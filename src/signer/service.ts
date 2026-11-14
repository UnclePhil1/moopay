import { KeyPairSigner, baseEncode, decodeTransaction, encodeTransaction } from "near-api-js";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { deriveWallet, type KeySource } from "./keys.js";
import { inspect, Refused, Tally, withinCaps, type SignerPolicy } from "./policy.js";
import { SignerPasskeys } from "./passkeys.js";
import type { StateStore, UserState } from "./state.js";

/** A passkey signature the user's device made for one payment or action, with the one-time nonce it was bound to. */
export interface Approval { nonce: string; assertion: AuthenticationResponseJSON }

/** A user's state as loaded for one operation. `save` writes it to the store and throws if the record changed underneath. */
interface Open { state: UserState; save(): Promise<void> }

const WRITER = "__state-writer__";

/**
 * The signer. It holds the wallet keys (derived from the TEE's root key), decodes every transaction itself, and signs only what
 * the policy allows. The MooPay server never sees a key: it sends an unsigned transaction and gets a signature or a refusal.
 *
 * Three layers, in order:
 *   1. caps: a hard ceiling per asset that no signature can lift.
 *   2. the unattended allowance: small payments may go with no passkey, unless the user turned on strict mode.
 *   3. a passkey signature for that exact payment, for everything else.
 *
 * State (passkeys, strict mode, lock, today's totals) is read from the store at the start of every call and written back
 * BEFORE a signature is made. So a rolled-back disk or a stale copy cannot reset a limit: the write is refused, and nothing is signed.
 */
export class WalletSigner {
  private root: Buffer | undefined;
  private readonly busy = new Map<string, Promise<unknown>>();
  constructor(
    private readonly keys: KeySource,
    private readonly policy: SignerPolicy,
    readonly passkeys: SignerPasskeys,
    private readonly store: StateStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async derive(id: string) {
    this.root ??= await this.keys.root();
    return deriveWallet(this.root, id);
  }
  private async wallet(userId: string) {
    // Ids starting with "__" are reserved for the signer's own accounts.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(userId)) throw new Refused("bad_transaction", "bad user id");
    return this.derive(userId);
  }

  /** The signer's own NEAR account. It pays the gas for writing state, and it is the account the contract lets write. Fund it with a little NEAR. */
  async writer(): Promise<{ accountId: string; publicKey: string; secretKey: string }> { return this.derive(WRITER); }

  /** One operation at a time per user, on state that was just read. */
  private async open<T>(userId: string, fn: (o: Open) => Promise<T>): Promise<T> {
    const prev = this.busy.get(userId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const { state, version } = await this.store.load(userId);
      let v = version;
      return fn({ state, save: async () => { v = await this.store.save(userId, state, v); } });
    });
    this.busy.set(userId, run);
    try { return await run; } finally { if (this.busy.get(userId) === run) this.busy.delete(userId); }
  }

  async pubkey(userId: string): Promise<{ accountId: string; publicKey: string }> {
    const w = await this.wallet(userId);
    return { accountId: w.accountId, publicKey: w.publicKey };
  }

  /** Where the user stands: what the app needs to know to ask for a passkey or explain a refusal. */
  async status(userId: string) {
    await this.wallet(userId);
    return this.open(userId, async ({ state: s }) => ({ passkeys: this.passkeys.list(s), active: this.passkeys.active(s), pending: this.passkeys.pending(s), activeAt: s.activeAt, strict: s.strict, locked: s.locked }));
  }

  nonce(userId: string): string { return this.passkeys.nonce(userId); }

  /** Signs an unsigned, borsh-encoded transaction. Returns the signed transaction bytes and its hash. */
  async sign(userId: string, unsigned: Uint8Array, approval?: Approval): Promise<{ signed: Uint8Array; txHash: string }> {
    const w = await this.wallet(userId);
    const seen = inspect(unsigned);
    if (seen.publicKey !== w.publicKey) throw new Refused("bad_transaction", "that transaction names a different key");
    return this.open(userId, async ({ state: st, save }) => {
      if (st.locked) throw new Refused("locked", "This wallet is locked. Unlock it with your passkey first.");
      const total = new Tally(st.total, this.now), free = new Tally(st.free, this.now);
      withinCaps(this.policy.caps, total, seen.outflows);

      let isFree = false;
      if (!st.strict) {
        try { withinCaps(this.policy.unattended, free, seen.outflows); isFree = true; }
        catch (e) { if (!(e instanceof Refused)) throw e; /* needs a passkey */ }
      }
      if (!isFree) {
        if (!this.passkeys.active(st)) {
          throw new Refused("passkey_required", this.passkeys.pending(st)
            ? "Your passkey is still in its waiting period, so larger payments are not available yet."
            : "Add a passkey to send more than the small limit.");
        }
        if (!approval) throw new Refused("passkey_required", "This payment needs your fingerprint, face or PIN.");
        await this.passkeys.verifyPayment(st, userId, approval.nonce, seen.outflows, approval.assertion);
      }
      for (const o of seen.outflows) { total.add(o.asset, o.amount); if (isFree) free.add(o.asset, o.amount); }
      await save(); // on record before it is signed
      const out = await KeyPairSigner.fromSecretKey(w.secretKey as never).signTransaction(decodeTransaction(unsigned));
      return { signed: encodeTransaction(out.signedTransaction), txHash: baseEncode(out.txHash) };
    });
  }

  /** Locking is always allowed (it can only make the wallet safer). Unlocking needs the passkey. */
  async lock(userId: string): Promise<void> {
    await this.wallet(userId);
    await this.open(userId, async ({ state, save }) => { state.locked = true; await save(); });
  }
  async unlock(userId: string, a: Approval): Promise<void> {
    await this.wallet(userId);
    await this.open(userId, async ({ state, save }) => { await this.passkeys.verifyAction(state, userId, a.nonce, "unlock", a.assertion); state.locked = false; await save(); });
  }

  /** Strict mode: every payment needs the passkey. Either direction needs the passkey. */
  async setStrict(userId: string, on: boolean, a: Approval): Promise<void> {
    await this.wallet(userId);
    await this.open(userId, async ({ state, save }) => {
      if (!this.passkeys.active(state)) throw new Refused("passkey_required", "Add a passkey first.");
      await this.passkeys.verifyAction(state, userId, a.nonce, on ? "strict:on" : "strict:off", a.assertion);
      state.strict = on;
      await save();
    });
  }

  async registerOptions(userId: string) {
    await this.wallet(userId);
    return this.open(userId, ({ state }) => this.passkeys.registerOptions(state, userId));
  }

  /** Adds a passkey. The first one starts counting after the waiting period. Once any exists, adding another needs one of them. */
  async addPasskey(userId: string, response: RegistrationResponseJSON, a?: Approval): Promise<{ activeAt: number }> {
    await this.wallet(userId);
    return this.open(userId, async ({ state, save }) => {
      if (state.credentials.length > 0) {
        if (!a) throw new Refused("passkey_required", "Adding another passkey needs one you already have.");
        await this.passkeys.verifyAction(state, userId, a.nonce, "addkey", a.assertion);
      }
      await this.passkeys.register(state, userId, response);
      await save();
      return { activeAt: state.activeAt };
    });
  }
}

const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** A small HTTP front for the signer. The bearer token only keeps strangers out; the policy and the passkey are the real checks. */
export function signerServer(signer: WalletSigner, token: string, log: (m: string) => void = () => undefined): Server {
  if (token.length < 32) throw new Error("SIGNER_TOKEN must be at least 32 characters");
  type Body = { userId?: string; tx?: string; nonce?: string; assertion?: AuthenticationResponseJSON; response?: RegistrationResponseJSON; on?: boolean };
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
    if (req.method !== "POST" || !same(req.headers["authorization"] ?? "", `Bearer ${token}`)) return send(401, { error: "unauthorized" });
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 64_000) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
      void (async () => {
        try {
          const b = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
          if (typeof b.userId !== "string") return send(400, { error: "userId is required" });
          const id = b.userId;
          const approval = (): Approval => { if (typeof b.nonce !== "string" || !b.assertion) throw new Refused("passkey_required", "That needs your fingerprint, face or PIN."); return { nonce: b.nonce, assertion: b.assertion }; };
          switch (req.url) {
            case "/v1/pubkey": return send(200, await signer.pubkey(id));
            case "/v1/status": return send(200, await signer.status(id));
            case "/v1/nonce": return send(200, { nonce: signer.nonce(id) });
            case "/v1/sign": {
              if (typeof b.tx !== "string") return send(400, { error: "tx is required" });
              const out = await signer.sign(id, Buffer.from(b.tx, "base64"), typeof b.nonce === "string" && b.assertion ? approval() : undefined);
              return send(200, { signed: Buffer.from(out.signed).toString("base64"), txHash: out.txHash });
            }
            case "/v1/lock": await signer.lock(id); return send(200, { ok: true });
            case "/v1/unlock": await signer.unlock(id, approval()); return send(200, { ok: true });
            case "/v1/strict": await signer.setStrict(id, b.on === true, approval()); return send(200, { ok: true });
            case "/v1/passkey/register-options": return send(200, await signer.registerOptions(id));
            case "/v1/passkey/register": {
              if (!b.response) return send(400, { error: "response is required" });
              return send(200, await signer.addPasskey(id, b.response, typeof b.nonce === "string" && b.assertion ? approval() : undefined));
            }
            default: return send(404, { error: "not found" });
          }
        } catch (e) {
          if (e instanceof Refused) { log(`refused: ${e.code}`); return send(403, { error: e.code, message: e.message }); }
          log("signer error"); send(500, { error: "signer_error" });
        }
      })();
    });
  });
}

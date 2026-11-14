import { KeyPairSigner, baseEncode, decodeTransaction, encodeTransaction } from "near-api-js";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { deriveWallet, type KeySource } from "./keys.js";
import { inspect, Ledger, Refused, withinCaps, type SignerPolicy } from "./policy.js";
import { SignerPasskeys } from "./passkeys.js";

/** A passkey signature the user's device made for one payment or action, with the one-time nonce it was bound to. */
export interface Approval { nonce: string; assertion: AuthenticationResponseJSON }

/**
 * The signer. It holds the wallet keys (derived from the TEE's root key), decodes every transaction itself, and signs only what
 * the policy allows. The MooPay server never sees a key: it sends an unsigned transaction and gets a signature or a refusal.
 *
 * Three layers, in order:
 *   1. caps: a hard ceiling per asset that no signature can lift.
 *   2. the unattended allowance: small payments may go with no passkey, unless the user turned on strict mode.
 *   3. a passkey signature for that exact payment, for everything else.
 */
export class WalletSigner {
  private root: Buffer | undefined;
  constructor(
    private readonly keys: KeySource,
    private readonly policy: SignerPolicy,
    readonly passkeys: SignerPasskeys,
    private readonly total = new Ledger(),
    private readonly unattended = new Ledger(),
  ) {}

  private async wallet(userId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Refused("bad_transaction", "bad user id");
    this.root ??= await this.keys.root();
    return deriveWallet(this.root, userId);
  }

  async pubkey(userId: string): Promise<{ accountId: string; publicKey: string }> {
    const w = await this.wallet(userId);
    return { accountId: w.accountId, publicKey: w.publicKey };
  }

  /** Where the user stands: what the app needs to know to ask for a passkey or explain a refusal. */
  async status(userId: string) {
    await this.wallet(userId);
    const s = this.passkeys.state(userId);
    return { passkeys: this.passkeys.list(userId), active: this.passkeys.active(userId), pending: this.passkeys.pending(userId), activeAt: s.activeAt, strict: s.strict, locked: s.locked };
  }

  nonce(userId: string): string { return this.passkeys.nonce(userId); }

  /** Signs an unsigned, borsh-encoded transaction. Returns the signed transaction bytes and its hash. */
  async sign(userId: string, unsigned: Uint8Array, approval?: Approval): Promise<{ signed: Uint8Array; txHash: string }> {
    const w = await this.wallet(userId);
    const seen = inspect(unsigned);
    if (seen.publicKey !== w.publicKey) throw new Refused("bad_transaction", "that transaction names a different key");
    const st = this.passkeys.state(userId);
    if (st.locked) throw new Refused("locked", "This wallet is locked. Unlock it with your passkey first.");
    withinCaps(this.policy.caps, this.total, userId, seen.outflows);

    let free = false;
    if (!st.strict) { try { withinCaps(this.policy.unattended, this.unattended, userId, seen.outflows); free = true; } catch { /* needs a passkey */ } }
    if (!free) {
      if (!this.passkeys.active(userId)) {
        throw new Refused("passkey_required", this.passkeys.pending(userId)
          ? "Your passkey is still in its waiting period, so larger payments are not available yet."
          : "Add a passkey to send more than the small limit.");
      }
      if (!approval) throw new Refused("passkey_required", "This payment needs your fingerprint, face or PIN.");
      await this.passkeys.verifyPayment(userId, approval.nonce, seen.outflows, approval.assertion);
    }
    const out = await KeyPairSigner.fromSecretKey(w.secretKey as never).signTransaction(decodeTransaction(unsigned));
    for (const o of seen.outflows) { this.total.add(userId, o.asset, o.amount); if (free) this.unattended.add(userId, o.asset, o.amount); }
    return { signed: encodeTransaction(out.signedTransaction), txHash: baseEncode(out.txHash) };
  }

  /** Locking is always allowed (it can only make the wallet safer). Unlocking needs the passkey. */
  lock(userId: string): void { this.passkeys.state(userId).locked = true; }
  async unlock(userId: string, a: Approval): Promise<void> { await this.passkeys.verifyAction(userId, a.nonce, "unlock", a.assertion); this.passkeys.state(userId).locked = false; }

  /** Strict mode: every payment needs the passkey. Either direction needs the passkey. */
  async setStrict(userId: string, on: boolean, a: Approval): Promise<void> {
    if (!this.passkeys.active(userId)) throw new Refused("passkey_required", "Add a passkey first.");
    await this.passkeys.verifyAction(userId, a.nonce, on ? "strict:on" : "strict:off", a.assertion);
    this.passkeys.state(userId).strict = on;
  }

  /** Adds a passkey. The first one starts counting after the waiting period. Once any exists, adding another needs one of them. */
  async addPasskey(userId: string, response: RegistrationResponseJSON, a?: Approval): Promise<{ activeAt: number }> {
    await this.wallet(userId);
    if (this.passkeys.state(userId).credentials.length > 0) {
      if (!a) throw new Refused("passkey_required", "Adding another passkey needs one you already have.");
      await this.passkeys.verifyAction(userId, a.nonce, "addkey", a.assertion);
    }
    return this.passkeys.register(userId, response);
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
            case "/v1/lock": signer.lock(id); return send(200, { ok: true });
            case "/v1/unlock": await signer.unlock(id, approval()); return send(200, { ok: true });
            case "/v1/strict": await signer.setStrict(id, b.on === true, approval()); return send(200, { ok: true });
            case "/v1/passkey/register-options": return send(200, await signer.passkeys.registerOptions(id));
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

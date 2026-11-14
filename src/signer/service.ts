import { KeyPairSigner, baseEncode, decodeTransaction, encodeTransaction } from "near-api-js";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { deriveWallet, type KeySource } from "./keys.js";
import { checkCaps, inspect, Ledger, Refused, type SignerPolicy } from "./policy.js";

/**
 * The signer. It holds the wallet keys (derived from the TEE's root key), decodes every transaction itself, and signs only what
 * the policy allows. The MooPay server never sees a key: it sends an unsigned transaction and gets a signature or a refusal.
 */
export class WalletSigner {
  private root: Buffer | undefined;
  constructor(private readonly keys: KeySource, private readonly policy: SignerPolicy, private readonly ledger = new Ledger()) {}

  private async wallet(userId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Refused("bad_transaction", "bad user id");
    this.root ??= await this.keys.root();
    return deriveWallet(this.root, userId);
  }

  async pubkey(userId: string): Promise<{ accountId: string; publicKey: string }> {
    const w = await this.wallet(userId);
    return { accountId: w.accountId, publicKey: w.publicKey };
  }

  /** Signs an unsigned, borsh-encoded transaction. Returns the signed transaction bytes and its hash. */
  async sign(userId: string, unsigned: Uint8Array): Promise<{ signed: Uint8Array; txHash: string }> {
    const w = await this.wallet(userId);
    const seen = inspect(unsigned);
    if (seen.publicKey !== w.publicKey) throw new Refused("bad_transaction", "that transaction names a different key");
    checkCaps(this.policy, this.ledger, userId, seen.outflows);
    const out = await KeyPairSigner.fromSecretKey(w.secretKey as never).signTransaction(decodeTransaction(unsigned));
    for (const o of seen.outflows) this.ledger.add(userId, o.asset, o.amount);
    return { signed: encodeTransaction(out.signedTransaction), txHash: baseEncode(out.txHash) };
  }
}

const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** A small HTTP front for the signer. The bearer token only keeps strangers out; the policy and (later) the passkey are the real checks. */
export function signerServer(signer: WalletSigner, token: string, log: (m: string) => void = () => undefined): Server {
  if (token.length < 32) throw new Error("SIGNER_TOKEN must be at least 32 characters");
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
    if (req.method !== "POST" || !same(req.headers["authorization"] ?? "", `Bearer ${token}`)) return send(401, { error: "unauthorized" });
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 64_000) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
      void (async () => {
        try {
          const b = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { userId?: string; tx?: string };
          if (typeof b.userId !== "string") return send(400, { error: "userId is required" });
          if (req.url === "/v1/pubkey") return send(200, await signer.pubkey(b.userId));
          if (req.url === "/v1/sign" && typeof b.tx === "string") {
            const out = await signer.sign(b.userId, Buffer.from(b.tx, "base64"));
            return send(200, { signed: Buffer.from(out.signed).toString("base64"), txHash: out.txHash });
          }
          send(404, { error: "not found" });
        } catch (e) {
          if (e instanceof Refused) { log(`refused: ${e.code}`); return send(403, { error: e.code, message: e.message }); }
          log("signer error"); send(500, { error: "signer_error" });
        }
      })();
    });
  });
}

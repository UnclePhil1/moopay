import { PublicKey, Signer, baseDecode, decodeSignedTransaction, encodeTransaction, type Transaction } from "near-api-js";
import { MoopayError } from "../util/errors.js";

/**
 * Signs through the TEE signer instead of holding a key. Plug it in wherever a wallet key string went: near-api-js's Account calls
 * signTransaction, which sends the unsigned transaction to the signer and gets back the signed one, or a refusal.
 */
export class RemoteSigner extends Signer {
  private constructor(private readonly url: string, private readonly token: string, private readonly userId: string, private readonly key: PublicKey, readonly accountId: string) { super(); }

  static async connect(url: string, token: string, userId: string): Promise<RemoteSigner> {
    const r = await RemoteSigner.post(url, token, "/v1/pubkey", { userId });
    return new RemoteSigner(url, token, userId, PublicKey.from(String(r["publicKey"])), String(r["accountId"]));
  }

  private static async post(url: string, token: string, path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try { res = await fetch(url.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); }
    catch { throw new MoopayError("UPSTREAM_TIMEOUT", "The signing service didn't answer, so nothing was sent. Try again in a minute."); }
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 403) throw new MoopayError("INVALID_INPUT", String(out["message"] ?? "The signing service refused that."));
    if (!res.ok) throw new MoopayError("INTERNAL", "The signing service had a problem, so nothing was sent.");
    return out;
  }

  override async getPublicKey(): Promise<PublicKey> { return this.key; }

  override async signTransaction(tx: Transaction) {
    const out = await RemoteSigner.post(this.url, this.token, "/v1/sign", { userId: this.userId, tx: Buffer.from(encodeTransaction(tx)).toString("base64") });
    return { txHash: baseDecode(String(out["txHash"])), signedTransaction: decodeSignedTransaction(Buffer.from(String(out["signed"]), "base64")) } as never;
  }

  protected override async signBytes(): Promise<never> { throw new MoopayError("INVALID_INPUT", "The signer only signs whole transactions it can read."); }
  override async signNep413Message(): Promise<never> { throw new MoopayError("INVALID_INPUT", "The signer does not sign messages."); }
  override async signDelegateAction(): Promise<never> { throw new MoopayError("INVALID_INPUT", "The signer does not sign delegate actions."); }
}

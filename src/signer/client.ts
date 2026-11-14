import { PublicKey, Signer, baseDecode, decodeSignedTransaction, encodeTransaction, type Transaction } from "near-api-js";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { MoopayError } from "../util/errors.js";

/** A passkey signature and the one-time nonce it was made for (see `paymentChallenge` and `actionChallenge`). */
export interface ApprovalProof { nonce: string; assertion: AuthenticationResponseJSON }

export interface SignerStatus { passkeys: { id: string; transports?: string[] }[]; active: boolean; pending: boolean; activeAt: number; strict: boolean; locked: boolean }

async function post(url: string, token: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try { res = await fetch(url.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); }
  catch { throw new MoopayError("UPSTREAM_TIMEOUT", "The signing service didn't answer, so nothing was sent. Try again in a minute."); }
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // A refusal carries a reason the app acts on: "passkey_required" means ask the user for their fingerprint, face or PIN.
  if (res.status === 403) throw new MoopayError("INVALID_INPUT", String(out["message"] ?? "The signing service refused that."), { reason: out["error"] });
  if (!res.ok) throw new MoopayError("INTERNAL", "The signing service had a problem, so nothing was sent.");
  return out;
}

/** Talks to the signer for the account calls the app makes: nonces, passkeys, strict mode, lock. */
export class SignerApi {
  constructor(private readonly url: string, private readonly token: string) {}
  pubkey = async (userId: string) => (await post(this.url, this.token, "/v1/pubkey", { userId })) as { accountId: string; publicKey: string };
  status = async (userId: string) => (await post(this.url, this.token, "/v1/status", { userId })) as unknown as SignerStatus;
  nonce = async (userId: string) => String((await post(this.url, this.token, "/v1/nonce", { userId }))["nonce"]);
  registerOptions = (userId: string) => post(this.url, this.token, "/v1/passkey/register-options", { userId });
  register = async (userId: string, response: RegistrationResponseJSON, proof?: ApprovalProof) => (await post(this.url, this.token, "/v1/passkey/register", { userId, response, ...proof })) as { activeAt: number };
  setStrict = async (userId: string, on: boolean, proof: ApprovalProof) => { await post(this.url, this.token, "/v1/strict", { userId, on, ...proof }); };
  lock = async (userId: string) => { await post(this.url, this.token, "/v1/lock", { userId }); };
  unlock = async (userId: string, proof: ApprovalProof) => { await post(this.url, this.token, "/v1/unlock", { userId, ...proof }); };
}

/**
 * Signs through the TEE signer instead of holding a key. Plug it in wherever a wallet key string went: near-api-js's Account calls
 * signTransaction, which sends the unsigned transaction to the signer and gets back the signed one, or a refusal.
 * `approved(proof)` returns a copy that attaches the user's passkey signature to the next signing.
 */
export class RemoteSigner extends Signer {
  private constructor(private readonly url: string, private readonly token: string, private readonly userId: string, private readonly key: PublicKey, readonly accountId: string, private readonly proof?: ApprovalProof) { super(); }

  static async connect(url: string, token: string, userId: string): Promise<RemoteSigner> {
    const r = await post(url, token, "/v1/pubkey", { userId });
    return new RemoteSigner(url, token, userId, PublicKey.from(String(r["publicKey"])), String(r["accountId"]));
  }

  /** A signer for a user whose account and key are already known, so no call is needed just to build it. */
  static known(url: string, token: string, userId: string, accountId: string, publicKey: string): RemoteSigner { return new RemoteSigner(url, token, userId, PublicKey.from(publicKey), accountId); }

  approved(proof: ApprovalProof): RemoteSigner { return new RemoteSigner(this.url, this.token, this.userId, this.key, this.accountId, proof); }

  override async getPublicKey(): Promise<PublicKey> { return this.key; }

  override async signTransaction(tx: Transaction) {
    const out = await post(this.url, this.token, "/v1/sign", { userId: this.userId, tx: Buffer.from(encodeTransaction(tx)).toString("base64"), ...this.proof });
    return { txHash: baseDecode(String(out["txHash"])), signedTransaction: decodeSignedTransaction(Buffer.from(String(out["signed"]), "base64")) } as never;
  }

  protected override async signBytes(): Promise<never> { throw new MoopayError("INVALID_INPUT", "The signer only signs whole transactions it can read."); }
  override async signNep413Message(): Promise<never> { throw new MoopayError("INVALID_INPUT", "The signer does not sign messages."); }
  override async signDelegateAction(): Promise<never> { throw new MoopayError("INVALID_INPUT", "The signer does not sign delegate actions."); }
}

import { createHash, createHmac } from "node:crypto";
import { deriveNoteAccount, type NoteAccount } from "../agent/crypto.js";

/** Where the signer's root secret comes from. In production it is the TEE's key; in tests it is a fixed value. */
export interface KeySource {
  root(): Promise<Buffer>;
}

/** A fixed root, for tests and local development only. Never use it with real funds. */
export class FixedKeySource implements KeySource {
  constructor(private readonly secret: string) {}
  async root(): Promise<Buffer> { return createHash("sha256").update("moopay.signer.test|" + this.secret).digest(); }
}

/**
 * The root key from the Phala dstack guest agent (the TEE). With on-chain KMS the agent only releases this key to code whose
 * compose hash the contract owner approved, and it is the same key after an approved update.
 */
export class DstackKeySource implements KeySource {
  constructor(private readonly path = "moopay/wallet-root/v1") {}
  async root(): Promise<Buffer> {
    // Loaded only inside the enclave image, so the main app does not need the package.
    const mod = (await import("@phala/dstack-sdk" as string)) as { DstackClient: new () => { getKey(path: string, purpose?: string, alg?: string): Promise<{ key: unknown }> } };
    const k = await new mod.DstackClient().getKey(this.path, "", "ed25519");
    const raw = String(k.key);
    if (raw.length < 32) throw new Error("the TEE returned no usable key");
    return createHash("sha256").update("moopay.signer.root|").update(raw).digest();
  }
}

/** One wallet per user, in the same shape the server used before, so the account format does not change. */
export function deriveWallet(root: Buffer, userId: string): NoteAccount {
  return deriveNoteAccount(createHmac("sha256", root).update("moopay.agent|" + userId).digest());
}

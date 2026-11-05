import { createDecipheriv, scryptSync } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { MoopayError } from "../util/errors.js";

/*
 * Every file under /data is one sealed line: "enc2:" + base64(nonce(24) || XChaCha20-Poly1305 ciphertext || tag).
 * The purpose string is bound in as associated data, so a sealed seed cannot be swapped in for a sealed state file.
 * XChaCha20-Poly1305 lives in @noble/ciphers: @noble/curves has no AEAD, and @noble/hashes supplies the key derivation.
 */
const SEALED = "enc2:";
const LEGACY = "enc1:"; // AES-256-GCM seed files written before this format existed
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export class Vault {
  private key: Uint8Array | undefined;
  private legacyKey: Buffer | undefined;

  /** Without a SEED_KEY the vault is open: files stay plain (development only). */
  constructor(secret: string | undefined = process.env["SEED_KEY"]?.trim() || undefined) {
    if (!secret) return;
    this.key = scrypt(utf8(secret), utf8("moopay.storage.v2"), { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
    this.legacyKey = scryptSync(secret, "moopay.seedfile.v1", 32);
  }

  get enabled(): boolean { return this.key !== undefined; }
  static isSealed = (text: string): boolean => text.startsWith(SEALED) || text.startsWith(LEGACY);
  static isLegacy = (text: string): boolean => text.startsWith(LEGACY);

  seal(plain: Uint8Array, purpose: string): string {
    if (!this.key) throw new MoopayError("INTERNAL", "SEED_KEY is not set, so nothing can be sealed");
    const nonce = randomBytes(24);
    const body = xchacha20poly1305(this.key, nonce, utf8(purpose)).encrypt(plain);
    return SEALED + Buffer.concat([nonce, body]).toString("base64");
  }

  open(text: string, purpose: string): Uint8Array {
    if (!this.key || !this.legacyKey) throw new MoopayError("INTERNAL", "this file is encrypted: set SEED_KEY to the key it was saved with");
    try {
      if (text.startsWith(LEGACY)) {
        const b = Buffer.from(text.slice(LEGACY.length), "base64");
        const d = createDecipheriv("aes-256-gcm", this.legacyKey, b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]);
      }
      const b = Buffer.from(text.slice(SEALED.length), "base64");
      return xchacha20poly1305(this.key, b.subarray(0, 24), utf8(purpose)).decrypt(b.subarray(24));
    } catch {
      throw new MoopayError("INTERNAL", "SEED_KEY does not match this file, or the file is damaged");
    }
  }

  /** Drops the derived keys once the process is done with the disk. */
  wipe(): void {
    this.key?.fill(0); this.legacyKey?.fill(0);
    this.key = undefined; this.legacyKey = undefined;
  }
}

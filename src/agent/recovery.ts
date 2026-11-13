import { argon2id } from "@noble/hashes/argon2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";

/*
 * The dead-man's switch: an offline copy of the agent wallet key, sealed with the user's recovery code.
 *
 *   - The key is encrypted with XChaCha20-Poly1305 under a key made from the recovery code by Argon2id (19 MiB, 2 passes),
 *     so guessing the code means paying that cost for every guess.
 *   - The file holds no secret in the clear: only the public account name, the salt, the nonce and the ciphertext.
 *   - The account name is bound in as associated data, so a file cannot be edited to point at another account.
 *   - Opening it needs only this file and the code. No MooPay server is involved, so if MooPay is gone the user can still
 *     reach their money: open the file (src/web/src/recover.ts runs this same function in the browser), import the key
 *     into any NEAR wallet, and move the funds.
 *
 * Runs unchanged in Node and in the browser.
 */
export interface Backup { v: 1; kdf: "argon2id"; m: number; t: number; p: number; account: string; salt: string; nonce: string; ct: string }
export interface WalletKey { accountId: string; secretKey: string }

const COST = { m: 19_456, t: 2, p: 1 } as const;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const keyFrom = (code: string, salt: Uint8Array, c: { m: number; t: number; p: number }): Uint8Array => argon2id(utf8(code), salt, { m: c.m, t: c.t, p: c.p, dkLen: 32 });

export function sealBackup(w: WalletKey, code: string): Backup {
  const salt = randomBytes(16), nonce = randomBytes(24);
  const ct = xchacha20poly1305(keyFrom(code, salt, COST), nonce, utf8("moopay.backup.v1|" + w.accountId)).encrypt(utf8(w.secretKey));
  return { v: 1, kdf: "argon2id", ...COST, account: w.accountId, salt: b64(salt), nonce: b64(nonce), ct: b64(ct) };
}

/** Opens a backup. A wrong code and a damaged file look the same on purpose. */
export function openBackup(b: Backup, code: string): WalletKey {
  try {
    if (b.v !== 1 || b.kdf !== "argon2id" || b.m > 262_144 || b.t > 10 || b.p > 4) throw new Error("unsupported");
    const plain = xchacha20poly1305(keyFrom(code, unb64(b.salt), b), unb64(b.nonce), utf8("moopay.backup.v1|" + b.account)).decrypt(unb64(b.ct));
    return { accountId: b.account, secretKey: new TextDecoder().decode(plain) };
  } catch {
    throw new Error("That recovery code does not open this file, or the file is damaged.");
  }
}

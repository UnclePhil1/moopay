import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { baseEncode } from "near-api-js";
import { MoopayError } from "./errors.js";

/*
 * Hash-lock note. NOT a zero-knowledge proof: once the secret is presented the
 * server learns it, and SHA256 alone gives no on-chain unlinkability.
 */
export const SECRET_PREFIX = "moopay1_";
const TAG_COMMIT = "moopay.v1.commit";
const TAG_NULL = "moopay.v1.null";
const TAG_BIND = "moopay.v1.bind";
const TAG_MEMO = "moopay.v1.memo";
const TAG_KEY = "moopay.v1.key";

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");
/** 4-byte big-endian length prefix so variable fields cannot be shifted into each other. */
const lp = (s: string): Buffer => {
  const b = utf8(s);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};

export function generateSecret(): Buffer {
  return randomBytes(32);
}

export const formatSecret = (secret: Buffer): string => SECRET_PREFIX + secret.toString("hex");

export function parseSecret(secretKeyString: string): Buffer {
  if (!/^moopay1_[0-9a-f]{64}$/.test(secretKeyString)) {
    throw new MoopayError("INVALID_INPUT", "secretKeyString is malformed (expected moopay1_ + 64 hex chars)");
  }
  return Buffer.from(secretKeyString.slice(SECRET_PREFIX.length), "hex");
}

export const commitmentOf = (secret: Buffer): string => sha256(utf8(TAG_COMMIT), secret).toString("hex");
export const nullifierHashOf = (secret: Buffer): string => sha256(utf8(TAG_NULL), secret).toString("hex");

/**
 * Binds the claim to its destination (Nova `extDataHash` idea) so the params
 * cannot be swapped between the CLAIMING mark and the retry.
 */
export function claimBinding(
  secret: Buffer,
  chain: string,
  recipient: string,
  assetId: string,
  amount: bigint,
): string {
  return sha256(utf8(TAG_BIND), secret, lp(chain), lp(recipient), lp(assetId), lp(amount.toString())).toString("hex");
}

/** Memo is stored hashed only. */
export const hashMemo = (memo: string): string => sha256(utf8(TAG_MEMO), utf8(memo)).toString("hex");

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/**
 * Per-note NEAR account. The ed25519 key is derived from the secret under its own domain tag,
 * so commitment / nullifierHash reveal nothing about it. Whoever holds the secret controls the
 * account (paper-wallet model); MooPay itself never holds a key.
 */
export interface NoteAccount {
  /** Implicit account id = hex of the ed25519 public key. */
  accountId: string;
  /** near-api-js KeyPairString: "ed25519:" + base58(seed || publicKey). */
  secretKey: string;
}

export function deriveNoteAccount(secret: Buffer): NoteAccount {
  const seed = sha256(utf8(TAG_KEY), secret);
  const pub = ed25519.getPublicKey(seed);
  return {
    accountId: Buffer.from(pub).toString("hex"),
    secretKey: "ed25519:" + baseEncode(Buffer.concat([seed, pub])),
  };
}

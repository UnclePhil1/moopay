import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode } from "../addresses.js";

export const validSolanaAddress = (a: string): boolean => base58Decode(a)?.length === 32;

/** Wallets such as Phantom sign the raw message bytes with ed25519; the signature arrives base64. */
export function verifySolanaSignature(address: string, message: Uint8Array, signature: string): boolean {
  const pub = base58Decode(address);
  return pub?.length === 32 && ed25519.verify(Buffer.from(signature, "base64"), message, pub);
}

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Every EVM chain where 1Click has USDC. */
export const EVM_CLAIM_CHAINS = ["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "monad", "xlayer"] as const;
export const isEvm = (c: string): boolean => (EVM_CLAIM_CHAINS as readonly string[]).includes(c);
export const validEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** EIP-191 personal_sign: what MetaMask, Rabby and the like produce. */
export function verifyEvmSignature(address: string, message: Uint8Array, signature: string): boolean {
  const sig = Buffer.from(signature.replace(/^0x/, ""), "hex");
  if (sig.length !== 65) return false;
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`), message]));
  const pub = new secp256k1.Signature(BigInt("0x" + hex(sig.subarray(0, 32))), BigInt("0x" + hex(sig.subarray(32, 64))), v).recoverPublicKey(digest).toBytes(false);
  return "0x" + hex(keccak_256(pub.subarray(1)).subarray(12)) === address.toLowerCase();
}

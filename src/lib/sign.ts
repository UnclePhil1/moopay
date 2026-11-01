import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58Decode } from "./addresses.js";
import { MoopayError } from "./errors.js";

/* Proof of wallet ownership for claims on other chains: the receiver signs a short message with their own wallet. */

/** Chains a claim can be paid out to. Solana, plus every EVM chain where 1Click has USDC. */
export const EVM_CLAIM_CHAINS = ["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "monad", "xlayer"] as const;
export const CLAIM_CHAINS = ["near", "sol", ...EVM_CLAIM_CHAINS] as const;
export type ClaimChain = (typeof CLAIM_CHAINS)[number];
export const isClaimChain = (c: string): c is ClaimChain => (CLAIM_CHAINS as readonly string[]).includes(c);
export const isEvm = (c: string): boolean => (EVM_CLAIM_CHAINS as readonly string[]).includes(c);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fail = (m: string) => new MoopayError("BAD_RECIPIENT", m);

export function validAddress(chain: string, a: string): boolean {
  if (chain === "sol") return base58Decode(a)?.length === 32;
  if (isEvm(chain)) return /^0x[0-9a-fA-F]{40}$/.test(a);
  return false;
}

/** Throws unless `signature` was made over `message` by the key behind `address`. */
export function verifyWalletSignature(chain: string, address: string, message: string, signature: string): void {
  const msg = new TextEncoder().encode(message);
  try {
    if (chain === "sol") {
      const pub = base58Decode(address);
      if (pub?.length !== 32 || !ed25519.verify(Buffer.from(signature, "base64"), msg, pub)) throw 0;
      return;
    }
    if (isEvm(chain)) {
      // EIP-191 personal_sign: what MetaMask, Rabby and the like produce.
      const sig = Buffer.from(signature.replace(/^0x/, ""), "hex");
      if (sig.length !== 65) throw 0;
      const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
      const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
      const pub = new secp256k1.Signature(BigInt("0x" + hex(sig.subarray(0, 32))), BigInt("0x" + hex(sig.subarray(32, 64))), v).recoverPublicKey(digest).toBytes(false);
      const who = "0x" + hex(keccak_256(pub.subarray(1)).subarray(12));
      if (who !== address.toLowerCase()) throw 0;
      return;
    }
  } catch {
    // fall through to the same message for any malformed or wrong signature
  }
  throw fail("the wallet signature did not check out");
}

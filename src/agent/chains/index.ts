import { MoopayError } from "../../util/errors.js";
import { EVM_CLAIM_CHAINS, isEvm, validEvmAddress, verifyEvmSignature } from "./evm.js";
import { validSolanaAddress, verifySolanaSignature } from "./solana.js";

/* Proof of wallet ownership for claims on other chains: the receiver signs a short message with their own wallet. */

export { EVM_CLAIM_CHAINS, isEvm };
/** Chains a claim can be paid out to. Solana, plus every EVM chain where 1Click has USDC. */
export const CLAIM_CHAINS = ["near", "sol", ...EVM_CLAIM_CHAINS] as const;
export type ClaimChain = (typeof CLAIM_CHAINS)[number];
export const isClaimChain = (c: string): c is ClaimChain => (CLAIM_CHAINS as readonly string[]).includes(c);

export function validAddress(chain: string, a: string): boolean {
  if (chain === "sol") return validSolanaAddress(a);
  return isEvm(chain) && validEvmAddress(a);
}

/** Throws unless `signature` was made over `message` by the key behind `address`. */
export function verifyWalletSignature(chain: string, address: string, message: string, signature: string): void {
  const msg = new TextEncoder().encode(message);
  try {
    if (chain === "sol" && verifySolanaSignature(address, msg, signature)) return;
    if (isEvm(chain) && verifyEvmSignature(address, msg, signature)) return;
  } catch {
    // fall through to the same message for any malformed or wrong signature
  }
  throw new MoopayError("BAD_RECIPIENT", "That wallet signature wasn't accepted. Try signing again.");
}

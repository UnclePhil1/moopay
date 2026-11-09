import { Account } from "near-api-js";
import { MoopayError } from "../../util/errors.js";

/*
 * Chain Signatures wrapper (guides/near/chain-signatures.md).
 * v1.signer `sign` takes payload, path and domain_id: 0 = Secp256k1, 1 = Ed25519.
 * One derivation path per chain, so a signature for one chain can never authorise another.
 */
export type SignChain = "near" | "btc" | "sol" | "eth";

export const DOMAIN_ID = { secp256k1: 0, ed25519: 1 } as const;

const DOMAIN_BY_CHAIN: Record<SignChain, number> = {
  btc: DOMAIN_ID.secp256k1,
  eth: DOMAIN_ID.secp256k1,
  sol: DOMAIN_ID.ed25519,
  near: DOMAIN_ID.ed25519,
};

export const derivationPath = (chain: SignChain): string => `moopay-v1-${chain}-1`;
export const domainIdFor = (chain: SignChain): number => DOMAIN_BY_CHAIN[chain];

export interface SignRequest {
  /** Hex of the 32-byte hash to sign (secp256k1) or the message bytes (ed25519). */
  payloadHex: string;
  chain: SignChain;
}

/**
 * Calls `MPC_CONTRACT_ID.sign({ request: { payload, path, domain_id } })`.
 * TODO(verify): the docs page linked from chain-signatures.md ("implementation") was not provided.
 *   Unconfirmed: (1) payload encoding (the on-chain contract may expect `payload_v2: {Ecdsa|Eddsa: hex}`
 *   rather than `payload`), (2) the required attached deposit (assumed 1 yoctoNEAR), (3) gas (assumed 300 Tgas).
 */
export async function requestMpcSignature(
  account: Account,
  mpcContractId: string,
  req: SignRequest,
): Promise<unknown> {
  try {
    return await account.callFunction({
      contractId: mpcContractId,
      methodName: "sign",
      args: {
        request: {
          payload: Array.from(Buffer.from(req.payloadHex, "hex")),
          path: derivationPath(req.chain),
          domain_id: domainIdFor(req.chain),
        },
      },
      deposit: 1n,
      gas: 300_000_000_000_000n,
    });
  } catch {
    throw new MoopayError("SIGNING_FAILED", "I couldn't sign that payment right now. Try again in a minute.");
  }
}

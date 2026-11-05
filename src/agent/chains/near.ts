import { Account, FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { MoopayError } from "../../util/errors.js";
import type { Config } from "../../../config/index.js";

/*
 * NEAR operations on a per-note account. MooPay holds no key: the note account's key is derived
 * from the claim secret, so the transfer is signed by whoever presents that secret. Chain
 * Signatures is not involved on this path (NEAR accounts sign natively); see signer.ts.
 */
export interface NearOps {
  ftBalance(tokenContract: string, accountId: string): Promise<bigint>;
  /** NEP-145 storage registration of `accountId` on the token contract. */
  storageRegistered(tokenContract: string, accountId: string): Promise<boolean>;
  /** Native NEAR balance in yocto; 0 when the account does not exist yet. */
  nearBalance(accountId: string): Promise<bigint>;
  /** Throws unless `signature` is a valid NEP-413 signature by an access key of `accountId`. */
  verifyOwner(p: { accountId: string; publicKey: string; signature: Buffer; payload: { message: string; recipient: string; nonce: Buffer } }): Promise<void>;
  /** Native NEAR transfer from the note account, signed with the note key. */
  sendNear(p: { accountId: string; secretKey: string; to: string; amount: bigint }): Promise<{ txHash: string }>;
  /** Wraps native NEAR into wNEAR (wrap.near near_deposit) so it can be swapped like any token. */
  wrapNear(p: { accountId: string; secretKey: string; wrapContract: string; amount: bigint }): Promise<{ txHash: string }>;
  /** Any contract call signed by the note account (used for rNEAR staking and unwrapping wNEAR). */
  call(p: { accountId: string; secretKey: string; contractId: string; method: string; args: Record<string, unknown>; deposit: bigint; gas: bigint }): Promise<{ txHash: string }>;
  /** Read-only contract call. */
  view(contractId: string, method: string, args?: Record<string, unknown>): Promise<unknown>;
  /** A transaction the payer's wallet signed: did it succeed, who got it, what did it do. Null until the chain has it. */
  txStatus(txHash: string, signerId: string): Promise<{ ok: boolean; receiver: string; actions: Record<string, any>[] } | null>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** ft_transfer from the note account to `to`, signed with the note key. */
  transferFromNote(p: {
    accountId: string;
    secretKey: string;
    tokenContract: string;
    to: string;
    amount: bigint;
  }): Promise<{ txHash: string }>;
}

const TGAS = 1_000_000_000_000n;
// Prepaid gas is charged up front at the current gas price (it has been ~10x the minimum), so keep it near what a token transfer really uses.
const FT_GAS = 12n * TGAS;
const STORAGE_REGISTRATION = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, NEP-145 minimum
const rpcDown = () => new MoopayError("UPSTREAM_TIMEOUT", "NEAR RPC is unavailable or timed out");

export function makeNearOps(cfg: Pick<Config, "nearRpcUrl">): NearOps {
  // The public NEAR RPC rate-limits (429); a second endpoint keeps balance checks and payments working.
  const urls = [cfg.nearRpcUrl, ...(cfg.nearRpcUrl.includes("mainnet") || cfg.nearRpcUrl === "https://free.rpc.fastnear.com" ? ["https://free.rpc.fastnear.com", "https://near.drpc.org"] : [])].filter((u, i, a) => a.indexOf(u) === i);
  const provider = urls.length > 1 ? new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url }))) : new JsonRpcProvider({ url: urls[0]! });
  return {
    async ftBalance(tokenContract, accountId) {
      try {
        const raw = await provider.callFunction({
          contractId: tokenContract,
          method: "ft_balance_of",
          args: { account_id: accountId },
        });
        return BigInt(String(raw));
      } catch {
        throw rpcDown();
      }
    },

    async storageRegistered(tokenContract, accountId) {
      try {
        const r = await provider.callFunction({ contractId: tokenContract, method: "storage_balance_of", args: { account_id: accountId } });
        return r !== null && r !== undefined;
      } catch {
        throw rpcDown();
      }
    },

    async nearBalance(accountId) {
      try {
        return (await provider.viewAccount({ accountId })).amount;
      } catch (e) {
        const all = [e, ...((e as { errors?: unknown[] }).errors ?? [])];
        if (all.some((x) => x instanceof Error && /does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(`${x.name} ${x.message}`))) return 0n;
        throw rpcDown();
      }
    },

    async verifyOwner({ accountId, publicKey, signature, payload }) {
      try {
        await verifyMessage({ signerAccountId: accountId, signerPublicKey: publicKey, payload: { ...payload, nonce: new Uint8Array(payload.nonce) }, signature: new Uint8Array(signature), provider });
      } catch {
        throw new MoopayError("BAD_RECIPIENT", "the wallet signature did not check out");
      }
    },

    async sendNear({ accountId, secretKey, to, amount }) {
      try {
        const out = await new Account(accountId, provider, secretKey as never).transfer({ receiverId: to, amount });
        return { txHash: (out as unknown as { transaction: { hash: string } }).transaction.hash };
      } catch (e) {
        if (e instanceof Error && /time(d)? ?out/i.test(e.message)) throw new MoopayError("UPSTREAM_TIMEOUT", "NEAR RPC timed out; the transfer may or may not have landed");
        throw new MoopayError("DEPOSIT_FAILED", "NEAR transfer failed");
      }
    },

    async call({ accountId, secretKey, contractId, method, args, deposit, gas }) {
      try {
        const out = await new Account(accountId, provider, secretKey as never).callFunctionRaw({ contractId, methodName: method, args, deposit, gas });
        return { txHash: out.transaction.hash as string };
      } catch (e) {
        if (process.env["MOOPAY_DEBUG"]) console.error(`[moopay] ${contractId}.${method} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : e);
        if (e instanceof Error && /time(d)? ?out/i.test(e.message)) throw new MoopayError("UPSTREAM_TIMEOUT", "NEAR RPC timed out; it may or may not have gone through");
        throw new MoopayError("DEPOSIT_FAILED", `${method} on ${contractId} failed`);
      }
    },

    async view(contractId, method, args = {}) {
      try { return await provider.callFunction({ contractId, method, args }); } catch { throw rpcDown(); }
    },

    async wrapNear({ accountId, secretKey, wrapContract, amount }) {
      try {
        const out = await new Account(accountId, provider, secretKey as never).callFunctionRaw({ contractId: wrapContract, methodName: "near_deposit", args: {}, deposit: amount, gas: 30n * TGAS });
        return { txHash: out.transaction.hash as string };
      } catch {
        throw new MoopayError("DEPOSIT_FAILED", "could not wrap NEAR for the swap");
      }
    },

    async txStatus(txHash, signerId) {
      try {
        const r = (await provider.viewTransactionStatus({ txHash, accountId: signerId, waitUntil: "EXECUTED_OPTIMISTIC" })) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!r?.transaction) return null;
        const failed = (s: any) => s && typeof s === "object" && "Failure" in s; // eslint-disable-line @typescript-eslint/no-explicit-any
        const ok = !failed(r.status) && !(r.receipts_outcome ?? []).some((o: any) => failed(o.outcome?.status)); // eslint-disable-line @typescript-eslint/no-explicit-any
        return { ok, receiver: String(r.transaction.receiver_id), actions: r.transaction.actions as Record<string, any>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
      } catch {
        return null;
      }
    },

    async transferFromNote({ accountId, secretKey, tokenContract, to, amount }) {
      const account = new Account(accountId, provider, secretKey as never);
      try {
        // NEP-145: the receiver must be registered or ft_transfer fails. The note account pays 0.00125 NEAR.
        const storage = await provider.callFunction({
          contractId: tokenContract,
          method: "storage_balance_of",
          args: { account_id: to },
        });
        if (storage === null || storage === undefined) {
          await account.callFunction({
            contractId: tokenContract,
            methodName: "storage_deposit",
            args: { account_id: to, registration_only: true },
            deposit: STORAGE_REGISTRATION,
            gas: FT_GAS,
          });
        }
      } catch {
        // TODO(verify): tokens without NEP-145 reject this; ft_transfer below then decides.
      }
      try {
        const outcome = await account.callFunctionRaw({
          contractId: tokenContract,
          methodName: "ft_transfer",
          args: { receiver_id: to, amount: amount.toString() },
          deposit: 1n,
          gas: FT_GAS,
        });
        return { txHash: outcome.transaction.hash as string };
      } catch (e) {
        if (process.env["MOOPAY_DEBUG"]) console.error("[moopay] ft_transfer failed:", e instanceof Error ? `${e.name}: ${e.message}` : e);
        if (e instanceof Error && /time(d)? ?out/i.test(e.message))
          throw new MoopayError("UPSTREAM_TIMEOUT", "NEAR RPC timed out; the transfer may or may not have landed");
        throw new MoopayError("DEPOSIT_FAILED", "ft_transfer to the 1Click deposit address failed");
      }
    },
  };
}

import { decodeTransaction } from "near-api-js";

/** A cap on one asset: native NEAR is "NEAR", a token is its contract id. Amounts are in the asset's smallest unit. */
export interface Cap { perTx: bigint; daily: bigint }
export interface SignerPolicy {
  /** The hard ceiling per asset, even with a passkey. An asset with no cap is refused, because it cannot be measured. */
  caps: Record<string, Cap>;
  /** What may be signed with no passkey signature: the whole allowance for an account without a passkey, and for scheduled runs. Unlisted assets always need one. */
  unattended: Record<string, Cap>;
}

/** One thing a transaction would take out of the wallet. */
export interface Outflow { asset: string; amount: bigint; to: string; method: string }

/** What the signer is willing to sign. Everything else (adding keys, deploying code, deleting accounts, staking directly) is refused. */
const CALLS = new Set(["ft_transfer", "near_deposit", "near_withdraw", "storage_deposit", "deposit_and_stake"]);
const big = (v: unknown): bigint => { try { return BigInt(String(v)); } catch { return -1n; } };

export class Refused extends Error {
  constructor(readonly code: "forbidden_action" | "unknown_asset" | "over_limit" | "bad_transaction" | "passkey_required" | "bad_assertion" | "locked", message: string) { super(message); }
}

/** Reads an unsigned transaction and lists every outflow, or refuses it. */
export function inspect(bytes: Uint8Array): { signerId: string; publicKey: string; outflows: Outflow[] } {
  let tx: ReturnType<typeof decodeTransaction>;
  try { tx = decodeTransaction(bytes); } catch { throw new Refused("bad_transaction", "that is not a NEAR transaction"); }
  if (!tx.actions.length) throw new Refused("bad_transaction", "a transaction with no actions");
  const outflows: Outflow[] = [];
  for (const a of tx.actions as unknown as Record<string, any>[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (a["transfer"]) {
      const amount = big(a["transfer"].deposit);
      if (amount < 0n) throw new Refused("bad_transaction", "bad amount");
      outflows.push({ asset: "NEAR", amount, to: tx.receiverId, method: "transfer" });
    } else if (a["functionCall"]) {
      const f = a["functionCall"], method = String(f.methodName);
      if (!CALLS.has(method)) throw new Refused("forbidden_action", `the call ${method} is not allowed`);
      let args: Record<string, unknown> = {};
      try { args = f.args?.length ? JSON.parse(Buffer.from(f.args).toString("utf8")) : {}; } catch { throw new Refused("bad_transaction", "unreadable call arguments"); }
      const deposit = big(f.deposit);
      if (deposit < 0n) throw new Refused("bad_transaction", "bad deposit");
      if (method === "ft_transfer") {
        const amount = big(args["amount"]);
        if (amount < 0n || typeof args["receiver_id"] !== "string") throw new Refused("bad_transaction", "a token transfer needs a receiver and an amount");
        outflows.push({ asset: tx.receiverId, amount, to: String(args["receiver_id"]), method });
      } else if (method === "near_withdraw") {
        // wNEAR back to NEAR: the asset leaving is wNEAR, and it comes back to the same wallet.
        const amount = big(args["amount"]);
        if (amount < 0n) throw new Refused("bad_transaction", "bad amount");
        outflows.push({ asset: tx.receiverId, amount, to: tx.signerId, method });
      }
      // Whatever NEAR is attached to the call leaves the wallet too (wrapping, staking, storage fees).
      if (deposit > 0n && method !== "ft_transfer" && method !== "near_withdraw") outflows.push({ asset: "NEAR", amount: deposit, to: tx.receiverId, method });
    } else {
      throw new Refused("forbidden_action", "only transfers and approved contract calls can be signed");
    }
  }
  return { signerId: tx.signerId, publicKey: tx.publicKey.toString(), outflows };
}

/** Per-user running totals for the current day (UTC). Kept in memory for now; step 5 anchors them on chain. */
export class Ledger {
  private readonly days = new Map<string, { day: string; total: bigint }>();
  constructor(private readonly now: () => number = Date.now) {}
  private day(): string { return new Date(this.now()).toISOString().slice(0, 10); }
  used(user: string, asset: string): bigint {
    const e = this.days.get(user + "|" + asset);
    return e && e.day === this.day() ? e.total : 0n;
  }
  add(user: string, asset: string, amount: bigint): void {
    this.days.set(user + "|" + asset, { day: this.day(), total: this.used(user, asset) + amount });
  }
}

/** Throws unless every outflow is within the caps. Nothing is recorded here, so a refusal leaves the totals alone. */
export function checkCaps(policy: SignerPolicy, ledger: Ledger, user: string, outflows: Outflow[]): void { withinCaps(policy.caps, ledger, user, outflows); }

export function withinCaps(caps: Record<string, Cap>, ledger: Ledger, user: string, outflows: Outflow[]): void {
  const sum = new Map<string, bigint>();
  for (const o of outflows) {
    const cap = caps[o.asset];
    if (!cap) throw new Refused("unknown_asset", `${o.asset} is not an asset this signer will move`);
    if (o.amount > cap.perTx) throw new Refused("over_limit", `that is more than the ${o.asset} limit for one payment`);
    sum.set(o.asset, (sum.get(o.asset) ?? 0n) + o.amount);
  }
  for (const [asset, amount] of sum) {
    const cap = caps[asset]!;
    if (ledger.used(user, asset) + amount > cap.daily) throw new Refused("over_limit", `that would pass the daily ${asset} limit`);
  }
}

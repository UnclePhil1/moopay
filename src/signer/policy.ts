import { baseEncode, decodeTransaction } from "near-api-js";

/** A cap on one asset: native NEAR is "NEAR", a token is its contract id. Amounts are in the asset's smallest unit. */
export interface Cap { perTx: bigint; daily: bigint }
export interface SignerPolicy {
  /** The hard ceiling per asset, even with a passkey. An asset with no cap is refused, because it cannot be measured. */
  caps: Record<string, Cap>;
  /** What may be signed with no passkey signature: the whole allowance for an account without a passkey, and for scheduled runs. Unlisted assets always need one. */
  unattended: Record<string, Cap>;
  /** MooPay's own fee account. Fee transfers to it are taken after a payment lands, with nobody there to sign, so they get their own small allowance. */
  feeAccount?: string;
  feeCaps?: Record<string, Cap>;
}

/** One payment a passkey signature approves: this asset, this recipient, up to this amount. */
export interface Flow { asset: string; to: string; amount: bigint }
/** What a passkey signature allows for a while. `left` shrinks as transactions use it. */
export interface Mandate { exp: number; allow: { asset: string; to: string; left: string }[] }

/** Returns the mandate with `outflows` taken out of it, or null when they are not all covered. Does not change the input. */
export function useMandate(m: Mandate | undefined, outflows: Outflow[], now: number): Mandate | null {
  if (!m || m.exp < now) return null;
  const allow = m.allow.map((a) => ({ ...a }));
  for (const o of outflows) {
    const slot = allow.find((a) => a.asset === o.asset && a.to === o.to && BigInt(a.left) >= o.amount);
    if (!slot) return null;
    slot.left = (BigInt(slot.left) - o.amount).toString();
  }
  return { exp: m.exp, allow };
}

/** One thing a transaction would take out of the wallet. */
export interface Outflow { asset: string; amount: bigint; to: string; method: string }

/** What the signer is willing to sign. Everything else (adding keys, deploying code, deleting accounts, staking directly) is refused. */
const CALLS = new Set(["ft_transfer", "near_deposit", "near_withdraw", "storage_deposit", "deposit_and_stake"]);
/** Each of these calls is only signed on its one contract, so a look-alike contract cannot be used: wrapping on wrap.near, staking on Rhea's rNEAR. */
export const PINNED: Record<string, string> = { near_deposit: "wrap.near", near_withdraw: "wrap.near", deposit_and_stake: "lst.rhealab.near" };
const big = (v: unknown): bigint => { try { return BigInt(String(v)); } catch { return -1n; } };

export class Refused extends Error {
  constructor(readonly code: "forbidden_action" | "unknown_asset" | "over_limit" | "bad_transaction" | "passkey_required" | "bad_assertion" | "locked" | "state_unavailable", message: string) { super(message); }
}

/** Reads an unsigned transaction and lists every outflow, or refuses it. */
export function inspect(bytes: Uint8Array): { signerId: string; receiverId: string; publicKey: string; outflows: Outflow[]; addKeys: { key: string; full: boolean }[]; storageOn: string[] } {
  let tx: ReturnType<typeof decodeTransaction>;
  try { tx = decodeTransaction(bytes); } catch { throw new Refused("bad_transaction", "that is not a NEAR transaction"); }
  if (!tx.actions.length) throw new Refused("bad_transaction", "a transaction with no actions");
  const outflows: Outflow[] = [], addKeys: { key: string; full: boolean }[] = [], storageOn: string[] = [];
  for (const a of tx.actions as unknown as Record<string, any>[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (a["transfer"]) {
      const amount = big(a["transfer"].deposit);
      if (amount < 0n) throw new Refused("bad_transaction", "bad amount");
      outflows.push({ asset: "NEAR", amount, to: tx.receiverId, method: "transfer" });
    } else if (a["functionCall"]) {
      const f = a["functionCall"], method = String(f.methodName);
      if (!CALLS.has(method)) throw new Refused("forbidden_action", `the call ${method} is not allowed`);
      const pin = PINNED[method];
      if (pin && tx.receiverId !== pin) throw new Refused("forbidden_action", `${method} is only signed on ${pin}`);
      if (method === "storage_deposit") storageOn.push(tx.receiverId);
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
    } else if (a["addKey"]) {
      // Only ever signed for a key the owner's passkey approved by name (see WalletSigner.recoveryKey); the caller checks that.
      const k = a["addKey"].publicKey?.ed25519Key?.data;
      if (!k || k.length !== 32) throw new Refused("bad_transaction", "that key is not an ed25519 key");
      addKeys.push({ key: "ed25519:" + baseEncode(Uint8Array.from(k)), full: !!a["addKey"].accessKey?.permission?.fullAccess });
    } else {
      throw new Refused("forbidden_action", "only transfers and approved contract calls can be signed");
    }
  }
  return { signerId: tx.signerId, receiverId: tx.receiverId, publicKey: tx.publicKey.toString(), outflows, addKeys, storageOn };
}

/** A day's running totals for one user, as stored on chain. It starts again when the UTC day changes. */
export interface TallyData { day: string; used: Record<string, string> }
export const emptyTally = (): TallyData => ({ day: "", used: {} });

export class Tally {
  constructor(private readonly d: TallyData, private readonly now: () => number = Date.now) {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (d.day !== today) { d.day = today; d.used = {}; }
  }
  used(asset: string): bigint { return BigInt(this.d.used[asset] ?? "0"); }
  add(asset: string, amount: bigint): void { this.d.used[asset] = (this.used(asset) + amount).toString(); }
}

/** Throws unless every outflow is within the caps. Nothing is recorded here, so a refusal leaves the totals alone. */
export function withinCaps(caps: Record<string, Cap>, tally: Pick<Tally, "used">, outflows: Outflow[]): void {
  const sum = new Map<string, bigint>();
  for (const o of outflows) {
    const cap = caps[o.asset];
    if (!cap) throw new Refused("unknown_asset", `${o.asset} is not an asset this signer will move`);
    if (o.amount > cap.perTx) throw new Refused("over_limit", `that is more than the ${o.asset} limit for one payment`);
    sum.set(o.asset, (sum.get(o.asset) ?? 0n) + o.amount);
  }
  for (const [asset, amount] of sum) {
    const cap = caps[asset]!;
    if (tally.used(asset) + amount > cap.daily) throw new Refused("over_limit", `that would pass the daily ${asset} limit`);
  }
}

import { MoopayError } from "../lib/errors.js";

/*
 * Rhea Finance rNEAR liquid staking (https://github.com/rhea-finance/rnear-sdk). Staking is one contract call,
 * `deposit_and_stake`, signed by the account that gets the rNEAR. These are the same calls the SDK builds.
 */

export const RNEAR = "lst.rhealab.near";
export const WRAP = "wrap.near";
export const STAKE_GAS = 200_000_000_000_000n; // 200 Tgas, the SDK's default; unused gas is refunded
export const STAKE_MIN_NEAR = 10n ** 23n; // 0.1 NEAR
const APY_URL = "https://api.rhea.finance/get-rnear-apy";

/** NEAR per 1 rNEAR (24 decimals) from the contract, e.g. 1067416371642320432486285n for 1.0674. */
export async function rnearPrice(view: (c: string, m: string) => Promise<unknown>): Promise<bigint> {
  const s = (await view(RNEAR, "get_summary")) as { ft_price?: string } | null;
  if (!s?.ft_price) throw new MoopayError("UPSTREAM_TIMEOUT", "couldn't read the rNEAR price right now");
  return BigInt(s.ft_price);
}

export async function rnearApy(doFetch: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await doFetch(APY_URL, { signal: AbortSignal.timeout(5000) });
    const d = ((await r.json()) as { data?: string }).data;
    return d ? Number(d).toFixed(2) : null;
  } catch { return null; }
}

const DUST = 10n ** 19n; // the contract's own rounding: less than this pending is nothing
export interface Unstaking { pending: bigint; canWithdraw: boolean }

/** What the user has waiting to come out of staking, and whether the delay is over. */
export async function unstaking(view: (c: string, m: string, a?: Record<string, unknown>) => Promise<unknown>, account: string): Promise<Unstaking> {
  const d = (await view(RNEAR, "get_account_details", { account_id: account })) as { unstaked_balance?: string; can_withdraw?: boolean } | null;
  const pending = BigInt(d?.unstaked_balance ?? "0");
  return pending < DUST ? { pending: 0n, canWithdraw: false } : { pending, canWithdraw: Boolean(d?.can_withdraw) };
}

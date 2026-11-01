import { MoopayError } from "../lib/errors.js";

/*
 * Rhea Finance rNEAR liquid staking (https://github.com/rhea-finance/rnear-sdk). Staking is one contract call,
 * `deposit_and_stake`, signed by the account that gets the rNEAR. These are the same calls the SDK builds.
 */

export const RNEAR = "lst.rhealab.near";
export const WRAP = "wrap.near";
export const RNEAR_APP = "https://rhea-finance.github.io/rnear-sdk/"; // Rhea's own page: unstake or withdraw with your wallet
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

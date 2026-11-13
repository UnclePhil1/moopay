import type { UserRec } from "../agent/store.js";

/*
 * A quick look at one payment before it goes: does it look like someone draining the wallet? No network calls, no model,
 * so it runs in well under a millisecond. When it says "step up", the payment cannot go on the user's earlier "no biometrics"
 * choice: it waits for a passkey, whatever the toggles say.
 *
 *   drain      the payment is 85% or more of the wallet (ignoring dust under $20)
 *   velocity   more than 3 payments in the last 60 seconds
 *   new        the first payment to this recipient. Only mentioned, never a reason on its own: small first payments are
 *              normal, and the policy already asks for approval on larger ones.
 */
export interface Risk { stepUp: boolean; why: string[] }
const DUST_USD = 20;

export function riskOf(u: UserRec, amountUsd: number, balanceUsd: number, fresh: boolean, now: number): Risk {
  const why: string[] = [];
  if (amountUsd >= DUST_USD && balanceUsd > 0 && amountUsd >= 0.85 * balanceUsd) why.push("it moves most of your wallet");
  if (u.payments.filter((p) => p.kind !== "sweep" && !p.feed && now - p.createdAt < 60_000).length >= 3) why.push("several payments went out in the last minute");
  const stepUp = why.length > 0;
  if (fresh) why.push("it is the first payment to this recipient");
  return { stepUp, why };
}

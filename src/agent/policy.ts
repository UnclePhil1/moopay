import type { AgentKey, Rules, UserRec } from "./store.js";

/** Rules the model cannot override. Pure functions, easy to test. */
export type Decision = { action: "auto" } | { action: "ask"; reason: string } | { action: "deny"; reason: string };

export const today = (now: number): string => new Date(now).toISOString().slice(0, 10);
export const spentToday = (u: UserRec, now: number): number => (u.spent.day === today(now) ? u.spent.usd : 0);

export function decide(u: UserRec, amountUsd: number, recipientKey: string, now: number): Decision {
  const r = u.rules;
  if (!(amountUsd > 0)) return { action: "deny", reason: "the amount must be above zero" };
  if (spentToday(u, now) + amountUsd > r.dailyCapUsd)
    return { action: "deny", reason: `this would pass your daily limit of $${r.dailyCapUsd} (already $${spentToday(u, now).toFixed(2)} today)` };
  if (!u.known.includes(recipientKey) && amountUsd > r.newRecipientLimitUsd)
    return { action: "ask", reason: `first payment to this recipient above $${r.newRecipientLimitUsd}` };
  if (amountUsd > r.approveAboveUsd) return { action: "ask", reason: `above your $${r.approveAboveUsd} auto-approve limit` };
  return { action: "auto" };
}

/** A new payout wallet only takes over this long after it was approved, so a thief with brief access cannot redirect the sweep at once. */
export const PAYOUT_HOLD_MS = 24 * 60 * 60 * 1000;
export const recipientKey = (chain: string, r: string): string => `${chain}:${chain === "eth" || chain === "near" ? r.toLowerCase() : r}`;

/** Loosening a limit or changing the payout wallet needs a human; tightening or first-time setup does not. */
export function rulesNeedApproval(old: Rules, next: Rules): string | undefined {
  if (old.payoutAddress && next.payoutAddress !== old.payoutAddress) return "changing your payout wallet";
  const widens = (o: string[] | undefined, n: string[] | undefined) => !!o?.length && (!n?.length || n.some((x) => !o.map((y) => y.toLowerCase()).includes(x.toLowerCase())));
  if (widens(old.allowedChains, next.allowedChains) || widens(old.allowedAssets, next.allowedAssets)) return "allowing more chains or assets";
  if (next.dailyCapUsd > old.dailyCapUsd || next.approveAboveUsd > old.approveAboveUsd || next.newRecipientLimitUsd > old.newRecipientLimitUsd)
    return "raising a spending limit";
  return undefined;
}

export interface Scope { chains?: string[] | undefined; assets?: string[] | undefined; recipients?: string[] | undefined }
const has = (list: string[] | undefined, v: string) => !list?.length || list.map((x) => x.toLowerCase()).includes(v.toLowerCase());

/** "Only Solana USDC", "only to this address". Returns why a payment is not allowed, or undefined. */
export function scopeDeny(s: Scope, chain: string, symbol: string, recipient: string): string | undefined {
  if (!has(s.chains, chain)) return `${chain.toUpperCase()} is not on the allowed list (${s.chains!.map((c) => c.toUpperCase()).join(", ")})`;
  if (!has(s.assets, symbol)) return `${symbol} is not on the allowed list (${s.assets!.join(", ")})`;
  if (!has(s.recipients, recipient)) return "that recipient is not on the allowed list";
  return undefined;
}

/** The leash on one agent key: scope, expiry, per-payment, daily and total budgets. */
export function agentDeny(ak: AgentKey, amountUsd: number, chain: string, symbol: string, recipient: string, now: number): string | undefined {
  if (ak.revoked) return "this agent key was revoked";
  if (ak.expiresAt && now > ak.expiresAt) return "this agent session has expired";
  const scope = scopeDeny({ chains: ak.chains, assets: ak.assets, recipients: ak.recipients }, chain, symbol, recipient);
  if (scope) return scope;
  if (ak.perPaymentUsd !== undefined && amountUsd > ak.perPaymentUsd) return `above this agent's $${ak.perPaymentUsd} per-payment limit`;
  const day = ak.spent.day === today(now) ? ak.spent.usd : 0;
  if (ak.dailyUsd !== undefined && day + amountUsd > ak.dailyUsd) return `this would pass this agent's daily limit of $${ak.dailyUsd} (used $${day.toFixed(2)})`;
  if (ak.totalUsd !== undefined && ak.totalSpent + amountUsd > ak.totalUsd) return `this would pass this agent's total budget of $${ak.totalUsd} (used $${ak.totalSpent.toFixed(2)})`;
  return undefined;
}

export const remaining = (ak: AgentKey, now: number) => ({
  today: ak.dailyUsd === undefined ? null : Math.max(0, ak.dailyUsd - (ak.spent.day === today(now) ? ak.spent.usd : 0)),
  total: ak.totalUsd === undefined ? null : Math.max(0, ak.totalUsd - ak.totalSpent),
});

import type { AgentKey, Rules, UserRec } from "./store.js";

/** Rules the model cannot override. Pure functions, easy to test. */
export type Decision = { action: "auto" } | { action: "ask"; reason: string } | { action: "deny"; reason: string };

export const today = (now: number): string => new Date(now).toISOString().slice(0, 10);
export const spentToday = (u: UserRec, now: number): number => (u.spent.day === today(now) ? u.spent.usd : 0);

/** Where a request came from. A public post on X is the easiest door to abuse, so it gets tighter limits. */
export type Channel = "x" | undefined;

/** The most one payment from the agent wallet may be, in dollars. Anything larger is signed by the user in their own wallet. */
export const txCeilingUsd = (): number => Number(process.env["MOOPAY_TX_CEILING_USD"]) || 3000;
/** The most a payment started from X may be without the user's OK in the app. */
export const xAutoUsd = (): number => Number(process.env["MOOPAY_X_AUTO_USD"]) || 10;

export function decide(u: UserRec, amountUsd: number, recipientKey: string, now: number, via?: Channel): Decision {
  const r = u.rules;
  if (!(amountUsd > 0)) return { action: "deny", reason: "the amount must be above zero" };
  if (amountUsd > txCeilingUsd())
    return { action: "deny", reason: `one payment from the agent wallet can be at most $${txCeilingUsd().toLocaleString("en-US")}. For more, pay from your own wallet` };
  if (spentToday(u, now) + amountUsd > r.dailyCapUsd)
    return { action: "deny", reason: `this would pass your daily limit of $${r.dailyCapUsd} (already $${spentToday(u, now).toFixed(2)} today)` };
  if (via === "x") {
    // Anyone who takes over the X account can write a post, so anything new or large waits for the user in the app.
    const mine = !!r.payoutAddress && recipientKey === `near:${r.payoutAddress.toLowerCase()}`;
    if (!u.known.includes(recipientKey) && !mine) return { action: "ask", reason: "first payment to this recipient started from X. Approve it in the app" };
    if (amountUsd > xAutoUsd()) return { action: "ask", reason: `above $${xAutoUsd()} for a payment started from X. Approve it in the app` };
  }
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

/** Payments above this many dollars earn points. */
export const POINTS_MIN_USD = 10;
export const POINTS_PER_PAYMENT = 10;
const EARNED = new Set(["DELIVERED", "STAKED", "CLAIMED"]);

/**
 * Gives 10 moo points to each finished payment above $10, once. Refunds, failures and unclaimed claims earn nothing,
 * and neither does money moved to the user's own wallets. Returns the points added now.
 */
export function earnPoints(u: UserRec): number {
  const own = new Set([u.accountId, u.rules.payoutAddress].filter(Boolean));
  let added = 0;
  for (const p of u.payments) {
    if (p.pts || !["send", "claim", "stake"].includes(p.kind) || !EARNED.has(p.status) || !(p.amountUsd > POINTS_MIN_USD) || own.has(p.recipient)) continue;
    p.pts = POINTS_PER_PAYMENT;
    added += POINTS_PER_PAYMENT;
  }
  if (added) u.points = (u.points ?? 0) + added;
  return added;
}

/** Words nobody may take as a wallet name, so no one can pose as MooPay, a chain or a service. */
const RESERVED = new Set(["moopay", "moopayagent", "moo", "admin", "administrator", "support", "help", "team", "staff", "official", "security", "root", "system", "agent", "bot", "wallet", "near", "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "usdc", "usdt", "rhea", "rnear", "stake", "pay", "payment", "claim", "mod", "www", "api", "app", "test", "null", "undefined"]);

/** Why a wallet name cannot be used, in words for the user; undefined when it is fine. */
export function nameProblem(name: string): string | undefined {
  if (name.length < 3 || name.length > 20) return "Use 3 to 20 characters.";
  if (!/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(name)) return "Use only lowercase letters, numbers, - and _, and start and end with a letter or number.";
  if (RESERVED.has(name)) return "That name is reserved. Try another.";
  return undefined;
}

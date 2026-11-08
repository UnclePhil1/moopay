import type { UserRec } from "../agent/index.js";
import type { Payment } from "../agent/store.js";

/* Team-only numbers, worked out from the user records the agent already keeps. Nothing extra is recorded, and no ids leave this file. */

const DAY = 86_400_000;
const DONE = new Set(["DELIVERED", "CLAIMED", "STAKED"]);
const BAD = new Set(["FAILED", "REFUNDED", "EXPIRED"]);
const MOVES = new Set(["send", "claim", "stake"]);
/** Every payment that actually moved money: the three above plus deposits (fund), withdrawals and payouts above the float (sweep). */
const ALL = new Set(["send", "claim", "stake", "fund", "withdraw", "sweep"]);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const round = (n: number) => Math.round(n * 100) / 100;

export interface History { rows: (Payment & { who?: string })[]; peaks: Map<string, number> }

export function metrics(users: UserRec[], now: number, history?: History) {
  /** The last time the user typed or paid; a user who keeps no chat history only shows through payments. */
  const lastSeen = (u: UserRec) => Math.max(0, ...u.chat.map((m) => m.at ?? 0), ...u.payments.map((p) => p.createdAt));
  const within = (t: number, days: number) => t > 0 && now - t < days * DAY;
  const moved = (u: UserRec) => u.payments.filter((p) => MOVES.has(p.kind) && DONE.has(p.status));
  const funded = (u: UserRec) => Number(u.seen.usdc) > 0 || u.payments.some((p) => p.kind === "fund" && p.status === "DELIVERED");

  // The ledger keeps every payment ever made; a user's own list stops at the latest 100.
  const all: (Payment & { who?: string })[] = history?.rows ?? users.flatMap((u) => u.payments.map((p) => ({ ...p, who: u.id })));
  const mine = (id: string) => all.filter((p) => p.who === id);
  const done = all.filter((p) => MOVES.has(p.kind) && DONE.has(p.status));
  const moves = all.filter((p) => ALL.has(p.kind) && DONE.has(p.status));
  const sum = (ps: { amountUsd: number }[]) => ps.reduce((a, p) => a + p.amountUsd, 0);
  const kindUsd = (k: string) => round(sum(moves.filter((p) => p.kind === k)));
  // Staking held: what was staked, less everything a user staked before an unstake that has started or finished. Unstakes record no dollar value, so a partial unstake takes out too much.
  const staking = users.reduce((a, u) => {
    const cut = Math.max(0, ...mine(u.id).filter((p) => p.kind === "unstake" && ["UNSTAKING", "READY_TO_WITHDRAW", "WITHDRAWN"].includes(p.status)).map((p) => p.createdAt));
    return a + sum(mine(u.id).filter((p) => p.kind === "stake" && p.status === "STAKED" && p.createdAt > cut));
  }, 0);
  // Money that reached a wallet without a recorded deposit (sent straight in) still counts: per user, the larger of recorded deposits and what the wallet held last time we looked.
  const deposits = users.reduce((a, u) => a + Math.max(sum(mine(u.id).filter((p) => p.kind === "fund" && p.status === "DELIVERED")), Number(u.seen.usdc) / 100, (history?.peaks.get(u.id) ?? 0) / 100), 0);
  const volume = done.reduce((a, p) => a + p.amountUsd, 0);
  const settled = all.filter((p) => p.settled && p.kind !== "sweep");
  const failed = settled.filter((p) => BAD.has(p.status));
  const byKind: Record<string, number> = {};
  for (const p of all) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  const approvals = users.flatMap((u) => u.approvals);
  const priv = all.filter((p) => p.pv);
  const keys = users.flatMap((u) => u.agents);

  const series = Array.from({ length: 14 }, (_, i) => {
    const d = iso(now - (13 - i) * DAY);
    const ps = moves.filter((p) => iso(p.createdAt) === d);
    return { day: d, signups: users.filter((u) => iso(u.createdAt) === d).length, payments: ps.length, volumeUsd: round(sum(ps)) };
  });

  const talked = users.filter((u) => u.chat.some((m) => m.role === "user") || u.payments.length);
  const paid = users.filter((u) => moved(u).length >= 1), repeat = users.filter((u) => moved(u).length >= 2);

  return {
    generatedAt: new Date(now).toISOString(),
    users: {
      total: users.length, new24h: users.filter((u) => within(u.createdAt, 1)).length, new7d: users.filter((u) => within(u.createdAt, 7)).length, new30d: users.filter((u) => within(u.createdAt, 30)).length,
      active24h: users.filter((u) => within(lastSeen(u), 1)).length, active7d: users.filter((u) => within(lastSeen(u), 7)).length, active30d: users.filter((u) => within(lastSeen(u), 30)).length,
      named: users.filter((u) => u.name).length, frozen: users.filter((u) => u.frozen).length, withPoints: users.filter((u) => (u.points ?? 0) > 0).length,
    },
    funnel: [
      { step: "Opened MooPay", users: users.length }, { step: "Chatted or paid", users: talked.length }, { step: "Funded the wallet", users: users.filter(funded).length },
      { step: "Made a first payment", users: paid.length }, { step: "Paid twice or more", users: repeat.length },
    ],
    agents: { created: users.length, keys: keys.length, keysActive: keys.filter((k) => !k.revoked && (!k.expiresAt || k.expiresAt > now)).length },
    tvl: { totalUsd: round(deposits + staking), depositsUsd: round(deposits), stakingUsd: round(staking), heldNowUsd: round(users.reduce((a, u) => a + Number(u.seen.usdc) / 100, 0)), stakers: new Set(all.filter((p) => p.kind === "stake" && p.status === "STAKED").map((p) => p.who)).size },
    money: {
      movedUsd: round(sum(moves)), transactions: moves.length, payments: done.length, volumeUsd: round(volume), averageUsd: moves.length ? round(sum(moves) / moves.length) : 0, largestUsd: round(Math.max(0, ...moves.map((p) => p.amountUsd))),
      depositedUsd: round(deposits), byKindUsd: { deposits: kindUsd("fund"), sends: kindUsd("send"), claims: kindUsd("claim"), staked: kindUsd("stake"), withdrawn: kindUsd("withdraw"), sweptToPayout: kindUsd("sweep") }, byKind,
    },
    health: { settled: settled.length, failed: failed.length, failRate: settled.length ? round((failed.length / settled.length) * 100) : 0 },
    approvals: { pending: approvals.filter((a) => a.status === "pending").length, approved: approvals.filter((a) => a.status === "approved").length, declined: approvals.filter((a) => a.status === "declined").length, expired: approvals.filter((a) => a.status === "expired").length },
    features: {
      scheduled: users.reduce((a, u) => a + u.tasks.length, 0), agentKeys: keys.length, agentKeysActive: keys.filter((k) => !k.revoked && (!k.expiresAt || k.expiresAt > now)).length,
      stakes: all.filter((p) => p.kind === "stake" && DONE.has(p.status)).length, claims: all.filter((p) => p.kind === "claim").length, points: users.reduce((a, u) => a + (u.points ?? 0), 0),
      private: { total: priv.length, delivered: priv.filter((p) => p.status === "DELIVERED").length, failed: priv.filter((p) => BAD.has(p.status)).length },
    },
    series,
  };
}

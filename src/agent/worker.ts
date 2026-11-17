import type { AgentOps } from "./ops.js";
import type { AgentStore, UserRec } from "./store.js";

/* The part that works while nobody is chatting: notices deposits, sweeps the extra out, follows payments, runs schedules. */

const PERIOD = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
const msg = (e: unknown) => (e instanceof Error ? e.message : "something went wrong");

/** How long an account with nothing going on (no chat open, no payment in flight, nothing scheduled) waits between looks at the chain. */
export const IDLE_MS = 10 * 60_000;

/**
 * One round over every account. With `pace`, accounts that are idle are looked at every `IDLE_MS` instead of every round, so a
 * hundred quiet accounts do not use up the node's rate limit and slow down the people who are using the app.
 */
export async function tick(ops: AgentOps, store: AgentStore, origin: string, now: number, pace?: Map<string, number>): Promise<void> {
  for (const u of store.all()) {
    store.settlePayout(u, now);
    if (pace && (pace.get(u.id) ?? 0) > now) continue;
    try { await one(ops, store, u, origin, now); await ops.takeFees(u); } catch { /* try again next round */ }
    if (pace) {
      const busy = u.sessions.some((s) => s.expiresAt > now) || u.payments.some((p) => !p.settled) || u.tasks.length > 0 || u.approvals.some((a) => a.status === "pending");
      if (busy) pace.delete(u.id); else pace.set(u.id, now + IDLE_MS);
    }
  }
}

/** Looks at every payment still in flight and tells the user in chat as soon as one lands, fails or comes back. */
export async function followPayments(ops: AgentOps, store: AgentStore, u: UserRec, origin: string): Promise<void> {
  for (const p of u.payments.filter((x) => !x.settled && x.kind !== "sweep")) {
    const r = await ops.refresh(u, p, { origin });
    if (!r.changed) continue;
    const text = p.status === "DELIVERED" && p.kind === "fund" ? `Your agent wallet is funded: about $${p.amountUsd.toFixed(2)} arrived as USDC.`
      : p.status === "DELIVERED" ? `Delivered: $${p.amountUsd.toFixed(2)} reached ${p.recipient}.`
      : p.status === "CLAIMED" ? `Claimed: ${p.recipient} opened your $${p.amountUsd.toFixed(2)} claim.`
      : p.kind === "unstake" ? ({ UNSTAKING: `Unstaking started: about ${p.expected} will be ready to withdraw in a day or two. I'll tell you the moment it is.`, READY_TO_WITHDRAW: `Your unstaked NEAR (${p.expected}) is ready. Press Withdraw and sign to send it to ${p.recipient}.`, WITHDRAWN: `Withdrawn: ${p.expected} is back in ${p.recipient}.`, EXPIRED: "The unstake window closed before it was signed. Nothing happened." } as Record<string, string>)[p.status]
      : p.status === "STAKED" ? `Staked: you now hold about ${p.expected}, sent to ${p.recipient}. Ask me any time to unstake.`
      : p.status === "WAITING_FOR_FEE" ? `Your payment arrived, but I can't finish the stake yet. ${p.why}`
      : p.kind === "stake" && p.status === "FAILED" ? `I couldn't finish your stake${p.why ? `: ${p.why}` : ""}. Your money is safe in your agent wallet; ask me to try again.`
      : p.pv && p.status === "REFUNDED" ? `The private payment of $${p.amountUsd.toFixed(2)} to ${p.recipient} did not finish. The money is on its way back to your agent wallet.`
      : p.status === "REFUNDED" ? `Refunded: your $${p.amountUsd.toFixed(2)} ${p.kind === "claim" ? "claim was not opened in time" : "payment did not go through"}, and the money is back ${p.payId ? "in your wallet" : "in your agent wallet"}.`
      : p.status === "EXPIRED" ? `The confirm link for your $${p.amountUsd.toFixed(2)} payment to ${p.recipient} expired before it was signed. Nothing was sent.`
      : p.status === "FAILED" ? `Failed: the $${p.amountUsd.toFixed(2)} payment to ${p.recipient} did not go through.${p.why ? " " + p.why : ""}` : undefined;
    if (text) store.event(u, text, r.card ?? (p.kind === "unstake" ? undefined : { kind: "payment", id: p.id, amountUsd: p.amountUsd, chain: p.chain, recipient: p.recipient, status: p.status, tx: r.link }));
    if (r.earned) ops.pointsEvent(u, r.earned);
  }
  store.save();
}

async function one(ops: AgentOps, store: AgentStore, u: UserRec, origin: string, now: number) {
  const b = await ops.balances(u);
  const cents = Math.round(b.totalUsd * 100), was = Number(u.seen.usdc), nat = b.nat.toString();
  if (was > 0 && cents > was + 4) store.event(u, `Money arrived: $${((cents - was) / 100).toFixed(2)}.`);
  else if (was === 0 && cents >= 5) store.event(u, `Your agent wallet is funded: $${(cents / 100).toFixed(2)}. I'm ready.`);
  if (await ops.sponsorGas(u, BigInt(Math.round(b.totalUsd * 1e6)), b.nat)) store.event(u, "I added a little NEAR so your agent wallet can pay its network fees.");
  u.seen = { usdc: String(cents), near: nat };

  for (const text of await ops.followSwaps(u).catch(() => [])) store.event(u, text);
  await ops.forwardRnear(u).catch(() => undefined); // rNEAR never stays in the agent wallet
  await ops.repayAdvance(u);
  const swept = await ops.sweep(u);
  if (swept) { store.event(u, `Sent $${swept.amountUsd.toFixed(2)} above your float to your own wallet.`, { kind: "payment", id: swept.id, amountUsd: swept.amountUsd, chain: "near", recipient: swept.recipient, status: "DELIVERED" }); u.seen.usdc = String(Math.round((await ops.balances(u)).totalUsd * 100)); }

  await followPayments(ops, store, u, origin);

  for (const t of u.tasks.filter((x) => x.nextAt <= now)) {
    t.nextAt = now + PERIOD[t.every];
    const had = new Set(u.payments.map((p) => p.id));
    try {
      const out = t.items ? await ops.sendMany(u, t.items, false, { sched: true }) : await ops.send(u, { amountUsd: String(t.amountUsd), chain: t.chain, recipient: t.recipient, assetSymbol: t.assetSymbol }, false, { sched: true });
      const st = out.result["status"];
      if (st === "sent" || st === "group_done") store.event(u, `Scheduled payment sent: ${t.text}.`, out.card);
      else if (st === "needs_approval") store.event(u, `Your scheduled payment (${t.text}) needs your OK.`, out.card);
      else store.event(u, `Skipped a scheduled payment (${t.text}): ${String(out.result["reason"] ?? "not allowed by your rules")}.`);
      for (const p of u.payments) if (!had.has(p.id)) p.tag = p.tag ?? "scheduled";
    } catch (e) { store.event(u, `Could not run a scheduled payment (${t.text}): ${msg(e)}`); }
  }
  store.save();
}

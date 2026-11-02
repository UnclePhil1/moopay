import { fmt, type AgentOps } from "./ops.js";
import type { AgentStore, UserRec } from "./store.js";

/* The part that works while nobody is chatting: notices deposits, sweeps the extra out, follows payments, runs schedules. */

const PERIOD = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
const msg = (e: unknown) => (e instanceof Error ? e.message : "something went wrong");

export async function tick(ops: AgentOps, store: AgentStore, origin: string, now: number): Promise<void> {
  for (const u of store.all()) {
    store.settlePayout(u, now);
    try { await one(ops, store, u, origin, now); } catch { /* try again next round */ }
  }
}

async function one(ops: AgentOps, store: AgentStore, u: UserRec, origin: string, now: number) {
  const b = await ops.balances(u);
  const cents = Math.round(b.totalUsd * 100), was = Number(u.seen.usdc), nat = b.nat.toString();
  if (was > 0 && cents > was + 4) store.event(u, `Money arrived: $${((cents - was) / 100).toFixed(2)}.`);
  else if (was === 0 && cents >= 5) store.event(u, `Your agent wallet is funded: $${(cents / 100).toFixed(2)}. I'm ready.`);
  if (await ops.sponsorGas(u, b.tok, b.nat)) store.event(u, "I added a little NEAR so your agent wallet can pay its network fees.");
  u.seen = { usdc: String(cents), near: nat };

  await ops.forwardRnear(u).catch(() => undefined); // rNEAR never stays in the agent wallet
  const swept = await ops.sweep(u);
  if (swept) { store.event(u, `Sent $${swept.amountUsd.toFixed(2)} above your float to your own wallet.`, { kind: "payment", id: swept.id, amountUsd: swept.amountUsd, chain: "near", recipient: swept.recipient, status: "DELIVERED" }); u.seen.usdc = String(Math.round((await ops.balances(u)).totalUsd * 100)); }

  for (const p of u.payments.filter((x) => !x.settled && x.kind !== "sweep")) {
    const r = await ops.refresh(u, p, { origin });
    if (!r.changed) continue;
    const text = p.status === "DELIVERED" && p.kind === "fund" ? `Your agent wallet is funded: about $${p.amountUsd.toFixed(2)} arrived as USDC.`
      : p.status === "DELIVERED" ? `Delivered: $${p.amountUsd.toFixed(2)} reached ${p.recipient}.`
      : p.status === "CLAIMED" ? `Claimed: ${p.recipient} opened your $${p.amountUsd.toFixed(2)} claim.`
      : p.status === "REFUNDED" ? `Refunded: your $${p.amountUsd.toFixed(2)} ${p.kind === "claim" ? "claim was not opened in time" : "payment did not go through"}, and the money is back ${p.payId ? "in your wallet" : "in your agent wallet"}.`
      : p.status === "EXPIRED" ? `The confirm link for your $${p.amountUsd.toFixed(2)} payment to ${p.recipient} expired before it was signed. Nothing was sent.`
      : p.status === "FAILED" ? `Failed: the $${p.amountUsd.toFixed(2)} payment to ${p.recipient} did not go through.` : undefined;
    if (text) store.event(u, text, { kind: "payment", id: p.id, amountUsd: p.amountUsd, chain: p.chain, recipient: p.recipient, status: p.status, tx: r.link });
  }

  for (const t of u.tasks.filter((x) => x.nextAt <= now)) {
    t.nextAt = now + PERIOD[t.every];
    try {
      const out = t.items ? await ops.sendMany(u, t.items, false) : await ops.send(u, { amountUsd: String(t.amountUsd), chain: t.chain, recipient: t.recipient, assetSymbol: t.assetSymbol }, false);
      const st = out.result["status"];
      if (st === "sent" || st === "group_done") store.event(u, `Scheduled payment sent: ${t.text}.`, out.card);
      else if (st === "needs_approval") store.event(u, `Your scheduled payment (${t.text}) needs your OK.`, out.card);
      else store.event(u, `Skipped a scheduled payment (${t.text}): ${String(out.result["reason"] ?? "not allowed by your rules")}.`);
    } catch (e) { store.event(u, `Could not run a scheduled payment (${t.text}): ${msg(e)}`); }
  }
  store.save();
}

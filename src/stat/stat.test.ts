import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentStore } from "../agent/index.js";
import { handleStat } from "./index.js";
import { metrics } from "./metrics.js";

/* Run on its own: npx tsx --test src/stat/stat.test.ts (this folder is not part of the main suite). */

test("stats: the numbers come from what the agent already keeps, and count each thing once", async () => {
  const store = await AgentStore.open(join(mkdtempSync(join(tmpdir(), "moopay-stat-")), "a.json"));
  const u1 = store.open("a".repeat(43)), u2 = store.open("b".repeat(43)), u3 = store.open("c".repeat(43));
  const t = Date.now();
  const pay = (kind: "send" | "fund" | "stake", amountUsd: number, status: string) => ({ id: Math.random().toString(36).slice(2), kind, amountUsd, chain: "near", recipient: "x.near", status, createdAt: t, settled: true });
  u1.payments.push(pay("send", 10, "DELIVERED"), pay("send", 30, "DELIVERED"), pay("send", 5, "FAILED"), pay("fund", 50, "DELIVERED"), pay("stake", 40, "STAKED"));
  u2.payments.push(pay("send", 20, "DELIVERED"));
  u2.chat.push({ role: "user", content: "hi", at: t });
  u1.points = 20;
  u1.approvals.push({ id: "a", kind: "send", params: {}, summary: "", reason: "", createdAt: t, status: "approved" }, { id: "b", kind: "send", params: {}, summary: "", reason: "", createdAt: t, status: "declined" });
  const m = metrics(store.all(), t);
  assert.equal(m.users.total, 3);
  assert.equal(m.users.active24h, 2, "u3 never typed or paid");
  assert.equal(m.money.payments, 4, "sends, claims and stakes that finished");
  assert.equal(m.money.transactions, 5, "and the deposit");
  assert.equal(m.money.movedUsd, 150, "10 + 30 + 20 sent, 40 staked, 50 deposited; the failed 5 is left out");
  assert.deepEqual(m.money.byKindUsd, { deposits: 50, sends: 60, claims: 0, staked: 40, withdrawn: 0, sweptToPayout: 0 });
  assert.equal(m.money.averageUsd, 30);
  assert.equal(m.money.largestUsd, 50);
  assert.deepEqual(m.tvl, { totalUsd: 90, depositsUsd: 50, stakingUsd: 40, heldNowUsd: 0, stakers: 1 });
  assert.equal(m.agents.created, 3);
  assert.deepEqual(m.funnel.map((f) => f.users), [3, 2, 1, 2, 1]);
  assert.equal(m.health.failed, 1);
  assert.equal(m.approvals.approved, 1);
  assert.equal(m.features.points, 20);
  assert.equal(m.series.at(-1)?.volumeUsd, 150);
  assert.equal(u3.payments.length, 0);
});

test("stats: staking drops out of the TVL once an unstake has started, and money held now is summed from the last balances seen", async () => {
  const store = await AgentStore.open(join(mkdtempSync(join(tmpdir(), "moopay-stat-")), "a.json"));
  const u = store.open("a".repeat(43)), v = store.open("b".repeat(43));
  const t = Date.now();
  const p = (kind: "stake" | "unstake", amountUsd: number, status: string, createdAt: number) => ({ id: kind + createdAt, kind, amountUsd, chain: "near", recipient: "x.near", status, createdAt, settled: true });
  u.payments.push(p("stake", 100, "STAKED", t - 3000), p("unstake", 0, "UNSTAKING", t - 2000), p("stake", 25, "STAKED", t - 1000));
  v.payments.push(p("stake", 10, "STAKED", t - 1000));
  u.seen = { usdc: "1250", near: "0" };
  const m = metrics(store.all(), t);
  assert.equal(m.tvl.stakingUsd, 35, "u's first 100 is being unstaked; the 25 staked after it and v's 10 count");
  assert.equal(m.tvl.heldNowUsd, 12.5);
});

test("stats page: needs the password, only by GET, and not indexed", async () => {
  process.env["MOOPAY_STAT_PASSWORD"] = "pw-for-test";
  const auth = { authorization: "Basic " + Buffer.from("team:pw-for-test").toString("base64") };
  const store = await AgentStore.open(join(mkdtempSync(join(tmpdir(), "moopay-stat-")), "a.json"));
  const server = createServer((req, res) => { const p = new URL(req.url ?? "/", "http://x").pathname; if (!handleStat(req, res, p, () => store.all(), Date.now())) { res.statusCode = 404; res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${root}/stat`)).status, 401);
    assert.equal((await fetch(`${root}/stat/data`, { headers: { authorization: "Basic " + Buffer.from("x:wrong").toString("base64") } })).status, 401);
    const page = await fetch(`${root}/stat`, { headers: auth });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-robots-tag"), "noindex");
    assert.match(await page.text(), /MooPay stats/);
    const data = await fetch(`${root}/stat/data`, { headers: auth });
    assert.equal(data.status, 200);
    assert.equal(((await data.json()) as { users: { total: number } }).users.total, 0);
    assert.equal((await fetch(`${root}/stat/data`, { method: "POST", headers: auth })).status, 404);
  } finally { server.close(); }
});

test("stats: the ledger keeps payments that dropped off a user's recent list, and survives a restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "moopay-stat-")), "a.json");
  const a = await AgentStore.open(path);
  const u = a.open("a".repeat(43));
  u.payments.push({ id: "p1", kind: "stake", amountUsd: 10, chain: "near", recipient: "x.near", status: "STAKED", createdAt: Date.now(), settled: true });
  u.seen = { usdc: "700", near: "0" };
  a.save(); await a.flush();
  u.payments.length = 0; u.seen = { usdc: "0", near: "0" }; a.save(); await a.flush();
  const b = await AgentStore.open(path);
  const m = metrics(b.all(), Date.now(), b.history());
  assert.equal(m.money.byKindUsd.staked, 10);
  assert.equal(m.tvl.stakingUsd, 10);
  assert.equal(m.tvl.depositsUsd, 7, "the most the wallet ever held");
});

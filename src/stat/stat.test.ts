import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentStore } from "../agent/index.js";
import { handleStat } from "./index.js";
import { metrics } from "./metrics.js";

/** Signs in through the password box and returns the cookie header to send after. */
async function signIn(root: string, password = "pw-for-test"): Promise<Record<string, string>> {
  const r = await fetch(`${root}/stat/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(r.status, 200);
  return { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0]! };
}

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
  assert.equal(m.tv.totalUsd, 150, "TV adds up every completed dollar: sends, the stake and the deposit");
  assert.equal(m.tv.transactions, 5);
  assert.ok(m.tv.since);
  assert.equal(m.money.averageUsd, 30);
  assert.equal(m.money.largestUsd, 50);
  assert.deepEqual(m.tvl, { totalUsd: 90, depositsUsd: 50, stakingUsd: 40, stakedEverUsd: 40, heldNowUsd: 0, stakers: 1 });
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

test("stats page: only a password box until you sign in; no user name; two-hour cookie; GET only; not indexed", async () => {
  process.env["MOOPAY_STAT_PASSWORD"] = "pw-for-test";
  const store = await AgentStore.open(join(mkdtempSync(join(tmpdir(), "moopay-stat-")), "a.json"));
  let clock = Date.now();
  const server = createServer((req, res) => { const p = new URL(req.url ?? "/", "http://x").pathname; if (!handleStat(req, res, p, () => store.all(), clock, undefined, undefined)) { res.statusCode = 404; res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const first = await fetch(`${root}/stat`);
    const box = await first.text();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-robots-tag"), "noindex");
    assert.match(box, /type="password"/);
    assert.doesNotMatch(box, /Live transactions|user name/i, "nothing but the box is shown");
    assert.equal((await fetch(`${root}/stat/data`)).status, 401, "no numbers without signing in");
    assert.equal((await fetch(`${root}/stat/export.csv`)).status, 401);
    const wrong = await fetch(`${root}/stat/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
    assert.equal(wrong.status, 401);
    assert.match(((await wrong.json()) as { error: string }).error, /isn't right/);
    const auth = await signIn(root);
    const page = await fetch(`${root}/stat`, { headers: auth });
    assert.match(await page.text(), /MooPay stats/);
    assert.match(page.headers.get("set-cookie") ?? "", /HttpOnly.*SameSite=Strict|SameSite=Strict.*HttpOnly/);
    const data = await fetch(`${root}/stat/data`, { headers: auth });
    assert.equal(data.status, 200);
    assert.equal(((await data.json()) as { users: { total: number } }).users.total, 0);
    assert.equal((await fetch(`${root}/stat/data`, { method: "PUT", headers: auth })).status, 404);
    assert.equal((await fetch(`${root}/stat/data`, { headers: { cookie: auth["cookie"]!.replace(/\.[\w-]+$/, ".forged") } })).status, 401, "a forged cookie does not pass");
    clock += 2 * 3_600_000 + 1000;
    assert.equal((await fetch(`${root}/stat/data`, { headers: auth })).status, 401, "two hours later the cookie is no good");
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

test("stats: other runs report in, the page can show all, the real site or test runs, and the rows export to CSV", async () => {
  process.env["MOOPAY_STAT_PASSWORD"] = "pw-for-test";
  process.env["MOOPAY_ENV"] = "production";
  try {
    const store = await AgentStore.open(join(mkdtempSync(join(tmpdir(), "moopay-stat-")), "a.json"));
    const u = store.open("a".repeat(43)), t = Date.now();
    u.payments.push({ id: "own1", kind: "send", amountUsd: 10, chain: "sol", recipient: "x", status: "DELIVERED", createdAt: t, settled: true });
    const server = createServer((req, res) => { const p = new URL(req.url ?? "/", "http://x").pathname; if (!handleStat(req, res, p, () => store.all(), Date.now(), store.history(), (rows) => store.ingest(rows))) { res.statusCode = 404; res.end(); } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const basic = await signIn(root), bearer = { authorization: "Bearer pw-for-test", "content-type": "application/json" };
    const row = (id: string, o: Record<string, unknown> = {}) => ({ key: `development:localhost:${id}`, id, who: "ab".repeat(8), env: "development", host: "localhost", kind: "send", chain: "near", amountUsd: 7, status: "DELIVERED", createdAt: t, settled: true, ...o });
    try {
      const post = (rows: unknown[], headers: Record<string, string> = bearer) => fetch(`${root}/stat/ingest`, { method: "POST", headers, body: JSON.stringify({ rows }) });
      assert.equal((await post([row("x")], { ...bearer, authorization: "Bearer nope" })).status, 401, "wrong password");
      const ok = await post([row("t1"), row("t2", { kind: "fund", amountUsd: 20 }), row("t3", { kind: "stake", amountUsd: 5, status: "STAKED" }), row("t4", { tag: "group" }), row("t5", { tag: "scheduled" }), row("t6", { chain: "eth" }), row("t7", { kind: "swap", amountUsd: 3 }),
        row("bad1", { amountUsd: -5 }), row("bad2", { env: "staging" }), row("bad3", { kind: "hack" }), row("bad4", { host: "a b" })]);
      assert.deepEqual(await ok.json(), { kept: 7 }, "bad rows are dropped");
      await post([row("t1", { amountUsd: 9 })]); // the same row again replaces the old one
      const get = async (q: string) => (await (await fetch(`${root}/stat/data${q}`, { headers: basic })).json()) as ReturnType<typeof metrics>;
      const all = await get("?env=all"), prod = await get("?env=production"), dev = await get("?env=development");
      assert.equal(prod.money.movedUsd, 10, "the real site only: its own $10");
      assert.equal(dev.money.movedUsd, 9 + 20 + 5 + 7 + 7 + 7, "test runs only: sends, deposit, stake, group, scheduled, bridged; the swap is not 'moved'");
      assert.equal(all.money.movedUsd, prod.money.movedUsd + dev.money.movedUsd);
      assert.equal(dev.users.total, 1, "one reporting user");
      assert.equal(all.users.total, 2, "the real site's user and the reporting one");
      assert.deepEqual(Object.fromEntries(Object.entries(dev.types).map(([k, v]) => [k, v.count])), { sending: 1, received: 1, swapped: 1, bridged: 1, stakes: 1, claims: 0, scheduled: 1, group: 1 });
      assert.equal(prod.types["bridged"]!.count, 1, "a send to another chain is a bridge");
      assert.equal(all.recent.length, 8);
      assert.ok(all.recent.every((r) => r.host && r.type));
      const file = await (await fetch(`${root}/stat/export.csv?env=development`, { headers: basic })).text();
      assert.match(file, /^time,environment,host,type,kind,chain,usd,status,id\n/);
      assert.equal(file.trim().split("\n").length, 1 + 7);
      assert.equal((await fetch(`${root}/stat/export.csv`)).status, 401, "the export needs the password too");
    } finally { server.close(); }
  } finally { delete process.env["MOOPAY_ENV"]; }
});

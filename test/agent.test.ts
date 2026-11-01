import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTurn, type Llm } from "../src/agent/loop.js";
import { AgentOps, type Sponsor } from "../src/agent/ops.js";
import { decide, rulesNeedApproval } from "../src/agent/policy.js";
import { AgentStore } from "../src/agent/store.js";
import { tick } from "../src/agent/worker.js";
import { ClaimDesk } from "../src/lib/claims.js";
import type { NearOps } from "../src/lib/origin.js";
import { MooPayService } from "../src/lib/service.js";
import { Ledger } from "../src/lib/state.js";
import { Stats } from "../src/lib/stats.js";
import type { OneClick } from "../src/lib/oneclick.js";
import { ETH_ADDR, FakeNear, FakeOneClick, TOKENS } from "./helpers.js";

const BOB = "bob.near";
const TOKEN = "t".repeat(43);
const USDC_CONTRACT = TOKENS[1]!.contractAddress!;

function agent(sponsor?: Sponsor) {
  const dir = mkdtempSync(join(tmpdir(), "moopay-agent-"));
  const oc = new FakeOneClick(), near = new FakeNear();
  let now = 1_800_000_000_000;
  let svc!: MooPayService;
  const claims = new ClaimDesk({ near: near as unknown as NearOps, tokens: () => svc.payAssets(), units: (t, tok) => svc.claimUnits(t, tok as never), swapOut: (p) => svc.claimSwapOut(p), file: join(dir, "c.json") });
  svc = new MooPayService({ ledger: new Ledger(join(dir, "s.json")), oneClick: oc as unknown as OneClick, near: near as unknown as NearOps, confidentiality: "basic", stats: new Stats(), claims });
  const store = new AgentStore(join(dir, "a.json"));
  const ops = new AgentOps(svc, store, () => now, sponsor);
  const u = store.open(TOKEN);
  const fund = (usd: number, nearUnits = 200_000_000_000_000_000_000_000n) => { near.tokenBalances.set(u.accountId, BigInt(Math.round(usd * 1e6))); near.nearBalances.set(u.accountId, nearUnits); };
  return { svc, oc, near, store, ops, u, fund, advance: (ms: number) => (now += ms), now: () => now };
}
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("policy: auto, ask, deny and rule changes", () => {
  const { u } = agent();
  const t = 1_800_000_000_000;
  assert.equal(decide(u, 5, "near:bob.near", t).action, "auto");
  assert.equal(decide(u, 15, "near:bob.near", t).action, "ask", "new recipient above $10");
  u.known.push("near:bob.near");
  assert.equal(decide(u, 15, "near:bob.near", t).action, "auto", "known recipient");
  assert.equal(decide(u, 30, "near:bob.near", t).action, "ask", "above the auto-approve limit");
  assert.equal(decide(u, 60, "near:bob.near", t).action, "deny", "above the daily cap");
  assert.equal(decide(u, 0, "x", t).action, "deny");
  assert.equal(rulesNeedApproval(u.rules, { ...u.rules, dailyCapUsd: 10 }), undefined, "tightening is free");
  assert.ok(rulesNeedApproval(u.rules, { ...u.rules, dailyCapUsd: 500 }), "loosening needs a yes");
  assert.equal(rulesNeedApproval(u.rules, { ...u.rules, payoutAddress: "me.near" }), undefined, "first payout is free");
  assert.ok(rulesNeedApproval({ ...u.rules, payoutAddress: "me.near" }, { ...u.rules, payoutAddress: "evil.near" }));
});

test("send to a NEAR wallet runs on its own within the rules, and refuses without funds", async () => {
  const a = agent();
  await assert.rejects(a.ops.send(a.u, { amountUsd: "5", chain: "near", recipient: BOB }), code("NOTE_NOT_FUNDED"));
  a.fund(20);
  const r = await a.ops.send(a.u, { amountUsd: "5", chain: "near", recipient: BOB });
  assert.equal(r.result["status"], "sent");
  assert.equal(a.near.transfers.at(-1)?.to, BOB);
  assert.equal(a.near.transfers.at(-1)?.amount, 5_000_000n);
  assert.equal(a.near.transfers.at(-1)?.tokenContract, USDC_CONTRACT);
  assert.equal(a.svc.publicStats().payments, 1);
  assert.equal(a.u.spent.usd, 5);
});

test("a big first payment waits for approval; approving runs it; declining does not", async () => {
  const a = agent();
  a.fund(100);
  const r = await a.ops.send(a.u, { amountUsd: "15", chain: "near", recipient: BOB });
  assert.equal(r.result["status"], "needs_approval");
  assert.equal(a.near.transfers.length, 0, "nothing moved yet");
  const done = await a.ops.resolve(a.u, r.result["approvalId"] as string, true, { origin: "https://x" });
  assert.equal(done.result["status"], "sent");
  assert.equal(a.near.transfers.length, 1);
  const r2 = await a.ops.send(a.u, { amountUsd: "30", chain: "near", recipient: BOB });
  const no = await a.ops.resolve(a.u, r2.result["approvalId"] as string, false, { origin: "https://x" });
  assert.equal(no.result["status"], "declined");
  assert.equal(a.near.transfers.length, 1);
  await assert.rejects(a.ops.resolve(a.u, r2.result["approvalId"] as string, true, { origin: "https://x" }), code("NOTE_NOT_FOUND"), "an answered approval cannot be reused");
  const over = await a.ops.send(a.u, { amountUsd: "80", chain: "near", recipient: BOB });
  assert.equal(over.result["status"], "denied");
});

test("cross-chain send: pays the 1Click deposit address from the agent wallet, then follows it to delivery", async () => {
  const a = agent();
  a.fund(50);
  const r = await a.ops.send(a.u, { amountUsd: "5", chain: "eth", recipient: ETH_ADDR, assetSymbol: "USDC" });
  assert.equal(r.result["status"], "sent");
  const q = a.oc.quotes.filter((x) => !x.dry).at(-1)!;
  assert.equal(q.refundTo, a.u.accountId);
  assert.equal(q.originAsset, TOKENS[1]!.assetId);
  assert.equal(a.near.transfers.at(-1)?.to, "dep-1");
  assert.equal(a.oc.submits.at(-1)?.depositAddress, "dep-1");
  const p = a.u.payments[0]!;
  a.oc.statuses.set("dep-1", "SUCCESS");
  const seen = await a.ops.refresh(a.u, p, { origin: "https://x" });
  assert.equal(seen.changed, true);
  assert.equal(p.status, "DELIVERED");
  await assert.rejects(a.ops.send(a.u, { amountUsd: "5", chain: "eth", recipient: "0x123" }), code("BAD_RECIPIENT"));
});

test("private claim is funded from the agent wallet and returns a link", async () => {
  const a = agent();
  a.fund(50);
  const r = await a.ops.claim(a.u, { amountUsd: "4", receiver: BOB }, { origin: "https://x" });
  assert.equal(r.result["status"], "created");
  assert.match(String(r.result["claimLink"]), /^https:\/\/x\/c\/[A-Za-z0-9_-]+$/);
  assert.equal(a.near.transfers.length, 2, "gas to the claim account, then the money");
  assert.equal(a.near.transfers[1]?.amount, 4_000_000n);
  await assert.rejects(a.ops.claim(a.u, { amountUsd: "4", receiver: "Not Valid!" }, { origin: "https://x" }), code("BAD_RECIPIENT"));
});

test("rules: first payout wallet is free, changing it needs a yes", async () => {
  const a = agent();
  assert.equal((await a.ops.rules(a.u, { payoutAddress: "me.near", floatUsd: 20 })).result["status"], "updated");
  const r = await a.ops.rules(a.u, { payoutAddress: "evil.near" });
  assert.equal(r.result["status"], "needs_approval");
  assert.equal(a.u.rules.payoutAddress, "me.near");
});

test("worker: sweeps money above the float to the payout wallet and announces deposits", async () => {
  const a = agent();
  await a.ops.rules(a.u, { payoutAddress: "me.near", floatUsd: 25 });
  a.fund(100.5);
  await tick(a.ops, a.store, "https://x", a.now());
  const sweep = a.near.transfers.at(-1)!;
  assert.equal(sweep.to, "me.near");
  assert.equal(sweep.amount, 75_500_000n);
  assert.ok(a.u.events.some((e) => /funded/.test(e.text)));
  assert.ok(a.u.events.some((e) => /above your float/.test(e.text)));
});

test("worker: scheduled payments follow the rules and then wait for the next period", async () => {
  const a = agent();
  a.fund(100);
  await a.ops.schedule(a.u, { amountUsd: "3", chain: "near", recipient: BOB, every: "week" });
  await tick(a.ops, a.store, "https://x", a.now());
  assert.equal(a.near.transfers.length, 0, "not due yet");
  a.advance(8 * 86_400_000);
  await tick(a.ops, a.store, "https://x", a.now());
  assert.equal(a.near.transfers.at(-1)?.to, BOB);
  assert.ok(a.u.tasks[0]!.nextAt > a.now());
});

test("agent loop: the model calls tools, rules still apply, and the reply is saved", async () => {
  const a = agent();
  a.fund(100);
  const script: { content: unknown[]; stop_reason: string }[] = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "send_money", input: { amountUsd: "30", chain: "near", recipient: BOB } }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "does_not_exist", input: {} }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "That needs your OK first." }] },
  ];
  const seen: unknown[] = [];
  const llm = { messages: { create: async (p: Record<string, unknown>) => { seen.push(p); return script.shift() as never; } } } as unknown as Llm;
  const events: { type: string; state?: string }[] = [];
  const out = await runTurn({ llm, model: "m", u: a.u, text: "send $30 to bob.near", ops: a.ops, svc: a.svc, ctx: { origin: "https://x" }, emit: (e) => events.push(e), context: "{}" });
  assert.equal(out, "That needs your OK first.");
  assert.equal(a.near.transfers.length, 0, "the model could not skip the approval");
  assert.ok(events.some((e) => e.type === "card"), "the approval card was shown");
  assert.deepEqual(events.filter((e) => e.type === "step").map((e) => e.state), ["running", "done", "running", "failed"]);
  assert.equal(a.u.chat.length, 2);
  const second = JSON.stringify((seen[2] as { messages: unknown }).messages);
  assert.match(second, /needs_approval/);
  assert.match(second, /unknown tool/);
});

test("agent loop: cancel works until a state-changing tool has run", async () => {
  const mk = (a: ReturnType<typeof agent>, ctl: { cancelled: boolean; ran: boolean }, tool: string, input: object) => {
    let n = 0;
    const llm = { messages: { create: async () => { n++; if (n === 1) { if (tool === "get_account") ctl.cancelled = true; return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: tool, input }] } as never; } if (tool !== "get_account") ctl.cancelled = true; return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } as never; } } } as unknown as Llm;
    const events: { type: string }[] = [];
    return { go: () => runTurn({ id: "x1", ctl, llm, model: "m", u: a.u, text: "hi", ops: a.ops, svc: a.svc, ctx: { origin: "https://x" }, emit: (e) => events.push(e), context: "{}" }), events };
  };
  const a = agent();
  const c1 = { cancelled: false, ran: false };
  const r1 = mk(a, c1, "get_account", {});
  assert.equal(await r1.go(), "");
  assert.ok(r1.events.some((e) => e.type === "cancelled"));
  assert.equal(a.u.chat.length, 0, "nothing saved");
  a.fund(50);
  const c2 = { cancelled: false, ran: false };
  const r2 = mk(a, c2, "send_money", { amountUsd: "1", chain: "near", recipient: BOB });
  assert.equal(await r2.go(), "ok", "a send already ran, so the cancel is ignored");
  assert.equal(c2.ran, true);
  assert.deepEqual(a.u.chat.map((m) => m.id), ["x1", "x1"]);
});

const SOL_ADDR = "9hBYRgE2xFfgbFX24HLTehnhZXXnkY3ARtGSpDUaYJpp";

test("withdraw: goes to the payout wallet on its own, anywhere else needs a yes", async () => {
  const a = agent();
  a.fund(40);
  await assert.rejects(a.ops.withdraw(a.u, {}), code("INVALID_INPUT"), "no payout wallet set yet");
  await a.ops.rules(a.u, { payoutAddress: "me.near" });
  const r = await a.ops.withdraw(a.u, {});
  assert.equal(r.result["status"], "sent");
  assert.equal(a.near.transfers.at(-1)?.to, "me.near");
  assert.equal(a.near.transfers.at(-1)?.amount, 40_000_000n, "everything");
  const other = await a.ops.withdraw(a.u, { to: "elsewhere.near", amountUsd: "5" });
  assert.equal(other.result["status"], "needs_approval");
  assert.equal(a.near.transfers.length, 1);
  await a.ops.resolve(a.u, other.result["approvalId"] as string, true, { origin: "https://x" });
  assert.equal(a.near.transfers.at(-1)?.to, "elsewhere.near");
  assert.equal(a.near.transfers.at(-1)?.amount, 5_000_000n);
  a.near.nearBalances.set(a.u.accountId, 100_000_000_000_000_000_000_000n);
  await a.ops.withdraw(a.u, { asset: "NEAR" });
  assert.equal(a.near.transfers.at(-1)?.tokenContract, "NEAR");
  assert.equal(a.near.transfers.at(-1)?.amount, 95_000_000_000_000_000_000_000n, "leaves a little for the fee");
});

test("fund from another chain: quote pays USDC to the agent wallet, shows the exact amount, no agent funds move", async () => {
  const a = agent();
  const r = await a.ops.fundWallet(a.u, { amountUsd: "20", fromChain: "sol", refundAddress: SOL_ADDR });
  const q = a.oc.quotes.at(-1)!;
  assert.equal(q.dry, false);
  assert.equal(q.recipient, a.u.accountId);
  assert.equal(q.destinationAsset, TOKENS[1]!.assetId, "arrives as USDC on NEAR");
  assert.equal(q.refundTo, SOL_ADDR);
  assert.equal(q.amount, "200000000", "$20 at $100/SOL = 0.2 SOL");
  assert.equal((r.card as { amount: string }).amount, "0.2");
  assert.equal(a.near.transfers.length, 0);
  assert.equal(a.u.payments[0]?.kind, "fund");
  await assert.rejects(a.ops.fundWallet(a.u, { amountUsd: "20", fromChain: "sol", refundAddress: "nope" }), code("BAD_RECIPIENT"));
  await assert.rejects(a.ops.fundWallet(a.u, { amountUsd: "20", fromChain: "doge", refundAddress: "x" }), code("UNKNOWN_ASSET"));
  a.oc.statuses.set("dep-1", "SUCCESS");
  const seen = await a.ops.refresh(a.u, a.u.payments[0]!, { origin: "https://x" });
  assert.equal(seen.changed, true);
});

test("pay without depositing: a deposit address from the user's own wallet, or a signing link", async () => {
  const a = agent();
  const r = await a.ops.payFromWallet(a.u, { amountUsd: "5", fromChain: "sol", refundAddress: SOL_ADDR, toChain: "eth", recipient: ETH_ADDR, toSymbol: "USDC" });
  assert.equal(r.result["status"], "awaiting_your_deposit");
  const q = a.oc.quotes.at(-1)!;
  assert.equal(q.refundTo, SOL_ADDR);
  assert.equal(q.recipient, ETH_ADDR);
  assert.equal(a.near.transfers.length, 0, "nothing came out of the agent wallet");
  const l = await a.ops.paymentLink({ amountUsd: "5", toChain: "eth", recipient: ETH_ADDR, toSymbol: "USDC" }, { origin: "https://x" });
  assert.match(String(l.result["payLink"]), /^https:\/\/x\/p\/[A-Za-z0-9_-]+$/, "a public link without any shared secret");
});

test("gas sponsor: tops up a funded wallet with no NEAR once, within the daily cap", async () => {
  const a = agent({ accountId: "sponsor.near", secretKey: "ed25519:x", dailyMax: 1 });
  assert.equal(await a.ops.sponsorGas(a.u, 0n, 0n), false, "no money yet, no top-up");
  assert.equal(await a.ops.sponsorGas(a.u, 5_000_000n, 0n), true);
  const t = a.near.transfers.at(-1)!;
  assert.equal(t.to, a.u.accountId);
  assert.equal(t.accountId, "sponsor.near");
  assert.equal(await a.ops.sponsorGas(a.u, 5_000_000n, 0n), false, "only once per wallet");
  const other = a.store.open("u".repeat(43));
  assert.equal(await a.ops.sponsorGas(other, 5_000_000n, 0n), false, "daily cap reached");
  const none = agent();
  assert.equal(await none.ops.sponsorGas(none.u, 5_000_000n, 0n), false, "no sponsor configured");
});

test("agent keys: own limits, scope, expiry, budget, revoke, and the user's rules still apply", async () => {
  const a = agent();
  a.fund(100);
  const made = a.ops.createAgent(a.u, { name: "bot", dailyUsd: 8, perPaymentUsd: 6, totalUsd: 10, chains: ["near"], recipients: [BOB], hours: 1 });
  const key = (made.card as { key: string }).key;
  assert.ok(key.startsWith("mpk_"));
  assert.equal(JSON.stringify(made.result).includes(key), false, "the key never goes back to the model");
  assert.equal(a.store.byKey(key)?.ak.name, "bot");
  assert.equal(a.store.byKey("mpk_wrong"), undefined);
  assert.equal(JSON.stringify(a.u.agents).includes(key), false, "only a hash is stored");
  const ak = a.u.agents[0]!;
  const who = { ak };
  assert.match(String((await a.ops.send(a.u, { amountUsd: "5", chain: "sol", recipient: "So11111111111111111111111111111111111111112" }, false, who)).result["reason"]), /not on the allowed list/);
  assert.match(String((await a.ops.send(a.u, { amountUsd: "5", chain: "near", recipient: "eve.near" }, false, who)).result["reason"]), /recipient/);
  assert.match(String((await a.ops.send(a.u, { amountUsd: "7", chain: "near", recipient: BOB }, false, who)).result["reason"]), /per-payment/);
  assert.equal((await a.ops.send(a.u, { amountUsd: "5", chain: "near", recipient: BOB }, false, who)).result["status"], "sent");
  assert.equal(ak.totalSpent, 5);
  assert.match(String((await a.ops.send(a.u, { amountUsd: "5", chain: "near", recipient: BOB }, false, who)).result["reason"]), /daily|total/);
  assert.equal(a.u.spent.usd, 5, "denied payments spend nothing");
  // the user's own rules also bind the agent
  a.ops.createAgent(a.u, { name: "wide" });
  const wide = { ak: a.u.agents[1]! };
  await a.ops.rules(a.u, { allowedChains: ["sol"] });
  assert.match(String((await a.ops.send(a.u, { amountUsd: "1", chain: "near", recipient: BOB }, false, wide)).result["reason"]), /your rules/);
  assert.ok(rulesNeedApproval(a.u.rules, { ...a.u.rules, allowedChains: undefined }), "removing the list needs a yes");
  assert.equal(rulesNeedApproval(a.u.rules, { ...a.u.rules, allowedChains: ["sol"], allowedAssets: ["USDC"] }), undefined, "narrowing is free");
  assert.ok(rulesNeedApproval(a.u.rules, { ...a.u.rules, allowedChains: ["sol", "eth"] }), "allowing more needs a yes");
  // expiry and revoke
  a.advance(2 * 3_600_000);
  assert.match(String((await a.ops.send(a.u, { amountUsd: "1", chain: "sol", recipient: "x" }, false, who).catch(() => ({ result: { reason: "expired" } }))).result["reason"]), /expired|allowed/);
  a.ops.revokeAgent(a.u, "wide");
  assert.match(String((await a.ops.send(a.u, { amountUsd: "1", chain: "sol", recipient: "x" }, false, { ak: a.u.agents[1]! }).catch(() => ({ result: { reason: "revoked" } }))).result["reason"]), /revoked|allowed/);
});

test("agent keys: an agent's big payment waits for the user's OK, then counts against the key", async () => {
  const a = agent();
  a.fund(100);
  a.ops.createAgent(a.u, { name: "bot", dailyUsd: 40 });
  const ak = a.u.agents[0]!;
  const r = await a.ops.send(a.u, { amountUsd: "30", chain: "near", recipient: BOB }, false, { ak });
  assert.equal(r.result["status"], "needs_approval");
  assert.equal(ak.totalSpent, 0);
  const done = await a.ops.resolve(a.u, r.result["approvalId"] as string, true, { origin: "http://x" });
  assert.equal(done.result["status"], "sent");
  assert.equal(ak.totalSpent, 30);
  assert.equal(a.u.payments[0]?.agentId, ak.id);
});

test("one balance: NEAR counts as dollars, and a payment converts NEAR to USDC behind the scenes", async () => {
  const a = agent();
  a.near.tokenBalances.set(a.u.accountId, 0n);
  a.near.nearBalances.set(a.u.accountId, 4_000_000_000_000_000_000_000_000n); // 4 NEAR at $5
  const acct = await a.ops.account(a.u);
  assert.equal(acct.result["balanceUsd"], "20.00");
  assert.equal("near" in acct.result || "usdc" in acct.result, false, "no separate fee balance is shown");
  (a.ops as unknown as { pollMs: number }).pollMs = 1;
  // the fake swap lands USDC as soon as the deposit is sent
  const send = a.near.transferFromNote.bind(a.near);
  a.near.transferFromNote = async (p) => { const r = await send(p); if (p.tokenContract === "wrap.near") { a.oc.statuses.set(p.to, "SUCCESS"); a.near.tokenBalances.set(a.u.accountId, 5_000_000n); } return r; };
  const r = await a.ops.send(a.u, { amountUsd: "5", chain: "near", recipient: BOB });
  assert.equal(r.result["status"], "sent");
  assert.equal(a.near.wraps.length, 1, "wrapped just enough NEAR");
  assert.ok(a.near.wraps[0]! < 2_000_000_000_000_000_000_000_000n, "about $5, not the whole balance");
  assert.equal(a.near.transfers.at(-1)?.to, BOB);
  // not enough in total: a plain message with the balance, nothing is swapped
  const b = agent();
  b.near.tokenBalances.set(b.u.accountId, 0n); b.near.nearBalances.set(b.u.accountId, 200_000_000_000_000_000_000_000n);
  await assert.rejects(b.ops.send(b.u, { amountUsd: "5", chain: "near", recipient: BOB }), /Your balance is \$1\.00/);
});

test("send in coins: 0.1 NEAR goes straight from the wallet's NEAR, no swap", async () => {
  const a = agent();
  a.near.tokenBalances.set(a.u.accountId, 0n); a.near.nearBalances.set(a.u.accountId, 2_000_000_000_000_000_000_000_000n);
  const r = await a.ops.send(a.u, { amount: "0.1", assetSymbol: "NEAR", chain: "near", recipient: BOB });
  assert.equal(r.result["status"], "sent");
  const t = a.near.transfers.at(-1)!;
  assert.deepEqual([t.to, t.amount, t.tokenContract], [BOB, 100_000_000_000_000_000_000_000n, "NEAR"]);
  assert.equal(a.near.wraps.length, 0);
  assert.equal(a.u.payments[0]?.amountUsd, 0.5, "0.1 NEAR at $5 counts as $0.50 against the limits");
  assert.equal(a.oc.quotes.length, 0);
});

test("send in coins to another chain: priced in dollars, paid from USDC, receiver gets that coin", async () => {
  const a = agent();
  a.fund(50);
  const r = await a.ops.send(a.u, { amount: "0.09", assetSymbol: "SOL", chain: "sol", recipient: "So11111111111111111111111111111111111111112" });
  assert.equal(r.result["status"], "sent");
  const q = a.oc.quotes.find((x) => !x.dry)!;
  assert.equal(q.destinationAsset, "nep141:sol.omft.near");
  assert.equal(q.amount, "9090000", "0.09 SOL at $100 plus a 1% cushion");
  await assert.rejects(a.ops.send(a.u, { chain: "sol", recipient: "So11111111111111111111111111111111111111112" }), code("INVALID_INPUT"));
});

import { nearAiLlm, nearAiTier } from "../src/agent/nearai.js";

test("NEAR AI brain: OpenAI-format replies run the same tool loop, rules still apply", async () => {
  const a = agent();
  a.fund(40);
  const seen: { url: string; auth: string; body: Record<string, any> }[] = [];
  const replies = [
    { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", function: { name: "send_money", arguments: JSON.stringify({ amountUsd: "5", chain: "near", recipient: BOB }) } }, { id: "c2", function: { name: "send_money", arguments: "{not json" } }] } }] },
    { choices: [{ finish_reason: "stop", message: { content: "Sent $5 to bob.near." } }] },
  ];
  const fake = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url, auth: init.headers["authorization"]!, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  const events: any[] = [];
  const text = await runTurn({ llm: nearAiLlm("key-123", "https://ai.test/v1", fake), model: "m", u: a.u, text: "pay bob $5", ops: a.ops, svc: a.svc, ctx: { origin: "https://x" }, emit: (e) => events.push(e), context: "ctx" });
  assert.equal(text, "Sent $5 to bob.near.");
  assert.equal(a.near.transfers.at(-1)?.to, BOB, "the tool ran through the normal rules and wallet");
  assert.equal(seen[0]!.url, "https://ai.test/v1/chat/completions");
  assert.equal(seen[0]!.auth, "Bearer key-123");
  assert.equal(seen[0]!.body["tools"].find((t: any) => t.function.name === "send_money").type, "function");
  assert.equal(seen[0]!.body["messages"][0].role, "system");
  const second = seen[1]!.body["messages"] as any[];
  assert.equal(second.filter((m) => m.role === "tool").length, 2, "both tool results go back, the bad-JSON one as an error");
  assert.ok(second.find((m) => m.role === "assistant").tool_calls.length === 2);
  assert.match(second.filter((m) => m.role === "tool")[1].content, /INVALID_INPUT/);
  // errors keep their status so the retry and the user message work
  const down = (async () => new Response("busy", { status: 529 })) as unknown as typeof fetch;
  await assert.rejects(nearAiLlm("k", "https://ai.test/v1", down).messages.create({ model: "m", system: "", messages: [{ role: "user", content: "hi" }] }), (e: any) => e.status === 529);
});

test("NEAR AI tier: sealed models are labelled, anything unknown says so", async () => {
  const list = (async () => new Response(JSON.stringify({ models: [{ id: "a", owned_by: "nearai" }, { id: "b", owned_by: "anthropic" }, { id: "c", owned_by: "attested 3p" }] }))) as unknown as typeof fetch;
  assert.equal(await nearAiTier("a", "https://x/v1", list), "Confidential TEE");
  assert.equal(await nearAiTier("b", "https://x/v1", list), "Gateway only");
  assert.equal(await nearAiTier("c", "https://x/v1", list), "3rd-party TEE");
  assert.equal(await nearAiTier("zzz", "https://x/v1", list), "unknown");
  assert.equal(await nearAiTier("a", "https://x/v1", (async () => { throw new Error("offline"); }) as unknown as typeof fetch), "unknown");
});

const NEAR_1 = 10n ** 24n;
function rhea(a: ReturnType<typeof agent>) {
  const move = a.near.transferFromNote.bind(a.near);
  a.near.transferFromNote = async (p) => { // rNEAR transfers move the fake balances
    const r = await move(p);
    if (p.tokenContract === "lst.rhealab.near") { const k = (x: string) => `lst.rhealab.near|${x}`; a.near.otherTokens.set(k(p.accountId), (a.near.otherTokens.get(k(p.accountId)) ?? 0n) - p.amount); a.near.otherTokens.set(k(p.to), (a.near.otherTokens.get(k(p.to)) ?? 0n) + p.amount); }
    return r;
  };
  a.near.views.set("lst.rhealab.near.get_summary", { ft_price: "1250000000000000000000000" }); // 1 rNEAR = 1.25 NEAR
  // like the chain: staking mints rNEAR at that price, unwrapping wNEAR adds NEAR
  a.near.onCall = (c, who) => {
    if (c.method === "deposit_and_stake") a.near.otherTokens.set(`lst.rhealab.near|${who}`, (c.deposit * NEAR_1) / 1_250_000_000_000_000_000_000_000n);
    if (c.method === "near_withdraw") { const w = BigInt(String(c.args["amount"])); a.near.otherTokens.set(`wrap.near|${who}`, (a.near.otherTokens.get(`wrap.near|${who}`) ?? 0n) - w); a.near.nearBalances.set(who, (a.near.nearBalances.get(who) ?? 0n) + w); }
  };
}

test("stake rNEAR: stakes from the wallet's NEAR and the rNEAR lands in the user's own wallet", async () => {
  const a = agent(); rhea(a);
  a.near.tokenBalances.set(a.u.accountId, 0n); a.near.nearBalances.set(a.u.accountId, 3n * NEAR_1);
  await assert.rejects(a.ops.stakeRnear(a.u, { amount: "1" }), /payout wallet first/, "rNEAR needs somewhere of the user's own to go");
  await a.ops.rules(a.u, { payoutAddress: "me.near" });
  await assert.rejects(a.ops.stakeRnear(a.u, { amount: "0.01" }), code("INVALID_INPUT"));
  const r = await a.ops.stakeRnear(a.u, { amount: "1" });
  assert.equal(r.result["status"], "staked");
  assert.equal(r.result["receives"], "about 0.8 rNEAR");
  const stake = a.near.calls.find((c) => c.method === "deposit_and_stake")!;
  assert.deepEqual([stake.contractId, stake.deposit, stake.gas], ["lst.rhealab.near", NEAR_1, 200_000_000_000_000n]);
  assert.ok(a.near.calls.some((c) => c.method === "storage_deposit"), "registers on the rNEAR token first");
  const out = a.near.transfers.at(-1)!;
  assert.deepEqual([out.tokenContract, out.to, out.amount], ["lst.rhealab.near", "me.near", 800_000_000_000_000_000_000_000n]);
  assert.equal(a.u.payments[0]?.kind, "stake");
  assert.equal(a.u.spent.usd, 5, "1 NEAR at $5 counts against the daily limit");
  const pos = await a.ops.rnearPosition(a.u);
  assert.equal(pos.result["priceNearPerRnear"], "1.25");
  assert.equal(pos.result["rnear"], "0.8", "counted from me.near; nothing is left in the agent wallet");
  assert.equal(await a.near.ftBalance("lst.rhealab.near", a.u.accountId), 0n);
});

test("stake rNEAR: limits apply, and a big stake waits for the user's OK", async () => {
  const a = agent(); rhea(a);
  a.near.nearBalances.set(a.u.accountId, 20n * NEAR_1);
  await a.ops.rules(a.u, { payoutAddress: "me.near" });
  const big = await a.ops.stakeRnear(a.u, { amountUsd: "30" }); // above the $25 auto-approve limit
  assert.equal(big.result["status"], "needs_approval");
  assert.equal(a.near.calls.some((c) => c.method === "deposit_and_stake"), false);
  const done = await a.ops.resolve(a.u, big.result["approvalId"] as string, true, { origin: "https://x" });
  assert.equal(done.result["status"], "staked");
  const over = await a.ops.stakeRnear(a.u, { amountUsd: "40" }); // 30 + 40 passes the $50 daily cap
  assert.equal(over.result["status"], "denied");
});

test("stake rNEAR: pays with USDC when the wallet holds no spare NEAR, converting quietly", async () => {
  const a = agent(); rhea(a);
  (a.ops as unknown as { pollMs: number }).pollMs = 1;
  await a.ops.rules(a.u, { payoutAddress: "me.near" });
  a.fund(50, NEAR_1 / 10n); // $50 USDC and only 0.1 NEAR: enough to pay fees, not to stake
  const send = a.near.transferFromNote.bind(a.near);
  a.near.transferFromNote = async (p) => { // the 1Click swap lands wNEAR in the wallet
    const r = await send(p);
    if (p.tokenContract !== "lst.rhealab.near" && p.to.startsWith("dep-")) { a.oc.statuses.set(p.to, "SUCCESS"); a.near.otherTokens.set(`wrap.near|${a.u.accountId}`, 3n * NEAR_1); }
    return r;
  };
  const r = await a.ops.stakeRnear(a.u, { amount: "0.5" });
  assert.equal(r.result["status"], "staked");
  const q = a.oc.quotes.find((x) => !x.dry)!;
  assert.equal(q.destinationAsset, "nep141:wrap.near", "swapped into wNEAR");
  assert.ok(a.near.calls.some((c) => c.method === "near_withdraw"), "unwrapped to plain NEAR before staking");
  assert.ok(a.near.calls.some((c) => c.method === "deposit_and_stake"));
});

import { plain } from "../src/agent/loop.js";

test("plain: markdown is stripped and bullets become a numbered list", () => {
  const raw = "I can do these things:\n\n- **Send money** to wallets, in dollars.\n- **Create private claims** that expire.\n* `Withdraw` any time\n\nUse __bold__ and *italic* and a * b. # not a heading\n## Next steps\n1. keep this\n2. and this";
  assert.equal(plain(raw), "I can do these things:\n\n1. Send money to wallets, in dollars.\n2. Create private claims that expire.\n3. Withdraw any time\n\nUse bold and italic and a * b. # not a heading\nNext steps\n1. keep this\n2. and this");
  assert.equal(plain("Sent $5 to bob.near."), "Sent $5 to bob.near.");
  assert.equal(plain("Costs 2*3 and 5 * 4 = 20"), "Costs 2*3 and 5 * 4 = 20");
});

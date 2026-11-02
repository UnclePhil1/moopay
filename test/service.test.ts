import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MoopayError } from "../src/lib/errors.js";
import { commitmentOf, deriveNoteAccount, parseSecret } from "../src/lib/crypto.js";
import { Ledger } from "../src/lib/state.js";
import { ETH_ADDR, ETH_USDC, USDC, mintFunded, routeArgs, setup } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof MoopayError && e.code === c;
const SOL = "11111111111111111111111111111111";

test("mint: per-note account derives from the secret; nothing secret persisted; no 1Click quote needed", async () => {
  const ctx = setup();
  const m = await ctx.service.mint({ assetId: USDC, amount: "123456789012345678901234567890", memo: "rent" });
  const secret = parseSecret(m.secretKeyString);
  assert.equal(commitmentOf(secret), m.commitment);
  assert.equal(m.escrow.address, deriveNoteAccount(secret).accountId);
  assert.match(m.escrow.address, /^[0-9a-f]{64}$/);
  assert.equal(m.escrow.amount, 123456789012345678901234567890n);
  assert.equal(ctx.oc.quotes.length, 0, "mint creates no 1Click deposit address and moves nothing");
  assert.ok(m.warnings.some((w) => /shown once/.test(w)));
  assert.equal(m.fundingSteps.length, 3);
  const file = readFileSync(ctx.ledger.filePath, "utf8");
  assert.ok(!file.includes(m.secretKeyString.slice(8)), "secret must not be persisted");
  assert.ok(!file.includes(deriveNoteAccount(secret).secretKey.slice(8)), "note key must not be persisted");
  assert.ok(!file.includes("rent"), "memo stored hashed only");
  const m2 = await ctx.service.mint({ assetId: USDC, amount: "1" });
  assert.notEqual(m2.commitment, m.commitment);
  assert.notEqual(m2.escrow.address, m.escrow.address);
});

test("mint input validation", async () => {
  const { service } = setup();
  await assert.rejects(service.mint({ assetId: USDC, amount: "0" }), code("INVALID_INPUT"));
  await assert.rejects(service.mint({ assetId: USDC, amount: "-5" }), code("INVALID_INPUT"));
  await assert.rejects(service.mint({ assetId: USDC, amount: 5 }), code("INVALID_INPUT"));
  await assert.rejects(service.mint({ assetId: "nep141:nope", amount: "1" }), code("UNKNOWN_ASSET"));
  await assert.rejects(service.mint({ assetId: (await import("./helpers.js")).ETH_USDC, amount: "1" }), code("INVALID_INPUT"));
});

test("claim: funding is read from chain; token and NEAR-for-gas both required", async () => {
  const ctx = setup();
  const m = await ctx.service.mint({ assetId: USDC, amount: "1000" });
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString)), code("NOTE_NOT_FUNDED"));
  ctx.near.fund(m.escrow.address, 1000n, 0n); // tokens but no gas
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString)), /0\.01 NEAR/);
  ctx.near.fund(m.escrow.address, 999n); // short
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString)), code("NOTE_NOT_FUNDED"));
  await assert.rejects(ctx.service.route(routeArgs("moopay1_" + "0".repeat(64), { originAssetId: USDC })), code("NOTE_NOT_FUNDED"));
  assert.equal(ctx.transfers.length, 0);
});

test("claim: dryRun returns quote and leaves the ledger byte-identical", async () => {
  const ctx = setup();
  const m = await mintFunded(ctx);
  const before = readFileSync(ctx.ledger.filePath, "utf8");
  const r = await ctx.service.route({ ...routeArgs(m.secretKeyString), dryRun: undefined });
  assert.equal(r.dryRun, true);
  assert.equal((r as { ledgerChanged: boolean }).ledgerChanged, false);
  assert.match((r as { claimBinding: string }).claimBinding, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(ctx.ledger.filePath, "utf8"), before);
  assert.equal(ctx.oc.quotes.at(-1)?.dry, true);
  assert.equal(ctx.oc.quotes.at(-1)?.confidentiality, "basic");
  assert.equal(ctx.oc.quotes.at(-1)?.refundTo, m.escrow.address, "refunds return to the note account");
  assert.equal(ctx.transfers.length, 0);
});

test("claim from a machine that never minted the note needs originAssetId and uses the on-chain balance", async () => {
  const minter = setup();
  const m = await mintFunded(minter, "777");
  const other = setup();
  other.near.fund(m.escrow.address, 777n);
  await assert.rejects(other.service.route(routeArgs(m.secretKeyString)), code("INVALID_INPUT"));
  const r = await other.service.route(routeArgs(m.secretKeyString, { originAssetId: USDC })) as { txHash: string };
  assert.equal(r.txHash, "tx-1");
  assert.equal(other.transfers[0]?.amount, 777n);
  assert.equal(other.transfers[0]?.accountId, m.escrow.address);
  assert.equal(other.transfers[0]?.secretKey, deriveNoteAccount(parseSecret(m.secretKeyString)).secretKey);
});

test("route: bad recipient, mismatched destination asset, mode validation", async () => {
  const ctx = setup();
  const m = await mintFunded(ctx);
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString, { recipient: "0x123" })), code("BAD_RECIPIENT"));
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString, { destinationChain: "sol", recipient: SOL })), code("INVALID_INPUT"));
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString, { amount: "5" })), code("INVALID_INPUT")); // amount not allowed in claim mode
  await assert.rejects(ctx.service.route({ destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: ETH_ADDR }), /originAssetId/); // direct mode missing fields
});

test("claim: executes once; double-claim rejected; recipient not persisted", async () => {
  const ctx = setup();
  const m = await mintFunded(ctx);
  const r = await ctx.service.route(routeArgs(m.secretKeyString)) as { txHash: string; depositAddress: string; intentId: string };
  assert.equal(r.txHash, "tx-1");
  assert.deepEqual(ctx.oc.submits, [{ depositAddress: r.depositAddress, txHash: "tx-1" }]);
  assert.equal(ctx.transfers[0]?.to, r.depositAddress);
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString)), code("NOTE_ALREADY_CLAIMED"));
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString, { recipient: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" })), code("NOTE_ALREADY_CLAIMED"));
  assert.equal(ctx.transfers.length, 1);
  const file = readFileSync(ctx.ledger.filePath, "utf8");
  assert.ok(!file.includes(ETH_ADDR));
  assert.equal(JSON.parse(file).nullifiers[r.intentId].state, "CLAIMING");
});

test("claim: concurrent calls spend exactly once", async () => {
  const ctx = setup();
  const m = await mintFunded(ctx);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => ctx.service.route(routeArgs(m.secretKeyString))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(ctx.transfers.length, 1);
});

test("claim: failure before broadcast releases; transfer failure releases; timeout keeps it reserved", async () => {
  const a = setup();
  const m = await mintFunded(a);
  a.oc.failNextQuote = true;
  await assert.rejects(a.service.route(routeArgs(m.secretKeyString)), code("QUOTE_FAILED"));
  assert.equal(a.ledger.nullifierState((await a.service.noteStatus(m.commitment)).nullifierHash), "UNUSED");
  a.near.failTransfer = () => new MoopayError("DEPOSIT_FAILED", "ft_transfer failed");
  await assert.rejects(a.service.route(routeArgs(m.secretKeyString)), code("DEPOSIT_FAILED"));
  a.near.failTransfer = undefined;
  await a.service.route(routeArgs(m.secretKeyString)); // retry works

  const b = setup();
  const m2 = await mintFunded(b);
  b.near.failTransfer = () => new MoopayError("UPSTREAM_TIMEOUT", "rpc");
  await assert.rejects(b.service.route(routeArgs(m2.secretKeyString)), code("UPSTREAM_TIMEOUT"));
  await assert.rejects(b.service.route(routeArgs(m2.secretKeyString)), code("NOTE_ALREADY_CLAIMED"));
});

test("status: reports chain funding; REFUNDED frees the nullifier; SUCCESS spends it", async () => {
  const ctx = setup();
  const m = await mintFunded(ctx);
  assert.equal((await ctx.service.noteStatus(m.commitment) as { funding: { funded: boolean } }).funding.funded, true);
  const r = await ctx.service.route(routeArgs(m.secretKeyString)) as { depositAddress: string; intentId: string };
  ctx.oc.statuses.set(r.depositAddress, "PROCESSING");
  assert.equal((await ctx.service.noteStatus(r.intentId)).status, "CLAIMING");
  ctx.oc.statuses.set(r.depositAddress, "REFUNDED");
  const refunded = await ctx.service.noteStatus(r.intentId);
  assert.equal(refunded.status, "MINTED");
  assert.equal(refunded.nullifier, "UNUSED");
  const r2 = await ctx.service.route(routeArgs(m.secretKeyString)) as { depositAddress: string };
  ctx.oc.statuses.set(r2.depositAddress, "SUCCESS");
  const done = await ctx.service.noteStatus(m.commitment);
  assert.equal(done.status, "CLAIMED");
  assert.equal(done.nullifier, "SPENT");
  await assert.rejects(ctx.service.route(routeArgs(m.secretKeyString)), code("NOTE_ALREADY_CLAIMED"));
});

test("direct: sender-pays quote, no secret, no ledger, no signing", async () => {
  const ctx = setup();
  const args = { originAssetId: USDC, amount: "2500000", refundTo: "sender.near", destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: ETH_ADDR };
  const dry = await ctx.service.route(args) as { mode: string; dryRun: boolean };
  assert.deepEqual([dry.mode, dry.dryRun], ["direct", true]);
  assert.equal(ctx.oc.quotes.at(-1)?.dry, true);
  const live = await ctx.service.route({ ...args, dryRun: false }) as { depositAddress: string; pay: { amount: bigint }; trackWith: { resource: string } };
  assert.equal(live.pay.amount, 2500000n);
  assert.equal(ctx.oc.quotes.at(-1)?.refundTo, "sender.near");
  assert.equal(ctx.oc.quotes.at(-1)?.amount, "2500000");
  assert.equal(live.trackWith.resource, `moopay://deposit/${live.depositAddress}`);
  assert.equal(ctx.transfers.length, 0);
  assert.equal(ctx.oc.submits.length, 0);
  assert.equal((await ctx.service.depositStatus(live.depositAddress)).status, "PENDING_DEPOSIT");
  await assert.rejects(ctx.service.route({ ...args, originAssetId: "nep141:nope" }), code("UNKNOWN_ASSET"));
});

test("ledger reloads from disk", async () => {
  const ctx = setup();
  const m = await mintFunded(ctx);
  await ctx.service.route(routeArgs(m.secretKeyString));
  const reloaded = new Ledger(ctx.ledger.filePath);
  assert.equal(reloaded.get(m.commitment)?.status, "CLAIMING");
  assert.equal(reloaded.get(m.commitment)?.amount, 1000000n);
});

test("pay link: needs HTTP prefix; page API builds the exact transfer the wallet signs", async () => {
  const ctx = setup();
  const args = { destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: ETH_ADDR, payAmount: "2.5" };
  await assert.rejects(ctx.service.route(args), /HTTP mode/);
  await assert.rejects(ctx.service.route({ ...args, payAmount: "2.5", amount: "5" }, { payLinkPrefix: "https://x/pay/t" }), code("INVALID_INPUT"));
  await assert.rejects(ctx.service.route({ ...args, payAmount: "1.1234567" }, { payLinkPrefix: "https://x/pay/t" }), code("INVALID_INPUT"));

  const r = await ctx.service.route(args, { payLinkPrefix: "https://x/pay/t" }) as { payLink: string };
  assert.match(r.payLink, /^https:\/\/x\/pay\/t\/[A-Za-z0-9_-]{6,}$/);
  assert.equal(ctx.oc.quotes.length, 0, "creating a link makes no quote and moves nothing");
  const id = r.payLink.split("/").pop()!;

  const view = await ctx.service.payIntentView(id);
  assert.equal(view.payAmount, "2.5");
  assert.deepEqual(view.assets.filter((a) => a.chain === "near").map((a) => a.symbol), ["USDC", "NEAR"]);
  assert.ok(view.assets.some((a) => a.chain === "sol" && a.native), "other chains are offered too");

  const est = await ctx.service.payEstimate(id, USDC);
  assert.equal(est.amountIn, 2500000n);
  assert.equal(ctx.oc.quotes.at(-1)?.dry, true);

  await assert.rejects(ctx.service.payQuote(id, USDC, "not an account!"), code("INVALID_INPUT"));
  await assert.rejects(ctx.service.payQuote(id, ETH_USDC, "me.near"), code("INVALID_INPUT")); // not an offered asset
  const q = await ctx.service.payQuote(id, USDC, "me.near");
  assert.equal(ctx.oc.quotes.at(-1)?.dry, false);
  assert.equal(ctx.oc.quotes.at(-1)?.refundTo, "me.near");
  assert.equal(ctx.oc.quotes.at(-1)?.amount, "2500000");
  assert.equal(q.transfer.amount, 2500000n);
  assert.equal(q.transfer.receiverId, q.depositAddress);
  assert.equal(q.transfer.needsRegistration, true);
  ctx.near.registered.add("dep-2");
  assert.equal((await ctx.service.payQuote(id, USDC, "me.near")).transfer.needsRegistration, false);
  assert.equal(ctx.transfers.length, 0, "MooPay signs nothing");
  assert.equal(q.transfer.native, false);

  // Plain NEAR: dollars are converted at the listed price (fake: $5), rounded up; unregistered sender wraps extra for storage.
  const near = await ctx.service.payQuote(id, "nep141:wrap.near", "me.near");
  assert.equal(near.transfer.amount, 500000000000000000000000n); // $2.50 / $5 = 0.5 NEAR
  assert.equal(near.transfer.native, true);
  assert.equal(near.transfer.wrapDeposit, 500000000000000000000000n + 1250000000000000000000n);
  ctx.near.registered.add("me.near");
  assert.equal((await ctx.service.payQuote(id, "nep141:wrap.near", "me.near")).transfer.wrapDeposit, 500000000000000000000000n);
  assert.equal((await ctx.service.payEstimate(id, "nep141:wrap.near")).paySymbol, "NEAR");
  await assert.rejects(ctx.service.payIntentView("nope-nope"), code("NOTE_NOT_FOUND"));
});

test("pay status: waits, then counts a delivered payment once in the public stats", async () => {
  const ctx = setup();
  const r = await ctx.service.route({ destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: ETH_ADDR, payAmount: "2.5" }, { payLinkPrefix: "https://x/pay/t" }) as { payLink: string };
  const id = r.payLink.split("/").pop()!;
  assert.equal((await ctx.service.payStatus(id)).state, "WAITING_FOR_USER");
  const q = await ctx.service.payQuote(id, USDC, "me.near");
  assert.equal((await ctx.service.payStatus(id)).state, "PENDING_DEPOSIT");
  assert.deepEqual(ctx.service.publicStats(), { payments: 0, volumeUsd: 0, users: 0 });
  ctx.oc.statuses.set(q.depositAddress, "SUCCESS");
  assert.equal((await ctx.service.payStatus(id)).state, "SUCCESS");
  await ctx.service.payStatus(id);
  assert.deepEqual(ctx.service.publicStats(), { payments: 1, volumeUsd: 2.5, users: 1 });
});

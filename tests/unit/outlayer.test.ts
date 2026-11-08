import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { OutLayer, OutLayerError } from "../../src/agent/outlayer.js";

/** A stand-in for OutLayer that answers the way its docs say it does. */
async function fake() {
  const seen: { method: string; url: string; auth?: string | undefined; idem?: string | undefined; body: unknown }[] = [];
  let polls = 0;
  const server = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, idem: req.headers["x-idempotency-key"] as string | undefined, body });
      const send = (code: number, j: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      if (req.url === "/register") return send(200, { api_key: "wk_test", near_account_id: "a".repeat(64), wallet_id: "w1" });
      if (req.url === "/wallet/v1/confidential/withdraw/dry-run") return send(200, { amount_in: "500000", amount_out: "440000", min_amount_out: "435600", time_estimate_seconds: 7 });
      if (req.url === "/wallet/v1/confidential/withdraw") return send(200, { request_id: "r1", status: "pending_deposit", intent_hash: "h", deposit_address: "d" });
      if (req.url === "/wallet/v1/requests/r1") return send(200, ++polls < 3 ? { status: "pending_deposit" } : { status: "success", result: { swap_details: { destinationChainTxHashes: ["0xabc"] } } });
      if (req.url === "/wallet/v1/confidential/balance") return send(403, { code: "wallet_frozen", message: "frozen" });
      if (req.url === "/wallet/v1/tokens") return send(502, { code: "confidential_jwt_expired", message: "try again" });
      send(404, { error: "nope" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, ol: new OutLayer(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), close: () => server.close() };
}

test("outlayer: register, quote and a private payout send the documented requests and follow it to the end", async () => {
  const f = await fake();
  try {
    const w = await f.ol.register();
    assert.equal(w.api_key, "wk_test");
    assert.equal(f.seen[0]?.auth, undefined, "register is the one call without a key");
    const body = { chain: "sol", to: "SoLAddr", amount: "500000", token: "nep141:usdc" };
    assert.equal((await f.ol.quoteWithdraw("wk_test", body)).min_amount_out, "435600");
    const op = await f.ol.withdraw("wk_test", body, "idem-1");
    assert.equal(f.seen.at(-1)?.auth, "Bearer wk_test");
    assert.equal(f.seen.at(-1)?.idem, "idem-1");
    assert.deepEqual(f.seen.at(-1)?.body, body);
    const end = await f.ol.settle("wk_test", op.request_id, { everyMs: 5, timeoutMs: 2000 });
    assert.equal(end.status, "success");
    assert.deepEqual((end.result as { swap_details: { destinationChainTxHashes: string[] } }).swap_details.destinationChainTxHashes, ["0xabc"]);
  } finally { f.close(); }
});

test("outlayer: a request still pending when time runs out comes back as it is, never as a failure", async () => {
  const f = await fake();
  try { assert.equal((await f.ol.settle("wk_test", "r1", { everyMs: 5, timeoutMs: 8 })).status, "pending_deposit"); } finally { f.close(); }
});

test("outlayer: errors carry the status and code, and only the two the docs call safe are retryable", async () => {
  const f = await fake();
  try {
    await assert.rejects(f.ol.balance("wk_test"), (e: unknown) => e instanceof OutLayerError && e.status === 403 && e.code === "wallet_frozen" && !e.retryable);
    await assert.rejects(f.ol.tokens("wk_test"), (e: unknown) => e instanceof OutLayerError && e.code === "confidential_jwt_expired" && e.retryable);
  } finally { f.close(); }
});

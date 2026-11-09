import assert from "node:assert/strict";
import { test } from "node:test";
import { Reporter } from "../../src/agent/report.js";

const pay = (id: string, status: string) => ({ id, kind: "send" as const, amountUsd: 5, chain: "sol", recipient: "SecretAddress111", status, createdAt: 1, settled: status === "DELIVERED", who: "userid-1", txHash: "0xsecret" });
const wait = () => new Promise((r) => setTimeout(r, 5));

test("a test run reports each payment's outcome once, without addresses, and tries again when the page is down", async () => {
  const calls: { url: string; auth: string; body: { rows: Record<string, unknown>[] } }[] = [];
  let up = false;
  const fake = (async (url: string, init: RequestInit) => { calls.push({ url, auth: String((init.headers as Record<string, string>)["authorization"]), body: JSON.parse(String(init.body)) }); return { ok: up } as Response; }) as unknown as typeof fetch;
  const r = new Reporter("https://example.test/stat/ingest", "pw", fake);
  assert.equal(r.on, true);
  r.push([pay("a", "PENDING")]); await wait();
  assert.equal(calls.length, 1);
  r.push([pay("a", "PENDING")]); await wait();
  assert.equal(calls.length, 2, "the page was down, so it is sent again");
  up = true;
  r.push([pay("a", "PENDING")]); await wait();
  r.push([pay("a", "PENDING")]); await wait();
  assert.equal(calls.length, 3, "delivered once, then nothing new to say");
  r.push([pay("a", "DELIVERED")]); await wait();
  assert.equal(calls.length, 4, "a changed status is reported");
  const sent = calls[3]!;
  assert.equal(sent.auth, "Bearer pw");
  const row = sent.body.rows[0]!;
  assert.equal(row["status"], "DELIVERED");
  assert.notEqual(row["who"], "userid-1", "the user is a hash");
  assert.equal(JSON.stringify(sent.body).includes("SecretAddress111"), false, "no wallet address leaves");
  assert.equal(JSON.stringify(sent.body).includes("0xsecret"), false, "no transaction id leaves");
  assert.equal(new Reporter(undefined, "pw", fake).on, false, "off unless an address is set");
});

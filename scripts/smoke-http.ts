/* HTTP transport smoke test: connect with the SDK's HTTP client, list tools, check token gating. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const fake = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(req.url === "/v0/tokens" ? JSON.stringify([{ assetId: "nep141:a", decimals: 6, blockchain: "near", symbol: "USDC", contractAddress: "a" }]) : "{}");
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const oc = (fake.address() as AddressInfo).port;
const TOKEN = "t".repeat(32);
const PORT = 38333;
const child = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
  env: { PATH: process.env["PATH"] ?? "", ONECLICK_BASE_URL: `http://127.0.0.1:${oc}`, MOOPAY_HTTP_PORT: String(PORT), MOOPAY_HTTP_TOKEN: TOKEN, STATE_FILE: join(mkdtempSync(join(tmpdir(), "moopay-http-")), "s.json") },
  stdio: ["ignore", "ignore", "pipe"],
});
let log = "";
child.stderr.on("data", (c) => (log += c));
for (let i = 0; i < 50 && !log.includes("ready"); i++) await new Promise((r) => setTimeout(r, 100));
assert.ok(log.includes("ready"), log);

const bad = await fetch(`http://127.0.0.1:${PORT}/mcp/wrong`, { method: "POST", body: "{}" });
assert.equal(bad.status, 404);
const client = new Client({ name: "smoke-http", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${TOKEN}`)));
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["mint_private_claim_deposit", "route_cross_chain_intent"]);
const r = await client.callTool({ name: "route_cross_chain_intent", arguments: { destinationChain: "eth", destinationAssetId: "x", recipient: "0xbad" } });
console.log("tools over HTTP:", tools.join(", "), "| wrong token -> 404 | tool error ->", JSON.parse(((r as { content: { text: string }[] }).content[0]!).text).code);
const link = JSON.parse(((await client.callTool({ name: "route_cross_chain_intent", arguments: {
  destinationChain: "eth", destinationAssetId: "nep141:eth-x", recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", payAmount: "2" } })) as { content: { text: string }[] }).content[0]!.text);
console.log("pay-link call ->", link.code ?? link.mode);
const page = await fetch(`http://127.0.0.1:${PORT}/pay/${TOKEN}/abcdefghij`);
assert.equal(page.status, 200);
assert.match(await page.text(), /Pay with MooPay/);
assert.equal((await fetch(`http://127.0.0.1:${PORT}/pay/${TOKEN}/assets/pay.js`)).status, 200);
assert.equal((await fetch(`http://127.0.0.1:${PORT}/pay/${TOKEN}/assets/..%2F..%2Fetc%2Fpasswd`)).status, 404);
assert.equal((await fetch(`http://127.0.0.1:${PORT}/pay/bad/abcdefghij`)).status, 404);
await client.close();
child.kill();
fake.close();
console.log("HTTP SMOKE OK");

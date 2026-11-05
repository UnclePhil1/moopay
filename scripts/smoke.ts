/* MCP smoke test: spawns the built-from-source server over stdio against a local fake 1Click. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { commitmentOf, deriveNoteAccount, parseSecret } from "../src/agent/crypto.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ETH_USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
let seenAuth: string | undefined;

const fake = createServer((req, res) => {
  seenAuth = req.headers.authorization ?? seenAuth;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/v0/tokens") return send([
      { assetId: USDC, decimals: 6, blockchain: "near", symbol: "USDC", contractAddress: USDC.slice(7) },
      { assetId: ETH_USDC, decimals: 6, blockchain: "eth", symbol: "USDC", contractAddress: "0xa0b8" },
    ]);
    if (req.url === "/v0/quote") {
      const q = JSON.parse(body);
      return send({ quote: { ...(q.dry ? {} : { depositAddress: "escrow-1" }), amountIn: q.amount, amountOut: "99000", minAmountOut: "98000", deadline: q.deadline } });
    }
    if (req.url?.startsWith("/v0/status")) return send({ status: "SUCCESS" });
    res.statusCode = 404; send({ message: "not found" });
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const port = (fake.address() as AddressInfo).port;

/* Fake NEAR JSON-RPC so the real near-api-js read path is exercised: everything is "funded". */
const nearRpc = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const rpc = JSON.parse(body) as { id: unknown; method: string; params: { request_type?: string; method_name?: string } };
    const base = { block_height: 1, block_hash: "11111111111111111111111111111111" };
    let result: unknown = {};
    if (rpc.params?.request_type === "view_account")
      result = { ...base, amount: "50000000000000000000000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182 };
    else if (rpc.params?.request_type === "call_function")
      result = { ...base, logs: [], result: [...Buffer.from(JSON.stringify("5000000"))] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
});
await new Promise<void>((r) => nearRpc.listen(0, "127.0.0.1", r));
const nearPort = (nearRpc.address() as AddressInfo).port;

const stateFile = join(mkdtempSync(join(tmpdir(), "moopay-smoke-")), "state.json");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/ai/mcp/stdio.ts"],
  env: {
    PATH: process.env["PATH"] ?? "",
    NEAR_NETWORK: "mainnet",
    NEAR_RPC_URL: `http://127.0.0.1:${nearPort}`,
    ONECLICK_BASE_URL: `http://127.0.0.1:${port}`,
    ONECLICK_JWT: "smoke-jwt-must-not-leak",
    STATE_FILE: stateFile,
  },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (c) => (stderr += c));
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["check_claim", "check_payment", "list_supported_assets", "mint_private_claim_deposit", "route_cross_chain_intent"]);
console.log("tools/list:", tools.join(", "));

const parse = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);
const mintRes = await client.callTool({ name: "mint_private_claim_deposit", arguments: { assetId: USDC, amount: "5000000" } });
const minted = parse(mintRes);
assert.ok(!(mintRes as { isError?: boolean }).isError);
assert.equal(commitmentOf(parseSecret(minted.secretKeyString)), minted.commitment);
console.log("mint: recomputed commitment matches; escrow", minted.escrow.address, "amount", minted.escrow.amount);

assert.equal(minted.escrow.address, deriveNoteAccount(parseSecret(minted.secretKeyString)).accountId);
console.log("mint: note account", minted.escrow.address.slice(0, 12) + "…", "amount", minted.escrow.amount);

const before = readFileSync(stateFile, "utf8");
const dry = parse(await client.callTool({ name: "route_cross_chain_intent", arguments: {
  secretKeyString: minted.secretKeyString, destinationChain: "eth", destinationAssetId: ETH_USDC,
  recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" } }));
assert.equal(dry.mode, "claim");
assert.equal(dry.dryRun, true);
assert.equal(dry.quote.amountOut, "99000");
assert.equal(readFileSync(stateFile, "utf8"), before);
console.log("claim dry run: chain funding read via near-api-js, quote returned, ledger byte-identical");

const direct = parse(await client.callTool({ name: "route_cross_chain_intent", arguments: {
  originAssetId: USDC, amount: "2500000", refundTo: "sender.near", dryRun: false, destinationChain: "eth",
  destinationAssetId: ETH_USDC, recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" } }));
assert.equal(direct.mode, "direct");
assert.equal(direct.depositAddress, "escrow-1");
assert.equal(readFileSync(stateFile, "utf8"), before);
console.log("direct: depositAddress", direct.depositAddress, "(ledger untouched)");

const bad = await client.callTool({ name: "route_cross_chain_intent", arguments: {
  secretKeyString: minted.secretKeyString, destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: "0xbad" } });
console.log("bad recipient ->", (bad as { isError?: boolean }).isError, parse(bad).code);
assert.equal(parse(bad).code, "BAD_RECIPIENT");

const numAmount = await client.callTool({ name: "mint_private_claim_deposit", arguments: { assetId: USDC, amount: 5 as unknown as string } }).catch((e) => e);
console.log("numeric amount ->", JSON.stringify(numAmount instanceof Error ? numAmount.message : (numAmount as { content: unknown }).content).slice(0, 200));

const res = await client.readResource({ uri: `moopay://note/${minted.commitment}` });
const status = JSON.parse((res.contents[0] as { text: string }).text);
console.log("note resource: funded =", status.funding.funded);
assert.equal(status.funding.funded, true);
const dres = await client.readResource({ uri: "moopay://deposit/escrow-1" });
assert.equal(JSON.parse((dres.contents[0] as { text: string }).text).status, "SUCCESS");

assert.equal(seenAuth, "Bearer smoke-jwt-must-not-leak");
assert.ok(!stderr.includes("smoke-jwt-must-not-leak") && !stderr.includes(minted.secretKeyString));
assert.ok(!readFileSync(stateFile, "utf8").includes(minted.secretKeyString.slice(8)));
console.log("stderr:", stderr.trim());
await client.close();
fake.close();
nearRpc.close();
console.log("SMOKE OK");

/* No-funds check against the real 1Click API: tokens + dry quotes only. Moves nothing. */
import { existsSync } from "node:fs";
import { loadConfig } from "../config/index.js";
import { OneClick } from "../src/agent/intents/oneclick.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const cfg = loadConfig();
const oc = new OneClick({ baseUrl: cfg.oneClickBaseUrl, jwt: cfg.oneClickJwt });
console.log("authenticated:", oc.authenticated);

const tokens = await oc.tokens();
console.log("tokens:", tokens.length);
const usdcNear = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "near");
const usdcEth = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "eth");
const usdcSol = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "sol");
const btc = tokens.find((t) => t.symbol === "BTC" && t.blockchain === "btc");
console.log("USDC near:", usdcNear?.assetId, "| contract", usdcNear?.contractAddress);
console.log("USDC eth :", usdcEth?.assetId);
console.log("USDC sol :", usdcSol?.assetId);
console.log("BTC      :", btc?.assetId);
if (!usdcNear || !usdcEth) throw new Error("expected USDC on near and eth");

const dest = [
  { chain: "eth", asset: usdcEth, recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  ...(usdcSol ? [{ chain: "sol", asset: usdcSol, recipient: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" }] : []),
];
for (const d of dest) {
  for (const confidentiality of [undefined, cfg.confidentiality !== "public" ? cfg.confidentiality : undefined]) {
    try {
      const q = await oc.quote({
        dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: usdcNear.assetId,
        depositType: "ORIGIN_CHAIN", destinationAsset: d.asset.assetId, amount: "10000000", recipient: d.recipient,
        recipientType: "DESTINATION_CHAIN", refundTo: "example.near", refundType: "ORIGIN_CHAIN",
        deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
        ...(confidentiality && confidentiality !== "public" ? { confidentiality } : {}),
      });
      console.log(`dry quote 10 USDC near->${d.chain} conf=${confidentiality ?? "none"}: OK`, JSON.stringify(q.quote).slice(0, 400));
    } catch (e) {
      console.log(`dry quote near->${d.chain} conf=${confidentiality ?? "none"}: FAIL`, (e as Error).message);
    }
  }
}

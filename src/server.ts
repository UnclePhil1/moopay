#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, createService, loadDotEnv } from "./app.js";
import { loadConfig } from "./lib/config.js";
import { MoopayError } from "./lib/errors.js";

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.oneClickJwt)
    console.error("[moopay] ONECLICK_JWT not set: every 1Click quote pays an extra 0.25% fee.");
  if (cfg.nearNetwork !== "mainnet")
    console.error("[moopay] NEAR Intents has no testnet; 1Click calls always hit the configured ONECLICK_BASE_URL.");

  await buildServer(createService(cfg)).connect(new StdioServerTransport());
  console.error(`[moopay] ready (stdio, non-custodial, ${cfg.nearNetwork}, confidentiality ${cfg.confidentiality})`);
}

main().catch((e) => {
  // Config errors are MoopayError with safe messages; anything else is not echoed.
  console.error(e instanceof MoopayError ? `[moopay] ${e.message}` : "[moopay] fatal startup error");
  process.exit(1);
});

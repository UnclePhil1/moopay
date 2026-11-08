#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { loadDotEnv } from "../config/paths.js";
import { createService, namesFromEnv, privateRouteFromEnv, sponsorFromEnv } from "./agent/index.js";
import { pickProvider } from "./ai/providers/index.js";
import { startServer } from "./server/index.js";
import { makeAgent } from "./server/routes/agent.js";
import { Vault } from "./storage/index.js";
import { MoopayError } from "./util/errors.js";

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const port = Number(process.env["MOOPAY_HTTP_PORT"] ?? 3333);
  const bind = process.env["MOOPAY_HOST"]?.trim() || "127.0.0.1";
  const token = process.env["MOOPAY_HTTP_TOKEN"]?.trim() || randomBytes(24).toString("hex");
  if (token.length < 24) throw new MoopayError("INVALID_INPUT", "MOOPAY_HTTP_TOKEN must be at least 24 characters");
  const vault = new Vault();
  if (!vault.enabled) console.error("[moopay] warning: SEED_KEY is not set, so state and seed files are stored unencrypted");

  const service = await createService(cfg, vault);
  const agent = await makeAgent({ svc: service, stateFile: cfg.stateFile, vault, sponsor: sponsorFromEnv(), names: namesFromEnv(), private: privateRouteFromEnv(), ...(await pickProvider()) });
  agent.startWorker();
  setInterval(() => void service.claimSweep().catch(() => undefined), 10 * 60 * 1000).unref();

  startServer({ service, token, agent: agent.handle }, {
    host: bind, port,
    onStop: async () => { await Promise.all([service.flush(), agent.store.flush()]); },
    onListen: () => {
      console.error(`[moopay] ready on ${bind}:${port} (${cfg.nearNetwork})`);
      // the connector path is a secret: only print it on a local run, never into hosted logs
      if (bind === "127.0.0.1") console.error(`[moopay] connector path: /mcp/${token}`);
      else console.error("[moopay] connector path hidden (set MOOPAY_HTTP_TOKEN to choose it)");
    },
  });
}

main().catch((e) => {
  console.error(e instanceof MoopayError ? `[moopay] ${e.message}` : "[moopay] fatal startup error");
  process.exit(1);
});

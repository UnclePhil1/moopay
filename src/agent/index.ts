import type { Config } from "../../config/index.js";
import { Ledger } from "../storage/ledger.js";
import { Stats } from "../storage/stats.js";
import { Vault } from "../storage/index.js";
import { ClaimDesk } from "./claims.js";
import { makeNearOps } from "./chains/near.js";
import { OneClick } from "./intents/oneclick.js";
import { MooPayService } from "./service.js";
import type { Sponsor } from "./ops.js";

/*
 * The agent gateway. Everything outside src/agent (the HTTP server, the AI loop, the MCP connector) reaches
 * wallets, chains and stored state through this file, and never through near-api-js or a chain driver directly.
 */
export { MooPayService, mintShape, routeShape, type RouteContext } from "./service.js";
export { AgentOps, approvalCard, type Ctx, type Out, type Sponsor } from "./ops.js";
export { AgentStore, SESSION_ENDED, SESSION_MS, type UserRec } from "./store.js";
export { spentToday } from "./policy.js";
export { followPayments, tick } from "./worker.js";

export async function createService(cfg: Config, vault: Vault = new Vault()): Promise<MooPayService> {
  const near = makeNearOps(cfg);
  const oneClick = new OneClick({ baseUrl: cfg.oneClickBaseUrl, jwt: cfg.oneClickJwt });
  let service!: MooPayService;
  const claims = await ClaimDesk.open({
    near, file: `${cfg.stateFile}.claims.json`,
    tokens: () => service.payAssets(),
    units: (text, token) => service.claimUnits(text, token as never),
    swapOut: (p) => service.claimSwapOut(p),
  }, vault);
  service = new MooPayService({
    claims,
    ledger: await Ledger.open(cfg.stateFile, vault),
    oneClick,
    near,
    confidentiality: cfg.confidentiality,
    stats: await Stats.open(`${cfg.stateFile}.stats.json`, vault),
  });
  return service;
}

/** The optional account that lends the first small network fee. Both values must be present. */
export function sponsorFromEnv(env: NodeJS.ProcessEnv = process.env): Sponsor | undefined {
  const accountId = env["GAS_SPONSOR_ACCOUNT"], secretKey = env["GAS_SPONSOR_KEY"];
  return accountId && secretKey ? { accountId, secretKey, dailyMax: Number(env["GAS_SPONSOR_DAILY_MAX"] ?? 20) } : undefined;
}

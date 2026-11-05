import type { IncomingMessage, ServerResponse } from "node:http";
import type { MooPayService } from "../../agent/index.js";
import { asMoopayError } from "../../util/errors.js";
import { toJson } from "../../util/json.js";
import { ClaimBody, FundPlanBody } from "../../storage/schema.js";
import { parseBody, publicOrigin, readJson } from "../middleware/body.js";
import { BUNDLES, sendBundle, sendWalletPage } from "./pages.js";
import { ID_RE, sendJson } from "./pay.js";

/** Claim and fund links: unguessable keys in the path; no MCP token is ever shared with a receiver. */
export async function handleClaims(service: MooPayService, parts: string[], req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const [kind, key, ...more] = parts as [string, string?, ...string[]];
  if (!["a", "f", "c", "fapi", "capi"].includes(kind)) return false;
  const reply = (data: unknown): true => { res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(toJson(data)); return true; };
  if (kind === "a" && key && req.method === "GET" && more.length === 0 && BUNDLES[key]) return sendBundle(res, key);
  if ((kind === "f" || kind === "c") && key && ID_RE.test(key) && more.length === 0 && req.method === "GET") { sendWalletPage(res, kind === "f" ? "fund.html" : "claim.html"); return true; }
  if ((kind === "fapi" || kind === "capi") && key && ID_RE.test(key)) {
    try {
      const op = more[0] ?? "";
      if (kind === "fapi") {
        if (op === "" && req.method === "GET") return reply(service.claimFundView(key));
        if (op === "status" && req.method === "GET") return reply(await service.claimFundState(key, publicOrigin(req)));
        if (op === "plan" && req.method === "POST") return reply(await service.claimFundPlan(key, parseBody(FundPlanBody, await readJson(req), "plan").sender));
      } else {
        if (op === "" && req.method === "GET") return reply(await service.claimView(key));
        if (op === "challenge" && req.method === "GET") return reply(service.claimChallenge(key));
        if (op === "claim" && req.method === "POST") {
          const b = parseBody(ClaimBody, await readJson(req), "claim");
          return reply(await service.claimNow(key, { accountId: b.accountId, ...(b.publicKey ? { publicKey: b.publicKey } : {}), signature: b.signature }));
        }
      }
    } catch (e) {
      const err = asMoopayError(e);
      res.statusCode = err.code === "INTERNAL" ? 500 : err.code === "NOTE_NOT_FOUND" ? 404 : 400;
      res.setHeader("content-type", "application/json");
      res.end(toJson({ code: err.code, message: err.message }));
      return true;
    }
  }
  sendJson(res, 404, { error: "not found" });
  return true;
}

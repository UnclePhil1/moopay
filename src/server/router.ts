import type { IncomingMessage, ServerResponse } from "node:http";
import type { MooPayService } from "../agent/index.js";
import { handleMcp } from "../ai/mcp/http.js";
import { clientIp, httpsRedirect, rateLimiter, securityHeaders } from "./middleware/security.js";
import { publicOrigin, readJson, tokenOk } from "./middleware/body.js";
import { handlePages, sendBundle, sendWalletPage } from "./routes/pages.js";
import { handlePay, ID_RE, payApi, sendJson } from "./routes/pay.js";
import { handleClaims } from "./routes/claims.js";

export interface Routes {
  service: MooPayService;
  /** Secret path segment that guards the MCP connector and the token-prefixed pay routes. */
  token: string;
  /** The agent's own routes (chat, account, agent keys). Returns true when it answered. */
  agent: (req: IncomingMessage, res: ServerResponse, url: URL, origin: string) => Promise<boolean>;
}

/** The request handler: security headers, rate limit, then the first route that claims the path. */
export function makeRouter({ service, token, agent }: Routes): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const perIp = rateLimiter(600, 60_000);
  return async (req, res) => {
    securityHeaders(req, res);
    const redirect = httpsRedirect(req);
    if (redirect) { res.writeHead(308, { location: redirect }); return void res.end(); }
    if (!perIp(clientIp(req))) return sendJson(res, 429, { code: "UPSTREAM_TIMEOUT", message: "Too many requests. Please slow down." });
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const own = process.env["MOOPAY_PUBLIC_HOST"]?.trim(); // www.<our domain> goes to the one real address, so sessions and links stay in one place
      if (own && String(req.headers.host ?? "").toLowerCase() === `www.${own}`) { res.writeHead(301, { location: `https://${own}${req.url ?? "/"}` }); return void res.end(); }
      const origin = publicOrigin(req);
      if (handlePages(req, res, url.pathname)) return;
      if (await agent(req, res, url, origin)) return;
      if (url.pathname === "/stats.json" && req.method === "GET") {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("cache-control", "public, max-age=30");
        return sendJson(res, 200, service.publicStats());
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (await handlePay(service, parts, req, res, url)) return;
      if (await handleClaims(service, parts, req, res)) return;

      const [kind, given, ...rest] = parts;
      // Same response for a wrong token and a wrong path: nothing to probe.
      if (!kind || !given || !["mcp", "pay", "api"].includes(kind) || !tokenOk(given, token)) return sendJson(res, 404, { error: "not found" });
      if (kind === "mcp") {
        if (rest.length) return sendJson(res, 404, { error: "not found" });
        if (req.method !== "POST") return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
        return await handleMcp(service, req, res, await readJson(req), { token, origin });
      }
      if (kind === "pay") {
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        if (rest[0] === "assets" && rest.length === 2) return void (sendBundle(res, rest[1]!) || sendJson(res, 404, { error: "not found" }));
        if (rest.length === 1 && ID_RE.test(rest[0]!)) return sendWalletPage(res, "pay.html");
        return sendJson(res, 404, { error: "not found" });
      }
      return await payApi(service, rest, req, res, url);
    } catch (e) {
      console.error("[moopay] http error:", e instanceof Error ? e.name : typeof e);
      if (!res.headersSent) sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null });
    }
  };
}

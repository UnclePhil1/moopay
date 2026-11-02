#!/usr/bin/env node
/*
 * Optional HTTP entry (Streamable HTTP, stateless) for MCP clients that only accept an HTTPS URL
 * (e.g. Claude's "Add custom connector"). Binds to 127.0.0.1; put an HTTPS tunnel in front of it.
 * The URL path carries a random token, which is the only access control: treat the full URL as a secret.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { clientIp, rateLimiter, securityHeaders } from "./lib/guard.js";
import { buildServer, createService, loadDotEnv } from "./app.js";
import { loadConfig } from "./lib/config.js";
import { asMoopayError, MoopayError } from "./lib/errors.js";
import { toJson } from "./lib/json.js";
import Anthropic from "@anthropic-ai/sdk";
import { nearAiLlm, nearAiTier, NEAR_AI_MODEL } from "./agent/nearai.js";
import { makeAgent } from "./agent/routes.js";

const MAX_BODY = 1_000_000;
const webFile = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url)));
const ASSETS: Record<string, string> = {
  "pay.js": "text/javascript; charset=utf-8",
  "fund.js": "text/javascript; charset=utf-8",
  "claim.js": "text/javascript; charset=utf-8",
  "modal-ui.css": "text/css; charset=utf-8",
  "moopay-logo.png": "image/png",
  "favicon.png": "image/png",
};
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Public base of this request (works behind a tunnel): https://host, or http://localhost for local use. */
function publicOrigin(req: IncomingMessage): string {
  const fixed = process.env["MOOPAY_PUBLIC_HOST"]?.trim(); // hosted: links always use our own domain, never a request header
  if (fixed) return `https://${fixed}`;
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost");
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = String(req.headers["x-forwarded-proto"] ?? (local ? "http" : "https")).split(",")[0];
  return `${proto}://${host}`;
}

const tokenOk = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new MoopayError("INVALID_INPUT", "request too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

/** NEAR AI (sealed enclaves) when its key is set, else Anthropic. Same chat, same rules; only the brain differs. */
async function pickAi() {
  const model = process.env["AGENT_MODEL"];
  if (process.env["NEAR_AI_API_KEY"]) {
    const m = model ?? NEAR_AI_MODEL;
    return { llm: nearAiLlm(process.env["NEAR_AI_API_KEY"]), model: m, ai: { name: "NEAR AI", tier: await nearAiTier(m) } };
  }
  if (process.env["ANTHROPIC_API_KEY"]) return { llm: new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] }) as never, model, ai: { name: "Anthropic", tier: "Provider API" } };
  return {};
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const port = Number(process.env["MOOPAY_HTTP_PORT"] ?? 3333);
  const token = process.env["MOOPAY_HTTP_TOKEN"]?.trim() || randomBytes(24).toString("hex");
  if (token.length < 24) throw new MoopayError("INVALID_INPUT", "MOOPAY_HTTP_TOKEN must be at least 24 characters");
  if (!process.env["SEED_KEY"]?.trim()) console.error("[moopay] warning: SEED_KEY is not set, so the seed files are stored unencrypted");
  const service = createService(cfg);
  const agent = makeAgent({
    svc: service, stateFile: cfg.stateFile,
    ...(await pickAi()),
    sponsor: process.env["GAS_SPONSOR_ACCOUNT"] && process.env["GAS_SPONSOR_KEY"] ? { accountId: process.env["GAS_SPONSOR_ACCOUNT"], secretKey: process.env["GAS_SPONSOR_KEY"], dailyMax: Number(process.env["GAS_SPONSOR_DAILY_MAX"] ?? 20) } : undefined,
  });
  agent.startWorker();

  async function payApi(rest: string[], req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (code: number, body: unknown): void => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    const apiErr = (e: unknown) => {
      const err = asMoopayError(e);
      const code = err.code === "INTERNAL" ? 500 : err.code === "NOTE_NOT_FOUND" ? 404 : 400;
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(toJson({ code: err.code, message: err.message }));
    };
    const sendJson = (data: unknown) => { res.setHeader("content-type", "application/json"); res.end(toJson(data)); };
    try {
      if (rest[0] === "status" && req.method === "GET")
        return sendJson(await service.depositStatus(url.searchParams.get("depositAddress") ?? ""));
      if (rest[0] === "intent" && rest[1] && ID_RE.test(rest[1])) {
        const id = rest[1];
        if (rest.length === 2 && req.method === "GET") return sendJson(await service.payIntentView(id));
        if (rest[2] === "status" && req.method === "GET") return sendJson(await service.payStatus(id));
        if (rest[2] === "blockhash" && req.method === "GET") return sendJson(await service.solBlockhash());
        if (rest[2] === "estimate" && req.method === "GET") return sendJson(await service.payEstimate(id, url.searchParams.get("asset") ?? ""));
        if (rest[2] === "quote" && req.method === "POST") {
          const b = (await readJson(req)) as { originAssetId?: unknown; refundTo?: unknown } | undefined;
          if (typeof b?.originAssetId !== "string" || typeof b.refundTo !== "string") throw new MoopayError("INVALID_INPUT", "originAssetId and refundTo are required");
          return sendJson(await service.payQuote(id, b.originAssetId, b.refundTo));
        }
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return apiErr(e);
    }
  }

  const perIp = rateLimiter(600, 60_000);
  const http = createServer(async (req, res) => {
    const send = (code: number, body: unknown): void => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    securityHeaders(req, res);
    if (!perIp(clientIp(req))) return send(429, { code: "UPSTREAM_TIMEOUT", message: "Too many requests. Please slow down." });
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (await agent.handle(req, res, url, publicOrigin(req))) return;
      if (url.pathname === "/stats.json" && req.method === "GET") {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("cache-control", "public, max-age=30");
        return send(200, service.publicStats());
      }
      const parts = url.pathname.split("/").filter(Boolean); // [kind, token, ...rest]

      // Public pay links made by the agent: /p/<id> (page) and /papi/<id>/... (JSON). The id is the only secret.
      if (parts[0] === "p" || parts[0] === "papi") {
        const [k, key, ...more] = parts as [string, string?, ...string[]];
        if (k === "p" && key === "assets" && more.length === 1 && ASSETS[more[0]!] && req.method === "GET") {
          res.setHeader("content-type", ASSETS[more[0]!]!);
          return void res.end(webFile(`dist/${more[0]}`));
        }
        if (k === "p" && key && ID_RE.test(key) && more.length === 0 && req.method === "GET") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          return void res.end(webFile("pay.html"));
        }
        if (k === "papi" && key && ID_RE.test(key)) return void (await payApi(["intent", key, ...more], req, res, url));
        return send(404, { error: "not found" });
      }

      // Claim links: unguessable keys in the path; no MCP token is ever shared with a receiver.
      if (["a", "f", "c", "fapi", "capi"].includes(parts[0] ?? "")) {
        const [k, key, ...more] = parts as [string, string?, ...string[]];
        const fail = (e: unknown) => {
          const err = asMoopayError(e);
          res.statusCode = err.code === "INTERNAL" ? 500 : err.code === "NOTE_NOT_FOUND" ? 404 : 400;
          res.setHeader("content-type", "application/json");
          res.end(toJson({ code: err.code, message: err.message }));
        };
        const json = (data: unknown) => { res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(toJson(data)); };
        if (k === "a" && key && req.method === "GET" && more.length === 0 && ASSETS[key]) {
          res.setHeader("content-type", ASSETS[key]!);
          return void res.end(webFile(`dist/${key}`));
        }
        if ((k === "f" || k === "c") && key && ID_RE.test(key) && more.length === 0 && req.method === "GET") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          return void res.end(webFile(k === "f" ? "fund.html" : "claim.html"));
        }
        if ((k === "fapi" || k === "capi") && key && ID_RE.test(key)) {
          try {
            const op = more[0] ?? "";
            if (k === "fapi") {
              if (op === "" && req.method === "GET") return json(service.claimFundView(key));
              if (op === "status" && req.method === "GET") return json(await service.claimFundState(key, publicOrigin(req)));
              if (op === "plan" && req.method === "POST") {
                const b = (await readJson(req)) as { sender?: unknown } | undefined;
                if (typeof b?.sender !== "string") throw new MoopayError("INVALID_INPUT", "sender is required");
                return json(await service.claimFundPlan(key, b.sender));
              }
            } else {
              if (op === "" && req.method === "GET") return json(await service.claimView(key));
              if (op === "challenge" && req.method === "GET") return json(service.claimChallenge(key));
              if (op === "claim" && req.method === "POST") {
                const b = (await readJson(req)) as { accountId?: unknown; publicKey?: unknown; signature?: unknown } | undefined;
                if (typeof b?.accountId !== "string" || typeof b.signature !== "string" || (b.publicKey !== undefined && typeof b.publicKey !== "string"))
                  throw new MoopayError("INVALID_INPUT", "accountId and signature are required");
                return json(await service.claimNow(key, { accountId: b.accountId, ...(b.publicKey ? { publicKey: b.publicKey as string } : {}), signature: b.signature }));
              }
            }
          } catch (e) {
            return fail(e);
          }
        }
        return send(404, { error: "not found" });
      }
      const [kind, given, ...rest] = parts;
      // Same response for a wrong token and a wrong path: nothing to probe.
      if (!kind || !given || !["mcp", "pay", "api"].includes(kind) || !tokenOk(given, token)) return send(404, { error: "not found" });

      if (kind === "mcp") {
        if (rest.length) return send(404, { error: "not found" });
        if (req.method !== "POST")
          return send(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
        const body = await readJson(req);
        const server = buildServer(service, { payLinkPrefix: `${publicOrigin(req)}/pay/${token}`, origin: publicOrigin(req) });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        return await transport.handleRequest(req, res, body);
      }

      if (kind === "pay") {
        if (req.method !== "GET") return send(405, { error: "method not allowed" });
        if (rest[0] === "assets" && rest.length === 2) {
          const type = ASSETS[rest[1]!];
          if (!type) return send(404, { error: "not found" });
          res.setHeader("content-type", type);
          return void res.end(webFile(`dist/${rest[1]}`));
        }
        if (rest.length === 1 && ID_RE.test(rest[0]!)) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          return void res.end(webFile("pay.html"));
        }
        return send(404, { error: "not found" });
      }

      // kind === "api": JSON for the pay page
      return void (await payApi(rest, req, res, url));
    } catch (e) {
      console.error("[moopay] http error:", e instanceof Error ? e.name : typeof e);
      if (!res.headersSent) send(400, { jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null });
    }
  });

  setInterval(() => void service.claimSweep().catch(() => undefined), 10 * 60 * 1000).unref();

  const bind = process.env["MOOPAY_HOST"]?.trim() || "127.0.0.1";
  http.listen(port, bind, () => {
    console.error(`[moopay] HTTP MCP ready on ${bind}:${port} (non-custodial, ${cfg.nearNetwork})`);
    // the connector path is a secret: only print it on a local run, never into hosted logs
    if (bind === "127.0.0.1") {
      console.error(`[moopay] connector path: /mcp/${token}`);
      console.error("[moopay] Put an HTTPS tunnel in front, then use https://<tunnel-host>/mcp/<token> as the connector URL.");
    } else console.error("[moopay] connector path hidden (set MOOPAY_HTTP_TOKEN to choose it)");
  });
}

main().catch((e) => {
  console.error(e instanceof MoopayError ? `[moopay] ${e.message}` : "[moopay] fatal startup error");
  process.exit(1);
});

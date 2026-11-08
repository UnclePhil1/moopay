import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ROOT } from "../../config/paths.js";
import type { UserRec } from "../agent/index.js";
import { pageHeaders, withNonce } from "../server/middleware/security.js";
import { metrics } from "./metrics.js";

/* The team's numbers page, at /stat, behind one shared password from MOOPAY_STAT_PASSWORD (the browser asks for it; any user name works). With no password set the page is off. */
const digest = (s: string) => createHash("sha256").update(s).digest();
let misses: number[] = [];
function allowed(req: IncomingMessage, res: ServerResponse): boolean {
  const want = process.env["MOOPAY_STAT_PASSWORD"];
  if (!want) { res.statusCode = 404; res.setHeader("content-type", "application/json"); res.end('{"error":"not found"}'); return false; }
  const now = Date.now(); misses = misses.filter((t) => now - t < 600_000);
  if (misses.length >= 20) { res.statusCode = 429; res.end("Too many wrong passwords. Try again in ten minutes."); return false; }
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /i, ""), "base64").toString().split(":").slice(1).join(":");
  if (timingSafeEqual(digest(got), digest(want))) return true;
  misses.push(now); res.statusCode = 401; res.setHeader("www-authenticate", 'Basic realm="MooPay stats"'); res.end("Password needed");
  return false;
}
export function handleStat(req: IncomingMessage, res: ServerResponse, path: string, users: () => UserRec[], now: number, history?: Parameters<typeof metrics>[2]): boolean {
  if (req.method !== "GET") return false;
  res.setHeader("x-robots-tag", "noindex");
  if (!allowed(req, res)) return true;
  if (path === "/stat/data") {
    res.statusCode = 200; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(metrics(users(), now, history)));
    return true;
  }
  const nonce = randomBytes(16).toString("base64url");
  res.setHeader("content-type", "text/html; charset=utf-8");
  pageHeaders(res, nonce);
  res.end(withNonce(readFileSync(join(ROOT, "src", "stat", "stat.html")), nonce));
  return true;
}

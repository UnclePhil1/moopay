import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ROOT } from "../../config/paths.js";
import type { UserRec } from "../agent/index.js";
import { pageHeaders, withNonce } from "../server/middleware/security.js";
import { csv, metrics, pickOf } from "./metrics.js";

/*
 * The team's numbers page, at /stat, behind one shared password from MOOPAY_STAT_PASSWORD. With no password set the page is off.
 * The page asks for it in its own box (no user name), then keeps a signed cookie that lasts two hours from the last use.
 * Another MooPay run reporting in (report.ts) sends the same password as a Bearer token.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();
const SESSION_MS = 2 * 3_600_000;
let misses: number[] = [];

const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const sign = (exp: string, password: string) => createHmac("sha256", "moopay.stat.session|" + password).update(exp).digest("base64url");
function signedIn(req: IncomingMessage, now: number, password: string): boolean {
  const m = /(?:^|;\s*)moopay_stat=(\d+)\.([\w-]+)/.exec(req.headers.cookie ?? "");
  return !!m && Number(m[1]) > now && same(m[2]!, sign(m[1]!, password));
}
/** Hands out (or renews) the two-hour cookie. */
function keepSignedIn(req: IncomingMessage, res: ServerResponse, now: number, password: string): void {
  const exp = String(now + SESSION_MS), secure = req.headers["x-forwarded-proto"] === "https" || !!(req.socket as { encrypted?: boolean }).encrypted;
  res.setHeader("set-cookie", `moopay_stat=${exp}.${sign(exp, password)}; Path=/stat; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`);
}
/** Checks a password guess; too many wrong ones in ten minutes locks the page for everyone until it passes. */
function guess(got: string, want: string, now: number): "ok" | "wrong" | "locked" {
  misses = misses.filter((t) => now - t < 600_000);
  if (misses.length >= 20) return "locked";
  if (same(got, want)) return "ok";
  misses.push(now); return "wrong";
}
const reply = (res: ServerResponse, code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(body)); };
async function bodyOf(req: IncomingMessage, max: number): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > max) throw new Error("too large"); chunks.push(c as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function page(res: ServerResponse, file: string): void {
  const nonce = randomBytes(16).toString("base64url");
  res.setHeader("content-type", "text/html; charset=utf-8"); res.setHeader("cache-control", "no-store");
  pageHeaders(res, nonce);
  res.end(withNonce(readFileSync(join(ROOT, "src", "stat", file)), nonce));
}

export function handleStat(req: IncomingMessage, res: ServerResponse, path: string, users: () => UserRec[], now: number, history?: Parameters<typeof metrics>[2], ingest?: (rows: unknown[]) => number): boolean {
  const want = process.env["MOOPAY_STAT_PASSWORD"];
  if (!want) return reply(res, 404, { error: "not found" }), true;
  res.setHeader("x-robots-tag", "noindex");

  // another MooPay run reporting its payments
  if (req.method === "POST" && path === "/stat/ingest") {
    const auth = req.headers.authorization ?? "";
    const r = /^Bearer /i.test(auth) ? guess(auth.slice(7), want, now) : "wrong";
    if (r !== "ok") return reply(res, r === "locked" ? 429 : 401, { error: "no" }), true;
    void bodyOf(req, 1_000_000).then((b) => { const rows = (b as { rows?: unknown }).rows; reply(res, 200, { kept: Array.isArray(rows) && ingest ? ingest(rows) : 0 }); }).catch(() => reply(res, 400, { error: "bad request" }));
    return true;
  }
  // the box on the login page
  if (req.method === "POST" && path === "/stat/login") {
    void bodyOf(req, 2_000).then((b) => {
      const r = guess(String((b as { password?: unknown }).password ?? ""), want, now);
      if (r === "ok") { keepSignedIn(req, res, now, want); return reply(res, 200, { ok: true }); }
      reply(res, r === "locked" ? 429 : 401, { error: r === "locked" ? "Too many wrong passwords. Try again in ten minutes." : "That password isn't right." });
    }).catch(() => reply(res, 400, { error: "bad request" }));
    return true;
  }
  if (req.method !== "GET") return false;

  if (path === "/stat") { // the numbers when signed in, otherwise only the password box
    if (!signedIn(req, now, want)) return page(res, "login.html"), true;
    keepSignedIn(req, res, now, want); return page(res, "stat.html"), true;
  }
  if (path !== "/stat/data" && path !== "/stat/export.csv") return false;
  if (!signedIn(req, now, want)) return reply(res, 401, { error: "sign in" }), true;
  keepSignedIn(req, res, now, want);
  const pick = pickOf(new URL(req.url ?? "/", "http://x").searchParams.get("env"));
  if (path === "/stat/data") return reply(res, 200, metrics(users(), now, history, pick)), true;
  res.statusCode = 200; res.setHeader("content-type", "text/csv; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.setHeader("content-disposition", `attachment; filename="moopay-${pick}-${new Date(now).toISOString().slice(0, 10)}.csv"`);
  res.end(csv(users(), history, pick));
  return true;
}

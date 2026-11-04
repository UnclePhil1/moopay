import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { asMoopayError, MoopayError } from "../lib/errors.js";
import { toJson } from "../lib/json.js";
import type { MooPayService } from "../lib/service.js";
import { randomBytes, randomUUID } from "node:crypto";
import { plain, runTurn, type Ctl, type Llm } from "./loop.js";
import { AgentOps, approvalCard, type Sponsor } from "./ops.js";
import { spentToday } from "./policy.js";
import { alertOwner } from "../lib/alert.js";
import { clientIp, pageHeaders, rateLimiter, withNonce } from "../lib/guard.js";
import { AgentStore, SESSION_ENDED, SESSION_MS, type UserRec } from "./store.js";
import { followPayments, tick } from "./worker.js";

const appFile = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`../../app/${name}`, import.meta.url)));
/** Docs are built into web/dist/docs: /docs opens the first page, /docs/<path> is a page, <path>.md its plain copy, /llms.txt the index. */
function docPage(p: string, res: ServerResponse): boolean {
  const root = fileURLToPath(new URL("../../web/dist/docs/", import.meta.url));
  const clean = p.replace(/\/$/, "");
  let file: string, type = "text/html; charset=utf-8";
  if (clean === "/llms.txt") { file = "llms.txt"; type = "text/plain; charset=utf-8"; }
  else if (clean === "/docs") { res.writeHead(302, { location: (JSON.parse(readFileSync(root + "index.json", "utf8")) as { first: string }).first }); res.end(); return true; }
  else if (clean.endsWith(".md")) { file = clean.slice(6); type = "text/markdown; charset=utf-8"; }
  else file = clean.slice(6) + ".html";
  try {
    const body = readFileSync(root + file);
    res.setHeader("content-type", type); res.setHeader("cache-control", "public, max-age=300");
    if (type.startsWith("text/html")) { const nonce = randomBytes(16).toString("base64url"); pageHeaders(res, nonce); res.end(withNonce(body, nonce)); } else res.end(body);
    return true;
  } catch { return false; }
}
const IMAGES = new Set(["moopay-logo.png", "moopay-mark.png", "favicon.png"]);
const MAX_BODY = 8 * 1024;
/** Below this the wallet only holds gas dust, so the account can be deleted. */
const DELETE_MAX_USD = 0.5;
const MSGS_PER_MINUTE = 12;

export interface AgentDeps { svc: MooPayService; stateFile: string; llm?: Llm | undefined; model?: string | undefined; ai?: { name: string; tier: string } | undefined; now?: () => number; sponsor?: Sponsor | undefined;
  /** AI messages allowed per day: per user, per IP, and across the whole server (a ceiling on what the AI can cost) */
  aiDaily?: { user: number; ip: number; total: number } }

export function makeAgent(d: AgentDeps) {
  const now = d.now ?? Date.now;
  const store = new AgentStore(`${d.stateFile}.agent.json`);
  const turns = new Map<string, Ctl>();
  const apiLimit = rateLimiter(240, 60_000, now), strictLimit = rateLimiter(12, 60_000, now), chatLimit = rateLimiter(40, 60_000, now);
  const day = 24 * 3_600_000, cap = d.aiDaily ?? { user: Number(process.env["AI_USER_DAILY"] ?? 100), ip: Number(process.env["AI_IP_DAILY"] ?? 300), total: Number(process.env["AI_TOTAL_DAILY"] ?? 5000) };
  const userDay = rateLimiter(cap.user, day, now), ipDay = rateLimiter(cap.ip, day, now), totalDay = rateLimiter(cap.total, day, now);
  const STRICT = new Set(["session", "reset", "delete", "signout", "export", "freeze"]);
  const ops = new AgentOps(d.svc, store, now, d.sponsor);
  const model = d.model ?? "claude-sonnet-5-5";
  let lastOrigin = "http://localhost:3333";

  const json = (res: ServerResponse, code: number, data: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(toJson(data)); };
  const bodyOf = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let size = 0; const chunks: Buffer[] = [];
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new MoopayError("INVALID_INPUT", "request too large"); chunks.push(c as Buffer); }
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
  };
  const tokenOf = (req: IncomingMessage): string => {
    const t = req.headers["x-moopay-device"];
    if (typeof t !== "string") throw new MoopayError("INVALID_INPUT", "missing device token");
    return t;
  };
  const authOf = (req: IncomingMessage) => {
    try { const a = store.auth(tokenOf(req), now()); store.settlePayout(a.u, now()); return a; } catch (e) { if (e instanceof MoopayError) throw e; throw new MoopayError("INVALID_INPUT", (e as Error).message); }
  };
  const contextOf = async (u: UserRec): Promise<string> => {
    const a = (await ops.account(u)).result;
    return JSON.stringify({ address: a["address"], balanceUsd: a["balanceUsd"], rules: u.rules, spentToday: spentToday(u, now()), schedules: a["schedules"], setupStepsLeft: a["setupSteps"] });
  };

  /** The door for outside AI agents: Bearer mpk_… key, same rules as the user, plus the key's own limits. */
  const lastFollow = new Map<string, number>();
  async function delegate(req: IncomingMessage, res: ServerResponse, op: string, ctx: { origin: string }) {
    const key = /^Bearer (mpk_[\w-]+)$/.exec(String(req.headers["authorization"] ?? ""))?.[1];
    const hit = key ? store.byKey(key) : undefined;
    if (!hit) throw new MoopayError("INVALID_INPUT", "send the agent key as 'Authorization: Bearer mpk_…'");
    const { u, ak } = hit;
    if (ak.ips?.length && !ak.ips.includes(clientIp(req))) throw new MoopayError("INVALID_INPUT", "this key can't be used from this address");
    if (op === "me" && req.method === "GET") { json(res, 200, ops.listAgents(u).result["items"] && { agent: (ops.listAgents(u).result["items"] as { id: string }[]).find((x) => x.id === ak.id) }); return; }
    const b = await bodyOf(req);
    const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    let out;
    if (op === "send" && req.method === "POST") out = await ops.send(u, { amountUsd: str("amountUsd"), chain: str("chain"), recipient: str("recipient"), ...(str("assetSymbol") ? { assetSymbol: str("assetSymbol") } : {}) }, false, { ak });
    else if (op === "claim" && req.method === "POST") out = await ops.claim(u, { amountUsd: str("amountUsd"), receiver: str("receiver") }, ctx, false, { ak });
    else throw new MoopayError("NOTE_NOT_FOUND", "use GET me, POST send, or POST claim");
    store.save();
    json(res, 200, out.result);
  }

  /** Plain words for the user; the real cause goes to the server log (status and message of the API error, never keys). */
  function failText(e: unknown): string {
    const status = (e as { status?: number }).status;
    if (typeof status === "number") {
      console.error(`[moopay] AI error ${status}` + (process.env["MOOPAY_DEBUG"] ? `: ${(e as Error).message?.slice(0, 200)}` : ""));
      if (status === 401 || status === 403) return "My AI key was rejected. The owner needs to check ANTHROPIC_API_KEY.";
      if (status === 404) return "The AI model set on the server was not found. The owner needs to check AGENT_MODEL.";
      if (status === 429 || status === 529 || status >= 500) return "The AI is busy right now. Please try again in a few seconds.";
      return "The AI could not process that. Please try again.";
    }
    const err = asMoopayError(e);
    return err.code === "INTERNAL" ? "Something went wrong on my side. Please try again." : err.message;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, origin: string): Promise<boolean> {
    const p = url.pathname;
    const page = req.method === "GET" ? ({ "/": "landing.html", "/agent": "index.html", "/agent/": "index.html", "/app": "index.html", "/app/": "index.html" } as Record<string, string>)[p] : undefined;
    if (page) {
      const nonce = randomBytes(16).toString("base64url");
      res.setHeader("content-type", "text/html; charset=utf-8"); pageHeaders(res, nonce);
      res.end(withNonce(appFile(page), nonce));
      return true;
    }
    if (req.method === "GET" && (p === "/guide" || p === "/guide/")) { res.writeHead(301, { location: "/docs" }); res.end(); return true; }
    if (req.method === "GET" && /^\/(docs|llms\.txt)(\/[a-z0-9-]+){0,3}(\.md)?\/?$/.test(p) && docPage(p, res)) return true;
    const img = /^\/app\/assets\/([a-z-]+\.png)$/.exec(p);
    if (req.method === "GET" && img && IMAGES.has(img[1]!)) { res.setHeader("content-type", "image/png"); res.setHeader("cache-control", "public, max-age=3600"); res.end(appFile(`assets/${img[1]}`)); return true; }
    const gp = /^\/g\/([\w-]{6,40})$/.exec(p);
    if (gp && req.method === "GET") { // the page a group claim link opens
      const nonce = randomBytes(16).toString("base64url");
      res.setHeader("content-type", "text/html; charset=utf-8"); pageHeaders(res, nonce);
      res.end(withNonce(appFile("group.html"), nonce));
      return true;
    }
    const ga = /^\/gapi\/([\w-]{6,40})$/.exec(p);
    if (ga && req.method === "GET") {
      if (!strictLimit(clientIp(req) + "|group")) { json(res, 429, { code: "UPSTREAM_TIMEOUT", message: "Slow down a little and try again in a moment." }); return true; }
      const key = store.groupFind(ga[1]!, url.searchParams.get("address") ?? "");
      json(res, key ? 200 : 404, key ? { link: `${origin}/c/${key}` } : { message: "That wallet is not part of this group link. Check the address." });
      return true;
    }
    if (!p.startsWith("/agent/api/")) return false;
    lastOrigin = origin;
    const ip = clientIp(req), op0 = p.slice("/agent/api/".length);
    if (!apiLimit(ip) || (STRICT.has(op0) && !strictLimit(ip + "|" + op0)) || (op0 === "chat" && !chatLimit(ip))) { json(res, 429, { code: "UPSTREAM_TIMEOUT", message: "Slow down a little and try again in a moment." }); return true; }
    const ctx = { origin };
    try {
      const op = p.slice("/agent/api/".length);
      if (op.startsWith("delegate/")) { await delegate(req, res, op.slice(9), ctx); return true; }
      const { u, master } = authOf(req);
      const needMaster = (what: string) => { if (!master) throw new MoopayError("INVALID_INPUT", `${what} needs your recovery code. Type /restore, paste it, and choose "My device".`); };
      if (op === "state" && req.method === "GET") {
        for (let i = 0; i < u.chat.length; i++) { const m = u.chat[i]!; if (!m.id) { m.id = randomUUID(); const n = u.chat[i + 1]; if (m.role === "user" && n && n.role === "assistant" && !n.id) n.id = m.id; } }
        const a = await ops.account(u).catch(() => undefined);
        const lastId = u.events.at(-1)?.id ?? 0;
        json(res, 200, { frozen: Boolean(u.frozen), account: a?.result ?? { address: u.accountId }, saveChat: !u.noHistory, chat: (u.noHistory ? [] : u.chat).slice(-20).map((m) => ({ ...m, content: m.role === "assistant" ? plain(m.content) : m.content })), lastEventId: lastId, approvals: u.approvals.filter((x) => x.status === "pending").map(approvalCard), live: Boolean(d.llm), ai: d.ai ?? null });
        return true;
      }
      if (op === "export" && req.method === "POST") {
        needMaster("Showing your wallet key");
        if (u.frozen) throw new MoopayError("INVALID_INPUT", "Your account is frozen. Type /unfreeze first.");
        const k = store.keyOf(u);
        json(res, 200, { accountId: k.accountId, secretKey: k.secretKey });
        return true;
      }
      if (op === "session" && req.method === "POST") {
        needMaster("A temporary session");
        store.event(u, "A temporary session was opened from another browser. It ends after an hour. If this wasn't you, type /reset.");
        json(res, 200, { token: store.startSession(u, now()), expiresAt: now() + SESSION_MS });
        return true;
      }
      if (op === "freeze" && req.method === "POST") {
        const b = await bodyOf(req), on = b["on"] !== false;
        if (!on) needMaster("Unfreezing");
        u.frozen = on || undefined;
        store.event(u, on ? "Your account is frozen. Nothing can leave it until you type /unfreeze." : "Your account is unfrozen."); store.save();
        json(res, 200, { frozen: on });
        return true;
      }
      if (op === "history" && req.method === "POST") {
        const b = await bodyOf(req), save = b["save"] !== false;
        u.noHistory = save ? undefined : true;
        if (!save) u.chat = [];
        store.save();
        json(res, 200, { saveChat: save });
        return true;
      }
      if (op === "signout" && req.method === "POST") {
        if (!master) store.endSession(tokenOf(req));
        json(res, 200, { ok: true });
        return true;
      }
      if (op === "reset" && req.method === "POST") {
        needMaster("Making a new code");
        store.event(u, "Your recovery code was reset and every other browser was signed out.");
        json(res, 200, { recovery: store.reset(u) });
        return true;
      }
      if (op === "delete" && req.method === "POST") {
        if (u.payments.some((x) => !x.settled && x.kind !== "sweep")) throw new MoopayError("INVALID_INPUT", "A payment is still on its way. Delete again once it lands.");
        const a = await ops.account(u).catch(() => undefined);
        if (!a) throw new MoopayError("UPSTREAM_TIMEOUT", "I can't check your balance right now. Try again in a moment.");
        const left = Number(a.result["balanceUsd"]);
        if (left >= DELETE_MAX_USD) throw new MoopayError("INVALID_INPUT", `You still have $${left.toFixed(2)} in your agent wallet. Withdraw it first (say "withdraw everything"), then delete.`);
        turns.delete(u.id); store.remove(u);
        json(res, 200, { ok: true });
        return true;
      }
      if (op === "events" && req.method === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0);
        if (u.payments.some((p) => !p.settled && p.kind !== "sweep") && (lastFollow.get(u.id) ?? 0) < Date.now() - 4000) { // the page asks every few seconds: say so the moment a payment lands, not a minute later
          lastFollow.set(u.id, Date.now());
          await followPayments(ops, store, u, origin).catch(() => undefined);
        }
        json(res, 200, { events: u.events.filter((e) => e.id > since) });
        return true;
      }
      if (op === "approve" && req.method === "POST") {
        const b = await bodyOf(req);
        if (typeof b["id"] !== "string" || typeof b["approve"] !== "boolean") throw new MoopayError("INVALID_INPUT", "id and approve are required");
        const out = await ops.resolve(u, b["id"], b["approve"], ctx);
        json(res, 200, { result: out.result, card: out.card });
        return true;
      }
      if (op === "chat/cancel" && req.method === "POST") {
        const c = turns.get(u.id);
        if (!c || c.ran) { json(res, 200, { ok: false }); return true; }
        c.cancelled = true;
        json(res, 200, { ok: true });
        return true;
      }
      if (op === "chat/delete" && req.method === "POST") {
        const b = await bodyOf(req);
        if (b["all"] === true) u.chat = [];
        else if (typeof b["id"] === "string") u.chat = u.chat.filter((m) => m.id !== b["id"]);
        else throw new MoopayError("INVALID_INPUT", "id is required");
        store.save();
        json(res, 200, { ok: true });
        return true;
      }
      if (op === "chat" && req.method === "POST") {
        const b = await bodyOf(req);
        const text = typeof b["message"] === "string" ? b["message"].trim().slice(0, 2000) : "";
        if (!text) throw new MoopayError("INVALID_INPUT", "message is required");
        u.msgTimes = u.msgTimes.filter((t) => now() - t < 60_000);
        if (u.msgTimes.length >= MSGS_PER_MINUTE) { json(res, 429, { code: "UPSTREAM_TIMEOUT", message: "Slow down a little and try again in a moment." }); return true; }
        u.msgTimes.push(now());
        if (!totalDay("all")) { void alertOwner("ai-total", `the server-wide daily AI limit (${cap.total} messages) was reached.`, now()); json(res, 429, { code: "UPSTREAM_TIMEOUT", message: "MooPay is very busy today and has reached its daily limit. Please try again tomorrow." }); return true; }
        if (!userDay(u.id) || !ipDay(ip)) { json(res, 429, { code: "UPSTREAM_TIMEOUT", message: "You've reached today's message limit. It opens up again within a day." }); return true; }
        res.statusCode = 200; res.setHeader("content-type", "application/x-ndjson"); res.setHeader("cache-control", "no-store");
        const id = randomUUID(), ctl: Ctl = { cancelled: false, ran: false };
        turns.set(u.id, ctl);
        const emit = (e: unknown) => res.write(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
        emit({ type: "turn", id });
        if (!d.llm) emit({ type: "text", text: "My AI isn't switched on yet. The owner needs to set NEAR_AI_API_KEY (or ANTHROPIC_API_KEY) on the server and restart it." });
        else {
          try { await runTurn({ id, ctl, llm: d.llm, model, u, text, ops, svc: d.svc, ctx, emit: emit as never, context: await contextOf(u).catch(() => "(account details are unavailable right now; call get_account if needed)") }); }
          catch (e) { emit({ type: "text", text: failText(e) }); }
        }
        if (turns.get(u.id) === ctl) turns.delete(u.id);
        store.save(); res.end();
        return true;
      }
      json(res, 404, { code: "NOTE_NOT_FOUND", message: "not found" });
    } catch (e) {
      const err = asMoopayError(e);
      if (!res.headersSent) json(res, err.code === "INTERNAL" ? 500 : err.message === SESSION_ENDED ? 401 : 400, { code: err.code, message: err.message }); else res.end();
    }
    return true;
  }

  const startWorker = (everyMs = 60_000) => setInterval(() => void tick(ops, store, lastOrigin, now()).catch(() => undefined), everyMs).unref();
  return { handle, startWorker, ops, store, tick: () => tick(ops, store, lastOrigin, now()) };
}

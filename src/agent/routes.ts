import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { asMoopayError, MoopayError } from "../lib/errors.js";
import { toJson } from "../lib/json.js";
import type { MooPayService } from "../lib/service.js";
import { randomUUID } from "node:crypto";
import { plain, runTurn, type Ctl, type Llm } from "./loop.js";
import { AgentOps, type Sponsor } from "./ops.js";
import { spentToday } from "./policy.js";
import { AgentStore, type UserRec } from "./store.js";
import { tick } from "./worker.js";

const appFile = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`../../app/${name}`, import.meta.url)));
const IMAGES = new Set(["moopay-logo.png", "moopay-mark.png", "favicon.png"]);
const MAX_BODY = 8 * 1024;
const MSGS_PER_MINUTE = 12;

export interface AgentDeps { svc: MooPayService; stateFile: string; llm?: Llm | undefined; model?: string | undefined; ai?: { name: string; tier: string } | undefined; now?: () => number; sponsor?: Sponsor | undefined }

export function makeAgent(d: AgentDeps) {
  const now = d.now ?? Date.now;
  const store = new AgentStore(`${d.stateFile}.agent.json`);
  const turns = new Map<string, Ctl>();
  const ops = new AgentOps(d.svc, store, now, d.sponsor);
  const model = d.model ?? "claude-sonnet-5-5";
  let lastOrigin = "http://localhost:3333";

  const json = (res: ServerResponse, code: number, data: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(toJson(data)); };
  const bodyOf = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let size = 0; const chunks: Buffer[] = [];
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new MoopayError("INVALID_INPUT", "request too large"); chunks.push(c as Buffer); }
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
  };
  const userOf = (req: IncomingMessage): UserRec => {
    const t = req.headers["x-moopay-device"];
    if (typeof t !== "string") throw new MoopayError("INVALID_INPUT", "missing device token");
    try { return store.open(t); } catch { throw new MoopayError("INVALID_INPUT", "bad device token"); }
  };
  const contextOf = async (u: UserRec): Promise<string> => {
    const a = (await ops.account(u)).result;
    return JSON.stringify({ address: a["address"], balanceUsd: a["balanceUsd"], rules: u.rules, spentToday: spentToday(u, now()), schedules: a["schedules"], setupStepsLeft: a["setupSteps"] });
  };

  /** The door for outside AI agents: Bearer mpk_… key, same rules as the user, plus the key's own limits. */
  async function delegate(req: IncomingMessage, res: ServerResponse, op: string, ctx: { origin: string }) {
    const key = /^Bearer (mpk_[\w-]+)$/.exec(String(req.headers["authorization"] ?? ""))?.[1];
    const hit = key ? store.byKey(key) : undefined;
    if (!hit) throw new MoopayError("INVALID_INPUT", "send the agent key as 'Authorization: Bearer mpk_…'");
    const { u, ak } = hit;
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
      console.error(`[moopay] AI error ${status}: ${(e as Error).message?.slice(0, 200)}`);
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
    if (req.method === "GET" && (p === "/" || p === "/agent" || p === "/agent/" || p === "/app" || p === "/app/")) { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(appFile(p === "/" ? "landing.html" : "index.html")); return true; }
    if (req.method === "GET" && (p === "/guide" || p === "/guide/")) { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(appFile("guide.html")); return true; }
    const img = /^\/app\/assets\/([a-z-]+\.png)$/.exec(p);
    if (req.method === "GET" && img && IMAGES.has(img[1]!)) { res.setHeader("content-type", "image/png"); res.setHeader("cache-control", "public, max-age=3600"); res.end(appFile(`assets/${img[1]}`)); return true; }
    if (!p.startsWith("/agent/api/")) return false;
    lastOrigin = origin;
    const ctx = { origin };
    try {
      const op = p.slice("/agent/api/".length);
      if (op.startsWith("delegate/")) { await delegate(req, res, op.slice(9), ctx); return true; }
      const u = userOf(req);
      if (op === "state" && req.method === "GET") {
        for (let i = 0; i < u.chat.length; i++) { const m = u.chat[i]!; if (!m.id) { m.id = randomUUID(); const n = u.chat[i + 1]; if (m.role === "user" && n && n.role === "assistant" && !n.id) n.id = m.id; } }
        const a = await ops.account(u).catch(() => undefined);
        const lastId = u.events.at(-1)?.id ?? 0;
        json(res, 200, { account: a?.result ?? { address: u.accountId }, chat: u.chat.slice(-20).map((m) => ({ ...m, content: m.role === "assistant" ? plain(m.content) : m.content })), lastEventId: lastId, approvals: u.approvals.filter((x) => x.status === "pending").map((x) => ({ kind: "approval", id: x.id, summary: x.summary, reason: x.reason })), live: Boolean(d.llm), ai: d.ai ?? null });
        return true;
      }
      if (op === "export" && req.method === "POST") {
        const k = store.keyOf(u);
        json(res, 200, { accountId: k.accountId, secretKey: k.secretKey });
        return true;
      }
      if (op === "events" && req.method === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0);
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
      if (!res.headersSent) json(res, err.code === "INTERNAL" ? 500 : 400, { code: err.code, message: err.message }); else res.end();
    }
    return true;
  }

  const startWorker = (everyMs = 60_000) => setInterval(() => void tick(ops, store, lastOrigin, now()).catch(() => undefined), everyMs).unref();
  return { handle, startWorker, ops, store, tick: () => tick(ops, store, lastOrigin, now()) };
}

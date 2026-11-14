import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { asMoopayError, MoopayError } from "../../util/errors.js";
import { toJson } from "../../util/json.js";
import { AgentOps, AgentStore, CHAT_FEE_BPS, X_FEE_BPS, approvalCard, followPayments, SESSION_ENDED, SESSION_MS, spentToday, tick, type MooPayService, type NameParent, type OutLayer, type Sponsor, type UserRec } from "../../agent/index.js";
import { CHAT_RULES, plain, runTurn, X_RULES, type Ctl, type Llm } from "../../ai/loop.js";
import { SILENT, startX, XClient, xFromEnv } from "../x.js";
import { alertOwner } from "../../util/alert.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { security, useSecurityLog } from "../../security/audit.js";
import { haltScope, setHalt, XBurst, type HaltScope } from "../../security/halt.js";
import { auditorOn } from "../../security/guard.js";
import { sealBackup } from "../../agent/recovery.js";
import { hasPasskey, needsPasskey, Passkeys } from "../../security/passkeys.js";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Vault } from "../../storage/index.js";
import { clientIp, rateLimiter } from "../middleware/security.js";

const MAX_BODY = 8 * 1024;
/** Below this the wallet only holds gas dust, so the account can be deleted. */
const DELETE_MAX_USD = 0.5;
const MSGS_PER_MINUTE = 12;

export interface AgentDeps { svc: MooPayService; stateFile: string; llm?: Llm | undefined; model?: string | undefined; ai?: { name: string; tier: string } | undefined; now?: () => number; sponsor?: Sponsor | undefined; names?: NameParent | undefined; private?: OutLayer | undefined;
  /** AI messages allowed per day: per user, per IP, and across the whole server (a ceiling on what the AI can cost) */
  aiDaily?: { user: number; ip: number; total: number };
  vault?: Vault | undefined }

export async function makeAgent(d: AgentDeps) {
  const now = d.now ?? Date.now;
  const store = await AgentStore.open(`${d.stateFile}.agent.json`, d.vault);
  useSecurityLog(`${d.stateFile}.security.log`);
  const turns = new Map<string, Ctl>();
  const apiLimit = rateLimiter(240, 60_000, now), strictLimit = rateLimiter(12, 60_000, now), chatLimit = rateLimiter(40, 60_000, now);
  const day = 24 * 3_600_000, cap = d.aiDaily ?? { user: Number(process.env["AI_USER_DAILY"] ?? 100), ip: Number(process.env["AI_IP_DAILY"] ?? 300), total: Number(process.env["AI_TOTAL_DAILY"] ?? 5000) };
  const userDay = rateLimiter(cap.user, day, now), ipDay = rateLimiter(cap.ip, day, now), totalDay = rateLimiter(cap.total, day, now);
  const STRICT = new Set(["name", "session", "reset", "delete", "signout", "export", "freeze", "backup"]);
  const ops = new AgentOps(d.svc, store, now, d.sponsor, d.names, d.private);
  const model = d.model ?? "claude-sonnet-5-5";
  let lastOrigin = "http://localhost:3333";
  const passkeys = new Passkeys(now);
  /** A second model that must agree before money moves. Off with MOOPAY_AUDITOR=off. */
  const auditor = d.llm && auditorOn() ? { llm: d.llm as never, model: process.env["MOOPAY_AUDITOR_MODEL"]?.trim() || model } : undefined;
  /** The operator's switchboard: pause payments, lift the pause, read the security log. Needs MOOPAY_ADMIN_TOKEN; with none set the routes do not exist. */
  const adminOk = (req: IncomingMessage): boolean => {
    const want = process.env["MOOPAY_ADMIN_TOKEN"]?.trim(), got = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!want || want.length < 24 || !got) return false;
    const h = (x: string) => createHash("sha256").update(x).digest();
    return timingSafeEqual(h(got), h(want));
  };
  // The team's numbers page lives in src/stat, which is kept out of git. When the folder is not there the page does not exist.
  const statModule = import(new URL("../../stat/index.js", import.meta.url).href).then((m) => m as { handleStat(req: IncomingMessage, res: ServerResponse, path: string, users: () => UserRec[], now: number, history?: ReturnType<AgentStore["history"]>, ingest?: (rows: unknown[]) => number): boolean }).catch(() => undefined);

  const json = (res: ServerResponse, code: number, data: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(toJson(data)); };
  const bodyOf = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let size = 0; const chunks: Buffer[] = [];
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new MoopayError("INVALID_INPUT", "request too large"); chunks.push(c as Buffer); }
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
  };
  const tokenOf = (req: IncomingMessage): string => {
    const t = req.headers["x-moopay-device"];
    if (typeof t !== "string") throw new MoopayError("INVALID_INPUT", "I couldn't tell which browser this is. Reload the page.");
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
      if (status === 401 || status === 403) return "My AI key was rejected. The owner needs to check NEAR_AI_API_KEY or ANTHROPIC_API_KEY.";
      if (status === 404) return "The AI model set on the server was not found. The owner needs to check AGENT_MODEL.";
      if (status === 429 || status === 529 || status >= 500) return "The AI is busy right now. Please try again in a few seconds.";
      return "The AI could not process that. Please try again.";
    }
    const err = asMoopayError(e);
    return err.code === "INTERNAL" ? "Something went wrong on my side. Please try again." : err.message;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, origin: string): Promise<boolean> {
    const p = url.pathname;
    const ga = /^\/gapi\/([\w-]{6,40})$/.exec(p);
    if (ga && req.method === "GET") {
      if (!strictLimit(clientIp(req) + "|group")) { json(res, 429, { code: "UPSTREAM_TIMEOUT", message: "Slow down a little and try again in a moment." }); return true; }
      const key = store.groupFind(ga[1]!, url.searchParams.get("address") ?? "");
      json(res, key ? 200 : 404, key ? { link: `${origin}/c/${key}` } : { message: "That wallet is not part of this group link. Check the address." });
      return true;
    }
    if (p.startsWith("/admin/")) {
      const ip = clientIp(req);
      if (!process.env["MOOPAY_ADMIN_TOKEN"] || !strictLimit(ip + "|admin")) { json(res, 404, { error: "not found" }); return true; }
      if (!adminOk(req)) { security.add("admin_denied", { path: p, ip: ip.slice(0, 40) }, now()); json(res, 401, { error: "no" }); return true; }
      if (p === "/admin/security-log" && req.method === "GET") { json(res, 200, { chainOk: security.verify(), halt: haltScope(store.kv) || null, events: security.tail(200) }); return true; }
      if (p === "/admin/emergency-halt" && req.method === "POST") {
        const scope = (await bodyOf(req))["scope"] === "all" ? "all" : "x";
        setHalt(store.kv, scope as HaltScope); store.save(); security.add("halt", { scope }, now());
        void alertOwner("halt", `payments paused (${scope}) by an operator.`, now()).catch(() => undefined);
        json(res, 200, { halt: scope }); return true;
      }
      if (p === "/admin/resume" && req.method === "POST") { setHalt(store.kv, ""); store.save(); security.add("resume", {}, now()); json(res, 200, { halt: null }); return true; }
      json(res, 404, { error: "not found" }); return true;
    }
    const ok = /^\/ok-api\/([\w-]{6,40})(\/(options|approve))?$/.exec(p);
    if (ok) {
      const ip = clientIp(req);
      if (!strictLimit(ip + "|ok")) { json(res, 429, { message: "Slow down a little and try again in a moment." }); return true; }
      const hit = store.all().map((x) => ({ u: x, a: x.approvals.find((y) => y.id === ok[1]) })).find((h) => h.a);
      try {
        if (!hit?.a || hit.a.status !== "pending") throw new MoopayError("NOTE_NOT_FOUND", "This approval is no longer waiting. Nothing was sent.");
        const { u, a } = hit as { u: UserRec; a: NonNullable<typeof hit.a> };
        if (!hasPasskey(u)) throw new MoopayError("INVALID_INPUT", "This account has no passkey. Approve it in the MooPay app instead.");
        if (!ok[3] && req.method === "GET") { json(res, 200, { summary: a.summary, reason: a.reason, details: (approvalCard(a)["details"] as unknown[]) ?? [] }); return true; }
        if (ok[3] === "options" && req.method === "POST") { json(res, 200, await passkeys.options(u, origin, "approve:" + a.id)); return true; }
        if (ok[3] === "approve" && req.method === "POST") {
          await passkeys.verify(u, origin, (await bodyOf(req))["assertion"] as AuthenticationResponseJSON | undefined, "approve:" + a.id); store.save();
          const had = new Set(u.payments.map((x) => x.id));
          const out = await ops.resolve(u, a.id, true, { origin });
          ops.stampFees(u, had, X_FEE_BPS());
          xDone(a, out.result["status"]);
          security.add("approved_by_passkey", { user: u.id.slice(0, 8), kind: a.kind }, now());
          json(res, 200, { status: out.result["status"], reason: out.result["reason"] ?? null }); return true;
        }
      } catch (e) { const er = asMoopayError(e); json(res, er.code === "NOTE_NOT_FOUND" ? 404 : 400, { code: er.code, message: er.message }); return true; }
      json(res, 404, { error: "not found" }); return true;
    }
    if (p === "/stat" || p.startsWith("/stat/")) { const m = await statModule; if (m && m.handleStat(req, res, p, () => store.all(), now(), store.history(), (rows) => store.ingest(rows))) return true; }
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
        json(res, 200, { frozen: Boolean(u.frozen), points: u.points ?? 0, names: ops.nameSuffix ? { suffix: ops.nameSuffix, needed: !u.name && !u.payments.length } : null, account: a?.result ?? { address: u.accountId }, saveChat: !u.noHistory, chat: (u.noHistory ? [] : u.chat).slice(-20).map((m) => ({ ...m, content: m.role === "assistant" ? plain(m.content) : m.content })), lastEventId: lastId, approvals: u.approvals.filter((x) => x.status === "pending").map(approvalCard), live: Boolean(d.llm), ai: d.ai ?? null });
        return true;
      }
      if (op === "name" && req.method === "POST") {
        needMaster("Choosing a name");
        const b = await bodyOf(req);
        json(res, 200, (await ops.setName(u, typeof b["name"] === "string" ? b["name"] : "")).result);
        return true;
      }
      if (op === "export" && req.method === "POST") {
        needMaster("Showing your wallet key");
        if (u.frozen) throw new MoopayError("INVALID_INPUT", "Your account is frozen. Type /unfreeze first.");
        // The key is the whole wallet, so showing it needs the owner's fingerprint, face or PIN, and an account with none must add one first.
        if (!hasPasskey(u)) throw new MoopayError("INVALID_INPUT", "Set up biometrics first. Type /passkey, then ask for your key again.");
        await passkeys.verify(u, origin, (await bodyOf(req))["assertion"] as AuthenticationResponseJSON | undefined, "export"); store.save();
        security.add("key_exported", { user: u.id.slice(0, 8) }, now());
        const k = store.keyOf(u);
        json(res, 200, { accountId: k.accountId, secretKey: k.secretKey });
        return true;
      }
      if (op === "passkey/status" && req.method === "GET") { json(res, 200, { count: u.passkeys?.length ?? 0, bio: u.bio ?? { web: true, x: true } }); return true; }
      if (op === "passkey/register-options" && req.method === "POST") { needMaster("Adding a passkey"); json(res, 200, await passkeys.registerOptions(u, origin)); return true; }
      if (op === "passkey/register" && req.method === "POST") {
        needMaster("Adding a passkey");
        await passkeys.register(u, origin, (await bodyOf(req))["response"] as RegistrationResponseJSON);
        security.add("passkey_added", { user: u.id.slice(0, 8) }, now()); store.event(u, "A passkey was added. Payments that need your OK now ask for your fingerprint, face or device PIN."); store.save();
        json(res, 200, { ok: true, count: u.passkeys?.length ?? 0 }); return true;
      }
      // Does this action need a passkey, and if so, the challenge to sign. Asked by the page before it tries.
      if (op === "passkey/options" && req.method === "POST") {
        const b = await bodyOf(req), purpose = String(b["purpose"] ?? "");
        const ap = u.approvals.find((x) => x.id === purpose.replace(/^approve:/, ""));
        const required = hasPasskey(u) && (purpose.startsWith("approve:") ? !!ap && ap.status === "pending" && (!!ap.strong || needsPasskey(u, "web")) : purpose === "toggle" || purpose === "unlock" || purpose === "export");
        json(res, 200, required ? { required, options: await passkeys.options(u, origin, purpose) } : { required: false }); return true;
      }
      if (op === "passkey/toggle" && req.method === "POST") {
        const b = await bodyOf(req), want = { web: b["web"] === undefined ? undefined : b["web"] !== false, x: b["x"] === undefined ? undefined : b["x"] !== false };
        if (!hasPasskey(u)) throw new MoopayError("INVALID_INPUT", "Add a passkey first. Type /passkey.");
        const cur = u.bio ?? { web: true, x: true };
        if ((want.web !== undefined && want.web !== cur.web) || (want.x !== undefined && want.x !== cur.x)) { await passkeys.verify(u, origin, b["assertion"] as AuthenticationResponseJSON | undefined, "toggle"); } // any change, on or off, needs the passkey itself
        u.bio = { web: want.web ?? cur.web, x: want.x ?? cur.x };
        security.add("passkey_toggle", { user: u.id.slice(0, 8), web: u.bio.web, x: u.bio.x }, now()); store.save();
        json(res, 200, { bio: u.bio }); return true;
      }
      if (op === "backup" && req.method === "POST") {
        needMaster("A backup");
        if (u.frozen) throw new MoopayError("INVALID_INPUT", "Your account is frozen. Type /unfreeze first.");
        const k = store.keyOf(u), code = String(req.headers["x-moopay-device"] ?? "");
        security.add("backup_made", { user: u.id.slice(0, 8) }, now());
        json(res, 200, sealBackup({ accountId: k.accountId, secretKey: k.secretKey }, code));
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
        if (!on) { needMaster("Unfreezing"); if (hasPasskey(u)) { await passkeys.verify(u, origin, b["assertion"] as AuthenticationResponseJSON | undefined, "unlock"); store.save(); } }
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
        const had = new Set(u.payments.map((p) => p.id));
        const ap = u.approvals.find((x) => x.id === b["id"]);
        if (b["approve"] && ap?.status === "pending" && hasPasskey(u) && (ap.strong || needsPasskey(u, "web"))) { await passkeys.verify(u, origin, b["assertion"] as AuthenticationResponseJSON | undefined, "approve:" + ap.id); store.save(); }
        const out = await ops.resolve(u, b["id"], b["approve"], ctx);
        ops.stampFees(u, had, CHAT_FEE_BPS());
        if (ap && b["approve"]) xDone(ap, out.result["status"]);
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
          const had = new Set(u.payments.map((p) => p.id));
          try { await runTurn({ id, ctl, auditor, extra: CHAT_RULES(CHAT_FEE_BPS()), llm: d.llm, model, u, text, ops, svc: d.svc, ctx, emit: emit as never, context: await contextOf(u).catch(() => "(account details are unavailable right now; call get_account if needed)") }); }
          catch (e) { emit({ type: "text", text: failText(e) }); }
          ops.stampFees(u, had, CHAT_FEE_BPS());
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
  /** Answers mentions on X, when the X_ settings are set and the AI is on. */
  let xPost: ((text: string, to: string) => Promise<void>) | undefined;
  /** After an approval that started on X goes through, the bot answers on that post with the amount and nothing else. */
  const xDone = (a: { tweet?: string; params: Record<string, unknown> }, status: unknown): void => {
    if (!a.tweet || !xPost || !(status === "sent" || status === "created" || status === "staked" || status === "group_done" || status === "scheduled" || status === "updated")) return;
    const p = a.params, items = Array.isArray(p["items"]) ? (p["items"] as { amountUsd?: string }[]) : undefined;
    const amt = p["amountUsd"] ? `$${p["amountUsd"]}` : p["amount"] ? `${p["amount"]} ${String(p["assetSymbol"] ?? "NEAR")}` : items && items.every((i) => i.amountUsd) ? `$${items.reduce((n, i) => n + Number(i.amountUsd), 0)}` : "";
    void xPost(`Transaction successful${amt ? `: ${amt}` : ""}`, a.tweet).catch(() => undefined);
  };
  const startXAgent = () => {
    const cfg = xFromEnv();
    if (!cfg || !d.llm) return undefined;
    const llm = d.llm, feeBps = X_FEE_BPS();
    const origin = process.env["MOOPAY_PUBLIC_HOST"]?.trim() ? `https://${process.env["MOOPAY_PUBLIC_HOST"]!.trim()}` : lastOrigin;
    const client = new XClient(cfg.keys);
    xPost = (text, to) => client.reply(text, to);
    return startX({
      store, feeBps, now, burst: new XBurst(),
      tripped: (why) => void alertOwner("x-halt", why, now()).catch(() => undefined),
      stamp: (u, had, bps) => ops.stampFees(u, had, bps),
      ask: async (u, text, tweetId) => {
        const urls: string[] = [];
        const emit = (e: { type: string; card?: Record<string, unknown>; label?: string; state?: string }) => { if (e.type === "step" && e.state !== "done") console.log(`[x] ${e.label}${e.state === "failed" ? " (failed)" : "…"}`); const url = e.type === "card" ? e.card?.["url"] : undefined; if (typeof url === "string") urls.push(url); };
        const final = await runTurn({ llm, model, auditor, u, text, ops, svc: d.svc, ctx: { origin, channel: "x", ...(tweetId ? { tweet: tweetId } : {}) }, emit: emit as never, extra: X_RULES(feeBps ? `${feeBps / 100}% of the amount` : "", hasPasskey(u) && needsPasskey(u, "x")), context: await contextOf(u).catch(() => "(account details are unavailable right now; call get_account if needed)") });
        if (SILENT.test(final)) u.chat.splice(-2, 2); // nothing was said, so nothing goes in the chat history
        store.save();
        return { text: final, urls };
      },
    }, cfg, Number(process.env["X_POLL_SECONDS"]) || 5, client);
  };
  return { handle, startWorker, startX: startXAgent, ops, store, tick: () => tick(ops, store, lastOrigin, now()) };
}

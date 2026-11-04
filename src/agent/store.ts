import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveNoteAccount } from "../lib/crypto.js";
import { loadSeed } from "../lib/seedfile.js";
import { recipientKey } from "./policy.js";

/*
 * One record per anonymous user. The browser keeps a random device token (the recovery code); only its hash is stored here.
 * A temporary session is a second, short-lived token for the same user: it can pay within the rules but cannot
 * export the wallet key, reset the recovery code or create more sessions. `id` never changes (the wallet key is derived from it).
 * The user's agent wallet is a NEAR account whose key is derived from a server seed (the "float" design:
 * it only ever holds the small working balance the user loads, and sweeps the rest to their payout wallet).
 */
export interface Rules { floatUsd: number; dailyCapUsd: number; newRecipientLimitUsd: number; approveAboveUsd: number; payoutAddress?: string; pendingPayout?: { address: string; at: number }; allowedChains?: string[]; allowedAssets?: string[] }
/** A leash for an outside AI agent (or a short-lived session). Always inside the user's own rules. */
export interface AgentKey {
  id: string; name: string; hash: string; prefix: string; createdAt: number; expiresAt?: number; revoked?: boolean;
  dailyUsd?: number; perPaymentUsd?: number; totalUsd?: number;
  chains?: string[]; assets?: string[]; recipients?: string[];
  /** only these client IPs may use the key */
  ips?: string[];
  spent: { day: string; usd: number }; totalSpent: number;
}
export interface Payment {
  id: string; kind: "send" | "claim" | "sweep" | "fund" | "withdraw" | "stake"; amountUsd: number; chain: string; recipient: string;
  status: string; createdAt: number; depositAddress?: string; txHash?: string; fundKey?: string; claimLink?: string; expected?: string; settled?: boolean; agentId?: string;
  /** set when the user signs in their own wallet on a pay page instead of the agent wallet */
  payId?: string;
  /** a stake paid from the user's own wallet: how much NEAR to stake once the money lands (24 decimals) */
  stakeNear?: string;
}
export interface Approval { id: string; kind: "send" | "claim" | "rules" | "withdraw" | "stake" | "batch" | "groupclaim"; params: Record<string, unknown>; summary: string; reason: string; createdAt: number; status: "pending" | "approved" | "declined" | "expired" }
/** One line of a group payout: where it goes, in what, and how much (dollars or coins). */
export interface GroupItem { chain: string; recipient: string; amountUsd?: string; amount?: string; assetSymbol?: string }
export interface Task { id: string; amountUsd: number; chain: string; recipient: string; assetSymbol?: string; items?: GroupItem[]; every: "day" | "week" | "month"; nextAt: number; text: string }
export interface AgentEvent { id: number; at: number; text: string; card?: unknown }
export interface Session { hash: string; createdAt: number; expiresAt: number }
export interface UserRec {
  id: string; accountId: string; createdAt: number; rules: Rules;
  /** hash of the current recovery code; equals `id` until the code is reset */
  masterHash: string; sessions: Session[];
  /** panic switch: nothing leaves the wallet and no rule changes until it is lifted with the recovery code */
  frozen?: boolean;
  /** where the rNEAR from a stake in progress goes, when it is not the payout wallet in the rules */
  rnearTo?: string;
  /** the user chose not to keep chat history: it stays in memory for context but is never written to disk or shown again after a reload */
  noHistory?: boolean;
  spent: { day: string; usd: number }; known: string[];
  payments: Payment[]; approvals: Approval[]; tasks: Task[]; events: AgentEvent[]; nextEventId: number;
  sponsoredAt?: number; agents: AgentKey[];
  /** one shared link, one private claim per named wallet */
  groups?: { id: string; at: number; entries: { receiver: string; chain: string; claimKey: string }[] }[];
  chat: { id?: string; at?: number; role: "user" | "assistant"; content: string }[]; seen: { usdc: string; near: string }; msgTimes: number[];
}

export const DEFAULT_RULES: Rules = { floatUsd: 25, dailyCapUsd: 50, newRecipientLimitUsd: 10, approveAboveUsd: 25 };
export const hashKey = (key: string): string => createHash("sha256").update("moopay.agentkey|" + key).digest("hex");
export const userIdOf = (deviceToken: string): string => createHash("sha256").update("moopay.device|" + deviceToken).digest("hex");

export const SESSION_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 10;
/** Old chat is dropped after this long (CHAT_RETENTION_DAYS, default 30). Payments and activity are kept: they are the user's money records. */
const chatTtl = (): number => (Number(process.env["CHAT_RETENTION_DAYS"]) || 30) * 86_400_000;
const MASTER_RE = /^[A-Za-z0-9_-]{32,64}$/;
const SESSION_RE = /^mps\.[A-Za-z0-9_-]{43}$/;
const newToken = (): string => randomBytes(32).toString("base64url");
/** Shown when a temporary session is over; the page turns this (HTTP 401) into a friendly restore prompt. */
export const SESSION_ENDED = "Your temporary session ended. Type /restore to open your account again.";

export class AgentStore {
  private users = new Map<string, UserRec>();
  private byMaster = new Map<string, UserRec>();
  private bySession = new Map<string, UserRec>();
  private readonly seed: Buffer;
  constructor(private readonly file: string) {
    if (existsSync(file)) for (const u of (JSON.parse(readFileSync(file, "utf8")) as { users: UserRec[] }).users) this.add(u);
    this.seed = loadSeed(`${file}.seed`);
  }

  private add(u: UserRec): void {
    u.agents ??= []; u.masterHash ??= u.id; for (const m of u.chat) m.at ??= Date.now(); u.sessions = (u.sessions ?? []).filter((x) => x.expiresAt > Date.now());
    this.users.set(u.id, u); this.byMaster.set(u.masterHash, u);
    for (const x of u.sessions) this.bySession.set(x.hash, u);
  }

  private wallet(id: string) { return deriveNoteAccount(createHmac("sha256", this.seed).update("moopay.agent|" + id).digest()); }
  keyOf(u: UserRec) { return this.wallet(u.id); }

  /** Who is behind this token? A recovery code (master) opens or creates the account; a session token only opens it, and never outlives its hour. */
  auth(token: string, now = Date.now()): { u: UserRec; master: boolean } {
    if (SESSION_RE.test(token)) {
      const hash = userIdOf(token), u = this.bySession.get(hash), x = u?.sessions.find((y) => y.hash === hash);
      if (!u || !x || x.expiresAt <= now) throw new Error(SESSION_ENDED);
      x.expiresAt = now + SESSION_MS;
      this.prune(u, now);
      return { u, master: false };
    }
    if (!MASTER_RE.test(token)) throw new Error("bad device token");
    const hash = userIdOf(token);
    let u = this.byMaster.get(hash);
    if (!u) {
      if (this.users.has(hash)) throw new Error("That recovery code was reset and no longer works. Use the new one.");
      u = {
        id: hash, masterHash: hash, sessions: [], accountId: this.wallet(hash).accountId, createdAt: now, rules: { ...DEFAULT_RULES }, spent: { day: "", usd: 0 }, known: [],
        payments: [], approvals: [], tasks: [], agents: [], events: [], nextEventId: 1, chat: [], seen: { usdc: "0", near: "0" }, msgTimes: [],
      };
      this.add(u); this.save();
    }
    this.prune(u, now);
    return { u, master: true };
  }
  private prune(u: UserRec, now: number): void { const keep = u.chat.filter((m) => (m.at ?? now) > now - chatTtl()); if (keep.length !== u.chat.length) u.chat = keep; }
  open(token: string): UserRec { return this.auth(token).u; }

  /** A one-hour token for a device that is not the user's own. */
  startSession(u: UserRec, now = Date.now()): string {
    for (const x of u.sessions.splice(0, Math.max(0, u.sessions.length - MAX_SESSIONS + 1))) this.bySession.delete(x.hash);
    const token = "mps." + newToken(), hash = userIdOf(token);
    u.sessions.push({ hash, createdAt: now, expiresAt: now + SESSION_MS }); this.bySession.set(hash, u); this.save();
    return token;
  }
  endSession(token: string): void {
    const hash = userIdOf(token), u = this.bySession.get(hash);
    if (!u) return;
    u.sessions = u.sessions.filter((x) => x.hash !== hash); this.bySession.delete(hash); this.save();
  }
  /** New recovery code; the old one and every session stop working. The wallet is unchanged. */
  reset(u: UserRec): string {
    const token = newToken();
    this.byMaster.delete(u.masterHash); u.masterHash = userIdOf(token); this.byMaster.set(u.masterHash, u);
    for (const x of u.sessions) this.bySession.delete(x.hash);
    u.sessions = []; this.save();
    return token;
  }
  /** Forgets the user entirely: chat, activity, schedules, agent keys, sessions. */
  remove(u: UserRec): void {
    this.users.delete(u.id); this.byMaster.delete(u.masterHash);
    for (const x of u.sessions) this.bySession.delete(x.hash);
    this.save();
  }
  /** Finds the account and key behind an agent key (compares hashes only). */
  byKey(key: string): { u: UserRec; ak: AgentKey } | undefined {
    const hash = hashKey(key);
    for (const u of this.users.values()) { const ak = u.agents?.find((a) => a.hash === hash); if (ak) return { u, ak }; }
    return undefined;
  }
  all(): UserRec[] { return [...this.users.values()]; }
  /** The claim link of one wallet inside a group link. Nothing about the other entries is revealed. */
  groupFind(gid: string, address: string): string | undefined {
    const norm = (a: string) => (a.startsWith("0x") || a.includes(".") ? a.toLowerCase() : a);
    for (const u of this.users.values()) for (const g of u.groups ?? []) if (g.id === gid) return g.entries.find((e) => norm(e.receiver) === norm(address.trim()))?.claimKey;
    return undefined;
  }

  /** Applies a held-back payout wallet change once its time has come. */
  settlePayout(u: UserRec, now = Date.now()): void {
    const p = u.rules.pendingPayout;
    if (!p || p.at > now) return;
    u.rules.payoutAddress = p.address; delete u.rules.pendingPayout;
    const k = recipientKey("near", p.address);
    if (!u.known.includes(k)) u.known.push(k);
    this.event(u, `Your new payout wallet ${p.address} is now active.`); this.save();
  }

  event(u: UserRec, text: string, card?: unknown): void {
    u.events.push({ id: u.nextEventId++, at: Date.now(), text, ...(card ? { card } : {}) });
    if (u.events.length > 100) u.events.shift();
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users: [...this.users.values()].map((u) => (u.noHistory ? { ...u, chat: [] } : u)) }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

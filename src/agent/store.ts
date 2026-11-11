import { createHash, createHmac, randomBytes } from "node:crypto";
import { deriveNoteAccount } from "./crypto.js";
import { SealedFile, Vault } from "../storage/index.js";
import { UserFileSchema } from "../storage/schema.js";
import { loadSeed } from "../storage/seed.js";
import { recipientKey } from "./policy.js";
import { Reporter, REPORT_KINDS, type Row } from "./report.js";
import type { Preflight } from "./preflight.js";

/*
 * One record per anonymous user. The browser keeps a random device token (the recovery code); only its hash is stored here.
 * A temporary session is a second, short-lived token for the same user: it can pay within the rules but cannot
 * export the wallet key, reset the recovery code or create more sessions. `id` never changes (the wallet key is derived from it).
 * The user's agent wallet is a NEAR account whose key is derived from a server seed (the "float" design:
 * it only ever holds the small working balance the user loads, and sweeps the rest to their payout wallet).
 */
export interface Rules { floatUsd: number; dailyCapUsd: number; newRecipientLimitUsd: number; approveAboveUsd: number; payoutAddress?: string; pendingPayout?: { address: string; at: number }; allowedChains?: string[]; allowedAssets?: string[]; /** send through the private route (beta) unless a payment says otherwise */ privateSends?: boolean }
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
  id: string; kind: "send" | "claim" | "sweep" | "fund" | "withdraw" | "stake" | "unstake" | "swap"; /** how it came about, for the team numbers only */ tag?: "scheduled" | "group"; amountUsd: number; chain: string; recipient: string;
  status: string; createdAt: number; /** moo points this payment earned, set once */ pts?: number; depositAddress?: string; txHash?: string; fundKey?: string; claimLink?: string; expected?: string; settled?: boolean; agentId?: string; /** fees added on top of `amountUsd`, in dollars, once known */ fee?: number;
  /** set when the user signs in their own wallet on a pay page instead of the agent wallet */
  payId?: string;
  /** the service fee rate (basis points) this payment owes, and whether it was taken; `feed` also marks the fee transfer itself */
  feeBps?: number; feed?: boolean;
  /** a stake paid from the user's own wallet: how much NEAR to stake once the money lands (24 decimals) */
  stakeNear?: string;
  /** why a stake is waiting or failed, in words the user can act on */
  why?: string;
  /** a private-route payment in progress (beta): `amt` in USDC units, `idem` makes a retried payout safe */
  pv?: { step: "funding" | "swapping" | "paying"; amt: string; idem: string; req?: string; /** where it goes: the OutLayer chain id and the token that leaves the private balance; swapTo and minOut when the receiver's coin is not USDC */ out: { chain: string; token: string; swapTo?: string; minOut?: string } };
}
export interface Approval { id: string; kind: "send" | "claim" | "rules" | "withdraw" | "stake" | "batch" | "groupclaim"; params: Record<string, unknown>; summary: string; reason: string; createdAt: number; status: "pending" | "approved" | "declined" | "expired"; pf?: Preflight }
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
  /** NEAR (yocto) lent to this wallet for its first fee, to be paid back after a stake */
  advance?: string;
  /** the user chose not to keep chat history: it stays in memory for context but is never written to disk or shown again after a reload */
  noHistory?: boolean;
  spent: { day: string; usd: number }; known: string[];
  payments: Payment[]; approvals: Approval[]; tasks: Task[]; events: AgentEvent[]; nextEventId: number;
  sponsoredAt?: number; agents: AgentKey[];
  /** conversions handed to the swap service that have not ended yet; the swap service sends the money back to the agent wallet if one fails */
  swaps?: { addr: string; at: number }[];
  /** the X (Twitter) account this user linked: mentions from it act as this user, inside the same rules */
  x?: { id: string; handle: string };
  /** the user's own OutLayer wallet for the private route (beta); the key is kept in the encrypted state file */
  outlayer?: { key: string; account: string };
  /** moo points earned by payments the agent made for this user (see earnPoints) */
  points?: number;
  /** the name the user chose; their wallet address is then <name>.<parent account> */
  name?: string;
  /** one shared link, one private claim per named wallet */
  groups?: { id: string; at: number; entries: { receiver: string; chain: string; claimKey: string }[] }[];
  chat: { id?: string; at?: number; role: "user" | "assistant"; content: string }[]; seen: { usdc: string; near: string }; msgTimes: number[];
}

export const DEFAULT_RULES: Rules = { floatUsd: 500, dailyCapUsd: 50, newRecipientLimitUsd: 10, approveAboveUsd: 25 };
export const hashKey = (key: string): string => createHash("sha256").update("moopay.agentkey|" + key).digest("hex");
export const userIdOf = (deviceToken: string): string => createHash("sha256").update("moopay.device|" + deviceToken).digest("hex");

export const SESSION_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 10;
/** Old chat is dropped after this long (CHAT_RETENTION_DAYS, default 30). Payments and activity are kept: they are the user's money records. */
const chatTtl = (): number => (Number(process.env["CHAT_RETENTION_DAYS"]) || 30) * 86_400_000;
const MAX_REMOTE = 500_000;
const MASTER_RE = /^[A-Za-z0-9_-]{32,64}$/;
const SESSION_RE = /^mps\.[A-Za-z0-9_-]{43}$/;
const newToken = (): string => randomBytes(32).toString("base64url");
/** Shown when a temporary session is over; the page turns this (HTTP 401) into a friendly restore prompt. */
export const SESSION_ENDED = "Your temporary session ended. Type /restore to open your account again.";

export class AgentStore {
  private users = new Map<string, UserRec>();
  private byMaster = new Map<string, UserRec>();
  private bySession = new Map<string, UserRec>();
  /** Every payment ever made (a user's list keeps only the latest 100) and the most each wallet has held, in cents. For the team's numbers; kept forever. */
  private ledger = new Map<string, Payment & { who: string }>();
  private peaks = new Map<string, number>();
  /** Payments other MooPay runs reported to this one (see report.ts), for the team's numbers page. */
  private remote = new Map<string, Row>();
  private readonly reporter = new Reporter();
  private constructor(private readonly file: SealedFile, private readonly seed: Buffer, users: UserRec[], ledger: Record<string, unknown> = {}, peaks: Record<string, number> = {}, remote: Record<string, unknown> = {}, kv: Record<string, string> = {}) {
    this.kv = kv;
    for (const u of users) this.add(u);
    for (const [k, v] of Object.entries(ledger)) this.ledger.set(k, v as Payment & { who: string });
    for (const [k, v] of Object.entries(peaks)) this.peaks.set(k, v);
    for (const [k, v] of Object.entries(remote)) this.remote.set(k, v as unknown as Row);
    this.remember();
  }

  static async open(path: string, vault: Vault = new Vault()): Promise<AgentStore> {
    const { file, value } = await SealedFile.open(path, UserFileSchema, vault, "state:agent");
    return new AgentStore(file, await loadSeed(`${path}.seed`, vault), (value?.users ?? []) as unknown as UserRec[], value?.ledger, value?.peaks, value?.remote, value?.kv);
  }

  flush(): Promise<void> { return this.file.flush(); }

  private add(u: UserRec): void {
    u.agents ??= []; u.masterHash ??= u.id; for (const m of u.chat) m.at ??= Date.now(); u.sessions = (u.sessions ?? []).filter((x) => x.expiresAt > Date.now());
    this.users.set(u.id, u); this.byMaster.set(u.masterHash, u);
    for (const x of u.sessions) this.bySession.set(x.hash, u);
  }

  private wallet(id: string) { return deriveNoteAccount(createHmac("sha256", this.seed).update("moopay.agent|" + id).digest()); }
  /** The key never changes; a named account is just another account controlled by the same key. */
  keyOf(u: UserRec) { const w = this.wallet(u.id); return u.name ? { ...w, accountId: u.accountId } : w; }
  nameTaken(name: string): boolean { for (const u of this.users.values()) if (u.name === name) return true; return false; }
  setName(u: UserRec, name: string, accountId: string): void { u.name = name; u.accountId = accountId; this.save(); }

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

  /** Copies every payment into the ledger as it is now (status changes included), and notes the most each wallet has held. */
  private remember(): void {
    for (const u of this.users.values()) {
      for (const p of u.payments) this.ledger.set(p.id, { ...p, who: u.id });
      const c = Number(u.seen?.usdc ?? 0); if (c > (this.peaks.get(u.id) ?? 0)) this.peaks.set(u.id, c);
    }
  }
  /* ---- the X agent: linking an X account, and a few small settings that belong to no user ---- */
  private xCodes = new Map<string, { id: string; exp: number }>();
  /** A one-time code the user posts from their X account to link it. Lasts 15 minutes. */
  linkCode(u: UserRec, now: number): string {
    for (const [c, v] of this.xCodes) if (v.exp < now || v.id === u.id) this.xCodes.delete(c);
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = randomBytes(8);
    const code = "moo-" + Array.from(b.subarray(0, 6), (x) => alphabet[x % alphabet.length]).join("");
    this.xCodes.set(code, { id: u.id, exp: now + 15 * 60_000 }); return code;
  }
  /** Links the X account that posted a valid code. One X account belongs to one MooPay account. */
  completeLink(code: string, xId: string, handle: string, now: number): UserRec | undefined {
    const key = "moo-" + code.trim().slice(4).toUpperCase(), c = this.xCodes.get(key);
    const u = c && c.exp > now ? this.users.get(c.id) : undefined;
    if (!u || (this.byX(xId) && this.byX(xId) !== u)) return undefined;
    this.xCodes.delete(key);
    u.x = { id: xId, handle: handle.replace(/^@/, "").toLowerCase() }; this.save(); return u;
  }
  byX(id: string): UserRec | undefined { return this.all().find((u) => u.x?.id === id); }
  byHandle(handle: string): UserRec | undefined { const h = handle.replace(/^@/, "").toLowerCase(); return this.all().find((u) => u.x?.handle === h); }
  kv: Record<string, string> = {};
  /** Notes a finished event (a conversion) in the permanent ledger without putting it in the user's recent list. */
  note(u: UserRec, row: Payment): void { this.ledger.set(row.id, { ...row, who: u.id }); }
  history(): { rows: (Payment & { who: string })[]; peaks: Map<string, number>; remote: Row[] } { this.remember(); return { rows: [...this.ledger.values()], peaks: this.peaks, remote: [...this.remote.values()] }; }

  /** Takes in rows reported by other MooPay runs (a laptop test, say). Bad rows are dropped; the same row again replaces the old one. Returns how many were kept. */
  ingest(rows: unknown[]): number {
    let kept = 0;
    for (const r of rows.slice(0, 500) as Partial<Row>[]) {
      const ok = r && typeof r === "object" && typeof r.key === "string" && r.key.length <= 200 && typeof r.id === "string" && r.id.length <= 80 && typeof r.who === "string" && /^[0-9a-f]{8,64}$/.test(r.who)
        && (r.env === "production" || r.env === "development") && typeof r.host === "string" && /^[\w.:-]{1,80}$/.test(r.host) && typeof r.kind === "string" && REPORT_KINDS.includes(r.kind)
        && typeof r.chain === "string" && r.chain.length <= 16 && typeof r.status === "string" && r.status.length <= 40 && typeof r.amountUsd === "number" && Number.isFinite(r.amountUsd) && r.amountUsd >= 0 && r.amountUsd < 1e9
        && typeof r.createdAt === "number" && Number.isFinite(r.createdAt) && (r.tag === undefined || r.tag === "scheduled" || r.tag === "group");
      if (!ok || (this.remote.size >= MAX_REMOTE && !this.remote.has(r.key!))) continue;
      this.remote.set(r.key!, { key: r.key!, id: r.id!, who: r.who!, env: r.env!, host: r.host!, kind: r.kind!, ...(r.tag ? { tag: r.tag } : {}), chain: r.chain!, amountUsd: r.amountUsd!, status: r.status!, createdAt: r.createdAt!, settled: !!r.settled });
      kept++;
    }
    if (kept) this.save();
    return kept;
  }

  save(): void {
    this.remember();
    this.reporter.push(this.ledger.values());
    this.file.save({ ledger: Object.fromEntries(this.ledger), peaks: Object.fromEntries(this.peaks), remote: Object.fromEntries(this.remote), kv: this.kv, users: [...this.users.values()].map((u) => (u.noHistory ? { ...u, chat: [] } : u)) });
  }
}

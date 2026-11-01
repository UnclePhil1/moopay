import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveNoteAccount } from "../lib/crypto.js";

/*
 * One record per anonymous user. The browser keeps a random device token; only its hash is stored here.
 * The user's agent wallet is a NEAR account whose key is derived from a server seed (the "float" design:
 * it only ever holds the small working balance the user loads, and sweeps the rest to their payout wallet).
 */
export interface Rules { floatUsd: number; dailyCapUsd: number; newRecipientLimitUsd: number; approveAboveUsd: number; payoutAddress?: string; allowedChains?: string[]; allowedAssets?: string[] }
/** A leash for an outside AI agent (or a short-lived session). Always inside the user's own rules. */
export interface AgentKey {
  id: string; name: string; hash: string; prefix: string; createdAt: number; expiresAt?: number; revoked?: boolean;
  dailyUsd?: number; perPaymentUsd?: number; totalUsd?: number;
  chains?: string[]; assets?: string[]; recipients?: string[];
  spent: { day: string; usd: number }; totalSpent: number;
}
export interface Payment {
  id: string; kind: "send" | "claim" | "sweep" | "fund" | "withdraw" | "stake"; amountUsd: number; chain: string; recipient: string;
  status: string; createdAt: number; depositAddress?: string; txHash?: string; fundKey?: string; claimLink?: string; expected?: string; settled?: boolean; agentId?: string;
}
export interface Approval { id: string; kind: "send" | "claim" | "rules" | "withdraw" | "stake"; params: Record<string, unknown>; summary: string; reason: string; createdAt: number; status: "pending" | "approved" | "declined" | "expired" }
export interface Task { id: string; amountUsd: number; chain: string; recipient: string; assetSymbol?: string; every: "day" | "week" | "month"; nextAt: number; text: string }
export interface AgentEvent { id: number; at: number; text: string; card?: unknown }
export interface UserRec {
  id: string; accountId: string; createdAt: number; rules: Rules;
  spent: { day: string; usd: number }; known: string[];
  payments: Payment[]; approvals: Approval[]; tasks: Task[]; events: AgentEvent[]; nextEventId: number;
  sponsoredAt?: number; agents: AgentKey[];
  chat: { id?: string; role: "user" | "assistant"; content: string }[]; seen: { usdc: string; near: string }; msgTimes: number[];
}

export const DEFAULT_RULES: Rules = { floatUsd: 25, dailyCapUsd: 50, newRecipientLimitUsd: 10, approveAboveUsd: 25 };
export const hashKey = (key: string): string => createHash("sha256").update("moopay.agentkey|" + key).digest("hex");
export const userIdOf = (deviceToken: string): string => createHash("sha256").update("moopay.device|" + deviceToken).digest("hex");

export class AgentStore {
  private users = new Map<string, UserRec>();
  private readonly seed: Buffer;
  constructor(private readonly file: string) {
    if (existsSync(file)) for (const u of (JSON.parse(readFileSync(file, "utf8")) as { users: UserRec[] }).users) this.users.set(u.id, u);
    const seedFile = `${file}.seed`;
    if (existsSync(seedFile)) this.seed = Buffer.from(readFileSync(seedFile, "utf8").trim(), "hex");
    else { this.seed = randomBytes(32); writeFileSync(seedFile, this.seed.toString("hex"), { mode: 0o600 }); }
  }

  private wallet(id: string) { return deriveNoteAccount(createHmac("sha256", this.seed).update("moopay.agent|" + id).digest()); }
  keyOf(u: UserRec) { return this.wallet(u.id); }

  open(deviceToken: string): UserRec {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(deviceToken)) throw new Error("bad device token");
    const id = userIdOf(deviceToken);
    let u = this.users.get(id);
    if (u) u.agents ??= [];
    if (!u) {
      u = {
        id, accountId: this.wallet(id).accountId, createdAt: Date.now(), rules: { ...DEFAULT_RULES }, spent: { day: "", usd: 0 }, known: [],
        payments: [], approvals: [], tasks: [], agents: [], events: [], nextEventId: 1, chat: [], seen: { usdc: "0", near: "0" }, msgTimes: [],
      };
      this.users.set(id, u); this.save();
    }
    return u;
  }
  /** Finds the account and key behind an agent key (compares hashes only). */
  byKey(key: string): { u: UserRec; ak: AgentKey } | undefined {
    const hash = hashKey(key);
    for (const u of this.users.values()) { const ak = u.agents?.find((a) => a.hash === hash); if (ak) return { u, ak }; }
    return undefined;
  }
  all(): UserRec[] { return [...this.users.values()]; }

  event(u: UserRec, text: string, card?: unknown): void {
    u.events.push({ id: u.nextEventId++, at: Date.now(), text, ...(card ? { card } : {}) });
    if (u.events.length > 100) u.events.shift();
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users: [...this.users.values()] }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

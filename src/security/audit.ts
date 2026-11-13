import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

/*
 * An append-only record of security events: blocked messages, refused payments, limit hits, the kill switch.
 * Every line carries the hash of the line before it, so deleting or editing an old line breaks the chain and `verify` says so.
 * It holds short facts only (what kind of event, which account, a few words), never keys, codes or full messages.
 */
export interface Entry { t: number; kind: string; [k: string]: string | number | boolean }
type Line = Entry & { prev: string; h: string };

const GENESIS = "0".repeat(64);
const digest = (prev: string, body: string): string => createHash("sha256").update(prev + body).digest("hex");
const short = (v: string | number | boolean): string | number | boolean => (typeof v === "string" ? v.slice(0, 160) : v);

export class SecurityLog {
  private last = GENESIS;
  private recent: Line[] = [];
  /** With a file, events survive a restart. Without one they stay in memory (tests, local runs). */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
      this.recent = rows.slice(-500); this.last = rows.at(-1)?.h ?? GENESIS;
    }
  }
  add(kind: string, detail: Record<string, string | number | boolean> = {}, t: number = Date.now()): void {
    const body = JSON.stringify({ t, kind, ...Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, short(v)])) });
    const line = { ...(JSON.parse(body) as Entry), prev: this.last, h: digest(this.last, body) } as Line;
    this.last = line.h; this.recent.push(line); if (this.recent.length > 500) this.recent.shift();
    if (this.file) try { appendFileSync(this.file, JSON.stringify(line) + "\n", { mode: 0o600 }); } catch { /* the log must never stop a payment check */ }
    console.log(`[security] ${kind} ${Object.entries(detail).map(([k, v]) => `${k}=${String(short(v))}`).join(" ")}`);
  }
  tail(n = 100): Entry[] { return this.recent.slice(-n).map(({ prev: _p, h: _h, ...e }) => e as Entry); }
  /** True when every line chains from the one before it, from the first line in the file to the last. */
  verify(): boolean {
    const rows = this.file && existsSync(this.file) ? readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line) : this.recent;
    let prev = rows.length && this.file ? GENESIS : (rows[0]?.prev ?? GENESIS);
    for (const r of rows) {
      const { prev: p, h, ...e } = r;
      if (p !== prev || digest(p, JSON.stringify(e)) !== h) return false;
      prev = h;
    }
    return true;
  }
}

/** The one log the whole app writes to. makeAgent points it at a file next to the state. */
export let security = new SecurityLog();
export const useSecurityLog = (file: string): SecurityLog => (security = new SecurityLog(file));

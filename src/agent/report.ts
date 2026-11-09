import { createHash } from "node:crypto";
import { where } from "../util/where.js";
import type { Payment } from "./store.js";

/*
 * Sends a copy of each payment's outcome to the team's numbers page, when MOOPAY_STAT_REPORT_URL is set (a test run on a laptop reports to the real site).
 * Only amounts, kinds, chains and statuses leave: no wallet addresses, no transaction ids, and the user is a one-way hash.
 */
export const REPORT_KINDS = ["send", "claim", "sweep", "fund", "withdraw", "stake", "unstake", "swap"];
export interface Row { key: string; id: string; who: string; env: string; host: string; kind: string; tag?: string; chain: string; amountUsd: number; status: string; createdAt: number; settled: boolean }
const hashed = (id: string) => createHash("sha256").update("moopay.stat|" + id).digest("hex").slice(0, 24);

export class Reporter {
  private sent = new Map<string, string>();
  private busy = false;
  constructor(private readonly url = process.env["MOOPAY_STAT_REPORT_URL"], private readonly secret = process.env["MOOPAY_STAT_PASSWORD"], private readonly doFetch: typeof fetch = fetch) {}
  get on(): boolean { return !!this.url && !!this.secret; }

  /** Sends whatever changed since the last time. A failure is simply tried again at the next save. */
  push(rows: Iterable<Payment & { who: string }>): void {
    if (!this.on || this.busy) return;
    const w = where(), batch: Row[] = [], sig = new Map<string, string>();
    for (const p of rows) {
      const s = `${p.status}|${p.settled ? 1 : 0}|${p.tag ?? ""}`;
      if (this.sent.get(p.id) === s || !REPORT_KINDS.includes(p.kind)) continue;
      sig.set(p.id, s);
      batch.push({ key: `${w.env}:${w.host}:${p.id}`, id: p.id, who: hashed(p.who), env: w.env, host: w.host, kind: p.kind, ...(p.tag ? { tag: p.tag } : {}), chain: p.chain, amountUsd: p.amountUsd, status: p.status, createdAt: p.createdAt, settled: !!p.settled });
      if (batch.length >= 200) break;
    }
    if (!batch.length) return;
    this.busy = true;
    void this.doFetch(this.url!, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.secret}` }, body: JSON.stringify({ rows: batch }), signal: AbortSignal.timeout(10_000) })
      .then((r) => { if (r.ok) for (const [id, s] of sig) this.sent.set(id, s); })
      .catch(() => undefined)
      .finally(() => { this.busy = false; });
  }
}

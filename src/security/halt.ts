/*
 * The global kill switch. One value in the saved state says what is paused:
 *   "x"   nothing started from X moves money (the web app still works)
 *   "all" nothing leaves any agent wallet
 * An operator sets it through the admin route. It also trips by itself when X traffic suddenly spikes, which is what a hijacked
 * account or a spam wave looks like. It stays set across restarts until an operator lifts it.
 */
export type HaltScope = "" | "x" | "all";

export const haltScope = (kv: Record<string, string>): HaltScope => (kv["halt"] === "x" || kv["halt"] === "all" ? kv["halt"] : "");
export const setHalt = (kv: Record<string, string>, scope: HaltScope): void => { if (scope) kv["halt"] = scope; else delete kv["halt"]; };

/** Money requests from X in the last ten minutes; too many at once trips the switch. */
export class XBurst {
  private times: number[] = [];
  constructor(private readonly limit: number = Number(process.env["MOOPAY_X_BURST"]) || 30) {}
  /** Counts one request. True when this one went over the limit. */
  note(now: number): boolean {
    this.times = this.times.filter((t) => now - t < 600_000);
    this.times.push(now);
    return this.times.length > this.limit;
  }
}

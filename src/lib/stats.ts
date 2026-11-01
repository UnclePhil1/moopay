import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Public, aggregate-only numbers for the landing page. Wallets are stored as short hashes, never as account ids. */
interface Data { payments: number; volumeUsdCents: number; wallets: string[]; seen: string[] }

export class Stats {
  private data: Data = { payments: 0, volumeUsdCents: 0, wallets: [], seen: [] };
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try { this.data = { ...this.data, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Data>) }; } catch { /* start fresh */ }
    }
  }

  /** Counts one delivered payment, once per deposit address. */
  record(depositAddress: string, usd: number, payer: string): void {
    if (this.data.seen.includes(depositAddress)) return;
    this.data.seen.push(depositAddress);
    if (this.data.seen.length > 5000) this.data.seen.shift();
    this.data.payments += 1;
    this.data.volumeUsdCents += Math.round(usd * 100);
    const w = createHash("sha256").update("moopay.stats|" + payer).digest("hex").slice(0, 16);
    if (!this.data.wallets.includes(w)) this.data.wallets.push(w);
    this.save();
  }

  snapshot() {
    return { payments: this.data.payments, volumeUsd: this.data.volumeUsdCents / 100, users: this.data.wallets.length };
  }

  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

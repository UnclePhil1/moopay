import { createHash } from "node:crypto";
import { SealedFile, Vault } from "./index.js";
import { StatsFileSchema } from "./schema.js";

/** Public, aggregate-only numbers for the landing page. Wallets are stored as short hashes, never as account ids. */
interface Data { payments: number; volumeUsdCents: number; wallets: string[]; seen: string[] }

export class Stats {
  private data: Data = { payments: 0, volumeUsdCents: 0, wallets: [], seen: [] };
  constructor(private readonly file?: SealedFile, data?: Partial<Data>) {
    if (data) this.data = { ...this.data, ...data };
  }

  /** A damaged stats file only loses landing-page counters, so it starts fresh instead of blocking the server. */
  static async open(path: string, vault: Vault = new Vault()): Promise<Stats> {
    try {
      const { file, value } = await SealedFile.open(path, StatsFileSchema, vault, "state:stats");
      return new Stats(file, value);
    } catch (e) {
      console.error(`[moopay] stats file ignored: ${(e as Error).message}`);
      return new Stats();
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

  private save(): void { this.file?.save(this.data); }

  flush(): Promise<void> { return this.file?.flush() ?? Promise.resolve(); }
}

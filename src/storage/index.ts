import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { bigintReplacer } from "../util/json.js";
import { Vault } from "./encryption.js";

export { Vault } from "./encryption.js";

/** One read: the validated value, plus whether the file still has to be moved to sealed storage. */
export interface Loaded<T> { value: T; upgrade: boolean }

export async function readSealed<S extends z.ZodType>(path: string, schema: S, vault: Vault, purpose: string): Promise<Loaded<z.infer<S>> | undefined> {
  let text: string;
  try { text = (await readFile(path, "utf8")).trim(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const sealed = Vault.isSealed(text);
  const json = sealed ? Buffer.from(vault.open(text, purpose)).toString("utf8") : text;
  const parsed = schema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`${path} does not match its schema (${parsed.error.issues[0]?.path.join(".") || "root"}); refusing to start over it`);
  return { value: parsed.data, upgrade: vault.enabled && (!sealed || Vault.isLegacy(text)) };
}

/** Temp file, flush to disk, rename: a reader or a crash never sees half a file. */
export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fh = await open(tmp, "w", 0o600);
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export const seal = (value: unknown, vault: Vault, purpose: string): string => {
  const json = JSON.stringify(value, bigintReplacer);
  return vault.enabled ? vault.seal(Buffer.from(json), purpose) : json;
};

/**
 * One sealed JSON file with a write-behind queue. save() takes a snapshot at once and returns; snapshots are written one at a time,
 * and only the newest waiting one is kept. flush() resolves when the disk matches the last save().
 */
export class SealedFile {
  private pending: string | undefined;
  private running: Promise<void> | undefined;
  private failure: unknown;

  private constructor(readonly path: string, private readonly vault: Vault, private readonly purpose: string) {}

  static async open<S extends z.ZodType>(path: string, schema: S, vault: Vault, purpose: string): Promise<{ file: SealedFile; value: z.infer<S> | undefined }> {
    const file = new SealedFile(path, vault, purpose);
    const loaded = await readSealed(path, schema, vault, purpose);
    if (loaded?.upgrade) await writeText(path, seal(loaded.value, vault, purpose));
    return { file, value: loaded?.value };
  }

  save(value: unknown): void {
    this.pending = seal(value, this.vault, this.purpose);
    this.running ??= this.drain();
  }

  async flush(): Promise<void> {
    while (this.running) await this.running;
    if (this.failure) { const e = this.failure; this.failure = undefined; throw e; }
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending !== undefined) {
        const text = this.pending;
        this.pending = undefined;
        try { await writeText(this.path, text); this.failure = undefined; } catch (e) {
          this.failure = e;
          this.pending ??= text; // the next save() retries with the newest snapshot
          console.error(`[moopay] could not write ${this.path}: ${(e as Error).message}`);
          return;
        }
      }
    } finally { this.running = undefined; }
  }
}

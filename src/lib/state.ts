import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MoopayError } from "./errors.js";
import { bigintReplacer } from "./json.js";

export type NoteStatus = "MINTED" | "CLAIMING" | "CLAIMED";
export type NullifierState = "UNUSED" | "CLAIMING" | "SPENT";

export interface ClaimRecord {
  /** claimBinding hash; the recipient itself is deliberately not stored. */
  binding: string;
  destinationChain: "btc" | "sol" | "eth";
  depositAddress?: string;
  txHash?: string;
  quoteDeadline?: string;
  startedAt: string;
  oneClickStatus?: string;
}

export interface Note {
  commitment: string;
  nullifierHash: string;
  assetId: string;
  amount: bigint;
  /** Per-note NEAR account derived from the secret; the funds live here, not with MooPay. */
  noteAccountId: string;
  status: NoteStatus;
  createdAt: string;
  updatedAt: string;
  memoHash?: string;
  claim?: ClaimRecord;
}

interface Persisted {
  version: 1;
  notes: Record<string, Omit<Note, "amount"> & { amount: string }>;
  nullifiers: Record<string, { state: NullifierState; commitment: string }>;
}

/** Serialises async critical sections (single process; the file is not shared between processes). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class Ledger {
  private notes = new Map<string, Note>();
  private nullifiers = new Map<string, { state: NullifierState; commitment: string }>();
  private readonly mutex = new Mutex();
  private readonly path: string;

  constructor(stateFile: string) {
    this.path = resolve(stateFile);
    if (existsSync(this.path)) {
      let data: Persisted;
      try {
        data = JSON.parse(readFileSync(this.path, "utf8")) as Persisted;
      } catch {
        throw new MoopayError("INTERNAL", "State file is unreadable; refusing to start with a fresh ledger");
      }
      for (const [k, n] of Object.entries(data.notes ?? {})) this.notes.set(k, { ...n, amount: BigInt(n.amount) });
      for (const [k, v] of Object.entries(data.nullifiers ?? {})) this.nullifiers.set(k, v);
    }
  }

  get filePath(): string {
    return this.path;
  }

  get(commitment: string): Note | undefined {
    const n = this.notes.get(commitment);
    return n ? structuredClone(n) : undefined;
  }

  /** Lookup by commitment or nullifierHash. */
  find(id: string): Note | undefined {
    const direct = this.get(id);
    if (direct) return direct;
    const nf = this.nullifiers.get(id);
    return nf ? this.get(nf.commitment) : undefined;
  }

  nullifierState(nullifierHash: string): NullifierState | undefined {
    return this.nullifiers.get(nullifierHash)?.state;
  }

  insert(note: Note): Promise<void> {
    return this.mutex.run(async () => {
      if (this.notes.has(note.commitment)) throw new MoopayError("INTERNAL", "commitment collision");
      this.notes.set(note.commitment, structuredClone(note));
      this.nullifiers.set(note.nullifierHash, { state: "UNUSED", commitment: note.commitment });
      this.flush();
    });
  }

  /** Read-modify-write under the lock. `fn` mutates a copy; throwing aborts without writing. */
  update(commitment: string, fn: (n: Note) => void): Promise<Note> {
    return this.mutex.run(async () => {
      const cur = this.notes.get(commitment);
      if (!cur) throw new MoopayError("NOTE_NOT_FOUND", "note not found");
      const next = structuredClone(cur);
      fn(next);
      next.updatedAt = new Date().toISOString();
      this.notes.set(commitment, next);
      this.flush();
      return structuredClone(next);
    });
  }

  /**
   * Atomically UNUSED -> CLAIMING, creating the journal entry if this machine never minted the note.
   * Flushed to disk before the caller touches 1Click, so a crash afterwards can only strand the
   * attempt, never double-spend it. The chain is the real source of truth for the funds.
   */
  beginClaim(base: Note, claim: ClaimRecord): Promise<Note> {
    return this.mutex.run(async () => {
      const existing = this.notes.get(base.commitment);
      const nf = this.nullifiers.get(base.nullifierHash);
      if ((nf && nf.state !== "UNUSED") || existing?.status === "CLAIMING" || existing?.status === "CLAIMED")
        throw new MoopayError("NOTE_ALREADY_CLAIMED", "note has already been claimed or is being claimed");
      const next: Note = {
        ...structuredClone(existing ?? base),
        status: "CLAIMING",
        claim,
        updatedAt: new Date().toISOString(),
      };
      this.notes.set(base.commitment, next);
      this.nullifiers.set(base.nullifierHash, { state: "CLAIMING", commitment: base.commitment });
      this.flush();
      return structuredClone(next);
    });
  }

  /** CLAIMING -> MINTED, nullifier unused again. Only for proven non-spend (pre-broadcast failure, 1Click REFUNDED). */
  releaseClaim(commitment: string): Promise<Note> {
    return this.mutex.run(async () => {
      const note = this.notes.get(commitment);
      if (!note || note.status !== "CLAIMING") throw new MoopayError("INTERNAL", "no claim to release");
      const next: Note = { ...structuredClone(note), status: "MINTED", updatedAt: new Date().toISOString() };
      delete next.claim;
      this.notes.set(commitment, next);
      this.nullifiers.set(note.nullifierHash, { state: "UNUSED", commitment });
      this.flush();
      return structuredClone(next);
    });
  }

  completeClaim(commitment: string): Promise<Note> {
    return this.mutex.run(async () => {
      const note = this.notes.get(commitment);
      if (!note || note.status !== "CLAIMING") throw new MoopayError("INTERNAL", "no claim to complete");
      const next: Note = { ...structuredClone(note), status: "CLAIMED", updatedAt: new Date().toISOString() };
      this.notes.set(commitment, next);
      this.nullifiers.set(note.nullifierHash, { state: "SPENT", commitment });
      this.flush();
      return structuredClone(next);
    });
  }

  /** Write temp file, fsync, rename: readers never see a partial ledger. */
  private flush(): void {
    const data: Persisted = { version: 1, notes: {}, nullifiers: {} };
    for (const [k, n] of this.notes) data.notes[k] = { ...n, amount: n.amount.toString() };
    for (const [k, v] of this.nullifiers) data.nullifiers[k] = v;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(data, bigintReplacer, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

import { Account, KeyPairSigner, type Signer } from "near-api-js";
import { Refused, emptyTally, type Mandate, type TallyData } from "./policy.js";

export interface Credential { id: string; publicKey: string; counter: number; transports?: string[]; at: number }

/** Everything the signer remembers about one user. It lives on chain, so a rolled-back disk cannot reset it. */
export interface UserState {
  credentials: Credential[];
  /** Until this time (ms) the first passkey is not yet in force, so a thief who registers one cannot use it at once. */
  activeAt: number;
  /** Every payment needs a passkey signature, however small. */
  strict: boolean;
  /** Nothing is signed until the passkey unlocks it. */
  locked: boolean;
  /** Today's total moved, per asset (all payments). */
  total: TallyData;
  /** Today's total moved with no passkey signature, per asset. */
  free: TallyData;
  /** Today's total moved to MooPay's fee account, per asset. */
  fee?: TallyData;
  /** What the owner's last passkey signature allows, for a few minutes. */
  mandate?: Mandate;
}

export const newUser = (): UserState => ({ credentials: [], activeAt: 0, strict: false, locked: false, total: emptyTally(), free: emptyTally() });

export interface Versioned { state: UserState; version: number }

/**
 * Where user state is kept. `save` must fail when `expectedVersion` is not the latest, so two signers (or an old copy) cannot
 * overwrite each other. The signer saves BEFORE it signs, so anything that was signed is always on record.
 */
export interface StateStore {
  load(user: string): Promise<Versioned>;
  save(user: string, state: UserState, expectedVersion: number): Promise<number>;
}

const unavailable = () => new Refused("state_unavailable", "The signer can't reach its record right now, so nothing was sent. Try again in a minute.");

/** For tests and local development. Versions behave like the chain: a stale save is refused. */
export class MemoryStateStore implements StateStore {
  private readonly rows = new Map<string, { version: number; json: string }>();
  async load(user: string): Promise<Versioned> {
    const r = this.rows.get(user);
    return r ? { state: JSON.parse(r.json) as UserState, version: r.version } : { state: newUser(), version: 0 };
  }
  async save(user: string, state: UserState, expectedVersion: number): Promise<number> {
    const have = this.rows.get(user)?.version ?? 0;
    if (have !== expectedVersion) throw unavailable();
    this.rows.set(user, { version: have + 1, json: JSON.stringify(state) });
    return have + 1;
  }
}

/** The minimum of near-api-js's provider that the store needs, so tests can stand in a fake chain. */
export interface ChainReader { callFunction(p: { contractId: string; method: string; args: Record<string, unknown> }): Promise<unknown> }

/** Keeps state in the `signer-state` contract. Reads are views; every write is a transaction signed by the signer's own key. */
export class NearStateStore implements StateStore {
  constructor(private readonly contractId: string, private readonly provider: ChainReader & ConstructorParameters<typeof Account>[1], private readonly writerId: string, private readonly writerKey: string | Signer) {}

  async load(user: string): Promise<Versioned> {
    let entry: unknown;
    try { entry = await this.provider.callFunction({ contractId: this.contractId, method: "get", args: { user } }); } catch { throw unavailable(); }
    if (entry === null || entry === undefined) return { state: newUser(), version: 0 };
    const e = entry as { version?: unknown; state?: unknown };
    if (typeof e.version !== "number" || typeof e.state !== "string") throw unavailable();
    try { return { state: JSON.parse(e.state) as UserState, version: e.version }; } catch { throw unavailable(); }
  }

  async save(user: string, state: UserState, expectedVersion: number): Promise<number> {
    const signer = typeof this.writerKey === "string" ? KeyPairSigner.fromSecretKey(this.writerKey as never) : this.writerKey;
    try {
      const out = await new Account(this.writerId, this.provider, signer).callFunctionRaw({
        contractId: this.contractId, methodName: "set", args: { user, state: JSON.stringify(state), expected_version: expectedVersion }, deposit: 0n, gas: 30n * 10n ** 12n,
      });
      const status = (out as unknown as { status?: unknown }).status;
      if (status && typeof status === "object" && "Failure" in (status as object)) throw new Error("failed");
      return expectedVersion + 1;
    } catch { throw unavailable(); }
  }
}

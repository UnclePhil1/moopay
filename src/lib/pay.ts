import { randomBytes } from "node:crypto";
import { MoopayError } from "./errors.js";

/** One pending payment the user finishes on the pay page. Held in memory only; nothing here is a secret. */
export interface PayIntent {
  id: string;
  destinationChain: string;
  destinationAssetId: string;
  recipient: string;
  /** Human decimal in the units of whichever stablecoin the user picks, e.g. "2.5". */
  payAmount: string;
  slippageBps: number;
  createdAt: number;
  /** Set when the user asks for a quote on the pay page. */
  depositAddress?: string;
  payer?: string;
  /** Which wallet the page should offer first, e.g. the user said "send my SOL". */
  fromChain?: string;
  fromSymbol?: string;
  /** Same chain and same coin: the payer's wallet sends straight to the recipient, no swap and no 1Click. */
  direct?: boolean;
  /** The transaction (signature or hash) the payer's wallet reported for a direct payment. */
  sig?: string;
  /** A staking payment: the money lands in the agent wallet and is staked for `payout`, which the page asks for before anything is signed. */
  stake?: { payout?: string; notice?: string };
  /** Money added to the agent wallet: a deposit address accepts a little more or less than quoted. */
  fund?: boolean;
  /** Not a payment: one contract call the user signs in their own wallet (unstaking, withdrawing). */
  call?: { account: string; contract: string; method: string; args: Record<string, unknown>; title: string; lines: [string, string][] };
}

const TTL_MS = 30 * 60 * 1000;
const MAX_INTENTS = 200;

export class PayHub {
  private readonly intents = new Map<string, PayIntent>();
  constructor(private readonly now: () => number = Date.now) {}

  create(i: Omit<PayIntent, "id" | "createdAt">): PayIntent {
    this.sweep();
    if (this.intents.size >= MAX_INTENTS) throw new MoopayError("INTERNAL", "too many pending payments; try again shortly");
    const intent: PayIntent = { ...i, id: randomBytes(9).toString("base64url"), createdAt: this.now() };
    this.intents.set(intent.id, intent);
    return intent;
  }

  get(id: string): PayIntent {
    this.sweep();
    const i = this.intents.get(id);
    if (!i) throw new MoopayError("NOTE_NOT_FOUND", "this payment link has expired; ask for a new one");
    return i;
  }

  /** Keeps a paying intent alive for another full window and remembers where it was paid. */
  attach(id: string, depositAddress: string, payer: string): void {
    const i = this.get(id);
    i.depositAddress = depositAddress;
    i.payer = payer;
    i.createdAt = this.now();
  }

  /** Marks a pay link as a straight transfer; the recipient plays the part of the deposit address. */
  direct(id: string, payer: string): void {
    const i = this.get(id);
    i.direct = true;
    i.depositAddress = i.recipient;
    i.payer = payer;
    i.createdAt = this.now();
  }

  /** Closes a window the user decided not to sign. */
  cancel(id: string): void { this.intents.delete(id); }

  setSig(id: string, sig: string): void { this.get(id).sig = sig; }

  setPayout(id: string, payout: string): void {
    const i = this.get(id);
    if (!i.stake) throw new MoopayError("INVALID_INPUT", "this payment does not stake anything");
    if (i.stake.payout === payout) return;
    if (i.payer) throw new MoopayError("INVALID_INPUT", "the payout wallet can't change once the payment has started");
    i.stake.payout = payout;
  }

  private sweep(): void {
    const cutoff = this.now() - TTL_MS;
    for (const [k, v] of this.intents) if (v.createdAt < cutoff) this.intents.delete(k);
  }
}

/** "2.5" -> 2500000n for 6 decimals. Strings only: JS numbers never carry money. */
export function parseDecimal(value: string, decimals: number): bigint {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!m) throw new MoopayError("INVALID_INPUT", "payAmount must be a decimal string like \"2\" or \"2.5\"");
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new MoopayError("INVALID_INPUT", `payAmount has more than ${decimals} decimal places`);
  const out = BigInt(m[1]! + frac.padEnd(decimals, "0"));
  if (out <= 0n) throw new MoopayError("INVALID_INPUT", "payAmount must be > 0");
  return out;
}

/** Valid NEAR account id: named (a.b.near) or 64-hex implicit. */
export const isNearAccountId = (s: string): boolean =>
  s.length >= 2 && s.length <= 64 && (/^[0-9a-f]{64}$/.test(s) || /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s));

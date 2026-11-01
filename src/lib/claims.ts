import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { deriveNoteAccount } from "./crypto.js";
import { MoopayError } from "./errors.js";
import type { NearOps } from "./origin.js";
import { isNearAccountId, parseDecimal } from "./pay.js";
import { isClaimChain, validAddress, verifyWalletSignature } from "./sign.js";

/*
 * Private claim links. The sender funds a per-claim NEAR account from their own wallet; the receiver
 * proves they own the wallet the sender named (NEP-413 signature) and the funds move to that wallet.
 * Unclaimed after 24h, the funds go back to the sender.
 *
 * TRUST NOTE: the claim account's key is derived from a seed kept by THIS server (HMAC of the claim id),
 * so the server operator can move these funds during the window. The code only ever sends to the named
 * receiver (claim) or to the sender (refund). A smart-contract escrow would remove this trust; see README.
 */

export const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
const FUND_WINDOW_MS = 30 * 60 * 1000;
export const GAS_NEAR = 30_000_000_000_000_000_000_000n; // 0.03 NEAR
const MIN_GAS_NEAR = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
const STORAGE_FEE = 1_250_000_000_000_000_000_000n;
const NATIVE_BUFFER = 2_000_000_000_000_000_000_000n; // 0.002 NEAR left over to pay the claim's gas

export type ClaimState = "AWAITING_FUNDING" | "FUNDED" | "CLAIMING" | "CLAIMED" | "REFUNDED" | "CANCELLED";

export interface PayToken { assetId: string; symbol: string; decimals: number; contract: string; native?: boolean; priceUsd?: number }

interface Claim {
  fundKey: string;
  claimKey: string;
  receiver: string;
  /** Where the receiver's wallet lives. Default "near"; "sol" and EVM chains are paid out through 1Click when claimed. */
  chain?: string;
  sender?: string;
  token: PayToken;
  amount: string; // smallest units
  amountText: string; // dollars as typed, e.g. "0.2"
  /** What people read, e.g. "0.2 USDC" or "0.043 NEAR". */
  display?: string;
  noteAccountId: string;
  state: ClaimState;
  createdAt: number;
  fundedAt?: number;
  expiresAt?: number;
  nonce?: string;
  claimTx?: string;
  refundTx?: string;
  deliverTo?: string;
}

export interface ClaimDeps {
  near: NearOps;
  tokens: () => Promise<PayToken[]>;
  /** Dollar text -> smallest units of `token`. */
  units: (amountText: string, token: PayToken) => bigint;
  /** Pays a claim out on another chain: moves the claim account's USDC into a 1Click swap that lands at `receiver`. */
  swapOut?: (p: { accountId: string; secretKey: string; token: PayToken; amount: bigint; chain: string; receiver: string; refundTo: string }) => Promise<{ txHash: string; depositAddress: string }>;
  file: string;
  now?: () => number;
}

const label = (c: Claim) => c.display ?? `${c.amountText} ${c.token.symbol}`;

function fmtUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, 6);
  return `${s.slice(0, s.length - decimals)}${frac ? "." + frac : ""}`;
}

const d_units = (d: ClaimDeps, text: string, token: PayToken) => d.units(text, token);

export class ClaimDesk {
  private claims: Claim[] = [];
  private readonly seed: Buffer;
  private readonly now: () => number;

  constructor(private readonly d: ClaimDeps) {
    this.now = d.now ?? Date.now;
    if (existsSync(d.file)) this.claims = (JSON.parse(readFileSync(d.file, "utf8")) as { claims: Claim[] }).claims ?? [];
    const seedFile = `${d.file}.seed`;
    if (existsSync(seedFile)) this.seed = Buffer.from(readFileSync(seedFile, "utf8").trim(), "hex");
    else {
      this.seed = randomBytes(32);
      writeFileSync(seedFile, this.seed.toString("hex"), { mode: 0o600 });
    }
  }

  private save(): void {
    const tmp = `${this.d.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ claims: this.claims }), { mode: 0o600 });
    renameSync(tmp, this.d.file);
  }

  private noteKey(c: Claim) {
    return deriveNoteAccount(createHmac("sha256", this.seed).update(`moopay.claim|${c.claimKey}`).digest());
  }

  private byFund(key: string): Claim {
    const c = this.claims.find((x) => x.fundKey === key);
    if (!c) throw new MoopayError("NOTE_NOT_FOUND", "this link is not valid or has expired");
    return c;
  }
  private byClaim(key: string): Claim {
    const c = this.claims.find((x) => x.claimKey === key);
    if (!c) throw new MoopayError("NOTE_NOT_FOUND", "this claim link is not valid");
    return c;
  }

  async create(p: { amount: string; receiver: string; symbol?: string; chain?: string }) {
    const chain = (p.chain ?? "near").toLowerCase();
    if (!isClaimChain(chain)) throw new MoopayError("INVALID_INPUT", "private claims can go to a NEAR, Solana or EVM-chain wallet (eth, base, arb, op, pol, bsc, avax, gnosis, monad, xlayer)");
    if (chain === "near" ? !isNearAccountId(p.receiver) : !validAddress(chain, p.receiver)) throw new MoopayError("BAD_RECIPIENT", chain === "near" ? "receiver must be a NEAR wallet address, like alice.near" : `that is not a valid ${chain.toUpperCase()} wallet address`);
    if (chain !== "near" && (p.symbol ?? "USDC") !== "USDC") throw new MoopayError("INVALID_INPUT", "claims to other chains are paid in USDC");
    const tokens = await this.d.tokens();
    const token = tokens.find((t) => t.symbol === (p.symbol ?? "USDC"));
    if (!token) throw new MoopayError("UNKNOWN_ASSET", `${p.symbol ?? "USDC"} is not available for claim links right now`);
    const amount = token.native ? d_units(this.d, p.amount, token) : parseDecimal(p.amount, token.decimals);
    const claimKey = randomBytes(18).toString("base64url");
    const c: Claim = {
      fundKey: randomBytes(12).toString("base64url"), claimKey, receiver: p.receiver, ...(chain !== "near" ? { chain } : {}), token,
      amount: amount.toString(), amountText: p.amount, display: token.native ? `${fmtUnits(amount, token.decimals)} NEAR` : `${p.amount} ${token.symbol}`, noteAccountId: "", state: "AWAITING_FUNDING", createdAt: this.now(),
    };
    c.noteAccountId = this.noteKey(c).accountId;
    this.claims.push(c);
    this.save();
    return c;
  }

  fundView(key: string) {
    const c = this.byFund(key);
    return { amount: label(c), symbol: c.token.symbol, receiver: c.receiver, chain: c.chain ?? "near", state: c.state };
  }

  /** The sender picked a wallet: remember it as the refund address and describe what to sign. */
  async fundPlan(key: string, sender: string) {
    const c = this.byFund(key);
    if (c.state !== "AWAITING_FUNDING") throw new MoopayError("NOTE_NOT_FOUND", "this payment was already funded");
    if (this.now() - c.createdAt > FUND_WINDOW_MS) throw new MoopayError("NOTE_EXPIRED", "this link expired; ask for a new one");
    if (!isNearAccountId(sender)) throw new MoopayError("INVALID_INPUT", "sender must be a NEAR account");
    c.sender = sender;
    this.save();
    if (c.token.native) return { noteAccountId: c.noteAccountId, gasNear: BigInt(c.amount) + NATIVE_BUFFER };
    return {
      noteAccountId: c.noteAccountId,
      gasNear: GAS_NEAR,
      token: { contract: c.token.contract, amount: BigInt(c.amount), needsRegistration: !(await this.d.near.storageRegistered(c.token.contract, c.noteAccountId)) },
    };
  }

  /** Looks at the chain; marks the claim funded and starts the 24h window once the money is there. */
  async fundStatus(key: string, origin: string) {
    const c = this.byFund(key);
    await this.refresh(c);
    return {
      state: c.state,
      ...(c.state !== "AWAITING_FUNDING" && c.state !== "CANCELLED" ? { claimLink: `${origin}/c/${c.claimKey}` } : {}),
      ...(c.expiresAt ? { expiresAt: new Date(c.expiresAt).toISOString() } : {}),
      receiver: c.receiver, amount: label(c), symbol: c.token.symbol,
      ...(c.claimTx ? { claimTx: c.claimTx } : {}), ...(c.refundTx ? { refundTx: c.refundTx } : {}),
    };
  }

  private async refresh(c: Claim): Promise<void> {
    if (c.state === "AWAITING_FUNDING") {
      if (this.now() - c.createdAt > FUND_WINDOW_MS + CLAIM_WINDOW_MS && !c.sender) { c.state = "CANCELLED"; this.save(); return; }
      const near = await this.d.near.nearBalance(c.noteAccountId);
      const funded = c.token.native
        ? near >= BigInt(c.amount) + NATIVE_BUFFER
        : (await this.d.near.ftBalance(c.token.contract, c.noteAccountId)) >= BigInt(c.amount) && near >= MIN_GAS_NEAR;
      if (funded) {
        c.state = "FUNDED"; c.fundedAt = this.now(); c.expiresAt = c.fundedAt + CLAIM_WINDOW_MS; this.save();
      }
    }
    if (c.state === "CLAIMING") {
      // A timed-out transfer: if the tokens left the account, it went through.
      const left = c.token.native ? await this.d.near.nearBalance(c.noteAccountId) : await this.d.near.ftBalance(c.token.contract, c.noteAccountId);
      if (left < (c.token.native ? BigInt(c.amount) + NATIVE_BUFFER / 2n : BigInt(c.amount))) c.state = "CLAIMED";
      else c.state = "FUNDED";
      this.save();
    }
    if (c.state === "FUNDED" && c.expiresAt && this.now() > c.expiresAt) await this.refund(c);
  }

  private payOut(c: Claim, to: string) {
    const k = this.noteKey(c);
    return c.token.native
      ? this.d.near.sendNear({ accountId: k.accountId, secretKey: k.secretKey, to, amount: BigInt(c.amount) })
      : this.d.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: c.token.contract, to, amount: BigInt(c.amount) });
  }

  private async refund(c: Claim): Promise<void> {
    if (!c.sender) return;
    c.state = "CLAIMING"; this.save();
    try {
      const r = await this.payOut(c, c.sender);
      c.state = "REFUNDED"; c.refundTx = r.txHash;
    } catch (e) {
      c.state = "FUNDED"; // try again on the next sweep
      if (!(e instanceof MoopayError)) throw e;
    }
    this.save();
  }

  /** Timer hook: refund everything whose window ran out. */
  async sweep(): Promise<number> {
    let n = 0;
    for (const c of this.claims.filter((x) => x.state === "FUNDED" || x.state === "CLAIMING")) {
      const before = c.state;
      await this.refresh(c).catch(() => undefined);
      if (before !== c.state && c.state === "REFUNDED") n++;
    }
    return n;
  }

  async claimView(key: string) {
    const c = this.byClaim(key);
    await this.refresh(c).catch(() => undefined);
    return {
      state: c.state === "AWAITING_FUNDING" ? "NOT_READY" : c.state,
      amount: label(c), symbol: c.token.symbol, receiver: c.receiver, chain: c.chain ?? "near", sender: c.sender,
      ...(c.expiresAt ? { expiresAt: new Date(c.expiresAt).toISOString() } : {}),
      ...(c.claimTx ? { claimTx: c.claimTx } : {}),
    };
  }

  /** What the receiver signs. On NEAR the nonce travels separately (NEP-413); elsewhere it is part of the text. */
  private message(c: Claim): string {
    const base = `Claim ${label(c)} from MooPay (${c.claimKey.slice(0, 6)})`;
    return !c.chain || c.chain === "near" ? base : `${base}\nNonce: ${c.nonce}`;
  }

  challenge(key: string) {
    const c = this.byClaim(key);
    c.nonce = randomBytes(32).toString("base64");
    this.save();
    return { message: this.message(c), recipient: "moopay", nonce: c.nonce, chain: c.chain ?? "near" };
  }

  /** Receiver signs with their own wallet (NEP-413). Only the wallet the sender named can claim. */
  async claim(key: string, proof: { accountId: string; publicKey?: string; signature: string }) {
    const c = this.byClaim(key);
    await this.refresh(c);
    if (c.state === "CLAIMED") throw new MoopayError("NOTE_ALREADY_CLAIMED", "this was already claimed");
    if (c.state !== "FUNDED") throw new MoopayError("NOTE_NOT_FUNDED", c.state === "REFUNDED" ? "this expired and was returned to the sender" : "this is not ready to claim yet");
    if (c.expiresAt && this.now() > c.expiresAt) throw new MoopayError("NOTE_EXPIRED", "this claim window has ended");
    const other = c.chain && c.chain !== "near";
    if (other ? proof.accountId.toLowerCase() !== c.receiver.toLowerCase() : proof.accountId !== c.receiver) throw new MoopayError("BAD_RECIPIENT", `only ${c.receiver} can claim this`);
    if (!c.nonce) throw new MoopayError("INVALID_INPUT", "ask for a challenge first");
    const message = this.message(c);
    const nonce = Buffer.from(c.nonce, "base64");
    c.nonce = undefined; // one use
    if (other) verifyWalletSignature(c.chain!, c.receiver, message, proof.signature);
    else {
      if (!proof.publicKey) throw new MoopayError("INVALID_INPUT", "publicKey is required");
      await this.d.near.verifyOwner({ accountId: c.receiver, publicKey: proof.publicKey, signature: Buffer.from(proof.signature, "base64"), payload: { message, recipient: "moopay", nonce } });
    }
    c.state = "CLAIMING"; this.save();
    try {
      let r: { txHash: string };
      if (other) {
        if (!this.d.swapOut || !c.sender) throw new MoopayError("INTERNAL", "this claim cannot be paid out to another chain");
        const k = this.noteKey(c);
        const out = await this.d.swapOut({ accountId: k.accountId, secretKey: k.secretKey, token: c.token, amount: BigInt(c.amount), chain: c.chain!, receiver: c.receiver, refundTo: c.sender });
        r = out; c.deliverTo = out.depositAddress;
      } else r = await this.payOut(c, c.receiver);
      c.state = "CLAIMED"; c.claimTx = r.txHash; this.save();
      return { state: c.state, claimTx: r.txHash, amount: label(c), symbol: c.token.symbol, chain: c.chain ?? "near" };
    } catch (e) {
      c.state = "FUNDED"; this.save();
      throw e;
    }
  }
}

export { STORAGE_FEE as CLAIM_STORAGE_FEE };

import { MoopayError } from "../../src/util/errors.js";
import { Stats } from "../../src/storage/stats.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OneClick, QuoteRequest, Token } from "../../src/agent/intents/oneclick.js";
import type { NearOps } from "../../src/agent/chains/near.js";
import { MooPayService } from "../../src/agent/service.js";
import { Ledger } from "../../src/storage/ledger.js";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const ETH_USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
export const ETH_ADDR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

export const TOKENS: Token[] = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 5, contractAddress: "wrap.near" },
  { assetId: USDC, decimals: 6, blockchain: "near", symbol: "USDC", contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
  { assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", price: 100 },
  { assetId: ETH_USDC, decimals: 6, blockchain: "eth", symbol: "USDC", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
];

export class FakeOneClick {
  authenticated = true;
  quotes: QuoteRequest[] = [];
  submits: { depositAddress: string; txHash: string }[] = [];
  statuses = new Map<string, string>();
  failNextQuote = false;
  private n = 0;
  async tokens() { return TOKENS; }
  async findToken(id: string) { return TOKENS.find((t) => t.assetId === id); }
  async quote(req: QuoteRequest) {
    this.quotes.push(req);
    if (this.failNextQuote) { this.failNextQuote = false; throw new (await import("../../src/util/errors.js")).MoopayError("QUOTE_FAILED", "nope"); }
    return {
      quote: {
        ...(req.dry ? {} : { depositAddress: `dep-${++this.n}` }),
        amountIn: req.swapType === "EXACT_OUTPUT" ? String((BigInt(req.amount) * 101n) / 100n) : req.amount, amountOut: "99000", minAmountOut: "98000",
        amountInUsd: "0.10", amountOutUsd: "0.099", deadline: req.deadline,
      },
    };
  }
  async submitDeposit(depositAddress: string, txHash: string) { this.submits.push({ depositAddress, txHash }); return { status: "KNOWN_DEPOSIT_TX" }; }
  async status(addr: string) { return { status: this.statuses.get(addr) ?? "PENDING_DEPOSIT" }; }
}

export class FakeNear {
  tokenBalances = new Map<string, bigint>();
  nearBalances = new Map<string, bigint>();
  transfers: { accountId: string; secretKey: string; tokenContract: string; to: string; amount: bigint }[] = [];
  failTransfer: (() => Error) | undefined;
  /** Balances of tokens other than USDC (wNEAR, rNEAR...), keyed "contract|account". USDC lives in tokenBalances. */
  otherTokens = new Map<string, bigint>();
  async ftBalance(t: string, a: string) { return ["wrap.near", "lst.rhealab.near", "usdt.tether-token.near"].includes(t) ? this.otherTokens.get(`${t}|${a}`) ?? 0n : this.tokenBalances.get(a) ?? 0n; }
  /** Transactions a payer's wallet "signed", by hash, for the straight-transfer checks. */
  txs = new Map<string, { ok: boolean; receiver: string; actions: Record<string, unknown>[] }>();
  async txStatus(hash: string) { return this.txs.get(hash) ?? null; }
  registered = new Set<string>();
  async storageRegistered(_t: string, a: string) { return this.registered.has(a); }
  async nearBalance(a: string) { return this.nearBalances.get(a) ?? 0n; }
  /** Named accounts a test wants to look like they were never created. */
  missing = new Set<string>();
  async exists(a: string) { return !this.missing.has(a); }
  badSigner = false;
  async verifyOwner() { if (this.badSigner) throw new MoopayError("BAD_RECIPIENT", "the wallet signature did not check out"); }
  calls: { contractId: string; method: string; args: Record<string, unknown>; deposit: bigint; gas: bigint }[] = [];
  views = new Map<string, unknown>();
  /** Lets a test react to a contract call, e.g. to move fake balances like the chain would. */
  onCall: ((c: FakeNear["calls"][number], who: string) => void) | undefined;
  async call(p: FakeNear["calls"][number] & { accountId: string }) { this.calls.push(p); this.onCall?.(p, p.accountId); return { txHash: `call-${this.calls.length}` }; }
  async view(contractId: string, method: string, args?: { account_id?: string }) { return this.views.get(`${contractId}.${method}.${args?.account_id}`) ?? this.views.get(`${contractId}.${method}`) ?? null; }
  wraps: bigint[] = [];
  async wrapNear(p: { accountId: string; amount: bigint }) { this.wraps.push(p.amount); return { txHash: `wrap-${this.wraps.length}` }; }
  created: { parentId: string; newId: string; deposit: bigint }[] = [];
  async createAccount(p: { parentId: string; newId: string; deposit: bigint }) {
    this.created.push({ parentId: p.parentId, newId: p.newId, deposit: p.deposit });
    this.nearBalances.set(p.newId, p.deposit);
    return { txHash: `create-${this.created.length}` };
  }
  async sendNear(p: { accountId: string; to: string; amount: bigint }) {
    this.transfers.push({ ...p, secretKey: "", tokenContract: "NEAR" });
    return { txHash: `tx-${this.transfers.length}` };
  }
  async transferFromNote(p: FakeNear["transfers"][number]) {
    if (this.failTransfer) throw this.failTransfer();
    this.transfers.push(p);
    return { txHash: `tx-${this.transfers.length}` };
  }
  fund(accountId: string, tokens: bigint, near = 20_000_000_000_000_000_000_000n) {
    this.tokenBalances.set(accountId, tokens);
    this.nearBalances.set(accountId, near);
  }
}

export async function setup(opts: { now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "moopay-test-"));
  const ledger = await Ledger.open(join(dir, "state.json"));
  const oc = new FakeOneClick();
  const near = new FakeNear();
  const service = new MooPayService({
    ledger, oneClick: oc as unknown as OneClick, near: near as unknown as NearOps, confidentiality: "basic", stats: await Stats.open(join(dir, "stats.json")),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { dir, ledger, oc, near, service, transfers: near.transfers };
}

/** Mint, then fund the per-note account on the fake chain. */
export async function mintFunded(ctx: Awaited<ReturnType<typeof setup>>, amount = "1000000") {
  const minted = await ctx.service.mint({ assetId: USDC, amount });
  ctx.near.fund(minted.escrow.address, BigInt(amount));
  return minted;
}

export const routeArgs = (secretKeyString: string, over: Record<string, unknown> = {}) => ({
  secretKeyString, destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: ETH_ADDR, dryRun: false, ...over,
});

/** A stand-in for OutLayer's private route: a balance the test fills by hand, and a payout whose ending the test picks. */
export class FakeOutLayer {
  registered = 0;
  deposits: { chain: string; token?: string; amount: string }[] = [];
  withdraws: { body: { chain: string; to: string; amount: string; token: string }; idem: string }[] = [];
  /** The private balance by token; `confidential` is the USDC part. */
  balances = new Map<string, bigint>();
  get confidential() { return this.balances.get(USDC) ?? 0n; }
  set confidential(v: bigint) { this.balances.set(USDC, v); }
  swaps: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }[] = [];
  failDeposit = false;
  requestStatus = "success";
  async register() { this.registered++; return { api_key: "wk_fake", near_account_id: "f".repeat(64) }; }
  async depositAddress(_k: string, p: { chain: string; token?: string; amount: string }) {
    if (this.failDeposit) throw new (await import("../../src/agent/outlayer.js")).OutLayerError(503, "confidential_unavailable", "off");
    this.deposits.push(p);
    return { intent_id: "i1", deposit_address: "a".repeat(64), amount: p.amount };
  }
  async balance(_k: string, token?: string) { return { balance: (this.balances.get(token ?? USDC) ?? 0n).toString() }; }
  async swap(_k: string, body: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }) { this.swaps.push(body); return { request_id: `swap-${this.swaps.length}`, status: "pending_deposit" }; }
  async withdraw(_k: string, body: { chain: string; to: string; amount: string; token: string }, idem: string) { this.withdraws.push({ body, idem }); return { request_id: `req-${this.withdraws.length}`, status: "pending_deposit" }; }
  async request() { return { status: this.requestStatus, result: { swap_details: { destinationChainTxHashes: ["txdest"] } } }; }
}

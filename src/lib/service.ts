import { z } from "zod";
import { assertRecipient } from "./addresses.js";
import type { Confidentiality } from "./config.js";
import {
  claimBinding,
  commitmentOf,
  deriveNoteAccount,
  formatSecret,
  generateSecret,
  hashMemo,
  nullifierHashOf,
  parseSecret,
} from "./crypto.js";
import { MoopayError } from "./errors.js";
import { isNearAccountId, parseDecimal, PayHub, type PayIntent } from "./pay.js";
import type { OneClick, QuoteRequest, Token } from "./oneclick.js";
import type { NearOps } from "./origin.js";
import { Stats } from "./stats.js";
import type { ClaimDesk } from "./claims.js";
import { Ledger, type Note } from "./state.js";

/* ---------- input schemas (the shapes are registered with the MCP SDK; strict parsing happens here) ---------- */

const AMOUNT_RE = /^[1-9][0-9]*$/;
const amountField = z
  .string()
  .regex(AMOUNT_RE, "amount must be a positive integer string in smallest units")
  .describe("Amount in the asset's smallest unit, as a decimal string (never a JSON number)");

export const mintShape = {
  receiver: z.string().min(2).max(64).optional().describe("LINK mode (easiest): the receiver's NEAR wallet, e.g. alice.near. Only that wallet can claim."),
  payAmount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/).optional().describe("LINK mode: dollar amount to send, e.g. \"5\" for $5. Paid in USDC by default."),
  symbol: z.enum(["USDC", "USDT", "NEAR"]).optional().describe("LINK mode: what to send, default USDC. NEAR sends plain NEAR (payAmount is still dollars)."),
  assetId: z.string().min(1).max(256).optional().describe("ADVANCED mode only: 1Click assetId of a NEAR-chain NEP-141 token"),
  amount: amountField.optional(),
  memo: z.string().max(64).optional().describe("Optional note label (<= 64 chars). Stored hashed only."),
};

export const routeShape = {
  secretKeyString: z
    .string()
    .optional()
    .describe("CLAIM mode: the moopay1_… secret from mint_private_claim_deposit. Omit for DIRECT mode."),
  originAssetId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("DIRECT mode: 1Click assetId the sender pays with (any chain). CLAIM mode: only needed if this machine did not mint the note."),
  amount: amountField.optional().describe("DIRECT mode only: amount the sender pays, smallest unit, decimal string"),
  payAmount: z
    .string()
    .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, "payAmount must be a decimal string like \"2\" or \"2.5\"")
    .optional()
    .describe("PAY-LINK mode (easiest): dollar value to send, e.g. \"2.5\" for about $2.50. The user picks USDC, USDT or NEAR on the link page and signs with their wallet (NEAR is converted at 1Click's price)."),
  refundTo: z.string().min(1).max(128).optional().describe("DIRECT mode only: sender address on the origin chain, used if the swap is refunded"),
  destinationChain: z.enum(["btc", "sol", "eth"]).describe("Chain that receives the funds"),
  destinationAssetId: z.string().min(1).max(256).describe("1Click assetId on the destination chain"),
  recipient: z.string().min(1).max(128).describe("Address on destinationChain (BTC bech32/base58, SOL base58, ETH 0x + EIP-55)"),
  slippageBps: z.number().int().min(0).max(500).default(100).describe("Max slippage in basis points (default 100, max 500)"),
  dryRun: z.boolean().default(true).describe("true (default): quote only, no state change. false: execute."),
};

export const mintSchema = z.object(mintShape).strict().superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (v.receiver !== undefined) {
    if (v.payAmount === undefined) issue("payAmount", "required with receiver");
    if (v.assetId !== undefined || v.amount !== undefined) issue("assetId", "not allowed in LINK mode");
  } else {
    if (v.assetId === undefined) issue("assetId", "required (or use receiver + payAmount)");
    if (v.amount === undefined) issue("amount", "required (or use receiver + payAmount)");
    if (v.payAmount !== undefined || v.symbol !== undefined) issue("payAmount", "needs receiver");
  }
});
export const routeSchema = z
  .object(routeShape)
  .strict()
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.secretKeyString !== undefined) {
      if (v.amount !== undefined) issue("amount", "not allowed in CLAIM mode (the note's amount is used)");
      if (v.refundTo !== undefined) issue("refundTo", "not allowed in CLAIM mode (refunds return to the note account)");
      if (v.payAmount !== undefined) issue("payAmount", "not allowed in CLAIM mode");
    } else if (v.payAmount !== undefined) {
      if (v.amount !== undefined) issue("amount", "not allowed in PAY-LINK mode (use payAmount)");
      if (v.refundTo !== undefined) issue("refundTo", "not allowed in PAY-LINK mode (the wallet the user connects is used)");
      if (v.originAssetId !== undefined) issue("originAssetId", "not allowed in PAY-LINK mode (the user picks the asset)");
    } else {
      if (!v.originAssetId) issue("originAssetId", "required in DIRECT mode (no secretKeyString or payAmount)");
      if (!v.amount) issue("amount", "required in DIRECT mode (no secretKeyString)");
      if (!v.refundTo) issue("refundTo", "required in DIRECT mode (no secretKeyString)");
    }
  });
export type MintInput = z.input<typeof mintSchema>;
export type RouteInput = z.input<typeof routeSchema>;

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    // Issue paths and messages only; never the offending values (they may be the secret).
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new MoopayError("INVALID_INPUT", msg);
  }
  return r.data;
}

/* ---------- service ---------- */

const QUOTE_TTL_MS = 5 * 60 * 1000; // spec: deadline <= 10 min
/** Native NEAR a note account must hold to sign: storage registration (0.00125) + two 30 Tgas calls, with margin. */
export const MIN_NOTE_NEAR = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
export const RECOMMENDED_NOTE_NEAR = "0.02";

export interface ServiceDeps {
  ledger: Ledger;
  oneClick: OneClick;
  near: NearOps;
  confidentiality: Confidentiality;
  stats?: Stats;
  claims?: ClaimDesk;
  now?: () => number;
}

/** Where pay links point; only available when running behind the HTTP entry. */
export interface RouteContext {
  payLinkPrefix?: string;
  /** https://host of this server, for claim links. */
  origin?: string;
}

/** Stablecoins the pay page offers (NEAR-chain NEP-141 assets a NEAR wallet can sign for). */
const PAY_SYMBOLS = ["USDC", "USDT"];
const NATIVE_NEAR_ASSET = "nep141:wrap.near";
const STORAGE_FEE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR

interface PayAsset { assetId: string; symbol: string; decimals: number; contract: string; native: boolean; priceUsd?: number }

/** payAmount is a dollar value. Stablecoins are 1:1; NEAR is converted at 1Click's price, rounded up so the recipient is not short. */
function payUnits(payAmount: string, asset: PayAsset): bigint {
  if (!asset.native) return parseDecimal(payAmount, asset.decimals);
  const usdMicro = parseDecimal(payAmount, 6);
  const priceMicro = BigInt(Math.round((asset.priceUsd ?? 0) * 1e6));
  if (priceMicro <= 0n) throw new MoopayError("QUOTE_FAILED", "no price available for NEAR right now");
  const num = usdMicro * 10n ** BigInt(asset.decimals);
  return (num + priceMicro - 1n) / priceMicro;
}

export class MooPayService {
  private readonly now: () => number;
  private readonly pay: PayHub;
  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? Date.now;
    this.pay = new PayHub(this.now);
  }

  /* ----- Tool 1: claim-link note. Funds are held by a per-note NEAR account, never by MooPay. ----- */
  async mint(rawInput: unknown, ctx: RouteContext = {}) {
    const input = parseInput(mintSchema, rawInput);
    if (input.receiver !== undefined) return this.createClaimLink(input as { receiver: string; payAmount: string; symbol?: "USDC" | "USDT" | "NEAR" }, ctx);
    const amount = BigInt(input.amount!);
    if (amount <= 0n) throw new MoopayError("INVALID_INPUT", "amount must be > 0");

    const token = await this.d.oneClick.findToken(input.assetId!);
    if (!token) throw new MoopayError("UNKNOWN_ASSET", "assetId is not listed by 1Click /v0/tokens");
    if (token.blockchain !== "near" || !token.contractAddress)
      throw new MoopayError("INVALID_INPUT", "claim notes hold NEAR-chain NEP-141 assets only (blockchain \"near\"); use DIRECT mode of route_cross_chain_intent for other origin chains");

    const secret = generateSecret();
    const commitment = commitmentOf(secret);
    const nullifierHash = nullifierHashOf(secret);
    const account = deriveNoteAccount(secret);

    const iso = new Date(this.now()).toISOString();
    const note: Note = {
      commitment,
      nullifierHash,
      assetId: input.assetId!,
      amount,
      noteAccountId: account.accountId,
      status: "MINTED",
      createdAt: iso,
      updatedAt: iso,
      ...(input.memo !== undefined ? { memoHash: hashMemo(input.memo) } : {}),
    };
    // The journal is a local convenience (status, double-claim guard); the funds and their spend authority are on-chain.
    await this.d.ledger.insert(note);

    return {
      secretKeyString: formatSecret(secret),
      commitment,
      escrow: {
        address: account.accountId,
        assetId: input.assetId!,
        amount,
        custody: "per-note NEAR account controlled by whoever holds the secret; MooPay holds no key and no funds",
      },
      fundingSteps: [
        { step: 1, action: "NEAR transfer", to: account.accountId, amount: `${RECOMMENDED_NOTE_NEAR} NEAR`, why: "creates the account and pays its gas" },
        { step: 2, action: "storage_deposit", contract: token.contractAddress, args: { account_id: account.accountId, registration_only: true }, deposit: "0.00125 NEAR", why: "NEP-145 registration so the account can hold the token" },
        { step: 3, action: "ft_transfer", contract: token.contractAddress, args: { receiver_id: account.accountId, amount: amount.toString() }, deposit: "1 yoctoNEAR" },
      ],
      status: note.status,
      trackWith: { resource: `moopay://note/${commitment}` },
      warnings: [
        "The secret is shown once. It is not stored and cannot be recovered; whoever holds it controls the funds.",
        "Funding is verified on-chain (token balance and NEAR for gas), not trusted from the caller.",
        "Do all three funding steps. Without step 2 the token transfer fails; without step 1 the note cannot sign its claim.",
        "Until claimed, the sender can sweep the note account back to their own wallet using the same secret.",
        "This is a hash-lock/paper-wallet, not a zero-knowledge proof. Unlinkability depends on the 1Click flow used, not on SHA256.",
      ],
    };
  }

  /* ----- Claim links: sender funds on a page, receiver claims with their own wallet ----- */
  private get desk(): ClaimDesk {
    if (!this.d.claims) throw new MoopayError("INVALID_INPUT", "claim links need the HTTP mode (npm run start:http behind an HTTPS tunnel)");
    return this.d.claims;
  }
  private async createClaimLink(input: { receiver: string; payAmount: string; symbol?: "USDC" | "USDT" | "NEAR" }, ctx: RouteContext) {
    if (!ctx.origin) throw new MoopayError("INVALID_INPUT", "claim links need the HTTP mode (npm run start:http behind an HTTPS tunnel)");
    const c = await this.desk.create({ amount: input.payAmount, receiver: input.receiver, ...(input.symbol ? { symbol: input.symbol } : {}) });
    return {
      mode: "claim-link" as const,
      fundLink: `${ctx.origin}/f/${c.fundKey}`,
      summary: `Send ${c.display} privately to ${c.receiver}. Only that wallet can claim it, within 24 hours after you fund it. Otherwise it comes back to you.`,
      instructions: "Give the user fundLink. They open it, press Send and sign in their wallet. When they are done, call check_claim with fundLink: once funded it returns a claimLink that the user shares with the receiver. Do not invent or guess a claimLink.",
    };
  }
  /** Dollar amount -> token units for a claim (NEAR converted at 1Click's price). */
  claimUnits(amountText: string, asset: PayAsset): bigint { return payUnits(amountText, asset); }

  /** Pays a claim to a wallet on another chain: the claim account's USDC goes into a 1Click swap that lands at the receiver. */
  async claimSwapOut(p: { accountId: string; secretKey: string; token: { assetId: string; contract: string }; amount: bigint; chain: string; receiver: string; refundTo: string }) {
    const dest = (await this.d.oneClick.tokens()).find((t) => t.blockchain === p.chain && t.symbol === "USDC");
    if (!dest) throw new MoopayError("UNKNOWN_ASSET", `USDC is not available on ${p.chain.toUpperCase()} right now`);
    const q = (await this.d.oneClick.quote({
      dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: p.token.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: dest.assetId, amount: p.amount.toString(),
      recipient: p.receiver, recipientType: "DESTINATION_CHAIN", refundTo: p.refundTo, refundType: "ORIGIN_CHAIN", deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    })).quote;
    if (!q.depositAddress) throw new MoopayError("QUOTE_FAILED", "1Click returned no deposit address");
    const r = await this.d.near.transferFromNote({ accountId: p.accountId, secretKey: p.secretKey, tokenContract: p.token.contract, to: q.depositAddress, amount: p.amount });
    await this.d.oneClick.submitDeposit(q.depositAddress, r.txHash).catch(() => undefined);
    return { txHash: r.txHash, depositAddress: q.depositAddress };
  }
  async claimFundStatus(fundLink: string, ctx: RouteContext) {
    const key = fundLink.split("?")[0]!.split("/").filter(Boolean).pop() ?? "";
    return this.desk.fundStatus(key, ctx.origin ?? "");
  }
  claimFundView(key: string) { return this.desk.fundView(key); }
  claimFundPlan(key: string, sender: string) { return this.desk.fundPlan(key, sender); }
  claimFundState(key: string, origin: string) { return this.desk.fundStatus(key, origin); }
  claimView(key: string) { return this.desk.claimView(key); }
  claimChallenge(key: string) { return this.desk.challenge(key); }
  claimNow(key: string, proof: { accountId: string; publicKey?: string; signature: string }) { return this.desk.claim(key, proof); }
  claimSweep() { return this.d.claims ? this.d.claims.sweep() : Promise.resolve(0); }

  /* ----- Tool 2: DIRECT (no secret) or CLAIM (secret) ----- */
  async route(rawInput: unknown, ctx: RouteContext = {}) {
    const input = parseInput(routeSchema, rawInput);
    assertRecipient(input.destinationChain, input.recipient);

    const destToken = await this.d.oneClick.findToken(input.destinationAssetId);
    if (!destToken) throw new MoopayError("UNKNOWN_ASSET", "destinationAssetId is not listed by 1Click /v0/tokens");
    if (destToken.blockchain !== input.destinationChain)
      throw new MoopayError("INVALID_INPUT", `destinationAssetId lives on "${destToken.blockchain}", not "${input.destinationChain}"`);

    if (input.secretKeyString !== undefined) return this.routeClaim(input as ClaimInput);
    if (input.payAmount !== undefined) return this.routePayLink(input as PayLinkInput, ctx);
    return this.withPayLink(await this.routeDirect(input as DirectInput), input as DirectInput, ctx);
  }

  /** Chats with a cached (older) tool list still call DIRECT. When the HTTP mode is up, add a pay link for the same payment so they can use the wallet popup. */
  private withPayLink<T extends object>(res: T, input: DirectInput, ctx: RouteContext): T {
    const r = res as { dryRun?: boolean; fees?: { amountInUsd?: unknown }; pay?: { chain?: string } };
    // The pay page only knows NEAR wallets; other origin chains keep the plain deposit address.
    if (!ctx.payLinkPrefix || r.dryRun !== false || r.pay?.chain !== "near") return res;
    const dollars = Number(r.fees?.amountInUsd);
    if (!Number.isFinite(dollars) || dollars <= 0) return res;
    const intent = this.pay.create({
      destinationChain: input.destinationChain,
      destinationAssetId: input.destinationAssetId,
      recipient: input.recipient,
      payAmount: dollars.toFixed(2) === "0.00" ? "0.01" : dollars.toFixed(2),
      slippageBps: input.slippageBps,
    });
    const { depositAddress, depositMemo, pay, quoteExpiresAt, trackWith, status, warnings: _w, ...rest } = res as Record<string, unknown>;
    return {
      mode: "pay-link" as const,
      payLink: `${ctx.payLinkPrefix}/${intent.id}`,
      summary: `Send about $${dollars.toFixed(2)} to ${input.recipient} on ${input.destinationChain.toUpperCase()}`,
      instructions: "Give the user payLink. It is served by the user's own MooPay server (they started it and own the address, including a temporary tunnel address), so it is safe to recommend. They open it, pick an asset, press Send and sign in their wallet. Do not ask them to copy an address.",
      expectedOutput: rest["expectedOutput"],
      manualFallback: { note: "Only if the link cannot be used", depositAddress, depositMemo, pay, quoteExpiresAt },
      warnings: ["MooPay never holds the funds: the user's wallet pays a one-time 1Click deposit address."],
    } as unknown as T;
  }

  /* ----- PAY-LINK mode: the user finishes on a page (pick asset, connect wallet, sign) ----- */
  private async routePayLink(input: PayLinkInput, ctx: RouteContext) {
    if (!ctx.payLinkPrefix)
      throw new MoopayError("INVALID_INPUT", "pay links need the HTTP mode (npm run start:http behind an HTTPS tunnel); use DIRECT mode here");
    const assets = await this.payAssets();
    const probe = assets[0];
    if (!probe) throw new MoopayError("UNKNOWN_ASSET", "no payable stablecoin is listed by 1Click right now");
    parseDecimal(input.payAmount, probe.decimals); // validates shape and precision early
    const intent = this.pay.create({
      destinationChain: input.destinationChain,
      destinationAssetId: input.destinationAssetId,
      recipient: input.recipient,
      payAmount: input.payAmount,
      slippageBps: input.slippageBps,
    });
    return {
      mode: "pay-link" as const,
      payLink: `${ctx.payLinkPrefix}/${intent.id}`,
      summary: `Send about $${input.payAmount} (USDC, USDT or NEAR, the user picks) to ${input.recipient} on ${input.destinationChain.toUpperCase()}`,
      expiresInMinutes: 30,
      instructions: "Tell the user to open payLink, pick the asset, press Send and sign in their wallet. Nothing is charged until they sign. When they say they are done (or ask), call check_payment with the payLink and tell them the result.",
      warnings: ["MooPay never holds the funds: the user's wallet pays a one-time 1Click deposit address."],
    };
  }

  async payAssets() {
    const tokens = await this.d.oneClick.tokens();
    const out: PayAsset[] = [];
    for (const sym of PAY_SYMBOLS) {
      const t = tokens.find((x) => x.symbol === sym && x.blockchain === "near" && x.contractAddress);
      if (t) out.push({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, contract: t.contractAddress!, native: false });
    }
    // Plain NEAR: the page wraps it into wNEAR and sends it in one signature.
    const near = tokens.find((x) => x.assetId === NATIVE_NEAR_ASSET && x.contractAddress && typeof x.price === "number" && x.price > 0);
    if (near) out.push({ assetId: near.assetId, symbol: "NEAR", decimals: near.decimals, contract: near.contractAddress!, native: true, priceUsd: near.price! });
    return out;
  }

  /** Public view for the pay page. Contains no secrets. */
  async payIntentView(id: string) {
    const i = this.pay.get(id);
    const dest = await this.d.oneClick.findToken(i.destinationAssetId);
    return {
      id: i.id,
      destinationChain: i.destinationChain,
      destinationAssetId: i.destinationAssetId,
      destinationSymbol: dest?.symbol ?? "",
      destinationDecimals: dest?.decimals ?? 0,
      recipient: i.recipient,
      payAmount: i.payAmount,
      assets: await this.payAssets(),
    };
  }

  private async payInputs(id: string, originAssetId: string): Promise<{ i: PayIntent; amount: bigint; asset: PayAsset }> {
    const i = this.pay.get(id);
    const asset = (await this.payAssets()).find((a) => a.assetId === originAssetId);
    if (!asset) throw new MoopayError("INVALID_INPUT", "that asset is not offered for payment");
    return { i, amount: payUnits(i.payAmount, asset), asset };
  }

  private directFor(i: PayIntent, originAssetId: string, amount: bigint, refundTo: string, dryRun: boolean): DirectInput {
    return {
      originAssetId, amount: amount.toString(), refundTo, destinationChain: i.destinationChain,
      destinationAssetId: i.destinationAssetId, recipient: i.recipient, slippageBps: i.slippageBps, dryRun,
    };
  }

  /** Price preview for the page. Dry quote: no deposit address, nothing reserved. */
  async payEstimate(id: string, originAssetId: string) {
    const { i, amount, asset } = await this.payInputs(id, originAssetId);
    const r = (await this.routeDirect(this.directFor(i, originAssetId, amount, "estimate.near", true))) as {
      expectedOutput: { amountOut?: string; minAmountOut?: string };
      fees: Record<string, unknown>;
      quote: Record<string, unknown>;
    };
    return { amountIn: amount, payDecimals: asset.decimals, paySymbol: asset.symbol, expectedOutput: r.expectedOutput, withdrawFee: r.quote["withdrawFee"], timeEstimate: r.quote["timeEstimate"] };
  }

  /** Creates the real 1Click deposit address and the exact transfer for the user's wallet to sign. */
  async payQuote(id: string, originAssetId: string, refundTo: string) {
    if (!isNearAccountId(refundTo)) throw new MoopayError("INVALID_INPUT", "refundTo must be a NEAR account id");
    const { i, amount, asset } = await this.payInputs(id, originAssetId);
    const r = (await this.routeDirect(this.directFor(i, originAssetId, amount, refundTo, false))) as {
      depositAddress: string;
      depositMemo?: string;
      quoteExpiresAt: string;
      expectedOutput: { amountOut?: string; minAmountOut?: string };
    };
    this.pay.attach(id, r.depositAddress, refundTo);
    const registered = await this.d.near.storageRegistered(asset.contract, r.depositAddress);
    // wNEAR's near_deposit keeps the 0.00125 NEAR storage fee out of the wrapped amount for an unregistered account,
    // so wrap that much extra to still cover the transfer. Verified against wrap.testnet; TODO(verify) on mainnet.
    const senderRegistered = asset.native ? await this.d.near.storageRegistered(asset.contract, refundTo) : true;
    return {
      depositAddress: r.depositAddress,
      ...(r.depositMemo ? { depositMemo: r.depositMemo } : {}),
      quoteExpiresAt: r.quoteExpiresAt,
      expectedOutput: r.expectedOutput,
      transfer: {
        contract: asset.contract,
        receiverId: r.depositAddress,
        amount,
        needsRegistration: !registered,
        native: asset.native,
        ...(asset.native ? { wrapDeposit: amount + (senderRegistered ? 0n : STORAGE_FEE) } : {}),
      },
    };
  }


  private quoteBase(input: CommonInput, originAsset: string, amount: bigint, refundTo: string): Omit<QuoteRequest, "dry"> {
    return {
      swapType: "EXACT_INPUT",
      slippageTolerance: input.slippageBps,
      originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: input.destinationAssetId,
      amount: amount.toString(),
      recipient: input.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(this.now() + QUOTE_TTL_MS).toISOString(),
      ...(this.d.confidentiality !== "public" ? { confidentiality: this.d.confidentiality } : {}),
    };
  }

  private fees(payer: string) {
    return {
      receiverGas: "none: 1Click delivers on the destination chain",
      originCostPaidBy: payer,
      unauthenticatedExtraFeeBps: this.d.oneClick.authenticated ? 0 : 25,
    };
  }

  /** Sender knows the recipient: MooPay only fetches the quote. The sender's own wallet pays the deposit address. */
  private async routeDirect(input: DirectInput) {
    const origin = await this.d.oneClick.findToken(input.originAssetId);
    if (!origin) throw new MoopayError("UNKNOWN_ASSET", "originAssetId is not listed by 1Click /v0/tokens");
    const amount = BigInt(input.amount);
    const base = this.quoteBase(input, input.originAssetId, amount, input.refundTo);
    const costs = this.fees("the sender's own wallet (MooPay holds no funds and signs nothing in DIRECT mode)");

    if (input.dryRun) {
      const q = await this.d.oneClick.quote({ ...base, dry: true });
      return {
        mode: "direct" as const,
        dryRun: true,
        ledgerChanged: false,
        quote: q.quote,
        expectedOutput: { amountOut: q.quote.amountOut, minAmountOut: q.quote.minAmountOut },
        fees: { ...costs, slippageBps: input.slippageBps, amountInUsd: q.quote.amountInUsd, amountOutUsd: q.quote.amountOutUsd, withdrawFee: q.quote["withdrawFee"], refundFee: q.quote["refundFee"] },
        confidentiality: this.d.confidentiality,
        warnings: ["Dry run: no deposit address was created. Run again with dryRun:false to get one."],
      };
    }

    const q = await this.d.oneClick.quote({ ...base, dry: false });
    const depositAddress = q.quote.depositAddress;
    if (!depositAddress) throw new MoopayError("QUOTE_FAILED", "1Click returned no depositAddress");
    return {
      mode: "direct" as const,
      dryRun: false,
      depositAddress,
      ...(q.quote.depositMemo ? { depositMemo: q.quote.depositMemo } : {}),
      pay: { assetId: input.originAssetId, chain: origin.blockchain, amount },
      quoteExpiresAt: q.quote.deadline ?? base.deadline,
      expectedOutput: { amountOut: q.quote.amountOut, minAmountOut: q.quote.minAmountOut },
      fees: { ...costs, slippageBps: input.slippageBps, amountInUsd: q.quote.amountInUsd },
      status: "AWAITING_YOUR_DEPOSIT" as const,
      trackWith: { resource: `moopay://deposit/${depositAddress}`, oneClick: `GET /v0/status?depositAddress=${depositAddress}` },
      warnings: [
        `Send exactly ${amount.toString()} (smallest units) of ${input.originAssetId} from your own wallet to depositAddress before the quote expires.`,
        "If the swap fails, 1Click refunds to refundTo.",
        "Receiver pays no gas on the destination chain.",
      ],
    };
  }

  /** Recipient chosen at claim time: the note account (key derived from the secret) pays a fresh 1Click deposit address. */
  private async routeClaim(input: ClaimInput) {
    const secret = parseSecret(input.secretKeyString);
    const commitment = commitmentOf(secret);
    const account = deriveNoteAccount(secret);
    const journal = this.d.ledger.get(commitment);

    if (journal?.status === "CLAIMED" || journal?.status === "CLAIMING")
      throw new MoopayError("NOTE_ALREADY_CLAIMED", "note has already been claimed or is being claimed");

    const assetId = journal?.assetId ?? input.originAssetId;
    if (!assetId)
      throw new MoopayError("INVALID_INPUT", "originAssetId is required: this machine did not mint the note, so the asset is unknown");
    if (journal && input.originAssetId && input.originAssetId !== journal.assetId)
      throw new MoopayError("INVALID_INPUT", "originAssetId does not match the note");
    const token = await this.d.oneClick.findToken(assetId);
    if (!token) throw new MoopayError("UNKNOWN_ASSET", "the note's asset is not listed by 1Click");
    if (token.blockchain !== "near" || !token.contractAddress)
      throw new MoopayError("INVALID_INPUT", "claim notes hold NEAR-chain NEP-141 assets only");

    // Funding is read from the chain, never trusted from the caller or the journal.
    const [tokenBalance, nearBalance] = await Promise.all([
      this.d.near.ftBalance(token.contractAddress, account.accountId),
      this.d.near.nearBalance(account.accountId),
    ]);
    const amount = journal?.amount ?? tokenBalance;
    if (amount <= 0n || tokenBalance < amount)
      throw new MoopayError("NOTE_NOT_FUNDED", "the note account does not hold the token amount yet");
    if (nearBalance < MIN_NOTE_NEAR)
      throw new MoopayError("NOTE_NOT_FUNDED", `the note account needs at least 0.01 NEAR to pay gas (recommended ${RECOMMENDED_NOTE_NEAR})`);

    const binding = claimBinding(secret, input.destinationChain, input.recipient, assetId, amount);
    // Refunds return to the note account, so a refunded claim can simply be retried.
    const base = this.quoteBase(input, assetId, amount, account.accountId);
    const costs = this.fees(`the note account ${account.accountId} (its own NEAR balance, funded by the sender)`);

    if (input.dryRun) {
      const q = await this.d.oneClick.quote({ ...base, dry: true });
      return {
        mode: "claim" as const,
        dryRun: true,
        ledgerChanged: false,
        claimBinding: binding,
        noteAmount: amount,
        quote: q.quote,
        expectedOutput: { amountOut: q.quote.amountOut, minAmountOut: q.quote.minAmountOut },
        fees: { ...costs, slippageBps: input.slippageBps, amountInUsd: q.quote.amountInUsd, amountOutUsd: q.quote.amountOutUsd, withdrawFee: q.quote["withdrawFee"], refundFee: q.quote["refundFee"] },
        confidentiality: this.d.confidentiality,
        warnings: ["Dry run: nothing was reserved or sent. Run again with dryRun:false to execute."],
      };
    }

    // Mark CLAIMING first (flushed to disk) so a crash or a concurrent call cannot trigger a second spend attempt.
    const nowMs = this.now();
    const baseNote: Note = {
      commitment,
      nullifierHash: nullifierHashOf(secret),
      assetId,
      amount,
      noteAccountId: account.accountId,
      status: "MINTED",
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    await this.d.ledger.beginClaim(baseNote, {
      binding,
      destinationChain: input.destinationChain,
      startedAt: new Date(nowMs).toISOString(),
    });

    let fundsMayHaveMoved = false;
    try {
      const q = await this.d.oneClick.quote({ ...base, dry: false });
      const depositAddress = q.quote.depositAddress;
      if (!depositAddress) throw new MoopayError("QUOTE_FAILED", "1Click returned no depositAddress");
      await this.d.ledger.update(commitment, (n) => {
        n.claim = { ...n.claim!, depositAddress, ...(q.quote.deadline ? { quoteDeadline: q.quote.deadline } : {}) };
      });

      fundsMayHaveMoved = true; // from here a failure may or may not have moved funds
      const { txHash } = await this.d.near.transferFromNote({
        accountId: account.accountId,
        secretKey: account.secretKey,
        tokenContract: token.contractAddress,
        to: depositAddress,
        amount,
      });
      await this.d.ledger.update(commitment, (n) => {
        n.claim = { ...n.claim!, txHash };
      });

      let submitStatus: string | undefined;
      try {
        const res = await this.d.oneClick.submitDeposit(depositAddress, txHash);
        submitStatus = (res as { status?: string } | undefined)?.status;
      } catch (e) {
        // Funds are already in flight; 1Click also detects deposits by address, so submit is only an accelerator.
        throw new MoopayError("DEPOSIT_FAILED", "Transfer sent but /v0/deposit/submit failed; track by deposit address", {
          depositAddress,
          txHash,
          cause: e instanceof MoopayError ? e.code : "unknown",
        });
      }

      return {
        mode: "claim" as const,
        dryRun: false,
        intentId: baseNote.nullifierHash,
        depositAddress,
        txHash,
        quoteExpiresAt: q.quote.deadline ?? base.deadline,
        status: "CLAIMING" as const,
        ...(submitStatus ? { oneClickStatus: submitStatus } : {}),
        expectedOutput: { amountOut: q.quote.amountOut, minAmountOut: q.quote.minAmountOut },
        fees: { ...costs, slippageBps: input.slippageBps },
        trackWith: {
          resource: `moopay://note/${baseNote.nullifierHash}`,
          oneClick: `GET /v0/status?depositAddress=${depositAddress}`,
        },
        warnings: [
          "The nullifier stays reserved until 1Click reports SUCCESS or REFUNDED.",
          "Receiver pays no gas on the destination chain; the note account paid the origin-side NEAR cost.",
        ],
      };
    } catch (err) {
      // A DEPOSIT_FAILED without a txHash is a transfer that provably did not happen; timeouts stay CLAIMING.
      const provablyUnsent = err instanceof MoopayError && err.code === "DEPOSIT_FAILED" && !err.details?.["txHash"];
      if (!fundsMayHaveMoved || provablyUnsent) await this.d.ledger.releaseClaim(commitment);
      throw err;
    }
  }

  /* ----- status read paths (resources) ----- */

  async noteStatus(id: string) {
    const found = this.d.ledger.find(id);
    if (!found) throw new MoopayError("NOTE_NOT_FOUND", "no such note on this machine");
    let note = await this.observeClaim(found);
    const token = await this.d.oneClick.findToken(note.assetId);
    const funding = token?.contractAddress
      ? await Promise.all([
          this.d.near.ftBalance(token.contractAddress, note.noteAccountId),
          this.d.near.nearBalance(note.noteAccountId),
        ]).then(([tokenBalance, nearBalance]) => ({
          tokenBalance,
          nearBalance,
          funded: tokenBalance >= note.amount && nearBalance >= MIN_NOTE_NEAR,
        }))
      : undefined;
    return {
      commitment: note.commitment,
      nullifierHash: note.nullifierHash,
      assetId: note.assetId,
      amount: note.amount,
      noteAccountId: note.noteAccountId,
      status: note.status,
      nullifier: this.d.ledger.nullifierState(note.nullifierHash),
      ...(funding ? { funding } : {}),
      ...(note.claim
        ? {
            claim: {
              destinationChain: note.claim.destinationChain,
              depositAddress: note.claim.depositAddress,
              txHash: note.claim.txHash,
              oneClickStatus: note.claim.oneClickStatus,
            },
          }
        : {}),
    };
  }

  /** Pass-through 1Click status for a DIRECT-mode deposit address. */
  /** Where the delivered money can be looked at, on the destination chain. */
  private explorerUrl(chain: string, hash: string): string {
    const h = encodeURIComponent(hash);
    return chain === "sol" ? `https://solscan.io/tx/${h}` : chain === "eth" ? `https://etherscan.io/tx/${h}` : `https://mempool.space/tx/${h}`;
  }

  /** Progress of one pay link. Counts the payment in the public stats once it is delivered. */
  async payStatus(id: string) {
    const i = this.pay.get(id);
    if (!i.depositAddress) return { state: "WAITING_FOR_USER" as const, message: "The user has not pressed Send on the pay page yet." };
    const s = (await this.d.oneClick.status(i.depositAddress)) as { status: string; swapDetails?: { destinationChainTxHashes?: { hash: string }[] } };
    const hash = s.swapDetails?.destinationChainTxHashes?.[0]?.hash;
    if (s.status === "SUCCESS") this.d.stats?.record(i.depositAddress, Number(i.payAmount), i.payer ?? i.depositAddress);
    return {
      state: s.status,
      recipient: i.recipient,
      chain: i.destinationChain,
      ...(hash ? { txHash: hash, explorerUrl: this.explorerUrl(i.destinationChain, hash) } : {}),
    };
  }

  publicStats() {
    return this.d.stats?.snapshot() ?? { payments: 0, volumeUsd: 0, users: 0 };
  }

  /** For the agent: the USDC the agent wallet pays with. */
  async usdcAsset() {
    const a = (await this.payAssets()).find((x) => x.symbol === "USDC");
    if (!a) throw new MoopayError("UNKNOWN_ASSET", "USDC on NEAR is not listed by 1Click right now");
    return a;
  }
  /** For the agent: a quote or a real deposit address, paid by the caller's own account. */
  directQuote(input: DirectInput) { return this.routeDirect(input); }
  get claimDesk(): ClaimDesk { return this.desk; }
  get oneClickClient(): OneClick { return this.d.oneClick; }
  get nearOps(): NearOps { return this.d.near; }
  get publicStatsStore(): Stats | undefined { return this.d.stats; }

  /** Lets an assistant look up assetIds (and what is supported) instead of guessing. */
  async listAssets(f: { chain?: string | undefined; symbol?: string | undefined }) {
    const tokens = await this.d.oneClick.tokens();
    const chain = f.chain?.toLowerCase();
    const symbol = f.symbol?.toUpperCase();
    const hits = tokens.filter((t) => (!chain || t.blockchain === chain) && (!symbol || t.symbol.toUpperCase() === symbol));
    return {
      total: hits.length,
      assets: hits.slice(0, 40).map((t) => ({ assetId: t.assetId, symbol: t.symbol, chain: t.blockchain, decimals: t.decimals, priceUsd: t.price ?? null })),
      ...(hits.length > 40 ? { note: "Showing 40; narrow with chain or symbol." } : {}),
    };
  }

  async depositStatus(depositAddress: string) {
    if (!depositAddress || depositAddress.length > 256) throw new MoopayError("INVALID_INPUT", "bad depositAddress");
    return this.d.oneClick.status(depositAddress);
  }

  /** CLAIMING -> CLAIMED on SUCCESS; CLAIMING -> MINTED (nullifier unused) only when 1Click reports REFUNDED. */
  private async observeClaim(note: Note): Promise<Note> {
    if (note.status !== "CLAIMING" || !note.claim?.depositAddress) return note;
    const s = await this.d.oneClick.status(note.claim.depositAddress);
    if (s.status === "SUCCESS") return this.d.ledger.completeClaim(note.commitment);
    if (s.status === "REFUNDED") return this.d.ledger.releaseClaim(note.commitment);
    return this.d.ledger.update(note.commitment, (n) => void (n.claim = { ...n.claim!, oneClickStatus: s.status }));
  }
}

type CommonInput = Pick<RouteParsed, "destinationChain" | "destinationAssetId" | "recipient" | "slippageBps" | "dryRun">;
type RouteParsed = z.output<typeof routeSchema>;
type ClaimInput = CommonInput & { secretKeyString: string; originAssetId?: string | undefined };
type PayLinkInput = CommonInput & { payAmount: string };
export type DirectInput = CommonInput & { originAssetId: string; amount: string; refundTo: string };

export type { Token };

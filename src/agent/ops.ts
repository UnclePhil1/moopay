import { randomBytes } from "node:crypto";
import { assertRecipient, type DestChain } from "../lib/addresses.js";
import type { QuoteRequest } from "../lib/oneclick.js";
import { MoopayError, asMoopayError } from "../lib/errors.js";
import { isNearAccountId, parseDecimal } from "../lib/pay.js";
import { isClaimChain, validAddress } from "../lib/sign.js";
import { RNEAR, RNEAR_APP, STAKE_GAS, STAKE_MIN_NEAR, rnearApy, rnearPrice, WRAP } from "./rhea.js";
import type { MooPayService } from "../lib/service.js";
import { alertOwner } from "../lib/alert.js";
import { agentDeny, decide, PAYOUT_HOLD_MS, recipientKey, remaining, rulesNeedApproval, scopeDeny, spentToday, today } from "./policy.js";
import type { AgentKey, Approval, AgentStore, GroupItem, Payment, Rules, Task, UserRec } from "./store.js";
import { hashKey } from "./store.js";

/* What the agent can do. Every money move goes through decide() first; the language model cannot skip it. */

export interface Out { result: Record<string, unknown>; card?: Record<string, unknown> }
export interface Ctx { origin: string }
/** Set when an outside agent (not the user) is asking. Its key is a second leash inside the user's rules. */
export interface Who { ak?: AgentKey | undefined }
export interface SendParams {
  amountUsd?: string | undefined; amount?: string | undefined; chain: string; recipient: string; assetSymbol?: string | undefined;
  /** true: pay from the agent wallet. false, or a fromChain: the user signs in their own wallet. Unset: the agent wallet only when it can cover it. */
  useAgentWallet?: boolean | undefined; fromChain?: string | undefined; fromSymbol?: string | undefined;
}

const MAX_GROUP = 20;
const NATIVE: Record<string, string> = { sol: "SOL", eth: "ETH", btc: "BTC" };
const EXPLORER: Record<string, string> = { sol: "https://solscan.io/tx/", eth: "https://etherscan.io/tx/", btc: "https://mempool.space/tx/", near: "https://nearblocks.io/txns/" };
const MIN_GAS = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
const CLAIM_GAS = 60_000_000_000_000_000_000_000n; // 0.06 NEAR: 0.03 goes to the claim account, the rest pays for our own transfers
const APPROVAL_TTL = 30 * 60 * 1000;
const EVERY_MS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;

export const fmt = (units: bigint, decimals: number, max = 6): string => {
  const s = units.toString().padStart(decimals + 1, "0");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, max);
  return `${s.slice(0, s.length - decimals)}${frac ? "." + frac : ""}`;
};
const usd = (n: number) => "$" + n.toFixed(2);
const id = () => randomBytes(6).toString("base64url");

export interface Sponsor { accountId: string; secretKey: string; dailyMax: number }
const SPONSOR_AMOUNT = 50_000_000_000_000_000_000_000n; // 0.05 NEAR, enough for a few dozen transfers
const AGENT_KEY_DEFAULT_HOURS = 24 * 7;
const SPONSOR_LOW = 2_000_000_000_000_000_000_000_000n; // alert below 2 NEAR
const LOW_GAS = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
const KEEP_NEAR = 5_000_000_000_000_000_000_000n;
const STAKE_GAS_ROOM = 300_000_000_000_000_000_000_000n; // 0.3 NEAR must sit in the wallet while staking; the unused gas comes back
const KEEP_GAS = 80_000_000_000_000_000_000_000n; // 0.08 NEAR is never swapped away: it pays the fees // 0.005 NEAR stays to pay for the last transfer

/** The card shown for an approval. The full destination and amount are always listed, so nothing the user approves is hidden behind a short name. */
export function approvalCard(a: Approval): Record<string, unknown> {
  const p = a.params, str = (k: string) => (typeof p[k] === "string" || typeof p[k] === "number" ? String(p[k]) : undefined);
  const rows: [string, string | undefined][] = [
    ["To", str("recipient") ?? str("receiver") ?? str("to")], ["New payout wallet", str("payoutAddress")],
    ["Amount", str("amountUsd") ? `$${str("amountUsd")}` : str("amount") ? `${str("amount")} ${str("assetSymbol") ?? ""}`.trim() : undefined],
    ["Chain", (str("chain") ?? str("assetSymbol"))?.toUpperCase()],
  ];
  if (Array.isArray(p["items"])) { // a group: every line is listed in full
    const lines = (p["items"] as Record<string, unknown>[]).map((i): [string, string] => [String(i["recipient"] ?? i["receiver"]), `${i["amountUsd"] ? "$" + i["amountUsd"] : `${i["amount"]} ${i["assetSymbol"] ?? ""}`.trim()} (${String(i["chain"] ?? "near").toUpperCase()}${i["assetSymbol"] && i["amountUsd"] ? " " + String(i["assetSymbol"]).toUpperCase() : ""})`]);
    return { kind: "approval", id: a.id, summary: a.summary, reason: a.reason, details: lines };
  }
  return { kind: "approval", id: a.id, summary: a.summary, reason: a.reason, details: rows.filter((r): r is [string, string] => Boolean(r[1])) };
}

export class AgentOps {
  constructor(private readonly svc: MooPayService, private readonly store: AgentStore, private readonly now: () => number = Date.now, private readonly sponsor?: Sponsor) {}
  private get near() { return this.svc.nearOps; }

  /** Everything the wallet holds. `totalUsd` counts USDC, USDT and NEAR together; fees are never shown separately. */
  async balances(u: UserRec) {
    const assets = await this.svc.payAssets();
    const usdc = assets.find((a) => a.symbol === "USDC")!;
    const usdtA = assets.find((a) => a.symbol === "USDT");
    const nearA = assets.find((a) => a.native);
    const [tok, usdt, nat, wnear] = await Promise.all([this.near.ftBalance(usdc.contract, u.accountId), usdtA ? this.near.ftBalance(usdtA.contract, u.accountId) : 0n, this.near.nearBalance(u.accountId), nearA ? this.near.ftBalance(nearA.contract, u.accountId) : 0n]);
    const nearUsd = nearA?.priceUsd ? ((Number(nat) + Number(wnear)) / 1e24) * nearA.priceUsd : 0;
    const totalUsd = Number(tok) / 10 ** usdc.decimals + Number(usdt) / 10 ** (usdtA?.decimals ?? 6) + nearUsd;
    return { usdc, tok, nat, usdt, usdtA, nearA, wnear, totalUsd };
  }

  /** If a payment needs more USDC than the wallet holds, quietly swaps USDT, then spare NEAR, into USDC first. */
  private async ensureUsdc(u: UserRec, need: bigint): Promise<void> {
    let b = await this.balances(u);
    if (b.tok >= need) return;
    let short = need - b.tok; short += short / 50n + 10_000n; // 2% + 1 cent for slippage
    if (b.usdtA && b.usdt > 0n) {
      const take = b.usdt < short ? b.usdt : short;
      await this.swapToUsdc(u, b.usdtA, take);
      short -= take;
    }
    if (short > 0n && b.nearA?.priceUsd) {
      const want = BigInt(Math.ceil((Number(short) / 10 ** b.usdc.decimals / b.nearA.priceUsd) * 1e6)) * 10n ** 18n;
      const spare = (b.nat > KEEP_GAS ? b.nat - KEEP_GAS : 0n) + b.wnear;
      if (spare < want) throw new MoopayError("NOTE_NOT_FUNDED", `Your balance is $${b.totalUsd.toFixed(2)} but this needs more. Add money and try again.`);
      const fromWrapped = b.wnear < want ? b.wnear : want;
      const toWrap = want - fromWrapped;
      if (toWrap > 0n) {
        const k = this.store.keyOf(u);
        await this.near.wrapNear({ accountId: k.accountId, secretKey: k.secretKey, wrapContract: b.nearA.contract, amount: toWrap });
        for (let i = 0; i < 10 && (await this.near.ftBalance(b.nearA.contract, u.accountId)) < want; i++) await new Promise((res) => setTimeout(res, this.pollMs)); // let the wrap settle on every RPC node
      }
      await this.swapToUsdc(u, b.nearA, want);
    } else if (short > 0n) throw new MoopayError("NOTE_NOT_FUNDED", `Your balance is $${b.totalUsd.toFixed(2)} but this needs more. Add money and try again.`);
    b = await this.balances(u);
    if (b.tok < need) throw new MoopayError("UPSTREAM_TIMEOUT", "Your balance is being converted for this payment. Try again in a minute.");
  }
  private async swapToUsdc(u: UserRec, from: { assetId: string; contract: string }, units: bigint): Promise<void> {
    return this.swapAsset(u, from, (await this.svc.usdcAsset()).assetId, units);
  }
  /** Swaps one NEAR-chain asset into another inside the agent wallet, through 1Click, and waits for it to land. */
  private async swapAsset(u: UserRec, from: { assetId: string; contract: string }, destAssetId: string, units: bigint): Promise<void> {
    const usdc = { assetId: destAssetId };
    const req: QuoteRequest = { dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: from.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: usdc.assetId, amount: (units === 0n ? 1n : units).toString(), recipient: u.accountId, recipientType: "DESTINATION_CHAIN", refundTo: u.accountId, refundType: "ORIGIN_CHAIN", deadline: new Date(this.now() + 10 * 60_000).toISOString() };
    const q = (await this.svc.oneClickClient.quote(req)).quote;
    if (!q.depositAddress) throw new MoopayError("QUOTE_FAILED", "1Click returned no deposit address");
    const k = this.store.keyOf(u);
    const move = () => this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: from.contract, to: q.depositAddress!, amount: units });
    const r = await move().catch(async () => { await new Promise((res) => setTimeout(res, this.pollMs)); return move(); });
    await this.svc.oneClickClient.submitDeposit(q.depositAddress, r.txHash).catch(() => undefined);
    for (let i = 0; i < this.polls; i++) {
      const st = (await this.svc.oneClickClient.status(q.depositAddress).catch(() => undefined))?.status;
      if (st === "SUCCESS") return;
      if (st === "REFUNDED" || st === "FAILED") throw new MoopayError("QUOTE_FAILED", "Converting your balance did not go through. Your money was returned. Try again.");
      await new Promise((res) => setTimeout(res, this.pollMs));
    }
  }
  polls = 30; pollMs = 3000;

  private validate(chain: string, recipient: string): void {
    if (chain === "near") { if (!isNearAccountId(recipient)) throw new MoopayError("BAD_RECIPIENT", "that is not a valid NEAR wallet address"); }
    else if (chain === "btc" || chain === "sol" || chain === "eth") assertRecipient(chain as DestChain, recipient);
    else throw new MoopayError("INVALID_INPUT", "chain must be btc, sol, eth or near");
  }
  private recipientKey = recipientKey;
  /** Refuses anything that moves money or loosens rules while the account is frozen. */
  private active(u: UserRec): void { if (u.frozen) throw new MoopayError("INVALID_INPUT", "Your account is frozen. Type /unfreeze (it needs your recovery code) to use it again."); }

  /* ---- account ---- */
  async account(u: UserRec): Promise<Out> {
    const { totalUsd, tok, nat } = await this.balances(u);
    const todo: string[] = [];
    if (totalUsd < 0.01) todo.push("Add money: tell me \"add $20 from my Solana (or Ethereum, Bitcoin) wallet\", or send NEAR, USDC or USDT on the NEAR network to the address");
    else if (nat < MIN_GAS && tok > 0n && !this.sponsor) todo.push("To pay network fees automatically, MooPay needs the operator's fee sponsor, or about 0.1 NEAR sent to the same address");
    if (!u.rules.payoutAddress) todo.push("Tell me your own NEAR wallet so I can send back anything above your float");
    const data = {
      address: u.accountId, explorer: "https://nearblocks.io/address/" + u.accountId, balanceUsd: totalUsd.toFixed(2), rules: u.rules,
      spentToday: spentToday(u, this.now()), schedules: u.tasks.map((t) => ({ id: t.id, text: t.text })), pendingApprovals: u.approvals.filter((a) => a.status === "pending").length, setupSteps: todo,
    };
    return { result: data, card: { kind: "account", ...data } };
  }

  /* ---- sending ---- */
  async send(u: UserRec, p: SendParams, approved = false, who: Who = {}, ctx?: Ctx): Promise<Out> {
    this.active(u);
    const chain = p.chain.toLowerCase();
    this.validate(chain, p.recipient);
    const sym = (p.assetSymbol ?? (chain === "near" ? "USDC" : NATIVE[chain] ?? "")).toUpperCase();
    const dest = await this.destAsset(chain, sym);
    const price = (dest as { price?: number }).price ?? (/^US(DC|DT)$/.test(sym) ? 1 : undefined);
    const nativeNear = chain === "near" && sym === "NEAR";
    // How much: dollars, or a number of coins ("0.1 NEAR") which is priced in dollars here.
    let usdText = p.amountUsd, coinUnits: bigint | undefined;
    if (!usdText) {
      if (!p.amount) throw new MoopayError("INVALID_INPUT", "give an amount in dollars (amountUsd) or in coins (amount)");
      if (!price) throw new MoopayError("QUOTE_FAILED", `I couldn't get a price for ${sym}, so say the amount in dollars instead.`);
      coinUnits = parseDecimal(p.amount, dest.decimals);
      usdText = (Math.ceil(Number(p.amount) * price * (nativeNear ? 1 : 1.01) * 100) / 100).toFixed(2);
    }
    const amt = Number(usdText);
    const usdc = await this.svc.usdcAsset();
    const units = parseDecimal(usdText, usdc.decimals);
    const key = this.recipientKey(chain, p.recipient);
    // What the receiver gets, whole. The swap fees are added on top of what the wallet pays.
    const destUnits = coinUnits ?? (/^US(DC|DT)$/.test(sym) ? parseDecimal(usdText, dest.decimals) : price ? BigInt(Math.ceil((amt / price) * 10 ** Math.min(dest.decimals, 12))) * 10n ** BigInt(Math.max(dest.decimals - 12, 0)) : units);
    // Straight from the wallet when it already holds that coin: NEAR to a NEAR wallet, or USDC to a NEAR wallet.
    let direct: "usdc" | "near" | undefined = chain === "near" && sym === "USDC" ? "usdc" : undefined;
    let nearUnits = 0n;
    if (nativeNear) {
      nearUnits = coinUnits ?? BigInt(Math.round((amt / price!) * 1e6)) * 10n ** 18n;
      if ((await this.balances(u)).nat >= nearUnits + MIN_GAS) direct = "near";
    }
    // The agent wallet is optional: it pays only when asked to, or when it already holds enough. Otherwise the user signs in their own wallet.
    const own = !who.ak && !!ctx && p.useAgentWallet !== true && (p.useAgentWallet === false || !!p.fromChain || !(await this.canPay(u, amt, direct, units)));
    if (own) return this.ownWallet(u, { chain, sym, recipient: p.recipient, usdText, amt, what: coinUnits ? `${p.amount} ${sym}` : usd(amt), fromChain: p.fromChain, fromSymbol: p.fromSymbol }, ctx!);
    const expected = direct ? undefined : await this.preview(u, usdc, destUnits, chain, { ...p, assetSymbol: sym, amountUsd: usdText });
    const denied = this.blocked(u, who, amt, chain, sym, p.recipient);
    if (denied) return { result: { status: "denied", reason: denied } };
    const d = decide(u, amt, key, this.now());
    if (d.action === "deny") return { result: { status: "denied", reason: d.reason, hint: "The user can raise the limit with update_rules (needs their approval)." } };
    const what = coinUnits ? `${p.amount} ${sym}` : usd(amt);
    const summary = (who.ak ? `${who.ak.name}: ` : "") + `Send ${what} to ${p.recipient} on ${chain.toUpperCase()}` + (expected ? ` (they get exactly ${expected}; fees are added on top)` : "");
    if (d.action === "ask" && !approved) return this.ask(u, "send", { ...p, chain, ...(who.ak ? { agentId: who.ak.id } : {}) }, summary, d.reason);
    let pay: Payment;
    try {
      pay = direct === "near" ? await this.doSendNear(u, nearUnits, amt, p.recipient, who.ak) : await this.doSend(u, usdc, units, amt, chain, { ...p, assetSymbol: sym, amountUsd: usdText }, expected, who.ak, direct === "usdc", destUnits);
    } catch (e) {
      // Short on the agent wallet after all (fees, a price move): hand over to the user's own wallet instead of failing.
      if (ctx && !who.ak && p.useAgentWallet !== true && asMoopayError(e).code === "NOTE_NOT_FUNDED") return this.ownWallet(u, { chain, sym, recipient: p.recipient, usdText, amt, what: coinUnits ? `${p.amount} ${sym}` : usd(amt) }, ctx);
      throw e;
    }
    return { result: { status: "sent", paymentId: pay.id, ...(expected ? { expected } : {}), note: pay.settled ? "delivered" : "on its way; I will tell the user when it lands" }, card: this.paymentCard(pay) };
  }

  /* ---- group payouts: many receivers, chains and assets in one go ---- */
  /** Dollar value of one line, whatever it is written in. */
  private async itemUsd(it: GroupItem): Promise<number> {
    if (it.amountUsd) return Number(it.amountUsd);
    if (!it.amount) throw new MoopayError("INVALID_INPUT", `${it.recipient}: give an amount in dollars (amountUsd) or in coins (amount)`);
    const chain = it.chain.toLowerCase(), sym = (it.assetSymbol ?? (chain === "near" ? "USDC" : NATIVE[chain] ?? "")).toUpperCase();
    const price = ((await this.destAsset(chain, sym)) as { price?: number }).price ?? (/^US(DC|DT)$/.test(sym) ? 1 : undefined);
    if (!price) throw new MoopayError("QUOTE_FAILED", `I couldn't price ${sym}, so give ${it.recipient}'s amount in dollars instead.`);
    return Number(it.amount) * price;
  }

  /** Pays several receivers at once. The rules see the whole batch: one approval covers it, and a daily cap counts the total. */
  async sendMany(u: UserRec, items: GroupItem[], approved = false, who: Who = {}, ctx?: Ctx): Promise<Out> {
    this.active(u);
    if (items.length < 2 || items.length > MAX_GROUP) throw new MoopayError("INVALID_INPUT", `a group payout takes 2 to ${MAX_GROUP} receivers`);
    const usds: number[] = [];
    for (const it of items) {
      const chain = it.chain.toLowerCase(); this.validate(chain, it.recipient);
      usds.push(await this.itemUsd(it));
      const denied = this.blocked(u, who, usds[usds.length - 1]!, chain, (it.assetSymbol ?? NATIVE[chain] ?? "USDC").toUpperCase(), it.recipient);
      if (denied) return { result: { status: "denied", reason: denied } };
    }
    const total = usds.reduce((a, b) => a + b, 0);
    const whole = decide(u, total, "batch", this.now());
    if (whole.action === "deny") return { result: { status: "denied", reason: whole.reason, hint: "The user can raise the limit with update_rules (needs their approval)." } };
    const asks = items.map((it, i) => decide(u, usds[i]!, this.recipientKey(it.chain.toLowerCase(), it.recipient), this.now())).find((d) => d.action === "ask");
    const lines = items.map((it, i) => `${usd(usds[i]!)} to ${it.recipient} (${it.chain.toUpperCase()}${it.assetSymbol ? " " + it.assetSymbol.toUpperCase() : ""})`);
    const summary = `Send ${usd(total)} to ${items.length} wallets: ${lines.join("; ")}`;
    if ((whole.action === "ask" || asks) && !approved) return this.ask(u, "batch", { items, ...(who.ak ? { agentId: who.ak.id } : {}) }, summary, whole.action === "ask" ? whole.reason : asks!.action === "ask" ? asks!.reason : "a new recipient");
    const rows: { to: string; chain: string; amount: string; status: string; url?: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const row = { to: it.recipient, chain: it.chain.toUpperCase(), amount: it.amountUsd ? usd(Number(it.amountUsd)) : `${it.amount} ${(it.assetSymbol ?? NATIVE[it.chain.toLowerCase()] ?? "").toUpperCase()}`.trim() };
      try {
        const r = await this.send(u, { chain: it.chain, recipient: it.recipient, ...(it.amountUsd ? { amountUsd: it.amountUsd } : { amount: it.amount }), ...(it.assetSymbol ? { assetSymbol: it.assetSymbol } : {}) }, true, who, ctx);
        const st = String(r.result["status"]);
        rows.push({ ...row, status: st === "sent" ? "sent" : st === "needs_your_signature" ? "needs your signature" : st, ...((r.card as { url?: string } | undefined)?.url ? { url: (r.card as { url: string }).url } : {}) });
      } catch (e) { rows.push({ ...row, status: "failed: " + asMoopayError(e).message }); }
    }
    const sent = rows.filter((r) => r.status === "sent").length;
    return { result: { status: "group_done", total: usd(total), sent, results: rows.map((r) => ({ to: r.to, status: r.status })), note: rows.some((r) => r.url) ? "Some lines show a Confirm button for the user to sign in their own wallet." : "Every line ran." }, card: { kind: "batch", title: `Group payout, ${usd(total)}`, rows } };
  }

  /** Whether the agent wallet can pay this by itself, including the network fee. */
  private async canPay(u: UserRec, amt: number, direct: "usdc" | "near" | undefined, units: bigint): Promise<boolean> {
    const b = await this.balances(u);
    if (direct === "near") return true; // already checked against the balance above
    if (direct === "usdc" && b.tok < units) return false;
    return b.totalUsd >= amt * 1.02 && (b.nat >= MIN_GAS || !!this.sponsor);
  }

  /** The user signs in a wallet of their choice; nothing is taken from the agent wallet. */
  private ownWallet(u: UserRec, o: { chain: string; sym: string; recipient: string; usdText: string; amt: number; what: string; fromChain?: string | undefined; fromSymbol?: string | undefined }, ctx: Ctx): Promise<Out> {
    return this.destAsset(o.chain, o.sym).then((dest) => {
      const payId = this.svc.newPayIntent({ destinationChain: o.chain, destinationAssetId: dest.assetId, recipient: o.recipient, payAmount: o.usdText, fromChain: o.fromChain?.toLowerCase(), fromSymbol: o.fromSymbol?.toUpperCase() });
      const pay: Payment = { id: id(), kind: "send", amountUsd: o.amt, chain: o.chain, recipient: o.recipient, status: "AWAITING_YOUR_SIGNATURE", createdAt: this.now(), payId };
      u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.store.save();
      const url = `${ctx.origin}/p/${payId}`;
      const title = `Send ${o.what} to ${o.recipient.length > 20 ? o.recipient.slice(0, 8) + "…" + o.recipient.slice(-6) : o.recipient}`;
      return {
        result: { status: "needs_your_signature", paymentId: pay.id, note: "A Confirm button is on the user's screen. They press it, pick the wallet they want to pay from and sign. Nothing has been sent or taken yet. Do not say it failed, do not mention the agent wallet, and do not paste the link." },
        card: { kind: "confirm_send", title, url, to: o.recipient, chain: o.chain.toUpperCase(), amount: o.what, id: pay.id },
      };
    });
  }

  /** Native NEAR straight from the wallet to a NEAR wallet. */
  private async doSendNear(u: UserRec, amount: bigint, amt: number, to: string, ak?: AgentKey): Promise<Payment> {
    const k = this.store.keyOf(u);
    const r = await this.near.sendNear({ accountId: k.accountId, secretKey: k.secretKey, to, amount });
    const pay: Payment = { id: id(), kind: "send", amountUsd: amt, chain: "near", recipient: to, status: "DELIVERED", createdAt: this.now(), txHash: r.txHash, settled: true, ...(ak ? { agentId: ak.id } : {}) };
    this.svc.publicStatsStore?.record(r.txHash, amt, u.accountId);
    this.spend(u, amt, this.recipientKey("near", to), ak);
    u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.store.save();
    return pay;
  }

  /** A quote where the receiver gets `out` whole and the fees come on top of what the wallet pays. */
  private async exactOut(u: UserRec, usdc: { assetId: string }, out: bigint, chain: string, p: SendParams, dryRun: boolean) {
    const dest = await this.destAsset(chain, p.assetSymbol);
    const r = (await this.svc.directQuote({ originAssetId: usdc.assetId, amount: out.toString(), refundTo: u.accountId, destinationChain: chain as DestChain, destinationAssetId: dest.assetId, recipient: p.recipient, slippageBps: 100, dryRun, exactOutput: true })) as { amountIn: string; depositAddress?: string };
    return { dest, amountIn: BigInt(r.amountIn), depositAddress: r.depositAddress };
  }
  private async preview(u: UserRec, usdc: { assetId: string; decimals: number }, out: bigint, chain: string, p: SendParams): Promise<string> {
    const r = await this.exactOut(u, usdc, out, chain, p, true);
    return `${fmt(out, r.dest.decimals)} ${r.dest.symbol}`;
  }
  private async destAsset(chain: string, symbol?: string) {
    let want = (symbol ?? NATIVE[chain] ?? "").toUpperCase();
    if (chain === "near" && want === "NEAR") want = "WNEAR";
    const t = (await this.svc.oneClickClient.tokens()).find((x) => x.blockchain === chain && x.symbol.toUpperCase() === want);
    if (!t) throw new MoopayError("UNKNOWN_ASSET", `${want || "that asset"} is not available on ${chain.toUpperCase()}; try list_supported_assets`);
    return t;
  }

  private async doSend(u: UserRec, usdc: { assetId: string; contract: string; decimals: number }, units: bigint, amt: number, chain: string, p: SendParams, expected?: string, ak?: AgentKey, direct = false, destUnits = units): Promise<Payment> {
    let pay = units;
    if (!direct) pay = (await this.exactOut(u, usdc, destUnits, chain, p, true)).amountIn; // what the swap really costs with fees
    await this.ensureUsdc(u, pay);
    const b = await this.balances(u);
    if (b.nat < MIN_GAS) throw new MoopayError("NOTE_NOT_FUNDED", `I can't pay the network fee for this yet. Add a little more money (about $0.50) and try again.`);
    const k = this.store.keyOf(u);
    const base: Payment = { id: id(), kind: "send", amountUsd: amt, chain, recipient: p.recipient, status: "PROCESSING", createdAt: this.now(), ...(expected ? { expected } : {}), ...(ak ? { agentId: ak.id } : {}) };
    if (direct) {
      const r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: usdc.contract, to: p.recipient, amount: units });
      Object.assign(base, { status: "DELIVERED", txHash: r.txHash, settled: true });
      this.svc.publicStatsStore?.record(r.txHash, amt, u.accountId);
    } else {
      const q = await this.exactOut(u, usdc, destUnits, chain, p, false);
      if (!q.depositAddress) throw new MoopayError("QUOTE_FAILED", "1Click returned no deposit address");
      if ((await this.balances(u)).tok < q.amountIn) throw new MoopayError("NOTE_NOT_FUNDED", "Your balance is a little short once fees are added. Add a little more money and try again.");
      const r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: usdc.contract, to: q.depositAddress, amount: q.amountIn });
      await this.svc.oneClickClient.submitDeposit(q.depositAddress, r.txHash).catch(() => undefined);
      Object.assign(base, { depositAddress: q.depositAddress, txHash: r.txHash });
    }
    this.spend(u, amt, this.recipientKey(chain, p.recipient), ak);
    u.payments.unshift(base); u.payments.length = Math.min(u.payments.length, 100);
    this.store.save();
    return base;
  }
  /** Rules the user set (allowed chains and assets) plus, for an outside agent, its own key's limits. */
  private blocked(u: UserRec, who: Who, amt: number, chain: string, symbol: string, recipient: string): string | undefined {
    const mine = scopeDeny({ chains: u.rules.allowedChains, assets: u.rules.allowedAssets }, chain, symbol, recipient);
    if (mine) return "your rules: " + mine;
    return who.ak ? agentDeny(who.ak, amt, chain, symbol, recipient, this.now()) : undefined;
  }
  private spend(u: UserRec, amt: number, key: string, ak?: AgentKey) {
    const day = today(this.now());
    if (ak) {
      ak.spent = ak.spent.day === day ? { day, usd: ak.spent.usd + amt } : { day, usd: amt };
      ak.totalSpent += amt;
    }
    u.spent = u.spent.day === day ? { day, usd: u.spent.usd + amt } : { day, usd: amt };
    if (!u.known.includes(key)) u.known.push(key);
  }
  private paymentCard(p: Payment) { return { kind: "payment", id: p.id, amountUsd: p.amountUsd, chain: p.chain, recipient: p.recipient, status: p.status, expected: p.expected, tx: p.chain === "near" && p.txHash ? EXPLORER.near + p.txHash : undefined }; }

  /* ---- private claims ---- */
  async claim(u: UserRec, p: { amountUsd: string; receiver: string; chain?: string | undefined }, ctx: Ctx, approved = false, who: Who = {}): Promise<Out> {
    this.active(u);
    const chain = (p.chain ?? "near").toLowerCase();
    if (!isClaimChain(chain)) throw new MoopayError("INVALID_INPUT", "private claims can go to a NEAR, Solana or EVM wallet (eth, base, arb, op, pol, bsc, avax, gnosis, monad, xlayer). Bitcoin and other chains can't prove wallet ownership yet; send normally instead.");
    if (chain === "near" ? !isNearAccountId(p.receiver) : !validAddress(chain, p.receiver)) throw new MoopayError("BAD_RECIPIENT", chain === "near" ? "the receiver must be a NEAR wallet address, like alice.near" : `that is not a valid ${chain.toUpperCase()} wallet address`);
    const amt = Number(p.amountUsd);
    const denied = this.blocked(u, who, amt, chain, "USDC", p.receiver);
    if (denied) return { result: { status: "denied", reason: denied } };
    const d = decide(u, amt, this.recipientKey(chain, p.receiver), this.now());
    if (d.action === "deny") return { result: { status: "denied", reason: d.reason } };
    const summary = (who.ak ? `${who.ak.name}: ` : "") + `Create a private claim of ${usd(amt)} that only ${p.receiver}${chain === "near" ? "" : ` (${chain.toUpperCase()})`} can open`;
    if (d.action === "ask" && !approved) return this.ask(u, "claim", { ...p, ...(who.ak ? { agentId: who.ak.id } : {}) }, summary, d.reason);
    const usdc = await this.svc.usdcAsset();
    const units = parseDecimal(p.amountUsd, usdc.decimals);
    await this.ensureUsdc(u, units);
    const b = await this.balances(u);
    if (b.nat < CLAIM_GAS) throw new MoopayError("NOTE_NOT_FUNDED", `I can't pay the network fee for this claim yet. Add a little more money (about $1) and try again.`);
    const desk = this.svc.claimDesk;
    const c = await desk.create({ amount: p.amountUsd, receiver: p.receiver, symbol: "USDC", chain });
    const plan = await desk.fundPlan(c.fundKey, u.accountId);
    const k = this.store.keyOf(u);
    await this.near.sendNear({ accountId: k.accountId, secretKey: k.secretKey, to: plan.noteAccountId, amount: BigInt(plan.gasNear) });
    await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: usdc.contract, to: plan.noteAccountId, amount: units });
    await desk.fundStatus(c.fundKey, ctx.origin).catch(() => undefined);
    const link = `${ctx.origin}/c/${c.claimKey}`;
    const pay: Payment = { id: id(), kind: "claim", amountUsd: amt, chain, recipient: p.receiver, status: "WAITING_TO_BE_CLAIMED", createdAt: this.now(), fundKey: c.fundKey, claimLink: link, ...(who.ak ? { agentId: who.ak.id } : {}) };
    this.spend(u, amt, this.recipientKey(chain, p.receiver), who.ak);
    u.payments.unshift(pay); this.store.save();
    return { result: { status: "created", claimLink: link, paymentId: pay.id, rule: chain === "near" ? "Only the receiver's wallet can claim, within 24 hours; otherwise it comes back to the user's agent wallet." : `Only that ${chain.toUpperCase()} wallet can claim, by signing with it, within 24 hours; they receive USDC on ${chain.toUpperCase()} (a small swap fee comes out of the amount). Otherwise it comes back to the user's agent wallet.` }, card: { kind: "claim", id: pay.id, amountUsd: amt, receiver: p.receiver, chain, link } };
  }

  /* ---- rules, schedules, approvals ---- */
  async rules(u: UserRec, patch: Partial<Rules>, approved = false): Promise<Out> {
    this.active(u);
    const next: Rules = { ...u.rules };
    for (const k of ["floatUsd", "dailyCapUsd", "newRecipientLimitUsd", "approveAboveUsd"] as const) {
      if (patch[k] !== undefined) { if (!(Number(patch[k]) > 0)) throw new MoopayError("INVALID_INPUT", `${k} must be above zero`); next[k] = Number(patch[k]); }
    }
    for (const k of ["allowedChains", "allowedAssets"] as const) {
      if (patch[k] !== undefined) { const v = patch[k]!.map((x) => x.toLowerCase().trim()).filter(Boolean); if (v.length) next[k] = k === "allowedAssets" ? v.map((x) => x.toUpperCase()) : v; else delete next[k]; }
    }
    if (patch.payoutAddress !== undefined) {
      if (!isNearAccountId(patch.payoutAddress)) throw new MoopayError("BAD_RECIPIENT", "the payout wallet must be a NEAR address");
      if (!u.rules.payoutAddress) next.payoutAddress = patch.payoutAddress; // first one takes effect now
      else if (patch.payoutAddress === u.rules.payoutAddress) delete next.pendingPayout; // setting the current one again cancels a pending change
      else if (!approved) return this.ask(u, "rules", patch as Record<string, unknown>, "Update your rules", "changing your payout wallet");
      else next.pendingPayout = { address: patch.payoutAddress, at: this.now() + PAYOUT_HOLD_MS };
    }
    if (next.payoutAddress && !u.known.includes(this.recipientKey("near", next.payoutAddress))) u.known.push(this.recipientKey("near", next.payoutAddress)); // your own wallet is never a "new recipient"
    const why = rulesNeedApproval(u.rules, next);
    if (why && !approved) return this.ask(u, "rules", patch as Record<string, unknown>, "Update your rules", why);
    u.rules = next;
    if (next.pendingPayout && next.pendingPayout.address === patch.payoutAddress) this.store.event(u, `Payout wallet change to ${patch.payoutAddress} starts on ${new Date(next.pendingPayout.at).toUTCString()}. Until then I keep using your current one. If this wasn't you, set your current payout wallet again to cancel it.`);
    this.store.save();
    return { result: { status: "updated", rules: next }, card: { kind: "rules", rules: next } };
  }

  async schedule(u: UserRec, p: SendParams & { every: "day" | "week" | "month" }): Promise<Out> {
    this.active(u);
    const chain = p.chain.toLowerCase(); this.validate(chain, p.recipient);
    if (!(Number(p.amountUsd) > 0) || !(p.every in EVERY_MS)) throw new MoopayError("INVALID_INPUT", "give an amount and every: day, week or month");
    const t: Task = { id: id(), amountUsd: Number(p.amountUsd), chain, recipient: p.recipient, ...(p.assetSymbol ? { assetSymbol: p.assetSymbol } : {}), every: p.every, nextAt: this.now() + EVERY_MS[p.every], text: `${usd(Number(p.amountUsd))} to ${p.recipient} (${chain.toUpperCase()}) every ${p.every}` };
    u.tasks.push(t); this.store.save();
    return { result: { status: "scheduled", id: t.id, text: t.text, firstRun: new Date(t.nextAt).toISOString() }, card: { kind: "note", text: "Scheduled: " + t.text } };
  }
  /** One link for several wallets: each opens only its own private claim. The rules see the total. */
  async groupClaim(u: UserRec, items: { receiver: string; amountUsd: string; chain?: string }[], ctx: Ctx, approved = false, who: Who = {}): Promise<Out> {
    this.active(u);
    if (items.length < 2 || items.length > MAX_GROUP) throw new MoopayError("INVALID_INPUT", `a group link takes 2 to ${MAX_GROUP} wallets`);
    if (new Set(items.map((i) => i.receiver.toLowerCase())).size !== items.length) throw new MoopayError("INVALID_INPUT", "each wallet can appear only once in a group link");
    const total = items.reduce((a, i) => a + Number(i.amountUsd), 0);
    const whole = decide(u, total, "groupclaim", this.now());
    if (whole.action === "deny") return { result: { status: "denied", reason: whole.reason } };
    if (whole.action === "ask" && !approved) return this.ask(u, "groupclaim", { items, ...(who.ak ? { agentId: who.ak.id } : {}) }, `One link with private claims totalling ${usd(total)}: ${items.map((i) => `${usd(Number(i.amountUsd))} for ${i.receiver}`).join("; ")}`, whole.reason);
    const entries: { receiver: string; chain: string; claimKey: string }[] = [];
    for (const it of items) {
      const r = await this.claim(u, { amountUsd: it.amountUsd, receiver: it.receiver, ...(it.chain ? { chain: it.chain } : {}) }, ctx, true, who);
      const link = (r.card as { link?: string } | undefined)?.link ?? String(r.result["claimLink"] ?? "");
      if (!link) return { result: { status: "partial", created: entries.length, reason: String(r.result["reason"] ?? "a claim could not be created") } };
      entries.push({ receiver: it.receiver, chain: (it.chain ?? "near").toLowerCase(), claimKey: link.split("/c/")[1]! });
    }
    const gid = id();
    (u.groups ??= []).unshift({ id: gid, at: this.now(), entries }); u.groups.length = Math.min(u.groups.length, 50); this.store.save();
    const link = `${ctx.origin}/g/${gid}`;
    return { result: { status: "created", groupLink: link, wallets: entries.length, total: usd(total), rule: "Each wallet opens the link, enters its own address and claims only its own amount within 24 hours; anything unclaimed comes back to the agent wallet." }, card: { kind: "groupclaim", link, total, rows: items.map((i) => ({ to: i.receiver, amount: usd(Number(i.amountUsd)), chain: (i.chain ?? "near").toUpperCase() })) } };
  }

  /** Repeats a whole group payout every day, week or month. Each run follows the rules like any other payment. */
  async scheduleGroup(u: UserRec, items: GroupItem[], every: "day" | "week" | "month"): Promise<Out> {
    this.active(u);
    if (!(every in EVERY_MS)) throw new MoopayError("INVALID_INPUT", "every must be day, week or month");
    if (items.length < 2 || items.length > MAX_GROUP) throw new MoopayError("INVALID_INPUT", `a group payout takes 2 to ${MAX_GROUP} receivers`);
    let total = 0;
    for (const it of items) { this.validate(it.chain.toLowerCase(), it.recipient); total += await this.itemUsd(it); }
    const t: Task = { id: id(), amountUsd: total, chain: "multi", recipient: `${items.length} wallets`, items, every, nextAt: this.now() + EVERY_MS[every], text: `${usd(total)} to ${items.length} wallets every ${every}` };
    u.tasks.push(t); this.store.save();
    return { result: { status: "scheduled", id: t.id, text: t.text, firstRun: new Date(t.nextAt).toISOString() }, card: { kind: "note", text: "Scheduled: " + t.text } };
  }
  cancel(u: UserRec, taskId: string): Out { u.tasks = u.tasks.filter((t) => t.id !== taskId); this.store.save(); return { result: { status: "cancelled" } }; }

  private ask(u: UserRec, kind: Approval["kind"], params: Record<string, unknown>, summary: string, reason: string): Out {
    const a: Approval = { id: id(), kind, params, summary, reason, createdAt: this.now(), status: "pending" };
    u.approvals.push(a); this.store.save();
    return { result: { status: "needs_approval", approvalId: a.id, reason, note: "An approval card was shown. Tell the user briefly why and wait." }, card: approvalCard(a) };
  }

  async resolve(u: UserRec, approvalId: string, yes: boolean, ctx: Ctx): Promise<Out> {
    this.active(u);
    const a = u.approvals.find((x) => x.id === approvalId);
    if (!a || a.status !== "pending") throw new MoopayError("NOTE_NOT_FOUND", "that approval is not pending");
    if (this.now() - a.createdAt > APPROVAL_TTL) { a.status = "expired"; this.store.save(); throw new MoopayError("NOTE_EXPIRED", "that approval expired; ask again"); }
    a.status = yes ? "approved" : "declined"; this.store.save();
    if (!yes) return { result: { status: "declined" }, card: { kind: "note", text: "Cancelled. Nothing was sent." } };
    const ak = u.agents.find((x) => x.id === a.params["agentId"]);
    if (a.kind === "send") return this.send(u, a.params as unknown as SendParams, true, { ak });
    if (a.kind === "groupclaim") return this.groupClaim(u, a.params["items"] as never, ctx, true, { ak });
    if (a.kind === "batch") return this.sendMany(u, a.params["items"] as GroupItem[], true, { ak }, ctx);
    if (a.kind === "claim") return this.claim(u, a.params as { amountUsd: string; receiver: string }, ctx, true, { ak });
    if (a.kind === "withdraw") return this.withdraw(u, a.params as never, true);
    if (a.kind === "stake") return this.stakeRnear(u, a.params as never, true);
    return this.rules(u, a.params as Partial<Rules>, true);
  }

  /* ---- agent keys: a leash for outside AI agents (and short sessions) ---- */
  createAgent(u: UserRec, p: { name: string; dailyUsd?: number; perPaymentUsd?: number; totalUsd?: number; hours?: number; chains?: string[]; assets?: string[]; recipients?: string[]; ips?: string[] }): Out {
    this.active(u);
    if (u.agents.filter((a) => !a.revoked).length >= 10) throw new MoopayError("INVALID_INPUT", "10 active agent keys is the limit; revoke one first");
    const key = "mpk_" + randomBytes(24).toString("base64url");
    const lower = (v?: string[]) => (v?.length ? v.map((x) => x.trim().toLowerCase()) : undefined);
    const ak: AgentKey = {
      id: id(), name: p.name.trim().slice(0, 40), hash: hashKey(key), prefix: key.slice(0, 9), createdAt: this.now(), spent: { day: today(this.now()), usd: 0 }, totalSpent: 0,
      ...(p.dailyUsd ? { dailyUsd: p.dailyUsd } : {}), ...(p.perPaymentUsd ? { perPaymentUsd: p.perPaymentUsd } : {}), ...(p.totalUsd ? { totalUsd: p.totalUsd } : {}),
      expiresAt: this.now() + (p.hours ?? AGENT_KEY_DEFAULT_HOURS) * 3_600_000, // a key always ends: 7 days unless the user picks another time
      ...(p.ips?.length ? { ips: p.ips.map((x) => x.trim()) } : {}),
      ...(lower(p.chains) ? { chains: lower(p.chains)! } : {}), ...(p.assets?.length ? { assets: p.assets.map((x) => x.trim().toUpperCase()) } : {}), ...(p.recipients?.length ? { recipients: p.recipients.map((x) => x.trim()) } : {}),
    };
    u.agents.push(ak); this.store.save();
    return { result: { status: "created", agentId: ak.id, note: "The key is shown on a card (once). Never repeat the key in your reply; tell the user to copy it and give it to their agent." }, card: { kind: "agentkey", ...this.agentView(ak), key } };
  }
  private agentView(ak: AgentKey) {
    const r = remaining(ak, this.now());
    return { id: ak.id, name: ak.name, prefix: ak.prefix, dailyUsd: ak.dailyUsd ?? null, perPaymentUsd: ak.perPaymentUsd ?? null, totalUsd: ak.totalUsd ?? null, leftToday: r.today, leftTotal: r.total, ips: ak.ips ?? null, chains: ak.chains ?? null, assets: ak.assets ?? null, recipients: ak.recipients ?? null, expiresAt: ak.expiresAt ? new Date(ak.expiresAt).toISOString() : null, revoked: !!ak.revoked, expired: !!ak.expiresAt && this.now() > ak.expiresAt };
  }
  listAgents(u: UserRec): Out { const items = u.agents.map((a) => this.agentView(a)); return { result: { items }, card: { kind: "agents", items } }; }
  revokeAgent(u: UserRec, agentId: string): Out {
    const ak = u.agents.find((a) => a.id === agentId || a.name.toLowerCase() === agentId.toLowerCase());
    if (!ak) throw new MoopayError("NOTE_NOT_FOUND", "no agent key with that id or name");
    ak.revoked = true; this.store.save();
    return { result: { status: "revoked", name: ak.name }, card: { kind: "note", text: `Revoked ${ak.name}. It can no longer send or claim.` } };
  }

  /* ---- Rhea: stake into rNEAR (liquid staking), from any money the wallet holds ---- */
  /** Makes sure the wallet holds `need` plus room for the staking gas as plain NEAR, converting wNEAR or stablecoins quietly. */
  private async ensureNear(u: UserRec, need: bigint): Promise<void> {
    const target = need + STAKE_GAS_ROOM;
    let b = await this.balances(u);
    if (b.nat >= target || !b.nearA?.priceUsd) { if (b.nat < target) throw new MoopayError("NOTE_NOT_FUNDED", `Your balance is $${b.totalUsd.toFixed(2)} but this needs more. Add money and try again.`); return; }
    const k = this.store.keyOf(u);
    const unwrap = async (amount: bigint) => {
      await this.near.call({ accountId: k.accountId, secretKey: k.secretKey, contractId: WRAP, method: "near_withdraw", args: { amount: amount.toString() }, deposit: 1n, gas: 30n * 10n ** 12n });
      for (let i = 0; i < 10 && (await this.near.nearBalance(u.accountId)) < b.nat + amount / 2n; i++) await new Promise((res) => setTimeout(res, this.pollMs));
    };
    let short = target - b.nat; short += short / 50n;
    if (b.wnear > 0n) { const take = b.wnear < short ? b.wnear : short; await unwrap(take); short -= take; }
    const price = b.nearA.priceUsd, nearAssetId = b.nearA.assetId;
    for (const [asset, have] of [[b.usdc, b.tok], [b.usdtA, b.usdt]] as const) {
      if (short <= 0n || !asset || have <= 0n) continue;
      const usdUnits = BigInt(Math.ceil((Number(short) / 1e24) * price * 10 ** asset.decimals * 1.02)) + 1n;
      const take = have < usdUnits ? have : usdUnits;
      await this.swapAsset(u, asset, nearAssetId, take);
      b = await this.balances(u);
      if (b.wnear > 0n) { await unwrap(b.wnear); }
      short = target - (await this.near.nearBalance(u.accountId));
    }
    if ((await this.near.nearBalance(u.accountId)) < target) throw new MoopayError("NOTE_NOT_FUNDED", `Your balance is $${b.totalUsd.toFixed(2)} but this needs more. Add money and try again.`);
  }

  async stakeRnear(u: UserRec, p: { amount?: string | undefined; amountUsd?: string | undefined }, approved = false, who: Who = {}): Promise<Out> {
    this.active(u);
    const payout = u.rules.payoutAddress;
    if (!payout) throw new MoopayError("INVALID_INPUT", "Set your payout wallet first (tell me your own NEAR wallet). Your rNEAR is sent there, so you hold it yourself.");
    const b = await this.balances(u);
    const nearUsd = b.nearA?.priceUsd;
    if (!nearUsd) throw new MoopayError("QUOTE_FAILED", "I couldn't get a NEAR price right now. Try again in a moment.");
    const nearAmt = p.amount ? parseDecimal(p.amount, 24) : p.amountUsd ? BigInt(Math.round((Number(p.amountUsd) / nearUsd) * 1e6)) * 10n ** 18n : 0n;
    if (nearAmt < STAKE_MIN_NEAR) throw new MoopayError("INVALID_INPUT", "give an amount of at least 0.1 NEAR (amount) or its dollar value (amountUsd)");
    const amt = Math.round((Number(nearAmt) / 1e24) * nearUsd * 100) / 100;
    const denied = this.blocked(u, who, amt, "near", "RNEAR", payout);
    if (denied) return { result: { status: "denied", reason: denied } };
    const d = decide(u, amt, this.recipientKey("near", payout), this.now());
    if (d.action === "deny") return { result: { status: "denied", reason: d.reason, hint: "The user can raise the limit with update_rules (needs their approval)." } };
    const price = await rnearPrice((c, m) => this.near.view(c, m) as Promise<unknown>);
    const shown = fmt(nearAmt, 24, 4);
    const expected = fmt((nearAmt * 10n ** 24n) / price, 24, 4);
    const summary = (who.ak ? `${who.ak.name}: ` : "") + `Stake ${shown} NEAR (about ${usd(amt)}) into rNEAR on Rhea; rNEAR goes to ${payout}`;
    if (d.action === "ask" && !approved) return this.ask(u, "stake", { amount: fmt(nearAmt, 24, 24), ...(who.ak ? { agentId: who.ak.id } : {}) }, summary, d.reason);
    await this.ensureNear(u, nearAmt);
    const k = this.store.keyOf(u);
    const before = await this.near.ftBalance(RNEAR, u.accountId);
    if (!(await this.near.storageRegistered(RNEAR, u.accountId))) await this.near.call({ accountId: k.accountId, secretKey: k.secretKey, contractId: RNEAR, method: "storage_deposit", args: { account_id: u.accountId, registration_only: true }, deposit: 1_250_000_000_000_000_000_000n, gas: 30n * 10n ** 12n });
    const tx = await this.near.call({ accountId: k.accountId, secretKey: k.secretKey, contractId: RNEAR, method: "deposit_and_stake", args: {}, deposit: nearAmt, gas: STAKE_GAS });
    const pay: Payment = { id: id(), kind: "stake", amountUsd: amt, chain: "near", recipient: payout, status: "STAKED", createdAt: this.now(), txHash: tx.txHash, settled: true, expected: `${expected} rNEAR`, ...(who.ak ? { agentId: who.ak.id } : {}) };
    this.spend(u, amt, this.recipientKey("near", payout), who.ak);
    u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.store.save();
    const got = (await this.near.ftBalance(RNEAR, u.accountId)) - before;
    const sent = got > 0n ? await this.forwardRnear(u) : undefined;
    const apy = await rnearApy();
    return { result: { status: "staked", staked: `${shown} NEAR`, receives: `about ${expected} rNEAR`, to: payout, delivered: Boolean(sent), ...(apy ? { apyPercent: apy } : {}), note: sent ? "rNEAR is in the user's own wallet; to unstake they use Rhea's page" : "rNEAR is in the agent wallet and will be forwarded to the payout wallet shortly" }, card: { kind: "stake", staked: shown, rnear: expected, to: payout, apy, tx: EXPLORER.near + tx.txHash, link: RNEAR_APP } };
  }

  /** Sends any rNEAR the agent wallet holds on to the user's own payout wallet (also used by the worker as a safety net). */
  async forwardRnear(u: UserRec): Promise<bigint | undefined> {
    const payout = u.rules.payoutAddress;
    if (!payout) return undefined;
    const bal = await this.near.ftBalance(RNEAR, u.accountId);
    if (bal <= 0n) return undefined;
    const k = this.store.keyOf(u);
    await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: RNEAR, to: payout, amount: bal });
    return bal;
  }

  /** What the user has in rNEAR (in their own wallet), its value, and the current yield. */
  async rnearPosition(u: UserRec): Promise<Out> {
    const payout = u.rules.payoutAddress;
    const [price, apy, b] = await Promise.all([rnearPrice((c, m) => this.near.view(c, m) as Promise<unknown>), rnearApy(), this.balances(u)]);
    const held = payout ? await this.near.ftBalance(RNEAR, payout) : 0n;
    const inAgent = await this.near.ftBalance(RNEAR, u.accountId);
    const total = held + inAgent;
    const nearValue = (total * price) / 10n ** 24n;
    const usdValue = b.nearA?.priceUsd ? (Number(nearValue) / 1e24) * b.nearA.priceUsd : undefined;
    const data = { rnear: fmt(total, 24, 4), worthNear: fmt(nearValue, 24, 4), ...(usdValue !== undefined ? { worthUsd: usdValue.toFixed(2) } : {}), priceNearPerRnear: fmt(price, 24, 4), ...(apy ? { apyPercent: apy } : {}), wallet: payout ?? null, unstakeAt: RNEAR_APP };
    return { result: data, card: { kind: "position", ...data } };
  }

  /* ---- status & activity ---- */
  activity(u: UserRec, limit = 8): Out {
    const items = u.payments.slice(0, Math.min(limit, 20)).map((p) => ({ id: p.id, kind: p.kind, amountUsd: p.amountUsd, to: p.recipient, chain: p.chain, status: p.status, at: new Date(p.createdAt).toISOString(), ...(p.claimLink ? { claimLink: p.claimLink } : {}) }));
    return { result: { items }, card: { kind: "list", items } };
  }

  /** Looks at 1Click / the claim desk; returns what changed so the worker can tell the user. */
  async refresh(u: UserRec, p: Payment, ctx: Ctx): Promise<{ changed: boolean; link?: string }> {
    if (p.settled) return { changed: false };
    const before = p.status;
    let link: string | undefined;
    if (p.payId && !p.depositAddress) {
      try { const s = await this.svc.payStatus(p.payId); if ("depositAddress" in s) p.depositAddress = s.depositAddress; }
      catch { p.status = "EXPIRED"; p.settled = true; }
    }
    if (p.kind === "claim" && p.fundKey) {
      const s = await this.svc.claimFundState(p.fundKey, ctx.origin);
      const map: Record<string, string> = { CLAIMED: "CLAIMED", REFUNDED: "REFUNDED", CANCELLED: "REFUNDED" };
      if (map[s.state]) { p.status = map[s.state]!; p.settled = true; }
    } else if (p.depositAddress) {
      const s = (await this.svc.oneClickClient.status(p.depositAddress)) as { status: string; swapDetails?: { destinationChainTxHashes?: { hash: string }[] } };
      const hash = s.swapDetails?.destinationChainTxHashes?.[0]?.hash;
      if (s.status === "SUCCESS") { p.status = "DELIVERED"; p.settled = true; if (hash) link = (EXPLORER[p.chain] ?? "") + hash; this.svc.publicStatsStore?.record(p.depositAddress, p.amountUsd, u.accountId); }
      else if (s.status === "REFUNDED" || s.status === "FAILED") { p.status = s.status; p.settled = true; }
      else p.status = s.status;
    }
    if (p.status !== before) this.store.save();
    return { changed: p.status !== before, ...(link ? { link } : {}) };
  }

  async status(u: UserRec, paymentId: string, ctx: Ctx): Promise<Out> {
    const p = u.payments.find((x) => x.id === paymentId);
    if (!p) throw new MoopayError("NOTE_NOT_FOUND", "no payment with that id");
    const r = await this.refresh(u, p, ctx);
    return { result: { id: p.id, status: p.status, ...(r.link ? { transaction: r.link } : {}) }, card: { kind: "payment", id: p.id, amountUsd: p.amountUsd, chain: p.chain, recipient: p.recipient, status: p.status, tx: r.link } };
  }


  /* ---- withdraw: the user's money is always theirs to take back ---- */
  async withdraw(u: UserRec, p: { amountUsd?: string | undefined; asset?: "USDC" | "NEAR" | undefined; to?: string | undefined }, approved = false): Promise<Out> {
    this.active(u);
    const to = p.to ?? u.rules.payoutAddress;
    if (!to) throw new MoopayError("INVALID_INPUT", "Tell me your own NEAR wallet first, then I can send your money there.");
    if (!isNearAccountId(to)) throw new MoopayError("BAD_RECIPIENT", "withdrawals go to a NEAR wallet; to reach another chain, use a payment instead");
    const asset = p.asset ?? "USDC";
    if (to !== u.rules.payoutAddress && !approved)
      return this.ask(u, "withdraw", { ...p, to }, `Withdraw ${asset === "NEAR" ? "your NEAR" : p.amountUsd ? usd(Number(p.amountUsd)) : "everything"} to ${to}`, "a wallet that isn't your payout wallet");
    const b = await this.balances(u);
    const k = this.store.keyOf(u);
    let r: { txHash: string }; let shown: number;
    if (asset === "NEAR") {
      if (b.nat <= KEEP_NEAR) throw new MoopayError("NOTE_NOT_FUNDED", "There isn't any spare NEAR to withdraw.");
      const amount = b.nat - KEEP_NEAR;
      r = await this.near.sendNear({ accountId: k.accountId, secretKey: k.secretKey, to, amount }); shown = Number(fmt(amount, 24, 4));
    } else {
      const units = p.amountUsd ? parseDecimal(p.amountUsd, b.usdc.decimals) : b.tok;
      if (units <= 0n || units > b.tok) throw new MoopayError("NOTE_NOT_FUNDED", `Your agent wallet holds $${fmt(b.tok, b.usdc.decimals, 2)}.`);
      if (b.nat < MIN_GAS) throw new MoopayError("NOTE_NOT_FUNDED", "Your agent wallet needs a little NEAR to pay the transfer fee. Send about 0.05 NEAR to it first.");
      r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: b.usdc.contract, to, amount: units }); shown = Number(fmt(units, b.usdc.decimals, 2));
    }
    const pay: Payment = { id: id(), kind: "withdraw", amountUsd: asset === "NEAR" ? 0 : shown, chain: "near", recipient: to, status: "DELIVERED", createdAt: this.now(), txHash: r.txHash, settled: true };
    u.payments.unshift(pay); this.store.save();
    return { result: { status: "sent", sent: asset === "NEAR" ? `${shown} NEAR` : usd(shown), to }, card: { kind: "payment", id: pay.id, amountUsd: shown, chain: "near", recipient: to, status: "DELIVERED", tx: EXPLORER.near + r.txHash, unit: asset === "NEAR" ? "NEAR" : undefined } };
  }

  /* ---- add money from any chain: 1Click turns it into USDC in the agent wallet ---- */
  private async originAsset(chain: string, symbol: string | undefined, amountUsd: string) {
    const want = (symbol ?? NATIVE[chain] ?? "").toUpperCase();
    const t = (await this.svc.oneClickClient.tokens()).find((x) => x.blockchain === chain && x.symbol.toUpperCase() === want);
    if (!t) throw new MoopayError("UNKNOWN_ASSET", `${want || "that asset"} on ${chain} is not supported; try list_supported_assets`);
    if (!t.price || t.price <= 0) throw new MoopayError("QUOTE_FAILED", `no price for ${want} right now`);
    const micro = parseDecimal(amountUsd, 6);
    const priceMicro = BigInt(Math.round(t.price * 1e6));
    const units = (micro * 10n ** BigInt(t.decimals) + priceMicro - 1n) / priceMicro;
    return { token: t, units };
  }
  private checkRefund(chain: string, addr: string) {
    if (chain === "sol" || chain === "eth" || chain === "btc") assertRecipient(chain, addr);
    else if (!addr || addr.length > 128) throw new MoopayError("BAD_RECIPIENT", "that refund address does not look right");
  }
  private depositCard(address: string, units: bigint, t: { symbol: string; decimals: number }, chain: string, quote: { deadline?: string | undefined; depositMemo?: string | undefined }, expected: string, note: string) {
    return { kind: "deposit", address, amount: fmt(units, t.decimals, 8), symbol: t.symbol, chain, expires: quote.deadline, memo: quote.depositMemo, expected, note };
  }

  async fundWallet(u: UserRec, p: { amountUsd: string; fromChain: string; fromSymbol?: string | undefined; refundAddress: string }): Promise<Out> {
    const chain = p.fromChain.toLowerCase();
    this.checkRefund(chain, p.refundAddress);
    const usdc = await this.svc.usdcAsset();
    const { token } = await this.originAsset(chain, p.fromSymbol, p.amountUsd);
    // The wallet receives the whole amount; the fees are added to what the user sends.
    const req: QuoteRequest = { dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: token.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: usdc.assetId, amount: parseDecimal(p.amountUsd, usdc.decimals).toString(), recipient: u.accountId, recipientType: "DESTINATION_CHAIN", refundTo: p.refundAddress, refundType: "ORIGIN_CHAIN", deadline: new Date(this.now() + 8 * 60_000).toISOString() };
    const q = (await this.svc.oneClickClient.quote(req)).quote;
    if (!q.depositAddress) throw new MoopayError("QUOTE_FAILED", "1Click returned no deposit address");
    const units = BigInt(q.amountIn ?? "0");
    const expected = `${fmt(parseDecimal(p.amountUsd, usdc.decimals), usdc.decimals, 2)} USDC`;
    u.payments.unshift({ id: id(), kind: "fund", amountUsd: Number(p.amountUsd), chain, recipient: u.accountId, status: "AWAITING_YOUR_DEPOSIT", createdAt: this.now(), depositAddress: q.depositAddress, expected });
    this.store.save();
    const card = this.depositCard(q.depositAddress, units, token, chain, { deadline: q.deadline, depositMemo: q.depositMemo }, expected, "Send exactly this amount from your own wallet. It arrives in your agent wallet as USDC.");
    return { result: { status: "awaiting_your_deposit", sendExactly: `${card["amount"]} ${token.symbol}`, to: q.depositAddress, arrives: expected, expires: q.deadline, ...(q.depositMemo ? { memo: q.depositMemo } : {}) }, card };
  }

  /* ---- pay without depositing: the user pays straight from their own wallet ---- */
  async payFromWallet(u: UserRec, p: { amountUsd: string; fromChain: string; fromSymbol?: string | undefined; refundAddress: string; toChain: string; recipient: string; toSymbol?: string | undefined }): Promise<Out> {
    const from = p.fromChain.toLowerCase(), to = p.toChain.toLowerCase();
    if (to !== "btc" && to !== "sol" && to !== "eth") throw new MoopayError("INVALID_INPUT", "paying from your own wallet can go to btc, sol or eth");
    this.checkRefund(from, p.refundAddress); this.validate(to, p.recipient);
    const { token } = await this.originAsset(from, p.fromSymbol, p.amountUsd);
    const dest = await this.destAsset(to, p.toSymbol);
    const price = (dest as { price?: number }).price;
    const out = /^US(DC|DT)$/i.test(dest.symbol) ? parseDecimal(p.amountUsd, dest.decimals) : price ? BigInt(Math.ceil((Number(p.amountUsd) / price) * 10 ** Math.min(dest.decimals, 12))) * 10n ** BigInt(Math.max(dest.decimals - 12, 0)) : 0n;
    if (out <= 0n) throw new MoopayError("QUOTE_FAILED", `I couldn't price ${dest.symbol} right now.`);
    const q = (await this.svc.directQuote({ originAssetId: token.assetId, amount: out.toString(), exactOutput: true, refundTo: p.refundAddress, destinationChain: to as DestChain, destinationAssetId: dest.assetId, recipient: p.recipient, slippageBps: 100, dryRun: false })) as { amountIn: string; depositAddress: string; depositMemo?: string; quoteExpiresAt?: string; expectedOutput?: { amountOut?: string } };
    const units = BigInt(q.amountIn);
    const expected = `${fmt(out, dest.decimals)} ${dest.symbol}`;
    u.payments.unshift({ id: id(), kind: "send", amountUsd: Number(p.amountUsd), chain: to, recipient: p.recipient, status: "AWAITING_YOUR_DEPOSIT", createdAt: this.now(), depositAddress: q.depositAddress, expected });
    this.store.save();
    const card = this.depositCard(q.depositAddress, units, token, from, { deadline: q.quoteExpiresAt, depositMemo: q.depositMemo }, `${p.recipient.slice(0, 8)}… gets exactly ${expected}`, "Send exactly this amount from your own wallet. MooPay holds nothing: it goes straight to the receiver.");
    return { result: { status: "awaiting_your_deposit", sendExactly: `${card["amount"]} ${token.symbol}`, to: q.depositAddress, receiverGets: expected, expires: q.quoteExpiresAt, ...(q.depositMemo ? { memo: q.depositMemo } : {}) }, card };
  }

  /** A link the user opens to sign in their own NEAR wallet (Meteor, Nightly...). No deposit, no stored money. */
  async paymentLink(p: { amountUsd: string; toChain: string; recipient: string; toSymbol?: string | undefined }, ctx: Ctx): Promise<Out> {
    const to = p.toChain.toLowerCase();
    if (to !== "btc" && to !== "sol" && to !== "eth") throw new MoopayError("INVALID_INPUT", "payment links can go to btc, sol or eth");
    this.validate(to, p.recipient);
    const dest = await this.destAsset(to, p.toSymbol);
    const r = (await this.svc.route({ destinationChain: to, destinationAssetId: dest.assetId, recipient: p.recipient, payAmount: p.amountUsd }, { payLinkPrefix: `${ctx.origin}/p` })) as { payLink: string };
    return { result: { status: "link_ready", payLink: r.payLink, note: "They open it, pick USDC, USDT or NEAR, press Send and sign in their NEAR wallet." }, card: { kind: "link", title: `Pay ${usd(Number(p.amountUsd))} from your own wallet`, url: r.payLink, button: "Open to sign", note: "Opens a page where you pick what to pay with and sign in your NEAR wallet. Nothing is stored here." } };
  }

  /* ---- gas sponsor: lets people with no NEAR start (capped, optional) ---- */
  async sponsorGas(u: UserRec, tok: bigint, nat: bigint): Promise<boolean> {
    const s = this.sponsor;
    if (!s || u.sponsoredAt || nat >= LOW_GAS || tok < 1_000_000n) return false;
    const day = today(this.now());
    if (this.store.all().filter((x) => x.sponsoredAt && today(x.sponsoredAt) === day).length >= s.dailyMax) return false;
    u.sponsoredAt = this.now();
    try { await this.near.sendNear({ accountId: s.accountId, secretKey: s.secretKey, to: u.accountId, amount: SPONSOR_AMOUNT }); }
    catch { u.sponsoredAt = undefined; void alertOwner("sponsor-failed", "the gas sponsor could not send a top-up. Its balance may be empty.", this.now()); return false; }
    this.store.save();
    const used = this.store.all().filter((x) => x.sponsoredAt && today(x.sponsoredAt) === day).length;
    if (used >= s.dailyMax * 0.8) void alertOwner("sponsor-daily", `the gas sponsor used ${used} of its ${s.dailyMax} daily top-ups. Is someone farming new accounts?`, this.now());
    void this.near.nearBalance(s.accountId).then((b) => { if (b < SPONSOR_LOW) void alertOwner("sponsor-low", `the gas sponsor wallet is running low (${(Number(b) / 1e24).toFixed(2)} NEAR left).`, this.now()); }).catch(() => undefined);
    return true;
  }

  /* ---- worker steps ---- */
  /** Sends anything above the float to the user's own payout wallet. */
  async sweep(u: UserRec): Promise<Payment | undefined> {
    if (!u.rules.payoutAddress) return undefined;
    const usdc = await this.svc.usdcAsset();
    const [tok, nat] = await Promise.all([this.near.ftBalance(usdc.contract, u.accountId), this.near.nearBalance(u.accountId)]);
    const floatUnits = parseDecimal(u.rules.floatUsd.toFixed(2), usdc.decimals);
    const margin = parseDecimal("1", usdc.decimals);
    if (tok <= floatUnits + margin || nat < MIN_GAS) return undefined;
    const excess = ((tok - floatUnits) / 10_000n) * 10_000n; // whole cents
    const k = this.store.keyOf(u);
    const r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: usdc.contract, to: u.rules.payoutAddress, amount: excess });
    const pay: Payment = { id: id(), kind: "sweep", amountUsd: Number(fmt(excess, usdc.decimals, 2)), chain: "near", recipient: u.rules.payoutAddress, status: "DELIVERED", createdAt: this.now(), txHash: r.txHash, settled: true };
    u.payments.unshift(pay); this.store.save();
    return pay;
  }
}

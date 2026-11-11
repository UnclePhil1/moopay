import { randomBytes } from "node:crypto";
import { assertRecipient, type DestChain } from "./addresses.js";
import type { QuoteRequest } from "./intents/oneclick.js";
import { MoopayError, asMoopayError } from "../util/errors.js";
import { isNearAccountId, parseDecimal } from "./pay.js";
import { isClaimChain, validAddress } from "./chains/index.js";
import { RNEAR, STAKE_GAS, STAKE_MIN_NEAR, rnearApy, rnearPrice, unstaking, WRAP } from "./rhea.js";
import { preflight, type Preflight } from "./preflight.js";
import { OutLayerError, type OutLayer } from "./outlayer.js";
import { swapServiceMessage } from "../util/friendly.js";
import type { MooPayService } from "./service.js";
import { alertOwner } from "../util/alert.js";
import { agentDeny, decide, earnPoints, nameProblem, PAYOUT_HOLD_MS, recipientKey, remaining, rulesNeedApproval, scopeDeny, spentToday, today } from "./policy.js";
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
  /** true: through the private route (beta). false: the normal route. Unset: the user's setting. */
  private?: boolean | undefined;
}

const MAX_GROUP = 20;
const NATIVE: Record<string, string> = { sol: "SOL", eth: "ETH", btc: "BTC" };
const EXPLORER: Record<string, string> = { sol: "https://solscan.io/tx/", eth: "https://etherscan.io/tx/", btc: "https://mempool.space/tx/", near: "https://nearblocks.io/txns/" };
/** The agent wallet holds money but no NEAR to pay its first network fee (and no sponsor topped it up). */
class NeedsFee extends MoopayError {
  constructor(address: string) { super("NOTE_NOT_FUNDED", `Your agent wallet needs a little NEAR for network fees. Send about 0.05 NEAR to ${address} and I will finish.`); }
}
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
/** The NEAR account that creates the named wallets (name.<accountId>). Both values must be set for names to work. */
export interface NameParent { accountId: string; secretKey: string }
/** Funds a new named account: enough for its storage and a first small fee. */
const NAME_DEPOSIT = 5_000_000_000_000_000_000_000n; // 0.005 NEAR
const NAME_STORAGE_USDC = 1_250_000_000_000_000_000_000n; // NEP-145 registration so USDC can be sent to the new name
const SPONSOR_AMOUNT = 50_000_000_000_000_000_000_000n; // 0.05 NEAR, enough for a few dozen transfers
const AGENT_KEY_DEFAULT_HOURS = 24 * 7;
/** A private payment waits this long for its money to show in the private balance before it is given up on. */
const PRIVATE_FUND_WAIT = 45 * 60_000;
const ADVANCE = 50_000_000_000_000_000_000_000n; // 0.05 NEAR lent to a wallet that holds wNEAR but no NEAR; paid back out of that wallet once it has staked
const SPONSOR_LOW = 2_000_000_000_000_000_000_000_000n; // alert below 2 NEAR
const LOW_GAS = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
const KEEP_NEAR = 5_000_000_000_000_000_000_000n;
const STAKE_GAS_ROOM = 100_000_000_000_000_000_000_000n; // 0.1 NEAR must sit in the wallet while staking (200 Tgas is prepaid at 0.02 NEAR); the unused gas comes back
const SWAP_WAIT = 20 * 60_000, SWAP_GIVE_UP = 2 * 3_600_000;
interface SwapStatus { status: string; swapDetails?: { amountInUsd?: string } }
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
  return { kind: "approval", id: a.id, summary: a.summary, reason: a.reason, details: rows.filter((r): r is [string, string] => Boolean(r[1])), ...(a.pf ? { preflight: a.pf } : {}) };
}

export class AgentOps {
  constructor(private readonly svc: MooPayService, private readonly store: AgentStore, private readonly now: () => number = Date.now, private readonly sponsor?: Sponsor, private readonly names?: NameParent, private readonly pr?: OutLayer) {}
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

  /** What the wallet holds, and how much to add so a payment of `need` dollars (fees included) can go, with the same 2% cushion canPay asks for. */
  private async gap(u: UserRec, need: number): Promise<{ have: number; need: number; add: number; short: boolean; gas: boolean }> {
    const b = await this.balances(u), have = b.totalUsd, want = Math.ceil(need * 1.02 * 100) / 100;
    // Enough money, but no NEAR to pay the network fee and no sponsor to lend it: the payment cannot go either.
    const gas = have >= want && b.nat < MIN_GAS && !this.sponsor;
    return { have, need: want, add: Math.max(0.01, Math.ceil((want - have) * 100) / 100), short: have < want, gas };
  }
  /** Why the agent wallet cannot pay this, in words the user can act on; the first part names the real shortage. */
  private why(u: UserRec, g: { have: number; need: number; add: number; gas: boolean }): string {
    return g.gas
      ? `Your agent wallet has ${usd(g.have)}, which covers this, but it holds no NEAR to pay the network fee. Send about 0.05 NEAR to ${u.accountId} and try again.`
      : `Your agent wallet has ${usd(g.have)}, and this needs about ${usd(g.need)} with fees. Add about ${usd(g.add)} more and try again (say "add ${usd(g.add)}" and I'll show you how).`;
  }
  private async lack(u: UserRec, need: number): Promise<string> { return this.why(u, await this.gap(u, need)); }
  /** Fee and total lines for a card; nothing when the fee is not known yet. */
  private feeFields(amt: number, fee?: number) { return fee === undefined ? {} : { fees: fee >= 0.005 ? usd(fee) : "none added", total: usd(amt + (fee >= 0.005 ? fee : 0)), feeUsd: fee }; }

  /** If a payment needs more USDC than the wallet holds, quietly swaps USDT, then spare NEAR, into USDC first. */
  private async ensureUsdc(u: UserRec, need: bigint): Promise<void> {
    let b = await this.balances(u);
    if (b.tok >= need) return;
    // A conversion already on its way finishes by itself, and starting another one would only split the money.
    if ((u.swaps ?? []).some((s) => this.now() - s.at < SWAP_WAIT)) throw new MoopayError("UPSTREAM_TIMEOUT", "I'm already converting your balance for a payment. It can take a few minutes, and I'll tell you in chat when it's done. Then ask me again.");
    let short = need - b.tok; short += short / 50n + 10_000n; // 2% + 1 cent for slippage
    if (b.usdtA && b.usdt > 0n) {
      const take = b.usdt < short ? b.usdt : short;
      await this.swapToUsdc(u, b.usdtA, take);
      short -= take;
    }
    if (short > 0n && b.nearA?.priceUsd) {
      const want = BigInt(Math.ceil((Number(short) / 10 ** b.usdc.decimals / b.nearA.priceUsd) * 1e6)) * 10n ** 18n;
      const spare = (b.nat > KEEP_GAS ? b.nat - KEEP_GAS : 0n) + b.wnear;
      if (spare < want) throw new MoopayError("NOTE_NOT_FUNDED", await this.lack(u, Number(need) / 10 ** b.usdc.decimals));
      const fromWrapped = b.wnear < want ? b.wnear : want;
      const toWrap = want - fromWrapped;
      if (toWrap > 0n) {
        const k = this.store.keyOf(u);
        await this.near.wrapNear({ accountId: k.accountId, secretKey: k.secretKey, wrapContract: b.nearA.contract, amount: toWrap });
        for (let i = 0; i < 10 && (await this.near.ftBalance(b.nearA.contract, u.accountId)) < want; i++) await new Promise((res) => setTimeout(res, this.pollMs)); // let the wrap settle on every RPC node
      }
      await this.swapToUsdc(u, b.nearA, want);
    } else if (short > 0n) throw new MoopayError("NOTE_NOT_FUNDED", await this.lack(u, Number(need) / 10 ** b.usdc.decimals));
    b = await this.balances(u);
    if (b.tok < need) throw new MoopayError("UPSTREAM_TIMEOUT", "I'm still converting your balance for this payment. Try again in a minute.");
  }
  private async swapToUsdc(u: UserRec, from: { assetId: string; contract: string }, units: bigint): Promise<void> {
    return this.swapAsset(u, from, (await this.svc.usdcAsset()).assetId, units);
  }
  /** Swaps one NEAR-chain asset into another inside the agent wallet, through 1Click, and waits for it to land. */
  private async swapAsset(u: UserRec, from: { assetId: string; contract: string }, destAssetId: string, units: bigint): Promise<void> {
    const usdc = { assetId: destAssetId };
    const req: QuoteRequest = { dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: from.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: usdc.assetId, amount: (units === 0n ? 1n : units).toString(), recipient: u.accountId, recipientType: "DESTINATION_CHAIN", refundTo: u.accountId, refundType: "ORIGIN_CHAIN", deadline: new Date(this.now() + 10 * 60_000).toISOString() };
    const q = (await this.svc.oneClickClient.quote(req)).quote;
    if (!q.depositAddress) throw new MoopayError("QUOTE_FAILED", "The swap service didn't give me an address to pay. Nothing was sent. Try again.");
    const k = this.store.keyOf(u);
    const move = () => this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: from.contract, to: q.depositAddress!, amount: units });
    // If the first try errors, look at the balance before trying again: it may have gone through and only the answer was lost, and a second try would pay the address twice.
    const before = await this.near.ftBalance(from.contract, u.accountId).catch(() => undefined);
    let txHash = "";
    try { txHash = (await move()).txHash; }
    catch (e) {
      await new Promise((res) => setTimeout(res, this.pollMs));
      const after = await this.near.ftBalance(from.contract, u.accountId).catch(() => undefined);
      if (!(before !== undefined && after !== undefined && before - after >= (units * 9n) / 10n)) txHash = (await move()).txHash;
    }
    (u.swaps ??= []).push({ addr: q.depositAddress, at: this.now() }); this.store.save();
    await this.svc.oneClickClient.submitDeposit(q.depositAddress, txHash).catch(() => undefined);
    for (let i = 0; i < this.polls; i++) {
      const st = await this.svc.oneClickClient.status(q.depositAddress).catch(() => undefined);
      if (st?.status === "SUCCESS" || st?.status === "REFUNDED" || st?.status === "FAILED") {
        this.endSwap(u, q.depositAddress, st as SwapStatus);
        if (st.status === "SUCCESS") return;
        throw new MoopayError("QUOTE_FAILED", "I couldn't convert your balance for this payment, and your money is back in your wallet. Try again.");
      }
      await new Promise((res) => setTimeout(res, this.pollMs));
    }
  }
  /** Takes a conversion off the watch list and, when it worked, notes it in the permanent ledger. */
  private endSwap(u: UserRec, addr: string, st: SwapStatus): void {
    u.swaps = (u.swaps ?? []).filter((s) => s.addr !== addr);
    if (st.status === "SUCCESS") this.store.note(u, { id: "swap-" + addr.slice(0, 16), kind: "swap", amountUsd: Number(st.swapDetails?.amountInUsd ?? 0) || 0, chain: "near", recipient: u.accountId, status: "DELIVERED", createdAt: this.now(), settled: true });
    this.store.save();
  }
  /**
   * Follows conversions that outlasted the wait. The swap service returns the money to the agent wallet by itself when one fails
   * (every quote names it as the refund address), so this only keeps track and says what happened.
   */
  async followSwaps(u: UserRec): Promise<string[]> {
    const said: string[] = [];
    for (const s of [...(u.swaps ?? [])]) {
      const st = (await this.svc.oneClickClient.status(s.addr).catch(() => undefined)) as SwapStatus | undefined;
      if (st?.status === "SUCCESS") { this.endSwap(u, s.addr, st); said.push("Your balance finished converting. You can ask me again now."); }
      else if (st?.status === "REFUNDED" || st?.status === "FAILED") { this.endSwap(u, s.addr, st); said.push("A conversion didn't go through, and the swap service sent your money back to your agent wallet."); }
      else if (this.now() - s.at > SWAP_GIVE_UP) { this.endSwap(u, s.addr, { status: "TIMEOUT" }); said.push("A conversion is taking much longer than usual. It's with the swap service, and if it can't finish your money comes back to your agent wallet on its own."); }
    }
    return said;
  }
  polls = 30; pollMs = 3000;

  private validate(chain: string, recipient: string): void {
    if (chain === "near") { if (!isNearAccountId(recipient)) throw new MoopayError("BAD_RECIPIENT", "That isn't a valid NEAR wallet address. It looks like alice.near."); }
    else if (chain === "btc" || chain === "sol" || chain === "eth") assertRecipient(chain as DestChain, recipient);
    else throw new MoopayError("INVALID_INPUT", "I can pay wallets on Bitcoin, Solana, Ethereum and NEAR. Which one is this for?");
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
      points: u.points ?? 0, spentToday: spentToday(u, this.now()), schedules: u.tasks.map((t) => ({ id: t.id, text: t.text })), pendingApprovals: u.approvals.filter((a) => a.status === "pending").length, setupSteps: todo,
    };
    return { result: { ...data, xLinked: u.x ? "@" + u.x.handle : null }, card: { kind: "account", ...data } };
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
      if (!p.amount) throw new MoopayError("INVALID_INPUT", "How much should I send? Say an amount, like $5.");
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
    let direct: "usdc" | "near" | "usdt" | undefined = chain === "near" && sym === "USDC" ? "usdc" : undefined;
    if (chain === "near" && sym === "USDT") { const b = await this.balances(u); if (b.usdtA && b.usdt >= destUnits && b.nat >= MIN_GAS) direct = "usdt"; }
    let nearUnits = 0n;
    if (nativeNear) {
      nearUnits = coinUnits ?? BigInt(Math.round((amt / price!) * 1e6)) * 10n ** 18n;
      if ((await this.balances(u)).nat >= nearUnits + MIN_GAS) direct = "near";
    }
    // The agent wallet is optional: it pays only when asked to, or when it already holds enough. Otherwise the user signs in their own wallet.
    const own = !who.ak && !!ctx && p.useAgentWallet !== true && (p.useAgentWallet === false || !!p.fromChain || !(await this.canPay(u, amt, direct, units)));
    const priv = p.private ?? !!u.rules.privateSends;
    if (priv) { const why = this.privateWhy(u, chain, dest.assetId === usdc.assetId); if (why) return { result: { status: "not_private", reason: why, hint: "Tell the user why. Send it the normal way only if they say so (call send_money again with private false)." } }; }
    // The fee a swap adds on top, when the route has one. Unknown (undefined) when it cannot be quoted yet.
    const feeEstimate = async (): Promise<number | undefined> => direct ? 0 : p.fromChain ? undefined : this.preview(u, usdc, destUnits, chain, { ...p, assetSymbol: sym, amountUsd: usdText }).then((q) => Math.max(0, q.payUsd - amt)).catch(() => undefined);
    if (priv && own) {
      const fee = (await feeEstimate()) ?? 0, g = await this.gap(u, amt + fee);
      return { result: { status: "not_private", reason: g.short || g.gas ? `Private send pays from the agent wallet. ${this.why(u, g)}` : "Private send pays from the agent wallet, so it can't use your own wallet.", hint: "Tell the user exactly this, and offer to show how to add money. Send it the normal way only if they say so (call send_money again with private false)." } };
    }
    if (own) {
      const fee = await feeEstimate();
      let notice: string | undefined;
      if (!p.fromChain && p.useAgentWallet === undefined) { const g = await this.gap(u, amt + (fee ?? 0)); if (g.short || g.gas) notice = `${this.why(u, g).replace(/ and try again.*$/, ".")} You can confirm below to pay from your own wallet now.`; }
      return this.ownWallet(u, { chain, sym, recipient: p.recipient, usdText, amt, what: coinUnits ? `${p.amount} ${sym}` : usd(amt), fromChain: p.fromChain, fromSymbol: p.fromSymbol, ...(fee !== undefined ? { fee } : {}), ...(notice ? { notice } : {}) }, ctx!);
    }
    const quote = direct ? undefined : await this.preview(u, usdc, destUnits, chain, { ...p, assetSymbol: sym, amountUsd: usdText });
    const expected = quote?.text;
    const denied = this.blocked(u, who, amt, chain, sym, p.recipient);
    if (denied) return { result: { status: "denied", reason: denied } };
    let d = decide(u, amt, key, this.now());
    if (d.action === "deny") return { result: { status: "denied", reason: d.reason, hint: "The user can raise the limit with update_rules (needs their approval)." } };
    const what = coinUnits ? `${p.amount} ${sym}` : usd(amt);
    const pf = approved ? undefined : await preflight(this.near, u, { chain, recipient: p.recipient, what, sym, receive: expected, private: priv, pay: usd(quote ? Math.max(quote.payUsd, amt) : amt), fees: quote && quote.payUsd - amt >= 0.005 ? usd(quote.payUsd - amt) : "none added" });
    if (pf?.missing) return { result: { status: "denied", reason: `${p.recipient} does not exist on NEAR, so money sent there could be lost. Ask the user to check the address.` } };
    if (pf?.warnings.length && d.action === "auto") d = { action: "ask", reason: pf.warnings[0]! };
    const summary = (who.ak ? `${who.ak.name}: ` : "") + `Send ${what} to ${p.recipient} on ${chain.toUpperCase()}${priv ? " through the private route" : ""}` + (expected ? ` (they get ${priv ? "about" : "exactly"} ${expected}; fees are added on top)` : "");
    if (d.action === "ask" && !approved) return this.ask(u, "send", { ...p, chain, private: priv, ...(who.ak ? { agentId: who.ak.id } : {}) }, summary, d.reason, pf);
    let pay: Payment;
    try {
      pay = priv ? await this.doPrivate(u, usdc, p, chain, sym, dest, destUnits, units, amt, who.ak) : direct === "near" ? await this.doSendNear(u, nearUnits, amt, p.recipient, who.ak) : direct === "usdt" ? await this.doSendToken(u, dest.contractAddress!, destUnits, amt, p.recipient, who.ak) : await this.doSend(u, usdc, units, amt, chain, { ...p, assetSymbol: sym, amountUsd: usdText }, expected, who.ak, direct === "usdc", destUnits);
    } catch (e) {
      // Short on the agent wallet after all (fees, a price move): hand over to the user's own wallet instead of failing.
      if (ctx && !who.ak && p.useAgentWallet !== true && asMoopayError(e).code === "NOTE_NOT_FUNDED") return this.ownWallet(u, { chain, sym, recipient: p.recipient, usdText, amt, what: coinUnits ? `${p.amount} ${sym}` : usd(amt) }, ctx);
      throw e;
    }
    return { result: { status: "sent", paymentId: pay.id, ...(expected ? { expected } : {}), note: pay.settled ? "delivered" : priv ? "on its way through the private route; it takes about a minute and I will tell the user when it lands" : "on its way; I will tell the user when it lands" }, card: this.paymentCard(pay) };
  }

  /* ---- group payouts: many receivers, chains and assets in one go ---- */
  /** Dollar value of one line, whatever it is written in. */
  private async itemUsd(it: GroupItem): Promise<number> {
    if (it.amountUsd) return Number(it.amountUsd);
    if (!it.amount) throw new MoopayError("INVALID_INPUT", `How much should ${it.recipient} get? Say an amount, like $5.`);
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
    let feeSum = 0;
    const had = new Set(u.payments.map((p) => p.id));
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const row = { to: it.recipient, chain: it.chain.toUpperCase(), amount: it.amountUsd ? usd(Number(it.amountUsd)) : `${it.amount} ${(it.assetSymbol ?? NATIVE[it.chain.toLowerCase()] ?? "").toUpperCase()}`.trim() };
      try {
        const r = await this.send(u, { chain: it.chain, recipient: it.recipient, ...(it.amountUsd ? { amountUsd: it.amountUsd } : { amount: it.amount }), ...(it.assetSymbol ? { assetSymbol: it.assetSymbol } : {}) }, true, who, ctx);
        const st = String(r.result["status"]);
        feeSum += (r.card as { feeUsd?: number } | undefined)?.feeUsd ?? 0;
        rows.push({ ...row, status: st === "sent" ? "sent" : st === "needs_your_signature" ? "needs your signature" : st, ...((r.card as { url?: string } | undefined)?.url ? { url: (r.card as { url: string }).url } : {}) });
      } catch (e) { rows.push({ ...row, status: "failed: " + asMoopayError(e).message }); }
    }
    for (const p of u.payments) if (!had.has(p.id)) p.tag = "group";
    const sent = rows.filter((r) => r.status === "sent").length;
    return { result: { status: "group_done", total: usd(total), sent, results: rows.map((r) => ({ to: r.to, status: r.status })), note: rows.some((r) => r.url) ? "Some lines show a Confirm button for the user to sign in their own wallet." : "Every line ran." }, card: { kind: "batch", title: `Group payout, ${usd(total)}`, rows, ...this.feeFields(total, feeSum) } };
  }

  /** Whether the agent wallet can pay this by itself, including the network fee. */
  private async canPay(u: UserRec, amt: number, direct: "usdc" | "near" | "usdt" | undefined, units: bigint): Promise<boolean> {
    const b = await this.balances(u);
    if (direct === "near" || direct === "usdt") return true; // already checked against the balance above
    // Not holding the exact coin is fine: whatever else the wallet has is converted first (ensureUsdc), so only the total counts.
    return b.totalUsd >= amt * 1.02 && (b.nat >= MIN_GAS || !!this.sponsor);
  }

  /** The user signs in a wallet of their choice; nothing is taken from the agent wallet. */
  private ownWallet(u: UserRec, o: { chain: string; sym: string; recipient: string; usdText: string; amt: number; what: string; fromChain?: string | undefined; fromSymbol?: string | undefined; fund?: boolean; fee?: number; notice?: string }, ctx: Ctx): Promise<Out> {
    return this.destAsset(o.chain, o.sym).then((dest) => {
      const payId = this.svc.newPayIntent({ destinationChain: o.chain, destinationAssetId: dest.assetId, recipient: o.recipient, payAmount: o.usdText, fromChain: o.fromChain?.toLowerCase(), fromSymbol: o.fromSymbol?.toUpperCase(), fund: o.fund });
      const pay: Payment = { id: id(), kind: o.fund ? "fund" : "send", amountUsd: o.amt, chain: o.chain, recipient: o.recipient, status: "AWAITING_YOUR_SIGNATURE", createdAt: this.now(), payId };
      u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.earn(u); this.store.save();
      const url = `${ctx.origin}/p/${payId}`;
      const title = o.fund ? `Add ${o.what} to your agent wallet` : `Send ${o.what} to ${o.recipient.length > 20 ? o.recipient.slice(0, 8) + "…" + o.recipient.slice(-6) : o.recipient}`;
      return {
        result: { status: "needs_your_signature", paymentId: pay.id, note: "A Confirm button is on the user's screen. They press it, pick the wallet they want to pay from and sign. Nothing has been sent or taken yet. Do not say it failed and do not paste the link." + (o.notice ? ` Tell the user this, in your own words: ${o.notice}` : " Do not mention the agent wallet.") },
        card: { kind: "confirm_send", title, url, amount: o.what, id: pay.id, ...(o.fund ? { button: "Add money" } : { to: o.recipient, chain: o.chain.toUpperCase() }), ...(o.fee !== undefined ? this.feeFields(o.amt, o.fee) : { fees: "shown before you sign" }), ...(o.notice ? { notice: o.notice } : {}) },
      };
    });
  }

  /** Native NEAR straight from the wallet to a NEAR wallet. */
  private async doSendNear(u: UserRec, amount: bigint, amt: number, to: string, ak?: AgentKey): Promise<Payment> {
    const k = this.store.keyOf(u);
    const r = await this.near.sendNear({ accountId: k.accountId, secretKey: k.secretKey, to, amount });
    const pay: Payment = { id: id(), kind: "send", amountUsd: amt, chain: "near", recipient: to, status: "DELIVERED", createdAt: this.now(), txHash: r.txHash, settled: true, fee: 0, ...(ak ? { agentId: ak.id } : {}) };
    this.svc.publicStatsStore?.record(r.txHash, amt, u.accountId);
    this.spend(u, amt, this.recipientKey("near", to), ak);
    u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.earn(u); this.store.save();
    return pay;
  }

  /** Another NEAR token the wallet already holds (USDT), straight to a NEAR wallet. */
  private async doSendToken(u: UserRec, contract: string, amount: bigint, amt: number, to: string, ak?: AgentKey): Promise<Payment> {
    const k = this.store.keyOf(u);
    const r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: contract, to, amount });
    const pay: Payment = { id: id(), kind: "send", amountUsd: amt, chain: "near", recipient: to, status: "DELIVERED", createdAt: this.now(), txHash: r.txHash, settled: true, fee: 0, ...(ak ? { agentId: ak.id } : {}) };
    this.svc.publicStatsStore?.record(r.txHash, amt, u.accountId);
    this.spend(u, amt, this.recipientKey("near", to), ak);
    u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.earn(u); this.store.save();
    return pay;
  }

  /** A quote where the receiver gets `out` whole and the fees come on top of what the wallet pays. */
  private async exactOut(u: UserRec, usdc: { assetId: string }, out: bigint, chain: string, p: SendParams, dryRun: boolean) {
    const dest = await this.destAsset(chain, p.assetSymbol);
    const r = (await this.svc.directQuote({ originAssetId: usdc.assetId, amount: out.toString(), refundTo: u.accountId, destinationChain: chain as DestChain, destinationAssetId: dest.assetId, recipient: p.recipient, slippageBps: 100, dryRun, exactOutput: true })) as { amountIn: string; depositAddress?: string };
    return { dest, amountIn: BigInt(r.amountIn), depositAddress: r.depositAddress };
  }
  private async preview(u: UserRec, usdc: { assetId: string; decimals: number }, out: bigint, chain: string, p: SendParams): Promise<{ text: string; payUsd: number }> {
    const r = await this.exactOut(u, usdc, out, chain, p, true);
    return { text: `${fmt(out, r.dest.decimals)} ${r.dest.symbol}`, payUsd: Number(r.amountIn) / 10 ** usdc.decimals };
  }
  private async destAsset(chain: string, symbol?: string) {
    let want = (symbol ?? NATIVE[chain] ?? "").toUpperCase();
    if (chain === "near" && want === "NEAR") want = "WNEAR";
    const t = (await this.svc.oneClickClient.tokens()).find((x) => x.blockchain === chain && x.symbol.toUpperCase() === want);
    if (!t) throw new MoopayError("UNKNOWN_ASSET", `I can't send ${want || "that coin"} on ${chain.toUpperCase()} yet. Ask me what I can send there.`);
    return t;
  }

  /**
   * When the wallet is short of USDC but holds enough USDT or NEAR to pay the whole thing, that coin goes straight into the one
   * cross-chain swap, so there is no separate conversion to wait for first. Returns that coin, or nothing to use the usual way.
   */
  private async singleHop(u: UserRec, payUsdc: bigint, destUnits: bigint, chain: string, p: SendParams): Promise<{ assetId: string; contract: string; decimals: number } | undefined> {
    try {
      const b = await this.balances(u);
      if (b.tok >= payUsdc) return undefined;
      const cushion = (n: bigint) => n + n / 50n + 1n; // 2% for price moves
      if (b.usdtA && b.usdt > 0n) {
        const need = cushion((await this.exactOut(u, b.usdtA, destUnits, chain, p, true)).amountIn);
        if (b.usdt >= need) return b.usdtA;
      }
      if (b.nearA) {
        const need = cushion((await this.exactOut(u, b.nearA, destUnits, chain, p, true)).amountIn);
        const spare = (b.nat > KEEP_GAS ? b.nat - KEEP_GAS : 0n) + b.wnear;
        if (spare < need) return undefined;
        if (b.wnear < need) {
          const k = this.store.keyOf(u);
          await this.near.wrapNear({ accountId: k.accountId, secretKey: k.secretKey, wrapContract: b.nearA.contract, amount: need - b.wnear });
          for (let i = 0; i < 10 && (await this.near.ftBalance(b.nearA.contract, u.accountId)) < need; i++) await new Promise((res) => setTimeout(res, this.pollMs));
        }
        return b.nearA;
      }
    } catch { /* fall back to the usual way */ }
    return undefined;
  }

  private async doSend(u: UserRec, usdc: { assetId: string; contract: string; decimals: number }, units: bigint, amt: number, chain: string, p: SendParams, expected?: string, ak?: AgentKey, direct = false, destUnits = units): Promise<Payment> {
    let pay = units;
    if (!direct) pay = (await this.exactOut(u, usdc, destUnits, chain, p, true)).amountIn; // what the swap really costs with fees
    // paying from NEAR or USDT in one swap is faster than converting to USDC first and then swapping again
    const hop = direct ? undefined : await this.singleHop(u, pay, destUnits, chain, p);
    if (!hop) await this.ensureUsdc(u, pay);
    const b = await this.balances(u);
    if (b.nat < MIN_GAS) throw new MoopayError("NOTE_NOT_FUNDED", `I can't pay the network fee for this yet: the agent wallet needs about 0.05 NEAR. Send it to ${u.accountId} and try again.`);
    const k = this.store.keyOf(u);
    const base: Payment = { id: id(), kind: "send", amountUsd: amt, chain, recipient: p.recipient, status: "PROCESSING", createdAt: this.now(), ...(expected ? { expected } : {}), ...(ak ? { agentId: ak.id } : {}) };
    if (direct) {
      const r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: usdc.contract, to: p.recipient, amount: units });
      Object.assign(base, { status: "DELIVERED", txHash: r.txHash, settled: true, fee: 0 });
      this.svc.publicStatsStore?.record(r.txHash, amt, u.accountId);
    } else {
      const o = hop ?? usdc;
      const q = await this.exactOut(u, o, destUnits, chain, p, false);
      if (!q.depositAddress) throw new MoopayError("QUOTE_FAILED", "The swap service didn't give me an address to pay. Nothing was sent. Try again.");
      if ((await this.near.ftBalance(o.contract, u.accountId)) < q.amountIn) throw new MoopayError("NOTE_NOT_FUNDED", await this.lack(u, Number(pay) / 10 ** usdc.decimals));
      const r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: o.contract, to: q.depositAddress, amount: q.amountIn });
      await this.svc.oneClickClient.submitDeposit(q.depositAddress, r.txHash).catch(() => undefined);
      Object.assign(base, { depositAddress: q.depositAddress, txHash: r.txHash, fee: Math.max(0, Number(pay) / 10 ** usdc.decimals - amt) });
    }
    this.spend(u, amt, this.recipientKey(chain, p.recipient), ak);
    u.payments.unshift(base); u.payments.length = Math.min(u.payments.length, 100);
    this.earn(u);
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
  private paymentCard(p: Payment) { return { kind: "payment", id: p.id, amountUsd: p.amountUsd, chain: p.chain, recipient: p.recipient, status: p.status, expected: p.expected, tx: p.chain === "near" && p.txHash ? EXPLORER.near + p.txHash : undefined, ...this.feeFields(p.amountUsd, p.fee) }; }

  /* ---- the private route (beta): the agent wallet pays into the user's OutLayer wallet, which converts if needed and pays the receiver from a private balance ---- */
  /** Why this payment cannot use the private route, in words for the user; undefined when it can. */
  private privateWhy(u: UserRec, chain: string, nearUsdc: boolean): string | undefined {
    if (!this.pr) return "The private route isn't switched on for this MooPay yet.";
    // Only USDC to a NEAR wallet has been run live. Payouts to Solana failed three times in testing, so the rest stays off unless MOOPAY_PRIVATE_ALL=1.
    if (!nearUsdc && process.env["MOOPAY_PRIVATE_ALL"] !== "1") return "The private route (beta) only sends USDC to a NEAR wallet for now. Other chains and coins are not available yet.";
    if (chain === "btc") return "The private route can't pay Bitcoin addresses yet.";
    if (u.payments.some((x) => x.pv && !x.settled)) return "Another private payment is still on its way. Wait for it to land first.";
    return undefined;
  }
  private async outlayerWallet(u: UserRec): Promise<{ key: string; account: string }> {
    if (u.outlayer) return u.outlayer;
    const w = await this.pr!.register();
    u.outlayer = { key: w.api_key, account: w.near_account_id };
    this.store.save(); // the key is shown once, so keep it before anything else happens
    return u.outlayer;
  }
  /** How the receiver gets paid from the private balance: USDC leaves as it is, to any chain that lists USDC; anything else is swapped inside first. */
  private privatePlan(usdc: { assetId: string }, dest: { assetId: string; blockchain: string; symbol: string }, destUnits: bigint): NonNullable<Payment["pv"]>["out"] {
    if (dest.assetId === usdc.assetId) return { chain: "near", token: usdc.assetId };
    if (dest.symbol.toUpperCase() === "USDC") return { chain: dest.blockchain, token: usdc.assetId };
    return { chain: dest.blockchain, token: dest.assetId, swapTo: dest.assetId, minOut: ((destUnits * 99n) / 100n).toString() };
  }
  private async doPrivate(u: UserRec, usdc: { assetId: string; contract: string; decimals: number }, p: SendParams & { recipient: string }, chain: string, sym: string, dest: { assetId: string; blockchain: string; symbol: string }, destUnits: bigint, units: bigint, amt: number, ak?: AgentKey): Promise<Payment> {
    const out = this.privatePlan(usdc, dest, destUnits);
    // What goes in: the amount as asked, or, when it has to be converted or bridged, what the normal route says that costs with fees.
    const fund = dest.assetId === usdc.assetId ? units : (await this.exactOut(u, usdc, destUnits, chain, { ...p, assetSymbol: sym }, true)).amountIn;
    await this.ensureUsdc(u, fund);
    if ((await this.balances(u)).nat < MIN_GAS) throw new MoopayError("NOTE_NOT_FUNDED", `I can't pay the network fee for this yet: the agent wallet needs about 0.05 NEAR. Send it to ${u.accountId} and try again.`);
    const ow = await this.outlayerWallet(u);
    // Ask first, with nothing signed: a payout that cannot be made is found now, not after the money is in.
    if (out.chain !== "near") {
      try {
        const q = await this.pr!.quoteWithdraw(ow.key, { chain: out.chain, to: p.recipient, amount: out.swapTo ? destUnits.toString() : fund.toString(), token: out.token });
        if (!q.amount_out) throw new MoopayError("QUOTE_FAILED", `There's no private route to ${chain.toUpperCase()} for that right now. Nothing was sent. Try the normal send, or a different amount.`);
      } catch (e) {
        if (e instanceof MoopayError) throw e;
        if (e instanceof OutLayerError && e.status === 400 && e.code !== "insufficient_balance") throw new MoopayError("QUOTE_FAILED", swapServiceMessage(e.message, e.status, out.swapTo ? undefined : { symbol: "USDC", decimals: usdc.decimals, price: 1 }));
        /* anything else (busy, down): the money is only taken in once the deposit address below works */
      }
    }
    let dep;
    try { dep = await this.pr!.depositAddress(ow.key, { chain: "near", token: "USDC", amount: fund.toString() }); }
    catch (e) { throw new MoopayError("UPSTREAM_TIMEOUT", "The private route isn't available right now. Nothing was sent. Try again in a minute."); }
    const k = this.store.keyOf(u);
    const r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: usdc.contract, to: dep.deposit_address, amount: fund });
    const pay: Payment = { id: id(), kind: "send", amountUsd: amt, chain, recipient: p.recipient, status: "PRIVATE_FUNDING", createdAt: this.now(), txHash: r.txHash, fee: Math.max(0, Number(fund) / 10 ** usdc.decimals - amt), pv: { step: "funding", amt: fund.toString(), idem: randomBytes(16).toString("hex"), out }, ...(ak ? { agentId: ak.id } : {}) };
    this.spend(u, amt, this.recipientKey(chain, p.recipient), ak);
    u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100);
    this.store.save();
    return pay;
  }
  /** Moves a private payment one step on: waits for the money in the private balance, converts it if needed, pays the receiver, follows it to the end. */
  private async refreshPrivate(u: UserRec, p: Payment): Promise<{ changed: boolean; link?: string }> {
    const pv = p.pv!, ow = u.outlayer;
    if (!ow || !this.pr) return { changed: false };
    const before = p.status, usdcId = (await this.svc.usdcAsset()).assetId, pr = this.pr;
    const giveBack = async (why: string) => { // USDC is still in the private balance: send it home rather than leave it there
      p.settled = true; p.why = why;
      try { await pr.withdraw(ow.key, { chain: "near", to: u.accountId, amount: pv.amt, token: usdcId }, pv.idem + "-back"); p.status = "REFUNDED"; }
      catch { p.status = "FAILED"; p.why += ` Your money is in your private balance (wallet ${ow.account}); I could not move it back yet.`; }
    };
    // "refunded" and a failure that never ran are safe to pay back; anything else may have moved money, so it is never retried.
    const safe = (r: { status: string; result?: Record<string, unknown> | undefined }) => r.status === "refunded" || (r.status === "failed" && !!(r.result?.["never_executed"] || r.result?.["never_submitted"]));
    const stuck = (why: string) => { p.status = "FAILED"; p.settled = true; p.why = `${why} Your money is in your private balance (wallet ${ow.account}).`; };
    const pay = async (token: string, amount: string) => { const op = await pr.withdraw(ow.key, { chain: pv.out.chain, to: p.recipient, amount, token }, pv.idem + (pv.out.swapTo ? "-out" : "")); pv.req = op.request_id; pv.step = "paying"; p.status = "PRIVATE_SENDING"; };
    try {
      if (pv.step === "funding") {
        const have = BigInt((await pr.balance(ow.key, usdcId)).balance ?? "0");
        if (have >= BigInt(pv.amt)) {
          if (pv.out.swapTo) { const op = await pr.swap(ow.key, { token_in: usdcId, token_out: pv.out.swapTo, amount_in: pv.amt, ...(pv.out.minOut ? { min_amount_out: pv.out.minOut } : {}) }, pv.idem + "-swap"); pv.req = op.request_id; pv.step = "swapping"; p.status = "PRIVATE_CONVERTING"; }
          else await pay(usdcId, pv.amt);
        } else if (this.now() - p.createdAt > PRIVATE_FUND_WAIT) { p.status = "FAILED"; p.settled = true; p.why = `The money never showed up in your private balance (wallet ${ow.account}), so nothing was paid out.`; }
      } else if (pv.step === "swapping") {
        const r = await pr.request(ow.key, pv.req!);
        if (r.status === "success") await pay(pv.out.token, BigInt((await pr.balance(ow.key, pv.out.token)).balance ?? "0").toString());
        else if (["failed", "refunded", "needs_review"].includes(r.status)) { if (safe(r)) await giveBack("The private payment could not convert your money."); else stuck(r.status === "needs_review" ? "OutLayer is checking this payment, so I won't try it again." : "The private payment could not convert your money."); }
      } else {
        const r = await pr.request(ow.key, pv.req!);
        const hash = ((r.result?.["swap_details"] as { destinationChainTxHashes?: string[] } | undefined)?.destinationChainTxHashes ?? [])[0];
        if (r.status === "success") { p.status = "DELIVERED"; p.settled = true; if (hash) p.txHash = hash; this.svc.publicStatsStore?.record(pv.idem, p.amountUsd, u.accountId); }
        else if (["failed", "refunded", "needs_review"].includes(r.status)) { if (!pv.out.swapTo && safe(r)) await giveBack("The private payout did not finish."); else stuck(r.status === "needs_review" ? "OutLayer is checking this payment, so I won't try it again." : "The private payout did not finish."); }
      }
    } catch (e) { if (!(e instanceof OutLayerError) || !e.retryable) { /* looked at again next round */ } }
    if (p.status !== before) this.store.save();
    return { changed: p.status !== before, ...(p.status === "DELIVERED" && p.txHash ? { link: (EXPLORER[p.chain] ?? "") + p.txHash } : {}) };
  }

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
    if (b.nat < CLAIM_GAS) throw new MoopayError("NOTE_NOT_FUNDED", `I can't pay the network fee for this claim yet: the agent wallet needs about 0.1 NEAR. Send it to ${u.accountId} and try again.`);
    const desk = this.svc.claimDesk;
    const c = await desk.create({ amount: p.amountUsd, receiver: p.receiver, symbol: "USDC", chain });
    const plan = await desk.fundPlan(c.fundKey, u.accountId);
    const k = this.store.keyOf(u);
    await this.near.sendNear({ accountId: k.accountId, secretKey: k.secretKey, to: plan.noteAccountId, amount: BigInt(plan.gasNear) });
    await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: usdc.contract, to: plan.noteAccountId, amount: units });
    await desk.fundStatus(c.fundKey, ctx.origin).catch(() => undefined);
    const link = `${ctx.origin}/c/${c.claimKey}`;
    const pay: Payment = { id: id(), kind: "claim", amountUsd: amt, chain, recipient: p.receiver, status: "WAITING_TO_BE_CLAIMED", createdAt: this.now(), ...(chain === "near" ? { fee: 0 } : {}), fundKey: c.fundKey, claimLink: link, ...(who.ak ? { agentId: who.ak.id } : {}) };
    this.spend(u, amt, this.recipientKey(chain, p.receiver), who.ak);
    u.payments.unshift(pay); this.store.save();
    return { result: { status: "created", claimLink: link, paymentId: pay.id, rule: chain === "near" ? "Only the receiver's wallet can claim, within 24 hours; otherwise it comes back to the user's agent wallet." : `Only that ${chain.toUpperCase()} wallet can claim, by signing with it, within 24 hours; they receive USDC on ${chain.toUpperCase()} (a small swap fee comes out of the amount). Otherwise it comes back to the user's agent wallet.` }, card: { kind: "claim", id: pay.id, amountUsd: amt, receiver: p.receiver, chain, link, fees: chain === "near" ? "none added" : "a small swap fee comes out of the amount", total: usd(amt) } };
  }

  /* ---- wallet name ---- */
  private named: number[] = [];
  /** Whether names are switched on, and what the address will end with. */
  get nameSuffix(): string | undefined { return this.names ? "." + this.names.accountId : undefined; }

  /** Checks a name without taking it. */
  async nameCheck(u: UserRec, raw: string): Promise<{ ok: boolean; id?: string; reason?: string }> {
    if (!this.names) return { ok: false, reason: "Wallet names are not switched on yet." };
    if (u.name) return { ok: false, reason: "You already have a name." };
    const name = raw.trim().toLowerCase(), bad = nameProblem(name);
    if (bad) return { ok: false, reason: bad };
    const id = name + "." + this.names.accountId;
    if (this.store.nameTaken(name) || (await this.near.nearBalance(id)) > 0n) return { ok: false, reason: "That name is taken." };
    return { ok: true, id };
  }

  /** Gives a brand-new account its name. The wallet is then <name>.<parent>, and its key does not change. */
  async setName(u: UserRec, raw: string): Promise<Out> {
    this.active(u);
    const c = await this.nameCheck(u, raw);
    if (!c.ok) throw new MoopayError("INVALID_INPUT", c.reason!);
    const b = await this.balances(u);
    if (u.payments.length || b.totalUsd > 0 || b.nat > 0n) throw new MoopayError("INVALID_INPUT", "A name can only be chosen before the account is used, so no money is left behind at the old address.");
    const day = 86_400_000, cap = Number(process.env["NAME_DAILY_MAX"] ?? 50);
    this.named = this.named.filter((t) => this.now() - t < day);
    if (this.named.length >= cap) { void alertOwner("names-daily", `the daily limit of ${cap} new wallet names was reached.`, this.now()); throw new MoopayError("UPSTREAM_TIMEOUT", "New names are paused for today. Try again tomorrow."); }
    const k = this.store.keyOf(u), name = raw.trim().toLowerCase();
    try { await this.near.createAccount({ parentId: this.names!.accountId, parentKey: this.names!.secretKey, newId: c.id!, forSecretKey: k.secretKey, deposit: NAME_DEPOSIT }); }
    catch { throw new MoopayError("UPSTREAM_TIMEOUT", "I couldn't create that name right now. Try again in a moment, or pick another."); }
    try { // best effort: a registered account can receive USDC from any wallet
      const usdc = await this.svc.usdcAsset();
      await this.near.call({ accountId: this.names!.accountId, secretKey: this.names!.secretKey, contractId: usdc.contract, method: "storage_deposit", args: { account_id: c.id, registration_only: true }, deposit: NAME_STORAGE_USDC, gas: 12n * 10n ** 12n });
    } catch { /* the wallet that sends USDC can register it instead */ }
    this.named.push(this.now());
    this.store.setName(u, name, c.id!);
    this.store.event(u, `Your wallet is now ${c.id}. Copy it and send money to it from any NEAR wallet or another MooPay agent.`);
    return { result: { status: "named", address: c.id } };
  }

  /* ---- rules, schedules, approvals ---- */
  async rules(u: UserRec, patch: Partial<Rules>, approved = false): Promise<Out> {
    this.active(u);
    const next: Rules = { ...u.rules };
    for (const k of ["floatUsd", "dailyCapUsd", "newRecipientLimitUsd", "approveAboveUsd"] as const) {
      if (patch[k] !== undefined) { if (!(Number(patch[k]) > 0)) throw new MoopayError("INVALID_INPUT", `${k} must be above zero`); next[k] = Number(patch[k]); }
    }
    if (patch.privateSends !== undefined) {
      if (patch.privateSends && !this.pr) throw new MoopayError("INVALID_INPUT", "The private route isn't switched on for this MooPay yet.");
      if (patch.privateSends) next.privateSends = true; else delete next.privateSends;
    }
    for (const k of ["allowedChains", "allowedAssets"] as const) {
      if (patch[k] !== undefined) { const v = patch[k]!.map((x) => x.toLowerCase().trim()).filter(Boolean); if (v.length) next[k] = k === "allowedAssets" ? v.map((x) => x.toUpperCase()) : v; else delete next[k]; }
    }
    if (patch.payoutAddress !== undefined) {
      if (!isNearAccountId(patch.payoutAddress)) throw new MoopayError("BAD_RECIPIENT", "Your payout wallet must be a NEAR wallet, like alice.near.");
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
    return { result: { status: "created", groupLink: link, wallets: entries.length, total: usd(total), rule: "Each wallet opens the link, enters its own address and claims only its own amount within 24 hours; anything unclaimed comes back to the agent wallet." }, card: { kind: "groupclaim", link, total, fees: items.every((i) => (i.chain ?? "near").toLowerCase() === "near") ? "none added" : "a small swap fee comes out of the non-NEAR claims", totalPay: usd(total), rows: items.map((i) => ({ to: i.receiver, amount: usd(Number(i.amountUsd)), chain: (i.chain ?? "near").toUpperCase() })) } };
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

  private ask(u: UserRec, kind: Approval["kind"], params: Record<string, unknown>, summary: string, reason: string, pf?: Preflight): Out {
    const a: Approval = { id: id(), kind, params, summary, reason, createdAt: this.now(), status: "pending", ...(pf ? { pf } : {}) };
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
    if (a.kind === "stake") return this.stakeRnear(u, a.params as never, true, {}, ctx);
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
  /* ---- the X agent ---- */
  /** A one-time code to post from the user's X account; mentions from that account then act as this user, inside their rules. */
  linkX(u: UserRec): Out {
    this.active(u);
    const handle = process.env["X_BOT_HANDLE"];
    if (!handle) return { result: { status: "not_available", reason: "The X agent isn't switched on for this MooPay." } };
    const code = this.store.linkCode(u, this.now());
    return { result: { status: "code_ready", code, linked: u.x?.handle ?? null, steps: `Post this from your X account (it works for 15 minutes): @${handle} link ${code}`, note: "Tell the user to post exactly that from the X account they want to link. Anyone who holds that account can then ask MooPay to move money inside the user's rules, so only link an account they keep safe." } };
  }
  unlinkX(u: UserRec): Out { const was = u.x?.handle; delete u.x; this.store.save(); return { result: { status: "unlinked", was: was ?? null } }; }
  /** The 1% service fee on a payment made through X: a USDC transfer from the agent wallet to the fee account. Returns false when it could not be taken. */
  async collectFee(u: UserRec, feeUsd: number): Promise<boolean> {
    const to = process.env["MOOPAY_X_FEE_ACCOUNT"];
    if (!to || feeUsd < 0.01) return true;
    try {
      const usdc = await this.svc.usdcAsset(), units = parseDecimal(feeUsd.toFixed(2), usdc.decimals);
      await this.ensureUsdc(u, units);
      const k = this.store.keyOf(u);
      const r = await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: usdc.contract, to, amount: units });
      u.payments.unshift({ id: id(), kind: "send", amountUsd: feeUsd, chain: "near", recipient: to, status: "DELIVERED", createdAt: this.now(), settled: true, txHash: r.txHash }); u.payments.length = Math.min(u.payments.length, 100);
      this.store.save(); return true;
    } catch { return false; }
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
    const { nearA } = b;
    if (b.nat < MIN_GAS) { // even unwrapping needs a first fee: use the sponsor if there is one
      await this.advanceGas(u, b.wnear, b.nat) || await this.sponsorGas(u, BigInt(Math.round(b.totalUsd * 1e6)), b.nat);
      b = await this.balances(u);
      if (b.nat < MIN_GAS) throw new NeedsFee(u.accountId);
    }
    const k = this.store.keyOf(u);
    const unwrap = async (amount: bigint) => {
      await this.near.call({ accountId: k.accountId, secretKey: k.secretKey, contractId: WRAP, method: "near_withdraw", args: { amount: amount.toString() }, deposit: 1n, gas: 30n * 10n ** 12n });
      for (let i = 0; i < 10 && (await this.near.nearBalance(u.accountId)) < b.nat + amount / 2n; i++) await new Promise((res) => setTimeout(res, this.pollMs));
    };
    let short = target - b.nat; short += short / 50n;
    if (b.wnear > 0n) { const take = b.wnear < short ? b.wnear : short; await unwrap(take); short -= take; }
    const price = nearA.priceUsd!, nearAssetId = nearA.assetId;
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

  /** Stakes in the agent wallet's name and sends the rNEAR on to `to` the same moment. */
  private async runStake(u: UserRec, nearAmt: bigint, to: string) {
    await this.ensureNear(u, nearAmt);
    const k = this.store.keyOf(u);
    u.rnearTo = to; this.store.save(); // if the hand-over fails, the worker still knows where this rNEAR belongs
    const before = await this.near.ftBalance(RNEAR, u.accountId);
    if (!(await this.near.storageRegistered(RNEAR, u.accountId))) await this.near.call({ accountId: k.accountId, secretKey: k.secretKey, contractId: RNEAR, method: "storage_deposit", args: { account_id: u.accountId, registration_only: true }, deposit: 1_250_000_000_000_000_000_000n, gas: 30n * 10n ** 12n });
    const tx = await this.near.call({ accountId: k.accountId, secretKey: k.secretKey, contractId: RNEAR, method: "deposit_and_stake", args: {}, deposit: nearAmt, gas: STAKE_GAS });
    const price = await rnearPrice((c, m) => this.near.view(c, m) as Promise<unknown>);
    const got = (await this.near.ftBalance(RNEAR, u.accountId)) - before;
    const delivered = got > 0n && Boolean(await this.forwardRnear(u));
    await this.repayAdvance(u, true);
    const apy = await rnearApy();
    const shown = fmt(nearAmt, 24, 4), rnear = fmt((nearAmt * 10n ** 24n) / price, 24, 4);
    return { tx: tx.txHash, shown, rnear, delivered, apy, card: { kind: "stake", staked: shown, rnear, to, apy, tx: EXPLORER.near + tx.txHash } };
  }

  async stakeRnear(u: UserRec, p: { amount?: string | undefined; amountUsd?: string | undefined; fromChain?: string | undefined; fromSymbol?: string | undefined; payout?: string | undefined }, approved = false, who: Who = {}, ctx?: Ctx): Promise<Out> {
    this.active(u);
    const b = await this.balances(u);
    const nearUsd = b.nearA?.priceUsd;
    if (!nearUsd) throw new MoopayError("QUOTE_FAILED", "I couldn't get a NEAR price right now. Try again in a moment.");
    const nearAmt = p.amount ? parseDecimal(p.amount, 24) : p.amountUsd ? BigInt(Math.round((Number(p.amountUsd) / nearUsd) * 1e6)) * 10n ** 18n : 0n;
    if (nearAmt < STAKE_MIN_NEAR) throw new MoopayError("INVALID_INPUT", "give an amount of at least 0.1 NEAR (amount) or its dollar value (amountUsd)");
    const amt = Math.round((Number(nearAmt) / 1e24) * nearUsd * 100) / 100;
    const payout = u.rules.payoutAddress;
    // Staking pays from the agent wallet and sends the rNEAR straight to the payout wallet: no window, no link. Only when the user names
    // money on another chain does the pay window open, because that money has to be signed for in their own wallet.
    const roomUsd = (Number(STAKE_GAS_ROOM) / 1e24) * nearUsd;
    if (ctx && !who.ak && p.fromChain) return this.stakeFromWallet(u, { nearAmt, amt, nearUsd, ...(p.payout ? { payout: p.payout } : payout ? { payout } : {}), fromChain: p.fromChain, ...(p.fromSymbol ? { fromSymbol: p.fromSymbol } : {}) }, ctx);
    if (!payout) throw new MoopayError("INVALID_INPUT", "Set your payout wallet first (tell me your own NEAR wallet). Your rNEAR is sent there, so you hold it yourself.");
    if (b.totalUsd < amt * 1.02 + roomUsd) throw new MoopayError("NOTE_NOT_FUNDED", await this.lack(u, amt + roomUsd / 1.02));
    const denied = this.blocked(u, who, amt, "near", "RNEAR", payout);
    if (denied) return { result: { status: "denied", reason: denied } };
    const d = decide(u, amt, this.recipientKey("near", payout), this.now());
    if (d.action === "deny") return { result: { status: "denied", reason: d.reason, hint: "The user can raise the limit with update_rules (needs their approval)." } };
    const shown = fmt(nearAmt, 24, 4);
    const expected = fmt((nearAmt * 10n ** 24n) / (await rnearPrice((c, m) => this.near.view(c, m) as Promise<unknown>)), 24, 4);
    const summary = (who.ak ? `${who.ak.name}: ` : "") + `Stake ${shown} NEAR (about ${usd(amt)}) into rNEAR on Rhea; rNEAR goes to ${payout}`;
    if (d.action === "ask" && !approved) return this.ask(u, "stake", { amount: fmt(nearAmt, 24, 24), ...(who.ak ? { agentId: who.ak.id } : {}) }, summary, d.reason);
    const r = await this.runStake(u, nearAmt, payout);
    const pay: Payment = { id: id(), kind: "stake", amountUsd: amt, chain: "near", recipient: payout, status: "STAKED", createdAt: this.now(), txHash: r.tx, settled: true, expected: `${r.rnear} rNEAR`, ...(who.ak ? { agentId: who.ak.id } : {}) };
    this.spend(u, amt, this.recipientKey("near", payout), who.ak);
    u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.earn(u); this.store.save();
    return { result: { status: "staked", staked: `${r.shown} NEAR`, receives: `about ${r.rnear} rNEAR`, to: payout, delivered: r.delivered, ...(r.apy ? { apyPercent: r.apy } : {}), note: r.delivered ? "rNEAR is in the user's own wallet; to unstake they sign in a window, call unstake_rnear" : "rNEAR is in the agent wallet and will be forwarded to the payout wallet shortly" }, card: r.card };
  }

  /** Staking with money from the user's own wallet on any chain: one pay window, payout wallet first, then the agent stakes what lands. */
  private async stakeFromWallet(u: UserRec, o: { nearAmt: bigint; amt: number; nearUsd: number; payout?: string; fromChain?: string; fromSymbol?: string }, ctx: Ctx): Promise<Out> {
    if (o.payout && !isNearAccountId(o.payout)) throw new MoopayError("BAD_RECIPIENT", "your rNEAR goes to a NEAR wallet, like alice.near");
    const dest = await this.destAsset("near", "NEAR");
    // The window asks for the network fee reserve on top, like every fee here; what staking does not use stays in the agent wallet.
    const usdText = (Math.ceil((Number(o.nearAmt + STAKE_GAS_ROOM + STAKE_GAS_ROOM / 2n) / 1e24) * o.nearUsd * 100) / 100).toFixed(2);
    // Without a gas wallet to lend the first fee, the agent wallet has to hold a little NEAR of its own: say so before the user signs.
    const feeNear = Math.ceil((1 / o.nearUsd) * 100) / 100;
    const notice = !this.sponsor && (await this.near.nearBalance(u.accountId)) < BigInt(Math.round(feeNear * 1e6)) * 10n ** 18n
      ? `Important: your agent wallet needs at least $1 of NEAR (about ${feeNear} NEAR) to pay the network fee for staking. Send it to ${u.accountId} first, or your stake will wait until it arrives.` : undefined;
    const payId = this.svc.newPayIntent({ destinationChain: "near", destinationAssetId: dest.assetId, recipient: u.accountId, payAmount: usdText, fromChain: o.fromChain?.toLowerCase(), fromSymbol: o.fromSymbol?.toUpperCase(), stake: { payout: o.payout, notice } });
    const price = await rnearPrice((c, m) => this.near.view(c, m) as Promise<unknown>);
    const shown = fmt(o.nearAmt, 24, 4), expected = fmt((o.nearAmt * 10n ** 24n) / price, 24, 4);
    const pay: Payment = { id: id(), kind: "stake", amountUsd: o.amt, chain: "near", recipient: o.payout ?? "your payout wallet", status: "AWAITING_YOUR_SIGNATURE", createdAt: this.now(), payId, expected: `${expected} rNEAR`, stakeNear: fmt(o.nearAmt, 24, 24) };
    u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.earn(u); this.store.save();
    return {
      result: { status: "needs_your_signature", paymentId: pay.id, note: "A Stake button is on the user's screen. They press it, give the NEAR wallet that should receive the rNEAR if it isn't filled in, pick the wallet they pay from and sign. Nothing has been sent or taken yet. Do not say it failed and do not paste the link." + (notice ? ` Also tell the user: ${notice}` : "") },
      card: { kind: "confirm_send", title: `Stake ${shown} NEAR with Rhea`, url: `${ctx.origin}/p/${payId}`, amount: `${shown} NEAR (about ${usd(o.amt)}), you receive about ${expected} rNEAR`, button: "Stake", fees: "network gas only, shown before you sign", ...(notice ? { notice } : {}), ...(o.payout ? { to: o.payout, chain: "NEAR", toLabel: "rNEAR goes to" } : {}), id: pay.id },
    };
  }

  /** The pay window's money has landed in the agent wallet: stake it and hand the rNEAR over. Safe to call twice; only one run goes ahead. */
  private async finishStake(u: UserRec, p: Payment): Promise<{ link: string; card: unknown } | undefined> {
    if (p.status === "STAKING") return undefined;
    const was = p.status;
    p.status = "STAKING"; this.store.save();
    try {
      if (!isNearAccountId(p.recipient)) throw new MoopayError("INVALID_INPUT", "no payout wallet was given");
      const b = await this.balances(u);
      const room = b.nat + b.wnear - STAKE_GAS_ROOM; // a small price move can leave the window a little short of the plan
      const nearAmt = [parseDecimal(p.stakeNear!, 24), room].reduce((x, y) => (x < y ? x : y));
      if (nearAmt < STAKE_MIN_NEAR) throw new MoopayError("NOTE_NOT_FUNDED", "Not enough arrived to stake yet. Add a little more and try again.");
      const r = await this.runStake(u, nearAmt, p.recipient);
      Object.assign(p, { status: "STAKED", settled: true, txHash: r.tx, expected: `${r.rnear} rNEAR` });
      delete p.why;
      this.spend(u, p.amountUsd, this.recipientKey("near", p.recipient));
      this.store.save();
      return { link: EXPLORER.near + r.tx, card: r.card };
    } catch (e) {
      console.error("stake failed", p.id, e);
      if (e instanceof NeedsFee) { p.status = "WAITING_FOR_FEE"; p.why = e.message; } // the money is safe; the next round tries again
      else { p.status = "FAILED"; p.settled = true; p.why = asMoopayError(e).message; }
      if (was !== p.status || p.status === "FAILED") this.store.save();
      return undefined;
    }
  }

  /** Sends any rNEAR the agent wallet holds on to the wallet it was staked for (also used by the worker as a safety net). */
  async forwardRnear(u: UserRec): Promise<bigint | undefined> {
    const to = u.rnearTo ?? u.rules.payoutAddress;
    if (!to) return undefined;
    const bal = await this.near.ftBalance(RNEAR, u.accountId);
    if (bal <= 0n) return undefined;
    const k = this.store.keyOf(u);
    await this.near.transferFromNote({ accountId: k.accountId, secretKey: k.secretKey, tokenContract: RNEAR, to, amount: bal });
    delete u.rnearTo; this.store.save();
    return bal;
  }

  /* ---- unstake: the rNEAR sits in the user's own wallet, so they sign; the agent opens the window and follows it ---- */
  private callWindow(u: UserRec, ctx: Ctx, p: Payment, o: { wallet: string; method: string; args: Record<string, unknown>; title: string; lines: [string, string][]; button: string }) {
    p.payId = this.svc.newCallIntent({ account: o.wallet, contract: RNEAR, method: o.method, args: o.args, title: o.title, lines: o.lines });
    this.store.save();
    return { kind: "confirm_send", title: o.title, url: `${ctx.origin}/p/${p.payId}`, amount: o.lines[1]?.[1] ?? "", button: o.button, id: p.id };
  }

  /** Opens a window where the user signs the unstake with the wallet that holds the rNEAR (all of it, or `amount` rNEAR). */
  async unstakeRnear(u: UserRec, p: { amount?: string | undefined; wallet?: string | undefined }, ctx: Ctx): Promise<Out> {
    this.active(u);
    const wallet = p.wallet ?? u.payments.find((x) => x.kind === "stake" && x.status === "STAKED")?.recipient ?? u.rules.payoutAddress;
    if (!wallet) throw new MoopayError("INVALID_INPUT", "Tell me the NEAR wallet that holds your rNEAR.");
    if (!isNearAccountId(wallet)) throw new MoopayError("BAD_RECIPIENT", "that is not a NEAR wallet address, like alice.near");
    const [held, price] = await Promise.all([this.near.ftBalance(RNEAR, wallet), rnearPrice((c, m) => this.near.view(c, m) as Promise<unknown>)]);
    if (held <= 0n) throw new MoopayError("INVALID_INPUT", `${wallet} holds no rNEAR.`);
    const units = p.amount ? parseDecimal(p.amount, 24) : held;
    if (units <= 0n || units > held) throw new MoopayError("INVALID_INPUT", `${wallet} holds ${fmt(held, 24, 4)} rNEAR.`);
    const worth = (units * price) / 10n ** 24n; // the contract takes the NEAR value
    const all = units === held;
    const pay: Payment = { id: id(), kind: "unstake", amountUsd: 0, chain: "near", recipient: wallet, status: "AWAITING_YOUR_SIGNATURE", createdAt: this.now(), expected: `${fmt(worth, 24, 4)} NEAR` };
    const card = this.callWindow(u, ctx, pay, { wallet, method: all ? "unstake_all" : "unstake", args: all ? {} : { amount: worth.toString() }, title: `Unstake ${fmt(units, 24, 4)} rNEAR`, button: "Unstake", lines: [["Unstaking", `${fmt(units, 24, 4)} rNEAR`], ["You get back", `about ${pay.expected}`], ["Ready to withdraw", "in a day or two"], ["Wallet", wallet]] });
    u.payments.unshift(pay); u.payments.length = Math.min(u.payments.length, 100); this.earn(u); this.store.save();
    return { result: { status: "needs_your_signature", paymentId: pay.id, note: "An Unstake button is on the user's screen. They press it and sign with their own NEAR wallet, the one that holds the rNEAR. Nothing has happened yet. I will tell them when the NEAR is ready to withdraw (a day or two). Do not paste the link." }, card };
  }

  /** Backs out of an unstake that has not been signed yet. Once signed it is on the blockchain and the delay runs. */
  cancelUnstake(u: UserRec): Out {
    const open = u.payments.filter((x) => x.kind === "unstake" && x.status === "AWAITING_YOUR_SIGNATURE");
    if (!open.length) {
      const running = u.payments.find((x) => x.kind === "unstake" && !x.settled);
      return { result: { status: "nothing_to_cancel", note: running ? "The unstake was already signed, so it is on the blockchain and can't be cancelled; the NEAR comes back after the delay." : "There is no unstake waiting to be signed." } };
    }
    for (const p of open) { if (p.payId) this.svc.cancelCall(p.payId); p.status = "CANCELLED"; p.settled = true; }
    this.store.save();
    return { result: { status: "cancelled", cancelled: open.length }, card: { kind: "note", text: "Cancelled. Nothing was unstaked and your rNEAR is untouched." } };
  }

  /** Once the delay is over: a window to sign the withdrawal that sends the unstaked NEAR to the user's wallet. */
  async withdrawUnstaked(u: UserRec, p: { wallet?: string | undefined }, ctx: Ctx): Promise<Out> {
    this.active(u);
    const wallet = p.wallet ?? u.payments.find((x) => x.kind === "unstake")?.recipient ?? u.rules.payoutAddress;
    if (!wallet) throw new MoopayError("INVALID_INPUT", "Tell me the NEAR wallet you unstaked from.");
    const d = await unstaking((c, m, a) => this.near.view(c, m, a), wallet);
    if (d.pending === 0n) return { result: { status: "nothing_pending", note: "Nothing is waiting to be withdrawn." } };
    if (!d.canWithdraw) return { result: { status: "not_ready", pending: `${fmt(d.pending, 24, 4)} NEAR`, note: "The unstaking delay is not over yet (a day or two). I will tell the user when it is." } };
    const pay = u.payments.find((x) => x.kind === "unstake" && !x.settled && x.recipient === wallet) ?? { id: id(), kind: "unstake" as const, amountUsd: 0, chain: "near", recipient: wallet, status: "READY_TO_WITHDRAW", createdAt: this.now() };
    pay.status = "READY_TO_WITHDRAW"; pay.expected = `${fmt(d.pending, 24, 4)} NEAR`;
    if (!u.payments.includes(pay)) u.payments.unshift(pay);
    const card = this.callWindow(u, ctx, pay, { wallet, method: "withdraw_all", args: {}, title: `Withdraw ${pay.expected}`, button: "Withdraw", lines: [["Withdrawing", pay.expected], ["Wallet", wallet]] });
    return { result: { status: "needs_your_signature", paymentId: pay.id, note: "A Withdraw button is on the user's screen; they sign with their own NEAR wallet. Do not paste the link." }, card };
  }

  /** Follows an unstake: signed, waiting out the delay, ready to withdraw, withdrawn. */
  private async refreshUnstake(p: Payment, ctx: Ctx, u: UserRec): Promise<{ changed: boolean; card?: unknown }> {
    const before = p.status;
    let card: unknown;
    try {
      const d = await unstaking((c, m, a) => this.near.view(c, m, a), p.recipient);
      if (p.status === "AWAITING_YOUR_SIGNATURE") {
        if (d.pending > 0n) p.status = "UNSTAKING";
        else if (p.payId && !this.svc.intentOpen(p.payId)) { p.status = "EXPIRED"; p.settled = true; }
      }
      if (p.status === "UNSTAKING" && d.canWithdraw) {
        p.expected = `${fmt(d.pending, 24, 4)} NEAR`; p.status = "READY_TO_WITHDRAW";
        card = this.callWindow(u, ctx, p, { wallet: p.recipient, method: "withdraw_all", args: {}, title: `Withdraw ${p.expected}`, button: "Withdraw", lines: [["Withdrawing", p.expected], ["Wallet", p.recipient]] });
      } else if ((p.status === "UNSTAKING" || p.status === "READY_TO_WITHDRAW") && d.pending === 0n) { p.status = "WITHDRAWN"; p.settled = true; }
    } catch { /* the chain was busy; look again next round */ }
    if (p.status !== before) this.store.save();
    return { changed: p.status !== before, ...(card ? { card } : {}) };
  }

  /** What the user has in rNEAR (in their own wallet), its value, and the current yield. */
  async rnearPosition(u: UserRec): Promise<Out> {
    const payout = u.rules.payoutAddress;
    const [price, apy, b] = await Promise.all([rnearPrice((c, m) => this.near.view(c, m) as Promise<unknown>), rnearApy(), this.balances(u)]);
    const held = payout ? await this.near.ftBalance(RNEAR, payout) : 0n;
    const inAgent = await this.near.ftBalance(RNEAR, u.accountId);
    const waiting = payout ? await unstaking((c, m, a) => this.near.view(c, m, a), payout).catch(() => undefined) : undefined;
    const total = held + inAgent;
    const nearValue = (total * price) / 10n ** 24n;
    const usdValue = b.nearA?.priceUsd ? (Number(nearValue) / 1e24) * b.nearA.priceUsd : undefined;
    const data = { rnear: fmt(total, 24, 4), worthNear: fmt(nearValue, 24, 4), ...(usdValue !== undefined ? { worthUsd: usdValue.toFixed(2) } : {}), priceNearPerRnear: fmt(price, 24, 4), ...(apy ? { apyPercent: apy } : {}), wallet: payout ?? null, ...(waiting?.pending ? { unstakingNear: fmt(waiting.pending, 24, 4), readyToWithdraw: waiting.canWithdraw } : {}) };
    return { result: data, card: { kind: "position", ...data } };
  }

  /* ---- status & activity ---- */
  activity(u: UserRec, limit = 8): Out {
    const items = u.payments.slice(0, Math.min(limit, 20)).map((p) => ({ id: p.id, kind: p.kind, amountUsd: p.amountUsd, to: p.recipient, chain: p.chain, status: p.status, at: new Date(p.createdAt).toISOString(), ...(p.claimLink ? { claimLink: p.claimLink } : {}) }));
    return { result: { items }, card: { kind: "list", items } };
  }

  /** Looks at 1Click / the claim desk; returns what changed so the worker can tell the user. */
  async refresh(u: UserRec, p: Payment, ctx: Ctx): Promise<{ changed: boolean; link?: string; card?: unknown; earned?: number }> {
    const out = await this.refreshOne(u, p, ctx);
    const earned = out.changed ? earnPoints(u) : 0;
    if (earned) this.store.save();
    return earned ? { ...out, earned } : out;
  }

  /** Says in chat that payments earned moo points. The caller saves. */
  pointsEvent(u: UserRec, earned: number): void {
    this.store.event(u, `You earned ${earned} moo points. You have ${u.points ?? 0} in total.`);
  }

  private earn(u: UserRec): void {
    const n = earnPoints(u);
    if (n) this.pointsEvent(u, n);
  }

  private async refreshOne(u: UserRec, p: Payment, ctx: Ctx): Promise<{ changed: boolean; link?: string; card?: unknown }> {
    if (p.settled) return { changed: false };
    if (p.kind === "unstake") return this.refreshUnstake(p, ctx, u);
    if (p.pv) return this.refreshPrivate(u, p);
    const before = p.status;
    let link: string | undefined;
    if (p.kind === "stake" && p.status === "WAITING_FOR_FEE") { // the money is here; staking waits only for a first network fee
      const done = await this.finishStake(u, p);
      return { changed: p.status !== before, ...(done ?? {}) };
    }
    if (p.kind === "stake" && p.payId) { // the pay window brings the money; the stake itself is ours to finish
      let done: { link: string; card: unknown } | undefined;
      try {
        const s = (await this.svc.payStatus(p.payId)) as { state: string; depositAddress?: string };
        p.recipient = this.svc.stakePayout(p.payId) ?? p.recipient;
        if (!p.depositAddress && s.depositAddress) p.depositAddress = s.depositAddress;
        if (s.state === "SUCCESS") done = await this.finishStake(u, p);
        else if (s.state === "REFUNDED" || s.state === "FAILED") { p.status = s.state; p.settled = true; }
      } catch { if (!p.depositAddress && p.status === "AWAITING_YOUR_SIGNATURE") { p.status = "EXPIRED"; p.settled = true; } }
      if (p.status !== before) this.store.save();
      return { changed: p.status !== before, ...(done ?? {}) };
    }
    if (p.payId) {
      try {
        const s = (await this.svc.payStatus(p.payId)) as { state: string; direct?: boolean; depositAddress?: string; explorerUrl?: string };
        if (s.direct) { // a straight transfer: the chain itself says whether it landed
          if (s.state === "SUCCESS") { p.status = "DELIVERED"; p.settled = true; link = s.explorerUrl; }
          else if (s.state === "FAILED") { p.status = "FAILED"; p.settled = true; }
          if (p.status !== before) this.store.save();
          return { changed: p.status !== before, ...(link ? { link } : {}) };
        }
        if (!p.depositAddress && s.depositAddress) p.depositAddress = s.depositAddress;
      } catch { if (!p.depositAddress) { p.status = "EXPIRED"; p.settled = true; } }
    }
    if (p.kind === "claim" && p.fundKey) {
      const s = await this.svc.claimFundState(p.fundKey, ctx.origin);
      const map: Record<string, string> = { CLAIMED: "CLAIMED", REFUNDED: "REFUNDED", CANCELLED: "REFUNDED" };
      // Opened is not delivered: a claim paid to another chain is only done when the swap service has put it there.
      const d = s.state === "CLAIMED" && s.deliverTo ? ((await this.svc.oneClickClient.status(s.deliverTo).catch(() => undefined)) as { status: string; swapDetails?: { destinationChainTxHashes?: { hash: string }[] } } | undefined) : undefined;
      if (d && d.status !== "SUCCESS") {
        if (d.status === "REFUNDED" || d.status === "FAILED") { p.status = "REFUNDED"; p.settled = true; } // the swap service returns it to the agent wallet
        else p.status = "ON_ITS_WAY";
      } else if (map[s.state]) {
        p.status = map[s.state]!; p.settled = true;
        const hash = d?.swapDetails?.destinationChainTxHashes?.[0]?.hash;
        if (hash) link = (EXPLORER[p.chain] ?? "") + hash;
      }
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
    if (!p) throw new MoopayError("NOTE_NOT_FOUND", "I can't find that payment.");
    const r = await this.refresh(u, p, ctx);
    if (r.earned) { this.pointsEvent(u, r.earned); this.store.save(); }
    return { result: { id: p.id, status: p.status, ...(r.link ? { transaction: r.link } : {}) }, card: { kind: "payment", id: p.id, amountUsd: p.amountUsd, chain: p.chain, recipient: p.recipient, status: p.status, tx: r.link, ...this.feeFields(p.amountUsd, p.fee) } };
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
    return { result: { status: "sent", sent: asset === "NEAR" ? `${shown} NEAR` : usd(shown), to }, card: { kind: "payment", id: pay.id, amountUsd: shown, chain: "near", recipient: to, status: "DELIVERED", tx: EXPLORER.near + r.txHash, unit: asset === "NEAR" ? "NEAR" : undefined, ...(asset === "NEAR" ? {} : this.feeFields(shown, 0)) } };
  }

  /* ---- add money from any chain: 1Click turns it into USDC in the agent wallet ---- */
  private async originAsset(chain: string, symbol: string | undefined, amountUsd: string) {
    const want = (symbol ?? NATIVE[chain] ?? "").toUpperCase();
    const t = (await this.svc.oneClickClient.tokens()).find((x) => x.blockchain === chain && x.symbol.toUpperCase() === want);
    if (!t) throw new MoopayError("UNKNOWN_ASSET", `I can't send ${want || "that coin"} on ${chain.toUpperCase()} yet. Ask me what I can send there.`);
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

  /** Adds money to the agent wallet: a pay window where the user picks any wallet and coin, signs, and it arrives as USDC. Refunds go back to the wallet that signed. */
  async fundWallet(u: UserRec, p: { amountUsd?: string | undefined; amount?: string | undefined; fromChain: string; fromSymbol?: string | undefined }, ctx: Ctx): Promise<Out> {
    const chain = p.fromChain.toLowerCase();
    let usdText = p.amountUsd;
    if (!usdText) { // coins ("0.01 SOL") are priced in dollars here
      if (!p.amount) throw new MoopayError("INVALID_INPUT", "How much should I send? Say an amount, like $5.");
      const price = (await this.destAsset(chain, p.fromSymbol) as { price?: number }).price;
      if (!price) throw new MoopayError("QUOTE_FAILED", "I couldn't get a price for that coin, so say the amount in dollars instead.");
      parseDecimal(p.amount, 18);
      usdText = (Math.ceil(Number(p.amount) * price * 100) / 100).toFixed(2);
    }
    const amt = Number(usdText);
    return this.ownWallet(u, { chain: "near", sym: "USDC", recipient: u.accountId, usdText, amt, what: p.amount ? `${p.amount} ${(p.fromSymbol ?? NATIVE[chain] ?? "").toUpperCase()}`.trim() : usd(amt), fromChain: chain, fromSymbol: p.fromSymbol, fund: true }, ctx);
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

  /* ---- gas advance: a loan for the first fee, repaid by the wallet's own reserve ---- */
  /** Lends a wallet that holds wNEAR (at least the staking reserve) but no NEAR enough NEAR to unwrap and stake it. One loan per wallet at a time. */
  private async advanceGas(u: UserRec, wnear: bigint, nat: bigint): Promise<boolean> {
    const s = this.sponsor;
    if (!s || u.advance || nat >= MIN_GAS || wnear < STAKE_GAS_ROOM) return false;
    u.advance = ADVANCE.toString(); this.store.save();
    try { await this.near.sendNear({ accountId: s.accountId, secretKey: s.secretKey, to: u.accountId, amount: ADVANCE }); }
    catch { delete u.advance; this.store.save(); void alertOwner("advance-failed", "the gas wallet could not lend NEAR for a stake. Its balance may be empty.", this.now()); return false; }
    for (let i = 0; i < 10 && (await this.near.nearBalance(u.accountId)) < MIN_GAS; i++) await new Promise((res) => setTimeout(res, this.pollMs));
    void this.near.nearBalance(s.accountId).then((b) => { if (b < SPONSOR_LOW) void alertOwner("sponsor-low", `the gas sponsor wallet is running low (${(Number(b) / 1e24).toFixed(2)} NEAR left).`, this.now()); }).catch(() => undefined);
    return true;
  }

  /** Sends the loan back once the stake is done. Also the worker's safety net, so it waits while a stake is still waiting on the wallet's wNEAR. */
  async repayAdvance(u: UserRec, force = false): Promise<void> {
    const s = this.sponsor;
    if (!s || !u.advance) return;
    try {
      if (!force && (await this.near.ftBalance(WRAP, u.accountId)) >= STAKE_MIN_NEAR) return;
      const owed = BigInt(u.advance), spare = (await this.near.nearBalance(u.accountId)) - KEEP_NEAR;
      const pay = owed < spare ? owed : spare;
      if (pay <= 0n) return;
      const k = this.store.keyOf(u);
      await this.near.sendNear({ accountId: k.accountId, secretKey: k.secretKey, to: s.accountId, amount: pay });
      if (pay >= owed) delete u.advance; else u.advance = (owed - pay).toString();
      this.store.save();
    } catch { /* the worker tries again */ }
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

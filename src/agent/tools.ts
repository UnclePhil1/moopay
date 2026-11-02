import { z } from "zod";
import { MoopayError } from "../lib/errors.js";
import type { MooPayService } from "../lib/service.js";
import type { AgentOps, Ctx, Out } from "./ops.js";
import type { UserRec } from "./store.js";

/** The tools the model can call. Inputs are re-validated here; the model's output is never trusted. */
const money = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/, "amount in dollars, like 20 or 12.50");
const chain = z.enum(["btc", "sol", "eth", "near"]);
const ZS = {
  get_account: z.object({}).strict(),
  send_money: z.object({ amountUsd: money.optional(), amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/, "amount in coins, like 0.1").optional(), chain, recipient: z.string().min(2).max(128), assetSymbol: z.string().max(16).optional(), useAgentWallet: z.boolean().optional(), fromChain: z.string().min(2).max(16).optional(), fromSymbol: z.string().max(16).optional() }).strict(),
  create_claim: z.object({ amountUsd: money, receiver: z.string().min(2).max(128), chain: z.string().min(2).max(16).optional() }).strict(),
  check_payment: z.object({ paymentId: z.string().min(3).max(32) }).strict(),
  list_activity: z.object({ limit: z.number().int().min(1).max(20).optional() }).strict(),
  update_rules: z.object({ floatUsd: z.number().positive().optional(), dailyCapUsd: z.number().positive().optional(), newRecipientLimitUsd: z.number().positive().optional(), approveAboveUsd: z.number().positive().optional(), payoutAddress: z.string().min(2).max(64).optional(), allowedChains: z.array(z.string().max(16)).max(8).optional(), allowedAssets: z.array(z.string().max(16)).max(8).optional() }).strict(),
  schedule_payment: z.object({ amountUsd: money, chain, recipient: z.string().min(2).max(128), every: z.enum(["day", "week", "month"]), assetSymbol: z.string().max(16).optional() }).strict(),
  cancel_schedule: z.object({ id: z.string().min(3).max(32) }).strict(),
  list_supported_assets: z.object({ chain: z.string().max(32).optional(), symbol: z.string().max(32).optional() }).strict(),
  withdraw: z.object({ amountUsd: money.optional(), asset: z.enum(["USDC", "NEAR"]).optional(), to: z.string().min(2).max(64).optional() }).strict(),
  fund_wallet: z.object({ amountUsd: money, fromChain: z.string().min(2).max(16), fromSymbol: z.string().max(16).optional(), refundAddress: z.string().min(2).max(128) }).strict(),
  pay_from_my_wallet: z.object({ amountUsd: money, fromChain: z.string().min(2).max(16), fromSymbol: z.string().max(16).optional(), refundAddress: z.string().min(2).max(128), toChain: z.enum(["btc", "sol", "eth"]), recipient: z.string().min(2).max(128), toSymbol: z.string().max(16).optional() }).strict(),
  payment_link: z.object({ amountUsd: money, toChain: z.enum(["btc", "sol", "eth"]), recipient: z.string().min(2).max(128), toSymbol: z.string().max(16).optional() }).strict(),
  create_agent_key: z.object({ name: z.string().min(1).max(40), dailyUsd: z.number().positive().optional(), perPaymentUsd: z.number().positive().optional(), totalUsd: z.number().positive().optional(), hours: z.number().positive().max(24 * 90).optional(), ips: z.array(z.string().max(45)).max(5).optional(), chains: z.array(z.string().max(16)).max(8).optional(), assets: z.array(z.string().max(16)).max(8).optional(), recipients: z.array(z.string().max(128)).max(10).optional() }).strict(),
  stake_rnear: z.object({ amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/, "NEAR amount, like 5").optional(), amountUsd: money.optional() }).strict(),
  rnear_position: z.object({}).strict(),
  list_agent_keys: z.object({}).strict(),
  revoke_agent_key: z.object({ agent: z.string().min(1).max(40) }).strict(),
} as const;
type Name = keyof typeof ZS;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
export const TOOLS = [
  { name: "get_account", description: "The user's agent wallet: address, balances, rules, schedules and what setup is left. Call it before payments if you are unsure they are funded.", input_schema: obj({}) },
  { name: "send_money", description: "Send money to a wallet on BTC, SOL, ETH or NEAR, in any asset 1Click supports (list_supported_assets). Give EITHER amountUsd (dollars) OR amount (a number of the receiver's coin, e.g. amount \"0.1\" with assetSymbol \"NEAR\"). The receiver gets the chain's own coin unless assetSymbol says otherwise (NEAR chain defaults to USDC). The wallet's balance is converted behind the scenes if needed. The agent wallet is OPTIONAL and never a reason to refuse: if it can cover the payment it pays, otherwise the user gets a Confirm button and signs in their own wallet (NEAR, Ethereum and other EVM chains, Solana, or any chain by deposit address), so never tell the user a payment cannot be made because the agent wallet is empty or has no NEAR. If the user names where the money comes from (\"send 0.5 SOL\", \"from my Phantom\", \"from my ETH\") set fromChain (and fromSymbol); set useAgentWallet true only if they say to use the agent wallet, false if they say to use their own wallet. The rules decide whether it runs now or needs the user's OK; just report which happened.", input_schema: obj({ amountUsd: str("dollars, e.g. \"20\""), amount: str("OR a number of coins the receiver gets, e.g. \"0.1\""), chain: { type: "string", enum: ["btc", "sol", "eth", "near"] }, recipient: str("the receiver's address"), assetSymbol: str("optional: NEAR, USDC, USDT, SOL, ETH, BTC or any asset from list_supported_assets"), fromChain: str("optional: chain the user pays from, e.g. sol, eth, base, near"), fromSymbol: str("optional: coin the user pays with, e.g. SOL, USDC"), useAgentWallet: { type: "boolean" } }, ["chain", "recipient"]) },
  { name: "create_claim", description: "Fund a private claim only the named wallet can open by signing with it (within 24 hours, otherwise refunded). Works for a NEAR wallet, a Solana wallet, or an EVM wallet (eth, base, arb, op, pol, bsc, avax, gnosis, monad, xlayer); on other chains they receive USDC. Returns a link for the user to give the receiver. Bitcoin and other chains are not supported for claims.", input_schema: obj({ amountUsd: str("dollars"), receiver: str("the receiver's wallet address"), chain: str("near (default), sol, eth, base, arb, ...") }, ["amountUsd", "receiver"]) },
  { name: "check_payment", description: "Latest status of a payment or claim by paymentId.", input_schema: obj({ paymentId: str("id from an earlier result") }, ["paymentId"]) },
  { name: "list_activity", description: "Recent payments and claims.", input_schema: obj({ limit: { type: "integer" } }) },
  { name: "update_rules", description: "Change the user's rules (float, daily cap, new-recipient limit, auto-approve limit, payout wallet). Only when the user asks. Loosening limits or changing the payout wallet needs their OK, and a changed payout wallet only starts 24 hours later (setting the current one again cancels the change).", input_schema: obj({ floatUsd: { type: "number" }, dailyCapUsd: { type: "number" }, newRecipientLimitUsd: { type: "number" }, approveAboveUsd: { type: "number" }, payoutAddress: str("the user's own NEAR wallet"), allowedChains: { type: "array", items: { type: "string" }, description: "only these chains may be paid, e.g. [\"sol\"]; empty list clears" }, allowedAssets: { type: "array", items: { type: "string" }, description: "only these assets, e.g. [\"USDC\"]; empty list clears" } }) },
  { name: "schedule_payment", description: "Repeat a payment every day, week or month. Each run follows the rules.", input_schema: obj({ amountUsd: str("dollars"), chain: { type: "string", enum: ["btc", "sol", "eth", "near"] }, recipient: str("address"), every: { type: "string", enum: ["day", "week", "month"] }, assetSymbol: str("optional") }, ["amountUsd", "chain", "recipient", "every"]) },
  { name: "cancel_schedule", description: "Stop a scheduled payment by id.", input_schema: obj({ id: str("schedule id from get_account") }, ["id"]) },
  { name: "list_supported_assets", description: "Look up assets 1Click supports, optionally filtered by chain and symbol. Do not guess asset names.", input_schema: obj({ chain: str("sol, eth, btc, near"), symbol: str("e.g. USDC") }) },
  { name: "withdraw", description: "Take money out of the agent wallet to the user's own NEAR wallet. Defaults to their payout wallet and to everything in USDC; asset NEAR sends spare NEAR. A different destination needs the user's OK. The user can always do this.", input_schema: obj({ amountUsd: str("dollars; omit for everything"), asset: { type: "string", enum: ["USDC", "NEAR"] }, to: str("optional NEAR wallet; default is the payout wallet") }) },
  { name: "fund_wallet", description: "Add money to the agent wallet from ANY chain (Solana, Ethereum, Bitcoin, or others from list_supported_assets). Returns a deposit address and the exact amount to send from their own wallet; it arrives as USDC. Use when the user wants to deposit or has no NEAR. Needs their refund address on that chain (used only if the swap fails).", input_schema: obj({ amountUsd: str("dollars to add"), fromChain: str("sol, eth, btc, or another 1Click chain"), fromSymbol: str("optional, defaults to the chain's own coin"), refundAddress: str("the user's own address on that chain") }, ["amountUsd", "fromChain", "refundAddress"]) },
  { name: "pay_from_my_wallet", description: "For users who don't want to deposit: pay a receiver straight from the user's OWN wallet on any chain. Returns a deposit address and the exact amount; nothing is stored in the agent wallet.", input_schema: obj({ amountUsd: str("dollars"), fromChain: str("chain the user pays from"), fromSymbol: str("optional"), refundAddress: str("the user's own address on that chain"), toChain: { type: "string", enum: ["btc", "sol", "eth"] }, recipient: str("receiver address"), toSymbol: str("optional") }, ["amountUsd", "fromChain", "refundAddress", "toChain", "recipient"]) },
  { name: "payment_link", description: "For users who don't want to deposit and have a NEAR wallet: a link they open to sign the payment in their own wallet (Meteor, Nightly).", input_schema: obj({ amountUsd: str("dollars"), toChain: { type: "string", enum: ["btc", "sol", "eth"] }, recipient: str("receiver address"), toSymbol: str("optional") }, ["amountUsd", "toChain", "recipient"]) },
  { name: "create_agent_key", description: "Give an outside AI agent (or a short session) its own key with its own limits, always inside the user's rules. Use for \"let my bot pay up to $50/day\", or a temporary permission: set hours, totalUsd, and optionally chains/assets/recipients (e.g. one address) and ips (only those IP addresses may use it). Keys expire after 7 days unless hours says otherwise. The key is shown once.", input_schema: obj({ name: str("short name, e.g. research-bot"), dailyUsd: { type: "number" }, perPaymentUsd: { type: "number" }, totalUsd: { type: "number", description: "total budget for the key's life" }, hours: { type: "number", description: "expires after this many hours (default 168)" }, ips: { type: "array", items: { type: "string" }, description: "only these IP addresses may use the key" }, chains: { type: "array", items: { type: "string" } }, assets: { type: "array", items: { type: "string" } }, recipients: { type: "array", items: { type: "string" }, description: "only these addresses" } }, ["name"]) },
  { name: "stake_rnear", description: "Stake NEAR into rNEAR on Rhea Finance (liquid staking, earns yield). Give amount (NEAR) OR amountUsd. Pays from whatever the wallet holds (NEAR, USDC, USDT; MooPay converts quietly). The rNEAR is sent to the user's own payout wallet, which must be set first. Rules and approvals apply. Works for money added from any chain too: use fund_wallet first.", input_schema: obj({ amount: str("NEAR to stake, e.g. \"5\""), amountUsd: str("OR dollars to stake, e.g. \"20\"") }) },
  { name: "rnear_position", description: "The user's rNEAR: how much, what it is worth, the current yield, and where to unstake (MooPay never holds their rNEAR, so unstaking is done from their own wallet on Rhea's page).", input_schema: obj({}) },
  { name: "list_agent_keys", description: "The user's agent keys with what each has left.", input_schema: obj({}) },
  { name: "revoke_agent_key", description: "Switch an agent key off now, by name or id.", input_schema: obj({ agent: str("name or id") }, ["agent"]) },
];

/** Tools that only look; a turn that used nothing else can still be cancelled. */
export const READ_ONLY = new Set(["get_account", "check_payment", "list_activity", "list_supported_assets", "rnear_position", "list_agent_keys"]);

export const STEP_LABEL: Record<string, string> = {
  get_account: "Checking your account", send_money: "Finding the best route", create_claim: "Preparing the private claim", check_payment: "Checking the payment",
  list_activity: "Looking through your activity", update_rules: "Updating your rules", schedule_payment: "Scheduling it", cancel_schedule: "Cancelling it", list_supported_assets: "Looking up assets", withdraw: "Preparing your withdrawal", fund_wallet: "Getting a deposit address", pay_from_my_wallet: "Getting a deposit address", payment_link: "Making your payment link", create_agent_key: "Creating the agent key", stake_rnear: "Staking with Rhea", rnear_position: "Checking your stake", list_agent_keys: "Looking at your agents", revoke_agent_key: "Switching it off",
};

export async function runTool(name: string, input: unknown, u: UserRec, ops: AgentOps, svc: MooPayService, ctx: Ctx): Promise<Out> {
  if (!(name in ZS)) throw new MoopayError("INVALID_INPUT", `unknown tool ${name}`);
  const parsed = ZS[name as Name].safeParse(input ?? {});
  if (!parsed.success) throw new MoopayError("INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const a = parsed.data as never as Record<string, never>;
  switch (name as Name) {
    case "get_account": return ops.account(u);
    case "send_money": return ops.send(u, a as never, false, {}, ctx);
    case "create_claim": return ops.claim(u, a as never, ctx);
    case "check_payment": return ops.status(u, a["paymentId"]!, ctx);
    case "list_activity": return ops.activity(u, a["limit"]);
    case "update_rules": return ops.rules(u, a as never);
    case "schedule_payment": return ops.schedule(u, a as never);
    case "cancel_schedule": return ops.cancel(u, a["id"]!);
    case "withdraw": return ops.withdraw(u, a as never);
    case "fund_wallet": return ops.fundWallet(u, a as never);
    case "pay_from_my_wallet": return ops.payFromWallet(u, a as never);
    case "payment_link": return ops.paymentLink(a as never, ctx);
    case "stake_rnear": return ops.stakeRnear(u, a as never);
    case "rnear_position": return ops.rnearPosition(u);
    case "create_agent_key": return ops.createAgent(u, a as never);
    case "list_agent_keys": return ops.listAgents(u);
    case "revoke_agent_key": return ops.revokeAgent(u, a["agent"]!);
    case "list_supported_assets": return { result: (await svc.listAssets(a as never)) as unknown as Record<string, unknown> };
  }
}

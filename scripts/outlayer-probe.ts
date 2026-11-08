/*
 * Tries OutLayer's confidential routes one step at a time, with real money, before MooPay depends on them.
 * Nothing here runs by itself and nothing is sent to MooPay. The wallet key is kept in .outlayer-probe.json (ignored by git, never printed).
 *
 *   npx tsx scripts/outlayer-probe.ts register                 make a throwaway OutLayer wallet
 *   npx tsx scripts/outlayer-probe.ts tokens [SYMBOL]          list what can be moved
 *   npx tsx scripts/outlayer-probe.ts deposit near 2           ask for a bridge address for 2 USDC from a chain
 *   npx tsx scripts/outlayer-probe.ts balance                  confidential balance (poll after sending to the address)
 *   npx tsx scripts/outlayer-probe.ts quote near bob.near 1    what a private payout of 1 USDC would deliver, nothing signed
 *   npx tsx scripts/outlayer-probe.ts send near bob.near 1 --yes   really send it
 *   npx tsx scripts/outlayer-probe.ts send sol <address> 1 --yes   USDC out to another chain that lists USDC
 *   npx tsx scripts/outlayer-probe.ts swap-quote nep141:sol.omft.near 1   what 1 USDC would convert to inside the private balance, nothing signed
 *   npx tsx scripts/outlayer-probe.ts swap nep141:sol.omft.near 1 --yes   really convert it
 *
 * Amounts are in USDC. Use small ones.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { OutLayer, OutLayerError } from "../src/agent/outlayer.js";

const FILE = ".outlayer-probe.json";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // USDC on NEAR
const units = (usd: string) => String(Math.round(Number(usd) * 1e6));
const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== "--yes");
const yes = process.argv.includes("--yes");
const ol = new OutLayer();
const show = (label: string, v: unknown) => console.log(label + ":", JSON.stringify(v, null, 2));
const need = (): string => {
  if (!existsSync(FILE)) { console.error("No wallet yet. Run: register"); process.exit(1); }
  return (JSON.parse(readFileSync(FILE, "utf8")) as { api_key: string }).api_key;
};

try {
  if (cmd === "register") {
    if (existsSync(FILE)) { console.error(`${FILE} already holds a wallet. Delete it first if you want a new one.`); process.exit(1); }
    const w = await ol.register();
    writeFileSync(FILE, JSON.stringify({ api_key: w.api_key, near_account_id: w.near_account_id }), { mode: 0o600 }); chmodSync(FILE, 0o600);
    console.log("wallet:", w.near_account_id, "(key saved to " + FILE + ")");
  } else if (cmd === "tokens") {
    const all = (await ol.tokens(need())) as unknown;
    const want = args[0]?.toUpperCase();
    show("tokens", want && Array.isArray(all) ? all.filter((t) => JSON.stringify(t).toUpperCase().includes(want)) : all);
  } else if (cmd === "deposit") {
    const [chain, amount] = args; if (!chain || !amount) throw new Error("usage: deposit <chain> <usdc amount>");
    show("send the money to this address, from that chain, within the time shown", await ol.depositAddress(need(), { chain, token: "USDC", amount: units(amount) }));
  } else if (cmd === "balance") {
    show("confidential balance", await ol.balance(need()));
  } else if (cmd === "swap-quote" || cmd === "swap") {
    const [out, amount] = args; if (!out || !amount) throw new Error(`usage: ${cmd} <token out, e.g. nep141:sol.omft.near> <usdc amount>`);
    const body = { token_in: USDC, token_out: out, amount_in: units(amount) };
    if (cmd === "swap-quote") show("quote", await ol.quoteSwap(need(), body));
    else {
      if (!yes) { show("would convert (add --yes to do it)", body); process.exit(0); }
      const key = need(), op = await ol.swap(key, body, randomUUID());
      show("accepted", op); show("result", await ol.settle(key, op.request_id)); show("balance now", await ol.balance(key, out));
    }
  } else if (cmd === "quote" || cmd === "send") {
    const [chain, to, amount] = args; if (!chain || !to || !amount) throw new Error(`usage: ${cmd} <chain> <address> <usdc amount>`);
    const body = { chain, to, amount: units(amount), token: USDC };
    if (cmd === "quote") show("quote", await ol.quoteWithdraw(need(), body));
    else {
      if (!yes) { show("would send (add --yes to do it)", body); process.exit(0); }
      const key = need(), op = await ol.withdraw(key, body, randomUUID());
      show("accepted", op);
      show("result", await ol.settle(key, op.request_id));
    }
  } else console.log("commands: register | tokens [SYMBOL] | deposit <chain> <usdc> | balance | quote <chain> <to> <usdc> | send <chain> <to> <usdc> --yes | swap-quote <token> <usdc> | swap <token> <usdc> --yes");
} catch (e) {
  if (e instanceof OutLayerError) { console.error(`OutLayer ${e.status} ${e.code}: ${e.message}${e.retryable ? " (safe to retry)" : ""}`); process.exit(1); }
  throw e;
}

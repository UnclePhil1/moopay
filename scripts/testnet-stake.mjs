// Tries the rNEAR staking calls on NEAR testnet with a throwaway account, using the same NearOps code the agent uses.
// Usage: [TESTNET_ACCOUNT=name.testnet] node scripts/testnet-stake.mjs <key-file> [payout-account]   (run `npm run build` first)
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { deriveNoteAccount } from "../dist/lib/crypto.js";
import { makeNearOps } from "../dist/lib/origin.js";

const LST = "lst.ref-dev.testnet";
const file = process.argv[2];
if (!file) throw new Error("give a key file path, e.g. /tmp/moopay-testnet.key");
if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
const derived = deriveNoteAccount(Buffer.from(readFileSync(file, "utf8").trim(), "hex"));
const me = { ...derived, accountId: process.env.TESTNET_ACCOUNT ?? derived.accountId }; // a named account created with the same key also works
const near = makeNearOps({ nearRpcUrl: "https://test.rpc.fastnear.com" });
const fmt = (n) => (Number(n) / 1e24).toFixed(4);
const payout = process.argv[3] ?? deriveNoteAccount(randomBytes(32)).accountId; // a fresh account stands in for "the user's own wallet"

const bal = await near.nearBalance(me.accountId);
console.log("testnet account:", me.accountId, "| balance:", fmt(bal), "NEAR");
if (bal < 2n * 10n ** 24n) { console.log("Fund this account with 2+ testnet NEAR (https://near-faucet.io), then run again."); process.exit(0); }

const price = (await near.view(LST, "get_summary")).ft_price;
console.log("rNEAR price (NEAR per rNEAR):", fmt(price));
const key = { accountId: me.accountId, secretKey: me.secretKey };
if (!(await near.storageRegistered(LST, me.accountId))) {
  console.log("registering on the rNEAR token…");
  await near.call({ ...key, contractId: LST, method: "storage_deposit", args: { account_id: me.accountId, registration_only: true }, deposit: 1_250_000_000_000_000_000_000n, gas: 30_000_000_000_000n });
}
const before = await near.ftBalance(LST, me.accountId);
console.log("staking 1 NEAR with 200 Tgas…");
const tx = await near.call({ ...key, contractId: LST, method: "deposit_and_stake", args: {}, deposit: 10n ** 24n, gas: 200_000_000_000_000n });
console.log("stake tx:", tx.txHash);
const got = (await near.ftBalance(LST, me.accountId)) - before;
console.log("rNEAR received:", fmt(got), "| NEAR left:", fmt(await near.nearBalance(me.accountId)));
if (got > 0n) {
  const t = await near.transferFromNote({ ...key, tokenContract: LST, to: payout, amount: got });
  console.log("forwarded to", payout, "tx:", t.txHash, "| payout rNEAR:", fmt(await near.ftBalance(LST, payout)));
}

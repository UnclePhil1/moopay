/*
 * NEAR testnet end-to-end for the claim-link path: real key derivation, real funding, real
 * storage registration and a real signed ft_transfer. 1Click has no testnet, so it is faked.
 * Uses wNEAR on testnet (wrap.testnet) as the token and a throwaway funder created via the testnet helper.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import { makeNearOps } from "../src/agent/chains/near.js";
import { MooPayService } from "../src/agent/service.js";
import { Ledger } from "../src/storage/ledger.js";
import type { OneClick, Token } from "../src/agent/intents/oneclick.js";
import { ETH_ADDR, ETH_USDC, FakeOneClick, TOKENS } from "../tests/fakes/helpers.js";

const RPC = "https://rpc.testnet.near.org";
const TOKEN = "wrap.testnet";
const ASSET = "nep141:wrap.testnet";
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

const provider = new JsonRpcProvider({ url: RPC });
const ops = makeNearOps({ nearRpcUrl: RPC });

const kp = KeyPair.fromRandom("ed25519");
const funderId = `moopay-e2e-${Date.now().toString(36)}.testnet`;
const res = await fetch("https://helper.testnet.near.org/account", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ newAccountId: funderId, newAccountPublicKey: kp.getPublicKey().toString() }),
});
assert.equal(res.status, 200, "testnet helper could not create the funder account");
const funder = new Account(funderId, provider, kp.toString() as never);
console.log("funder", funderId, "balance", (await ops.nearBalance(funderId)) / NEAR, "NEAR");

// wNEAR for the funder.
const AMOUNT = 4n * NEAR / 10n; // 0.4 wNEAR (near_deposit keeps ~0.00125 for storage)
await funder.callFunction({ contractId: TOKEN, methodName: "near_deposit", args: {}, deposit: 5n * NEAR / 10n, gas: 30n * TGAS });
console.log("funder wNEAR", await ops.ftBalance(TOKEN, funderId));

class TestnetOneClick extends FakeOneClick {
  override async tokens(): Promise<Token[]> {
    return [{ assetId: ASSET, decimals: 24, blockchain: "near", symbol: "wNEAR", contractAddress: TOKEN }, ...TOKENS];
  }
  override async findToken(id: string) {
    return (await this.tokens()).find((t) => t.assetId === id);
  }
  override async quote(req: Parameters<FakeOneClick["quote"]>[0]) {
    const q = await super.quote(req);
    // Pretend 1Click's deposit address is a fresh, unregistered implicit account.
    if (!req.dry) q.quote.depositAddress = randomBytes(32).toString("hex");
    return q;
  }
}

const oc = new TestnetOneClick();
const service = new MooPayService({
  ledger: await Ledger.open(join(mkdtempSync(join(tmpdir(), "moopay-testnet-")), "state.json")),
  oneClick: oc as unknown as OneClick,
  near: ops,
  confidentiality: "basic",
});

const note = await service.mint({ assetId: ASSET, amount: AMOUNT.toString() });
const noteAccount = note.escrow.address;
console.log("minted; note account", noteAccount.slice(0, 16) + "…");

// Before funding the chain must say "not funded".
await assert.rejects(
  service.route({ secretKeyString: note.secretKeyString, destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: ETH_ADDR, dryRun: false }),
  (e: { code?: string }) => e.code === "NOTE_NOT_FUNDED",
);
console.log("unfunded claim rejected from on-chain state");

// Sender performs the three funding steps from mint's fundingSteps.
await funder.transfer({ receiverId: noteAccount, amount: 5n * NEAR / 100n }); // 0.05 NEAR, creates the implicit account
await funder.callFunction({ contractId: TOKEN, methodName: "storage_deposit", args: { account_id: noteAccount, registration_only: true }, deposit: 125n * NEAR / 100_000n, gas: 30n * TGAS });
await funder.callFunction({ contractId: TOKEN, methodName: "ft_transfer", args: { receiver_id: noteAccount, amount: AMOUNT.toString() }, deposit: 1n, gas: 30n * TGAS });

const st = (await service.noteStatus(note.commitment)) as { funding: { funded: boolean; tokenBalance: bigint } };
assert.equal(st.funding.funded, true);
console.log("note funded on testnet:", st.funding.tokenBalance.toString());

const dry = await service.route({ secretKeyString: note.secretKeyString, destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: ETH_ADDR });
assert.equal((dry as { dryRun: boolean }).dryRun, true);

const live = (await service.route({ secretKeyString: note.secretKeyString, destinationChain: "eth", destinationAssetId: ETH_USDC, recipient: ETH_ADDR, dryRun: false })) as {
  depositAddress: string;
  txHash: string;
};
console.log("claim sent; tx", live.txHash, "to", live.depositAddress.slice(0, 16) + "…");
assert.equal(await ops.ftBalance(TOKEN, live.depositAddress), AMOUNT);
assert.equal(await ops.ftBalance(TOKEN, noteAccount), 0n);
console.log("TESTNET E2E OK: derived key signed the transfer; deposit address received", AMOUNT.toString());

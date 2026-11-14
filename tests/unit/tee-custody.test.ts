import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { actions, createTransaction, encodeTransaction, PublicKey, Signer } from "near-api-js";
import { AgentStore, DEFAULT_RULES } from "../../src/agent/store.js";
DEFAULT_RULES.approveAboveUsd = 25;
import { AgentOps } from "../../src/agent/ops.js";
import type { NearOps } from "../../src/agent/chains/near.js";
import { MooPayService } from "../../src/agent/service.js";
import { ClaimDesk } from "../../src/agent/claims.js";
import { Ledger } from "../../src/storage/ledger.js";
import { Stats } from "../../src/storage/stats.js";
import type { OneClick } from "../../src/agent/intents/oneclick.js";
import { FakeNear, FakeOneClick, TOKENS } from "../fakes/helpers.js";
import { FixedKeySource } from "../../src/signer/keys.js";
import { signerServer, WalletSigner } from "../../src/signer/service.js";
import { SignerPasskeys } from "../../src/signer/passkeys.js";
import { MemoryStateStore } from "../../src/signer/state.js";

const TOKEN = "t".repeat(43), SECRET = "s".repeat(40);
const USDC_CONTRACT = TOKENS[1]!.contractAddress!;
const caps = { NEAR: { perTx: 10n ** 24n, daily: 3n * 10n ** 24n }, [USDC_CONTRACT]: { perTx: 50_000_000n, daily: 100_000_000n } };
/** 1 USDC a day, and a little NEAR for storage fees, with no passkey. */
const policy = { caps, unattended: { [USDC_CONTRACT]: { perTx: 1_000_000n, daily: 1_000_000n }, NEAR: { perTx: 10n ** 22n, daily: 10n ** 23n } } };

async function withSigner<T>(fn: (url: string, signer: WalletSigner) => Promise<T>): Promise<T> {
  const signer = new WalletSigner(new FixedKeySource("tee-custody"), policy, new SignerPasskeys("https://moopay.cash", 0), new MemoryStateStore());
  const server = signerServer(signer, SECRET);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, signer); } finally { server.close(); }
}
const openStore = async () => AgentStore.open(join(mkdtempSync(join(tmpdir(), "moopay-tee-")), "a.json"));
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("custody: with no signer set, accounts are made exactly as before", async () => {
  const store = await openStore();
  await store.prepare(TOKEN); // does nothing
  const u = store.open(TOKEN);
  assert.equal(u.tee, undefined);
  assert.equal(typeof store.keyOf(u).secretKey, "string", "the old server-held key");
  assert.equal(store.rawKeyOf(u).secretKey, store.keyOf(u).secretKey);
});

test("custody: with a signer set, a new account's address comes from the signer and the server keeps no key", async () => {
  await withSigner(async (url, signer) => {
    const store = await openStore();
    store.useSigner({ url, token: SECRET });
    await store.prepare(TOKEN);
    const u = store.open(TOKEN);
    const mine = await signer.pubkey(u.id);
    assert.equal(u.accountId, mine.accountId);
    assert.deepEqual(u.tee, { publicKey: mine.publicKey });
    const k = store.keyOf(u);
    assert.ok(k.secretKey instanceof Signer, "a signer object, not a key string");
    assert.equal(k.publicKey, mine.publicKey);
    assert.throws(() => store.rawKeyOf(u), code("INVALID_INPUT"), "no key can be shown or backed up");
    assert.doesNotMatch(JSON.stringify(u), /ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/, "no secret key text in the saved record");
  });
});

test("custody: an account is never made on a server key when a signer is set but unreachable", async () => {
  const store = await openStore();
  store.useSigner({ url: "http://127.0.0.1:1", token: SECRET });
  await assert.rejects(store.prepare(TOKEN), code("UPSTREAM_TIMEOUT"));
  assert.throws(() => store.open(TOKEN), /secure signer/i, "opening without the signer's answer fails instead of falling back");
});

test("custody: accounts made before the signer was turned on keep working on their own key", async () => {
  await withSigner(async (url) => {
    const store = await openStore();
    const old = store.open(TOKEN); // made with no signer
    store.useSigner({ url, token: SECRET });
    await store.prepare(TOKEN);
    assert.equal(store.open(TOKEN), old);
    assert.equal(typeof store.keyOf(old).secretKey, "string");
    await store.prepare("n".repeat(43));
    assert.ok(store.open("n".repeat(43)).tee, "a new one goes to the signer");
  });
});

test("custody: payments are signed by the signer, small ones on their own and larger ones refused until a passkey exists", async () => {
  await withSigner(async (url) => {
    const dir = mkdtempSync(join(tmpdir(), "moopay-tee-"));
    const near = new FakeNear(), oc = new FakeOneClick();
    let svc!: MooPayService;
    const claims = await ClaimDesk.open({ near: near as unknown as NearOps, tokens: () => svc.payAssets(), units: (t, tok) => svc.claimUnits(t, tok as never), swapOut: (p) => svc.claimSwapOut(p), file: join(dir, "c.json") } as never);
    svc = new MooPayService({ ledger: await Ledger.open(join(dir, "s.json")), oneClick: oc as unknown as OneClick, near: near as unknown as NearOps, confidentiality: "basic", stats: await Stats.open(join(dir, "st.json")), claims } as never);
    const store = await AgentStore.open(join(dir, "a.json"));
    store.useSigner({ url, token: SECRET });
    await store.prepare(TOKEN);
    const u = store.open(TOKEN), ops = new AgentOps(svc, store, () => 1_800_000_000_000);
    near.fund(u.accountId, 20_000_000n);

    await ops.send(u, { amountUsd: "0.5", chain: "near", recipient: "bob.near" });
    const used = near.transfers.at(-1)!.secretKey as unknown as Signer;
    assert.ok(used instanceof Signer, "the wallet call got the signer, not a key");

    // Sign the same payment for real through that signer, as the NEAR library would.
    const pk = await used.getPublicKey(), mk = (amount: string) => createTransaction(u.accountId, pk, USDC_CONTRACT, 1n, [actions.functionCall("ft_transfer", { receiver_id: "bob.near", amount }, 12n * 10n ** 12n, 1n)], new Uint8Array(32));
    const out = (await used.signTransaction(mk("500000"))) as unknown as { txHash: Uint8Array };
    assert.ok(out.txHash.length === 32);
    await assert.rejects(used.signTransaction(mk("5000000")), (e) => (e as { details?: { reason?: string } }).details?.reason === "passkey_required", "above the free allowance the signer wants a passkey");
    assert.ok(encodeTransaction(mk("1")).length > 0 && PublicKey.from(store.keyOf(u).publicKey));
  });
});

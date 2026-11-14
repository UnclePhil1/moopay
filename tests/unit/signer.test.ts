import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { actions, createTransaction, encodeTransaction, PublicKey, type Transaction } from "near-api-js";
import { FixedKeySource, deriveWallet } from "../../src/signer/keys.js";
import { checkCaps, inspect, Ledger, Refused, type SignerPolicy } from "../../src/signer/policy.js";
import { signerServer, WalletSigner } from "../../src/signer/service.js";
import { RemoteSigner } from "../../src/signer/client.js";

const TOKEN = "t".repeat(40);
const USDC = "usdc.token.near";
const policy: SignerPolicy = { caps: { NEAR: { perTx: 10n ** 24n, daily: 3n * 10n ** 24n }, [USDC]: { perTx: 50_000_000n, daily: 100_000_000n } } };
const keys = new FixedKeySource("unit");
const hash = new Uint8Array(32);

async function setup(p: SignerPolicy = policy, now = () => Date.now()) {
  const signer = new WalletSigner(keys, p, new Ledger(now));
  return { signer, me: await signer.pubkey("alice") };
}
const mk = (signerId: string, pub: string, receiver: string, acts: ReturnType<typeof actions.transfer>[]): Transaction => createTransaction(signerId, PublicKey.from(pub), receiver, 1n, acts, hash);
const ft = (to: string, amount: string) => actions.functionCall("ft_transfer", { receiver_id: to, amount }, 12n * 10n ** 12n, 1n);

test("signer: each user gets their own wallet, the same one every time", async () => {
  const root = await keys.root();
  assert.equal(deriveWallet(root, "alice").accountId, deriveWallet(root, "alice").accountId);
  assert.notEqual(deriveWallet(root, "alice").accountId, deriveWallet(root, "bob").accountId);
  assert.notEqual(deriveWallet(await new FixedKeySource("other").root(), "alice").accountId, deriveWallet(root, "alice").accountId, "a different root key means different wallets");
});

test("signer: reads transfers and token transfers, and refuses everything else", async () => {
  const { me } = await setup();
  const ok = inspect(encodeTransaction(mk(me.accountId, me.publicKey, USDC, [ft("bob.near", "5000000")])));
  assert.deepEqual(ok.outflows.map((o) => [o.asset, o.amount, o.to]), [[USDC, 5_000_000n, "bob.near"]]);
  const near = inspect(encodeTransaction(mk(me.accountId, me.publicKey, "bob.near", [actions.transfer(10n ** 24n)])));
  assert.deepEqual(near.outflows.map((o) => [o.asset, o.amount]), [["NEAR", 10n ** 24n]]);
  for (const bad of [actions.addFullAccessKey(PublicKey.from(me.publicKey)), actions.deleteAccount("x.near"), actions.deployContract(new Uint8Array([0])), actions.functionCall("anything_else", {}, 1n, 0n)]) {
    assert.throws(() => inspect(encodeTransaction(mk(me.accountId, me.publicKey, "bob.near", [bad]))), (e) => e instanceof Refused && e.code === "forbidden_action");
  }
  assert.throws(() => inspect(new Uint8Array([1, 2, 3])), (e) => e instanceof Refused && e.code === "bad_transaction");
});

test("signer: NEAR attached to a call counts as money leaving", async () => {
  const { me } = await setup();
  const stake = inspect(encodeTransaction(mk(me.accountId, me.publicKey, "rnear.near", [actions.functionCall("deposit_and_stake", {}, 1n, 5n * 10n ** 24n)])));
  assert.deepEqual(stake.outflows.map((o) => [o.asset, o.amount]), [["NEAR", 5n * 10n ** 24n]]);
});

test("signer: per-payment and daily limits, and assets it does not know are refused", async () => {
  const { signer, me } = await setup();
  const send = (to: string, amount: string, asset = USDC) => signer.sign("alice", encodeTransaction(mk(me.accountId, me.publicKey, asset, [ft(to, amount)])));
  await send("bob.near", "50000000");
  await assert.rejects(send("bob.near", "50000001"), (e) => e instanceof Refused && e.code === "over_limit", "more than the per-payment limit");
  await send("bob.near", "50000000");
  await assert.rejects(send("bob.near", "1"), (e) => e instanceof Refused && e.code === "over_limit", "the day's total is used up");
  await assert.rejects(send("bob.near", "1", "random.token.near"), (e) => e instanceof Refused && e.code === "unknown_asset");
});

test("signer: the daily total resets the next day, and a refusal does not use any of it", async () => {
  let t = Date.parse("2026-11-14T10:00:00Z");
  const { signer, me } = await setup(policy, () => t);
  const send = (amount: string) => signer.sign("alice", encodeTransaction(mk(me.accountId, me.publicKey, USDC, [ft("bob.near", amount)])));
  await send("50000000"); await send("50000000");
  await assert.rejects(send("1"));
  t += 24 * 3600 * 1000;
  await send("50000000");
  const l = new Ledger(); checkCaps(policy, l, "x", [{ asset: USDC, amount: 1n, to: "b", method: "ft_transfer" }]);
  assert.equal(l.used("x", USDC), 0n, "checking does not record");
});

test("signer: the signature is valid, and a transaction for another key is refused", async () => {
  const { signer, me } = await setup();
  const tx = mk(me.accountId, me.publicKey, "bob.near", [actions.transfer(1n)]);
  const out = await signer.sign("alice", encodeTransaction(tx));
  assert.ok(out.signed.length > 64 && out.txHash.length > 30);
  const other = await signer.pubkey("bob");
  await assert.rejects(signer.sign("alice", encodeTransaction(mk(me.accountId, other.publicKey, "bob.near", [actions.transfer(1n)]))), (e) => e instanceof Refused && /different key/.test(e.message), "alice's signer will not sign with bob's key named");
  await assert.rejects(signer.sign("../etc", encodeTransaction(tx)), (e) => e instanceof Refused);
});

test("signer: over HTTP, through the remote signer", async () => {
  const signer = new WalletSigner(keys, policy);
  const server = signerServer(signer, TOKEN);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(url + "/health")).status, 200);
    assert.equal((await fetch(url + "/v1/pubkey", { method: "POST", body: JSON.stringify({ userId: "alice" }) })).status, 401, "no token, no answer");
    assert.equal((await fetch(url + "/v1/pubkey", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
    const remote = await RemoteSigner.connect(url, TOKEN, "alice");
    const direct = await signer.pubkey("alice");
    assert.equal(remote.accountId, direct.accountId);
    assert.equal((await remote.getPublicKey()).toString(), direct.publicKey);
    const tx = mk(remote.accountId, direct.publicKey, USDC, [ft("bob.near", "1000000")]);
    const signed = (await remote.signTransaction(tx)) as unknown as { txHash: Uint8Array; signedTransaction: { signature: { ed25519Signature: { data: Uint8Array } } } };
    assert.equal(signed.signedTransaction.signature.ed25519Signature.data.length, 64);
    assert.ok(PublicKey.from(direct.publicKey).verify(signed.txHash, Uint8Array.from(signed.signedTransaction.signature.ed25519Signature.data)), "the signature checks out against the wallet's public key");
    await assert.rejects(remote.signTransaction(mk(remote.accountId, direct.publicKey, "x.near", [actions.addFullAccessKey(PublicKey.from(direct.publicKey))])), /not allowed|only transfers/i);
    await assert.rejects(remote.signTransaction(mk(remote.accountId, direct.publicKey, USDC, [ft("bob.near", "999999999")])), /limit/i);
  } finally { server.close(); }
});

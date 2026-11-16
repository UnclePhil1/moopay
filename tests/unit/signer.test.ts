import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { actions, createTransaction, encodeTransaction, PublicKey, type Transaction } from "near-api-js";
import { FixedKeySource, deriveWallet } from "../../src/signer/keys.js";
import { emptyTally, inspect, Refused, Tally, withinCaps, type SignerPolicy } from "../../src/signer/policy.js";
import { MemoryStateStore, NearStateStore, type StateStore, type UserState, type Versioned } from "../../src/signer/state.js";
import { signerServer, WalletSigner, type Approval } from "../../src/signer/service.js";
import { actionChallenge, mandateChallenge, paymentChallenge, SignerPasskeys, type Action } from "../../src/signer/passkeys.js";
import { RemoteSigner, SignerApi } from "../../src/signer/client.js";
import { ORIGIN, phone } from "../fakes/phone.js";
import * as page from "../../src/web/src/signer-challenge.js";

const TOKEN = "t".repeat(40);
const USDC = "usdc.token.near";
const caps = { NEAR: { perTx: 10n ** 24n, daily: 3n * 10n ** 24n }, [USDC]: { perTx: 50_000_000n, daily: 100_000_000n } };
/** Everything is allowed without a passkey: the original limits tests. */
const open: SignerPolicy = { caps, unattended: caps };
/** A small free allowance: 1 USDC a day with no passkey. */
const small: SignerPolicy = { caps, unattended: { [USDC]: { perTx: 1_000_000n, daily: 1_000_000n } } };
const keys = new FixedKeySource("unit");
const hash = new Uint8Array(32);
const HOUR = 3600_000;

function setup(p: SignerPolicy = open, now = () => Date.now(), delay = 0, store: StateStore = new MemoryStateStore()) {
  return new WalletSigner(keys, p, new SignerPasskeys(ORIGIN, delay, now), store, now);
}
const mk = (signerId: string, pub: string, receiver: string, acts: ReturnType<typeof actions.transfer>[]): Transaction => createTransaction(signerId, PublicKey.from(pub), receiver, 1n, acts, hash);
const ft = (to: string, amount: string) => actions.functionCall("ft_transfer", { receiver_id: to, amount }, 12n * 10n ** 12n, 1n);
const pay = (me: { accountId: string; publicKey: string }, to: string, amount: string, asset = USDC) => mk(me.accountId, me.publicKey, asset, [ft(to, amount)]);

/** Enrols a pretend phone, as the browser would: options from the signer, a created credential back. */
async function enrol(signer: WalletSigner, user: string, ph = phone()) {
  await signer.addPasskey(user, ph.create((await signer.registerOptions(user)).challenge));
  return ph;
}
/** What the browser does to approve one payment: ask for a nonce, hash it with what the card shows, have the phone sign it. */
async function approve(signer: WalletSigner, user: string, ph: ReturnType<typeof phone>, tx: Transaction): Promise<Approval> {
  const nonce = signer.nonce(user);
  return { nonce, assertion: ph.get(paymentChallenge(user, nonce, inspect(encodeTransaction(tx)).outflows)) };
}
async function approveAction(signer: WalletSigner, user: string, ph: ReturnType<typeof phone>, action: Action): Promise<Approval> {
  const nonce = signer.nonce(user);
  return { nonce, assertion: ph.get(actionChallenge(user, nonce, action)) };
}
const code = (c: string) => (e: unknown) => e instanceof Refused && e.code === c;

test("signer: each user gets their own wallet, the same one every time", async () => {
  const root = await keys.root();
  assert.equal(deriveWallet(root, "alice").accountId, deriveWallet(root, "alice").accountId);
  assert.notEqual(deriveWallet(root, "alice").accountId, deriveWallet(root, "bob").accountId);
  assert.notEqual(deriveWallet(await new FixedKeySource("other").root(), "alice").accountId, deriveWallet(root, "alice").accountId, "a different root key means different wallets");
});

test("signer: reads transfers and token transfers, and refuses everything else", async () => {
  const me = await setup().pubkey("alice");
  const ok = inspect(encodeTransaction(pay(me, "bob.near", "5000000")));
  assert.deepEqual(ok.outflows.map((o) => [o.asset, o.amount, o.to]), [[USDC, 5_000_000n, "bob.near"]]);
  const near = inspect(encodeTransaction(mk(me.accountId, me.publicKey, "bob.near", [actions.transfer(10n ** 24n)])));
  assert.deepEqual(near.outflows.map((o) => [o.asset, o.amount]), [["NEAR", 10n ** 24n]]);
  for (const bad of [actions.deleteAccount("x.near"), actions.deployContract(new Uint8Array([0])), actions.functionCall("anything_else", {}, 1n, 0n)]) {
    assert.throws(() => inspect(encodeTransaction(mk(me.accountId, me.publicKey, "bob.near", [bad]))), code("forbidden_action"));
  }
  assert.throws(() => inspect(new Uint8Array([1, 2, 3])), code("bad_transaction"));
});

test("signer: NEAR attached to a call counts as money leaving", async () => {
  const me = await setup().pubkey("alice");
  const stake = inspect(encodeTransaction(mk(me.accountId, me.publicKey, "lst.rhealab.near", [actions.functionCall("deposit_and_stake", {}, 1n, 5n * 10n ** 24n)])));
  assert.deepEqual(stake.outflows.map((o) => [o.asset, o.amount]), [["NEAR", 5n * 10n ** 24n]]);
});

test("signer: per-payment and daily limits, and assets it does not know are refused", async () => {
  const signer = setup(), me = await signer.pubkey("alice");
  const send = (amount: string, asset = USDC) => signer.sign("alice", encodeTransaction(pay(me, "bob.near", amount, asset)));
  await send("50000000");
  await assert.rejects(send("50000001"), code("over_limit"), "more than the per-payment limit");
  await send("50000000");
  await assert.rejects(send("1"), code("over_limit"), "the day's total is used up");
  await assert.rejects(send("1", "random.token.near"), code("unknown_asset"));
});

test("signer: the daily total resets the next day, and a check does not record anything", async () => {
  let t = Date.parse("2026-11-14T10:00:00Z");
  const signer = setup(open, () => t), me = await signer.pubkey("alice");
  const send = (amount: string) => signer.sign("alice", encodeTransaction(pay(me, "bob.near", amount)));
  await send("50000000"); await send("50000000");
  await assert.rejects(send("1"));
  t += 24 * HOUR;
  await send("50000000");
  const tally = new Tally(emptyTally()); withinCaps(caps, tally, [{ asset: USDC, amount: 1n, to: "b", method: "ft_transfer" }]);
  assert.equal(tally.used(USDC), 0n);
});

test("signer: the signature is valid, and a transaction for another key is refused", async () => {
  const signer = setup(), me = await signer.pubkey("alice");
  const out = await signer.sign("alice", encodeTransaction(mk(me.accountId, me.publicKey, "bob.near", [actions.transfer(1n)])));
  assert.ok(out.signed.length > 64 && out.txHash.length > 30);
  const other = await signer.pubkey("bob");
  await assert.rejects(signer.sign("alice", encodeTransaction(mk(me.accountId, other.publicKey, "bob.near", [actions.transfer(1n)]))), (e) => e instanceof Refused && /different key/.test(e.message));
  await assert.rejects(signer.sign("../etc", encodeTransaction(pay(me, "b.near", "1"))), (e) => e instanceof Refused);
});

test("passkey: with no passkey only the small free allowance can move", async () => {
  const signer = setup(small), me = await signer.pubkey("alice");
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "1000000")));
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "1"))), code("passkey_required"), "the free allowance is used up");
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "2000000"))), code("passkey_required"));
  await assert.rejects(signer.sign("alice", encodeTransaction(mk(me.accountId, me.publicKey, "bob.near", [actions.transfer(1n)]))), code("passkey_required"), "an asset with no free allowance always needs a passkey");
});

test("passkey: a payment above the free allowance needs a signature for that exact payment", async () => {
  const signer = setup(small), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const tx = pay(me, "bob.near", "20000000");
  await assert.rejects(signer.sign("alice", encodeTransaction(tx)), code("passkey_required"), "no signature, no payment");
  const ok = await approve(signer, "alice", ph, tx);
  assert.ok((await signer.sign("alice", encodeTransaction(tx), ok)).signed.length > 64);
  await assert.rejects(signer.sign("alice", encodeTransaction(tx), ok), code("bad_assertion"), "the same signature cannot be used twice");
});

test("passkey: a signature for one payment cannot be used for a different amount, a different recipient or another user's wallet", async () => {
  const signer = setup(small), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const shown = pay(me, "bob.near", "20000000");
  for (const sent of [pay(me, "bob.near", "30000000"), pay(me, "mallory.near", "20000000")]) {
    const a = await approve(signer, "alice", ph, shown);
    await assert.rejects(signer.sign("alice", encodeTransaction(sent), a), code("bad_assertion"), "what was shown must be what is sent");
  }
  const bob = await signer.pubkey("bob"); await enrol(signer, "bob");
  const a = await approve(signer, "alice", ph, shown);
  await assert.rejects(signer.sign("bob", encodeTransaction(pay(bob, "bob.near", "20000000")), a), code("bad_assertion"), "alice's phone cannot spend bob's wallet");
});

test("passkey: a signature needs a fingerprint or PIN, the right site, and a counter that goes up", async () => {
  const signer = setup(small), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const tx = pay(me, "bob.near", "20000000"), flows = inspect(encodeTransaction(tx)).outflows;
  const tries: [string, (n: string) => unknown][] = [
    ["no user verification", (n) => ph.get(paymentChallenge("alice", n, flows), 5, 0x01)],
    ["a look-alike site", (n) => ph.get(paymentChallenge("alice", n, flows), 6, 0x05, "https://moopay-cash.evil.example")],
    ["a made-up nonce", () => ph.get(paymentChallenge("alice", "not-issued", flows), 7)],
  ];
  for (const [why, make] of tries) {
    const nonce = signer.nonce("alice");
    await assert.rejects(signer.sign("alice", encodeTransaction(tx), { nonce: why === "a made-up nonce" ? "not-issued" : nonce, assertion: make(nonce) as never }), code("bad_assertion"), why);
  }
  const good = await approve(signer, "alice", ph, tx);
  await signer.sign("alice", encodeTransaction(tx), good);
  const nonce = signer.nonce("alice");
  await assert.rejects(signer.sign("alice", encodeTransaction(tx), { nonce, assertion: ph.get(paymentChallenge("alice", nonce, flows), 1) as never }), code("bad_assertion"), "an old counter looks like a cloned key");
});

test("passkey: on an account that never moved money, the first passkey counts at once", async () => {
  const t = Date.parse("2026-11-14T10:00:00Z");
  const signer = setup(small, () => t, 24 * HOUR), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const tx = pay(me, "bob.near", "20000000");
  assert.equal((await signer.status("alice")).active, true);
  assert.equal((await signer.status("alice")).pending, false);
  await signer.sign("alice", encodeTransaction(tx), await approve(signer, "alice", ph, tx));
});

test("passkey: once the account has moved money, the first passkey waits, so a thief who adds one cannot use it at once", async () => {
  let t = Date.parse("2026-11-14T10:00:00Z");
  const signer = setup(small, () => t, 24 * HOUR), me = await signer.pubkey("alice");
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "1000000")));
  const ph = await enrol(signer, "alice");
  const tx = pay(me, "bob.near", "20000000");
  assert.equal((await signer.status("alice")).pending, true);
  await assert.rejects(signer.sign("alice", encodeTransaction(tx), await approve(signer, "alice", ph, tx)), (e) => e instanceof Refused && e.code === "passkey_required" && /waiting period/.test(e.message));
  t += 25 * HOUR;
  assert.equal((await signer.status("alice")).active, true);
  await signer.sign("alice", encodeTransaction(tx), await approve(signer, "alice", ph, tx));
});

test("passkey: once one exists, adding another needs the first, even before it is in force", async () => {
  const signer = setup(small, undefined, 24 * HOUR);
  const mine = await enrol(signer, "alice"), thief = phone();
  const create = async () => thief.create((await signer.registerOptions("alice")).challenge);
  await assert.rejects(signer.addPasskey("alice", await create()), code("passkey_required"), "a stolen server cannot add its own device");
  await assert.rejects(signer.addPasskey("alice", await create(), await approveAction(signer, "alice", thief, "addkey")), code("bad_assertion"), "the thief's own phone is not a passkey on this account");
  await signer.addPasskey("alice", await create(), await approveAction(signer, "alice", mine, "addkey"));
  assert.equal((await signer.status("alice")).passkeys.length, 2);
});

test("passkey: strict mode makes even a tiny payment need the passkey, and only the passkey can change it", async () => {
  const signer = setup(small), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const tiny = pay(me, "bob.near", "100");
  await signer.sign("alice", encodeTransaction(tiny));
  await signer.setStrict("alice", true, await approveAction(signer, "alice", ph, "strict:on"));
  await assert.rejects(signer.sign("alice", encodeTransaction(tiny)), code("passkey_required"), "strict: no free payments");
  await assert.rejects(signer.setStrict("alice", false, await approveAction(signer, "alice", ph, "strict:on")), code("bad_assertion"), "a signature for turning it on cannot turn it off");
  await signer.sign("alice", encodeTransaction(tiny), await approve(signer, "alice", ph, tiny));
  await signer.setStrict("alice", false, await approveAction(signer, "alice", ph, "strict:off"));
  await signer.sign("alice", encodeTransaction(tiny));
});

test("passkey: locking needs nothing, unlocking needs the passkey, and a locked wallet signs nothing", async () => {
  const signer = setup(open), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const tx = pay(me, "bob.near", "100");
  await signer.lock("alice");
  await assert.rejects(signer.sign("alice", encodeTransaction(tx)), code("locked"));
  await assert.rejects(signer.sign("alice", encodeTransaction(tx), await approve(signer, "alice", ph, tx)), code("locked"), "not even with a passkey");
  await assert.rejects(signer.unlock("alice", await approveAction(signer, "alice", phone(), "unlock")), code("bad_assertion"));
  await signer.unlock("alice", await approveAction(signer, "alice", ph, "unlock"));
  await signer.sign("alice", encodeTransaction(tx));
});

test("passkey: even with a valid signature the hard caps still hold", async () => {
  const signer = setup(small), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const big = pay(me, "bob.near", "50000001");
  await assert.rejects(signer.sign("alice", encodeTransaction(big), await approve(signer, "alice", ph, big)), code("over_limit"));
});

test("signer: over HTTP, through the remote signer and the passkey calls", async () => {
  const signer = setup(small);
  const server = signerServer(signer, TOKEN);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(url + "/health")).status, 200);
    assert.equal((await fetch(url + "/v1/pubkey", { method: "POST", body: JSON.stringify({ userId: "alice" }) })).status, 401, "no token, no answer");
    assert.equal((await fetch(url + "/v1/pubkey", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
    const remote = await RemoteSigner.connect(url, TOKEN, "alice"), api = new SignerApi(url, TOKEN);
    const direct = await signer.pubkey("alice");
    assert.equal(remote.accountId, direct.accountId);
    assert.equal((await remote.getPublicKey()).toString(), direct.publicKey);

    const small1 = pay(direct, "bob.near", "1000000");
    const signed = (await remote.signTransaction(small1)) as unknown as { txHash: Uint8Array; signedTransaction: { signature: { ed25519Signature: { data: Uint8Array } } } };
    assert.ok(PublicKey.from(direct.publicKey).verify(signed.txHash, Uint8Array.from(signed.signedTransaction.signature.ed25519Signature.data)), "the signature checks out against the wallet's public key");
    await assert.rejects(remote.signTransaction(mk(remote.accountId, direct.publicKey, "x.near", [actions.addFullAccessKey(PublicKey.from(direct.publicKey))])), /recovery key|fingerprint|approved|only key/i);

    const ph = phone(), big = pay(direct, "bob.near", "20000000");
    await assert.rejects(remote.signTransaction(big), (e) => (e as { details?: { reason?: string } }).details?.reason === "passkey_required", "the app is told to ask for a passkey");
    await api.register("alice", ph.create(String((await api.registerOptions("alice"))["challenge"])));
    const st = await api.status("alice");
    assert.equal(st.passkeys.length, 1); assert.equal(st.active, true);
    const nonce = await api.nonce("alice");
    const proof = { nonce, assertion: ph.get(paymentChallenge("alice", nonce, inspect(encodeTransaction(big)).outflows)) };
    assert.ok(await remote.approved(proof).signTransaction(big));
    await assert.rejects(remote.approved(proof).signTransaction(big), /did not match/, "a signature is spent once");
    await api.lock("alice");
    assert.equal((await api.status("alice")).locked, true);
  } finally { server.close(); }
});

/** A store that can be told to fail, or to answer with an older copy, like a rolled-back disk or a lagging node. */
class Flaky implements StateStore {
  failSave = false; stale: Versioned | undefined;
  constructor(readonly inner: MemoryStateStore) {}
  async load(user: string) { return this.stale ?? this.inner.load(user); }
  async save(user: string, state: UserState, v: number) { if (this.failSave) throw new Refused("state_unavailable", "down"); return this.inner.save(user, state, v); }
}

test("state: a restart keeps passkeys, locks and the day's totals, because they are on record, not in memory", async () => {
  const store = new MemoryStateStore();
  const a = setup(small, undefined, 0, store), me = await a.pubkey("alice"), ph = await enrol(a, "alice");
  await a.sign("alice", encodeTransaction(pay(me, "bob.near", "1000000")));
  await a.setStrict("alice", true, await approveAction(a, "alice", ph, "strict:on"));
  await a.lock("alice");
  const b = setup(small, undefined, 0, store); // a fresh signer process over the same record
  const st = await b.status("alice");
  assert.deepEqual([st.passkeys.length, st.active, st.strict, st.locked], [1, true, true, true]);
  await assert.rejects(b.sign("alice", encodeTransaction(pay(me, "bob.near", "1"))), code("locked"));
});

test("state: the free allowance used today is remembered after a restart", async () => {
  const store = new MemoryStateStore();
  const me = await setup().pubkey("alice");
  await setup(small, undefined, 0, store).sign("alice", encodeTransaction(pay(me, "bob.near", "1000000")));
  await assert.rejects(setup(small, undefined, 0, store).sign("alice", encodeTransaction(pay(me, "bob.near", "1"))), code("passkey_required"), "a restart does not hand back the free allowance");
});

test("state: an older copy of the record cannot reset a limit, and nothing is signed", async () => {
  const flaky = new Flaky(new MemoryStateStore());
  const signer = setup(open, undefined, 0, flaky), me = await signer.pubkey("alice");
  const old = await flaky.load("alice"); // version 0: nothing spent yet
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "50000000")));
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "50000000")));
  flaky.stale = old; // the host serves the state from before those two payments
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "50000000"))), code("state_unavailable"), "the write is refused, so there is no signature");
});

test("state: if the record cannot be saved, nothing is signed", async () => {
  const flaky = new Flaky(new MemoryStateStore());
  const signer = setup(open, undefined, 0, flaky), me = await signer.pubkey("alice");
  flaky.failSave = true;
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "1"))), code("state_unavailable"));
  flaky.failSave = false;
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "1")));
});

test("state: payments sent at the same moment cannot beat the daily limit", async () => {
  const signer = setup(), me = await signer.pubkey("alice");
  const go = () => signer.sign("alice", encodeTransaction(pay(me, "bob.near", "50000000"))).then(() => "ok", () => "refused");
  const results = await Promise.all([go(), go(), go(), go(), go()]);
  assert.equal(results.filter((r) => r === "ok").length, 2, "the daily limit is 100 USDC, so two of 50");
});

test("state: the signer's own writer account is reserved and cannot be asked for as a user", async () => {
  const signer = setup();
  assert.ok((await signer.writer()).accountId.length === 64);
  await assert.rejects(signer.pubkey("__state-writer__"), (e) => e instanceof Refused);
});

test("state: the on-chain store reads what the contract returns, and any trouble means no signing", async () => {
  const provider = (answer: () => unknown) => ({ callFunction: async () => answer() }) as never;
  const none = new NearStateStore("state.near", provider(() => null), "w", "ed25519:x");
  assert.deepEqual(await none.load("alice"), { state: { credentials: [], activeAt: 0, strict: false, locked: false, total: { day: "", used: {} }, free: { day: "", used: {} } }, version: 0 });
  const some = new NearStateStore("state.near", provider(() => ({ version: 3, state: JSON.stringify({ credentials: [], activeAt: 0, strict: true, locked: false, total: { day: "d", used: {} }, free: { day: "d", used: {} } }) })), "w", "ed25519:x");
  const got = await some.load("alice");
  assert.equal(got.version, 3); assert.equal(got.state.strict, true);
  for (const bad of [() => { throw new Error("rpc down"); }, () => ({ version: "x", state: 1 }), () => ({ version: 1, state: "{not json" })]) {
    await assert.rejects(new NearStateStore("state.near", provider(bad), "w", "ed25519:x").load("alice"), code("state_unavailable"));
  }
});

const FEE = "fee.moopay.near";
const withFees: SignerPolicy = { ...small, feeAccount: FEE, feeCaps: { [USDC]: { perTx: 2_000_000n, daily: 3_000_000n } } };
type Flow = { asset: string; to: string; amount: bigint };
async function mandate(signer: WalletSigner, user: string, ph: ReturnType<typeof phone>, flows: Flow[], ttl?: number) {
  const nonce = signer.nonce(user);
  return signer.mandate(user, flows, { nonce, assertion: ph.get(mandateChallenge(user, nonce, flows)) }, ttl);
}

test("mandate: one passkey signature approves exactly one payment, however many transactions it takes to make it", async () => {
  const signer = setup(small), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const flow = { asset: USDC, to: "bob.near", amount: 20_000_000n };
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "20000000"))), code("passkey_required"));
  await mandate(signer, "alice", ph, [flow]);
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "12000000")));
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "8000000")));
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "2000000"))), code("passkey_required"), "the approved amount is used up, and 2 USDC is above the free allowance");
});

test("mandate: a different recipient, a bigger amount or a different asset is not covered", async () => {
  const signer = setup(small), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  await mandate(signer, "alice", ph, [{ asset: USDC, to: "bob.near", amount: 20_000_000n }]);
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "mallory.near", "20000000"))), code("passkey_required"), "another recipient");
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "20000001"))), code("passkey_required"), "one unit more");
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "20000000")));
});

test("mandate: it runs out after a few minutes, and needs a real passkey signature to make", async () => {
  let t = Date.parse("2026-11-14T10:00:00Z");
  const signer = setup(small, () => t), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const flow = { asset: USDC, to: "bob.near", amount: 20_000_000n };
  await mandate(signer, "alice", ph, [flow]);
  t += 11 * 60_000;
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "20000000"))), code("passkey_required"), "expired");
  const nonce = signer.nonce("alice");
  await assert.rejects(signer.mandate("alice", [flow], { nonce, assertion: phone().get(mandateChallenge("alice", nonce, [flow])) }), code("bad_assertion"), "someone else's phone");
  const n2 = signer.nonce("alice");
  await assert.rejects(signer.mandate("alice", [{ ...flow, amount: 30_000_000n }], { nonce: n2, assertion: ph.get(mandateChallenge("alice", n2, [flow])) }), code("bad_assertion"), "a signature for one list cannot approve a bigger one");
  await assert.rejects(signer.mandate("alice", [{ ...flow, amount: 60_000_000n }], await approveAction(signer, "alice", ph, "unlock")), code("over_limit"), "the hard cap holds before anything is checked");
});

test("mandate: works in strict mode (it is a passkey approval), but not on a locked wallet or before the first passkey counts", async () => {
  const signer = setup(small), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  await signer.setStrict("alice", true, await approveAction(signer, "alice", ph, "strict:on"));
  await mandate(signer, "alice", ph, [{ asset: USDC, to: "bob.near", amount: 100n }]);
  await signer.sign("alice", encodeTransaction(pay(me, "bob.near", "100")));
  await signer.lock("alice");
  await assert.rejects(mandate(signer, "alice", ph, [{ asset: USDC, to: "bob.near", amount: 100n }]), code("locked"));
  const t0 = Date.parse("2026-11-14T10:00:00Z");
  const fresh = setup(small, () => t0, 24 * HOUR), me2 = await fresh.pubkey("carol");
  await fresh.sign("carol", encodeTransaction(pay(me2, "bob.near", "1000000")));
  const ph2 = await enrol(fresh, "carol");
  await assert.rejects(mandate(fresh, "carol", ph2, [{ asset: USDC, to: "bob.near", amount: 100n }]), code("passkey_required"));
});

test("fees: transfers to MooPay's fee account need no passkey within their own small allowance, and nothing else gets that", async () => {
  const signer = setup(withFees), me = await signer.pubkey("alice");
  await signer.sign("alice", encodeTransaction(pay(me, FEE, "2000000")));
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, FEE, "2000001"))), code("over_limit"), "above the fee allowance for one transfer");
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, FEE, "2000000"))), code("over_limit"), "above the fee allowance for the day");
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "mallory.near", "5000000"))), code("passkey_required"), "any other recipient is not a fee");
  const plain = setup(small);
  await assert.rejects(plain.sign("alice", encodeTransaction(pay(me, FEE, "2000000"))), code("passkey_required"), "with no fee account configured it is an ordinary payment");
});

test("fees: they still work in strict mode, because they are taken with nobody there to sign", async () => {
  const signer = setup(withFees), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  await signer.setStrict("alice", true, await approveAction(signer, "alice", ph, "strict:on"));
  await signer.sign("alice", encodeTransaction(pay(me, FEE, "1000000")));
  await assert.rejects(signer.sign("alice", encodeTransaction(pay(me, "bob.near", "100"))), code("passkey_required"));
});

test("page and signer build the same challenge, so what the page signs is what the signer checks", async () => {
  const flows = [
    { asset: USDC, to: "bob.near", amount: 20_000_000n },
    { asset: "NEAR", to: "zoë-müller.near", amount: 10n ** 24n },
    { asset: USDC, to: "alice.near", amount: 1n },
  ];
  const asStrings = flows.map((f) => ({ ...f, amount: f.amount.toString() }));
  assert.equal(await page.mandateChallenge("user-1", "n0nce_-x", asStrings), mandateChallenge("user-1", "n0nce_-x", flows));
  assert.equal(await page.mandateChallenge("user-1", "n0nce_-x", [...asStrings].reverse()), mandateChallenge("user-1", "n0nce_-x", flows), "order of the list does not matter");
  for (const a of ["addkey", "strict:on", "strict:off", "unlock"] as const) assert.equal(await page.actionChallenge("user-1", "n0nce", a), actionChallenge("user-1", "n0nce", a));
  assert.notEqual(await page.mandateChallenge("user-1", "n0nce_-x", asStrings), await page.mandateChallenge("user-2", "n0nce_-x", asStrings), "the user is part of it");
  assert.notEqual(await page.mandateChallenge("user-1", "a", asStrings), await page.mandateChallenge("user-1", "b", asStrings), "so is the nonce");
});

test("page: amounts are read from a table the page owns, so the server cannot make a big payment look small", () => {
  const usdc = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  assert.equal(page.describeFlow({ asset: usdc, to: "bob.near", amount: "5000000" }), "5.00 USDC to bob.near");
  assert.equal(page.describeFlow({ asset: usdc, to: "bob.near", amount: "5500000" }), "5.50 USDC to bob.near");
  assert.equal(page.describeFlow({ asset: "NEAR", to: "bob.near", amount: "1500000000000000000000000" }), "1.50 NEAR to bob.near");
  assert.equal(page.describeFlow({ asset: "fake.near", to: "bob.near", amount: "5000000" }), "5000000 units of fake.near to bob.near", "an unknown token is never given a friendly name or decimals");
  assert.match(page.describeFlow({ asset: "NEAR", to: "bob.near", amount: "1e24" }), /units of NEAR/, "not a plain number: shown raw");
});

test("service: /v1/writer needs the token and returns only the state writer's address", async () => {
  const wallet = new WalletSigner(new FixedKeySource("w"), { caps: {}, unattended: {} }, new SignerPasskeys("https://moopay.cash", 0), new MemoryStateStore());
  const server = signerServer(wallet, "t".repeat(40), () => undefined, { writer: "abc123" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/writer`;
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const ok = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + "t".repeat(40) } });
    assert.deepEqual([ok.status, await ok.json()], [200, { writer: "abc123" }]);
  } finally { server.close(); }
});

const none: SignerPolicy = { caps, unattended: {} };

test("no free allowance: with nothing unattended, every payment needs the passkey, and without one it is refused", async () => {
  const signer = setup(none), me = await signer.pubkey("alice");
  const tx = pay(me, "bob.near", "100");
  await assert.rejects(signer.sign("alice", encodeTransaction(tx)), code("passkey_required"));
  const ph = await enrol(signer, "alice");
  await assert.rejects(signer.sign("alice", encodeTransaction(tx)), code("passkey_required"), "a registered passkey still has to approve");
  await signer.sign("alice", encodeTransaction(tx), await approve(signer, "alice", ph, tx));
});

import { KeyPair } from "near-api-js";
const addKeyTx = (me: { accountId: string; publicKey: string }, key: string, over: { receiver?: string; fn?: boolean; extra?: boolean } = {}) =>
  mk(me.accountId, me.publicKey, over.receiver ?? me.accountId, [
    over.fn ? actions.addFunctionCallAccessKey(PublicKey.from(key), "x.near", [], 0n) : actions.addFullAccessKey(PublicKey.from(key)),
    ...(over.extra ? [actions.transfer(1n)] : []),
  ]);

test("recovery key: a key the passkey approved by name can be added once, and nothing else can", async () => {
  const signer = setup(none), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
  const mine = KeyPair.fromRandom("ed25519").getPublicKey().toString(), other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const sign = (tx: Transaction) => signer.sign("alice", encodeTransaction(tx));

  await assert.rejects(sign(addKeyTx(me, mine)), code("passkey_required"), "not approved yet");
  await assert.rejects(signer.recoveryKey("alice", mine, await approveAction(signer, "alice", phone(), `recoverykey:${mine}`)), code("bad_assertion"), "a thief's own device cannot approve it");
  await assert.rejects(signer.recoveryKey("alice", mine, await approveAction(signer, "alice", ph, `recoverykey:${other}`)), code("bad_assertion"), "the signature names a different key");
  await signer.recoveryKey("alice", mine, await approveAction(signer, "alice", ph, `recoverykey:${mine}`));
  assert.deepEqual((await signer.status("alice")).recovery, { approved: [mine], added: [] });

  await assert.rejects(sign(addKeyTx(me, other)), code("passkey_required"), "only the key that was named");
  await assert.rejects(sign(addKeyTx(me, mine, { fn: true })), code("forbidden_action"), "full access only");
  await assert.rejects(sign(addKeyTx(me, mine, { receiver: "mallory.near" })), code("forbidden_action"), "only this same account");
  await assert.rejects(sign(addKeyTx(me, mine, { extra: true })), code("forbidden_action"), "never mixed with a payment");
  assert.ok((await sign(addKeyTx(me, mine))).signed.length > 0, "the approved key is signed");
  assert.deepEqual((await signer.status("alice")).recovery, { approved: [], added: [mine] });
  await assert.rejects(sign(addKeyTx(me, mine)), code("passkey_required"), "one use per approval");
});

test("recovery key: needs a passkey, is limited to three, and a locked wallet adds nothing", async () => {
  const signer = setup(none), me = await signer.pubkey("alice");
  const k = () => KeyPair.fromRandom("ed25519").getPublicKey().toString();
  await assert.rejects(signer.recoveryKey("alice", k(), { nonce: signer.nonce("alice"), assertion: {} as never }), code("passkey_required"), "no passkey, no recovery key");
  const ph = await enrol(signer, "alice");
  await assert.rejects(signer.recoveryKey("alice", "not-a-key", await approveAction(signer, "alice", ph, "recoverykey:not-a-key")), code("bad_transaction"));
  for (let i = 0; i < 3; i++) { const key = k(); await signer.recoveryKey("alice", key, await approveAction(signer, "alice", ph, `recoverykey:${key}`)); }
  const fourth = k();
  await assert.rejects(signer.recoveryKey("alice", fourth, await approveAction(signer, "alice", ph, `recoverykey:${fourth}`)), code("over_limit"));
  await signer.lock("alice");
  const st = (await signer.status("alice")).recovery!;
  await assert.rejects(signer.sign("alice", encodeTransaction(addKeyTx(me, st.approved[0]!))), code("locked"));
});

test("showcode: the owner's passkey can be checked without changing anything, and a thief's cannot", async () => {
  const signer = setup(none), ph = await enrol(signer, "alice");
  await assert.rejects(signer.verifyOwner("alice", await approveAction(signer, "alice", phone(), "showcode")), code("bad_assertion"));
  await assert.rejects(signer.verifyOwner("alice", await approveAction(signer, "alice", ph, "strict:on")), code("bad_assertion"), "a signature for another action does not count");
  await signer.verifyOwner("alice", await approveAction(signer, "alice", ph, "showcode"));
  const fresh = setup(none);
  await assert.rejects(fresh.verifyOwner("bob", { nonce: fresh.nonce("bob"), assertion: {} as never }), code("passkey_required"), "no passkey, nothing to check");
});

test("pinned calls: wrapping and staking are only signed on the official contracts, and storage only on known tokens", async () => {
  const signer = setup(none), me = await signer.pubkey("alice");
  const call = (to: string, method: string, args: object = {}, deposit = 1n) => mk(me.accountId, me.publicKey, to, [actions.functionCall(method, args, 30n * 10n ** 12n, deposit)]);
  const ok = (tx: Transaction) => inspect(encodeTransaction(tx));
  // the right contract reads fine
  ok(call("wrap.near", "near_deposit")); ok(call("wrap.near", "near_withdraw", { amount: "1" })); ok(call("lst.rhealab.near", "deposit_and_stake"));
  // a look-alike does not
  for (const [to, method] of [["wrap.near.evil.near", "near_deposit"], ["wrap.testnet", "near_withdraw"], ["lst.rhealab.near.x", "deposit_and_stake"], ["wrap.near", "deposit_and_stake"], ["lst.rhealab.near", "near_deposit"]] as const) {
    assert.throws(() => ok(call(to, method)), code("forbidden_action"), `${method} on ${to}`);
  }
  // storage_deposit: a token on the signer's list, or one of the two pinned contracts; nothing else
  const sign = (to: string) => signer.sign("alice", encodeTransaction(call(to, "storage_deposit", { account_id: me.accountId, registration_only: true })));
  await assert.rejects(sign("evil.near"), code("forbidden_action"));
  await assert.rejects(sign("usdc.token.near.evil"), code("forbidden_action"));
  const ph = await enrol(signer, "alice");
  void ph;
  assert.deepEqual(ok(call(USDC, "storage_deposit")).storageOn, [USDC]);
});

test("passkey removal: needs a passkey signing that exact removal, and the last passkey can never go", async () => {
  const signer = setup(small, undefined, 24 * HOUR);
  const mine = await enrol(signer, "alice"), second = phone(), thief = phone();
  const [first] = (await signer.status("alice")).passkeys;
  await assert.rejects(signer.removePasskey("alice", first!.id, await approveAction(signer, "alice", mine, `removekey:${first!.id}`)), code("bad_transaction"), "the only passkey stays");
  await signer.addPasskey("alice", second.create((await signer.registerOptions("alice")).challenge), await approveAction(signer, "alice", mine, "addkey"));
  const ids = (await signer.status("alice")).passkeys.map((p) => p.id), other = ids.find((i) => i !== first!.id)!;
  await assert.rejects(signer.removePasskey("alice", first!.id, await approveAction(signer, "alice", thief, `removekey:${first!.id}`)), code("bad_assertion"), "a stranger's device cannot remove it");
  await assert.rejects(signer.removePasskey("alice", first!.id, await approveAction(signer, "alice", mine, `removekey:${other}`)), code("bad_assertion"), "a signature for another passkey does not count");
  await assert.rejects(signer.removePasskey("alice", "nope", await approveAction(signer, "alice", mine, "removekey:nope")), code("bad_transaction"));
  await signer.removePasskey("alice", first!.id, await approveAction(signer, "alice", mine, `removekey:${first!.id}`));
  assert.deepEqual((await signer.status("alice")).passkeys.map((p) => p.id), [other]);
  await assert.rejects(signer.removePasskey("alice", other, await approveAction(signer, "alice", second, `removekey:${other}`)), code("bad_transaction"), "never down to none");
});

test("unstake and withdraw: signed on the rNEAR contract only, with nothing attached, and without a passkey", async () => {
  const signer = setup(small), me = await signer.pubkey("alice");
  const mkc = (to: string, method: string, deposit: bigint) => mk(me.accountId, me.publicKey, to, [actions.functionCall(method, {}, 30n * 10n ** 12n, deposit)]);
  for (const m of ["unstake_all", "withdraw_all"]) {
    assert.equal(inspect(encodeTransaction(mkc("lst.rhealab.near", m, 0n))).outflows.length, 0, m);
    assert.throws(() => inspect(encodeTransaction(mkc("lst.rhealab.near.evil", m, 0n))), code("forbidden_action"), `${m} on a look-alike`);
    assert.throws(() => inspect(encodeTransaction(mkc("lst.rhealab.near", m, 1n))), code("forbidden_action"), `${m} with NEAR attached`);
  }
  await signer.sign("alice", encodeTransaction(mkc("lst.rhealab.near", "withdraw_all", 0n))); // it only brings money back to the wallet
});

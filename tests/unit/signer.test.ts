import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { actions, createTransaction, encodeTransaction, PublicKey, type Transaction } from "near-api-js";
import { FixedKeySource, deriveWallet } from "../../src/signer/keys.js";
import { emptyTally, inspect, Refused, Tally, withinCaps, type SignerPolicy } from "../../src/signer/policy.js";
import { MemoryStateStore, NearStateStore, type StateStore, type UserState, type Versioned } from "../../src/signer/state.js";
import { signerServer, WalletSigner, type Approval } from "../../src/signer/service.js";
import { actionChallenge, paymentChallenge, SignerPasskeys, type Action } from "../../src/signer/passkeys.js";
import { RemoteSigner, SignerApi } from "../../src/signer/client.js";
import { ORIGIN, phone } from "../fakes/phone.js";

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
  for (const bad of [actions.addFullAccessKey(PublicKey.from(me.publicKey)), actions.deleteAccount("x.near"), actions.deployContract(new Uint8Array([0])), actions.functionCall("anything_else", {}, 1n, 0n)]) {
    assert.throws(() => inspect(encodeTransaction(mk(me.accountId, me.publicKey, "bob.near", [bad]))), code("forbidden_action"));
  }
  assert.throws(() => inspect(new Uint8Array([1, 2, 3])), code("bad_transaction"));
});

test("signer: NEAR attached to a call counts as money leaving", async () => {
  const me = await setup().pubkey("alice");
  const stake = inspect(encodeTransaction(mk(me.accountId, me.publicKey, "rnear.near", [actions.functionCall("deposit_and_stake", {}, 1n, 5n * 10n ** 24n)])));
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

test("passkey: the first passkey waits before it counts, so a thief who adds one cannot use it at once", async () => {
  let t = Date.parse("2026-11-14T10:00:00Z");
  const signer = setup(small, () => t, 24 * HOUR), me = await signer.pubkey("alice"), ph = await enrol(signer, "alice");
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
    await assert.rejects(remote.signTransaction(mk(remote.accountId, direct.publicKey, "x.near", [actions.addFullAccessKey(PublicKey.from(direct.publicKey))])), /not allowed|only transfers/i);

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

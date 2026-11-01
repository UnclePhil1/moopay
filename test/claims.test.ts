import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimDesk, CLAIM_WINDOW_MS } from "../src/lib/claims.js";
import { FakeNear } from "./helpers.js";

const TOKEN = { assetId: "nep141:usdc", symbol: "USDC", decimals: 6, contract: "usdc.near" };
const NEAR = { assetId: "nep141:wrap.near", symbol: "NEAR", decimals: 24, contract: "wrap.near", native: true, priceUsd: 5 };
const proof = (accountId: string) => ({ accountId, publicKey: "ed25519:x", signature: Buffer.from("sig").toString("base64") });

function desk() {
  let t = 1_000_000;
  const near = new FakeNear();
  const d = new ClaimDesk({ near: near as never, tokens: async () => [TOKEN, NEAR], units: (t: string, tok: { priceUsd?: number }) => BigInt(Math.ceil((Number(t) / (tok.priceUsd ?? 1)) * 1e6)) * 10n ** 18n, file: join(mkdtempSync(join(tmpdir(), "moopay-claims-")), "c.json"), now: () => t });
  return { d, near, advance: (ms: number) => (t += ms) };
}
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

test("claim link: only the named wallet claims, once; funds go to that wallet", async () => {
  const { d, near } = desk();
  const c = await d.create({ amount: "0.2", receiver: "bob.near" });
  assert.equal((await d.fundStatus(c.fundKey, "https://x")).state, "AWAITING_FUNDING");
  assert.equal((await d.claimView(c.claimKey)).state, "NOT_READY");
  await assert.rejects(d.claim(c.claimKey, proof("bob.near")), code("NOTE_NOT_FUNDED"));

  const plan = await d.fundPlan(c.fundKey, "alice.near");
  assert.equal(plan.token.amount, 200000n);
  near.fund(plan.noteAccountId, 200000n);
  const st = await d.fundStatus(c.fundKey, "https://x");
  assert.equal(st.state, "FUNDED");
  assert.equal(st.claimLink, `https://x/c/${c.claimKey}`);

  d.challenge(c.claimKey);
  await assert.rejects(d.claim(c.claimKey, proof("mallory.near")), code("BAD_RECIPIENT"));
  d.challenge(c.claimKey);
  near.badSigner = true;
  await assert.rejects(d.claim(c.claimKey, proof("bob.near")), code("BAD_RECIPIENT"));
  assert.equal(near.transfers.length, 0);
  near.badSigner = false;
  await assert.rejects(d.claim(c.claimKey, proof("bob.near")), code("INVALID_INPUT")); // challenge was used up

  d.challenge(c.claimKey);
  const r = await d.claim(c.claimKey, proof("bob.near"));
  assert.equal(r.state, "CLAIMED");
  assert.equal(near.transfers[0]?.to, "bob.near");
  assert.equal(near.transfers[0]?.amount, 200000n);
  d.challenge(c.claimKey);
  await assert.rejects(d.claim(c.claimKey, proof("bob.near")), code("NOTE_ALREADY_CLAIMED"));
});

test("claim link: after 24h the sender is refunded and the receiver can no longer claim", async () => {
  const { d, near, advance } = desk();
  const c = await d.create({ amount: "1", receiver: "bob.near" });
  const plan = await d.fundPlan(c.fundKey, "alice.near");
  near.fund(plan.noteAccountId, 1_000_000n);
  await d.fundStatus(c.fundKey, "https://x");
  advance(CLAIM_WINDOW_MS + 1000);
  assert.equal(await d.sweep(), 1);
  assert.equal(near.transfers[0]?.to, "alice.near");
  assert.equal((await d.claimView(c.claimKey)).state, "REFUNDED");
  d.challenge(c.claimKey);
  await assert.rejects(d.claim(c.claimKey, proof("bob.near")), code("NOTE_NOT_FUNDED"));
  assert.equal(await d.sweep(), 0, "refunds only once");
});

test("claim link: validates receiver, amount and asset", async () => {
  const { d } = desk();
  await assert.rejects(d.create({ amount: "1", receiver: "Bad Name!" }), code("BAD_RECIPIENT"));
  await assert.rejects(d.create({ amount: "0", receiver: "bob.near" }), code("INVALID_INPUT"));
  await assert.rejects(d.create({ amount: "1", receiver: "bob.near", symbol: "DAI" }), code("UNKNOWN_ASSET"));
});

test("claim link in plain NEAR: one transfer funds it, claim and refund send native NEAR", async () => {
  const { d, near, advance } = desk();
  const c = await d.create({ amount: "2.5", receiver: "bob.near", symbol: "NEAR" });
  assert.equal(c.display, "0.5 NEAR");
  const plan = await d.fundPlan(c.fundKey, "alice.near");
  assert.equal("token" in plan, false);
  assert.equal(plan.gasNear, 500000000000000000000000n + 2000000000000000000000n);
  near.nearBalances.set(plan.noteAccountId, 500000000000000000000000n); // not enough yet
  assert.equal((await d.fundStatus(c.fundKey, "https://x")).state, "AWAITING_FUNDING");
  near.nearBalances.set(plan.noteAccountId, plan.gasNear as bigint);
  assert.equal((await d.fundStatus(c.fundKey, "https://x")).state, "FUNDED");
  d.challenge(c.claimKey);
  await d.claim(c.claimKey, proof("bob.near"));
  assert.equal(near.transfers[0]?.tokenContract, "NEAR");
  assert.equal(near.transfers[0]?.to, "bob.near");
  assert.equal(near.transfers[0]?.amount, 500000000000000000000000n);
  void advance;
});

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b: Uint8Array) => { let n = BigInt("0x" + Buffer.from(b).toString("hex")), s = ""; while (n > 0n) { s = B58[Number(n % 58n)]! + s; n /= 58n; } return s; };

function otherDesk() {
  const x = desk();
  const outs: { receiver: string; chain: string; amount: bigint; refundTo: string }[] = [];
  (x.d as unknown as { d: { swapOut: unknown } }).d.swapOut = async (p: { receiver: string; chain: string; amount: bigint; refundTo: string }) => { outs.push(p); return { txHash: "swap-tx", depositAddress: "dep-1" }; };
  return { ...x, outs };
}
async function funded(x: ReturnType<typeof otherDesk>, receiver: string, chain: string) {
  const c = await x.d.create({ amount: "5", receiver, chain });
  const plan = await x.d.fundPlan(c.fundKey, "alice.near");
  x.near.fund(plan.noteAccountId, 5_000_000n);
  await x.d.fundStatus(c.fundKey, "https://x");
  return c;
}

test("claim to a Solana wallet: signing with that wallet pays out through 1Click, other wallets cannot", async () => {
  const x = otherDesk();
  const sk = ed25519.utils.randomSecretKey(), addr = b58(ed25519.getPublicKey(sk));
  await assert.rejects(x.d.create({ amount: "5", receiver: "not-an-address", chain: "sol" }), code("BAD_RECIPIENT"));
  await assert.rejects(x.d.create({ amount: "5", receiver: addr, chain: "btc" }), code("INVALID_INPUT"));
  const c = await funded(x, addr, "sol");
  const ch = x.d.challenge(c.claimKey);
  assert.equal(ch.chain, "sol");
  const sig = (m: string, k = sk) => Buffer.from(ed25519.sign(new TextEncoder().encode(m), k)).toString("base64");
  await assert.rejects(x.d.claim(c.claimKey, { accountId: addr, signature: sig("something else") }), code("BAD_RECIPIENT"));
  const ch2 = x.d.challenge(c.claimKey);
  const other = ed25519.utils.randomSecretKey();
  await assert.rejects(x.d.claim(c.claimKey, { accountId: addr, signature: sig(ch2.message, other) }), code("BAD_RECIPIENT"));
  assert.equal(x.outs.length, 0);
  const ch3 = x.d.challenge(c.claimKey);
  const r = await x.d.claim(c.claimKey, { accountId: addr, signature: sig(ch3.message) });
  assert.equal(r.state, "CLAIMED");
  assert.deepEqual([x.outs[0]!.receiver, x.outs[0]!.chain, x.outs[0]!.amount, x.outs[0]!.refundTo], [addr, "sol", 5_000_000n, "alice.near"]);
  await assert.rejects(x.d.claim(c.claimKey, { accountId: addr, signature: "x" }), code("NOTE_ALREADY_CLAIMED"));
});

test("claim to an EVM wallet (Base): personal_sign from that address pays out; a stranger's signature does not; unclaimed refunds the sender", async () => {
  const x = otherDesk();
  const mk = () => { const k = secp256k1.utils.randomSecretKey(); return { k, addr: "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(k, false).subarray(1)).subarray(12)).toString("hex") }; };
  const me = mk(), stranger = mk();
  const sign = (k: Uint8Array, m: string) => {
    const msg = new TextEncoder().encode(m);
    const dg = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
    const s = secp256k1.sign(dg, k, { prehash: false, format: "recovered" });
    return "0x" + Buffer.concat([s.subarray(1), Buffer.from([s[0]! + 27])]).toString("hex");
  };
  const c = await funded(x, me.addr, "base");
  const ch = x.d.challenge(c.claimKey);
  const text = ch.message;
  await assert.rejects(x.d.claim(c.claimKey, { accountId: me.addr, signature: sign(stranger.k, text) }), code("BAD_RECIPIENT"));
  const ch2 = x.d.challenge(c.claimKey);
  const r = await x.d.claim(c.claimKey, { accountId: me.addr.toUpperCase().replace("0X", "0x"), signature: sign(me.k, ch2.message) });
  assert.equal(r.state, "CLAIMED");
  assert.equal(x.outs[0]!.chain, "base");
  // expiry: not claimed in time goes back to the sender on NEAR
  const y = otherDesk();
  const c2 = await funded(y, me.addr, "eth");
  y.advance(CLAIM_WINDOW_MS + 1000);
  assert.equal(await y.d.sweep(), 1);
  assert.equal(y.near.transfers.at(-1)?.to, "alice.near");
  assert.equal(y.outs.length, 0);
  assert.equal((await y.d.claimView(c2.claimKey)).state, "REFUNDED");
});

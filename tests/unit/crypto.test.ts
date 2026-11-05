import { test } from "node:test";
import assert from "node:assert/strict";
import { claimBinding, commitmentOf, formatSecret, generateSecret, nullifierHashOf, parseSecret, safeEqualHex } from "../../src/agent/crypto.js";
import { toJson } from "../../src/util/json.js";

test("commitment and nullifier are deterministic and domain-separated", () => {
  const s = Buffer.alloc(32, 7);
  assert.equal(commitmentOf(s), commitmentOf(Buffer.from(s)));
  assert.equal(nullifierHashOf(s), nullifierHashOf(Buffer.from(s)));
  assert.notEqual(commitmentOf(s), nullifierHashOf(s));
  assert.match(commitmentOf(s), /^[0-9a-f]{64}$/);
  assert.notEqual(commitmentOf(s), commitmentOf(Buffer.alloc(32, 8)));
});

test("secret string round-trips and rejects malformed input without echoing it", () => {
  const s = generateSecret();
  assert.deepEqual(parseSecret(formatSecret(s)), s);
  assert.throws(() => parseSecret("moopay1_zz"), (e: Error & { code?: string }) => e.code === "INVALID_INPUT" && !e.message.includes("zz"));
  assert.throws(() => parseSecret("x".repeat(72)));
});

test("claim binding changes with every bound field and cannot be shifted between fields", () => {
  const s = Buffer.alloc(32, 1);
  const base = claimBinding(s, "eth", "0xabc", "asset", 100n);
  assert.notEqual(base, claimBinding(s, "btc", "0xabc", "asset", 100n));
  assert.notEqual(base, claimBinding(s, "eth", "0xabd", "asset", 100n));
  assert.notEqual(base, claimBinding(s, "eth", "0xabc", "asset2", 100n));
  assert.notEqual(base, claimBinding(s, "eth", "0xabc", "asset", 101n));
  assert.notEqual(claimBinding(s, "e", "thX", "a", 1n), claimBinding(s, "et", "hX", "a", 1n));
});

test("safeEqualHex", () => {
  assert.ok(safeEqualHex("ab".repeat(32), "ab".repeat(32)));
  assert.ok(!safeEqualHex("ab".repeat(32), "ac".repeat(32)));
  assert.ok(!safeEqualHex("ab", "abab"));
});

test("toJson serialises bigint as decimal string and round-trips beyond 2^53", () => {
  const big = 2n ** 80n + 12345n;
  const out = JSON.parse(toJson({ amount: big, nested: { a: [1n, 2n] } }));
  assert.equal(out.amount, big.toString());
  assert.equal(BigInt(out.amount), big);
  assert.deepEqual(out.nested.a, ["1", "2"]);
});

import { deriveNoteAccount } from "../../src/agent/crypto.js";
import { KeyPair } from "near-api-js";

test("note account: deterministic, key matches account id, independent of commitment/nullifier", () => {
  const s = Buffer.alloc(32, 9);
  const a = deriveNoteAccount(s);
  assert.deepEqual(a, deriveNoteAccount(Buffer.from(s)));
  assert.notEqual(a.accountId, deriveNoteAccount(Buffer.alloc(32, 10)).accountId);
  const kp = KeyPair.fromString(a.secretKey as never);
  assert.equal(Buffer.from(kp.getPublicKey().data).toString("hex"), a.accountId);
  assert.notEqual(a.accountId, commitmentOf(s));
  assert.notEqual(a.accountId, nullifierHashOf(s));
});

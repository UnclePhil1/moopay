import assert from "node:assert/strict";
import { test } from "node:test";
import { openBackup, sealBackup } from "../../src/agent/recovery.js";

const KEY = { accountId: "a".repeat(64), secretKey: "ed25519:" + "3".repeat(88) };
const CODE = "r".repeat(43);

test("backup: the right recovery code opens it, anything else does not", () => {
  const b = sealBackup(KEY, CODE);
  assert.deepEqual(openBackup(b, CODE), KEY);
  assert.throws(() => openBackup(b, CODE.slice(1) + "x"), /does not open/);
  assert.ok(!JSON.stringify(b).includes(KEY.secretKey), "the key is not in the file");
  assert.equal(b.account, KEY.accountId);
});

test("backup: a file edited to point at another account, or with a changed ciphertext, does not open", () => {
  const b = sealBackup(KEY, CODE);
  assert.throws(() => openBackup({ ...b, account: "b".repeat(64) }, CODE), /does not open/);
  const ct = Buffer.from(b.ct, "base64"); ct[0] = ct[0]! ^ 1;
  assert.throws(() => openBackup({ ...b, ct: ct.toString("base64") }, CODE), /does not open/);
  assert.throws(() => openBackup({ ...b, m: 9_999_999 }, CODE), /does not open/, "a file cannot ask for a huge amount of memory");
});

test("backup: two backups of the same key are different files", () => {
  assert.notEqual(sealBackup(KEY, CODE).ct, sealBackup(KEY, CODE).ct);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rateLimiter, withNonce } from "../../src/server/middleware/security.js";
import { Vault } from "../../src/storage/index.js";
import { loadSeed } from "../../src/storage/seed.js";

test("rate limiter: counts per key, resets after the window", () => {
  let t = 0;
  const ok = rateLimiter(2, 1000, () => t);
  assert.deepEqual([ok("a"), ok("a"), ok("a"), ok("b")], [true, true, false, true]);
  t = 1001;
  assert.equal(ok("a"), true);
});

test("nonce goes on inline scripts and styles only", () => {
  const out = withNonce(Buffer.from('<style>a{}</style><script>1</script><script src="x"></script><link rel="stylesheet" href="y">'), "N");
  assert.equal(out, '<style nonce="N">a{}</style><script nonce="N">1</script><script nonce="N" src="x"></script><link rel="stylesheet" href="y">');
});

test("seed file: plain by default, encrypted with SEED_KEY, plain files migrate, wrong or missing key fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moopay-seed-"));
  const plain = join(dir, "p.seed"), enc = join(dir, "e.seed");
  const a = await loadSeed(plain, new Vault(undefined));
  assert.match(readFileSync(plain, "utf8"), /^[0-9a-f]{64}$/);
  assert.deepEqual(await loadSeed(plain, new Vault(undefined)), a);

  assert.deepEqual(await loadSeed(plain, new Vault("secret")), a, "same seed after encrypting");
  const raw = readFileSync(plain, "utf8");
  assert.ok(Vault.isSealed(raw) && !raw.includes(a.toString("hex")), "no longer readable on disk");
  assert.deepEqual(await loadSeed(plain, new Vault("secret")), a);
  await assert.rejects(() => loadSeed(plain, new Vault(undefined)), /SEED_KEY/);
  await assert.rejects(() => loadSeed(plain, new Vault("other")), /does not match/);

  const b = await loadSeed(enc, new Vault("k"));
  assert.ok(Vault.isSealed(readFileSync(enc, "utf8")));
  assert.deepEqual(await loadSeed(enc, new Vault("k")), b);
  const sealed = readFileSync(enc, "utf8");
  writeFileSync(enc, sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA"));
  await assert.rejects(() => loadSeed(enc, new Vault("k")), /does not match/, "tampering is detected");
});

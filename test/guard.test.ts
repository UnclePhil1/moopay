import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rateLimiter, withNonce } from "../src/lib/guard.js";
import { loadSeed } from "../src/lib/seedfile.js";

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

test("seed file: plain by default, encrypted with SEED_KEY, plain files migrate, wrong or missing key fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "moopay-seed-"));
  const plain = join(dir, "p.seed"), enc = join(dir, "e.seed");
  const a = loadSeed(plain, undefined);
  assert.match(readFileSync(plain, "utf8"), /^[0-9a-f]{64}$/);
  assert.deepEqual(loadSeed(plain, undefined), a);

  assert.deepEqual(loadSeed(plain, "secret"), a, "same seed after encrypting");
  const raw = readFileSync(plain, "utf8");
  assert.ok(raw.startsWith("enc1:") && !raw.includes(a.toString("hex")), "no longer readable on disk");
  assert.deepEqual(loadSeed(plain, "secret"), a);
  assert.throws(() => loadSeed(plain, undefined), /SEED_KEY/);
  assert.throws(() => loadSeed(plain, "other"), /does not match/);

  const b = loadSeed(enc, "k");
  assert.ok(readFileSync(enc, "utf8").startsWith("enc1:"));
  assert.deepEqual(loadSeed(enc, "k"), b);
  writeFileSync(enc, readFileSync(enc, "utf8").slice(0, -4) + "AAAA");
  assert.throws(() => loadSeed(enc, "k"), /does not match/, "tampering is detected");
});

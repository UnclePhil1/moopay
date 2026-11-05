import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidBtc, isValidEth, isValidSol, assertRecipient } from "../../src/agent/addresses.js";

test("BTC", () => {
  for (const ok of [
    "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", // P2WPKH
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", // BIP350 bech32m
    "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", // P2PKH
    "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", // P2SH
    "BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ", // all-caps is legal
  ]) assert.ok(isValidBtc(ok), ok);
  for (const bad of [
    "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdp", // bad checksum
    "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", // testnet
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj1",
    "bc1qar0srrr7xfkvy5L643lydnw9re59gtzzwf5mdq", // mixed case
    "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", // base58 checksum
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "", "bc1",
  ]) assert.ok(!isValidBtc(bad), bad);
});

test("SOL", () => {
  assert.ok(isValidSol("11111111111111111111111111111111"));
  assert.ok(isValidSol("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"));
  assert.ok(!isValidSol("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4")); // 31 bytes
  assert.ok(!isValidSol("0Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T")); // '0' not in alphabet
  assert.ok(!isValidSol("short"));
});

test("ETH EIP-55", () => {
  assert.ok(isValidEth("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"));
  assert.ok(isValidEth("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"));
  assert.ok(isValidEth("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")); // no checksum info
  assert.ok(!isValidEth("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")); // one flipped case letter
  assert.ok(!isValidEth("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe")); // short
  assert.ok(!isValidEth("5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"));
});

test("assertRecipient throws BAD_RECIPIENT", () => {
  assert.throws(() => assertRecipient("eth", "nope"), (e: Error & { code?: string }) => e.code === "BAD_RECIPIENT");
});

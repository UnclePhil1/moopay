import assert from "node:assert/strict";
import { test } from "node:test";
import { friendlyError } from "../../src/web/src/friendly.js";

test("wallet and network errors become plain words, with the raw text kept for support", () => {
  const keys = friendlyError(new Error("[-32000] Server error: Account devbose.near has more than 100 access keys; use a paginated view_access_key_list request"));
  assert.equal(keys.title, "Wallet key limit reached", "the key limit wins over the generic server error");
  assert.equal(keys.action, "switch-wallet");
  assert.match(keys.raw, /\[-32000\]/);
  assert.doesNotMatch(keys.text, /32000|view_access_key_list/);
  assert.equal(friendlyError("[-32000] Server error: could not reach node").title, "Connection interrupted");
  assert.equal(friendlyError(new TypeError("Failed to fetch")).title, "Connection interrupted");
  assert.equal(friendlyError(new Error("User rejected the request")).title, "Transaction cancelled");
  assert.equal(friendlyError(new Error("Insufficient funds for transfer")).title, "Not enough balance");
  assert.equal(friendlyError(new Error("SlippageToleranceExceeded")).title, "Price moved quickly");
});

test("an unknown technical error never shows its trace, and our own plain messages pass through untouched", () => {
  const odd = friendlyError(new Error("ExecutionError: wasm execution failed at contract.call (0xdeadbeefdeadbeefdead)"));
  assert.equal(odd.title, "Something went wrong");
  assert.doesNotMatch(odd.text, /wasm|0xdead|Execution/);
  assert.match(odd.raw, /wasm/);
  const plain = friendlyError(new Error("That payment link has expired. Ask for a new one."));
  assert.equal(plain.title, "");
  assert.equal(plain.text, "That payment link has expired. Ask for a new one.");
  assert.equal(plain.raw, "");
  assert.equal(friendlyError(undefined, "This link is not valid.").text, "This link is not valid.");
});

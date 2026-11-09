import assert from "node:assert/strict";
import { test } from "node:test";
import { OneClick } from "../../src/agent/intents/oneclick.js";
import { swapServiceMessage } from "../../src/util/friendly.js";

test("swap service errors are said in plain words, with the minimum in the coin the payer sends", async () => {
  const raw = "Amount is too low for bridge, try at least 24561338599507633587785";
  assert.equal(swapServiceMessage(raw, 400, { symbol: "NEAR", decimals: 24, price: 4 }), "That amount is too small to bridge. Try at least 0.0246 NEAR (about $0.10).");
  assert.equal(swapServiceMessage(raw, 400), "That amount is too small to bridge. Try a larger amount.");
  assert.match(swapServiceMessage("Amount is too high", 400), /too large/);
  assert.match(swapServiceMessage("no liquidity", 400), /no route/);
  assert.match(swapServiceMessage("whatever", 503), /busy/);
  assert.doesNotMatch(swapServiceMessage("TypeError: foo is undefined at bar.js:12", 400), /TypeError|bar\.js/);

  // end to end through the client: the user never sees 1Click's own sentence or a raw number
  const token = { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 4 };
  const fetchImpl = (async (url: string) => url.endsWith("/v0/tokens")
    ? new Response(JSON.stringify([token]), { status: 200 })
    : new Response(JSON.stringify({ message: raw }), { status: 400 })) as unknown as typeof fetch;
  const oc = new OneClick({ baseUrl: "https://x.test", fetchImpl });
  await assert.rejects(oc.quote({ originAsset: "nep141:wrap.near" } as never), /Try at least 0\.0246 wNEAR/);
});

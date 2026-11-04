---
title: "Send API"
description: "Send a payment from your agent wallet with an agent key."
---

`POST /agent/api/delegate/send`

| Field | Type | Notes |
| :- | :- | :- |
| `amountUsd` | string | Dollars, for example `"5"`. |
| `chain` | string | `btc`, `sol`, `eth` or `near`. |
| `recipient` | string | The receiver's address. |
| `assetSymbol` | string | Optional. For example `USDC`. |

```bash curl
curl -X POST https://moopay.cash/agent/api/delegate/send \
  -H "Authorization: Bearer mpk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"amountUsd":"5","chain":"sol","recipient":"<address>"}'
```

```javascript JavaScript
const res = await fetch("https://moopay.cash/agent/api/delegate/send", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.MOOPAY_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ amountUsd: "5", chain: "sol", recipient }),
});
const out = await res.json();
```

## Result

The reply tells you if the payment ran, needs the owner's OK, or was blocked. Check the `status` and message in the reply. Use [Errors](/docs/developers/agent-api/errors) to handle failures.

## When not to use it

For a payment the receiver must prove they own, use the [Claim API](/docs/developers/agent-api/claim-api).

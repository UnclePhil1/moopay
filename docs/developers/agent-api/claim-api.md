---
title: "Claim API"
description: "Create a private claim from your agent wallet with an agent key."
---

`POST /agent/api/delegate/claim`

| Field | Type | Notes |
| :- | :- | :- |
| `amountUsd` | string | Dollars. |
| `receiver` | string | The wallet that may open the claim. |

```bash curl
curl -X POST https://moopay.cash/agent/api/delegate/claim \
  -H "Authorization: Bearer mpk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"amountUsd":"20","receiver":"alice.near"}'
```

The reply holds a link. Give it to the receiver. It expires after 24 hours and the money returns to the wallet.

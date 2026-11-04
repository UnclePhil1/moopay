---
title: "Agent keys"
description: "Create a key so an outside bot can pay inside limits you set."
---

An agent key starts with `mpk_`. It lets a bot send money from your agent wallet. It is always inside your own rules, plus limits you put on the key.

## Create one

In the chat, say: `Create an agent key called research-bot, $10 per payment, $50 a day, only Solana USDC, for 48 hours`. The key shows once. Copy it.

## Limits you can set

| Limit | Meaning |
| :- | :- |
| `perPaymentUsd` | Biggest single payment. |
| `dailyUsd` | Daily budget. |
| `totalUsd` | Budget for the key's whole life. |
| `hours` | Expiry. Default is 7 days. |
| `chains`, `assets` | Allowed chains and coins. |
| `recipients` | Only these addresses. |
| `ips` | Only these IP addresses can use it. |

## Manage keys

Type `/agents` to list keys and what is left. Say `Revoke research-bot` to switch one off.

## Use it

Send the key as a bearer token. See [Send API](/docs/developers/agent-api/send-api) and [Claim API](/docs/developers/agent-api/claim-api).

```http Check a key
GET /agent/api/delegate/me HTTP/1.1
Authorization: Bearer mpk_your_key
```

:::note
Do not put the key in front-end code. Keep it on a server.
:::

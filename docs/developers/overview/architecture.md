---
title: "Architecture"
description: "See the parts of MooPay and how they fit together."
---

## Parts

| Part | Path | Job |
| :- | :- | :- |
| Entry | `src/index.ts` | Starts the server, the worker and the AI. |
| HTTP server | `src/server/router.ts` | Routes for pages, the pay window, claims and the connector. |
| Agent routes | `src/server/routes/agent.ts` | Chat, account and agent key API. |
| Gateway | `src/agent/index.ts` | The only door from the server and the AI to wallets and chains. |
| Chat loop | `src/ai/loop.ts` | Talks to the AI and calls tools. |
| Tools | `src/ai/tools.ts` | The actions the AI may call. |
| Operations | `src/agent/ops.ts` | Sends, claims, staking and wallet work. |
| Policy | `src/agent/policy.ts` | Rules the AI cannot override. |
| Store | `src/agent/store.ts` | Users, rules, payments and keys. |
| Worker | `src/agent/worker.ts` | Follows payments until they finish. |
| Service | `src/agent/service.ts` | Pay intents, quotes and verification. |
| 1Click client | `src/agent/intents/oneclick.ts` | Talks to NEAR Intents. |
| Storage | `src/storage/` | Encrypted JSON files, written atomically. |
| Pay window | `src/web/src/pay-logic.ts` | The wallet and signing page. |

## Flow

```text
chat message -> AI picks a tool -> policy decides -> ops runs it
                                          |
                    auto: pay now   ask: confirm button   deny: stop
                                          |
                      worker follows the payment to the end
```

## Design choices

- Rules live in code. The AI only picks tools.
- Direct same-chain payments are checked on chain.
- Cross-chain payments go through 1Click quotes.
- Pages are served with a strict content security policy and a fresh nonce for scripts.

---
title: "Architecture"
description: "See the parts of MooPay and how they fit together."
---

## Parts

| Part | Path | Job |
| :- | :- | :- |
| HTTP server | `src/http.ts` | Routes for the pay window, claims and the pay API. |
| Agent routes | `src/agent/routes.ts` | Chat, account and agent key API. |
| Chat loop | `src/agent/loop.ts` | Talks to the AI and calls tools. |
| Tools | `src/agent/tools.ts` | The actions the AI may call. |
| Operations | `src/agent/ops.ts` | Sends, claims, staking and wallet work. |
| Policy | `src/agent/policy.ts` | Rules the AI cannot override. |
| Store | `src/agent/store.ts` | Users, rules, payments and keys. |
| Worker | `src/agent/worker.ts` | Follows payments until they finish. |
| Service | `src/lib/service.ts` | Pay intents, quotes and verification. |
| 1Click client | `src/lib/oneclick.ts` | Talks to NEAR Intents. |
| Pay window | `web/pay.ts` | The wallet and signing page. |

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

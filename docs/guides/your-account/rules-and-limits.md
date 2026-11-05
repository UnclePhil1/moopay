---
title: "Rules and limits"
description: "Set how much the agent can spend and when it must ask you."
---

Your float applies to new accounts. An account made before the default changed keeps its own float until you change it.

Rules are plain code on the server. The AI cannot change them or get around them.

| Rule | Default | What it does |
| :- | :- | :- |
| Float | $500 | How much stays in the agent wallet. |
| Daily cap | $50 | The most the agent can spend in a day. |
| New recipient limit | $10 | The most to a new address before it asks you. |
| Auto-approve limit | $25 | Payments above this need your OK. |
| Allowed chains | Any | Only these chains can be paid. |
| Allowed assets | Any | Only these assets can be paid. |

## Change a rule

Say `Set my daily cap to $100`. Lowering a limit is instant. Raising a limit, allowing more chains, or changing the payout wallet needs your OK.

## Freeze

Type `/freeze` to stop all spending right now. `/unfreeze` needs your recovery code.

## Next step

Give a bot its own limits with [Agent keys](/docs/developers/agent-api/agent-keys).

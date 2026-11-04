---
title: "How it works"
description: "See what happens between your message and the money arriving."
---

When you ask for a payment, four things happen.

:::steps
1. **You ask.** The chat reads your message and works out the amount, the chain and the receiver.
2. **The rules check.** Your limits decide if it can run now, needs your OK, or is blocked. The AI cannot change these rules.
3. **A route is found.** If the money and the receiver are on the same chain, it sends directly. If not, it uses [NEAR Intents](https://near-intents.org) (1Click) to swap and deliver across chains.
4. **It is followed to the end.** The agent watches the payment and tells you when it lands or if it fails.
:::

## Same chain or cross chain

| | Same chain | Cross chain |
| :- | :- | :- |
| Example | NEAR to NEAR | SOL to ETH |
| Route | Direct transfer. | Swap through 1Click. |
| Extra fees | Network fee only. | Swap fee and network fee. |

## Who holds the money

- In the agent wallet, the money sits in a NEAR account made for you. See [Agent wallet](/docs/guides/your-account/agent-wallet).
- In the pay window, the money moves from your own wallet. MooPay never holds it.

## Where the AI fits

The AI reads your words and picks a tool, like "send money". It does not hold keys and cannot skip the rules. The rules are plain code on the server. See [Policy rules](/docs/developers/inside-the-code/policy-rules).

## Next step

See [Architecture](/docs/developers/overview/architecture) if you want the technical picture.

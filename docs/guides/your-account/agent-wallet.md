---
title: "Agent wallet"
description: "Understand the small wallet the agent spends from."
---

The agent wallet is a NEAR account made for you. The agent uses it to pay quickly. It is optional.

## How it works

- The address is a NEAR implicit account. The key is made from a seed kept on the server.
- The wallet keeps up to your float. The default is $500. Anything above it is swept to your payout wallet.
- You can withdraw at any time.

## Payout wallet

Your payout wallet is your own NEAR wallet. Swept money and withdrawals go there. If you change it, the new wallet starts after 24 hours and needs your OK. This stops a thief with short access from redirecting your money.

## Show the key

Type `/export` to see the wallet key. Anyone with it can take the money, so only do this in private.

:::warning
The operator of the server can technically use the money in the agent wallet. Keep only a small float there.
:::

## Next step

Set limits in [Rules and limits](/docs/guides/your-account/rules-and-limits).

---
title: "Send money"
description: "Pay a wallet on Bitcoin, Solana, Ethereum or NEAR, using money from many other chains."
---

Give the agent an amount, a receiver and a chain. It runs the whole payment.

## Examples

- `Send $20 to <address> on Solana`
- `Send 0.1 NEAR to alice.near`
- `Send $15 in USDC to <ethereum address>`
- `Pay $30 from my Phantom wallet to <bitcoin address>`

You can give a dollar amount or an amount of the receiver's coin. The receiver gets the chain's own coin unless you name another asset.

## What happens next

:::steps
1. If the amount fits your rules and the agent wallet has money, it pays at once.
2. If it needs your OK, a **Confirm** button shows in the chat.
3. If the agent wallet is empty, a pay window opens. Pick your wallet and sign.
4. The agent follows the payment and tells you when it lands.
:::

## Pay from your own wallet

Say where the money comes from, like `from my ETH` or `from Phantom`. The pay window opens and you sign. You can also pay by sending to a deposit address if you do not want to connect a wallet.

## Make it private

Say `privately`, or turn on private sends in your rules, to pay through a private balance. See [Private send](/docs/guides/using-moopay/private-send).

## When not to use it

Do not use a normal send if you want the receiver to prove they own the wallet. Use a [private claim](/docs/guides/using-moopay/private-claims) instead.

## Next step

Set limits in [Rules and limits](/docs/guides/your-account/rules-and-limits).

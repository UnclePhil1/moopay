---
title: "Private send"
description: "Pay through a private balance so the public chain does not link your wallet to the receiver."
---

Privacy is a choice. You can tell the agent to make a transfer private, or keep it a normal payment. It is up to you, every time.

## What you get

A normal payment goes straight from your agent wallet to the receiver, so anyone can see both on a block explorer. A private send goes through a private balance, so the public chain does not link your wallet to the receiver.

The receiver and the amount are still visible on the chain.

## Turn it on

- For one payment, say `Send $5 to bob.near privately`.
- For every payment, ask the agent to turn on private sends in your [rules](/docs/guides/your-account/rules-and-limits). Turn it off the same way.

The confirm card marks the payment as private, so you see it before you approve.

## What it can send

Private send pays USDC to a NEAR wallet, powered by [OutLayer](https://outlayer.ai/).

## What happens next

:::steps
1. The agent wallet sends the USDC to your private balance.
2. The receiver is paid from that balance.
3. The agent follows the payment and tells you when it lands.
:::

If anything goes wrong, the money goes back to your agent wallet.

## Next step

Read [Privacy](/docs/guides/your-account/privacy) to see what else MooPay keeps private.

---
title: "Private claims"
description: "Send money that only one named wallet can open."
---

A claim is a link. Only the wallet you name can open it, and only by signing with that wallet. You send the link to the receiver any way you like.

## Create one

Say: `Create a private claim of $20 for <address>`.

The agent funds the claim and gives you a link. The receiver opens it, signs with the named wallet, and gets the money.

## Rules

- A claim lasts 24 hours. If nobody opens it, the money goes back to you.
- It works for NEAR, Solana and EVM wallets. On other chains the receiver gets USDC.
- Bitcoin is not supported for claims.

:::warning
Claims are not zero-knowledge. The claim account is controlled by a key that the MooPay server keeps. See [Safety and trust](/docs/guides/resources/safety-and-trust).
:::

## When not to use it

For a plain, quick payment to an address, use [Send money](/docs/guides/using-moopay/send-money). Claims add steps for the receiver.

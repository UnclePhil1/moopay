---
title: "Privacy"
description: "Learn what is private in MooPay and what is not."
---

## What is private

- **Privacy chat.** The chat can run inside sealed enclaves on [NEAR AI Cloud](https://near.ai), so even the host cannot read it, and chat history is optional. See [Privacy chat](/docs/guides/your-account/privacy-chat).
- **Private send (beta).** A payment can go through a private balance so the public chain does not link your wallet to the receiver. See [Private send](/docs/guides/using-moopay/private-send).
- You need no email or sign-up.

## What is not private

- Payments on public chains are public. Anyone can look up an address on a block explorer.
- A private send hides the link from your wallet to the receiver, not the receiver or the amount.
- 1Click can add some privacy on swaps, but it does not hide the receiver on the final chain.
- Claims are not zero-knowledge.

## Delete your data

Type `/delete` to erase your data from MooPay. Chain records stay, because no one can remove them.

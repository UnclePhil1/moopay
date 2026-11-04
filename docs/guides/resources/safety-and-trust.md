---
title: "Safety and trust"
description: "Read the honest list of what you are trusting when you use MooPay."
---

MooPay is new and has not been audited. Here is what you are trusting.

## What the operator can do

- The agent wallet key comes from a seed on the server. The operator can use the money in it. Keep only a small float there.
- Claim accounts use a server seed too.
- The chat host can see messages unless the sealed enclave mode is on.

## What protects you

- Rules are code, not AI. The AI cannot skip them.
- Payments are checked on chain.
- A new payout wallet waits 24 hours.
- Agent keys have their own limits and can be revoked.
- You can freeze spending at any time.
- You can export your wallet key and leave.

## Know the limits

- Claims are not zero-knowledge.
- It runs on mainnet only.
- Some wallets may warn about the site because it is new.

If you find a security problem, email [support@moopay.cash](mailto:support@moopay.cash) or see `SECURITY.md` in the repository.

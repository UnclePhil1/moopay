> ## Documentation Index
> Fetch the complete documentation index at: https://docs.near-intents.org/llms.txt
> Use this file to discover all available pages before exploring further.

# What are Intents?

> Define desired outcomes instead of managing execution steps

An intent expresses **what you want** to achieve, **not how to get it**. Instead of writing code to bridge assets, find quotes, and execute swaps, you submit an intent such as *"I have 1 ETH on Ethereum, I want USDC on Arbitrum"*.

[NEAR 101: Introduction to Intents](https://www.youtube.com/embed/mOGD2gzZJqE)

***

## How it works

**1. You create an intent**

Specify your desired outcome: the tokens you have, the tokens you want, and where you want them delivered.

**2. Market makers compete**

Multiple market makers bid to fulfill your intent (quote request), competing on price, speed, and execution quality.

**3. Smart contracts verify**

Approved quotes are submitted to a smart contract ensuring atomic execution; your swap either completes fully or you get automatically refunded.

**4. You receive your tokens**

Your requested tokens arrive at the destination address you choose, secured by on-chain verification.

![NEAR Intents Architecture](https://mintcdn.com/defuselabsltd/7Xebxgu7H2OpX1la/images/diagrams/what-are-intents.png?fit=max\&auto=format\&n=7Xebxgu7H2OpX1la\&q=85\&s=b6dc50f7f81fc45f06162f00032e3c9b)

***

## Key benefits

> **Simple Integration**
>
> Express desired outcomes instead of managing individual steps

> **Fast Settlement**
>
> Solvers compete to fill orders quickly

> **Use Your Wallets**
>
> Use your existing wallets on any supported chain

> **Competitive Pricing**
>
> Multiple solvers compete on price and execution quality

> **Automatic Refunds**
>
> Funds are returned if the intent cannot be executed

> **Non-Custodial Security**
>
> You maintain control of your assets throughout the process

***

## Learn more

> **How does NEAR Intents ensure security?**
>
> NEAR Intents uses atomic execution enforced by smart contracts on NEAR Protocol. Transactions either complete with all conditions met, or they are reverted and funds returned to the refund address. All transactions are verified on-chain before settlement.

> **What chains and tokens are supported?**
>
> NEAR Intents supports major blockchains including Ethereum, NEAR, and others. The list of supported chains and tokens is continuously expanding. Check our [Chain Support page](https://docs.near-intents.org/resources/chain-support.md) for the current list.

> **What are the fees?**
>
> The 1Click API charges an additional 0.25% (25 basis points) on unauthenticated quotes. Authenticated requests use the partner fee schedule (typically 20 bps, or 1 bp on stablecoin and same-asset multichain routes), plus network gas and market maker spreads. [Learn more about fees](https://docs.near-intents.org/resources/fees.md).

> **How do market makers compete?**
>
> When you create an intent, it is broadcast to multiple market makers who bid to fulfill it. They compete on price, speed, and execution quality. The best execution path is selected while ensuring the intent's terms are met.

***

## Additional Resources

> **[Read the deep dive](https://www.near.org/blog/unpacking-near-intents-a-deep-dive)**
>
> Explore the technical architecture and design philosophy behind NEAR Intents in this comprehensive blog post.

> **[Watch NEAR 101: Introduction to Intents](https://www.youtube.com/watch?v=mOGD2gzZJqE)**
>
> Learn the basics of what NEAR Intents are and how they work in this video overview.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
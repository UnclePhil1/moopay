> ## Documentation Index
> Fetch the complete documentation index at: https://docs.near-intents.org/llms.txt
> Use this file to discover all available pages before exploring further.

# 1Click Swap API

> REST API for cross-chain swaps powered by NEAR Intents

1Click Swap is a REST API that automates routing and settlement on NEAR Intents. It requests quotes from [Market Makers](https://docs.near-intents.org/integration/market-makers/introduction.md), constructs the swap, and tracks execution. Assets move to a quote-specific deposit address and settle on-chain; 1Click does not take custody of them.

This REST API abstracts the complexity of intent creation, solver coordination, and transaction execution.

> [!WARNING]
>
> By using the 1Click Swap API, you agree to the [1Click Terms of Service](https://docs.near-intents.org/security-compliance/terms-of-service.md).

***

## Key Benefits

> **Simple REST API**
>
> Create intents, submit deposits, and track status with a few endpoints.

> **Competitive Pricing**
>
> Market makers compete on price through automatic solver discovery.

> **Built-in Transaction Handling**
>
> Includes status tracking, automatic retries, and refund handling.

> **Fee Collection**
>
> Configure fee collection with a single parameter in your quote requests.

***

## Ready to Dive In?

> **[Quickstart Guide](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction.md)**
>
> Step-by-step tutorial to make your first swap in under 10 minutes

> **[Keys](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md)**
>
> Learn how to generate API keys and authenticate your requests

> **[SDK Libraries](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk.md)**
>
> Explore our SDK libraries for TypeScript, Go, and Rust

> **[Fee Configuration](https://docs.near-intents.org/integration/distribution-channels/1click-api/fee-config.md)**
>
> Learn how to set up fee collection for your swaps

> **[Earn](https://docs.near-intents.org/integration/distribution-channels/1click-api/earn.md)**
>
> Offer multichain yield through the 1Click Swap API

> **[Limit Orders](./orders)**
>
> Offer a swap at the user's price through the 1Click Swap API

> **[Explorer API](./explorer/introduction)**
>
> Programmatic access to historical 1Click Swap transactions

> **[Proactive Intents Security](https://docs.near-intents.org/security-compliance/proactive-intents-security.md)**
>
> Learn how NEAR Intents proactively manages suspicious fund flows, transaction risk, and security posture across swaps


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
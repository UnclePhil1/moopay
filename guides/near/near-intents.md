> ## Documentation Index
> Fetch the complete documentation index at: https://docs.near-intents.org/llms.txt
> Use this file to discover all available pages before exploring further.

# &#x20;NEAR Intents&#x20;

Welcome to the NEAR Intents Docs

## &#x20;1-Click Swap API&#x20;

Request quotes, execute cross-chain swaps, and track their status. [ Quickstart -> ](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction.md)[ Learn More -> ](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api.md)

```bash cURL theme={null}
# Query supported tokens
curl https://1click.chaindefuser.com/v0/tokens

# Request a quote
curl -X POST https://1click.chaindefuser.com/v0/quote \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "swapType": "EXACT_INPUT",
    "originAsset": "nep141:wrap.near",
    "depositType": "ORIGIN_CHAIN",
    "destinationAsset": "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
    "amount": "100000000000000000000000",
    ...
  }'
```

```typescript TypeScript theme={null}
// Query supported tokens
const tokensResponse = await fetch('https://1click.chaindefuser.com/v0/tokens');
const tokens = await tokensResponse.json();

// Request a quote
const quote = await fetch('https://1click.chaindefuser.com/v0/quote', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  },
  body: JSON.stringify({
    swapType: 'EXACT_INPUT',
    originAsset: 'nep141:wrap.near',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
    amount: '100000000000000000000000',
    // ...
  })
});
const result = await quote.json();
```

```python Python theme={null}
import requests

# Query supported tokens
tokens_response = requests.get('https://1click.chaindefuser.com/v0/tokens')
tokens = tokens_response.json()

# Request a quote
quote = requests.post(
  'https://1click.chaindefuser.com/v0/quote',
  headers={
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  },
  json={
    'swapType': 'EXACT_INPUT',
    'originAsset': 'nep141:wrap.near',
    'depositType': 'ORIGIN_CHAIN',
    'destinationAsset': 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
    'amount': '100000000000000000000000',
    # ...
  }
)
result = quote.json()
```

AI Agent Skills: `npx skills add near/agent-skills --skill near-intents`

![Swap Widget UI](https://mintcdn.com/defuselabsltd/3cok9PrJx-RnWxlT/images/widget/swap-widget.png?fit=max\&auto=format\&n=3cok9PrJx-RnWxlT\&q=85\&s=b6a4214c0fe76be1ba56539e4b233707)

## &#x20;React Widget&#x20;

Integrate a customizable, cross-chain swap interface into your app with just a few lines of code.[ Learn More -> ](https://docs.near-intents.org/integration/devkit/react-widget.md)

## &#x20;SDK Libraries&#x20;

Use SDKs for TypeScript, Go, and Rust to request quotes, submit deposits, and monitor execution status.[ Learn More -> ](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk.md)

```typescript TypeScript theme={null}
import { OpenAPI, OneClickService } from '@defuse-protocol/one-click-sdk-typescript';

OpenAPI.TOKEN = 'YOUR_JWT_TOKEN';

const tokens = await OneClickService.getTokens();
console.log(tokens.length);
```

```go Go theme={null}
configuration := openapiclient.NewConfiguration()
apiClient := openapiclient.NewAPIClient(configuration)

tokens, _, err := apiClient.OneClickAPI.GetTokens(context.Background()).Execute()
if err != nil {
  panic(err)
}
```

```rust Rust theme={null}
use one_click_sdk_rs::apis::one_click_api;
use one_click_sdk_rs::apis::configuration::Configuration;

let config = Configuration::default();
let tokens = one_click_api::get_tokens(&config).await?;
println!("{}", tokens.len());
```

## &#x20;Browse By Topic&#x20;

> **[API Quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction.md)**
>
> Execute your first cross-chain swap in minutes.

> **[React Widget](https://docs.near-intents.org/integration/devkit/react-widget.md)**
>
> Embed a customizable swap UI with a ready-to-use React component.

> **[Swap Libraries](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk.md)**
>
> Build with TypeScript, Go, and Rust SDKs for typed API integration.

> **[What are intents?](https://docs.near-intents.org/getting-started/what-are-intents.md)**
>
> Learn how the protocol works and core concepts.

> **[Market Makers](https://docs.near-intents.org/integration/market-makers/introduction.md)**
>
> Provide liquidity by fulfilling cross-chain swap intents.

> **[Verifier Contract](https://docs.near-intents.org/integration/verifier-contract/introduction.md)**
>
> Interact with the smart contract for custom integrations.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.near-intents.org/llms.txt
> Use this file to discover all available pages before exploring further.

# API Keys

> Obtain a JWT token for authenticated API access

Unauthenticated requests incur an additional **0.25% (25 basis points)** platform fee on every non-`ANY_INPUT` quote. Authenticated requests use the partner fee schedule (typically 20 bps, or 1 bp on stablecoin and same-asset multichain routes). See [Fees](https://docs.near-intents.org/resources/fees.md).

Get your JWT token from the [Partner Dashboard](https://partners.near-intents.org/home) for authenticated API access and the partner fee schedule.

***

## How to Use Your API Key

Once you have your JWT token from the Partner Dashboard, send it as `X-API-Key` on API requests. `Authorization: Bearer` is also accepted for the same partner JWT.

```bash cURL theme={null}
curl -X POST https://1click.chaindefuser.com/v0/quote \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_JWT_TOKEN" \
  -d '{
    "dry": false,
    "swapType": "EXACT_INPUT",
    "originAsset": "nep141:wrap.near",
    "destinationAsset": "nep141:usdt.tether-token.near",
    "amount": "1000000000000000000000000",
    "recipient": "your-account.near",
    "recipientType": "INTENTS",
    "refundTo": "your-account.near",
    "refundType": "INTENTS"
  }'
```

```javascript JavaScript theme={null}
const response = await fetch('https://1click.chaindefuser.com/v0/quote', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'YOUR_JWT_TOKEN'
  },
  body: JSON.stringify({
    dry: false,
    swapType: 'EXACT_INPUT',
    originAsset: 'nep141:wrap.near',
    destinationAsset: 'nep141:usdt.tether-token.near',
    amount: '1000000000000000000000000',
    recipient: 'your-account.near',
    recipientType: 'INTENTS',
    refundTo: 'your-account.near',
    refundType: 'INTENTS'
  })
});
```

```python Python theme={null}
import requests

response = requests.post(
  'https://1click.chaindefuser.com/v0/quote',
  headers={
    'Content-Type': 'application/json',
    'X-API-Key': 'YOUR_JWT_TOKEN'
  },
  json={
    'dry': False,
    'swapType': 'EXACT_INPUT',
    'originAsset': 'nep141:wrap.near',
    'destinationAsset': 'nep141:usdt.tether-token.near',
    'amount': '1000000000000000000000000',
    'recipient': 'your-account.near',
    'recipientType': 'INTENTS',
    'refundTo': 'your-account.near',
    'refundType': 'INTENTS'
  }
)
```

> [!TIP]
>
> Store your JWT token securely and never commit it to version control. Use environment variables or secure secret management systems.

***

## Authenticating end users (Confidential Intents)

Your Partner JWT authenticates **your integration** and applies the authenticated fee schedule. It does not let you read a user's confidential data. Reading private balances or confidential transaction history requires a separate **User-Session** token that proves the account owner (an end user, or a solver checking its own balance) actually controls the account, since none of that data is exposed by any public endpoint.

### Get a User-Session token

Have the account owner's wallet sign an empty intent and POST it as `signedData` to `/v0/auth/authenticate`. The request for each wallet, including `signer_id` and the versioned nonce, is on [Authenticate User with Signed Data](https://docs.near-intents.org/api-reference/user-auth/authenticate-user-with-signed-data.md).

| Field | Description |
| - | - |
| `accessToken` | Short-lived bearer token. Send it as `Authorization: Bearer <accessToken>` on `GET /v0/account/balances` and `GET /v0/account/history` |
| `refreshToken` | Exchange this for a new `accessToken` without re-signing |
| `expiresIn` / `refreshExpiresIn` | Lifetime of `accessToken` / `refreshToken`, in seconds |

### Refresh a token

When `accessToken` expires, exchange `refreshToken` for a new one instead of re-signing:

```bash theme={null}
curl -X POST https://1click.chaindefuser.com/v0/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "YOUR_REFRESH_TOKEN" }'
```

Returns a new `{ accessToken, expiresIn }`.

> [!TIP]
>
> See this flow wired into a real solver in [Confidential Example → Authentication](https://docs.near-intents.org/integration/market-makers/confidential-example.md#authentication).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
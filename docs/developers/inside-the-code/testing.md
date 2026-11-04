---
title: "Testing"
description: "Run the tests and add your own."
---

```bash Terminal
npm test
npx tsc -p tsconfig.json --noEmit
```

Tests use `tsx --test` and live in `test/`. They use fake NEAR and 1Click helpers from `test/helpers.ts`, so they run with no network and no money.

| File | Covers |
| :- | :- |
| `agent.test.ts` | Tools, policy, staking, funding, keys. |
| `service.test.ts` | Pay intents and quotes. |
| `claims.test.ts` | Claim flows. |
| `guard.test.ts` | Page headers and limits. |
| `addresses.test.ts` | Address checks. |
| `crypto.test.ts` | Crypto helpers. |

:::note
Tests use fakes. Real wallets and mainnet are not covered, so try small real payments before you trust a change.
:::

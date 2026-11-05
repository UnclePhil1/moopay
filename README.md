# MooPay

NEAR Intents 1Click + Vanilla HTML/TypeScript payment engine. An AI money agent in a chat page, with an optional agent wallet, cross-chain sends, private claim links, group payouts, scheduled payments, rNEAR staking on Rhea, agent keys (`mpk_`) and an MCP connector. Runs as one Node process on Fly.io.

Docs: `/docs` on the running site (source in `docs/`). Security policy: [SECURITY.md](SECURITY.md).

## Run it

```bash
npm install
cp .env.example .env   # set SEED_KEY and one AI key (NEAR_AI_API_KEY or ANTHROPIC_API_KEY)
npm run build          # tsc, wallet bundles (esbuild), docs
npm start              # http://127.0.0.1:3333
```

`npm test` runs the unit tests with fake NEAR and 1Click (no network, no money). `npm run smoke` and `npm run smoke:http` start the real server against a local fake 1Click.

## Layout

```
config/            environment schema (Zod), paths, .env loading
src/index.ts       entry: storage -> agent gateway -> AI -> HTTP server
src/storage/       encryption (XChaCha20-Poly1305), atomic file writes, Zod schemas, ledger, seed, stats
src/agent/         the gateway (index.ts), ops, policy, claims, 1Click, chain drivers
src/ai/            chat loop, tools, providers (NEAR AI, Anthropic), MCP connector (HTTP and stdio)
src/server/        router, security middleware (headers, CSP, rate limits), routes
src/web/           public/ (pages, assets) and src/ (wallet and pay logic bundled by build.js)
tests/             unit tests and fakes
build.js           esbuild bundles for the pay, fund and claim pages, then the docs
```

Rule: `src/server` and `src/ai` reach wallets and chains only through `src/agent/index.ts`, and `src/agent` never imports `src/ai`.

## Security

- State is JSON on one volume (`/data`, a single Fly machine). Files are written to a temp file, fsynced and renamed. With `SEED_KEY` set, state and seed files are encrypted at rest; without it a warning is logged and they are stored in plain text.
- Every request body is parsed with a Zod schema before it reaches the service.
- Agent pages use a nonce CSP and `X-Frame-Options: DENY`. Pay, fund and claim pages send their CSP in report-only mode until it has been checked against real wallet flows. HSTS is sent over https. With `MOOPAY_TRUST_PROXY=1` plain http is redirected to `MOOPAY_PUBLIC_HOST`.
- Limits and approvals are enforced in code (`src/agent/policy.ts`) before money moves, whatever the AI says.
- The MCP connector path carries a random token; treat the full URL as a secret.

| Setting | What it does |
| --- | --- |
| `SEED_KEY` | Encrypts state and seed files on disk. Back it up separately: without it the wallets cannot be recovered. |
| `MOOPAY_PUBLIC_HOST` | Links and redirects always use this domain, never a request header. |
| `MOOPAY_TRUST_PROXY=1` | Behind Fly.io only: https redirect and rate limits by real client IP. |
| `MOOPAY_HTTP_TOKEN` | Path token for the MCP connector (24+ characters). |
| `CHAT_RETENTION_DAYS`, `AI_USER_DAILY`, `AI_IP_DAILY`, `AI_TOTAL_DAILY` | Chat expiry and daily AI message caps. |
| `GAS_SPONSOR_ACCOUNT`, `GAS_SPONSOR_KEY`, `GAS_SPONSOR_DAILY_MAX` | Optional account that lends the first small network fee. |
| `NAME_PARENT_ACCOUNT`, `NAME_PARENT_KEY`, `NAME_DAILY_MAX` | Account that creates named wallets (`name.<account>`), its key, and how many names may be made per day (default 50). Names are off unless both are set. |
| `ALERT_WEBHOOK_URL` | Slack or Discord webhook for owner alerts. |

`scripts/backup.mjs` makes and restores encrypted backups of the state files (`BACKUP_KEY`).

## Deploy

`fly deploy` builds the Dockerfile and starts `node dist/src/index.js`. `.github/workflows/fly.yml` deploys on every push to `main`.

## Not covered by tests

Real wallet signatures (NEAR, Phantom, EVM), mainnet payments and staking with real funds, and the report-only CSP on wallet pages. Try small real payments before trusting a change.

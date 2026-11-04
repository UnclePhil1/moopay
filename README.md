<<<<<<< HEAD
# MooPay

A private cross-chain payment agent delivered as an **MCP server** (TypeScript, stdio). Any MCP-capable agent can
mint a claim note and route it to Bitcoin, Solana or Ethereum through NEAR Intents (1Click). The receiver pays no gas.

No runtime dependency on REA or any analysis tool. `guides/` is read-only reference material and is not imported.

## What this is, and is not

- **Non-custodial.** MooPay holds no key and no funds. There is no operator account.
- **A hash-lock / paper wallet, not a zero-knowledge proof.** A claim note is `secret -> commitment` plus a NEAR account whose
  key is derived from the secret. SHA256 alone gives **no** on-chain unlinkability.
- Unlinkability depends on the 1Click flow: the payout leaves through a fresh 1Click deposit address and
  `ONECLICK_CONFIDENTIALITY` (`basic` by default) is sent on that quote (see `guides/near/1click-confidential-swaps.md`).
  The sender's funding transfer to a note account stays visible on NEAR, and amount/timing correlation is still possible.
- **Whoever holds the secret holds the funds.** Until claimed, the sender can sweep the note account with the same secret.
- **"No gas" means the receiver's.** In direct mode the sender's wallet pays origin gas. In claim mode the note account pays it
  from the NEAR the sender put there (0.01 NEAR minimum, 0.02 recommended). Chain Signatures signs outbound transactions only.
- **Mainnet only.** NEAR Intents has no testnet.

## Pay link (easiest, needs the HTTP mode)

`route_cross_chain_intent({ destinationChain, destinationAssetId, recipient, payAmount: "2" })` returns a `payLink`.
`payAmount` is a **dollar value** (stablecoins 1:1; NEAR converted at 1Click's listed price, rounded up). The user opens the link in a
normal browser tab, picks USDC, USDT or plain NEAR (wrapped to wNEAR in the same signature; refunds come back as wNEAR), presses **Send**, picks a wallet (Meteor, Nightly,
MyNearWallet via NEAR Wallet Selector) and signs once. The page asks MooPay for a real 1Click deposit address, then the wallet signs
`storage_deposit` (only if the address needs it) plus `ft_transfer` in one transaction. The deposit address stays visible with
a copy button, and the page polls 1Click until `SUCCESS`, `REFUNDED` or `FAILED`.

- Pending links live in memory for 30 minutes; creating one makes no quote and moves nothing.
- Amounts are computed server-side from `payAmount` and the token's decimals; the page cannot change them.
- The link path contains the same secret token as the connector URL, and the page sends `Referrer-Policy: no-referrer`.
- Only NEAR-network assets (USDC, USDT, NEAR) can be signed in the page. Other chains use DIRECT mode (copy the address).
- Build the page with `npm run build` (it bundles the wallet selector into `web/dist`).
- Tested here: link creation over MCP, the page, wallet picker, estimate and quote against the real 1Click and NEAR RPC.
  **Not tested:** an actual wallet signature and the redirect return for MyNearWallet.

## Two modes (below: the other modes)

| | Direct send | Claim link |
|---|---|---|
| Use when | sender knows the recipient | recipient chosen later |
| Tool | `route_cross_chain_intent` without `secretKeyString` | `mint_private_claim_deposit`, then `route_cross_chain_intent` with the secret |
| Funds sit in | nowhere: sender pays a one-time 1Click `depositAddress` from their own wallet | a per-note NEAR account (key derived from the secret) |
| Origin chain | any chain 1Click supports | NEAR NEP-141 tokens (e.g. USDC) |
| Refunds go to | `refundTo` (sender) | the note account (so a refunded claim can be retried) |

## Design

```
secret        = randomBytes(32)                      secretKeyString = "moopay1_" + hex
commitment    = SHA256("moopay.v1.commit" || secret)
nullifierHash = SHA256("moopay.v1.null"   || secret)
noteKey       = ed25519 seed SHA256("moopay.v1.key" || secret)   noteAccountId = hex(public key)  (implicit account)
claimBinding  = SHA256("moopay.v1.bind" || secret || lp(chain) || lp(recipient) || lp(assetId) || lp(amount))
```

`lp()` is a 4-byte length prefix (so fields cannot be shifted into each other). The local journal stores commitment,
nullifier hash, note account id, status, and the claim binding. It never stores the secret, the note key, the memo (hash only)
or the recipient. It is a convenience and a local double-claim guard; the chain is the source of truth for funds.

Mint derives the note account and returns three funding steps (NEAR for gas, NEP-145 `storage_deposit`, `ft_transfer`).
A claim is allowed only when `ft_balance_of` and the NEAR balance of the note account show it funded.

Claim (`dryRun:false`): read funding from chain, mark the nullifier `CLAIMING` (flushed to disk first), request a non-dry
quote, `ft_transfer` from the note account (signed with the derived key) to the quote's `depositAddress`, then
`POST /v0/deposit/submit`. Failures before the transfer roll back. A timeout or submit failure after it leaves `CLAIMING`.
The nullifier is freed only when 1Click reports `REFUNDED`.

A note minted on another machine can be claimed here by passing `originAssetId`; the amount is then the note account's balance.

## Tools

- `mint_private_claim_deposit({ assetId, amount, memo? })`
- `route_cross_chain_intent({ destinationChain, destinationAssetId, recipient, slippageBps?, dryRun? } + either { secretKeyString, originAssetId? } or { originAssetId, amount, refundTo })`

There is no note expiry: funds sit in an account the secret holder controls, so there is nothing for MooPay to expire.

`dryRun` defaults to `true`. Amounts are decimal strings. Errors are `{ code, message }` with `isError:true`; codes:
`INVALID_INPUT UNKNOWN_ASSET NOTE_NOT_FOUND NOTE_NOT_FUNDED NOTE_EXPIRED NOTE_ALREADY_CLAIMED BAD_RECIPIENT QUOTE_FAILED
SIGNING_FAILED DEPOSIT_FAILED UPSTREAM_TIMEOUT INTERNAL`.

Status read paths: resource `moopay://note/{commitment-or-intentId}` (chain-verified funding; polls 1Click and settles `CLAIMING` notes) and `moopay://deposit/{depositAddress}` (1Click status for direct sends).

## Setup

```bash
npm install
npm run build
cp .env.example .env   # all optional; export them in the environment your MCP client launches the server with
npm start              # stdio; logs go to stderr
```

### Apps that only take a web link (Claude "Add custom connector", ChatGPT)

```bash
npm run start:http     # 127.0.0.1:3333, prints a secret path /mcp/<token>
```

Put an HTTPS tunnel in front (e.g. `cloudflared tunnel --url http://localhost:3333`) and use
`https://<tunnel-host>/mcp/<token>` as the connector URL. The random token in the path is the only access control, so treat
the whole URL as a secret and stop the tunnel when done. The server keeps no keys, but anyone with the URL can create quotes
and, with a claim secret, spend a funded note. `MOOPAY_HTTP_PORT` and `MOOPAY_HTTP_TOKEN` (24+ chars) override the defaults.
Smoke-tested locally over HTTP; **not** tested through a real tunnel or Claude's connector dialog.

Open `site/index.html` (or `npm run site`, then http://localhost:4173) for the linking page with copy-paste MCP configs.

## Tests

```bash
npm test          # unit + service tests (fake 1Click, no network)
npm run smoke     # spawns the server over stdio against a local fake 1Click and fake NEAR RPC
```

## Not done / TODO(verify)

- Live mainnet swap: **not run** (no testnet; it would move real funds). The NEAR side is untested against a real chain unless
  `npm run testnet` was run (see below).
- Chain Signatures: `src/lib/signer.ts` wraps `v1.signer.sign` but is **not used**: NEAR accounts sign natively, and non-NEAR
  origin chains are only supported in direct mode (the sender signs). Payload encoding, deposit and gas are unverified.
- 1Click quote/status response fields and `deadline` limits are assumptions (the provided docs show requests, not full responses).
- No web wallet UI yet: `site/` is a static linking page. A wallet-connected UI needs a small HTTP wrapper over the same service.
- Wrong-primitive-type input (e.g. a JSON number for `amount`) is rejected by the MCP SDK before the handler, with the SDK's
  message rather than a MooPay `code`.
- `Authorization: Bearer` is used as specified; the docs also accept `X-API-Key`.


## Claim links (send privately to one wallet)

`mint_private_claim_deposit` with `receiver` (a NEAR wallet) and `payAmount` (dollars) returns a `fundLink`. The sender opens it, presses Send and signs once (gas, token registration and the token transfer go to a per-claim NEAR account). `check_claim` then returns a private `claimLink` for the receiver. The receiver connects their wallet and signs a NEP-413 message; only the wallet named by the sender can claim. After 24 hours unclaimed, the server refunds the sender (a sweep runs every 10 minutes).

**Trust note:** unlike the paper-wallet mode, the claim account's key is derived from a seed this server keeps (`<STATE_FILE>.claims.json.seed`, mode 0600), so whoever runs the server can move funds during the window. The code only sends to the named receiver or back to the sender. Removing that trust needs a smart-contract escrow (not built). The sender address used for refunds is the wallet that opened the fund link. Claims pay the receiver in USDC/USDT on NEAR. Not yet tested on mainnet with a real wallet.


## The agent (chat at `/`, guide at `/guide`)

`npm run build && npm run start:http`, then open http://localhost:3333/ (landing page for new visitors; the agent is at /agent, and returning browsers are sent there automatically). Set `NEAR_AI_API_KEY` (private: the chat runs inside NEAR AI Cloud sealed enclaves, default model `deepseek-ai/DeepSeek-V4.1-Flash-1017`) or `ANTHROPIC_API_KEY` (default `claude-sonnet-5-5`) in `.env`; NEAR AI wins if both are set. `AGENT_MODEL` overrides the model. Without a key the chat says the AI is off. Type `/privacy` in the chat to see who can read it. NEAR AI is untested here with a real key; the adapter is covered by tests against a fake server.

- **No login, no wallet connect.** The browser keeps a random device token (only its hash is stored). Each user gets an *agent wallet*: a NEAR account whose key is derived from a server seed (`<STATE_FILE>.agent.json.seed`, mode 0600).
- **Float design.** The user funds it with USDC (NEAR network) plus ~0.1 NEAR for fees. It never keeps more than the user's *float*; the worker sweeps the excess to the user's own payout wallet. **Trust note:** whoever runs the server can move the float.
- **Agent loop** (`src/agent/loop.ts`): the model calls tools (`send_money`, `create_claim`, `check_payment`, `list_activity`, `update_rules`, `schedule_payment`, `cancel_schedule`, `get_account`, `list_supported_assets`) which call the same MooPay service as the MCP tools.
- **Policy** (`src/agent/policy.ts`) is code, outside the model: daily cap (deny), first payment to a new recipient above a limit and anything above the auto-approve limit (needs an Approve click), raising limits or changing the payout wallet (needs approval). A prompt cannot change this.
- **Worker** (every 60 s): announces deposits, sweeps above-float money, follows payments to delivery/refund, runs scheduled payments. Updates show in the chat.
- Payments go from the agent wallet: `ft_transfer` of USDC to a one-time 1Click deposit address (any destination chain) or straight to a NEAR wallet. Claims are funded from the agent wallet and opened by the receiver with their own wallet at `/c/<key>`.
- Not done / untested: the agent has only been run against a scripted fake model and unit-test fakes, not a live model or real mainnet funds. Funding the agent wallet from other chains, fiat on-ramps, a passkey/recovery export for the device token, and per-user LLM spend limits are not built.

### Trust, funding and no-deposit options

- **Where the money is / withdraw / export:** the agent wallet is a normal NEAR account (address shown in chat, viewable on nearblocks). `/withdraw` (tool `withdraw`) sends to the user's payout wallet with no approval; any other destination needs approval. `/export` shows the wallet key (never sent through the model or saved in chat history). The server operator can still use the wallet, so the float is kept small.
- **Add money from any chain** (`fund_wallet`): a 1Click quote with the agent wallet as recipient and USDC on NEAR as the output. The user sends from their own wallet to the deposit address; the worker announces when it arrives. Checked against the live 1Click for SOL, ETH and BTC.
- **No deposit at all:** `pay_from_my_wallet` (deposit address on any chain, money goes straight to the receiver) and `payment_link` (a public `/p/<id>` page where the user signs in a NEAR wallet; no shared secret in the URL).
- **Gas loan for staking (same `GAS_SPONSOR_*` wallet):** money added from another chain for a stake lands as wNEAR in a wallet with no NEAR. The sponsor lends it 0.05 NEAR for the first fee, only when the wallet already holds the staking reserve, and the wallet sends it back right after the stake. It costs nothing in the long run; it only needs about 1 to 2 NEAR of float in the sponsor wallet.
- **Gas sponsor (optional, `GAS_SPONSOR_ACCOUNT` / `GAS_SPONSOR_KEY`):** a wallet funded only with USDC cannot pay its first network fee. When configured, the worker sends 0.05 NEAR once per wallet, after real USDC arrives, capped per day (`GAS_SPONSOR_DAILY_MAX`, default 20). Without it, users who add money from other chains must also send ~0.1 NEAR. The sponsor's cost is a known leak: a user can export the key and keep the 0.05 NEAR.


## Agent keys (limits for other AI agents)

Ask the chat: "give my research bot $20 a day, Solana USDC only" or "let this agent pay up to $50 to bob.near for the next 2 hours". MooPay makes a key (`mpk_…`, shown once, only its hash is stored) with its own daily / per-payment / total limits, expiry, and allowed chains, assets or recipients. The same rules always apply on top: your allowed chains and assets, daily cap, and approvals (an agent's big payment shows up as an Approve card in your chat). Revoke any time (`/agents`).

An outside agent calls (all JSON, `Authorization: Bearer mpk_…`):

- `GET  /agent/api/delegate/me`
- `POST /agent/api/delegate/send` with `{amountUsd, chain, recipient, assetSymbol?}`
- `POST /agent/api/delegate/claim` with `{amountUsd, receiver}`

Limits are checked in code before any money moves. Base and other EVM chains are not supported destinations (only BTC, SOL, ETH, NEAR).


## Rhea staking (rNEAR)

Say "stake $20 into rNEAR" (or "stake 5 NEAR"). MooPay converts what the wallet holds (NEAR, wNEAR, USDC, USDT; money added from any chain works too) into plain NEAR, calls `deposit_and_stake` on `lst.rhealab.near` (the call Rhea's rnear-sdk builds), and sends the rNEAR to the user's own payout wallet, which has to be set first. The worker forwards any rNEAR left in the agent wallet. Spending limits and approvals apply (the amount is counted in dollars). Ask "my rNEAR" to see the position and yield. Ask "unstake my rNEAR" and a window opens where the user signs `unstake_all` (or `unstake` for part) with the wallet that holds the rNEAR, since MooPay never keeps it. The agent follows `get_account_details` on the contract, says when the NEAR is ready (a day or two), and opens a second window to sign `withdraw_all`.

Not tested on mainnet with real funds. The stake call attaches 200 Tgas as Rhea's SDK does; at current gas prices that needs about 0.3 NEAR free in the wallet while it runs (the unused part is refunded), so very small wallets can't stake.
=======
# moopay
Money that moves in private.
>>>>>>> bb59739e2d526a3eb8db3a16af64424c2eb1f43f

## Security settings (hosting)

| Setting | What it does |
| --- | --- |
| `SEED_KEY` | Encrypts the server seed files on disk. Back it up separately: without it the wallets cannot be recovered. |
| `MOOPAY_PUBLIC_HOST` | Links always use this domain, never a request header. |
| `MOOPAY_TRUST_PROXY=1` | Behind Fly.io only: rate limits use the real client IP. |
| `CHAT_RETENTION_DAYS`, `AI_USER_DAILY`, `AI_IP_DAILY`, `AI_TOTAL_DAILY` | Chat expiry and daily AI message caps. |
| `ALERT_WEBHOOK_URL` | Slack/Discord webhook for owner alerts (gas sponsor low, daily AI limit reached). |

In the chat, users have `/signout`, `/reset`, `/delete`, `/freeze`, `/unfreeze`, `/history` and `/lock`. Payout wallet changes wait 24 hours, and agent keys expire after 7 days unless set otherwise. `scripts/backup.mjs` makes and restores encrypted backups of the state files (`BACKUP_KEY`).

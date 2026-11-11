---
title: "Configuration"
description: "Look up every environment setting."
---

Set these in `.env` or as secrets on your host. See `.env.example`.

| Setting | Purpose |
| :- | :- |
| `NEAR_NETWORK` | `mainnet`. |
| `NEAR_RPC_URL` | Optional RPC override. |
| `ONECLICK_BASE_URL`, `ONECLICK_JWT` | 1Click API and token. |
| `ONECLICK_CONFIDENTIALITY` | `public`, `basic` or `advanced`. |
| `NEAR_AI_API_KEY` | Private AI. Used first if set. |
| `ANTHROPIC_API_KEY` | Other AI option. |
| `AGENT_MODEL` | Override the model. |
| `GAS_SPONSOR_ACCOUNT`, `GAS_SPONSOR_KEY`, `GAS_SPONSOR_DAILY_MAX` | Pays first small network fees. |
| `NAME_PARENT_ACCOUNT`, `NAME_PARENT_KEY`, `NAME_DAILY_MAX` | Creates named wallets under that account. Off unless both are set. |
| `SEED_KEY` | Encrypts seeds at rest. |
| `STATE_FILE` | Where the journal is kept. |
| `MOOPAY_HOST`, `MOOPAY_PUBLIC_HOST` | Hosting and public links. |
| `MOOPAY_PRIVATE_ROUTE` | Set to `1` to turn on private send (beta). Off unless set. |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `X_BOT_USER_ID`, `X_BOT_HANDLE` | The MooPay account on X. With all six set, mentions are answered in public. Off unless set. |
| `X_POLL_SECONDS` | How often to look for new mentions. Default 30. |
| `MOOPAY_FEE_ACCOUNT`, `MOOPAY_CHAT_FEE_BPS`, `MOOPAY_X_FEE_BPS` | NEAR wallet that receives the service fee, and the fee in basis points for the chat (default 100, which is 1%) and for X (default 200, which is 2%). The fee is taken from the agent wallet once a send, claim or stake has landed. Payments signed in your own wallet carry none. No fee when the account is empty. `MOOPAY_X_FEE_ACCOUNT` still works as the older name. |
| `MOOPAY_TRUST_PROXY` | Set to `1` behind Fly.io. |
| `CHAT_RETENTION_DAYS` | How long chat is kept. Default 30. |
| `AI_USER_DAILY`, `AI_IP_DAILY`, `AI_TOTAL_DAILY` | AI message limits. |
| `ALERT_WEBHOOK_URL` | Alerts to Slack or Discord. |
| `WALLETCONNECT_PROJECT_ID` | Lets phones pick any wallet. |

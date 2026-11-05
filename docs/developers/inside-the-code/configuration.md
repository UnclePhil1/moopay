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
| `MOOPAY_TRUST_PROXY` | Set to `1` behind Fly.io. |
| `CHAT_RETENTION_DAYS` | How long chat is kept. Default 30. |
| `AI_USER_DAILY`, `AI_IP_DAILY`, `AI_TOTAL_DAILY` | AI message limits. |
| `ALERT_WEBHOOK_URL` | Alerts to Slack or Discord. |
| `WALLETCONNECT_PROJECT_ID` | Lets phones pick any wallet. |

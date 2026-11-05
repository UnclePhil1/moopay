---
title: "Run it yourself"
description: "Start your own copy of MooPay on your machine."
---

You need Node 22 and an AI key.

:::steps
1. Clone the repository and install.
2. Copy `.env.example` to `.env` and add a key.
3. Build and start.
:::

```bash Terminal
npm install
cp .env.example .env
npm run build
npm start
```

Open the address it prints, then go to `/agent`.

## Minimum settings

| Setting | Why |
| :- | :- |
| `NEAR_AI_API_KEY` or `ANTHROPIC_API_KEY` | Turns the chat on. |
| `ONECLICK_JWT` | Removes the extra 0.25% quote fee. |
| `SEED_KEY` | Encrypts seed files. Back it up. |

See [Configuration](/docs/developers/inside-the-code/configuration) for the rest.

:::warning
Running a server means you hold the seeds for agent wallets. Treat `SEED_KEY` like a bank key.
:::

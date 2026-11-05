---
title: "Pay window"
description: "Understand the signing page and its API."
---

The pay window lives at `/p/<id>`. It is built from `src/web/src/pay-logic.ts` and `src/web/public/pay.html`. The page talks to the server at `/papi/<id>/...`.

## Endpoints

| Path | Use |
| :- | :- |
| `GET /papi/<id>` | The intent view. |
| `GET /papi/<id>/status` | Payment status. |
| `POST /papi/<id>/estimate` | A price estimate. |
| `POST /papi/<id>/quote` | A real quote with a deposit address. |
| `POST /papi/<id>/paid` | Tell the server the payer sent. |
| `POST /papi/<id>/payout` | Set the payout wallet for staking. |
| `POST /papi/<id>/cancel` | Cancel before signing. |
| `GET /papi/<id>/sol-check`, `POST sol-send`, `GET blockhash` | Solana helpers. |

## Intent types

| Type | What it is |
| :- | :- |
| Pay | Send to a receiver. |
| `stake` | Stake into rNEAR with a payout wallet. |
| `fund` | Add money to the agent wallet. |
| `call` | Sign a contract call, like unstake or withdraw. |

## Wallet pop-ups

Browsers only allow pop-ups opened by a click. Popup wallets must open from the iframe, so the page offers a **Sign transaction** button when a pop-up is blocked.

The window talks to the chat with `postMessage` so the chat can close it and show results.

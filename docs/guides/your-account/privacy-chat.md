---
title: "Privacy chat"
description: "Your chat with the agent runs in sealed enclaves on NEAR AI Cloud, and you choose whether it is saved."
---

Privacy chat keeps what you say to the agent away from the host and the AI provider's staff.

## How it works

- The agent's AI runs inside sealed enclaves on [NEAR AI Cloud](https://near.ai). Even the people who run the machine cannot read the chat.
- This needs the server to be set up with a NEAR AI key. Type `/privacy` to see how your chat is handled right now.
- You need no email or sign-up.

## Chat history

- Chat history is optional. Type `/history` to save it or stop saving it.
- When it is off, a "Chat not saved" label shows. The agent remembers the chat while the page is open, and it is never written to disk.
- When it is on, old chat is deleted after 30 days by default.
- Type `/clear` to clear the chat on screen, or `/delete` to erase your data from MooPay.

## What it does not cover

- Privacy chat protects the chat. It does not hide payments. See [Private send](/docs/guides/using-moopay/private-send).
- If the server uses a different AI provider, `/privacy` says so.

## Next step

Read [Privacy](/docs/guides/your-account/privacy) for the whole picture.

---
title: "MooPay on X"
description: "Use MooPay from X. Link your account once, then mention @moopaybot to send, split, stake and more, and confirm in a post."
---

The MooPay X agent is MooPay without opening the app. You link your X account once. After that, you mention `@moopaybot` in a post and say what you want, in plain words. It does the same things the chat does, with the same rules and the same limits.

## What it can do

- **Send money.** "send $10 to alice.near", or to a Solana, Ethereum or Bitcoin address. Name the chain, like "as sol" or "on base", when the address alone isn't clear.
- **Send in a coin.** "send 2 NEAR to bob.near".
- **Pay a person by their X name.** If the person linked their own X account, use their @name as the receiver.
- **Split and group payouts.** One post, several receivers.
- **Schedule payments.** "send $5 to alice.near every week".
- **Private claims and private sends.** The same options you have in the app.
- **Stake.** "stake $20" into rNEAR.
- **Check things.** Your balance, and the status of a payment.
- **Cancel.** Say "cancel" before you confirm, and nothing is sent.

## What you get back

- A short summary before money moves: the receiver, the amount and the fee. You confirm, or you don't.
- A short note when it is sent, or a plain reason when it couldn't be, with a question: "Want me to try again?"
- Nothing when a post is not a request. Questions about MooPay, praise and jokes get no reply.

## Link your X account

You do this once. It takes about a minute.

:::steps
1. Open MooPay at [moopay.cash/agent](/agent).
2. In the chat, type `link my X account`. MooPay gives you a code that works for 15 minutes. It looks like `@moopaybot link moo-ABC123`.
3. Copy that line with the Copy button beside it.
4. Open X, sign in to the account you want to link, and post that exact line.
5. Wait up to a minute. MooPay checks X every 30 seconds.
6. Ask the chat, `is my X linked?` You should see your X name. You may also get a reply on X that says you are linked.
:::

If it says "not linked", make a new code and post it again. A code works once and expires after 15 minutes. One X account links to one MooPay account.

To unlink, type `unlink my X account` in the chat.

## Send your first payment on X

:::steps
1. Post: `@moopaybot send $0.50 to alice.near`.
2. MooPay answers with what it is about to do, the receiver, the amount and the fee.
3. Post: `@moopaybot confirm`. Say only that. Pasting the whole request again does not count as a confirm.
4. MooPay tells you when it is on its way, and when it lands.
:::

Start with a small amount to see how it works.

## Rules, limits and fees

- Your rules from the app apply on X exactly the same: allowed chains, daily limits and the rest. Larger payments still ask for your approval.
- A payment made on X carries a 2% service fee, shown in the summary before you confirm. The same payment in the MooPay chat carries 1%.
- You can send up to 6 messages a minute. After that, MooPay asks you to slow down.

## Addresses on X

X blocks posts that show a full crypto address for new accounts. So MooPay's replies show only the start and the end of an address, like `2dj3...8d3`. The full address is still used to send. Check it in your own post, which has the full address, before you confirm.

## Good to know

- Your posts are public. Keep private details out of them. For anything sensitive, use the app.
- Anyone who can post from your linked X account can ask MooPay to pay inside your limits. Link an account you keep safe, and use rules that fit.
- If a payment fails, MooPay tells you in plain words whether any money moved, and asks before it tries again. It never retries on its own.
- Results also show in your MooPay chat, so you can check there too.

## If you don't see a reply

X sometimes hides replies from newer accounts. The bot may still have answered.

:::steps
1. Look in your X Notifications, under Mentions.
2. Open the `@moopaybot` profile and check its Replies tab.
3. Ask the chat in MooPay: `is my X linked?` or `what happened to my last payment?`
4. Scroll to the bottom of your post and look for "Show additional replies".
:::

## Next step

Read [Send money](/docs/guides/using-moopay/send-money) for everything you can send, and [Rules and limits](/docs/guides/your-account/rules-and-limits) to set how much MooPay can do on its own.

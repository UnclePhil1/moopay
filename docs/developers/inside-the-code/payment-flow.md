---
title: "Payment flow"
description: "Follow one payment through the code."
---

## 1. A tool is called

The AI picks `send_money` from `src/ai/tools.ts`. The tool calls `ops.send`.

## 2. Policy decides

```ts src/agent/policy.ts
export function decide(u, amountUsd, recipientKey, now): Decision {
  const r = u.rules;
  if (spentToday(u, now) + amountUsd > r.dailyCapUsd) return { action: "deny", reason: "..." };
  if (!u.known.includes(recipientKey) && amountUsd > r.newRecipientLimitUsd) return { action: "ask", reason: "..." };
  if (amountUsd > r.approveAboveUsd) return { action: "ask", reason: "..." };
  return { action: "auto" };
}
```

## 3. The route

- Agent wallet can cover it: it pays from there.
- Otherwise a pay intent is made and the pay window `/p/<id>` opens.

## 4. Same chain or cross chain

Same chain pays directly and is checked on chain. Cross chain asks 1Click for a quote, then the payer sends to the deposit address.

## 5. The worker follows it

`src/agent/worker.ts` checks status and writes the chat message when it lands, fails or needs a fee.

## Add a tool

Add an entry to the list in `src/ai/tools.ts` with a name, a clear description and an input schema. Put the work in `ops.ts`. Add a test in `tests/unit/agent.test.ts`.

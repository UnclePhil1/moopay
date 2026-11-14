---
title: "Policy rules"
description: "Read the code that limits what the agent can spend."
---

All limits live in `src/agent/policy.ts`. They are pure functions, so they are easy to test.

| Function | Job |
| :- | :- |
| `decide` | Auto, ask or deny for one payment. |
| `rulesNeedApproval` | Says if a rules change needs your OK. |
| `scopeDeny` | Chain, asset and recipient allow lists. |
| `agentDeny` | Limits on one agent key. |

```ts Default rules
export const DEFAULT_RULES: Rules = {
  floatUsd: 25,
  dailyCapUsd: 50,
  newRecipientLimitUsd: 10,
  approveAboveUsd: 0.1,
};
```

Loosening a rule or changing the payout wallet needs a human. A new payout wallet waits `PAYOUT_HOLD_MS`, which is 24 hours.

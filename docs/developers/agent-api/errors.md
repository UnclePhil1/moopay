---
title: "Errors"
description: "Handle failed requests from the agent API."
---

Errors come back as JSON with a `code` and a plain `message`.

| Cause | What it means |
| :- | :- |
| Missing or wrong key | Send `Authorization: Bearer mpk_...`. |
| Key revoked or expired | Ask the owner for a new key. |
| Over a limit | Per payment, daily or total budget is used up. |
| Not allowed | Chain, asset or recipient is outside the key's list. |
| Wrong address | The key can only be used from listed IPs. |
| Needs approval | The owner must confirm in the chat. |
| 429 | Too many requests. Wait and retry. |

```json Example
{ "code": "INVALID_INPUT", "message": "this agent session has expired" }
```

Read the `message`. It is written for people, so you can pass it on.

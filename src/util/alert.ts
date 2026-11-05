/*
 * A heads-up to the owner: always in the server log, and also posted to ALERT_WEBHOOK_URL when set (a Slack or Discord
 * incoming webhook works as is). The same alert is sent at most once an hour, so a problem does not turn into spam.
 */
const lastSent = new Map<string, number>();

export async function alertOwner(key: string, text: string, now: number = Date.now(), send: typeof fetch = fetch): Promise<void> {
  if (now - (lastSent.get(key) ?? -Infinity) < 3_600_000) return;
  lastSent.set(key, now);
  console.error(`[moopay] ALERT ${text}`);
  const url = process.env["ALERT_WEBHOOK_URL"]?.trim();
  if (!url) return;
  await send(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `MooPay: ${text}`, content: `MooPay: ${text}` }), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
}

/** Test helper: forget what was sent. */
export const resetAlerts = (): void => lastSent.clear();

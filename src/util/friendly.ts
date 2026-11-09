/* Turns what the swap service says into words a person can act on. The raw text is never shown (it is logged when MOOPAY_DEBUG is set). */

/** A token amount from its smallest unit, rounded up so "try at least" is enough to pass. */
export function roundedUp(units: bigint, decimals: number): string {
  const places = units >= 10n ** BigInt(Math.max(decimals - 2, 0)) ? 4 : 6;
  const scale = 10n ** BigInt(Math.max(decimals - places, 0));
  const whole = (units + scale - 1n) / scale;
  const n = Number(whole) / 10 ** Math.min(places, decimals);
  return n.toLocaleString("en-US", { maximumFractionDigits: places }).replace(/\.0+$/, "");
}

export interface Coin { symbol: string; decimals: number; price?: number | null | undefined }

/** `reason` is the swap service's own sentence; `coin` is what the payer sends, when known. */
export function swapServiceMessage(reason: string, status?: number, coin?: Coin): string {
  if (process.env["MOOPAY_DEBUG"]) console.error("[moopay] swap service said:", status, reason);
  const r = reason.toLowerCase();
  const min = /(?:at least|minimum(?: of)?)\s*(\d{4,})/.exec(reason)?.[1];
  if (/too low|too small|below (the )?minimum|minimum/.test(r)) {
    if (min && coin) {
      const amount = roundedUp(BigInt(min), coin.decimals);
      const dollars = coin.price ? ` (about $${(Number(min) / 10 ** coin.decimals * coin.price + 0.005).toFixed(2)})` : "";
      return `That amount is too small to bridge. Try at least ${amount} ${coin.symbol}${dollars}.`;
    }
    return "That amount is too small to bridge. Try a larger amount.";
  }
  if (/too (high|large|big)|exceed|maximum/.test(r)) return "That amount is too large for this route right now. Try a smaller amount.";
  if (/liquidity|no route|no (quote|path)|not (supported|available)|unsupported|cannot (find|route)/.test(r)) return "There's no route for that swap right now. Try a different coin or amount.";
  if (/deadline|expired|stale/.test(r)) return "That price expired. Ask me again and I'll get a fresh one.";
  if (/recipient|address|refund/.test(r)) return "The swap service didn't accept the receiving address for that network. Check it and try again.";
  if (status === 429 || (status !== undefined && status >= 500)) return "The swap service is busy right now. Nothing was sent. Try again in a minute.";
  return "The swap service couldn't set up this payment. Try a different amount or coin, or try again in a minute.";
}

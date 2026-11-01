import type { IncomingMessage, ServerResponse } from "node:http";

/** Headers every response carries. HSTS only when the request came in over https. */
export function securityHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer"); // claim links carry a secret in the path
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (String(req.headers["x-forwarded-proto"] ?? "").startsWith("https")) res.setHeader("strict-transport-security", "max-age=31536000");
}

/** The agent's own pages: no framing, and scripts only from this page's nonce (everything is inline, nothing is loaded from other sites but fonts). */
export function pageHeaders(res: ServerResponse, nonce: string): void {
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", [
    "default-src 'self'", `script-src 'nonce-${nonce}'`, `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`, "style-src-attr 'unsafe-inline'",
    "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join("; "));
}

/** Adds the nonce to every inline <script> and <style> of a page. */
export const withNonce = (html: Buffer, nonce: string): string => html.toString("utf8").replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${nonce}"`);

/** Behind Fly the real client address is in fly-client-ip; trusted only when MOOPAY_TRUST_PROXY=1, since anyone could send that header directly. */
export const clientIp = (req: IncomingMessage): string =>
  (process.env["MOOPAY_TRUST_PROXY"] === "1" && String(req.headers["fly-client-ip"] ?? "")) || req.socket.remoteAddress || "unknown";

/** Fixed-window counter per key. Returns false once `max` hits are used up inside the window. */
export function rateLimiter(max: number, windowMs: number, now: () => number = Date.now): (key: string) => boolean {
  const hits = new Map<string, { n: number; end: number }>();
  return (key) => {
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.end <= t) hits.delete(k);
    let h = hits.get(key);
    if (!h || h.end <= t) { h = { n: 0, end: t + windowMs }; hits.set(key, h); }
    return ++h.n <= max;
  };
}

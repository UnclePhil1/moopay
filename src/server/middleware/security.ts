import type { IncomingMessage, ServerResponse } from "node:http";

const HSTS = "max-age=63072000; includeSubDomains; preload";

/** Hosts the wallet pages talk to from the browser. Kept in one place so the policy below stays readable. */
const NEAR_RPC = ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org", "https://rpc.testnet.near.org"];
const SOLANA_RPC = ["https://api.mainnet-beta.solana.com"];
const WALLET_RELAY = ["https://*.walletconnect.org", "wss://*.walletconnect.org", "https://*.walletconnect.com", "wss://*.walletconnect.com", "https://api.web3modal.org", "https://*.reown.com"];
const EVM_RPC = ["https://*.llamarpc.com", "https://cloudflare-eth.com", "https://mainnet.base.org", "https://arb1.arbitrum.io", "https://mainnet.optimism.io", "https://polygon-rpc.com", "https://bsc-dataseed.binance.org", "https://api.avax.network"];
const FONT_CSS = "https://fonts.googleapis.com", FONT_FILES = "https://fonts.gstatic.com";

/** Headers every response carries. The default CSP suits JSON and assets: nothing may load, nothing may frame it. */
export function securityHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "SAMEORIGIN"); // pay pages open as a sheet inside our own chat page and nowhere else
  res.setHeader("referrer-policy", "no-referrer"); // claim links carry a secret in the path
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (String(req.headers["x-forwarded-proto"] ?? "").startsWith("https")) res.setHeader("strict-transport-security", HSTS);
}

/** The agent's own pages: no framing, and scripts only from this page's nonce (everything is inline, nothing is loaded from other sites but fonts). */
export function pageHeaders(res: ServerResponse, nonce: string): void {
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", [
    "default-src 'self'", `script-src 'nonce-${nonce}'`, `style-src 'self' 'nonce-${nonce}' ${FONT_CSS}`, "style-src-attr 'unsafe-inline'",
    `font-src ${FONT_FILES}`, "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join("; "));
}

/**
 * The pay, fund and claim pages load wallet code that reaches many hosts. The policy is sent in report-only mode until it has been
 * checked against real wallet flows in the browser console; enforcing a guess here would break payments.
 */
export function walletPageHeaders(res: ServerResponse): void {
  res.removeHeader("content-security-policy");
  res.setHeader("content-security-policy-report-only", [
    "default-src 'self'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'", `style-src 'self' 'unsafe-inline' ${FONT_CSS}`, `font-src 'self' data: ${FONT_FILES}`,
    "img-src 'self' data: https:", `connect-src 'self' ${[...NEAR_RPC, ...SOLANA_RPC, ...EVM_RPC, ...WALLET_RELAY].join(" ")}`,
    "frame-src https:", "frame-ancestors 'self'", "base-uri 'none'", "object-src 'none'",
  ].join("; "));
}

/** Adds the nonce to every inline <script> and <style> of a page. */
export const withNonce = (html: Buffer, nonce: string): string => html.toString("utf8").replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${nonce}"`);

/**
 * The Fly edge sets X-Forwarded-Proto. Anything that did not arrive over https is sent to the https address,
 * built from the configured public host rather than the Host header so a forged header cannot steer the redirect.
 */
export function httpsRedirect(req: IncomingMessage): string | undefined {
  if (process.env["MOOPAY_TRUST_PROXY"] !== "1") return undefined;
  if (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https") return undefined;
  const host = process.env["MOOPAY_PUBLIC_HOST"]?.trim() || String(req.headers.host ?? "");
  return host ? `https://${host}${req.url ?? "/"}` : undefined;
}

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

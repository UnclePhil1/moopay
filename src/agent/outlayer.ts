/*
 * A small client for OutLayer's confidential routes (the optional "private route", beta). Written from OutLayer's docs
 * (app.outlayer.ai/docs/agent-custody and skills.outlayer.ai/agent-custody/references/confidential.md); none of it has run
 * against the live service yet. Amounts are strings in the token's smallest unit. Mainnet only: testnet answers 503.
 */

export const OUTLAYER_URL = "https://api.outlayer.ai";
const WALLET = "/wallet/v1";

export class OutLayerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OutLayerError"; }
  /** The docs say these two are safe to try again; anything else is not. */
  get retryable(): boolean { return this.code === "confidential_jwt_expired" || this.code === "keystore_error"; }
}

export interface Op { request_id: string; status: string; intent_hash?: string; deposit_address?: string; poll_url?: string }
export interface Quote { amount_in?: string; amount_out?: string; min_amount_out?: string; deadline?: string; time_estimate_seconds?: number; hint?: string }
export interface Request { status: string; result?: Record<string, unknown> }
export interface CrossChainDeposit { intent_id: string; deposit_address: string; amount: string; amount_out?: string; min_amount_out?: string; expires_at?: string; hint?: string }
export interface Wallet { api_key: string; near_account_id: string; wallet_id?: string; handoff_url?: string }

/** Where a request ends. `refunded` means it failed halfway and the money is back in the confidential balance. */
export const TERMINAL = new Set(["success", "failed", "refunded", "needs_review"]);

export class OutLayer {
  constructor(private readonly baseUrl = OUTLAYER_URL, private readonly doFetch: typeof fetch = fetch) {}

  private async call<T>(method: "GET" | "POST", path: string, key: string | undefined, body?: unknown, idempotency?: string): Promise<T> {
    const res = await this.doFetch(this.baseUrl + path, {
      method,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(idempotency ? { "x-idempotency-key": idempotency } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      const j = json as { code?: string; error?: string; message?: string };
      throw new OutLayerError(res.status, j.code ?? j.error ?? `http_${res.status}`, (j.message ?? j.error ?? text.slice(0, 200)) || `OutLayer answered ${res.status}`);
    }
    return json as T;
  }

  /** Makes a new wallet. The api_key comes back once only. */
  register(): Promise<Wallet> { return this.call("POST", "/register", undefined, {}); }
  tokens(key: string): Promise<unknown> { return this.call("GET", `${WALLET}/tokens`, key); }
  balance(key: string, token?: string): Promise<{ balance?: string; balances?: { token: string; balance: string }[]; account_id?: string }> {
    return this.call("GET", `${WALLET}/confidential/balance${token ? `?token=${encodeURIComponent(token)}` : ""}`, key);
  }
  /** A bridge address on the source chain; the money is sent there outside this API. */
  depositAddress(key: string, p: { chain: string; token?: string; amount: string }): Promise<CrossChainDeposit> {
    return this.call("POST", `${WALLET}/confidential/deposit/cross-chain`, key, p);
  }
  /** What a private payout would give the receiver, with nothing signed. */
  quoteWithdraw(key: string, p: { chain: string; to: string; amount: string; token: string }): Promise<Quote> {
    return this.call("POST", `${WALLET}/confidential/withdraw/dry-run`, key, p);
  }
  /** What a swap inside the private balance would give, with nothing signed. */
  quoteSwap(key: string, p: { token_in: string; token_out: string; amount_in: string }): Promise<Quote> {
    return this.call("POST", `${WALLET}/confidential/swap/quote`, key, p);
  }
  /** Swaps inside the private balance. A quote below min_amount_out is refused before anything is signed. */
  swap(key: string, p: { token_in: string; token_out: string; amount_in: string; min_amount_out?: string }, idempotency: string): Promise<Op> {
    return this.call("POST", `${WALLET}/confidential/swap`, key, p, idempotency);
  }
  /** Sends out of the confidential balance to an address on any chain in the 1Click catalog. Pass the same idempotency key on a retry. */
  withdraw(key: string, p: { chain: string; to: string; amount: string; token: string }, idempotency: string): Promise<Op> {
    return this.call("POST", `${WALLET}/confidential/withdraw`, key, p, idempotency);
  }
  request(key: string, id: string): Promise<Request> { return this.call("GET", `${WALLET}/requests/${encodeURIComponent(id)}`, key); }

  /** Polls until the request ends. A request that is still going when time runs out is returned as it is; never send it again. */
  async settle(key: string, id: string, o: { everyMs?: number; timeoutMs?: number } = {}): Promise<Request> {
    const end = Date.now() + (o.timeoutMs ?? 120_000);
    let last: Request = { status: "pending_deposit" };
    while (Date.now() < end) {
      last = await this.request(key, id);
      if (TERMINAL.has(last.status)) return last;
      await new Promise((r) => setTimeout(r, o.everyMs ?? 3000));
    }
    return last;
  }
}

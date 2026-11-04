import { z } from "zod";
import { MoopayError, type ErrorCode } from "./errors.js";

/*
 * Typed client for the 1Click Swap API. Request fields follow
 * guides/near/1click-making-a-request.md. Response shapes beyond what the docs show
 * (quote.* fields, status payload) are parsed tolerantly: TODO(verify) against the API reference.
 */

const TOKENS_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const TokenSchema = z
  .object({
    assetId: z.string(),
    decimals: z.number(),
    blockchain: z.string(),
    symbol: z.string(),
    price: z.number().nullish(),
    contractAddress: z.string().nullish(),
  })
  .passthrough();
export type Token = z.infer<typeof TokenSchema>;

const usd = z.union([z.string(), z.number()]).optional();
const QuoteResponseSchema = z
  .object({
    timestamp: z.string().optional(),
    signature: z.string().optional(),
    quote: z
      .object({
        depositAddress: z.string().optional(),
        depositMemo: z.string().optional(),
        amountIn: z.string().optional(),
        amountInUsd: usd,
        minAmountIn: z.string().optional(),
        amountOut: z.string().optional(),
        amountOutUsd: usd,
        minAmountOut: z.string().optional(),
        deadline: z.string().optional(),
        timeEstimate: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

const StatusResponseSchema = z.object({ status: z.string() }).passthrough();
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  deadline: string;
  confidentiality?: "basic" | "advanced";
}

export interface OneClickOptions {
  baseUrl: string;
  jwt?: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class OneClick {
  private tokenCache: { at: number; tokens: Token[] } | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: OneClickOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get authenticated(): boolean {
    return Boolean(this.opts.jwt);
  }

  private async request(path: string, init: RequestInit, failCode: ErrorCode): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body) headers["Content-Type"] = "application/json";
    // Unauthenticated calls pay an extra 0.25% fee (guides/near/1click-auth.md).
    if (this.opts.jwt) headers["Authorization"] = `Bearer ${this.opts.jwt}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.baseUrl + path, {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
        throw new MoopayError("UPSTREAM_TIMEOUT", "1Click did not answer in time");
      throw new MoopayError(failCode, "1Click is unreachable");
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const msg =
        body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string"
          ? (body as { message: string }).message.slice(0, 300)
          : `HTTP ${res.status}`;
      throw new MoopayError(failCode, `1Click rejected the request: ${msg}`, { httpStatus: res.status });
    }
    return body;
  }

  async tokens(): Promise<Token[]> {
    if (this.tokenCache && this.now() - this.tokenCache.at < TOKENS_TTL_MS) return this.tokenCache.tokens;
    let body: unknown;
    try {
      body = await this.request("/v0/tokens", { method: "GET" }, "QUOTE_FAILED");
    } catch (e) {
      if (this.tokenCache) return this.tokenCache.tokens; // 1Click is down: the last list still names the same assets
      throw e;
    }
    const parsed = z.array(TokenSchema).safeParse(body);
    if (!parsed.success) throw new MoopayError("QUOTE_FAILED", "1Click returned an unexpected /v0/tokens payload");
    this.tokenCache = { at: this.now(), tokens: parsed.data };
    return parsed.data;
  }

  async findToken(assetId: string): Promise<Token | undefined> {
    return (await this.tokens()).find((t) => t.assetId === assetId);
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    const body = await this.request("/v0/quote", { method: "POST", body: JSON.stringify(req) }, "QUOTE_FAILED");
    const parsed = QuoteResponseSchema.safeParse(body);
    if (!parsed.success) throw new MoopayError("QUOTE_FAILED", "1Click returned an unexpected /v0/quote payload");
    return parsed.data;
  }

  async submitDeposit(depositAddress: string, txHash: string): Promise<unknown> {
    return this.request(
      "/v0/deposit/submit",
      { method: "POST", body: JSON.stringify({ depositAddress, txHash }) },
      "DEPOSIT_FAILED",
    );
  }

  async status(depositAddress: string): Promise<StatusResponse> {
    const body = await this.request(
      `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
      { method: "GET" },
      "QUOTE_FAILED",
    );
    const parsed = StatusResponseSchema.safeParse(body);
    if (!parsed.success) throw new MoopayError("QUOTE_FAILED", "1Click returned an unexpected /v0/status payload");
    return parsed.data;
  }
}

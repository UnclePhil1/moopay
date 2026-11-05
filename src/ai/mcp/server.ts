import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMoopayError } from "../../util/errors.js";
import { toJson } from "../../util/json.js";
import { MooPayService, mintShape, routeShape, type RouteContext } from "../../agent/index.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: toJson(data) }] });
const fail = (err: unknown): ToolResult => {
  const e = asMoopayError(err);
  return {
    content: [{ type: "text", text: toJson({ code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }) }],
    isError: true,
  };
};

export function buildServer(service: MooPayService, ctx: RouteContext = {}): McpServer {
  const server = new McpServer({ name: "moopay", version: "0.1.0" });

  server.registerTool(
    "mint_private_claim_deposit",
    {
      title: "Mint private claim deposit",
      description:
        "Send money privately to someone's NEAR wallet. EASIEST (LINK mode): give receiver (their NEAR wallet, e.g. alice.near) and payAmount (dollars, e.g. \"5\"). Returns fundLink: the user opens it, presses Send and signs once. Then call check_claim to get the claimLink to share with the receiver. Only the named wallet can claim, within 24 hours of funding. symbol can be USDC (default), USDT or NEAR; otherwise it is refunded to the sender. " +
        "ADVANCED (assetId + amount in smallest units, stdio use): returns a one-time secret and a per-note NEAR account to fund by hand. Prefer LINK mode.",
      inputSchema: mintShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return ok(await service.mint(args, ctx));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "route_cross_chain_intent",
    {
      title: "Route cross-chain intent",
      description:
        "Route funds to a BTC, SOL or ETH address through NEAR Intents 1Click. Three modes. " +
        "PAY-LINK (easiest; give payAmount as a dollar value, e.g. \"2\" for about $2): returns a payLink. The user opens it, picks USDC, USDT or NEAR, presses Send and signs in their NEAR wallet. Needs the HTTP mode. Prefer this mode whenever the user says what to send and where. " +
        "DIRECT (originAssetId, amount, refundTo): returns a 1Click depositAddress that the sender pays from their own wallet. Use DIRECT when the sender pays from SOL, ETH, BTC or any non-NEAR wallet (refundTo is then their address on that chain). Find assetIds with list_supported_assets. " +
        "CLAIM (secretKeyString from mint_private_claim_deposit): the note account pays a fresh deposit address. " +
        "dryRun defaults to true and only returns a quote (no state change; pay links are not affected). The receiver pays no gas; MooPay never holds funds.",
      inputSchema: routeShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return ok(await service.route(args, ctx));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Read path: polls 1Click and settles CLAIMING notes (SUCCESS -> CLAIMED, REFUNDED -> claimable again).
  server.registerTool(
    "list_supported_assets",
    {
      title: "List supported assets",
      description:
        "Look up 1Click assetIds and decimals, optionally filtered by chain (e.g. \"sol\", \"eth\", \"btc\", \"near\") and/or symbol (e.g. \"USDC\"). Use it to find originAssetId / destinationAssetId and to convert amounts to smallest units before calling route_cross_chain_intent. Do not guess assetIds.",
      inputSchema: { chain: z.string().max(32).optional(), symbol: z.string().max(32).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return ok(await service.listAssets(args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "check_claim",
    {
      title: "Check claim link",
      description:
        "Check a MooPay claim link the sender was asked to fund. Returns AWAITING_FUNDING (sender has not signed yet), FUNDED (with claimLink to share with the receiver, and expiresAt), CLAIMED (with claimTx), REFUNDED or CANCELLED. Call it when the user says they funded it or asks about it.",
      inputSchema: { fundLink: z.string().min(1).max(512).describe("The fundLink returned by mint_private_claim_deposit") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fundLink }) => {
      try {
        return ok(await service.claimFundStatus(fundLink, ctx));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "check_payment",
    {
      title: "Check payment",
      description:
        "Check a MooPay pay link after the user has used it. Returns WAITING_FOR_USER (not sent yet), PENDING_DEPOSIT, PROCESSING, SUCCESS (delivered, with an explorerUrl to show as a link), REFUNDED or FAILED. Call this when the user says they sent it, or asks if it arrived.",
      inputSchema: { payLink: z.string().min(1).max(512).describe("The payLink returned by route_cross_chain_intent (or just its last path segment)") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ payLink }) => {
      try {
        const id = payLink.split("?")[0]!.split("/").filter(Boolean).pop() ?? "";
        return ok(await service.payStatus(id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerResource(
    "note-status",
    new ResourceTemplate("moopay://note/{id}", { list: undefined }),
    {
      title: "Note status",
      description: "Chain-verified funding and claim status for a note minted on this machine, addressed by commitment or intentId (nullifierHash). Never contains the secret.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables["id"] ?? "");
      try {
        const body = await service.noteStatus(id);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: toJson(body) }] };
      } catch (e) {
        const err = asMoopayError(e);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: toJson({ code: err.code, message: err.message }) }] };
      }
    },
  );

  server.registerResource(
    "deposit-status",
    new ResourceTemplate("moopay://deposit/{address}", { list: undefined }),
    {
      title: "Deposit status",
      description: "1Click status for a DIRECT-mode deposit address.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const address = String(variables["address"] ?? "");
      try {
        const body = await service.depositStatus(address);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: toJson(body) }] };
      } catch (e) {
        const err = asMoopayError(e);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: toJson({ code: err.code, message: err.message }) }] };
      }
    },
  );

  return server;
}

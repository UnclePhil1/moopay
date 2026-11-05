import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MooPayService } from "../../agent/index.js";
import { buildServer } from "./server.js";

/** One stateless MCP request: a fresh server and transport per call, closed when the response ends. */
export async function handleMcp(service: MooPayService, req: IncomingMessage, res: ServerResponse, body: unknown, ctx: { token: string; origin: string }): Promise<void> {
  const server = buildServer(service, { payLinkPrefix: `${ctx.origin}/pay/${ctx.token}`, origin: ctx.origin });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

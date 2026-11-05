import type { IncomingMessage, ServerResponse } from "node:http";
import type { MooPayService } from "../../agent/index.js";
import { asMoopayError } from "../../util/errors.js";
import { toJson } from "../../util/json.js";
import { PayoutBody, QuoteBody, TxBody } from "../../storage/schema.js";
import { parseBody, readJson } from "../middleware/body.js";
import { BUNDLES, sendBundle, sendWalletPage } from "./pages.js";

export const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const send = (res: ServerResponse, code: number, body: unknown): void => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

/** JSON the pay page calls: `rest` is the path after /papi/<id> (or after /api/<token>). */
export async function payApi(service: MooPayService, rest: string[], req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const reply = (data: unknown) => { res.setHeader("content-type", "application/json"); res.end(toJson(data)); };
  try {
    if (rest[0] === "status" && req.method === "GET") return reply(await service.depositStatus(url.searchParams.get("depositAddress") ?? ""));
    if (rest[0] === "intent" && rest[1] && ID_RE.test(rest[1])) {
      const id = rest[1], op = rest[2], get = req.method === "GET", post = req.method === "POST";
      if (!op && get) return reply(await service.payIntentView(id));
      if (op === "status" && get) return reply(await service.payStatus(id));
      if (op === "blockhash" && get) return reply(await service.solBlockhash());
      if (op === "paid" && post) return reply(service.directDone(id, parseBody(TxBody, await readJson(req), "paid").tx));
      if (op === "cancel" && post) return reply(service.cancelCall(id));
      if (op === "payout" && post) return reply(service.setStakePayout(id, parseBody(PayoutBody, await readJson(req), "payout").address));
      if (op === "sol-check" && get) return reply(await service.solCheck(url.searchParams.get("owner") ?? "", url.searchParams.get("mint") ?? undefined, url.searchParams.get("to") ?? undefined));
      if (op === "sol-send" && post) return reply(await service.solSend(parseBody(TxBody, await readJson(req), "sol-send").tx));
      if (op === "estimate" && get) return reply(await service.payEstimate(id, url.searchParams.get("asset") ?? ""));
      if (op === "quote" && post) {
        const b = parseBody(QuoteBody, await readJson(req), "quote");
        return reply(await service.payQuote(id, b.originAssetId, b.refundTo));
      }
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    const err = asMoopayError(e);
    res.statusCode = err.code === "INTERNAL" ? 500 : err.code === "NOTE_NOT_FOUND" ? 404 : 400;
    res.setHeader("content-type", "application/json");
    res.end(toJson({ code: err.code, message: err.message }));
  }
}

/** Public pay links made by the agent: /p/<id> (page) and /papi/<id>/... (JSON). The id is the only secret. */
export async function handlePay(service: MooPayService, parts: string[], req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const [kind, key, ...more] = parts as [string, string?, ...string[]];
  if (kind !== "p" && kind !== "papi") return false;
  if (kind === "p" && key === "assets" && more.length === 1 && BUNDLES[more[0]!] && req.method === "GET") return sendBundle(res, more[0]!);
  if (kind === "p" && key && ID_RE.test(key) && more.length === 0 && req.method === "GET") { sendWalletPage(res, "pay.html"); return true; }
  if (kind === "papi" && key && ID_RE.test(key)) { await payApi(service, ["intent", key, ...more], req, res, url); return true; }
  send(res, 404, { error: "not found" });
  return true;
}

export { send as sendJson };

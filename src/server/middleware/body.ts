import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { z } from "zod";
import { MoopayError } from "../../util/errors.js";

const MAX_BODY = 1_000_000;

export async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new MoopayError("INVALID_INPUT", "request too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new MoopayError("INVALID_INPUT", "the request is not valid JSON"); }
}

/** Zero-trust parse: anything that does not match the schema stops here with a plain message. */
export function parseBody<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new MoopayError("INVALID_INPUT", `${what} ${r.error.issues[0]?.path.join(".") || "request"} is missing or invalid`);
  return r.data;
}

/** Public base of this request (works behind a tunnel): https://host, or http://localhost for local use. */
export function publicOrigin(req: IncomingMessage): string {
  const fixed = process.env["MOOPAY_PUBLIC_HOST"]?.trim(); // hosted: links always use our own domain, never a request header
  if (fixed) return `https://${fixed}`;
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost");
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = String(req.headers["x-forwarded-proto"] ?? (local ? "http" : "https")).split(",")[0];
  return `${proto}://${host}`;
}

export const tokenOk = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

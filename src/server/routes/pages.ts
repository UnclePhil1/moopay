import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { builtFile, publicFile } from "../../../config/paths.js";
import { pageHeaders, walletPageHeaders, withNonce } from "../middleware/security.js";

const PAGES: Record<string, string> = { "/": "landing.html", "/agent": "index.html", "/agent/": "index.html", "/app": "index.html", "/app/": "index.html", "/recover": "recover.html" };
const IMAGES = new Set(["moopay-logo.png", "moopay-mark.png", "favicon.png"]);
/** Bundles esbuild writes into public/dist, and how to label them. */
export const BUNDLES: Record<string, string> = {
  "pay.js": "text/javascript; charset=utf-8",
  "fund.js": "text/javascript; charset=utf-8",
  "claim.js": "text/javascript; charset=utf-8",
  "recover.js": "text/javascript; charset=utf-8",
  "passkey.js": "text/javascript; charset=utf-8",
  "approve.js": "text/javascript; charset=utf-8",
  "modal-ui.css": "text/css; charset=utf-8",
  "moopay-logo.png": "image/png",
  "favicon.png": "image/png",
};

/** An agent page: a fresh nonce per response, no framing, scripts only from that nonce. */
export function sendPage(res: ServerResponse, file: string): void {
  const nonce = randomBytes(16).toString("base64url");
  res.setHeader("content-type", "text/html; charset=utf-8");
  pageHeaders(res, nonce);
  res.end(withNonce(publicFile(file), nonce));
}

/** A wallet page (pay, fund, claim): static HTML plus the script bundle, with the report-only policy. */
export function sendWalletPage(res: ServerResponse, file: string): void {
  res.setHeader("content-type", "text/html; charset=utf-8");
  walletPageHeaders(res);
  res.end(publicFile(file));
}

export function sendBundle(res: ServerResponse, name: string): boolean {
  const type = BUNDLES[name];
  if (!type) return false;
  res.setHeader("content-type", type);
  res.end(builtFile(name));
  return true;
}

/** /docs opens the first page, /docs/<path> is a page, <path>.md its plain copy, /llms.txt the index. */
function sendDoc(path: string, res: ServerResponse): boolean {
  const clean = path.replace(/\/$/, "");
  let file: string, type = "text/html; charset=utf-8";
  if (clean === "/llms.txt") { file = "docs/llms.txt"; type = "text/plain; charset=utf-8"; }
  else if (clean === "/docs") {
    res.writeHead(302, { location: (JSON.parse(builtFile("docs/index.json").toString("utf8")) as { first: string }).first });
    res.end();
    return true;
  } else if (clean.endsWith(".md")) { file = `docs${clean.slice(5)}`; type = "text/markdown; charset=utf-8"; }
  else file = `docs${clean.slice(5)}.html`;
  try {
    const body = builtFile(file);
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "public, max-age=300");
    if (type.startsWith("text/html")) { const nonce = randomBytes(16).toString("base64url"); pageHeaders(res, nonce); res.end(withNonce(body, nonce)); } else res.end(body);
    return true;
  } catch { return false; }
}

/** The site's own pages and static files. Returns false when the path is not one of them. */
export function handlePages(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (req.method !== "GET") return false;
  const page = PAGES[path];
  if (page) { sendPage(res, page); return true; }
  if (path === "/robots.txt" || path === "/sitemap.xml") {
    try {
      const body = builtFile(path.slice(1));
      res.setHeader("content-type", path.endsWith(".xml") ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8");
      res.setHeader("cache-control", "public, max-age=3600");
      res.end(body); return true;
    } catch { return false; }
  }
  if (path === "/guide" || path === "/guide/") { res.writeHead(301, { location: "/docs" }); res.end(); return true; }
  if (/^\/(docs|llms\.txt)(\/[a-z0-9-]+){0,3}(\.md)?\/?$/.test(path)) return sendDoc(path, res);
  const img = /^\/app\/assets\/([a-z-]+\.png)$/.exec(path);
  if (img && IMAGES.has(img[1]!)) {
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "public, max-age=3600");
    res.end(publicFile(`assets/${img[1]}`));
    return true;
  }
  if (/^\/g\/[\w-]{6,40}$/.test(path)) { sendPage(res, "group.html"); return true; }
  if (/^\/ok\/[\w-]{6,40}$/.test(path)) { sendPage(res, "approve.html"); return true; }
  return false;
}

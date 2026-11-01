// Bundles the pay page (wallet selector + page logic) into web/dist.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("web/dist", { recursive: true });
await build({
  entryPoints: ["web/pay.ts", "web/fund.ts", "web/claim.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outdir: "web/dist",
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  alias: { buffer: "buffer/", util: "util/" },
  inject: ["web/shim.js"],
  logLevel: "info",
});
copyFileSync("node_modules/@near-wallet-selector/modal-ui/styles.css", "web/dist/modal-ui.css");
copyFileSync("site/assets/moopay-logo.png", "web/dist/moopay-logo.png");
copyFileSync("site/assets/favicon.png", "web/dist/favicon.png");

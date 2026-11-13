// Bundles the wallet pages (NEAR Wallet Selector, Reown AppKit) into src/web/public/dist, then builds the docs.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const out = "src/web/public/dist";
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { pay: "src/web/src/pay-logic.ts", fund: "src/web/src/fund.ts", claim: "src/web/src/claim.ts", recover: "src/web/src/recover.ts", passkey: "src/web/src/passkey.ts", approve: "src/web/src/approve.ts" },
  bundle: true, minify: true, format: "iife", platform: "browser", target: "es2022",
  outdir: out,
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  alias: { buffer: "buffer/", util: "util/" },
  inject: ["src/web/src/shim.js"],
  logLevel: "info",
});
copyFileSync("node_modules/@near-wallet-selector/modal-ui/styles.css", `${out}/modal-ui.css`);
copyFileSync("src/web/public/assets/moopay-logo.png", `${out}/moopay-logo.png`);
copyFileSync("src/web/public/assets/favicon.png", `${out}/favicon.png`);
const docs = spawnSync(process.execPath, ["scripts/build-docs.mjs"], { stdio: "inherit" });
if (docs.status !== 0) process.exit(docs.status ?? 1);

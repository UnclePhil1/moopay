/*
 * Tests candidate SEED_KEY values against copies of the production seed files, offline. Nothing is sent anywhere and no key is printed.
 *
 *   npx tsx scripts/check-seed-key.ts <dir with agent.seed and claims.seed> [ENV_NAME ...]
 *
 * Candidates come from the named variables of .env (default: every variable whose name starts with SEED_KEY), or one per line on stdin when the last argument is `-`.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Vault } from "../src/storage/encryption.js";

const dir = process.argv[2];
if (!dir) { console.error("usage: check-seed-key.ts <dir> [ENV_NAME ...]"); process.exit(2); }
const seeds = ["agent", "claims"].map((n) => readFileSync(`${dir}/${n}.seed`, "utf8").trim());
const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const rest = process.argv.slice(3).filter((a) => a !== "-"), fromStdin = process.argv.includes("-");
const names = rest.length ? rest : Object.keys(env).filter((k) => k.startsWith("SEED_KEY"));
const cands: [string, string][] = names.map((n) => [n, env[n] ?? ""]);
if (fromStdin) for (const l of readFileSync(0, "utf8").split("\n")) if (l.trim()) cands.push(["stdin", l.trim()]);
for (const [name, v] of cands) {
  const vault = new Vault(v);
  const ok = seeds.map((s) => { try { vault.open(s, "seed"); return true; } catch { return false; } });
  console.log(name.padEnd(22), createHash("sha256").update(v).digest("hex").slice(0, 8), ok.every(Boolean) ? "MATCHES production" : "no match");
}

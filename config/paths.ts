import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// tsx runs config/ in place, while the compiled copy sits one level deeper in dist/. Both resolve to the repository root.
export const ROOT = here.split(/[\\/]/).includes("dist") ? resolve(here, "..", "..") : resolve(here, "..");
export const PUBLIC_DIR = join(ROOT, "src", "web", "public");
export const BUILD_DIR = join(PUBLIC_DIR, "dist");

export const publicFile = (name: string): Buffer => readFileSync(join(PUBLIC_DIR, name));
export const builtFile = (name: string): Buffer => readFileSync(join(BUILD_DIR, name));

/** Loads <project root>/.env without overriding variables that are already set. Values are never logged. */
export function loadDotEnv(): void {
  const file = join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

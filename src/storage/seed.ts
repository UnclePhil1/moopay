import { randomBytes } from "@noble/hashes/utils.js";
import { readFile } from "node:fs/promises";
import { Vault, writeText } from "./index.js";

/*
 * A server seed on disk. With SEED_KEY set it is sealed, so a copied disk or backup alone cannot move anyone's money.
 * Without it the file is plain hex (mode 0600), for development. An older plain or AES-GCM seed is moved to the current format on first start.
 */
export async function loadSeed(file: string, vault: Vault): Promise<Buffer> {
  const put = (seed: Buffer) => writeText(file, vault.enabled ? vault.seal(seed, "seed") : seed.toString("hex"));
  let raw: string;
  try { raw = (await readFile(file, "utf8")).trim(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const seed = Buffer.from(randomBytes(32));
    await put(seed);
    return seed;
  }
  if (!Vault.isSealed(raw)) {
    const seed = Buffer.from(raw, "hex");
    if (vault.enabled) await put(seed);
    return seed;
  }
  const seed = Buffer.from(vault.open(raw, "seed"));
  if (Vault.isLegacy(raw)) await put(seed);
  return seed;
}

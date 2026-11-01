import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/*
 * A server seed on disk. With SEED_KEY set it is stored encrypted (AES-256-GCM, key from scrypt), so a copied disk or backup
 * alone cannot move anyone's money. Without it the file is plain hex (mode 0600), as before. An old plain file is encrypted on first start.
 */
const PREFIX = "enc1:";
const keyOf = (secret: string): Buffer => scryptSync(secret, "moopay.seedfile.v1", 32);

export function loadSeed(file: string, secret: string | undefined = process.env["SEED_KEY"]?.trim() || undefined): Buffer {
  const write = (seed: Buffer) => {
    if (!secret) return writeFileSync(file, seed.toString("hex"), { mode: 0o600 });
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
    const body = Buffer.concat([c.update(seed), c.final()]);
    writeFileSync(file, PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64"), { mode: 0o600 });
  };
  if (!existsSync(file)) { const seed = randomBytes(32); write(seed); return seed; }
  const raw = readFileSync(file, "utf8").trim();
  if (!raw.startsWith(PREFIX)) {
    const seed = Buffer.from(raw, "hex");
    if (secret) write(seed); // moves an old plain seed to encrypted storage
    return seed;
  }
  if (!secret) throw new Error(`${file} is encrypted: set SEED_KEY to the key it was saved with`);
  const b = Buffer.from(raw.slice(PREFIX.length), "base64");
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(secret), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]);
  } catch { throw new Error(`SEED_KEY does not match ${file}`); }
}

// Encrypted backup of MooPay's state. Usage:
//   BACKUP_KEY=... node scripts/backup.mjs backup <state-file> <out.enc>     (state-file is STATE_FILE, e.g. /data/moopay-state.json)
//   BACKUP_KEY=... node scripts/backup.mjs restore <in.enc> <state-file>
// It bundles <state-file>.agent.json, .claims.json, .stats.json and the two .seed files, encrypted with AES-256-GCM.
// Keep BACKUP_KEY (and SEED_KEY) somewhere safe and separate from the backup.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FILES = [".agent.json", ".agent.json.seed", ".claims.json", ".claims.json.seed", ".stats.json"];
const [mode, a, b] = process.argv.slice(2);
const secret = process.env.BACKUP_KEY?.trim();
if (!secret || secret.length < 16 || !["backup", "restore"].includes(mode) || !a || !b) {
  console.error("usage: BACKUP_KEY=<16+ chars> node scripts/backup.mjs backup <state-file> <out.enc> | restore <in.enc> <state-file>");
  process.exit(1);
}
const key = (salt) => scryptSync(secret, salt, 32);

if (mode === "backup") {
  const bundle = Object.fromEntries(FILES.filter((f) => existsSync(a + f)).map((f) => [f, readFileSync(a + f, "utf8")]));
  const salt = randomBytes(16), iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(salt), iv);
  const body = Buffer.concat([c.update(JSON.stringify(bundle)), c.final()]);
  writeFileSync(b, Buffer.concat([salt, iv, c.getAuthTag(), body]), { mode: 0o600 });
  console.error(`backed up ${Object.keys(bundle).length} files to ${b}`);
} else {
  const raw = readFileSync(a);
  const d = createDecipheriv("aes-256-gcm", key(raw.subarray(0, 16)), raw.subarray(16, 28));
  d.setAuthTag(raw.subarray(28, 44));
  let bundle;
  try { bundle = JSON.parse(Buffer.concat([d.update(raw.subarray(44)), d.final()]).toString("utf8")); }
  catch { console.error("wrong BACKUP_KEY or damaged file"); process.exit(1); }
  for (const [f, text] of Object.entries(bundle)) writeFileSync(b + f, text, { mode: 0o600 });
  console.error(`restored ${Object.keys(bundle).length} files next to ${b}`);
}

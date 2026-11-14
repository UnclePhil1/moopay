import { DstackKeySource } from "./keys.js";
import { signerServer, WalletSigner } from "./service.js";
import { SignerPasskeys } from "./passkeys.js";
import type { Cap } from "./policy.js";

/**
 * Entry point of the enclave image. SIGNER_CAPS is the hard ceiling and SIGNER_UNATTENDED the small no-passkey allowance, both JSON:
 * {"NEAR":{"perTx":"...","daily":"..."},"usdc.contract":{...}}, in smallest units. SIGNER_ORIGIN is the site the passkeys belong to.
 */
function caps(name: string, required: boolean): Record<string, Cap> {
  const raw = JSON.parse(process.env[name] ?? "{}") as Record<string, { perTx: string; daily: string }>;
  if (required && !Object.keys(raw).length) throw new Error(`${name} is empty: the signer would refuse everything`);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { perTx: BigInt(v.perTx), daily: BigInt(v.daily) }]));
}

const token = process.env["SIGNER_TOKEN"] ?? "";
const port = Number(process.env["PORT"] ?? 3000);
const origin = process.env["SIGNER_ORIGIN"] ?? "https://moopay.cash";
const delay = Number(process.env["SIGNER_PASSKEY_DELAY_HOURS"] ?? 24) * 3600_000;
signerServer(new WalletSigner(new DstackKeySource(), { caps: caps("SIGNER_CAPS", true), unattended: caps("SIGNER_UNATTENDED", false) }, new SignerPasskeys(origin, delay)), token, (m) => console.log(`[signer] ${m}`)).listen(port, "0.0.0.0", () => console.log(`[signer] up on ${port}`));

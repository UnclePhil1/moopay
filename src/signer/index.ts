import { DstackKeySource } from "./keys.js";
import { signerServer, WalletSigner } from "./service.js";
import type { Cap } from "./policy.js";

/** Entry point of the enclave image. Caps come from SIGNER_CAPS as JSON: {"NEAR":{"perTx":"...","daily":"..."},"usdc.contract":{...}}, in smallest units. */
function caps(): Record<string, Cap> {
  const raw = JSON.parse(process.env["SIGNER_CAPS"] ?? "{}") as Record<string, { perTx: string; daily: string }>;
  if (!Object.keys(raw).length) throw new Error("SIGNER_CAPS is empty: the signer would refuse everything");
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { perTx: BigInt(v.perTx), daily: BigInt(v.daily) }]));
}

const token = process.env["SIGNER_TOKEN"] ?? "";
const port = Number(process.env["PORT"] ?? 3000);
signerServer(new WalletSigner(new DstackKeySource(), { caps: caps() }), token, (m) => console.log(`[signer] ${m}`)).listen(port, "0.0.0.0", () => console.log(`[signer] up on ${port}`));

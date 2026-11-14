import { FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
import { DstackKeySource, deriveWallet, type KeySource } from "./keys.js";
import { signerServer, WalletSigner } from "./service.js";
import { SignerPasskeys } from "./passkeys.js";
import { NearStateStore } from "./state.js";
import type { Cap } from "./policy.js";

/**
 * Entry point of the enclave image.
 *
 *   SIGNER_TOKEN           bearer token the MooPay server sends (32+ characters)
 *   SIGNER_STATE_CONTRACT  the NEAR account of the signer-state contract. The signer will not start without it.
 *   SIGNER_CAPS            hard ceiling per asset, JSON: {"NEAR":{"perTx":"...","daily":"..."},"usdc.contract":{...}}, in smallest units
 *   SIGNER_UNATTENDED      the small no-passkey allowance, same shape (optional; empty means every payment needs a passkey)
 *   SIGNER_FEE_ACCOUNT     MooPay's fee account, and SIGNER_FEE_CAPS its allowance (same shape): fee transfers need no passkey, within that allowance
 *   SIGNER_ORIGIN          the site the passkeys belong to (default https://moopay.cash)
 *   SIGNER_PASSKEY_DELAY_HOURS  waiting period for a first passkey (default 24)
 *   NEAR_RPC_URL           NEAR RPC endpoint(s), comma separated
 */
function caps(name: string, required: boolean): Record<string, Cap> {
  const raw = JSON.parse(process.env[name] ?? "{}") as Record<string, { perTx: string; daily: string }>;
  if (required && !Object.keys(raw).length) throw new Error(`${name} is empty: the signer would refuse everything`);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { perTx: BigInt(v.perTx), daily: BigInt(v.daily) }]));
}

async function main(): Promise<void> {
  const contract = process.env["SIGNER_STATE_CONTRACT"];
  if (!contract) throw new Error("SIGNER_STATE_CONTRACT is not set: without an on-chain record a rolled-back disk could reset the limits, so the signer will not start");
  const token = process.env["SIGNER_TOKEN"] ?? "";
  const port = Number(process.env["PORT"] ?? 3000);
  const origin = process.env["SIGNER_ORIGIN"] ?? "https://moopay.cash";
  const delay = Number(process.env["SIGNER_PASSKEY_DELAY_HOURS"] ?? 24) * 3600_000;

  const root = await new DstackKeySource().root();
  const keys: KeySource = { root: async () => root };
  const urls = (process.env["NEAR_RPC_URL"] ?? "https://rpc.mainnet.near.org").split(",").map((u) => u.trim()).filter(Boolean);
  const provider = urls.length > 1 ? new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url }))) : new JsonRpcProvider({ url: urls[0]! });
  const writer = deriveWallet(root, "__state-writer__");
  const store = new NearStateStore(contract, provider as never, writer.accountId, writer.secretKey);
  const signer = new WalletSigner(keys, { caps: caps("SIGNER_CAPS", true), unattended: caps("SIGNER_UNATTENDED", false), ...(process.env["SIGNER_FEE_ACCOUNT"] ? { feeAccount: process.env["SIGNER_FEE_ACCOUNT"], feeCaps: caps("SIGNER_FEE_CAPS", false) } : {}) }, new SignerPasskeys(origin, delay), store);

  // The operator funds this account with a little NEAR and sets it as the contract's signer, once.
  console.log(`[signer] state writer account: ${writer.accountId}`);
  signerServer(signer, token, (m) => console.log(`[signer] ${m}`)).listen(port, "0.0.0.0", () => console.log(`[signer] up on ${port}`));
}

main().catch((e) => { console.error("[signer] failed to start:", e instanceof Error ? e.message : e); process.exit(1); });

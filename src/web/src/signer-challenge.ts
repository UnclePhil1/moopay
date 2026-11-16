/*
 * What the passkey signs for an account whose key is in the signer.
 *
 * The page builds the challenge itself, from the payment it shows and a one-time nonce the signer issued, and hashes it exactly the
 * way the signer does (src/signer/passkeys.ts: flowsText, mandateChallenge, actionChallenge). A test keeps the two in step. If the
 * MooPay server lied about the payment, the nonce or the user, the signature would not match what the signer expects, and the
 * signer would refuse it.
 *
 * This module has no browser-only imports, so the same code runs in the page and in the tests.
 */
export interface PayFlow { asset: string; to: string; amount: string }
export type SignerAction = "addkey" | "strict:on" | "strict:off" | "unlock" | "showcode" | `recoverykey:${string}` | `removekey:${string}`;
export interface SignerPrompt {
  kind: "mandate" | "action";
  userId: string;
  nonce: string;
  rpId: string;
  allowCredentials: { id: string; type: "public-key"; transports?: string[] }[];
  flows?: PayFlow[];
  action?: SignerAction;
}

export const flowsText = (flows: PayFlow[]): string => flows.map((f) => [f.asset, f.amount, f.to].join(" ")).sort().join("\n");

async function sha(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let bin = ""; for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const mandateChallenge = (user: string, nonce: string, flows: PayFlow[]): Promise<string> => sha(`moopay.mandate.v1|${user}|${nonce}|${flowsText(flows)}`);
export const actionChallenge = (user: string, nonce: string, action: SignerAction): Promise<string> => sha(`moopay.action.v1|${user}|${nonce}|${action}`);

export function signerChallenge(p: SignerPrompt): Promise<string> {
  if (p.kind === "mandate" && p.flows?.length) return mandateChallenge(p.userId, p.nonce, p.flows);
  if (p.kind === "action" && p.action) return actionChallenge(p.userId, p.nonce, p.action);
  throw new Error("That request is not one the passkey can sign.");
}

/**
 * Assets the page knows by name. Anything else is shown as raw units and contract, so a server cannot make 5000 look like 5
 * by sending a made-up symbol or number of decimals.
 */
const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  NEAR: { symbol: "NEAR", decimals: 24 },
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { symbol: "USDC", decimals: 6 },
};

export function describeFlow(f: PayFlow): string {
  const k = KNOWN[f.asset];
  if (!k || !/^\d+$/.test(f.amount)) return `${f.amount} units of ${f.asset} to ${f.to}`;
  const n = BigInt(f.amount), base = 10n ** BigInt(k.decimals);
  const whole = n / base, frac = (n % base).toString().padStart(k.decimals, "0").replace(/0+$/, "").padEnd(Math.min(2, k.decimals), "0");
  return `${whole}${frac ? "." + frac : ""} ${k.symbol} to ${f.to}`;
}

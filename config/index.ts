import { z } from "zod";
import { MoopayError } from "../src/util/errors.js";

export type Confidentiality = "public" | "basic" | "advanced";

export interface Config {
  nearNetwork: "mainnet" | "testnet";
  nearRpcUrl: string;
  mpcContractId: string;
  oneClickBaseUrl: string;
  oneClickJwt: string | undefined;
  confidentiality: Confidentiality;
  stateFile: string;
}

const DEFAULT_RPC = {
  mainnet: "https://free.rpc.fastnear.com", // rpc.mainnet.near.org is deprecated and always answers 429
  testnet: "https://rpc.testnet.near.org",
} as const;

/** Environment values arrive as strings; blank means unset. */
const url = z.string().refine((v) => URL.canParse(v), "is not a valid URL");

const EnvSchema = z.object({
  NEAR_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  ONECLICK_CONFIDENTIALITY: z.enum(["public", "basic", "advanced"]).default("basic"),
  ONECLICK_BASE_URL: url.default("https://1click.chaindefuser.com"),
  NEAR_RPC_URL: url.optional(),
  MPC_CONTRACT_ID: z.string().min(1).default("v1.signer"),
  ONECLICK_JWT: z.string().min(1).optional(),
  STATE_FILE: z.string().min(1).default("./moopay-state.json"),
});

/**
 * MooPay holds no operator key, so nothing is strictly required. Validates what is set and fails fast
 * with one message listing every problem. Never echoes values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, string> = {};
  for (const k of Object.keys(EnvSchema.shape)) {
    const v = env[k]?.trim();
    if (v) raw[k] = v;
  }
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${String(i.path[0])} ${i.code === "invalid_value" ? `must be ${(i as { values: string[] }).values.join(", ")}` : i.message}`);
    throw new MoopayError("INVALID_INPUT", `Invalid configuration: ${problems.join("; ")}`);
  }
  const e = parsed.data;
  return {
    nearNetwork: e.NEAR_NETWORK,
    nearRpcUrl: e.NEAR_RPC_URL ?? DEFAULT_RPC[e.NEAR_NETWORK],
    mpcContractId: e.MPC_CONTRACT_ID,
    oneClickBaseUrl: e.ONECLICK_BASE_URL.replace(/\/+$/, ""),
    oneClickJwt: e.ONECLICK_JWT,
    confidentiality: e.ONECLICK_CONFIDENTIALITY,
    stateFile: e.STATE_FILE,
  };
}

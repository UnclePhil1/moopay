import { MoopayError } from "./errors.js";

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

/**
 * MooPay holds no key, so nothing is strictly required. Validates what is set and fails fast
 * with one message listing every problem. Never echoes values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const get = (k: string): string | undefined => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };

  const network = get("NEAR_NETWORK") ?? "mainnet";
  if (network !== "mainnet" && network !== "testnet") problems.push("NEAR_NETWORK must be mainnet or testnet");

  const conf = get("ONECLICK_CONFIDENTIALITY") ?? "basic";
  if (conf !== "public" && conf !== "basic" && conf !== "advanced")
    problems.push("ONECLICK_CONFIDENTIALITY must be public, basic or advanced");

  const base = (get("ONECLICK_BASE_URL") ?? "https://1click.chaindefuser.com").replace(/\/+$/, "");
  try {
    new URL(base);
  } catch {
    problems.push("ONECLICK_BASE_URL is not a valid URL");
  }

  const rpc = get("NEAR_RPC_URL");
  if (rpc) {
    try {
      new URL(rpc);
    } catch {
      problems.push("NEAR_RPC_URL is not a valid URL");
    }
  }

  if (problems.length) throw new MoopayError("INVALID_INPUT", `Invalid configuration: ${problems.join("; ")}`);

  const net = network as "mainnet" | "testnet";
  return {
    nearNetwork: net,
    nearRpcUrl: rpc ?? DEFAULT_RPC[net],
    mpcContractId: get("MPC_CONTRACT_ID") ?? "v1.signer",
    oneClickBaseUrl: base,
    oneClickJwt: get("ONECLICK_JWT"),
    confidentiality: conf as Confidentiality,
    stateFile: get("STATE_FILE") ?? "./moopay-state.json",
  };
}

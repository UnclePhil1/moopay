import Anthropic from "@anthropic-ai/sdk";
import type { Llm } from "../loop.js";
import { nearAiLlm, nearAiTier, NEAR_AI_MODEL } from "../cloud/nearai.js";

export interface Provider { llm?: Llm; model?: string | undefined; ai?: { name: string; tier: string } }

/** NEAR AI (sealed enclaves) when its key is set, else Anthropic. Same chat, same rules; only the brain differs. */
export async function pickProvider(env: NodeJS.ProcessEnv = process.env): Promise<Provider> {
  const model = env["AGENT_MODEL"];
  if (env["NEAR_AI_API_KEY"]) {
    const m = model ?? NEAR_AI_MODEL;
    return { llm: nearAiLlm(env["NEAR_AI_API_KEY"]), model: m, ai: { name: "NEAR AI", tier: await nearAiTier(m) } };
  }
  if (env["ANTHROPIC_API_KEY"]) return { llm: new Anthropic({ apiKey: env["ANTHROPIC_API_KEY"] }) as never, model, ai: { name: "Anthropic", tier: "Provider API" } };
  return {};
}

import type { Llm } from "../loop.js";

/*
 * NEAR AI Cloud as the agent's brain. It speaks the OpenAI chat format, so this is a small translator
 * from the Anthropic-style messages the loop uses; the loop itself does not change. Models marked
 * "nearai" run inside hardware-sealed enclaves (TEEs), so even the model host can't read prompts.
 */

export const NEAR_AI_URL = "https://cloud-api.near.ai/v1";
export const NEAR_AI_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017"; // sealed on NEAR AI's own GPUs, tool calling, cheap

type Msg = { role: string; content: unknown };
type Part = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string };

/** Anthropic-style messages -> OpenAI chat messages. */
function toChat(system: string, messages: Msg[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const parts = m.content as Part[];
    if (m.role === "assistant") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
      const calls = parts.filter((p) => p.type === "tool_use").map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else for (const p of parts) out.push(p.type === "tool_result" ? { role: "tool", tool_call_id: p.tool_use_id, content: p.content ?? "" } : { role: "user", content: p.text ?? "" });
  }
  return out;
}

export function nearAiLlm(apiKey: string, baseUrl = NEAR_AI_URL, doFetch: typeof fetch = fetch): Llm {
  return {
    messages: {
      async create(p) {
        const tools = (p["tools"] as { name: string; description: string; input_schema: unknown }[] | undefined)?.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
        const res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: p["model"], max_tokens: p["max_tokens"], messages: toChat(String(p["system"] ?? ""), p["messages"] as Msg[]), ...(tools?.length ? { tools } : {}) }),
        });
        if (!res.ok) throw Object.assign(new Error(`NEAR AI ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`), { status: res.status });
        const msg = ((await res.json()) as { choices: { message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[] }).choices[0];
        const content: { type: string; [k: string]: unknown }[] = [];
        if (msg?.message.content) content.push({ type: "text", text: msg.message.content });
        for (const c of msg?.message.tool_calls ?? []) {
          let input: unknown = {};
          try { input = JSON.parse(c.function.arguments || "{}"); } catch { input = { __bad_json: true }; } // fails tool validation, the model sees the error and retries
          content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
        }
        return { content: content as never, stop_reason: msg?.finish_reason ?? null };
      },
    },
  };
}

/** "Confidential TEE" when the model runs on NEAR AI's own sealed GPUs, otherwise a plain label. Never throws. */
export async function nearAiTier(model: string, baseUrl = NEAR_AI_URL, doFetch: typeof fetch = fetch): Promise<string> {
  try {
    const list = ((await (await doFetch(`${baseUrl}/models`)).json()) as { models?: { id: string; owned_by?: string }[]; data?: { id: string; owned_by?: string }[] });
    const m = (list.models ?? list.data ?? []).find((x) => x.id === model);
    if (!m) return "unknown";
    return m.owned_by === "nearai" ? "Confidential TEE" : m.owned_by === "attested 3p" ? "3rd-party TEE" : "Gateway only";
  } catch { return "unknown"; }
}

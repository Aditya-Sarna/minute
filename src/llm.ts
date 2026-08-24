import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

export function llmConfigured(): boolean {
  return Boolean(anthropicKey || openaiKey);
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

export async function complete(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
  const model = process.env.MINUTE_LLM_MODEL;
  if (anthropicKey) {
    const client = new Anthropic({ apiKey: anthropicKey });
    const res = await client.messages.create({
      model: model || "claude-sonnet-4-5-20250929",
      max_tokens: opts?.maxTokens ?? 8000,
      messages: [{ role: "user", content: prompt }],
    });
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  }
  if (openaiKey) {
    const client = new OpenAI({ apiKey: openaiKey });
    const res = await client.chat.completions.create({
      model: model || "gpt-4.1",
      messages: [{ role: "user", content: prompt }],
      max_tokens: opts?.maxTokens ?? 8000,
    });
    return res.choices[0]?.message?.content ?? "";
  }
  throw new Error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY");
}

export async function completeJson<T>(prompt: string, opts?: { maxTokens?: number }): Promise<T> {
  const text = await complete(
    `${prompt}

Reply with JSON only. No markdown.`,
    opts,
  );
  return JSON.parse(extractJson(text)) as T;
}

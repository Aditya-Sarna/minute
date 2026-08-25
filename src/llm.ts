import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { log } from "./logger.js";

export function llmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /429|rate|timeout|529|503|overloaded/i.test(msg);
      if (!retryable || i === attempts - 1) throw err;
      const wait = 500 * 2 ** i;
      log.warn({ err, wait }, "llm retry");
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

export async function complete(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
  const model = process.env.MINUTE_LLM_MODEL;
  return withRetry(async () => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
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
  });
}

export async function completeJson<T>(prompt: string, opts?: { maxTokens?: number }): Promise<T> {
  const ask = `${prompt}

Reply with JSON only. No markdown.`;
  let text = await complete(ask, opts);
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    text = await complete(`${ask}\n\nYour previous reply was not valid JSON. Return JSON only.`, opts);
    return JSON.parse(extractJson(text)) as T;
  }
}

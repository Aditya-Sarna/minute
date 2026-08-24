import { completeJson } from "./llm.js";
import { repoLabel } from "./config.js";
import type { ClassifyResult, Playground } from "./types.js";

export async function classifyRequest(
  request: string,
  playground: Playground,
): Promise<ClassifyResult> {
  const result = await completeJson<{
    simple: boolean;
    reason: string;
    route: string;
    summary: string;
  }>(`You are Minute's gate. Minute is ONLY for simple, non-technical work that still has to live in a git repo: copy, color, spacing, a small tab, placing an image/chart, hiding a badge.

Refuse if it is architecture, auth, payments, infra, migrations, secrets, a rewrite, a new product flow, or too vague to do as a smallest-possible change.

Playground: ${playground.id} (${repoLabel(playground)})
Allowed paths: ${playground.allow.paths.join(", ") || "(none listed)"}
Allowed routes: ${playground.allow.routes.join(", ") || "/"}
Hard refuse topics: ${playground.refuse.join(", ") || "(none)"}

Stakeholder request:
${request}

Return:
{
  "simple": boolean,
  "reason": "short, spoken to the stakeholder if refusing; empty if ok",
  "route": "best matching route from allowed routes",
  "summary": "one line of what you would change"
}`);

  if (!result.simple) {
    return {
      ok: false,
      reason:
        result.reason ||
        "This isn’t a Minute — ping tech first. It’s bigger than a simple change.",
    };
  }

  const route =
    playground.allow.routes.find((r) => r === result.route) ??
    playground.preview.defaultRoute ??
    playground.allow.routes[0] ??
    "/";

  return { ok: true, route, summary: result.summary || request };
}

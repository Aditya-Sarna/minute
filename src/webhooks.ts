import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { runByPrNumber, seenWebhook } from "./store.js";
import { enqueueGithub } from "./jobs.js";
import { log } from "./logger.js";

function validSignature(raw: string, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerGithubWebhook(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (req.url?.startsWith("/webhooks/github")) {
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse(String(body)));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post("/webhooks/github", async (req, reply) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    if (secret) {
      const sig = req.headers["x-hub-signature-256"];
      if (typeof sig !== "string" || !validSignature(raw, sig, secret)) {
        return reply.code(401).send({ ok: false });
      }
    } else if (process.env.NODE_ENV === "production") {
      return reply.send({ ok: true, ignored: "set GITHUB_WEBHOOK_SECRET; using poll" });
    }

    const delivery = req.headers["x-github-delivery"];
    if (typeof delivery === "string" && seenWebhook(delivery)) {
      return reply.send({ ok: true, duplicate: true });
    }

    const event = req.headers["x-github-event"];
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ ok: false });
    }

    const pr = (payload.pull_request ?? payload) as { number?: number; merged?: boolean; state?: string };
    const number = pr.number;
    if (!number) return reply.send({ ok: true });
    const run = runByPrNumber(number);
    if (!run) return reply.send({ ok: true, ignored: true });

    if (event === "pull_request") {
      const action = payload.action;
      if (action === "closed" && pr.merged) enqueueGithub(run.id, "merged");
      else if (action === "closed") enqueueGithub(run.id, "closed");
    }
    if (event === "pull_request_review") {
      const review = payload.review as { state?: string } | undefined;
      if (review?.state === "changes_requested") enqueueGithub(run.id, "changes_requested");
    }

    log.info({ event, pr: number, runId: run.id }, "github webhook");
    return reply.send({ ok: true });
  });
}

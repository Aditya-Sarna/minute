import "dotenv/config";
import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { openDb, closeDb } from "./db.js";
import { log } from "./logger.js";
import { createSlackApp } from "./slack-app.js";
import { createDiscordClient } from "./discord-app.js";
import { startGithubWatch } from "./github-watch.js";
import { slackAdapter } from "./surfaces/slack.js";
import { discordAdapter, asSendable } from "./surfaces/discord.js";
import { startJobs } from "./jobs.js";
import { recoverStuckJobs, stopWorker } from "./queue.js";
import { registerGithubWebhook } from "./webhooks.js";
import { inflightCount } from "./queue.js";
import type { Run } from "./types.js";
import type { ChatAdapter } from "./surfaces/types.js";

function bootEnv() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY");
  }
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("Set GITHUB_TOKEN");
  }
  const slack =
    process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && process.env.SLACK_SIGNING_SECRET;
  if (!slack && !process.env.DISCORD_TOKEN) {
    throw new Error("Configure Slack and/or Discord in .env");
  }
}

async function main() {
  bootEnv();
  openDb();
  recoverStuckJobs();
  loadConfig();

  const slack = createSlackApp();
  const discord = createDiscordClient();

  if (slack) {
    await slack.start();
    log.info("slack socket mode on");
  } else {
    log.warn("slack skipped");
  }

  if (discord) {
    await discord.client.login(discord.token);
  } else {
    log.warn("discord skipped");
  }

  const lookup = async (run: Run): Promise<ChatAdapter | null> => {
    if (run.surface === "slack") {
      if (!slack) return null;
      return slackAdapter(slack.client, run.channelId, run.threadId);
    }
    if (!discord) return null;
    const channel = await discord.client.channels.fetch(run.threadId);
    if (!channel || !channel.isTextBased()) return null;
    return discordAdapter(asSendable(channel));
  };

  startJobs(lookup);
  startGithubWatch();

  const port = Number(process.env.PORT || 8787);
  const http = Fastify({ logger: false });
  http.get("/health", async () => ({ ok: true }));
  http.get("/ready", async (_req, reply) => {
    try {
      loadConfig();
      return { ok: true, inflight: inflightCount(), name: loadConfig().name };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  registerGithubWebhook(http);
  await http.listen({ port, host: "0.0.0.0" });
  log.info({ port }, "minute up");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await stopWorker();
    if (slack) await slack.stop();
    discord?.client.destroy();
    await http.close();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});

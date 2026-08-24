import "dotenv/config";
import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { createSlackApp } from "./slack-app.js";
import { createDiscordClient } from "./discord-app.js";
import { startGithubWatch } from "./github-watch.js";
import { slackAdapter } from "./surfaces/slack.js";
import { discordAdapter, asSendable } from "./surfaces/discord.js";
import type { ChatAdapter } from "./surfaces/types.js";
import type { Run } from "./types.js";

async function main() {
  loadConfig();

  const slack = createSlackApp();
  const discord = createDiscordClient();

  if (slack) {
    await slack.start();
    log.info("slack socket mode on");
  } else {
    log.warn("slack skipped — set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET");
  }

  if (discord) {
    await discord.client.login(discord.token);
  } else {
    log.warn("discord skipped — set DISCORD_TOKEN");
  }

  if (!slack && !discord) {
    throw new Error("No chat surface configured. Fill .env for Slack and/or Discord.");
  }

  startGithubWatch(async (run: Run): Promise<ChatAdapter | null> => {
    if (run.surface === "slack") {
      if (!slack) return null;
      return slackAdapter(slack.client, run.channelId, run.threadId);
    }
    if (!discord) return null;
    const channel = await discord.client.channels.fetch(run.threadId);
    if (!channel || !channel.isTextBased()) return null;
    return discordAdapter(asSendable(channel));
  });

  const port = Number(process.env.PORT || 8787);
  const http = Fastify({ logger: false });
  http.get("/health", async () => ({ ok: true, name: loadConfig().name }));
  await http.listen({ port, host: "0.0.0.0" });
  log.info({ port }, "minute up");
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});

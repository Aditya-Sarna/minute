import bolt from "@slack/bolt";
import { isAdmin, isRequester, grant, revoke, denyMessage, listGranted } from "./access.js";
import { playgroundForChannel, loadConfig, repoLabel } from "./config.js";
import { getRun, runByThread, busyRunInThread, claimRun } from "./store.js";
import { downloadAttachment } from "./download.js";
import { clampRequest, LIMITS } from "./limits.js";
import { takeStartToken, takeIterateToken, rateLimitedMessage } from "./rate-limit.js";
import { createRunDraft } from "./protocol.js";
import { enqueueStart, enqueueIterate, enqueueHandoff, enqueueCancel } from "./jobs.js";

const { App } = bolt;

export function createSlackApp() {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!token || !appToken || !signingSecret) return null;

  const app = new App({
    token,
    appToken,
    signingSecret,
    socketMode: true,
  });

  app.command("/minute", async ({ command, ack, client }) => {
    await ack();
    const userId = command.user_id;
    if (!isRequester("slack", userId)) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: userId,
        text: denyMessage(),
      });
      return;
    }
    if (!takeStartToken("slack", userId)) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: userId,
        text: rateLimitedMessage(),
      });
      return;
    }
    const playground = playgroundForChannel("slack", command.channel_id);
    if (!playground) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: userId,
        text: "This channel isn’t wired to a playground. Ask an admin to add its channel ID in minute.config.yaml.",
      });
      return;
    }
    const text = clampRequest(command.text || "");
    if (!text) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: userId,
        text: `Try \`/minute make the homepage background forest green\` (max ${LIMITS.requestChars} chars).`,
      });
      return;
    }

    const parent = await client.chat.postMessage({
      channel: command.channel_id,
      text: `*Minute* · <@${userId}> · ${text}`,
    });
    const threadTs = parent.ts;
    if (!threadTs) return;

    const run = createRunDraft({
      surface: "slack",
      channelId: command.channel_id,
      threadId: threadTs,
      parentMessageId: threadTs,
      requesterId: userId,
      requesterName: command.user_name,
      playgroundId: playground.id,
      text,
    });
    enqueueStart(run.id);
  });

  app.command("/minute-admin", async ({ command, ack, client }) => {
    await ack();
    if (!isAdmin("slack", command.user_id)) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Admins only.",
      });
      return;
    }
    const [verb, raw] = (command.text || "").trim().split(/\s+/, 2);
    const mention = raw?.match(/<@([A-Z0-9]+)/)?.[1];
    if (verb === "allow" && mention) {
      grant("slack", mention);
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Granted Minute to <@${mention}>.`,
      });
      return;
    }
    if (verb === "revoke" && mention) {
      revoke("slack", mention);
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Revoked Minute from <@${mention}>.`,
      });
      return;
    }
    const cfg = loadConfig();
    const playgrounds = cfg.playgrounds
      .map((p) => `• ${p.id} → ${repoLabel(p)} · slack channels ${p.slackChannelIds.join(", ") || "(none)"}`)
      .join("\n");
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: [
        `*Minute admin*`,
        `Requesters: ${listGranted("slack").map((id) => `<@${id}>`).join(", ") || "(none)"}`,
        `Tech: ${cfg.tech.slackUserIds.map((id) => `<@${id}>`).join(", ") || "(none)"}`,
        playgrounds,
        `Usage: \`/minute-admin allow @user\` · \`/minute-admin revoke @user\``,
      ].join("\n"),
    });
  });

  app.action("minute_looks_good", async ({ ack, body, client }) => {
    await ack();
    const runId =
      "actions" in body && body.actions?.[0] && "value" in body.actions[0] ? body.actions[0].value : "";
    const run = runId ? getRun(runId) : undefined;
    if (!run) return;
    if (body.user.id !== run.requesterId && !isAdmin("slack", body.user.id)) return;
    enqueueHandoff(run.id);
  });

  app.action("minute_cancel", async ({ ack, body }) => {
    await ack();
    const runId =
      "actions" in body && body.actions?.[0] && "value" in body.actions[0] ? body.actions[0].value : "";
    const run = runId ? getRun(runId) : undefined;
    if (!run) return;
    enqueueCancel(run.id, "Cancelled in chat. Minute is done.");
  });

  app.event("message", async ({ event, client }) => {
    if (event.subtype && event.subtype !== "file_share") return;
    const threadTs = "thread_ts" in event ? event.thread_ts : undefined;
    if (!threadTs || threadTs === event.ts) return;
    if ("bot_id" in event && event.bot_id) return;
    if (busyRunInThread("slack", threadTs)) return;
    const run = runByThread("slack", threadTs);
    if (!run || run.status !== "proof") return;
    if (!("user" in event) || event.user !== run.requesterId) return;
    if (!claimRun(run.id, "proof", "working")) return;
    if (!takeIterateToken("slack", event.user)) {
      claimRun(run.id, "working", "proof");
      await client.chat.postMessage({
        channel: run.channelId,
        thread_ts: threadTs,
        text: rateLimitedMessage(),
      });
      return;
    }
    const text = clampRequest("text" in event ? event.text || "" : "");

    const attachments = [];
    if ("files" in event && Array.isArray(event.files)) {
      for (const f of event.files) {
        if (!f.url_private || !f.name) continue;
        attachments.push(
          await downloadAttachment(run.id, { name: f.name, url: f.url_private }, {
            Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          }),
        );
      }
    }
    if (!text && attachments.length === 0) {
      claimRun(run.id, "working", "proof");
      return;
    }
    enqueueIterate(run.id, text || "(see attached file)", attachments);
  });

  return app;
}

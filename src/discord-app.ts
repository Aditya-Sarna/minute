import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
} from "discord.js";
import { isAdmin, isRequester, grant, revoke, denyMessage, listGranted } from "./access.js";
import { playgroundForChannel, loadConfig, repoLabel } from "./config.js";
import { getRun, runByThread, busyRunInThread, claimRun } from "./store.js";
import { downloadAttachment } from "./download.js";
import { log } from "./logger.js";
import { clampRequest, LIMITS } from "./limits.js";
import { takeStartToken, takeIterateToken, rateLimitedMessage } from "./rate-limit.js";
import { createRunDraft } from "./protocol.js";
import { enqueueStart, enqueueIterate, enqueueHandoff, enqueueCancel } from "./jobs.js";

export function createDiscordClient() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return null;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, (c) => {
    log.info({ user: c.user.tag }, "discord ready");
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton()) {
        const [prefix, action, runId] = interaction.customId.split(":");
        if (prefix !== "minute" || !runId) return;
        const run = getRun(runId);
        if (!run) {
          await interaction.reply({ content: "That Minute is gone.", ephemeral: true });
          return;
        }
        if (action === "looks_good") {
          if (interaction.user.id !== run.requesterId && !isAdmin("discord", interaction.user.id)) {
            await interaction.reply({ content: "Only the requester can sign off.", ephemeral: true });
            return;
          }
          await interaction.deferUpdate();
          enqueueHandoff(run.id);
          return;
        }
        if (action === "cancel") {
          await interaction.deferUpdate();
          enqueueCancel(run.id, "Cancelled in chat. Minute is done.");
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "minute-admin") {
        await handleAdmin(interaction);
        return;
      }
      if (interaction.commandName !== "minute") return;

      const userId = interaction.user.id;
      if (!isRequester("discord", userId)) {
        await interaction.reply({ content: denyMessage(), ephemeral: true });
        return;
      }
      if (!takeStartToken("discord", userId)) {
        await interaction.reply({ content: rateLimitedMessage(), ephemeral: true });
        return;
      }
      const channelId = interaction.channelId;
      const playground = playgroundForChannel("discord", channelId);
      if (!playground) {
        await interaction.reply({
          content:
            "This channel isn’t wired to a playground. Ask an admin to add its channel ID in minute.config.yaml.",
          ephemeral: true,
        });
        return;
      }
      const text = clampRequest(interaction.options.getString("request", true));
      if (!text) {
        await interaction.reply({
          content: `Need a request (max ${LIMITS.requestChars} chars).`,
          ephemeral: true,
        });
        return;
      }
      await interaction.reply(`**Minute** · ${interaction.user} · ${text}`);
      const reply = await interaction.fetchReply();
      const channel = await interaction.channel?.fetch();
      if (!channel || !("threads" in channel)) {
        await interaction.followUp({
          content: "Minute needs a channel that can have threads.",
          ephemeral: true,
        });
        return;
      }
      const thread = await reply.startThread({
        name: `minute · ${text.slice(0, 80)}`,
        autoArchiveDuration: 1440,
      });
      const file = interaction.options.getAttachment("file");
      const attachments = [];
      if (file) {
        attachments.push(await downloadAttachment(thread.id, { name: file.name, url: file.url }));
      }
      const run = createRunDraft({
        surface: "discord",
        channelId,
        threadId: thread.id,
        parentMessageId: reply.id,
        requesterId: userId,
        requesterName: interaction.user.displayName || interaction.user.username,
        playgroundId: playground.id,
        text,
      });
      enqueueStart(run.id, attachments);
    } catch (err) {
      log.error({ err }, "discord interaction");
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;
    if (busyRunInThread("discord", message.channel.id)) return;
    const run = runByThread("discord", message.channel.id);
    if (!run || run.status !== "proof") return;
    if (message.author.id !== run.requesterId) return;
    if (!claimRun(run.id, "proof", "working")) return;
    if (!takeIterateToken("discord", message.author.id)) {
      claimRun(run.id, "working", "proof");
      await message.reply(rateLimitedMessage());
      return;
    }
    const text = clampRequest(message.content);
    if (!text && message.attachments.size === 0) {
      claimRun(run.id, "working", "proof");
      return;
    }
    const attachments = [];
    for (const att of message.attachments.values()) {
      attachments.push(await downloadAttachment(run.id, { name: att.name, url: att.url }));
    }
    enqueueIterate(run.id, text || "(see attached file)", attachments);
  });

  return { client, token };
}

async function handleAdmin(interaction: ChatInputCommandInteraction) {
  if (!isAdmin("discord", interaction.user.id)) {
    await interaction.reply({ content: "Admins only.", ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  const user = interaction.options.getUser("user");
  if (sub === "allow" && user) {
    grant("discord", user.id);
    await interaction.reply({ content: `Granted Minute to ${user}.`, ephemeral: true });
    return;
  }
  if (sub === "revoke" && user) {
    revoke("discord", user.id);
    await interaction.reply({ content: `Revoked Minute from ${user}.`, ephemeral: true });
    return;
  }
  const cfg = loadConfig();
  const playgrounds = cfg.playgrounds
    .map((p) => `• ${p.id} → ${repoLabel(p)} · discord ${p.discordChannelIds.join(", ") || "(none)"}`)
    .join("\n");
  await interaction.reply({
    ephemeral: true,
    content: [
      `**Minute admin**`,
      `Requesters: ${listGranted("discord").map((id) => `<@${id}>`).join(" ") || "(none)"}`,
      `Tech: ${cfg.tech.discordUserIds.map((id) => `<@${id}>`).join(" ") || "(none)"}`,
      playgrounds,
    ].join("\n"),
  });
}

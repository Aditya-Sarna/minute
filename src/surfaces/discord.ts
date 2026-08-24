import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageCreateOptions,
} from "discord.js";
import { basename } from "node:path";
import type { ChatAdapter } from "./types.js";
import type { Proof, Run } from "../types.js";

type Sendable = {
  send: (payload: string | MessageCreateOptions) => Promise<unknown>;
};

export function asSendable(channel: object): Sendable {
  if (!("send" in channel) || typeof (channel as Sendable).send !== "function") {
    throw new Error("channel cannot send");
  }
  return channel as Sendable;
}

export function discordAdapter(channel: Sendable): ChatAdapter {
  const send = (payload: string | MessageCreateOptions) => channel.send(payload);

  return {
    mention: (userId) => `<@${userId}>`,

    async postStatus(text) {
      await send(text);
    },

    async postRefuse(reason) {
      await send(reason);
    },

    async postProof(proof: Proof, run: Run) {
      const content = [
        proof.caption,
        `Route \`${proof.route}\` · ${proof.filesChanged.map((f) => `\`${f}\``).join(", ") || "files changed"}`,
        proof.skippedReason ? `_${proof.skippedReason}_` : "",
        run.prUrl ? `PR for tech: ${run.prUrl}` : "",
        "Reply here to tweak. **Looks good** pings tech to review the PR.",
      ]
        .filter(Boolean)
        .join("\n");

      const files = [proof.beforePath, proof.afterPath].filter(Boolean).map((p) => ({
        attachment: p as string,
        name: basename(p as string),
      }));

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`minute:looks_good:${run.id}`)
          .setLabel("Looks good")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`minute:cancel:${run.id}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      );

      await send({
        content,
        files: files.length ? files : undefined,
        components: [row],
      });
    },

    async postHandoff(run, techMentions) {
      await send(
        `${techMentions} **${run.requesterName}** signed off visually. Review the PR on technical grounds — approve or disapprove. If it isn’t feasible, take it offline; Minute stops.\n${run.prUrl ?? ""}`,
      );
    },

    async postExit(reason) {
      await send(reason);
    },
  };
}

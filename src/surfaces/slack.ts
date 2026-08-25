import type { ChatAdapter } from "./types.js";
import type { Proof, Run } from "../types.js";
import type { WebClient } from "@slack/web-api";
import { createReadStream } from "node:fs";

export function slackAdapter(
  client: WebClient,
  channel: string,
  threadTs: string,
): ChatAdapter {
  return {
    mention: (userId) => `<@${userId}>`,

    async postOrUpdateStatus(text, messageId) {
      if (messageId) {
        await client.chat.update({ channel, ts: messageId, text });
        return messageId;
      }
      const posted = await client.chat.postMessage({ channel, thread_ts: threadTs, text });
      return posted.ts;
    },

    async postRefuse(reason) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: reason });
    },

    async postProof(proof: Proof, run: Run) {
      const lines = [
        proof.caption,
        `Route \`${proof.route}\` · ${proof.filesChanged.map((f) => `\`${f}\``).join(", ") || "files changed"}`,
        proof.skippedReason ? `_${proof.skippedReason}_` : "",
        run.prUrl ? `PR for tech (don’t need it unless you’re tech): ${run.prUrl}` : "",
        "Reply in this thread to tweak. *Looks good* pings tech to review the PR.",
      ]
        .filter(Boolean)
        .join("\n");

      for (const [label, file] of [
        ["before", proof.beforePath],
        ["after", proof.afterPath],
      ] as const) {
        if (!file) continue;
        await client.filesUploadV2({
          channel_id: channel,
          thread_ts: threadTs,
          filename: `${label}.png`,
          file: createReadStream(file),
          initial_comment: label === "after" ? lines : `*${label}*`,
        });
      }

      if (!proof.afterPath) {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: lines });
      }

      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "When the photo looks right, hand it to tech.",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Looks good" },
                style: "primary",
                action_id: "minute_looks_good",
                value: run.id,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Cancel" },
                action_id: "minute_cancel",
                value: run.id,
              },
            ],
          },
        ],
      });
    },

    async postHandoff(run, techMentions) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `${techMentions} ${run.requesterName} signed off visually. Review the PR on technical grounds — approve or disapprove. If it isn’t feasible, take it offline; Minute stops.\n${run.prUrl ?? ""}`,
      });
    },

    async postExit(reason) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: reason });
    },
  };
}

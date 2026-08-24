import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { MinuteConfig, Playground, Surface } from "./types.js";

const ids = z.array(z.string()).default([]);

const schema = z.object({
  minute: z.object({
    name: z.string().default("Office"),
    admins: z
      .object({
        slackUserIds: ids,
        discordUserIds: ids,
        githubLogins: ids,
      })
      .default({}),
    requesters: z
      .object({
        slackUserIds: ids,
        discordUserIds: ids,
      })
      .default({}),
    tech: z
      .object({
        slackUserIds: ids,
        discordUserIds: ids,
      })
      .default({}),
    playgrounds: z
      .array(
        z.object({
          id: z.string(),
          slackChannelIds: ids,
          discordChannelIds: ids,
          github: z.object({
            owner: z.string(),
            repo: z.string(),
            defaultBranch: z.string().default("main"),
          }),
          preview: z
            .object({
              baseUrl: z.string().default(""),
              command: z.string().default(""),
              url: z.string().default("http://localhost:3000"),
              waitSeconds: z.number().default(25),
              defaultRoute: z.string().default("/"),
            })
            .default({}),
          allow: z
            .object({
              paths: z.array(z.string()).default([]),
              routes: z.array(z.string()).default(["/"]),
            })
            .default({}),
          refuse: z.array(z.string()).default([]),
        }),
      )
      .min(1),
  }),
});

let cached: MinuteConfig | null = null;

export function configPath(): string {
  return resolve(process.env.MINUTE_CONFIG ?? "minute.config.yaml");
}

export function loadConfig(): MinuteConfig {
  if (cached) return cached;
  const raw = readFileSync(configPath(), "utf8");
  const parsed = schema.parse(parse(raw));
  cached = parsed.minute;
  return cached;
}

export function reloadConfig(): MinuteConfig {
  cached = null;
  return loadConfig();
}

export function playgroundForChannel(
  surface: Surface,
  channelId: string,
): Playground | undefined {
  const cfg = loadConfig();
  return cfg.playgrounds.find((p) =>
    surface === "slack"
      ? p.slackChannelIds.includes(channelId)
      : p.discordChannelIds.includes(channelId),
  );
}

export function repoLabel(p: Playground): string {
  return `${p.github.owner}/${p.github.repo}`;
}

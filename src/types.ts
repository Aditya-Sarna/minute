export type Surface = "slack" | "discord";

export type RunStatus =
  | "classifying"
  | "working"
  | "proof"
  | "handed_off"
  | "exited"
  | "refused";

export type Run = {
  id: string;
  surface: Surface;
  channelId: string;
  threadId: string;
  parentMessageId: string;
  requesterId: string;
  requesterName: string;
  playgroundId: string;
  request: string;
  status: RunStatus;
  branch: string;
  prNumber?: number;
  prUrl?: string;
  workspaceDir?: string;
  lastProofPath?: string;
  createdAt: string;
  updatedAt: string;
  exitReason?: string;
};

export type Playground = {
  id: string;
  slackChannelIds: string[];
  discordChannelIds: string[];
  github: {
    owner: string;
    repo: string;
    defaultBranch: string;
  };
  preview: {
    baseUrl: string;
    command: string;
    url: string;
    waitSeconds: number;
    defaultRoute: string;
  };
  allow: {
    paths: string[];
    routes: string[];
  };
  refuse: string[];
};

export type MinuteConfig = {
  name: string;
  admins: {
    slackUserIds: string[];
    discordUserIds: string[];
    githubLogins: string[];
  };
  requesters: {
    slackUserIds: string[];
    discordUserIds: string[];
  };
  tech: {
    slackUserIds: string[];
    discordUserIds: string[];
  };
  playgrounds: Playground[];
};

export type Attachment = {
  name: string;
  url: string;
  localPath?: string;
};

export type Proof = {
  beforePath?: string;
  afterPath?: string;
  caption: string;
  route: string;
  filesChanged: string[];
  skippedReason?: string;
};

export type ClassifyResult =
  | { ok: true; route: string; summary: string }
  | { ok: false; reason: string };

import type { Proof, Run } from "../types.js";

export type ChatAdapter = {
  postOrUpdateStatus: (text: string, messageId?: string) => Promise<string | undefined>;
  postRefuse: (reason: string) => Promise<void>;
  postProof: (proof: Proof, run: Run) => Promise<void>;
  postHandoff: (run: Run, techMentions: string) => Promise<void>;
  postExit: (reason: string) => Promise<void>;
  mention: (userId: string) => string;
};

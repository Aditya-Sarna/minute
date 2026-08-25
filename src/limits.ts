import { resolve } from "node:path";

export function dataDir(): string {
  return resolve(process.env.MINUTE_DATA_DIR ?? ".data");
}

export const LIMITS = {
  requestChars: 4_000,
  iterations: 8,
  jobsPerUserHour: 10,
  iteratesPerUserHour: 30,
  jobTimeoutMs: Number(process.env.MINUTE_JOB_TIMEOUT_MS ?? 8 * 60 * 1000),
  maxConcurrentJobs: Number(process.env.MINUTE_MAX_JOBS ?? 2),
  maxEditFiles: 4,
  maxFileBytes: 200_000,
} as const;

export function clampRequest(text: string): string {
  return text.replace(/\0/g, "").trim().slice(0, LIMITS.requestChars);
}

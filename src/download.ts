import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Attachment } from "./types.js";

export async function downloadAttachment(
  runId: string,
  att: Attachment,
  headers?: Record<string, string>,
): Promise<Attachment> {
  const dest = resolve(".data/uploads", runId, att.name.replace(/[^\w.-]+/g, "_"));
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(att.url, { headers });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  return { ...att, localPath: dest };
}

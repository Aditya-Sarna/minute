export function normalizeRepoPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function isSafeRepoPath(file: string): boolean {
  if (!file || file.startsWith("/") || /^[a-zA-Z]:/.test(file)) return false;
  const norm = normalizeRepoPath(file);
  if (!norm) return false;
  const parts = norm.split("/");
  if (parts.some((p) => p === ".." || p === "")) return false;
  if (norm.startsWith(".git/") || norm === ".git") return false;
  return true;
}

export function isAllowedPath(file: string, allow: string[]): boolean {
  if (!isSafeRepoPath(file)) return false;
  const norm = normalizeRepoPath(file);
  if (allow.length === 0) return !norm.startsWith(".");
  return allow.some((p) => {
    const prefix = normalizeRepoPath(p);
    if (!prefix) return false;
    return norm === prefix || norm.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  });
}

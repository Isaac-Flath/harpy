/**
 * Session-scoped registry of search-result snippets already returned to the
 * model. kb_search and colgrep share it (all extensions load in one process),
 * so an exact file+range+content repeat — within or across tools — can be
 * replaced with a one-line stub instead of duplicating context.
 *
 * The content hash in the key makes suppression safe: if a file changes
 * between searches, the hash differs and the full content is returned again.
 */
import { createHash } from "crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const seen = new Map<string, string>(); // key -> tool that first returned the snippet

export function resultKey(
  file: string,
  startLine: number,
  endLine: number | undefined,
  content: string
): string {
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 12);
  return `${file}:${startLine}-${endLine ?? startLine}:${hash}`;
}

/**
 * Returns the name of the tool that already returned this exact snippet, or
 * undefined if it is new (and records it under the given tool name).
 */
export function checkAndRemember(key: string, tool: string): string | undefined {
  const first = seen.get(key);
  if (first) return first;
  seen.set(key, tool);
  return undefined;
}

export function duplicateStub(firstTool: string): string {
  return `(unchanged — already returned by ${firstTool} earlier this session; re-read the file if needed)`;
}

/**
 * Suppression is only valid while the first copy is still in the model's
 * context: clear on session start/switch and after compaction. Safe to call
 * from multiple extensions.
 */
export function registerSeenResultsReset(pi: ExtensionAPI): void {
  pi.on("session_start", async () => seen.clear());
  pi.on("session_compact", async () => seen.clear());
}

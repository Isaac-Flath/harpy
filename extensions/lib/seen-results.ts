/**
 * Session-scoped registry of search-result chunks already returned to the
 * model. kb_search and colgrep share it (all extensions load in one process).
 *
 * Dedupe contract: a chunk returned by any earlier search is never repeated.
 * Instead the agent sees a one-line id-handle pointer, and the duplicate does
 * NOT count toward top-k — callers over-fetch and backfill so every search
 * returns top-k new, unseen chunks.
 *
 * The content hash in the key makes suppression safe: if a file changes
 * between searches, the hash differs and the full content is returned again.
 */
import { createHash } from "crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface SeenEntry {
  /** Session-sequential id, shown to the agent as the pointer handle. */
  id: number;
  /** Tool that first returned the chunk. */
  tool: string;
}

const seen = new Map<string, SeenEntry>(); // key -> first sighting
let nextId = 1;

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
 * Returns the entry recorded when this exact chunk was first returned, or
 * undefined if it is new (and records it under the given tool name).
 */
export function checkAndRemember(key: string, tool: string): SeenEntry | undefined {
  const first = seen.get(key);
  if (first) return first;
  seen.set(key, { id: nextId++, tool });
  return undefined;
}

/** One-line pointer shown to the agent instead of a duplicated chunk. */
export function seenPointer(entry: SeenEntry, location: string): string {
  return `[seen #${entry.id}] ${location} — unchanged, already returned by ${entry.tool} this session; re-read the file if needed`;
}

/**
 * Suppression is only valid while the first copy is still in the model's
 * context: clear on session start/switch and after compaction. Safe to call
 * from multiple extensions.
 */
export function registerSeenResultsReset(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    seen.clear();
    nextId = 1;
  });
  pi.on("session_compact", async () => {
    seen.clear();
    nextId = 1;
  });
}

import { createWriteToolDefinition, defineTool, generateDiffString } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { MAX_FILE_BYTES, MAX_DIFF_BYTES, MAX_DIFF_LINES, previewLimit } from "./diff-model.js";

export interface WritePreview {
  diff?: string;
  created?: boolean;
  note?: string;
}

export type Snapshot = { content: string; created: boolean } | { skipped: string };

/** Bounded, asynchronous and best-effort. O_NONBLOCK prevents opening a FIFO
 * from hanging before fstat can reject it. Never treat unreadable as empty. */
export async function readSnapshot(absolutePath: string): Promise<Snapshot> {
  let file;
  try {
    file = await open(absolutePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) return { skipped: "not a regular file" };
    if (stat.size > MAX_FILE_BYTES) return { skipped: "original over 64 KiB" };
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) return { skipped: "original over 64 KiB" };
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
    if (content.includes("\0")) return { skipped: "original is binary" };
    const limit = previewLimit(content);
    return limit ? { skipped: `original ${limit}` } : { content, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", created: true };
    return { skipped: "original unavailable or not UTF-8" };
  } finally {
    await file?.close().catch(() => {});
  }
}

export function buildWritePreview(snapshot: Snapshot, content: string): WritePreview {
  if ("skipped" in snapshot) return { note: `Diff preview omitted: ${snapshot.skipped}` };
  const inputLimit = previewLimit(snapshot.content) ?? previewLimit(content);
  if (inputLimit) return { created: snapshot.created, note: `Diff preview omitted: ${inputLimit}` };
  try {
    // Pi owns the display-diff format. Inputs are bounded before this call.
    const { diff } = generateDiffString(snapshot.content, content);
    const limit = previewLimit(diff, MAX_DIFF_BYTES, MAX_DIFF_LINES);
    const newlineChanged = snapshot.content.length > 0 && content.length > 0 &&
      snapshot.content.endsWith("\n") !== content.endsWith("\n");
    return {
      created: snapshot.created,
      diff: limit ? undefined : diff,
      note: limit ? `Diff preview omitted: ${limit}` : newlineChanged ? "Final newline changed" : undefined,
    };
  } catch {
    return { created: snapshot.created, note: "Diff preview unavailable" };
  }
}

/** Only write needs execution instrumentation. Pi still owns path expansion,
 * validation, abort handling, mkdir and the shared file-mutation queue.
 * Each execution has its own capture; no cross-call maps or event hooks. */
export function createPreviewWriteTool(cwd: string, capture = readSnapshot) {
  const { renderCall: _call, renderResult: _result, ...builtin } = createWriteToolDefinition(cwd);
  return defineTool<typeof builtin.parameters, { harpyDiff: WritePreview }>({
    ...builtin,
    async execute(id, input, signal, _onUpdate, ctx) {
      let snapshot: Snapshot = { skipped: "original unavailable" };
      const local = createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
          // Called by Pi with its resolved path, inside its mutation queue.
          writeFile: async (absolutePath, content) => {
            const limit = previewLimit(content);
            try {
              snapshot = limit ? { skipped: `new content ${limit}` } : await capture(absolutePath);
            } catch {
              snapshot = { skipped: "original unavailable" };
            }
            signal?.throwIfAborted();
            await writeFile(absolutePath, content, "utf8");
          },
        },
      });
      const result = await local.execute(id, input, signal, undefined, ctx);
      return { ...result, details: { harpyDiff: buildWritePreview(snapshot, input.content) } };
    },
  });
}

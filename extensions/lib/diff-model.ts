import { diffWordsWithSpace } from "diff";

export type DiffLayout = "auto" | "unified" | "split";
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FILE_LINES = 1000;
export const MAX_DIFF_BYTES = 2 * MAX_FILE_BYTES + 32 * MAX_FILE_LINES;
export const MAX_DIFF_LINES = 2 * MAX_FILE_LINES + 100;
export const MAX_WORD_CHARS = 2000;

export interface DiffLine {
  kind: "added" | "removed" | "context" | "gap";
  oldNumber?: number;
  newNumber?: number;
  text: string;
}

export interface DiffRow {
  left?: DiffLine;
  right?: DiffLine;
}

export interface WordSegment {
  text: string;
  changed: boolean;
}

export function parseLayout(value: unknown): DiffLayout | undefined {
  return value === "auto" || value === "unified" || value === "split" ? value : undefined;
}

export function countLines(text: string): number {
  return text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
}

export function previewLimit(text: string, bytes = MAX_FILE_BYTES, lines = MAX_FILE_LINES): string | undefined {
  // Avoid allocating a UTF-8 buffer or splitting an arbitrarily large string.
  if (text.length > bytes || Buffer.byteLength(text, "utf8") > bytes) return `over ${bytes / 1024} KiB`;
  if (countLines(text) > lines) return `over ${lines} lines`;
  return undefined;
}

/** Pi's display diff numbers context in old-file coordinates. All changes are
 * included, so their cumulative delta gives the corresponding new-file number. */
export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let delta = 0;
  for (const raw of diff.split("\n")) {
    const match = /^([ +\-])( *\d*) (.*)$/s.exec(raw);
    if (!match) continue;
    const [, sign, number, text] = match;
    if (sign === " " && !number.trim() && text.trim() === "...") {
      lines.push({ kind: "gap", text: "..." });
      continue;
    }
    if (!number.trim()) continue;
    const n = Number(number);
    if (sign === "+") {
      lines.push({ kind: "added", newNumber: n, text });
      delta++;
    } else if (sign === "-") {
      lines.push({ kind: "removed", oldNumber: n, text });
      delta--;
    } else {
      lines.push({ kind: "context", oldNumber: n, newNumber: n + delta, text });
    }
  }
  return lines;
}

export function pairLines(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === "context" || lines[i].kind === "gap") {
      rows.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[i]?.kind === "removed") removed.push(lines[i++]);
    while (lines[i]?.kind === "added") added.push(lines[i++]);
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      rows.push({ left: removed[j], right: added[j] });
    }
  }
  return rows;
}

/** Always reconstruct the exact original strings, including whitespace. Bound
 * expensive comparisons; whole-line highlighting is the safe fallback. */
export function wordSegments(oldText: string, newText: string): [WordSegment[], WordSegment[]] {
  const fallback: [WordSegment[], WordSegment[]] = [
    [{ text: oldText, changed: true }], [{ text: newText, changed: true }],
  ];
  if (oldText.length + newText.length > MAX_WORD_CHARS) return fallback;
  const parts = diffWordsWithSpace(oldText, newText, { timeout: 5, maxEditLength: 200 });
  if (!parts) return fallback;
  const old: WordSegment[] = [];
  const next: WordSegment[] = [];
  for (const part of parts) {
    if (!part.added) old.push({ text: part.value, changed: Boolean(part.removed) });
    if (!part.removed) next.push({ text: part.value, changed: Boolean(part.added) });
  }
  return [old, next];
}

/** Source text must not act as terminal control sequences. Make tabs and CRs
 * explicit so a tab/space or line-ending change cannot look identical. */
export function displayText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    if (char === "\t") return "→  ";
    if (char === "\r") return "␍";
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

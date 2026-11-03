import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { displayText, pairLines, parseDiff, wordSegments, type DiffLayout, type DiffLine, type DiffRow, type WordSegment } from "./diff-model.js";

const COLLAPSED_ROWS = 20;
const EXPANDED_ROWS = 2000;
const MAX_LINE_CHARS = 4000;

export interface DiffView {
  diff: string;
  filePath: string;
  action: "created" | "modified" | "unchanged" | "written";
  note?: string;
  markdown: boolean;
}

function lineStyle(theme: Theme, kind: DiffLine["kind"]) {
  const fg = kind === "added" ? "toolDiffAdded" : kind === "removed" ? "toolDiffRemoved" : "toolDiffContext";
  // Do not invent a background when the theme requests the terminal default.
  const tinted = (kind === "added" || kind === "removed") && theme.getBgAnsi("toolSuccessBg") !== "";
  return {
    fg,
    bg: tinted ? mixColors(theme.colors.toolSuccessBg, theme.colors[fg], 0.12) : undefined,
    wordBg: tinted ? mixColors(theme.colors.toolSuccessBg, theme.colors[fg], 0.28) : undefined,
  } as const;
}

function renderLine(
  line: DiffLine | undefined, side: "left" | "right", segments: WordSegment[] | undefined,
  theme: Theme, width: number, digits: number,
): string[] {
  if (!line) return [" ".repeat(width)];
  if (line.kind === "gap") return [theme.fg("dim", "…") + " ".repeat(Math.max(0, width - 1))];
  const style = lineStyle(theme, line.kind);
  const number = side === "left" ? line.oldNumber : line.newNumber ?? line.oldNumber;
  const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
  const gutter = `${sign}${String(number ?? "").padStart(digits)} `;
  const contentWidth = Math.max(1, width - gutter.length);
  let remaining = MAX_LINE_CHARS;
  let content = "";
  for (const segment of segments ?? [{ text: line.text, changed: false }]) {
    if (remaining <= 0) break;
    const text = segment.text.slice(0, remaining);
    remaining -= text.length;
    content += theme.style(displayText(text), {
      fg: style.fg,
      bg: segment.changed ? style.wordBg : style.bg,
      inverse: segment.changed && !style.wordBg,
    });
  }
  if (line.text.length > MAX_LINE_CHARS) content += theme.fg("warning", " … [line truncated]");
  const chunks = wrapTextWithAnsi(content, contentWidth);
  if (!chunks.length) chunks.push("");
  return chunks.map((chunk, index) => {
    const prefix = theme.style(index === 0 ? gutter : " ".repeat(gutter.length), { fg: style.fg, bg: style.bg });
    const text = truncateToWidth(prefix + chunk, width);
    return text + theme.style(" ".repeat(Math.max(0, width - visibleWidth(text))), { bg: style.bg });
  });
}

/** Lazy row rendering means a collapsed Markdown preview never computes the
 * word diffs or wrapping for thousands of invisible rows. */
function* renderRows(rows: DiffRow[], theme: Theme, width: number, split: boolean, digits: number): Generator<string> {
  const panelWidth = Math.floor((width - 3) / 2);
  const gutter = theme.fg("dim", " │ ");
  for (const row of rows) {
    const changed = row.left?.kind === "removed" || row.right?.kind === "added";
    const [old, next] = row.left && row.right && changed
      ? wordSegments(row.left.text, row.right.text)
      : [undefined, undefined];
    if (split) {
      const left = renderLine(row.left, "left", old, theme, panelWidth, digits);
      const right = renderLine(row.right, "right", next, theme, panelWidth, digits);
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        yield (left[i] ?? " ".repeat(panelWidth)) + gutter + (right[i] ?? " ".repeat(panelWidth));
      }
    } else if (!changed) {
      yield* renderLine(row.right ?? row.left, "right", undefined, theme, width, digits);
    } else {
      if (row.left) yield* renderLine(row.left, "left", old, theme, width, digits);
      if (row.right) yield* renderLine(row.right, "right", next, theme, width, digits);
    }
  }
}

export class DiffComponent implements Component {
  private view: DiffView;
  private theme: Theme;
  private expanded: boolean;
  private layout: DiffLayout;
  private expandKey: string;
  private lines: DiffLine[];
  private rows: DiffRow[];
  private cached?: { width: number; lines: string[] };

  constructor(view: DiffView, theme: Theme, expanded: boolean, layout: DiffLayout, expandKey: string) {
    this.view = view;
    this.theme = theme;
    this.expanded = expanded;
    this.layout = layout;
    this.expandKey = expandKey;
    this.lines = parseDiff(view.diff);
    this.rows = pairLines(this.lines);
  }

  update(view: DiffView, theme: Theme, expanded: boolean, layout: DiffLayout, expandKey: string): void {
    if (this.view.diff !== view.diff) {
      this.lines = parseDiff(view.diff);
      this.rows = pairLines(this.lines);
    }
    this.view = view;
    this.theme = theme;
    this.expanded = expanded;
    this.layout = layout;
    this.expandKey = expandKey;
    this.invalidate();
  }

  invalidate(): void { this.cached = undefined; }

  render(width: number): string[] {
    if (width < 1) return [];
    if (this.cached?.width === width) return this.cached.lines;
    const theme = this.theme;
    const additions = this.lines.filter((line) => line.kind === "added").length;
    const removals = this.lines.filter((line) => line.kind === "removed").length;
    let summary = theme.fg("success", `${this.view.action} ${displayText(this.view.filePath)}`);
    if (this.lines.length) summary += ` · ${theme.fg("toolDiffAdded", `+${additions}`)} ${theme.fg("toolDiffRemoved", `−${removals}`)}`;
    const result = [summary];
    if (this.view.note) result.push(theme.fg("warning", this.view.note));
    const hint = this.expandKey ? `${this.expandKey} to expand` : "Expand tool output to see the diff";
    if (!this.expanded && !this.view.markdown) {
      if (this.rows.length) result.push(theme.fg("dim", hint));
    } else {
      // Even a forced split must leave room for two useful panels.
      const split = this.layout !== "unified" && width >= (this.layout === "split" ? 60 : 140);
      const digits = String(Math.max(1, ...this.lines.flatMap((line) => [line.oldNumber ?? 0, line.newNumber ?? 0]))).length;
      const budget = this.expanded ? EXPANDED_ROWS : COLLAPSED_ROWS;
      let count = 0;
      for (const line of renderRows(this.rows, theme, width, split, digits)) {
        if (count++ >= budget) {
          result.push(theme.fg("dim", this.expanded ? "… preview row limit reached" : `… more diff lines (${hint})`));
          break;
        }
        result.push(line);
      }
    }
    const lines = result.map((line) => truncateToWidth(line, width));
    this.cached = { width, lines };
    return lines;
  }
}

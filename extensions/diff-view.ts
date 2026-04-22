import {
  createEditToolDefinition,
  createWriteToolDefinition,
  formatSize,
  isWriteToolResult,
  isToolCallEventType,
  type ExtensionAPI,
  type AgentToolResult,
  type ToolRenderResultOptions,
  type EditToolDetails,
  type WriteToolInput,
} from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import * as Diff from "diff";
import { existsSync, readFileSync } from "fs";
import * as path from "path";

// =============================================================================
// Constants -- all tunables in one place
// =============================================================================

const SPLIT_MIN_WIDTH = 140;
const COLLAPSED_MAX_LINES = 20;
const LINE_BG_MIX = 0.12;
const WORD_BG_MIX = 0.28;
const TAB_REPLACEMENT = "   ";
const CONTEXT_LINES = 4;
const RST = "\x1b[0m";
const BG_RST = "\x1b[49m";

// =============================================================================
// Types
// =============================================================================

interface ParsedLine {
  type: "added" | "removed" | "context" | "ellipsis";
  lineNum: string;
  content: string;
}

interface ChangePair {
  removed: ParsedLine | null;
  added: ParsedLine | null;
}

interface DiffHunk {
  type: "context" | "change" | "ellipsis";
  lines?: ParsedLine[];
  pairs?: ChangePair[];
}

interface WordSegment {
  text: string;
  changed: boolean;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface DiffPalette {
  addedBg: string;
  removedBg: string;
  ctxBg: string;
  addedWordBg: string;
  removedWordBg: string;
}

interface WriteDiffDetails {
  diff: string;
  created?: boolean;
}

interface LineRange {
  start: number;
  end: number;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".ex",
  ".exs",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const RANGE_SUMMARY_LIMIT = 6;

// =============================================================================
// ANSI color utilities
// =============================================================================

function parseAnsiRgb(ansi: string): RGB | null {
  const match = ansi.match(/\x1b\[\d+;2;(\d+);(\d+);(\d+)m/);
  if (!match) return null;
  return { r: +match[1], g: +match[2], b: +match[3] };
}

function mixRgb(base: RGB, tint: RGB, alpha: number): RGB {
  return {
    r: Math.round(base.r * (1 - alpha) + tint.r * alpha),
    g: Math.round(base.g * (1 - alpha) + tint.g * alpha),
    b: Math.round(base.b * (1 - alpha) + tint.b * alpha),
  };
}

function rgbToBgAnsi(rgb: RGB): string {
  return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function derivePalette(theme: Theme): DiffPalette {
  const baseBg = parseAnsiRgb(theme.getBgAnsi("toolSuccessBg"));
  const addFg = parseAnsiRgb(theme.getFgAnsi("toolDiffAdded"));
  const delFg = parseAnsiRgb(theme.getFgAnsi("toolDiffRemoved"));

  // Fallback base if ANSI parsing fails (light gray)
  const base = baseBg ?? { r: 234, g: 235, b: 232 };
  const addTint = addFg ?? { r: 42, g: 110, b: 5 };
  const delTint = delFg ?? { r: 168, g: 37, b: 37 };

  return {
    addedBg: rgbToBgAnsi(mixRgb(base, addTint, LINE_BG_MIX)),
    removedBg: rgbToBgAnsi(mixRgb(base, delTint, LINE_BG_MIX)),
    ctxBg: rgbToBgAnsi(base),
    addedWordBg: rgbToBgAnsi(mixRgb(base, addTint, WORD_BG_MIX)),
    removedWordBg: rgbToBgAnsi(mixRgb(base, delTint, WORD_BG_MIX)),
  };
}

// =============================================================================
// Diff parsing
// =============================================================================

const DIFF_LINE_RE = /^([+-\s])(\s*\d*)\s(.*)$/;

function replaceTabs(text: string): string {
  return text.replace(/\t/g, TAB_REPLACEMENT);
}

function parseDiffText(diffText: string): ParsedLine[] {
  const result: ParsedLine[] = [];
  for (const line of diffText.split("\n")) {
    const match = line.match(DIFF_LINE_RE);
    if (!match) continue;
    const [, prefix, lineNum, content] = match;
    const cleaned = replaceTabs(content);
    if (cleaned.trim() === "...") {
      result.push({ type: "ellipsis", lineNum, content: cleaned });
    } else if (prefix === "+") {
      result.push({ type: "added", lineNum, content: cleaned });
    } else if (prefix === "-") {
      result.push({ type: "removed", lineNum, content: cleaned });
    } else {
      result.push({ type: "context", lineNum, content: cleaned });
    }
  }
  return result;
}

function groupIntoHunks(lines: ParsedLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === "ellipsis") {
      hunks.push({ type: "ellipsis", lines: [line] });
      i++;
      continue;
    }

    if (line.type === "context") {
      const ctxLines: ParsedLine[] = [];
      while (i < lines.length && lines[i].type === "context") {
        ctxLines.push(lines[i]);
        i++;
      }
      hunks.push({ type: "context", lines: ctxLines });
      continue;
    }

    const removed: ParsedLine[] = [];
    const added: ParsedLine[] = [];

    while (i < lines.length && lines[i].type === "removed") {
      removed.push(lines[i]);
      i++;
    }
    while (i < lines.length && lines[i].type === "added") {
      added.push(lines[i]);
      i++;
    }

    const pairCount = Math.max(removed.length, added.length);
    const pairs: ChangePair[] = [];
    for (let j = 0; j < pairCount; j++) {
      pairs.push({
        removed: j < removed.length ? removed[j] : null,
        added: j < added.length ? added[j] : null,
      });
    }
    hunks.push({ type: "change", pairs });
  }

  return hunks;
}

function getToolPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const candidate = (args as { path?: unknown }).path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function getFileExtension(filePath: string | undefined): string {
  return filePath ? path.extname(filePath).toLowerCase() : "";
}

function isMarkdownPath(filePath: string | undefined): boolean {
  return MARKDOWN_EXTENSIONS.has(getFileExtension(filePath));
}

function isCodePath(filePath: string | undefined): boolean {
  return CODE_EXTENSIONS.has(getFileExtension(filePath));
}

function parseLineNumber(lineNum: string): number | null {
  const parsed = Number.parseInt(lineNum.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectChangedRanges(diffText: string): LineRange[] {
  const changed = parseDiffText(diffText)
    .filter((line) => line.type === "added" || line.type === "removed")
    .map((line) => parseLineNumber(line.lineNum))
    .filter((line): line is number => line !== null)
    .sort((a, b) => a - b);

  if (changed.length === 0) {
    return [];
  }

  const unique = [...new Set(changed)];
  const ranges: LineRange[] = [];
  let start = unique[0]!;
  let end = unique[0]!;

  for (let i = 1; i < unique.length; i++) {
    const line = unique[i]!;
    if (line === end + 1) {
      end = line;
      continue;
    }
    ranges.push({ start, end });
    start = line;
    end = line;
  }

  ranges.push({ start, end });
  return ranges;
}

function formatChangedRanges(ranges: LineRange[]): string | null {
  if (ranges.length === 0) return null;

  const shown = ranges.slice(0, RANGE_SUMMARY_LIMIT).map((range) =>
    range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`
  );

  if (ranges.length > RANGE_SUMMARY_LIMIT) {
    shown.push(`+${ranges.length - RANGE_SUMMARY_LIMIT} more`);
  }

  return shown.join(", ");
}

function buildDiffSummary(
  filePath: string | undefined,
  diffText: string,
  created: boolean,
  theme: Theme
): string {
  const action = created ? "created" : "modified";
  const headline = `${action} ${filePath ?? "file"}`;
  const ranges = formatChangedRanges(collectChangedRanges(diffText));

  if (!ranges) {
    return theme.fg("success", headline);
  }

  return [
    theme.fg("success", headline),
    theme.fg("muted", `lines changed: ${ranges}`),
  ].join("\n");
}

function formatWriteCallSummary(args: WriteToolInput, theme: Theme): string {
  const filePath = args.path || "...";
  const content = args.content ?? "";
  const lineCount = content.length === 0 ? 0 : content.split("\n").length;
  const lineLabel = lineCount === 1 ? "line" : "lines";
  const size = formatSize(Buffer.byteLength(content, "utf-8"));

  return `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", filePath)}${theme.fg("dim", ` (${lineCount} ${lineLabel}, ${size})`)}`;
}

// =============================================================================
// Word-level diff
// =============================================================================

function computeWordDiff(
  oldContent: string,
  newContent: string
): { oldSegs: WordSegment[]; newSegs: WordSegment[] } {
  const parts = Diff.diffWords(oldContent, newContent);
  const oldSegs: WordSegment[] = [];
  const newSegs: WordSegment[] = [];

  for (const part of parts) {
    if (part.removed) {
      oldSegs.push({ text: part.value, changed: true });
    } else if (part.added) {
      newSegs.push({ text: part.value, changed: true });
    } else {
      oldSegs.push({ text: part.value, changed: false });
      newSegs.push({ text: part.value, changed: false });
    }
  }

  return { oldSegs, newSegs };
}

function computePairWordDiff(
  pair: ChangePair
): { removedSegs: WordSegment[] | null; addedSegs: WordSegment[] | null } {
  if (pair.removed && pair.added) {
    const wd = computeWordDiff(pair.removed.content, pair.added.content);
    return { removedSegs: wd.oldSegs, addedSegs: wd.newSegs };
  }
  return { removedSegs: null, addedSegs: null };
}

function renderWordSegments(
  segs: WordSegment[],
  lineBg: string,
  wordBg: string
): string {
  let result = "";
  for (const seg of segs) {
    if (seg.changed) {
      result += wordBg + seg.text + BG_RST + lineBg;
    } else {
      result += seg.text;
    }
  }
  return result;
}

// =============================================================================
// Line rendering
// =============================================================================

function preserveBackground(text: string, bgAnsi: string): string {
  return text
    .replaceAll(BG_RST, BG_RST + bgAnsi)
    .replaceAll(RST, RST + bgAnsi);
}

function padLine(
  text: string,
  width: number,
  bgAnsi: string,
  fillToWidth = true
): string {
  const fitted =
    visibleWidth(text) > width ? truncateToWidth(text, width) : text;
  const vis = visibleWidth(fitted);
  const pad = Math.max(0, width - vis);

  if (!bgAnsi) {
    return fitted + " ".repeat(pad);
  }

  const styled = bgAnsi + preserveBackground(fitted, bgAnsi);
  if (fillToWidth) {
    return styled + " ".repeat(pad) + RST;
  }
  return styled + RST + " ".repeat(pad);
}

function lineColors(
  line: ParsedLine,
  palette: DiffPalette
): { fgColor: string; lineBg: string; wordBg: string } {
  if (line.type === "added") {
    return {
      fgColor: "toolDiffAdded",
      lineBg: palette.addedBg,
      wordBg: palette.addedWordBg,
    };
  }
  if (line.type === "removed") {
    return {
      fgColor: "toolDiffRemoved",
      lineBg: palette.removedBg,
      wordBg: palette.removedWordBg,
    };
  }
  return {
    fgColor: "toolDiffContext",
    lineBg: palette.ctxBg,
    wordBg: "",
  };
}

// Render a single diff line (used by both unified and split views).
// bgOverride/wordBgOverride let the split view supply custom colors.
// fillToWidth controls whether the line background extends through trailing pad.
function renderDiffLine(
  line: ParsedLine | null,
  wordSegs: WordSegment[] | null,
  palette: DiffPalette,
  theme: Theme,
  width: number,
  bgOverride?: string,
  wordBgOverride?: string,
  fillToWidth = true
): string[] {
  if (!line) {
    return [padLine("", width, bgOverride ?? "", fillToWidth)];
  }

  const sign =
    line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  const { fgColor, lineBg, wordBg } = lineColors(line, palette);
  const bg = bgOverride ?? lineBg;
  const wBg = wordBgOverride ?? wordBg;

  const gutter = `${sign}${line.lineNum} `;
  const gutterWidth = gutter.length;
  const contentWidth = Math.max(1, width - gutterWidth);

  let styledContent: string;
  if (wordSegs) {
    styledContent = renderWordSegments(wordSegs, bg, wBg);
  } else {
    styledContent = line.content;
  }

  const wrappedChunks = wrapTextWithAnsi(styledContent, contentWidth);
  if (wrappedChunks.length === 0) wrappedChunks.push("");

  const indent = " ".repeat(gutterWidth);
  const result: string[] = [];
  for (let i = 0; i < wrappedChunks.length; i++) {
    const prefix = i === 0 ? gutter : indent;
    const raw = prefix + wrappedChunks[i];
    const colored = theme.fg(fgColor as any, raw);
    result.push(padLine(colored, width, bg, fillToWidth));
  }
  return result;
}

// =============================================================================
// Unified view
// =============================================================================

function renderUnified(
  hunks: DiffHunk[],
  palette: DiffPalette,
  theme: Theme,
  width: number
): string[] {
  const result: string[] = [];

  for (const hunk of hunks) {
    if (hunk.type === "ellipsis" || hunk.type === "context") {
      for (const line of hunk.lines!) {
        result.push(...renderDiffLine(line, null, palette, theme, width));
      }
    } else {
      for (const pair of hunk.pairs!) {
        const { removedSegs, addedSegs } = computePairWordDiff(pair);

        if (pair.removed) {
          result.push(
            ...renderDiffLine(pair.removed, removedSegs, palette, theme, width)
          );
        }
        if (pair.added) {
          result.push(
            ...renderDiffLine(pair.added, addedSegs, palette, theme, width)
          );
        }
      }
    }
  }

  return result;
}

// =============================================================================
// Split (side-by-side) view
// =============================================================================

const GUTTER = " \u2502 "; // " │ "
const GUTTER_WIDTH = 3;

function joinPanels(
  leftLines: string[],
  rightLines: string[],
  gutter: string,
  panelWidth: number
): string[] {
  const maxRows = Math.max(leftLines.length, rightLines.length);
  const blank = " ".repeat(panelWidth);
  const rows: string[] = [];
  for (let i = 0; i < maxRows; i++) {
    const left = i < leftLines.length ? leftLines[i] : blank;
    const right = i < rightLines.length ? rightLines[i] : blank;
    rows.push(left + gutter + right);
  }
  return rows;
}

function renderSplit(
  hunks: DiffHunk[],
  palette: DiffPalette,
  theme: Theme,
  width: number
): string[] {
  const panelWidth = Math.floor((width - GUTTER_WIDTH) / 2);
  const gutter = theme.fg("dim" as any, GUTTER);
  const result: string[] = [];

  for (const hunk of hunks) {
    if (hunk.type === "ellipsis" || hunk.type === "context") {
      for (const line of hunk.lines!) {
        const leftLines = renderDiffLine(
          line, null, palette, theme, panelWidth, "", "", false
        );
        const rightLines = renderDiffLine(
          line, null, palette, theme, panelWidth, "", "", false
        );
        result.push(
          ...joinPanels(leftLines, rightLines, gutter, panelWidth)
        );
      }
    } else {
      for (const pair of hunk.pairs!) {
        const { removedSegs, addedSegs } = computePairWordDiff(pair);

        const leftBg = pair.removed ? palette.removedBg : "";
        const rightBg = pair.added ? palette.addedBg : "";

        const leftLines = renderDiffLine(
          pair.removed, removedSegs,
          palette, theme, panelWidth,
          leftBg, palette.removedWordBg, false
        );
        const rightLines = renderDiffLine(
          pair.added, addedSegs,
          palette, theme, panelWidth,
          rightBg, palette.addedWordBg, false
        );

        result.push(
          ...joinPanels(leftLines, rightLines, gutter, panelWidth)
        );
      }
    }
  }

  return result;
}

// =============================================================================
// Write tool diff generation
// =============================================================================

function generateWriteDiff(oldContent: string, newContent: string): string {
  const parts = Diff.diffLines(oldContent, newContent);
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const numWidth = String(maxLineNum).length;
  const output: string[] = [];

  let oldLine = 1;
  let newLine = 1;
  let lastWasChange = false;

  function pushContext(line: string): void {
    output.push(` ${String(oldLine).padStart(numWidth)} ${line}`);
    oldLine++;
    newLine++;
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLine).padStart(numWidth)} ${line}`);
          newLine++;
        } else {
          output.push(`-${String(oldLine).padStart(numWidth)} ${line}`);
          oldLine++;
        }
      }
      lastWasChange = true;
    } else {
      const nextIsChange =
        i < parts.length - 1 &&
        (parts[i + 1].added || parts[i + 1].removed);
      const leading = lastWasChange ? CONTEXT_LINES : 0;
      const trailing = nextIsChange ? CONTEXT_LINES : 0;

      if (leading === 0 && trailing === 0) {
        oldLine += raw.length;
        newLine += raw.length;
      } else if (raw.length <= leading + trailing) {
        for (const line of raw) pushContext(line);
      } else {
        for (let j = 0; j < leading; j++) pushContext(raw[j]);
        const skipped = raw.length - leading - trailing;
        output.push(` ${"".padStart(numWidth)} ...`);
        oldLine += skipped;
        newLine += skipped;
        for (let j = raw.length - trailing; j < raw.length; j++) pushContext(raw[j]);
      }

      lastWasChange = false;
    }
  }

  return output.join("\n");
}

// =============================================================================
// DiffComponent
// =============================================================================

class DiffComponent implements Component {
  private hunks: DiffHunk[];
  private palette: DiffPalette;
  private theme: Theme;
  private expanded: boolean;
  private collapsedSummary: string | null;

  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;
  private lastRenderedHeight = 0;

  constructor(
    hunks: DiffHunk[],
    palette: DiffPalette,
    theme: Theme,
    expanded: boolean,
    collapsedSummary: string | null
  ) {
    this.hunks = hunks;
    this.palette = palette;
    this.theme = theme;
    this.expanded = expanded;
    this.collapsedSummary = collapsedSummary;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded !== expanded) {
      this.expanded = expanded;
      this.cachedLines = null;
    }
  }

  invalidate(): void {
    this.cachedLines = null;
    this.cachedWidth = -1;
  }

  private withTrailingClear(lines: string[], width: number): string[] {
    const previousHeight = this.lastRenderedHeight;
    this.lastRenderedHeight = lines.length;

    if (lines.length >= previousHeight) {
      return lines;
    }

    return [
      ...lines,
      ...Array.from({ length: previousHeight - lines.length }, () => " ".repeat(width)),
    ];
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedExpanded === this.expanded
    ) {
      return this.cachedLines;
    }

    // Code file collapsed: show summary instead of diff
    if (!this.expanded && this.collapsedSummary !== null) {
      const lines = this.collapsedSummary.split("\n").map((line) =>
        visibleWidth(line) > width ? truncateToWidth(line, width) : line
      );
      this.cachedLines = lines;
      this.cachedWidth = width;
      this.cachedExpanded = this.expanded;
      return this.withTrailingClear(lines, width);
    }

    const useSplit = width >= SPLIT_MIN_WIDTH;
    let lines: string[];

    if (useSplit) {
      lines = renderSplit(this.hunks, this.palette, this.theme, width);
    } else {
      lines = renderUnified(this.hunks, this.palette, this.theme, width);
    }

    // Truncate when collapsed
    if (!this.expanded && lines.length > COLLAPSED_MAX_LINES) {
      const remaining = lines.length - COLLAPSED_MAX_LINES;
      lines = lines.slice(0, COLLAPSED_MAX_LINES);
      const hint = `  ... ${remaining} more lines (expand to see all)`;
      lines.push(this.theme.fg("muted" as any, hint));
    }

    // Final safety: guarantee every line fits within width
    lines = lines.map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width) : line
    );

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedExpanded = this.expanded;
    return this.withTrailingClear(lines, width);
  }
}

// =============================================================================
// renderResult
// =============================================================================

function writeCallRender(
  args: WriteToolInput,
  theme: Theme,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(formatWriteCallSummary(args, theme));
  return text;
}

function diffRenderResult(
  result: AgentToolResult<EditToolDetails | WriteDiffDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: {
    lastComponent: Component | undefined;
    isError: boolean;
    args?: unknown;
  }
): Component {
  const details = result.details as EditToolDetails | WriteDiffDetails | undefined;
  const diff = details?.diff;
  if (context.isError || !diff) {
    const text =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
    const content = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    text.setText(content);
    return text;
  }

  const filePath = getToolPath(context.args);
  const created = Boolean((details as WriteDiffDetails | undefined)?.created);

  if (context.lastComponent instanceof DiffComponent) {
    context.lastComponent.setExpanded(options.expanded);
    return context.lastComponent;
  }

  const parsed = parseDiffText(diff);
  const hunks = groupIntoHunks(parsed);
  const palette = derivePalette(theme);
  const collapsedSummary =
    isCodePath(filePath) && !isMarkdownPath(filePath)
      ? buildDiffSummary(filePath, diff, created, theme)
      : null;

  return new DiffComponent(hunks, palette, theme, options.expanded, collapsedSummary);
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  const oldContentMap = new Map<string, string | null>();

  pi.on("tool_call", (event, ctx) => {
    if (isToolCallEventType("write", event)) {
      const absPath = path.resolve(ctx.cwd, event.input.path);
      oldContentMap.set(
        event.toolCallId,
        existsSync(absPath) ? readFileSync(absPath, "utf-8") : null
      );
    }
  });

  pi.on("tool_result", (event) => {
    if (isWriteToolResult(event)) {
      const old = oldContentMap.get(event.toolCallId);
      oldContentMap.delete(event.toolCallId);

      if (!event.isError && old !== undefined) {
        const newContent = (event.input as Record<string, unknown>)
          .content as string;
        const diff = generateWriteDiff(old ?? "", newContent);
        return { details: { diff, created: old === null } };
      }
    }
  });

  const builtinEdit = createEditToolDefinition(process.cwd());
  pi.registerTool({
    ...builtinEdit,
    renderResult: diffRenderResult as any,
  });

  const builtinWrite = createWriteToolDefinition(process.cwd());
  pi.registerTool({
    ...builtinWrite,
    renderCall: writeCallRender as any,
    renderResult: diffRenderResult as any,
  });
}

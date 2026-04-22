import {
  createReadToolDefinition,
  type AgentToolResult,
  type ExtensionAPI,
  type ReadToolDetails,
  type ReadToolInput,
  type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";

const SHOWING_LINES_RE = /^\[Showing lines (\d+)-(\d+) of (\d+).+\]$/;
const MORE_LINES_RE = /^\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/;
const OVERSIZE_LINE_RE = /^\[Line (\d+) is .+ exceeds .+ limit.+\]$/;

type SummaryTone = "success" | "warning" | "dim";

interface ReadSummary {
  text: string;
  tone: SummaryTone;
}

interface ReadViewState {
  collapsedSummary?: ReadSummary;
}

function getTextOutput(result: AgentToolResult<ReadToolDetails | undefined>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function renderFallbackText(
  result: AgentToolResult<ReadToolDetails | undefined>,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(getTextOutput(result));
  return text;
}

function getPathText(path: unknown): string {
  return typeof path === "string" && path.length > 0 ? path : "...";
}

function countDisplayedLines(text: string): number {
  const normalized = text.replace(/\r/g, "");
  if (!normalized) return 0;
  const segments = normalized.split("\n");
  return normalized.endsWith("\n") ? Math.max(0, segments.length - 1) : segments.length;
}

function summarizeReadResult(
  args: ReadToolInput,
  result: AgentToolResult<ReadToolDetails | undefined>
): ReadSummary {
  if (result.content.some((c) => c.type === "image")) {
    return { text: "image loaded", tone: "success" };
  }

  const output = getTextOutput(result);
  if (!output.trim()) {
    return { text: "empty file", tone: "dim" };
  }

  const rawLines = output.replace(/\r/g, "").split("\n");
  let lastNonEmpty = rawLines.length - 1;
  while (lastNonEmpty >= 0 && rawLines[lastNonEmpty] === "") {
    lastNonEmpty--;
  }

  const tail = lastNonEmpty >= 0 ? rawLines[lastNonEmpty]!.trim() : "";

  const oversize = tail.match(OVERSIZE_LINE_RE);
  if (oversize) {
    return {
      text: `line ${oversize[1]} exceeds the read size limit`,
      tone: "warning",
    };
  }

  const showing = tail.match(SHOWING_LINES_RE);
  if (showing) {
    return {
      text: `lines ${showing[1]}-${showing[2]} of ${showing[3]}`,
      tone: "success",
    };
  }

  const more = tail.match(MORE_LINES_RE);
  if (more) {
    const remaining = Number(more[1]);
    const nextOffset = Number(more[2]);
    const startLine = args.offset ?? 1;
    const endLine = Math.max(startLine, nextOffset - 1);
    const totalLines = endLine + remaining;
    return {
      text: `lines ${startLine}-${endLine} of ${totalLines}`,
      tone: "success",
    };
  }

  const lineCount = countDisplayedLines(output);
  if (lineCount === 0) {
    return { text: "empty file", tone: "dim" };
  }

  const startLine = args.offset ?? 1;
  const endLine = startLine + lineCount - 1;
  const totalLines = result.details?.truncation?.totalLines;

  if (totalLines && totalLines > endLine) {
    return {
      text: `lines ${startLine}-${endLine} of ${totalLines}`,
      tone: "success",
    };
  }

  return { text: `lines ${startLine}-${endLine}`, tone: "success" };
}

function renderCollapsedCall(
  args: ReadToolInput,
  theme: Theme,
  summary: ReadSummary | undefined
): string {
  const toolName = theme.fg("toolTitle", theme.bold("read"));
  const path = theme.fg("accent", getPathText(args.path));

  if (!summary) {
    return `${toolName} ${path}`;
  }

  return `${toolName} ${path} ${theme.fg(summary.tone, summary.text)}`;
}

export default function (pi: ExtensionAPI) {
  const builtinRead = createReadToolDefinition(process.cwd());

  pi.registerTool({
    ...builtinRead,
    renderCall(
      args: ReadToolInput,
      theme: Theme,
      context: {
        lastComponent: Component | undefined;
        state: ReadViewState;
      }
    ): Component {
      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
      text.setText(renderCollapsedCall(args, theme, context.state.collapsedSummary));
      return text;
    },
    renderResult(
      result: AgentToolResult<ReadToolDetails | undefined>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: {
        lastComponent: Component | undefined;
        isError: boolean;
        args: ReadToolInput;
        state: ReadViewState;
        invalidate: () => void;
      }
    ): Component {
      if (context.isError || options.expanded || options.isPartial) {
        return builtinRead.renderResult
          ? builtinRead.renderResult(result, options, theme, context as any)
          : renderFallbackText(result, context);
      }

      const summary = summarizeReadResult(context.args, result);
      const previous = context.state.collapsedSummary;
      if (!previous || previous.text !== summary.text || previous.tone !== summary.tone) {
        context.state.collapsedSummary = summary;
        context.invalidate();
      }

      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
      text.setText("");
      return text;
    },
  });
}

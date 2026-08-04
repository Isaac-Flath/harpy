/**
 * Compact rendering for the built-in bash tool.
 *
 * Collapsed bash output is noise while the agent works: osascript calls,
 * installs, test runs. This view shrinks each call to a single line —
 * `bash <command> ✓ N lines` — with a one-line live tail while running.
 * Errors and expanded view (ctrl+o) fall through to the full built-in
 * rendering, same pattern as read-view.ts.
 */
import {
  createBashToolDefinition,
  type AgentToolResult,
  type BashToolDetails,
  type BashToolInput,
  type ExtensionAPI,
  type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";
import { summarizeSingleLine } from "./lib/render-text.js";

const COMMAND_MAX = 72;

type SummaryTone = "success" | "warning" | "dim";

interface BashSummary {
  text: string;
  tone: SummaryTone;
}

interface BashViewState {
  collapsedSummary?: BashSummary;
}

function getTextOutput(result: AgentToolResult<BashToolDetails | undefined>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function countLines(output: string): number {
  const trimmed = output.replace(/\r/g, "").replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

function lastNonEmptyLine(output: string): string {
  const lines = output.replace(/\r/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line) return line;
  }
  return "";
}

function summarizeBashResult(
  result: AgentToolResult<BashToolDetails | undefined>
): BashSummary {
  const lineCount = countLines(getTextOutput(result));
  if (lineCount === 0) return { text: "no output", tone: "dim" };

  const truncated = result.details?.truncation?.truncated ? ", truncated" : "";
  return {
    text: `✓ ${lineCount} line${lineCount === 1 ? "" : "s"}${truncated}`,
    tone: "success",
  };
}

function renderCallLine(
  args: Partial<BashToolInput> | undefined,
  theme: Theme,
  summary: BashSummary | undefined
): string {
  const toolName = theme.fg("toolTitle", theme.bold("bash"));
  const command = args?.command
    ? theme.fg("dim", summarizeSingleLine(args.command, COMMAND_MAX))
    : "";
  const status = summary ? ` ${theme.fg(summary.tone, summary.text)}` : "";
  return `${toolName} ${command}${status}`;
}

export default function (pi: ExtensionAPI) {
  const builtinBash = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...builtinBash,
    renderCall(
      args: BashToolInput,
      theme: Theme,
      context: { lastComponent: Component | undefined; state: BashViewState }
    ): Component {
      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
      text.setText(renderCallLine(args, theme, context.state?.collapsedSummary));
      return text;
    },
    renderResult(
      result: AgentToolResult<BashToolDetails | undefined>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: {
        lastComponent: Component | undefined;
        isError: boolean;
        args: BashToolInput;
        state: BashViewState;
        invalidate: () => void;
      }
    ): Component {
      // Failures and expanded view get the full built-in rendering.
      if (context.isError || options.expanded) {
        return builtinBash.renderResult
          ? builtinBash.renderResult(result, options, theme, context as any)
          : (() => {
              const text =
                context.lastComponent instanceof Text
                  ? context.lastComponent
                  : new Text("", 0, 0);
              text.setText(getTextOutput(result));
              return text;
            })();
      }

      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);

      // While running: a one-line live tail instead of a scrolling preview.
      if (options.isPartial) {
        const tail = lastNonEmptyLine(getTextOutput(result));
        text.setText(tail ? theme.fg("dim", `  ${summarizeSingleLine(tail, COMMAND_MAX)}`) : "");
        return text;
      }

      // Complete + collapsed: move the summary up onto the call line.
      const summary = summarizeBashResult(result);
      const previous = context.state.collapsedSummary;
      if (!previous || previous.text !== summary.text || previous.tone !== summary.tone) {
        context.state.collapsedSummary = summary;
        context.invalidate();
      }
      text.setText("");
      return text;
    },
  });
}

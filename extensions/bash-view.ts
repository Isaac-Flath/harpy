/** Compact bash display only; the active tool still owns execution and output. */
import type { BashToolDetails, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { RendererDelegate, textOutput, type RenderContext, type Summary } from "./lib/compact-render.js";
import { summarizeSingleLine } from "./lib/render-text.js";

interface BashViewState {
  call: Text;
  result: Text;
  delegate: RendererDelegate;
  summary?: Summary;
}

function stateFor(context: RenderContext): BashViewState {
  return context.state.harpyBashView ??= {
    call: new Text("", 0, 0), result: new Text("", 0, 0), delegate: new RendererDelegate(),
  };
}

function header(args: unknown, theme: Theme, summary?: Summary): string {
  const input = args && typeof args === "object" ? args as { command?: unknown } : {};
  const command = typeof input.command === "string" ? summarizeSingleLine(input.command, 72) : "...";
  return `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("dim", command)}` +
    (summary ? ` ${theme.fg(summary.tone, summary.text)}` : "");
}

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((name, next) => {
    const base = next();
    if (name !== "bash") return base;
    return {
      ...base,
      renderCall(args, theme, context) {
        const state = stateFor(context);
        if (context.expanded || context.isError) {
          return state.delegate.call(base, args, theme, context, header(args, theme));
        }
        state.call.setText(header(args, theme, context.isPartial ? undefined : state.summary));
        return state.call;
      },
      renderResult(result, options, theme, context) {
        const state = stateFor(context);
        const output = textOutput(result).replace(/\r/g, "");
        const trimmed = output.replace(/\n+$/, "");
        const lines = trimmed ? trimmed.split("\n").length : 0;
        const truncated = (result.details as BashToolDetails | undefined)?.truncation?.truncated;
        state.summary = context.isError || options.isPartial ? undefined : {
          text: `${lines ? `✓ ${lines} line${lines === 1 ? "" : "s"}` : "no output"}${truncated ? ", truncated" : ""}`,
          tone: truncated ? "warning" : lines ? "success" : "dim",
        };
        // Update the already-mounted header without recursively invalidating the row.
        state.call.setText(header(context.args, theme, state.summary));
        if (context.isError || options.expanded) return state.delegate.result(base, result, theme, context);
        // If expanded while streaming, the native renderer may have started a
        // timer. Keep it informed (especially of final results) after collapse.
        if (state.delegate.used) state.delegate.result(base, result, theme, context);
        const tail = output.trimEnd().split("\n").pop()?.trim();
        state.result.setText(options.isPartial && tail ? theme.fg("dim", `  ${summarizeSingleLine(tail, 72)}`) : "");
        return state.result;
      },
    };
  });
}

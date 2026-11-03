import type { AgentToolResult, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

export type RenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];
export interface Summary { text: string; tone: "success" | "warning" | "dim" }

export function textOutput(result: AgentToolResult<unknown>): string {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

/** Native renderers may return Containers, not Text, and share call/result
 * state. Keep both slots separate from our compact components when toggling. */
export class RendererDelegate {
  private state: Record<string, unknown> = {};
  private callComponent?: Component;
  private resultComponent?: Component;
  used = false;

  call(base: ToolRenderers | undefined, args: unknown, theme: Theme, context: RenderContext, fallback: string): Component {
    this.used = true;
    this.callComponent = base?.renderCall?.(args, theme, {
      ...context, state: this.state, lastComponent: this.callComponent,
    }) ?? new Text(fallback, 0, 0);
    return this.callComponent;
  }

  result(base: ToolRenderers | undefined, result: AgentToolResult<unknown>, theme: Theme, context: RenderContext): Component {
    this.resultComponent = base?.renderResult?.(result, {
      expanded: context.expanded, isPartial: context.isPartial,
    }, theme, { ...context, state: this.state, lastComponent: this.resultComponent }) ??
      new Text(context.isError ? theme.fg("error", textOutput(result)) : textOutput(result), 0, 0);
    return this.resultComponent;
  }
}

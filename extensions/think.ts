import { Type, type Static } from "@sinclair/typebox";
import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const thinkSchema = Type.Object({
  thought: Type.String({
    description: "Your reasoning — what you're considering, planning, or reassessing.",
  }),
});

type ThinkInput = Static<typeof thinkSchema>;

interface ThinkDetails {
  thought: string;
}

function summarizeThought(thought: string, maxLength = 80): string {
  const singleLine = thought.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function renderThinkResult(
  result: AgentToolResult<ThinkDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { lastComponent: Text | undefined; isError: boolean }
): Text {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);

  if (context.isError) {
    const content = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    text.setText(theme.fg("error", content || "Thinking failed"));
    return text;
  }

  const thought = result.details?.thought ?? "";
  const summary = summarizeThought(thought || "No thought recorded");

  if (!options.expanded) {
    text.setText(
      `${theme.fg("toolTitle", theme.bold("Thinking: "))}${theme.fg("dim", summary)}`
    );
    return text;
  }

  const lines = thought.split("\n");
  const rendered = [
    `${theme.fg("toolTitle", theme.bold("Thinking"))}`,
    ...lines.map((line) => theme.fg("dim", line || " ")),
  ].join("\n");

  text.setText(rendered);
  return text;
}

const thinkTool = defineTool({
  name: "think",
  label: "think",
  description:
    "Pause to think through your approach before acting. Use this to plan multi-step work, reason about edge cases, or reassess after unexpected results.",
  promptSnippet: "Think step-by-step before complex actions",
  promptGuidelines: [
    "Use this before starting multi-step work to plan your approach.",
    "Use this after an error or unexpected result to reassess before retrying.",
    "Use this when choosing between multiple approaches or reasoning about tradeoffs.",
    "Do not use this for trivial one-step actions where immediate execution is clearer.",
  ],
  parameters: thinkSchema,
  renderResult: renderThinkResult as any,

  async execute(
    _toolCallId: string,
    params: ThinkInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<ThinkDetails> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<ThinkDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    return {
      content: [{ type: "text", text: params.thought }],
      details: { thought: params.thought },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(thinkTool);
}

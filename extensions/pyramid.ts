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
import { summarizeSingleLine } from "./lib/render-text.js";

// =============================================================================
// Schema
//
// Minto pyramid: a governing thought supported by 2-4 points, each of which
// may carry its own supports. The levels are unrolled (instead of a recursive
// schema) so depth is capped at 3 by construction and the JSON schema contains
// no recursive $refs, which some providers reject.
// =============================================================================

const POINT_MAX = 200;

const pointField = (role: string) =>
  Type.String({
    maxLength: POINT_MAX,
    description: `${role} Written as a conclusion, not a topic label — "Use X because Y", never "Options".  One line.`,
  });

const level3 = Type.Object({
  point: pointField("A supporting fact, example, or detail."),
});

const level2 = Type.Object({
  point: pointField("A supporting point."),
  supports: Type.Optional(
    Type.Array(level3, {
      maxItems: 4,
      description: "Facts or examples that jointly establish this point. Aim for 2-4, no overlap.",
    })
  ),
});

const level1 = Type.Object({
  point: pointField("A key supporting point."),
  supports: Type.Optional(
    Type.Array(level2, {
      maxItems: 4,
      description: "Sub-points that jointly establish this point. Aim for 2-4, no overlap.",
    })
  ),
});

const pyramidSchema = Type.Object({
  point: pointField("The governing thought — the answer, recommendation, thesis, or plan, stated first."),
  supports: Type.Array(level1, {
    minItems: 1,
    maxItems: 4,
    description:
      "Key points that jointly justify the governing thought. Aim for 2-4, mutually exclusive, collectively sufficient.",
  }),
  assumptions: Type.Optional(
    Type.Array(Type.String({ maxLength: POINT_MAX }), {
      description:
        "Choices made on the user's behalf that they never explicitly approved — libraries picked, scope interpretations, defaults, edge-case resolutions. One line each so the user can veto them.",
    })
  ),
});

type PyramidInput = Static<typeof pyramidSchema>;

interface PyramidNode {
  point: string;
  supports?: PyramidNode[];
}

type PyramidDetails = PyramidInput;

// =============================================================================
// Plain-text rendering (goes back to the model as the tool result)
// =============================================================================

function toOutline(nodes: PyramidNode[], indent: string, out: string[]): void {
  for (const node of nodes) {
    out.push(`${indent}- ${node.point}`);
    if (node.supports?.length) toOutline(node.supports, indent + "  ", out);
  }
}

function toPlainText(input: PyramidInput): string {
  const out: string[] = [input.point];
  toOutline(input.supports, "", out);
  if (input.assumptions?.length) {
    out.push("", "Assumptions made:");
    for (const a of input.assumptions) out.push(`- ${a}`);
  }
  return out.join("\n");
}

// =============================================================================
// TUI rendering
// =============================================================================

function depthColor(depth: number): "text" | "dim" {
  return depth >= 2 ? "dim" : "text";
}

function renderTree(
  nodes: PyramidNode[],
  prefix: string,
  depth: number,
  theme: Theme,
  out: string[]
): void {
  nodes.forEach((node, i) => {
    const last = i === nodes.length - 1;
    const connector = last ? "└─ " : "├─ ";
    const childPrefix = prefix + (last ? "   " : "│  ");
    out.push(theme.fg("muted", prefix + connector) + theme.fg(depthColor(depth), node.point));
    if (node.supports?.length) {
      renderTree(node.supports, childPrefix, depth + 1, theme, out);
    }
  });
}

function renderPyramidCall(
  args: Partial<PyramidInput> | undefined,
  theme: Theme,
  context: { lastComponent: Text | undefined }
): Text {
  const text =
    context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const summary = args?.point ? theme.fg("dim", summarizeSingleLine(args.point)) : "";
  text.setText(`${theme.fg("toolTitle", theme.bold("pyramid"))} ${summary}`);
  return text;
}

function renderPyramidResult(
  result: AgentToolResult<PyramidDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { lastComponent: Text | undefined; isError: boolean }
): Text {
  const text =
    context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);

  if (context.isError) {
    const content = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    text.setText(theme.fg("error", content || "Pyramid rendering failed"));
    return text;
  }

  const details = result.details;
  if (!details) {
    text.setText(theme.fg("dim", "No pyramid recorded"));
    return text;
  }

  // Always render in full, regardless of the TUI's collapse state: this tool
  // exists solely for the user to read, so hiding its content defeats it.
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold(details.point)));
  renderTree(details.supports, "", 0, theme, lines);

  if (details.assumptions?.length) {
    lines.push("");
    lines.push(theme.fg("warning", theme.bold("Assumptions made")));
    for (const a of details.assumptions) {
      lines.push(`${theme.fg("warning", "• ")}${theme.fg("text", a)}`);
    }
  }

  text.setText(lines.join("\n"));
  return text;
}

// =============================================================================
// Tool definition
// =============================================================================

const pyramidTool = defineTool({
  name: "pyramid",
  label: "pyramid",
  description:
    "Communicate a structured argument to the user in Minto pyramid form: the answer first, " +
    "then 2-4 supporting points, each optionally backed by its own sub-points (max depth 3). " +
    "Use it whenever presenting a recommendation, a plan or approach before non-trivial work, " +
    "a diagnosis, or the structure of a blog post, lesson, or script. " +
    "This is communication to the user, not a thinking aid — write for their comprehension.",
  promptSnippet: "Present recommendations, plans, and argument structures as a pyramid (answer first, supported top-down)",
  promptGuidelines: [
    "Use pyramid when proposing an approach, making a recommendation, explaining a diagnosis, or structuring content (posts, lessons, scripts). Clarity of communication to the user outweighs token cost — prefer it over prose for anything non-trivial.",
    "Every point is a conclusion, not a topic: 'Cache invalidation causes the stale reads' not 'Caching'.",
    "Each group of supports must be MECE: no two siblings overlap, and together they fully justify their parent.",
    "Put every choice you made on the user's behalf in `assumptions` — they own all decisions.",
    "Do not use pyramid for trivial confirmations or one-line answers.",
  ],
  parameters: pyramidSchema,
  renderCall: renderPyramidCall as any,
  renderResult: renderPyramidResult as any,

  async execute(
    _toolCallId: string,
    params: PyramidInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<PyramidDetails> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<PyramidDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    return {
      content: [{ type: "text", text: toPlainText(params) }],
      details: params,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(pyramidTool);
}

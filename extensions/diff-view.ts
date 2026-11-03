/** Compact, bounded diff rendering. Edit execution stays entirely with Pi;
 * write uses a small operations wrapper to capture its preimage in Pi's queue. */
import { formatSize, type ExtensionAPI, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { extname } from "node:path";
import { countLines, displayText, MAX_DIFF_BYTES, MAX_DIFF_LINES, parseLayout, previewLimit } from "./lib/diff-model.js";
import { DiffComponent, type DiffView } from "./lib/diff-render.js";
import { createPreviewWriteTool } from "./lib/write-preview.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("diff-layout", {
    description: "Harpy diff layout: auto, unified, or split (also HARPY_DIFF_LAYOUT)",
    type: "string",
    default: process.env.HARPY_DIFF_LAYOUT ?? "auto",
  });
  pi.on("session_start", (_event, ctx) => {
    if (!parseLayout(pi.getFlag("diff-layout"))) {
      ctx.ui.notify("Invalid diff-layout; using auto. Choose auto, unified, or split.", "warning");
    }
  });

  pi.registerTool(createPreviewWriteTool(process.cwd()));
  pi.registerToolRenderer((toolName, next) => {
    if (toolName !== "edit" && toolName !== "write") return next();
    const renderers: ToolRenderers = {
      // The native edit renderer owns its shell. Ours delegates that to Pi.
      renderShell: "default",
      renderCall(args, theme, context) {
        const input = record(args);
        const path = typeof input.path === "string" ? displayText(input.path) : "...";
        let header = `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", path)}`;
        if (toolName === "write" && typeof input.content === "string") {
          const lines = countLines(input.content);
          header += theme.fg("dim", ` (${lines} ${lines === 1 ? "line" : "lines"}, ${formatSize(Buffer.byteLength(input.content))})`);
        }
        const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        text.setText(header);
        return text;
      },
      renderResult(result, options, theme, context) {
        const details = record(result.details);
        // Older Harpy sessions stored write diffs directly in details.
        const preview = toolName === "write" && details.harpyDiff ? record(details.harpyDiff) : details;
        const input = record(context.args);
        const filePath = typeof input.path === "string" ? input.path : "file";
        const textResult = () => {
          const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
          const content = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
          text.setText(context.isError ? theme.fg("error", content) : content);
          return text;
        };
        if (context.isError || options.isPartial || (typeof preview.diff !== "string" && typeof preview.note !== "string")) {
          return textResult();
        }
        const diff = typeof preview.diff === "string" ? preview.diff : "";
        const limit = previewLimit(diff, MAX_DIFF_BYTES, MAX_DIFF_LINES);
        const view: DiffView = {
          diff: limit ? "" : diff,
          filePath,
          action: preview.created === true ? "created" : preview.diff === "" ? "unchanged" :
            toolName === "edit" || preview.created === false || diff ? "modified" : "written",
          note: limit ? `Diff preview omitted: ${limit}` : typeof preview.note === "string" ? preview.note : undefined,
          markdown: [".md", ".mdx"].includes(extname(filePath).toLowerCase()),
        };
        const layout = parseLayout(pi.getFlag("diff-layout")) ?? "auto";
        const key = context.keyText("app.tools.expand");
        if (context.lastComponent instanceof DiffComponent) {
          context.lastComponent.update(view, theme, options.expanded, layout, key);
          return context.lastComponent;
        }
        return new DiffComponent(view, theme, options.expanded, layout, key);
      },
    };
    return renderers;
  });
}

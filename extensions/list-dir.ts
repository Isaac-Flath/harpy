import { Type, type Static } from "@sinclair/typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readdirSync, statSync } from "fs";
import nodePath from "path";
import { getTextContent } from "./lib/render-text.js";

const listDirSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory to list (default: current directory)" })
  ),
  depth: Type.Optional(
    Type.Number({
      description: "How many levels deep to recurse (default: 2, max: 5)",
    })
  ),
  include: Type.Optional(
    Type.String({
      description:
        'Comma-separated file extensions to include, e.g. ".py,.md". Only files matching these extensions are shown. Directories are always shown.',
    })
  ),
  dirs_only: Type.Optional(
    Type.Boolean({
      description:
        "If true, show only directories (no files). Useful for understanding project layout.",
    })
  ),
});

type ListDirInput = Static<typeof listDirSchema>;

interface ListDirDetails {
  displayPath: string;
  depth: number;
  include?: string;
  dirsOnly: boolean;
  entryCount: number;
  truncated: boolean;
}

const MAX_ENTRIES = 2000;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 5;

/**
 * Recursively walk a directory tree and collect formatted lines.
 */
function walkDir(
  dirPath: string,
  currentDepth: number,
  maxDepth: number,
  includeExts: Set<string> | null,
  dirsOnly: boolean,
  results: string[],
  prefix: string
): void {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  // Sort: directories first, then alphabetical within each group
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    // Skip common noise directories
    if (
      entry === "node_modules" ||
      entry === ".git" ||
      entry === "__pycache__" ||
      entry === ".venv" ||
      entry === "venv"
    ) {
      continue;
    }

    const fullPath = nodePath.join(dirPath, entry);
    let isDir: boolean;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      dirs.push(entry);
    } else if (!dirsOnly) {
      if (includeExts) {
        const ext = nodePath.extname(entry).toLowerCase();
        if (!includeExts.has(ext)) continue;
      }
      files.push(entry);
    }
  }

  dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  files.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const allEntries = [...dirs, ...files];

  for (let i = 0; i < allEntries.length; i++) {
    if (results.length >= MAX_ENTRIES) return;

    const entry = allEntries[i];
    const isLast = i === allEntries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const isDir = i < dirs.length;

    results.push(`${prefix}${connector}${entry}${isDir ? "/" : ""}`);

    if (isDir && currentDepth < maxDepth) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      walkDir(
        nodePath.join(dirPath, entry),
        currentDepth + 1,
        maxDepth,
        includeExts,
        dirsOnly,
        results,
        childPrefix
      );
    }
  }
}

function formatListDirCall(args: ListDirInput, theme: Theme): string {
  const path = args.path || ".";
  const depth = Math.min(Math.max(args.depth ?? DEFAULT_DEPTH, 1), MAX_DEPTH);
  const flags = [
    theme.fg("accent", path),
    theme.fg("dim", `--depth ${depth}`),
  ];

  if (args.dirs_only) flags.push(theme.fg("dim", "--dirs-only"));
  if (args.include) flags.push(theme.fg("dim", `--include ${args.include}`));

  return `${theme.fg("toolTitle", theme.bold("ls"))} ${flags.join(" ")}`;
}

function isTruncationNotice(line: string): boolean {
  return line.trim().startsWith("[Truncated:");
}

class ListDirComponent implements Component {
  private output: string;
  private details: ListDirDetails;
  private theme: Theme;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(
    output: string,
    details: ListDirDetails,
    theme: Theme,
    expanded: boolean
  ) {
    this.output = output;
    this.details = details;
    this.theme = theme;
    this.expanded = expanded;
  }

  setState(output: string, details: ListDirDetails, expanded: boolean): void {
    const changed =
      this.output !== output ||
      this.details !== details ||
      this.expanded !== expanded;
    this.output = output;
    this.details = details;
    this.expanded = expanded;
    if (changed) {
      this.cachedLines = null;
    }
  }

  invalidate(): void {
    this.cachedLines = null;
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedExpanded === this.expanded
    ) {
      return this.cachedLines;
    }

    if (!this.expanded) {
      this.cachedLines = [];
      this.cachedWidth = width;
      this.cachedExpanded = this.expanded;
      return this.cachedLines;
    }

    const rawLines = this.output.split("\n").filter((line) => line.length > 0);
    const lines = rawLines.map((line) =>
      isTruncationNotice(line)
        ? this.theme.fg("warning", line)
        : this.theme.fg("toolOutput", line)
    );

    this.cachedLines = lines.map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width) : line
    );
    this.cachedWidth = width;
    this.cachedExpanded = this.expanded;
    return this.cachedLines;
  }
}

function listDirRenderCall(
  args: ListDirInput,
  theme: Theme,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(formatListDirCall(args, theme));
  return text;
}

function listDirRenderResult(
  result: AgentToolResult<ListDirDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { lastComponent: Component | undefined; isError: boolean }
): Component {
  const output = getTextContent(result);

  if (context.isError || !result.details) {
    const text =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
    text.setText(output);
    return text;
  }

  if (context.lastComponent instanceof ListDirComponent) {
    context.lastComponent.setState(output, result.details, options.expanded);
    return context.lastComponent;
  }

  return new ListDirComponent(output, result.details, theme, options.expanded);
}

const listDirTool = defineTool({
  name: "list_dir",
  label: "list_dir",
  description:
    "List directory contents recursively as a tree. Supports depth control, file extension filtering, and directory-only mode. Skips node_modules, .git, __pycache__, .venv by default.",
  promptSnippet: "Recursive directory tree with depth, filter, and dirs-only options",
  promptGuidelines: [
    "Use list_dir instead of ls when you need to understand project structure across multiple levels.",
    "Use dirs_only=true to quickly understand a project's directory layout without file noise.",
    "Use include to filter to specific file types, e.g. include='.py,.ts' to see only Python and TypeScript files.",
    "Default depth is 2. Use depth=1 for a quick overview, depth=3-5 for deeper exploration.",
  ],
  parameters: listDirSchema,
  renderCall: listDirRenderCall as any,
  renderResult: listDirRenderResult as any,

  async execute(
    _toolCallId: string,
    params: ListDirInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<ListDirDetails> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<ListDirDetails>> {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    const dirPath = params.path
      ? nodePath.resolve(ctx.cwd, params.path)
      : ctx.cwd;

    const depth = Math.min(Math.max(params.depth ?? DEFAULT_DEPTH, 1), MAX_DEPTH);
    const dirsOnly = params.dirs_only ?? false;

    // Parse include extensions
    let includeExts: Set<string> | null = null;
    if (params.include) {
      includeExts = new Set(
        params.include.split(",").map((ext) => {
          ext = ext.trim().toLowerCase();
          return ext.startsWith(".") ? ext : `.${ext}`;
        })
      );
    }

    // Verify directory exists
    try {
      const stat = statSync(dirPath);
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }
    } catch (e: any) {
      if (e.code === "ENOENT") {
        throw new Error(`Path not found: ${dirPath}`);
      }
      throw e;
    }

    const results: string[] = [];
    const displayPath = params.path || ".";
    results.push(`${displayPath}/`);

    walkDir(dirPath, 1, depth, includeExts, dirsOnly, results, "");

    const entryCount = Math.max(0, results.length - 1);
    const truncated = results.length >= MAX_ENTRIES;
    if (truncated) {
      results.push(`\n[Truncated: ${MAX_ENTRIES} entry limit reached. Use a smaller depth or add filters.]`);
    }

    const output = results.join("\n");

    return {
      content: [{ type: "text", text: output }],
      details: {
        displayPath,
        depth,
        include: params.include,
        dirsOnly,
        entryCount,
        truncated,
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(listDirTool);
}

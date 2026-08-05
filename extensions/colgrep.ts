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
import { Text, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import nodePath from "path";
import {
  bold,
  dim,
  getTextContent,
  summarizeSingleLine,
  wrapAnsiLines,
} from "./lib/render-text.js";
import { checkAndRemember, duplicateStub, registerSeenResultsReset, resultKey } from "./lib/seen-results.js";

// =============================================================================
// Types mirroring colgrep --json output
// =============================================================================

interface ColgrepUnit {
  name?: string;
  qualified_name?: string;
  file: string;
  line: number;
  end_line?: number;
  language?: string;
  unit_type?: string;
  signature?: string;
  docstring?: string | null;
  parameters?: string[];
  return_type?: string | null;
  code?: string;
}

interface ColgrepResult {
  unit: ColgrepUnit;
  score: number;
}

interface ColgrepDetails {
  mode: "json" | "files_only";
  cwd: string;
  query?: string;
  pattern?: string;
  paths?: string[];
  include?: string;
  exclude?: string[];
  excludeDir?: string[];
  topK?: number;
  model?: string;
  alpha?: number;
  wholeWord: boolean;
  fixedStrings: boolean;
  codeOnly: boolean;
  semanticOnly: boolean;
  filesOnly: boolean;
  commandLine: string;
  results: ColgrepResult[]; // empty when mode=files_only
  files: string[]; // populated when mode=files_only
  rawNote?: string;
}

// =============================================================================
// Building the argv
// =============================================================================

interface BuildArgsOptions {
  query?: string;
  pattern?: string;
  paths?: string[];
  include?: string;
  exclude?: string[];
  excludeDir?: string[];
  topK?: number;
  model?: string;
  alpha?: number;
  wholeWord: boolean;
  fixedStrings: boolean;
  codeOnly: boolean;
  semanticOnly: boolean;
  filesOnly: boolean;
}

function buildArgs(opts: BuildArgsOptions): string[] {
  const args: string[] = [];
  // --json must come before the positional QUERY so colgrep doesn't swallow it.
  if (!opts.filesOnly) args.push("--json");
  // Tool calls are non-interactive. Always auto-confirm indexing prompts.
  args.push("-y");
  if (opts.filesOnly) args.push("-l");
  if (opts.pattern !== undefined) args.push("-e", opts.pattern);
  if (opts.include) args.push("--include", opts.include);
  if (opts.exclude) for (const p of opts.exclude) args.push("--exclude", p);
  if (opts.excludeDir)
    for (const d of opts.excludeDir) args.push("--exclude-dir", d);
  if (opts.topK !== undefined) args.push("-k", String(opts.topK));
  if (opts.model) args.push("--model", opts.model);
  if (opts.alpha !== undefined) args.push("--alpha", String(opts.alpha));
  if (opts.wholeWord) args.push("-w");
  if (opts.fixedStrings) args.push("-F");
  if (opts.codeOnly) args.push("--code-only");
  if (opts.semanticOnly) args.push("--semantic-only");
  if (opts.query !== undefined) args.push(opts.query);
  if (opts.paths) for (const p of opts.paths) args.push(p);
  return args;
}

function formatCommandLine(args: string[]): string {
  const quoted = args.map((a) => (/[\s"'`$*?|&;<>\\]/.test(a) ? JSON.stringify(a) : a));
  return ["colgrep", ...quoted].join(" ");
}

function guardAgainstCommonMistakes(opts: BuildArgsOptions): void {
  if (opts.pattern !== undefined && opts.pattern.length === 0) {
    throw new Error("pattern must be non-empty when provided");
  }
  if (opts.query === undefined && opts.pattern === undefined) {
    throw new Error(
      "Provide at least `query` (semantic) or `pattern` (regex). `files_only` still needs something to search for."
    );
  }
  if (
    opts.alpha !== undefined &&
    (!Number.isFinite(opts.alpha) || opts.alpha < 0 || opts.alpha > 1)
  ) {
    throw new Error("alpha must be between 0.0 and 1.0");
  }
  // Detect the "pipe-separated keyword list in -e" mistake from the tooling
  // recommendations doc. A single-atom alternation like "(a|b|c)" is fine; the
  // failure mode is bare "a|b|c|d|e" when the user really wants a semantic query.
  if (opts.pattern && !opts.query) {
    const cleaned = opts.pattern.trim();
    const looksLikeKeywordList =
      cleaned.includes("|") &&
      !/[\\\[\]().*+?{}^$]/.test(cleaned) &&
      cleaned.split("|").filter((x) => x.trim().length > 0).length >= 3;
    if (looksLikeKeywordList) {
      throw new Error(
        `-e takes a single regex, not a pipe-separated keyword list. ` +
          `Use the \`query\` parameter (semantic search handles synonyms), ` +
          `or wrap alternation in a real regex group like "(${cleaned})".`
      );
    }
  }
}

// =============================================================================
// Rendering
// =============================================================================

function formatColgrepCall(args: ColgrepInput, theme: Theme): string {
  const pieces: string[] = [theme.fg("toolTitle", theme.bold("colgrep"))];
  if (args.query) pieces.push(theme.fg("accent", JSON.stringify(args.query)));
  if (args.pattern)
    pieces.push(theme.fg("dim", `-e ${JSON.stringify(args.pattern)}`));
  if (args.paths?.length) pieces.push(theme.fg("dim", args.paths.join(" ")));
  if (args.include) pieces.push(theme.fg("dim", `--include ${args.include}`));
  if (args.top_k !== undefined) pieces.push(theme.fg("dim", `-k ${args.top_k}`));
  if (args.model) pieces.push(theme.fg("dim", `--model ${args.model}`));
  if (args.alpha !== undefined)
    pieces.push(theme.fg("dim", `--alpha ${args.alpha}`));
  if (args.files_only) pieces.push(theme.fg("dim", "-l"));
  if (args.whole_word) pieces.push(theme.fg("dim", "-w"));
  if (args.fixed_strings) pieces.push(theme.fg("dim", "-F"));
  if (args.code_only) pieces.push(theme.fg("dim", "--code-only"));
  if (args.semantic_only) pieces.push(theme.fg("dim", "--semantic-only"));
  return pieces.join(" ");
}

function fileDisplay(d: ColgrepDetails, absPath: string): string {
  try {
    const rel = nodePath.relative(d.cwd, absPath);
    if (!rel.startsWith("..") && !nodePath.isAbsolute(rel)) return rel || ".";
  } catch {
    // fall through
  }
  return absPath;
}

function renderAsLines(d: ColgrepDetails, expanded: boolean, theme: Theme): string[] {
  const lines: string[] = [];

  // Header summarizing input.
  const header: string[] = [bold(theme, "colgrep")];
  if (d.query) header.push(JSON.stringify(d.query));
  if (d.pattern) header.push(dim(theme, `-e ${JSON.stringify(d.pattern)}`));
  if (d.paths?.length) header.push(dim(theme, d.paths.join(" ")));
  if (d.model) header.push(dim(theme, `--model ${d.model}`));
  if (d.alpha !== undefined) header.push(dim(theme, `--alpha ${d.alpha}`));
  lines.push(header.join(" "));

  if (d.mode === "files_only") {
    lines.push("");
    lines.push(bold(theme, `Files (${d.files.length})`));
    if (d.files.length === 0) {
      lines.push(dim(theme, "  (no matches)"));
    } else {
      for (const f of d.files) lines.push(`  ${f}`);
    }
    return lines;
  }

  lines.push("");
  lines.push(bold(theme, `Results (${d.results.length})`));

  if (d.results.length === 0) {
    lines.push(
      dim(theme, "  No matches. Try a broader semantic query or relax the regex.")
    );
    return lines;
  }

  for (let i = 0; i < d.results.length; i++) {
    const r = d.results[i];
    const u = r.unit;
    const loc = `${fileDisplay(d, u.file)}:${u.line}${u.end_line && u.end_line !== u.line ? `-${u.end_line}` : ""}`;
    const meta: string[] = [];
    if (u.unit_type) meta.push(u.unit_type);
    if (u.language) meta.push(u.language);
    const metaStr = meta.length ? ` [${meta.join("/")}]` : "";
    const name = u.name ? ` ${u.name}` : "";
    const header = `  ${bold(theme, `[${i + 1}] ${loc}`)}${dim(theme, metaStr)}${name}  ${dim(theme, `(${r.score.toFixed(3)})`)}`;
    lines.push(header);

    if (!expanded) continue;

    if (u.signature) {
      lines.push(`    ${dim(theme, summarizeSingleLine(u.signature, 160))}`);
    }
    if (u.code) {
      lines.push("");
      for (const cl of u.code.split("\n")) lines.push(`    ${cl}`);
    }
    if (i < d.results.length - 1) {
      lines.push("", dim(theme, "  ───"), "");
    }
  }

  if (d.rawNote) {
    lines.push("");
    lines.push(dim(theme, d.rawNote));
  }

  return lines;
}

class ColgrepComponent implements Component {
  private details: ColgrepDetails;
  private theme: Theme;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(details: ColgrepDetails, expanded: boolean, theme: Theme) {
    this.details = details;
    this.theme = theme;
    this.expanded = expanded;
  }

  setState(details: ColgrepDetails, expanded: boolean, theme: Theme): void {
    const changed =
      this.details !== details || this.theme !== theme || this.expanded !== expanded;
    this.details = details;
    this.theme = theme;
    this.expanded = expanded;
    if (changed) this.cachedLines = null;
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
    const lines = renderAsLines(this.details, this.expanded, this.theme);
    this.cachedLines = this.expanded
      ? wrapAnsiLines(lines, width)
      : lines.map((line) =>
          visibleWidth(line) > width ? truncateToWidth(line, width) : line
        );
    this.cachedWidth = width;
    this.cachedExpanded = this.expanded;
    return this.cachedLines;
  }
}

function colgrepRenderCall(
  args: ColgrepInput,
  theme: Theme,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(formatColgrepCall(args, theme));
  return text;
}

function colgrepRenderResult(
  result: AgentToolResult<ColgrepDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { lastComponent: Component | undefined; isError: boolean }
): Component {
  if (context.isError || !result.details) {
    const text =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
    text.setText(getTextContent(result));
    return text;
  }
  if (context.lastComponent instanceof ColgrepComponent) {
    context.lastComponent.setState(result.details, options.expanded, theme);
    return context.lastComponent;
  }
  return new ColgrepComponent(result.details, options.expanded, theme);
}

// =============================================================================
// Schema
// =============================================================================

const colgrepSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        'Natural-language query for semantic search (e.g., "error handling for database connections"). Pair with `pattern` for hybrid search.',
    })
  ),
  pattern: Type.Optional(
    Type.String({
      description:
        'Regex pre-filter passed to -e. Takes a SINGLE regex (extended by default), NOT a pipe-separated keyword list. For alternation use a real group like "(auth|login|signin)". For keywords, put them in `query` instead.',
    })
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Files or directories to search in (cwd-relative or absolute). Default: current directory. Example: ["./src/api", "./src/auth"].',
    })
  ),
  include: Type.Optional(
    Type.String({
      description: 'File glob to include, e.g. "*.ts", "*.{ts,tsx}", "*.rs".',
    })
  ),
  exclude: Type.Optional(
    Type.Array(Type.String(), {
      description: 'File globs to exclude (e.g. ["*_test.go", "*.min.js"]).',
    })
  ),
  exclude_dir: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Directory names or globs to exclude (e.g. ["node_modules", "vendor", "**/test_*"]).',
    })
  ),
  top_k: Type.Optional(
    Type.Number({ description: "Number of results (default: colgrep default, 25)." })
  ),
  model: Type.Optional(
    Type.String({
      description:
        "ColBERT model HuggingFace ID or local path (--model). Uses the saved colgrep preference if not specified.",
    })
  ),
  alpha: Type.Optional(
    Type.Number({
      description:
        "Hybrid search alpha between keyword (0.0) and semantic (1.0) scoring (--alpha). Default: colgrep default, 0.60.",
      minimum: 0,
      maximum: 1,
    })
  ),
  whole_word: Type.Optional(
    Type.Boolean({ description: "Match whole words only for `pattern` (-w)." })
  ),
  fixed_strings: Type.Optional(
    Type.Boolean({
      description: "Treat `pattern` as a literal string, not a regex (-F).",
    })
  ),
  code_only: Type.Optional(
    Type.Boolean({
      description:
        "Only search code files, skip text/config (md, txt, yaml, json, toml, etc.).",
    })
  ),
  semantic_only: Type.Optional(
    Type.Boolean({
      description: "Disable FTS5 hybrid ranking (pure semantic search).",
    })
  ),
  files_only: Type.Optional(
    Type.Boolean({
      description:
        "Return only a list of matching file paths (-l). Equivalent to grep -l. Incompatible with --json; the tool returns plain filenames in this mode. Still requires `query` or `pattern`.",
    })
  ),
});

type ColgrepInput = Static<typeof colgrepSchema>;

// =============================================================================
// Tool
// =============================================================================

const colgrepTool = defineTool({
  name: "colgrep",
  label: "colgrep",
  description:
    "Semantic + regex code search over an indexed codebase. Use `query` for natural-language semantic search, `pattern` for a regex pre-filter, or both together for hybrid search. First call per project may take 30-90s to index; subsequent calls are fast (<5s). Prefer this over grep/rg/find for code exploration in the current project.",
  promptSnippet:
    "Semantic + regex code search (natural-language + hybrid ranking)",
  promptGuidelines: [
    "Use colgrep as the primary code-search tool over grep, rg, or find within the current project.",
    "`query` is natural language (handles synonyms). `pattern` is a single regex pre-filter. Passing both runs hybrid search.",
    "`pattern` is ONE regex, not a pipe-separated keyword list. For several keywords, put them in `query`. For alternation, use a real regex group like `(auth|login|signin)`.",
    "Use `paths` to scope to specific files/directories, `include` to filter by extension, `exclude`/`exclude_dir` to skip noise.",
    "Use `files_only: true` when you just need the list of matching files.",
    "Omit top_k and use the default; only raise it after a search that came back empty or clearly truncated.",
    "Use `model` or `alpha` only when the task explicitly needs search tuning.",
    "If one call returns nothing, try a broader `query` before running many narrow variants.",
    "colgrep cannot search files outside the current project's index. Use read/list_dir/bash for that.",
  ],
  parameters: colgrepSchema,
  renderCall: colgrepRenderCall as any,
  renderResult: colgrepRenderResult as any,

  async execute(
    _toolCallId: string,
    params: ColgrepInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<ColgrepDetails> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<ColgrepDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const opts: BuildArgsOptions = {
      query: params.query,
      pattern: params.pattern,
      paths: params.paths,
      include: params.include,
      exclude: params.exclude,
      excludeDir: params.exclude_dir,
      topK: params.top_k,
      model: params.model,
      alpha: params.alpha,
      wholeWord: params.whole_word ?? false,
      fixedStrings: params.fixed_strings ?? false,
      codeOnly: params.code_only ?? false,
      semanticOnly: params.semantic_only ?? false,
      filesOnly: params.files_only ?? false,
    };
    guardAgainstCommonMistakes(opts);

    const args = buildArgs(opts);
    const commandLine = formatCommandLine(args);

    // First call may take 30-90s to load model and build index; allow up to 10min.
    const { stdout, stderr, code } = await _pi.exec("colgrep", args, {
      cwd: ctx.cwd,
      signal,
      timeout: 600_000,
    });

    if (code !== 0) {
      const message =
        stderr.trim() || stdout.trim() || `colgrep exited ${code}`;
      throw new Error(`colgrep failed (exit ${code}): ${message}`);
    }

    const baseDetails = {
      cwd: ctx.cwd,
      query: opts.query,
      pattern: opts.pattern,
      paths: opts.paths,
      include: opts.include,
      exclude: opts.exclude,
      excludeDir: opts.excludeDir,
      topK: opts.topK,
      model: opts.model,
      alpha: opts.alpha,
      wholeWord: opts.wholeWord,
      fixedStrings: opts.fixedStrings,
      codeOnly: opts.codeOnly,
      semanticOnly: opts.semanticOnly,
      filesOnly: opts.filesOnly,
      commandLine,
    } as const;

    if (opts.filesOnly) {
      const files = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const details: ColgrepDetails = {
        ...baseDetails,
        mode: "files_only",
        results: [],
        files,
      };
      const text = files.length
        ? `Matching files (${files.length}):\n${files.map((f) => `  ${f}`).join("\n")}`
        : "No matching files.";
      return {
        content: [{ type: "text", text }],
        details,
      };
    }

    let results: ColgrepResult[];
    try {
      results = JSON.parse(stdout) as ColgrepResult[];
    } catch (error) {
      const stdoutPreview = summarizeSingleLine(stdout, 220);
      const stderrPreview = summarizeSingleLine(stderr, 220);
      const pieces = [
        "colgrep returned non-JSON stdout while JSON was expected.",
        stdout.trim() ? `stdout: ${stdoutPreview}` : undefined,
        stderr.trim() ? `stderr: ${stderrPreview}` : undefined,
        error instanceof Error ? `parse error: ${error.message}` : undefined,
      ].filter(Boolean);
      throw new Error(pieces.join(" "));
    }

    if (!Array.isArray(results)) {
      throw new Error(
        `colgrep --json returned a non-array payload: ${summarizeSingleLine(stdout, 200)}`
      );
    }

    // Exact repeats (same file, range, and content — from any search tool)
    // keep their header and signature but swap the code body for a stub, so
    // repeated searches don't duplicate context.
    const dedupedResults = results.map((r) => {
      if (!r.unit.code) return r;
      const firstTool = checkAndRemember(
        // Absolute path so keys line up with kb_search's absolute file paths.
        resultKey(nodePath.resolve(ctx.cwd, r.unit.file), r.unit.line, r.unit.end_line, r.unit.code),
        "colgrep"
      );
      return firstTool
        ? { ...r, unit: { ...r.unit, code: duplicateStub(firstTool) } }
        : r;
    });

    const details: ColgrepDetails = {
      ...baseDetails,
      mode: "json",
      results: dedupedResults,
      files: [],
    };

    const text = buildTextOutput(details);
    return {
      content: [{ type: "text", text }],
      details,
    };
  },
});

function buildTextOutput(d: ColgrepDetails): string {
  if (d.results.length === 0) {
    return "No matches. Try a broader semantic query or relax the regex.";
  }
  const sections = d.results.map((r, i) => {
    const u = r.unit;
    const loc = `${fileDisplay(d, u.file)}:${u.line}${u.end_line && u.end_line !== u.line ? `-${u.end_line}` : ""}`;
    const meta: string[] = [];
    if (u.unit_type) meta.push(u.unit_type);
    if (u.language) meta.push(u.language);
    const metaStr = meta.length ? ` [${meta.join("/")}]` : "";
    const header = `[${i + 1}] ${loc}${metaStr}  (score ${r.score.toFixed(3)})`;
    const name = u.name ? `name: ${u.name}` : "";
    const signature = u.signature ? `signature: ${u.signature}` : "";
    const code = u.code ? `\n${u.code}` : "";
    return [header, name, signature].filter(Boolean).join("\n") + code;
  });
  return sections.join("\n\n---\n\n");
}

// =============================================================================
// Module-level pi reference
// =============================================================================

let _pi: ExtensionAPI;

export default function (pi: ExtensionAPI) {
  _pi = pi;
  pi.registerTool(colgrepTool);
  registerSeenResultsReset(pi);
}

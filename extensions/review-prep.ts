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
import { bold, dim, getTextContent, wrapAnsiLines } from "./lib/render-text.js";

// =============================================================================
// Types
// =============================================================================

interface DiffstatEntry {
  file: string;
  changes: string; // e.g. "+12 -3" or "Bin"
}

interface ReviewPrepDetails {
  cwd: string;
  base: string;
  resolvedBase: string;
  includeDiff: boolean;
  diffContext: number;
  commits: string[];
  diffstat: DiffstatEntry[];
  diffstatSummary?: string;
  fullDiff: string;
  truncated: boolean;
  notes: string[];
}

// =============================================================================
// Helpers
// =============================================================================

async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeout = 60_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return pi.exec("git", args, { cwd, signal, timeout });
}

function splitLines(s: string): string[] {
  return s.split("\n").filter((line) => line.length > 0);
}

/**
 * Parse `git diff --stat` output. The last line is typically a summary like
 * " 3 files changed, 12 insertions(+), 4 deletions(-)".
 */
function parseDiffstat(stdout: string): {
  entries: DiffstatEntry[];
  summary?: string;
} {
  const lines = splitLines(stdout);
  if (lines.length === 0) return { entries: [] };

  let summary: string | undefined;
  const last = lines[lines.length - 1];
  if (/\b(insertion|deletion|changed)\b/.test(last)) {
    summary = last.trim();
    lines.pop();
  }

  const entries: DiffstatEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    // Format: "<path> | <N> <+/-bar>" or "<path> | Bin <bytes> -> <bytes> bytes"
    const pipeIdx = line.indexOf("|");
    if (pipeIdx === -1) continue;
    const file = line.slice(0, pipeIdx).trim();
    const rest = line.slice(pipeIdx + 1).trim();
    const firstTokenMatch = rest.match(/^(\S+)/);
    const changes = firstTokenMatch ? firstTokenMatch[1] : rest;
    entries.push({ file, changes });
  }
  return { entries, summary };
}

// =============================================================================
// Rendering
// =============================================================================

function formatReviewPrepCall(args: ReviewPrepInput, theme: Theme): string {
  const flags: string[] = [];
  if (args.base) flags.push(theme.fg("accent", args.base));
  if (args.include_diff === false) flags.push(theme.fg("dim", "--no-diff"));
  if (args.context !== undefined)
    flags.push(theme.fg("dim", `--context ${args.context}`));
  return `${theme.fg("toolTitle", theme.bold("review_prep"))} ${flags.join(" ")}`.trim();
}

function renderAsLines(d: ReviewPrepDetails): string[] {
  const lines: string[] = [];
  lines.push(`${bold("Base:")} ${d.resolvedBase} ${dim(`(requested: ${d.base})`)}`);

  lines.push("");
  lines.push(`${bold("Commits")} (${d.commits.length})`);
  if (d.commits.length === 0) {
    lines.push(dim("  (no commits ahead of base)"));
  } else {
    for (const c of d.commits) lines.push(`  ${c}`);
  }

  lines.push("");
  lines.push(`${bold("Diffstat")} (${d.diffstat.length} files)`);
  if (d.diffstat.length === 0) {
    lines.push(dim("  (no diff)"));
  } else {
    for (const e of d.diffstat) lines.push(`  ${e.file}  ${dim(e.changes)}`);
    if (d.diffstatSummary) lines.push(dim(`  ${d.diffstatSummary}`));
  }

  if (d.includeDiff) {
    lines.push("");
    lines.push(`${bold("Full diff")}`);
    if (!d.fullDiff.trim()) {
      lines.push(dim("  (empty)"));
    } else {
      for (const ln of d.fullDiff.split("\n")) lines.push(`  ${ln}`);
    }
    if (d.truncated) {
      lines.push(
        dim(`  [truncated — re-run with a narrower base or fewer files]`)
      );
    }
  }

  for (const note of d.notes) {
    lines.push("");
    lines.push(dim(note));
  }

  return lines;
}

class ReviewPrepComponent implements Component {
  private details: ReviewPrepDetails;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(details: ReviewPrepDetails, expanded: boolean) {
    this.details = details;
    this.expanded = expanded;
  }

  setState(details: ReviewPrepDetails, expanded: boolean): void {
    const changed = this.details !== details || this.expanded !== expanded;
    this.details = details;
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

    // Collapsed view: just show a summary line so big diffs don't dominate the log.
    if (!this.expanded) {
      const summary = this.details.diffstatSummary
        ? ` — ${this.details.diffstatSummary}`
        : "";
      const lines = [
        `${bold("review_prep")} ${dim(this.details.resolvedBase)}  ${dim(`${this.details.commits.length} commits, ${this.details.diffstat.length} files${summary}`)}`,
      ];
      this.cachedLines = lines.map((line) =>
        visibleWidth(line) > width ? truncateToWidth(line, width) : line
      );
      this.cachedWidth = width;
      this.cachedExpanded = this.expanded;
      return this.cachedLines;
    }

    const lines = renderAsLines(this.details);
    this.cachedLines = wrapAnsiLines(lines, width);
    this.cachedWidth = width;
    this.cachedExpanded = this.expanded;
    return this.cachedLines;
  }
}

function reviewPrepRenderCall(
  args: ReviewPrepInput,
  theme: Theme,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(formatReviewPrepCall(args, theme));
  return text;
}

function reviewPrepRenderResult(
  result: AgentToolResult<ReviewPrepDetails>,
  options: ToolRenderResultOptions,
  _theme: Theme,
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

  if (context.lastComponent instanceof ReviewPrepComponent) {
    context.lastComponent.setState(result.details, options.expanded);
    return context.lastComponent;
  }

  return new ReviewPrepComponent(result.details, options.expanded);
}

// =============================================================================
// Tool definition
// =============================================================================

const DEFAULT_CONTEXT = 3;
const MAX_DIFF_CHARS = 200_000;

const reviewPrepSchema = Type.Object({
  base: Type.Optional(
    Type.String({
      description:
        'Base ref to compare against (e.g., "main", "origin/main", "HEAD~3"). Default: upstream tracking branch (@{u}); if no upstream, falls back to origin/HEAD.',
    })
  ),
  include_diff: Type.Optional(
    Type.Boolean({
      description:
        "Whether to include the full unified diff. Default: true. Set false when you only need commit list and diffstat.",
    })
  ),
  context: Type.Optional(
    Type.Number({
      description: `Unified diff context lines (default: ${DEFAULT_CONTEXT}).`,
    })
  ),
});

type ReviewPrepInput = Static<typeof reviewPrepSchema>;

async function resolveBase(
  pi: ExtensionAPI,
  cwd: string,
  requested: string | undefined,
  signal: AbortSignal | undefined,
  notes: string[]
): Promise<{ base: string; resolved: string }> {
  if (requested) {
    const check = await runGit(pi, cwd, ["rev-parse", "--verify", requested], signal, 10_000);
    if (check.code !== 0) {
      throw new Error(
        `Cannot resolve base '${requested}': ${check.stderr.trim() || `exit ${check.code}`}`
      );
    }
    return { base: requested, resolved: requested };
  }

  // No base requested — prefer upstream.
  const upstream = await runGit(
    pi,
    cwd,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    signal,
    10_000
  );
  if (upstream.code === 0 && upstream.stdout.trim()) {
    return { base: "@{u}", resolved: upstream.stdout.trim() };
  }

  // Fall back to origin/HEAD.
  const originHead = await runGit(
    pi,
    cwd,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    signal,
    10_000
  );
  if (originHead.code === 0 && originHead.stdout.trim()) {
    const resolved = originHead.stdout.trim();
    notes.push(`No upstream configured; falling back to ${resolved}.`);
    return { base: resolved, resolved };
  }

  throw new Error(
    "Could not determine a base ref: no upstream and no origin/HEAD. Pass the `base` parameter explicitly."
  );
}

const reviewPrepTool = defineTool({
  name: "review_prep",
  label: "review_prep",
  description:
    "Bundle everything you need to code-review what's about to be pushed: the list of commits ahead of a base ref, the diffstat, and the full unified diff. Replaces the 2–3 step 'what would I be pushing?' ritual.",
  promptSnippet:
    "Commits ahead + diffstat + full diff vs a base ref (defaults to upstream)",
  promptGuidelines: [
    "Use review_prep when the user asks you to review local changes, prepare a PR description, or answer 'what am I about to push?'",
    "Default base is the tracking upstream (@{u}). Pass base='main' or 'origin/main' to compare against a different ref.",
    "Set include_diff=false when you only need the commit list and diffstat (e.g., picking which files to open).",
    "The full diff is truncated if it exceeds the internal size limit — the output will note this.",
  ],
  parameters: reviewPrepSchema,
  renderCall: reviewPrepRenderCall as any,
  renderResult: reviewPrepRenderResult as any,

  async execute(
    _toolCallId: string,
    params: ReviewPrepInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<ReviewPrepDetails> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<ReviewPrepDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const cwd = ctx.cwd;

    const insideCheck = await runGit(
      _pi,
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      signal,
      10_000
    );
    if (insideCheck.code !== 0 || insideCheck.stdout.trim() !== "true") {
      throw new Error(`Not a git repository: ${cwd}`);
    }

    const notes: string[] = [];
    const { base, resolved } = await resolveBase(
      _pi,
      cwd,
      params.base,
      signal,
      notes
    );
    const includeDiff = params.include_diff ?? true;
    const diffContext = Math.max(0, params.context ?? DEFAULT_CONTEXT);

    const dotdotdot = `${base}...HEAD`;
    const dotdot = `${base}..HEAD`;

    const tasks: Promise<{ stdout: string; stderr: string; code: number }>[] = [
      runGit(_pi, cwd, ["log", "--oneline", dotdot], signal),
      runGit(_pi, cwd, ["diff", "--stat", dotdotdot], signal),
    ];
    if (includeDiff) {
      tasks.push(
        runGit(
          _pi,
          cwd,
          ["diff", `--unified=${diffContext}`, dotdotdot],
          signal,
          120_000
        )
      );
    }

    const results = await Promise.all(tasks);
    const [logRes, statRes, diffRes] = results;

    if (logRes.code !== 0) {
      throw new Error(
        `git log ${dotdot} failed: ${logRes.stderr.trim() || `exit ${logRes.code}`}`
      );
    }
    if (statRes.code !== 0) {
      throw new Error(
        `git diff --stat ${dotdotdot} failed: ${statRes.stderr.trim() || `exit ${statRes.code}`}`
      );
    }

    const commits = splitLines(logRes.stdout);
    const { entries: diffstat, summary: diffstatSummary } = parseDiffstat(
      statRes.stdout
    );

    let fullDiff = "";
    let truncated = false;
    if (includeDiff && diffRes) {
      if (diffRes.code !== 0) {
        notes.push(
          `git diff failed: ${diffRes.stderr.trim() || `exit ${diffRes.code}`}`
        );
      } else {
        fullDiff = diffRes.stdout;
        if (fullDiff.length > MAX_DIFF_CHARS) {
          fullDiff = fullDiff.slice(0, MAX_DIFF_CHARS);
          truncated = true;
        }
      }
    }

    const details: ReviewPrepDetails = {
      cwd,
      base,
      resolvedBase: resolved,
      includeDiff,
      diffContext,
      commits,
      diffstat,
      diffstatSummary,
      fullDiff,
      truncated,
      notes,
    };

    const text = buildTextOutput(details);

    return {
      content: [{ type: "text", text }],
      details,
    };
  },
});

function buildTextOutput(d: ReviewPrepDetails): string {
  const lines: string[] = [];
  lines.push(`Base: ${d.resolvedBase} (requested: ${d.base})`);

  lines.push("");
  lines.push(`Commits (${d.commits.length}):`);
  for (const c of d.commits) lines.push(`  ${c}`);

  lines.push("");
  lines.push(`Diffstat (${d.diffstat.length} files):`);
  for (const e of d.diffstat) lines.push(`  ${e.file}  ${e.changes}`);
  if (d.diffstatSummary) lines.push(`  ${d.diffstatSummary}`);

  if (d.includeDiff) {
    lines.push("");
    lines.push("Full diff:");
    lines.push(d.fullDiff);
    if (d.truncated) {
      lines.push("");
      lines.push(
        "[Diff truncated to keep output manageable. Re-run with a narrower base or fewer files.]"
      );
    }
  }

  for (const note of d.notes) {
    lines.push("");
    lines.push(`Note: ${note}`);
  }

  return lines.join("\n");
}

// =============================================================================
// Module-level pi reference
// =============================================================================

let _pi: ExtensionAPI;

export default function (pi: ExtensionAPI) {
  _pi = pi;
  pi.registerTool(reviewPrepTool);
}

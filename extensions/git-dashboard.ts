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

interface StatusEntry {
  status: string; // two-char porcelain status, e.g. " M", "A ", "??"
  path: string;
}

interface GitDashboardDetails {
  cwd: string;
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: StatusEntry[];
  recentCommits: string[];
  changedFromUpstream: string[];
  logLimit: number;
  notes: string[];
}

// =============================================================================
// Helpers
// =============================================================================

async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined
): Promise<{ stdout: string; stderr: string; code: number }> {
  return pi.exec("git", args, { cwd, signal, timeout: 30_000 });
}

function parsePorcelain(stdout: string): {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: StatusEntry[];
} {
  const staged: StatusEntry[] = [];
  const unstaged: StatusEntry[] = [];
  const untracked: StatusEntry[] = [];

  // NUL-delimited porcelain v1. Rename/copy entries have an extra NUL-delimited
  // "original path" field we skip.
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.length < 3) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    const isRenameOrCopy = xy[0] === "R" || xy[0] === "C";
    if (isRenameOrCopy) {
      // Skip the following "from" path element.
      i += 1;
    }

    if (xy === "??") {
      untracked.push({ status: xy, path });
      continue;
    }
    const x = xy[0];
    const y = xy[1];
    if (x !== " " && x !== "?") {
      staged.push({ status: xy, path });
    }
    if (y !== " " && y !== "?") {
      unstaged.push({ status: xy, path });
    }
  }
  return { staged, unstaged, untracked };
}

function splitLines(s: string): string[] {
  return s.split("\n").filter((line) => line.length > 0);
}

function parseAheadBehind(s: string): { ahead: number; behind: number } {
  // git rev-list --left-right --count HEAD...@{u} => "<ahead>\t<behind>"
  const trimmed = s.trim();
  if (!trimmed) return { ahead: 0, behind: 0 };
  const [a, b] = trimmed.split(/\s+/);
  return { ahead: parseInt(a, 10) || 0, behind: parseInt(b, 10) || 0 };
}

// =============================================================================
// Rendering
// =============================================================================

function formatGitDashboardCall(args: GitDashboardInput, theme: Theme): string {
  const flags = [theme.fg("dim", `--log ${args.log_limit ?? DEFAULT_LOG_LIMIT}`)];
  return `${theme.fg("toolTitle", theme.bold("git_dashboard"))} ${flags.join(" ")}`;
}

function renderAsLines(d: GitDashboardDetails): string[] {
  const lines: string[] = [];

  if (!d.isRepo) {
    lines.push(dim("Not a git repository: " + d.cwd));
    return lines;
  }

  const branch = d.branch || "(detached)";
  const upstreamInfo = d.upstream
    ? `${d.upstream}${d.ahead || d.behind ? dim(`  (ahead ${d.ahead}, behind ${d.behind})`) : ""}`
    : dim("no upstream");
  lines.push(`${bold("Branch:")} ${branch}  ${bold("→")} ${upstreamInfo}`);

  const totalChanges = d.staged.length + d.unstaged.length + d.untracked.length;
  lines.push("");
  lines.push(
    `${bold("Working tree:")} ${totalChanges === 0 ? dim("clean") : `${totalChanges} changed`}`
  );

  const pushSection = (title: string, entries: StatusEntry[]) => {
    if (entries.length === 0) return;
    lines.push(`  ${bold(title)} (${entries.length})`);
    for (const e of entries) {
      lines.push(`    ${dim(e.status)} ${e.path}`);
    }
  };
  pushSection("Staged", d.staged);
  pushSection("Unstaged", d.unstaged);
  pushSection("Untracked", d.untracked);

  if (d.changedFromUpstream.length > 0) {
    lines.push("");
    lines.push(
      `${bold("Changed vs upstream")} (${d.changedFromUpstream.length})`
    );
    for (const f of d.changedFromUpstream) lines.push(`  ${f}`);
  }

  if (d.recentCommits.length > 0) {
    lines.push("");
    lines.push(`${bold("Recent commits")} (${d.recentCommits.length})`);
    for (const c of d.recentCommits) lines.push(`  ${c}`);
  }

  for (const note of d.notes) {
    lines.push("");
    lines.push(dim(note));
  }

  return lines;
}

class GitDashboardComponent implements Component {
  private details: GitDashboardDetails;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(details: GitDashboardDetails, expanded: boolean) {
    this.details = details;
    this.expanded = expanded;
  }

  setState(details: GitDashboardDetails, expanded: boolean): void {
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

    const lines = renderAsLines(this.details);
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

function gitDashboardRenderCall(
  args: GitDashboardInput,
  theme: Theme,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(formatGitDashboardCall(args, theme));
  return text;
}

function gitDashboardRenderResult(
  result: AgentToolResult<GitDashboardDetails>,
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

  if (context.lastComponent instanceof GitDashboardComponent) {
    context.lastComponent.setState(result.details, options.expanded);
    return context.lastComponent;
  }

  return new GitDashboardComponent(result.details, options.expanded);
}

// =============================================================================
// Tool definition
// =============================================================================

const DEFAULT_LOG_LIMIT = 10;
const MAX_LOG_LIMIT = 50;

const gitDashboardSchema = Type.Object({
  log_limit: Type.Optional(
    Type.Number({
      description: `How many recent commits to include (default: ${DEFAULT_LOG_LIMIT}, max: ${MAX_LOG_LIMIT}).`,
    })
  ),
});

type GitDashboardInput = Static<typeof gitDashboardSchema>;

const gitDashboardTool = defineTool({
  name: "git_dashboard",
  label: "git_dashboard",
  description:
    "Return a one-call snapshot of the repo: current branch, upstream, ahead/behind counts, staged/unstaged/untracked files, files changed vs upstream, and recent commits. Replaces the multi-command 'git status + rev-parse + rev-list + log' chain agents typically run at the start of a task.",
  promptSnippet:
    "One-call repo snapshot: branch, upstream, ahead/behind, status, recent commits",
  promptGuidelines: [
    "Use git_dashboard at the start of any git-related task instead of chaining git status + rev-parse + rev-list + log.",
    "One call returns: branch, upstream, ahead/behind counts, staged/unstaged/untracked files, files changed vs upstream, and recent commits.",
    "For the full diff of unpushed changes, use review_prep instead — git_dashboard only lists filenames.",
  ],
  parameters: gitDashboardSchema,
  renderCall: gitDashboardRenderCall as any,
  renderResult: gitDashboardRenderResult as any,

  async execute(
    _toolCallId: string,
    params: GitDashboardInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<GitDashboardDetails> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<GitDashboardDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const cwd = ctx.cwd;
    const logLimit = Math.min(
      Math.max(params.log_limit ?? DEFAULT_LOG_LIMIT, 1),
      MAX_LOG_LIMIT
    );

    // Bail out fast if we are not inside a git repo.
    const insideCheck = await runGit(
      _pi,
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      signal
    );
    if (insideCheck.code !== 0 || insideCheck.stdout.trim() !== "true") {
      const details: GitDashboardDetails = {
        cwd,
        isRepo: false,
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        recentCommits: [],
        changedFromUpstream: [],
        logLimit,
        notes: [],
      };
      return {
        content: [{ type: "text", text: `Not a git repository: ${cwd}` }],
        details,
      };
    }

    const notes: string[] = [];

    const [branchRes, statusRes, logRes, upstreamRes] = await Promise.all([
      runGit(_pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal),
      runGit(_pi, cwd, ["status", "--porcelain=v1", "-z"], signal),
      runGit(
        _pi,
        cwd,
        ["log", `-n${logLimit}`, "--pretty=%h %s"],
        signal
      ),
      runGit(
        _pi,
        cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        signal
      ),
    ]);

    const branch =
      branchRes.code === 0 ? branchRes.stdout.trim() || undefined : undefined;

    const hasUpstream = upstreamRes.code === 0;
    const upstream = hasUpstream ? upstreamRes.stdout.trim() : undefined;

    let ahead = 0;
    let behind = 0;
    let changedFromUpstream: string[] = [];
    if (hasUpstream) {
      const [abRes, diffRes] = await Promise.all([
        runGit(
          _pi,
          cwd,
          ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
          signal
        ),
        runGit(_pi, cwd, ["diff", "--name-only", "@{u}...HEAD"], signal),
      ]);
      if (abRes.code === 0) {
        const parsed = parseAheadBehind(abRes.stdout);
        ahead = parsed.ahead;
        behind = parsed.behind;
      }
      if (diffRes.code === 0) {
        changedFromUpstream = splitLines(diffRes.stdout);
      }
    } else {
      notes.push("No upstream configured for this branch.");
    }

    const { staged, unstaged, untracked } =
      statusRes.code === 0
        ? parsePorcelain(statusRes.stdout)
        : { staged: [], unstaged: [], untracked: [] };
    if (statusRes.code !== 0) {
      notes.push(
        `git status failed: ${statusRes.stderr.trim() || `exit ${statusRes.code}`}`
      );
    }

    const recentCommits = logRes.code === 0 ? splitLines(logRes.stdout) : [];
    if (logRes.code !== 0) {
      notes.push(
        `git log failed: ${logRes.stderr.trim() || `exit ${logRes.code}`}`
      );
    }

    const details: GitDashboardDetails = {
      cwd,
      isRepo: true,
      branch,
      upstream,
      ahead,
      behind,
      staged,
      unstaged,
      untracked,
      recentCommits,
      changedFromUpstream,
      logLimit,
      notes,
    };

    // LLM-facing text — keep it terse and parseable.
    const text = buildTextOutput(details);

    return {
      content: [{ type: "text", text }],
      details,
    };
  },
});

function buildTextOutput(d: GitDashboardDetails): string {
  const lines: string[] = [];
  lines.push(`Branch: ${d.branch ?? "(detached)"}`);
  if (d.upstream) {
    lines.push(`Upstream: ${d.upstream} (ahead ${d.ahead}, behind ${d.behind})`);
  } else {
    lines.push("Upstream: (none)");
  }

  const pushSection = (title: string, entries: StatusEntry[]) => {
    lines.push("");
    lines.push(`${title} (${entries.length}):`);
    for (const e of entries) {
      lines.push(`  ${e.status} ${e.path}`);
    }
  };
  pushSection("Staged", d.staged);
  pushSection("Unstaged", d.unstaged);
  pushSection("Untracked", d.untracked);

  lines.push("");
  lines.push(`Changed vs upstream (${d.changedFromUpstream.length}):`);
  for (const f of d.changedFromUpstream) lines.push(`  ${f}`);

  lines.push("");
  lines.push(`Recent commits (${d.recentCommits.length}):`);
  for (const c of d.recentCommits) lines.push(`  ${c}`);

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
  pi.registerTool(gitDashboardTool);
}

/**
 * AgentKB primitives for Pi.
 *
 * Two tools only, matching agentkb's two stable JSON contracts:
 *
 *   kb_search — `agentkb search --json`: semantic + keyword retrieval over
 *               every store (the one thing bash can't do)
 *   kb_paths  — `agentkb settings --json`: resolved store paths, so the
 *               built-in read/edit/bash tools can work on the content repo
 *
 * Everything else (demand SQL, chats browsing, wiki edits, refresh/index)
 * goes through built-in tools and the agentkb CLI directly — see
 * prompts/APPEND_SYSTEM.md.
 */

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
import {
  bold,
  dim,
  getTextContent,
  summarizeSingleLine,
  wrapAnsiLines,
} from "./lib/render-text.js";

// =============================================================================
// Types
// =============================================================================

interface KbSearchResult {
  collection: string;
  /** Absolute path — feed it straight to the read tool. */
  file: string;
  relative_path?: string;
  line: number;
  score: number;
  name?: string;
  unit_type?: string;
  title?: string;
  section?: string;
  tags?: string[];
  content?: string;
}

interface KbSearchDetails {
  query: string;
  scope: string;
  topK: number;
  pattern?: string;
  results: KbSearchResult[];
}

interface AgentkbSettingsPayload {
  config_file: string;
  settings: Record<string, unknown>;
  resolved_paths: Record<string, string>;
}

// =============================================================================
// CLI helpers
// =============================================================================

function parseJsonStdout<T>(toolName: string, stdout: string, stderr: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const pieces = [
      `${toolName} returned non-JSON stdout while JSON was expected.`,
      stdout.trim() ? `stdout: ${summarizeSingleLine(stdout, 220)}` : undefined,
      stderr.trim() ? `stderr: ${summarizeSingleLine(stderr, 220)}` : undefined,
      error instanceof Error ? `parse error: ${error.message}` : undefined,
    ].filter(Boolean);
    throw new Error(pieces.join(" "));
  }
}

async function runAgentkbJson<T>(
  toolName: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeout = 120_000
): Promise<T> {
  const { stdout, stderr, code } = await _pi.exec("agentkb", args, {
    signal,
    timeout,
  });

  if (code !== 0) {
    const message = stderr.trim() || stdout.trim() || `agentkb exited ${code}`;
    throw new Error(`${toolName} failed: ${message}`);
  }

  return parseJsonStdout<T>(toolName, stdout, stderr);
}

// =============================================================================
// KbSearchComponent
// =============================================================================

class KbSearchComponent implements Component {
  private details: KbSearchDetails;
  private theme: Theme;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(details: KbSearchDetails, expanded: boolean, theme: Theme) {
    this.details = details;
    this.theme = theme;
    this.expanded = expanded;
  }

  setState(details: KbSearchDetails, expanded: boolean, theme: Theme): void {
    const changed =
      this.theme !== theme ||
      this.expanded !== expanded ||
      this.details.query !== details.query ||
      this.details.pattern !== details.pattern ||
      this.details.results !== details.results;
    this.details = details;
    this.theme = theme;
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

    const { query, scope, topK, pattern, results } = this.details;

    const lines: string[] = [
      bold(this.theme, "Search input"),
      `  query: ${JSON.stringify(query)}`,
      `  scope: ${scope}`,
      `  top_k: ${topK}`,
    ];
    if (pattern) lines.push(`  pattern: ${JSON.stringify(pattern)}`);

    const displayPath = (r: KbSearchResult) => r.relative_path ?? r.file;

    if (!results.length) {
      lines.push("", dim(this.theme, "No results found. Try broader terms or a different scope."));
    } else if (!this.expanded) {
      lines.push("", bold(this.theme, `Results (${results.length})`));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const section = r.section ? ` › ${r.section}` : "";
        lines.push(
          `  [${i + 1}] ${r.collection}/${displayPath(r)}${section} ${dim(this.theme, `(${r.score.toFixed(2)})`)}`
        );
      }
    } else {
      lines.push("", bold(this.theme, `Results (${results.length})`));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const section = r.section ? ` › ${r.section}` : "";
        const score = `  (${r.score.toFixed(2)})`;

        lines.push(`  ${bold(this.theme, `[${i + 1}] ${r.collection}/${displayPath(r)}${section}`)}${dim(this.theme, score)}`);
        if (r.title) {
          lines.push(`    ${r.title}`);
        }
        if (r.tags?.length) {
          lines.push(dim(this.theme, `    Tags: ${r.tags.join(", ")}`));
        }
        if (r.content) {
          lines.push("");
          for (const cl of r.content.split("\n")) {
            lines.push(`    ${cl}`);
          }
        }
        if (i < results.length - 1) {
          lines.push("", dim(this.theme, "  ───"), "");
        }
      }
    }

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

function kbSearchRenderResult(
  result: AgentToolResult<KbSearchDetails>,
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

  if (context.lastComponent instanceof KbSearchComponent) {
    context.lastComponent.setState(result.details, options.expanded, theme);
    return context.lastComponent;
  }

  return new KbSearchComponent(result.details, options.expanded, theme);
}

// =============================================================================
// kb_search
// =============================================================================

const SCOPES =
  "wiki (default), wiki:notes, wiki:source, cards, chats, community, " +
  "community:members, community:forum, community:notes, community:analytics, " +
  "communications, demand, demand:ideas, demand:signals, library, lessons, " +
  "evidence, episodes, media, all, everything";

const searchSchema = Type.Object({
  query: Type.String({
    description:
      "Semantic search query — describe what you're looking for in natural language",
  }),
  scope: Type.Optional(
    Type.String({
      description: `Which store to search: ${SCOPES}`,
    })
  ),
  top_k: Type.Optional(
    Type.Number({
      description: "Number of results to return (default: 5)",
    })
  ),
  pattern: Type.Optional(
    Type.String({
      description:
        "Optional regex pattern to combine with semantic search (hybrid mode)",
    })
  ),
});

type SearchInput = Static<typeof searchSchema>;

const kbSearchTool = defineTool({
  name: "kb_search",
  label: "kb_search",
  description:
    "Search the persistent knowledge base across all AgentKB stores: wiki (distilled lessons), chats (session history), cards, demand (audience signals), library (lessons/evidence/episodes/media), community, and communications. Results include content and absolute file paths readable with the read tool.",
  promptSnippet:
    "Search accumulated knowledge: lessons, corrections, preferences, gotchas, demand signals",
  promptGuidelines: [
    "Use kb_search for targeted lookups: 'does the KB mention X', 'find the page about Y', one-shot sanity checks.",
    "Scopes: wiki for distilled knowledge (default), chats for session history, demand for audience questions, library for lessons/evidence/episodes, communications for researcher posts, everything for all stores.",
    "Result file paths are absolute — pass them to the read tool for full context around a hit.",
    "Search after the user corrects you or expresses a preference — there may be related guidance already recorded.",
    "Use the pattern parameter for hybrid semantic+regex search when you know a specific identifier.",
    "For multi-step research, compose kb_search with SQL, file reads, and scripted LLM fanout (see the Primitives section of the system prompt).",
  ],
  parameters: searchSchema,

  renderResult: kbSearchRenderResult as any,

  async execute(
    _toolCallId: string,
    params: SearchInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<KbSearchDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const scope = params.scope ?? "wiki";
    const topK = params.top_k ?? 5;

    const args: string[] = ["search"];
    if (params.scope) args.push("-s", params.scope);
    args.push("-k", String(topK));
    if (params.pattern) args.push("-e", params.pattern);
    args.push("-c", "--json");
    args.push(params.query);

    const parsed = await runAgentkbJson<{ results?: KbSearchResult[] }>(
      "agentkb search",
      args,
      signal
    );
    const results = parsed.results ?? [];
    const details: KbSearchDetails = {
      query: params.query,
      scope,
      topK,
      pattern: params.pattern,
      results,
    };

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No results found. Try broader terms or a different scope.",
          },
        ],
        details,
      };
    }

    const formatted = results.map((r, i) => {
      const header = `[${i + 1}] [${r.collection}] ${r.file}:${r.line}  (${r.score})`;
      const title = r.title
        ? `    ${r.title}` + (r.section ? ` > ${r.section}` : "")
        : "";
      const tags = r.tags?.length ? `    Tags: ${r.tags.join(", ")}` : "";
      return [header, title, tags, r.content ?? ""].filter(Boolean).join("\n");
    });

    return {
      content: [{ type: "text", text: formatted.join("\n\n---\n\n") }],
      details,
    };
  },
});

// =============================================================================
// kb_paths
// =============================================================================

const pathsSchema = Type.Object({});

const kbPathsTool = defineTool({
  name: "kb_paths",
  label: "kb_paths",
  description:
    "Returns the absolute paths of every AgentKB store (wiki pages, chats readable, cards, demand, library, community, communications). Use these paths with the built-in read/edit/write/bash tools to browse and update the knowledge base directly.",
  promptSnippet: "Get AgentKB store paths for direct file access",
  promptGuidelines: [
    "Call this once, then use built-in tools on the returned paths: read/edit for wiki pages, read for chats readable markdown, sqlite3 (read-only) for the demand DB.",
    "To save new knowledge: kb_search first to find an existing page to update, then edit it, or write a new page under the wiki pages directory. Decompose by topic, not project.",
    "No fabrication — only write what was actually learned in this session.",
    "After creating or updating wiki pages, run 'agentkb index' to make changes searchable.",
  ],
  parameters: pathsSchema,

  async execute(
    _toolCallId: string,
    _params: Static<typeof pathsSchema>,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const settings = await runAgentkbJson<AgentkbSettingsPayload>(
      "agentkb settings",
      ["settings", "--json"],
      signal,
      30_000
    );

    const lines = Object.entries(settings.resolved_paths).map(
      ([key, value]) => `${key}: ${value}`
    );
    lines.push("demand_db: " + settings.resolved_paths.demand_root + "/data/idea_review.sqlite");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: undefined,
    };
  },
});

// =============================================================================
// Registration
// =============================================================================

let _pi: ExtensionAPI;

export default function (pi: ExtensionAPI) {
  _pi = pi;
  pi.registerTool(kbSearchTool);
  pi.registerTool(kbPathsTool);
}

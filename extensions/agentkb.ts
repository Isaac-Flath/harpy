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
import { existsSync, readFileSync } from "fs";
import nodePath from "path";
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
  file: string;
  line: number;
  score: number;
  name?: string;
  unit_type?: string;
  title?: string;
  section?: string;
  tags?: string[];
  content: string;
}

interface KbSearchDetails {
  query: string;
  scope: string;
  topK: number;
  pattern?: string;
  results: KbSearchResult[];
}

interface KbReadDetails {
  content: string;
  path: string;
}

type KbListStore = "chats" | "wiki";

interface KbChatListItem {
  id: string;
  title: string;
  date?: string;
  source?: string;
  project?: string;
  session_id?: string;
  messages?: number;
  path?: string;
  source_jsonl?: string;
}

interface KbWikiListItem {
  path: string;
  title: string;
  tags?: string[];
  mtime?: string;
}

type KbListItem = KbChatListItem | KbWikiListItem;

interface KbListDetails {
  store: KbListStore;
  items: KbListItem[];
  limit: number;
  since?: string;
  until?: string;
  source?: string;
  project?: string;
  tag?: string;
}

interface KbChatReadDetails {
  id: string;
  title?: string;
  date?: string;
  source?: string;
  project?: string;
  session_id?: string;
  messages?: number;
  path?: string;
  source_jsonl?: string;
  content: string;
}

interface AgentkbSettingsPayload {
  config_file: string;
  settings: Record<string, unknown>;
  resolved_paths: {
    agentkb_home: string;
    wiki_root: string;
    wiki_pages: string;
    wiki_sources: string;
    chats_root: string;
    chats_sessions: string;
    chats_readable: string;
    skills_root: string;
  };
}

// =============================================================================
// ANSI helpers
// =============================================================================

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJsonStdout<T>(toolName: string, stdout: string, stderr: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const stdoutPreview = summarizeSingleLine(stdout, 220);
    const stderrPreview = summarizeSingleLine(stderr, 220);
    const pieces = [
      `${toolName} returned non-JSON stdout while JSON was expected.`,
      stdout.trim() ? `stdout: ${stdoutPreview}` : undefined,
      stderr.trim() ? `stderr: ${stderrPreview}` : undefined,
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

async function getAgentkbSettings(
  signal: AbortSignal | undefined
): Promise<AgentkbSettingsPayload> {
  return runAgentkbJson<AgentkbSettingsPayload>(
    "agentkb settings",
    ["settings", "--json"],
    signal,
    30_000
  );
}

function isChatListItem(item: KbListItem): item is KbChatListItem {
  return "id" in item;
}

function isWikiListItem(item: KbListItem): item is KbWikiListItem {
  return "path" in item && !("id" in item);
}

// =============================================================================
// KbSearchComponent
// =============================================================================

class KbSearchComponent implements Component {
  private details: KbSearchDetails;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(details: KbSearchDetails, expanded: boolean) {
    this.details = details;
    this.expanded = expanded;
  }

  setState(details: KbSearchDetails, expanded: boolean): void {
    const changed =
      this.expanded !== expanded ||
      this.details.query !== details.query ||
      this.details.pattern !== details.pattern ||
      this.details.results !== details.results;
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

    const { query, scope, topK, pattern, results } = this.details;

    const lines: string[] = [
      bold("Search input"),
      `  query: ${JSON.stringify(query)}`,
      `  scope: ${scope}`,
      `  top_k: ${topK}`,
    ];
    if (pattern) lines.push(`  pattern: ${JSON.stringify(pattern)}`);

    if (!results.length) {
      lines.push("", dim("No results found. Try broader terms or a different scope."));
    } else if (!this.expanded) {
      lines.push("", bold(`Results (${results.length})`));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const section = r.section ? ` › ${r.section}` : "";
        lines.push(
          `  [${i + 1}] ${r.collection}/${r.file}${section} ${dim(`(${r.score.toFixed(2)})`)}`
        );
      }
    } else {
      lines.push("", bold(`Results (${results.length})`));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const section = r.section ? ` › ${r.section}` : "";
        const score = `  (${r.score.toFixed(2)})`;

        lines.push(`  ${bold(`[${i + 1}] ${r.collection}/${r.file}${section}`)}${dim(score)}`);
        if (r.title) {
          lines.push(`    ${r.title}`);
        }
        if (r.tags?.length) {
          lines.push(dim(`    Tags: ${r.tags.join(", ")}`));
        }
        lines.push("");
        for (const cl of r.content.split("\n")) {
          lines.push(`    ${cl}`);
        }
        if (i < results.length - 1) {
          lines.push("", dim("  ───"), "");
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

// =============================================================================
// KbReadComponent
// =============================================================================

class KbReadComponent implements Component {
  private content: string;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(content: string, expanded: boolean) {
    this.content = content;
    this.expanded = expanded;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded !== expanded) {
      this.expanded = expanded;
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

    const allLines = this.content.split("\n");
    let lines: string[];

    if (this.expanded) {
      lines = allLines.map((line) => `  ${line}`);
    } else {
      const noun = allLines.length === 1 ? "line" : "lines";
      lines = [dim(`${allLines.length} ${noun} (expand to read)`)];
    }

    this.cachedLines = lines.map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width) : line
    );
    this.cachedWidth = width;
    this.cachedExpanded = this.expanded;
    return this.cachedLines;
  }
}

class KbListComponent implements Component {
  private details: KbListDetails;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(details: KbListDetails, expanded: boolean) {
    this.details = details;
    this.expanded = expanded;
  }

  setState(details: KbListDetails, expanded: boolean): void {
    const changed = this.details !== details || this.expanded !== expanded;
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

    const lines: string[] = [
      bold(`Store: ${this.details.store}`),
      `  limit: ${this.details.limit}`,
    ];

    if (this.details.since) lines.push(`  since: ${JSON.stringify(this.details.since)}`);
    if (this.details.until) lines.push(`  until: ${JSON.stringify(this.details.until)}`);
    if (this.details.source) lines.push(`  source: ${JSON.stringify(this.details.source)}`);
    if (this.details.project) lines.push(`  project: ${JSON.stringify(this.details.project)}`);
    if (this.details.tag) lines.push(`  tag: ${JSON.stringify(this.details.tag)}`);

    if (!this.details.items.length) {
      lines.push("", dim("No items found."));
    } else {
      const visibleItems = this.expanded
        ? this.details.items
        : this.details.items.slice(0, Math.min(this.details.items.length, 5));

      lines.push("", bold(`Items (${this.details.items.length})`));
      for (let i = 0; i < visibleItems.length; i++) {
        const item = visibleItems[i];
        if (isChatListItem(item)) {
          const meta = [item.date, item.source, item.project].filter(Boolean).join(" • ");
          lines.push(`  [${i + 1}] ${item.title}`);
          lines.push(`      ${item.id}`);
          if (meta) lines.push(dim(`      ${meta}`));
        } else if (isWikiListItem(item)) {
          lines.push(`  [${i + 1}] ${item.path}`);
          lines.push(`      ${item.title}`);
          if (item.tags?.length) lines.push(dim(`      tags: ${item.tags.join(", ")}`));
        }
      }

      if (!this.expanded && this.details.items.length > visibleItems.length) {
        lines.push(
          "",
          dim(`... ${this.details.items.length - visibleItems.length} more items (expand to view all)`)
        );
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

// =============================================================================
// Render helpers
// =============================================================================

function kbSearchRenderResult(
  result: AgentToolResult<KbSearchDetails>,
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

  if (context.lastComponent instanceof KbSearchComponent) {
    context.lastComponent.setState(result.details, options.expanded);
    return context.lastComponent;
  }

  return new KbSearchComponent(result.details, options.expanded);
}

function kbReadRenderCall(
  args: { path: string },
  theme: Theme,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(
    `${theme.fg("toolTitle", theme.bold("kb_read"))} ${theme.fg("accent", args.path)}`
  );
  return text;
}

function kbReadRenderResult(
  result: AgentToolResult<KbReadDetails>,
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

  if (context.lastComponent instanceof KbReadComponent) {
    context.lastComponent.setExpanded(options.expanded);
    return context.lastComponent;
  }

  return new KbReadComponent(result.details.content, options.expanded);
}

function kbListRenderCall(
  args: {
    store: KbListStore;
    since?: string;
    until?: string;
    source?: string;
    project?: string;
    tag?: string;
    limit?: number;
  },
  theme: Theme,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  const flags = [theme.fg("accent", args.store)];
  if (args.limit !== undefined) flags.push(theme.fg("dim", `--limit ${args.limit}`));
  if (args.since) flags.push(theme.fg("dim", `--since ${JSON.stringify(args.since)}`));
  if (args.until) flags.push(theme.fg("dim", `--until ${JSON.stringify(args.until)}`));
  if (args.source) flags.push(theme.fg("dim", `--source ${JSON.stringify(args.source)}`));
  if (args.project) flags.push(theme.fg("dim", `--project ${JSON.stringify(args.project)}`));
  if (args.tag) flags.push(theme.fg("dim", `--tag ${JSON.stringify(args.tag)}`));
  text.setText(`${theme.fg("toolTitle", theme.bold("kb_list"))} ${flags.join(" ")}`);
  return text;
}

function kbListRenderResult(
  result: AgentToolResult<KbListDetails>,
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

  if (context.lastComponent instanceof KbListComponent) {
    context.lastComponent.setState(result.details, options.expanded);
    return context.lastComponent;
  }

  return new KbListComponent(result.details, options.expanded);
}

function kbChatReadRenderCall(
  args: { id: string },
  theme: Theme,
  context: { lastComponent: Component | undefined }
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(
    `${theme.fg("toolTitle", theme.bold("kb_chat_read"))} ${theme.fg("accent", args.id)}`
  );
  return text;
}

function kbChatReadRenderResult(
  result: AgentToolResult<KbChatReadDetails>,
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

  if (context.lastComponent instanceof KbReadComponent) {
    context.lastComponent.setExpanded(options.expanded);
    return context.lastComponent;
  }

  return new KbReadComponent(result.details.content, options.expanded);
}

// =============================================================================
// kb_search
// =============================================================================

const searchSchema = Type.Object({
  query: Type.String({
    description:
      "Semantic search query — describe what you're looking for in natural language",
  }),
  scope: Type.Optional(
    Type.String({
      description:
        'Which collection to search: "wiki" (default), "chats", or "all"',
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
    "Search the persistent knowledge base (wiki and chat history). Returns semantically relevant results from past lessons, corrections, API gotchas, taste decisions, and preferences accumulated across all sessions.",
  promptSnippet:
    "Search accumulated knowledge: lessons, corrections, preferences, gotchas",
  promptGuidelines: [
    "Use kb_search for targeted lookups: 'does the KB mention X', 'find the page about Y', one-shot sanity checks.",
    "For multi-step research questions, combine kb_search with kb_read and scripted LLM fanout (see harpy_llm.py) to filter, read, and synthesize across pages.",
    "Search after the user corrects you or expresses a preference — there may be related guidance already recorded.",
    "Use scope='wiki' for distilled knowledge (default), scope='chats' for raw session history, scope='all' for both.",
    "Use the pattern parameter for hybrid semantic+regex search when you know a specific identifier or pattern.",
    "Queries are natural language — describe what you're looking for conceptually, not just keywords.",
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
    args.push("--json");
    args.push(params.query);

    try {
      const { stdout, stderr, code } = await _pi.exec("agentkb", args, {
        signal,
        timeout: 120_000,
      });

      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `agentkb exited ${code}`;
        throw new Error(`agentkb exited ${code}: ${message}`);
      }

      const parsed = parseJsonStdout<{ results?: KbSearchResult[] }>(
        "agentkb search",
        stdout,
        stderr
      );
      const results: KbSearchResult[] = parsed.results || [];
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

      // Format results for the LLM
      const formatted = results.map((r, i) => {
        const header = `[${i + 1}] [${r.collection}] ${r.file}:${r.line}  (${r.score})`;
        const title = r.title
          ? `    ${r.title}` + (r.section ? ` > ${r.section}` : "")
          : "";
        const tags = r.tags?.length ? `    Tags: ${r.tags.join(", ")}` : "";
        const content = r.content || "";
        return [header, title, tags, content].filter(Boolean).join("\n");
      });

      return {
        content: [{ type: "text", text: formatted.join("\n\n---\n\n") }],
        details,
      };
    } catch (e: any) {
      const msg = e.stderr?.toString() || e.message || "Unknown error";
      throw new Error(`agentkb search failed: ${msg}`);
    }
  },
});

// =============================================================================
// kb_read
// =============================================================================

const readSchema = Type.Object({
  path: Type.String({
    description:
      'Wiki page path relative to the wiki directory, e.g. "tools/colgrep.md" or "writing/writing-with-zinsser.md". Use kb_search first to find relevant pages.',
  }),
});

type ReadInput = Static<typeof readSchema>;

const kbReadTool = defineTool({
  name: "kb_read",
  label: "kb_read",
  description:
    "Read a wiki page from the knowledge base. Use kb_search first to find relevant pages, then kb_read to get the full content.",
  promptSnippet: "Read a knowledge base wiki page by path",
  promptGuidelines: [
    "Use kb_search first to find relevant pages, then kb_read to get the full content when a search result looks relevant.",
    "Page paths come from search results — use the file field from kb_search output.",
  ],
  parameters: readSchema,

  renderCall: kbReadRenderCall as any,
  renderResult: kbReadRenderResult as any,

  async execute(
    _toolCallId: string,
    params: ReadInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<KbReadDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const settings = await getAgentkbSettings(signal);
    const wikiPagesDir = settings.resolved_paths.wiki_pages;
    const wikiRoot = nodePath.resolve(wikiPagesDir);
    const fullPath = nodePath.resolve(wikiRoot, params.path);
    const relativePath = nodePath.relative(wikiRoot, fullPath);

    // Ensure path stays within wiki directory.
    if (
      relativePath.startsWith("..") ||
      nodePath.isAbsolute(relativePath)
    ) {
      throw new Error("Path must be within the wiki directory");
    }

    if (!existsSync(fullPath)) {
      throw new Error(`Wiki page not found: ${params.path}`);
    }

    const content = readFileSync(fullPath, "utf-8");
    return {
      content: [{ type: "text", text: content }],
      details: { content, path: params.path },
    };
  },
});

// =============================================================================
// kb_list
// =============================================================================

const listSchema = Type.Object({
  store: Type.Union([Type.Literal("chats"), Type.Literal("wiki")], {
    description: 'Which store to browse: "chats" or "wiki"',
  }),
  since: Type.Optional(
    Type.String({
      description:
        'Only include items on or after this time filter, e.g. "7 days" or "2026-04-16"',
    })
  ),
  until: Type.Optional(
    Type.String({
      description:
        'Only include items on or before this time filter, e.g. "today" or "2026-04-16"',
    })
  ),
  source: Type.Optional(
    Type.String({
      description: 'Chats only: filter by source such as "pi" or "claude"',
    })
  ),
  project: Type.Optional(
    Type.String({
      description: 'Chats only: filter by project substring',
    })
  ),
  tag: Type.Optional(
    Type.String({
      description: 'Wiki only: filter by tag',
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of items to return (default: 20)",
    })
  ),
});

type ListInput = Static<typeof listSchema>;

const kbListTool = defineTool({
  name: "kb_list",
  label: "kb_list",
  description:
    "List knowledge-base items from the chats or wiki store. Use it for browsing, recency views, tag views, and chat-session discovery.",
  promptSnippet: "List chat sessions or wiki pages from AgentKB",
  promptGuidelines: [
    "Use kb_list when you already know which store you want and need browsing rather than semantic relevance.",
    "Use store='chats' for recent session discovery and store='wiki' for tag or recency views.",
    "After listing chats, use kb_chat_read to open a selected session by id.",
    "Keep kb_read for wiki pages and kb_search for relevance-based retrieval.",
  ],
  parameters: listSchema,
  renderCall: kbListRenderCall as any,
  renderResult: kbListRenderResult as any,

  async execute(
    _toolCallId: string,
    params: ListInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<KbListDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    if (params.store === "wiki" && (params.source || params.project)) {
      throw new Error("source and project filters only apply to store='chats'");
    }
    if (params.store === "chats" && params.tag) {
      throw new Error("tag filter only applies to store='wiki'");
    }

    const limit = params.limit ?? 20;
    const args = [params.store, "list", "--json", "--limit", String(limit)];
    if (params.since) args.push("--since", params.since);
    if (params.until) args.push("--until", params.until);
    if (params.source) args.push("--source", params.source);
    if (params.project) args.push("--project", params.project);
    if (params.tag) args.push("--tag", params.tag);

    const parsed = await runAgentkbJson<{
      items?: KbListItem[];
      meta?: { count?: number; store?: string };
      message?: string;
    }>(`agentkb ${params.store} list`, args, signal);

    const items = parsed.items ?? [];
    const details: KbListDetails = {
      store: params.store,
      items,
      limit,
      since: params.since,
      until: params.until,
      source: params.source,
      project: params.project,
      tag: params.tag,
    };

    if (!items.length) {
      return {
        content: [
          {
            type: "text",
            text:
              parsed.message ??
              `No ${params.store === "chats" ? "chat sessions" : "wiki pages"} found.`,
          },
        ],
        details,
      };
    }

    const formatted = items.map((item, index) => {
      if (isChatListItem(item)) {
        const meta = [item.date, item.source, item.project].filter(Boolean).join(" | ");
        return [
          `[${index + 1}] ${item.title}`,
          `    id: ${item.id}`,
          meta ? `    ${meta}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      const tags = item.tags?.length ? `    tags: ${item.tags.join(", ")}` : "";
      return [`[${index + 1}] ${item.path}`, `    ${item.title}`, tags]
        .filter(Boolean)
        .join("\n");
    });

    return {
      content: [{ type: "text", text: formatted.join("\n\n") }],
      details,
    };
  },
});

// =============================================================================
// kb_chat_read
// =============================================================================

const chatReadSchema = Type.Object({
  id: Type.String({
    description: "Chat id returned by kb_list with store='chats'",
  }),
});

type ChatReadInput = Static<typeof chatReadSchema>;

const kbChatReadTool = defineTool({
  name: "kb_chat_read",
  label: "kb_chat_read",
  description:
    "Read a chat session from AgentKB by id. Use kb_list with store='chats' first when you need to browse recent sessions.",
  promptSnippet: "Read a chat session by id from AgentKB",
  promptGuidelines: [
    "Use kb_list with store='chats' to discover session ids, then call kb_chat_read on the one you want.",
    "Keep kb_chat_read chat-specific instead of using it as a generic KB getter.",
  ],
  parameters: chatReadSchema,
  renderCall: kbChatReadRenderCall as any,
  renderResult: kbChatReadRenderResult as any,

  async execute(
    _toolCallId: string,
    params: ChatReadInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<KbChatReadDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const parsed = await runAgentkbJson<{ item?: KbChatReadDetails }>(
      "agentkb chats show",
      ["chats", "show", "--id", params.id, "--json"],
      signal
    );

    const item = parsed.item;
    if (!item) {
      throw new Error(`Chat session not found: ${params.id}`);
    }

    return {
      content: [{ type: "text", text: item.content }],
      details: item,
    };
  },
});

// =============================================================================
// kb_wiki_path
// =============================================================================

const wikiPathSchema = Type.Object({});

const kbWikiPathTool = defineTool({
  name: "kb_wiki_path",
  label: "kb_wiki_path",
  description:
    "Returns the absolute path to the knowledge base wiki directory. Use this to locate wiki pages for reading with the read tool or editing with the edit tool.",
  promptSnippet: "Get the wiki directory path for direct file editing",
  promptGuidelines: [
    "Call this once to get the wiki path, then use the built-in edit tool for surgical updates to existing pages and write for new pages.",
    "This is better than a custom write tool — edit preserves existing content and only changes what needs changing.",
    "To save new knowledge: kb_wiki_path to get the wiki path, then write to create a new page or edit to update an existing one.",
    "Decompose by topic, not project. Go concurrency lessons go on a Go page, not a project page.",
    "No fabrication — only write what was actually learned in this session.",
    "Use kb_search first to check for existing pages to update rather than creating duplicates.",
    "After creating or updating pages, run 'agentkb index' yourself to make changes searchable. Only ask the user if the command fails or is unavailable.",
  ],
  parameters: wikiPathSchema,

  async execute(
    _toolCallId: string,
    _params: Static<typeof wikiPathSchema>,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const settings = await getAgentkbSettings(signal);
    const wikiRoot = settings.resolved_paths.wiki_root;
    const wikiPagesDir = settings.resolved_paths.wiki_pages;
    const schemaPath = nodePath.join(wikiRoot, "schema.md");
    const indexPath = nodePath.join(wikiRoot, "index.md");

    let info = `Wiki directory: ${wikiPagesDir}`;
    if (existsSync(schemaPath)) {
      info += `\nSchema (conventions): ${schemaPath}`;
    }
    if (existsSync(indexPath)) {
      info += `\nIndex (page catalog): ${indexPath}`;
    }

    return {
      content: [{ type: "text", text: info }],
      details: undefined,
    };
  },
});

// =============================================================================
// Module-level reference to ExtensionAPI (set at registration time)
// =============================================================================

let _pi: ExtensionAPI;

export default function (pi: ExtensionAPI) {
  _pi = pi;
  pi.registerTool(kbSearchTool);
  pi.registerTool(kbReadTool);
  pi.registerTool(kbListTool);
  pi.registerTool(kbChatReadTool);
  pi.registerTool(kbWikiPathTool);
}

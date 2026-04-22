import { Type, type Static } from "@sinclair/typebox";
import {
  defineTool,
  getMarkdownTheme,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  TruncatedText,
  type Component,
} from "@mariozechner/pi-tui";
import {
  runInvestigation,
  seedLeadsFromAgentkb,
  type InvestigationResult,
  type TurnLog,
  type TerminatedReason,
} from "./lib/rlm-investigation.js";
import {
  InvestigationLogger,
  defaultLogPath,
} from "./lib/rlm-investigation-log.js";
import { writeNotebook } from "./lib/rlm-notebook.js";

// =============================================================================
// Schema
// =============================================================================

const rlmQuerySchema = Type.Object({
  question: Type.String({
    description:
      "The research question to answer by exploring the knowledge base with a programmatic REPL.",
  }),
  scope: Type.Optional(
    Type.String({
      description:
        "Which agentkb collection to seed leads from. Default (unset) is a mixed seed: k hits each from 'wiki:notes' (hand-curated), 'wiki:source' (fetched references), and 'chats' — so the model sees all source types without one dominating. Pass an explicit scope ('wiki', 'wiki:notes', 'wiki:source', 'chats', 'communications') for single-store seeding.",
    }),
  ),
  k: Type.Optional(
    Type.Number({
      description:
        "Number of initial agentkb hits PER STORE. Default 30. With the mixed seed (scope unset), total initial leads = k × 3. With an explicit scope, total = k.",
    }),
  ),
  max_iterations: Type.Optional(
    Type.Number({
      description:
        "Cap on turns per investigation (default 40). Most investigations converge in <10.",
    }),
  ),
  max_recursive_calls: Type.Optional(
    Type.Number({
      description:
        "How many layers of actual recursion `rlm_query` can do from inside the REPL. Default 2. 0 means rlm_query short-circuits to llm_query with no child investigation. 1 = one level of real recursion. 2 = two levels, so the root can spawn children and grandchildren.",
    }),
  ),
  max_budget: Type.Optional(
    Type.Number({
      description:
        "Hard cap on total LM spend in USD across all depths and siblings (default 1.00, i.e. about one US dollar total across the whole investigation tree).",
    }),
  ),
  investigator_model: Type.Optional(
    Type.String({
      description:
        "Investigator model id — the one that drives the investigation REPL (default 'gpt-5.4').",
    }),
  ),
  investigator_provider: Type.Optional(
    Type.String({
      description:
        "Investigator provider (default 'openai-codex', uses Codex OAuth sub). Use 'anthropic' for claude-* models.",
    }),
  ),
  analyst_model: Type.Optional(
    Type.String({
      description:
        "Analyst model id — used by llm_query / llm_query_batched for fan-out work and by child investigations (default 'gpt-5.4-mini').",
    }),
  ),
  analyst_provider: Type.Optional(
    Type.String({
      description:
        "Analyst provider (default 'openai-codex'). Typically matches investigator_provider.",
    }),
  ),
});

type RlmQueryInput = Static<typeof rlmQuerySchema>;

// =============================================================================
// Details type — what flows to the renderer
// =============================================================================

interface TurnView {
  i: number;
  blocks: string[];
  stdouts: string[]; // truncated
  has_final: boolean;
  cost: number;
}

interface InvestigationView {
  question: string;
  depth: number;
  answer: string | undefined;
  terminated_reason: TerminatedReason;
  total_cost: number;
  turns: TurnView[];
  child_investigations: InvestigationView[];
}

interface RlmQueryDetails extends InvestigationView {
  initial_leads_count: number;
  log_path: string;
  notebook_path?: string;
  elapsed_ms: number;
  in_progress: boolean;
}

function viewTurn(t: TurnLog, i: number): TurnView {
  return {
    i,
    blocks: t.blocks,
    stdouts: t.blockResults.map((r) =>
      r.stdout
        ? r.stdout.length > 500
          ? r.stdout.slice(0, 500) + "..."
          : r.stdout
        : "",
    ),
    has_final: t.blockResults.some((r) => r.final_answer !== undefined),
    cost: t.lmCost,
  };
}

function viewInvestigation(
  inv: InvestigationResult,
  question: string,
  depth: number,
): InvestigationView {
  return {
    question,
    depth,
    answer: inv.answer,
    terminated_reason: inv.terminatedReason,
    total_cost: inv.totalCost,
    turns: inv.turns.map((t, i) => viewTurn(t, i + 1)),
    child_investigations: inv.childInvestigations.map((c) =>
      viewInvestigation(c, "(sub-question)", depth + 1),
    ),
  };
}

// =============================================================================
// Tool
// =============================================================================

const DEFAULT_INVESTIGATOR_PROVIDER = "openai-codex";
const DEFAULT_ANALYST_PROVIDER = "openai-codex";
const DEFAULT_INVESTIGATOR_MODEL = "gpt-5.4";
const DEFAULT_ANALYST_MODEL = "gpt-5.4-mini";
const DEFAULT_MAX_ITERATIONS = 40;
const DEFAULT_MAX_RECURSIVE_CALLS = 2;
const DEFAULT_MAX_BUDGET = 1.0;

const rlmQueryTool = defineTool({
  name: "rlm_query",
  label: "rlm_query",
  description:
    "Answer a question by spawning a Python REPL where the investigator model iteratively explores the agentkb knowledge base. The REPL has a `context` variable pre-seeded with agentkb hits (the leads), plus builtins: kb_search, kb_read, llm_query, llm_query_batched, rlm_query, rlm_query_batched, FINAL. Use for questions that benefit from programmatic filter/sort/fan-out/synthesize rather than plain search. Returns final answer with cost + terminated_reason.",
  promptSnippet:
    "Programmatic KB retrieval — investigator writes Python to explore agentkb",
  promptGuidelines: [
    "Call rlm_query directly when the user asks a research question: 'what are the gotchas with X', 'summarize KB on Y', 'compare A vs B', 'what does my KB say about Z'. Do NOT pre-search with kb_search first — rlm_query already seeds itself from agentkb and iterates. Pre-searching wastes a turn.",
    "Call rlm_query directly when the user explicitly asks to use it (e.g. 'use rlm to ...'). Skip any preparatory kb_search.",
    "Use rlm_query for anything that benefits from filter → deep-read → synthesize, fan-out per-chunk classification, or cross-page comparison.",
    "For a simple one-shot lookup ('is there a page about X?', 'find the file Y'), kb_search is still the right tool — rlm_query has $0.02-$0.15 setup cost and ~15-60s latency.",
    "terminated_reason='final' means the investigator emitted FINAL(answer). Other reasons ('max_iterations', 'budget_exceeded', 'no_code_blocks') indicate the investigation didn't converge — surface this clearly to the user.",
    "Default seed is mixed: 30 hits each from wiki:notes (curated), wiki:source (fetched references), and chats — 90 leads total. Each hit carries a `collection` field the investigator can filter by. Pass an explicit `scope` ('wiki', 'chats', etc.) to narrow to a single source.",
    "max_recursive_calls defaults to 2. That allows real recursive investigations two layers deep: the root can spawn children, and children can spawn grandchildren. Set it to 0 if you want rlm_query builtins to short-circuit to plain LM calls instead.",
  ],
  parameters: rlmQuerySchema,

  async execute(
    toolCallId: string,
    params: RlmQueryInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<RlmQueryDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<RlmQueryDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    // scope === undefined triggers the mixed seed (wiki:notes, wiki:source,
    // chats — k hits each). An explicit scope string is single-store.
    const scope = params.scope;
    const k = params.k ?? 30;
    const maxIter = params.max_iterations ?? DEFAULT_MAX_ITERATIONS;
    const maxRecursiveCalls =
      params.max_recursive_calls ?? DEFAULT_MAX_RECURSIVE_CALLS;
    const maxBudget = params.max_budget ?? DEFAULT_MAX_BUDGET;
    const investigatorModelId =
      params.investigator_model ?? DEFAULT_INVESTIGATOR_MODEL;
    const analystModelId = params.analyst_model ?? DEFAULT_ANALYST_MODEL;
    const investigatorProvider =
      params.investigator_provider ?? DEFAULT_INVESTIGATOR_PROVIDER;
    const analystProvider =
      params.analyst_provider ?? DEFAULT_ANALYST_PROVIDER;

    // 1. Seed leads from agentkb (normalized shape: {path, score, snippet, ...})
    const initialLeads = await seedLeadsFromAgentkb(
      params.question,
      k,
      scope,
    );
    const effectiveScope = scope ?? "mixed(wiki:notes+wiki:source+chats)";
    const initialLeadsCount = initialLeads.length;

    // 2. Resolve models
    const investigatorModel = ctx.modelRegistry.find(
      investigatorProvider,
      investigatorModelId,
    );
    if (!investigatorModel) {
      throw new Error(
        `investigator model ${investigatorProvider}/${investigatorModelId} not found in pi model registry`,
      );
    }
    const analystModel = ctx.modelRegistry.find(
      analystProvider,
      analystModelId,
    );
    if (!analystModel) {
      throw new Error(
        `analyst model ${analystProvider}/${analystModelId} not found in pi model registry`,
      );
    }

    // 3. Investigation log
    const logPath = defaultLogPath(toolCallId);
    const log = new InvestigationLogger(logPath);
    log.write({
      type: "metadata",
      depth: 0,
      question: params.question,
      initial_leads_count: initialLeadsCount,
      initial_leads: initialLeads,
      investigator_provider: investigatorProvider,
      investigator_model: investigatorModel.id,
      analyst_provider: analystProvider,
      analyst_model: analystModel.id,
      max_iterations: maxIter,
      max_recursive_calls: maxRecursiveCalls,
      max_budget: maxBudget,
      scope: effectiveScope,
      k,
    });

    // 4. Streaming partial-result helper
    const t0 = Date.now();
    let lastTurn = 0;
    let lastCost = 0;
    const emitPartial = (extra?: Partial<RlmQueryDetails>) => {
      if (!onUpdate) return;
      const partial: RlmQueryDetails = {
        question: params.question,
        depth: 0,
        answer: undefined,
        terminated_reason: "max_iterations",
        total_cost: lastCost,
        turns: [],
        child_investigations: [],
        initial_leads_count: initialLeadsCount,
        log_path: logPath,
        elapsed_ms: Date.now() - t0,
        in_progress: true,
        ...extra,
      };
      onUpdate({
        content: [
          {
            type: "text",
            text: `turn ${lastTurn} · $${lastCost.toFixed(4)}`,
          },
        ],
        details: partial,
      });
    };

    emitPartial();

    // 5. Run investigation
    const result: InvestigationResult = await runInvestigation({
      question: params.question,
      leads: initialLeads,
      depth: 0,
      maxRecursiveCalls,
      maxIterations: maxIter,
      maxBudget,
      investigatorModel,
      analystModel,
      modelRegistry: ctx.modelRegistry,
      log,
      signal,
      onUpdate: (ev) => {
        // depth=0 events drive the live counter; deeper-depth events are still
        // captured in the investigation log and final tree, just not streamed live.
        if (ev.depth === 0) {
          lastTurn = ev.turn;
          lastCost = ev.cumulativeCost;
          emitPartial();
        }
      },
    });
    const elapsedMs = Date.now() - t0;

    log.write({
      type: "final",
      depth: 0,
      terminated_reason: result.terminatedReason,
      total_cost: result.totalCost,
      turns: result.turns.length,
      elapsed_ms: elapsedMs,
    });

    // 6. Render NDJSON → .ipynb as a human-readable view alongside the log.
    const notebookPath = logPath.replace(/\.ndjson$/, ".ipynb");
    let notebookWritten: string | undefined;
    try {
      writeNotebook(logPath, notebookPath);
      notebookWritten = notebookPath;
    } catch (e) {
      // Notebook rendering is a best-effort view; don't fail the query if
      // it breaks. The NDJSON is the source of truth.
      console.error(
        `rlm: notebook render failed (${notebookPath}):`,
        e instanceof Error ? e.message : e,
      );
    }

    // 7. Build response
    const investigationView = viewInvestigation(result, params.question, 0);
    const details: RlmQueryDetails = {
      ...investigationView,
      initial_leads_count: initialLeadsCount,
      log_path: logPath,
      notebook_path: notebookWritten,
      elapsed_ms: elapsedMs,
      in_progress: false,
    };

    const responseText = formatResponseText(details);

    return {
      content: [{ type: "text", text: responseText }],
      details,
    };
  },

  renderCall: renderRlmCall as never,
  renderResult: renderRlmResult as never,
});

function formatResponseText(details: RlmQueryDetails): string {
  const headerLines = [
    `rlm_query: ${details.question}`,
    `  terminated_reason: ${details.terminated_reason}`,
    `  turns: ${details.turns.length}`,
    `  cost: $${details.total_cost.toFixed(4)}`,
    `  elapsed: ${(details.elapsed_ms / 1000).toFixed(1)}s`,
    `  log: ${details.log_path}`,
  ];
  if (details.notebook_path) {
    headerLines.push(`  notebook: ${details.notebook_path}`);
  }
  const header = headerLines.join("\n");

  if (details.terminated_reason !== "final") {
    return `${header}\n\n(no FINAL emitted — investigation did not converge)`;
  }
  return `${header}\n\n${details.answer ?? ""}`;
}

// =============================================================================
// Rendering
// =============================================================================

function renderRlmCall(
  args: RlmQueryInput,
  theme: Theme,
  context: { lastComponent: Component | undefined },
): Text {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  const q =
    args.question.length > 80
      ? `${args.question.slice(0, 80)}...`
      : args.question;
  text.setText(
    `${theme.fg("toolTitle", theme.bold("rlm_query"))} ${theme.fg("accent", q)}`,
  );
  return text;
}

function statusIcon(reason: TerminatedReason, theme: Theme, inProgress: boolean): string {
  if (inProgress) return theme.fg("warning", "⏳");
  if (reason === "final") return theme.fg("success", "✓");
  return theme.fg("error", "✗");
}

function renderRlmResult(
  result: AgentToolResult<RlmQueryDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: { lastComponent: Component | undefined; isError: boolean },
): Component {
  const details = result.details;
  if (!details) {
    const fallback = result.content.find((c) => c.type === "text");
    return new Text(
      fallback?.type === "text" ? fallback.text : "(no result)",
      0,
      0,
    );
  }

  if (options.expanded) {
    return renderExpanded(details, theme);
  }
  return renderCollapsed(details, theme);
}

function renderCollapsed(details: RlmQueryDetails, theme: Theme): Text {
  const lines: string[] = [];
  const icon = statusIcon(details.terminated_reason, theme, details.in_progress);
  const q =
    details.question.length > 80
      ? `${details.question.slice(0, 80)}...`
      : details.question;

  lines.push(
    `${icon} ${theme.fg("toolTitle", theme.bold("rlm_query"))} ${theme.fg("dim", q)}`,
  );

  const childCount = details.child_investigations.length;
  const stats = [
    `${details.turns.length} turns`,
    `$${details.total_cost.toFixed(4)}`,
    `${(details.elapsed_ms / 1000).toFixed(1)}s`,
    details.terminated_reason,
  ];
  if (childCount > 0)
    stats.push(
      `${childCount} child investigation${childCount > 1 ? "s" : ""}`,
    );
  lines.push(theme.fg("dim", `  ${stats.join(" · ")}`));

  if (details.in_progress) {
    lines.push(theme.fg("warning", "  (running...)"));
  } else if (details.terminated_reason !== "final") {
    lines.push(
      theme.fg("error", "  no FINAL emitted — investigation did not converge"),
    );
  } else if (details.answer) {
    lines.push("");
    const preview = details.answer.split("\n").slice(0, 6).join("\n");
    for (const l of preview.split("\n")) {
      lines.push(`  ${l}`);
    }
    const lineCount = details.answer.split("\n").length;
    if (lineCount > 6) {
      lines.push(theme.fg("muted", `  … ${lineCount - 6} more lines (Ctrl+O to expand)`));
    }
  }

  return new Text(lines.join("\n"), 0, 0);
}

function renderExpanded(details: RlmQueryDetails, theme: Theme): Component {
  const container = new Container();
  const mdTheme = getMarkdownTheme();

  const icon = statusIcon(details.terminated_reason, theme, details.in_progress);
  const childCount = details.child_investigations.length;
  const stats = [
    `${details.turns.length} turns`,
    `$${details.total_cost.toFixed(4)}`,
    `${(details.elapsed_ms / 1000).toFixed(1)}s`,
    details.terminated_reason,
  ];
  if (childCount > 0) stats.push(`${childCount} child`);

  container.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold("rlm_query"))} ${theme.fg("dim", details.question)}`,
      0,
      0,
    ),
  );
  container.addChild(new Text(theme.fg("dim", `  ${stats.join(" · ")}`), 0, 0));
  container.addChild(
    new Text(theme.fg("muted", `  log: ${details.log_path}`), 0, 0),
  );

  appendInvestigationBody(container, details, theme, 0);

  if (details.terminated_reason === "final" && details.answer) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Final answer ───"), 0, 0));
    container.addChild(new Markdown(details.answer.trim(), 0, 0, mdTheme));
  } else if (!details.in_progress && details.terminated_reason !== "final") {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg(
          "error",
          `Investigation did not converge: ${details.terminated_reason}`,
        ),
        0,
        0,
      ),
    );
  }

  return container;
}

function appendInvestigationBody(
  container: Container,
  inv: InvestigationView,
  theme: Theme,
  depth: number,
): void {
  const indent = "  ".repeat(depth + 1);

  for (const t of inv.turns) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${indent}${theme.fg("muted", `─── d${depth} turn ${t.i} ───`)} ${theme.fg("dim", `$${t.cost.toFixed(4)}`)}`,
        0,
        0,
      ),
    );

    for (let bi = 0; bi < t.blocks.length; bi++) {
      const code = t.blocks[bi];
      const stdout = t.stdouts[bi] ?? "";
      const codeLines = code.trim().split("\n");
      for (const cl of codeLines) {
        container.addChild(
          new Text(`${indent}${theme.fg("toolOutput", "│ " + cl)}`, 0, 0),
        );
      }
      if (stdout) {
        container.addChild(
          new Text(`${indent}${theme.fg("muted", "→ stdout:")}`, 0, 0),
        );
        for (const sl of stdout.split("\n")) {
          container.addChild(
            new Text(`${indent}${theme.fg("dim", "  " + sl)}`, 0, 0),
          );
        }
      }
    }

  }

  // Child investigations shown in completion order at the end of the parent
  // block. Perfect turn-to-child attribution would need per-block RPC
  // tracking that we don't currently collect.
  if (inv.child_investigations.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${indent}${theme.fg("muted", `─── ${inv.child_investigations.length} child investigation${inv.child_investigations.length > 1 ? "s" : ""} ───`)}`,
        0,
        0,
      ),
    );
    for (const child of inv.child_investigations) {
      container.addChild(new Spacer(1));
      const childIcon = statusIcon(
        child.terminated_reason,
        theme,
        false,
      );
      container.addChild(
        new TruncatedText(
          `${indent}${childIcon} ${theme.fg("dim", `d${child.depth}: ${child.question}`)} ${theme.fg("muted", `· ${child.turns.length} turns · $${child.total_cost.toFixed(4)} · ${child.terminated_reason}`)}`,
          0,
          0,
        ),
      );
      appendInvestigationBody(container, child, theme, depth + 1);
    }
  }
}

// =============================================================================
// Extension entry
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool(rlmQueryTool);
}

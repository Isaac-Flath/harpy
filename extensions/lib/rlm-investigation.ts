import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import type { Readable, Writable } from "stream";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import { callLM, callLMBatched, extractText } from "./rlm-piai.js";
import { RLM_SYSTEM_PROMPT } from "./rlm-prompts.js";
import { makeSemaphore } from "./semaphore.js";
import { InvestigationLogger } from "./rlm-investigation-log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminatedReason =
  | "final"
  | "no_code_blocks"
  | "max_iterations"
  | "budget_exceeded";

// Handlers return values the model sees in Python. Strings and lists are
// mapped directly — no nested cost/answer objects (keeps the REPL ergonomic).
export interface RpcHandlers {
  kb_search: (params: {
    query: string;
    k?: number;
    scope?: string;
    pattern?: string | null;
  }) => Promise<unknown>;
  kb_read: (params: { path: string }) => Promise<string>;
  llm_query: (params: {
    prompt: string;
    model?: string | null;
  }) => Promise<string>;
  llm_query_batched: (params: {
    prompts: string[];
    model?: string | null;
  }) => Promise<string[]>;
  rlm_query: (params: {
    prompt: string;
    context?: unknown;
    model?: string | null;
  }) => Promise<string>;
  rlm_query_batched: (params: {
    prompts: string[];
    contexts?: unknown[];
    model?: string | null;
  }) => Promise<string[]>;
}

export interface InvestigationOptions {
  question: string;
  leads: unknown;
  depth: number;
  /**
   * How many layers of actual recursion `rlm_query` can do. 0 = no recursion
   * (rlm_query short-circuits to llm_query). 1 = one level (parent spawns
   * children, children short-circuit). Etc.
   */
  maxRecursiveCalls: number;
  maxIterations: number;
  maxBudget: number;
  investigatorModel: Model<Api>;
  analystModel: Model<Api>;
  modelRegistry: ModelRegistry;
  log?: InvestigationLogger;
  signal?: AbortSignal;
  onUpdate?: (ev: InvestigationUpdateEvent) => void;
}

export interface InvestigationUpdateEvent {
  depth: number;
  turn: number;
  cumulativeCost: number;
}

export interface BlockResult {
  stdout: string;
  stdout_truncated?: boolean;
  stderr: string;
  error?: string;
  final_answer?: unknown;
}

export interface TurnLog {
  blocks: string[];
  blockResults: BlockResult[];
  lmCost: number;
}

export interface InvestigationResult {
  answer: string | undefined;
  terminatedReason: TerminatedReason;
  totalCost: number;
  turns: TurnLog[];
  childInvestigations: InvestigationResult[];
}

// ---------------------------------------------------------------------------
// Python subprocess management
// ---------------------------------------------------------------------------

const REPL_HOST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "repl-host.py",
);

// One merged event stream from the Python subprocess.
// stdout lines and ctrl-fd frames both land in the same queue, tagged by source.
// Exactly one consumer (execAndServeRpcs) pulls events. This avoids the stale-
// resolver leak that a Promise.race over two separate readers would create.

type ProcEvent =
  | { src: "stdout"; line: string }
  | { src: "ctrl"; frame: Buffer }
  | { src: "end" };

interface Proc {
  child: ChildProcess;
  stdin: Writable;
  ctrlIn: Writable; // fd 3 on child — we write, child reads (RPC responses)
  events: EventQueue;
}

class EventQueue {
  private items: ProcEvent[] = [];
  private waiter: ((ev: ProcEvent) => void) | null = null;

  push(ev: ProcEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(ev);
    } else {
      this.items.push(ev);
    }
  }

  take(): Promise<ProcEvent> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    if (this.waiter) {
      throw new Error("EventQueue: concurrent take() not allowed");
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

function spawnReplHost(): Proc {
  const child = spawn("uv", ["run", REPL_HOST_PATH], {
    stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout || !child.stdio[3] || !child.stdio[4]) {
    throw new Error("Failed to open Python subprocess pipes");
  }

  const events = new EventQueue();

  // Line reader on stdout
  {
    let buffer = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        events.push({ src: "stdout", line });
      }
    });
    child.stdout.on("end", () => events.push({ src: "end" }));
  }

  // Length-prefixed frame reader on fd 4
  {
    let buffer: Buffer = Buffer.alloc(0);
    const ctrlOut = child.stdio[4] as Readable;
    ctrlOut.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (buffer.length < 4) break;
        const n = buffer.readUInt32BE(0);
        if (buffer.length < 4 + n) break;
        const frame = buffer.subarray(4, 4 + n);
        buffer = buffer.subarray(4 + n);
        events.push({ src: "ctrl", frame: Buffer.from(frame) });
      }
    });
    ctrlOut.on("end", () => events.push({ src: "end" }));
  }

  return {
    child,
    stdin: child.stdin,
    ctrlIn: child.stdio[3] as Writable,
    events,
  };
}

async function sendOp(proc: Proc, op: object): Promise<void> {
  proc.stdin.write(JSON.stringify(op) + "\n");
}

function writeFrame(stream: Writable, obj: unknown): void {
  const payload = Buffer.from(JSON.stringify(obj), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  stream.write(Buffer.concat([header, payload]));
}

// ---------------------------------------------------------------------------
// Code block parsing
// ---------------------------------------------------------------------------

function parsePythonBlocks(text: string): string[] {
  // Only ```repl fences execute. ```python blocks are treated as illustrative
  // prose (so the model can quote Python without accidentally triggering exec).
  const blocks: string[] = [];
  const regex = /```repl\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Exec one code block + service RPC calls until done
// ---------------------------------------------------------------------------

async function execAndServeRpcs(
  proc: Proc,
  code: string,
  handlers: RpcHandlers,
  log: InvestigationLogger | undefined,
  depth: number,
  invId: string,
): Promise<BlockResult> {
  sendOp(proc, { op: "exec", code });

  while (true) {
    const ev = await proc.events.take();

    if (ev.src === "end") {
      throw new Error("Python subprocess closed unexpectedly during exec");
    }

    if (ev.src === "stdout") {
      // Exec completed — parse and return the result frame.
      return JSON.parse(ev.line) as BlockResult;
    }

    // RPC request from child — service and reply, then keep pulling events.
    const req = JSON.parse(ev.frame.toString("utf-8")) as {
      method: keyof RpcHandlers;
      params: Record<string, unknown>;
    };
    const startMs = Date.now();
    let response: { result?: unknown; error?: string };
    try {
      const handler = handlers[req.method];
      if (!handler) throw new Error(`unhandled RPC: ${req.method}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (handler as any)(req.params);
      response = { result };
    } catch (e) {
      response = { error: e instanceof Error ? e.message : String(e) };
    }
    log?.write({
      type: "rpc_call",
      depth,
      inv_id: invId,
      method: req.method,
      params: summarizeParams(req.method, req.params),
      duration_ms: Date.now() - startMs,
      ok: response.error === undefined,
      error: response.error,
    });
    writeFrame(proc.ctrlIn, response);
  }
}

function summarizeParams(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  // Don't bloat the log with full prompts; summarize lengths.
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v.length > 200) {
      summary[k] = `<${v.length} chars>`;
    } else if (Array.isArray(v)) {
      summary[k] = `<array of ${v.length}>`;
    } else {
      summary[k] = v;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Main investigation loop
// ---------------------------------------------------------------------------

export async function runInvestigation(
  opts: InvestigationOptions,
): Promise<InvestigationResult> {
  const proc = spawnReplHost();
  const log = opts.log;
  const invId = randomUUID().slice(0, 8);
  const childInvestigations: InvestigationResult[] = [];
  const turns: TurnLog[] = [];
  let cumulativeCost = 0;
  let finalAnswer: string | undefined;
  let terminatedReason: TerminatedReason = "max_iterations";

  const model =
    opts.depth === 0 ? opts.investigatorModel : opts.analystModel;

  try {
    // Load leads into the REPL as the `context` variable (paper-compat name).
    sendOp(proc, { op: "load_context", context: opts.leads });
    const ack = await proc.events.take();
    if (ack.src !== "stdout") {
      throw new Error(
        `expected stdout ack after load_context, got ${ack.src}`,
      );
    }

    log?.write({
      type: "investigation_start",
      depth: opts.depth,
      inv_id: invId,
      question: opts.question,
      investigator_model: opts.investigatorModel.id,
      analyst_model: opts.analystModel.id,
      max_recursive_calls: opts.maxRecursiveCalls,
      max_iterations: opts.maxIterations,
      max_budget: opts.maxBudget,
      initial_leads_kind: Array.isArray(opts.leads)
        ? `list[${opts.leads.length}]`
        : typeof opts.leads,
    });

    // RPC handlers for this investigation
    const handlers: RpcHandlers = makeHandlers(
      opts,
      log,
      invId,
      (cost) => {
        cumulativeCost += cost;
      },
      (child) => {
        childInvestigations.push(child);
      },
      () => cumulativeCost,
    );

    // History starts with the user question
    const history: Message[] = [
      { role: "user", content: opts.question, timestamp: Date.now() },
    ];

    for (let i = 0; i < opts.maxIterations; i++) {
      if (cumulativeCost >= opts.maxBudget) {
        terminatedReason = "budget_exceeded";
        break;
      }

      log?.write({
        type: "turn_start",
        depth: opts.depth,
        inv_id: invId,
        i: i + 1,
      });

      // Call LM
      const assistant = await callLM({
        model,
        modelRegistry: opts.modelRegistry,
        systemPrompt: RLM_SYSTEM_PROMPT,
        messages: history,
        signal: opts.signal,
      });
      const lmCost = assistant.usage.cost?.total ?? 0;
      cumulativeCost += lmCost;
      history.push(assistant);
      const assistantText = extractText(assistant);

      log?.write({
        type: "assistant_message",
        depth: opts.depth,
        inv_id: invId,
        i: i + 1,
        text: assistantText,
        stop_reason: assistant.stopReason,
      });

      // Diagnostic: log the content-type distribution if text is empty.
      if (assistantText.length === 0) {
        const contentTypes = assistant.content.map((c) => c.type);
        log?.write({
          type: "empty_assistant_text",
          depth: opts.depth,
          inv_id: invId,
          i: i + 1,
          content_types: contentTypes,
          stop_reason: assistant.stopReason,
          content_sample: JSON.stringify(assistant.content).slice(0, 2000),
        });
      }

      // Parse code blocks
      const blocks = parsePythonBlocks(assistantText);
      if (blocks.length === 0) {
        turns.push({ blocks: [], blockResults: [], lmCost });
        log?.write({
          type: "turn_end",
          depth: opts.depth,
          inv_id: invId,
          i: i + 1,
          lm_cost: lmCost,
          cumulative_cost: cumulativeCost,
          blocks: 0,
        });
        terminatedReason = "no_code_blocks";
        break;
      }

      // Exec each block
      const blockResults: BlockResult[] = [];
      for (let b = 0; b < blocks.length; b++) {
        const code = blocks[b];
        log?.write({
          type: "code_block",
          depth: opts.depth,
          inv_id: invId,
          i: i + 1,
          block_index: b,
          code,
        });
        const result = await execAndServeRpcs(
          proc,
          code,
          handlers,
          log,
          opts.depth,
          invId,
        );
        log?.write({
          type: "block_result",
          depth: opts.depth,
          inv_id: invId,
          i: i + 1,
          block_index: b,
          stdout: result.stdout,
          stdout_truncated: result.stdout_truncated ?? false,
          stderr: result.stderr,
          error: result.error,
          final_answer: result.final_answer,
        });
        blockResults.push(result);
        if (result.final_answer !== undefined) {
          finalAnswer =
            typeof result.final_answer === "string"
              ? result.final_answer
              : JSON.stringify(result.final_answer, null, 2);
          terminatedReason = "final";
          break;
        }
      }

      turns.push({ blocks, blockResults, lmCost });
      log?.write({
        type: "turn_end",
        depth: opts.depth,
        inv_id: invId,
        i: i + 1,
        lm_cost: lmCost,
        cumulative_cost: cumulativeCost,
        blocks: blocks.length,
        final_emitted: finalAnswer !== undefined,
      });

      opts.onUpdate?.({
        depth: opts.depth,
        turn: i + 1,
        cumulativeCost,
      });

      if (finalAnswer !== undefined) break;

      // Format block results and append as user message
      history.push({
        role: "user",
        content: formatBlockResults(blocks, blockResults),
        timestamp: Date.now(),
      });
    }

    log?.write({
      type: "investigation_end",
      depth: opts.depth,
      inv_id: invId,
      terminated_reason: terminatedReason,
      answer_set: finalAnswer !== undefined,
      total_cost: cumulativeCost,
      turns: turns.length,
      final_answer: finalAnswer,
    });

    return {
      answer: finalAnswer,
      terminatedReason,
      totalCost: cumulativeCost,
      turns,
      childInvestigations,
    };
  } finally {
    try {
      sendOp(proc, { op: "shutdown" });
    } catch {
      /* ignore */
    }
    proc.child.kill();
  }
}

function formatBlockResults(blocks: string[], results: BlockResult[]): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const r = results[i];
    if (!r) continue;
    const pieces: string[] = [];
    if (r.stdout) {
      const note = r.stdout_truncated ? " (truncated at 20000 chars)" : "";
      pieces.push(`stdout${note}:\n${r.stdout}`);
    }
    if (r.stderr) pieces.push(`stderr:\n${r.stderr}`);
    if (r.error) pieces.push(`exception:\n${r.error}`);
    if (r.final_answer !== undefined) {
      pieces.push(`FINAL emitted`);
    }
    parts.push(
      `[block ${i + 1}]\n${pieces.join("\n\n") || "(no output)"}`,
    );
  }
  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// RPC handlers: KB, LM, recursion
// ---------------------------------------------------------------------------

function makeHandlers(
  opts: InvestigationOptions,
  log: InvestigationLogger | undefined,
  invId: string,
  onCost: (cost: number) => void,
  onChildInvestigation: (child: InvestigationResult) => void,
  getCumulativeCost: () => number,
): RpcHandlers {
  // With maxRecursiveCalls being "how many layers rlm_query can recurse",
  // the investigation at depth D can spawn a child (bringing it to D+1) as
  // long as D < maxRecursiveCalls. So depth 0 recurses when maxRecursiveCalls
  // >= 1; depth 1 recurses when maxRecursiveCalls >= 2; etc.
  const nextDepth = opts.depth + 1;
  const willRecurse = opts.depth < opts.maxRecursiveCalls;

  return {
    kb_search: async (params) => {
      return runAgentkbSearch(
        params.query,
        params.k ?? 5,
        params.scope ?? "wiki",
        params.pattern ?? null,
      );
    },

    kb_read: async (params) => {
      return readWikiFile(params.path);
    },

    llm_query: async (params) => {
      const msg = await callLM({
        model: opts.analystModel,
        modelRegistry: opts.modelRegistry,
        messages: [
          { role: "user", content: params.prompt, timestamp: Date.now() },
        ],
        signal: opts.signal,
      });
      onCost(msg.usage.cost?.total ?? 0);
      return extractText(msg);
    },

    llm_query_batched: async (params) => {
      const { messages, totalCost } = await callLMBatched({
        model: opts.analystModel,
        modelRegistry: opts.modelRegistry,
        prompts: params.prompts,
        signal: opts.signal,
      });
      onCost(totalCost);
      return messages.map(extractText);
    },

    rlm_query: async (params) => {
      if (!willRecurse) {
        const msg = await callLM({
          model: opts.analystModel,
          modelRegistry: opts.modelRegistry,
          messages: [
            { role: "user", content: params.prompt, timestamp: Date.now() },
          ],
          signal: opts.signal,
        });
        const cost = msg.usage.cost?.total ?? 0;
        onCost(cost);
        log?.write({
          type: "rlm_query_short_circuit",
          depth: opts.depth,
          inv_id: invId,
          reason: "max_recursive_calls_cap",
          cost,
        });
        return extractText(msg);
      }

      const remainingBudget = opts.maxBudget - getCumulativeCost();
      const child = await runInvestigation({
        question: params.prompt,
        leads: params.context ?? params.prompt,
        depth: nextDepth,
        maxRecursiveCalls: opts.maxRecursiveCalls,
        maxIterations: opts.maxIterations,
        maxBudget: Math.max(remainingBudget, 0),
        investigatorModel: opts.investigatorModel,
        analystModel: opts.analystModel,
        modelRegistry: opts.modelRegistry,
        log,
        signal: opts.signal,
      });
      onCost(child.totalCost);
      onChildInvestigation(child);
      return child.answer ?? "";
    },

    rlm_query_batched: async (params) => {
      if (!willRecurse) {
        const { messages, totalCost } = await callLMBatched({
          model: opts.analystModel,
          modelRegistry: opts.modelRegistry,
          prompts: params.prompts,
          signal: opts.signal,
          concurrency: 4,
        });
        onCost(totalCost);
        log?.write({
          type: "rlm_query_batched_short_circuit",
          depth: opts.depth,
          inv_id: invId,
          reason: "max_recursive_calls_cap",
          cost: totalCost,
          count: params.prompts.length,
        });
        return messages.map(extractText);
      }

      const baseBudget = Math.max(opts.maxBudget - getCumulativeCost(), 0);
      const perChildBudget = baseBudget / Math.max(params.prompts.length, 1);
      const limit = makeSemaphore(4);
      const promises = params.prompts.map((prompt, i) => {
        const childLeads = params.contexts?.[i] ?? prompt;
        return limit(async () =>
          runInvestigation({
            question: prompt,
            leads: childLeads,
            depth: nextDepth,
            maxRecursiveCalls: opts.maxRecursiveCalls,
            maxIterations: opts.maxIterations,
            maxBudget: perChildBudget,
            investigatorModel: opts.investigatorModel,
            analystModel: opts.analystModel,
            modelRegistry: opts.modelRegistry,
            log,
            signal: opts.signal,
          }),
        );
      });
      const children = await Promise.all(promises);
      let totalCost = 0;
      for (const child of children) {
        onChildInvestigation(child);
        totalCost += child.totalCost;
      }
      onCost(totalCost);
      return children.map((c) => c.answer ?? "");
    },
  };
}

// ---------------------------------------------------------------------------
// KB shims (stdlib-only — mirror extensions/agentkb.ts patterns)
// ---------------------------------------------------------------------------

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { resolve as resolvePath, relative, isAbsolute } from "path";
const execFileP = promisify(execFile);

interface AgentkbSettings {
  resolved_paths: {
    wiki_pages: string;
    wiki_sources: string;
    chats_readable: string;
    communications_root: string;
  };
}

interface KbRoots {
  wikiPages: string;
  wikiSources: string;
  chatsReadable: string;
  communicationsRoot: string;
}

let cachedKbRoots: KbRoots | undefined;

async function getKbRoots(): Promise<KbRoots> {
  if (cachedKbRoots) return cachedKbRoots;
  const { stdout } = await execFileP("agentkb", ["settings", "--json"], {
    timeout: 30_000,
  });
  const settings = JSON.parse(stdout) as AgentkbSettings;
  cachedKbRoots = {
    wikiPages: resolvePath(settings.resolved_paths.wiki_pages),
    wikiSources: resolvePath(settings.resolved_paths.wiki_sources),
    chatsReadable: resolvePath(settings.resolved_paths.chats_readable),
    communicationsRoot: resolvePath(
      settings.resolved_paths.communications_root,
    ),
  };
  return cachedKbRoots;
}

/**
 * Seed initial leads for the investigator's `context` variable.
 *
 * When `scope` is undefined (the default), fan out across three slices so no
 * single source dominates: hand-curated wiki notes (`wiki:notes`), fetched
 * source references (`wiki:source`), and chat history (`chats`). Each gets
 * `k` hits, concatenated — so a default k=30 yields 90 mixed leads. Each hit
 * keeps its `collection` field so the investigator can filter by source.
 *
 * When `scope` is an explicit string, behave as before: single-store seed.
 */
export const MIXED_SEED_SCOPES = ["wiki:notes", "wiki:source", "chats"] as const;

export async function seedLeadsFromAgentkb(
  query: string,
  k: number,
  scope: string | undefined,
): Promise<unknown[]> {
  if (scope === undefined) {
    const perStore = await Promise.all(
      MIXED_SEED_SCOPES.map((s) => runAgentkbSearch(query, k, s, null)),
    );
    const merged: unknown[] = [];
    for (const hits of perStore) {
      if (Array.isArray(hits)) merged.push(...hits);
    }
    return merged;
  }
  const results = await runAgentkbSearch(query, k, scope, null);
  return Array.isArray(results) ? results : [];
}

export async function runAgentkbSearch(
  query: string,
  k: number,
  scope: string,
  pattern: string | null,
): Promise<unknown> {
  const args = ["search", "-s", scope, "-k", String(k), "--json"];
  if (pattern) args.push("-e", pattern);
  args.push(query);
  const { stdout } = await execFileP("agentkb", args, {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { results?: unknown[] };
  return (parsed.results ?? []).map(normalizeKbHit);
}

// agentkb returns {file, content, ...}. Our system prompt documents
// {path, score, snippet, ...}. Normalize so the two line up.
//
// We pass agentkb's content through as-is rather than re-truncating. agentkb
// already chunks content to a bounded size (~500-2000 chars typically). Letting
// the model see the full chunk in `snippet` improves filter quality with only
// a tiny increase in filter-prompt tokens.
function normalizeKbHit(h: unknown): unknown {
  if (typeof h !== "object" || h === null) return h;
  const r = h as Record<string, unknown>;
  return {
    path: r.file ?? r.path,
    score: r.score,
    snippet: r.content,
    title: r.title,
    section: r.section,
    tags: r.tags,
    collection: r.collection,
    line: r.line,
  };
}

export async function readWikiFile(path: string): Promise<string> {
  const roots = await getKbRoots();

  // agentkb search results return paths with a collection-aware prefix:
  //   - `wiki/foo.md`           → resolves under wiki_pages
  //   - `sources/refs/foo.md`   → resolves under wiki_sources (strip `sources/`)
  //   - `YYYY-MM/foo.md`        → resolves under chats_readable
  // If the prefix doesn't match any, we fall back to trying all stores.
  const candidates: { root: string; rel: string; label: string }[] = [];

  if (path.startsWith("wiki/")) {
    candidates.push({
      root: roots.wikiPages,
      rel: path.slice("wiki/".length),
      label: "wiki",
    });
  } else if (path.startsWith("sources/")) {
    candidates.push({
      root: roots.wikiSources,
      rel: path.slice("sources/".length),
      label: "wiki:source",
    });
  } else if (/^\d{4}-\d{2}\//.test(path)) {
    candidates.push({
      root: roots.chatsReadable,
      rel: path,
      label: "chats",
    });
  } else {
    candidates.push(
      { root: roots.wikiPages, rel: path, label: "wiki" },
      { root: roots.wikiSources, rel: path, label: "wiki:source" },
      { root: roots.chatsReadable, rel: path, label: "chats" },
      { root: roots.communicationsRoot, rel: path, label: "communications" },
    );
  }

  const attempted: string[] = [];
  for (const { root, rel, label } of candidates) {
    const fullPath = resolvePath(root, rel);
    const relCheck = relative(root, fullPath);
    if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
      attempted.push(`${label}: path escapes root`);
      continue;
    }
    try {
      return readFileSync(fullPath, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      attempted.push(`${label}: ${fullPath}`);
    }
  }
  throw new Error(
    `kb page not found: ${path} (tried: ${attempted.join("; ")})`,
  );
}

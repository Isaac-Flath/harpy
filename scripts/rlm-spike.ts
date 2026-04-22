/**
 * RLM spike — standalone CLI that exercises the full investigation pipeline
 * end-to-end without the pi extension wrapper.
 *
 * Usage:
 *   npx tsx scripts/rlm-spike.ts "your question here"
 *
 * Side effects:
 *   - spawns `agentkb search ...` to seed leads
 *   - spawns `uv run extensions/lib/repl-host.py` for the Python REPL
 *   - writes NDJSON investigation log to ~/.agentkb/rlm-logs/
 *   - prints final answer + log path to stdout
 */

import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

import {
  runInvestigation,
  seedLeadsFromAgentkb,
} from "../extensions/lib/rlm-investigation.js";
import {
  InvestigationLogger,
  defaultLogPath,
} from "../extensions/lib/rlm-investigation-log.js";

const DEFAULT_INVESTIGATOR_PROVIDER = "openai-codex";
const DEFAULT_INVESTIGATOR_MODEL_ID = "gpt-5.4";
const DEFAULT_ANALYST_PROVIDER = "openai-codex";
const DEFAULT_ANALYST_MODEL_ID = "gpt-5.4-mini";

const DEFAULT_K = 30;
const DEFAULT_MAX_ITER = 40;
const DEFAULT_MAX_BUDGET = 1.0;
const DEFAULT_MAX_RECURSIVE_CALLS = 2;

async function main() {
  const args = process.argv.slice(2);
  let maxRecursiveCalls = DEFAULT_MAX_RECURSIVE_CALLS;
  let investigatorProvider = DEFAULT_INVESTIGATOR_PROVIDER;
  let investigatorModelId = DEFAULT_INVESTIGATOR_MODEL_ID;
  let analystProvider = DEFAULT_ANALYST_PROVIDER;
  let analystModelId = DEFAULT_ANALYST_MODEL_ID;
  // undefined = mixed seed (wiki:notes + wiki:source + chats, k each)
  let scope: string | undefined = undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-recursive-calls" || args[i] === "-r") {
      maxRecursiveCalls = parseInt(args[++i], 10);
    } else if (args[i] === "--investigator-provider") {
      investigatorProvider = args[++i];
    } else if (args[i] === "--investigator-model") {
      investigatorModelId = args[++i];
    } else if (args[i] === "--analyst-provider") {
      analystProvider = args[++i];
    } else if (args[i] === "--analyst-model") {
      analystModelId = args[++i];
    } else if (args[i] === "--scope" || args[i] === "-s") {
      scope = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  const question = positional[0];
  if (!question) {
    console.error(
      "usage: tsx scripts/rlm-spike.ts [--max-recursive-calls N] [--investigator-provider P] [--investigator-model M] [--analyst-provider P] [--analyst-model M] <question>",
    );
    process.exit(1);
  }

  console.error(`[spike] question: ${JSON.stringify(question)}`);

  // Seed leads from agentkb
  const scopeLabel = scope ?? "mixed(wiki:notes+wiki:source+chats)";
  console.error(
    `[spike] seeding leads from agentkb search (scope=${scopeLabel}, k=${DEFAULT_K}${scope === undefined ? " per store" : ""})...`,
  );
  const initialLeads = await seedLeadsFromAgentkb(
    question,
    DEFAULT_K,
    scope,
  );
  console.error(`[spike] initial leads: ${initialLeads.length} hits`);
  if (Array.isArray(initialLeads) && initialLeads.length > 0) {
    const byCollection: Record<string, number> = {};
    for (const h of initialLeads) {
      const c = (h as { collection?: string }).collection ?? "unknown";
      byCollection[c] = (byCollection[c] ?? 0) + 1;
    }
    console.error(`[spike] by collection:`, byCollection);
  }

  // Bootstrap AuthStorage + ModelRegistry (standalone — mimics what pi does internally)
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const investigatorModel = modelRegistry.find(
    investigatorProvider,
    investigatorModelId,
  );
  if (!investigatorModel) {
    throw new Error(
      `investigator model ${investigatorProvider}/${investigatorModelId} not found in registry`,
    );
  }
  const analystModel = modelRegistry.find(analystProvider, analystModelId);
  if (!analystModel) {
    throw new Error(
      `analyst model ${analystProvider}/${analystModelId} not found in registry`,
    );
  }

  // Investigation log
  const logPath = defaultLogPath("spike");
  const log = new InvestigationLogger(logPath);
  log.write({
    type: "metadata",
    depth: 0,
    question,
    initial_leads_count: Array.isArray(initialLeads)
      ? initialLeads.length
      : 0,
    investigator_model: investigatorModel.id,
    analyst_model: analystModel.id,
    max_iterations: DEFAULT_MAX_ITER,
    max_recursive_calls: maxRecursiveCalls,
    max_budget: DEFAULT_MAX_BUDGET,
  });

  // Run investigation
  const t0 = Date.now();
  const result = await runInvestigation({
    question,
    leads: initialLeads,
    depth: 0,
    maxRecursiveCalls,
    maxIterations: DEFAULT_MAX_ITER,
    maxBudget: DEFAULT_MAX_BUDGET,
    investigatorModel,
    analystModel,
    modelRegistry,
    log,
    onUpdate: (ev) => {
      console.error(
        `[spike] depth=${ev.depth} turn=${ev.turn} cumulative_cost=$${ev.cumulativeCost.toFixed(4)}`,
      );
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

  console.error(`[spike] terminated_reason: ${result.terminatedReason}`);
  console.error(
    `[spike] turns: ${result.turns.length}, cost: $${result.totalCost.toFixed(4)}, elapsed: ${elapsedMs}ms`,
  );
  console.error(`[spike] log: ${logPath}`);
  console.error("");
  console.error("=== ANSWER ===");
  console.log(result.answer ?? "(no FINAL emitted)");
}

main().catch((e) => {
  console.error("[spike] error:", e);
  process.exit(1);
});

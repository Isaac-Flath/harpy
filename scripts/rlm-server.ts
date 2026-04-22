/**
 * Local RPC server for RLM notebooks — exposes the same primitives the
 * in-harness REPL uses (kb_search, kb_read, llm_query, rlm_query, ...) over
 * HTTP on localhost, so a Jupyter notebook can rerun investigation cells
 * against live models.
 *
 * Usage (invoked by a notebook's bootstrap cell, not by hand):
 *   npx tsx scripts/rlm-server.ts \
 *     --investigator-provider openai-codex --investigator-model gpt-5.4 \
 *     --analyst-provider openai-codex --analyst-model gpt-5.4-mini
 *
 * Handshake:
 *   The very first line on stdout is a JSON object: {"port": N, "token": "..."}.
 *   The client reads this, then uses the port + token to make requests.
 *
 * Auth:
 *   Every request must carry X-RLM-Token: <token>. Anything else → 401.
 *   Listens only on 127.0.0.1.
 *
 * Routes (all POST, JSON body in, JSON out):
 *   /kb_search            {query, k?, scope?, pattern?}    → {result: hits[]}
 *   /kb_read              {path}                           → {result: string}
 *   /llm_query            {prompt, model?}                 → {result: string}
 *   /llm_query_batched    {prompts, model?}                → {result: string[]}
 *   /rlm_query            {prompt, context?, model?, max_iterations?,
 *                          max_recursive_calls?, max_budget?}  → {result: string}
 *   /rlm_query_batched    {prompts, contexts?, model?}     → {result: string[]}
 *
 * Error responses: {error: "..."}. Process exits on SIGTERM/SIGINT.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomBytes } from "crypto";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import {
  runAgentkbSearch,
  readWikiFile,
  runInvestigation,
} from "../extensions/lib/rlm-investigation.js";
import { callLM, callLMBatched, extractText } from "../extensions/lib/rlm-piai.js";

// ----- CLI args --------------------------------------------------------------

interface Args {
  investigatorProvider: string;
  investigatorModel: string;
  analystProvider: string;
  analystModel: string;
  maxIterations: number;
  maxRecursiveCalls: number;
  maxBudget: number;
}

function parseArgs(): Args {
  const a: Args = {
    investigatorProvider: "openai-codex",
    investigatorModel: "gpt-5.4",
    analystProvider: "openai-codex",
    analystModel: "gpt-5.4-mini",
    maxIterations: 30,
    maxRecursiveCalls: 0,
    maxBudget: 0.5,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--investigator-provider") {
      a.investigatorProvider = v;
      i++;
    } else if (k === "--investigator-model") {
      a.investigatorModel = v;
      i++;
    } else if (k === "--analyst-provider") {
      a.analystProvider = v;
      i++;
    } else if (k === "--analyst-model") {
      a.analystModel = v;
      i++;
    } else if (k === "--max-iterations") {
      a.maxIterations = parseInt(v, 10);
      i++;
    } else if (k === "--max-recursive-calls") {
      a.maxRecursiveCalls = parseInt(v, 10);
      i++;
    } else if (k === "--max-budget") {
      a.maxBudget = parseFloat(v);
      i++;
    }
  }
  return a;
}

// ----- HTTP helpers ----------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf-8");
  if (!body) return {};
  return JSON.parse(body);
}

function writeJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ----- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const token = randomBytes(16).toString("hex");

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const investigatorModel = modelRegistry.find(
    args.investigatorProvider,
    args.investigatorModel,
  );
  if (!investigatorModel) {
    throw new Error(
      `investigator model ${args.investigatorProvider}/${args.investigatorModel} not found`,
    );
  }
  const analystModel = modelRegistry.find(
    args.analystProvider,
    args.analystModel,
  );
  if (!analystModel) {
    throw new Error(
      `analyst model ${args.analystProvider}/${args.analystModel} not found`,
    );
  }

  // Resolve which model a method should use. `modelOverride` (from the request
  // body) wins over defaults; if only an id is given, we try to find it in the
  // registry using the analyst's provider as the best-guess default.
  function resolveModel(
    modelOverride: string | null | undefined,
    fallback: Model<Api>,
  ): Model<Api> {
    if (!modelOverride) return fallback;
    // If override looks like "provider/id", split. Otherwise assume analyst provider.
    let provider = args.analystProvider;
    let id = modelOverride;
    const slash = modelOverride.indexOf("/");
    if (slash > 0) {
      provider = modelOverride.slice(0, slash);
      id = modelOverride.slice(slash + 1);
    }
    const m = modelRegistry.find(provider, id);
    if (!m) {
      throw new Error(`model not found: ${provider}/${id}`);
    }
    return m;
  }

  type Handler = (body: Record<string, unknown>) => Promise<unknown>;

  const routes: Record<string, Handler> = {
    "/kb_search": async (body) => {
      return runAgentkbSearch(
        body.query as string,
        (body.k as number) ?? 5,
        (body.scope as string) ?? "wiki",
        (body.pattern as string | null) ?? null,
      );
    },
    "/kb_read": async (body) => {
      return readWikiFile(body.path as string);
    },
    "/llm_query": async (body) => {
      const model = resolveModel(
        body.model as string | null | undefined,
        analystModel,
      );
      const msg = await callLM({
        model,
        modelRegistry,
        messages: [
          { role: "user", content: body.prompt as string, timestamp: Date.now() },
        ],
      });
      return extractText(msg);
    },
    "/llm_query_batched": async (body) => {
      const model = resolveModel(
        body.model as string | null | undefined,
        analystModel,
      );
      const { messages } = await callLMBatched({
        model,
        modelRegistry,
        prompts: body.prompts as string[],
      });
      return messages.map(extractText);
    },
    "/rlm_query": async (body) => {
      const child = await runInvestigation({
        question: body.prompt as string,
        leads: body.context ?? body.prompt,
        depth: 0,
        maxRecursiveCalls:
          (body.max_recursive_calls as number) ?? args.maxRecursiveCalls,
        maxIterations: (body.max_iterations as number) ?? args.maxIterations,
        maxBudget: (body.max_budget as number) ?? args.maxBudget,
        investigatorModel,
        analystModel,
        modelRegistry,
      });
      return child.answer ?? "";
    },
    "/rlm_query_batched": async (body) => {
      const prompts = body.prompts as string[];
      const contexts = body.contexts as unknown[] | undefined;
      const results = await Promise.all(
        prompts.map((prompt, i) =>
          runInvestigation({
            question: prompt,
            leads: contexts?.[i] ?? prompt,
            depth: 0,
            maxRecursiveCalls:
              (body.max_recursive_calls as number) ?? args.maxRecursiveCalls,
            maxIterations: (body.max_iterations as number) ?? args.maxIterations,
            maxBudget: (body.max_budget as number) ?? args.maxBudget,
            investigatorModel,
            analystModel,
            modelRegistry,
          }),
        ),
      );
      return results.map((r) => r.answer ?? "");
    },
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      const tokenHeader = req.headers["x-rlm-token"];
      if (tokenHeader !== token) {
        writeJson(res, 401, { error: "bad token" });
        return;
      }
      const handler = routes[req.url ?? ""];
      if (!handler) {
        writeJson(res, 404, { error: `unknown route: ${req.url}` });
        return;
      }
      const body = (await readJson(req)) as Record<string, unknown>;
      const result = await handler(body);
      writeJson(res, 200, { result });
    } catch (e) {
      writeJson(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("failed to bind");
    }
    // Handshake: first line on stdout is JSON with the port and token.
    // Anything the notebook prints after this is runtime noise.
    process.stdout.write(
      JSON.stringify({ port: addr.port, token }) + "\n",
    );
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  process.stderr.write(
    `rlm-server fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
  );
  process.exit(1);
});

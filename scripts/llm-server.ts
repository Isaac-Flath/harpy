/**
 * Local HTTP server that exposes cheap LLM calls for Python scripts.
 *
 * The agent can write and run Python scripts that import `harpy_llm`, which
 * auto-starts this server and calls its endpoints. Auth and model resolution
 * are handled here via Pi's ModelRegistry, so the Python side stays thin.
 *
 * Usage (invoked automatically by harpy_llm, or by hand):
 *   npx tsx scripts/llm-server.ts \
 *     --provider openai-codex --model gpt-5.4-mini
 *
 * Handshake:
 *   The very first line on stdout is a JSON object: {"port": N, "token": "..."}.
 *   The client reads this, then uses the port + token to make requests.
 *
 * Auth:
 *   Every request must carry X-Harpy-Token: <token>. Anything else → 401.
 *   Listens only on 127.0.0.1.
 *
 * Routes (all POST, JSON body in, JSON out):
 *   /llm_query          {prompt, model?}    → {result: string}
 *   /llm_query_batched  {prompts, model?}   → {result: string[]}
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

import { callLM, callLMBatched, extractText } from "../extensions/lib/llm.js";

// ----- CLI args --------------------------------------------------------------

interface Args {
  provider: string;
  model: string;
}

function parseArgs(): Args {
  const a: Args = {
    provider: "openai-codex",
    model: "gpt-5.4-mini",
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--provider") {
      a.provider = v;
      i++;
    } else if (k === "--model") {
      a.model = v;
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

  const found = modelRegistry.find(args.provider, args.model);
  if (!found) {
    throw new Error(
      `model ${args.provider}/${args.model} not found in registry`,
    );
  }
  const defaultModel: Model<Api> = found;

  // Resolve a model from an optional override string ("provider/id" or bare id).
  function resolveModel(
    modelOverride: string | null | undefined,
  ): Model<Api> {
    if (!modelOverride) return defaultModel;
    let provider = args.provider;
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
    "/llm_query": async (body) => {
      const model = resolveModel(body.model as string | null | undefined);
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
      const model = resolveModel(body.model as string | null | undefined);
      const { messages } = await callLMBatched({
        model,
        modelRegistry,
        prompts: body.prompts as string[],
      });
      return messages.map(extractText);
    },
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      const tokenHeader = req.headers["x-harpy-token"];
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
    process.stdout.write(JSON.stringify({ port: addr.port, token }) + "\n");
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
    `llm-server fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
  );
  process.exit(1);
});

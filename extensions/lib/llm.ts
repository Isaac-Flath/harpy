import { complete } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
} from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import { makeSemaphore } from "./semaphore.js";

export interface LMCall {
  model: Model<Api>;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
}

async function resolveAuth(
  modelRegistry: ModelRegistry,
  model: Model<Api>,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(
      `Auth failed for ${model.provider}/${model.id}: ${auth.error}`,
    );
  }
  return { apiKey: auth.apiKey, headers: auth.headers };
}

// Minimal fallback system prompt. OpenAI's responses API rejects requests
// without an `instructions` field; Anthropic accepts an empty one. So we
// always pass at least this when the caller doesn't provide something richer.
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

export async function callLM(
  opts: LMCall & {
    systemPrompt?: string;
    messages: Message[];
  },
): Promise<AssistantMessage> {
  const { apiKey, headers } = await resolveAuth(opts.modelRegistry, opts.model);
  const msg = await complete(
    opts.model,
    {
      systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      messages: opts.messages,
    },
    {
      apiKey,
      headers,
      signal: opts.signal,
      cacheRetention: "short",
    },
  );
  // pi-ai returns AssistantMessage with stopReason='error' instead of throwing.
  // Surface as a thrown error so callers see the failure clearly.
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new Error(
      `LM call failed (${opts.model.provider}/${opts.model.id}, stop=${msg.stopReason}): ${msg.errorMessage ?? "(no error message)"}`,
    );
  }
  return msg;
}

export async function callLMBatched(
  opts: LMCall & {
    systemPrompt?: string;
    prompts: string[];
    concurrency?: number;
  },
): Promise<{ messages: AssistantMessage[]; totalCost: number }> {
  const { apiKey, headers } = await resolveAuth(opts.modelRegistry, opts.model);
  const limit = makeSemaphore(opts.concurrency ?? 16);
  const now = Date.now();

  const results = await Promise.all(
    opts.prompts.map((prompt) =>
      limit(async () => {
        const msg = await complete(
          opts.model,
          {
            systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt, timestamp: now }],
          },
          {
            apiKey,
            headers,
            signal: opts.signal,
            cacheRetention: "short",
          },
        );
        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
          throw new Error(
            `LM call failed (${opts.model.provider}/${opts.model.id}, stop=${msg.stopReason}): ${msg.errorMessage ?? "(no error message)"}`,
          );
        }
        return msg;
      }),
    ),
  );

  const totalCost = results.reduce(
    (sum, msg) => sum + (msg.usage.cost?.total ?? 0),
    0,
  );
  return { messages: results, totalCost };
}

export function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string; textSignature?: string } =>
      c.type === "text",
    )
    .map((c) => c.text)
    .join("");
}

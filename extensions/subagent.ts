/**
 * Subagent tool: delegate a task to a named agent defined in <repo>/agents/*.md.
 *
 * Each agent file is markdown with frontmatter:
 *
 *   ---
 *   name: signal-librarian
 *   description: When to delegate to this agent (shown to the model)
 *   tools: read, bash, grep, find, ls        # optional allowlist
 *   model: provider/id                       # optional override
 *   ---
 *   System prompt body ...
 *
 * Execution follows the official pi-mono subagent example: spawn a fresh
 * `pi -p --no-session` subprocess per task. Because it is a normal pi
 * invocation, the child inherits everything ambient from ~/.pi/agent —
 * auth, settings (default model), harpy extensions, APPEND_SYSTEM.md, and
 * skills — so the subagent works with the same capabilities as the parent,
 * in its own context window. The agent's markdown body is passed via
 * --append-system-prompt and its tools list via --tools.
 */

import { Type, type Static } from "@sinclair/typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type AgentToolResult,
  type AgentToolUpdateCallback,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "fs";
import nodePath from "path";
import { fileURLToPath } from "url";

interface AgentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
}

const AGENTS_DIR = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents"
);

function parseAgentFile(filePath: string): AgentDef | undefined {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return undefined;

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  if (!frontmatter.name || !frontmatter.description) return undefined;

  const tools = frontmatter.tools
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: tools?.length ? tools : undefined,
    model: frontmatter.model,
    systemPrompt: match[2].trim(),
  };
}

function loadAgents(): AgentDef[] {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseAgentFile(nodePath.join(AGENTS_DIR, f)))
    .filter((a): a is AgentDef => a !== undefined);
}

const agents = loadAgents();

const subagentSchema = Type.Object({
  agent: Type.String({
    description: `Agent to delegate to. Available: ${agents.map((a) => a.name).join(", ") || "(none)"}`,
  }),
  task: Type.String({
    description:
      "The task for the agent. Be specific: the agent has no access to this conversation, so include all context it needs.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent (default: current directory)",
    })
  ),
});

type SubagentInput = Static<typeof subagentSchema>;

const agentCatalog = agents
  .map((a) => `- ${a.name}: ${a.description}`)
  .join("\n");

const subagentTool = defineTool({
  name: "subagent",
  label: "subagent",
  description:
    "Delegate a task to a specialized subagent. It runs in its own context window with its own system prompt and restricted tools, and returns its final report.\n\nAvailable agents:\n" +
    (agentCatalog || "(none defined)"),
  promptSnippet: "Delegate research tasks to specialized subagents",
  promptGuidelines: [
    "Use subagent for self-contained tasks that would flood this context with intermediate output — the subagent returns only its final report.",
    "The subagent cannot see this conversation. Put every requirement, path, and constraint into the task text.",
    ...agents.map((a) => `Use agent='${a.name}' — ${a.description}`),
  ],
  parameters: subagentSchema,

  async execute(
    _toolCallId: string,
    params: SubagentInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<{ agent: string; task: string }>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const agent = agents.find((a) => a.name === params.agent);
    if (!agent) {
      const names = agents.map((a) => a.name).join(", ") || "(none)";
      throw new Error(`Unknown agent: ${params.agent}. Available: ${names}`);
    }

    const args: string[] = ["-p", "--no-session"];
    if (agent.model) args.push("--model", agent.model);
    if (agent.tools) args.push("--tools", agent.tools.join(","));
    args.push("--append-system-prompt", agent.systemPrompt);
    args.push(`Task: ${params.task}`);

    const { stdout, stderr, code } = await _pi.exec("pi", args, {
      signal,
      timeout: 1_200_000, // 20 minutes
      cwd: params.cwd ?? ctx.cwd,
    });

    if (code !== 0) {
      const message = stderr.trim() || stdout.trim() || `pi exited ${code}`;
      throw new Error(`subagent '${agent.name}' failed: ${message}`);
    }

    const report = stdout.trim() || "(subagent produced no output)";
    return {
      content: [{ type: "text", text: report }],
      details: { agent: agent.name, task: params.task },
    };
  },
});

let _pi: ExtensionAPI;

export default function (pi: ExtensionAPI) {
  _pi = pi;
  pi.registerTool(subagentTool);
}

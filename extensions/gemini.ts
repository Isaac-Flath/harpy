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
import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import nodePath from "path";
import { createHash } from "crypto";
import {
  bold,
  dim,
  getTextContent,
  summarizeSingleLine,
  wrapAnsiLines,
} from "./lib/render-text.js";

const geminiSchema = Type.Object({
  prompt: Type.String({ description: "Prompt to send to Gemini" }),
  model: Type.Optional(
    Type.String({
      description: "Gemini model to use (default: gemini-2.5-pro)",
    })
  ),
  files: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Local file paths to attach (PDFs, images, videos)",
      })
    )
  ),
  context_files: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Optional local text notes to prepend before analyzing attached media or PDFs",
      })
    )
  ),
  max_output_chars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return inline before truncating",
    })
  ),
});

type GeminiInput = Static<typeof geminiSchema>;

interface GeminiFileInfo {
  inputPath: string;
  path: string;
  name: string;
  mimeType: string;
}

interface GeminiContextFileInfo {
  inputPath: string;
  path: string;
  name: string;
  chars: number;
}

interface GeminiDetails {
  backend: string;
  model: string;
  prompt: string;
  fullPrompt: string;
  promptChars: number;
  responseText: string;
  responseChars: number;
  truncated: boolean;
  fullPath?: string;
  files: GeminiFileInfo[];
  contextFiles: GeminiContextFileInfo[];
  maxOutputChars: number;
  usage?: {
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtsTokens?: number;
  };
}

interface GeminiBackendConfig {
  name: string;
  client: GoogleGenAI;
}

const DEFAULT_MODEL = "gemini-2.5-pro";
const DEFAULT_MAX_CHARS = 50_000;
const MAX_LINES = 2_000;
const TMP_DIR = nodePath.join(tmpdir(), "harpy-gemini");
const FILE_READY_TIMEOUT_MS = 120_000;
const FILE_READY_POLL_MS = 2_000;

function formatUsage(details: GeminiDetails): string | undefined {
  const usage = details.usage;
  if (!usage) return undefined;

  const parts: string[] = [];
  if (usage.promptTokens !== undefined) parts.push(`prompt ${usage.promptTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`output ${usage.outputTokens}`);
  if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
  if (usage.thoughtsTokens !== undefined) parts.push(`thoughts ${usage.thoughtsTokens}`);
  return parts.length ? parts.join(" • ") : undefined;
}

function getBackendConfigs(): GeminiBackendConfig[] {
  const configs: GeminiBackendConfig[] = [];

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (geminiApiKey) {
    configs.push({
      name: "gemini-api",
      client: new GoogleGenAI({ apiKey: geminiApiKey }),
    });
  }

  const vertexEnabled =
    process.env.GOOGLE_GENAI_USE_VERTEXAI?.toLowerCase() === "true" ||
    !!process.env.VERTEX_AI_API_KEY;
  const vertexApiKey = process.env.VERTEX_AI_API_KEY || process.env.GOOGLE_API_KEY;
  if (vertexEnabled && vertexApiKey) {
    configs.push({
      name: "vertex-ai",
      client: new GoogleGenAI({
        vertexai: true,
        apiKey: vertexApiKey,
      }),
    });
  }

  if (!configs.length) {
    throw new Error(
      "No Gemini backend is configured. Set GEMINI_API_KEY for the direct Gemini API, and optionally set GOOGLE_GENAI_USE_VERTEXAI=true with VERTEX_AI_API_KEY or GOOGLE_API_KEY for Vertex AI fallback."
    );
  }

  return configs;
}

function resolveExistingFile(cwd: string, inputPath: string, label: string): string {
  const resolved = nodePath.resolve(cwd, inputPath);
  if (!existsSync(resolved)) {
    throw new Error(`${label} not found: ${inputPath}`);
  }
  const stat = statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${inputPath}`);
  }
  return resolved;
}

function loadContextFiles(
  cwd: string,
  paths: string[]
): { combined: string; resolved: GeminiContextFileInfo[] } {
  const blocks: string[] = [];
  const resolved: GeminiContextFileInfo[] = [];

  for (const inputPath of paths) {
    const absPath = resolveExistingFile(cwd, inputPath, "Context file");
    const content = readFileSync(absPath, "utf-8");
    blocks.push(`# Context from: ${nodePath.basename(absPath)}\n\n${content}`);
    resolved.push({
      inputPath,
      path: absPath,
      name: nodePath.basename(absPath),
      chars: content.length,
    });
  }

  return {
    combined: blocks.length ? `${blocks.join("\n\n---\n\n")}\n\n---\n\n` : "",
    resolved,
  };
}

function guessMimeType(filePath: string): string {
  const ext = nodePath.extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".m4v":
      return "video/x-m4v";
    case ".webm":
      return "video/webm";
    case ".avi":
      return "video/x-msvideo";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".ogg":
      return "audio/ogg";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".html":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStateName(state: any): string | undefined {
  if (!state) return undefined;
  if (typeof state === "string") return state;
  if (typeof state.name === "string") return state.name;
  return undefined;
}

async function waitForFileReady(ai: GoogleGenAI, uploadedFile: any): Promise<any> {
  const fileName = uploadedFile?.name;
  if (!fileName) return uploadedFile;

  const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
  let current = uploadedFile;

  while (Date.now() < deadline) {
    const state = getStateName(current?.state);
    if (!state || state === "ACTIVE") {
      return current;
    }
    if (state === "FAILED") {
      throw new Error(`Gemini file processing failed for ${fileName}`);
    }

    await sleep(FILE_READY_POLL_MS);
    current = await ai.files.get({ name: fileName });
  }

  throw new Error(`Timed out waiting for Gemini file processing: ${fileName}`);
}

async function uploadFiles(
  ai: GoogleGenAI,
  cwd: string,
  files: string[]
): Promise<{ uploaded: any[]; resolved: GeminiFileInfo[] }> {
  const uploaded: any[] = [];
  const resolved: GeminiFileInfo[] = [];

  for (const inputPath of files) {
    const absPath = resolveExistingFile(cwd, inputPath, "Attachment");
    const mimeType = guessMimeType(absPath);
    const uploadedFile = await ai.files.upload({
      file: absPath,
      config: { mimeType },
    });
    const readyFile = await waitForFileReady(ai, uploadedFile);
    uploaded.push(readyFile);
    resolved.push({
      inputPath,
      path: absPath,
      name: nodePath.basename(absPath),
      mimeType,
    });
  }

  return { uploaded, resolved };
}

async function deleteUploadedFiles(ai: GoogleGenAI, uploaded: any[]): Promise<void> {
  await Promise.all(
    uploaded.map(async (file) => {
      const name = file?.name;
      if (!name) return;
      try {
        await ai.files.delete({ name });
      } catch {
        // Best-effort cleanup only.
      }
    })
  );
}

function extractResponseText(response: any): string {
  if (typeof response?.text === "string" && response.text.trim()) {
    return response.text;
  }

  const parts = response?.candidates?.flatMap((candidate: any) =>
    candidate?.content?.parts ?? []
  );
  const text = parts
    ?.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (text) return text;
  return JSON.stringify(response, null, 2);
}

function extractUsage(response: any): GeminiDetails["usage"] | undefined {
  const usage = response?.usageMetadata;
  if (!usage) return undefined;

  return {
    promptTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
    thoughtsTokens: usage.thoughtsTokenCount,
  };
}

function truncateContent(
  content: string,
  maxChars: number,
  requestKey: string
): { text: string; fullPath?: string } {
  const lines = content.split("\n");
  if (content.length <= maxChars && lines.length <= MAX_LINES) {
    return { text: content };
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const hash = createHash("sha256").update(requestKey).digest("hex").slice(0, 12);
  const fullPath = nodePath.join(TMP_DIR, `gemini-${hash}.md`);
  writeFileSync(fullPath, content, { mode: 0o600 });

  const truncated = lines.slice(0, MAX_LINES).join("\n").slice(0, maxChars);
  return {
    text:
      truncated +
      `\n\n[Content truncated. Full response (${content.length} chars, ${lines.length} lines) saved to: ${fullPath}]`,
    fullPath,
  };
}

async function runGeminiRequest(
  ai: GoogleGenAI,
  model: string,
  cwd: string,
  prompt: string,
  attachmentInput: string[]
): Promise<{
  responseText: string;
  usage?: GeminiDetails["usage"];
  resolvedFiles: GeminiFileInfo[];
}> {
  const uploadedFiles: any[] = [];

  try {
    let resolvedFiles: GeminiFileInfo[] = [];
    if (attachmentInput.length) {
      const uploadResult = await uploadFiles(ai, cwd, attachmentInput);
      uploadedFiles.push(...uploadResult.uploaded);
      resolvedFiles = uploadResult.resolved;
    }

    const parts = [
      ...uploadedFiles.map((file) => createPartFromUri(file.uri, file.mimeType)),
      prompt,
    ];

    const response = await ai.models.generateContent({
      model,
      contents: createUserContent(parts),
    });

    return {
      responseText: extractResponseText(response).trim(),
      usage: extractUsage(response),
      resolvedFiles,
    };
  } finally {
    await deleteUploadedFiles(ai, uploadedFiles);
  }
}

class GeminiComponent implements Component {
  private details: GeminiDetails;
  private expanded: boolean;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private cachedExpanded = false;

  constructor(details: GeminiDetails, expanded: boolean) {
    this.details = details;
    this.expanded = expanded;
  }

  setState(details: GeminiDetails, expanded: boolean): void {
    const changed =
      this.expanded !== expanded ||
      this.details.responseText !== details.responseText ||
      this.details.fullPrompt !== details.fullPrompt ||
      this.details.responseChars !== details.responseChars ||
      this.details.truncated !== details.truncated;

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

    const d = this.details;
    const fileCount = d.files.length;
    const contextCount = d.contextFiles.length;
    const summary = `${d.model} via ${d.backend} • ${fileCount} attachment${fileCount === 1 ? "" : "s"} • ${contextCount} context file${contextCount === 1 ? "" : "s"} • response ${d.responseChars} chars`;

    let lines: string[];
    if (!this.expanded) {
      lines = [
        bold(summary),
        dim(`Prompt: ${summarizeSingleLine(d.prompt, 90)}`),
        dim(`Response: ${summarizeSingleLine(d.responseText, 90)}`),
      ];
      if (d.truncated && d.fullPath) {
        lines.push(dim(`Full response saved to: ${d.fullPath}`));
      }
    } else {
      const usage = formatUsage(d);
      lines = [
        bold("Request"),
        `  Model: ${d.model}`,
        `  Backend: ${d.backend}`,
        `  max_output_chars: ${d.maxOutputChars}`,
        `  Prompt chars sent: ${d.promptChars}`,
      ];

      if (usage) lines.push(`  Usage: ${usage}`);

      lines.push("", bold("Prompt (agent input)"));
      for (const line of d.prompt.split("\n")) {
        lines.push(`  ${line}`);
      }

      if (d.fullPrompt !== d.prompt) {
        lines.push("", bold("Exact prompt sent to Gemini"));
        for (const line of d.fullPrompt.split("\n")) {
          lines.push(`  ${line}`);
        }
      }

      lines.push("", bold(`Attachments (${d.files.length})`));
      if (!d.files.length) {
        lines.push(dim("  None"));
      } else {
        d.files.forEach((file, index) => {
          lines.push(`  [${index + 1}] ${file.name}`);
          lines.push(`      input: ${file.inputPath}`);
          lines.push(`      path: ${file.path}`);
          lines.push(`      mime: ${file.mimeType}`);
        });
      }

      lines.push("", bold(`Context files (${d.contextFiles.length})`));
      if (!d.contextFiles.length) {
        lines.push(dim("  None"));
      } else {
        d.contextFiles.forEach((file, index) => {
          lines.push(`  [${index + 1}] ${file.name}`);
          lines.push(`      input: ${file.inputPath}`);
          lines.push(`      path: ${file.path}`);
          lines.push(`      chars: ${file.chars}`);
        });
      }

      lines.push("", bold("Response"), `  Chars: ${d.responseChars}`);
      if (d.truncated && d.fullPath) {
        lines.push(`  Full response path: ${d.fullPath}`);
      }
      for (const line of d.responseText.split("\n")) {
        lines.push(`  ${line}`);
      }
    }

    this.cachedLines = this.expanded
      ? wrapAnsiLines(lines, width)
      : lines.map((line) => {
          if (visibleWidth(line) <= width) return line;
          return truncateToWidth(line, width);
        });
    this.cachedWidth = width;
    this.cachedExpanded = this.expanded;
    return this.cachedLines;
  }
}

function renderGeminiResult(
  result: AgentToolResult<GeminiDetails>,
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

  const details = result.details;
  if (context.lastComponent instanceof GeminiComponent) {
    context.lastComponent.setState(details, options.expanded);
    return context.lastComponent;
  }

  return new GeminiComponent(details, options.expanded);
}

const geminiTool = defineTool({
  name: "gemini",
  label: "gemini",
  description:
    "Query Gemini models for media/PDF analysis of images, videos, and PDFs.",
  promptSnippet:
    "Gemini media/PDF analysis for images, videos, and PDFs",
  promptGuidelines: [
    "Use gemini only for images, videos, and PDFs.",
    "Do not use gemini for long-context text analysis, generic harder reasoning tasks, or plain-text/code inspection.",
    "Use context_files only as brief local notes that help interpret attached media or PDFs.",
    "Prefer local tools for file reading, code inspection, and other text-heavy tasks.",
  ],
  parameters: geminiSchema,
  renderResult: renderGeminiResult as any,

  async execute(
    _toolCallId: string,
    params: GeminiInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<GeminiDetails> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<GeminiDetails>> {
    if (signal?.aborted) throw new Error("Operation aborted");

    const model = params.model ?? DEFAULT_MODEL;
    const maxChars = params.max_output_chars ?? DEFAULT_MAX_CHARS;
    const backends = getBackendConfigs();

    const contextFilesInput = params.context_files ?? [];
    const attachmentInput = params.files ?? [];

    const { combined: contextPrefix, resolved: resolvedContextFiles } =
      loadContextFiles(ctx.cwd, contextFilesInput);
    const fullPrompt = contextPrefix
      ? `${contextPrefix}# Task\n\n${params.prompt}`
      : params.prompt;

    let lastError: unknown;

    for (const backend of backends) {
      if (signal?.aborted) throw new Error("Operation aborted");

      try {
        const { responseText, usage, resolvedFiles } = await runGeminiRequest(
          backend.client,
          model,
          ctx.cwd,
          fullPrompt,
          attachmentInput
        );

        const requestKey = JSON.stringify({
          backend: backend.name,
          model,
          prompt: fullPrompt,
          files: resolvedFiles.map((file) => file.path),
        });
        const { text, fullPath } = truncateContent(
          responseText || "[Gemini returned an empty response]",
          maxChars,
          requestKey
        );

        return {
          content: [{ type: "text", text }],
          details: {
            backend: backend.name,
            model,
            prompt: params.prompt,
            fullPrompt,
            promptChars: fullPrompt.length,
            responseText: responseText || "[Gemini returned an empty response]",
            responseChars: responseText.length,
            truncated: !!fullPath,
            fullPath,
            files: resolvedFiles,
            contextFiles: resolvedContextFiles,
            maxOutputChars: maxChars,
            usage,
          },
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      `All Gemini backends failed.${
        lastError instanceof Error ? ` Last error: ${lastError.message}` : ""
      }`
    );
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(geminiTool);
}

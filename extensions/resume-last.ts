import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

interface ResumeSessionInfo {
  id: string;
  name?: string;
  command: string;
}

interface ExitPrinterState {
  installed: boolean;
  shouldPrint: boolean;
  currentSession: ResumeSessionInfo | null;
}

const GLOBAL_STATE_KEY = "__harpyResumeOnExitState";

type GlobalWithExitState = typeof globalThis & {
  [key in typeof GLOBAL_STATE_KEY]?: ExitPrinterState;
};

function buildResumeCommand(sessionId: string): string {
  return `pi --session ${sessionId}`;
}

function normalizeSessionName(name: string | undefined): string | undefined {
  const normalized = name?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function formatSessionLabel(session: ResumeSessionInfo): string {
  const name = normalizeSessionName(session.name);
  return name ? `${name} (${session.id})` : session.id;
}

function formatExitMessage(session: ResumeSessionInfo): string {
  return `\nResume this Pi session for ${formatSessionLabel(session)} with:\n  ${session.command}\n`;
}

function shouldPrintOnExit(): boolean {
  const args = process.argv.slice(2);

  if (args.includes("-p") || args.includes("--print")) return false;
  if (args.includes("--export")) return false;

  const modeIndex = args.indexOf("--mode");
  if (modeIndex !== -1) {
    const mode = args[modeIndex + 1];
    if (mode === "json" || mode === "rpc") return false;
  }

  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function getExitPrinterState(): ExitPrinterState {
  const globalState = globalThis as GlobalWithExitState;
  globalState[GLOBAL_STATE_KEY] ??= {
    installed: false,
    shouldPrint: shouldPrintOnExit(),
    currentSession: null,
  };
  return globalState[GLOBAL_STATE_KEY]!;
}

function installExitPrinter(): void {
  const state = getExitPrinterState();
  if (state.installed) return;

  process.on("exit", () => {
    const session = state.currentSession;
    if (!state.shouldPrint || !session) return;

    try {
      process.stdout.write(formatExitMessage(session));
    } catch {
      // Best effort only during process shutdown.
    }
  });

  state.installed = true;
}

function readCurrentSession(ctx: ExtensionContext): ResumeSessionInfo | null {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return null;

  const id = ctx.sessionManager.getSessionId();
  return {
    id,
    name: ctx.sessionManager.getSessionName(),
    command: buildResumeCommand(id),
  };
}

export default function (pi: ExtensionAPI) {
  const state = getExitPrinterState();
  state.shouldPrint = shouldPrintOnExit();
  installExitPrinter();

  pi.on("session_start", async (_event, ctx) => {
    state.currentSession = readCurrentSession(ctx);
  });
}

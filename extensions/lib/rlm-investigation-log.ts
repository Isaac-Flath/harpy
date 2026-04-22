import { mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";

export interface InvestigationLogEntry {
  type: string;
  timestamp: string;
  depth: number;
  [k: string]: unknown;
}

export class InvestigationLogger {
  private path: string;
  private opened = false;

  constructor(path: string) {
    this.path = path;
  }

  write(entry: { type: string; depth: number; [k: string]: unknown }): void {
    if (!this.opened) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.opened = true;
    }
    const full = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(this.path, JSON.stringify(full) + "\n");
  }

  get logPath(): string {
    return this.path;
  }
}

export function defaultLogPath(toolCallId: string): string {
  const home = process.env.HOME ?? ".";
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return `${home}/.agentkb/rlm-logs/${ts}_${toolCallId}.ndjson`;
}

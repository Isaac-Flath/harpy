import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

let caffeinateProcess: ChildProcess | null = null;
let didAttemptStartup = false;

function isDisabled(): boolean {
  const value = process.env.PI_PREVENT_IDLE_SLEEP;
  if (!value) return false;
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (process.platform !== "darwin") return;
    if (didAttemptStartup || caffeinateProcess) return;
    if (isDisabled()) return;

    didAttemptStartup = true;

    try {
      const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", () => {
        if (caffeinateProcess === child) caffeinateProcess = null;
      });

      child.on("exit", () => {
        if (caffeinateProcess === child) caffeinateProcess = null;
      });

      child.unref();
      caffeinateProcess = child;

      if (ctx.hasUI) {
        ctx.ui.setStatus("prevent-idle-sleep", "caffeinate on");
      }
    } catch {
      caffeinateProcess = null;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("prevent-idle-sleep", undefined);
    }
  });
}

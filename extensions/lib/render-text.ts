import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

export function bold(theme: Theme, text: string): string {
  return theme.bold(text);
}

export function dim(theme: Theme, text: string): string {
  return theme.fg("dim", text);
}

export function summarizeSingleLine(text: string, maxLength = 100): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "(empty)";
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

export function wrapAnsiLines(lines: string[], width: number): string[] {
  const wrapped: string[] = [];
  const safeWidth = Math.max(1, width);

  for (const line of lines) {
    if (visibleWidth(line) > safeWidth) {
      wrapped.push(...wrapTextWithAnsi(line, safeWidth));
    } else {
      wrapped.push(line);
    }
  }

  return wrapped;
}

export function getTextContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

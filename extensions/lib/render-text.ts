import { visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

const BOLD = "\x1b[1m";
const BOLD_END = "\x1b[22m";
const DIM = "\x1b[2m";
const DIM_END = "\x1b[22m";

export function bold(text: string): string {
  return BOLD + text + BOLD_END;
}

export function dim(text: string): string {
  return DIM + text + DIM_END;
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

/** Compact reads, grouping only successful text reads from a live contiguous run.
 * Errors, images, pending/expanded rows and resumed history remain individual. */
import type { AgentToolResult, ExtensionAPI, ReadToolDetails, ReadToolInput, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isAbsolute, relative, sep } from "node:path";
import { RendererDelegate, textOutput, type RenderContext, type Summary } from "./lib/compact-render.js";

interface Member {
  group: Member[];
  epoch: number;
  view?: ReadView;
  invalidate?: () => void;
  refreshPending?: boolean;
}
interface ReadView {
  call: Text;
  result: Text;
  delegate: RendererDelegate;
  epoch: number;
  args: Partial<ReadToolInput>;
  cwd: string;
  expanded: boolean;
  partial: boolean;
  error: boolean;
  image: boolean;
  summary?: Summary;
  member?: Member;
}

function summarize(args: Partial<ReadToolInput>, result: AgentToolResult<unknown>): Summary {
  if (result.content.some((c) => c.type === "image")) return { text: "image loaded", tone: "success" };
  const output = textOutput(result).replace(/\r/g, "");
  if (!output) return { text: "empty file", tone: "dim" };
  const tail = output.trimEnd().split("\n").pop()?.trim() ?? "";
  const oversize = /^\[Line (\d+) is .+ exceeds .+ limit.+\]$/.exec(tail);
  if (oversize) return { text: `line ${oversize[1]} exceeds the read size limit`, tone: "warning" };
  const showing = /^\[Showing lines (\d+)-(\d+) of (\d+).+\]$/.exec(tail);
  if (showing) return { text: `lines ${showing[1]}-${showing[2]} of ${showing[3]}`, tone: "warning" };
  const start = typeof args.offset === "number" ? args.offset : 1;
  const more = /^\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/.exec(tail);
  if (more) {
    const end = Math.max(start, Number(more[2]) - 1);
    return { text: `lines ${start}-${end} of ${end + Number(more[1])}`, tone: "success" };
  }
  const count = output.split("\n").length - Number(output.endsWith("\n"));
  const truncation = (result.details as ReadToolDetails | undefined)?.truncation;
  const end = start + count - 1;
  return {
    text: `lines ${start}-${end}${truncation?.totalLines && truncation.totalLines > end ? ` of ${truncation.totalLines}` : ""}`,
    tone: truncation?.truncated ? "warning" : "success",
  };
}

function pathText(view: ReadView): string {
  const path = typeof view.args.path === "string" ? view.args.path : "...";
  if (!isAbsolute(path)) return path;
  const local = relative(view.cwd, path);
  return local && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local) ? local : path;
}

export default function (pi: ExtensionAPI) {
  let epoch = 0;
  let current: Member[] = [];
  // Only unbound live calls live in this map. Once a row renders, it owns its
  // membership; completed off-screen calls and session changes release entries.
  const pending = new Map<string, Member>();
  const reset = () => { epoch++; current = []; pending.clear(); };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_tree", reset);
  pi.on("message_start", ({ message }) => {
    if (message.role === "user" || message.role === "assistant") current = [];
  });
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId) return; // Nested tools have no independent transcript row.
    if (event.toolName !== "read") { current = []; return; }
    const member: Member = { group: current, epoch };
    current.push(member);
    pending.set(event.toolCallId, member);
  });
  pi.on("tool_execution_end", (event) => { pending.delete(event.toolCallId); });

  function eligible(view: ReadView): boolean {
    return view.epoch === epoch && Boolean(view.summary) && !view.expanded && !view.partial && !view.error && !view.image;
  }

  function refreshOthers(member: Member | undefined): void {
    if (!member || member.epoch !== epoch) return;
    for (const other of member.group) {
      if (other === member || !other.invalidate || other.refreshPending) continue;
      other.refreshPending = true;
      // Pi's invalidate() rebuilds the row synchronously. Defer cross-row updates
      // to avoid reentrant tool rendering while a result is being mounted.
      queueMicrotask(() => {
        other.refreshPending = false;
        if (other.epoch === epoch) other.invalidate?.();
      });
    }
  }

  function stateFor(args: unknown, context: RenderContext): ReadView {
    const state: ReadView = context.state.harpyReadView ??= {
      call: new Text("", 0, 0), result: new Text("", 0, 0), delegate: new RendererDelegate(),
      epoch, args: {}, cwd: context.cwd, expanded: false, partial: true, error: false, image: false,
    };
    const wasEligible = eligible(state);
    if (state.epoch === epoch && !state.member) {
      state.member = pending.get(context.toolCallId);
      if (state.member) { state.member.view = state; pending.delete(context.toolCallId); }
    }
    if (state.member) state.member.invalidate = context.invalidate;
    state.args = args && typeof args === "object" ? args as Partial<ReadToolInput> : {};
    state.cwd = context.cwd;
    state.expanded = context.expanded;
    state.partial = context.isPartial;
    state.error = context.isError;
    if (wasEligible !== eligible(state)) refreshOthers(state.member);
    return state;
  }

  function header(state: ReadView, theme: Theme): string {
    const title = theme.fg("toolTitle", theme.bold("read"));
    const group = state.member?.group.filter((m) => m.view && eligible(m.view)) ?? [];
    if (eligible(state) && group.length > 1) {
      if (group.at(-1) !== state.member) return "";
      const views = group.map((m) => m.view!);
      const files = new Set(views.map(pathText)).size;
      const parts = views.map((view) => `${theme.fg("accent", pathText(view))} ${theme.fg(view.summary!.tone, `(${view.summary!.text.replace(/^lines /, "")})`)}`);
      return `${title} ${theme.fg("dim", `${files} file${files === 1 ? "" : "s"}:`)} ${parts.join(theme.fg("dim", ", "))}`;
    }
    const summary = !state.partial && !state.error ? state.summary : undefined;
    return `${title} ${theme.fg("accent", pathText(state))}${summary ? ` ${theme.fg(summary.tone, summary.text)}` : ""}`;
  }

  pi.registerToolRenderer((name, next) => {
    const base = next();
    if (name !== "read") return base;
    return {
      ...base,
      renderCall(args, theme, context) {
        const state = stateFor(args, context);
        if (context.expanded || context.isError || context.isPartial) {
          return state.delegate.call(base, args, theme, context, header(state, theme));
        }
        state.call.setText(header(state, theme));
        return state.call;
      },
      renderResult(result, options, theme, context) {
        const state = stateFor(context.args, context);
        const previous = state.summary;
        const wasImage = state.image;
        state.image = result.content.some((c) => c.type === "image");
        state.summary = context.isError || options.isPartial ? undefined : summarize(state.args, result);
        if (previous?.text !== state.summary?.text || previous?.tone !== state.summary?.tone || wasImage !== state.image) {
          refreshOthers(state.member);
        }
        state.call.setText(header(state, theme));
        if (context.isError || options.expanded || options.isPartial) return state.delegate.result(base, result, theme, context);
        if (state.delegate.used) state.delegate.result(base, result, theme, context);
        state.result.setText("");
        return state.result;
      },
    };
  });
}

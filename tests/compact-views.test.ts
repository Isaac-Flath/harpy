import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  createBashToolDefinition, createReadToolDefinition, discoverAndLoadExtensions, initTheme,
  ToolExecutionComponent, type ExtensionContext, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";

initTheme("dark", false);
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const result = (text: string, details?: unknown, isError = false) => ({
  content: [{ type: "text", text }], details, isError, durationMs: 5,
});
type Result = Parameters<ToolExecutionComponent["updateResult"]>[0];
interface Row { id: string; name: string; args: Record<string, unknown>; ui: ToolExecutionComponent; text: () => string }

async function fixture(t: TestContext, overrides: Partial<Record<"bash" | "read", ToolRenderers>> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "harpy-compact-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([resolve("extensions/bash-view.ts"), resolve("extensions/read-view.ts")], dir, dir);
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions.every((ext) => ext.tools.size === 0), "display extensions must not register executable tools");
  const rows: Row[] = [];
  // Mirror Pi's renderer registry boundary, which erases tool parameter types.
  const base: Record<string, ToolRenderers> = {
    bash: createBashToolDefinition(dir) as ToolRenderers,
    read: createReadToolDefinition(dir) as ToolRenderers,
    ...overrides,
  };
  const ui = { requestRender() {} } as TUI;
  const resolvers = loaded.extensions.flatMap((ext) => ext.toolRenderers ?? []);
  const renderer = (name: string) => {
    const chain = (i: number): ToolRenderers | undefined => i === resolvers.length
      ? base[name as "bash" | "read"] : resolvers[i](name, () => chain(i + 1));
    return chain(0);
  };
  async function emit(type: string, fields: Record<string, unknown> = {}) {
    for (const ext of loaded.extensions) {
      for (const handler of ext.handlers.get(type) ?? []) await handler({ type, ...fields }, { cwd: dir } as ExtensionContext);
    }
  }
  function row(name: string, id: string, args: Record<string, unknown>): Row {
    const component = new ToolExecutionComponent(name, id, args, { showImages: false }, renderer(name), ui, dir);
    const row = { name, id, args, ui: component, text: () => component.render(220).map(stripVTControlCharacters).join("\n") };
    rows.push(row);
    return row;
  }
  async function start(name: string, id: string, args: Record<string, unknown>) {
    const value = row(name, id, args); // Pi creates the row before execution starts.
    await emit("tool_execution_start", { toolName: name, toolCallId: id, args });
    value.ui.markExecutionStarted();
    value.ui.setArgsComplete();
    return value;
  }
  async function finish(row: Row, value: Result) {
    await emit("tool_execution_end", { toolName: row.name, toolCallId: row.id, args: row.args, result: value, isError: value.isError });
    row.ui.updateResult(value);
    await flush();
  }
  // Ensure native timers are stopped even if an assertion fails mid-stream.
  t.after(() => {
    for (const row of rows) { row.ui.setExpanded(true); row.ui.updateResult(result("", undefined, true)); }
  });
  await emit("session_start", { reason: "startup" });
  return { dir, loaded, emit, row, start, finish, renderer };
}

test("bash: streaming tail, full expansion, collapse and final success use compatible components", async (t) => {
  const h = await fixture(t);
  const row = await h.start("bash", "b", { command: "printf 'one\\ntwo\\n'" });
  row.ui.updateResult(result("one\ntwo\n"), true);
  assert.match(row.text(), /two/);
  assert.doesNotMatch(row.text(), /✓/);
  row.ui.setExpanded(true);
  assert.match(row.text(), /one\s*\n/);
  assert.match(row.text(), /two/);
  row.ui.setExpanded(false);
  assert.doesNotMatch(row.text(), /one\s*\n/);
  const clear = t.mock.method(globalThis, "clearInterval");
  await h.finish(row, result("one\ntwo\n"));
  assert.match(row.text(), /✓ 2 lines/);
  assert.ok(clear.mock.callCount() > 0, "native streaming timer must stop even when collapsed");
  row.ui.setExpanded(true);
  assert.match(row.text(), /one\s*\n/);
  row.ui.setExpanded(false);
  assert.match(row.text(), /✓ 2 lines/);
});

test("bash: errors retain full command and native output; empty/truncated output have honest status", async (t) => {
  const h = await fixture(t);
  const command = "echo " + "long-command-".repeat(12) + "THE-END";
  const row = await h.start("bash", "error", { command });
  await h.finish(row, result("denied\nCommand exited with code 1", undefined, true));
  assert.match(row.text(), /THE-END/);
  assert.match(row.text(), /denied/);
  assert.doesNotMatch(row.text(), /✓/);
  const empty = await h.start("bash", "empty", {});
  await h.finish(empty, result(""));
  assert.match(empty.text(), /no output/);
  const truncated = await h.start("bash", "trunc", { command: "generate" });
  await h.finish(truncated, result("data\n", { truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 50 }, fullOutputPath: "/tmp/full-output.log" }));
  assert.match(truncated.text(), /1 line, truncated/);
  truncated.ui.setExpanded(true);
  assert.match(truncated.text(), /Full output: \/tmp\/full-output.log/);
});

test("read: parallel completion order never hides pending rows or moves the group out of source order", async (t) => {
  const h = await fixture(t);
  const a = await h.start("read", "a", { path: join(h.dir, "a.txt") });
  const b = await h.start("read", "b", { path: join(h.dir, "b.txt") });
  const c = await h.start("read", "c", { path: join(h.dir, "c.txt") });
  await h.finish(b, result("B\n"));
  assert.match(a.text(), /a.txt/);
  assert.match(c.text(), /c.txt/);
  await h.finish(a, result("A\n"));
  assert.doesNotMatch(a.text(), /a.txt/);
  assert.match(b.text(), /2 files:.*a.txt.*b.txt/);
  assert.match(c.text(), /c.txt/);
  await h.finish(c, result("C\n"));
  assert.doesNotMatch(b.text(), /b.txt/);
  assert.match(c.text(), /3 files:.*a.txt.*b.txt.*c.txt/);
});

test("read: individual and global expansion restore full output without losing the other reads", async (t) => {
  const h = await fixture(t);
  const a = await h.start("read", "a", { path: "a.txt" });
  const b = await h.start("read", "b", { path: "b.txt" });
  const c = await h.start("read", "c", { path: "c.txt" });
  for (const row of [a, b, c]) await h.finish(row, result(`contents of ${row.id}\n`));
  c.ui.setExpanded(true);
  await flush();
  assert.match(c.text(), /contents of c/);
  assert.match(b.text(), /2 files:.*a.txt.*b.txt/);
  a.ui.setExpanded(true);
  b.ui.setExpanded(true);
  await flush();
  for (const row of [a, b, c]) assert.match(row.text(), new RegExp(`contents of ${row.id}`));
  for (const row of [a, b, c]) row.ui.setExpanded(false);
  await flush();
  assert.match(c.text(), /3 files:/);
  assert.doesNotMatch(a.text(), /a.txt/);
});

test("read: failures and images remain identified separately from grouped successful text reads", async (t) => {
  const h = await fixture(t);
  const a = await h.start("read", "a", { path: "a.txt" });
  const error = await h.start("read", "e", { path: "missing.txt" });
  const image = await h.start("read", "i", { path: "portrait.png" });
  const b = await h.start("read", "b", { path: "b.txt" });
  await h.finish(a, result("A"));
  await h.finish(error, result("ENOENT missing.txt", undefined, true));
  const imageResult = { content: [{ type: "image", mimeType: "image/png", data: "original-image" }], isError: false };
  const before = structuredClone(imageResult);
  await h.finish(image, imageResult);
  await h.finish(b, result("B"));
  assert.match(error.text(), /missing.txt/);
  assert.match(error.text(), /ENOENT/);
  assert.match(image.text(), /portrait.png.*image loaded/);
  assert.match(b.text(), /2 files:.*a.txt.*b.txt/);
  assert.doesNotMatch(b.text(), /missing.txt|portrait.png/);
  assert.deepEqual(imageResult, before, "display must not alter image results");
});

test("read: repeated reads count unique files and use session cwd, not process.cwd()", async (t) => {
  const h = await fixture(t);
  const a = await h.start("read", "a", { path: join(h.dir, "file.txt"), offset: 10 });
  const b = await h.start("read", "b", { path: "file.txt", offset: 20 });
  await h.finish(a, result("x\ny\n"));
  await h.finish(b, result("z\n"));
  assert.match(b.text(), /1 file:.*file.txt.*10-11.*file.txt.*20-20/);
  assert.doesNotMatch(b.text(), new RegExp(h.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("read: message/non-read boundaries split groups; tool results and nested calls do not", async (t) => {
  const h = await fixture(t);
  const a = await h.start("read", "a", { path: "a.txt" });
  await h.finish(a, result("a"));
  await h.emit("message_start", { message: { role: "toolResult" } });
  await h.emit("tool_execution_start", { toolName: "bash", toolCallId: "parent/1", parentToolCallId: "parent", args: {} });
  const b = await h.start("read", "b", { path: "b.txt" });
  await h.finish(b, result("b"));
  assert.match(b.text(), /2 files:/);
  await h.emit("message_start", { message: { role: "assistant" } });
  const c = await h.start("read", "c", { path: "c.txt" });
  await h.finish(c, result("c"));
  assert.doesNotMatch(c.text(), /files:/);
  await h.emit("tool_execution_start", { toolName: "bash", toolCallId: "shell", args: {} });
  const d = await h.start("read", "d", { path: "d.txt" });
  await h.finish(d, result("d"));
  assert.doesNotMatch(d.text(), /files:/);
});

test("read: partial, empty, whitespace-only and truncated results summarize correctly", async (t) => {
  const h = await fixture(t);
  const cases: [string, string, string][] = [
    ["empty", "", "empty file"], ["spaces", " \n", "lines 1-1"],
    ["more", "x\n\n[3 more lines in file. Use offset=2 to continue.]", "lines 1-1 of 4"],
    ["shown", "x\n\n[Showing lines 1-2 of 100 (50KB limit).]", "lines 1-2 of 100"],
    ["oversize", "[Line 1 is 60KB, exceeds 50KB limit. Use bash.]", "line 1 exceeds the read size limit"],
  ];
  for (const [id, output, expected] of cases) {
    await h.emit("message_start", { message: { role: "user" } });
    const row = await h.start("read", id, { path: `${id}.txt` });
    row.ui.updateResult(result("partial"), true);
    assert.doesNotMatch(row.text(), /empty file|lines 1-/);
    await h.finish(row, result(output));
    assert.ok(row.text().includes(expected));
    row.ui.setExpanded(true);
    if (output) assert.ok(row.text().includes(output.split("\n")[0]));
  }
});

test("read: tree/session changes detach old groups, and resumed/reloaded history stays individual", async (t) => {
  const h = await fixture(t);
  for (const reason of ["tree", "reload", "new", "resume", "fork"]) {
    const a = await h.start("read", "a", { path: "a.txt" });
    const b = await h.start("read", "b", { path: "b.txt" });
    await h.finish(a, result("a"));
    await h.finish(b, result("b"));
    assert.match(b.text(), /2 files:/);
    if (reason === "tree") await h.emit("session_tree");
    else {
      await h.emit("session_shutdown", { reason });
      await h.emit("session_start", { reason });
    }
    a.ui.invalidate(); b.ui.invalidate();
    await flush();
    assert.match(a.text(), /a.txt/);
    assert.doesNotMatch(b.text(), /2 files:/);
    const restored = h.row("read", "a", { path: "restored.txt" });
    restored.ui.updateResult(result("restored body"));
    assert.match(restored.text(), /restored.txt/);
    restored.ui.setExpanded(true);
    assert.match(restored.text(), /restored body/);
  }
});

test("delegation respects downstream custom renderer state/components and doesn't mutate results", async (t) => {
  const calls: string[] = [];
  const custom: ToolRenderers = {
    renderCall(args, _theme, context) {
      assert.ok(!context.lastComponent || context.lastComponent instanceof Container);
      context.state.marker = "shared";
      const box = context.lastComponent as Container | undefined ?? new Container();
      box.clear(); box.addChild(new Text(`CUSTOM CALL ${JSON.stringify(args)}`, 0, 0));
      calls.push("call");
      return box;
    },
    renderResult(_result, _options, _theme, context) {
      assert.equal(context.state.marker, "shared");
      assert.ok(!context.lastComponent || context.lastComponent instanceof Container);
      const box = context.lastComponent as Container | undefined ?? new Container();
      box.clear(); box.addChild(new Text("CUSTOM RESULT", 0, 0));
      calls.push("result");
      return box;
    },
  };
  const h = await fixture(t, { bash: custom, read: custom });
  assert.equal(h.renderer("unknown"), undefined);
  for (const name of ["bash", "read"]) {
    const row = await h.start(name, name, name === "bash" ? { command: "echo hi" } : { path: "file.txt" });
    row.ui.setExpanded(true);
    const value = result("hello", { custom: "untouched" });
    const original = structuredClone(value);
    await h.finish(row, value);
    assert.match(row.text(), /CUSTOM CALL/);
    assert.match(row.text(), /CUSTOM RESULT/);
    row.ui.setExpanded(false);
    assert.doesNotMatch(row.text(), /CUSTOM RESULT/);
    row.ui.setExpanded(true);
    assert.match(row.text(), /CUSTOM RESULT/);
    assert.deepEqual(value, original);
  }
  assert.ok(calls.length > 0);
});

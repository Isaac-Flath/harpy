import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions, generateDiffString, Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { countLines, displayText, MAX_WORD_CHARS, pairLines, parseDiff, parseLayout, previewLimit, wordSegments } from "../extensions/lib/diff-model.js";
import { DiffComponent, type DiffView } from "../extensions/lib/diff-render.js";

export function makeTheme(light = false, mode: "truecolor" | "256color" = "truecolor", defaultBg = false): Theme {
  const foreground = {
    toolDiffAdded: "#22aa22", toolDiffRemoved: "#cc2222", toolDiffContext: light ? "#333333" : "#cccccc",
    success: light ? "#006600" : "#66ff66", warning: "#bbbb00", dim: "#888888", muted: "#999999",
    accent: "#0088ff", toolTitle: "#0088ff", error: "#ff0000", text: "#aaaaaa", thinkingXhigh: "#aaaaaa",
  };
  const background = { selectedBg: "#222222", toolSuccessBg: defaultBg ? "" : light ? "#ffffff" : "#111111" };
  return new Theme(foreground as ConstructorParameters<typeof Theme>[0], background as ConstructorParameters<typeof Theme>[1], mode);
}

function view(oldText = "old\n", newText = "new\n", markdown = false): DiffView {
  return { diff: generateDiffString(oldText, newText).diff, filePath: markdown ? "test.md" : "test.py", action: "modified", markdown };
}
const plain = (component: DiffComponent, width = 100) => component.render(width).map(stripVTControlCharacters).join("\n");

test("word highlighting preserves indentation, whitespace, punctuation and Unicode exactly", () => {
  for (const [old, next] of [
    ["    return x", "        return x"], ["a b", "a  b"], ["a ", "a\t"],
    ["你好 👩‍💻 é", "您好 👩‍💻 é"], ["", " "], ["x();", "x(1);"], ["same", "same"],
  ]) {
    const [removed, added] = wordSegments(old, next);
    assert.equal(removed.map((s) => s.text).join(""), old);
    assert.equal(added.map((s) => s.text).join(""), next);
    if (old !== next) assert.ok([...removed, ...added].some((s) => s.changed));
  }
});

test("word comparisons fall back to exact whole lines above their budget", () => {
  const old = "a".repeat(MAX_WORD_CHARS);
  const next = "b".repeat(MAX_WORD_CHARS);
  assert.deepEqual(wordSegments(old, next), [[{ text: old, changed: true }], [{ text: next, changed: true }]]);
});

test("literal ellipses and CRLF source are not dropped or treated as gaps", () => {
  const lines = parseDiff("-1     ...\n+1     pass\n 2 ...\n   ...\n+3 text\r");
  assert.deepEqual(lines.map((l) => l.kind), ["removed", "added", "context", "gap", "added"]);
  assert.equal(lines[0].text, "    ...");
  assert.equal(lines[4].text, "text\r");
  assert.equal(parseDiff("nonsense").length, 0);
});

test("old/new context coordinates remain correct across multiple changes and omitted context", () => {
  const original = Array.from({ length: 50 }, (_,i) => `line ${i}`).join("\n") + "\n";
  const next = original.replace("line 1\n", "inserted\nline 1\n").replace("line 25\nline 26\n", "").replace("line 40\n", "new A\nnew B\nnew C\n");
  const lines = parseDiff(generateDiffString(original, next).diff);
  assert.ok(lines.some((l) => l.kind === "gap"));
  for (const line of lines) {
    if (line.oldNumber) assert.equal(line.text, original.split("\n")[line.oldNumber - 1]);
    if (line.newNumber) assert.equal(line.text, next.split("\n")[line.newNumber - 1]);
  }
  assert.ok(pairLines(lines).length > 0);
});

test("source controls are shown as text, not executed; tabs and CR are distinguishable", () => {
  assert.equal(displayText("a\tb\r"), "a→  b␍");
  assert.equal(displayText("\x1b[2J\x07"), "\\x1b[2J\\x07");
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines(""), 0);
  assert.equal(countLines("\n"), 1);
  assert.ok(previewLimit("x".repeat(65537)));
  assert.ok(previewLimit("😀".repeat(20000)));
  assert.ok(previewLimit("x\n".repeat(1001)));
  assert.equal(parseLayout("split"), "split");
  assert.equal(parseLayout("bogus"), undefined);
});

test("split shows independent context numbers, unified has no divider, narrow forced split falls back", () => {
  const data = view("a\nb\nc\n", "a\ninserted\nb\nc\n");
  const split = plain(new DiffComponent(data, makeTheme(), true, "split", "ctrl+o"), 150);
  assert.match(split, / 2 b +│  3 b/);
  assert.match(split, / 3 c +│  4 c/);
  assert.doesNotMatch(plain(new DiffComponent(data, makeTheme(), true, "unified", "ctrl+o"), 150), /│/);
  assert.doesNotMatch(plain(new DiffComponent(data, makeTheme(), true, "split", "ctrl+o"), 40), /│/);
});

test("collapse/expand/resize are deterministic; updates replace content and key hints", () => {
  const theme = makeTheme();
  const data = view("a\nb\nc\n", "x\ny\nz\n");
  const component = new DiffComponent(data, theme, true, "auto", "ctrl+o");
  const expanded = component.render(100);
  component.update(data, theme, false, "auto", "alt+e");
  const collapsed = component.render(100);
  assert.ok(collapsed.length < expanded.length);
  assert.deepEqual(component.render(100), collapsed);
  assert.match(plain(component), /alt\+e to expand/);
  component.invalidate();
  assert.deepEqual(component.render(100), collapsed);
  component.update(view("before\n", "latest\n"), theme, true, "auto", "alt+e");
  assert.match(plain(component), /latest/);
  assert.doesNotMatch(plain(component), /ctrl\+o/);
  assert.match(plain(component, 160), /│/);
});

test("summaries recolor after theme changes; all modes fit narrow widths and wide characters", () => {
  const data = view("  你好 👩‍💻\t...\n", "    你好 é\r\n", true);
  const component = new DiffComponent(data, makeTheme(), false, "auto", "ctrl+o");
  const dark = component.render(100);
  component.update(data, makeTheme(true), false, "auto", "ctrl+o");
  assert.notDeepEqual(component.render(100), dark);
  for (const theme of [makeTheme(), makeTheme(true), makeTheme(false, "256color"), makeTheme(false, "truecolor", true)]) {
    for (const width of [0, 1, 2, 5, 25, 59, 60, 100, 139, 140, 180]) {
      for (const layout of ["auto", "split", "unified"] as const) {
        component.update(data, theme, true, layout, "ctrl+o");
        assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `${layout} width ${width}`);
      }
    }
  }
});

test("Markdown stays visible while collapsed and long previews/lines are bounded and labelled", () => {
  const data = view("", Array.from({length: 1000}, (_, i) => `line ${i}`).join("\n"), true);
  const component = new DiffComponent(data, makeTheme(), false, "unified", "ctrl+o");
  assert.match(plain(component), /line 0/);
  assert.match(plain(component), /more diff lines/);
  assert.ok(component.render(100).length <= 22);
  component.update(view("", "x".repeat(64000), true), makeTheme(), true, "unified", "ctrl+o");
  assert.match(plain(component), /line truncated/);
  assert.ok(component.render(100).length < 100);
});

test("omitted-context dividers align in split layout and blank/unchanged files have honest summaries", () => {
  const component = new DiffComponent(view("head\n" + "context\n".repeat(20), "new\n" + "context\n".repeat(20)), makeTheme(), true, "split", "ctrl+o");
  const lines = component.render(150).map(stripVTControlCharacters);
  const columns = lines.filter((l) => l.includes("│")).map((l) => visibleWidth(l.split("│")[0]));
  assert.equal(new Set(columns).size, 1);
  component.update({ ...view("", ""), action: "created" }, makeTheme(), false, "auto", "ctrl+o");
  assert.match(plain(component), /^created/);
  assert.doesNotMatch(plain(component), /to expand/);
});

test("registered renderers handle streaming, errors, old sessions, large diffs and layout flags", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harpy-render-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([resolve("extensions/diff-view.ts")], dir, dir);
  assert.deepEqual(loaded.errors, []);
  const resolver = loaded.extensions[0].toolRenderers![0];
  const sentinel = { renderShell: "self" } as const;
  assert.equal(resolver("unrelated", () => sentinel), sentinel);
  const renderer = resolver("write", () => undefined)!;
  assert.equal(renderer.renderShell, "default");
  const theme = makeTheme();
  const context: Parameters<NonNullable<ToolRenderers["renderResult"]>>[3] = {
    args: { path: "test.txt", content: "new\n" }, toolCallId: "test", state: {}, cwd: dir,
    invalidate() {}, lastComponent: undefined, executionStarted: true, argsComplete: true,
    isPartial: false, expanded: true, showImages: false, isError: false, durationMs: 1, outputPad: 1,
    keyText: () => "alt+e", keyHint: (_key, description) => `alt+e ${description}`,
  };
  const options = { expanded: true, isPartial: false };
  const result = { content: [{ type: "text" as const, text: "Written" }], details: { diff: "-1 old\n+1 new", created: false } };
  const render = (value = result) => renderer.renderResult!(value, options, theme, context);
  loaded.runtime.flagValues.set("diff-layout", "unified");
  context.lastComponent = render();
  assert.doesNotMatch(context.lastComponent.render(160).map(stripVTControlCharacters).join("\n"), /│/);
  loaded.runtime.flagValues.set("diff-layout", "split");
  context.lastComponent = render();
  assert.match(context.lastComponent.render(160).map(stripVTControlCharacters).join("\n"), /│/);
  options.expanded = false;
  assert.match(render().render(100).map(stripVTControlCharacters).join("\n"), /alt\+e to expand/);
  assert.match(renderer.renderCall!({ path: "x", content: "a\n" }, theme, context).render(100).map(stripVTControlCharacters).join("\n"), /1 line,/);
  options.isPartial = true;
  assert.equal(stripVTControlCharacters(render().render(100).join("\n")).trim(), "Written");
  options.isPartial = false;
  context.isError = true;
  assert.equal(stripVTControlCharacters(render().render(100).join("\n")).trim(), "Written");
  context.isError = false;
  const huge = { ...result, details: { diff: "+1 " + "x".repeat(200000), created: false } };
  assert.match(render(huge).render(100).map(stripVTControlCharacters).join("\n"), /preview omitted/);
  const empty = renderer.renderResult!({ ...result, details: { harpyDiff: { diff: "", created: true } } }, options, theme, context);
  assert.match(empty.render(100).map(stripVTControlCharacters).join("\n"), /created test.txt/);
});

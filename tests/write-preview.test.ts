import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createEditToolDefinition, discoverAndLoadExtensions, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { MAX_FILE_BYTES } from "../extensions/lib/diff-model.js";
import { buildWritePreview, createPreviewWriteTool, readSnapshot } from "../extensions/lib/write-preview.js";

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "harpy-diff-test-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = { cwd: dir } as ExtensionToolContext;
  const tool = createPreviewWriteTool(dir);
  const write = (path: string, content: string, id = "test") => tool.execute(id, { path, content }, undefined, undefined, ctx);
  return { dir, ctx, tool, write };
}

test("write creates parent directories, captures overwrites, and leaves model-facing output unchanged", async (t) => {
  const { dir, write } = await fixture(t);
  const first = await write("nested/test.txt", "before\n");
  assert.equal(first.details.harpyDiff.created, true);
  assert.match(first.details.harpyDiff.diff!, /\+1 before/);
  assert.deepEqual(first.content, [{ type: "text", text: "Successfully wrote to nested/test.txt" }]);
  const next = await write("nested/test.txt", "after\n");
  assert.equal(next.details.harpyDiff.created, false);
  assert.match(next.details.harpyDiff.diff!, /-1 before\n\+1 after/);
  assert.equal(await readFile(join(dir, "nested/test.txt"), "utf8"), "after\n");
});

test("write uses Pi's @ and ~ expansion and current context cwd, not the registration cwd", async (t) => {
  const { dir, write, tool } = await fixture(t);
  const file = join(dir, "path.txt");
  await writeFile(file, "original\n");
  for (const path of [`@${file}`, `~/${relative(homedir(), file)}`]) {
    const result = await write(path, `next ${path}\n`);
    assert.equal(result.details.harpyDiff.created, false);
    assert.match(result.details.harpyDiff.diff!, /^-/);
  }
  const child = join(dir, "child");
  await mkdir(child);
  await writeFile(join(child, "local.txt"), "child before\n");
  const result = await tool.execute("cwd", { path: "local.txt", content: "child after\n" }, undefined, undefined, { cwd: child } as ExtensionToolContext);
  assert.match(result.details.harpyDiff.diff!, /child before/);
  assert.equal(await readFile(join(child, "local.txt"), "utf8"), "child after\n");
});

test("parallel writes capture their actual serialized preimages, including symlink aliases", async (t) => {
  const { dir, write } = await fixture(t);
  const file = join(dir, "target.txt");
  const alias = join(dir, "alias.txt");
  await writeFile(file, "original\n");
  await symlink(file, alias);
  const results = await Promise.all([write(file, "first\n", "one"), write(alias, "second\n", "two")]);
  const final = await readFile(file, "utf8");
  const last = final === "first\n" ? results[0] : results[1];
  assert.match(last.details.harpyDiff.diff!, final === "first\n" ? /-1 second\n\+1 first/ : /-1 first\n\+1 second/);
});

test("write capture shares the file queue with native edits", async (t) => {
  const { dir, ctx, tool } = await fixture(t);
  const file = join(dir, "shared.txt");
  await writeFile(file, "old\n");
  let markStarted = () => {};
  let releaseRead = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const editor = createEditToolDefinition(dir, {
    operations: {
      access: async () => {},
      readFile: async (path) => { markStarted(); await gate; return readFile(path); },
      writeFile: (path, content) => writeFile(path, content),
    },
  });
  const editing = editor.execute("edit", { path: file, edits: [{ oldText: "old", newText: "edited" }] }, undefined, undefined, ctx);
  await started; // The edit now owns the queue, but has not modified the file.
  const writing = tool.execute("write", { path: file, content: "written\n" }, undefined, undefined, ctx);
  releaseRead();
  const [edit, write] = await Promise.all([editing, writing]);
  assert.match(edit.details!.diff, /edited/);
  assert.match(write.details.harpyDiff.diff!, /-1 edited/);
});

test("preview capture failures do not prevent writes or pretend the old file was empty", async (t) => {
  const { dir, ctx } = await fixture(t);
  const file = join(dir, "file.txt");
  await writeFile(file, "old");
  const tool = createPreviewWriteTool(dir, async () => { throw new Error("simulated unreadable file"); });
  const result = await tool.execute("test", { path: file, content: "new" }, undefined, undefined, ctx);
  assert.equal(await readFile(file, "utf8"), "new");
  assert.equal(result.details.harpyDiff.diff, undefined);
  assert.equal(result.details.harpyDiff.created, undefined);
  assert.match(result.details.harpyDiff.note!, /omitted/);
});

test("unreadable originals are not classified as missing", async (t) => {
  const { dir } = await fixture(t);
  const file = join(dir, "unreadable.txt");
  await writeFile(file, "secret");
  await chmod(file, 0o200);
  try {
    const snapshot = await readSnapshot(file);
    if (process.getuid?.() !== 0) assert.ok("skipped" in snapshot);
  } finally { await chmod(file, 0o600); }
});

test("abort after capture and native write errors are preserved", async (t) => {
  const { dir, ctx, write } = await fixture(t);
  const file = join(dir, "abort.txt");
  await writeFile(file, "old");
  const controller = new AbortController();
  const tool = createPreviewWriteTool(dir, async (path) => {
    const result = await readSnapshot(path);
    controller.abort();
    return result;
  });
  await assert.rejects(tool.execute("abort", { path: file, content: "new" }, controller.signal, undefined, ctx));
  assert.equal(await readFile(file, "utf8"), "old");
  await assert.rejects(write(dir, "cannot overwrite a directory"));
  // A failed/aborted operation must not poison the mutation queue.
  await write(file, "recovered");
  assert.equal(await readFile(file, "utf8"), "recovered");
});

test("large and binary originals skip previews; large new content still writes successfully", async (t) => {
  const { dir, write } = await fixture(t);
  const file = join(dir, "large.txt");
  await writeFile(file, "a".repeat(MAX_FILE_BYTES + 1));
  const small = await write(file, "small");
  assert.match(small.details.harpyDiff.note!, /original over/);
  const bigContent = "b".repeat(MAX_FILE_BYTES + 1);
  const big = await write(file, bigContent);
  assert.match(big.details.harpyDiff.note!, /new content over/);
  assert.equal(await readFile(file, "utf8"), bigContent);
  await writeFile(file, Buffer.from([0, 1, 2]));
  assert.match((await write(file, "text")).details.harpyDiff.note!, /binary/);
  await writeFile(file, Buffer.from([0xff, 0xfe]));
  assert.ok("skipped" in await readSnapshot(file));
  await writeFile(file, "\uFEFFtext");
  assert.deepEqual(await readSnapshot(file), { content: "\uFEFFtext", created: false });
  assert.ok("skipped" in await readSnapshot(dir));
  await writeFile(file, "x\n".repeat(1001));
  assert.match((await write(file, "text")).details.harpyDiff.note!, /1000 lines/);
});

test("empty creations, identical overwrites and final-newline changes have distinct metadata", async (t) => {
  const { write } = await fixture(t);
  const created = (await write("empty.txt", "")).details.harpyDiff;
  assert.equal(created.created, true);
  assert.equal(created.diff, "");
  const unchanged = (await write("empty.txt", "")).details.harpyDiff;
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.diff, "");
  assert.match(buildWritePreview({ content: "line\n", created: false }, "line").note!, /Final newline/);
});

test("all Harpy extensions load against Pi 1.5; diff-view only instruments write, not edit", async (t) => {
  const { dir } = await fixture(t);
  const loaded = await discoverAndLoadExtensions([resolve("extensions")], dir, dir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 4);
  const extension = loaded.extensions.find((extension) => extension.path.endsWith("diff-view.ts"))!;
  assert.ok(extension);
  assert.deepEqual([...extension.tools.keys()], ["write"]);
  assert.equal(extension.toolRenderers?.length, 1);
  assert.equal(extension.handlers.has("tool_call"), false);
  assert.equal(extension.handlers.has("tool_result"), false);
  assert.deepEqual(extension.tools.get("write")?.definition.promptGuidelines, ["Use write only for new files or complete rewrites."]);
});

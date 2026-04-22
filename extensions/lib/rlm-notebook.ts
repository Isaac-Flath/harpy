import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Resolve the harpy repo root from this file's location: extensions/lib/rlm-notebook.ts
// → two `..` up → harpy root. Used to bake the rlm-server path into the notebook
// bootstrap cell so the notebook is self-locating.
const HARPY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Minimal nbformat 4.5 cell types — hand-built to avoid a runtime nbformat dep.

interface BaseCell {
  cell_type: "markdown" | "code" | "raw";
  id: string;
  metadata: Record<string, unknown>;
  source: string[];
}

interface MarkdownCell extends BaseCell {
  cell_type: "markdown";
}

interface RawCell extends BaseCell {
  cell_type: "raw";
}

interface CodeCell extends BaseCell {
  cell_type: "code";
  execution_count: number | null;
  outputs: Output[];
}

type Cell = MarkdownCell | RawCell | CodeCell;

type Output =
  | {
      output_type: "stream";
      name: "stdout" | "stderr";
      text: string[];
    }
  | {
      output_type: "display_data";
      data: Record<string, string[]>;
      metadata: Record<string, unknown>;
    };

interface Notebook {
  cells: Cell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

type LogEntry = { type: string; [k: string]: unknown };

// nbformat requires each cell's `source` and stream `text` to be either a
// single string or an array of strings whose elements end in \n (except
// possibly the last). We normalize to the array form.
function splitLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    if (isLast && parts[i] === "") continue;
    out.push(isLast ? parts[i] : parts[i] + "\n");
  }
  return out;
}

function mdCell(text: string, idGen: () => string): MarkdownCell {
  return {
    cell_type: "markdown",
    id: idGen(),
    metadata: {},
    source: splitLines(text),
  };
}

function rawCell(text: string, idGen: () => string): RawCell {
  return {
    cell_type: "raw",
    id: idGen(),
    metadata: {},
    source: splitLines(text),
  };
}

function codeCell(
  code: string,
  outputs: Output[],
  idGen: () => string,
): CodeCell {
  return {
    cell_type: "code",
    id: idGen(),
    metadata: {},
    execution_count: null,
    source: splitLines(code),
    outputs,
  };
}

function streamOut(name: "stdout" | "stderr", text: string): Output {
  return { output_type: "stream", name, text: splitLines(text) };
}

function bootstrapCell(
  meta: LogEntry,
  idGen: () => string,
): CodeCell {
  // For scalar strings/numbers we embed directly — JSON.stringify produces valid
  // Python literals for those types. But the `leads` snapshot can contain JSON
  // `null`/`true`/`false` which aren't valid Python, so we base64-encode it and
  // json.loads() inside the cell. This also sidesteps triple-quote collisions.
  const pyJson = (v: unknown): string => JSON.stringify(v ?? null);
  const leads = meta.initial_leads ?? [];
  const leadsB64 = Buffer.from(JSON.stringify(leads), "utf-8").toString(
    "base64",
  );

  const code = `# RLM rerun bootstrap — launches a local server and installs RPC shims.
# Modify/delete this cell at your own risk; the code below expects these builtins.
import atexit, json, os, subprocess, sys
from urllib import request, error

HARPY_ROOT = ${pyJson(HARPY_ROOT)}
SERVER_ARGS = [
    "npx", "tsx", os.path.join(HARPY_ROOT, "scripts", "rlm-server.ts"),
    "--investigator-provider", ${pyJson(meta.investigator_provider)},
    "--investigator-model",    ${pyJson(meta.investigator_model)},
    "--analyst-provider",      ${pyJson(meta.analyst_provider)},
    "--analyst-model",         ${pyJson(meta.analyst_model)},
    "--max-iterations",        str(${JSON.stringify(meta.max_iterations ?? 40)}),
    "--max-recursive-calls",   str(${JSON.stringify(meta.max_recursive_calls ?? 2)}),
    "--max-budget",            str(${JSON.stringify(meta.max_budget ?? 1.0)}),
]

_proc = subprocess.Popen(
    SERVER_ARGS, cwd=HARPY_ROOT,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
)

def _shutdown():
    try:
        _proc.terminate(); _proc.wait(timeout=3)
    except Exception:
        try: _proc.kill()
        except Exception: pass
atexit.register(_shutdown)

_line = _proc.stdout.readline()
if not _line:
    err = _proc.stderr.read()
    raise RuntimeError(f"rlm-server exited before handshake.\\nstderr:\\n{err}")
_info = json.loads(_line)
_BASE = f"http://127.0.0.1:{_info['port']}"
_TOKEN = _info["token"]
print(f"rlm-server ready at {_BASE}")

def _rpc(method, **params):
    body = json.dumps(params).encode("utf-8")
    req = request.Request(
        f"{_BASE}/{method}", data=body,
        headers={"Content-Type": "application/json", "X-RLM-Token": _TOKEN},
        method="POST",
    )
    try:
        with request.urlopen(req) as resp:
            data = json.loads(resp.read())
    except error.HTTPError as e:
        data = json.loads(e.read())
    if "error" in data:
        raise RuntimeError(f"{method} failed: {data['error']}")
    return data["result"]

def kb_search(query, k=5, scope="wiki", pattern=None):
    return _rpc("kb_search", query=query, k=k, scope=scope, pattern=pattern)

def kb_read(path):
    return _rpc("kb_read", path=path)

def llm_query(prompt, model=None):
    return _rpc("llm_query", prompt=prompt, model=model)

def llm_query_batched(prompts, model=None):
    return _rpc("llm_query_batched", prompts=prompts, model=model)

def rlm_query(prompt, context=None, model=None):
    return _rpc("rlm_query", prompt=prompt, context=context, model=model)

def rlm_query_batched(prompts, contexts=None, model=None):
    return _rpc("rlm_query_batched", prompts=prompts, contexts=contexts, model=model)

def FINAL(answer):
    globals()["__final__"] = answer
    print(f"FINAL: {answer!r}")

def FINAL_VAR(name):
    FINAL(globals()[name])

def SHOW_VARS():
    return {k: type(v).__name__ for k, v in globals().items()
            if not k.startswith("_") and not callable(v)}

# Preload \`context\` from the original investigation's initial leads snapshot.
import base64 as _b64
context = json.loads(_b64.b64decode("${leadsB64}"))
print(f"context loaded: {len(context) if hasattr(context, '__len__') else type(context).__name__}")
`;
  return codeCell(code, [], idGen);
}

function displayOut(text: string): Output {
  return {
    output_type: "display_data",
    data: { "text/plain": splitLines(text) },
    metadata: {},
  };
}

function fmt4(n: unknown): string {
  return typeof n === "number" ? n.toFixed(4) : "?";
}

function readEntries(logPath: string): LogEntry[] {
  const content = readFileSync(logPath, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LogEntry);
}

export function renderNotebook(logPath: string): string {
  const entries = readEntries(logPath);

  let cellId = 0;
  const nextId = (): string => `rlm-${(cellId++).toString().padStart(4, "0")}`;

  // Build (inv_id, turn, block_index) → block_result lookup.
  const blockResults = new Map<string, LogEntry>();
  for (const e of entries) {
    if (e.type === "block_result") {
      const key = `${e.inv_id}|${e.i}|${e.block_index}`;
      blockResults.set(key, e);
    }
  }

  const cells: Cell[] = [];

  // Front matter — from the outer `metadata` entry (written by rlm.ts).
  const meta = entries.find((e) => e.type === "metadata");
  if (meta) {
    // Cell 1: raw cell with YAML front matter only.
    const frontMatter = [
      "---",
      `question: ${JSON.stringify(meta.question)}`,
      `investigator: ${meta.investigator_provider}/${meta.investigator_model}`,
      `analyst: ${meta.analyst_provider}/${meta.analyst_model}`,
      `max_iterations: ${meta.max_iterations}`,
      `max_recursive_calls: ${meta.max_recursive_calls}`,
      `max_budget: ${meta.max_budget}`,
      `scope: ${meta.scope ?? "(default mixed)"}`,
      `k: ${meta.k}`,
      `initial_leads_count: ${meta.initial_leads_count}`,
      `log_path: ${logPath}`,
      "---",
    ].join("\n");
    cells.push(rawCell(frontMatter, nextId));

    // Cell 2: markdown with the question and rerun explanation.
    const prose = [
      `**${meta.question}**`,
      "",
      "The next cell launches a local `rlm-server` and installs the RLM builtins (`kb_search`, `llm_query`, `rlm_query`, ...) so you can modify any code cell below and re-run it against live models. Cells below this bootstrap show what the investigator actually did on the original run — running them again will produce a **different** trajectory because LM calls aren't deterministic.",
    ].join("\n");
    cells.push(mdCell(prose, nextId));

    cells.push(bootstrapCell(meta, nextId));
  }

  // Walk log in order. Each investigation's entries appear contiguously
  // (within a depth level) but children can interleave between a parent's
  // code_block and its matching block_result — that's fine, the notebook
  // reads as a timeline.
  for (const e of entries) {
    switch (e.type) {
      case "investigation_start": {
        const header =
          e.depth === 0
            ? `## Root investigation · \`${e.inv_id}\``
            : `## Nested investigation · depth ${e.depth} · \`${e.inv_id}\``;
        const body = [
          header,
          "",
          `**Question:** ${e.question}`,
          "",
          `investigator: \`${e.investigator_model}\` · analyst: \`${e.analyst_model}\` · max_iter: ${e.max_iterations} · max_recursive_calls: ${e.max_recursive_calls} · budget: $${fmt4(e.max_budget)}`,
        ].join("\n");
        cells.push(mdCell(body, nextId));
        break;
      }
      case "turn_start": {
        cells.push(
          mdCell(`### Turn ${e.i} · depth ${e.depth} · \`${e.inv_id}\``, nextId),
        );
        break;
      }
      case "assistant_message": {
        const text = (e.text as string) ?? "";
        if (text.length > 0) {
          cells.push(mdCell(text, nextId));
        } else {
          cells.push(
            mdCell(
              `_(empty assistant response, stop_reason=${e.stop_reason ?? "unknown"})_`,
              nextId,
            ),
          );
        }
        break;
      }
      case "code_block": {
        const key = `${e.inv_id}|${e.i}|${e.block_index}`;
        const result = blockResults.get(key);
        const outputs: Output[] = [];
        if (result) {
          if (result.stdout) {
            outputs.push(streamOut("stdout", result.stdout as string));
            if (result.stdout_truncated) {
              outputs.push(
                streamOut("stderr", "(stdout truncated at 20000 chars)"),
              );
            }
          }
          if (result.stderr) outputs.push(streamOut("stderr", result.stderr as string));
          if (result.error) {
            outputs.push(streamOut("stderr", `Exception: ${result.error}`));
          }
          if (result.final_answer !== undefined) {
            const fa =
              typeof result.final_answer === "string"
                ? result.final_answer
                : JSON.stringify(result.final_answer, null, 2);
            outputs.push(displayOut(`FINAL ANSWER:\n\n${fa}`));
          }
        } else {
          outputs.push(
            streamOut("stderr", "(no block_result logged — run may have crashed mid-block)"),
          );
        }
        cells.push(codeCell(e.code as string, outputs, nextId));
        break;
      }
      case "turn_end":
        // No cell — the Turn header + code cell outputs already convey the
        // per-turn state. Cost/cumulative are available in the NDJSON for
        // anyone who wants them.
        break;
      case "investigation_end": {
        // Depth 0 gets its summary from the `## Final` cell at the end of the
        // notebook. Only emit an End marker for nested (child) investigations,
        // where it helps delimit the child's block in the timeline.
        if ((e.depth as number) > 0) {
          cells.push(
            mdCell(
              `**End nested investigation** · depth ${e.depth} · \`${e.inv_id}\` · ${e.terminated_reason} · $${fmt4(e.total_cost)} · ${e.turns} turn(s)`,
              nextId,
            ),
          );
        }
        break;
      }
      case "rlm_query_short_circuit":
      case "rlm_query_batched_short_circuit": {
        cells.push(
          mdCell(
            `_${e.type} · depth ${e.depth} · \`${e.inv_id}\` · reason=${e.reason} · cost $${fmt4(e.cost)}_`,
            nextId,
          ),
        );
        break;
      }
      case "final": {
        const body = [
          `## Final`,
          "",
          `- **terminated:** ${e.terminated_reason}`,
          `- **total cost:** $${fmt4(e.total_cost)}`,
          `- **turns:** ${e.turns}`,
          `- **elapsed:** ${
            typeof e.elapsed_ms === "number"
              ? (e.elapsed_ms / 1000).toFixed(1) + "s"
              : "?"
          }`,
        ].join("\n");
        cells.push(mdCell(body, nextId));
        break;
      }
      // metadata, rpc_call, empty_assistant_text: skipped — metadata handled
      // up top, rpc_call noise is redundant with the code cell outputs,
      // empty_assistant_text surfaces via the assistant_message fallback.
    }
  }

  const nb: Notebook = {
    cells,
    metadata: {
      kernelspec: {
        name: "python3",
        display_name: "Python 3 (RLM)",
        language: "python",
      },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };

  return JSON.stringify(nb, null, 1);
}

export function writeNotebook(logPath: string, notebookPath: string): void {
  writeFileSync(notebookPath, renderNotebook(logPath));
}

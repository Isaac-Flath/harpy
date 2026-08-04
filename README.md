# harpy

Harpy is my personal [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) package.
It bundles repo-local extensions and prompt additions.

Clone the repo, run `./setup.sh`, restart Pi, and Pi will load this checkout.

I built this for myself first. You are welcome to use it or copy pieces from it, but expect rough edges and opinionated defaults.

## Quick start

### Prerequisites

- Node.js 20+
- Pi installed locally

If Pi is not installed yet:

```bash
npm install -g @mariozechner/pi-coding-agent
```

Install Harpy:

```bash
git clone https://github.com/Isaac-Flath/harpy.git
cd harpy
./setup.sh
```

Then restart Pi and verify the install:

```bash
npm run typecheck
pi -p "List available tools" --no-session
```

## What `setup.sh` does

`./setup.sh` is the main install and update step. It:

1. Installs npm dependencies.
2. Symlinks `prompts/APPEND_SYSTEM.md` to `~/.pi/agent/APPEND_SYSTEM.md`.
3. Adds this repo's `extensions/` directory to `~/.pi/agent/settings.json`.
4. Points the `skills` path in `~/.pi/agent/settings.json` at `~/.agents/skills` (maintained by `agentkb skills link`) and removes dead skill symlinks left by older setups.

Re-run `./setup.sh` after changing prompts or extensions.

## What's included

| Path | Purpose |
|---|---|
| `extensions/agentkb.ts` | Adds `kb_search` (all AgentKB stores) and `kb_paths` (store paths for direct file access) |
| `extensions/colgrep.ts` | Adds `colgrep` semantic + regex code search |
| `extensions/git-dashboard.ts` | Adds `git_dashboard` for a one-call repo snapshot |
| `extensions/review-prep.ts` | Adds `review_prep` for commits, diffstat, and diff |
| `extensions/list-dir.ts` | Adds `list_dir` for recursive tree views |
| `extensions/web.ts` | Adds `web_fetch` for web pages, YouTube transcripts, and PDFs |
| `extensions/gemini.ts` | Adds `gemini` for PDF, image, and video analysis |
| `extensions/pyramid.ts` | Adds `pyramid` for Minto-pyramid communication: recommendations, plans, and argument structures, answer-first |
| `extensions/subagent.ts` | Adds `subagent` for delegating tasks to agents defined in `agents/*.md` |
| `agents/signal-librarian.md` | Demand-research subagent: compiles demand-evidence briefs from the AgentKB signal database |
| `extensions/bash-view.ts` | Collapses `bash` output to one line: command + `✓ N lines`, with a one-line live tail while running |
| `extensions/diff-view.ts` | Improves how `edit` and `write` diffs render |
| `extensions/read-view.ts` | Improves collapsed summaries for `read` output and merges consecutive reads into one `read N files: …` line |
| `extensions/prevent-idle-sleep.ts` | Prevents macOS idle sleep with `caffeinate` |
| `extensions/resume-last.ts` | Prints the exact `pi --session ...` command to resume the current session when Pi exits |
| `prompts/APPEND_SYSTEM.md` | Extends the system prompt with AgentKB, colgrep, GitHub API, and Gemini guidance |

## Optional integrations

Harpy works as a basic Pi package with just Node and Pi. A few tools need extra local setup.

### AgentKB

AgentKB-related tools depend on a local AgentKB install and local AgentKB data.

That affects:

- `kb_search`
- `kb_paths`
- AgentKB skills discovered via `~/.agents/skills` (maintained by `agentkb skills link`)

### LLM fanout

Harpy includes a lightweight LLM call server and Python client so the agent can write scripts that fan out cheap model calls. The server handles auth and model resolution via Pi's ModelRegistry; the Python module auto-starts it and exposes `llm_query` and `llm_query_batched`.

```python
from harpy_llm import llm_query, llm_query_batched

answer = llm_query("Summarize this: ...")
answers = llm_query_batched(["Is this relevant?", "Is that relevant?"])
```

The server is at `scripts/llm-server.ts` (`npm run llm-server` to run by hand). The Python client is at `scripts/harpy_llm.py`. Override the default model with `HARPY_LLM_PROVIDER` and `HARPY_LLM_MODEL` env vars.

### Gemini

The `gemini` extension calls the Gemini API directly.

Set one of these up before using it:

```bash
# Direct Gemini API
export GEMINI_API_KEY=...

# Optional Vertex AI fallback
export GOOGLE_GENAI_USE_VERTEXAI=true
export VERTEX_AI_API_KEY=...   # or GOOGLE_API_KEY=...
```

The tool tries the direct Gemini API first. If that fails, it retries with Vertex AI when configured.
Use it for PDFs, images, and videos. Do not use it as a general code or long-context text tool.

## Scripts

- `./setup.sh`: installs dependencies and wires Harpy into `~/.pi/agent/`
- `npm run typecheck`: type-checks the extensions
- `npm run llm-server`: starts the LLM fanout HTTP server (auto-started by `harpy_llm.py` when imported)
- `scripts/harpy_llm.py`: Python module with `llm_query` and `llm_query_batched` for scripted fanout

## Run Pi

```bash
pi
pi -p "query" --no-session
```

## Who this is for

Use this repo if you already use Pi and want a working set of extra tools and prompts without building everything yourself.

If you want a polished starter kit, this is probably not it.
The easiest way to borrow from Harpy is usually to point an agent at this repo and ask it to copy the parts you want into your own setup.

## Notes

- `prevent-idle-sleep` is macOS-only and starts automatically when Pi starts.
- You do not need to adopt the whole repo. Copy the ideas you like.
- If Harpy saves you time, leave a star.

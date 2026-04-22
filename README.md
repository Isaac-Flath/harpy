# harpy

Custom extensions, themes, and prompts for [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Install

```bash
npm install -g @mariozechner/pi-coding-agent
cd ~/git/harpy && ./setup.sh
```

`setup.sh` installs npm dependencies, symlinks prompts, and registers extensions/themes in `~/.pi/agent/settings.json`. Re-run it after adding new configs.

### Notes

- `prevent-idle-sleep` is macOS-only and starts automatically on Pi startup.
- Set `PI_PREVENT_IDLE_SLEEP=false` to opt out.

## Test

```bash
npx tsc --noEmit                                      # type-check
pi -p "List available tools" --no-session            # verify extensions load
```

## Run

```bash
pi              # interactive
pi -p "query"   # one-shot
```

## Gemini tool

The `gemini` tool uses the Gemini API directly from the Pi extension layer.

Requirements:

```bash
# Direct Gemini API
export GEMINI_API_KEY=...

# Optional Vertex AI fallback
export GOOGLE_GENAI_USE_VERTEXAI=true
export VERTEX_AI_API_KEY=...   # or GOOGLE_API_KEY=...
```

The tool tries the direct Gemini API path first and, if that errors, retries with Vertex AI when configured.
Use it only for PDFs, images, and videos. It is not intended as a general long-context or harder-reasoning tool.

## What's included

| Directory | Contents |
|-----------|----------|
| `extensions/list-dir.ts` | `list_dir` tool -- recursive directory tree with depth, filter, dirs-only |
| `extensions/agentkb.ts` | `kb_search`, `kb_read`, `kb_wiki_path` -- persistent knowledge base access |
| `extensions/git-dashboard.ts` | `git_dashboard` tool -- one-call repo snapshot (branch, upstream, status, recent commits) |
| `extensions/review-prep.ts` | `review_prep` tool -- commits + diffstat + full diff for code review and PR prep |
| `extensions/colgrep.ts` | `colgrep` tool -- semantic + regex code search wrapping colgrep's JSON output |
| `extensions/gemini.ts` | `gemini` tool -- Gemini analysis for PDFs, images, and videos |
| `extensions/think.ts` | `think` tool -- structured reasoning step between actions |
| `extensions/prevent-idle-sleep.ts` | macOS idle-sleep prevention via `caffeinate -i -w <pid>` |
| `extensions/diff-view.ts` | Enhanced diff rendering -- colored backgrounds, word-level highlights, side-by-side view |
| `themes/ghostie.json` | Light theme for Ghostty's Tomorrow Night palette on a light background |
| `prompts/APPEND_SYSTEM.md` | Global prompt additions (agentkb, colgrep, GitHub API, and Gemini guidance) |

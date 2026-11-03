# harpy

Harpy is my personal [Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) package.
It adds display improvements, macOS idle sleep prevention, and a small collection of personal content-workflow skills.
It appends a short personal tool-awareness note through `APPEND_SYSTEM.md`, preserving Pi's default system prompt.

Clone the repo, run `./setup.sh`, restart Pi, and Pi will load this checkout.

I built this for myself first. You are welcome to use it or copy pieces from it, but expect rough edges and opinionated defaults.

## Quick start

### Prerequisites

- Node.js 22.19+
- Pi 1.5.0+ installed locally

If Pi is not installed yet:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Install Harpy:

```bash
git clone https://github.com/Isaac-Flath/harpy.git
cd harpy
./setup.sh
```

Sign in to each MCP once (opens your browser), then start Pi:

```bash
pi mcp login ordinal
pi mcp login figma
pi mcp list
pi
```

Subsequent starts load the two skills, system append, and MCP connections
automatically. Pi stores OAuth credentials locally in `~/.pi/agent/mcp-auth.json`
and refreshes them as needed; no API keys belong in this repo. Use `/mcp` to inspect
connections or sign in again. MCP tools are discovered on demand to keep the prompt
small. No extra MCP adapter extension is needed; use a Pi version with built-in
MCP support.

If Figma rejects OAuth client registration, consult Pi's MCP troubleshooting
options before changing the server configuration. A project-level `.pi/mcp.json`
can override a global server.

Check the extensions with `npm run typecheck && npm test`.

## What `setup.sh` does

`./setup.sh` is the main install and update step. It:

1. Installs npm dependencies.
2. Migrates this checkout's old instruction symlinks; unrelated user files are left alone.
3. Adds this repo's `extensions/` directory to `~/.pi/agent/settings.json`.
4. Adds this repo's `skills/` directory to `~/.pi/agent/settings.json` and removes dead skill symlinks left by older setups.
5. Links `APPEND_SYSTEM.md` as `~/.pi/agent/APPEND_SYSTEM.md` if that location is free. Existing user instructions are left untouched with a manual-merge notice. A trusted project's `.pi/APPEND_SYSTEM.md` takes precedence over the global file.
6. Adds the Ordinal and Figma defaults from `mcp.json` to `~/.pi/agent/mcp.json`. Existing server entries, custom settings, and credentials are preserved; repo defaults are only applied for missing entries.

Running setup enables discovery of the curated skills in `skills/`. See `skills/README.md` for scope, sources, and external requirements.

Restart Pi or run `/reload` after changing extensions or skills.

## What's included

| Path | Purpose |
|---|---|
| `extensions/bash-view.ts` | Collapses `bash` output to one line: command + `✓ N lines`, with a one-line live tail while running |
| `extensions/diff-view.ts` | Improves how `edit` and `write` diffs render |
| `extensions/read-view.ts` | Improves collapsed summaries for `read` output and merges consecutive reads into one `read N files: …` line |
| `extensions/prevent-idle-sleep.ts` | Prevents macOS idle sleep with `caffeinate` |
| `APPEND_SYSTEM.md` | Personal tools, secrets location, timezone, storage facts, and public-delivery approval rule |
| `mcp.json` | Official Ordinal and Figma MCP defaults installed by setup |
| `skills/` | Two optional skills: content publishing and visual style; see `skills/README.md` |

## Diff display

`extensions/diff-view.ts` customizes the `edit` and `write` display without adding
model calls or changing their model-facing output. Non-Markdown files collapse to
an action and `+added −removed` line counts; `.md` and `.mdx` keep a short inline
preview. Expand tool output (normally `Ctrl+O`; the hint follows your keybindings)
for more detail. Tabs display as `→` followed by two spaces, and carriage returns
as `␍`, so whitespace-only changes remain visible.

The default layout is unified below 140 available columns and side-by-side above
that. Override it for one invocation or set a shell preference:

```bash
pi --diff-layout unified
pi --diff-layout split
export HARPY_DIFF_LAYOUT=auto  # auto | unified | split
```

Even forced split falls back to unified below 60 columns. Invalid preferences
warn and fall back to `auto`. Restart Pi after changing the environment variable.

Edit execution stays with Pi. Write previews use a small wrapper around Pi's
local write operations: old contents are captured inside Pi's per-file mutation
queue, using Pi's resolved path. Missing, unreadable, binary, and oversized
originals are distinguished; failed preview capture never prevents a write.
As with other tool overrides, a different extension replacing `write` can replace
this capture wrapper (for example a remote-filesystem extension).

Previews are deliberately bounded: each write input is limited to 64 KiB and
1,000 lines **for diff computation only**, not for the write itself. Larger diffs
show an omission notice. Rendered previews show up to 20 rows when collapsed and
2,000 when expanded, clip individual source lines at 4,000 characters with a
notice, and bound word-level comparisons. These limits keep large/generated
files from stalling the UI. Diff metadata is saved with the tool result for
resume/export, but is not injected into the model's text context.

## Scripts

- `./setup.sh`: installs dependencies and wires Harpy into `~/.pi/agent/`
- `npm run typecheck`: type-checks the extensions and tests against Pi 1.5.0
- `npm test`: runs diff, rendering, file-write, and extension-loading regression tests

## Run Pi

```bash
pi
pi -p "query" --no-session
```

## Who this is for

Use this repo if you already use Pi and want compact tool displays, macOS sleep prevention, and minimal personal content-tool context.

If you want a polished starter kit, this is probably not it.
The easiest way to borrow from Harpy is usually to point an agent at this repo and ask it to copy the parts you want into your own setup.

## Notes

- `prevent-idle-sleep` is macOS-only and starts automatically when Pi starts.
- You do not need to adopt the whole repo. Copy the ideas you like.
- If Harpy saves you time, leave a star.

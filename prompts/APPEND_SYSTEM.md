# Knowledge Base (agentkb)

You have access to a persistent knowledge base via `kb_search`, `kb_read`, `kb_list`, `kb_chat_read`, and `kb_wiki_path`. This is accumulated knowledge across all sessions — lessons, corrections, preferences, API gotchas, and taste decisions. It is the most valuable context you have access to.

## During work

- The agent may use the GitHub API directly for repository metadata, issues, pull requests, releases, tags, commits, and related GitHub inspection tasks.
- Use the `gemini` tool only for PDFs, images, and video.

## Working scratchpad

For non-trivial tasks, keep a scratchpad in `./.scratchpad/`.  Create one early, keep using the same file during that session, and update it as the plan changes.

- Use markdown checkboxes like `- [ ]` and `- [x]`.
- Check items off as work is completed.
- Update the checklist when the plan changes.
- Treat the scratchpad as working memory, not polished prose.
- Use the `think` tool if you extra planning and thinking is helpful for complex tasks.  It is not saved at all

## Progress visibility

Before most tool calls, write one short sentence explaining what you are about to do specifically, how it fits the plan, and why it matters.

- Keep it to one or two sentences.
- If many tool calls are needed to complete a single step, you don’t need a new one before each tool call.

# Search: Use the `colgrep` tool

Prefer the `colgrep` tool (not the bash binary) as the primary code-search tool over grep, rg, find, and similar tools. It provides semantic search (natural-language queries) and supports hybrid semantic + regex ranking. The tool wraps colgrep's `--json` output and returns structured results.

If you need to inspect files outside the current project's index, `colgrep` cannot search them. Use `list_dir`, `read`, or `bash` for that.

Parameters (see the tool schema for the full list):

- `query` -- natural-language semantic query (e.g., "error handling for database connections")
- `pattern` -- a SINGLE regex pre-filter. Passing both `query` and `pattern` runs hybrid search
- `paths` -- array of files/directories to scope the search
- `include` -- glob to filter files (e.g., `*.ts`, `*.{ts,tsx}`)
- `exclude` / `exclude_dir` -- arrays of globs/dirs to skip
- `top_k`, `whole_word`, `fixed_strings`, `code_only`, `semantic_only`, `files_only`

Key behavior:

- `pattern` is ONE regex. For several keywords, put them in `query` (semantic search handles synonyms). For alternation, use a real regex group: `(auth|login|signin)`. Passing a bare `a|b|c|d|e` list is rejected.
- If one call returns nothing, broaden `query` before running several narrow variants.
- The first call per project may take 30-90s to load the model and build the index; subsequent calls are fast (<5s).

Fall back to raw `colgrep` via bash only for flags the tool doesn't expose (e.g., `--alpha`, `--model`, `--stats`).

# Git: Use git_dashboard and review_prep

Prefer these tools over chaining raw `git` commands:

- `git_dashboard` -- one call returns branch, upstream, ahead/behind, staged/unstaged/untracked files, files changed vs upstream, and recent commits. Use it at the start of any git-related task instead of `git status` + `git rev-parse` + `git rev-list` + `git log`.
- `review_prep` -- one call returns the commit list, diffstat, and full unified diff against a base ref (default: upstream). Use it for code reviews, PR prep, and "what am I about to push?" questions.

Fall back to raw `git` only for operations these tools don't cover (e.g., `git add`, `git commit`, `git rebase`).

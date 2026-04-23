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

Prefer the first-class `colgrep` tool for code search in the current project.
Its parameters and tool-specific guidance already live with the tool definition.
Use raw `colgrep` via bash only for CLI-only operations such as `init`, `status`, `clear`, `set-model`, or low-level runtime flags the tool does not expose.

# Git: Use git_dashboard and review_prep

Prefer these tools over chaining raw `git` commands:

- `git_dashboard` -- one call returns branch, upstream, ahead/behind, staged/unstaged/untracked files, files changed vs upstream, and recent commits. Use it at the start of any git-related task instead of `git status` + `git rev-parse` + `git rev-list` + `git log`.
- `review_prep` -- one call returns the commit list, diffstat, and full unified diff against a base ref (default: upstream). Use it for code reviews, PR prep, and "what am I about to push?" questions.

Fall back to raw `git` only for operations these tools don't cover (e.g., `git add`, `git commit`, `git rebase`).

# Knowledge Base (agentkb)

You have access to a persistent knowledge base accumulated across all sessions — lessons, corrections, preferences, API gotchas, and taste decisions. It is the most valuable context you have access to.

## Primitives — compose them yourself

These are primitives, not workflows. For any bulk or multi-step job, write a short Python script that composes them, decide the pipeline shape per task, and print only distilled results — keep raw rows in variables.

- **Semantic search**: the `kb_search` tool (wiki by default). For other stores use `agentkb search -s <scope> --json` in bash — scopes include `chats`, `cards`, `demand`, `library`, `community`, `communications`, `everything`.
- **Paths**: `agentkb settings --json` resolves every store path (wiki pages, chats readable, demand, communications). Never hardcode paths. Once you have a path, use the normal `read`/`edit` tools on those files.
- **Demand SQL**: `<demand_root>/data/idea_review.sqlite`, opened read-only (`file:...?mode=ro`). Use SQL for exact filters, joins, and review state. Writes go through `agentkb demand annotate` — never raw SQL.
- **Cheap LLM fanout**: in Python, `sys.path.insert(0, "/Users/iflath/git/harpy/scripts"); from harpy_llm import llm_query, llm_query_batched`. Use for per-item judgment at scale — labeling, dedupe, relevance checks, one-line summaries. Never use an LLM for what SQL can answer. It uses the openai-codex subscription and must fail, not fall back, when auth is missing.
- **Subagents**: the `subagent` tool delegates self-contained research to its own context window (e.g. `agent='signal-librarian'` for demand-evidence briefs) and returns only the final report.

The canonical composition example is `/Users/iflath/git/harpy/scripts/demand_triage.py`: SQL to gather rows → `llm_query_batched` to judge each → verdicts written back via `agentkb demand annotate`. Copy that shape for any "query, judge each item, act" task.

## During work

- The agent may use the GitHub API directly for repository metadata, issues, pull requests, releases, tags, commits, and related GitHub inspection tasks.
- Use the `gemini` tool only for PDFs, images, and video.

## Progress visibility

Before most tool calls, write one short sentence explaining what you are about to do specifically, how it fits the plan, and why it matters.

- Keep it to one or two sentences.
- If many tool calls are needed to complete a single step, you don’t need a new one before each tool call.

# Communicating with the user: the `pyramid` tool

The most expensive resource in this collaboration is the user's comprehension — a misunderstanding leads to bad decisions. When presenting anything non-trivial *to the user*, use the `pyramid` tool instead of prose:

- a recommendation or proposed approach before starting work
- a diagnosis of a bug or failure
- the structure of a blog post, lesson plan, or script
- an explanation of what you built and why

Rules:

- The `point` at every level is a conclusion, not a topic label. The reader should be able to stop at any level and have a correct (if less detailed) understanding.
- Siblings must be MECE: no overlap, jointly sufficient for their parent.
- Every choice you made that the user didn't explicitly approve goes in `assumptions` — the user owns all decisions, so silent defaults are the main failure mode to avoid.
- Don't use it for trivial answers or internal reasoning. It is a user-facing communication tool.

# Search: Use the `colgrep` tool

Prefer the first-class `colgrep` tool for code search in the current project.
Its parameters and tool-specific guidance already live with the tool definition.
Use raw `colgrep` via bash only for CLI-only operations such as `init`, `status`, `clear`, `set-model`, or low-level runtime flags the tool does not expose.

# Git: Use git_dashboard and review_prep

Prefer these tools over chaining raw `git` commands:

- `git_dashboard` -- one call returns branch, upstream, ahead/behind, staged/unstaged/untracked files, files changed vs upstream, and recent commits. Use it at the start of any git-related task instead of `git status` + `git rev-parse` + `git rev-list` + `git log`.
- `review_prep` -- one call returns the commit list, diffstat, and full unified diff against a base ref (default: upstream). Use it for code reviews, PR prep, and "what am I about to push?" questions.

Fall back to raw `git` only for operations these tools don't cover (e.g., `git add`, `git commit`, `git rebase`).

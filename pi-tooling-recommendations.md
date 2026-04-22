# Pi Tooling Recommendations

Open tooling gaps still worth implementing. This file no longer lists items that are already done.

---

# Open Recommendations

## 1. Structured Data Query Surface

**Pattern:** Agents keep dropping into inline Python to validate, filter, count, sort, or reshape JSON from tools and CLIs. The problem is not that JSON is too hard to read. The problem is that the agent lacks a first-class way to do structured post-processing.

Typical examples:
- count results from a search response
- extract filenames, ids, or paths from a JSON payload
- filter objects by date, status, source, or tag
- validate that a payload has the fields the next step expects
- project a large object down to the 2 or 3 fields that matter

**Recommended fix:**
- Make tools return structured data natively wherever possible.
- Add a generic structured-data helper such as `data_query` or `json_query` for common operations:
  - field selection
  - filtering
  - counting
  - sorting
  - distinct values
  - shape validation
  - compact summaries
- Prefer tool parameters for common cases over forcing the agent to fetch a large blob and transform it later.

**Why this is broadly useful:**
This applies to search results, GitHub API responses, knowledge-base lookups, test reports, logs, filesystem metadata, package manager output, and any CLI with `--json`.

---

## 2. First-Class List and Filter Commands for File-Backed Stores

**Pattern:** Agents often enumerate directories and then write ad hoc filtering logic over filenames, dates, sources, or projects. That is a missing product surface, not an agent failure.

Typical examples:
- list sessions from the last 7 days
- list artifacts for one project
- list exports created after a given date
- list logs from one source
- list backups matching a tag or prefix

**Recommended fix:**
Add first-class list commands to systems that manage collections of files. Push filtering into the tool or CLI instead of making the agent glob and parse names.

Useful parameters:
- `since`
- `until`
- `source`
- `project`
- `tag`
- `limit`
- `format=json`
- optional field selection

**Why this is broadly useful:**
This pattern shows up in chat stores, logs, exports, artifacts, backups, reports, and build output directories. If the agent repeatedly lists files and filters them itself, the system is missing a query surface.

---

## 3. Canonical Workflow Tasks for Repeated Repo Rituals

**Pattern:** Agents keep rediscovering the same multi-step repo workflows: test, build, install, upgrade, package, release, commit, push. The shell commands differ by repo, but the need is universal.

Typical examples:
- run the right test command before commit
- reinstall a local tool after changing the repo
- upgrade an editable install safely
- build and publish a package
- run a release workflow with the right prechecks

**Recommended fix:**
Expose named workflows from the repo, then give the agent one standard way to discover and run them.

Possible sources:
- `just`
- `make`
- npm scripts
- package scripts in other ecosystems
- a small repo-local workflow manifest

Useful features:
- task name and description
- preconditions
- dry-run support
- side-effect summary
- machine-readable output
- canonical install or release task names

**Why this is broadly useful:**
Every serious repo accumulates a few rituals. Agents should call a stable workflow entry point, not reconstruct the same command chain from scratch every session.

---

## 4. Machine-Readable Output Contracts

**Pattern:** Tools advertise `--json`, but automation still breaks because status chatter, progress output, or nested helper logs leak into stdout.

Typical failure modes:
- progress messages mixed with JSON
- nested helpers printing to stdout during JSON mode
- different success and failure shapes
- undocumented fields appearing or disappearing

**Recommended fix:**
Treat machine-readable mode as a strict contract.

Rules:
- stdout contains only the machine-readable payload in JSON mode
- stderr carries progress, warnings, and human-oriented status messages
- success and failure use stable envelope shapes
- nested helpers inherit the same output contract
- tests assert that stdout stays parseable under all code paths

A simple envelope often helps:
```json
{
  "ok": true,
  "data": {},
  "errors": [],
  "meta": {}
}
```

**Why this is broadly useful:**
Every agent-friendly CLI depends on this. Search tools, deployment tools, package tools, reporting commands, and internal utilities all become more reliable when machine-readable mode is clean and predictable.

---

## 5. Generic Service and Process Status

**Pattern:** Agents keep writing shell snippets to answer simple runtime questions: is it running, what PID owns it, which port is open, is the health endpoint up.

Typical examples:
- check whether a local dev server is running
- verify that a daemon restarted successfully
- find the PID for a background worker
- check whether a port is listening
- confirm that a service is healthy before the next step

**Recommended fix:**
Add a generic `service_status` or `process_status` capability instead of relying on ad hoc shell probes.

Useful fields:
- running or not
- PID
- command line
- port bindings
- uptime
- health check result
- optional recent logs

Useful selectors:
- process name
- command substring
- executable path
- port
- health URL

**Why this is broadly useful:**
This applies to dev servers, daemons, workers, databases, queues, language servers, preview environments, and background jobs. Agents should not have to rebuild process inspection from grep and `ps` every time.

---

## Summary

| Recommendation | Effort | Impact | Why it matters |
|---|---|---|---|
| Structured Data Query Surface | Medium | High | Replaces ad hoc Python for filtering and validation |
| First-Class List and Filter Commands | Low-Medium | High | Removes filename parsing and manual date filtering |
| Canonical Workflow Tasks | Medium | High | Replaces repeated repo-specific shell rituals |
| Machine-Readable Output Contracts | Low-Medium | High | Makes CLI automation trustworthy |
| Generic Service and Process Status | Medium | Medium-High | Replaces repeated liveness and port-check snippets |

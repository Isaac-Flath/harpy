# AgentKB and Pi Tool Boundary Recommendation

AgentKB should own store-aware retrieval. Pi should own thin agent-facing wrappers. Keep the boundary simple. AgentKB answers store questions. Pi makes those answers easy for the model to use.

Current status: the tool work is done in source for `agentkb chats list`, `agentkb chats show`, `agentkb wiki list`, `kb_list`, and `kb_chat_read`. Existing `kb_search` and `kb_read` stay in place. What is still left is operational: update the installed `agentkb` tool, restart Pi so it reloads the extension and prompt changes, and do one end-to-end smoke test. `data_query` is still intentionally deferred.

## `kb_search`

Semantic search across AgentKB content.

**Status**
- Complete

**Done**
- Kept as the relevance tool.
- Left the search boundary unchanged.
- Preserved the split between search, listing, and direct reads.

**Left**
- Nothing for this boundary change.

**Why**
- Search answers "what is relevant?"
- It should stay separate from listing and direct reads.
- The current tool already fits the boundary well.

## `kb_read`

Read a wiki page by path.

**Status**
- Complete

**Done**
- Kept it path-based.
- Left wiki reads separate from chat reads.
- Preserved the existing stable path model for wiki pages.

**Left**
- Nothing for this boundary change.

**Why**
- Wiki pages already have a natural identifier: path.
- This keeps the wiki surface simple for the model.
- Chats need a separate read path because they do not have human-stable paths.

## `agentkb chats list`

List chat sessions from the chats store.

**Status**
- Complete in source

**Done**
- Implemented in AgentKB.
- Supports chat-store filters: `since`, `until`, `source`, `project`, and `limit`.
- Returns machine-readable JSON.
- Reads metadata from readable chat markdown frontmatter.
- Uses the readable chat path as the stable id Pi can pass back later.
- Added CLI test coverage.

**Left**
- Update the installed `agentkb` tool so the command is live outside the repo checkout.
- Smoke-test the live command once installed.

**Why**
- AgentKB owns the chat store and its metadata.
- Pi should not scan directories or infer meaning from filenames.
- Filtering at the source is simpler, faster, and more reliable than post-processing a raw dump.

## `agentkb chats show`

Read one chat session by stable id.

**Status**
- Complete in source

**Done**
- Implemented in AgentKB.
- Accepts an id returned by `agentkb chats list`.
- Returns machine-readable JSON with the session content.
- Resolves ids safely inside the readable chats directory.
- Added CLI test coverage, including path escape rejection.

**Left**
- Update the installed `agentkb` tool so Pi can call the new command outside the repo checkout.
- Smoke-test the live command once installed.

**Why**
- Once Pi lists chats, it needs one reliable way to fetch a selected session.
- AgentKB should own id resolution and storage details.
- This keeps chat access symmetric: list, then read.

## `agentkb wiki list`

List wiki pages with light metadata filters.

**Status**
- Complete in source

**Done**
- Implemented in AgentKB.
- Supports wiki-store filters: `tag`, `since`, `until`, and `limit`.
- Returns machine-readable JSON.
- Uses wiki-relative paths as stable references.
- Added CLI test coverage.

**Left**
- Update the installed `agentkb` tool so the command is live outside the repo checkout.
- Smoke-test the live command once installed.

**Why**
- Search and listing solve different problems.
- Search finds relevant pages. Listing supports browsing, recency views, and tag views.
- AgentKB already owns the wiki structure, so it should expose the list surface too.

## `kb_list`

Unified listing tool for Pi.

**Status**
- Complete in source

**Done**
- Implemented in Pi.
- Wraps `agentkb chats list` and `agentkb wiki list`.
- Keeps one small interface for the model.
- Stays thin. No extra query language. No duplicated store logic.
- Added prompt guidance so the model uses it for browsing instead of relevance search.

**Left**
- Restart Pi so it reloads the extension and prompt changes.
- Run one end-to-end smoke test against the installed `agentkb` tool.

**Why**
- The model needs one simple tool, not CLI-specific commands.
- Pi is the right place to shape agent ergonomics.
- AgentKB should stay focused on store-aware retrieval.

## `kb_chat_read`

Read a chat session from Pi.

**Status**
- Complete in source

**Done**
- Implemented in Pi.
- Wraps `agentkb chats show`.
- Accepts ids returned by `kb_list`.
- Keeps the surface chat-specific instead of introducing a vague generic getter.
- Added prompt guidance so the model uses it after `kb_list`.

**Left**
- Restart Pi so it reloads the extension and prompt changes.
- Run one end-to-end smoke test against the installed `agentkb` tool.

**Why**
- The model works better with clear nouns and verbs.
- `kb_chat_read` says exactly what it does.
- A store-specific tool is easier to prompt and harder to misuse than a generic `kb_get`.

## `data_query`

Generic post-processing over JSON.

**Status**
- Not started by design

**Done**
- Kept it out of AgentKB.
- Left the system focused on store-aware list and read commands first.

**Left**
- Nothing unless real usage shows a cross-tool query utility is still needed.
- If it becomes necessary, build it in Pi, not AgentKB.

**Why**
- `data_query` is not AgentKB-specific. It is generic agent plumbing.
- AgentKB should expose clean store commands, not become a general JSON manipulation layer.
- Good list and read commands remove most of the pressure to build this at all.

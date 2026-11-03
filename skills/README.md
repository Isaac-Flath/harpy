# Content skills

Two task-specific skills, plus a short system append in `../APPEND_SYSTEM.md`:

| Skill | Purpose |
|---|---|
| `content-publishing` | Ordinal social publishing, approved public image uploads, Luma webinars and Riverside audience links |
| `content-style` | Real-photo/source-evidence visuals and the current thumbnail treatment |

`setup.sh` links Pi's global `APPEND_SYSTEM.md` when that location is free and
enables this skills directory. Skills are advertised automatically and their full
instructions load when relevant; the system append need not mention them.
Existing user files are preserved. Restart Pi or `/reload` after changes.
A trusted project's `.pi/APPEND_SYSTEM.md` takes precedence over the global append.

Commands using `scripts/` resolve relative to the skill directory. Ordinal's API
fallback requires `ORDINAL_API_KEY` in the environment or `~/.secrets`, Python,
and `curl` for uploads. Its YouTube thumbnail helper needs separate authorized
Google OAuth and the `uv --with` dependencies documented in the helper. These
are uploaded-video checks, not YouTube Live setup. No live API actions are run
merely by installing these skills.

Dedicated transcription/screenshots, Camtasia, YouTube Live, TypeSafe, critique,
and episode-brief skills are intentionally removed. No Figma/brand skill,
Raw2Draft-managed wrappers, or Codex built-ins are included. Use available tools
and current documentation as needed rather than retaining obsolete workflows.

## Provenance and scope

Consolidated from `~/git/agentkb-content/skills/.agents/skills/`, duplicate skills
in `~/git/agentkb-skills/.agents/skills/`, the website's `.agents/skills/`, and
personal Codex skill copies. Only the retained workflows and necessary helpers
remain. Project-specific commands, instructions, and assets stay in their project.

Source repositories and Codex's global skills/symlinks are unchanged. This is the
Harpy maintenance copy; old consumers have not been migrated. No credentials,
media, caches, or generated outputs are bundled. Private/third bucket names and
purposes still need confirmation before adding them to the system append.

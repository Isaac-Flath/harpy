#!/usr/bin/env bash
#
# Install harpy: dependencies, extensions, and prompts.
# Run after cloning or when configs change.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="$HOME/.pi/agent"

# Install dependencies
cd "$REPO_DIR"
npm install
echo "installed: npm dependencies"

mkdir -p "$PI_DIR"

# Symlink APPEND_SYSTEM.md
ln -sfn "$REPO_DIR/prompts/APPEND_SYSTEM.md" "$PI_DIR/APPEND_SYSTEM.md"
echo "linked: APPEND_SYSTEM.md"

# Update settings.json: extensions and skills paths.
# Skills: Pi only scans ~/.pi/agent/skills and .pi/skills by default, so we
# point the settings "skills" array at ~/.agents/skills — the global discovery
# directory that `agentkb skills link` maintains. agentkb owns the skill links;
# Pi just reads the directory.
SETTINGS="$PI_DIR/settings.json"
if [ -f "$SETTINGS" ]; then
  # Use node to merge paths into existing settings
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
    const extPath = '$REPO_DIR/extensions';
    const skillsPath = '$HOME/.agents/skills';
    if (!s.extensions) s.extensions = [];
    if (!s.extensions.includes(extPath)) s.extensions.push(extPath);
    if (Array.isArray(s.themes)) {
      s.themes = s.themes.filter((p) => p !== '$REPO_DIR/themes');
      if (s.themes.length === 0) delete s.themes;
    }
    if (s.theme === 'ghostie') delete s.theme;
    if (!s.skills) s.skills = [];
    if (!s.skills.includes(skillsPath)) s.skills.push(skillsPath);
    fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
  "
else
  cat > "$SETTINGS" <<SETTINGS
{
  "extensions": ["$REPO_DIR/extensions"],
  "skills": ["$HOME/.agents/skills"]
}
SETTINGS
fi
echo "updated: settings.json"

if [ ! -d "$HOME/.agents/skills" ]; then
  echo "note: ~/.agents/skills not found — run 'agentkb skills link' to populate it"
fi

# Remove dead skill symlinks left behind by older harpy setups
# (they pointed at ~/.agentkb/skills/.claude/skills, which no longer exists).
if [ -d "$PI_DIR/skills" ]; then
  find "$PI_DIR/skills" -maxdepth 1 -type l ! -exec test -e {} \; -delete
fi

echo "done. restart pi to pick up changes."

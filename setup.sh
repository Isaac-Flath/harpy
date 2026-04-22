#!/usr/bin/env bash
#
# Install harpy: dependencies, extensions, themes, and prompts.
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

# Update settings.json: extensions and themes paths
SETTINGS="$PI_DIR/settings.json"
if [ -f "$SETTINGS" ]; then
  # Use node to merge paths into existing settings
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
    const extPath = '$REPO_DIR/extensions';
    const themePath = '$REPO_DIR/themes';
    if (!s.extensions) s.extensions = [];
    if (!s.extensions.includes(extPath)) s.extensions.push(extPath);
    if (!s.themes) s.themes = [];
    if (!s.themes.includes(themePath)) s.themes.push(themePath);
    fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
  "
else
  cat > "$SETTINGS" <<SETTINGS
{
  "extensions": ["$REPO_DIR/extensions"],
  "themes": ["$REPO_DIR/themes"]
}
SETTINGS
fi
echo "updated: settings.json"

# Symlink agentkb skills into Pi's skill discovery path
SKILLS_SRC="$HOME/.agentkb/skills/.claude/skills"
SKILLS_DST="$PI_DIR/skills"
if [ -d "$SKILLS_SRC" ]; then
  mkdir -p "$SKILLS_DST"
  for skill in "$SKILLS_SRC"/*/; do
    name="$(basename "$skill")"
    ln -sfn "$skill" "$SKILLS_DST/$name"
  done
  echo "linked: agentkb skills"
else
  echo "skipped: agentkb skills (not found at $SKILLS_SRC)"
fi

echo "done. restart pi to pick up changes."

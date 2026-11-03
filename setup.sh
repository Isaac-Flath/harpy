#!/usr/bin/env bash
#
# Install harpy: dependencies, extensions, skills, system append, and MCP servers.
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

# Migrate only instruction symlinks owned by this checkout.
if [ -L "$PI_DIR/AGENTS.md" ] && \
   [ "$(readlink "$PI_DIR/AGENTS.md")" = "$REPO_DIR/context/AGENTS.md" ]; then
  rm "$PI_DIR/AGENTS.md"
fi
if [ -L "$PI_DIR/APPEND_SYSTEM.md" ] && \
   [ "$(readlink "$PI_DIR/APPEND_SYSTEM.md")" = "$REPO_DIR/prompts/APPEND_SYSTEM.md" ]; then
  rm "$PI_DIR/APPEND_SYSTEM.md"
fi

# Append personal facts without replacing Pi's default prompt or user files.
APPEND_TARGET="$PI_DIR/APPEND_SYSTEM.md"
APPEND_SOURCE="$REPO_DIR/APPEND_SYSTEM.md"
if [ -L "$APPEND_TARGET" ] && [ "$(readlink "$APPEND_TARGET")" = "$APPEND_SOURCE" ]; then
  echo "system append: already linked"
elif [ ! -e "$APPEND_TARGET" ] && [ ! -L "$APPEND_TARGET" ]; then
  ln -s "$APPEND_SOURCE" "$APPEND_TARGET"
  echo "system append: linked"
else
  echo "system append: existing $APPEND_TARGET left unchanged; merge $APPEND_SOURCE manually"
fi

# Update settings.json: extensions and skills paths.
# Load this checkout's skills alongside its extensions.
SETTINGS="$PI_DIR/settings.json"
if [ -f "$SETTINGS" ]; then
  # Use node to merge paths into existing settings
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
    const extPath = '$REPO_DIR/extensions';
    const skillsPath = '$REPO_DIR/skills';
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
  "skills": ["$REPO_DIR/skills"]
}
SETTINGS
fi
echo "updated: settings.json"

# Add MCP defaults without overwriting existing servers or local OAuth settings.
node --input-type=module - "$REPO_DIR/mcp.json" "$PI_DIR/mcp.json" <<'NODE'
import fs from 'node:fs';
const [source, target] = process.argv.slice(2);
const defaults = JSON.parse(fs.readFileSync(source, 'utf8'));
const config = fs.existsSync(target)
  ? JSON.parse(fs.readFileSync(target, 'utf8'))
  : {};
if (config.mcpServers == null) config.mcpServers = {};
if (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
  throw new Error(`Invalid mcpServers in ${target}; left unchanged`);
}
for (const [name, server] of Object.entries(defaults.mcpServers)) {
  if (Object.hasOwn(config.mcpServers, name)) {
    console.log(`MCP: existing ${name} left unchanged`);
  } else {
    config.mcpServers[name] = server;
    console.log(`MCP: added ${name}`);
  }
}
fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
NODE

# Remove dead skill symlinks left behind by older harpy setups.
if [ -d "$PI_DIR/skills" ]; then
  find "$PI_DIR/skills" -maxdepth 1 -type l ! -exec test -e {} \; -delete
fi

echo "done. restart pi or /reload to pick up changes."
echo "first-time MCP sign-in: pi mcp login ordinal && pi mcp login figma"
echo "check connections: pi mcp list"

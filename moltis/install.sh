#!/bin/sh
# install.sh — build + validate the Fortress Moltis config (no gateway launch).
# Regenerates [agents.presets.*] from backend/src/settlement.js, installs the
# config where Moltis expects it, and validates with `moltis config check` +
# `moltis doctor`.
#
# LOCAL LLAMA ONLY: the opencode Zen bridge (proxy-zen.js / big-pickle) and
# OpenRouter tiers are retired — this script now KILLS any stray proxy-zen.js
# instead of starting it. No cloud keys are injected anywhere.
set -eu
cd "$(dirname "$0")/.."          # repo root
ROOT="$(pwd)"

echo "==> building config from settlement roster (single source of truth)"
node "$ROOT/moltis/scripts/build-config.js"

mkdir -p "$HOME/.config/moltis" "$HOME/.moltis" "$HOME/.moltis/hooks" "$HOME/.moltis/skills"
chmod 700 "$HOME/.moltis"
cp "$ROOT/moltis/build/moltis.toml" "$HOME/.config/moltis/moltis.toml"
chmod 600 "$HOME/.config/moltis/moltis.toml"
echo "==> installed $HOME/.config/moltis/moltis.toml (0600, data dir 0700)"

echo "==> retiring Fortress Zen bridge (big-pickle is OUT — local llama only)"
pkill -f 'proxy-zen\.js' 2>/dev/null && echo "    stopped a running proxy-zen.js" || echo "    no proxy-zen.js running"

echo "==> installing fortress bridge doctrine + gateway hook (home-dir pattern)"
mkdir -p "$HOME/.moltis/hooks/fortress-gateway-start" "$HOME/.moltis/skills/fortress-bridge"
cp "$ROOT/moltis/hooks/fortress-gateway-start/HOOK.md" "$ROOT/moltis/hooks/fortress-gateway-start/handler.sh" "$HOME/.moltis/hooks/fortress-gateway-start/"
chmod +x "$HOME/.moltis/hooks/fortress-gateway-start/handler.sh"
cp "$ROOT/moltis/skills/fortress-bridge/SKILL.md" "$HOME/.moltis/skills/fortress-bridge/"
echo "==> installing jarv-brain (MoltenJarv lineage: soul + coding discipline + anatomy)"
mkdir -p "$HOME/.moltis/skills/jarv-brain"
cp "$ROOT/moltis/skills/jarv-brain/SKILL.md" "$ROOT/moltis/skills/jarv-brain/SOUL.md" \
   "$ROOT/moltis/skills/jarv-brain/CODE_PLAYBOOK.md" "$ROOT/moltis/skills/jarv-brain/ANATOMY.md" \
   "$HOME/.moltis/skills/jarv-brain/"
echo "==> installed hook + skills (restart moltis gateway to pick them up)"

# Tool protocol (data-dir + main agent workspace): keeps small local models
# from treating exec/tool output as "user-provided" content.
cp "$ROOT/moltis/tools/TOOLS.md" "$HOME/.moltis/TOOLS.md"
cp "$ROOT/moltis/tools/TOOLS.md" "$HOME/.moltis/agents/main/TOOLS.md"
echo "==> installed tool protocol (TOOLS.md)"

if command -v moltris >/dev/null 2>&1; then BIN=moltis; elif command -v moltis >/dev/null 2>&1; then BIN=moltis; else
  echo "    moltis CLI not found on PATH — skip validation (expect at /Users/tfe/.local/bin)"
  exit 0
fi
echo "==> validating with $BIN"
"$BIN" config check || { echo "  config check failed — see above"; exit 1; }
"$BIN" doctor || { echo "  doctor reported issues — see above (non-gateway)"; exit 1; }
echo "==> done. Config validated. Start the stack with moltris/scripts/start.sh."
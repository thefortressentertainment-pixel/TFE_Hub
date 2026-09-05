#!/bin/sh
# install.sh — build + validate the Fortress Moltis config (no gateway launch),
# then (re)start the Fortress Zen bridge so big-pickle works via the opencode
# account session. Regenerates [agents.presets.*] from backend/src/settlement.js, installs the
# config where Moltis expects it, and validates with `moltis config check`.
set -eu
cd "$(dirname "$0")/.."          # repo root
ROOT="$(pwd)"

echo "==> building config from settlement roster (single source of truth)"
node "$ROOT/moltis/scripts/build-config.js"

echo "==> resolving OpenRouter key for provider wiring"
OPENROUTER_API_KEY=""
if [ -f "$ROOT/backend/.env" ]; then
  OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY=' "$ROOT/backend/.env" | head -1 | cut -d= -f2- | tr -d '"')"
  [ -n "$OPENROUTER_API_KEY" ] && echo "    openrouter key: present" || echo "    openrouter key: NOT set (openrouter provider will be offline)"
else
  echo "    backend/.env not found; key resolution skipped"
fi

echo "==> injecting OpenCode Zen key (big-pickle) into Moltis key store"
ZEN_KEY="$(grep -E '^OPENCODE_API_KEY=' "$ROOT/backend/.env" | head -1 | cut -d= -f2- | tr -d '"')"
KEYS="$HOME/.config/moltis/provider_keys.json"
if [ -n "$ZEN_KEY" ]; then
  ZEN_KEY="$ZEN_KEY" node -e '
    const fs = require("fs");
    const path = process.env.HOME + "/.config/moltis/provider_keys.json";
    let store = {};
    try { store = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) {}
    delete store.opencode;
    store.openai = Object.assign({}, store.openai, {
      apiKey: process.env.ZEN_KEY,
      models: ["big-pickle", "nemotron-3-ultra-free", "mimo-v2.5-free"],
    });
    fs.writeFileSync(path, JSON.stringify(store, null, 2));
    console.error("    openai slot <- Zen (big-pickle) key; existing providers preserved");
  '
  chmod 600 "$KEYS"
else
  echo "    OPENCODE_API_KEY missing — openai slot (Zen) will be offline"
fi

mkdir -p "$HOME/.config/moltis" "$HOME/.moltis" "$HOME/.moltis/hooks" "$HOME/.moltis/skills"
chmod 700 "$HOME/.moltis"
cp "$ROOT/moltis/build/moltis.toml" "$HOME/.config/moltis/moltis.toml"
NEXT_KEY="${OPENROUTER_API_KEY:-}" ZEN_KEY="$ZEN_KEY" OPENROUTER_KEY="$OPENROUTER_API_KEY" node -e '
  const fs = require("fs");
  const p = process.env.HOME + "/.config/moltis/moltis.toml";
  let s = fs.readFileSync(p, "utf8");
  const zen = /^[\x20-\x7E]+$/.test(process.env.ZEN_KEY) ? process.env.ZEN_KEY : "";
  const or = /^[\x20-\x7E]+$/.test(process.env.OPENROUTER_KEY) ? process.env.OPENROUTER_KEY : "";
  s = s.replace(`OPENCODE_API_KEY = "__SET_BY_INSTALL__"`, `OPENCODE_API_KEY = "${zen}"`);
  s = s.replace(`OPENROUTER_API_KEY = "__SET_BY_INSTALL__"`, `OPENROUTER_API_KEY = "${or}"`);
  fs.writeFileSync(p, s);
'
chmod 600 "$HOME/.config/moltis/moltis.toml"
echo "==> installed $HOME/.config/moltis/moltis.toml (0600, data dir 0700)"

echo "==> (re)starting Fortress Zen bridge (OpenAI /v1 -> opencode session)"
pkill -f 'proxy-zen\.js' 2>/dev/null || true
(cd "$ROOT/moltis" && nohup node proxy-zen.js > /tmp/fortress-zen-bridge.log 2>&1 &)
sleep 1
if curl -s --max-time 3 http://127.0.0.1:63851/v1/models >/dev/null 2>&1; then
  echo "    bridge up on 127.0.0.1:63851 (big-pickle via the opencode account session)"
else
  echo "    WARN: bridge not responding — openai slot will be offline (see /tmp/fortress-zen-bridge.log)"
fi

echo "==> installing fortress bridge doctrine + gateway hook (home-dir pattern)"
mkdir -p "$HOME/.moltis/hooks/fortress-gateway-start" "$HOME/.moltis/skills/fortress-bridge"
cp "$ROOT/moltis/hooks/fortress-gateway-start/HOOK.md" "$ROOT/moltis/hooks/fortress-gateway-start/handler.sh" "$HOME/.moltis/hooks/fortress-gateway-start/"
chmod +x "$HOME/.moltis/hooks/fortress-gateway-start/handler.sh"
cp "$ROOT/moltis/skills/fortress-bridge/SKILL.md" "$HOME/.moltis/skills/fortress-bridge/"
echo "==> installed hook + SKILL.md (restart moltis gateway to pick both up)"

if command -v moltris >/dev/null 2>&1; then BIN=moltis; elif command -v moltis >/dev/null 2>&1; then BIN=moltis; else
  echo "    moltis CLI not found on PATH — skip validation (expect at /Users/tfe/.local/bin)"
  exit 0
fi
echo "==> validating with $BIN"
"$BIN" config check || { echo "  config check failed — see above"; exit 1; }
"$BIN" doctor || { echo "  doctor reported issues — see above (non-gateway)"; exit 1; }
echo "==> done. Config validated. Launch the gateway manually when you're ready (moltis gateway)."
#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# fortress-hub/moltis/scripts/start.sh
# Single-script startup for the Fortress Moltis stack on this Mac.
#
# Configures (idempotently) and starts:
#   1. apple-container brew service  → sandbox backend
#   2. Moltis gateway                → plain HTTP/ws on 127.0.0.1:63849
#   3. "fort" node (launchd)         → registers this machine so the exec
#                                      tool has a host to route to
#
# Usage:  sh moltris/scripts/start.sh
# Alias:  alias mg='sh ~/fortress-hub/moltis/scripts/start.sh'
#
# OPTIONAL — Fortress hub control plane (settlement ROI + bridge talk/dispatch
# on http://127.0.0.1:4002). Not started here to keep the stack lean; start it
# when you want the team trackable: cd ~/fortress-hub/backend && npm start
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

UID_GUI="gui/$(id -u)"
HEALTH_URL="http://127.0.0.1:63849/health"
GATEWAY_URL="ws://localhost:63849/ws/chat"
PLIST="$HOME/Library/LaunchAgents/org.moltis.node.plist"
GATEWAY_LOG="/tmp/moltis-gateway.log"
NODE_LOG="$HOME/.moltis/node.log"
NODE_ID="b66e92ce-54f6-4eb5-955b-d0b76b18f963"
MOLTIS_BIN="${MOLTIS_BIN:-"$(command -v moltis || true)"}"
[ -n "$MOLTIS_BIN" ] || MOLTIS_BIN="$HOME/.local/bin/moltis"

echo "→ Fortress Moltis stack start"

# ── 1. apple-container sandbox backend ──────────────────────────────────────
# The runtime (container-apiserver + vmnet/machine plugins) is the real signal;
# `brew services list` can lag behind it, so check the process, not the flag.
if pgrep -f 'container-apiserver' >/dev/null 2>&1; then
  echo "  container: runtime active (apple-container sandbox available)"
elif brew services list 2>/dev/null | awk 'NR>1 {print $1}' | grep -q '^container$'; then
  echo "  container: starting…"
  brew services start container >/dev/null 2>&1 \
    || echo "  ⚠  brew service flag failed; runtime may still be usable (exec runs on host regardless)"
else
  echo "  container: brew service not installed — sandbox unavailable (exec still runs on host)"
fi

# ── 2. Moltis gateway (no-TLS: the node client ships without TLS support) ───
# Managed by launchd (org.moltis.gateway) so it survives shell teardown and
# auto-restarts after crashes. Falls back to a detached nohup process if the
# agent can't be loaded.
GATEWAY_PLIST="$HOME/Library/LaunchAgents/org.moltis.gateway.plist"
cat > "$GATEWAY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.moltis.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${MOLTIS_BIN}</string>
    <string>gateway</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>MOLTIS_NO_TLS</key><string>true</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${GATEWAY_LOG}</string>
  <key>StandardErrorPath</key><string>${GATEWAY_LOG}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
chmod 644 "$GATEWAY_PLIST"

if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
  echo "  moltis gateway: already running (http://127.0.0.1:63849)"
elif launchctl print "$UID_GUI/org.moltis.gateway" >/dev/null 2>&1; then
  echo "  moltis gateway: starting (launchd)…"
  launchctl kickstart -k "$UID_GUI/org.moltis.gateway" >/dev/null 2>&1 \
    || { launchctl bootout "$UID_GUI/org.moltis.gateway" 2>/dev/null || true; \
         launchctl bootstrap "$UID_GUI" "$GATEWAY_PLIST" 2>/dev/null \
           || launchctl load -w "$GATEWAY_PLIST"; }
else
  echo "  moltis gateway: starting (launchd)…"
  launchctl bootstrap "$UID_GUI" "$GATEWAY_PLIST" 2>/dev/null \
    || launchctl load -w "$GATEWAY_PLIST"
fi
ok=0
for _ in $(seq 1 30); do
  sleep 1
  curl -sf "$HEALTH_URL" >/dev/null 2>&1 && { ok=1; break; }
done
if [ "$ok" != 1 ]; then
  echo "  moltis gateway: launchd path failed — detaching nohup fallback…"
  MOLTIS_NO_TLS=true setsid "$MOLTIS_BIN" gateway >> "$GATEWAY_LOG" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  for _ in $(seq 1 30); do
    sleep 1
    curl -sf "$HEALTH_URL" >/dev/null 2>&1 && { ok=1; break; }
  done
  [ "$ok" = 1 ] || { echo "  ✗ gateway failed to start; see $GATEWAY_LOG"; exit 1; }
fi
echo "  moltis gateway: up"

# ── 3. fort node (launchd) ──────────────────────────────────────────────────
# NOTE: stock `moltis node add` writes a broken plist (`node run` — the
# subcommand doesn't exist in 0.10.18). We author a fixed plist here instead.
mkdir -p "$HOME/.moltis"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>org.moltis.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>${MOLTIS_BIN}</string>
    <string>node</string>
    <string>add</string>
    <string>--foreground</string>
    <string>--host</string>
    <string>${GATEWAY_URL}</string>
    <string>--token</string>
    <string>fort-local-token</string>
    <string>--timeout</string>
    <string>300</string>
    <string>--node-id</string>
    <string>${NODE_ID}</string>
    <string>--name</string>
    <string>fort</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${NODE_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${NODE_LOG}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
chmod 644 "$PLIST"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M)"
if launchctl print "$UID_GUI/org.moltis.node" >/dev/null 2>&1; then
  if pgrep -f 'moltis node add' >/dev/null 2>&1; then
    echo "  fort node: launchd service running"
  else
    echo "  fort node: relaunching dead service…"
    launchctl kickstart -k "$UID_GUI/org.moltis.node" >/dev/null 2>&1 \
      || { launchctl bootout "$UID_GUI/org.moltis.node" 2>/dev/null || true; \
           launchctl load -w "$PLIST"; }
  fi
else
  echo "  fort node: booting launchd service…"
  launchctl bootstrap "$UID_GUI" "$PLIST" 2>/dev/null \
    || launchctl load -w "$PLIST"
fi

for _ in $(seq 1 25); do
  latest="$(grep 'node registered' "$NODE_LOG" 2>/dev/null | tail -1 | sed -E $'s/\x1b\[[0-9;]*m//g' | tr -d '\r' || true)"
  case "$latest" in "$STARTED_AT"*) break;; esac
  sleep 1
done
latest="$(grep 'node registered' "$NODE_LOG" 2>/dev/null | tail -1 | sed -E $'s/\x1b\[[0-9;]*m//g' | tr -d '\r' || true)"
if case "$latest" in "$STARTED_AT"*) true;; *) false;; esac; then
  echo "  fort node: registered"
else
  echo "  ⚠  fort node: not registered yet; see $NODE_LOG" >&2
fi

echo
echo "✓ Stack ready → http://localhost:63849"
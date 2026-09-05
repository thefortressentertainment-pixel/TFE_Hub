#!/bin/sh
# Hook GatewayStart: best-effort ping of the hub Settlement. Never fatal.
LOG=/tmp/fortress-moltis-hook.log
{
  echo "=== GatewayStart $(date +%FT%T) ==="
  python3 /Users/tfe/fortress-hub/moltis/comm/fortress-bridge.py health
  python3 /Users/tfe/fortress-hub/moltis/comm/fortress-bridge.py roi
} >> "$LOG" 2>&1
exit 0
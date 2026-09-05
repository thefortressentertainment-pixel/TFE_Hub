#!/bin/sh
# tier_bridge.sh <tier> <command> <message...>  — route a message to a tier's
# canonical agent via the fortress bridge (tier -> agent mapping preserved from
# the original comm/tier_bridge.sh).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$ROOT/comm/fortress-bridge.py"
tier="${1:-}"; cmd="${2:-}"; shift 2 || true
case "$tier" in
  leadership) agent=core ;;
  operations) agent=ops ;;
  specialist) agent=curie ;;
  support)    agent=eyebot ;;
  grunt)      agent=mole-ratt ;;
  heavy)      agent=gutsy ;;
  *) echo "usage: tier_bridge.sh <leadership|operations|specialist|support|grunt|heavy> <talk|dispatch> <text>" >&2; exit 2 ;;
esac
exec python3 "$BRIDGE" "$cmd" "$agent" "$@"
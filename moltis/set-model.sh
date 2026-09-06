#!/bin/sh
# set-model.sh — switch Moltis agent models between the local quantized models
# installed on this Mac (M1, Ollama). Rebuilds the config from the settlement
# roster and installs it where Moltis expects it, then validates.
#
# Usage:
#   moltis/set-model.sh list                          show local models + current assignments
#   moltis/set-model.sh default <model>               set EVERY tier to <model>
#   moltis/set-model.sh split <reasoning> <hands>     reasoning tiers (leadership/ops/specialist)
#                                                     to <reasoning>; hands tiers (support/grunt/heavy)
#                                                     to <hands>
#
# Examples:
#   moltis/set-model.sh default qwen2.5:1.5b                  # everything on the 1.5b
#   moltis/set-model.sh split qwen3:1.7b qwen2.5-coder:0.5b   # think big, act fast
#   moltis/set-model.sh split llama3.2:3b-instruct-q8_0 qwen2.5:0.5b
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="$ROOT/moltis/scripts/build-config.js"
BIN="${MOLTIS_BIN:-/Users/tfe/.local/bin/moltis}"
INSTALLED="$HOME/.config/moltis/moltis.toml"

# Curated local chat models of this Mac (checked against `ollama list` at use-time).
# 8GB M1 sizing: Q4 3B primary; Q8 3B only when heavy apps are closed.
CHAT_MODELS="llama3.2:3b-q4-8k llama3.2:3b-instruct-q8_0 llama3.2:latest llama3.2:1b llama3.2:1b-q4_k_m llama3.2:1b-q4-8k qwen3:4b-thinking-2507-q8_0"

# Current tier->model map as defined in build-config.js (canonical).
current_map() {
  grep -nE '^  (leadership|operations|specialist|support|grunt|heavy):' "$GEN"
}

die() { echo "error: $*" >&2; exit 1; }

fail_if_not_installed() {
  case " $CHAT_MODELS " in
    *" $1 "*) : ;;
    *) die "'$1' is not a curated local model. Installed options: $CHAT_MODELS" ;;
  esac
  if command -v ollama >/dev/null 2>&1; then
    if ! ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$1"; then
      die "'$1' is not installed in Ollama — run: ollama pull $1"
    fi
  fi
}

cmd_list() {
  echo "== Local quantized chat models (ollama) =="
  ollama list 2>/dev/null | awk 'NR>1{print "  " $1"\t"$2}' | grep -E "$(echo "$CHAT_MODELS" | tr ' ' '|')" || echo "  (none of the curated chat models installed!)"
  echo
  echo "== Current tier assignments (build-config.js) =="
  current_map || echo "  (no tier model map found)"
  echo
  echo "Installed config: $INSTALLED"
  echo "Web chat: open https://127.0.0.1:63849 and use the Model Dropdown per session."
}

# $1=reasoning model id  $2=hands model id
rewrite_map() {
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const r = process.argv[2], h = process.argv[3];
    let s = fs.readFileSync(f, "utf8");
    const re = /const TIER_MODEL = \{[^}]*\};/s;
    if (!re.test(s)) { console.error("TIER_MODEL map not found in " + f); process.exit(1); }
    const map = [
      "  leadership: \"" + r + "\",",
      "  operations: \"" + r + "\",",
      "  specialist: \"" + r + "\",",
      "  support: \"" + h + "\",",
      "  grunt: \"" + h + "\",",
      "  heavy: \"" + h + "\",",
    ].join("\n");
    s = s.replace(re, "const TIER_MODEL = {\n" + map + "\n};");
    fs.writeFileSync(f, s);
    console.log("patched " + f);
  ' "$GEN" "ollama/$1" "ollama/$2"
}

cmd_default() {
  fail_if_not_installed "$1"
  echo "Setting EVERY tier to ollama/$1 ..."
  rewrite_map "$1" "$1"
  build_and_install
}

cmd_split() {
  fail_if_not_installed "$1"
  fail_if_not_installed "$2"
  echo "Reasoning tiers  -> ollama/$1"
  echo "Hands tiers      -> ollama/$2"
  rewrite_map "$1" "$2"
  build_and_install
}

build_and_install() {
  echo "== rebuilding config from settlement roster =="
  (cd "$ROOT" && node "$GEN") || die "build-config.js failed"
  echo "== installing + validating =="
  (cd "$ROOT" && sh "$ROOT/moltis/install.sh") || die "install.sh failed (see above)"
  if [ -x "$BIN" ]; then
    "$BIN" config check >/dev/null 2>&1 || die "moltis config check failed after install"
    echo "== "
  fi
  echo "== done =="
  current_map
  echo "Restart the gateway to apply:  moltis gateway"
}

case "${1:-}" in
  list)   cmd_list ;;
  default) [ "$#" -eq 2 ] || die "usage: set-model.sh default <model>"
           cmd_default "$2" ;;
  split)  [ "$#" -eq 3 ] || die "usage: set-model.sh split <reasoning-model> <hands-model>"
           cmd_split "$2" "$3" ;;
  *) cat >&2 <<'EOF'
usage: moltis/set-model.sh <command>

  list                show local quantized models + current tier assignments
  default <model>     set every agent tier to <model>
  split <r> <h>       reasoning tiers -> <r>, hands tiers -> <h>
EOF
     exit 1 ;;
esac
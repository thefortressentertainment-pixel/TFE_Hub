#!/usr/bin/env bash
# Build JARV.app — the one desktop icon that opens the encrypted JARV IDE.
#
#   jarv/launcher/build-app.sh               → ~/Desktop/JARV.app
#   jarv/launcher/build-app.sh --dest DIR    → DIR/JARV.app
#   jarv/launcher/build-app.sh --wordmark    → use the JARV-wordmark icon
#   jarv/launcher/build-app.sh --icons       → redraw the .icns first
#   jarv/launcher/build-app.sh --keep-old    → don't retire the old launchers
#
# Building also RETIRES the previous desktop launchers (the old JARV.app and any
# loose "JARV Vibe.command") into ~/.jarv/desktop-retired/, so exactly one JARV
# icon is left on the Desktop. Nothing is deleted — move them back to undo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"    # <repo>/jarv/launcher
REPO="$(cd "$HERE/../.." && pwd)"                       # <repo>
ASSETS="$HERE/assets"
DESKTOP="$HOME/Desktop"
DEST="$DESKTOP"
ICON="JARV"
REGEN=0
RETIRE=1

usage() { sed -n '4,8p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dest)   DEST="${2:?--dest needs a directory}"; shift 2 ;;
    --wordmark) ICON="JARV-wordmark"; shift ;;
    --icons)  REGEN=1; shift ;;
    --keep-old) RETIRE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -f "$REPO/jarv/vault.py" ] || { echo "!! not the fortress-hub checkout: $REPO" >&2; exit 1; }
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "!! no python3 on PATH" >&2; exit 1; }

# ── the icon ────────────────────────────────────────────────────────────────
ICNS="$ASSETS/$ICON.icns"
if [ "$REGEN" = 1 ] || [ ! -f "$ICNS" ]; then
  echo "==> drawing the icon ($ICON)"
  if [ "$ICON" = "JARV-wordmark" ]; then
    "$PY" "$HERE/make-icon.py" --out "$ASSETS" --wordmark
  else
    "$PY" "$HERE/make-icon.py" --out "$ASSETS"
  fi
fi
[ -f "$ICNS" ] || { echo "!! missing $ICNS — run: $PY $HERE/make-icon.py --both" >&2; exit 1; }

# ── stage the bundle away from the Desktop, so a failure never leaves half an
#    app sitting where the icon used to be ───────────────────────────────────
APP_NAME="JARV.app"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/jarv-app.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/$APP_NAME"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> writing $APP_NAME"
cp "$HERE/jarv-launcher" "$APP/Contents/MacOS/jarv"
chmod 755 "$APP/Contents/MacOS/jarv"
cp "$ICNS" "$APP/Contents/Resources/JARV.icns"
printf '%s\n' "$REPO" > "$APP/Contents/Resources/repo-path"
printf '%s\n' "$PY"   > "$APP/Contents/Resources/python-path"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>JARV</string>
  <key>CFBundleDisplayName</key><string>JARV</string>
  <key>CFBundleIdentifier</key><string>hub.fortress.jarv</string>
  <key>CFBundleExecutable</key><string>jarv</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>JARV</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# ── retire the old desktop launchers ────────────────────────────────────────
RETIRED="$HOME/.jarv/desktop-retired"
retire() {
  local src="$1" name tgt="$RETIRED/$(basename "$1")"
  [ "$src" = "$DEST/$APP_NAME" ] && return 0    # the slot the new app takes
  [ -e "$src" ] || return 0
  if [ -e "$tgt" ]; then tgt="$tgt.$(date +%Y%m%d-%H%M%S)"; fi
  mkdir -p "$RETIRED"
  mv "$src" "$tgt"
  echo "    retired  $(basename "$src")  →  $tgt"
}

if [ "$RETIRE" = 1 ]; then
  echo "==> retiring the old desktop launchers"
  retire "$DESKTOP/$APP_NAME"
  retire "$DESKTOP/JARV Vibe.command"
  retire "$DESKTOP/JARV Vibe.app"
fi

# ── install ─────────────────────────────────────────────────────────────────
echo "==> installing $DEST/$APP_NAME"
mkdir -p "$DEST"
rm -rf "$DEST/$APP_NAME"
cp -R "$APP" "$DEST/$APP_NAME"

# Ad-hoc signature so Gatekeeper and the icon cache treat the bundle as whole.
if codesign --force --deep --sign - "$DEST/$APP_NAME" >/dev/null 2>&1; then
  echo "    ad-hoc signed"
else
  echo "    (ad-hoc signing skipped — the icon still works)"
fi
touch "$DEST/$APP_NAME"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREG" ]; then "$LSREG" -f "$DEST/$APP_NAME" >/dev/null 2>&1 || true; fi

echo
echo "==> done"
echo "    icon      $ICON.icns ($(du -h "$ICNS" | cut -f1))"
echo "    opens     $PY jarv/vault.py launch"
echo "    checkout  $REPO"
if [ "$RETIRE" = 1 ]; then echo "    retired   $RETIRED"; fi

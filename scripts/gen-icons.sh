#!/usr/bin/env bash
# Regenerates app icons. Usage: pnpm gen-icons <icon.png> <icon-macos.png>
# <icon.png> is full-bleed (Windows, Linux, favicon). <icon-macos.png> is the HIG squircle with its
# own inset and shadow; never derive one from the other.
# macOS-only (sips + iconutil). Output is committed.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: pnpm gen-icons <icon.png> <icon-macos.png>" >&2
  exit 1
fi

for f in "$1" "$2"; do
  [ -f "$f" ] || { echo "missing source icon: $f" >&2; exit 1; }
done

SRC="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
SRC_MACOS="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"

cd "$(dirname "$0")/.."

OUT="src-tauri/icons"

# `tauri icon` also writes an icon.icns; the macOS step overwrites it.
echo "==> tauri icon ($SRC)"
pnpm tauri icon "$SRC" --output "$OUT"

# Desktop-only; drop the mobile sets.
rm -rf "$OUT/ios" "$OUT/android"

echo "==> icon.icns ($SRC_MACOS)"
ICONSET="$(mktemp -d)/set.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC_MACOS" \
    --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$SRC_MACOS" \
    --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/icon.icns"
rm -rf "$(dirname "$ICONSET")"

echo "==> static/favicon.png ($SRC)"
sips -z 256 256 "$SRC" --out static/favicon.png >/dev/null

echo "done."

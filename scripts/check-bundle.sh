#!/usr/bin/env bash
# Checks a built bundle: the app binary is `set` (not `set-mcp`), `set-mcp` shipped beside it, and
# the visible name is "Set".
# Usage: scripts/check-bundle.sh <bundle-dir>. Absent formats are skipped; finding nothing is a
# failure.
# Windows installers: check-bundle.ps1.
set -euo pipefail

BUNDLE_DIR="${1:-}"
if [ -z "$BUNDLE_DIR" ]; then
  echo "usage: $0 <bundle-dir>" >&2
  exit 2
fi

# `::error::` is a GitHub Actions annotation.
fail() {
  echo "::error::$*" >&2
  exit 1
}

# `find` on a missing dir exits 1 under `set -e`; absence is a skip, not a failure.
find_one() {
  [ -d "$1" ] || return 0
  find "$1" -maxdepth 1 -name "$2" 2>/dev/null | head -1 || true
}

# Members may or may not carry a leading `./`; anchored so `set` cannot match `set-mcp`.
deb_has() {
  echo "$1" | grep -qE "[[:space:]]\.?/?$2\$"
}

checked=0

app="$BUNDLE_DIR/macos/Set.app"
if [ -d "$app" ]; then
  plist="$app/Contents/Info.plist"
  read_plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null || true; }

  exe=$(read_plist CFBundleExecutable)
  [ "$exe" = "set" ] || fail "Set.app launches '$exe', not the app binary 'set'."

  name=$(read_plist CFBundleName)
  [ "$name" = "Set" ] || fail "Set.app is named '$name', not 'Set'."

  for bin in set set-mcp; do
    [ -x "$app/Contents/MacOS/$bin" ] || fail "$bin is missing from Set.app."
  done

  echo "ok: Set.app launches 'set', is named 'Set', and ships set-mcp"
  checked=$((checked + 1))
fi

deb=$(find_one "$BUNDLE_DIR/deb" '*.deb')
if [ -n "$deb" ]; then
  contents=$(dpkg-deb -c "$deb")
  for bin in set set-mcp; do
    deb_has "$contents" "usr/bin/$bin" ||
      fail "$bin is missing from $(basename "$deb")."
  done

  # The .desktop entry is the only human-readable name; `Package:` must be lowercase.
  desktop=$(dpkg-deb --fsys-tarfile "$deb" |
    tar -xO --wildcards '*usr/share/applications/Set.desktop' 2>/dev/null || true)
  [ -n "$desktop" ] || fail "Set.desktop is missing from $(basename "$deb")."
  echo "$desktop" | grep -q '^Name=Set$' ||
    fail "Set.desktop does not read 'Name=Set': $(echo "$desktop" | grep '^Name=' || echo '(no Name)')"

  echo "ok: $(basename "$deb") ships set + set-mcp in /usr/bin and names the app 'Set'"
  checked=$((checked + 1))
fi

# Same bundler path as .deb; skipped where `rpm` is missing.
rpm_pkg=$(find_one "$BUNDLE_DIR/rpm" '*.rpm')
if [ -n "$rpm_pkg" ] && command -v rpm >/dev/null; then
  listing=$(rpm -qlp "$rpm_pkg" 2>/dev/null)
  for bin in set set-mcp; do
    echo "$listing" | grep -qx "/usr/bin/$bin" ||
      fail "$bin is missing from $(basename "$rpm_pkg")."
  done
  echo "ok: $(basename "$rpm_pkg") ships set + set-mcp in /usr/bin"
  checked=$((checked + 1))
fi

appimage=$(find_one "$BUNDLE_DIR/appimage" '*.AppImage')
if [ -n "$appimage" ]; then
  # `--appimage-extract` needs no FUSE and writes squashfs-root/ into cwd.
  workdir=$(mktemp -d)
  trap 'rm -rf "$workdir"' EXIT
  # Absolute path (extract runs from the work dir), and +x may be lost through a zip.
  appimage="$(cd "$(dirname "$appimage")" && pwd)/$(basename "$appimage")"
  chmod +x "$appimage"
  (cd "$workdir" && "$appimage" --appimage-extract >/dev/null)
  root="$workdir/squashfs-root"

  for bin in set set-mcp; do
    [ -x "$root/usr/bin/$bin" ] || fail "$bin is missing from $(basename "$appimage")."
  done
  grep -q '^Name=Set$' "$root/Set.desktop" ||
    fail "$(basename "$appimage") does not name the app 'Set'."

  echo "ok: $(basename "$appimage") ships set + set-mcp and names the app 'Set'"
  checked=$((checked + 1))
fi

if [ "$checked" -eq 0 ]; then
  fail "no bundles found under $BUNDLE_DIR; nothing was checked."
fi

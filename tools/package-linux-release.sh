#!/usr/bin/env bash
# package-linux-release.sh — Build an AppImage using the host GTK/WebKit stack.
#
# Usage:
#   bash tools/package-linux-release.sh [version] [build_dir] [notes_file]
#
# Defaults:
#   version   = 0.0.0
#   build_dir = build-release-linux
#
# Prerequisites:
#   - Release build already compiled (python build.py prod --version <version>, or cmake manually)
#   - wget available (for downloading linuxdeploy on first run)
#
set -euo pipefail

VERSION="${1:-0.0.0}"
BUILD_DIR="${2:-build-release-linux}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION="${VERSION#v}"
NOTES_FILE="${3:-docs/releases/$VERSION.md}"
python3 "$ROOT_DIR/tools/validate-release-notes.py" --version "$VERSION" --notes-file "$NOTES_FILE"
python3 - "$ROOT_DIR/$BUILD_DIR" "$SCRIPT_DIR/package-linux-native.py" <<'PYCODE'
import importlib.util
import sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("native_packaging", sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.validate_ai_release_configuration(Path(sys.argv[1]))
PYCODE

BINARY="$ROOT_DIR/$BUILD_DIR/OpenStudio_artefacts/Release/OpenStudio"
APPDIR="$ROOT_DIR/dist/linux/OpenStudio.AppDir"
OUT_DIR="$ROOT_DIR/dist/linux"
TOOLS_DIR="$ROOT_DIR/tools"
LINUXDEPLOY_VERSION="1-alpha-20251107-1"
LINUXDEPLOY_SHA256="c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d"

echo "=== OpenStudio Linux AppImage packaging ==="
echo "Version   : $VERSION"
echo "Build dir : $BUILD_DIR"
echo "Binary    : $BINARY"

# ── Validate binary ────────────────────────────────────────────────────────────
if [ ! -f "$BINARY" ]; then
    echo "ERROR: Release binary not found at $BINARY"
    echo "Run the release build first:"
    echo "  python build.py prod --version $VERSION"
    exit 1
fi

if [ ! -x "$(dirname "$BINARY")/OpenStudioUpdateInstaller" ]; then
    echo "ERROR: The executable update helper is missing. Rebuild before packaging." >&2
    exit 1
fi

# ── Create AppDir skeleton ─────────────────────────────────────────────────────
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/256x256/apps" "$OUT_DIR"

# Copy main binary
cp "$BINARY" "$APPDIR/usr/bin/OpenStudio"
chmod +x "$APPDIR/usr/bin/OpenStudio"

# Copy all runtime assets that sit beside the binary (models/, scripts/, ffmpeg, webui/, etc.)
RELEASE_ASSET_DIR="$(dirname "$BINARY")"
for item in "$RELEASE_ASSET_DIR"/*/; do
    [ -d "$item" ] && cp -r "$item" "$APPDIR/usr/bin/"
done
for item in "$RELEASE_ASSET_DIR"/*; do
    [ -f "$item" ] && [ "$(basename "$item")" != "OpenStudio" ] && cp "$item" "$APPDIR/usr/bin/"
done

# linuxdeploy rewrites the executable's RUNPATH to $ORIGIN/../lib. Keep the
# pinned private runtime there; exclude host GTK/WebKit libraries below.
mkdir -p "$APPDIR/usr/lib"
for item in "$APPDIR/usr/bin"/libonnxruntime.so*; do
    [ ! -f "$item" ] || cp -a "$item" "$APPDIR/usr/lib/"
done

# ── Desktop entry + icon ───────────────────────────────────────────────────────
cp "$TOOLS_DIR/OpenStudio.desktop" "$APPDIR/OpenStudio.desktop"
cp "$TOOLS_DIR/OpenStudio.desktop" "$APPDIR/usr/share/applications/OpenStudio.desktop"

if [ -f "$ROOT_DIR/assets/icon-256x256.png" ]; then
    cp "$ROOT_DIR/assets/icon-256x256.png" "$APPDIR/OpenStudio.png"
    cp "$ROOT_DIR/assets/icon-256x256.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/OpenStudio.png"
fi

# ── Download linuxdeploy if needed ─────────────────────────────────────────────
LINUXDEPLOY="$TOOLS_DIR/linuxdeploy-x86_64.AppImage"
if [ -f "$LINUXDEPLOY" ] && ! echo "$LINUXDEPLOY_SHA256  $LINUXDEPLOY" | sha256sum --check --strict --status; then
    echo "Existing linuxdeploy checksum does not match the pinned release; replacing it."
    rm -f -- "$LINUXDEPLOY"
fi

if [ ! -f "$LINUXDEPLOY" ]; then
    echo "Downloading linuxdeploy..."
    LINUXDEPLOY_TEMP="$LINUXDEPLOY.download"
    wget -q --show-progress \
        -O "$LINUXDEPLOY_TEMP" \
        "https://github.com/linuxdeploy/linuxdeploy/releases/download/$LINUXDEPLOY_VERSION/linuxdeploy-x86_64.AppImage"
    echo "$LINUXDEPLOY_SHA256  $LINUXDEPLOY_TEMP" | sha256sum --check --strict
    mv -f -- "$LINUXDEPLOY_TEMP" "$LINUXDEPLOY"
    chmod +x "$LINUXDEPLOY"
fi

# Reject payloads newer than the declared Ubuntu 22.04 ABI baseline, including
# helper executables and prebuilt libraries. This does not provision host WebKit.
python3 "$TOOLS_DIR/validate-linux-abi.py" --root "$APPDIR" --max-glibc 2.35 \
    --report "$OUT_DIR/OpenStudio-${VERSION}-payload-abi.json"

# ── Build AppImage ─────────────────────────────────────────────────────────────
# WebKit is loaded dynamically. Bundling only JavaScriptCore/GLib and their
# transitive dependencies breaks compatibility with newer host WebKit/GTK.
# Keep the system stack on the host; pinned ONNX Runtime is already copied
# into usr/lib above. Native .deb/.rpm packages provision dependencies;
# AppImage remains an optional download for prepared Linux installations.
export APPIMAGE_EXTRACT_AND_RUN=1

# Isolate output discovery from earlier builds in the checkout.
PACKAGE_WORK="$(mktemp -d)"
trap 'rm -rf -- "$PACKAGE_WORK"' EXIT
cd "$PACKAGE_WORK"
"$LINUXDEPLOY" \
    --appdir "$APPDIR" \
    --executable "$APPDIR/usr/bin/OpenStudio" \
    --desktop-file "$APPDIR/OpenStudio.desktop" \
    --icon-file "$APPDIR/OpenStudio.png" \
    --exclude-library '*' \
    --output appimage

# Accept exactly one fresh output; never reuse an older AppImage by glob order.
shopt -s nullglob
BUILT_APPIMAGES=(OpenStudio*.AppImage)
if [ "${#BUILT_APPIMAGES[@]}" -eq 1 ]; then
    BUILT_APPIMAGE="${BUILT_APPIMAGES[0]}"
    OUTPUT_NAME="OpenStudio-${VERSION}-linux-x86_64.AppImage"
    mv "$BUILT_APPIMAGE" "$OUT_DIR/$OUTPUT_NAME"
    python3 "$TOOLS_DIR/validate-linux-abi.py" --root "$APPDIR" --max-glibc 2.35 \
        --report "$OUT_DIR/OpenStudio-${VERSION}-appdir-abi.json"
    # Validate the finished launcher, including its rewritten library paths.
    # This is an asset/prerequisite check, not the separate boot-ready UI gate.
    REPORT="$OUT_DIR/OpenStudio-${VERSION}-AppImage-startup.txt"
    rm -f "$REPORT"
    "$OUT_DIR/$OUTPUT_NAME" --startup-self-test --report "$REPORT"
    grep -q '^shellReady=true' "$REPORT"
    echo ""
    echo "AppImage created: dist/linux/$OUTPUT_NAME"
else
    echo "WARNING: Could not locate built AppImage. Check linuxdeploy output above."
    exit 1
fi

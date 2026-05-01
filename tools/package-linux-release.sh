#!/usr/bin/env bash
# package-linux-release.sh — Build a portable AppImage for OpenStudio on Linux.
#
# Usage:
#   bash tools/package-linux-release.sh [version] [build_dir]
#
# Defaults:
#   version   = 0.0.0
#   build_dir = build-release-linux
#
# Prerequisites:
#   - Release build already compiled (python build.py prod, or cmake manually)
#   - wget available (for downloading linuxdeploy on first run)
#
set -euo pipefail

VERSION="${1:-0.0.0}"
BUILD_DIR="${2:-build-release-linux}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

BINARY="$ROOT_DIR/$BUILD_DIR/OpenStudio_artefacts/Release/OpenStudio"
APPDIR="$ROOT_DIR/dist/linux/OpenStudio.AppDir"
OUT_DIR="$ROOT_DIR/dist/linux"
TOOLS_DIR="$ROOT_DIR/tools"

echo "=== OpenStudio Linux AppImage packaging ==="
echo "Version   : $VERSION"
echo "Build dir : $BUILD_DIR"
echo "Binary    : $BINARY"

# ── Validate binary ────────────────────────────────────────────────────────────
if [ ! -f "$BINARY" ]; then
    echo "ERROR: Release binary not found at $BINARY"
    echo "Run the release build first:"
    echo "  python build.py prod"
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

# ── Desktop entry + icon ───────────────────────────────────────────────────────
cp "$TOOLS_DIR/OpenStudio.desktop" "$APPDIR/OpenStudio.desktop"
cp "$TOOLS_DIR/OpenStudio.desktop" "$APPDIR/usr/share/applications/OpenStudio.desktop"

if [ -f "$ROOT_DIR/assets/icon-256x256.png" ]; then
    cp "$ROOT_DIR/assets/icon-256x256.png" "$APPDIR/OpenStudio.png"
    cp "$ROOT_DIR/assets/icon-256x256.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/OpenStudio.png"
fi

# ── Download linuxdeploy if needed ─────────────────────────────────────────────
LINUXDEPLOY="$TOOLS_DIR/linuxdeploy-x86_64.AppImage"
if [ ! -f "$LINUXDEPLOY" ]; then
    echo "Downloading linuxdeploy..."
    wget -q --show-progress \
        -O "$LINUXDEPLOY" \
        "https://github.com/linuxdeploy/linuxdeploy/releases/latest/download/linuxdeploy-x86_64.AppImage"
    chmod +x "$LINUXDEPLOY"
fi

# ── Build AppImage ─────────────────────────────────────────────────────────────
cd "$ROOT_DIR"
"$LINUXDEPLOY" \
    --appdir "$APPDIR" \
    --executable "$APPDIR/usr/bin/OpenStudio" \
    --desktop-file "$APPDIR/OpenStudio.desktop" \
    --icon-file "$APPDIR/OpenStudio.png" \
    --output appimage

# linuxdeploy names the output using the AppDir Name field — move it to dist/
APPIMAGE_PATTERN="OpenStudio-*.AppImage"
BUILT_APPIMAGE=$(ls $APPIMAGE_PATTERN 2>/dev/null | head -1 || true)
if [ -z "$BUILT_APPIMAGE" ]; then
    # Fallback: linuxdeploy may have placed it differently
    BUILT_APPIMAGE=$(ls *.AppImage 2>/dev/null | grep -i openstudio | head -1 || true)
fi

if [ -n "$BUILT_APPIMAGE" ]; then
    OUTPUT_NAME="OpenStudio-${VERSION}-linux-x86_64.AppImage"
    mv "$BUILT_APPIMAGE" "$OUT_DIR/$OUTPUT_NAME"
    echo ""
    echo "AppImage created: dist/linux/$OUTPUT_NAME"
else
    echo "WARNING: Could not locate built AppImage. Check linuxdeploy output above."
    exit 1
fi

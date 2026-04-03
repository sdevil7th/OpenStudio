#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-}"
VERSION="${2:-}"
OUTPUT_DIR="${3:-dist/macos}"

if [[ -z "$APP_PATH" || -z "$VERSION" ]]; then
  echo "Usage: $0 <path-to-OpenStudio.app> <version> [output-dir]" >&2
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "App bundle not found: $APP_PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

APP_NAME="$(basename "$APP_PATH")"
STAGED_APP="$STAGING_DIR/$APP_NAME"
DMG_PATH="$OUTPUT_DIR/OpenStudio-macOS.dmg"

ditto "$APP_PATH" "$STAGED_APP"
ln -s /Applications "$STAGING_DIR/Applications"

if [[ -n "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --deep --timestamp --options runtime --sign "$MACOS_CODESIGN_IDENTITY" "$STAGED_APP"
  codesign --verify --deep --strict "$STAGED_APP"
  spctl --assess --type execute "$STAGED_APP"
else
  echo "Packaging unsigned macOS DMG (free degraded distribution path)." >&2
fi

hdiutil create \
  -volname "OpenStudio ${VERSION}" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

if [[ -n "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --timestamp --sign "$MACOS_CODESIGN_IDENTITY" "$DMG_PATH"
  codesign --verify "$DMG_PATH"
  spctl --assess --type open "$DMG_PATH"
fi

if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --wait

  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
fi

echo "Created macOS DMG at $DMG_PATH"

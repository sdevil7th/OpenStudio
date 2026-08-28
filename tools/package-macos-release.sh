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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENTITLEMENTS_PATH="${MACOS_ENTITLEMENTS_PATH:-$ROOT_DIR/packaging/macos/OpenStudio.entitlements}"

NOTARY_CREDENTIAL_COUNT=0
[[ -n "${APPLE_ID:-}" ]] && NOTARY_CREDENTIAL_COUNT=$((NOTARY_CREDENTIAL_COUNT + 1))
[[ -n "${APPLE_TEAM_ID:-}" ]] && NOTARY_CREDENTIAL_COUNT=$((NOTARY_CREDENTIAL_COUNT + 1))
[[ -n "${APPLE_APP_PASSWORD:-}" ]] && NOTARY_CREDENTIAL_COUNT=$((NOTARY_CREDENTIAL_COUNT + 1))

if [[ "$NOTARY_CREDENTIAL_COUNT" -ne 0 && "$NOTARY_CREDENTIAL_COUNT" -ne 3 ]]; then
  echo "Notarization requires APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_PASSWORD together." >&2
  exit 1
fi

if [[ "$NOTARY_CREDENTIAL_COUNT" -eq 3 && -z "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
  echo "Notarization requires a Developer ID-signed app; set MACOS_CODESIGN_IDENTITY." >&2
  exit 1
fi

ditto "$APP_PATH" "$STAGED_APP"
ln -s /Applications "$STAGING_DIR/Applications"

if [[ -n "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
  # Sign the outer app explicitly.  Do not use --deep while signing: any future
  # nested code must be signed deliberately in its own designated-code slot,
  # and the strict deep verification below will fail closed if it is missed.
  if [[ -f "$ENTITLEMENTS_PATH" ]]; then
    codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS_PATH" --sign "$MACOS_CODESIGN_IDENTITY" "$STAGED_APP"
  else
    echo "macOS entitlements file not found at $ENTITLEMENTS_PATH; signing without extra runtime permissions." >&2
    codesign --force --timestamp --options runtime --sign "$MACOS_CODESIGN_IDENTITY" "$STAGED_APP"
  fi
  codesign --verify --deep --strict "$STAGED_APP"
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
fi

if [[ "$NOTARY_CREDENTIAL_COUNT" -eq 3 ]]; then
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --wait

  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_PATH"
else
  if [[ -n "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
    echo "The DMG is Developer ID-signed but not notarized; Gatekeeper may still warn or block first launch." >&2
  fi
fi

echo "Created macOS DMG at $DMG_PATH"

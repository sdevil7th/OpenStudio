#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-}"
VERSION="${2:-}"
OUTPUT_DIR="${3:-dist/macos}"
NOTES_FILE="${4:-}"

if [[ -z "$APP_PATH" || -z "$VERSION" ]]; then
  echo "Usage: $0 <path-to-OpenStudio.app> <version> [output-dir] [notes-file]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
python3 "$SCRIPT_DIR/validate-release-notes.py" --version "$VERSION" --notes-file "$NOTES_FILE"

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
ENTITLEMENTS_PATH="${MACOS_ENTITLEMENTS_PATH:-$ROOT_DIR/packaging/macos/OpenStudio.entitlements}"

SIGNING_KIND="${MACOS_CODESIGN_KIND:-developer-id}"
case "$SIGNING_KIND" in
  developer-id) TIMESTAMP_OPTION="--timestamp" ;;
  self-signed) TIMESTAMP_OPTION="--timestamp=none" ;;
  *) echo "MACOS_CODESIGN_KIND must be developer-id or self-signed." >&2; exit 1 ;;
esac
if [[ "$SIGNING_KIND" == "self-signed" && -z "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
  echo "Self-signed mode requires a persistent MACOS_CODESIGN_IDENTITY." >&2
  exit 1
fi

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

if [[ "$NOTARY_CREDENTIAL_COUNT" -eq 3 && "$SIGNING_KIND" != "developer-id" ]]; then
  echo "Self-signed builds cannot be notarized. Use Developer ID for notarization." >&2
  exit 1
fi

ditto "$APP_PATH" "$STAGED_APP"
if [[ ! -x "$STAGED_APP/Contents/Helpers/OpenStudioUpdateInstaller" ]]; then
  echo "The app is missing its executable update helper. Rebuild before packaging." >&2
  exit 1
fi
python3 "$SCRIPT_DIR/validate-support-tool.py" --bundle "$STAGED_APP" --version "$VERSION"
python3 "$SCRIPT_DIR/release_build_policy.py" --bundle "$STAGED_APP" --version "$VERSION"
SUPPORT_SHORTCUT="$(dirname "$APP_PATH")/OpenStudio Support.app"
if [[ ! -d "$SUPPORT_SHORTCUT" ]]; then
  echo "Missing separate Finder support launcher; assemble/stage the support package first." >&2
  exit 1
fi
ditto "$SUPPORT_SHORTCUT" "$STAGING_DIR/OpenStudio Support.app"
lipo "$STAGED_APP/Contents/Helpers/OpenStudioSupport.app/Contents/MacOS/OpenStudioSupport" -verify_arch arm64 x86_64
ln -s /Applications "$STAGING_DIR/Applications"

if [[ -n "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
  # Sign the outer app explicitly.  Do not use --deep while signing: any future
  # nested code must be signed deliberately in its own designated-code slot,
  # and the strict deep verification below will fail closed if it is missed.
  SUPPORT_SIGN_OPTIONS=()
  [[ "$SIGNING_KIND" != "self-signed" ]] || SUPPORT_SIGN_OPTIONS+=(--no-timestamp)
  python3 "$SCRIPT_DIR/sign-macos-support.py" "$STAGED_APP/Contents/Helpers/OpenStudioSupport.app" --identity "$MACOS_CODESIGN_IDENTITY" "${SUPPORT_SIGN_OPTIONS[@]}"
  python3 "$SCRIPT_DIR/sign-macos-support.py" "$STAGING_DIR/OpenStudio Support.app" --identity "$MACOS_CODESIGN_IDENTITY" "${SUPPORT_SIGN_OPTIONS[@]}"
  codesign --force "$TIMESTAMP_OPTION" --options runtime --sign "$MACOS_CODESIGN_IDENTITY" "$STAGED_APP/Contents/Helpers/OpenStudioUpdateInstaller"
  if [[ -f "$ENTITLEMENTS_PATH" ]]; then
    codesign --force "$TIMESTAMP_OPTION" --options runtime --entitlements "$ENTITLEMENTS_PATH" --sign "$MACOS_CODESIGN_IDENTITY" "$STAGED_APP"
  else
    echo "macOS entitlements file not found at $ENTITLEMENTS_PATH; signing without extra runtime permissions." >&2
    codesign --force "$TIMESTAMP_OPTION" --options runtime --sign "$MACOS_CODESIGN_IDENTITY" "$STAGED_APP"
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
  codesign --force "$TIMESTAMP_OPTION" --sign "$MACOS_CODESIGN_IDENTITY" "$DMG_PATH"
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
    echo "The DMG is $SIGNING_KIND signed but not notarized; Gatekeeper may still warn or block first launch." >&2
  fi
fi

# Preserve evidence of the actual identity rather than inferring it from inputs.
{ codesign -d --verbose=4 --requirements :- "$STAGED_APP" 2>&1 || true; } > "$OUTPUT_DIR/OpenStudio-macOS.signing.txt"
if [[ "$SIGNING_KIND" == "self-signed" ]]; then
  echo "Self-signing is an identity-continuity experiment, not Gatekeeper acceptance. Reuse the same release key; never ask users to trust a root certificate." >&2
fi
echo "Created macOS DMG at $DMG_PATH"

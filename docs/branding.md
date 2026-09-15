# OpenStudio branding

The approved logo master is [`assets/branding/openstudio-logo-source.png`](../assets/branding/openstudio-logo-source.png), a 2160 × 2160 PNG. It matches the website master byte for byte:

`ab70f07153bf727611bda48729dc0bdefe174c53b908655c547aec140f6c8dee` (SHA-256).

## Regenerate icons

After installing the frontend dependencies, run from the repository root:

```sh
node tools/generate-icons.mjs
```

The script resizes the master directly, preserving transparency. Do not generate one icon from another smaller icon.

| Consumer | Source |
| --- | --- |
| Menu bar, 16 px display | `frontend/public/icon-32x32.png` |
| Main/documentation README | `frontend/public/icon.png`, 512 px |
| Browser | `frontend/public/favicon-{16x16,32x32,48x48}.png` and links in `frontend/index.html` |
| Apple home screen | `frontend/public/apple-touch-icon.png`, 180 px |
| Web manifest | `frontend/public/android-chrome-{192x192,512x512}.png` and `site.webmanifest` |
| JUCE native app icons | `assets/icon-1024x1024.png` and `assets/icon-16x16.png`, selected in `CMakeLists.txt` |
| Linux AppImage / desktop launcher | `assets/icon-256x256.png`, copied by `tools/package-linux-release.sh` |
| Windows Store MSIX tiles | `assets/icon-1024x1024.png`, resized by `tools/package-windows-store.ps1` |

Old `frontend/public/icon.svg` and `logo.svg` were retired. When changing the master again, regenerate all sizes and bump the frontend favicon/manifest query version. Rebuild the frontend and the native configuration that will be shipped; already-built executables and published releases retain their previous embedded resources.

The September 2026 refresh passed the frontend production build and `cmake --build build --config Debug`. The Debug executable and copied `webui` include the updated icons. A new app release is needed to deliver the native icons to existing users. Historical screenshots and third-party logos are separate from active OpenStudio branding.

For later changes, follow [WORKFLOWS.md](../WORKFLOWS.md), the
[release runbook](release-runbook.md#branding-before-packaging) and
[release smoke checklist](release-smoke-checklist.md#branding-and-public-download-consistency).
Those checks apply to the candidate being shipped; the September Debug result
does not qualify a later installer or other platform.

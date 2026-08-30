# OpenStudio Development Workflows

## ✨ NEW: Single Command Development

```bash
python build.py dev --run
```

**What it does:**
1. ✅ Installs npm dependencies
2. ✅ Builds C++ backend (if needed)
3. ✅ Starts Vite dev server (background)
4. ✅ Launches OpenStudio.exe
5. ✅ Auto-cleanup when you close the app

**No more juggling terminals!**

## Manual Testing Handoff

When Codex asks for manual testing, the handoff must be ready for this exact command:

```bash
python build.py dev --run
```

Before that handoff:
- `cmake --build build --config Debug` must have completed after the latest changes.
- The current frontend must be built/copied so packaged assets are not stale if fallback is ever used.
- No pre-running Vite/npm/dev server should be required from the user.
- Any Codex-started Vite/npm/browser harness processes should be stopped first, and port `5183` should not be left occupied by a Codex-started process.

**Run this to rebuild the backend:**

```bash
cmake --build build --config Debug
```

---

## Alternative: Manual Development

### First Time Setup
```bash
python build.py dev --run
```

### Daily Workflow
```bash
# Terminal 1
cd frontend
npm run dev

# Terminal 2
./build/OpenStudio_artefacts/Debug/OpenStudio.exe
```

---

## Production Build

```bash
python build.py prod
doppler run -- python build.py dev --run
```

**Output:** Single executable at `build/OpenStudio_artefacts/Release/OpenStudio.exe`
**No Vite needed!** Assets are embedded.

---


## Simple release trigger
```bash
git push origin main
git tag v0.0.2
git push origin v0.0.2
```

## Release trigger for AI Tools runtime
```bash
git tag ai-runtime-v0.0.31
git push origin ai-runtime-v0.0.31

```

## macOS first launch

The normal first-launch path is:

1. Verify the downloaded DMG against the published SHA-256 checksum.
2. Drag `OpenStudio.app` to `/Applications` and attempt to open it.
3. If macOS blocks the unsigned build, use **System Settings > Privacy &
   Security > Open Anyway** for that app, then confirm the launch.

## If that also doesn't work, then run this command to un-quarantine the app and use it
## Otherwise the app might be shown as damaged or broken in macOS
```bash
xattr -dr com.apple.quarantine /Applications/OpenStudio.app
```

## Comparison with REAPER

| Feature | OpenStudio (Hybrid) | REAPER (Native) |
|---------|-------------------|-----------------|
| **Dev Mode** | `python build.py dev --run` | Rebuild for every UI change |
| **UI Tech** | React + CSS | Win32/Cocoa C++ |
| **Dev Speed** | ⚡ Instant HMR | 🐌 Full recompile |
| **Memory** | ~100MB (WebView) | ~20MB (Native) |
| **Production** | Single .exe | Single .exe |
| **Cross-Platform UI** | ✅ Same code | ❌ Per-OS code |

**Takeaway:** We sacrifice a bit of memory for **massively** faster UI development.

---

## FAQ

**Q: Why does dev mode need Vite?**  
A: Hot Module Replacement (HMR) - change React → instant update. No C++ rebuild!

**Q: Can I skip Vite?**  
A: Yes! Use `python build.py prod` for embedded assets. But you lose HMR.

**Q: How does production work?**  
A: Frontend assets are compiled into the .exe. No server needed!

**Q: Is this slower than REAPER?**  
A: Slightly higher memory (~80MB overhead), but audio thread is 100% native C++. No performance hit for DSP!

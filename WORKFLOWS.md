# Studio13 Development Workflows

## ✨ NEW: Single Command Development

```bash
python build.py dev --run
```

**What it does:**
1. ✅ Installs npm dependencies
2. ✅ Builds C++ backend (if needed)
3. ✅ Starts Vite dev server (background)
4. ✅ Launches Studio13_v2.exe
5. ✅ Auto-cleanup when you close the app

**No more juggling terminals!**

---

## Alternative: Manual Development

### First Time Setup
```bash
python build.py dev
```

### Daily Workflow
```bash
# Terminal 1
cd frontend
npm run dev

# Terminal 2
./build/Studio13_v2_artefacts/Debug/Studio13.exe
```

---

## Production Build

```bash
python build.py prod
```

**Output:** Single executable at `build/Studio13_v2_artefacts/Release/Studio13.exe`  
**No Vite needed!** Assets are embedded.

---

## Comparison with REAPER

| Feature | Studio13 (Hybrid) | REAPER (Native) |
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

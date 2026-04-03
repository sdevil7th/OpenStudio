# Studio13 New Features Implementation Plan

## Current State Summary

| Area | Status | Notes |
|------|--------|-------|
| JSFX Audio Processing | Done | YSFX fully integrated, S13FXProcessor wraps scripts as AudioProcessor |
| JSFX @gfx Rendering | Not Started | YSFX header has gfx APIs but never called |
| Lua Scripting (Automation) | Done | 50+ functions in ScriptEngine, transport/tracks/FX/automation/analysis |
| Lua Scripting (GUI) | Not Started | No drawing API, scripts output to console only |
| Theme System | Done | 5 presets + per-color overrides via ThemeEditor, CSS custom properties |
| VST3 Hosting | Done | Full scanning, loading, parameter control, editor windows |
| CLAP Hosting | Partial | CLAPPluginFormat class exists, scan paths configured, loading incomplete |
| LV2 Hosting | Prepared | Code paths exist, JUCE 8 has LV2 support, not compiled in |
| REAPER Compatibility | Not Started | Architecture inspired by REAPER but no API/format compatibility |

---

## Feature 1: Playhead Stop Behavior Setting

**Priority**: High | **Effort**: Low | **Impact**: High (UX polish)

Currently the playhead returns to the position where playback started when stopped. Many users (especially those coming from REAPER/Pro Tools) expect it to stop where it is.

### Implementation Plan

#### 1.1 Add workspace setting to Zustand store
**File**: `frontend/src/store/useDAWStore.ts`
- Add `playheadStopBehavior: 'return-to-start' | 'stop-in-place'` to store state
- Default: `'return-to-start'` (current behavior, no breaking change)
- Add `setPlayheadStopBehavior(mode)` action
- Persist in project settings / preferences

#### 1.2 Modify stop action
**File**: `frontend/src/store/useDAWStore.ts` (stop/transport logic)
- In the `stop()` action, check `playheadStopBehavior`:
  - `'return-to-start'`: current behavior (set currentTime back to where play started)
  - `'stop-in-place'`: leave currentTime at current playhead position
- The C++ backend stop doesn't need changes — the position is a frontend concern

#### 1.3 Add to Preferences modal
**File**: `frontend/src/components/PreferencesModal.tsx`
- Add toggle under "Editing" or "General" tab:
  - Label: "Playhead behavior on stop"
  - Options: "Return to start position" / "Stop at current position"

#### 1.4 Add keyboard shortcut variant
- Consider: pressing Stop once = stop-in-place, pressing Stop twice = return to start
  (this is the REAPER convention and feels natural for both workflows)

---

## Feature 2: JSFX @gfx Rendering Support

**Priority**: Medium | **Effort**: High | **Impact**: High (unlocks community JSFX plugin UIs)

YSFX already exposes the full @gfx API (`ysfx_gfx_setup`, `ysfx_gfx_run`, `ysfx_gfx_update_mouse`, `ysfx_gfx_add_key`). We just need to render the framebuffer and route input.

### Architecture Decision

**Option A**: Render in JUCE native window (like VST3 editors) using `juce::Image` as framebuffer
- Pros: Same window management as VST3, no WebView overhead, direct pixel access
- Cons: Separate native window, not in WebView

**Option B**: Render in WebView via base64 frame streaming or OffscreenCanvas
- Pros: Integrated in FXChainPanel UI
- Cons: Frame streaming overhead, latency, complex bridge

**Recommendation**: Option A — native JUCE window, matching existing PluginWindowManager pattern

### Implementation Plan

#### 2.1 Create S13FXGfxEditor (JUCE AudioProcessorEditor for JSFX @gfx)
**New file**: `Source/S13FXGfxEditor.h` / `.cpp`

```
class S13FXGfxEditor : public juce::AudioProcessorEditor, public juce::Timer
```

- Holds a `juce::Image` framebuffer (ARGB, sized to gfx_w x gfx_h)
- On `timerCallback()` (~30fps):
  1. Lock the YSFX effect
  2. Call `ysfx_gfx_setup(effect, &gfxConfig)` with framebuffer pointer, width, height
  3. Call `ysfx_gfx_run(effect)` to execute the @gfx section
  4. Unlock, `repaint()`
- On `paint()`: draw the `juce::Image` to screen
- On `mouseDown/mouseDrag/mouseUp/mouseMove`: call `ysfx_gfx_update_mouse(effect, x, y, buttons)`
- On `keyPressed`: call `ysfx_gfx_add_key(effect, keyCode, modifiers, isPressed)`
- Support `ysfx_gfx_wants_retina()` for HiDPI

#### 2.2 Configure ysfx_gfx_config_t
**Reference**: `build/_deps/ysfx-src/include/ysfx.h`

The `ysfx_gfx_config_t` struct needs:
- `pixel_width`, `pixel_height` — framebuffer dimensions
- `pixel_stride` — bytes per row
- `pixels` — pointer to ARGB pixel data (from juce::Image::BitmapData)
- `scale_factor` — for HiDPI (1.0 or 2.0)
- `show_menu` callback — for JSFX scripts that call `gfx_showmenu()`
- `set_cursor` callback — to change mouse cursor

#### 2.3 Update S13FXProcessor to support editor
**File**: `Source/S13FXProcessor.h` / `.cpp`

- Change `hasEditor()` to return `true` when the loaded script has a @gfx section
  - Use `ysfx_has_section(effect, ysfx_section_gfx)` to detect
- `createEditor()` returns `new S13FXGfxEditor(*this)` when @gfx exists
- Add `ysfx_t* getEffect()` accessor for the editor to call gfx APIs
- Add mutex for gfx thread safety (gfx runs on message thread, audio on audio thread)

#### 2.4 Wire into PluginWindowManager
**File**: `Source/PluginWindowManager.cpp`

No changes needed — PluginWindowManager already opens editors via `processor->createEditor()`. Once S13FXProcessor returns an editor, the existing window management works automatically.

#### 2.5 Handle JSFX image loading (gfx_loadimg)
- YSFX's `gfx_loadimg` loads PNGs from the script's directory
- Need to ensure `ysfx_config_set_data_root()` points to the script's parent directory
- Already set in S13FXProcessor::loadScript — verify it includes the effects directory

#### 2.6 Testing
- Test with community JSFX plugins that use @gfx:
  - ReaEQ (REAPER's built-in EQ with spectrum display)
  - Geraint Luff's jsfx-ui-lib examples (knobs, graphs)
  - JS: Liteon/analyser (spectrum analyzer)
  - Any JSFX with `@gfx` section from the ReaTeam JSFX repository

### Dependencies
- None (YSFX already compiled and linked)

### Estimated Sub-tasks
1. Implement S13FXGfxEditor with framebuffer rendering — 1 session
2. Wire mouse/keyboard input routing — 0.5 session
3. Handle gfx_loadimg, show_menu, set_cursor callbacks — 0.5 session
4. Test with 5+ community JSFX scripts — 1 session

---

## Feature 3: Lua Scripting GUI API

**Priority**: Medium | **Effort**: Medium | **Impact**: Medium (power users can create custom tools)

Expose a drawing/widget API to Lua scripts so they can create custom tool windows (similar to REAPER's ReaScript gfx.* or ReaImGui).

### Architecture Decision

**Option A**: Immediate-mode drawing API (like REAPER's gfx.*)
- `s13.gfx.init("Window Title", 400, 300)`
- `s13.gfx.rect(x, y, w, h)`, `s13.gfx.line(...)`, `s13.gfx.drawstr(...)`
- `s13.gfx.mouse_x`, `s13.gfx.mouse_y`, `s13.gfx.mouse_cap`
- Runs in a loop via `s13.defer(callback)` pattern
- Pros: REAPER-compatible API surface, simple for script authors
- Cons: Need native window + framebuffer per script, C++ rendering

**Option B**: WebView-based widget API (React components generated from Lua)
- Scripts describe UI declaratively, rendered in a docked WebView panel
- Pros: Rich UI, uses existing React infrastructure, beautiful by default
- Cons: Complex bridge, not REAPER-compatible, higher latency

**Option C**: ImGui-style API via native window
- `s13.ui.begin("Window")`, `s13.ui.button("Click me")`, `s13.ui.slider("Volume", 0, 1)`
- Backed by JUCE components in a native window
- Pros: Fast, native feel, widget-level API (simpler than pixel drawing)
- Cons: No REAPER compatibility, need widget rendering engine

**Recommendation**: Option A first (REAPER compatibility), Option C later for convenience widgets

### Implementation Plan

#### 3.1 Create S13ScriptWindow (JUCE component for script GUIs)
**New file**: `Source/S13ScriptWindow.h` / `.cpp`

- `juce::DocumentWindow` subclass with embedded `juce::Component`
- Holds a `juce::Image` framebuffer
- 30fps timer for redraw
- Mouse/keyboard event capture and storage in shared state
- Script reads mouse_x/mouse_y/mouse_cap from Lua globals

#### 3.2 Add gfx.* API to ScriptEngine
**File**: `Source/ScriptEngine.cpp`

Register these Lua functions:
```
s13.gfx.init(title, width, height [, dock])  -- open/resize window
s13.gfx.close()                               -- close window
s13.gfx.set(r, g, b [, a])                    -- set color (0-1)
s13.gfx.rect(x, y, w, h [, filled])           -- rectangle
s13.gfx.line(x1, y1, x2, y2 [, aa])           -- line
s13.gfx.circle(x, y, r [, fill, aa])          -- circle
s13.gfx.arc(x, y, r, ang1, ang2 [, aa])       -- arc
s13.gfx.roundrect(x, y, w, h, radius)         -- rounded rect
s13.gfx.drawstr(text [, flags, right, bottom]) -- text
s13.gfx.setfont(size [, face, flags])          -- font
s13.gfx.measurestr(text) -> w, h              -- text metrics
s13.gfx.blit(img, scale, rotation, ...)        -- image blit
s13.gfx.loadimg(idx, filename)                 -- load PNG
s13.gfx.getchar() -> keycode                  -- keyboard input
```

Expose as globals (matching REAPER convention):
```
gfx.x, gfx.y           -- current draw position
gfx.w, gfx.h           -- window size
gfx.mouse_x, gfx.mouse_y  -- mouse position
gfx.mouse_cap          -- mouse buttons bitmask (1=L, 2=R, 4=Ctrl, 8=Shift, 16=Alt)
gfx.mouse_wheel        -- scroll delta
```

#### 3.3 Add s13.defer() for script main loops
**File**: `Source/ScriptEngine.cpp`

- `s13.defer(callback)` — schedule a Lua function to run on next message loop cycle
- This is the pattern REAPER uses for scripts that need continuous updates
- ScriptEngine maintains a deferred callback queue, processes on a timer

#### 3.4 Script window management
**File**: `Source/ScriptEngine.cpp` / `MainComponent.cpp`

- Track open script windows in ScriptEngine
- Close all script windows when script terminates
- Support docking (stretch goal — requires WebView panel integration)

#### 3.5 Frontend integration
**File**: `frontend/src/components/` (new ScriptRunner panel)

- Add "Run Script" UI in menu/toolbar
- Script console panel showing print() output
- List of running scripts with stop buttons

### REAPER API Compatibility Target
The goal is that simple ReaScripts using `gfx.*` functions work with minimal modifications:
- Change `reaper.defer(fn)` to `s13.defer(fn)`
- Change `reaper.GetCursorPosition()` to `s13.getPlayhead()`
- Most `gfx.*` calls should work as-is

### Estimated Sub-tasks
1. S13ScriptWindow with framebuffer — 1 session
2. Core gfx.* drawing functions (rect, line, circle, text) — 1 session
3. Mouse/keyboard input routing — 0.5 session
4. s13.defer() and script lifecycle — 0.5 session
5. Image loading (gfx.loadimg/blit) — 0.5 session
6. Testing with adapted REAPER scripts — 1 session

---

## Feature 4: Community Compatibility (Themes, Scripts, Extensions)

**Priority**: Medium | **Effort**: Medium-High | **Impact**: High (ecosystem leverage)

### 4.1 REAPER Theme Color Import
**Effort**: Low

REAPER `.ReaperTheme` files are INI-format with 400+ named color entries. We can import the key colors into our CSS custom property system.

**Plan**:
- Add "Import REAPER Theme" button in ThemeEditor
- Parse the `.ReaperTheme` INI file
- Map REAPER color keys to Studio13 `daw-*` tokens:
  - `col_main_bg` -> `--color-daw-dark`
  - `col_main_bg2` -> `--color-daw-panel`
  - `col_main_text` -> `--color-daw-text`
  - `col_tcp_text` -> `--color-daw-text`
  - `col_seltrack` -> `--color-daw-selection`
  - `col_cursor` -> `--color-daw-accent`
  - etc. (partial mapping, best effort)
- Apply as custom theme overrides
- **File**: `frontend/src/components/ThemeEditor.tsx` + new `reaperThemeParser.ts` utility

### 4.2 REAPER JSFX Compatibility
**Effort**: Already mostly done (audio), high for @gfx

The YSFX runtime IS REAPER's JSFX engine (same codebase by jpcima). Audio processing is 100% compatible. What's needed:
- Feature 2 above (@gfx rendering) — makes visual JSFX plugins work
- Ensure `@import` and library includes work (YSFX handles this via data_root)
- Test with ReaTeam JSFX repository scripts (largest JSFX collection)

### 4.3 ReaPack-style Script Distribution (Stretch)
**Effort**: Medium

ReaPack is REAPER's package manager for scripts/JSFX/themes. Full compatibility is unrealistic, but we can support the same repository format for JSFX/Lua scripts.

**Plan**:
- Parse ReaPack `.xml` repository index files
- Download and install JSFX scripts to user effects directory
- Download and install Lua scripts to user scripts directory
- Simple browser UI: search, categories, install/update/remove
- **NOT** full ReaPack compatibility (no extensions, no theme installation, no auto-update daemon)
- Focus on the two largest repos: ReaTeam JSFX and ReaTeam Scripts

### 4.4 CLAP Plugin Hosting (Complete)
**Effort**: Medium

CLAPPluginFormat already exists. Finish it:
- Complete `createPluginInstance()` implementation
- Parameter mapping (CLAP params -> JUCE AudioProcessorParameter)
- Editor window support (CLAP GUI API)
- State save/restore (CLAP state API)
- Test with popular CLAP plugins (Surge XT, Vital, Dexed CLAP builds)

### 4.5 LV2 Plugin Hosting (Enable)
**Effort**: Low

JUCE 8.0.0 has LV2 hosting support. Just needs:
- Add `JUCE_PLUGINHOST_LV2=1` to `target_compile_definitions` in CMakeLists.txt
- Verify scan paths in PluginManager
- Test with a few LV2 plugins
- Handle LV2-specific quirks (turtle files, presets)

### 4.6 Theme Export Format
**Effort**: Low

Allow users to export/import Studio13 themes as JSON files:
```json
{
  "name": "My Custom Theme",
  "author": "Username",
  "version": "1.0",
  "colors": {
    "daw-dark": "#121212",
    "daw-panel": "#1a1a1a",
    ...
  }
}
```
- Share via file or paste
- Could host a simple theme gallery on the website

---

## Feature 5: User Theme API (CSS Variables)

**Priority**: Low | **Effort**: Low | **Impact**: Low (already mostly done)

The theme system is already user-editable. Small additions:

### 5.1 Theme file import/export
- Export current theme as `.s13theme` JSON
- Import from file picker
- **File**: `frontend/src/components/ThemeEditor.tsx`

### 5.2 Additional CSS tokens
Expose more granular tokens for power users:
- `--color-daw-clip-audio` (audio clip background)
- `--color-daw-clip-midi` (MIDI clip background)
- `--color-daw-waveform` (waveform color)
- `--color-daw-grid-line` (timeline grid)
- `--color-daw-playhead` (playhead cursor)
- `--font-daw-primary` (main font family)
- `--font-daw-mono` (monospace font for values)

### 5.3 Live CSS injection for advanced users
- Allow pasting custom CSS in preferences (textarea)
- Applied as `<style>` tag in head
- For power users who want pixel-perfect control beyond color tokens

---

## Feature 6: C++ Extension API (Future / Low Priority)

**Priority**: Low | **Effort**: Very High | **Impact**: Low (niche audience)

This would allow C++ developers to write native extensions (like SWS for REAPER). NOT recommended for near-term roadmap.

### If implemented:
- Define stable C API (not C++) for extensions to call
- Extension DLLs loaded at startup from `Documents/Studio13/Extensions/`
- API surface: register actions, add menu items, access track/clip data, process audio
- Would need versioned ABI, documentation, example project
- Consider: is this worth it when Lua + JSFX already cover most use cases?

### Recommendation
Skip this for now. Invest in Lua + JSFX extensibility instead. Revisit when user demand exists.

---

## Implementation Priority Order

| Phase | Feature | Sessions Est. |
|-------|---------|---------------|
| **Phase 1** | 1. Playhead stop behavior setting | 0.5 |
| **Phase 2** | 2. JSFX @gfx rendering | 3 |
| **Phase 3** | 4.4 Complete CLAP hosting | 2 |
| **Phase 3** | 4.5 Enable LV2 hosting | 0.5 |
| **Phase 4** | 3. Lua scripting GUI API | 4 |
| **Phase 4** | 4.1 REAPER theme import | 1 |
| **Phase 5** | 4.3 ReaPack browser (stretch) | 3 |
| **Phase 5** | 4.6 Theme export/share | 0.5 |
| **Phase 5** | 5. Additional CSS tokens | 0.5 |
| **Future** | 6. C++ Extension API | 10+ |

Total estimated: ~15 sessions for Phase 1-5, with Phase 1-3 being the highest impact.

---

## Key Files Reference

| Component | Files |
|-----------|-------|
| YSFX/JSFX runtime | `Source/S13FXProcessor.{h,cpp}`, `build/_deps/ysfx-src/include/ysfx.h` |
| Lua scripting | `Source/ScriptEngine.{h,cpp}` |
| Plugin hosting | `Source/PluginManager.{h,cpp}`, `Source/CLAPPluginFormat.h` |
| Plugin windows | `Source/PluginWindowManager.{h,cpp}` |
| Theme system | `frontend/src/components/ThemeEditor.tsx`, `frontend/src/index.css` |
| Theme store | `frontend/src/store/useDAWStore.ts` (THEME_PRESETS ~line 9871) |
| Transport | `frontend/src/store/useDAWStore.ts` (stop/play actions) |
| Preferences | `frontend/src/components/PreferencesModal.tsx` |
| Native bridge | `frontend/src/services/NativeBridge.ts`, `Source/MainComponent.cpp` |

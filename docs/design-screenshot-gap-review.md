# Design Screenshot Gap Review

## Summary

This document compares the supplied design screenshots against the current OpenStudio frontend and records what is already implemented, what is partial, what is still missing, and what depends on backend support.

Scope notes:

- The screenshots are treated as the design source of truth.
- This review targets screenshot parity, not full PRO DAW parity beyond what is visibly represented.
- Status labels used in this document:
  - `Implemented`: the visible surface and primary behavior already exist.
  - `Partial`: some of the visible surface or behavior exists, but parity is incomplete.
  - `Missing`: the screenshot-visible surface is not exposed yet.
  - `Backend-dependent`: the frontend surface exists or is planned, but full behavior still depends on backend support.

## Current App Baseline

The main DAW shell is already present and wired in the current app:

- `ProjectTabBar`, `MenuBar`, timeline workspace, lower editor zones, mixer, and transport are mounted from `frontend/src/App.tsx`.
- The app already ships major dialogs and panels referenced by the screenshots, including:
  - `RenderModal`
  - `ProjectSettingsModal`
  - `RenderQueuePanel`
  - `UndoHistoryPanel`
  - `CommandPalette`
  - `DynamicSplitModal`
  - `RegionRenderMatrix`
  - `CleanProjectModal`
  - `BatchConverterModal`
  - `CrossfadeEditor`
  - `ClipPropertiesPanel`
  - `PianoRoll`
  - `VirtualPianoKeyboard`

Key validation already completed during this audit:

- `frontend` tests pass: `51/51`
- `frontend` production build succeeds

## Screenshot Audit

### `design.png`

Status: `Partial`

What matches today:

- Main DAW shell exists with a top menu bar, track control panel, timeline, mixer area, and bottom transport.
- Track headers already support record arm, mute, solo, FX, input selection, color, icon, and automation-oriented controls.
- Mixer and transport surfaces are implemented as app-level panels rather than placeholders.

What is still off:

- Top-level menu structure does not yet match the screenshot order.
- The screenshot shows `File`, `Edit`, `View`, `Insert`, `Item`, `Track`, `Options`, `Actions`, `Help`.
- The current app renders only `File`, `Edit`, `View`, `Insert`, `Options`, `Help`.
- The screenshot suggests a more PRO DAW-aligned discoverability flow for item and track operations than the current top menu exposes.

Relevant implementation:

- `frontend/src/App.tsx`
- `frontend/src/components/MenuBar.tsx`
- `frontend/src/components/TrackHeader.tsx`
- `frontend/src/components/SortableTrackHeader.tsx`
- `frontend/src/components/Timeline.tsx`
- `frontend/src/components/MixerPanel.tsx`
- `frontend/src/components/TransportBar.tsx`

### `Design screenshots/File-options.png`

Status: `Partial`

Already implemented:

- New project
- Open project
- Save project
- Save project as
- Close project
- Project settings
- Render
- Region Render Matrix
- Export project MIDI
- Clean project directory
- Batch file converter
- Quit
- Recent projects
- Template-related operations
- Safe mode project open

Differences from screenshot:

- `New project tab` and `Save all projects` are not surfaced in the File menu today, even though project tabs exist.
- `Queued Renders` is represented as a separate `Render Queue` panel, but not exposed with the same wording and placement as the screenshot.
- `Project Render Metadata` is not a complete File-menu workflow yet.
- `Save live output to disk (bounce)...` is represented as `Capture Output`, which is functionally related but not named or placed as screenshot parity.
- `Consolidate/Export tracks...` is not surfaced from the File menu as shown.

Relevant implementation:

- `frontend/src/components/MenuBar.tsx`
- `frontend/src/components/RenderQueuePanel.tsx`
- `frontend/src/store/actionRegistry.ts`

### `Design screenshots/Edit-options.png`

Status: `Partial`

Already implemented:

- Undo / redo
- Undo history
- Select all
- Cut / copy / paste
- Cut within time selection
- Copy within time selection
- Dynamic split

Implemented elsewhere but not surfaced like the screenshot:

- Crossfade editor exists
- Nudge operations exist
- Split operations exist
- Group / ungroup exist
- Reverse clip exists
- Quantize selected clips exists

Current parity gaps:

- The current `Edit` menu mixes general edit operations with clip/item-specific operations that should likely move into a top-level `Item` menu for screenshot parity.
- Several screenshot-visible operations exist in store actions or context menus but are not exposed with the same labels, grouping, or separators.
- `Transient Detection Settings` is not surfaced as a dedicated menu entry; transient detection currently lives inside `DynamicSplitModal`.

Relevant implementation:

- `frontend/src/components/menus/EditMenu.tsx`
- `frontend/src/components/DynamicSplitModal.tsx`
- `frontend/src/components/CrossfadeEditor.tsx`
- `frontend/src/store/actionRegistry.ts`
- `frontend/src/store/actions/clipEditing.ts`

### `Design screenshots/View-options.png`

Status: `Partial`

Already implemented:

- Mixer toggle
- Virtual MIDI keyboard
- Region/marker manager
- Clip properties
- Big clock
- Render queue
- Routing matrix
- Media explorer
- Audio settings
- Render
- Region Render Matrix
- Zoom controls
- Loop enable
- Snap enable
- Screensets

Partially matching:

- The View menu contains many screenshot-related destinations, but naming and ordering do not yet follow the screenshot.
- Some screenshot items are represented by OpenStudio-specific equivalents instead of direct label matches.

Still missing or not surfaced cleanly:

- `Track Manager`
- `Track Group Manager`
- `Project Media/FX Bay`
- `Navigator`
- `Scale Finder`
- `Show/hide all floating windows`
- `Cascade all floating windows`
- `Time unit for ruler`
- `Go to`
- `Always on top`
- `Fullscreen`

Relevant implementation:

- `frontend/src/components/MenuBar.tsx`
- `frontend/src/components/VirtualPianoKeyboard.tsx`
- `frontend/src/components/RegionMarkerManager.tsx`
- `frontend/src/components/ClipPropertiesPanel.tsx`
- `frontend/src/components/BigClock.tsx`
- `frontend/src/components/RenderQueuePanel.tsx`
- `frontend/src/components/RoutingMatrix.tsx`
- `frontend/src/components/MediaExplorer.tsx`

### `Design screenshots/Insert-options.png`

Status: `Partial`

Already implemented:

- Media file import
- New MIDI item equivalent via empty MIDI clip
- Empty item
- Marker
- Marker with prompt for name
- Region from selection
- Track insertion
- Multiple tracks
- Virtual instrument on new track

Partial or different from screenshot:

- The current Insert menu includes more OpenStudio-specific track creation choices like bus/group tracks and spacer tracks.
- Screenshot entries like SMPTE timecode generator and click source are not surfaced.
- `Track from template` exists conceptually through templates, but top-level parity is incomplete.

Relevant implementation:

- `frontend/src/components/MenuBar.tsx`
- `frontend/src/store/actionRegistry.ts`

### `Design screenshots/Item-options.png`

Status: `Missing` as a top-level menu, `Partial` as underlying behavior

Already implemented in behavior:

- Select all
- Nudge/set items equivalent via nudge actions
- Split items at cursor
- Split items at time selection
- Item properties equivalent through clip properties
- Group / ungroup selected clips
- Reverse clip
- Item-level editing functions in timeline context menus and store actions

Still missing for screenshot parity:

- No top-level `Item` menu is rendered today.
- Existing item-related behavior is split across:
  - `Edit` menu
  - clip context menus
  - timeline interactions
  - clip properties panel
- Screenshot-level grouping such as `Take`, `Comps`, `Stretch markers`, `Spectral edits`, and `Media` is not exposed as a dedicated top menu structure.

Relevant implementation:

- `frontend/src/components/menus/EditMenu.tsx`
- `frontend/src/components/ClipPropertiesPanel.tsx`
- `frontend/src/components/Timeline.tsx`
- `frontend/src/store/actionRegistry.ts`
- `frontend/src/store/actions/clipEditing.ts`

### `Design screenshots/Track-options.png`

Status: `Missing` as a top-level menu, `Partial` as underlying behavior

Already implemented in behavior:

- Insert new track
- Insert multiple tracks
- Insert virtual instrument track
- Save/load track templates
- Remove tracks
- Duplicate tracks
- Move tracks to folder
- Freeze / unfreeze
- Track color
- Track icon
- Free item positioning
- Track automation-related operations
- Routing-related operations

Current mismatch:

- No top-level `Track` menu is rendered today.
- A large portion of screenshot-relevant behavior lives in track context menus instead of the main menu bar.
- Track-level commands are discoverable only after right-clicking track headers, which is not screenshot parity.

Still missing or not clearly surfaced:

- Dedicated `Meters` submenu parity
- `Track timebase`
- `Track performance options`
- `Track layout`
- `Track grouping` as top-level menu content
- `MIDI track controls` and `Lock track controls` as explicit grouped menu content

Relevant implementation:

- `frontend/src/components/SortableTrackHeader.tsx`
- `frontend/src/components/TrackHeader.tsx`
- `frontend/src/store/useDAWStore.ts`
- `frontend/src/store/actions/tracks.ts`

### `Design screenshots/Options-options.png`

Status: `Partial`

Already implemented:

- Record mode selection
- Ripple editing mode selection
- Auto-crossfade
- Locking
- Theme settings
- Preferences
- Timecode / sync settings

Partially matching:

- Screenshot-specific option naming does not line up perfectly with the current menu structure.
- Some screenshot entries are represented by broader or differently grouped OpenStudio settings.

Still missing or not surfaced:

- Many PRO DAW-specific editing preference toggles shown in the screenshot are not directly exposed.
- `Metronome/pre-roll settings...` is not surfaced in the Options menu as shown.
- Several transport-display and playback-scroll options are not top-menu surfaced in the same way.

Relevant implementation:

- `frontend/src/components/MenuBar.tsx`
- `frontend/src/components/PreferencesModal.tsx`
- `frontend/src/components/TimecodeSettingsPanel.tsx`

### `Design screenshots/Actions-options.png`

Status: `Missing` as a top-level menu, `Partial` in underlying system

Already implemented:

- A central action registry exists.
- Command palette exists.
- Recent actions behavior exists in the command palette.
- Shortcut metadata and action categories are already centralized.

Still missing for screenshot parity:

- No top-level `Actions` menu is rendered today.
- No menu-level recent action list matching the screenshot is exposed.
- No direct `Show action list...` top-menu destination exists yet, even though the action registry is already suitable for it.

Relevant implementation:

- `frontend/src/store/actionRegistry.ts`
- `frontend/src/components/CommandPalette.tsx`
- `frontend/src/components/MenuBar.tsx`

### `Design screenshots/Help-options.png`

Status: `Partial`

Already implemented:

- Getting started guide
- Help reference
- Keyboard shortcuts
- Check for updates
- Command palette
- About dialog

Still missing or not aligned:

- Screenshot-specific entries such as documentation submenu, project timebase help, action list as HTML, and legal/purchasing/changelog links are not exposed.
- The Help menu is more product-focused than screenshot-parity focused right now.

Relevant implementation:

- `frontend/src/components/MenuBar.tsx`
- `frontend/src/components/HelpOverlay.tsx`
- `frontend/src/components/KeyboardShortcutsModal.tsx`
- `frontend/src/components/GettingStartedGuide.tsx`

### `Design screenshots/render-export.png`

Status: `Partial`

Already implemented:

- Render dialog exists and is functional.
- Source selection
- Bounds selection
- Time bounds section
- Output directory
- File naming
- Format selection
- Sample rate
- Channels
- Bit depth where applicable
- MP3 bitrate
- OGG quality
- Normalize
- Dither
- Add to queue
- Multi-file render count logic
- Region-based render support
- Stem render support
- Secondary output support
- Add-to-project-after-render flow

Known current gaps:

- Metadata section is present but explicitly marked `coming soon`.
- Resample quality is shown but explicitly marked `Backend support pending`.
- Online render is shown but explicitly marked `unsupported`.
- Screenshot-style preset handling is not fully matched.
- Screenshot-specific fine-grained embed / preserve / dithering / second-pass combinations are not fully mirrored yet.

Status classification details:

- `Metadata`: `Backend-dependent`
- `Resample quality`: `Backend-dependent`
- `Online render`: `Backend-dependent`
- Overall dialog: `Partial`

Relevant implementation:

- `frontend/src/components/RenderModal.tsx`
- `frontend/src/components/RenderQueuePanel.tsx`
- `frontend/src/services/NativeBridge.ts`
- `Source/AudioEngine.cpp`
- `Source/MainComponent.cpp`

### `Design screenshots/midi track and clip.png`

Status: `Partial`

Already implemented:

- MIDI track support
- Piano roll editor
- Virtual MIDI keyboard
- Instrument tracks
- MIDI device routing

What still differs:

- The screenshot is focused on arrange-view MIDI clip visibility inside the main timeline.
- The current app has the necessary MIDI infrastructure, but screenshot-level visual parity for the exact arrange-view presentation needs a dedicated audit pass against timeline rendering and track header MIDI affordances.

Relevant implementation:

- `frontend/src/components/PianoRoll.tsx`
- `frontend/src/components/VirtualPianoKeyboard.tsx`
- `frontend/src/components/Timeline.tsx`
- `frontend/src/components/TrackHeader.tsx`

## Consolidated Status

### Already Implemented

- Main DAW shell
- Project tabs
- Menu bar framework
- File menu core actions
- Edit menu core actions
- View menu major panels and toggles
- Insert menu core track and marker actions
- Track header controls
- Timeline
- Mixer
- Transport
- Render queue
- Project settings dialog
- Region render matrix dialog
- Dynamic split dialog
- Clean project directory dialog
- Batch file converter dialog
- Crossfade editor dialog
- Undo history panel
- Command palette
- Clip properties panel
- Piano roll
- Virtual MIDI keyboard

### Partial

- Overall screenshot shell parity
- File menu parity
- Edit menu parity
- View menu parity
- Insert menu parity
- Options menu parity
- Help menu parity
- Render/export parity
- MIDI arrange-view parity
- Track header visual parity

### Missing

- Top-level `Item` menu
- Top-level `Track` menu
- Top-level `Actions` menu
- Screenshot-matching menu grouping for many existing item and track actions
- Screenshot-level help/documentation menu structure

### Backend-dependent

- Render metadata
- Full resample quality support
- Online render mode
- Any additional screenshot-visible render options that require new bridge parameters

## Remaining Work TODO

### 1. Create the dedicated deliverable

- [x] Create `docs/design-screenshot-gap-review.md` as the dedicated audit and remaining-work plan.
- [x] Compare each supplied screenshot against the current app shell, menus, dialogs, and track/timeline UI.
- [x] Mark each screenshot-visible feature as `implemented`, `partial`, `missing`, or `backend-dependent`.
- [x] Keep the scope focused on screenshot parity rather than full PRO DAW parity.

### 2. Finish menu-bar parity

- [ ] Add top-level `Item` menu to the menu bar.
- [ ] Add top-level `Track` menu to the menu bar.
- [ ] Add top-level `Actions` menu to the menu bar.
- [ ] Keep menu order aligned to the screenshots:
  - `File`
  - `Edit`
  - `View`
  - `Insert`
  - `Item`
  - `Track`
  - `Options`
  - `Actions`
  - `Help`
- [ ] Normalize labels, separators, and submenu grouping to match the screenshots more closely.
- [ ] Normalize shortcut display where the action registry already defines the binding.
- [ ] Use disabled entries only when screenshot visibility matters and the feature is not yet implemented.

### 3. Refactor menu definitions

- [ ] Refactor menu definitions so menu items come from shared builders instead of duplicated inline logic in `MenuBar.tsx`.
- [ ] Reuse existing store actions and action-registry definitions where possible.
- [ ] Avoid duplicating behavior between:
  - `EditMenu`
  - track context menus
  - action registry
  - top-level menu definitions
- [ ] Centralize label, enablement, checked state, and shortcut resolution.

### 4. Promote already-implemented item behavior into a real `Item` menu

- [ ] Move clip/item-oriented commands out of the overloaded `Edit` menu where needed.
- [ ] Include currently implemented actions such as:
  - split at cursor
  - split at time selection
  - nudge operations
  - group / ungroup
  - reverse clip
  - dynamic split
  - crossfade editor entry point
  - clip/item properties
- [ ] Add placeholder or disabled sections only where screenshot-level grouping is needed but behavior is not yet present.

### 5. Promote track behavior into a real `Track` menu

- [ ] Surface track operations that already exist in track context menus and store actions.
- [ ] Include currently implemented actions such as:
  - insert new track
  - insert multiple tracks
  - virtual instrument track
  - delete track(s)
  - duplicate track
  - move to folder
  - save/load track template
  - freeze / unfreeze
  - track color
  - track icon
  - free item positioning
  - routing-related entry points
  - automation-related entry points
- [ ] Add screenshot-driven structure for track grouping and track controls without removing OpenStudio-specific affordances.

### 6. Build the `Actions` menu from the existing action system

- [ ] Back the `Actions` menu with `frontend/src/store/actionRegistry.ts`.
- [ ] Add a top-level entry equivalent to `Show action list...`.
- [ ] Surface recent actions using the same recent-action source already used by `CommandPalette`.
- [ ] Keep action labels and shortcuts synchronized with the registry rather than copying strings into the menu.

### 7. Tighten File / View / Insert / Options / Help parity

- [ ] Add missing File-menu screenshot entries where a reasonable OpenStudio equivalent already exists.
- [ ] Align `Render Queue` / `Queued Renders` naming and placement decisions.
- [ ] Decide whether `Capture Output` should be renamed or regrouped to match screenshot expectations better.
- [ ] Expand View menu coverage for screenshot-visible managers and utility windows.
- [ ] Expand Insert menu coverage for screenshot-visible non-track insert tools where appropriate.
- [ ] Expose metronome/pre-roll and related transport options if they are needed for screenshot parity.
- [ ] Expand Help menu structure to cover screenshot-visible documentation and reference entry points.

### 8. Expand render/export parity carefully

- [ ] Keep the current working render modal intact as the base.
- [ ] Finish screenshot-visible preset handling if required for parity.
- [ ] Implement render metadata behavior or keep it clearly marked as backend-dependent.
- [ ] Implement resample quality behavior or keep it clearly marked as backend-dependent.
- [ ] Implement online render mode or keep it clearly marked as backend-dependent.
- [ ] Review screenshot-visible checkbox groups and labels for naming and placement parity.
- [ ] Preserve backward compatibility for existing bridge calls while extending render options.

### 9. Document backend dependencies separately

- [ ] Track backend-required parity items in their own section, separate from frontend-only tasks.
- [ ] Include bridge/API implications for each backend-dependent item.
- [ ] Keep the frontend plan executable even if backend tasks are staged later.

## Test Plan TODO

- [ ] Add tests that assert full top-level menu order and presence.
- [ ] Add tests for representative `Item` menu commands.
- [ ] Add tests for representative `Track` menu commands.
- [ ] Add tests for representative `Actions` menu commands.
- [ ] Add render-modal tests for visible supported vs unsupported states.
- [ ] Add tests for any shared menu-builder logic introduced during refactor.
- [ ] Run `npm test` in `frontend`.
- [ ] Run `npm run build` in `frontend`.
- [ ] Perform manual screenshot-by-screenshot parity verification after implementation.

## Assumptions

- [x] Treat the supplied screenshots as the design source of truth.
- [x] Target design plus visible behavior parity, not visual-only parity.
- [x] Use the current React, Zustand, and modal architecture; do not replace it with native menus.
- [x] Preserve backward compatibility for existing store actions and bridge calls where possible.
- [x] Preserve existing OpenStudio-specific features unless they directly conflict with screenshot parity.

## Priority Order

Recommended implementation order:

1. Add `Item`, `Track`, and `Actions` top-level menus.
2. Refactor menu definitions into shared builders.
3. Promote existing item and track operations into screenshot-aligned menu structures.
4. Normalize File / View / Insert / Options / Help labels and grouping.
5. Expand render/export parity.
6. Add menu and render tests.
7. Perform final manual screenshot parity pass.

# Frontend Component Map

A guide to `frontend/src/components/`: what each component does, where it is
mounted, what it depends on, and how portable it is if you want to lift it
onto a marketing website and animate it.

Paths below are relative to `frontend/src/` unless stated otherwise.

Reviewed on 2026-09-15 against [PR #16 at `4ae6162`](https://github.com/sdevil7th/OpenStudio/pull/16)
and [`main` at `d205615`](https://github.com/sdevil7th/OpenStudio/commit/d2056151222fefcede123ef614ec38c6893cbfd5).
Their frontend sources are identical. Sections 1–7 describe that PR/main snapshot.
Section 8 records newer committed work on `fix-nam-rack`, which has not been
merged into this PR's base. Follow the linked source files when updating the map,
since component ownership and dependencies can change.

---

## 1. How the app is assembled

`main.tsx` picks a root component from the native window role, then mounts it
inside `ErrorBoundary`:

| Window role (`utils/windowEnvironment`) | Root component            | What it hosts                               |
| --------------------------------------- | ------------------------- | ------------------------------------------- |
| main (default)                          | `App.tsx`                 | Full DAW shell                              |
| `mixer`                                 | `MixerWindowApp.tsx`      | `MixerPanel` in a detached window           |
| `midiEditor`                            | `MidiEditorWindowApp.tsx` | `PianoRoll` in a detached window            |
| `pluginEditor`                          | `PluginEditorWindowApp.tsx` | `BuiltInPluginPanel` (NAM Rack etc.) detached |
| safe startup (overrides any window role) | `components/StartupRecoveryApp.tsx` | Recovery UI                        |

`App.tsx` layout, top to bottom:

```
ProjectTabBar
MenuBar (when the window uses custom chrome)
MainToolbar  (+ CustomToolbarStrip from ToolbarEditor)
workspace
  ├─ TCP sidebar:  SortableTrackHeader × N  → TrackHeader / AITrackHeader
  │                MasterTrackHeader
  └─ TimelineRuler + Timeline (react-konva canvases, Playhead, HorizontalScrollbar)
PitchEditorLowerZone / docked PianoRoll (conditional editor sections)
TransportBar (imported as BottomTransportBar)
VirtualPianoKeyboard / other conditional panels / MixerPanel
Modals and overlays (mostly lazy-loaded, see §4)
```

`App.tsx` owns the editor sections directly; there is no `LowerZone` component
in this source tree. `ClipPropertiesPanel` is a separately mounted panel.
See [bootstrap](../frontend/src/main.tsx) and [shell](../frontend/src/App.tsx).

Two import styles matter when you search for "where is X used":

- **Static imports** in `App.tsx`: `Timeline`, `TimelineRuler`, `MixerPanel`,
  `MainToolbar`, `TransportBar`, `MenuBar`, `MasterTrackHeader`,
  `ProjectTabBar`, `ToolbarEditor`, `PluginBrowser`, `SortableTrackHeader`,
  `AddMultipleTracksModal`, `ContextMenu`, `EssentialControlsCard`,
  `InputProfileOnboardingCard`, `UnsavedChangesDialog`, `ui/Button`.
- **Lazy imports** in `App.tsx` (`React.lazy(() => import(...))`):
  most modals and secondary panels; the static exceptions are listed above.
  A plain grep for `from "./components/X"`
  will miss these.

---

## 2. Global styling contract

- Tailwind v4. Theme tokens live in `index.css` under `@theme`:
  `--color-daw-dark #121212`, `--color-daw-panel #1a1a1a`,
  `--color-daw-lighter #252525`, `--color-daw-accent #0078d4`,
  `--color-daw-record #e53935`, `--color-daw-mute #43a047`,
  `--color-daw-solo #fdd835`, `--color-daw-fx #7cb342`,
  `--color-daw-border #2a2a2a`, meter greens/yellows/reds.
- Font stack: `'Segoe UI', Inter, system-ui, sans-serif`, dark colour scheme.
- Global keyframes in `index.css`: `recording-pulse` (used by `.recording-dot`)
  and `openstudio-startup-spin`.
- `.vertical-fader` in `index.css` styles the native range input used by the
  `Slider` fader variant.
- Component-owned stylesheets sit beside the component and are imported by it
  (`NAMRack*.css`, `FXChainPanel.css`, `PianoRoll.css`, `NAMCompactChain.css`).
  `FXChainPanel.css` also holds the **base** NAM Rack control
  rules (`.nam-rack-control`, `.nam-rack-knob-cap`), so NAM knobs need it even
  outside the FX chain.
- Icons: `lucide-react` everywhere, plus the hand-drawn SVGs in `icons.tsx`.

---

## 3. Portability tiers for website use

These tiers describe extraction effort, not a published standalone component
package. Copy transitive local dependencies and the packages they import from
[package.json](../frontend/package.json), including React/React DOM,
`classnames` and `lucide-react` where used. Import primitives from their own
folders: copying the whole `ui/index.ts` barrel also resolves its DAW-coupled
exports, including `Modal` and the wheel-enabled controls.

**Tier A: props-driven, without DAW runtime dependencies.** Copy the files,
their local helpers, CSS and assets, and the required Tailwind tokens.

| Component | File(s) | Notes |
| --- | --- | --- |
| Track icons | `icons.tsx` | Pure SVG, `currentColor`. Exports `MetronomeIcon`, `PianoIcon`, `MicrophoneIcon`, `GuitarIcon`, `BassGuitarIcon`, `DrumsIcon`, `KeysIcon`, `BusIcon`, `MasterIcon`, `MIDIIcon`, `FolderIcon`, `AIIcon`, plus `TRACK_ICONS` map. |
| Peak meter | `PeakMeter.tsx`, `meterConfig.ts` | Canvas + RAF loop. See §5.3. |
| Master meter cluster | `MasterPeakMeterCluster.tsx` | Wraps `PeakMeter` with a dBFS ruler overlay. |
| Button / Input / Checkbox / Textarea / Select / NativeSelect / TimeSignatureInput | Individual `ui/` folders, including their type/style maps | `Select` renders a native select; it does not use Headless UI. |
| Rack chain tile | `NAMRackChainModule.tsx` + `.css` | Props-only module tile with drag handles, power button, favourite star. |
| Compact signal chain | `NAMCompactChain.tsx` + `.css` | Props-only overlay; has `nam-compact-chain-rise` keyframe. Needs `NAMSignalChainTypes.ts` (types only). |
| Control tooltip | `NAMRackControlTooltip.tsx` + `.css` | Anchored portal tooltip. Its CSS references `nam-rack-tooltip-in`, defined in `NAMRackPanel.css`; copy that keyframe too if retaining the entrance animation. |
| Detachable panel | `DetachablePanel.tsx` | Floating/dock wrapper. |
| Horizontal scrollbar | `HorizontalScrollbar.tsx` | Overview scrollbar. Extract the `ScrollbarOverview`/`ScrollbarOverviewBin` interfaces for a standalone copy; the full `utils/scrollbarOverview` module also has type imports from the DAW store and bridge. |

**Tier B: adapt the parameter-wheel profile lookup.** These import
`utils/parameterWheel.ts`, which imports `useDAWStore` to read the mouse profile.
Replace only that lookup as shown in §6, preserving the gesture/value helpers.
Alternatively remove wheel handling and its imports from the copied components.

| Component | File(s) | Notes |
| --- | --- | --- |
| SVG knob | `ui/Knob/*` | See §5.1. Also needs `utils/wheelDeltaAccumulator.ts` and `ui/editTransactionLifecycle.ts` (both independent of DAW state). |
| Slider / fader | `ui/Slider/*`, `ui/ProfiledRangeInput/*` | Native range input; also needs the wheel accumulator, gesture types and edit lifecycle helper. Fader variant needs `.vertical-fader` CSS from `index.css`. |
| Sprite-atlas knob | `NAMRackKnob.tsx` + `.css`, `NAMRackControlAssets.ts`, `NAMRackControlTooltip.tsx` + `.css` | See §5.2. Also needs `utils/builtInParamValue.ts` and the `BuiltInParamDescriptor` type (including the type-only import in that helper). |
| Advanced NAM inspector | `NAMRackMixer.tsx` + `.css` (`NAMRackMixerView`) | Props-driven host of `RackKnob`; carries the knob's dependencies and uses `BuiltInParamDescriptor` types. Preserve/extract the NAM host-scoped CSS when porting it. |
| Parametric graphs | `ParametricGraph/*` | SVG EQ / compressor / gate / delay / reverb / saturation / chorus curves. See §5.4. |

**Tier C: requires a broader adaptation.** These have direct or transitive
dependencies on stores, actions, native services, or DAW-specific hosts.
Prefer extracting presentation and supplying local state and callbacks.

`ui/Modal`, `ContextMenu`, and `menus/MenuDropdown` belong here despite having
props-driven interfaces. Their `utils/modalShortcutScope` dependency imports
`store/actionRegistry` and `utils/globalShortcutDispatcher`, which reach DAW
state. A website port needs its own close/focus/keyboard handling in place of
that shortcut integration. `Modal` also requires `@headlessui/react`.
See [modal shortcut scope](../frontend/src/utils/modalShortcutScope.ts).

Everything else in the directory, notably `TransportBar`, `ChannelStrip`,
`MixerPanel`, `TrackHeader`, `MasterTrackHeader`, `VirtualPianoKeyboard`,
`BigClock`, `Timeline`, `TimelineRuler`, `Playhead`, `PianoRoll*`,
`PitchEditorLowerZone`, `NAMRackPanel`, `NAMRackDesignPort`, `NAMExplorer`,
`FXChainPanel`, `BuiltInPluginPanel`, and all modals.

---

## 4. Catalog by area

Each row: component → where it is mounted → dependencies worth knowing.
Dependencies are highlights, not complete import lists; `store` means the main
DAW store unless the pitch store is named. The component families below cover
the top-level TSX components and group the MIDI editor's smaller sections.

### 4.1 Shell and navigation

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `MenuBar` | `App` | store, `menus/MenuDropdown`, `menus/EditMenu` |
| `menus/EditMenu` | `MenuBar` | main and pitch stores, action registry, shortcut context, `MenuDropdown` |
| `ProjectTabBar` | `App` | store, `ContextMenu` |
| `MainToolbar` | `App` | store, `ui` |
| `ToolbarEditor` (`ToolbarEditor`, `CustomToolbarStrip`) | `App` | store, `ui` |
| `TransportBar` | `App` (as `BottomTransportBar`) | store, `MetronomeSettings`, `icons.MetronomeIcon`, `ui/Button`, `ui/Input`, `ui/TimeSignatureInput` |
| `MetronomeSettings` | `TransportBar` | store, `ui` |
| `BigClock` | `App` (lazy) | store, `ui/Button` |
| `CommandPalette` | `App` (lazy) | store, `actionRegistry` |
| `KeyboardShortcutsModal` | `App` (lazy) | store, `CustomKeyboardProfileManager`, `InputProfileSelectors`, `KeyboardShortcutsPrint.css` |
| `EssentialControlsCard`, `InputProfileOnboardingCard` | `App` | store, input-profile helpers; onboarding also mounts `InputProfileSelectors` |
| `HelpOverlay`, `GettingStartedGuide` | `App` (lazy) | store, input-profile and shortcut helpers; `HelpOverlay` also uses `utils/helpTexts` |
| `ErrorBoundary` | `main.tsx` | bridge (stops native runtime after a frontend failure), window environment |
| `StartupRecoveryApp` | `main.tsx` (safe startup) | window environment, direct JUCE event-based diagnostic calls |

### 4.2 Tracks and arrangement

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `SortableTrackHeader` | `App` (one per track) | `@dnd-kit`, `TrackHeader`, `AITrackHeader`, `ColorPicker`, `ContextMenu` |
| `TrackHeader` | `SortableTrackHeader` | store, `FXChainPanel`, `MIDIDeviceSelector`, `TrackNameEditor`, `ColorPicker`, `PluginBrowser`, `icons`, `ui` |
| `AITrackHeader` | `SortableTrackHeader` | store, `AIWorkflowModal`, `FXChainPanel`, `TrackNameEditor`, `ColorPicker`, `tcpHeaderButtonStyles` |
| `MasterTrackHeader` | `App` | store, `FXChainPanel`, `tcpHeaderButtonStyles` |
| `TrackNameEditor` | `TrackHeader`, `AITrackHeader` | store |
| `ColorPicker` (`TRACK_COLORS`) | track headers | store (recent colours) |
| `MIDIDeviceSelector` | `TrackHeader` | store, bridge |
| `Timeline` | `App` | react-konva, store, `Playhead`, `HorizontalScrollbar`, `ContextMenu` |
| `TimelineRuler` (`TIMELINE_RULER_HEIGHT = 30`) | `App` | react-konva, store, `Playhead` |
| `Playhead` / `MemoizedPlayhead` | `Timeline`, `TimelineRuler` | react-konva, imperative store subscription; updates Konva refs when `transport.currentTime` or `scrollX` changes |
| `HorizontalScrollbar` | `Timeline` | `ScrollbarOverview` type; no DAW runtime dependency |
| `ClipLauncherView` | `App` (lazy) | store |
| `ClipPropertiesPanel` | `App` (lazy) | store |
| `CrossfadeEditor` | `App` (lazy) | store |
| `RegionMarkerManager`, `RegionRenderMatrix` | `App` (lazy) | store |
| `AddMultipleTracksModal` | `App` | props/callbacks, track-creation helpers, shared `Modal` (shortcut coupling) |

### 4.3 Mixer and metering

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `MixerPanel` | `App`, `MixerWindowApp` | store, `SortableTrack`, `DetachablePanel`, `ui` |
| `SortableTrack` | `MixerPanel` | `@dnd-kit`, `ChannelStrip` |
| `ChannelStrip` | `MixerPanel`, `SortableTrack` | store, bridge, `PeakMeter`, `MasterPeakMeterCluster`, `FXChainPanel`, `ui/Slider` (`variant="fader"` and `"pan"`), `ui/Button`, `ContextMenu` |
| `PeakMeter` | `ChannelStrip`, `MasterPeakMeterCluster` | `meterConfig` only |
| `MasterPeakMeterCluster` | `ChannelStrip` (master) | `PeakMeter`, `meterConfig` |
| `ChannelStripEQModal` | `App` (lazy) | store, `ui` |
| `TrackRoutingModal`, `RoutingMatrix` | `App` (lazy) | store, bridge |
| `DetachablePanel` | `MixerPanel` | none |

### 4.4 FX chain and plugins

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `FXChainPanel` (+ `FXChainPanel.css`) | `TrackHeader`, `MasterTrackHeader`, `ChannelStrip`, `AITrackHeader` | store, bridge, `BuiltInPluginPanel`, `MIDIFXControls`, `PitchCorrectorPanel`, `ParametricGraph` |
| `BuiltInPluginPanel` | `FXChainPanel`, `PluginEditorWindowApp` | bridge, `NAMRackPanel`, `ParametricGraph` |
| `PluginBrowser` | `App`, `TrackHeader` | store, action registry, bridge (plugin catalogue) |
| `MIDIFXControls` | `FXChainPanel` | store |
| `PitchCorrectorPanel` (+ `pitchCorrectorPresets.ts`) | `FXChainPanel` | bridge, local React state, shared UI |
| `ParametricGraph/*` | `FXChainPanel`, `BuiltInPluginPanel` | `utils/parameterWheel` (wheel only) |

### 4.5 NAM Rack (guitar/bass amp workspace)

Product doc: [NAM Rack](nam-rack.md). Conditional rendering relationships
(these views are not all visible at once):

```
BuiltInPluginPanel
└─ NAMRackPanel  (.nam-product.nam-neural-product[data-view][data-rack-section])
   ├─ NAMRackDesignPort   photoreal artboard: pedals, amp head, cab, EQ rack
   │    ├─ Module → <img.module-skin> body art + AssetControl children
   │    ├─ NAMToneCapturePicker
   │    └─ NAMRackControlTooltip
   ├─ NAMRackMixerView (from NAMRackMixer.tsx; advanced inspector) → RackKnob
   ├─ NAMExplorer         TONE3000 / library browser (card art assets)
   ├─ NAMCompactChain     signal-flow overlay
   ├─ NAMRackChainModule  (RackModule) chain tiles
   ├─ NAMRackDiagnostics
   ├─ NAMPresetManagerModal
   └─ NAMToneSaveModal (from NAMToneSave.tsx)
```

Supporting modules: `NAMDesignAssets.ts` (body and control artwork registry
with intrinsic pixel sizes), `NAMRackControlAssets.ts` (knob sprite atlases),
`namRackFaceplateGeometry.ts` (intrinsic-pixel control placement contract),
`NAMCabPresentation.ts`, `NAMSignalChainTypes.ts`.

Stylesheet import ownership:

- `NAMRackPanel.tsx`: `NAMRackPanel.css`, `NAMRackBrowser.css`,
  `NAMRackPresets.css`, `NAMRackPedalboard.css`, `NAMRackSourceFlow.css`,
  `NAMRackNeural.css`, `NAMRackCalibration.css`.
- `NAMRackDesignPort.tsx`: `NAMRackDesignPort.css`, `NAMRackStage.css`,
  `NAMRackHardware.css` (artwork/control primitives),
  `NAMRackDesignPortSourceFlow.css`, `NAMRackFooter.css`, `NAMRackHeader.css`.
- Children import their own namesake sheets: `NAMRackMixer`, `NAMRackKnob`,
  `NAMRackChainModule`, `NAMCompactChain`, `NAMRackControlTooltip`,
  `NAMRackDiagnostics`, `NAMToneCapturePicker`, and `NAMPresetManagerModal`.
  Some shared base rules/keyframes still live in `FXChainPanel.css` or
  `NAMRackPanel.css`; see §2 and §5.2.

### 4.6 MIDI and piano roll

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `PianoRoll` (+ `PianoRoll.css`) | `App` (lazy), `MidiEditorWindowApp` | react-konva, store, and the `PianoRoll*Section` / `PianoRollToolbar` / `PianoRollStatusStrip` / `PianoRollInfoLine` / `PianoRollInspectorSummary` sub-components |
| `VirtualPianoKeyboard` | `App` (lazy) | store, bridge (`sendMidiNote`), `ui/Button`. Two octaves C3–B4 in Tailwind divs. |

The `PianoRoll*` family includes `PianoRollToolbar`, `PianoRollStatusStrip`,
`PianoRollInfoLine`, `PianoRollInspectorSummary`, `PianoRollControllerLaneSection`,
`PianoRollLaneEditorSection`, `PianoRollNoteInspectorSection`, and
`PianoRollPitchBendSection`. The pitch editor's `NoteInspector` is separate.

### 4.7 Pitch editor

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `PitchEditorLowerZone` | `App` (lazy) | main and pitch stores, action/shortcut helpers, `PitchEditorCanvas`, `NoteInspector`, `CorrectPitchModal`; native apply/analysis is routed through the pitch store |
| `PitchEditorCanvas.ts` | `PitchEditorLowerZone` | Imperative 2D canvas renderer (RAF loop) for note blobs and contour |
| `NoteInspector` | `PitchEditorLowerZone` | pitch store, bridge |
| `CorrectPitchModal` | `PitchEditorLowerZone` | pitch store, shared `Modal` |

### 4.8 Project, settings, and export panels and modals

These are lazy-loaded by `App` except the explicitly marked static dialog:

`SettingsModal`, `ProjectSettingsModal`, `PreferencesModal`, `RenderModal`,
`RenderQueuePanel`, `DDPExportModal`, `BatchConverterModal`,
`CleanProjectModal`, `ProjectCompareModal`, `MissingMediaResolver`,
`UndoHistoryPanel`, `EnvelopeManagerModal`, `DynamicSplitModal`,
`TimecodeSettingsPanel`, `ThemeEditor`, `MediaExplorer`, `ScriptEditor`,
`VideoWindow`, `StemSeparationModal`, `AIClipGenerationModal`,
`AiToolsSetupModal`, `UnsavedChangesDialog` (static).

`AIWorkflowModal` is opened from `AITrackHeader`; `AIWorkflowParamField`
serves both AI modals. `CustomKeyboardProfileManager` and
`InputProfileSelectors` live inside `KeyboardShortcutsModal`.

### 4.9 Shared UI primitives (`ui/index.ts`)

`Button`, `Input`, `Select`, `Checkbox`, `Textarea`, `Slider`,
`ProfiledRangeInput`, `TimeSignatureInput`, `NativeSelect`, `Knob`,
`Modal` (+ `ModalHeader`, `ModalContent`, `ModalFooter`). Almost every
component imports from `./ui`. `ui/editTransactionLifecycle.ts` is the shared
begin/commit helper for undoable continuous edits.

---

## 5. Animatable pieces in detail

### 5.1 `ui/Knob` (SVG knob)

Source: [Knob](../frontend/src/components/ui/Knob/Knob.tsx).

- Sizes: `sm` 24 px, `md` 30 px (`knobSizeMap`).
- Geometry: 270° sweep from 225° (7:30) to 495° (4:30), gap at 6 o'clock.
  `valueToAngle()` maps value → angle; `describeArc()` builds the SVG path.
- Layers: outer ring circle, dark track arc, fill arc (`FILL_COLORS`: default
  `#0078d4`, volume `#4caf50`, pan `#16a34a`), tick marks, cap circle, and
  an indicator line that turns white while dragging.
- `bipolarCenter` makes the fill originate from the centre (pan knobs).
- Interaction: vertical drag (`sensitivity` px for full range), wheel, and
  Ctrl/Meta+click or double-click reset to `defaultValue`.
  `onBeginEdit` / `onCommitEdit` wrap a
  gesture for undo.
- **To animate on a site:** drive the numeric `value` prop from React state
  updated by an animation loop or a tween's update subscription, and let the
  component recompute the arc. Nothing inside uses CSS transitions, so the
  arc will follow the value frame by frame.

### 5.2 `NAMRackKnob` (photographed knob, sprite atlas)

Sources: [RackKnob](../frontend/src/components/NAMRackKnob.tsx),
[atlas helpers](../frontend/src/components/NAMRackControlAssets.ts),
[raster CSS](../frontend/src/components/NAMRackKnob.css).

`RackKnob` renders one of three controls from a `BuiltInParamDescriptor`:

- `type: "enum"` → `<label.nam-rack-control-select>` with a native select.
- `type: "toggle"` → `<button.nam-rack-control-switch data-active>` with a
  `Power` icon.
- otherwise → `<label.nam-rack-control-knob data-size="default|large">`
  containing `RasterKnobCap`, a label, a value readout, and a hidden
  `<input type="range">` for keyboard access.

`RasterKnobCap` picks a frame from a sprite atlas:

| Atlas (`assets/nam/controls/`) | Canvas | Grid | Frame | Frames |
| --- | --- | --- | --- | --- |
| `knob-black-atlas.webp` | 2112 × 2112 | 11 × 11 | 192 px | 121 |
| `knob-metal-atlas.webp` | 2112 × 2112 | 11 × 11 | 192 px | 121 |
| `knob-cream-atlas.webp` | 2112 × 2112 | 11 × 11 | 192 px | 121 |

`knobFrameIndex(pct)` = `round(pct × 120)`; `knobAtlasFrame()` returns
column/row; the inner `<span>` gets `background-image`, `background-size:
1100% 1100%` and a percentage `background-position`. Frame 0 is fully
counter-clockwise, frame 120 fully clockwise. `knobAssetForVariant()` picks
metal for `"metal" | "white" | "panel"`, cream for `"warning"`, black
otherwise.

`RackKnob` itself uses black for `size="default"` and metal for `size="large"`;
it has no variant prop. The broader variant mapping is an asset-helper API.

CSS custom properties set on the label:

| Variable | Value | Used by |
| --- | --- | --- |
| `--nam-knob-rotation` | `-135deg … 135deg` | `.nam-rack-knob-cap > span { transform: rotate(var(--nam-knob-rotation)) }` (vector fallback cap) |
| `--nam-knob-pct` | `0% … 75%` | conic-gradient ring on the vector cap |
| `--nam-knob-fill-start` / `--nam-knob-fill-end` | percent | bipolar ring fill |

Two CSS layers apply. The base rules in `FXChainPanel.css`
draw a vector fallback cap with a conic gradient and a pointer pseudo-element.
The overrides in `NAMRackKnob.css` under `.nam-product[data-view="rack"]` and
`[data-view="mixer"]` strip that and show the raster sprite with a
`drop-shadow` filter. **On a website, wrap the knob in an element carrying
`class="nam-product" data-view="rack"`** (or copy those rules without the
prefix) so the sprite, not the gradient, is visible.

**Animating it:** the cheapest path is to step the frame index from a tween
and set `background-position` yourself; `knobAtlasFrame()` and
`NAM_KNOB_ATLAS_COLUMNS` are exported for this. Because the atlas is a
pre-rendered turn, each frame supplies its own lighting. Do not add a CSS
`transition` on `background-position`; it would
smear across sprite cells. Use `steps()` timing or per-frame updates.

### 5.3 `PeakMeter` (canvas level meter)

Sources: [PeakMeter](../frontend/src/components/PeakMeter.tsx),
[meter configuration](../frontend/src/components/meterConfig.ts).

- Renders a `<canvas>` inside a `div.h-full`; height follows the container via
  `ResizeObserver` unless an explicit `height` is supplied. Width comes from
  `width`, defaulting to 16 px stereo or 10 px mono.
- A single `requestAnimationFrame` loop reads the latest props from refs.
  Changing `level` still renders the React component and updates those refs;
  the draw loop does not set React state or restart for each level change.
  Canvas drawing is throttled to about 20 fps (50 ms between draws).
- Features: simulated stereo split (`getStereoMeterChannelLevels` offsets
  audio L/R by ±3%; MIDI-input bars are equal), internal peak hold and decay,
  a smoothed display derived from squared normalized levels, clip indicator, two
  scales (`extended` up to +12 dB, `dbfs` up to 0 dB), `segmented` (2 px
  segments, 1 px gap) or `continuous` render mode, optional ruler labels and
  threshold line, `centerContrast` colour scheme.
- The stereo and smoothed bars are display approximations, not separately
  measured L/R or audio RMS data. The internal peak holds for 1.5 seconds;
  its decay code subtracts a cumulative elapsed-time amount on each draw, so
  it should not be documented as a calibrated 3 dB/s meter.
- Colours and thresholds are all in `meterConfig.ts` (`METER_COLORS`,
  `METER_DB_FLOOR = -60`, warning from −6 dB, red from −1 dB in dBFS mode).
- **Animating it:** feed a synthetic level (for example an audio-reactive value
  or a scripted envelope) into `level` as linear amplitude (`1` = 0 dBFS),
  not a dB value or screen-height fraction. `resetSignal` (increment a counter)
  clears internal peak/RMS state; a positive external `peakHold` prop must
  also be cleared by its owner. `clipping` is likewise supplied by the caller.

### 5.4 `ParametricGraph` (SVG response curves)

Source: [ParametricGraph](../frontend/src/components/ParametricGraph/ParametricGraph.tsx).

- Pure SVG, sized by `width`/`height` props, margins
  `{ top 10, right 14, bottom 24, left 38 }`.
- Inputs: `xAxis`/`yAxis` (`linear` or `log`), `nodes` (draggable band
  handles, up to 8 colours in `NODE_COLORS`), `responseCurve`,
  `backgroundCurves`, `perNodeCurves`.
- Colours are CSS custom properties with fallbacks
  (`--s13-graph-surface`, `--s13-graph-grid`, `--s13-graph-response`, …), so
  a site can retheme it without touching the code.
- Wrappers `EQGraph`, `CompressorGraph`, `GateGraph`, `DelayGraph`,
  `ReverbGraph`, `SaturationGraph`, `ChorusGraph` turn a plugin slider array
  into nodes and curves. `eqResponseCurve.ts` computes the biquad EQ response.
- **Animating it:** interpolate the `nodes` array (`x`/`y`/optional `z`,
  representing frequency/gain/Q in EQ) and pass a
  recomputed `responseCurve`; the `<path>` d-attribute changes each frame.
  Direct path morphing requires keeping the sampled point count and topology
  stable in the website's own animation.

### 5.5 `NAMRackDesignPort` hardware artwork

The artboard is too coupled to lift as a component (param
context, TONE3000 flows), but its **markup pattern, CSS and artwork are
reusable**:

- Optional studio backdrop: `assets/nam/rack-studio-backdrop-v2.webp` is
  referenced by the pedalboard/mixer styles; it is not the universal design-port background.
- A `Module` is `div.module[data-module="<name>"]` absolutely positioned via
  `pxBox()`, containing `div.module-frame` → `<img.module-skin>` (body
  artwork from `NAM_DESIGN_BODY_ASSETS`) plus child controls and an optional
  `.module-title`. Module names: `gate`, `booster`, `tone`, `compressor`,
  `overdrive`, `octaver`, `precision-drive`, `amp-head`, `cabinet`,
  `mic-panel`, `eq-rack`, `modulator`, `delay`, `reverb`.
- Body artwork sizes (intrinsic px) are declared in `NAMDesignAssets.ts`,
  for example `amp-head-body-v5` 2160 × 1035, `graphic-eq-body-v6` 2160 × 720,
  standard `stompbox-body-blue` 694 × 1340 and `wide-pedal-body-copper`
  1355 × 662. Wide/deep/tall variants have different dimensions; use the
  individual entry in [NAMDesignAssets](../frontend/src/components/NAMDesignAssets.ts).
- A control is `<img.asset-control.{knob|toggle|led|footswitch|…}>` from
  `NAM_DESIGN_CONTROL_ASSETS` (512 × 512 for most) positioned by CSS custom
  properties:

  | Variable | Meaning |
  | --- | --- |
  | `--x`, `--y` | percentage of the module box, centre anchored |
  | `--size` | rendered width |
  | `--rot` | rotation in degrees (`transform: translate(-50%,-50%) rotate(var(--rot))`) |

  Knob artwork rotates around `50% 47.5586%` (the visible gear ring centre)
  by default in `NAMRackHardware.css`; the `.amp-head-v4` and `.eq-rack-v4`
  panel knobs override that to `50% 50%`. LEDs use on/off asset pairs
  (top or panel variants) and `.led.on` / `.led.off` filter classes. Toggles
  snap between two states with only a `filter` transition. Enum rotaries use
  `transition: transform 170ms cubic-bezier(.2,.92,.28,1.12)`.
- The hit target is a separate `span.control-hit` sized by `--hit`, so the
  artwork itself stays `pointer-events: none`.
- `namRackFaceplateGeometry.ts` documents the intrinsic-pixel placement
  contract (visible alpha bounds, safe zones, fader cap travel) used when
  faceplates are regenerated.

**Animating on a site:** reproduce `.module` / `.asset-control` markup with the
same CSS variables and tween `--rot` (knobs), swap LED sources, or animate
`filter`/`opacity` for power states. Preserve the relevant host classes and
control-specific transform origins from
[NAMRackHardware.css](../frontend/src/components/NAMRackHardware.css).

### 5.6 Other ready-made motion

| Where | Keyframe / transition | Effect |
| --- | --- | --- |
| `index.css` | `recording-pulse` on `.recording-dot` | 1 s opacity blink |
| `FXChainPanel.css` | `fx-overlay-fade-in`, `fx-panel-slide-in`, `nam-spin`, `nam-skeleton` | overlay fade, panel slide, spinner, shimmer |
| `NAMCompactChain.css` | `nam-compact-chain-rise` | 150 ms rise-in (disabled under reduced motion) |
| `NAMRackControlTooltip.css` (animation), `NAMRackPanel.css` (keyframe) | `nam-rack-tooltip-in` | 90 ms tooltip pop |
| `NAMRackDesignPort.css` | `tone-library-shimmer` | skeleton shimmer |
| `NAMRackStage.css` | `.premium-tuner-needle { transition: left 90ms linear }` | tuner needle glide |
| `NAMRackNeural.css` | `transition: height 35ms linear` | meter bar |

---

## 6. Recipe: lifting a component onto the website

1. **Copy the files** listed in the tier tables, keeping the relative layout
   (`components/ui/Knob/*`, `components/meterConfig.ts`, and so on) so imports
   resolve. Follow each import recursively, including types. Use individual
   primitive entry points rather than copying the full `ui/index.ts` barrel.
   For `RackKnob`, extract `BuiltInParamDescriptor` into a local types module
   and update its type-only imports in both the control and `builtInParamValue`;
   copying `NativeBridge.ts` pulls in unrelated app dependencies.
2. **Copy the theme.** Paste the `@theme` block from `index.css` into your
   site's Tailwind entry so `bg-daw-panel`, `text-daw-text-muted` and friends
   exist. Add `.vertical-fader` if you use the fader slider. The app's global
   `body`/`#root` rules lock scrolling and selection; select only the global
   rules appropriate to the website.
3. **Adapt `utils/parameterWheel.ts`** for Tier B components. Copy
   [parameterWheel.ts](../frontend/src/utils/parameterWheel.ts),
   [wheelGestureResolver.ts](../frontend/src/utils/wheelGestureResolver.ts),
   [wheelDeltaAccumulator.ts](../frontend/src/utils/wheelDeltaAccumulator.ts),
   and [platform.ts](../frontend/src/utils/platform.ts).
   Remove the `useDAWStore` and `mouseBehaviorProfiles` imports from the copy
   of `parameterWheel.ts`. Keep its other imports, interfaces, and helper
   functions. Replace **only** `resolveProfiledParameterWheel` with:

   ```ts
   // Uses the resolver's built-in OpenStudio profile, without a DAW store.
   export function resolveProfiledParameterWheel(
     event: WheelEventLike,
     subtarget: WheelSubtarget = "control",
   ): ResolvedWheelGesture {
     const platform = getShortcutPlatform();
     return resolveWheelGesture(event, {
       surface: "parameter",
       subtarget,
       platform: platform === "linux" ? "other" : platform,
     });
   }
   ```

   This preserves delta-mode normalization, `amount`/`precision`, profile keys,
   accumulation, clamping and actual value/step changes. It uses a fixed profile;
   it does not provide the DAW's user-selectable mouse preferences.
   For a display-only port, remove wheel handlers and their imports instead.
4. **Assets.** Import the webp files through your bundler
   (`new URL("../assets/nam/controls/knob-black-atlas.webp", import.meta.url)`
   from a file under `components/`), matching `NAMRackControlAssets.ts`.
   Keep all URLs in a copied registry resolvable, or trim it to the assets used.
   Preload the atlas needed for the initial view.
5. **Wrap NAM knobs** in `<div className="nam-product" data-view="rack">` and
   import `FXChainPanel.css` plus `NAMRackKnob.css`, or extract the
   `.nam-rack-control*` / `.nam-rack-knob-cap*` rules into a smaller sheet.
   Include the tooltip component's CSS and the `nam-rack-tooltip-in` keyframe
   from `NAMRackPanel.css` if retaining tooltip motion.
6. **Fonts.** The UI is tuned for `'Segoe UI', Inter, system-ui`; load Inter
   on the site to keep label metrics.
7. **Reduced motion.** `NAMCompactChain.css` already guards its keyframe with
   `prefers-reduced-motion`; add the same guard to any new tweens.
8. **Verify the extraction.** Type-check/build the website and exercise wheel,
   pointer, keyboard, reset and disabled states in a browser. Check host resizing,
   focus visibility, clipping and reduced motion. A props-driven animation still
   needs React state updates; updating a ref alone does not refresh an SVG knob.

## 7. Maintaining components inside OpenStudio

- Use `useShallow` selectors for React consumers of `useDAWStore`, selecting only
  needed fields. Meter maps are separate from `tracks` to avoid invalidating all
  track consumers on meter updates. `Playhead` uses an imperative subscription
  and Konva refs for transport/scroll updates.
- Track/clip mutations must participate in the command manager's undo/redo.
  Continuous controls need a begin/commit transaction owned by their caller;
  a visual control alone does not make an edit undoable.
- Native calls are asynchronous. Frontend-only bridge fallbacks help development
  but do not prove native audio or detached-window integration. Window startup
  follows the `boot-ready` contract in `main.tsx`.
- Use Tailwind for ordinary layout and component-owned CSS for artwork/geometry;
  keep intrinsic-pixel safe zones and hit areas aligned when changing bitmaps.
  Follow the repository [AGENTS.md](../AGENTS.md) for build and visual QA rules.

## 8. Development branch additions (not yet in this PR's base)

As of 2026-09-15, [`fix-nam-rack` at `98197be`](https://github.com/sdevil7th/OpenStudio/commit/98197be)
contains additional frontend work. These files are absent from the `main`
snapshot described above. The links below pin the reviewed development source;
they do not imply that these features have shipped.

| Component | Mounted by | Dependencies and behavior |
| --- | --- | --- |
| [AppDialogHost](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/AppDialogHost.tsx) | `main.tsx` alongside the selected window root | `services/appDialogs`, native bridge, shared modal and license text; renders asynchronous app dialogs. |
| [AppUpdatePanel](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/AppUpdatePanel.tsx) | `App` | Update store, DAW store and native bridge; update notification, download progress and explicit install flow. Preparation/restart differs between Windows, macOS/Linux and Microsoft Store. |
| [ProjectRecoveryDialog](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/ProjectRecoveryDialog.tsx) | `App` | DAW store, native bridge and `WorkRecoveryItems`; project and unfinished-work recovery. |
| [WorkRecoveryItems](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/WorkRecoveryItems.tsx) | `ProjectRecoveryDialog` | DAW store, native bridge and `services/workRecovery`; prepares/previews/imports recording and AI recovery entries. |
| [RecordingFailureBanner](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/RecordingFailureBanner.tsx) | `App` | Native recording-failure events and a store lookup for track names; reports failed recording destinations. |
| [InputGestureReference](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/InputGestureReference.tsx) | Gesture view of `KeyboardShortcutsModal` | Store, input profiles and gesture descriptions; reflects the selected input mappings. |
| [MetronomeControls](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/MetronomeControls.tsx) | `MetronomeSettings`, compact version in `TransportBar` | DAW store and shared UI; common metronome controls. |
| [PluginActivity](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/PluginActivity.tsx) | `FXChainPanel`, `MixerPanel` | Props-driven status text with a Lucide spinner; respects reduced motion. No DAW runtime dependency. |
| [AIGenerationProgressBar](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/AIGenerationProgressBar.tsx) | Both AI generation modals and `AITrackHeader` | Props-driven stage progress with its own CSS; supports indeterminate progress. |
| [AIGenerationHardwareCheck](https://github.com/sdevil7th/OpenStudio/blob/98197be/frontend/src/components/AIGenerationHardwareCheck.tsx) | `AIWorkflowModal`, `AIClipGenerationModal` | Native preflight bridge and shared button; debounces/serializes probes, discards stale results, and shows estimated need, available memory, shortfall and refresh. Advisory only: the worker makes the final memory decision. |

Existing components also changed on this branch, including the app shell,
shared input controls, AI setup, NAM Rack and shortcut integration. Recheck
their imports and APIs before applying an extraction recipe to that revision.
When this work merges into `main`, fold these entries into the main catalog,
refresh the portability tiers, and update the source snapshot above.

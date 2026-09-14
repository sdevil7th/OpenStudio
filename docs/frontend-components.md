# Frontend Component Map

A guide to `frontend/src/components/`: what each component does, where it is
mounted, what it depends on, and how portable it is if you want to lift it
onto a marketing website and animate it.

Paths below are relative to `frontend/src/` unless stated otherwise.

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
| safe mode                               | `components/StartupRecoveryApp.tsx` | Recovery UI                        |

`App.tsx` layout, top to bottom:

```
MenuBar
ProjectTabBar
MainToolbar  (+ CustomToolbarStrip from ToolbarEditor)
workspace
  ├─ TCP sidebar:  SortableTrackHeader × N  → TrackHeader / AITrackHeader
  │                MasterTrackHeader
  └─ TimelineRuler + Timeline (react-konva canvases, Playhead, HorizontalScrollbar)
TransportBar
LowerZone / panels (PitchEditorLowerZone, ClipPropertiesPanel, MixerPanel …)
Modals (lazy-loaded, see §4)
```

Two import styles matter when you search for "where is X used":

- **Static imports** in `App.tsx`: `Timeline`, `TimelineRuler`, `MixerPanel`,
  `MainToolbar`, `TransportBar`, `MenuBar`, `MasterTrackHeader`,
  `ProjectTabBar`, `ToolbarEditor`, `PluginBrowser`, `SortableTrackHeader`,
  `AddMultipleTracksModal`, `ContextMenu`, `EssentialControlsCard`,
  `InputProfileOnboardingCard`, `UnsavedChangesDialog`, `ui/Button`.
- **Lazy imports** in `App.tsx` lines 72–108 (`React.lazy(() => import(...))`):
  every modal and secondary panel. A plain grep for `from "./components/X"`
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
  `FXChainPanel.css` (5.6k lines) also holds the **base** NAM Rack control
  rules (`.nam-rack-control`, `.nam-rack-knob-cap`), so NAM knobs need it even
  outside the FX chain.
- Icons: `lucide-react` everywhere, plus the hand-drawn SVGs in `icons.tsx`.

---

## 3. Portability tiers for website use

**Tier A: drop-in.** No Zustand store, no native bridge. Copy the file(s), the
CSS they import, and Tailwind tokens.

| Component | File(s) | Notes |
| --- | --- | --- |
| Track icons | `icons.tsx` | Pure SVG, `currentColor`. Exports `MetronomeIcon`, `PianoIcon`, `MicrophoneIcon`, `GuitarIcon`, `BassGuitarIcon`, `DrumsIcon`, `KeysIcon`, `BusIcon`, `MasterIcon`, `MIDIIcon`, `FolderIcon`, `AIIcon`, plus `TRACK_ICONS` map. |
| Peak meter | `PeakMeter.tsx`, `meterConfig.ts` | Canvas + RAF loop. See §5.3. |
| Master meter cluster | `MasterPeakMeterCluster.tsx` | Wraps `PeakMeter` with a dBFS ruler overlay. |
| Button / Input / Checkbox / Textarea / NativeSelect | `ui/*` | Tailwind class maps; `Select` and `Modal` also need `@headlessui/react`. |
| Modal | `ui/Modal/*` | Headless UI `Dialog` + `Transition`. Imports `utils/shortcutContext` (no store). |
| Rack chain tile | `NAMRackChainModule.tsx` + `.css` | Props-only module tile with drag handles, power button, favourite star. |
| Compact signal chain | `NAMCompactChain.tsx` + `.css` | Props-only overlay; has `nam-compact-chain-rise` keyframe. Needs `NAMSignalChainTypes.ts` (types only). |
| Control tooltip | `NAMRackControlTooltip.tsx` + `.css` | Anchored tooltip, `nam-rack-tooltip-in` keyframe. |
| Context menu | `ContextMenu.tsx` | `ContextMenu` + `useContextMenu` hook. |
| Menu dropdown | `menus/MenuDropdown.tsx` | Keyboard-shortcut aware dropdown. |
| Detachable panel | `DetachablePanel.tsx` | Floating/dock wrapper. |
| Horizontal scrollbar | `HorizontalScrollbar.tsx` | Overview scrollbar. Type-only import from `utils/scrollbarOverview`. |

**Tier B: one stub needed.** These import `utils/parameterWheel.ts`, which
imports `useDAWStore` on its first line to read the mouse-behaviour profile.
Replace `resolveProfiledParameterWheel` / `accumulateParameterWheelGesture` /
`getParameterWheelValue` with a small local shim (or delete the wheel handler)
and they become standalone.

| Component | File(s) | Notes |
| --- | --- | --- |
| SVG knob | `ui/Knob/*` | See §5.1. Also needs `utils/wheelDeltaAccumulator.ts` (pure) and `ui/editTransactionLifecycle.ts` (pure). |
| Slider / fader | `ui/Slider/*`, `ui/ProfiledRangeInput/*` | Native range input; fader variant needs `.vertical-fader` CSS from `index.css`. |
| Sprite-atlas knob | `NAMRackKnob.tsx` + `.css`, `NAMRackControlAssets.ts` | See §5.2. Also needs `utils/builtInParamValue.ts` (pure) and the `BuiltInParamDescriptor` type. |
| Parametric graphs | `ParametricGraph/*` | SVG EQ / compressor / gate / delay / reverb / saturation / chorus curves. See §5.4. |

**Tier C: bound to the DAW.** They read the Zustand store and call the native
bridge. Reuse their markup, CSS and assets, not the component itself.

Everything else in the directory, notably `TransportBar`, `ChannelStrip`,
`MixerPanel`, `TrackHeader`, `MasterTrackHeader`, `VirtualPianoKeyboard`,
`BigClock`, `Timeline`, `TimelineRuler`, `Playhead`, `PianoRoll*`,
`PitchEditorLowerZone`, `NAMRackPanel`, `NAMRackDesignPort`, `NAMExplorer`,
`NAMRackMixer`, `FXChainPanel`, `BuiltInPluginPanel`, and all modals.

---

## 4. Catalog by area

Each row: component → where it is mounted → dependencies worth knowing.

### 4.1 Shell and navigation

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `MenuBar` | `App` | store, `menus/MenuDropdown`, `menus/EditMenu` |
| `menus/EditMenu` | `MenuBar` | `MenuDropdown` |
| `ProjectTabBar` | `App` | store, `ContextMenu` |
| `MainToolbar` | `App` | store, `ui` |
| `ToolbarEditor` (`ToolbarEditor`, `CustomToolbarStrip`) | `App` | store, `ui` |
| `TransportBar` | `App` (as `BottomTransportBar`) | store, `MetronomeSettings`, `icons.MetronomeIcon`, `ui/Button`, `ui/Input`, `ui/TimeSignatureInput` |
| `MetronomeSettings` | `TransportBar` | store, `ui` |
| `BigClock` | `App` (lazy) | store, `ui/Button` |
| `CommandPalette` | `App` (lazy) | store, `actionRegistry` |
| `KeyboardShortcutsModal` | `App` (lazy) | store, `CustomKeyboardProfileManager`, `InputProfileSelectors`, `KeyboardShortcutsPrint.css` |
| `EssentialControlsCard`, `InputProfileOnboardingCard` | `App` | store, `InputProfileSelectors` |
| `HelpOverlay`, `GettingStartedGuide` | `App` (lazy) | store, `utils/helpTexts` |
| `ErrorBoundary` | `main.tsx` | none |
| `StartupRecoveryApp` | `main.tsx` (safe mode) | bridge |

### 4.2 Tracks and arrangement

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `SortableTrackHeader` | `App` (one per track) | `@dnd-kit`, `TrackHeader`, `AITrackHeader`, `ColorPicker`, `ContextMenu` |
| `TrackHeader` | `SortableTrackHeader` | store, `FXChainPanel`, `MIDIDeviceSelector`, `TrackNameEditor`, `ColorPicker`, `PluginBrowser`, `icons`, `ui` |
| `AITrackHeader` | `SortableTrackHeader` | store, `AIWorkflowModal`, `FXChainPanel`, `TrackNameEditor`, `ColorPicker`, `tcpHeaderButtonStyles` |
| `MasterTrackHeader` | `App` | store, `FXChainPanel`, `tcpHeaderButtonStyles` |
| `TrackNameEditor` | `TrackHeader`, `AITrackHeader` | store |
| `ColorPicker` (`TRACK_COLORS`) | track headers | store (recent colours) |
| `MIDIDeviceSelector` | `TrackHeader` | bridge |
| `Timeline` (9.4k lines) | `App` | react-konva, store, `Playhead`, `HorizontalScrollbar`, `ContextMenu` |
| `TimelineRuler` (`TIMELINE_RULER_HEIGHT = 30`) | `App` | react-konva, store, `Playhead` |
| `Playhead` / `MemoizedPlayhead` | `Timeline`, `TimelineRuler` | react-konva, store (subscribes to `currentTime` alone) |
| `HorizontalScrollbar` | `Timeline` | none |
| `ClipLauncherView` | `App` (lazy) | store |
| `ClipPropertiesPanel` | `App` (lazy) | store |
| `CrossfadeEditor` | `App` (lazy) | store |
| `RegionMarkerManager`, `RegionRenderMatrix` | `App` (lazy) | store |
| `AddMultipleTracksModal` | `App` | store |

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
| `PluginBrowser` | `App`, `TrackHeader` | bridge (plugin catalogue) |
| `MIDIFXControls` | `FXChainPanel` | store |
| `PitchCorrectorPanel` (+ `pitchCorrectorPresets.ts`) | `FXChainPanel` | store, bridge |
| `ParametricGraph/*` | `FXChainPanel`, `BuiltInPluginPanel` | `utils/parameterWheel` (wheel only) |

### 4.5 NAM Rack (guitar/bass amp workspace)

Product doc: `docs/nam-rack.md`. Rendering tree:

```
BuiltInPluginPanel
└─ NAMRackPanel  (.nam-product.nam-neural-product[data-view][data-rack-section])
   ├─ NAMRackDesignPort   photoreal artboard: pedals, amp head, cab, EQ rack
   │    ├─ Module → <img.module-skin> body art + AssetControl children
   │    ├─ NAMRackMixer (advanced stage inspector) → RackKnob
   │    ├─ NAMToneCapturePicker
   │    └─ NAMRackControlTooltip
   ├─ NAMExplorer         TONE3000 / library browser (card art assets)
   ├─ NAMCompactChain     signal-flow overlay
   ├─ NAMRackChainModule  (RackModule) chain tiles
   ├─ NAMRackDiagnostics
   ├─ NAMPresetManagerModal
   └─ NAMToneSave
```

Supporting modules: `NAMDesignAssets.ts` (body and control artwork registry
with intrinsic pixel sizes), `NAMRackControlAssets.ts` (knob sprite atlases),
`namRackFaceplateGeometry.ts` (intrinsic-pixel control placement contract),
`NAMCabPresentation.ts`, `NAMSignalChainTypes.ts`.

Stylesheets, all imported by `NAMRackDesignPort.tsx` or `NAMRackPanel.tsx`:
`NAMRackPanel.css`, `NAMRackHardware.css` (artwork, control primitives),
`NAMRackStage.css`, `NAMRackHeader.css`, `NAMRackFooter.css`,
`NAMRackDesignPort.css`, `NAMRackDesignPortSourceFlow.css`,
`NAMRackBrowser.css`, `NAMRackPresets.css`, `NAMRackPedalboard.css`,
`NAMRackSourceFlow.css`, `NAMRackNeural.css`, `NAMRackCalibration.css`,
`NAMRackMixer.css`, `NAMRackKnob.css`, `NAMRackChainModule.css`,
`NAMCompactChain.css`, `NAMToneCapturePicker.css`, `NAMPresetManagerModal.css`.

### 4.6 MIDI and piano roll

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `PianoRoll` (+ `PianoRoll.css`) | `App` (lazy), `MidiEditorWindowApp` | react-konva, store, and the `PianoRoll*Section` / `PianoRollToolbar` / `PianoRollStatusStrip` / `PianoRollInfoLine` / `PianoRollInspectorSummary` sub-components |
| `VirtualPianoKeyboard` | `App` (lazy) | store, bridge (`sendMidiNote`), `ui/Button`. Two octaves C3–B4 in Tailwind divs. |
| `NoteInspector` | `PitchEditorLowerZone` | pitch store |

### 4.7 Pitch editor

| Component | Mounted by | Depends on |
| --- | --- | --- |
| `PitchEditorLowerZone` | `App` (lazy) | `pitchEditorStore`, bridge, `PitchEditorCanvas`, `NoteInspector`, `CorrectPitchModal` |
| `PitchEditorCanvas.ts` | `PitchEditorLowerZone` | Imperative 2D canvas renderer (RAF loop) for note blobs and contour |
| `CorrectPitchModal` | `PitchEditorLowerZone` | store |

### 4.8 Project, settings, and export modals (all lazy in `App`)

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

- Sizes: `sm` 24 px, `md` 30 px (`knobSizeMap`).
- Geometry: 270° sweep from 225° (7:30) to 495° (4:30), gap at 6 o'clock.
  `valueToAngle()` maps value → angle; `describeArc()` builds the SVG path.
- Layers: outer ring circle, dark track arc, fill arc (`FILL_COLORS`: default
  `#0078d4`, volume `#4caf50`, pan `#16a34a`), tick marks, cap circle, and
  an indicator line that turns white while dragging.
- `bipolarCenter` makes the fill originate from the centre (pan knobs).
- Interaction: vertical drag (`sensitivity` px for full range), wheel, and
  Ctrl+click reset to `defaultValue`. `onBeginEdit` / `onCommitEdit` wrap a
  gesture for undo.
- **To animate on a site:** drive the `value` prop from a tween (Framer Motion
  `useMotionValue` + `useEffect`, GSAP, or `requestAnimationFrame`) and let the
  component recompute the arc. Nothing inside uses CSS transitions, so the
  arc will follow the value frame by frame.

### 5.2 `NAMRackKnob` (photographed knob, sprite atlas)

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

CSS custom properties set on the label (`NAMRackKnob.tsx` lines 80–88):

| Variable | Value | Used by |
| --- | --- | --- |
| `--nam-knob-rotation` | `-135deg … 135deg` | `.nam-rack-knob-cap > span { transform: rotate(var(--nam-knob-rotation)) }` (vector fallback cap) |
| `--nam-knob-pct` | `0% … 75%` | conic-gradient ring on the vector cap |
| `--nam-knob-fill-start` / `--nam-knob-fill-end` | percent | bipolar ring fill |

Two CSS layers apply. The base rules in `FXChainPanel.css` (from line 2039)
draw a vector fallback cap with a conic gradient and a pointer pseudo-element.
The overrides in `NAMRackKnob.css` under `.nam-product[data-view="rack"]` and
`[data-view="mixer"]` strip that and show the raster sprite with a
`drop-shadow` filter. **On a website, wrap the knob in an element carrying
`class="nam-product" data-view="rack"`** (or copy those rules without the
prefix) so the sprite, not the gradient, is visible.

**Animating it:** the cheapest path is to step the frame index from a tween
and set `background-position` yourself; `knobAtlasFrame()` and
`NAM_KNOB_ATLAS_COLUMNS` are exported for this. Because the atlas is a
pre-rendered 3D turn, a frame step reads as a physical rotation with correct
highlights. Do not add a CSS `transition` on `background-position`; it would
smear across sprite cells. Use `steps()` timing or per-frame updates.

### 5.3 `PeakMeter` (canvas VU meter)

- Renders a `<canvas>` inside a `div.h-full`; height follows the container via
  `ResizeObserver`, width from the `width` prop.
- A single `requestAnimationFrame` loop reads prop values from refs, so
  updating `level` never re-renders React; it only changes what the next frame
  draws.
- Features: stereo split (`getStereoMeterChannelLevels` offsets L/R by ±3%),
  peak-hold marker with 3 dB/s decay, RMS smoothing, clip indicator, two
  scales (`extended` up to +12 dB, `dbfs` up to 0 dB), `segmented` (2 px
  segments, 1 px gap) or `continuous` render mode, optional ruler labels and
  threshold line, `centerContrast` colour scheme.
- Colours and thresholds are all in `meterConfig.ts` (`METER_COLORS`,
  `METER_DB_FLOOR = -60`, warning from −6 dB, red from −1 dB in dBFS mode).
- **Animating it:** feed a synthetic level (for example an audio-reactive value
  or a scripted envelope) into `level`; the decay and peak-hold logic will do
  the rest. `resetSignal` (increment a counter) clears the peak marker.

### 5.4 `ParametricGraph` (SVG response curves)

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
- **Animating it:** interpolate the `nodes` array (freq/gain/Q) and pass a
  recomputed `responseCurve`; the `<path>` d-attribute changes each frame.
  Alternatively animate the SVG paths directly with a path-morph library since
  point counts are stable.

### 5.5 `NAMRackDesignPort` hardware artwork

The artboard is too coupled to lift as a component (7.6k lines, param
context, TONE3000 flows), but its **markup pattern, CSS and artwork are
reusable**:

- Backdrop: `assets/nam/rack-studio-backdrop-v2.webp`.
- A `Module` is `div.module[data-module="<name>"]` absolutely positioned via
  `pxBox()`, containing `div.module-frame` → `<img.module-skin>` (body
  artwork from `NAM_DESIGN_BODY_ASSETS`) plus child controls and an optional
  `.module-title`. Module names: `gate`, `booster`, `tone`, `compressor`,
  `overdrive`, `octaver`, `precision-drive`, `amp-head`, `cabinet`,
  `mic-panel`, `eq-rack`, `modulator`, `delay`, `reverb`.
- Body artwork sizes (intrinsic px) are declared in `NAMDesignAssets.ts`,
  for example `amp-head-body-v5` 2160 × 1035, `graphic-eq-body-v6` 2160 × 720,
  `stompbox-body-*` 694 × 1340, `wide-pedal-body-*` 1355 × 662.
- A control is `<img.asset-control.{knob|toggle|led|footswitch|…}>` from
  `NAM_DESIGN_CONTROL_ASSETS` (512 × 512 for most) positioned by CSS custom
  properties:

  | Variable | Meaning |
  | --- | --- |
  | `--x`, `--y` | percentage of the module box, centre anchored |
  | `--size` | rendered width |
  | `--rot` | rotation in degrees (`transform: translate(-50%,-50%) rotate(var(--rot))`) |

  Knob artwork rotates around `50% 47.5586%` (the visible gear ring centre)
  per `NAMRackHardware.css`. LEDs swap between `led-amber-on-top` and
  `led-amber-off-top` and get `.led.on` / `.led.off` filter classes. Toggles
  snap between two states with only a `filter` transition. Enum rotaries use
  `transition: transform 170ms cubic-bezier(.2,.92,.28,1.12)`.
- The hit target is a separate `span.control-hit` sized by `--hit`, so the
  artwork itself stays `pointer-events: none`.
- `namRackFaceplateGeometry.ts` documents the intrinsic-pixel placement
  contract (visible alpha bounds, safe zones, fader cap travel) used when
  faceplates are regenerated.

**Animating on a site:** reproduce `.module` / `.asset-control` markup with the
same CSS variables and tween `--rot` (knobs), swap LED sources, or animate
`filter`/`opacity` for power states. The photographs are already lit for a
top-down view, so a small `translateY` plus `drop-shadow` change on hover
reads as depth.

### 5.6 Other ready-made motion

| Where | Keyframe / transition | Effect |
| --- | --- | --- |
| `index.css` | `recording-pulse` on `.recording-dot` | 1 s opacity blink |
| `FXChainPanel.css` | `fx-overlay-fade-in`, `fx-panel-slide-in`, `nam-spin`, `nam-skeleton` | overlay fade, panel slide, spinner, shimmer |
| `NAMCompactChain.css` | `nam-compact-chain-rise` | 150 ms rise-in (disabled under reduced motion) |
| `NAMRackControlTooltip.css` | `nam-rack-tooltip-in` | 90 ms tooltip pop |
| `NAMRackDesignPort.css` | `tone-library-shimmer` | skeleton shimmer |
| `NAMRackStage.css` | `.premium-tuner-needle { transition: left 90ms linear }` | tuner needle glide |
| `NAMRackNeural.css` | `transition: height 35ms linear` | meter bar |

---

## 6. Recipe: lifting a component onto the website

1. **Copy the files** listed in the tier tables, keeping the relative layout
   (`components/ui/Knob/*`, `components/meterConfig.ts`, and so on) so imports
   resolve.
2. **Copy the theme.** Paste the `@theme` block from `index.css` into your
   site's Tailwind entry so `bg-daw-panel`, `text-daw-text-muted` and friends
   exist. Add `.vertical-fader` if you use the fader slider.
3. **Stub `utils/parameterWheel.ts`** for Tier B components:

   ```ts
   // utils/parameterWheel.ts (website shim)
   export function resolveProfiledParameterWheel(e: WheelEvent) {
     return { operation: "adjust", direction: Math.sign(-e.deltaY), preventDefault: true, stopPropagation: false };
   }
   export const accumulateParameterWheelGesture = (_acc: unknown, g: unknown) => g;
   export function getParameterWheelValue(_g: unknown, o: { value: number }) { return o.value; }
   export const getParameterWheelStepCount = () => 0;
   ```

   Or delete the `onWheel` handlers; nothing else in those components touches
   the store.
4. **Assets.** Import the webp files through your bundler
   (`new URL("./knob-black-atlas.webp", import.meta.url)`), matching what
   `NAMRackControlAssets.ts` does. The three atlases are 1.0–1.25 MB each;
   preload the one you use.
5. **Wrap NAM knobs** in `<div className="nam-product" data-view="rack">` and
   import `FXChainPanel.css` plus `NAMRackKnob.css`, or extract the
   `.nam-rack-control*` / `.nam-rack-knob-cap*` rules into a smaller sheet.
6. **Fonts.** The UI is tuned for `'Segoe UI', Inter, system-ui`; load Inter
   on the site to keep label metrics.
7. **Reduced motion.** `NAMCompactChain.css` already guards its keyframe with
   `prefers-reduced-motion`; add the same guard to any new tweens.

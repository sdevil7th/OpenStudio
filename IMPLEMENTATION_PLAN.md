# Studio13-v3 Implementation Plan

> **Goal**: Close the gap between Studio13-v3 and professional DAWs like Ardour by implementing missing features end-to-end (C++ backend + bridge + React frontend). UI/UX improvements and optimizations are listed separately and deferred.
>
> **Architecture reference**: Ardour codebase at `C:\Users\srvds\Documents\Codes\ardour`

---

## Phase 1: Wire Frontend-Only Features to C++ Backend

These features already have working UI and Zustand state. They need C++ backend implementations and bridge wiring so they actually affect audio processing.

### 1.1 Automation Playback (CRITICAL — Enables parameter modulation during playback)

**Current state**: `useDAWStore.ts` has `automationLanes` with per-track automation points for volume/pan/mute. Users can draw/edit points in the UI. But `TrackProcessor::processBlock()` ignores them entirely — volume/pan are static values.

**What to implement**:

#### C++ Backend

- **AutomationList class** (`Source/AutomationList.h/cpp`)
  - Stores sorted `std::vector<AutomationPoint>` where `AutomationPoint = { double timeSamples; float value; }`
  - Thread-safe: message thread writes via lock, audio thread reads via `ScopedTryLock` (REAPER pattern already used in codebase)
  - `float eval(double timeSamples)` — linear interpolation between adjacent points
  - `float eval(double startSample, double endSample, int numSamples, float* outputBuffer)` — batch evaluation for a process block, writes per-sample interpolated values
  - Support interpolation modes: `discrete`, `linear` (default), `exponential`

- **Per-track automation storage in AudioEngine**
  - `std::map<std::string, std::map<std::string, std::unique_ptr<AutomationList>>> trackAutomation` — keyed by trackId → parameterId
  - Parameter IDs: `"volume"`, `"pan"`, `"mute"`, `"plugin-{index}-param-{paramIndex}"`
  - Native functions to expose:
    - `setAutomationPoints(trackId, parameterId, pointsJSON)` — bulk set from frontend state
    - `setAutomationMode(trackId, parameterId, mode)` — `"off"`, `"read"`, `"write"`, `"touch"`, `"latch"`
    - `getAutomationMode(trackId, parameterId)` → string
    - `clearAutomation(trackId, parameterId)`

- **TrackProcessor::processBlock() changes**
  - Before applying static volume/pan, check if automation mode is `"read"` (or `"touch"`/`"latch"` when not touching)
  - If yes, call `automationList->eval(blockStartSample, blockEndSample, numSamples, tempBuffer)` to get per-sample automation values
  - Apply sample-by-sample gain instead of block-level gain
  - For plugin parameter automation: call `plugin->setParameter(paramIndex, value)` per block boundary (not per-sample — too expensive)
  - **Smoothing**: Apply 1-pole lowpass (alpha ~0.001) to avoid zipper noise on discrete jumps

- **Automation recording** (write/touch/latch modes)
  - When mode is `"write"`: every processBlock, record current parameter value as a new point at current playhead position
  - When mode is `"touch"`: record only while user is actively moving a fader/knob (track touch state via `beginTouchAutomation(trackId, parameterId)` / `endTouchAutomation(...)` bridge calls)
  - When mode is `"latch"`: like touch, but after release, continue writing the last value until transport stops
  - Recorded points are sent back to frontend via periodic event emission (10Hz) for UI update

#### NativeBridge.ts

- Add bridge functions:
  ```
  setAutomationPoints(trackId: string, parameterId: string, points: { time: number; value: number }[]): Promise<void>
  setAutomationMode(trackId: string, parameterId: string, mode: 'off'|'read'|'write'|'touch'|'latch'): Promise<void>
  getAutomationMode(trackId: string, parameterId: string): Promise<string>
  clearAutomation(trackId: string, parameterId: string): Promise<void>
  beginTouchAutomation(trackId: string, parameterId: string): Promise<void>
  endTouchAutomation(trackId: string, parameterId: string): Promise<void>
  ```
- Add event listener for `automationPointsRecorded` to receive recorded points during write/touch/latch

#### Frontend Changes

- **useDAWStore.ts**: When automation points change (add/move/delete), call `nativeBridge.setAutomationPoints()` to sync to backend
- **useDAWStore.ts**: When automation mode changes, call `nativeBridge.setAutomationMode()`
- **ChannelStrip.tsx**: On fader mousedown → `beginTouchAutomation()`, on mouseup → `endTouchAutomation()`
- **Timeline.tsx automation lanes**: Listen for `automationPointsRecorded` event and merge recorded points into store

#### Undo/Redo

- All automation point edits already go through CommandManager (frontend). Backend sync is fire-and-forget (backend is always overwritten with full point list).

---

### 1.2 Tempo Map with Variable BPM Playback

**Current state**: `useDAWStore.ts` has `tempoMarkers: TempoMarker[]` with `{ id, position, bpm, timeSignature }`. The metronome and playback engine use a single global BPM from `setTempo()`. Grid snapping uses frontend-only calculations.

**What to implement**:

#### C++ Backend

- **TempoMap class** (`Source/TempoMap.h/cpp`)
  - Stores sorted list of tempo events: `struct TempoEvent { double beatPosition; double bpm; int timeSigNum; int timeSigDenom; }`
  - Core conversion functions (must be audio-thread safe — no allocations, no locks):
    - `double beatToSample(double beat, double sampleRate)` — integrate tempo curve from start
    - `double sampleToBeat(double sample, double sampleRate)` — inverse of above
    - `BBT sampleToBBT(double sample, double sampleRate)` — bar/beat/tick from sample position
    - `double bbtToSample(BBT bbt, double sampleRate)` — sample from bar/beat/tick
    - `double tempoAtSample(double sample, double sampleRate)` — BPM at a given position
    - `double tempoAtBeat(double beat)` — BPM at a given beat
  - **Thread safety**: Use atomic pointer swap (RCU pattern from Ardour). Message thread builds a new TempoMap, atomically swaps pointer. Audio thread reads current pointer — no locks.
  - **Cache**: Pre-compute cumulative sample offsets at each tempo event for O(log n) lookup via binary search

- **Integration points**:
  - **Metronome.cpp**: Replace fixed BPM with `tempoMap->tempoAtSample(currentPosition)`. Click intervals vary per beat based on local tempo.
  - **PlaybackEngine.cpp**: `fillTrackBuffer()` does NOT need tempo awareness for audio clips (they're sample-positioned). But MIDI clips need beat-to-sample conversion.
  - **AudioEngine.cpp**: Expose native functions:
    - `setTempoMap(tempoEventsJSON)` — bulk set from frontend
    - `getBeatAtSample(samplePos)` → double
    - `getSampleAtBeat(beat)` → double
    - `getBBTAtSample(samplePos)` → `{ bar, beat, tick }`
    - `getTempoAtSample(samplePos)` → double

- **MIDI clip playback with tempo map**:
  - `MIDIClip::getNotesInRange()` currently uses beat positions. The audio engine needs to convert beat positions to sample positions using the tempo map when scheduling MIDI note-on/note-off events.

#### NativeBridge.ts

- Add bridge functions:
  ```
  setTempoMap(events: { beatPosition: number; bpm: number; timeSigNum: number; timeSigDenom: number }[]): Promise<void>
  getBeatAtSample(sample: number): Promise<number>
  getSampleAtBeat(beat: number): Promise<number>
  getBBTAtSample(sample: number): Promise<{ bar: number; beat: number; tick: number }>
  getTempoAtSample(sample: number): Promise<number>
  ```

#### Frontend Changes

- **useDAWStore.ts**: When `tempoMarkers` change, serialize and send full map to backend via `nativeBridge.setTempoMap()`
- **snapToGrid.ts**: Use backend `getBeatAtSample()` / `getSampleAtBeat()` for accurate snapping with variable tempo (currently assumes fixed BPM)
- **Timeline.tsx ruler**: Grid lines must be spaced according to tempo map, not fixed intervals
- **TransportBar.tsx BBT display**: Use backend `getBBTAtSample()` for accurate bar:beat:tick display

---

### 1.3 Comping / Takes System (End-to-End)

**Current state**: `useDAWStore.ts` has per-clip takes (`clip.takes[]`, `clip.activeTakeIndex`), with UI for explode/implode/promote/swap. But the backend only knows about the "active" clip — it has no concept of takes. Switching takes doesn't update what's actually playing.

**What to implement**:

#### C++ Backend

- **No new classes needed** — the backend already manages clips per track via `addPlaybackClip()` / `removePlaybackClip()`. Takes are a frontend organizational concept.
- **The fix**: When the active take changes in the frontend, the frontend must:
  1. `removePlaybackClip(trackId, oldClipId)` — remove the old active take from playback
  2. `addPlaybackClip(trackId, newClipId, filePath, startTime, offset, duration, ...)` — add the new active take
  3. This makes the backend play the correct take

#### Frontend Changes

- **useDAWStore.ts `setActiveTake()`**: After updating `clip.activeTakeIndex` in state, call bridge to swap playback clips:
  ```typescript
  const oldTake = clip.takes[oldIndex];
  const newTake = clip.takes[newIndex];
  await nativeBridge.removePlaybackClip(trackId, oldTake.clipId);
  await nativeBridge.addPlaybackClip(trackId, newTake.clipId, newTake.filePath, clip.startTime, newTake.offset, newTake.duration, ...);
  ```
- **Recording integration**: When a new take is recorded (overdub/replace mode), store the new clip as a take alongside existing clip:
  1. After recording stops, `getLastCompletedClips()` returns the new clip
  2. Add it as a new take entry in the existing clip's `takes[]` array
  3. Optionally auto-switch to the new take

- **Comping (multi-take assembly)**:
  - When user selects time ranges from different takes (using razor-like tool on take lanes):
    1. Split the active clip at comp boundaries
    2. For each segment, set the active take to the user-selected take
    3. Each segment independently calls `removePlaybackClip` / `addPlaybackClip` to play its chosen take
  - This requires the frontend to manage "comp segments" — essentially multiple clips per original clip position, each pointing to a different take

#### Undo/Redo

- Take switching and comping operations must push undo commands that capture:
  - Old active take index, new active take index
  - The bridge calls to swap playback clips (execute/undo both re-sync backend)

---

### 1.4 Razor Editing (Wire to Backend)

**Current state**: Alt+drag creates razor areas in the UI, Delete removes content (frontend clips are split/removed). But the backend playback clips are not updated — removed content may still play.

**What to implement**:

#### Frontend Changes

- **useDAWStore.ts `deleteRazorContent()`**: After removing/splitting clips in the store, sync to backend:
  1. For each affected clip: `removePlaybackClip(trackId, clipId)` to remove old clip
  2. For each resulting clip (after split): `addPlaybackClip(trackId, newClipId, ...)` to add new clips
  3. Clear razor areas after applying

- **Ripple editing integration**: When ripple mode is on and razor content is deleted:
  1. After deleting razor content, shift subsequent clips earlier
  2. For each shifted clip: `removePlaybackClip()` then `addPlaybackClip()` with new position
  3. This is already partially implemented in frontend state — just needs bridge sync

---

### 1.5 Track Groups (Wire to Backend)

**Current state**: `useDAWStore.ts` has `trackGroups` with linked parameters (volume, pan, mute, solo). But when group-linked parameters change, only the frontend state updates — the backend doesn't receive the linked changes.

**What to implement**:

#### Frontend Changes

- **useDAWStore.ts**: When a grouped parameter changes, iterate all tracks in the group and call the appropriate bridge function for each:
  ```typescript
  // In setTrackVolume():
  if (track is in a group with 'volume' linked) {
    for (const linkedTrackId of group.trackIds) {
      // Apply relative volume change
      nativeBridge.setTrackVolume(linkedTrackId, newVolume);
    }
  }
  ```
- Same pattern for `setTrackPan()`, `setTrackMute()`, `setTrackSolo()`

---

## Phase 2: Complete Incomplete / Stubbed Features

These features have partial implementations (stubs, TODOs) that need to be finished.

### 2.1 MIDI Recording (Save to Clips)

**Current state**: `MIDIManager.cpp` receives MIDI messages and routes them to instrument plugins for live playback. But there's a TODO at `AudioEngine.cpp:766` — MIDI notes are NOT saved to `MIDIClip` objects during recording.

**What to implement**:

#### C++ Backend

- **MIDIRecorder class** (`Source/MIDIRecorder.h/cpp`) or extend `AudioRecorder`
  - Thread-safe ring buffer for incoming MIDI events during recording
  - When transport is recording and track is armed:
    - On MIDI note-on: push `{ timestamp, noteNumber, velocity, channel }` to ring buffer
    - On MIDI note-off: push corresponding event
    - Also capture CC, pitch bend, program change events
  - On recording stop:
    - Drain ring buffer into a new `MIDIClip` object
    - Write to `.mid` (SMF) file on disk for persistence
    - Notify frontend with clip metadata (like `getLastCompletedClips()` for audio)

- **AudioEngine integration**:
  - In the MIDI input callback (where instrument plugins already receive events):
    - If track is armed and recording: also push events to `MIDIRecorder`
  - On `setTransportRecording(false)`:
    - Finalize MIDI recording, create clip, emit event

- **New native functions**:
  - `getLastCompletedMIDIClips()` — returns list of newly recorded MIDI clips with metadata
  - `getMIDIClipNotes(clipId)` — returns note events for PianoRoll display

#### Frontend Changes

- After recording stops, poll `getLastCompletedMIDIClips()` to get new MIDI clip data
- Create clip entries in store with `type: 'midi'`
- PianoRoll can display/edit using existing `MIDIClip` note data

---

### 2.2 Time Stretching (Real Implementation)

**Current state**: `NativeBridge.ts` has `timeStretchClip()` and `pitchShiftClip()` functions. The C++ side has stubs that return empty results.

**What to implement**:

#### C++ Backend — Option A: RubberBand Library Integration

- Add RubberBand library as a CMake dependency (MIT license, well-suited for JUCE)
- **TimeStretchProcessor class** (`Source/TimeStretchProcessor.h/cpp`)
  - Offline processing (not real-time — same as Ardour's approach):
    1. Read source audio file via `AudioFormatReader`
    2. Create `RubberBandStretcher` with desired time ratio and pitch shift
    3. Process in blocks (e.g., 4096 samples), writing to a new WAV file
    4. Return path to new file
  - Parameters:
    - `timeRatio`: 0.5 = half speed, 2.0 = double speed (preserves pitch)
    - `pitchSemitones`: pitch shift in semitones (preserves duration)
    - `preserveFormants`: boolean (better vocal quality)
  - Progress callback for UI progress bar
  - Runs on a background `juce::Thread` to not block the message thread

#### C++ Backend — Option B: FFmpeg Fallback

- If RubberBand is too complex to integrate, use FFmpeg's `rubberband` audio filter:
  ```
  ffmpeg -i input.wav -af "rubberband=tempo=1.5:pitch=1.0" output.wav
  ```
- Shell out to FFmpeg (already bundled in `tools/`) as a `juce::ChildProcess`
- Simpler but less control over quality parameters

#### Recommended: Option A (RubberBand) for quality, with Option B as a fallback.

- **Native functions to complete**:
  - `timeStretchClip(filePath, outputPath, timeRatio, pitchSemitones, preserveFormants, callback)` → returns output path
  - `pitchShiftClip(filePath, outputPath, semitones, preserveFormants, callback)` → returns output path

#### Frontend Changes

- **useDAWStore.ts**: `stretchClip(clipId, targetDuration)`:
  1. Calculate `timeRatio = targetDuration / clip.duration`
  2. Call `nativeBridge.timeStretchClip(clip.filePath, outputPath, timeRatio, 0, true)`
  3. On completion, update clip to point to new file, regenerate peaks
  4. Push undo command
- **Timeline.tsx**: Add stretch handle on clip edges (Alt+drag clip edge to time-stretch instead of trim)
- **RenderModal.tsx or dedicated dialog**: Allow specifying stretch/pitch parameters

---

### 2.3 Pitch Shifting

**Same as 2.2** — implemented via the same `TimeStretchProcessor` class. Pitch shifting is just time stretching with `timeRatio=1.0` and non-zero `pitchSemitones`.

---

### 2.4 Sample Rate Conversion on Render

**Current state**: `AudioEngine::renderProject()` always renders at the device's current sample rate, ignoring the target sample rate parameter.

**What to implement**:

#### C++ Backend

- In `renderProject()`:
  1. Render at device sample rate (current behavior)
  2. If target sample rate differs from device rate:
     - Use `juce::ResamplingAudioSource` or a dedicated resampler (e.g., `juce::LagrangeInterpolator` or libsamplerate/zita-resampler)
     - Resample the rendered output file to target rate
     - OR: Temporarily switch the offline render's "virtual" sample rate and use the existing SR conversion in `PlaybackEngine::fillTrackBuffer()`
  3. Write final file at target sample rate

- **Better approach**: Render the project at the target sample rate directly:
  - Set `PlaybackEngine`'s device rate to the target rate for the duration of the render
  - All SR conversion in `fillTrackBuffer()` will naturally produce output at the target rate
  - Restore device rate after render

---

### 2.5 Dither on Render

**Current state**: `RenderModal.tsx` shows a dither option but the backend ignores it.

**What to implement**:

#### C++ Backend

- In `renderProject()`, after rendering to float buffer and before writing to file:
  - If bit depth < 32 (i.e., 16-bit or 24-bit) AND dither is enabled:
    - Apply TPDF (Triangular Probability Density Function) dither
    - Implementation: For each sample, add `(random1 + random2 - 1.0) / (2^bitDepth)` where random1/random2 are uniform [0,1]
    - This is ~20 lines of code, standard practice

---

### 2.6 Monitoring FX Chain

**Current state**: `AudioEngine.cpp:1925` has a TODO — `monitoringFXChain` exists as a member but is not connected to the signal path.

**What to implement**:

#### C++ Backend

- In the audio callback, when input monitoring is enabled for a track:
  1. Copy input audio to monitoring buffer
  2. Process through `monitoringFXChain` (same as `trackFXChain` processing)
  3. Mix into output
- This allows musicians to hear themselves with effects (e.g., reverb) while recording, without the FX being printed to the recorded file

---

## Phase 3: New Features (Not Yet Started)

### 3.1 Punch In/Out Recording

**What it is**: Automatically start/stop recording at predefined time boundaries while transport rolls. Essential for fixing mistakes in a take without re-recording everything.

#### C++ Backend

- **Punch range state**: `struct PunchRange { bool enabled; double startSample; double endSample; }`
- **AudioEngine changes**:
  - Store punch range, updated via bridge
  - In audio callback when recording is armed:
    - If `currentPosition < punchRange.startSample`: pass through (play existing audio, don't record)
    - If `currentPosition >= punchRange.startSample && currentPosition < punchRange.endSample`: record (call `AudioRecorder::writeBlock()`)
    - If `currentPosition >= punchRange.endSample`: stop recording, finalize clip
  - Handle block boundaries: if punch point falls mid-block, split the block
- **Pre-roll option**: Start transport N bars before punch-in so musician can get in rhythm

- **Native functions**:
  - `setPunchRange(startSample, endSample, enabled)`
  - `setPunchPreRoll(beats)` — number of beats to play before punch-in

#### Frontend Changes

- **useDAWStore.ts**: Add `punchRange: { enabled: boolean; start: number; end: number }` state
- **Timeline.tsx**: Render punch range as a highlighted region (like loop range but different color, e.g., red tint)
- **Timeline.tsx**: Allow dragging punch-in and punch-out markers on the ruler
- **TransportBar.tsx**: Punch in/out toggle buttons
- **actionRegistry.ts**: Add `toggle-punch-in`, `toggle-punch-out`, `set-punch-to-selection` actions

---

### 3.2 Loop Recording

**What it is**: Record multiple passes over a loop region, automatically creating takes for each pass. Essential for capturing the best performance.

#### C++ Backend

- When loop is enabled AND recording:
  - Each time transport loops back to loop start:
    1. Finalize current recording as a take
    2. Start a new recording for the next pass
    3. Increment take counter
  - After recording stops, all takes are available for comping

- **AudioEngine changes**:
  - Track loop pass counter
  - On loop boundary detection (current position wraps from loop end to loop start):
    - `AudioRecorder::finalize()` current take
    - `AudioRecorder::beginNewTake()` for next pass
    - Generate unique filenames: `trackName_take1.wav`, `trackName_take2.wav`, etc.

#### Frontend Changes

- After loop recording stops, `getLastCompletedClips()` returns multiple clips (one per take)
- Store them as takes on the same clip position
- Take lanes UI already exists — just populate with loop recording results

---

### 3.3 Record-Safe Mode

**What it is**: Prevents accidental recording on a track. Track cannot be armed until record-safe is disabled.

#### C++ Backend

- Add `bool recordSafe` flag per track in `AudioEngine`
- `setTrackRecordArm()` checks `recordSafe` — if true, refuse to arm and return error
- Native function: `setTrackRecordSafe(trackId, bool)`

#### Frontend Changes

- **useDAWStore.ts**: Add `recordSafe` per track
- **TrackHeader.tsx**: Record-safe toggle button (lock icon on record button)
- When record-safe is on, visually disable the arm button

---

### 3.4 LV2 Plugin Support

**Current state**: Only VST3 is supported. LV2 is the open standard plugin format, widely used on Linux and increasingly on Windows.

#### C++ Backend

- **Option A**: Use JUCE's built-in LV2 hosting (available in JUCE 7+)
  - JUCE has `juce::AudioPluginFormatManager` which can host LV2 if the `JUCE_PLUGINHOST_LV2` flag is enabled
  - Add `target_compile_definitions(Studio13 PRIVATE JUCE_PLUGINHOST_LV2=1)` to CMakeLists.txt
  - `PluginManager::scanForPlugins()` already uses `AudioPluginFormatManager` — LV2 plugins will appear automatically after enabling the flag

- **Option B**: If JUCE's LV2 hosting is insufficient, use `lilv` library directly (more complex)

- **Recommended**: Option A — minimal code changes, JUCE handles the heavy lifting

#### Frontend Changes

- **PluginBrowser.tsx**: Add LV2 category filter alongside VST3
- **FXChainPanel.tsx**: LV2 plugins appear in the same list as VST3

---

### 3.5 CLAP Plugin Support

**What it is**: CLAP (CLever Audio Plugin) is a modern, open-source plugin format designed to address limitations of VST3 and AU. Growing ecosystem with Bitwig, Reaper support.

#### C++ Backend

- JUCE does not natively support CLAP hosting. Options:
  - **clap-juce-extensions**: Open-source library that adds CLAP hosting to JUCE applications
  - Add as a CMake dependency
  - Register CLAP format with `AudioPluginFormatManager`
  - Scanning and loading follows the same pattern as VST3

---

### 3.6 Audio Units Support (macOS — Future)

- Only relevant when/if Studio13-v3 goes cross-platform
- JUCE has built-in AU hosting (`JUCE_PLUGINHOST_AU=1`)
- Deferred until macOS port

---

### 3.7 Full Surround / Spatial Audio

**What it is**: Support for surround sound formats (5.1, 7.1, Atmos-style object-based panning).

#### C++ Backend

- **TrackProcessor channel expansion**:
  - Currently processes mono/stereo. Extend to N channels.
  - `processBlock()` must handle arbitrary channel counts
- **VBAP Panner** (`Source/VBAPPanner.h/cpp`):
  - Vector Base Amplitude Panning for arbitrary speaker layouts
  - Input: source position (azimuth, elevation), speaker layout
  - Output: per-speaker gain coefficients
  - Implementation: ~200 lines, well-documented algorithm
- **Speaker layout configuration**:
  - Preset layouts: stereo, 5.1, 7.1, 7.1.4 (Atmos bed)
  - Custom layout editor (speaker positions)

#### Frontend Changes

- **Panner UI**: Replace linear pan slider with 2D surround panner (circle/sphere)
- **Speaker layout preset selector** in project settings
- **Channel strip**: Show N meters for surround tracks

---

### 3.8 Video Integration

**Current state**: `openVideoFile()` and `getVideoFrame()` exist in NativeBridge but return empty/stub results.

#### C++ Backend

- **VideoReader class** (`Source/VideoReader.h/cpp`)
  - Use FFmpeg libraries (libavformat, libavcodec, libavutil) via `juce::ChildProcess` or direct linking
  - `openFile(path)` — open video, extract audio to WAV for timeline
  - `getFrameAtTime(seconds)` → JPEG/PNG image data (for thumbnail strip)
  - Frame extraction runs on background thread
  - Timecode extraction from video metadata

- **Video preview window**:
  - Separate native window showing video frame synced to transport position
  - Update at display refresh rate (not audio callback rate)
  - Use `juce::OpenGLContext` or platform video APIs for efficient frame display

- **Native functions to complete**:
  - `openVideoFile(path)` → `{ duration, width, height, fps, audioPath }`
  - `getVideoFrame(timeSeconds)` → base64 image data or shared memory handle
  - `closeVideoFile()`

#### Frontend Changes

- **VideoWindow.tsx**: Render video frame synced to playhead using bridge calls
- **Timeline.tsx**: Video thumbnail strip on a dedicated video track
- **Import**: Drag-and-drop video files, auto-extract audio to audio track

---

### 3.9 Timecode / Sync

**What it is**: Synchronize with external hardware/software via SMPTE/LTC timecode, MIDI Time Code (MTC), MIDI Machine Control (MMC), and MIDI Clock.

#### C++ Backend — Implement in phases:

**3.9.1 MIDI Clock Output** (simplest)
- In audio callback: emit MIDI Clock messages (24 ppqn) to selected MIDI output
- Tempo-aware: clock rate follows current BPM
- Start/Stop/Continue messages on transport changes
- ~50 lines in audio callback

**3.9.2 MIDI Clock Input (Sync to External)**
- Listen for MIDI Clock on selected input
- Measure interval between clocks to determine external BPM
- Phase-lock transport to external clock
- Requires PLL (Phase-Locked Loop) for jitter smoothing

**3.9.3 MTC (MIDI Time Code) Send/Receive**
- Full-frame messages and quarter-frame messages
- SMPTE frame rates: 24, 25, 29.97df, 30 fps
- ~200 lines for encoding/decoding

**3.9.4 LTC (Linear Time Code) Output**
- Generate LTC audio signal and output on a dedicated audio channel
- Requires LTC encoder (biphase modulation of SMPTE timecode)
- Use `libltc` library or implement from spec (~300 lines)

#### Frontend Changes

- **SyncSettingsPanel**: Select sync source (internal/MTC/MIDI Clock/LTC)
- **TransportBar.tsx**: Show sync status indicator (locked/unlocked)
- **Time display**: SMPTE timecode format option (HH:MM:SS:FF)

---

### 3.10 Control Surface Support

**What it is**: Support for hardware controllers (faders, knobs, buttons) via standard protocols.

#### Architecture (Modular, Plugin-like — inspired by Ardour)

- **ControlSurfaceManager** (`Source/ControlSurfaceManager.h/cpp`)
  - Manages active control surface connections
  - Routes parameter changes bidirectionally (hardware ↔ DAW)

- **ControlSurface base class** (`Source/ControlSurface.h`)
  ```cpp
  class ControlSurface {
    virtual std::string name() = 0;
    virtual bool connect() = 0;
    virtual void disconnect() = 0;
    virtual void onTrackSelectionChanged(const std::string& trackId) = 0;
    virtual void onParameterChanged(const std::string& trackId, const std::string& param, float value) = 0;
    // Called from audio thread — must be RT-safe
    virtual void process(int numSamples) {}
  };
  ```

#### Implement in order of priority:

**3.10.1 Generic MIDI** (most universal)
- MIDI CC learn: user moves hardware knob → map to DAW parameter
- Configurable CC→parameter mappings stored in JSON
- Bidirectional: CC-in controls DAW, DAW changes send CC-out to update motorized faders
- ~500 lines

**3.10.2 Mackie Control Universal (MCU)**
- Industry standard for control surfaces (Behringer X-Touch, Icon Platform, etc.)
- 8-channel fader banks with bank switching
- Transport controls, jog wheel, V-Pot encoders
- LCD scribble strip updates
- Well-documented protocol — ~1000 lines

**3.10.3 OSC (Open Sound Control)**
- UDP-based, used by TouchOSC, Lemur, custom controllers
- Expose DAW state as OSC addresses: `/track/1/volume`, `/transport/play`, etc.
- Use `juce::OSCSender` / `juce::OSCReceiver` (built into JUCE)
- ~400 lines

#### Frontend Changes

- **ControlSurfaceSettingsPanel**: Select/configure active control surfaces
- **MIDI Learn mode**: Click parameter → move hardware control → mapping saved

---

### 3.11 Scripting Engine Completion (Lua → End-to-End)

**Current state**: `ScriptEngine.cpp` has a Lua 5.4 runtime with `s13.*` API bindings. Scripts can be run from the frontend script editor. But the API coverage is limited.

**What to implement**:

#### C++ Backend — Expand s13.* Lua API

- **Track operations**: `s13.addTrack()`, `s13.removeTrack()`, `s13.getTrackByName()`, `s13.setTrackProperty()`
- **Clip operations**: `s13.splitClip()`, `s13.moveClip()`, `s13.getClipsInRange()`, `s13.setClipProperty()`
- **Transport**: `s13.play()`, `s13.stop()`, `s13.record()`, `s13.getPosition()`, `s13.setPosition()`
- **Selection**: `s13.getSelectedTracks()`, `s13.getSelectedClips()`, `s13.selectClip()`
- **Automation**: `s13.addAutomationPoint()`, `s13.getAutomationPoints()`
- **MIDI**: `s13.addMIDINote()`, `s13.getMIDINotes()`, `s13.transformMIDI()`
- **Markers**: `s13.addMarker()`, `s13.getMarkers()`, `s13.jumpToMarker()`
- **Project**: `s13.save()`, `s13.load()`, `s13.getProjectInfo()`
- **Dialogs**: `s13.alert()`, `s13.confirm()`, `s13.prompt()`, `s13.fileDialog()`
- **Batch processing**: `s13.processFiles()`, `s13.renderRegion()`

#### Frontend Changes

- **ScriptEditor.tsx**: Improve with syntax highlighting, autocompletion of s13.* API
- **Script manager**: Save/load/organize user scripts
- **Script keybindings**: Assign keyboard shortcuts to scripts via action registry

---

### 3.12 Strip Silence

**What it is**: Automatically detect and remove silent sections from audio clips, creating multiple smaller clips.

#### C++ Backend

- **Algorithm**:
  1. Scan audio file for amplitude below threshold (e.g., -48dB)
  2. Track state: in_sound / in_silence
  3. Configurable parameters:
     - Threshold (dB)
     - Minimum silence duration (ms) — don't split on brief gaps
     - Minimum sound duration (ms) — don't create tiny clips
     - Pre-attack (ms) — include audio before transient
     - Post-release (ms) — include audio after sound ends
  4. Return list of non-silent regions: `[{ startSample, endSample }, ...]`

- **Native function**: `detectSilentRegions(filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs)` → regions JSON

#### Frontend Changes

- **StripSilenceDialog.tsx**: Preview dialog showing detected regions before applying
- **useDAWStore.ts**: `stripSilence(clipId, params)`:
  1. Call backend to detect regions
  2. Split clip into multiple clips at detected boundaries
  3. Push undo command

---

### 3.13 Offline Bounce / Freeze Track

**What it is**: Render a track's output (with all FX) to a new audio file, replacing the track's clips. Reduces CPU load from plugins.

#### C++ Backend

- Already partially implemented — `renderProject()` can render individual tracks via stem export
- **New function**: `freezeTrack(trackId)`:
  1. Render the track's output (including all FX) to a new WAV file
  2. Replace the track's clips with a single clip pointing to the bounced file
  3. Bypass all FX on the track (they're baked in)
  4. Store original state for un-freeze

- **Unfreeze**: `unfreezeTrack(trackId)`:
  1. Restore original clips and FX state
  2. Remove bounced file

#### Frontend Changes

- **TrackHeader.tsx**: Freeze/unfreeze button (snowflake icon)
- **useDAWStore.ts**: Track `isFrozen` state, `frozenClipId`, `originalClips`, `originalFX`
- Frozen tracks show a visual indicator (e.g., blue tint, snowflake badge)

---

### 3.14 AAF/OMF Import/Export (Session Interchange)

**What it is**: Import/export projects from/to other DAWs (Pro Tools, Logic, etc.) via AAF (Advanced Authoring Format) or OMF.

#### C++ Backend

- **Option A**: Use `libaaf` (open source AAF library)
  - Parse AAF files to extract: tracks, clips, clip positions, fades, volume, pan
  - Map to Studio13's track/clip model
  - Export: serialize Studio13 project to AAF format

- **Option B**: REAPER-compatible RPP format (simpler, text-based)
  - Parse/generate RPP (REAPER Project) files
  - Many DAWs can import RPP via REAPER as intermediary

- **Recommended**: Start with AAF import (most universal), then add AAF export

---

### 3.15 DDP Export (CD Mastering)

**Current state**: `RenderModal.tsx` has DDP export UI, `exportDDP()` exists in NativeBridge but is a stub.

#### C++ Backend

- **DDP format**: Industry standard for CD replication
  - Write DDP 2.0 files: `DDPID`, `DDPMS`, `IMAGE.DAT`, `SUBCODE.DAT`
  - Track markers from frontend markers (CD track markers)
  - Red Book compliant: 44.1kHz, 16-bit, stereo
  - PQ subcodes for track boundaries, ISRC codes, UPC/EAN

- Libraries: No good open-source DDP libraries. Implement from spec (~500 lines, format is straightforward binary).

---

## Phase 4: Advanced Features

### 4.1 Clip Launch / Trigger System

**What it is**: Ableton Live-style clip launcher for live performance. Grid of clips that can be triggered independently, with quantized launch.

#### C++ Backend

- **TriggerEngine class** (`Source/TriggerEngine.h/cpp`)
  - Grid: N tracks × M slots (like Ableton's session view)
  - Each slot holds an audio or MIDI clip reference
  - `triggerSlot(trackIndex, slotIndex)` — queue clip for launch at next quantize boundary
  - `stopSlot(trackIndex, slotIndex)` — queue stop
  - Quantize options: none, 1/4, 1/2, 1 bar, 2 bars, 4 bars
  - Clip modes: one-shot, loop, gate (play while held)
  - Follow actions: on clip end, trigger next/prev/random/specific slot

- **Audio thread integration**:
  - At each block, check if any triggered clips should start/stop (based on quantize boundary)
  - Mix triggered clips into track output alongside arrangement clips
  - Or: arrangement vs session view mode toggle (like Ableton)

#### Frontend Changes

- **SessionView.tsx**: Grid-based clip launcher view (alternative to arrangement timeline)
- **ClipSlot.tsx**: Individual slot with play/stop/record buttons, clip name, color
- **SceneRow.tsx**: Trigger all clips in a row simultaneously (scene launch)
- Toggle between Arrangement view and Session view

---

### 4.2 Step Sequencer

**What it is**: Grid-based MIDI pattern editor (like drum machines). Each row = pitch, each column = time step.

#### Frontend

- **StepSequencer.tsx**: Grid of buttons, click to toggle notes on/off
- Configure: step count, step size (1/16, 1/8, etc.), velocity per step
- Output to MIDI clip that feeds instrument plugin

#### C++ Backend

- Step sequencer data stored as MIDI events in `MIDIClip`
- Playback via existing MIDI clip → instrument plugin pipeline

---

### 4.3 Built-in Effects (ACE-style)

**What it is**: Ship basic built-in effects so users have something without installing third-party plugins. Ardour has ACE Compressor, ACE EQ, ACE Delay, ACE Reverb, etc.

#### C++ Backend — Implement as JUCE AudioProcessor subclasses

These can be based on the existing S13FX (JSFX) infrastructure or implemented directly:

**Priority order**:
1. **S13 EQ** — Parametric EQ (4-band + HPF + LPF), uses `juce::dsp::IIR::Filter`
2. **S13 Compressor** — Feed-forward compressor with attack/release/threshold/ratio/knee/makeup
3. **S13 Delay** — Stereo delay with tempo sync, feedback, ping-pong mode
4. **S13 Reverb** — Algorithmic reverb (Freeverb-based, `juce::dsp::Reverb`)
5. **S13 Gate** — Noise gate with threshold/attack/hold/release
6. **S13 Chorus** — Stereo chorus with rate/depth/feedback
7. **S13 Limiter** — Brickwall limiter (look-ahead based)
8. **S13 Saturator** — Soft clipping / tape saturation

Each plugin: ~200-400 lines of C++, using JUCE DSP module.

#### Frontend Changes

- Built-in plugins appear in PluginBrowser with a "Built-in" category
- Custom parameter UIs for each (instead of generic slider layout)

---

### 4.4 Sidechain Support

**What it is**: Route audio from one track to a plugin's sidechain input on another track. Essential for sidechain compression (ducking), gating, etc.

#### C++ Backend

- **TrackProcessor changes**:
  - Support sidechain input routing: `setSidechainSource(pluginIndex, sourceTrackId)`
  - Before calling `plugin->processBlock()`, fill sidechain input channels from source track's output buffer
  - Requires processing order: source track must be processed before destination track
  - AudioEngine already has processing order via `processOrderedTracks()` — extend with sidechain dependency graph

#### Frontend Changes

- **FXChainPanel.tsx**: Per-plugin sidechain input selector dropdown
- **RoutingMatrix.tsx**: Show sidechain connections

---

## Phase 5: Cross-Platform & Distribution

### 5.1 macOS Port

- JUCE is cross-platform — C++ code compiles on macOS with minimal changes
- Replace ASIO/WASAPI with CoreAudio backend (JUCE handles this)
- Replace WebView2 with WKWebView (JUCE's `WebBrowserComponent` abstracts this)
- Enable Audio Units hosting (`JUCE_PLUGINHOST_AU=1`)
- Add code signing and notarization for distribution
- Build system: CMake already cross-platform, add macOS targets

### 5.2 Linux Port

- JUCE supports Linux (ALSA, JACK backends)
- Replace WebView2 with WebKitGTK (`WebBrowserComponent` on Linux)
- Enable LV2 plugin hosting (primary format on Linux)
- Package as AppImage or Flatpak
- Test with PipeWire (modern Linux audio)

### 5.3 Installer / Auto-Update

- **Windows**: Create NSIS or WiX installer, include Visual C++ runtime
- **macOS**: Create .dmg with drag-to-Applications
- **Auto-update**: Check for updates on startup, download in background, prompt to install

---

## UI/UX Improvements (DEFERRED — to be addressed after feature implementation)

> These items improve the user experience but are not functional gaps. Address after core feature implementation is complete.

### Visual / Cosmetic

- [ ] **Waveform rendering quality**: Anti-aliased waveforms, colored by clip/track
- [ ] **Clip rendering**: Rounded corners, gradient fills, shadow/glow on selected clips
- [ ] **Fade curve visualization**: Show actual fade curve shape on clip (not just handles)
- [ ] **Automation lane styling**: Bezier curve rendering, filled area under curve, color per parameter
- [ ] **Mixer panel redesign**: More realistic fader graphics, VU-style meters, scribble strips
- [ ] **Theme system**: Multiple built-in themes (dark, light, high-contrast), user-customizable
- [ ] **Track icons**: Custom icons per track (microphone, guitar, drums, etc.)
- [ ] **Clip thumbnails**: Show file name, duration, and mini-waveform on very small clips
- [ ] **Smooth animations**: Animate clip moves, fader changes, panel open/close (60fps CSS transitions)
- [ ] **High-DPI scaling**: Ensure all UI elements are crisp on 4K displays
- [ ] **Color picker improvements**: Better color picker for track/clip colors with presets

### Interaction / Workflow

- [ ] **Drag-and-drop from OS file explorer**: Drag audio files from Windows Explorer onto timeline
- [ ] **Multi-monitor support**: Detachable panels (mixer, piano roll, video) to separate windows
- [ ] **Customizable toolbar**: Let users choose which buttons appear in MainToolbar
- [ ] **Customizable keyboard shortcuts**: Allow rebinding all shortcuts (currently view-only)
- [ ] **Quick-add instrument**: Typing instrument name creates track + loads matching VSTi
- [ ] **Smart tool**: Single tool that switches between select/trim/fade based on cursor position on clip
- [ ] **Snap preview**: Show ghost position when dragging near snap points
- [ ] **Zoom to selection**: Double-click time selection to zoom to fit
- [ ] **Waveform zoom**: Vertical waveform zoom (amplitude scaling) per track
- [ ] **Spectral view**: Option to show spectrogram instead of waveform
- [ ] **Track folders**: Nest tracks inside collapsible folder tracks
- [ ] **Mixer sends section**: Visual send levels on each channel strip

### Performance / Optimization

- [ ] **Waveform rendering virtualization**: Only render visible waveform sections, cull off-screen clips
- [ ] **React rendering optimization**: Profile and eliminate unnecessary re-renders during playback
- [ ] **WebView2 GPU acceleration**: Ensure hardware-accelerated rendering is enabled
- [ ] **Large project handling**: Test and optimize for 100+ tracks, 1000+ clips
- [ ] **Memory management**: Track and limit memory usage for peak caches, plugin state
- [ ] **Startup time**: Profile and optimize cold start (plugin scanning, project loading)
- [ ] **Audio engine efficiency**: SIMD optimizations for mixing, metering, pan law calculations
- [ ] **Lazy peak generation**: Generate peaks on-demand instead of upfront for imported files

### Accessibility

- [ ] **Screen reader support**: ARIA labels for all interactive elements
- [ ] **Keyboard-only navigation**: Full DAW operation without mouse
- [ ] **High-contrast mode**: For visually impaired users
- [ ] **Tooltip improvements**: Consistent, informative tooltips on all controls

---

## Implementation Priority & Dependencies

```
Phase 1 (Wire Frontend to Backend) — Estimated complexity: Medium
├── 1.1 Automation Playback ★★★★★ (HIGHEST PRIORITY — foundational)
│   └── No dependencies
├── 1.2 Tempo Map ★★★★☆
│   └── No dependencies (but affects 1.1 if automation uses beat-time)
├── 1.3 Comping/Takes ★★★☆☆
│   └── Depends on: recording system (already working)
├── 1.4 Razor Editing ★★☆☆☆
│   └── No dependencies (simple bridge sync)
└── 1.5 Track Groups ★★☆☆☆
    └── No dependencies (simple bridge sync)

Phase 2 (Complete Stubs) — Estimated complexity: Medium-High
├── 2.1 MIDI Recording ★★★★☆
│   └── Depends on: MIDIClip (exists), AudioRecorder pattern (exists)
├── 2.2 Time Stretching ★★★★☆
│   └── Depends on: RubberBand library integration
├── 2.3 Pitch Shifting ★★★☆☆
│   └── Depends on: 2.2 (same library)
├── 2.4 SR Conversion on Render ★★☆☆☆
│   └── No dependencies
├── 2.5 Dither ★☆☆☆☆
│   └── No dependencies (20 lines)
└── 2.6 Monitoring FX ★★☆☆☆
    └── No dependencies

Phase 3 (New Features) — Estimated complexity: High
├── 3.1 Punch Recording ★★★☆☆
│   └── Depends on: AudioRecorder (exists)
├── 3.2 Loop Recording ★★★☆☆
│   └── Depends on: 3.1, 1.3 (comping for take management)
├── 3.3 Record-Safe ★☆☆☆☆
│   └── No dependencies (trivial)
├── 3.4 LV2 Plugins ★★★☆☆
│   └── Depends on: JUCE flag + PluginManager refactor
├── 3.5 CLAP Plugins ★★★★☆
│   └── Depends on: clap-juce-extensions library
├── 3.7 Surround/Spatial ★★★★★
│   └── Depends on: TrackProcessor channel expansion
├── 3.8 Video Integration ★★★★☆
│   └── Depends on: FFmpeg linking
├── 3.9 Timecode/Sync ★★★★☆
│   └── Depends on: 1.2 (tempo map)
├── 3.10 Control Surfaces ★★★★☆
│   └── Depends on: JUCE MIDI/OSC (exists)
├── 3.11 Scripting Completion ★★★☆☆
│   └── Depends on: ScriptEngine (exists)
├── 3.12 Strip Silence ★★☆☆☆
│   └── No dependencies
├── 3.13 Freeze Track ★★★☆☆
│   └── Depends on: render system (exists)
├── 3.14 AAF Import/Export ★★★★☆
│   └── Depends on: libaaf library
└── 3.15 DDP Export ★★★☆☆
    └── No dependencies

Phase 4 (Advanced) — Estimated complexity: Very High
├── 4.1 Clip Launch ★★★★★
│   └── Depends on: significant AudioEngine expansion
├── 4.2 Step Sequencer ★★★☆☆
│   └── Depends on: 2.1 (MIDI recording/playback)
├── 4.3 Built-in Effects ★★★☆☆
│   └── No dependencies (JUCE DSP)
└── 4.4 Sidechain ★★★★☆
    └── Depends on: TrackProcessor routing graph

Phase 5 (Cross-Platform) — Estimated complexity: High
├── 5.1 macOS Port ★★★★☆
├── 5.2 Linux Port ★★★★☆
└── 5.3 Installer/Update ★★★☆☆
```

---

## Recommended Implementation Order

**Sprint 1**: Phase 1.1 (Automation) + Phase 2.5 (Dither) + Phase 1.4 (Razor sync) + Phase 1.5 (Track groups sync)
**Sprint 2**: Phase 1.2 (Tempo Map) + Phase 2.6 (Monitoring FX)
**Sprint 3**: Phase 1.3 (Comping/Takes) + Phase 2.1 (MIDI Recording)
**Sprint 4**: Phase 3.1 (Punch Recording) + Phase 3.2 (Loop Recording) + Phase 3.3 (Record-Safe)
**Sprint 5**: Phase 2.2–2.3 (Time Stretch / Pitch Shift) + Phase 2.4 (SR Conversion)
**Sprint 6**: Phase 3.4 (LV2) + Phase 3.5 (CLAP)
**Sprint 7**: Phase 3.10.1 (Generic MIDI Control) + Phase 3.10.3 (OSC)
**Sprint 8**: Phase 3.12 (Strip Silence) + Phase 3.13 (Freeze Track)
**Sprint 9**: Phase 3.11 (Scripting) + Phase 3.10.2 (MCU)
**Sprint 10**: Phase 3.9 (Timecode/Sync)
**Sprint 11**: Phase 3.8 (Video) + Phase 3.15 (DDP)
**Sprint 12**: Phase 3.7 (Surround) + Phase 4.4 (Sidechain)
**Sprint 13**: Phase 4.3 (Built-in Effects)
**Sprint 14**: Phase 4.1 (Clip Launch) + Phase 4.2 (Step Sequencer)
**Sprint 15**: Phase 3.14 (AAF Import/Export)
**Sprint 16+**: Phase 5 (Cross-Platform), UI/UX improvements from deferred list

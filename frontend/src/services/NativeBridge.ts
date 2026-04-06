// Type definitions for the JUCE backend
const FORMANT_LOG_PREFIX = "[pitchEditor.formant]";

function shouldLogPitchEditorFormant() {
  const win = window as Window & { __S13_DEBUG_FORMANT__?: boolean; location?: { hostname?: string } };
  const host = win.location?.hostname ?? "";
  return win.__S13_DEBUG_FORMANT__ === true || host === "localhost" || host === "127.0.0.1";
}

// Pitch Corrector data types
export interface PitchCorrectorData {
  detectedPitch: number;    // Hz
  correctedPitch: number;   // Hz
  confidence: number;       // 0-1
  centsDeviation: number;   // -50 to +50
  noteName: string;         // e.g. "A4"
  key: number;              // 0-11
  scale: number;            // Scale enum
  retuneSpeed: number;      // ms
  humanize: number;         // 0-100
  transpose: number;        // semitones
  correctionStrength: number; // 0-1
  formantCorrection: boolean;
  formantShift: number;     // semitones
  mix: number;              // 0-1
  midiOutput: boolean;      // MIDI output enabled
  midiChannel: number;      // 1-16
  noteEnables: boolean[];   // 12 booleans
}

export interface PitchHistoryFrame {
  detected: number;   // MIDI note (fractional)
  corrected: number;  // MIDI note (fractional)
  confidence: number; // 0-1
}

// Pitch Corrector graphical mode types
export interface PitchNoteData {
  id: string;
  startTime: number;
  endTime: number;
  detectedPitch: number;      // MIDI note (fractional)
  correctedPitch: number;     // MIDI note (fractional)
  driftCorrectionAmount: number; // 0-1
  vibratoDepth: number;       // multiplier
  vibratoRate: number;        // Hz, 0 = original
  transitionIn: number;       // ms
  transitionOut: number;      // ms
  formantShift: number;       // semitones
  gain: number;               // dB
  voiced: boolean;            // true = pitched vocal, false = unvoiced (sibilant/breath)
  pitchDrift: number[];       // per-frame deviation from note center
}

export interface PitchContourData {
  clipId: string;
  sampleRate: number;
  hopSize: number;
  frames: {
    times: number[];
    midi: number[];
    confidence: number[];
    rms: number[];
    voiced: boolean[];
  };
  notes: PitchNoteData[];
}

export interface ClipPitchPreviewPayload {
  pitchSegments: {
    startTime: number;
    endTime: number;
    pitchRatio: number;
  }[];
  globalFormantSemitones?: number;
  previewStartSec?: number;
  previewEndSec?: number;
}

export type PitchCorrectionRenderMode = "single" | "preview_segment" | "full_clip_hq";

// Polyphonic pitch detection types (Phase 6)
export interface PolyNoteData {
  id: string;
  startTime: number;
  endTime: number;
  midiPitch: number;          // integer MIDI note (21-108)
  confidence: number;         // 0-1
  velocity: number;           // 0-1
  correctedPitch: number;     // user-edited (initially = midiPitch)
  formantShift: number;       // semitones
  gain: number;               // dB
}

// Unified note type — superset of mono PitchNoteData + poly PolyNoteData
// Used internally by the pitch editor store so canvas/inspector code works with one type.
export interface UnifiedNoteData extends PitchNoteData {
  confidence: number;         // 0-1 (mono: from YIN, poly: from Basic-Pitch)
  velocity: number;           // 0-1 (poly only, mono defaults to 1)
  isPoly: boolean;            // true if from polyphonic analysis
}

/** Convert a PolyNoteData to UnifiedNoteData (fills in mono-style defaults) */
export function polyToUnified(n: PolyNoteData): UnifiedNoteData {
  return {
    id: n.id,
    startTime: n.startTime,
    endTime: n.endTime,
    detectedPitch: n.midiPitch,
    correctedPitch: n.correctedPitch,
    driftCorrectionAmount: 0,
    vibratoDepth: 1,
    vibratoRate: 0,
    transitionIn: 0,
    transitionOut: 0,
    formantShift: n.formantShift,
    gain: n.gain,
    voiced: true,
    pitchDrift: [],
    confidence: n.confidence,
    velocity: n.velocity,
    isPoly: true,
  };
}

/** Convert a PitchNoteData to UnifiedNoteData (fills in poly-style defaults) */
export function monoToUnified(n: PitchNoteData, confidence?: number): UnifiedNoteData {
  return {
    ...n,
    confidence: confidence ?? 0.9,
    velocity: 1,
    isPoly: false,
  };
}

export interface PolyAnalysisResult {
  clipId: string;
  sampleRate: number;
  hopSize: number;
  pitchSalience: number[][];  // downsampled for visualization
  salienceDownsampleFactor: number;
  notes: PolyNoteData[];
  error?: string;
}

export interface StemSeparationResult {
  success: boolean;
  error?: string;
  stems?: Array<{
    name: string;      // "Drums", "Bass", "Other", "Vocals"
    filePath: string;
  }>;
}

export interface StemSepProgress {
  state: "idle" | "loading" | "analyzing" | "writing" | "done" | "error";
  progress: number;
  stemFiles?: Array<{ name: string; filePath: string }>;
  error?: string;
  backend?: "cuda" | "directml" | "coreml" | "mps" | "cpu";
  accelerationMode?: "auto" | "cpu-only";
  threadCap?: number;
}

export interface ActiveRecordingMIDIPreviewRequest {
  trackId: string;
  generation: number;
  knownEventCount: number;
}

export interface ActiveRecordingMIDIPreviewActiveNote {
  note: number;
  startTimestamp: number;
}

export interface ActiveRecordingMIDIPreviewResponse {
  trackId: string;
  generation: number;
  recordingStartTime: number;
  totalEventCount: number;
  deltaEvents: Array<{
    timestamp: number;
    type: string;
    note?: number;
    velocity?: number;
    channel?: number;
  }>;
  activeNotes: ActiveRecordingMIDIPreviewActiveNote[];
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MixerWindowState {
  isOpen: boolean;
}

export interface MixerUISnapshotEnvelope<T = any> {
  originWindowId: string;
  revision: number;
  payload: T;
}

export interface AiToolsStatus {
    state:
      | "idle"
      | "installing"
      | "checking"
      | "fetching_runtime_manifest"
      | "downloading_runtime"
      | "verifying_runtime_archive"
      | "extracting_runtime"
      | "creating_venv"
      | "verifying_runtime"
      | "probing_runtime"
      | "downloading_model"
      | "pythonMissing"
      | "runtimeMissing"
      | "modelMissing"
      | "ready"
      | "error"
    | "cancelled";
  progress: number;
  available: boolean;
  installerAvailable: boolean;
  pythonDetected: boolean;
    scriptAvailable: boolean;
    runtimeInstalled: boolean;
    modelInstalled: boolean;
    installInProgress: boolean;
    requiresExternalPython: boolean;
    message?: string;
    error?: string;
    errorCode?: string;
    detailLogPath?: string;
    helpUrl?: string;
    installSource?: "downloadedRuntime" | "externalPython" | "none";
    buildRuntimeMode?: "downloaded-runtime" | "unbundled-dev";
    supportedBackends?: string[];
    selectedBackend?: "cuda" | "directml" | "coreml" | "mps" | "cpu";
    runtimeVersion?: string;
    modelVersion?: string;
    verificationMode?: "in-process" | "subprocess";
    runtimeCandidate?: string;
    installSessionId?: string;
    fallbackAttempted?: boolean;
    restartRequired?: boolean;
  }

export interface InstallAiToolsResponse {
  started: boolean;
  error?: string;
  message?: string;
  status?: AiToolsStatus;
}

export interface ARAPluginInfo {
  name: string;
  manufacturer: string;
  pluginId: string;
  category: string;
}

export interface ARAStatus {
  active: boolean;
  activeFxIndex: number;
  lastAttemptFxIndex: number;
  lastAttemptComplete: boolean;
  lastAttemptWasARAPlugin: boolean;
  lastAttemptSucceeded: boolean;
  analysisProgress?: number;
  analysisComplete?: boolean;
  analysisRequested?: boolean;
  analysisStarted?: boolean;
  lastAnalysisProgressValue?: number;
  sourceCount?: number;
  playbackRegionCount?: number;
  audioSourceSamplesAccessEnabled?: boolean;
  editorRendererAttached?: boolean;
  playbackRendererAttached?: boolean;
  error?: string;
}

export interface NativeGlobalShortcutEvent {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  source?: string;
}

// Audio device configuration (matches C++ backend response shape)
export interface AudioDeviceConfig {
  audioDeviceType: string;
  inputDevice: string;
  outputDevice: string;
  sampleRate: number;
  bufferSize: number;
  [key: string]: unknown;
}

export interface AudioDeviceSetupResponse {
  current: AudioDeviceConfig;
  availableTypes?: string[];
  inputs?: string[];
  outputs?: string[];
  sampleRates?: number[];
  bufferSizes?: number[];
  inputChannelNames?: string[];
  outputChannelNames?: string[];
  [key: string]: unknown;
}

// Diagnostic and testing result types
export interface MidiDiagnosticsReport {
  inputDevices: string[];
  outputDevices: string[];
  openDevices: string[];
  lateMidiEvents: number;
  [key: string]: unknown;
}

export interface PluginCapabilities {
  success?: boolean;
  pluginFormat?: string;
  format?: string;
  name?: string;
  vendor?: string;
  category?: string;
  numInputChannels?: number;
  numOutputChannels?: number;
  supportsDouble?: boolean;
  supportsDoublePrecision?: boolean;
  isInstrument?: boolean;
  producesMidi?: boolean;
  isMidiEffect?: boolean;
  hasMidiInput?: boolean;
  hasMidiOutput?: boolean;
  hasEditor?: boolean;
  [key: string]: unknown;
}

export interface BenchmarkResults {
  cpuUsage: number;
  callbackDurationMs: number;
  bufferSize: number;
  sampleRate: number;
  trackCount: number;
  [key: string]: unknown;
}

export interface AudioDebugTrackSnapshot {
  trackId: string;
  clipCount: number;
}

export interface AudioDebugSnapshot {
  transportPlaying: boolean;
  transportRecording: boolean;
  transportPosition: number;
  sampleRate: number;
  blockSize: number;
  playbackClipCount: number;
  activeOutputChannels: number;
  postTrackPlaybackPeak: number;
  postMonitoringInputPeak: number;
  postMasterFxPeak: number;
  postMonitoringFxPeak: number;
  finalOutputPeak: number;
  lastRecordingClipCountReturned: number;
  playbackTracks: AudioDebugTrackSnapshot[];
  [key: string]: unknown;
}

export interface GuardrailsReport {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; message?: string }>;
  [key: string]: unknown;
}

export interface ClipLauncherSlotState {
  trackIndex: number;
  slotIndex: number;
  state: "empty" | "stopped" | "playing" | "queued";
  clipId?: string;
  clipName?: string;
}

export interface ClipLauncherState {
  slots: ClipLauncherSlotState[];
  [key: string]: unknown;
}

// Waveform visualization data type
export interface ChannelPeak {
  min: number;
  max: number;
}

export interface WaveformPeak {
  channels: ChannelPeak[]; // Per-channel peak data
}

// Parse flat peak array from C++: [numChannels, min_ch0_px0, max_ch0_px0, min_ch1_px0, ...]
// into WaveformPeak[] objects.  V8 creates these JS objects orders of magnitude
// faster than C++ DynamicObjects (~84K heap allocs eliminated per 5-min clip).
function parseFlatPeaks(flat: number[]): WaveformPeak[] {
  if (!flat || flat.length < 1) return [];
  const numCh = flat[0];
  const stride = numCh * 2;
  const count = Math.floor((flat.length - 1) / stride);
  const peaks: WaveformPeak[] = new Array(count);
  for (let p = 0; p < count; p++) {
    const base = 1 + p * stride;
    const channels: ChannelPeak[] = new Array(numCh);
    for (let ch = 0; ch < numCh; ch++) {
      channels[ch] = { min: flat[base + ch * 2] || 0, max: flat[base + ch * 2 + 1] || 0 };
    }
    peaks[p] = { channels };
  }
  return peaks;
}

declare global {
  interface Window {
    __JUCE__?: {
      backend: {
        // Native functions registered via withNativeFunction
        addTrack?: (explicitId?: string) => Promise<string>;
        removeTrack?: (trackId: string) => Promise<boolean>;
        reorderTrack?: (
          trackId: string,
          newPosition: number,
        ) => Promise<boolean>;
        getAudioDeviceSetup?: () => Promise<AudioDeviceSetupResponse>;
        setAudioDeviceSetup?: (config: any) => Promise<boolean>;

        // Track Control (Phase 1)
        setTrackRecordArm?: (
          trackId: string,
          armed: boolean,
        ) => Promise<boolean>;
        setTrackInputMonitoring?: (
          trackId: string,
          enabled: boolean,
        ) => Promise<boolean>;
        setTrackInputChannels?: (
          trackId: string,
          startChannel: number,
          numChannels: number,
        ) => Promise<boolean>;

        // Volume/Pan/Mute/Solo (Phase 1)
        setTrackVolume?: (
          trackId: string,
          volumeDB: number,
        ) => Promise<boolean>;
        setTrackPan?: (trackId: string, pan: number) => Promise<boolean>;
        setTrackMute?: (trackId: string, muted: boolean) => Promise<boolean>;
        setTrackSolo?: (trackId: string, soloed: boolean) => Promise<boolean>;

        // Transport (Phase 2)
        setTransportPlaying?: (playing: boolean) => Promise<boolean>;
        setTransportRecording?: (recording: boolean) => Promise<boolean>;
        setTempo?: (bpm: number) => Promise<boolean>;
        getTempo?: () => Promise<number>;
        getTransportPosition?: () => Promise<number>;
        setTransportPosition?: (seconds: number) => Promise<boolean>;

        // Punch In/Out (Phase 3.1)
        setPunchRange?: (startTime: number, endTime: number, enabled: boolean) => Promise<boolean>;

        // Record-Safe (Phase 3.3)
        setTrackRecordSafe?: (trackId: string, safe: boolean) => Promise<boolean>;
        getTrackRecordSafe?: (trackId: string) => Promise<boolean>;

        // Metronome & Time Signature (Phase 3)
        setMetronomeEnabled?: (enabled: boolean) => Promise<boolean>;
        setMetronomeVolume?: (volume: number) => Promise<boolean>;
        isMetronomeEnabled?: () => Promise<boolean>;
        setTimeSignature?: (
          numerator: number,
          denominator: number,
        ) => Promise<boolean>;
        getTimeSignature?: () => Promise<{
          numerator: number;
          denominator: number;
        }>;
        setMetronomeAccentBeats?: (accentBeats: boolean[]) => Promise<boolean>;
        renderMetronomeToFile?: (startTime: number, endTime: number) => Promise<string>;

        // Recording
        getLastCompletedClips?: () => Promise<
          Array<{
            trackId: string;
            filePath: string;
            startTime: number;
            duration: number;
          }>
        >;
        getLastCompletedMIDIClips?: () => Promise<
          Array<{
            trackId: string;
            startTime: number;
            duration: number;
            filePath?: string;
            events: Array<{
              timestamp: number;
              type: string;
              note?: number;
              velocity?: number;
              controller?: number;
              value?: number;
              channel?: number;
            }>;
          }>
        >;
        getActiveRecordingMIDIPreviews?: (
          requests: ActiveRecordingMIDIPreviewRequest[],
        ) => Promise<ActiveRecordingMIDIPreviewResponse[]>;
        // Live recording waveform - returns peaks for recording in progress
        getRecordingPeaks?: (
          trackId: string,
          samplesPerPixel: number,
          numPixels: number,
        ) => Promise<WaveformPeak[]>;

        // FX Management (Phase 3)
        scanForPlugins?: () => Promise<boolean>;
        getAvailablePlugins?: () => Promise<any[]>;
        addTrackInputFX?: (
          trackId: string,
          pluginPath: string,
          openEditor?: boolean,
        ) => Promise<boolean>;
        addTrackFX?: (trackId: string, pluginPath: string, openEditor?: boolean) => Promise<boolean>;
        openPluginEditor?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
        ) => Promise<boolean>;
        closePluginEditor?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
        ) => Promise<boolean>;
        closeAllPluginWindows?: () => Promise<boolean>;

        // Metering (Phase 4)
        getMeterLevels?: () => Promise<number[]>;
        getMasterLevel?: () => Promise<number>;
        resetMeterClip?: (trackId: string) => Promise<boolean>;

        // Master (Phase 5)
        addMasterFX?: (pluginPath: string) => Promise<boolean>;
        getMasterFX?: () => Promise<any[]>;
        removeMasterFX?: (fxIndex: number) => Promise<boolean>;
        openMasterFXEditor?: (fxIndex: number) => Promise<boolean>;
        setMasterVolume?: (volume: number) => Promise<boolean>;
        setMasterPan?: (pan: number) => Promise<boolean>;
        getMasterPan?: () => Promise<number>;
        setMasterMono?: (mono: boolean) => Promise<boolean>;
        getMasterMono?: () => Promise<boolean>;

        // Monitoring FX (Phase 2.6)
        addMonitoringFX?: (pluginPath: string) => Promise<boolean>;
        getMonitoringFX?: () => Promise<any[]>;
        removeMonitoringFX?: (fxIndex: number) => Promise<boolean>;
        openMonitoringFXEditor?: (fxIndex: number) => Promise<boolean>;
        bypassMonitoringFX?: (fxIndex: number, bypassed: boolean) => Promise<boolean>;

        // Waveform Visualization
        getWaveformPeaks?: (
          filePath: string,
          samplesPerPixel: number,
          startSample: number,
          numPixels: number,
        ) => Promise<WaveformPeak[]>;

        // Playback clip management
        addPlaybackClip?: (
          trackId: string,
          filePath: string,
          startTime: number,
          duration: number,
          offset: number,
          volumeDB: number,
          fadeIn: number,
          fadeOut: number,
          clipId: string,
          pitchCorrectionSourceFilePath?: string,
          pitchCorrectionSourceOffset?: number,
        ) => Promise<boolean>;
        addPlaybackClipsBatch?: (clipsJSON: string) => Promise<boolean>;
        removePlaybackClip?: (
          trackId: string,
          filePath: string,
        ) => Promise<boolean>;
        clearPlaybackClips?: () => Promise<boolean>;

        // Automation (Phase 1.1)
        setAutomationPoints?: (trackId: string, parameterId: string, pointsJSON: string) => Promise<boolean>;
        setAutomationMode?: (trackId: string, parameterId: string, mode: string) => Promise<boolean>;
        getAutomationMode?: (trackId: string, parameterId: string) => Promise<string>;
        clearAutomation?: (trackId: string, parameterId: string) => Promise<boolean>;
        beginTouchAutomation?: (trackId: string, parameterId: string) => Promise<boolean>;
        endTouchAutomation?: (trackId: string, parameterId: string) => Promise<boolean>;

        // Tempo Map (Phase 1.2)
        setTempoMarkers?: (markersJSON: string) => Promise<boolean>;
        clearTempoMarkers?: () => Promise<boolean>;

        // FX Chain Management
        getTrackInputFX?: (trackId: string) => Promise<any[]>;
        getTrackFX?: (trackId: string) => Promise<any[]>;
        removeTrackInputFX?: (
          trackId: string,
          fxIndex: number,
        ) => Promise<boolean>;
        removeTrackFX?: (trackId: string, fxIndex: number) => Promise<boolean>;
        bypassTrackInputFX?: (
          trackId: string,
          fxIndex: number,
          bypassed: boolean,
        ) => Promise<boolean>;
        bypassTrackFX?: (
          trackId: string,
          fxIndex: number,
          bypassed: boolean,
        ) => Promise<boolean>;
        reorderTrackInputFX?: (
          trackId: string,
          fromIndex: number,
          toIndex: number,
        ) => Promise<boolean>;
        reorderTrackFX?: (
          trackId: string,
          fromIndex: number,
          toIndex: number,
        ) => Promise<boolean>;

        // S13FX (JSFX) Management
        addTrackS13FX?: (
          trackId: string,
          scriptPath: string,
          isInputFX?: boolean,
        ) => Promise<boolean>;
        addMasterS13FX?: (scriptPath: string) => Promise<boolean>;
        getS13FXSliders?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
        ) => Promise<any[]>;
        setS13FXSlider?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
          sliderIndex: number,
          value: number,
        ) => Promise<boolean>;
        reloadS13FX?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
        ) => Promise<boolean>;
        getAvailableS13FX?: () => Promise<any[]>;
        openUserEffectsFolder?: () => Promise<boolean>;

        // Built-in FX Presets
        getBuiltInFXPresets?: (pluginName: string) => Promise<any[]>;
        saveBuiltInFXPreset?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
          presetName: string,
        ) => Promise<boolean>;
        loadBuiltInFXPreset?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
          presetName: string,
        ) => Promise<boolean>;
        deleteBuiltInFXPreset?: (
          pluginName: string,
          presetName: string,
        ) => Promise<boolean>;

        // Lua Scripting (S13Script)
        runScript?: (scriptPath: string) => Promise<{ success: boolean; output: string; error?: string }>;
        runScriptCode?: (code: string) => Promise<{ success: boolean; output: string; error?: string }>;
        getScriptDirectory?: () => Promise<string>;
        listScripts?: () => Promise<Array<{ name: string; filePath: string; description: string; isStock: boolean }>>;

        // MIDI Device Management (Phase 2)
        getMIDIInputDevices?: () => Promise<string[]>;
        getMIDIOutputDevices?: () => Promise<string[]>;
        openMIDIDevice?: (deviceName: string) => Promise<boolean>;
        closeMIDIDevice?: (deviceName: string) => Promise<boolean>;
        getOpenMIDIDevices?: () => Promise<string[]>;

        // Track Type Management (Phase 2)
        setTrackType?: (
          trackId: string,
          type: "audio" | "midi" | "instrument",
        ) => Promise<boolean>;
        setTrackMIDIInput?: (
          trackId: string,
          deviceName: string,
          channel: number,
        ) => Promise<boolean>;
        setTrackMIDIClips?: (trackId: string, clipsJSON: string) => Promise<boolean>;
        loadInstrument?: (trackId: string, vstPath: string) => Promise<boolean>;
        openInstrumentEditor?: (trackId: string) => Promise<boolean>;

        // Project Save/Load (F2)
        showSaveDialog?: (
          defaultPath?: string,
          title?: string,
          filters?: string,
        ) => Promise<string>;
        showOpenDialog?: (title?: string, filters?: string) => Promise<string>;
        openFileExternal?: (path: string) => Promise<boolean>;
        saveProjectToFile?: (
          filePath: string,
          jsonContent: string,
        ) => Promise<boolean>;
        loadProjectFromFile?: (filePath: string) => Promise<string>;
        consumePendingLaunchProjectPath?: () => Promise<string>;

        // Plugin State Serialization (F2)
        getPluginState?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
        ) => Promise<string>;
        setPluginState?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
          base64State: string,
        ) => Promise<boolean>;
        getMasterPluginState?: (fxIndex: number) => Promise<string>;
        setMasterPluginState?: (
          fxIndex: number,
          base64State: string,
        ) => Promise<boolean>;

        // MIDI
        getAudioDebugSnapshot?: () => Promise<AudioDebugSnapshot>;
        sendMidiNote?: (
          trackId: string,
          note: number,
          velocity: number,
          isNoteOn: boolean,
        ) => Promise<void>;
        getMidiDiagnostics?: () => Promise<MidiDiagnosticsReport>;
        getPluginCapabilities?: (pluginPath: string) => Promise<PluginCapabilities>;
        setProcessingPrecision?: (mode: "float32" | "hybrid64") => Promise<boolean>;
        getProcessingPrecision?: () => Promise<"float32" | "hybrid64">;
        getPluginCompatibilityMatrix?: () => Promise<Record<string, PluginCapabilities>>;
        runEngineBenchmarks?: () => Promise<BenchmarkResults>;
        setTrackPluginPrecisionOverride?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
          mode: "auto" | "float32",
        ) => Promise<boolean>;
        setInstrumentPrecisionOverride?: (
          trackId: string,
          mode: "auto" | "float32",
        ) => Promise<boolean>;
        setMasterFXPrecisionOverride?: (
          fxIndex: number,
          mode: "auto" | "float32",
        ) => Promise<boolean>;
        bypassMasterFX?: (fxIndex: number, bypassed: boolean) => Promise<boolean>;
        setMonitoringFXPrecisionOverride?: (
          fxIndex: number,
          mode: "auto" | "float32",
        ) => Promise<boolean>;
        runReleaseGuardrails?: () => Promise<GuardrailsReport>;
        runAutomatedRegressionSuite?: () => Promise<GuardrailsReport>;
        getAppVersion?: () => Promise<string>;
        checkForUpdates?: (manual?: boolean) => Promise<any>;
        downloadAndInstallUpdate?: (
          downloadUrl: string,
          version?: string,
          sha256?: string,
          releasePageUrl?: string,
          installerArguments?: string,
          size?: number,
        ) => Promise<any>;
        openExternalURL?: (url: string) => Promise<boolean>;

        // Media Import (F10)
        importMediaFile?: (filePath: string) => Promise<{
          filePath: string;
          duration: number;
          sampleRate: number;
          numChannels: number;
          format: string;
        }>;

        // File drop support — save base64-encoded file to disk
        saveDroppedFile?: (fileName: string, base64Data: string) => Promise<string>;

        // Render/Export (F3)
        showRenderSaveDialog?: (defaultFileName: string, formatExtension: string) => Promise<string>;
        renderProject?: (
          source: string, startTime: number, endTime: number,
          filePath: string, format: string, sampleRate: number,
          bitDepth: number, channels: number, normalize: boolean,
          addTail: boolean, tailLength: number,
        ) => Promise<boolean>;
        renderProjectWithDither?: (
          source: string, startTime: number, endTime: number,
          filePath: string, format: string, sampleRate: number,
          bitDepth: number, channels: number, normalize: boolean,
          addTail: boolean, tailLength: number, ditherType: string,
        ) => Promise<boolean>;

        // Phase 9: Audio Engine Enhancements
        reverseAudioFile?: (filePath: string) => Promise<string>;
        detectTransients?: (filePath: string, sensitivity: number, minGapMs: number) => Promise<number[]>;
        setMetronomeClickSound?: (filePath: string) => Promise<boolean>;
        setMetronomeAccentSound?: (filePath: string) => Promise<boolean>;
        resetMetronomeSounds?: () => Promise<boolean>;
        measureLUFS?: (filePath: string, startTime?: number, endTime?: number) => Promise<{
          integrated: number;
          shortTerm: number;
          momentary: number;
          truePeak: number;
          range: number;
        }>;

        // Phase 11: Send/Bus Routing
        addTrackSend?: (sourceTrackId: string, destTrackId: string) => Promise<number>;
        removeTrackSend?: (sourceTrackId: string, sendIndex: number) => Promise<boolean>;
        setTrackSendLevel?: (sourceTrackId: string, sendIndex: number, level: number) => Promise<boolean>;
        setTrackSendPan?: (sourceTrackId: string, sendIndex: number, pan: number) => Promise<boolean>;
        setTrackSendEnabled?: (sourceTrackId: string, sendIndex: number, enabled: boolean) => Promise<boolean>;
        setTrackSendPreFader?: (sourceTrackId: string, sendIndex: number, preFader: boolean) => Promise<boolean>;
        setTrackSendPhaseInvert?: (sourceTrackId: string, sendIndex: number, invert: boolean) => Promise<boolean>;
        getTrackSends?: (trackId: string) => Promise<Array<{ destTrackId: string; level: number; pan: number; enabled: boolean; preFader: boolean; phaseInvert: boolean }>>;

        // Track Routing Features
        setTrackPhaseInvert?: (trackId: string, invert: boolean) => Promise<boolean>;
        getTrackPhaseInvert?: (trackId: string) => Promise<boolean>;
        setTrackStereoWidth?: (trackId: string, widthPercent: number) => Promise<boolean>;
        getTrackStereoWidth?: (trackId: string) => Promise<number>;
        setTrackMasterSendEnabled?: (trackId: string, enabled: boolean) => Promise<boolean>;
        getTrackMasterSendEnabled?: (trackId: string) => Promise<boolean>;
        setTrackOutputChannels?: (trackId: string, startChannel: number, numChannels: number) => Promise<boolean>;
        setTrackPlaybackOffset?: (trackId: string, offsetMs: number) => Promise<boolean>;
        getTrackPlaybackOffset?: (trackId: string) => Promise<number>;
        setTrackChannelCount?: (trackId: string, numChannels: number) => Promise<boolean>;
        getTrackChannelCount?: (trackId: string) => Promise<number>;
        setTrackMIDIOutput?: (trackId: string, deviceName: string) => Promise<boolean>;
        getTrackMIDIOutput?: (trackId: string) => Promise<string>;
        getTrackRoutingInfo?: (trackId: string) => Promise<{
          phaseInverted: boolean; stereoWidth: number; masterSendEnabled: boolean;
          outputStartChannel: number; outputChannelCount: number; playbackOffsetMs: number;
          trackChannelCount: number; midiOutputDevice: string;
        }>;

        // Phase 12: Media & File Management
        browseDirectory?: (path: string) => Promise<Array<{
          name: string; path: string; size: number; isDirectory: boolean;
          format: string; duration: number; sampleRate: number; numChannels: number;
        }>>;
        previewAudioFile?: (path: string) => Promise<boolean>;
        stopPreview?: () => Promise<boolean>;
        cleanProjectDirectory?: (projectDir: string, referencedFiles: string[]) => Promise<{
          orphanedFiles: Array<{ path: string; size: number }>;
          totalSize: number;
        }>;
        deleteFiles?: (filePaths: string[]) => Promise<{ deleted: number; errors: string[] }>;
        exportProjectMIDI?: (filePath: string, midiTracks: any[]) => Promise<boolean>;
        convertAudioFile?: (inputPath: string, outputPath: string, format: string, sampleRate: number, bitDepth: number, channels: number) => Promise<boolean>;
        getHomeDirectory?: () => Promise<string>;

        // Phase 13: Advanced Editing
        timeStretchClip?: (filePath: string, factor: number) => Promise<string | { success: boolean; filePath?: string; duration?: number; sampleRate?: number }>;
        pitchShiftClip?: (filePath: string, semitones: number) => Promise<string | { success: boolean; filePath?: string; duration?: number; sampleRate?: number }>;

        // Phase 3.10: Control Surface Support
        connectMIDIControlSurface?: (inputName: string, outputName: string) => Promise<boolean>;
        disconnectMIDIControlSurface?: () => Promise<boolean>;
        startMIDILearn?: (trackId: string, parameter: string) => Promise<boolean>;
        cancelMIDILearn?: () => Promise<boolean>;
        getMIDIMappings?: () => Promise<Array<{ channel: number; cc: number; trackId: string; parameter: string }>>;
        addMIDIMapping?: (channel: number, cc: number, trackId: string, parameter: string) => Promise<boolean>;
        removeMIDIMapping?: (channel: number, cc: number) => Promise<boolean>;
        connectOSC?: (receivePort: number, sendHost: string, sendPort: number) => Promise<boolean>;
        disconnectOSC?: () => Promise<boolean>;
        getControlSurfaceMIDIDevices?: () => Promise<{ inputs: string[]; outputs: string[] }>;

        // Phase 3.9: Timecode / Sync
        connectMIDIClockOutput?: (midiOutputName: string) => Promise<boolean>;
        setMIDIClockOutputEnabled?: (enabled: boolean) => Promise<boolean>;
        connectMIDIClockInput?: (midiInputName: string) => Promise<boolean>;
        setMIDIClockInputEnabled?: (enabled: boolean) => Promise<boolean>;
        connectMTCOutput?: (midiOutputName: string) => Promise<boolean>;
        setMTCEnabled?: (enabled: boolean) => Promise<boolean>;
        setMTCFrameRate?: (rate: number) => Promise<boolean>;
        connectMTCInput?: (midiInputName: string) => Promise<boolean>;
        setSyncSource?: (source: string) => Promise<boolean>;
        getSyncStatus?: () => Promise<{ locked: boolean; source: string; externalBPM: number; mtcPosition: number }>;

        // Phase 3.10.2: MCU (Mackie Control Universal)
        connectMCU?: (inputName: string, outputName: string) => Promise<boolean>;
        disconnectMCU?: () => Promise<boolean>;
        setMCUBankOffset?: (offset: number) => Promise<boolean>;

        // Phase 3.12: Strip Silence
        detectSilentRegions?: (filePath: string, thresholdDb: number, minSilenceMs: number,
                               minSoundMs: number, preAttackMs: number, postReleaseMs: number) =>
          Promise<Array<{ startTime: number; endTime: number; startSample: number; endSample: number }>>;

        // Phase 4.1: Clip Launch
        triggerSlot?: (trackIndex: number, slotIndex: number) => Promise<boolean>;
        stopSlot?: (trackIndex: number, slotIndex: number) => Promise<boolean>;
        triggerScene?: (slotIndex: number) => Promise<boolean>;
        stopAllSlots?: () => Promise<boolean>;
        setSlotClip?: (trackIndex: number, slotIndex: number, filePath: string, duration: number) => Promise<boolean>;
        clearSlot?: (trackIndex: number, slotIndex: number) => Promise<boolean>;
        getClipLauncherState?: () => Promise<ClipLauncherState>;

        // Phase 3.14: Session Interchange (AAF/RPP/EDL)
        importSession?: (filePath: string) => Promise<{ success: boolean; tempo?: number; sampleRate?: number; tracks?: any[]; error?: string }>;
        exportSession?: (filePath: string, format: string, sessionData: any) => Promise<boolean>;

        // Phase 3.13: Freeze Track
        freezeTrack?: (trackId: string) => Promise<{ success: boolean; filePath?: string; duration?: number; sampleRate?: number; startTime?: number; error?: string }>;
        unfreezeTrack?: (trackId: string) => Promise<boolean>;

        // Phase 4.3: Built-in Effects
        addTrackBuiltInFX?: (trackId: string, effectName: string, isInputFX?: boolean) => Promise<boolean>;
        addMasterBuiltInFX?: (effectName: string) => Promise<boolean>;
        getAvailableBuiltInFX?: () => Promise<Array<{ name: string; category: string }>>;

        // Phase 4.4: Sidechain Routing
        setSidechainSource?: (destTrackId: string, pluginIndex: number, sourceTrackId: string) => Promise<boolean>;
        clearSidechainSource?: (destTrackId: string, pluginIndex: number) => Promise<boolean>;
        getSidechainSource?: (destTrackId: string, pluginIndex: number) => Promise<string>;

        // Phase 3.7: Surround / Spatial Audio
        getSurroundLayouts?: () => Promise<Array<{ name: string; channels: number }>>;

        // Phase 15: Platform & Extensibility
        openVideoFile?: (filePath: string) => Promise<{ width: number; height: number; duration: number; fps: number; filePath: string; audioPath?: string; error?: string }>;
        getVideoFrame?: (time: number, width?: number, height?: number) => Promise<string>; // base64 image data
        closeVideoFile?: () => void;
        executeScript?: (code: string) => Promise<{ result: string; error: string }>;
        loadScriptFile?: (filePath: string) => Promise<{ result: string; error: string }>;
        setLTCOutput?: (enabled: boolean, channel: number, frameRate: number) => Promise<boolean>;

        // Phase 16: Pro Audio & Compatibility
        startLiveCapture?: (format: string) => Promise<string>; // returns filePath
        stopLiveCapture?: () => Promise<{ filePath: string; duration: number }>;
        exportDDP?: (sourceWavPath: string, outputDir: string, tracks: any[], catalogNumber?: string) => Promise<boolean>;

        // Sprint 16: Performance + Audio Quality
        setPanLaw?: (law: string) => Promise<boolean>;
        getPanLaw?: () => Promise<string>;
        setTrackDCOffset?: (trackId: string, enabled: boolean) => Promise<boolean>;

        // Sprint 19: Plugin Management
        getPluginParameters?: (trackId: string, fxIndex: number, isInputFX: boolean) => Promise<Array<{ index: number; name: string; value: number; text: string }>>;
        setPluginParameter?: (trackId: string, fxIndex: number, isInputFX: boolean, paramIndex: number, value: number) => Promise<boolean>;
        getPluginPresets?: (trackId: string, fxIndex: number, isInputFX: boolean) => Promise<string[]>;
        loadPluginPreset?: (trackId: string, fxIndex: number, isInputFX: boolean, presetName: string) => Promise<boolean>;
        savePluginPreset?: (trackId: string, fxIndex: number, isInputFX: boolean, presetName: string) => Promise<boolean>;

        // Sprint 19: MIDI Learn (plugin params)
        startPluginMIDILearn?: (trackId: string, pluginIndex: number, paramIndex: number) => Promise<boolean>;
        cancelPluginMIDILearn?: () => Promise<boolean>;

        // Sprint 19: MIDI Import/Export
        importMIDIFile?: (filePath: string) => Promise<{ success: boolean; tracks: Array<{ name: string; channel: number; events: any[] }>; error?: string }>;
        exportMIDIFile?: (filePath: string, tracksJSON: string) => Promise<boolean>;

        // Sprint 19: A/B Plugin Comparison
        storePluginStateA?: (trackId: string, fxIndex: number, isInputFX: boolean) => Promise<boolean>;
        storePluginStateB?: (trackId: string, fxIndex: number, isInputFX: boolean) => Promise<boolean>;
        recallPluginStateA?: (trackId: string, fxIndex: number, isInputFX: boolean) => Promise<boolean>;
        recallPluginStateB?: (trackId: string, fxIndex: number, isInputFX: boolean) => Promise<boolean>;

        // Sprint 20: Metering & Analysis
        getLoudnessData?: () => Promise<{ integrated: number; shortTerm: number; momentary: number; truePeak: number; range: number }>;
        getPhaseCorrelation?: () => Promise<number>;
        getSpectrumData?: () => Promise<number[]>;

        // Channel Strip EQ (Phase 19.18)
        setChannelStripEQEnabled?: (trackId: string, enabled: boolean) => Promise<boolean>;
        setChannelStripEQParam?: (trackId: string, paramIndex: number, value: number) => Promise<boolean>;
        getChannelStripEQParam?: (trackId: string, paramIndex: number) => Promise<number>;

        // Pitch Corrector (auto mode)
        getPitchCorrectorData?: (trackId: string, fxIndex: number) => Promise<PitchCorrectorData>;
        setPitchCorrectorParam?: (trackId: string, fxIndex: number, param: string, value: number) => Promise<boolean>;
        getPitchHistory?: (trackId: string, fxIndex: number, numFrames: number) => Promise<PitchHistoryFrame[]>;

        // Pitch Corrector (graphical mode)
        analyzePitchContour?: (trackId: string, clipId: string) => Promise<PitchContourData>;
        analyzePitchContourDirect?: (filePath: string, offset: number, duration: number, clipId: string) => Promise<PitchContourData>;
        getLastPitchAnalysisResult?: () => Promise<PitchContourData>;
        applyPitchCorrection?: (trackId: string, clipId: string, notes: PitchNoteData[], frames?: PitchContourData['frames'], requestId?: string, globalFormantSemitones?: number, windowStartSec?: number, windowEndSec?: number, renderMode?: PitchCorrectionRenderMode, requestGroupId?: string) => Promise<{ outputFile: string; success: boolean }>;
        previewPitchCorrection?: (trackId: string, clipId: string, notes: PitchNoteData[]) => Promise<{ outputFile: string; success: boolean }>;

        // Polyphonic Pitch Detection (Phase 6)
        analyzePolyphonic?: (trackId: string, clipId: string, options?: { noteThreshold?: number; onsetThreshold?: number; minDurationMs?: number }) => Promise<PolyAnalysisResult>;
        extractMidiFromAudio?: (trackId: string, clipId: string) => Promise<PolyAnalysisResult>;
        isPolyphonicDetectionAvailable?: () => Promise<boolean>;

        // Polyphonic Pitch Editing (Phase 7)
        applyPolyPitchCorrection?: (trackId: string, clipId: string, editedNotes: any[]) => Promise<{ outputFile: string; success: boolean }>;
        soloPolyNote?: (trackId: string, clipId: string, noteId: string) => Promise<{ outputFile: string; success: boolean }>;
        setPitchCorrectionBypass?: (trackId: string, clipId: string, bypass: boolean) => Promise<void>;

        // Real-time pitch preview (Phase 7.5)
        setClipPitchPreview?: (clipId: string, payload: ClipPitchPreviewPayload) => Promise<boolean>;
        clearClipPitchPreview?: (clipId: string) => Promise<boolean>;
        clearClipRenderedPreviewSegments?: (clipId: string) => Promise<boolean>;

        // Source Separation (Phase 8 + Phase 10)
        separateStems?: (trackId: string, clipId: string) => Promise<StemSeparationResult>;
        isStemSeparationAvailable?: () => Promise<boolean>;
        getAiToolsStatus?: () => Promise<AiToolsStatus>;
        refreshAiToolsStatus?: () => Promise<AiToolsStatus>;
        installAiTools?: () => Promise<InstallAiToolsResponse>;
        separateStemsAsync?: (trackId: string, clipId: string, optionsJSON: string) => Promise<{ started: boolean; error?: string; cached?: boolean }>;
        getStemSeparationProgress?: () => Promise<StemSepProgress>;
        cancelStemSeparation?: () => Promise<void>;
        cancelAiToolsInstall?: () => Promise<void>;

        // ARA Plugin Hosting (Phase 9)
        initializeARA?: (trackId: string, fxIndex: number) => Promise<{ success: boolean; error?: string }>;
        addARAClip?: (trackId: string, clipId: string) => Promise<{ success: boolean; error?: string }>;
        removeARAClip?: (trackId: string, clipId: string) => Promise<{ success: boolean }>;
        getARAStatus?: (trackId: string) => Promise<ARAStatus>;
        shutdownARA?: (trackId: string) => Promise<{ success: boolean }>;
        isARAActive?: (trackId: string) => Promise<boolean>;
        hasAnyActiveARA?: () => Promise<boolean>;

        // Clip Gain Envelope
        setClipGainEnvelope?: (trackId: string, clipId: string, envelopeJSON: string) => Promise<boolean>;

        // Timecode Sync (additional)
        setTimecodeFrameRate?: (fps: string) => Promise<boolean>;
        setTimecodeMIDIDevice?: (deviceId: string, isInput: boolean) => Promise<boolean>;

        // Sprint 20: File System Helpers
        browseForFile?: (title: string, filters?: string) => Promise<string>;
        browseForFolder?: (title: string) => Promise<string>;
        fileExists?: (filePath: string) => Promise<boolean>;

        // Sprint 20: Session Archive
        archiveSession?: (projectDir: string, outputPath: string) => Promise<boolean>;

        // Window Management
        minimizeWindow?: () => Promise<void>;
        maximizeWindow?: () => Promise<boolean>; // returns new isMaximized state
        closeWindow?: () => Promise<void>;
        isWindowMaximized?: () => Promise<boolean>;
        startWindowDrag?: () => Promise<void>;
        openMixerWindow?: (bounds?: Partial<WindowBounds>) => Promise<boolean>;
        closeMixerWindow?: () => Promise<boolean>;
        getMixerWindowState?: () => Promise<MixerWindowState>;
        publishMixerUISnapshot?: (snapshot: any) => Promise<boolean>;
        getMixerUISnapshot?: () => Promise<any>;
        reportFrontendStartupState?: (state: string, detail?: string) => Promise<boolean>;
        getStartupDiagnostics?: () => Promise<any>;

        // Event system
        addEventListener?: (
          eventId: string,
          callback: (data: any) => void,
        ) => string;
        removeEventListener?: (token: string) => void;
        emitEvent?: (eventId: string, data: any) => void;
      };
    };
  }
}

export interface StretchResult {
  success: boolean;
  filePath?: string;
  duration?: number;
  sampleRate?: number;
}

class NativeBridge {
  private isNative: boolean;
  private eventListeners: Map<string, Set<(data: any) => void>> = new Map();

  private getBackend() {
    return typeof window !== "undefined" ? window.__JUCE__?.backend : undefined;
  }

  constructor() {
    const juce = typeof window !== "undefined" ? window.__JUCE__ : undefined;
    this.isNative = typeof juce !== "undefined";
    if (this.isNative) {
      console.log("NativeBridge: JUCE Object found.");

      // Debugging: Alert the available keys to see what we are working with
      const backend = juce?.backend;
      if (backend) {
        const keys = Object.keys(backend);
        console.log("NativeBridge: Backend keys:", keys);
        console.log("NativeBridge: Functions available:", {
          addTrack: typeof backend.addTrack,
          removeTrack: typeof backend.removeTrack,
          getAudioDeviceSetup: typeof backend.getAudioDeviceSetup,
          addEventListener: typeof backend.addEventListener,
        });

        // CRITICAL: If no functions are exposed, alert
        if (!backend.addTrack && !backend.getAudioDeviceSetup) {
          alert(
            "CRITICAL: Native functions NOT exposed!\nOnly keys: " +
              JSON.stringify(keys) +
              "\n\nFalling back to MOCK data!",
          );
        }
      } else {
        alert("CRITICAL ERROR: window.__JUCE__.backend is missing!");
      }
    } else {
      console.log(
        "NativeBridge: Running in browser mode (no JUCE), using mock data",
      );
    }
  }

  // Subscribe to peak-cache-ready events emitted by C++ after background peak generation.
  // Returns an unsubscribe function (or no-op in dev mode).
  onPeaksReady(callback: (filePath: string) => void): () => void {
    const backend = this.getBackend();
    if (this.isNative && backend?.addEventListener) {
      const listener = backend.addEventListener(
        "peaksReady",
        (data: any) => callback(data?.filePath ?? ""),
      );
      return () => backend?.removeEventListener?.(listener);
    }
    return () => {};
  }

  // Subscribe to pitch analysis completion events from C++ background thread.
  // Returns an unsubscribe function (or no-op in dev mode).
  onPitchAnalysisComplete(callback: (data: PitchContourData) => void): () => void {
    const backend = this.getBackend();
    if (this.isNative && backend?.addEventListener) {
      const listener = backend.addEventListener(
        "pitchAnalysisComplete",
        (data: any) => callback(data),
      );
      return () => backend?.removeEventListener?.(listener);
    }
    return () => {};
  }

  // Subscribe to pitch correction completion events (emitted when WORLD vocoder finishes).
  // Returns an unsubscribe function (or no-op in dev mode).
  onPitchCorrectionComplete(callback: (data: { clipId: string; success: boolean; outputFile?: string; requestId?: string; restored?: boolean; renderMode?: PitchCorrectionRenderMode; cancelled?: boolean; swapDeferred?: boolean }) => void): () => void {
    const backend = this.getBackend();
    if (this.isNative && backend?.addEventListener) {
      const listener = backend.addEventListener(
        "pitchCorrectionComplete",
        (data: any) => callback(data),
      );
      return () => backend?.removeEventListener?.(listener);
    }
    return () => {};
  }

  // Subscribe to transport position updates from C++ (emitted at 10Hz).
  // Returns an unsubscribe function (or no-op in dev mode).
  onTransportUpdate(callback: (data: { position: number; isPlaying: boolean }) => void): () => void {
    const backend = this.getBackend();
    if (this.isNative && backend?.addEventListener) {
      const listener = backend.addEventListener("transportUpdate", (data: any) => {
        callback(data);
      });
      return () => backend?.removeEventListener?.(listener);
    }
    return () => {};
  }

  // Set callback for meter update events from C++
  onMeterUpdate(
    callback: (data: {
      trackLevels: number[];
      trackClipping?: Record<string, boolean>;
      masterLevel: number;
      masterClipping?: boolean;
      timestamp: number;
    }) => void,
  ) {
    const backend = this.getBackend();
    if (!this.isNative || !backend?.addEventListener) return;

    backend.addEventListener("meterUpdate", (data: any) => {
      callback(data);
    });
  }

  // CORRECTED: Call native functions directly as methods
  async addTrack(explicitId?: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.addTrack) {
      if (explicitId) {
        return await window.__JUCE__.backend.addTrack(explicitId);
      } else {
        return await window.__JUCE__.backend.addTrack();
      }
    } else {
      const id =
        explicitId || "Mock_Track_" + Math.random().toString(36).substr(2, 9);
      console.log("Mock: addTrack", id);
      return id;
    }
  }

  async removeTrack(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeTrack) {
      return await window.__JUCE__.backend.removeTrack(trackId);
    } else {
      console.log("Mock: removeTrack", trackId);
      return true;
    }
  }

  async reorderTrack(trackId: string, newPosition: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.reorderTrack) {
      return await window.__JUCE__.backend.reorderTrack(trackId, newPosition);
    } else {
      console.log("Mock: reorderTrack", trackId, newPosition);
      return true;
    }
  }

  async getAudioDeviceSetup(): Promise<AudioDeviceSetupResponse> {
    console.log(
      "[NativeBridge] getAudioDeviceSetup called, isNative:",
      this.isNative,
    );
    console.log(
      "[NativeBridge] window.__JUCE__?.backend.getAudioDeviceSetup exists:",
      typeof window.__JUCE__?.backend.getAudioDeviceSetup,
    );

    if (this.isNative && window.__JUCE__?.backend.getAudioDeviceSetup) {
      try {
        console.log("[NativeBridge] Calling backend.getAudioDeviceSetup()...");
        const result = await window.__JUCE__.backend.getAudioDeviceSetup();
        console.log("[NativeBridge] Got result:", result);
        return result;
      } catch (error) {
        console.error(
          "[NativeBridge] Error calling getAudioDeviceSetup:",
          error,
        );
        throw error;
      }
    } else {
      console.log("[NativeBridge] Using mock data");
      // Mock Data
      return {
        current: {
          audioDeviceType: "Mock",
          inputDevice: "Mock In",
          outputDevice: "Mock Out",
          sampleRate: 44100,
          bufferSize: 512,
        },
        availableTypes: ["Mock", "ASIO", "WASAPI"],
        inputs: ["Mock In", "Mic 1"],
        outputs: ["Mock Out", "Speakers"],
        sampleRates: [44100, 48000],
        bufferSizes: [256, 512, 1024],
      };
    }
  }

  async setAudioDeviceSetup(config: any): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setAudioDeviceSetup) {
      return await window.__JUCE__.backend.setAudioDeviceSetup(config);
    } else {
      console.log("Mock: setAudioDeviceSetup", config);
      return true;
    }
  }

  // Track Control (Phase 1)
  // Track Control (Phase 1)
  async setTrackRecordArm(trackId: string, armed: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackRecordArm) {
      return await window.__JUCE__.backend.setTrackRecordArm(trackId, armed);
    } else {
      console.log(
        `[NativeBridge] Mock setTrackRecordArm: track ${trackId}, armed: ${armed}`,
      );
      return true;
    }
  }

  async setTrackInputMonitoring(
    trackId: string,
    enabled: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackInputMonitoring) {
      return await window.__JUCE__.backend.setTrackInputMonitoring(
        trackId,
        enabled,
      );
    } else {
      console.log(
        `[NativeBridge] Mock setTrackInputMonitoring: track ${trackId}, enabled: ${enabled}`,
      );
      return true;
    }
  }

  async setTrackInputChannels(
    trackId: string,
    startChannel: number,
    numChannels: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackInputChannels) {
      return await window.__JUCE__.backend.setTrackInputChannels(
        trackId,
        startChannel,
        numChannels,
      );
    } else {
      console.log(
        `[NativeBridge] Mock setTrackInputChannels: track ${trackId}, ${startChannel}-${startChannel + numChannels - 1}`,
      );
      return true;
    }
  }

  // Volume/Pan/Mute/Solo (Phase 1)
  // Volume/Pan/Mute/Solo (Phase 1)
  async setTrackVolume(trackId: string, volumeDB: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackVolume) {
      return await window.__JUCE__.backend.setTrackVolume(trackId, volumeDB);
    } else {
      console.log(
        `[NativeBridge] Mock setTrackVolume: track ${trackId}, ${volumeDB} dB`,
      );
      return true;
    }
  }

  async setTrackPan(trackId: string, pan: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackPan) {
      return await window.__JUCE__.backend.setTrackPan(trackId, pan);
    } else {
      console.log(`[NativeBridge] Mock setTrackPan: track ${trackId}, ${pan}`);
      return true;
    }
  }

  async setTrackMute(trackId: string, muted: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackMute) {
      return await window.__JUCE__.backend.setTrackMute(trackId, muted);
    } else {
      console.log(
        `[NativeBridge] Mock setTrackMute: track ${trackId}, ${muted}`,
      );
      return true;
    }
  }

  async setTrackSolo(trackId: string, soloed: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackSolo) {
      return await window.__JUCE__.backend.setTrackSolo(trackId, soloed);
    } else {
      console.log(
        `[NativeBridge] Mock setTrackSolo: track ${trackId}, ${soloed}`,
      );
      return true;
    }
  }

  // Transport Control (Phase 2)
  async setTransportPlaying(playing: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTransportPlaying) {
      console.log("[audio.transport] NativeBridge.setTransportPlaying", { playing });
      return await window.__JUCE__.backend.setTransportPlaying(playing);
    } else {
      console.log(`[NativeBridge] Mock setTransportPlaying: ${playing}`);
      return true;
    }
  }

  async setTransportRecording(recording: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTransportRecording) {
      console.log("[audio.record] NativeBridge.setTransportRecording", { recording });
      return await window.__JUCE__.backend.setTransportRecording(recording);
    } else {
      console.log(`[NativeBridge] Mock setTransportRecording: ${recording}`);
      return true;
    }
  }

  // Punch In/Out (Phase 3.1)
  async setPunchRange(startTime: number, endTime: number, enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setPunchRange) {
      return await window.__JUCE__.backend.setPunchRange(startTime, endTime, enabled);
    }
    console.log(`[NativeBridge] Mock setPunchRange: ${startTime}-${endTime} enabled=${enabled}`);
    return true;
  }

  // Record-Safe (Phase 3.3)
  async setTrackRecordSafe(trackId: string, safe: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackRecordSafe) {
      return await window.__JUCE__.backend.setTrackRecordSafe(trackId, safe);
    }
    console.log(`[NativeBridge] Mock setTrackRecordSafe: ${trackId} safe=${safe}`);
    return true;
  }

  async getTrackRecordSafe(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.getTrackRecordSafe) {
      return await window.__JUCE__.backend.getTrackRecordSafe(trackId);
    }
    return false;
  }

  async setTempo(bpm: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTempo) {
      return await window.__JUCE__.backend.setTempo(bpm);
    } else {
      console.log(`[NativeBridge] Mock setTempo: ${bpm} BPM`);
      return true;
    }
  }

  async getTempo(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getTempo) {
      return await window.__JUCE__.backend.getTempo();
    } else {
      return 120;
    }
  }

  async getTransportPosition(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getTransportPosition) {
      return await window.__JUCE__.backend.getTransportPosition();
    } else {
      return 0;
    }
  }

  async setTransportPosition(seconds: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTransportPosition) {
      console.log("[audio.transport] NativeBridge.setTransportPosition", { seconds });
      return await window.__JUCE__.backend.setTransportPosition(seconds);
    } else {
      console.log(`[NativeBridge] Mock setTransportPosition: ${seconds}s`);
      return true;
    }
  }

  // Metronome & Time Signature (Phase 3)
  async setMetronomeEnabled(enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMetronomeEnabled) {
      return await window.__JUCE__.backend.setMetronomeEnabled(enabled);
    }
    return false;
  }

  async setMetronomeVolume(volume: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMetronomeVolume) {
      return await window.__JUCE__.backend.setMetronomeVolume(volume);
    }
    return false;
  }

  async isMetronomeEnabled(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.isMetronomeEnabled) {
      return await window.__JUCE__.backend.isMetronomeEnabled();
    }
    return false;
  }

  async setTimeSignature(
    numerator: number,
    denominator: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTimeSignature) {
      return await window.__JUCE__.backend.setTimeSignature(
        numerator,
        denominator,
      );
    }
    return false;
  }

  async getTimeSignature(): Promise<{
    numerator: number;
    denominator: number;
  }> {
    if (this.isNative && window.__JUCE__?.backend.getTimeSignature) {
      return await window.__JUCE__.backend.getTimeSignature();
    }
    return { numerator: 4, denominator: 4 };
  }

  async setMetronomeAccentBeats(accentBeats: boolean[]): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMetronomeAccentBeats) {
      return await window.__JUCE__.backend.setMetronomeAccentBeats(accentBeats);
    }
    console.log("[NativeBridge] Mock setMetronomeAccentBeats:", accentBeats);
    return true;
  }

  async renderMetronomeToFile(
    startTime: number,
    endTime: number,
  ): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.renderMetronomeToFile) {
      return await window.__JUCE__.backend.renderMetronomeToFile(
        startTime,
        endTime,
      );
    }
    console.log(
      `[NativeBridge] Mock renderMetronomeToFile: ${startTime} - ${endTime}`,
    );
    return "";
  }

  // Recording
  async getLastCompletedClips(): Promise<
    Array<{
      trackId: string;
      filePath: string;
      startTime: number;
      duration: number;
    }>
  > {
    if (this.isNative && window.__JUCE__?.backend.getLastCompletedClips) {
      console.log("[audio.record] NativeBridge.getLastCompletedClips");
      return await window.__JUCE__.backend.getLastCompletedClips();
    }
    return [];
  }

  async getLastCompletedMIDIClips(): Promise<
    Array<{
      trackId: string;
      startTime: number;
      duration: number;
      filePath?: string;
      events: Array<{
        timestamp: number;
        type: string;
        note?: number;
        velocity?: number;
        controller?: number;
        value?: number;
        channel?: number;
      }>;
    }>
  > {
    if (this.isNative && window.__JUCE__?.backend.getLastCompletedMIDIClips) {
      return await window.__JUCE__.backend.getLastCompletedMIDIClips();
    }
    return [];
  }

  async getActiveRecordingMIDIPreviews(
    requests: ActiveRecordingMIDIPreviewRequest[],
  ): Promise<ActiveRecordingMIDIPreviewResponse[]> {
    if (this.isNative && window.__JUCE__?.backend.getActiveRecordingMIDIPreviews) {
      return await window.__JUCE__.backend.getActiveRecordingMIDIPreviews(requests);
    }
    return [];
  }

  // Live recording waveform - get peaks for recording in progress
  async getRecordingPeaks(
    trackId: string,
    samplesPerPixel: number,
    numPixels: number,
  ): Promise<WaveformPeak[]> {
    if (this.isNative && window.__JUCE__?.backend.getRecordingPeaks) {
      console.log("[audio.record] NativeBridge.getRecordingPeaks", {
        trackId,
        samplesPerPixel,
        numPixels,
      });
      const flat = await window.__JUCE__.backend.getRecordingPeaks(
        trackId,
        samplesPerPixel,
        numPixels,
      );
      return parseFlatPeaks(flat as unknown as number[]);
    } else {
      // Mock: generate fake live recording waveform data
      const peaks: WaveformPeak[] = [];
      for (let i = 0; i < numPixels; i++) {
        // Simulate recording waveform with some randomness
        const amplitude = 0.3 + Math.random() * 0.4;
        peaks.push({
          channels: [
            { min: -amplitude, max: amplitude },
            { min: -amplitude * 0.9, max: amplitude * 0.9 },
          ],
        });
      }
      return peaks;
    }
  }

  async getAudioDebugSnapshot(): Promise<AudioDebugSnapshot> {
    if (this.isNative && window.__JUCE__?.backend.getAudioDebugSnapshot) {
      console.log("[audio.playback] NativeBridge.getAudioDebugSnapshot");
      const snapshot = await window.__JUCE__.backend.getAudioDebugSnapshot();
      try {
        console.log("[audio.playback] NativeBridge.getAudioDebugSnapshot result", snapshot, JSON.stringify(snapshot, null, 2));
      } catch {
        console.log("[audio.playback] NativeBridge.getAudioDebugSnapshot result", snapshot);
      }
      return snapshot;
    }
    const fallbackSnapshot = {
      transportPlaying: false,
      transportRecording: false,
      transportPosition: 0,
      sampleRate: 44100,
      blockSize: 512,
      playbackClipCount: 0,
      activeOutputChannels: 0,
      postTrackPlaybackPeak: 0,
      postMonitoringInputPeak: 0,
      postMasterFxPeak: 0,
      postMonitoringFxPeak: 0,
      finalOutputPeak: 0,
      lastRecordingClipCountReturned: 0,
      playbackTracks: [],
    };
    console.log("[audio.playback] NativeBridge.getAudioDebugSnapshot fallback", fallbackSnapshot, JSON.stringify(fallbackSnapshot, null, 2));
    return fallbackSnapshot;
  }

  // FX Management (Phase 3)
  async scanForPlugins(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.scanForPlugins) {
      return await window.__JUCE__.backend.scanForPlugins();
    } else {
      console.log("[NativeBridge] Mock scanForPlugins");
      return true;
    }
  }

  async getAvailablePlugins(): Promise<any[]> {
    if (this.isNative && window.__JUCE__?.backend.getAvailablePlugins) {
      return await window.__JUCE__.backend.getAvailablePlugins();
    } else {
      console.log("[NativeBridge] Mock getAvailablePlugins");
      return [
        {
          name: "Mock Compressor",
          manufacturer: "Mock Audio",
          category: "Dynamics",
          fileOrIdentifier: "/mock/comp.vst3",
        },
        {
          name: "Mock Reverb",
          manufacturer: "Mock FX",
          category: "Reverb",
          fileOrIdentifier: "/mock/reverb.vst3",
        },
      ];
    }
  }

  async addTrackInputFX(trackId: string, pluginPath: string, openEditor = true): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addTrackInputFX) {
      return await window.__JUCE__.backend.addTrackInputFX(trackId, pluginPath, openEditor);
    } else {
      console.log(
        `[NativeBridge] Mock addTrackInputFX: track ${trackId}, plugin ${pluginPath}`,
      );
      return true;
    }
  }

  async addTrackFX(trackId: string, pluginPath: string, openEditor = true): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addTrackFX) {
      return await window.__JUCE__.backend.addTrackFX(trackId, pluginPath, openEditor);
    } else {
      console.log(
        `[NativeBridge] Mock addTrackFX: track ${trackId}, plugin ${pluginPath}`,
      );
      return true;
    }
  }

  async openPluginEditor(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openPluginEditor) {
      return await window.__JUCE__.backend.openPluginEditor(
        trackId,
        fxIndex,
        isInputFX,
      );
    } else {
      console.log(
        `[NativeBridge] Mock openPluginEditor: track ${trackId}, fx ${fxIndex}, isInput: ${isInputFX}`,
      );
      return true;
    }
  }

  async closePluginEditor(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.closePluginEditor) {
      return await window.__JUCE__.backend.closePluginEditor(
        trackId,
        fxIndex,
        isInputFX,
      );
    } else {
      console.log(
        `[NativeBridge] Mock closePluginEditor: track ${trackId}, fx ${fxIndex}`,
      );
      return true;
    }
  }

  async closeAllPluginWindows(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.closeAllPluginWindows) {
      return await window.__JUCE__.backend.closeAllPluginWindows();
    } else {
      console.log('[NativeBridge] Mock closeAllPluginWindows');
      return true;
    }
  }

  // S13FX (JSFX) Management
  async addTrackS13FX(
    trackId: string,
    scriptPath: string,
    isInputFX = false,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addTrackS13FX) {
      return await window.__JUCE__.backend.addTrackS13FX(
        trackId,
        scriptPath,
        isInputFX,
      );
    } else {
      console.log(
        `[NativeBridge] Mock addTrackS13FX: track ${trackId}, script ${scriptPath}`,
      );
      return true;
    }
  }

  async addMasterS13FX(scriptPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addMasterS13FX) {
      return await window.__JUCE__.backend.addMasterS13FX(scriptPath);
    } else {
      console.log(`[NativeBridge] Mock addMasterS13FX: ${scriptPath}`);
      return true;
    }
  }

  async getS13FXSliders(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
  ): Promise<
    {
      index: number;
      name: string;
      min: number;
      max: number;
      def: number;
      inc: number;
      value: number;
      isEnum: boolean;
      enumNames?: string[];
    }[]
  > {
    if (this.isNative && window.__JUCE__?.backend.getS13FXSliders) {
      return await window.__JUCE__.backend.getS13FXSliders(
        trackId,
        fxIndex,
        isInputFX,
      );
    } else {
      return [];
    }
  }

  async setS13FXSlider(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
    sliderIndex: number,
    value: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setS13FXSlider) {
      return await window.__JUCE__.backend.setS13FXSlider(
        trackId,
        fxIndex,
        isInputFX,
        sliderIndex,
        value,
      );
    } else {
      return true;
    }
  }

  async reloadS13FX(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.reloadS13FX) {
      return await window.__JUCE__.backend.reloadS13FX(
        trackId,
        fxIndex,
        isInputFX,
      );
    } else {
      return true;
    }
  }

  async getAvailableS13FX(): Promise<
    {
      name: string;
      filePath: string;
      author: string;
      isStock: boolean;
      type: string;
      tags: string[];
    }[]
  > {
    if (this.isNative && window.__JUCE__?.backend.getAvailableS13FX) {
      return await window.__JUCE__.backend.getAvailableS13FX();
    } else {
      return [
        {
          name: "Mock Gain",
          filePath: "/mock/gain.jsfx",
          author: "OpenStudio",
          isStock: true,
          type: "s13fx",
          tags: ["utility"],
        },
      ];
    }
  }

  async openUserEffectsFolder(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openUserEffectsFolder) {
      return await window.__JUCE__.backend.openUserEffectsFolder();
    } else {
      console.log("[NativeBridge] Mock openUserEffectsFolder");
      return true;
    }
  }

  // Built-in FX Presets
  async getBuiltInFXPresets(
    pluginName: string,
  ): Promise<{ name: string; path: string }[]> {
    if (this.isNative && window.__JUCE__?.backend.getBuiltInFXPresets) {
      return await window.__JUCE__.backend.getBuiltInFXPresets(pluginName);
    }
    return [];
  }

  async saveBuiltInFXPreset(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
    presetName: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.saveBuiltInFXPreset) {
      return await window.__JUCE__.backend.saveBuiltInFXPreset(
        trackId,
        fxIndex,
        isInputFX,
        presetName,
      );
    }
    console.log(
      `[NativeBridge] Mock saveBuiltInFXPreset: ${presetName}`,
    );
    return true;
  }

  async loadBuiltInFXPreset(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
    presetName: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.loadBuiltInFXPreset) {
      return await window.__JUCE__.backend.loadBuiltInFXPreset(
        trackId,
        fxIndex,
        isInputFX,
        presetName,
      );
    }
    console.log(
      `[NativeBridge] Mock loadBuiltInFXPreset: ${presetName}`,
    );
    return true;
  }

  async deleteBuiltInFXPreset(
    pluginName: string,
    presetName: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.deleteBuiltInFXPreset) {
      return await window.__JUCE__.backend.deleteBuiltInFXPreset(
        pluginName,
        presetName,
      );
    }
    console.log(
      `[NativeBridge] Mock deleteBuiltInFXPreset: ${presetName}`,
    );
    return true;
  }

  // Lua Scripting (S13Script)
  async runScript(
    scriptPath: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    if (this.isNative && window.__JUCE__?.backend.runScript) {
      return await window.__JUCE__.backend.runScript(scriptPath);
    } else {
      return { success: true, output: "Mock: script executed" };
    }
  }

  async runScriptCode(
    code: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    if (this.isNative && window.__JUCE__?.backend.runScriptCode) {
      return await window.__JUCE__.backend.runScriptCode(code);
    } else {
      return { success: true, output: "Mock: code executed" };
    }
  }

  async getScriptDirectory(): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getScriptDirectory) {
      return await window.__JUCE__.backend.getScriptDirectory();
    } else {
      return String.raw`C:\Users\Mock\Documents\OpenStudio\Scripts`;
    }
  }

  async openFileExternal(path: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openFileExternal) {
      return await window.__JUCE__.backend.openFileExternal(path);
    }
    return false;
  }

  async listScripts(): Promise<
    Array<{
      name: string;
      filePath: string;
      description: string;
      isStock: boolean;
    }>
  > {
    if (this.isNative && window.__JUCE__?.backend.listScripts) {
      return await window.__JUCE__.backend.listScripts();
    } else {
      return [
        {
          name: "Hello World",
          filePath: "/mock/hello.lua",
          description: "Print a greeting",
          isStock: true,
        },
      ];
    }
  }

  // Metering (Phase 4)
  async getMeterLevels(): Promise<number[]> {
    if (this.isNative && window.__JUCE__?.backend.getMeterLevels) {
      return await window.__JUCE__.backend.getMeterLevels();
    } else {
      // Mock: return random levels for testing
      return [Math.random() * 0.5, Math.random() * 0.5, Math.random() * 0.5];
    }
  }

  async getMasterLevel(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getMasterLevel) {
      return await window.__JUCE__.backend.getMasterLevel();
    } else {
      // Mock: return random level
      return Math.random() * 0.5;
    }
  }

  async resetMeterClip(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.resetMeterClip) {
      return await window.__JUCE__.backend.resetMeterClip(trackId);
    }
    return true;
  }

  // Master & Monitoring (Phase 5)
  async addMasterFX(pluginPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addMasterFX) {
      return await window.__JUCE__.backend.addMasterFX(pluginPath);
    } else {
      console.log(`[NativeBridge] Mock addMasterFX: ${pluginPath}`);
      return true;
    }
  }

  async getMasterFX(): Promise<{ index: number; name: string; pluginPath?: string; bypassed?: boolean; precisionOverride?: "auto" | "float32" }[]> {
    if (this.isNative && window.__JUCE__?.backend.getMasterFX) {
      return await window.__JUCE__.backend.getMasterFX();
    }
    return [];
  }

  async removeMasterFX(fxIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeMasterFX) {
      return await window.__JUCE__.backend.removeMasterFX(fxIndex);
    }
    return false;
  }

  async openMasterFXEditor(fxIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openMasterFXEditor) {
      return await window.__JUCE__.backend.openMasterFXEditor(fxIndex);
    }
    return false;
  }

  async bypassMasterFX(fxIndex: number, bypassed: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.bypassMasterFX) {
      return await window.__JUCE__.backend.bypassMasterFX(fxIndex, bypassed);
    }
    return false;
  }

  // Monitoring FX (Phase 2.6) — output-only, not included in offline renders
  async addMonitoringFX(pluginPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addMonitoringFX) {
      return await window.__JUCE__.backend.addMonitoringFX(pluginPath);
    }
    console.log(`[NativeBridge] Mock addMonitoringFX: ${pluginPath}`);
    return true;
  }

  async getMonitoringFX(): Promise<{ index: number; name: string; pluginPath?: string; bypassed?: boolean }[]> {
    if (this.isNative && window.__JUCE__?.backend.getMonitoringFX) {
      return await window.__JUCE__.backend.getMonitoringFX();
    }
    return [];
  }

  async removeMonitoringFX(fxIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeMonitoringFX) {
      return await window.__JUCE__.backend.removeMonitoringFX(fxIndex);
    }
    return false;
  }

  async openMonitoringFXEditor(fxIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openMonitoringFXEditor) {
      return await window.__JUCE__.backend.openMonitoringFXEditor(fxIndex);
    }
    return false;
  }

  async bypassMonitoringFX(fxIndex: number, bypassed: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.bypassMonitoringFX) {
      return await window.__JUCE__.backend.bypassMonitoringFX(fxIndex, bypassed);
    }
    return false;
  }

  async setMasterVolume(volume: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMasterVolume) {
      return await window.__JUCE__.backend.setMasterVolume(volume);
    } else {
      console.log(`[NativeBridge] Mock setMasterVolume: ${volume}`);
      return true;
    }
  }

  async setMasterPan(pan: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMasterPan) {
      return await window.__JUCE__.backend.setMasterPan(pan);
    } else {
      console.log(`[NativeBridge] Mock setMasterPan: ${pan}`);
      return true;
    }
  }

  async getMasterPan(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getMasterPan) {
      return await window.__JUCE__.backend.getMasterPan();
    } else {
      return 0.0;
    }
  }

  async setMasterMono(mono: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMasterMono) {
      return await window.__JUCE__.backend.setMasterMono(mono);
    }
    return true;
  }

  async getMasterMono(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.getMasterMono) {
      return await window.__JUCE__.backend.getMasterMono();
    }
    return false;
  }

  // Waveform Visualization
  async getWaveformPeaks(
    filePath: string,
    samplesPerPixel: number,
    startSample: number,
    numPixels: number,
  ): Promise<WaveformPeak[]> {
    if (this.isNative && window.__JUCE__?.backend.getWaveformPeaks) {
      const flat = await window.__JUCE__.backend.getWaveformPeaks(
        filePath,
        samplesPerPixel,
        startSample,
        numPixels,
      );
      return parseFlatPeaks(flat as unknown as number[]);
    } else {
      // Mock: generate fake waveform data for testing
      const peaks: WaveformPeak[] = [];
      for (let i = 0; i < numPixels; i++) {
        const amplitude = Math.sin(i * 0.1) * 0.5 + Math.random() * 0.3;
        peaks.push({
          channels: [
            { min: -amplitude, max: amplitude }, // Left channel
            { min: -amplitude * 0.8, max: amplitude * 0.8 }, // Right channel (slightly different)
          ],
        });
      }
      return peaks;
    }
  }

  // Playback clip management
  async addPlaybackClip(
    trackId: string,
    filePath: string,
    startTime: number,
    duration: number,
    offset: number = 0,
    volumeDB: number = 0,
    fadeIn: number = 0,
    fadeOut: number = 0,
    clipId: string = "",
    pitchCorrectionSourceFilePath?: string,
    pitchCorrectionSourceOffset?: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addPlaybackClip) {
      console.log("[audio.playback] NativeBridge.addPlaybackClip", {
        trackId,
        clipId,
        filePath,
        startTime,
        duration,
        offset,
      });
      return await window.__JUCE__.backend.addPlaybackClip(
        trackId,
        filePath,
        startTime,
        duration,
        offset,
        volumeDB,
        fadeIn,
        fadeOut,
        clipId,
        pitchCorrectionSourceFilePath,
        pitchCorrectionSourceOffset,
      );
    }
    return false;
  }

  async removePlaybackClip(
    trackId: string,
    filePath: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removePlaybackClip) {
      return await window.__JUCE__.backend.removePlaybackClip(
        trackId,
        filePath,
      );
    }
    return false;
  }

  async clearPlaybackClips(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.clearPlaybackClips) {
      console.log("[audio.playback] NativeBridge.clearPlaybackClips");
      return await window.__JUCE__.backend.clearPlaybackClips();
    }
    return false;
  }

  /** Batch-add multiple playback clips in parallel using Promise.all().
   *  Frontend-only optimization — each clip still calls addPlaybackClip individually
   *  but all calls are dispatched concurrently instead of sequentially. */
  async addPlaybackClipsBatch(
    clips: Array<{
      trackId: string;
      filePath: string;
      startTime: number;
      duration: number;
      offset: number;
      volumeDB: number;
      fadeIn: number;
      fadeOut: number;
      clipId?: string;
      pitchCorrectionSourceFilePath?: string;
      pitchCorrectionSourceOffset?: number;
    }>,
  ): Promise<boolean> {
    if (clips.length === 0) return true;
    // Single bridge call — C++ parses JSON array and adds all clips in one go
    if (this.isNative && window.__JUCE__?.backend.addPlaybackClipsBatch) {
      console.log("[audio.playback] NativeBridge.addPlaybackClipsBatch", {
        count: clips.length,
        clips: clips.map((clip) => ({
          trackId: clip.trackId,
          clipId: clip.clipId,
          filePath: clip.filePath,
          startTime: clip.startTime,
          duration: clip.duration,
          offset: clip.offset,
        })),
      });
      return await window.__JUCE__.backend.addPlaybackClipsBatch(JSON.stringify(clips));
    }
    // Fallback: individual calls (for dev mode or if backend doesn't support batch)
    await Promise.all(
      clips.map((clip) =>
        this.addPlaybackClip(
          clip.trackId,
          clip.filePath,
          clip.startTime,
          clip.duration,
          clip.offset,
          clip.volumeDB,
          clip.fadeIn,
          clip.fadeOut,
          clip.clipId ?? "",
          clip.pitchCorrectionSourceFilePath,
          clip.pitchCorrectionSourceOffset,
        ),
      ),
    );
    return true;
  }

  // Automation (Phase 1.1)
  async setAutomationPoints(
    trackId: string,
    parameterId: string,
    points: { time: number; value: number }[],
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setAutomationPoints) {
      const json = JSON.stringify(points);
      return await window.__JUCE__.backend.setAutomationPoints(trackId, parameterId, json);
    }
    return false;
  }

  async setAutomationMode(
    trackId: string,
    parameterId: string,
    mode: "off" | "read" | "write" | "touch" | "latch",
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setAutomationMode) {
      return await window.__JUCE__.backend.setAutomationMode(trackId, parameterId, mode);
    }
    return false;
  }

  async getAutomationMode(
    trackId: string,
    parameterId: string,
  ): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getAutomationMode) {
      return await window.__JUCE__.backend.getAutomationMode(trackId, parameterId);
    }
    return "off";
  }

  async clearAutomation(
    trackId: string,
    parameterId: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.clearAutomation) {
      return await window.__JUCE__.backend.clearAutomation(trackId, parameterId);
    }
    return false;
  }

  async beginTouchAutomation(
    trackId: string,
    parameterId: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.beginTouchAutomation) {
      return await window.__JUCE__.backend.beginTouchAutomation(trackId, parameterId);
    }
    return false;
  }

  async endTouchAutomation(
    trackId: string,
    parameterId: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.endTouchAutomation) {
      return await window.__JUCE__.backend.endTouchAutomation(trackId, parameterId);
    }
    return false;
  }

  // Tempo Map (Phase 1.2)
  async setTempoMarkers(
    markers: Array<{ time: number; tempo: number }>,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTempoMarkers) {
      return await window.__JUCE__.backend.setTempoMarkers(JSON.stringify(markers));
    }
    return false;
  }

  async clearTempoMarkers(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.clearTempoMarkers) {
      return await window.__JUCE__.backend.clearTempoMarkers();
    }
    return false;
  }

  // MIDI Device Management (Phase 2)
  async getMIDIInputDevices(): Promise<string[]> {
    if (this.isNative && window.__JUCE__?.backend.getMIDIInputDevices) {
      return await window.__JUCE__.backend.getMIDIInputDevices();
    }
    return [];
  }

  async getMIDIOutputDevices(): Promise<string[]> {
    if (this.isNative && window.__JUCE__?.backend.getMIDIOutputDevices) {
      return await window.__JUCE__.backend.getMIDIOutputDevices();
    }
    // Fallback: try getControlSurfaceMIDIDevices which returns both inputs and outputs
    if (this.isNative && window.__JUCE__?.backend.getControlSurfaceMIDIDevices) {
      const devices = await window.__JUCE__.backend.getControlSurfaceMIDIDevices();
      return devices.outputs || [];
    }
    return [];
  }

  async openMIDIDevice(deviceName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openMIDIDevice) {
      return await window.__JUCE__.backend.openMIDIDevice(deviceName);
    }
    return false;
  }

  async closeMIDIDevice(deviceName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.closeMIDIDevice) {
      return await window.__JUCE__.backend.closeMIDIDevice(deviceName);
    }
    return false;
  }

  async getOpenMIDIDevices(): Promise<string[]> {
    if (this.isNative && window.__JUCE__?.backend.getOpenMIDIDevices) {
      return await window.__JUCE__.backend.getOpenMIDIDevices();
    }
    return [];
  }

  // Track Type Management (Phase 2)
  // Track Type Management (Phase 2)
  async setTrackType(
    trackId: string,
    type: "audio" | "midi" | "instrument",
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackType) {
      return await window.__JUCE__.backend.setTrackType(trackId, type);
    }
    return false;
  }

  async setTrackMIDIInput(
    trackId: string,
    deviceName: string,
    channel: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackMIDIInput) {
      return await window.__JUCE__.backend.setTrackMIDIInput(
        trackId,
        deviceName,
        channel,
      );
    }
    return false;
  }

  async setTrackMIDIClips(trackId: string, clips: Array<any>): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackMIDIClips) {
      return await window.__JUCE__.backend.setTrackMIDIClips(
        trackId,
        JSON.stringify(clips),
      );
    }
    return true;
  }

  async loadInstrument(trackId: string, vstPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.loadInstrument) {
      return await window.__JUCE__.backend.loadInstrument(trackId, vstPath);
    }
    return false;
  }

  async openInstrumentEditor(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openInstrumentEditor) {
      return await window.__JUCE__.backend.openInstrumentEditor(trackId);
    }
    return false;
  }

  // Project Save/Load (F2)
  async showSaveDialog(defaultPath?: string, title?: string, filters?: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.showSaveDialog) {
      return await window.__JUCE__.backend.showSaveDialog(defaultPath, title, filters);
    }
    console.log("[NativeBridge] Mock showSaveDialog");
    return "";
  }

  async showOpenDialog(title?: string, filters?: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.showOpenDialog) {
      return await window.__JUCE__.backend.showOpenDialog(title, filters);
    }
    console.log("[NativeBridge] Mock showOpenDialog");
    return "";
  }

  async getAppVersion(): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getAppVersion) {
      return await window.__JUCE__.backend.getAppVersion();
    }
    return "0.0.1";
  }

  async checkForUpdates(manual = true): Promise<any> {
    if (this.isNative && window.__JUCE__?.backend.checkForUpdates) {
      return await window.__JUCE__.backend.checkForUpdates(manual);
    }
    return { status: "error", message: "Updates are unavailable in the web preview." };
  }

  async downloadAndInstallUpdate(
    downloadUrl: string,
    version?: string,
    sha256?: string,
    releasePageUrl?: string,
    installerArguments?: string,
    size?: number,
  ): Promise<any> {
    if (this.isNative && window.__JUCE__?.backend.downloadAndInstallUpdate) {
      return await window.__JUCE__.backend.downloadAndInstallUpdate(
        downloadUrl,
        version,
        sha256,
        releasePageUrl,
        installerArguments,
        size,
      );
    }
    return { status: "error", message: "Installer downloads are unavailable in the web preview." };
  }

  async openExternalURL(url: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openExternalURL) {
      return await window.__JUCE__.backend.openExternalURL(url);
    }

    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    }

    return false;
  }

  async saveProjectToFile(
    filePath: string,
    jsonContent: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.saveProjectToFile) {
      return await window.__JUCE__.backend.saveProjectToFile(
        filePath,
        jsonContent,
      );
    }
    console.log(
      `[NativeBridge] Mock saveProjectToFile: ${filePath} (${jsonContent.length} bytes)`,
    );
    return true;
  }

  async loadProjectFromFile(filePath: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.loadProjectFromFile) {
      return await window.__JUCE__.backend.loadProjectFromFile(filePath);
    }
    console.log(`[NativeBridge] Mock loadProjectFromFile: ${filePath}`);
    return "";
  }

  async consumePendingLaunchProjectPath(): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.consumePendingLaunchProjectPath) {
      return await window.__JUCE__.backend.consumePendingLaunchProjectPath();
    }
    return "";
  }

  // Render/Export (F3)
  async showRenderSaveDialog(defaultFileName: string, formatExtension: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.showRenderSaveDialog) {
      return await window.__JUCE__.backend.showRenderSaveDialog(defaultFileName, formatExtension);
    }
    console.log("[NativeBridge] Mock showRenderSaveDialog");
    return "";
  }

  async renderProject(options: {
    source: string;
    startTime: number;
    endTime: number;
    filePath: string;
    format: string;
    sampleRate: number;
    bitDepth: number;
    channels: number;
    normalize: boolean;
    addTail: boolean;
    tailLength: number;
  }): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.renderProject) {
      return await window.__JUCE__.backend.renderProject(
        options.source,
        options.startTime,
        options.endTime,
        options.filePath,
        options.format,
        options.sampleRate,
        options.bitDepth,
        options.channels,
        options.normalize,
        options.addTail,
        options.tailLength
      );
    }
    console.log(
      `[NativeBridge] Mock renderProject: ${options.filePath} (${options.format}, ${options.startTime}-${options.endTime}s)`,
    );
    // Simulate render progress
    return new Promise((resolve) => {
      setTimeout(() => resolve(true), 2000);
    });
  }

  async renderProjectWithDither(options: {
    source: string;
    startTime: number;
    endTime: number;
    filePath: string;
    format: string;
    sampleRate: number;
    bitDepth: number;
    channels: number;
    normalize: boolean;
    addTail: boolean;
    tailLength: number;
    ditherType: string;
  }): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.renderProjectWithDither) {
      return await window.__JUCE__.backend.renderProjectWithDither(
        options.source,
        options.startTime,
        options.endTime,
        options.filePath,
        options.format,
        options.sampleRate,
        options.bitDepth,
        options.channels,
        options.normalize,
        options.addTail,
        options.tailLength,
        options.ditherType,
      );
    }
    // Fallback to non-dither render
    return this.renderProject(options);
  }

  // MIDI
  async sendMidiNote(
    trackId: string,
    note: number,
    velocity: number,
    isNoteOn: boolean
  ): Promise<void> {
    if (this.isNative && window.__JUCE__?.backend.sendMidiNote) {
      await window.__JUCE__.backend.sendMidiNote(
        trackId,
        note,
        velocity,
        isNoteOn
      );
      return;
    }
    console.log(
      `[NativeBridge] Mock sendMidiNote: track=${trackId}, note=${note}, velocity=${velocity}, on=${isNoteOn}`,
    );
  }

  async getMidiDiagnostics(): Promise<MidiDiagnosticsReport> {
    if (this.isNative && window.__JUCE__?.backend.getMidiDiagnostics) {
      return await window.__JUCE__.backend.getMidiDiagnostics();
    }
    return {
      inputDevices: [],
      outputDevices: [],
      openDevices: [],
      lateMidiEvents: 0,
    };
  }

  async getPluginCapabilities(pluginPath: string): Promise<PluginCapabilities> {
    if (this.isNative && window.__JUCE__?.backend.getPluginCapabilities) {
      return await window.__JUCE__.backend.getPluginCapabilities(pluginPath);
    }
    return {
      format: "unknown", name: "Mock", vendor: "Mock", category: "",
      numInputChannels: 2, numOutputChannels: 2, supportsDouble: false,
      hasMidiInput: false, hasMidiOutput: false, hasEditor: false,
    };
  }

  async setProcessingPrecision(mode: "float32" | "hybrid64"): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setProcessingPrecision) {
      return await window.__JUCE__.backend.setProcessingPrecision(mode);
    }
    return true;
  }

  async getProcessingPrecision(): Promise<"float32" | "hybrid64"> {
    if (this.isNative && window.__JUCE__?.backend.getProcessingPrecision) {
      return await window.__JUCE__.backend.getProcessingPrecision();
    }
    return "float32";
  }

  async getPluginCompatibilityMatrix(): Promise<Record<string, PluginCapabilities>> {
    if (this.isNative && window.__JUCE__?.backend.getPluginCompatibilityMatrix) {
      return await window.__JUCE__.backend.getPluginCompatibilityMatrix();
    }
    return {};
  }

  async runEngineBenchmarks(): Promise<BenchmarkResults> {
    if (this.isNative && window.__JUCE__?.backend.runEngineBenchmarks) {
      return await window.__JUCE__.backend.runEngineBenchmarks();
    }
    return { cpuUsage: 0, callbackDurationMs: 0, bufferSize: 512, sampleRate: 44100, trackCount: 0 };
  }

  async setTrackPluginPrecisionOverride(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
    mode: "auto" | "float32",
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackPluginPrecisionOverride) {
      return await window.__JUCE__.backend.setTrackPluginPrecisionOverride(
        trackId,
        fxIndex,
        isInputFX,
        mode,
      );
    }
    return true;
  }

  async setInstrumentPrecisionOverride(
    trackId: string,
    mode: "auto" | "float32",
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setInstrumentPrecisionOverride) {
      return await window.__JUCE__.backend.setInstrumentPrecisionOverride(trackId, mode);
    }
    return true;
  }

  async setMasterFXPrecisionOverride(
    fxIndex: number,
    mode: "auto" | "float32",
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMasterFXPrecisionOverride) {
      return await window.__JUCE__.backend.setMasterFXPrecisionOverride(fxIndex, mode);
    }
    return true;
  }

  async setMonitoringFXPrecisionOverride(
    fxIndex: number,
    mode: "auto" | "float32",
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMonitoringFXPrecisionOverride) {
      return await window.__JUCE__.backend.setMonitoringFXPrecisionOverride(fxIndex, mode);
    }
    return true;
  }

  async runReleaseGuardrails(): Promise<GuardrailsReport> {
    if (this.isNative && window.__JUCE__?.backend.runReleaseGuardrails) {
      return await window.__JUCE__.backend.runReleaseGuardrails();
    }
    return { passed: false, checks: [] };
  }

  async runAutomatedRegressionSuite(): Promise<GuardrailsReport> {
    if (this.isNative && window.__JUCE__?.backend.runAutomatedRegressionSuite) {
      return await window.__JUCE__.backend.runAutomatedRegressionSuite();
    }
    return { passed: false, checks: [] };
  }

  // Media Import (F10)
  async importMediaFile(filePath: string): Promise<{
    filePath: string;
    duration: number;
    sampleRate: number;
    numChannels: number;
    format: string;
  }> {
    if (this.isNative && window.__JUCE__?.backend.importMediaFile) {
      return await window.__JUCE__.backend.importMediaFile(filePath);
    }
    console.log(`[NativeBridge] Mock importMediaFile: ${filePath}`);
    // Mock: return fake audio file metadata
    return {
      filePath: filePath,
      duration: 30.5,
      sampleRate: 44100,
      numChannels: 2,
      format: filePath.endsWith('.wav') ? 'WAV' :
              filePath.endsWith('.mp3') ? 'MP3' :
              filePath.endsWith('.mp4') ? 'MP4' : 'Unknown',
    };
  }

  // Save a dropped file (base64 encoded) to disk via the backend
  async saveDroppedFile(fileName: string, base64Data: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.saveDroppedFile) {
      return await window.__JUCE__.backend.saveDroppedFile(fileName, base64Data);
    }
    console.log(`[NativeBridge] Mock saveDroppedFile: ${fileName}`);
    return "";
  }

  // Plugin State Management (F2)
  async getPluginState(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
  ): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getPluginState) {
      return await window.__JUCE__.backend.getPluginState(
        trackId,
        fxIndex,
        isInputFX,
      );
    }
    // Mock state
    return "";
  }

  async setPluginState(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
    base64State: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setPluginState) {
      return await window.__JUCE__.backend.setPluginState(
        trackId,
        fxIndex,
        isInputFX,
        base64State,
      );
    }
    return true;
  }

  async getMasterPluginState(fxIndex: number): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getMasterPluginState) {
      return await window.__JUCE__.backend.getMasterPluginState(fxIndex);
    }
    return "";
  }

  async setMasterPluginState(
    fxIndex: number,
    base64State: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMasterPluginState) {
      return await window.__JUCE__.backend.setMasterPluginState(
        fxIndex,
        base64State,
      );
    }
    return true;
  }

  // FX Chain Management
  // FX Chain Management
  async getTrackInputFX(trackId: string): Promise<any[]> {
    if (this.isNative && window.__JUCE__?.backend.getTrackInputFX) {
      return await window.__JUCE__.backend.getTrackInputFX(trackId);
    }
    return [];
  }

  async getTrackFX(trackId: string): Promise<any[]> {
    if (this.isNative && window.__JUCE__?.backend.getTrackFX) {
      return await window.__JUCE__.backend.getTrackFX(trackId);
    }
    return [];
  }

  async removeTrackInputFX(trackId: string, fxIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeTrackInputFX) {
      return await window.__JUCE__.backend.removeTrackInputFX(trackId, fxIndex);
    }
    return false;
  }

  async removeTrackFX(trackId: string, fxIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeTrackFX) {
      return await window.__JUCE__.backend.removeTrackFX(trackId, fxIndex);
    }
    return false;
  }

  async bypassTrackInputFX(
    trackId: string,
    fxIndex: number,
    bypassed: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.bypassTrackInputFX) {
      return await window.__JUCE__.backend.bypassTrackInputFX(
        trackId,
        fxIndex,
        bypassed,
      );
    }
    return false;
  }

  async bypassTrackFX(
    trackId: string,
    fxIndex: number,
    bypassed: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.bypassTrackFX) {
      return await window.__JUCE__.backend.bypassTrackFX(
        trackId,
        fxIndex,
        bypassed,
      );
    }
    return false;
  }

  async reorderTrackInputFX(
    trackId: string,
    fromIndex: number,
    toIndex: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.reorderTrackInputFX) {
      return await window.__JUCE__.backend.reorderTrackInputFX(
        trackId,
        fromIndex,
        toIndex,
      );
    }
    console.log(
      `[NativeBridge] Mock reorderTrackInputFX: track ${trackId}, from ${fromIndex} to ${toIndex}`,
    );
    return true;
  }

  async reorderTrackFX(
    trackId: string,
    fromIndex: number,
    toIndex: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.reorderTrackFX) {
      return await window.__JUCE__.backend.reorderTrackFX(
        trackId,
        fromIndex,
        toIndex,
      );
    }
    console.log(
      `[NativeBridge] Mock reorderTrackFX: track ${trackId}, from ${fromIndex} to ${toIndex}`,
    );
    return true;
  }

  // Phase 9: Audio Engine Enhancements
  async reverseAudioFile(filePath: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.reverseAudioFile) {
      return await window.__JUCE__.backend.reverseAudioFile(filePath);
    }
    console.log(`[NativeBridge] Mock reverseAudioFile: ${filePath}`);
    return filePath; // Mock: return same path
  }

  async detectTransients(filePath: string, sensitivity: number, minGapMs: number): Promise<number[]> {
    if (this.isNative && window.__JUCE__?.backend.detectTransients) {
      return await window.__JUCE__.backend.detectTransients(filePath, sensitivity, minGapMs);
    }
    console.log(`[NativeBridge] Mock detectTransients: ${filePath}, sensitivity=${sensitivity}, minGap=${minGapMs}`);
    // Mock: return some fake transient times
    return [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
  }

  async setMetronomeClickSound(filePath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMetronomeClickSound) {
      return await window.__JUCE__.backend.setMetronomeClickSound(filePath);
    }
    console.log(`[NativeBridge] Mock setMetronomeClickSound: ${filePath}`);
    return true;
  }

  async setMetronomeAccentSound(filePath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMetronomeAccentSound) {
      return await window.__JUCE__.backend.setMetronomeAccentSound(filePath);
    }
    console.log(`[NativeBridge] Mock setMetronomeAccentSound: ${filePath}`);
    return true;
  }

  async resetMetronomeSounds(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.resetMetronomeSounds) {
      return await window.__JUCE__.backend.resetMetronomeSounds();
    }
    console.log("[NativeBridge] Mock resetMetronomeSounds");
    return true;
  }

  async measureLUFS(filePath: string, startTime?: number, endTime?: number): Promise<{
    integrated: number;
    shortTerm: number;
    momentary: number;
    truePeak: number;
    range: number;
  }> {
    if (this.isNative && window.__JUCE__?.backend.measureLUFS) {
      return await window.__JUCE__.backend.measureLUFS(filePath, startTime, endTime);
    }
    console.log(`[NativeBridge] Mock measureLUFS: ${filePath}`);
    return { integrated: -14.0, shortTerm: -12.0, momentary: -10.0, truePeak: -0.3, range: 8.0 };
  }

  // Phase 11: Send/Bus Routing
  async addTrackSend(sourceTrackId: string, destTrackId: string): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.addTrackSend) {
      return await window.__JUCE__.backend.addTrackSend(sourceTrackId, destTrackId);
    }
    console.log(`[NativeBridge] Mock addTrackSend: ${sourceTrackId} -> ${destTrackId}`);
    return 0;
  }

  async removeTrackSend(sourceTrackId: string, sendIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeTrackSend) {
      return await window.__JUCE__.backend.removeTrackSend(sourceTrackId, sendIndex);
    }
    console.log(`[NativeBridge] Mock removeTrackSend: ${sourceTrackId} [${sendIndex}]`);
    return true;
  }

  async setTrackSendLevel(sourceTrackId: string, sendIndex: number, level: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackSendLevel) {
      return await window.__JUCE__.backend.setTrackSendLevel(sourceTrackId, sendIndex, level);
    }
    return true;
  }

  async setTrackSendPan(sourceTrackId: string, sendIndex: number, pan: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackSendPan) {
      return await window.__JUCE__.backend.setTrackSendPan(sourceTrackId, sendIndex, pan);
    }
    return true;
  }

  async setTrackSendEnabled(sourceTrackId: string, sendIndex: number, enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackSendEnabled) {
      return await window.__JUCE__.backend.setTrackSendEnabled(sourceTrackId, sendIndex, enabled);
    }
    return true;
  }

  async setTrackSendPreFader(sourceTrackId: string, sendIndex: number, preFader: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackSendPreFader) {
      return await window.__JUCE__.backend.setTrackSendPreFader(sourceTrackId, sendIndex, preFader);
    }
    return true;
  }

  async getTrackSends(trackId: string): Promise<Array<{ destTrackId: string; level: number; pan: number; enabled: boolean; preFader: boolean; phaseInvert: boolean }>> {
    if (this.isNative && window.__JUCE__?.backend.getTrackSends) {
      return await window.__JUCE__.backend.getTrackSends(trackId);
    }
    return [];
  }

  async setTrackSendPhaseInvert(sourceTrackId: string, sendIndex: number, invert: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackSendPhaseInvert) {
      return await window.__JUCE__.backend.setTrackSendPhaseInvert(sourceTrackId, sendIndex, invert);
    }
    return true;
  }

  // ===== Track Routing Features =====

  async setTrackPhaseInvert(trackId: string, invert: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackPhaseInvert) {
      return await window.__JUCE__.backend.setTrackPhaseInvert(trackId, invert);
    }
    return true;
  }

  async getTrackPhaseInvert(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.getTrackPhaseInvert) {
      return await window.__JUCE__.backend.getTrackPhaseInvert(trackId);
    }
    return false;
  }

  async setTrackStereoWidth(trackId: string, widthPercent: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackStereoWidth) {
      return await window.__JUCE__.backend.setTrackStereoWidth(trackId, widthPercent);
    }
    return true;
  }

  async getTrackStereoWidth(trackId: string): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getTrackStereoWidth) {
      return await window.__JUCE__.backend.getTrackStereoWidth(trackId);
    }
    return 100;
  }

  async setTrackMasterSendEnabled(trackId: string, enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackMasterSendEnabled) {
      return await window.__JUCE__.backend.setTrackMasterSendEnabled(trackId, enabled);
    }
    return true;
  }

  async getTrackMasterSendEnabled(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.getTrackMasterSendEnabled) {
      return await window.__JUCE__.backend.getTrackMasterSendEnabled(trackId);
    }
    return true;
  }

  async setTrackOutputChannels(trackId: string, startChannel: number, numChannels: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackOutputChannels) {
      return await window.__JUCE__.backend.setTrackOutputChannels(trackId, startChannel, numChannels);
    }
    return true;
  }

  async setTrackPlaybackOffset(trackId: string, offsetMs: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackPlaybackOffset) {
      return await window.__JUCE__.backend.setTrackPlaybackOffset(trackId, offsetMs);
    }
    return true;
  }

  async getTrackPlaybackOffset(trackId: string): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getTrackPlaybackOffset) {
      return await window.__JUCE__.backend.getTrackPlaybackOffset(trackId);
    }
    return 0;
  }

  async setTrackChannelCount(trackId: string, numChannels: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackChannelCount) {
      return await window.__JUCE__.backend.setTrackChannelCount(trackId, numChannels);
    }
    return true;
  }

  async getTrackChannelCount(trackId: string): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getTrackChannelCount) {
      return await window.__JUCE__.backend.getTrackChannelCount(trackId);
    }
    return 2;
  }

  async setTrackMIDIOutput(trackId: string, deviceName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackMIDIOutput) {
      return await window.__JUCE__.backend.setTrackMIDIOutput(trackId, deviceName);
    }
    return true;
  }

  async getTrackMIDIOutput(trackId: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getTrackMIDIOutput) {
      return await window.__JUCE__.backend.getTrackMIDIOutput(trackId);
    }
    return "";
  }

  async getTrackRoutingInfo(trackId: string): Promise<{
    phaseInverted: boolean; stereoWidth: number; masterSendEnabled: boolean;
    outputStartChannel: number; outputChannelCount: number; playbackOffsetMs: number;
    trackChannelCount: number; midiOutputDevice: string;
  }> {
    if (this.isNative && window.__JUCE__?.backend.getTrackRoutingInfo) {
      return await window.__JUCE__.backend.getTrackRoutingInfo(trackId);
    }
    return {
      phaseInverted: false, stereoWidth: 100, masterSendEnabled: true,
      outputStartChannel: 0, outputChannelCount: 2, playbackOffsetMs: 0,
      trackChannelCount: 2, midiOutputDevice: "",
    };
  }

  // ===== Phase 12: Media & File Management =====

  async browseDirectory(path: string): Promise<Array<{
    name: string; path: string; size: number; isDirectory: boolean;
    format: string; duration: number; sampleRate: number; numChannels: number;
  }>> {
    if (this.isNative && window.__JUCE__?.backend.browseDirectory) {
      return await window.__JUCE__.backend.browseDirectory(path);
    }
    // Mock: return some fake directory entries
    return [
      { name: "Documents", path: path + "/Documents", size: 0, isDirectory: true, format: "", duration: 0, sampleRate: 0, numChannels: 0 },
      { name: "demo_beat.wav", path: path + "/demo_beat.wav", size: 2456000, isDirectory: false, format: "wav", duration: 4.2, sampleRate: 44100, numChannels: 2 },
      { name: "vocal_take.wav", path: path + "/vocal_take.wav", size: 8320000, isDirectory: false, format: "wav", duration: 12.5, sampleRate: 48000, numChannels: 1 },
    ];
  }

  async previewAudioFile(path: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.previewAudioFile) {
      return await window.__JUCE__.backend.previewAudioFile(path);
    }
    console.log("[NativeBridge] Mock previewAudioFile:", path);
    return true;
  }

  async stopPreview(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.stopPreview) {
      return await window.__JUCE__.backend.stopPreview();
    }
    return true;
  }

  async cleanProjectDirectory(projectDir: string, referencedFiles: string[]): Promise<{
    orphanedFiles: Array<{ path: string; size: number }>;
    totalSize: number;
  }> {
    if (this.isNative && window.__JUCE__?.backend.cleanProjectDirectory) {
      return await window.__JUCE__.backend.cleanProjectDirectory(projectDir, referencedFiles);
    }
    return { orphanedFiles: [], totalSize: 0 };
  }

  async deleteFiles(filePaths: string[]): Promise<{ deleted: number; errors: string[] }> {
    if (this.isNative && window.__JUCE__?.backend.deleteFiles) {
      return await window.__JUCE__.backend.deleteFiles(filePaths);
    }
    console.log("[NativeBridge] Mock deleteFiles:", filePaths);
    return { deleted: filePaths.length, errors: [] };
  }

  async exportProjectMIDI(filePath: string, midiTracks: any[]): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.exportProjectMIDI) {
      return await window.__JUCE__.backend.exportProjectMIDI(filePath, midiTracks);
    }
    console.log("[NativeBridge] Mock exportProjectMIDI:", filePath);
    return true;
  }

  async convertAudioFile(inputPath: string, outputPath: string, format: string, sampleRate: number, bitDepth: number, channels: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.convertAudioFile) {
      return await window.__JUCE__.backend.convertAudioFile(inputPath, outputPath, format, sampleRate, bitDepth, channels);
    }
    console.log("[NativeBridge] Mock convertAudioFile:", inputPath, "->", outputPath);
    return true;
  }

  async getHomeDirectory(): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getHomeDirectory) {
      return await window.__JUCE__.backend.getHomeDirectory();
    }
    return "C:/Users";
  }

  // ===== Phase 13: Advanced Editing =====

  async timeStretchClip(filePath: string, factor: number): Promise<StretchResult> {
    if (this.isNative && window.__JUCE__?.backend.timeStretchClip) {
      const raw = await window.__JUCE__.backend.timeStretchClip(filePath, factor);
      if (typeof raw === "string") {
        // Legacy string response — empty = failure
        return raw ? { success: true, filePath: raw } : { success: false };
      }
      return raw as StretchResult;
    }
    console.log("[NativeBridge] Mock timeStretchClip:", filePath, factor);
    return { success: true, filePath, duration: 0, sampleRate: 44100 };
  }

  async pitchShiftClip(filePath: string, semitones: number): Promise<StretchResult> {
    if (this.isNative && window.__JUCE__?.backend.pitchShiftClip) {
      const raw = await window.__JUCE__.backend.pitchShiftClip(filePath, semitones);
      if (typeof raw === "string") {
        return raw ? { success: true, filePath: raw } : { success: false };
      }
      return raw as StretchResult;
    }
    console.log("[NativeBridge] Mock pitchShiftClip:", filePath, semitones);
    return { success: true, filePath, duration: 0, sampleRate: 44100 };
  }

  // ===== Phase 3.10: Control Surface Support =====

  async connectMIDIControlSurface(inputName: string, outputName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.connectMIDIControlSurface)
      return await window.__JUCE__.backend.connectMIDIControlSurface(inputName, outputName);
    console.log("[NativeBridge] Mock connectMIDIControlSurface:", inputName, outputName);
    return true;
  }

  async disconnectMIDIControlSurface(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.disconnectMIDIControlSurface)
      return await window.__JUCE__.backend.disconnectMIDIControlSurface();
    return true;
  }

  async startMIDILearn(trackId: string, parameter: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.startMIDILearn)
      return await window.__JUCE__.backend.startMIDILearn(trackId, parameter);
    return true;
  }

  async cancelMIDILearn(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.cancelMIDILearn)
      return await window.__JUCE__.backend.cancelMIDILearn();
    return true;
  }

  async getMIDIMappings(): Promise<Array<{ channel: number; cc: number; trackId: string; parameter: string }>> {
    if (this.isNative && window.__JUCE__?.backend.getMIDIMappings)
      return await window.__JUCE__.backend.getMIDIMappings();
    return [];
  }

  async addMIDIMapping(channel: number, cc: number, trackId: string, parameter: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addMIDIMapping)
      return await window.__JUCE__.backend.addMIDIMapping(channel, cc, trackId, parameter);
    return true;
  }

  async removeMIDIMapping(channel: number, cc: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeMIDIMapping)
      return await window.__JUCE__.backend.removeMIDIMapping(channel, cc);
    return true;
  }

  async connectOSC(receivePort: number, sendHost: string, sendPort: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.connectOSC)
      return await window.__JUCE__.backend.connectOSC(receivePort, sendHost, sendPort);
    console.log("[NativeBridge] Mock connectOSC:", receivePort, sendHost, sendPort);
    return true;
  }

  async disconnectOSC(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.disconnectOSC)
      return await window.__JUCE__.backend.disconnectOSC();
    return true;
  }

  async getControlSurfaceMIDIDevices(): Promise<{ inputs: string[]; outputs: string[] }> {
    if (this.isNative && window.__JUCE__?.backend.getControlSurfaceMIDIDevices)
      return await window.__JUCE__.backend.getControlSurfaceMIDIDevices();
    return { inputs: ["Mock MIDI Controller"], outputs: ["Mock MIDI Output"] };
  }

  // Phase 3.12: Strip Silence
  async detectSilentRegions(
    filePath: string, thresholdDb: number, minSilenceMs: number,
    minSoundMs: number, preAttackMs: number, postReleaseMs: number
  ): Promise<Array<{ startTime: number; endTime: number; startSample: number; endSample: number }>> {
    if (this.isNative && window.__JUCE__?.backend.detectSilentRegions)
      return await window.__JUCE__.backend.detectSilentRegions(filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs);
    return [];
  }

  // Phase 3.9: Timecode / Sync
  async connectMIDIClockOutput(midiOutputName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.connectMIDIClockOutput)
      return await window.__JUCE__.backend.connectMIDIClockOutput(midiOutputName);
    return false;
  }

  async setMIDIClockOutputEnabled(enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMIDIClockOutputEnabled)
      return await window.__JUCE__.backend.setMIDIClockOutputEnabled(enabled);
    return false;
  }

  async connectMIDIClockInput(midiInputName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.connectMIDIClockInput)
      return await window.__JUCE__.backend.connectMIDIClockInput(midiInputName);
    return false;
  }

  async setMIDIClockInputEnabled(enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMIDIClockInputEnabled)
      return await window.__JUCE__.backend.setMIDIClockInputEnabled(enabled);
    return false;
  }

  async connectMTCOutput(midiOutputName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.connectMTCOutput)
      return await window.__JUCE__.backend.connectMTCOutput(midiOutputName);
    return false;
  }

  async setMTCEnabled(enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMTCEnabled)
      return await window.__JUCE__.backend.setMTCEnabled(enabled);
    return false;
  }

  async setMTCFrameRate(rate: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMTCFrameRate)
      return await window.__JUCE__.backend.setMTCFrameRate(rate);
    return false;
  }

  async connectMTCInput(midiInputName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.connectMTCInput)
      return await window.__JUCE__.backend.connectMTCInput(midiInputName);
    return false;
  }

  async setSyncSource(source: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setSyncSource)
      return await window.__JUCE__.backend.setSyncSource(source);
    return false;
  }

  async getSyncStatus(): Promise<{ locked: boolean; source: string; externalBPM: number; mtcPosition: number }> {
    if (this.isNative && window.__JUCE__?.backend.getSyncStatus)
      return await window.__JUCE__.backend.getSyncStatus();
    return { locked: true, source: "internal", externalBPM: 120, mtcPosition: 0 };
  }

  // Phase 3.10.2: MCU (Mackie Control Universal)
  async connectMCU(inputName: string, outputName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.connectMCU)
      return await window.__JUCE__.backend.connectMCU(inputName, outputName);
    return false;
  }

  async disconnectMCU(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.disconnectMCU)
      return await window.__JUCE__.backend.disconnectMCU();
    return false;
  }

  async setMCUBankOffset(offset: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMCUBankOffset)
      return await window.__JUCE__.backend.setMCUBankOffset(offset);
    return false;
  }

  // Phase 3.14: Session Interchange
  async importSession(filePath: string): Promise<{ success: boolean; tempo?: number; sampleRate?: number; tracks?: any[]; error?: string }> {
    if (this.isNative && window.__JUCE__?.backend.importSession)
      return await window.__JUCE__.backend.importSession(filePath);
    console.log("[NativeBridge] Mock importSession:", filePath);
    return { success: false, error: "Not available in mock mode" };
  }

  async exportSession(filePath: string, format: string, sessionData: any): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.exportSession)
      return await window.__JUCE__.backend.exportSession(filePath, format, sessionData);
    console.log("[NativeBridge] Mock exportSession:", filePath, format);
    return true;
  }

  // Phase 3.13: Freeze Track
  async freezeTrack(trackId: string): Promise<{ success: boolean; filePath?: string; duration?: number; sampleRate?: number; startTime?: number; error?: string }> {
    if (this.isNative && window.__JUCE__?.backend.freezeTrack)
      return await window.__JUCE__.backend.freezeTrack(trackId);
    return { success: false, error: "Not available in mock mode" };
  }

  async unfreezeTrack(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.unfreezeTrack)
      return await window.__JUCE__.backend.unfreezeTrack(trackId);
    return false;
  }

  // Phase 4.3: Built-in Effects
  async addTrackBuiltInFX(trackId: string, effectName: string, isInputFX?: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addTrackBuiltInFX)
      return await window.__JUCE__.backend.addTrackBuiltInFX(trackId, effectName, isInputFX);
    console.log("[NativeBridge] Mock addTrackBuiltInFX:", trackId, effectName, isInputFX);
    return true;
  }

  async addMasterBuiltInFX(effectName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addMasterBuiltInFX)
      return await window.__JUCE__.backend.addMasterBuiltInFX(effectName);
    console.log("[NativeBridge] Mock addMasterBuiltInFX:", effectName);
    return true;
  }

  async getAvailableBuiltInFX(): Promise<Array<{ name: string; category: string }>> {
    if (this.isNative && window.__JUCE__?.backend.getAvailableBuiltInFX)
      return await window.__JUCE__.backend.getAvailableBuiltInFX();
    return [
      { name: "OpenStudio EQ", category: "Built-in" },
      { name: "OpenStudio Compressor", category: "Built-in" },
      { name: "OpenStudio Gate", category: "Built-in" },
      { name: "OpenStudio Limiter", category: "Built-in" },
      { name: "OpenStudio Delay", category: "Built-in" },
      { name: "OpenStudio Reverb", category: "Built-in" },
      { name: "OpenStudio Chorus", category: "Built-in" },
      { name: "OpenStudio Saturator", category: "Built-in" },
    ];
  }

  // Phase 4.4: Sidechain Routing
  async setSidechainSource(destTrackId: string, pluginIndex: number, sourceTrackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setSidechainSource)
      return await window.__JUCE__.backend.setSidechainSource(destTrackId, pluginIndex, sourceTrackId);
    console.log("[NativeBridge] Mock setSidechainSource:", destTrackId, pluginIndex, sourceTrackId);
    return true;
  }

  async clearSidechainSource(destTrackId: string, pluginIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.clearSidechainSource)
      return await window.__JUCE__.backend.clearSidechainSource(destTrackId, pluginIndex);
    console.log("[NativeBridge] Mock clearSidechainSource:", destTrackId, pluginIndex);
    return true;
  }

  async getSidechainSource(destTrackId: string, pluginIndex: number): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getSidechainSource)
      return await window.__JUCE__.backend.getSidechainSource(destTrackId, pluginIndex);
    return "";
  }

  // Phase 3.7: Surround / Spatial Audio
  async getSurroundLayouts(): Promise<Array<{ name: string; channels: number }>> {
    if (this.isNative && window.__JUCE__?.backend.getSurroundLayouts)
      return await window.__JUCE__.backend.getSurroundLayouts();
    return [
      { name: "Stereo", channels: 2 },
      { name: "Quad", channels: 4 },
      { name: "5.1 Surround", channels: 6 },
      { name: "7.1 Surround", channels: 8 },
      { name: "7.1.4 Atmos", channels: 12 },
    ];
  }

  // Phase 15: Platform & Extensibility
  async openVideoFile(filePath: string): Promise<{ width: number; height: number; duration: number; fps: number; filePath: string; audioPath?: string; error?: string }> {
    if (this.isNative && window.__JUCE__?.backend.openVideoFile) {
      return await window.__JUCE__.backend.openVideoFile(filePath);
    }
    console.log("[NativeBridge] Mock openVideoFile:", filePath);
    return { width: 1920, height: 1080, duration: 120, fps: 30, filePath };
  }

  async getVideoFrame(time: number, width?: number, height?: number): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getVideoFrame) {
      return await window.__JUCE__.backend.getVideoFrame(time, width, height);
    }
    // Mock: return empty 1x1 transparent pixel
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  }

  closeVideoFile(): void {
    if (this.isNative && window.__JUCE__?.backend.closeVideoFile) {
      window.__JUCE__.backend.closeVideoFile();
    }
    console.log("[NativeBridge] Mock closeVideoFile");
  }

  async executeScript(code: string): Promise<{ result: string; error: string }> {
    // Prefer the new Lua backend (runScriptCode) over the legacy stub
    if (this.isNative && window.__JUCE__?.backend.runScriptCode) {
      const res = await window.__JUCE__.backend.runScriptCode(code);
      return { result: res.output || (res.success ? "OK" : ""), error: res.error || "" };
    }
    if (this.isNative && window.__JUCE__?.backend.executeScript) {
      return await window.__JUCE__.backend.executeScript(code);
    }
    console.log("[NativeBridge] Mock executeScript:", code.substring(0, 100));
    return { result: "Script executed (mock)", error: "" };
  }

  async loadScriptFile(filePath: string): Promise<{ result: string; error: string }> {
    // Prefer the new Lua backend (runScript) over the legacy stub
    if (this.isNative && window.__JUCE__?.backend.runScript) {
      const res = await window.__JUCE__.backend.runScript(filePath);
      return { result: res.output || (res.success ? "OK" : ""), error: res.error || "" };
    }
    if (this.isNative && window.__JUCE__?.backend.loadScriptFile) {
      return await window.__JUCE__.backend.loadScriptFile(filePath);
    }
    console.log("[NativeBridge] Mock loadScriptFile:", filePath);
    return { result: "Script loaded (mock)", error: "" };
  }

  async setLTCOutput(enabled: boolean, channel: number, frameRate: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setLTCOutput) {
      return await window.__JUCE__.backend.setLTCOutput(enabled, channel, frameRate);
    }
    console.log("[NativeBridge] Mock setLTCOutput:", enabled, channel, frameRate);
    return true;
  }

  // Phase 16: Pro Audio & Compatibility
  async startLiveCapture(format: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.startLiveCapture) {
      return await window.__JUCE__.backend.startLiveCapture(format);
    }
    console.log("[NativeBridge] Mock startLiveCapture:", format);
    return "mock_capture.wav";
  }

  async stopLiveCapture(): Promise<{ filePath: string; duration: number }> {
    if (this.isNative && window.__JUCE__?.backend.stopLiveCapture) {
      return await window.__JUCE__.backend.stopLiveCapture();
    }
    console.log("[NativeBridge] Mock stopLiveCapture");
    return { filePath: "mock_capture.wav", duration: 0 };
  }

  async exportDDP(sourceWavPath: string, outputDir: string, tracks: any[], catalogNumber?: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.exportDDP) {
      return await window.__JUCE__.backend.exportDDP(sourceWavPath, outputDir, tracks, catalogNumber);
    }
    console.log("[NativeBridge] Mock exportDDP:", sourceWavPath, outputDir, tracks.length, "tracks");
    return true;
  }

  // ==================== Phase 4.1: Clip Launcher ====================
  async triggerSlot(trackIndex: number, slotIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.triggerSlot)
      return await window.__JUCE__.backend.triggerSlot(trackIndex, slotIndex);
    console.log("[NativeBridge] Mock triggerSlot:", trackIndex, slotIndex);
    return true;
  }

  async stopSlot(trackIndex: number, slotIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.stopSlot)
      return await window.__JUCE__.backend.stopSlot(trackIndex, slotIndex);
    console.log("[NativeBridge] Mock stopSlot:", trackIndex, slotIndex);
    return true;
  }

  async triggerScene(slotIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.triggerScene)
      return await window.__JUCE__.backend.triggerScene(slotIndex);
    console.log("[NativeBridge] Mock triggerScene:", slotIndex);
    return true;
  }

  async stopAllSlots(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.stopAllSlots)
      return await window.__JUCE__.backend.stopAllSlots();
    console.log("[NativeBridge] Mock stopAllSlots");
    return true;
  }

  async setSlotClip(trackIndex: number, slotIndex: number, filePath: string, duration: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setSlotClip)
      return await window.__JUCE__.backend.setSlotClip(trackIndex, slotIndex, filePath, duration);
    console.log("[NativeBridge] Mock setSlotClip:", trackIndex, slotIndex, filePath, duration);
    return true;
  }

  async clearSlot(trackIndex: number, slotIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.clearSlot)
      return await window.__JUCE__.backend.clearSlot(trackIndex, slotIndex);
    console.log("[NativeBridge] Mock clearSlot:", trackIndex, slotIndex);
    return true;
  }

  async getClipLauncherState(): Promise<ClipLauncherState> {
    if (this.isNative && window.__JUCE__?.backend.getClipLauncherState)
      return await window.__JUCE__.backend.getClipLauncherState();
    return { slots: [], numTracks: 0, numSlots: 8 };
  }

  // ==================== Window Management ====================
  async minimizeWindow(): Promise<void> {
    if (this.isNative && window.__JUCE__?.backend.minimizeWindow) {
      await window.__JUCE__.backend.minimizeWindow();
    }
  }

  async maximizeWindow(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.maximizeWindow) {
      return await window.__JUCE__.backend.maximizeWindow();
    }
    return false;
  }

  async closeWindow(): Promise<void> {
    if (this.isNative && window.__JUCE__?.backend.closeWindow) {
      await window.__JUCE__.backend.closeWindow();
    }
  }

  async isWindowMaximized(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.isWindowMaximized) {
      return await window.__JUCE__.backend.isWindowMaximized();
    }
    return false;
  }

  async startWindowDrag(): Promise<void> {
    if (this.isNative && window.__JUCE__?.backend.startWindowDrag) {
      await window.__JUCE__.backend.startWindowDrag();
    }
  }

  async openMixerWindow(bounds?: Partial<WindowBounds>): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openMixerWindow) {
      return await window.__JUCE__.backend.openMixerWindow(bounds);
    }
    return false;
  }

  async closeMixerWindow(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.closeMixerWindow) {
      return await window.__JUCE__.backend.closeMixerWindow();
    }
    return false;
  }

  async getMixerWindowState(): Promise<MixerWindowState> {
    if (this.isNative && window.__JUCE__?.backend.getMixerWindowState) {
      return await window.__JUCE__.backend.getMixerWindowState();
    }
    return { isOpen: false };
  }

  async publishMixerUISnapshot(snapshot: any): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.publishMixerUISnapshot) {
      return await window.__JUCE__.backend.publishMixerUISnapshot(snapshot);
    }
    return false;
  }

  async getMixerUISnapshot<T = any>(): Promise<T | null> {
    if (this.isNative && window.__JUCE__?.backend.getMixerUISnapshot) {
      return await window.__JUCE__.backend.getMixerUISnapshot();
    }
    return null;
  }

  // Event subscription
  subscribe(eventId: string, callback: (data: any) => void): () => void {
    if (this.isNative && window.__JUCE__?.backend.addEventListener) {
      const token = window.__JUCE__.backend.addEventListener(eventId, callback);
      return () => {
        if (window.__JUCE__?.backend.removeEventListener) {
          window.__JUCE__.backend.removeEventListener(token);
        }
      };
    } else {
      // Mock subscription
      if (!this.eventListeners.has(eventId)) {
        this.eventListeners.set(eventId, new Set());
      }
      this.eventListeners.get(eventId)!.add(callback);
      return () => {
        this.eventListeners.get(eventId)?.delete(callback);
      };
    }
  }

  onNativeGlobalShortcut(callback: (event: NativeGlobalShortcutEvent) => void): () => void {
    return this.subscribe("nativeGlobalShortcut", callback);
  }

  // Sprint 16: Performance + Audio Quality

  async setPanLaw(law: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setPanLaw)
      return await window.__JUCE__.backend.setPanLaw(law);
    console.log("[NativeBridge] Mock setPanLaw:", law);
    return true;
  }

  async getPanLaw(): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getPanLaw)
      return await window.__JUCE__.backend.getPanLaw();
    return "constant_power";
  }

  async setTrackDCOffset(trackId: string, enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackDCOffset)
      return await window.__JUCE__.backend.setTrackDCOffset(trackId, enabled);
    console.log("[NativeBridge] Mock setTrackDCOffset:", trackId, enabled);
    return true;
  }

  // ==================== Sprint 19: Plugin Management ====================

  async getPluginParameters(trackId: string, fxIndex: number, isInputFX: boolean): Promise<Array<{ index: number; name: string; value: number; text: string }>> {
    if (this.isNative && window.__JUCE__?.backend.getPluginParameters)
      return await window.__JUCE__.backend.getPluginParameters(trackId, fxIndex, isInputFX);
    console.log("[NativeBridge] Mock getPluginParameters:", trackId, fxIndex, isInputFX);
    return [
      { index: 0, name: "Gain", value: 0.5, text: "0.0 dB" },
      { index: 1, name: "Mix", value: 1.0, text: "100%" },
    ];
  }

  async setPluginParameter(trackId: string, fxIndex: number, isInputFX: boolean, paramIndex: number, value: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setPluginParameter)
      return await window.__JUCE__.backend.setPluginParameter(trackId, fxIndex, isInputFX, paramIndex, value);
    console.log("[NativeBridge] Mock setPluginParameter:", trackId, fxIndex, isInputFX, paramIndex, value);
    return true;
  }

  async getPluginPresets(trackId: string, fxIndex: number, isInputFX: boolean): Promise<string[]> {
    if (this.isNative && window.__JUCE__?.backend.getPluginPresets)
      return await window.__JUCE__.backend.getPluginPresets(trackId, fxIndex, isInputFX);
    return ["Default", "Preset 1", "Preset 2"];
  }

  async loadPluginPreset(trackId: string, fxIndex: number, isInputFX: boolean, presetName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.loadPluginPreset)
      return await window.__JUCE__.backend.loadPluginPreset(trackId, fxIndex, isInputFX, presetName);
    console.log("[NativeBridge] Mock loadPluginPreset:", trackId, fxIndex, isInputFX, presetName);
    return true;
  }

  async savePluginPreset(trackId: string, fxIndex: number, isInputFX: boolean, presetName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.savePluginPreset)
      return await window.__JUCE__.backend.savePluginPreset(trackId, fxIndex, isInputFX, presetName);
    console.log("[NativeBridge] Mock savePluginPreset:", trackId, fxIndex, isInputFX, presetName);
    return true;
  }

  async startPluginMIDILearn(trackId: string, pluginIndex: number, paramIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.startPluginMIDILearn)
      return await window.__JUCE__.backend.startPluginMIDILearn(trackId, pluginIndex, paramIndex);
    console.log("[NativeBridge] Mock startPluginMIDILearn:", trackId, pluginIndex, paramIndex);
    return true;
  }

  async cancelPluginMIDILearn(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.cancelPluginMIDILearn)
      return await window.__JUCE__.backend.cancelPluginMIDILearn();
    return true;
  }

  // ==================== Sprint 19: MIDI Import/Export ====================

  async importMIDIFile(filePath: string): Promise<{ success: boolean; tracks: Array<{ name: string; channel: number; events: any[] }>; error?: string }> {
    if (this.isNative && window.__JUCE__?.backend.importMIDIFile)
      return await window.__JUCE__.backend.importMIDIFile(filePath);
    console.log("[NativeBridge] Mock importMIDIFile:", filePath);
    return { success: true, tracks: [] };
  }

  async exportMIDIFile(filePath: string, tracksJSON: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.exportMIDIFile)
      return await window.__JUCE__.backend.exportMIDIFile(filePath, tracksJSON);
    console.log("[NativeBridge] Mock exportMIDIFile:", filePath);
    return true;
  }

  // ==================== Sprint 19: A/B Plugin Comparison ====================

  async storePluginStateA(trackId: string, fxIndex: number, isInputFX: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.storePluginStateA)
      return await window.__JUCE__.backend.storePluginStateA(trackId, fxIndex, isInputFX);
    return true;
  }

  async storePluginStateB(trackId: string, fxIndex: number, isInputFX: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.storePluginStateB)
      return await window.__JUCE__.backend.storePluginStateB(trackId, fxIndex, isInputFX);
    return true;
  }

  async recallPluginStateA(trackId: string, fxIndex: number, isInputFX: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.recallPluginStateA)
      return await window.__JUCE__.backend.recallPluginStateA(trackId, fxIndex, isInputFX);
    return true;
  }

  async recallPluginStateB(trackId: string, fxIndex: number, isInputFX: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.recallPluginStateB)
      return await window.__JUCE__.backend.recallPluginStateB(trackId, fxIndex, isInputFX);
    return true;
  }

  // ==================== Sprint 20: Metering & Analysis ====================

  async getLoudnessData(): Promise<{ integrated: number; shortTerm: number; momentary: number; truePeak: number; range: number }> {
    if (this.isNative && window.__JUCE__?.backend.getLoudnessData)
      return await window.__JUCE__.backend.getLoudnessData();
    return { integrated: -23, shortTerm: -20, momentary: -18, truePeak: -1, range: 8 };
  }

  async getPhaseCorrelation(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getPhaseCorrelation)
      return await window.__JUCE__.backend.getPhaseCorrelation();
    return 0.85;
  }

  async getSpectrumData(): Promise<number[]> {
    if (this.isNative && window.__JUCE__?.backend.getSpectrumData)
      return await window.__JUCE__.backend.getSpectrumData();
    // Mock: return empty spectrum
    return [];
  }

  // ==================== Clip Gain Envelope ====================

  async setClipGainEnvelope(trackId: string, clipId: string, envelope: Array<{ time: number; gain: number }>): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setClipGainEnvelope)
      return await window.__JUCE__.backend.setClipGainEnvelope(trackId, clipId, JSON.stringify(envelope));
    console.log("[NativeBridge] Mock setClipGainEnvelope:", trackId, clipId, envelope.length, "points");
    return true;
  }

  // ==================== Timecode Sync (additional) ====================

  async setTimecodeFrameRate(fps: string): Promise<boolean> {
    // Map fps string to numeric SMPTE enum: 0=24, 1=25, 2=29.97df, 3=30
    const fpsMap: Record<string, number> = { "24": 0, "25": 1, "29.97df": 2, "30": 3 };
    const rate = fpsMap[fps] ?? 3;
    return this.setMTCFrameRate(rate);
  }

  async setTimecodeMIDIDevice(deviceId: string, isInput: boolean): Promise<boolean> {
    // Route to existing low-level connect functions
    if (isInput) {
      return this.connectMTCInput(deviceId);
    } else {
      return this.connectMTCOutput(deviceId);
    }
  }

  // ==================== Channel Strip EQ (Phase 19.18) ====================

  async setChannelStripEQEnabled(trackId: string, enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setChannelStripEQEnabled)
      return await window.__JUCE__.backend.setChannelStripEQEnabled(trackId, enabled);
    return true;
  }

  async setChannelStripEQParam(trackId: string, paramIndex: number, value: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setChannelStripEQParam)
      return await window.__JUCE__.backend.setChannelStripEQParam(trackId, paramIndex, value);
    return true;
  }

  async getChannelStripEQParam(trackId: string, paramIndex: number): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getChannelStripEQParam)
      return await window.__JUCE__.backend.getChannelStripEQParam(trackId, paramIndex);
    return 0;
  }

  // ==================== Pitch Corrector ====================

  async getPitchCorrectorData(trackId: string, fxIndex: number): Promise<PitchCorrectorData | null> {
    if (this.isNative && window.__JUCE__?.backend.getPitchCorrectorData)
      return await window.__JUCE__.backend.getPitchCorrectorData(trackId, fxIndex);
    return null;
  }

  async setPitchCorrectorParam(trackId: string, fxIndex: number, param: string, value: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setPitchCorrectorParam)
      return await window.__JUCE__.backend.setPitchCorrectorParam(trackId, fxIndex, param, value);
    return true;
  }

  async getPitchHistory(trackId: string, fxIndex: number, numFrames: number): Promise<PitchHistoryFrame[]> {
    if (this.isNative && window.__JUCE__?.backend.getPitchHistory)
      return await window.__JUCE__.backend.getPitchHistory(trackId, fxIndex, numFrames);
    return [];
  }

  // ==================== Pitch Corrector (Graphical Mode) ====================

  async analyzePitchContour(trackId: string, clipId: string): Promise<PitchContourData | null> {
    if (this.isNative && window.__JUCE__?.backend.analyzePitchContour)
      return await window.__JUCE__.backend.analyzePitchContour(trackId, clipId);
    return null;
  }

  async analyzePitchContourDirect(filePath: string, offset: number, duration: number, clipId: string): Promise<PitchContourData | null> {
    if (this.isNative && window.__JUCE__?.backend.analyzePitchContourDirect)
      return await window.__JUCE__.backend.analyzePitchContourDirect(filePath, offset, duration, clipId);
    return null;
  }

  async getLastPitchAnalysisResult(): Promise<PitchContourData | null> {
    if (this.isNative && window.__JUCE__?.backend.getLastPitchAnalysisResult)
      return await window.__JUCE__.backend.getLastPitchAnalysisResult();
    return null;
  }

  async applyPitchCorrection(
    trackId: string,
    clipId: string,
    notes: PitchNoteData[],
    frames?: PitchContourData['frames'],
    requestId?: string,
    globalFormantSemitones?: number,
    windowStartSec?: number,
    windowEndSec?: number,
    renderMode: PitchCorrectionRenderMode = "single",
    requestGroupId?: string,
  ): Promise<{ outputFile: string; success: boolean } | null> {
    if (shouldLogPitchEditorFormant()) {
      let pitchEdits = 0;
      let noteFormantEdits = 0;
      let gainEdits = 0;
      let driftEdits = 0;
      let vibratoEdits = 0;
      for (const note of notes) {
        if (Math.abs(note.correctedPitch - note.detectedPitch) > 0.01) pitchEdits++;
        if (Math.abs(note.formantShift) > 0.01) noteFormantEdits++;
        if (Math.abs(note.gain) > 0.01) gainEdits++;
        if (note.driftCorrectionAmount > 0.01) driftEdits++;
        if (Math.abs(note.vibratoDepth - 1.0) > 0.01) vibratoEdits++;
      }
      console.log(FORMANT_LOG_PREFIX, "bridge applyPitchCorrection payload", {
        trackId,
        clipId,
        requestId,
        noteCount: notes.length,
        pitchEdits,
        noteFormantEdits,
        gainEdits,
        driftEdits,
        vibratoEdits,
        frameCount: frames?.times?.length ?? 0,
        globalFormantSemitones: globalFormantSemitones ?? 0,
        windowStartSec: windowStartSec ?? null,
        windowEndSec: windowEndSec ?? null,
        renderMode,
        requestGroupId: requestGroupId ?? null,
      });
    }
    if (this.isNative && window.__JUCE__?.backend.applyPitchCorrection)
      return await window.__JUCE__.backend.applyPitchCorrection(trackId, clipId, notes, frames, requestId, globalFormantSemitones, windowStartSec, windowEndSec, renderMode, requestGroupId);
    return null;
  }

  async previewPitchCorrection(trackId: string, clipId: string, notes: PitchNoteData[]): Promise<{ outputFile: string; success: boolean } | null> {
    if (this.isNative && window.__JUCE__?.backend.previewPitchCorrection)
      return await window.__JUCE__.backend.previewPitchCorrection(trackId, clipId, notes);
    return null;
  }

  async clearClipRenderedPreviewSegments(clipId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.clearClipRenderedPreviewSegments)
      return await window.__JUCE__.backend.clearClipRenderedPreviewSegments(clipId);
    return false;
  }

  // ==================== Polyphonic Pitch Detection (Phase 6) ====================

  async analyzePolyphonic(trackId: string, clipId: string, options?: { noteThreshold?: number; onsetThreshold?: number; minDurationMs?: number }): Promise<PolyAnalysisResult | null> {
    if (this.isNative && window.__JUCE__?.backend.analyzePolyphonic)
      return await window.__JUCE__.backend.analyzePolyphonic(trackId, clipId, options);
    // Mock: return empty result
    return { clipId, sampleRate: 22050, hopSize: 256, pitchSalience: [], salienceDownsampleFactor: 1, notes: [] };
  }

  async extractMidiFromAudio(trackId: string, clipId: string): Promise<PolyAnalysisResult | null> {
    if (this.isNative && window.__JUCE__?.backend.extractMidiFromAudio)
      return await window.__JUCE__.backend.extractMidiFromAudio(trackId, clipId);
    return null;
  }

  async isPolyphonicDetectionAvailable(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.isPolyphonicDetectionAvailable)
      return await window.__JUCE__.backend.isPolyphonicDetectionAvailable();
    return false;
  }

  // ==================== Polyphonic Pitch Editing (Phase 7) ====================

  async applyPolyPitchCorrection(trackId: string, clipId: string, editedNotes: any[]): Promise<{ outputFile: string; success: boolean } | null> {
    if (this.isNative && window.__JUCE__?.backend.applyPolyPitchCorrection)
      return await window.__JUCE__.backend.applyPolyPitchCorrection(trackId, clipId, editedNotes);
    return null;
  }

  async soloPolyNote(trackId: string, clipId: string, noteId: string): Promise<{ outputFile: string; success: boolean } | null> {
    if (this.isNative && window.__JUCE__?.backend.soloPolyNote)
      return await window.__JUCE__.backend.soloPolyNote(trackId, clipId, noteId);
    return null;
  }

  async setPitchCorrectionBypass(trackId: string, clipId: string, bypass: boolean): Promise<void> {
    if (this.isNative && window.__JUCE__?.backend.setPitchCorrectionBypass)
      await window.__JUCE__.backend.setPitchCorrectionBypass(trackId, clipId, bypass);
  }

  /** Set real-time pitch/formant preview state for a clip */
  async setClipPitchPreview(clipId: string, payload: ClipPitchPreviewPayload): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setClipPitchPreview)
      return await window.__JUCE__.backend.setClipPitchPreview(clipId, payload);
    return false;
  }

  /** Clear real-time pitch preview for a clip */
  async clearClipPitchPreview(clipId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.clearClipPitchPreview)
      return await window.__JUCE__.backend.clearClipPitchPreview(clipId);
    return false;
  }

  // ==================== Phase 8: Source Separation ====================

  async separateStems(trackId: string, clipId: string): Promise<StemSeparationResult> {
    if (this.isNative && window.__JUCE__?.backend.separateStems)
      return await window.__JUCE__.backend.separateStems(trackId, clipId);
    console.log("[NativeBridge] Mock separateStems:", trackId, clipId);
    return { success: false, error: "Not available in dev mode" };
  }

  async isStemSeparationAvailable(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.isStemSeparationAvailable)
      return await window.__JUCE__.backend.isStemSeparationAvailable();
    return false;
  }

  async getAiToolsStatus(): Promise<AiToolsStatus> {
    if (this.isNative && window.__JUCE__?.backend.getAiToolsStatus) {
      return await window.__JUCE__.backend.getAiToolsStatus();
    }

      return {
        state: "runtimeMissing",
        progress: 0,
        available: false,
        installerAvailable: false,
        pythonDetected: false,
        scriptAvailable: false,
        runtimeInstalled: false,
        modelInstalled: false,
        installInProgress: false,
        requiresExternalPython: false,
        message: "AI tools are unavailable in the web preview.",
        installSource: "none",
        buildRuntimeMode: "downloaded-runtime",
        supportedBackends: ["cpu"],
        selectedBackend: "cpu",
        restartRequired: false,
      };
  }

  async refreshAiToolsStatus(): Promise<AiToolsStatus> {
    if (this.isNative && window.__JUCE__?.backend.refreshAiToolsStatus) {
      return await window.__JUCE__.backend.refreshAiToolsStatus();
    }

    return this.getAiToolsStatus();
  }

  async installAiTools(): Promise<InstallAiToolsResponse> {
    if (this.isNative && window.__JUCE__?.backend.installAiTools) {
      return await window.__JUCE__.backend.installAiTools();
    }

    return {
      started: false,
      error: "AI tools installation is unavailable in the web preview.",
      status: await this.getAiToolsStatus(),
    };
  }

  // ==================== Phase 10: Stem Separation Workflow ====================

  async separateStemsAsync(trackId: string, clipId: string, options: { stems: string[]; filePath?: string; accelerationMode?: "auto" | "cpu-only" }): Promise<{ started: boolean; error?: string; cached?: boolean }> {
    if (this.isNative && window.__JUCE__?.backend.separateStemsAsync)
      return await window.__JUCE__.backend.separateStemsAsync(trackId, clipId, JSON.stringify(options));
    console.log("[NativeBridge] Mock separateStemsAsync:", trackId, clipId, options);
    return { started: true };
  }

  async getStemSeparationProgress(): Promise<StemSepProgress> {
    if (this.isNative && window.__JUCE__?.backend.getStemSeparationProgress)
      return await window.__JUCE__.backend.getStemSeparationProgress();
    return { state: "idle", progress: 0 };
  }

  async cancelStemSeparation(): Promise<void> {
    if (this.isNative && window.__JUCE__?.backend.cancelStemSeparation)
      return await window.__JUCE__.backend.cancelStemSeparation();
  }

  async cancelAiToolsInstall(): Promise<void> {
    if (this.isNative && window.__JUCE__?.backend.cancelAiToolsInstall)
      return await window.__JUCE__.backend.cancelAiToolsInstall();
  }

  // ==================== Phase 9: ARA Plugin Hosting ====================

  async initializeARA(trackId: string, fxIndex: number): Promise<{ success: boolean; error?: string }> {
    if (this.isNative && window.__JUCE__?.backend.initializeARA)
      return await window.__JUCE__.backend.initializeARA(trackId, fxIndex);
    return { success: false, error: "Not available in dev mode" };
  }

  async addARAClip(trackId: string, clipId: string): Promise<{ success: boolean; error?: string }> {
    if (this.isNative && window.__JUCE__?.backend.addARAClip)
      return await window.__JUCE__.backend.addARAClip(trackId, clipId);
    return { success: false, error: "Not available in dev mode" };
  }

  async removeARAClip(trackId: string, clipId: string): Promise<{ success: boolean }> {
    if (this.isNative && window.__JUCE__?.backend.removeARAClip)
      return await window.__JUCE__.backend.removeARAClip(trackId, clipId);
    return { success: false };
  }

  async getARAStatus(trackId: string): Promise<ARAStatus> {
    if (this.isNative && window.__JUCE__?.backend.getARAStatus)
      return await window.__JUCE__.backend.getARAStatus(trackId);
    return {
      active: false,
      activeFxIndex: -1,
      lastAttemptFxIndex: -1,
      lastAttemptComplete: false,
      lastAttemptWasARAPlugin: false,
      lastAttemptSucceeded: false,
      analysisProgress: 0,
      analysisComplete: false,
      analysisRequested: false,
      analysisStarted: false,
      lastAnalysisProgressValue: 0,
      sourceCount: 0,
      playbackRegionCount: 0,
      audioSourceSamplesAccessEnabled: false,
      editorRendererAttached: false,
      playbackRendererAttached: false,
      error: "",
    };
  }

  async shutdownARA(trackId: string): Promise<{ success: boolean }> {
    if (this.isNative && window.__JUCE__?.backend.shutdownARA)
      return await window.__JUCE__.backend.shutdownARA(trackId);
    return { success: false };
  }

  async isARAActive(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.isARAActive)
      return await window.__JUCE__.backend.isARAActive(trackId);
    return false;
  }

  async hasAnyActiveARA(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.hasAnyActiveARA)
      return await window.__JUCE__.backend.hasAnyActiveARA();
    return false;
  }

  // ==================== Sprint 20: File System Helpers ====================

  async browseForFile(title: string, filters?: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.browseForFile)
      return await window.__JUCE__.backend.browseForFile(title, filters);
    console.log("[NativeBridge] Mock browseForFile:", title, filters);
    return "";
  }

  async browseForFolder(title: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.browseForFolder)
      return await window.__JUCE__.backend.browseForFolder(title);
    console.log("[NativeBridge] Mock browseForFolder:", title);
    return "";
  }

  async fileExists(filePath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.fileExists)
      return await window.__JUCE__.backend.fileExists(filePath);
    return true;
  }

  // ==================== Sprint 20: Session Archive ====================

  async archiveSession(projectDir: string, outputPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.archiveSession)
      return await window.__JUCE__.backend.archiveSession(projectDir, outputPath);
    console.log("[NativeBridge] Mock archiveSession:", projectDir, outputPath);
    return true;
  }
}

export const nativeBridge = new NativeBridge();

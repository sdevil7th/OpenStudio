import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { nativeBridge } from "../services/NativeBridge";
import { Command, commandManager } from "./commands";
import { calculateGridInterval, type GridSize } from "../utils/snapToGrid";
import { automationToBackend, interpolateAtTime } from "./automationParams";
import { usePitchEditorStore } from "./pitchEditorStore";

// Module-level snapshot map for continuous edit undo/redo (volume/pan fader drags).
// Stores the value at edit start so we can create a single undo command on edit end.
const _editSnapshots = new Map<string, number>();

// Helper: sync an automation lane's points to the C++ backend.
// Converts normalised 0–1 frontend values to backend-native values:
//   volume: 0–1 → -60 to +6 dB
//   pan:    0–1 → -1.0 to +1.0
// Module-level throttle map for automation point recording during fader movement
const _autoRecordTimers = new Map<string, number>();
const AUTO_RECORD_INTERVAL_MS = 50;

function syncAutomationLaneToBackend(
  trackId: string,
  lane: { param: string; points: { time: number; value: number }[]; mode?: AutomationModeType },
) {
  const parameterId = lane.param;
  const converted = lane.points.map((p) => ({
    time: p.time,
    value: automationToBackend(lane.param, p.value),
  }));
  nativeBridge.setAutomationPoints(trackId, parameterId, converted).catch(() => {});
  // Sync the lane's actual mode (not hardcoded "read")
  if (lane.mode) {
    nativeBridge.setAutomationMode(trackId, parameterId, lane.mode).catch(() => {});
  }
}

// Sync all tempo markers to the C++ backend (Phase 1.2)
function syncTempoMarkersToBackend(markers: { time: number; tempo: number }[]) {
  if (markers.length === 0) {
    nativeBridge.clearTempoMarkers().catch(() => {});
  } else {
    nativeBridge.setTempoMarkers(markers).catch(() => {});
  }
}

// Group colors for visual linking brackets/tints
export const TRACK_GROUP_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#eab308",
  "#8b5cf6", "#ec4899", "#f97316", "#14b8a6",
];

// Helper: find the group a track belongs to and return its color index
export function getTrackGroupInfo(
  trackId: string,
  trackGroups: Array<{ id: string; memberTrackIds: string[] }>,
): { groupId: string; colorIndex: number } | null {
  for (let i = 0; i < trackGroups.length; i++) {
    if (trackGroups[i].memberTrackIds.includes(trackId)) {
      return { groupId: trackGroups[i].id, colorIndex: i % TRACK_GROUP_COLORS.length };
    }
  }
  return null;
}

// Re-entrance guard for linked track parameter syncing.
// Prevents infinite loops when changing a linked track triggers the same action
// on other linked tracks.
const _linkingInProgress = new Set<string>();

// Diff-based sync cache: tracks which clips were last sent to the C++ backend.
// Key format: "trackId|filePath|startTime|duration|offset|volumeDB|fadeIn|fadeOut"
// On play, we diff against this to only add/remove changed clips (Sprint 16.3).
let _lastSyncedClipKeys = new Set<string>();

function makeClipKey(
  trackId: string,
  filePath: string,
  startTime: number,
  duration: number,
  offset: number,
  volumeDB: number,
  fadeIn: number,
  fadeOut: number,
): string {
  return `${trackId}|${filePath}|${startTime}|${duration}|${offset}|${volumeDB}|${fadeIn}|${fadeOut}`;
}

// Reset the sync cache (call on project load/new)
export function resetSyncCache() {
  _lastSyncedClipKeys = new Set<string>();
}

// Returns all member IDs in the same track group as `trackId`, or just `[trackId]`.
function getLinkedTrackIds(
  trackId: string,
  trackGroups: Array<{ id: string; memberTrackIds: string[]; linkedParams: string[] }>,
  param?: string,
): string[] {
  for (const g of trackGroups) {
    if (g.memberTrackIds.includes(trackId)) {
      if (param && !g.linkedParams.includes(param)) return [trackId];
      return g.memberTrackIds;
    }
  }
  return [trackId];
}

// ============================================
// Type Definitions
// ============================================

export type TrackType = "audio" | "midi" | "instrument" | "bus";
export type InputType = "mono" | "stereo" | "midi";

// MIDI Event structure
export interface MIDIEvent {
  timestamp: number; // Time in seconds from clip start
  type: "noteOn" | "noteOff" | "cc" | "pitchBend";
  note?: number; // 0-127 for note events
  velocity?: number; // 0-127 for note events
  controller?: number; // CC number
  value?: number; // CC value or pitch bend
  pitchBend?: number; // Per-note pitch bend, -1.0 to +1.0
  pressure?: number; // Per-note pressure/aftertouch, 0.0 to 1.0
  slide?: number; // Per-note slide (CC74), 0.0 to 1.0
}

// CC Event for MIDI CC lane editing
export interface MIDICCEvent {
  cc: number;       // CC number (e.g. 1=Mod, 7=Vol, 10=Pan, 11=Expr, 64=Sustain)
  time: number;     // Time in seconds from clip start
  value: number;    // 0-127
}

// MIDI Clip structure
export interface MIDIClip {
  id: string;
  name: string;
  startTime: number; // Position on timeline in seconds
  duration: number; // Duration in seconds
  events: MIDIEvent[];
  ccEvents?: MIDICCEvent[]; // CC lane events for piano roll editing
  color: string;
}

// Supports built-in params plus plugin params like "plugin_0_3" (fxIndex_paramIndex)
export type AutomationParam = "volume" | "pan" | "mute" | (string & {});
export type AutomationModeType = "off" | "read" | "write" | "touch" | "latch";
export const AUTOMATION_LANE_HEIGHT = 60; // px per visible automation lane

export interface AutomationPoint {
  time: number; // Position in seconds
  value: number; // 0.0 to 1.0 normalized value
}

export interface AutomationLane {
  id: string;
  param: AutomationParam;
  points: AutomationPoint[];
  visible: boolean;
  mode: AutomationModeType;
  armed: boolean;
}

// ===== Automation Layout Helpers =====

export function getEffectiveTrackHeight(track: Track, baseTrackHeight: number): number {
  if (!track.showAutomation) return baseTrackHeight;
  const visibleLaneCount = track.automationLanes.filter((l) => l.visible).length;
  return baseTrackHeight + visibleLaneCount * AUTOMATION_LANE_HEIGHT;
}

export function getTrackYPositions(
  tracks: Track[],
  baseTrackHeight: number,
): { trackYs: number[]; totalHeight: number } {
  const trackYs: number[] = [];
  let y = 0;
  for (const track of tracks) {
    trackYs.push(y);
    y += getEffectiveTrackHeight(track, baseTrackHeight);
  }
  return { trackYs, totalHeight: y };
}

export function getTrackAtY(
  y: number,
  tracks: Track[],
  trackYs: number[],
  baseTrackHeight: number,
): { trackIndex: number; isInClipArea: boolean; laneIndex: number } | null {
  // Binary search for the track containing y
  let lo = 0;
  let hi = tracks.length - 1;
  let trackIndex = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (trackYs[mid] <= y) {
      trackIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (trackIndex < 0 || trackIndex >= tracks.length) return null;

  const localY = y - trackYs[trackIndex];
  if (localY < baseTrackHeight) {
    return { trackIndex, isInClipArea: true, laneIndex: -1 };
  }
  // In automation lane area
  const laneY = localY - baseTrackHeight;
  const visibleLanes = tracks[trackIndex].automationLanes.filter((l) => l.visible);
  const laneIndex = Math.min(
    Math.floor(laneY / AUTOMATION_LANE_HEIGHT),
    visibleLanes.length - 1,
  );
  return { trackIndex, isInClipArea: false, laneIndex };
}

export interface AudioClip {
  id: string;
  filePath: string;
  name: string;
  startTime: number; // Position on timeline in seconds
  duration: number; // Duration in seconds
  offset: number; // Start offset within source file
  color: string;
  volumeDB: number; // Per-clip gain (-60 to +12 dB)
  fadeIn: number; // Fade in length (seconds)
  fadeOut: number; // Fade out length (seconds)
  sampleRate?: number; // Source file sample rate (for waveform display)
  muted?: boolean; // Per-clip mute (skipped during playback)
  groupId?: string; // Clip group ID for grouped editing
  locked?: boolean; // Prevent moving/resizing/deleting
  reversed?: boolean; // True if audio has been reversed (Phase 9A)
  fadeInShape?: number; // 0=linear, 1=equal_power, 2=s_curve, 3=log, 4=exp
  fadeOutShape?: number;
  playbackRate?: number; // Time stretch factor (1.0 = normal)
  pitchSemitones?: number; // Pitch shift in semitones
  originalFilePath?: string; // Original file before time stretch/pitch shift (for undo)
  freeY?: number; // Free positioning Y offset in pixels
  takes?: AudioClip[]; // Alternative takes for comping
  activeTakeIndex?: number; // Which take is active (undefined = main clip)
  sourceLength?: number; // Full duration of source audio file (for resize clamping after split)
  gainEnvelope?: Array<{ time: number; gain: number }>; // Per-clip gain envelope (time relative to clip start, gain 0.0-2.0)
}

export interface TempoMarker {
  id: string;
  time: number; // Position in seconds
  tempo: number; // BPM at this point
}

export interface Marker {
  id: string;
  time: number;
  name: string;
  color: string;
}

export interface Region {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  color: string;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  type: TrackType; // 'audio', 'midi', or 'instrument'
  inputType: InputType; // 'mono', 'stereo', or 'midi'

  // Audio Controls
  volume: number; // 0.0 to 1.0 (linear)
  volumeDB: number; // -60 to +12 dB
  pan: number; // -1.0 (L) to 1.0 (R)

  // States
  muted: boolean;
  soloed: boolean;
  armed: boolean;
  monitorEnabled: boolean;
  recordSafe: boolean; // Phase 3.3 — prevents arming

  // Metering
  meterLevel: number;
  peakLevel: number;
  clipping: boolean;

  // Input Configuration (Audio tracks)
  inputChannel: string | null;
  inputStartChannel: number;
  inputChannelCount: number;

  // MIDI Configuration (MIDI/Instrument tracks)
  midiInputDevice?: string;
  midiChannel?: number; // 0 = all, 1-16 = specific channel
  instrumentPlugin?: string;

  // FX counts (for visual indicators)
  inputFxCount: number;
  trackFxCount: number;
  fxBypassed: boolean; // All FX bypassed (on/off toggle)

  // Automation
  automationLanes: AutomationLane[];
  showAutomation: boolean;

  // Freeze
  frozen: boolean;
  freezeFilePath?: string;
  frozenOriginalClips?: AudioClip[]; // Saved clips before freeze (for unfreeze restore)

  // Comping / Takes
  takes: AudioClip[][]; // Array of take lanes (each lane is an array of clips)
  activeTakeIndex: number; // Which take lane is active (0 = main clips)

  // Sends (Phase 11)
  sends: Array<{
    destTrackId: string;
    level: number;
    pan: number;
    enabled: boolean;
    preFader: boolean;
    phaseInvert: boolean;
  }>;

  // Routing (Track IO)
  phaseInverted: boolean;
  stereoWidth: number;           // 0-200%, 100% = normal
  masterSendEnabled: boolean;
  outputStartChannel: number;
  outputChannelCount: number;
  playbackOffsetMs: number;
  trackChannelCount: number;     // 1-8
  midiOutputDevice: string;

  // Visual
  icon?: string; // Track icon ID (microphone, guitar, drums, keys, bus, master, midi, folder, piano)
  notes?: string; // Free-form track notes/comments
  waveformZoom?: number; // Waveform vertical zoom factor (0.1 to 5.0, default 1.0)
  spectralView?: boolean; // Show spectrogram instead of waveform

  // Folder tracks
  isFolder?: boolean; // True if this track is a folder track
  parentFolderId?: string; // ID of parent folder track (for nesting)
  folderCollapsed?: boolean; // Whether folder children are hidden

  // VCA fader
  vcaGroupId?: string; // VCA group this track belongs to (leader track acts as VCA fader)
  isVCALeader?: boolean; // True if this track is the VCA fader controlling the group

  // Clips
  clips: AudioClip[];
  midiClips: MIDIClip[];
}

export interface TransportState {
  isPlaying: boolean;
  isRecording: boolean; // True when transport is playing AND tracks are armed
  isPaused: boolean;
  currentTime: number; // Playhead position in seconds
  tempo: number; // BPM
  loopEnabled: boolean;
  loopStart: number; // seconds
  loopEnd: number; // seconds
  punchEnabled: boolean; // Phase 3.1 — punch in/out
  punchStart: number; // seconds
  punchEnd: number; // seconds
}

// Recording clip info for live visualization
export interface RecordingClip {
  trackId: string;
  startTime: number;
}

// Audio Device Setup (for dynamic input channel list)
export interface AudioDeviceSetup {
  deviceType: string;
  inputDevice: string;
  outputDevice: string;
  sampleRate: number;
  bufferSize: number;
  numInputChannels: number;
  numOutputChannels: number;
  inputChannelNames?: string[];
  outputChannelNames?: string[];
}

// Render Queue Job
export interface RenderJob {
  id: string;
  options: {
    source: string;
    bounds: string;
    startTime: number;
    endTime: number;
    tailLength: number;
    addTail: boolean;
    directory: string;
    fileName: string;
    format: string;
    sampleRate: number;
    bitDepth: number;
    channels: string;
    normalize: boolean;
    dither: boolean;
    mp3Bitrate: number;
    oggQuality: number;
  };
  status: "pending" | "rendering" | "done" | "error";
  error?: string;
}

// ============================================
// Mixer Snapshot
// ============================================

export interface MixerSnapshot {
  name: string;
  timestamp: number;
  tracks: Array<{ id: string; volume: number; pan: number; mute: boolean; solo: boolean }>;
}

// ============================================
// Project Template
// ============================================

export interface ProjectTemplate {
  name: string;
  tracks: Track[];
  masterVolume: number;
  masterPan: number;
  tempo: number;
  timeSignature: { numerator: number; denominator: number };
}

// ============================================
// Store State Interface
// ============================================

interface DAWState {
  // Tracks
  tracks: Track[];
  selectedTrackId: string | null; // Legacy single selection
  selectedTrackIds: string[]; // Multi-selection support
  lastSelectedTrackId: string | null; // For shift-click range selection

  // Transport
  transport: TransportState;
  recordingClips: RecordingClip[]; // Tracks currently being recorded (for live visualization)
  playStartPosition: number; // Position where play/record was started (for stop behavior)
  timeSelection: { start: number; end: number } | null; // Time selection for rendering/looping

  // Metronome
  metronomeEnabled: boolean;
  metronomeVolume: number; // 0.0 to 1.0 (linear volume for metronome click)
  metronomeAccentBeats: boolean[]; // Which beats in the bar should be accented (index 0 = beat 1, etc.)
  metronomeTrackId: string | null; // Track ID for the rendered metronome track
  timeSignature: { numerator: number; denominator: number };
  tapTimestamps: number[]; // For tap tempo feature (stores last 8 taps)

  // Project Range
  projectRange: { start: number; end: number }; // Project bounds in seconds

  // Clip Editing
  selectedClipId: string | null; // Last selected (for single-target actions)
  selectedClipIds: string[];     // All selected clips (multi-select)
  clipboard: {
    clip: AudioClip | null;
    clips: Array<{ clip: AudioClip; trackId: string }>; // Multi-clip with track info
    isCut: boolean;
  };

  // Markers and Regions
  markers: Marker[];
  regions: Region[];
  tempoMarkers: TempoMarker[];

  // Master
  masterVolume: number;
  masterPan: number;
  masterLevel: number;
  masterFxCount: number;
  isMasterMuted: boolean;
  masterMono: boolean;
  masterAutomationLanes: AutomationLane[];
  showMasterAutomation: boolean;

  // Meter state — stored separately from `tracks` so that 10Hz meter updates
  // never give tracks a new array reference.  Only ChannelStrip / TrackHeader
  // subscribe to these; Timeline and App are completely unaffected.
  meterLevels: Record<string, number>;
  peakLevels: Record<string, number>;
  // Automation-interpolated display values — trackId → paramId → display-unit value
  // Updated at ~30fps during playback. Separate from tracks[] to avoid mass re-renders.
  automatedParamValues: Record<string, Record<string, number>>;

  // Record & Edit Modes
  recordMode: "normal" | "overdub" | "replace";
  rippleMode: "off" | "per_track" | "all_tracks";
  playheadStopBehavior: "return-to-start" | "stop-in-place";

  // Auto-Crossfade
  autoCrossfade: boolean;
  defaultCrossfadeLength: number; // seconds

  // Razor Edits (per-track time selections)
  razorEdits: Array<{ trackId: string; start: number; end: number }>;

  // Timeline View
  pixelsPerSecond: number;
  scrollX: number;
  scrollY: number;
  trackHeight: number; // For Vertical Zoom
  tcpWidth: number; // Track Control Panel width (draggable)
  snapEnabled: boolean;
  gridSize: GridSize;
  toolMode: "select" | "split" | "mute" | "smart";

  // UI State
  showMixer: boolean;
  showMasterTrackInTCP: boolean;
  showSettings: boolean;
  showRenderModal: boolean;
  showPluginBrowser: boolean;
  pluginBrowserTrackId: string | null;
  showEnvelopeManager: boolean;
  envelopeManagerTrackId: string | null;
  showChannelStripEQ: boolean;
  channelStripEQTrackId: string | null;
  showTrackRouting: boolean;
  trackRoutingTrackId: string | null;
  showVirtualKeyboard: boolean;
  showUndoHistory: boolean;
  showCommandPalette: boolean;
  showRegionMarkerManager: boolean;
  showClipProperties: boolean;
  showBigClock: boolean;
  bigClockFormat: "time" | "beats";
  showKeyboardShortcuts: boolean;
  showContextualHelp: boolean;
  showGettingStarted: boolean;
  showPreferences: boolean;
  timecodeMode: "time" | "beats" | "smpte";
  smpteFrameRate: 24 | 25 | 29.97 | 30;

  // Accessibility: UI font scaling (0.75 - 1.5, default 1.0)
  uiFontScale: number;

  // Stem Separation Modal
  showStemSeparation: boolean;
  stemSepTrackId: string | null;
  stemSepClipId: string | null;
  stemSepClipName: string;
  stemSepClipDuration: number;

  // Script Console
  showScriptConsole: boolean;

  // Piano Roll
  showPianoRoll: boolean;
  pianoRollTrackId: string | null;
  pianoRollClipId: string | null;
  selectedNoteIds: string[];
  pianoRollScaleRoot: number; // 0=C, 1=C#, ..., 11=B
  pianoRollScaleType: string; // 'chromatic', 'major', 'minor', 'dorian', 'mixolydian', 'pentatonic_major', 'pentatonic_minor', 'blues'

  // Step Input Mode (Piano Roll)
  stepInputEnabled: boolean;
  stepInputSize: number;     // Duration in beats (0.125=1/32, 0.25=1/16, 0.5=1/8, 1=1/4)
  stepInputPosition: number; // Current step cursor time in seconds (relative to clip start)

  // Audio Device
  audioDeviceSetup: AudioDeviceSetup | null;

  // Undo/Redo System
  canUndo: boolean;
  canRedo: boolean;

  // Project State (F2)
  projectPath: string | null;
  isModified: boolean;
  recentProjects: string[];

  // Project Settings/Metadata
  showProjectSettings: boolean;
  projectName: string;
  projectNotes: string;
  projectSampleRate: 44100 | 48000 | 88200 | 96000 | 192000;
  projectBitDepth: 16 | 24 | 32;

  // Auto-Backup / Auto-Save
  autoBackupEnabled: boolean;
  autoBackupInterval: number; // milliseconds
  autoSaveEnabled: boolean;
  autoSaveIntervalMinutes: number; // minutes (default 5)
  autoSaveMaxVersions: number; // max rotating backup versions (default 3)

  // Custom Keyboard Shortcuts (actionId -> shortcut string)
  customShortcuts: Record<string, string>;

  // Track Templates
  trackTemplates: Array<{ id: string; name: string; trackConfig: Partial<Track> }>;

  // Project Loading
  isProjectLoading: boolean;
  projectLoadingMessage: string;

  // Toast notifications
  toastMessage: string;
  toastType: "success" | "error" | "info";
  toastVisible: boolean;

  // Lock Settings (granular)
  lockSettings: {
    items: boolean;
    envelopes: boolean;
    timeSelection: boolean;
    markers: boolean;
  };
  globalLocked: boolean;

  // Track Spacers
  spacers: Array<{ id: string; afterTrackId: string; height: number }>;

  // Recent Actions (for Command Palette)
  recentActions: string[];

  // Screensets / Layouts
  screensets: Array<{
    id: string;
    name: string;
    layout: {
      showMixer: boolean;
      showPianoRoll: boolean;
      showBigClock: boolean;
      showClipProperties: boolean;
      showUndoHistory: boolean;
      showRegionMarkerManager: boolean;
      pixelsPerSecond: number;
      trackHeight: number;
      tcpWidth?: number;
    };
  }>;

  // Custom Actions (Macros)
  customActions: Array<{
    id: string;
    name: string;
    steps: string[];
    shortcut?: string;
  }>;

  // Render Queue
  renderQueue: RenderJob[];
  showRenderQueue: boolean;

  // Phase 9: Audio Engine Enhancements
  showDynamicSplit: boolean;
  dynamicSplitClipId: string | null;
  metronomeClickPath: string; // Custom click sound path (empty = default)
  metronomeAccentPath: string; // Custom accent sound path (empty = default)
  ditherType: "none" | "tpdf" | "shaped"; // Render dither setting
  resampleQuality: "fast" | "good" | "best"; // Render resample quality

  // Phase 10: Render Pipeline Expansion
  selectedRegionIds: string[]; // For region-based rendering
  renderMetadata: {
    title: string;
    artist: string;
    album: string;
    genre: string;
    year: string;
    description: string;
    isrc: string;
  };
  secondaryOutputEnabled: boolean;
  secondaryOutputFormat: string;
  secondaryOutputBitDepth: number;
  onlineRender: boolean; // 1x speed render for live monitoring
  addToProjectAfterRender: boolean;
  showRegionRenderMatrix: boolean;

  // Phase 11C: Track Groups (VCA)
  trackGroups: Array<{ id: string; name: string; leadTrackId: string; memberTrackIds: string[]; linkedParams: string[] }>;
  showRoutingMatrix: boolean;

  // Phase 12: Media & File Management
  showMediaExplorer: boolean;
  mediaExplorerPath: string;
  mediaExplorerRecentPaths: string[];
  showCleanProject: boolean;
  showBatchConverter: boolean;

  // Phase 13: Advanced Editing
  showCrossfadeEditor: boolean;
  crossfadeEditorClipIds: [string, string] | null; // Two overlapping clip IDs
  freePositioning: boolean;

  // Phase 14: Theming & Customization
  theme: string; // Active theme preset name
  customThemeOverrides: Record<string, string>; // User overrides for CSS variables
  showThemeEditor: boolean;
  mouseModifiers: Record<string, Record<string, string>>; // context -> modifiers -> action
  panelPositions: Record<string, { dock: "floating" | "left" | "right" | "bottom" | "tab"; x: number; y: number; width: number; height: number; visible: boolean; tabGroup?: string }>;

  // Phase 15: Platform & Extensibility
  showVideoWindow: boolean;
  videoFilePath: string;
  videoInfo: { width: number; height: number; duration: number; fps: number } | null;
  showScriptEditor: boolean;
  showPitchEditor: boolean;
  pitchEditorTrackId: string | null;
  pitchEditorClipId: string | null;
  pitchEditorFxIndex: number;
  lowerZoneHeight: number; // pitch editor lower zone height in px
  scriptConsoleOutput: string[];
  userScripts: Array<{ id: string; name: string; code: string; filePath?: string }>;
  projectTabs: Array<{ id: string; name: string; isActive: boolean }>;
  activeTabId: string;
  customToolbars: Array<{ id: string; name: string; visible: boolean; buttons: Array<{ actionId: string; icon: string; label: string }> }>;
  showToolbarEditor: boolean;
  ltcEnabled: boolean;
  ltcOutputChannel: number;
  ltcFrameRate: 24 | 25 | 29.97 | 30;

  // Phase 16: Pro Audio & Compatibility
  trackChannelFormats: Record<string, "mono" | "stereo" | "5.1" | "7.1">; // per-track channel format
  masterChannelFormat: "mono" | "stereo" | "5.1" | "7.1";
  pluginBridgeEnabled: boolean;
  pluginBridge32Paths: string[]; // 32-bit plugin paths detected during scan
  liveCaptureEnabled: boolean;
  liveCaptureFilePath: string;
  liveCaptureDuration: number;
  showDDPExport: boolean;

  // Phase 4.2: Step Sequencer
  stepSequencer: {
    steps: boolean[][];       // [row/pitch][column/step]
    velocities: number[][];   // velocity per step (0-127)
    stepCount: number;
    stepSize: string;         // '1/16', '1/8', '1/4'
    selectedPitch: number;
    pitchCount: number;
  };
  showStepSequencer: boolean;

  // Phase 4.1: Clip Launcher
  clipLauncher: {
    slots: Array<Array<{
      filePath?: string;
      name?: string;
      duration?: number;
      isPlaying?: boolean;
      isQueued?: boolean;
      color?: string;
    }>>;
    numTracks: number;
    numSlots: number;
    quantize: string;         // 'none', '1/4', '1/2', '1bar', '2bar', '4bar'
  };
  showClipLauncher: boolean;

  // Missing Media Resolver
  showMissingMedia: boolean;
  missingMediaFiles: Array<{ path: string; clipIds: string[] }>;

  // Sprint 17: Visual Improvements
  recentColors: string[];

  // Sprint 18: Interaction/Workflow
  autoScrollDuringPlayback: boolean;
  showQuantizeDialog: boolean;
  showDrumEditor: boolean;

  // Sprint 19: Plugin + Mixing
  showMediaPool: boolean;

  // Plugin A/B Comparison — per-plugin state slots keyed by "trackId-fxIndex"
  pluginABStates: Record<string, { a?: string; b?: string; active: "a" | "b" }>;

  // FX Chain Presets — save/load entire FX chains
  fxChainPresets: Array<{ name: string; plugins: Array<{ pluginId: string; state?: string }> }>;

  // Sprint 20: Metering + Analysis
  showLoudnessMeter: boolean;
  showSpectrumAnalyzer: boolean;
  showPhaseCorrelation: boolean;
  showProjectTemplates: boolean;

  // Sprint 21: Timeline Interaction
  showCrosshair: boolean;

  // Mixer Snapshots
  mixerSnapshots: MixerSnapshot[];

  // Project Templates
  projectTemplates: ProjectTemplate[];

  // Project Compare
  showProjectCompare: boolean;
  projectCompareData: {
    tracksDiff: Array<{ type: "added" | "removed" | "modified"; id: string; name: string; details?: string }>;
    clipsDiff: Array<{ type: "added" | "removed" | "modified"; id: string; name: string; trackName: string; details?: string }>;
    settingsDiff: Array<{ field: string; oldValue: string; newValue: string }>;
  } | null;

  // Collaborative Metadata
  projectAuthor: string;
  projectRevisionNotes: Array<{ timestamp: number; author: string; note: string }>;

  // Timecode Sync Settings
  showTimecodeSettings: boolean;

  // Detachable Panels (multi-monitor support)
  detachedPanels: string[];
}

// ============================================
// Store Actions Interface
// ============================================

interface DAWActions {
  // Toast
  showToast: (message: string, type?: "success" | "error" | "info") => void;

  // Project Management (F2)
  newProject: () => Promise<void>;
  saveProject: (saveAs?: boolean) => Promise<boolean>;
  saveNewVersion: () => Promise<boolean>;
  loadProject: (path?: string, options?: { bypassFX?: boolean }) => Promise<boolean>;
  setModified: (modified: boolean) => void;
  clearRecentProjects: () => void;

  // Auto-Backup
  setAutoBackupEnabled: (enabled: boolean) => void;
  setAutoBackupInterval: (ms: number) => void;

  // Auto-Save
  toggleAutoSave: () => void;
  setAutoSaveInterval: (minutes: number) => void;
  setAutoSaveMaxVersions: (max: number) => void;

  // Custom Keyboard Shortcuts
  setCustomShortcut: (actionId: string, shortcut: string) => void;
  resetCustomShortcuts: () => void;

  // Track Templates
  saveTrackTemplate: (trackId: string, name: string) => void;
  loadTrackTemplate: (templateId: string) => void;
  deleteTrackTemplate: (templateId: string) => void;

  // Track Folder Management
  createFolderTrack: (name: string) => void;
  moveTracksToFolder: (trackIds: string[], folderId: string) => void;
  toggleFolderCollapsed: (folderId: string) => void;
  removeTrackFromFolder: (trackId: string) => void;
  getVisibleTracks: () => Track[];

  // VCA Faders
  createVCAFader: (name: string, memberTrackIds: string[]) => void;
  removeVCAGroup: (vcaGroupId: string) => void;

  // Track Management
  addTrack: (track: Partial<Track> & { id: string; name: string }) => void;
  removeTrack: (id: string) => Promise<void>;
  updateTrack: (id: string, updates: Partial<Track>) => void;
  reorderTrack: (activeId: string, overId: string) => void;
  reorderMultipleTracks: (trackIds: string[], overId: string) => void;
  selectTrack: (
    id: string | null,
    modifiers?: { shift?: boolean; ctrl?: boolean },
  ) => void;
  selectAllTracks: () => void;
  deselectAllTracks: () => void;
  deleteSelectedTracks: () => Promise<void>;

  // Track Notes
  setTrackNotes: (trackId: string, notes: string) => void;

  // Track Audio Controls
  setTrackVolume: (id: string, volumeDB: number) => Promise<void>;
  setTrackPan: (id: string, pan: number) => Promise<void>;
  toggleTrackMute: (id: string) => Promise<void>;
  toggleTrackSolo: (id: string) => Promise<void>;
  toggleTrackArmed: (id: string) => Promise<void>;
  toggleTrackFXBypass: (id: string) => Promise<void>;
  toggleTrackMonitor: (id: string) => Promise<void>;
  setTrackInput: (
    id: string,
    startChannel: number,
    channelCount: number,
  ) => Promise<void>;

  // Continuous edit begin/commit (for undo/redo of fader drags)
  beginTrackVolumeEdit: (id: string) => void;
  commitTrackVolumeEdit: (id: string) => void;
  beginTrackPanEdit: (id: string) => void;
  commitTrackPanEdit: (id: string) => void;
  beginClipVolumeEdit: (clipId: string) => void;
  commitClipVolumeEdit: (clipId: string) => void;

  // FX undo/redo actions
  addTrackFXWithUndo: (trackId: string, pluginPath: string, chainType: "input" | "track") => Promise<boolean>;
  removeTrackFXWithUndo: (trackId: string, fxIndex: number, chainType: "input" | "track") => Promise<boolean>;

  // Record & Edit Modes
  setRecordMode: (mode: "normal" | "overdub" | "replace") => void;
  setRippleMode: (mode: "off" | "per_track" | "all_tracks") => void;
  setPlayheadStopBehavior: (mode: "return-to-start" | "stop-in-place") => void;

  // Auto-Crossfade
  toggleAutoCrossfade: () => void;
  applyAutoCrossfades: (trackId: string) => void;

  // Clip Lock & Color
  toggleClipLock: (clipId: string) => void;
  setClipColor: (clipId: string, color: string) => void;

  // Transport Controls
  play: () => Promise<void>;
  record: () => Promise<void>;
  pause: () => void;
  stop: () => Promise<void>;
  togglePlayPause: () => Promise<void>;
  setCurrentTime: (time: number) => void;
  seekTo: (time: number) => Promise<void>;
  setTempo: (tempo: number) => Promise<void>;
  toggleLoop: () => void;
  setLoopRegion: (start: number, end: number) => void;
  togglePunch: () => void;
  setPunchRange: (start: number, end: number) => void;
  setTrackRecordSafe: (trackId: string, safe: boolean) => void;
  setTimeSelection: (start: number, end: number) => void;
  clearTimeSelection: () => void;
  setLoopToSelection: () => void;
  toggleMetronome: () => void;
  setMetronomeVolume: (volume: number) => Promise<void>;
  setMetronomeAccentBeats: (accentBeats: boolean[]) => void;
  setTimeSignature: (numerator: number, denominator: number) => void;
  tapTempo: () => void;
  generateMetronomeTrack: () => Promise<void>;
  removeMetronomeTrack: () => Promise<void>;
  setProjectRange: (start: number, end: number) => void;

  // Master Controls
  setMasterVolume: (volume: number) => Promise<void>;
  setMasterPan: (pan: number) => Promise<void>;
  toggleMasterMute: () => void;
  toggleMasterMono: () => void;
  toggleMasterAutomation: () => void;
  addMasterAutomationLane: (param: string) => string | null;
  toggleMasterAutomationLaneVisibility: (laneId: string) => void;
  setMasterAutomationLaneMode: (laneId: string, mode: AutomationModeType) => void;
  armMasterAutomationLane: (laneId: string, armed: boolean) => void;
  setMasterTrackAutomationMode: (mode: AutomationModeType) => void;
  showAllActiveMasterEnvelopes: () => void;
  hideAllMasterEnvelopes: () => void;
  armAllVisibleMasterAutomationLanes: () => void;
  disarmAllMasterAutomationLanes: () => void;
  addMasterAutomationPoint: (laneId: string, time: number, value: number) => void;
  removeMasterAutomationPoint: (laneId: string, pointIndex: number) => void;
  moveMasterAutomationPoint: (laneId: string, pointIndex: number, time: number, value: number) => void;

  // Metering
  setTrackMeterLevel: (trackId: string, level: number) => void;
  batchUpdateMeterLevels: (levels: Record<string, number>, masterLevel: number) => void;
  setMasterLevel: (level: number) => void;
  updateAutomatedValues: () => void;

  // Timeline View
  setZoom: (pixelsPerSecond: number) => void;
  setScroll: (x: number, y: number) => void;
  setTrackHeight: (height: number) => void;
  setTcpWidth: (width: number) => void;
  toggleSnap: () => void;
  setGridSize: (size: GridSize) => void;

  // Clips
  addClip: (trackId: string, clip: AudioClip) => void;
  removeClip: (trackId: string, clipId: string) => void;
  syncClipsWithBackend: () => Promise<void>;
  importMedia: (
    filePath: string,
    trackId: string,
    startTime: number,
  ) => Promise<void>;

  // Tool Mode
  setToolMode: (mode: "select" | "split" | "mute" | "smart") => void;
  toggleSplitTool: () => void;
  toggleMuteTool: () => void;

  // Clip Editing
  splitClipAtPlayhead: () => void;
  splitClipAtPosition: (clipId: string, splitTime: number) => void;
  splitMIDIClipAtPosition: (clipId: string, splitTime: number) => void;
  selectClip: (clipId: string | null, modifiers?: { ctrl?: boolean }) => void;
  moveClipToTrack: (
    clipId: string,
    newTrackId: string,
    newStartTime: number,
  ) => Promise<void>;
  resizeClip: (
    clipId: string,
    newStartTime: number,
    newDuration: number,
    newOffset: number,
  ) => void;
  toggleClipMute: (clipId: string) => void;
  setClipVolume: (clipId: string, volumeDB: number) => void;
  setClipFades: (clipId: string, fadeIn: number, fadeOut: number) => void;
  selectAllClips: () => void;
  setSelectedClipIds: (clipIds: string[]) => void;
  copyClip: (clipId: string) => void;
  cutClip: (clipId: string) => void;
  copySelectedClips: () => void;
  cutSelectedClips: () => void;
  pasteClip: (targetTrackId: string, targetTime: number) => void;
  pasteClips: () => void; // Smart paste: selected track or new tracks, at playhead
  nudgeClips: (direction: "left" | "right", fine?: boolean) => void;
  deleteClip: (clipId: string) => void;
  duplicateClip: (clipId: string) => void;

  // Clip Gain Envelope
  addClipGainPoint: (clipId: string, time: number, gain: number) => void;
  removeClipGainPoint: (clipId: string, pointIndex: number) => void;
  moveClipGainPoint: (clipId: string, pointIndex: number, time: number, gain: number) => void;

  // Advanced Clip Editing (Phase 4)
  splitAtTimeSelection: () => void;
  groupSelectedClips: () => void;
  ungroupSelectedClips: () => void;
  normalizeSelectedClips: () => void;

  // Razor Edits
  addRazorEdit: (trackId: string, start: number, end: number) => void;
  clearRazorEdits: () => void;
  deleteRazorEditContent: () => void;

  // Track Automation (Phase 5)
  toggleTrackAutomation: (trackId: string) => void;
  addAutomationLane: (trackId: string, param: AutomationParam, label?: string) => string | null;
  addAutomationPoint: (trackId: string, laneId: string, time: number, value: number) => void;
  removeAutomationPoint: (trackId: string, laneId: string, pointIndex: number) => void;
  moveAutomationPoint: (trackId: string, laneId: string, pointIndex: number, time: number, value: number) => void;
  toggleAutomationLaneVisibility: (trackId: string, laneId: string) => void;
  clearAutomationLane: (trackId: string, laneId: string) => void;
  setAutomationLaneMode: (trackId: string, laneId: string, mode: AutomationModeType) => void;
  setTrackAutomationMode: (trackId: string, mode: AutomationModeType) => void;
  armAutomationLane: (trackId: string, laneId: string, armed: boolean) => void;
  armAllVisibleAutomationLanes: (trackId: string) => void;
  disarmAllAutomationLanes: (trackId: string) => void;
  showAllActiveEnvelopes: (trackId: string) => void;
  hideAllEnvelopes: (trackId: string) => void;

  // Strip Silence (Phase 3.12)
  stripSilence: (clipId: string, thresholdDb: number, minSilenceMs: number,
                 minSoundMs: number, preAttackMs: number, postReleaseMs: number) => void;

  // Track Freeze (Phase 3.13)
  freezeTrack: (trackId: string) => void;
  unfreezeTrack: (trackId: string) => void;

  // Comping / Takes (Phase 6)
  promoteClipsToTake: (trackId: string) => void; // Move current clips to a new take lane
  setActiveTake: (trackId: string, takeIndex: number) => void;
  deleteTake: (trackId: string, takeIndex: number) => void;

  // Markers and Regions
  addMarker: (time: number, name?: string) => void;
  removeMarker: (id: string) => void;
  updateMarker: (id: string, updates: Partial<Marker>) => void;
  addRegion: (start: number, end: number, name?: string) => void;
  removeRegion: (id: string) => void;
  updateRegion: (id: string, updates: Partial<Region>) => void;

  // Tempo Map
  addTempoMarker: (time: number, tempo: number) => void;
  removeTempoMarker: (id: string) => void;
  updateTempoMarker: (id: string, updates: Partial<TempoMarker>) => void;
  getTempoAtTime: (time: number) => number;

  // UI State
  toggleMixer: () => void;
  toggleMasterTrackInTCP: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openProjectSettings: () => void;
  closeProjectSettings: () => void;
  openRenderModal: () => void;
  closeRenderModal: () => void;
  openPluginBrowser: (trackId: string) => void;
  closePluginBrowser: () => void;
  openEnvelopeManager: (trackId: string) => void;
  closeEnvelopeManager: () => void;
  openChannelStripEQ: (trackId: string) => void;
  closeChannelStripEQ: () => void;
  openTrackRouting: (trackId: string) => void;
  closeTrackRouting: () => void;
  toggleVirtualKeyboard: () => void;
  toggleUndoHistory: () => void;
  toggleCommandPalette: () => void;
  toggleRegionMarkerManager: () => void;
  toggleClipProperties: () => void;
  toggleBigClock: () => void;
  toggleBigClockFormat: () => void;
  toggleKeyboardShortcuts: () => void;
  toggleContextualHelp: () => void;
  toggleGettingStarted: () => void;
  togglePreferences: () => void;
  toggleScriptConsole: () => void;
  openStemSeparation: (trackId: string, clipId: string, name: string, duration: number) => void;
  closeStemSeparation: () => void;
  completeStemSeparation: (sourceTrackId: string, sourceClipId: string, clipName: string,
    stemFiles: Array<{ name: string; filePath: string; duration?: number; sampleRate?: number }>,
    sourceClipStartTime: number) => void;
  setTimecodeMode: (mode: "time" | "beats" | "smpte") => void;
  setSmpteFrameRate: (rate: 24 | 25 | 29.97 | 30) => void;
  setUIFontScale: (scale: number) => void;

  // Detachable Panels
  detachPanel: (panelId: string) => void;
  attachPanel: (panelId: string) => void;

  // Cut/Copy/Delete within Time Selection
  cutWithinTimeSelection: () => void;
  copyWithinTimeSelection: () => void;
  deleteWithinTimeSelection: () => void;
  insertSilenceAtTimeSelection: () => void;

  // Piano Roll
  openPianoRoll: (trackId: string, clipId: string) => void;
  closePianoRoll: () => void;
  addMIDIClip: (trackId: string, startTime: number, duration?: number) => string;

  // Project Settings Actions
  setProjectName: (name: string) => void;
  setProjectNotes: (notes: string) => void;
  setProjectSampleRate: (sampleRate: 44100 | 48000 | 88200 | 96000 | 192000) => void;
  setProjectBitDepth: (bitDepth: 16 | 24 | 32) => void;

  // Audio Device
  setAudioDeviceSetup: (setup: AudioDeviceSetup) => void;
  refreshAudioDeviceSetup: () => Promise<void>;

  // Undo/Redo
  undo: () => void;
  redo: () => void;
  executeCommand: (command: Command) => void;

  // Empty Item (silent clip)
  addEmptyClip: (trackId: string, startTime: number, duration: number) => void;

  // Lock Settings (granular)
  toggleGlobalLock: () => void;
  setLockSetting: (key: keyof DAWState["lockSettings"], value: boolean) => void;

  // Track Spacers
  addSpacer: (afterTrackId: string) => void;
  removeSpacer: (spacerId: string) => void;
  setSpacerHeight: (spacerId: string, height: number) => void;

  // Recent Actions
  trackRecentAction: (actionId: string) => void;

  // Quantize Clips to Grid
  quantizeSelectedClips: () => void;

  // Move Envelope Points with Items
  moveEnvelopesWithItems: boolean;
  toggleMoveEnvelopesWithItems: () => void;

  // Screensets / Layouts
  saveScreenset: (slotIndex: number, name?: string) => void;
  loadScreenset: (slotIndex: number) => void;
  deleteScreenset: (slotIndex: number) => void;

  // Custom Actions (Macros)
  addCustomAction: (name: string, steps: string[], shortcut?: string) => void;
  removeCustomAction: (actionId: string) => void;
  executeCustomAction: (actionId: string) => void;

  // Render Queue
  addToRenderQueue: (options: RenderJob["options"]) => void;
  removeFromRenderQueue: (jobId: string) => void;
  clearRenderQueue: () => void;
  executeRenderQueue: () => Promise<void>;
  toggleRenderQueue: () => void;

  // Phase 9: Audio Engine Enhancements
  reverseClip: (clipId: string) => Promise<void>;
  openDynamicSplit: (clipId?: string) => void;
  closeDynamicSplit: () => void;
  executeDynamicSplit: (clipId: string, transientTimes: number[]) => void;
  setMetronomeClickSound: (filePath: string) => Promise<boolean>;
  setMetronomeAccentSound: (filePath: string) => Promise<boolean>;
  resetMetronomeSounds: () => Promise<boolean>;
  setDitherType: (type: "none" | "tpdf" | "shaped") => void;
  setResampleQuality: (quality: "fast" | "good" | "best") => void;

  // Phase 11: Send/Bus Routing
  addTrackSend: (sourceTrackId: string, destTrackId: string) => Promise<void>;
  removeTrackSend: (sourceTrackId: string, sendIndex: number) => Promise<void>;
  setTrackSendLevel: (sourceTrackId: string, sendIndex: number, level: number) => Promise<void>;
  setTrackSendPan: (sourceTrackId: string, sendIndex: number, pan: number) => Promise<void>;
  setTrackSendEnabled: (sourceTrackId: string, sendIndex: number, enabled: boolean) => Promise<void>;
  setTrackSendPreFader: (sourceTrackId: string, sendIndex: number, preFader: boolean) => Promise<void>;
  setTrackSendPhaseInvert: (sourceTrackId: string, sendIndex: number, invert: boolean) => Promise<void>;
  setTrackPhaseInvert: (trackId: string, invert: boolean) => Promise<void>;
  setTrackStereoWidth: (trackId: string, widthPercent: number) => Promise<void>;
  setTrackMasterSendEnabled: (trackId: string, enabled: boolean) => Promise<void>;
  setTrackOutputChannels: (trackId: string, startChannel: number, numChannels: number) => Promise<void>;
  setTrackPlaybackOffset: (trackId: string, offsetMs: number) => Promise<void>;
  setTrackChannelCount: (trackId: string, numChannels: number) => Promise<void>;
  setTrackMIDIOutput: (trackId: string, deviceName: string) => Promise<void>;

  // Phase 11B: Routing Matrix
  toggleRoutingMatrix: () => void;

  // Phase 11C: Track Groups (VCA)
  addTrackGroup: (name: string, leadTrackId: string, memberTrackIds: string[], linkedParams: string[]) => void;
  removeTrackGroup: (groupId: string) => void;
  updateTrackGroup: (groupId: string, updates: Partial<{ name: string; leadTrackId: string; memberTrackIds: string[]; linkedParams: string[] }>) => void;

  // Phase 10: Render Pipeline Expansion
  selectRegion: (id: string, modifiers?: { ctrl?: boolean }) => void;
  deselectAllRegions: () => void;
  setRenderMetadata: (metadata: Partial<DAWState["renderMetadata"]>) => void;
  setSecondaryOutputEnabled: (enabled: boolean) => void;
  setSecondaryOutputFormat: (format: string) => void;
  setSecondaryOutputBitDepth: (bitDepth: number) => void;
  setOnlineRender: (enabled: boolean) => void;
  setAddToProjectAfterRender: (enabled: boolean) => void;
  toggleRegionRenderMatrix: () => void;

  // Phase 12: Media & File Management
  toggleMediaExplorer: () => void;
  setMediaExplorerPath: (path: string) => void;
  addMediaExplorerRecentPath: (path: string) => void;
  toggleCleanProject: () => void;
  toggleBatchConverter: () => void;
  exportProjectMIDI: () => Promise<boolean>;
  consolidateTrack: (trackId: string) => Promise<string | null>;
  renderClipInPlace: (clipId: string) => Promise<void>;
  renderTrackInPlace: (trackId: string) => Promise<void>;

  // Phase 13: Advanced Editing
  setClipFadeInShape: (clipId: string, shape: number) => void;
  setClipFadeOutShape: (clipId: string, shape: number) => void;
  openCrossfadeEditor: (clipId1: string, clipId2: string) => void;
  closeCrossfadeEditor: () => void;
  addClipTake: (clipId: string, take: AudioClip) => void;
  setActiveClipTake: (clipId: string, takeIndex: number) => void;
  explodeTakes: (clipId: string) => void;
  implodeTakes: (clipIds: string[]) => void;
  setClipPlaybackRate: (clipId: string, rate: number) => Promise<void>;
  setClipPitch: (clipId: string, semitones: number) => Promise<void>;
  toggleFreePositioning: () => void;
  setClipFreeY: (clipId: string, freeY: number) => void;

  // Phase 14: Theming & Customization
  setTheme: (themeName: string) => void;
  setCustomThemeOverride: (property: string, value: string) => void;
  clearCustomThemeOverrides: () => void;
  toggleThemeEditor: () => void;
  setMouseModifier: (context: string, modifiers: string, action: string) => void;
  resetMouseModifiers: () => void;
  setPanelPosition: (panelId: string, position: Partial<DAWState["panelPositions"][string]>) => void;
  togglePanelDock: (panelId: string, dock: "floating" | "left" | "right" | "bottom" | "tab") => void;

  // Phase 15: Platform & Extensibility
  toggleVideoWindow: () => void;
  openVideoFile: (filePath: string) => Promise<void>;
  closeVideoFile: () => void;
  toggleScriptEditor: () => void;
  openPitchEditor: (trackId: string, clipId: string, fxIndex: number) => void;
  closePitchEditor: () => void;
  setLowerZoneHeight: (h: number) => void;
  executeScript: (code: string) => Promise<void>;
  addUserScript: (name: string, code: string) => void;
  removeUserScript: (scriptId: string) => void;
  appendScriptConsole: (line: string) => void;
  clearScriptConsole: () => void;
  addProjectTab: (name?: string) => void;
  closeProjectTab: (tabId: string) => void;
  switchProjectTab: (tabId: string) => void;
  addCustomToolbar: (name: string) => void;
  removeCustomToolbar: (toolbarId: string) => void;
  addToolbarButton: (toolbarId: string, actionId: string, icon: string, label: string) => void;
  removeToolbarButton: (toolbarId: string, buttonIndex: number) => void;
  toggleToolbarVisibility: (toolbarId: string) => void;
  toggleToolbarEditor: () => void;
  setLTCEnabled: (enabled: boolean) => Promise<void>;
  setLTCOutputChannel: (channel: number) => void;
  setLTCFrameRate: (rate: 24 | 25 | 29.97 | 30) => void;

  // Phase 16: Pro Audio & Compatibility
  setTrackChannelFormat: (trackId: string, format: "mono" | "stereo" | "5.1" | "7.1") => void;
  setMasterChannelFormat: (format: "mono" | "stereo" | "5.1" | "7.1") => void;
  togglePluginBridge: () => void;
  startLiveCapture: () => Promise<void>;
  stopLiveCapture: () => Promise<void>;
  toggleDDPExport: () => void;
  exportDDP: (sourceWavPath: string, outputDir: string, catalogNumber?: string) => Promise<boolean>;

  // Phase 4.2: Step Sequencer
  toggleStep: (pitch: number, step: number) => void;
  setStepVelocity: (pitch: number, step: number, velocity: number) => void;
  setStepCount: (count: number) => void;
  setStepSize: (size: string) => void;
  clearStepSequencer: () => void;
  generateMIDIClipFromSteps: () => void;
  toggleStepSequencer: () => void;

  // Phase 4.1: Clip Launcher
  triggerSlot: (trackIndex: number, slotIndex: number) => void;
  stopSlot: (trackIndex: number, slotIndex: number) => void;
  triggerScene: (slotIndex: number) => void;
  stopAllSlots: () => void;
  setSlotClip: (trackIndex: number, slotIndex: number, filePath: string, name: string, duration: number) => void;
  clearSlot: (trackIndex: number, slotIndex: number) => void;
  setClipLauncherQuantize: (quantize: string) => void;
  toggleClipLauncher: () => void;

  // Timecode Sync Settings
  toggleTimecodeSettings: () => void;

  // Missing Media Resolver
  resolveMissingMedia: (originalPath: string, newPath: string) => void;
  closeMissingMedia: () => void;

  // Sprint 17: Visual Improvements
  addRecentColor: (color: string) => void;

  // Sprint 18: Interaction/Workflow
  toggleAutoScroll: () => void;
  zoomToSelection: () => void;
  toggleQuantizeDialog: () => void;
  toggleDrumEditor: () => void;
  selectAllMIDINotes: () => void;
  updateMIDINotes: (clipId: string, notes: any[]) => void;

  // Piano Roll: Velocity & CC editing
  updateMIDINoteVelocity: (trackId: string, clipId: string, noteTimestamp: number, noteNumber: number, velocity: number) => void;
  updateMIDICCEvents: (trackId: string, clipId: string, ccEvents: MIDICCEvent[]) => void;
  setPianoRollScaleRoot: (root: number) => void;
  setPianoRollScaleType: (scaleType: string) => void;

  // Step Input Mode (Piano Roll)
  toggleStepInput: () => void;
  setStepInputSize: (beats: number) => void;
  setStepInputPosition: (time: number) => void;
  advanceStepInput: () => void;

  // MIDI Transform
  transposeMIDINotes: (clipId: string, semitones: number) => void;
  scaleMIDINoteVelocity: (clipId: string, factor: number) => void;
  reverseMIDINotes: (clipId: string) => void;
  invertMIDINotes: (clipId: string) => void;

  // Note Expression / MPE
  setNoteExpression: (clipId: string, noteId: string, expr: { pitchBend?: number; pressure?: number; slide?: number }) => void;

  // Sprint 19: Plugin + Mixing
  toggleMediaPool: () => void;

  // Plugin A/B Comparison
  storePluginState: (trackId: string, fxIndex: number, slot: "a" | "b", isInputFX: boolean) => Promise<void>;
  recallPluginState: (trackId: string, fxIndex: number, slot: "a" | "b", isInputFX: boolean) => Promise<void>;
  togglePluginAB: (trackId: string, fxIndex: number, isInputFX: boolean) => Promise<void>;

  // FX Chain Presets
  saveFXChainPreset: (trackId: string, name: string, chainType: "input" | "track" | "master") => Promise<void>;
  loadFXChainPreset: (trackId: string, presetIndex: number, chainType: "input" | "track" | "master") => Promise<void>;
  deleteFXChainPreset: (index: number) => void;

  // Sprint 20: Metering + Analysis + Project
  toggleLoudnessMeter: () => void;
  toggleSpectrumAnalyzer: () => void;
  togglePhaseCorrelation: () => void;
  toggleProjectTemplates: () => void;
  archiveSession: () => Promise<void>;

  // Sprint 21: Timeline Interaction
  setTrackWaveformZoom: (trackId: string, zoom: number) => void;
  toggleSpectralView: (trackId: string) => void;
  toggleCrosshair: () => void;
  slipEditClip: (clipId: string, newOffset: number) => void;

  // Mixer Snapshots
  saveMixerSnapshot: (name: string) => void;
  recallMixerSnapshot: (index: number) => void;
  deleteMixerSnapshot: (index: number) => void;

  // Bus/Group Creation
  createBusFromSelectedTracks: () => void;

  // Project Templates
  saveAsTemplate: (name: string) => void;
  loadTemplate: (index: number) => void;
  deleteTemplate: (index: number) => void;

  // Project Compare
  toggleProjectCompare: () => void;
  compareWithSavedProject: () => Promise<void>;

  // Collaborative Metadata
  setProjectAuthor: (author: string) => void;
  addRevisionNote: (note: string) => void;
  deleteRevisionNote: (index: number) => void;
}

// ============================================
// Default Values
// ============================================

const DEFAULT_TRACK_COLORS = [
  "#4361ee",
  "#7209b7",
  "#f72585",
  "#4cc9f0",
  "#4895ef",
  "#560bad",
  "#3a0ca3",
  "#f77f00",
];

const getRandomTrackColor = (): string => {
  return DEFAULT_TRACK_COLORS[
    Math.floor(Math.random() * DEFAULT_TRACK_COLORS.length)
  ];
};

const createDefaultTrack = (
  id: string,
  name: string,
  color?: string,
): Track => ({
  id,
  name,
  color: color || getRandomTrackColor(),
  type: "audio",
  inputType: "stereo",
  volume: 0.8,
  volumeDB: 0,
  pan: 0,
  muted: false,
  soloed: false,
  armed: false,
  recordSafe: false,
  monitorEnabled: false,
  inputChannel: null,
  inputStartChannel: 0,
  inputChannelCount: 2,
  midiInputDevice: undefined,
  midiChannel: 0,
  instrumentPlugin: undefined,
  clips: [],
  midiClips: [],
  inputFxCount: 0,
  trackFxCount: 0,
  fxBypassed: false,
  meterLevel: 0,
  peakLevel: 0,
  clipping: false,
  automationLanes: [
    { id: "vol", param: "volume", points: [], visible: true, mode: "read", armed: false },
    { id: "pan", param: "pan", points: [], visible: false, mode: "read", armed: false },
  ],
  showAutomation: false,
  frozen: false,
  takes: [],
  activeTakeIndex: 0,
  sends: [],
  phaseInverted: false,
  stereoWidth: 100,
  masterSendEnabled: true,
  outputStartChannel: 0,
  outputChannelCount: 2,
  playbackOffsetMs: 0,
  trackChannelCount: 2,
  midiOutputDevice: "",
});

const initialTransport: TransportState = {
  isPlaying: false,
  isRecording: false,
  isPaused: false,
  currentTime: 0,
  tempo: 120,
  loopEnabled: false,
  loopStart: 0,
  loopEnd: 16,
  punchEnabled: false,
  punchStart: 0,
  punchEnd: 0,
};

// ============================================
// ============================================
// Helpers
// ============================================

/**
 * Compute the minimum track header height based on TCP width.
 *
 * The track header uses a single flex-wrap row. Items wrap into more rows as
 * the panel gets narrower. This estimates the number of rows and converts to
 * a minimum pixel height so content is never clipped by the fixed trackHeight.
 *
 * Row item approximate widths (including gaps):
 *   Record arm (30) + Name input (46+) + M/S/FX/bypass/A group (126) +
 *   Track type select (50) + stereo/mono select (50) + input select (50) +
 *   MIDI device selector (~140)
 *
 * Usable width ≈ tcpWidth - colorBar(8) - meter(24) - padding(12)
 */
function getMinTrackHeight(tcpWidth: number): number {
  const usable = tcpWidth - 44; // color bar + meter + padding
  const ROW_H = 24; // icon-sm button height
  const GAP_Y = 2;  // gap-y-0.5
  const PAD_Y = 8;  // py-1 top + bottom

  // Approximate total item width for worst case (audio track with all selects)
  const totalItemWidth = 30 + 46 + 126 + 50 + 50 + 50; // ~352px
  const rows = Math.max(1, Math.ceil(totalItemWidth / Math.max(usable, 60)));
  return rows * ROW_H + (rows - 1) * GAP_Y + PAD_Y;
}

// ============================================
// State Serialization Helper
// ============================================

/**
 * Keys that represent transient/runtime state and should NOT be persisted
 * when saving a project. These include metering data (updated at 10-60 Hz),
 * UI interaction state, drag state, and ephemeral display flags.
 */
const TRANSIENT_STATE_KEYS: ReadonlySet<string> = new Set([
  // Metering / automation display — updated at high frequency, meaningless after reload
  "meterLevels",
  "peakLevels",
  "masterLevel",
  "automatedParamValues",

  // Transport runtime (position is reset on load; tempo/loop are saved explicitly)
  "recordingClips",
  "playStartPosition",

  // Selection state — ephemeral, not part of the "document"
  "selectedTrackId",
  "selectedTrackIds",
  "lastSelectedTrackId",
  "selectedClipId",
  "selectedClipIds",
  "clipboard",
  "selectedNoteIds",
  "selectedRegionIds",
  "razorEdits",
  "timeSelection",

  // UI modal/panel visibility — restored from defaults or user preferences
  "showMixer",
  "showSettings",
  "showRenderModal",
  "showPluginBrowser",
  "pluginBrowserTrackId",
  "showVirtualKeyboard",
  "showUndoHistory",
  "showCommandPalette",
  "showRegionMarkerManager",
  "showClipProperties",
  "showBigClock",
  "showKeyboardShortcuts",
  "showContextualHelp",
  "showGettingStarted",
  "showPreferences",
  "showScriptConsole",
  "showPianoRoll",
  "showProjectSettings",
  "showDynamicSplit",
  "showRenderQueue",
  "showRoutingMatrix",
  "showMediaExplorer",
  "showCleanProject",
  "showBatchConverter",
  "showCrossfadeEditor",
  "showThemeEditor",
  "showVideoWindow",
  "showScriptEditor",
  "showToolbarEditor",
  "showDDPExport",
  "showStepSequencer",
  "showClipLauncher",
  "showTimecodeSettings",
  "showQuantizeDialog",
  "showDrumEditor",
  "showMediaPool",
  "showLoudnessMeter",
  "showSpectrumAnalyzer",
  "showPhaseCorrelation",
  "showProjectTemplates",
  "showRegionRenderMatrix",
  "showMasterTrackInTCP",
  "showCrosshair",
  "showProjectCompare",
  "projectCompareData",

  // Piano Roll editing context — ephemeral
  "pianoRollTrackId",
  "pianoRollClipId",
  "dynamicSplitClipId",
  "crossfadeEditorClipIds",

  // Step Input state — runtime only
  "stepInputEnabled",
  "stepInputSize",
  "stepInputPosition",

  // Audio device setup — always re-read from backend on start
  "audioDeviceSetup",

  // Undo/redo flags — restored from deserialized CommandManager
  "canUndo",
  "canRedo",

  // Project loading overlay
  "isProjectLoading",
  "projectLoadingMessage",

  // Toast notifications — ephemeral
  "toastMessage",
  "toastType",
  "toastVisible",

  // Tap tempo timestamps — runtime only
  "tapTimestamps",

  // Recent actions for Command Palette — session-only
  "recentActions",

  // Script console output — session-only
  "scriptConsoleOutput",

  // Plugin A/B states — runtime comparison, not document state
  "pluginABStates",
]);

/**
 * JSON.stringify replacer that strips transient keys and large binary-like
 * data from the serialized output. Used by saveProject to keep project files
 * lean and avoid persisting runtime-only state.
 *
 * @param key - The current key being stringified
 * @param value - The current value being stringified
 * @returns The value to include, or undefined to skip
 */
function projectJsonReplacer(key: string, value: unknown): unknown {
  // Top-level transient keys
  if (key && TRANSIENT_STATE_KEYS.has(key)) {
    return undefined;
  }

  // Strip per-track runtime fields that are not useful after reload
  if (key === "meterLevel" || key === "peakLevel" || key === "clipping") {
    return undefined;
  }

  return value;
}

// Store Creation
// ============================================

export const useDAWStore = create<DAWState & DAWActions>()(
  subscribeWithSelector((set, get) => ({
    // Initial State
    tracks: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    transport: initialTransport,
    recordingClips: [],
    playStartPosition: 0,
    timeSelection: null,
    metronomeEnabled: false,
    metronomeVolume: 0.5,
    metronomeAccentBeats: [true, false, false, false], // Accent beat 1 by default (4/4 time)
    metronomeTrackId: null,
    timeSignature: { numerator: 4, denominator: 4 },
    tapTimestamps: [],
    projectRange: { start: 0, end: 0 },
    selectedClipId: null,
    selectedClipIds: [],
    clipboard: {
      clip: null,
      clips: [],
      isCut: false,
    },
    markers: [],
    regions: [],
    tempoMarkers: [],
    masterVolume: 1.0,
    masterPan: 0.0,
    masterLevel: 0,
    masterFxCount: 0,
    isMasterMuted: false,
    masterMono: false,
    masterAutomationLanes: [
      { id: "master-vol", param: "volume", points: [], visible: false, mode: "read", armed: false },
      { id: "master-pan", param: "pan", points: [], visible: false, mode: "read", armed: false },
    ],
    showMasterAutomation: false,
    meterLevels: {},
    peakLevels: {},
    automatedParamValues: {},
    pixelsPerSecond: 50,
    scrollX: 0,
    scrollY: 0,
    trackHeight: 100,
    tcpWidth: 310,
    recordMode: "normal",
    rippleMode: "off",
    playheadStopBehavior: "return-to-start",
    autoCrossfade: true,
    defaultCrossfadeLength: 0.05,
    razorEdits: [],
    snapEnabled: true,
    gridSize: "bar",
    toolMode: "select" as const,
    showMixer: true,
    showMasterTrackInTCP: false,
    showSettings: false,
    showRenderModal: false,
    showPluginBrowser: false,
    pluginBrowserTrackId: null,
    showEnvelopeManager: false,
    envelopeManagerTrackId: null,
    showChannelStripEQ: false,
    channelStripEQTrackId: null,
    showTrackRouting: false,
    trackRoutingTrackId: null,
    showVirtualKeyboard: false,
    showUndoHistory: false,
    showClipProperties: false,
    showBigClock: false,
    bigClockFormat: "time",
    showKeyboardShortcuts: false,
    showContextualHelp: false,
    showGettingStarted: false,
    showPreferences: false,
    timecodeMode: "time",
    smpteFrameRate: 24,
    uiFontScale: 1.0,
    showCommandPalette: false,
    showRegionMarkerManager: false,
    showScriptConsole: false,
    showStemSeparation: false,
    stemSepTrackId: null,
    stemSepClipId: null,
    stemSepClipName: "",
    stemSepClipDuration: 0,
    showPianoRoll: false,
    pianoRollTrackId: null,
    pianoRollClipId: null,
    selectedNoteIds: [],
    pianoRollScaleRoot: 0,
    pianoRollScaleType: "chromatic",
    stepInputEnabled: false,
    stepInputSize: 0.25,     // 1/16 note by default
    stepInputPosition: 0,
    audioDeviceSetup: null,
    canUndo: false,
    canRedo: false,

    // Project State (F2)
    projectPath: null,
    isModified: false,
    recentProjects: (() => {
      try {
        const stored = localStorage.getItem("recentProjects");
        return stored ? JSON.parse(stored) : [];
      } catch {
        return [];
      }
    })(),

    // Project Settings/Metadata
    showProjectSettings: false,
    projectName: "Untitled Project",
    projectNotes: "",
    projectSampleRate: 44100,
    projectBitDepth: 24,

    autoBackupEnabled: false,
    autoBackupInterval: 300000, // 5 minutes
    autoSaveEnabled: false,
    autoSaveIntervalMinutes: 5,
    autoSaveMaxVersions: 3,

    // Custom Keyboard Shortcuts (persisted in localStorage)
    customShortcuts: (() => {
      try {
        const stored = localStorage.getItem("s13_customShortcuts");
        return stored ? JSON.parse(stored) : {};
      } catch {
        return {};
      }
    })(),

    trackTemplates: JSON.parse(localStorage.getItem("s13_trackTemplates") || "[]"),

    // Project Loading
    isProjectLoading: false,
    projectLoadingMessage: "",

    // Toast notifications
    toastMessage: "",
    toastType: "info" as const,
    toastVisible: false,

    // Lock Settings (granular)
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    globalLocked: false,

    // Track Spacers
    spacers: [],

    // Recent Actions
    recentActions: [],

    // Screensets / Layouts
    screensets: JSON.parse(localStorage.getItem("s13_screensets") || "[]"),

    // Custom Actions (Macros)
    customActions: JSON.parse(localStorage.getItem("s13_customActions") || "[]"),

    // Move Envelope Points with Items
    moveEnvelopesWithItems: true,

    // Render Queue
    renderQueue: [],
    showRenderQueue: false,

    // Phase 9: Audio Engine Enhancements
    showDynamicSplit: false,
    dynamicSplitClipId: null,
    metronomeClickPath: "",
    metronomeAccentPath: "",
    ditherType: "none" as const,
    resampleQuality: "good" as const,

    // Phase 11: Routing & Mixing
    trackGroups: [],
    showRoutingMatrix: false,

    // Phase 10: Render Pipeline Expansion
    selectedRegionIds: [],
    renderMetadata: { title: "", artist: "", album: "", genre: "", year: "", description: "", isrc: "" },
    secondaryOutputEnabled: false,
    secondaryOutputFormat: "mp3",
    secondaryOutputBitDepth: 16,
    onlineRender: false,
    addToProjectAfterRender: false,
    showRegionRenderMatrix: false,

    // Phase 12: Media & File Management
    showMediaExplorer: false,
    mediaExplorerPath: "",
    mediaExplorerRecentPaths: [],
    showCleanProject: false,
    showBatchConverter: false,

    // Phase 13: Advanced Editing
    showCrossfadeEditor: false,
    crossfadeEditorClipIds: null,
    freePositioning: false,

    // Phase 14: Theming & Customization
    theme: "dark",
    customThemeOverrides: {},
    showThemeEditor: false,
    mouseModifiers: {
      clip_drag: { none: "move", ctrl: "copy", shift: "constrain", alt: "bypass_snap" },
      clip_resize: { none: "resize", ctrl: "fine", shift: "symmetric", alt: "stretch" },
      timeline_click: { none: "seek", ctrl: "select_range", shift: "extend_selection", alt: "zoom" },
      track_header: { none: "select", ctrl: "toggle_select", shift: "range_select", alt: "solo" },
      automation_point: { none: "move", ctrl: "fine", shift: "constrain_y", alt: "delete" },
      fade_handle: { none: "adjust", ctrl: "fine", shift: "symmetric", alt: "shape_cycle" },
      ruler_click: { none: "seek", ctrl: "loop_set", shift: "time_select", alt: "zoom_to" },
    },
    panelPositions: {
      mixer: { dock: "bottom", x: 0, y: 0, width: 0, height: 250, visible: false },
      mediaExplorer: { dock: "left", x: 0, y: 0, width: 260, height: 0, visible: false },
      undoHistory: { dock: "floating", x: -1, y: 80, width: 240, height: 300, visible: false },
      clipProperties: { dock: "floating", x: 8, y: 80, width: 240, height: 300, visible: false },
      renderQueue: { dock: "floating", x: -1, y: -1, width: 320, height: 250, visible: false },
    },

    // Phase 15: Platform & Extensibility
    showVideoWindow: false,
    videoFilePath: "",
    videoInfo: null,
    showScriptEditor: false,
    showPitchEditor: false,
    pitchEditorTrackId: null,
    pitchEditorClipId: null,
    pitchEditorFxIndex: 0,
    lowerZoneHeight: 280,
    scriptConsoleOutput: [],
    userScripts: [],
    projectTabs: [{ id: "default", name: "Untitled Project", isActive: true }],
    activeTabId: "default",
    customToolbars: [],
    showToolbarEditor: false,
    ltcEnabled: false,
    ltcOutputChannel: 0,
    ltcFrameRate: 30,

    // Phase 16: Pro Audio & Compatibility
    trackChannelFormats: {},
    masterChannelFormat: "stereo",
    pluginBridgeEnabled: false,
    pluginBridge32Paths: [],
    liveCaptureEnabled: false,
    liveCaptureFilePath: "",
    liveCaptureDuration: 0,
    showDDPExport: false,

    // Phase 4.2: Step Sequencer
    stepSequencer: {
      steps: Array.from({ length: 16 }, () => Array(16).fill(false)),
      velocities: Array.from({ length: 16 }, () => Array(16).fill(100)),
      stepCount: 16,
      stepSize: "1/16",
      selectedPitch: 0,
      pitchCount: 16,
    },
    showStepSequencer: false,

    // Phase 4.1: Clip Launcher
    clipLauncher: {
      slots: [],
      numTracks: 0,
      numSlots: 8,
      quantize: "1bar",
    },
    showClipLauncher: false,
    showMissingMedia: false,
    missingMediaFiles: [],

    // Sprint 17: Visual Improvements
    recentColors: [],

    // Sprint 18: Interaction/Workflow
    autoScrollDuringPlayback: true,
    showQuantizeDialog: false,
    showDrumEditor: false,

    // Sprint 19: Plugin + Mixing
    showMediaPool: false,

    // Plugin A/B Comparison
    pluginABStates: {},

    // FX Chain Presets
    fxChainPresets: [],

    // Sprint 20: Metering + Analysis
    showLoudnessMeter: false,
    showSpectrumAnalyzer: false,
    showPhaseCorrelation: false,
    showProjectTemplates: false,

    // Sprint 21: Timeline Interaction
    showCrosshair: false,

    // Mixer Snapshots
    mixerSnapshots: JSON.parse(localStorage.getItem("s13_mixerSnapshots") || "[]"),

    // Project Templates
    projectTemplates: JSON.parse(localStorage.getItem("s13_projectTemplates") || "[]"),

    // Project Compare
    showProjectCompare: false,
    projectCompareData: null,

    // Collaborative Metadata
    projectAuthor: (() => {
      try {
        return localStorage.getItem("s13_projectAuthor") || "Unknown Author";
      } catch {
        return "Unknown Author";
      }
    })(),
    projectRevisionNotes: [],

    // Timecode Sync Settings
    showTimecodeSettings: false,

    // Detachable Panels (multi-monitor support)
    detachedPanels: [],

    // ========== Toast ==========
    showToast: (message, type = "info") => {
      set({ toastMessage: message, toastType: type, toastVisible: true });
      setTimeout(() => set({ toastVisible: false }), 3000);
    },

    // ========== Project Management (F2) ==========
    newProject: async () => {
      // Stop playback
      await get().stop();

      // Close all open plugin editor windows before removing tracks
      // to prevent dangling pointers / use-after-free crashes
      await nativeBridge.closeAllPluginWindows();

      // Reset sync cache (Sprint 16.3)
      resetSyncCache();

      // Remove all tracks (reverse order to be safe)
      const tracks = get().tracks;
      for (let i = tracks.length - 1; i >= 0; i--) {
        await get().removeTrack(tracks[i].id);
      }

      set({
        projectPath: null,
        isModified: false,
        transport: initialTransport,
        tracks: [],
        selectedTrackId: null,
        selectedClipId: null,
        selectedClipIds: [],
        canUndo: false,
        canRedo: false,
        metronomeVolume: 0.5,
        metronomeTrackId: null,
        projectRange: { start: 0, end: 0 },
        projectRevisionNotes: [],
      });

      // Reset Undo History
      commandManager.clear();
    },

    setModified: (modified) => set({ isModified: modified }),

    saveProject: async (saveAs = false) => {
      let path = get().projectPath;

      if (!path || saveAs) {
        path = await nativeBridge.showSaveDialog(path || undefined);
        if (!path) return false;
      }

      try {
      const state = get();
      console.log(`[DEBUG SAVE] Starting save. ${state.tracks.length} tracks.`);

      // 1. Serialize Tracks with Plugin States
      const serializedTracks = await Promise.all(
        state.tracks.map(async (track) => {
          const inputFXStates: string[] = [];

          const inputFXList = await nativeBridge.getTrackInputFX(track.id);
          console.log(`[DEBUG SAVE] Track "${track.name}" (${track.id}): getTrackInputFX returned`, JSON.stringify(inputFXList));
          const inputFXPaths: string[] = [];
          for (let i = 0; i < inputFXList.length; i++) {
            const item = inputFXList[i];
            console.log(`[DEBUG SAVE]   inputFX[${i}] raw object keys:`, Object.keys(item), `pluginPath="${item.pluginPath}"`);
            if (item.pluginPath) inputFXPaths.push(item.pluginPath);
            const fxState = await nativeBridge.getPluginState(track.id, i, true);
            console.log(`[DEBUG SAVE]   inputFX[${i}] state length: ${fxState ? fxState.length : 0}`);
            if (fxState) inputFXStates.push(fxState);
          }

          const trackFXStates: string[] = [];
          const trackFXPaths: string[] = [];
          const trackFXList = await nativeBridge.getTrackFX(track.id);
          console.log(`[DEBUG SAVE] Track "${track.name}" (${track.id}): getTrackFX returned`, JSON.stringify(trackFXList));
          for (let i = 0; i < trackFXList.length; i++) {
            const item = trackFXList[i];
            console.log(`[DEBUG SAVE]   trackFX[${i}] raw object keys:`, Object.keys(item), `pluginPath="${item.pluginPath}"`);
            if (item.pluginPath) trackFXPaths.push(item.pluginPath);
            const fxState = await nativeBridge.getPluginState(track.id, i, false);
            console.log(`[DEBUG SAVE]   trackFX[${i}] state length: ${fxState ? fxState.length : 0}`);
            if (fxState) trackFXStates.push(fxState);
          }

          console.log(`[DEBUG SAVE] Track "${track.name}" RESULT: ${inputFXPaths.length} input FX paths, ${trackFXPaths.length} track FX paths`);

          return {
            id: track.id,
            name: track.name,
            color: track.color,
            type: track.type,
            inputType: track.inputType,
            inputStartChannel: track.inputStartChannel,
            inputChannelCount: track.inputChannelCount,
            volumeDB: track.volumeDB,
            pan: track.pan,
            muted: track.muted,
            soloed: track.soloed,
            armed: track.armed,
            monitorEnabled: track.monitorEnabled,
            inputChannel: track.inputChannel,
            clips: track.clips,
            midiClips: track.midiClips,
            inputFXPaths,
            inputFXStates,
            trackFXPaths,
            trackFXStates,
            instrumentPlugin: track.instrumentPlugin,
          };
        }),
      );

      // 2. Master Bus FX serialization
      const masterFXPaths: string[] = [];
      const masterFXStates: string[] = [];
      try {
        const masterFXList = await nativeBridge.getMasterFX();
        for (let i = 0; i < masterFXList.length; i++) {
          const path = masterFXList[i].pluginPath;
          if (path) masterFXPaths.push(path);
          const fxState = await nativeBridge.getMasterPluginState(i);
          if (fxState) masterFXStates.push(fxState);
        }
      } catch (e) {
        console.warn("[saveProject] Failed to serialize master FX:", e);
      }

      const projectData = {
        version: "1.0.0",
        savedAt: Date.now(),
        projectName: state.projectName,
        projectNotes: state.projectNotes,
        projectSampleRate: state.projectSampleRate,
        projectBitDepth: state.projectBitDepth,
        tempo: state.transport.tempo,
        timeSignature: state.timeSignature,
        masterVolume: state.masterVolume,
        masterPan: state.masterPan,
        tracks: serializedTracks,
        masterFXPaths,
        masterFXStates,
        metronomeVolume: state.metronomeVolume,
        metronomeTrackId: state.metronomeTrackId,
        projectRange: state.projectRange,
        mixerSnapshots: state.mixerSnapshots,
        customShortcuts: state.customShortcuts,
        autoSaveEnabled: state.autoSaveEnabled,
        autoSaveIntervalMinutes: state.autoSaveIntervalMinutes,
        autoSaveMaxVersions: state.autoSaveMaxVersions,
        projectAuthor: state.projectAuthor,
        projectRevisionNotes: state.projectRevisionNotes,
        undoHistory: commandManager.serialize(),
      };

      const success = await nativeBridge.saveProjectToFile(
        path,
        JSON.stringify(projectData, projectJsonReplacer, 2),
      );

      if (success) {
        console.log(`[DEBUG SAVE] Saved successfully to: ${path}`);
        get().showToast("Project saved", "success");
        set((ctx) => {
          const newRecent = [
            path!,
            ...ctx.recentProjects.filter((p) => p !== path),
          ].slice(0, 10);
          return {
            projectPath: path,
            isModified: false,
            recentProjects: newRecent,
          };
        });
        localStorage.setItem(
          "recentProjects",
          JSON.stringify(get().recentProjects),
        );
      } else {
        console.error(`[DEBUG SAVE] Save FAILED for path: ${path}`);
        get().showToast("Failed to save project", "error");
      }

      return success;
      } catch (e) {
        console.error("[DEBUG SAVE] Exception during save:", e);
        get().showToast("Save failed: " + String(e), "error");
        return false;
      }
    },

    saveNewVersion: async () => {
      const state = get();
      let basePath = state.projectPath;
      if (!basePath) {
        // No existing path — fallback to Save As
        return get().saveProject(true);
      }

      // Increment version: "project.s13" → "project_v2.s13" → "project_v3.s13"
      const ext = basePath.match(/\.[^.]+$/)?.[0] || ".s13";
      const base = basePath.replace(/\.[^.]+$/, "");
      const versionMatch = base.match(/_v(\d+)$/);
      let newPath: string;
      if (versionMatch) {
        const nextVersion = parseInt(versionMatch[1], 10) + 1;
        newPath = base.replace(/_v\d+$/, `_v${nextVersion}`) + ext;
      } else {
        newPath = base + "_v2" + ext;
      }

      // Update projectPath and save
      set({ projectPath: newPath });
      return get().saveProject(false);
    },

    // ========== Auto-Backup ==========
    setAutoBackupEnabled: (enabled) => set({ autoBackupEnabled: enabled }),
    setAutoBackupInterval: (ms) => set({ autoBackupInterval: Math.max(30000, ms) }),

    // ========== Auto-Save ==========
    toggleAutoSave: () => set((s) => ({ autoSaveEnabled: !s.autoSaveEnabled })),
    setAutoSaveInterval: (minutes) =>
      set({ autoSaveIntervalMinutes: Math.max(1, Math.min(60, minutes)) }),
    setAutoSaveMaxVersions: (max) =>
      set({ autoSaveMaxVersions: Math.max(1, Math.min(20, max)) }),

    // ========== Custom Keyboard Shortcuts ==========
    setCustomShortcut: (actionId, shortcut) => {
      set((s) => {
        const updated = { ...s.customShortcuts, [actionId]: shortcut };
        localStorage.setItem("s13_customShortcuts", JSON.stringify(updated));
        return { customShortcuts: updated };
      });
    },
    resetCustomShortcuts: () => {
      localStorage.removeItem("s13_customShortcuts");
      set({ customShortcuts: {} });
    },

    // ========== Track Templates ==========
    saveTrackTemplate: (trackId, name) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;

      const template = {
        id: crypto.randomUUID(),
        name,
        trackConfig: {
          type: track.type,
          inputType: track.inputType,
          color: track.color,
          volumeDB: track.volumeDB,
          pan: track.pan,
          inputStartChannel: track.inputStartChannel,
          inputChannelCount: track.inputChannelCount,
        },
      };

      set((s) => {
        const templates = [...s.trackTemplates, template];
        localStorage.setItem("s13_trackTemplates", JSON.stringify(templates));
        return { trackTemplates: templates };
      });
    },

    loadTrackTemplate: (templateId) => {
      const template = get().trackTemplates.find((t) => t.id === templateId);
      if (!template) return;

      get().addTrack({
        id: crypto.randomUUID(),
        name: template.name,
        ...template.trackConfig,
      });
    },

    deleteTrackTemplate: (templateId) => {
      set((s) => {
        const templates = s.trackTemplates.filter((t) => t.id !== templateId);
        localStorage.setItem("s13_trackTemplates", JSON.stringify(templates));
        return { trackTemplates: templates };
      });
    },

    loadProject: async (path, options) => {
      // Reset sync cache on project load (Sprint 16.3)
      resetSyncCache();

      const bypassFX = options?.bypassFX ?? false;
      if (!path) {
        path = await nativeBridge.showOpenDialog();
        if (!path) return false;
      }

      const json = await nativeBridge.loadProjectFromFile(path);
      if (!json) return false;

      set({ isProjectLoading: true, projectLoadingMessage: "Parsing project..." });
      // Yield to let React render the loading overlay
      await new Promise((r) => setTimeout(r, 0));

      try {
        const data = JSON.parse(json);
        console.log(`[DEBUG LOAD] Parsed project. ${data.tracks?.length || 0} tracks.`);
        // Log what FX data exists in the saved file for each track
        for (const t of data.tracks || []) {
          console.log(`[DEBUG LOAD] Saved track "${t.name}": inputFXPaths=${JSON.stringify(t.inputFXPaths || [])}, trackFXPaths=${JSON.stringify(t.trackFXPaths || [])}, inputFXStates=${(t.inputFXStates || []).length} states, trackFXStates=${(t.trackFXStates || []).length} states`);
        }
        if (data.masterFXPaths) {
          console.log(`[DEBUG LOAD] Saved masterFXPaths=${JSON.stringify(data.masterFXPaths)}`);
        }

        set({ projectLoadingMessage: "Resetting current project..." });
        await new Promise((r) => setTimeout(r, 0));

        // Reset current project
        await get().newProject(); // Clears everything

        // Restore Project Metadata
        if (data.projectName) get().setProjectName(data.projectName);
        if (data.projectNotes) get().setProjectNotes(data.projectNotes);
        if (data.projectSampleRate) get().setProjectSampleRate(data.projectSampleRate);
        if (data.projectBitDepth) get().setProjectBitDepth(data.projectBitDepth);

        // Restore Collaborative Metadata
        if (data.projectAuthor) set({ projectAuthor: data.projectAuthor });
        if (data.projectRevisionNotes) set({ projectRevisionNotes: data.projectRevisionNotes });

        // Restore Global Settings
        get().setTempo(data.tempo || 120);
        if (data.timeSignature) {
          get().setTimeSignature(
            data.timeSignature.numerator,
            data.timeSignature.denominator,
          );
        }
        get().setMasterVolume(data.masterVolume ?? 1.0);
        get().setMasterPan(data.masterPan ?? 0.0);

        // Restore metronome and project range
        if (data.metronomeVolume !== undefined) {
          set({ metronomeVolume: data.metronomeVolume });
          nativeBridge.setMetronomeVolume(data.metronomeVolume);
        }
        if (data.projectRange) {
          set({ projectRange: data.projectRange });
        }
        if (data.metronomeTrackId) {
          set({ metronomeTrackId: data.metronomeTrackId });
        }

        // Restore Tracks
        const totalTracks = data.tracks.length;
        for (let ti = 0; ti < totalTracks; ti++) {
          const trackData = data.tracks[ti];
          set({ projectLoadingMessage: `Loading track ${ti + 1}/${totalTracks}: ${trackData.name}` });
          await new Promise((r) => setTimeout(r, 0));

          console.log("Loading track:", trackData.name, trackData.id);

          try {
            // 1. Create track in backend using explicit ID
            await nativeBridge.addTrack(trackData.id);

            // 2. Restore track properties in backend
            await nativeBridge.setTrackVolume(trackData.id, trackData.volumeDB);
            await nativeBridge.setTrackPan(trackData.id, trackData.pan);

            // Backend defaults are unmuted/unsoloed/unarmed
            if (trackData.muted)
              await nativeBridge.setTrackMute(trackData.id, true);
            if (trackData.soloed)
              await nativeBridge.setTrackSolo(trackData.id, true);
            if (trackData.armed)
              await nativeBridge.setTrackRecordArm(trackData.id, true);
            if (trackData.monitorEnabled)
              await nativeBridge.setTrackInputMonitoring(trackData.id, true);

            // Restore input channel configuration (mono/stereo)
            const inputStartCh = trackData.inputStartChannel ?? 0;
            const inputChCount = trackData.inputChannelCount ?? 2;
            await nativeBridge.setTrackInputChannels(
              trackData.id,
              inputStartCh,
              inputChCount,
            );

            // 3. Restore Clips (Backend)
            if (trackData.clips) {
              for (const clip of trackData.clips) {
                if (clip.filePath) {
                  await nativeBridge.addPlaybackClip(
                    trackData.id,
                    clip.filePath,
                    clip.startTime,
                    clip.duration,
                    clip.offset || 0,
                    clip.volumeDB || 0,
                    clip.fadeIn || 0,
                    clip.fadeOut || 0,
                    clip.id,
                  );
                }
              }
            }

            // 4. Restore FX Plugins (skipped in Recovery Mode)
            console.log(`[DEBUG LOAD] Track "${trackData.name}" FX data from file: bypassFX=${bypassFX}, inputFXPaths=${JSON.stringify(trackData.inputFXPaths || "MISSING")}, trackFXPaths=${JSON.stringify(trackData.trackFXPaths || "MISSING")}`);
            let inputFxRestored = 0;
            if (!bypassFX && trackData.inputFXPaths && trackData.inputFXPaths.length > 0) {
              set({ projectLoadingMessage: `Restoring input FX for ${trackData.name}...` });
              await new Promise((r) => setTimeout(r, 0));
              for (let i = 0; i < trackData.inputFXPaths.length; i++) {
                console.log(`[DEBUG LOAD]   Restoring input FX[${i}]: "${trackData.inputFXPaths[i]}"`);
                const success = await nativeBridge.addTrackInputFX(trackData.id, trackData.inputFXPaths[i], false);
                console.log(`[DEBUG LOAD]   addTrackInputFX result: ${success}`);
                if (success) {
                  if (trackData.inputFXStates && trackData.inputFXStates[i]) {
                    const stateResult = await nativeBridge.setPluginState(trackData.id, i, true, trackData.inputFXStates[i]);
                    console.log(`[DEBUG LOAD]   setPluginState(input) result: ${stateResult}`);
                  }
                  inputFxRestored++;
                }
              }
            }

            let trackFxRestored = 0;
            if (!bypassFX && trackData.trackFXPaths && trackData.trackFXPaths.length > 0) {
              set({ projectLoadingMessage: `Restoring track FX for ${trackData.name}...` });
              await new Promise((r) => setTimeout(r, 0));
              for (let i = 0; i < trackData.trackFXPaths.length; i++) {
                console.log(`[DEBUG LOAD]   Restoring track FX[${i}]: "${trackData.trackFXPaths[i]}"`);
                const success = await nativeBridge.addTrackFX(trackData.id, trackData.trackFXPaths[i], false);
                console.log(`[DEBUG LOAD]   addTrackFX result: ${success}`);
                if (success) {
                  if (trackData.trackFXStates && trackData.trackFXStates[i]) {
                    const stateResult = await nativeBridge.setPluginState(trackData.id, i, false, trackData.trackFXStates[i]);
                    console.log(`[DEBUG LOAD]   setPluginState(track) result: ${stateResult}`);
                  }
                  trackFxRestored++;
                }
              }
            }

            console.log(`[DEBUG LOAD] Track "${trackData.name}" RESULT: restored ${inputFxRestored} input FX, ${trackFxRestored} track FX`);

            // Ensure saved track data has correct defaults for store state
            trackData.inputType = trackData.inputType || (inputChCount === 1 ? "mono" : "stereo");
            trackData.inputStartChannel = inputStartCh;
            trackData.inputChannelCount = inputChCount;
            trackData.inputFxCount = inputFxRestored;
            trackData.trackFxCount = trackFxRestored;
            // Ensure runtime fields exist
            trackData.meterLevel = trackData.meterLevel ?? 0;
            trackData.peakLevel = trackData.peakLevel ?? 0;
            trackData.clipping = trackData.clipping ?? false;
            trackData.volume = trackData.volume ?? (trackData.volumeDB <= -60 ? 0 : Math.pow(10, trackData.volumeDB / 20));
          } catch (err) {
            console.error(`Failed to restore track ${trackData.name}`, err);
          }
        }

        // 5. Restore Master FX Plugins
        let masterFxRestored = 0;
        if (!bypassFX && data.masterFXPaths && data.masterFXPaths.length > 0) {
          set({ projectLoadingMessage: "Restoring master FX..." });
          await new Promise((r) => setTimeout(r, 0));
          for (let i = 0; i < data.masterFXPaths.length; i++) {
            const success = await nativeBridge.addMasterFX(data.masterFXPaths[i]);
            if (success) {
              if (data.masterFXStates && data.masterFXStates[i]) {
                await nativeBridge.setMasterPluginState(i, data.masterFXStates[i]);
              }
              masterFxRestored++;
            }
          }
        }

        set({ projectLoadingMessage: "Finalizing...", masterFxCount: masterFxRestored });
        await new Promise((r) => setTimeout(r, 0));

        // Normalize tracks — fill missing fields from defaults for old project files
        const normalizedTracks = (data.tracks || []).map((t: any) => {
          const defaults = createDefaultTrack(t.id, t.name, t.color);
          return {
            ...defaults,
            ...t,
            clips: (t.clips || []).map((c: any) => ({ ...c, offset: c.offset ?? 0 })),
            midiClips: t.midiClips ?? [],
            sends: t.sends ?? [],
            automationLanes: (t.automationLanes ?? defaults.automationLanes).map((l: any) => ({
              ...l,
              mode: l.mode ?? "read",
              armed: l.armed ?? false,
            })),
            takes: t.takes ?? [],
            meterLevel: 0,
            peakLevel: 0,
            clipping: false,
          };
        });

        // Update Store State
        set((state) => ({
          tracks: normalizedTracks,
          projectPath: path,
          isModified: false,
          transport: { ...state.transport, tempo: data.tempo || 120 },
          timeSignature: data.timeSignature || { numerator: 4, denominator: 4 },
          masterVolume: data.masterVolume ?? 1.0,
          masterPan: data.masterPan ?? 0.0,
          metronomeVolume: data.metronomeVolume ?? 0.5,
          metronomeTrackId: data.metronomeTrackId ?? null,
          projectRange: data.projectRange ?? { start: 0, end: 120 },
          mixerSnapshots: data.mixerSnapshots ?? [],
        }));

        // Persist loaded mixer snapshots to localStorage
        if (data.mixerSnapshots && data.mixerSnapshots.length > 0) {
          localStorage.setItem("s13_mixerSnapshots", JSON.stringify(data.mixerSnapshots));
        }

        // Restore custom shortcuts and auto-save settings from project
        if (data.customShortcuts && typeof data.customShortcuts === "object") {
          set({ customShortcuts: data.customShortcuts });
          localStorage.setItem("s13_customShortcuts", JSON.stringify(data.customShortcuts));
        }
        if (data.autoSaveEnabled !== undefined) {
          set({
            autoSaveEnabled: data.autoSaveEnabled,
            autoSaveIntervalMinutes: data.autoSaveIntervalMinutes ?? 5,
            autoSaveMaxVersions: data.autoSaveMaxVersions ?? 3,
          });
        }

        // Restore undo history metadata (display-only — pre-save commands
        // cannot be re-executed, but the history panel will show them)
        if (data.undoHistory) {
          commandManager.deserialize(data.undoHistory);
          set({
            canUndo: commandManager.canUndo(),
            canRedo: commandManager.canRedo(),
          });
        }

        set((ctx) => {
          const newRecent = [
            path!,
            ...ctx.recentProjects.filter((p) => p !== path),
          ].slice(0, 10);
          return {
            projectPath: path,
            isModified: false,
            recentProjects: newRecent,
          };
        });
        localStorage.setItem(
          "recentProjects",
          JSON.stringify(get().recentProjects),
        );

        // Check for missing media files
        set({ projectLoadingMessage: "Checking media files..." });
        await new Promise((r) => setTimeout(r, 0));
        const missingFiles: Array<{ path: string; clipIds: string[] }> = [];
        const checkedPaths = new Map<string, boolean>();
        for (const track of get().tracks) {
          for (const clip of track.clips) {
            if (!clip.filePath) continue;
            if (!checkedPaths.has(clip.filePath)) {
              const exists = await nativeBridge.fileExists(clip.filePath).catch(() => true);
              checkedPaths.set(clip.filePath, exists);
            }
            if (!checkedPaths.get(clip.filePath)) {
              const existing = missingFiles.find((f) => f.path === clip.filePath);
              if (existing) {
                existing.clipIds.push(clip.id);
              } else {
                missingFiles.push({ path: clip.filePath, clipIds: [clip.id] });
              }
            }
          }
        }
        if (missingFiles.length > 0) {
          set({ showMissingMedia: true, missingMediaFiles: missingFiles });
        }

        set({ isProjectLoading: false, projectLoadingMessage: "" });
        return true;
      } catch (e) {
        console.error("Failed to parse project file", e);
        set({ isProjectLoading: false, projectLoadingMessage: "" });
        return false;
      }
    },

    clearRecentProjects: () => {
      set({ recentProjects: [] });
      localStorage.removeItem("recentProjects");
    },

    // ========== Project Settings ==========
    setProjectName: (name) => {
      set({ projectName: name, isModified: true });
    },

    setProjectNotes: (notes) => {
      set({ projectNotes: notes, isModified: true });
    },

    setProjectSampleRate: (sampleRate) => {
      set({ projectSampleRate: sampleRate, isModified: true });
    },

    setProjectBitDepth: (bitDepth) => {
      set({ projectBitDepth: bitDepth, isModified: true });
    },

    // ========== Track Folder Management ==========
    createFolderTrack: (name) => {
      const id = crypto.randomUUID();
      const newTrack = createDefaultTrack(id, name);
      const folderTrack: Track = { ...newTrack, isFolder: true, folderCollapsed: false, icon: "folder" };

      const command: Command = {
        type: "ADD_FOLDER_TRACK",
        description: `Add folder track "${name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((state) => ({ tracks: [...state.tracks, folderTrack] }));
        },
        undo: () => {
          set((state) => ({
            tracks: state.tracks
              .filter((t) => t.id !== id)
              .map((t) => (t.parentFolderId === id ? { ...t, parentFolderId: undefined } : t)),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    moveTracksToFolder: (trackIds, folderId) => {
      const state = get();
      const folder = state.tracks.find((t) => t.id === folderId && t.isFolder);
      if (!folder) return;
      // Capture old parentFolderIds for undo
      const oldParents = new Map<string, string | undefined>();
      for (const tid of trackIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) oldParents.set(tid, t.parentFolderId);
      }

      const command: Command = {
        type: "MOVE_TRACKS_TO_FOLDER",
        description: `Move ${trackIds.length} track(s) to folder "${folder.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              trackIds.includes(t.id) ? { ...t, parentFolderId: folderId } : t,
            ),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldParents.get(t.id);
              return old !== undefined || oldParents.has(t.id)
                ? { ...t, parentFolderId: old }
                : t;
            }),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleFolderCollapsed: (folderId) => {
      const state = get();
      const folder = state.tracks.find((t) => t.id === folderId && t.isFolder);
      if (!folder) return;
      const newCollapsed = !folder.folderCollapsed;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === folderId ? { ...t, folderCollapsed: newCollapsed } : t,
        ),
      }));
    },

    removeTrackFromFolder: (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track || !track.parentFolderId) return;
      const oldFolderId = track.parentFolderId;

      const command: Command = {
        type: "REMOVE_TRACK_FROM_FOLDER",
        description: `Remove track "${track.name}" from folder`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId ? { ...t, parentFolderId: undefined } : t,
            ),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId ? { ...t, parentFolderId: oldFolderId } : t,
            ),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    getVisibleTracks: () => {
      const { tracks } = get();
      // Collect all collapsed folder IDs
      const collapsedFolderIds = new Set<string>();
      for (const t of tracks) {
        if (t.isFolder && t.folderCollapsed) collapsedFolderIds.add(t.id);
      }
      if (collapsedFolderIds.size === 0) return tracks;

      // Build set of all ancestor folder IDs for each track; if any ancestor is collapsed, hide
      return tracks.filter((t) => {
        let current = t;
        while (current.parentFolderId) {
          if (collapsedFolderIds.has(current.parentFolderId)) return false;
          const parent = tracks.find((p) => p.id === current.parentFolderId);
          if (!parent) break;
          current = parent;
        }
        return true;
      });
    },

    // ========== VCA Faders ==========
    createVCAFader: (name, memberTrackIds) => {
      const vcaGroupId = crypto.randomUUID();
      const vcaTrackId = crypto.randomUUID();
      const vcaTrack = createDefaultTrack(vcaTrackId, name);
      const faderTrack: Track = { ...vcaTrack, isVCALeader: true, vcaGroupId, type: "bus" as TrackType, icon: "bus" };

      const command: Command = {
        type: "CREATE_VCA_FADER",
        description: `Create VCA fader "${name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((state) => ({
            tracks: [
              ...state.tracks.map((t) =>
                memberTrackIds.includes(t.id) ? { ...t, vcaGroupId } : t,
              ),
              faderTrack,
            ],
          }));
        },
        undo: () => {
          set((state) => ({
            tracks: state.tracks
              .filter((t) => t.id !== vcaTrackId)
              .map((t) => (t.vcaGroupId === vcaGroupId ? { ...t, vcaGroupId: undefined } : t)),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeVCAGroup: (vcaGroupId) => {
      const state = get();
      const vcaLeader = state.tracks.find((t) => t.isVCALeader && t.vcaGroupId === vcaGroupId);
      const memberIds = state.tracks.filter((t) => t.vcaGroupId === vcaGroupId).map((t) => t.id);
      if (!vcaLeader) return;

      const command: Command = {
        type: "REMOVE_VCA_GROUP",
        description: `Remove VCA group "${vcaLeader.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks
              .filter((t) => !(t.isVCALeader && t.vcaGroupId === vcaGroupId))
              .map((t) => (t.vcaGroupId === vcaGroupId ? { ...t, vcaGroupId: undefined } : t)),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: [
              ...s.tracks.map((t) =>
                memberIds.includes(t.id) ? { ...t, vcaGroupId } : t,
              ),
              vcaLeader,
            ],
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== Track Management ==========
    addTrack: (trackData) => {
      const newTrack = createDefaultTrack(
        trackData.id,
        trackData.name,
        trackData.color,
      );
      const fullTrack = { ...newTrack, ...trackData };

      const command: Command = {
        type: "ADD_TRACK",
        description: `Add track "${trackData.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((state) => {
            const insertAfter = (trackData as any).insertAfterTrackId as string | undefined;
            if (insertAfter) {
              const idx = state.tracks.findIndex((t) => t.id === insertAfter);
              if (idx >= 0) {
                const newTracks = [...state.tracks];
                newTracks.splice(idx + 1, 0, fullTrack);
                return { tracks: newTracks };
              }
            }
            return { tracks: [...state.tracks, fullTrack] };
          });
          nativeBridge.addTrack(trackData.id).catch((e) =>
            console.error("[DAW] Failed to sync addTrack with backend:", e),
          );
        },
        undo: () => {
          nativeBridge.removeTrack(trackData.id).catch((e) =>
            console.error("[DAW] Failed to sync removeTrack with backend:", e),
          );
          set((state) => ({
            tracks: state.tracks.filter((t) => t.id !== trackData.id),
            selectedTrackId:
              state.selectedTrackId === trackData.id ? null : state.selectedTrackId,
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeTrack: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      // Capture full track data and its index for undo
      const trackSnapshot = JSON.parse(JSON.stringify(track)) as Track;
      const trackIndex = state.tracks.findIndex((t) => t.id === id);

      const command: Command = {
        type: "REMOVE_TRACK",
        description: `Remove track "${track.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          // Clear clips from backend playback engine
          for (const clip of trackSnapshot.clips) {
            if (clip.filePath) {
              await nativeBridge.removePlaybackClip(id, clip.filePath).catch(() => {});
            }
          }
          await nativeBridge.removeTrack(id).catch(() => {});
          set((s) => ({
            tracks: s.tracks.filter((t) => t.id !== id),
            selectedTrackId: s.selectedTrackId === id ? null : s.selectedTrackId,
            metronomeTrackId: s.metronomeTrackId === id ? null : s.metronomeTrackId,
          }));
        },
        undo: async () => {
          // Re-add track to backend
          await nativeBridge.addTrack(id).catch(() => {});
          // Restore track at original position
          set((s) => {
            const newTracks = [...s.tracks];
            newTracks.splice(Math.min(trackIndex, newTracks.length), 0, trackSnapshot);
            return { tracks: newTracks };
          });
          // Re-add clips to backend
          for (const clip of trackSnapshot.clips) {
            if (clip.filePath) {
              await nativeBridge.addPlaybackClip(
                id, clip.filePath, clip.startTime, clip.duration,
                clip.offset || 0, clip.volumeDB || 0, clip.fadeIn || 0, clip.fadeOut || 0,
                clip.id,
              ).catch(() => {});
            }
          }
          // Restore backend track order
          nativeBridge.reorderTrack(id, trackIndex).catch(() => {});
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    updateTrack: (id, updates) => {
      set((state) => ({
        tracks: state.tracks.map((t) => {
          if (t.id === id) {
            // If color is being updated, also update all clips to match
            const updatedTrack = { ...t, ...updates };
            if (updates.color) {
              updatedTrack.clips = t.clips.map((clip) => ({
                ...clip,
                color: updates.color!,
              }));
            }
            return updatedTrack;
          }
          return t;
        }),
      }));
    },

    setTrackNotes: (trackId, notes) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return;
      const oldNotes = track.notes || "";
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, notes } : t,
        ),
      }));
      const command: Command = {
        type: "UPDATE_TRACK",
        description: `Set track notes on "${track.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId ? { ...t, notes } : t,
            ),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId ? { ...t, notes: oldNotes } : t,
            ),
          }));
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    reorderTrack: (activeId, overId) => {
      const state = get();
      const oldIndex = state.tracks.findIndex((t) => t.id === activeId);
      const newIndex = state.tracks.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return;

      const command: Command = {
        type: "REORDER_TRACK",
        description: "Reorder track",
        timestamp: Date.now(),
        execute: () => {
          set((s) => {
            const oi = s.tracks.findIndex((t) => t.id === activeId);
            const ni = s.tracks.findIndex((t) => t.id === overId);
            if (oi === -1 || ni === -1) return s;
            const newTracks = [...s.tracks];
            const [moved] = newTracks.splice(oi, 1);
            newTracks.splice(ni, 0, moved);
            nativeBridge.reorderTrack(activeId, ni);
            return { tracks: newTracks };
          });
        },
        undo: () => {
          set((s) => {
            const ci = s.tracks.findIndex((t) => t.id === activeId);
            if (ci === -1) return s;
            const newTracks = [...s.tracks];
            const [moved] = newTracks.splice(ci, 1);
            newTracks.splice(Math.min(oldIndex, newTracks.length), 0, moved);
            nativeBridge.reorderTrack(activeId, oldIndex);
            return { tracks: newTracks };
          });
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    reorderMultipleTracks: (trackIds, overId) => {
      set((state) => {
        // Find the target position (where the drop target is)
        const overIndex = state.tracks.findIndex((t) => t.id === overId);
        if (overIndex === -1) return state;

        // Extract selected tracks in their original relative order
        const selectedTracks = state.tracks.filter((t) => trackIds.includes(t.id));
        const remainingTracks = state.tracks.filter((t) => !trackIds.includes(t.id));

        // Find where to insert in the remaining array
        let insertIndex = remainingTracks.findIndex((t) => t.id === overId);
        if (insertIndex === -1) {
          // overId was a selected track — insert at the original position
          insertIndex = Math.min(overIndex, remainingTracks.length);
        } else {
          // Determine drag direction: if first selected was above over target, we're moving down
          const firstSelectedIndex = state.tracks.findIndex((t) => trackIds.includes(t.id));
          if (firstSelectedIndex < overIndex) {
            insertIndex++; // Insert AFTER the over item when moving down
          }
        }

        // Insert all selected tracks at the target position
        const newTracks = [...remainingTracks];
        newTracks.splice(insertIndex, 0, ...selectedTracks);

        // Sync backend for each moved track
        newTracks.forEach((track, i) => {
          nativeBridge.reorderTrack(track.id, i);
        });

        return { tracks: newTracks };
      });
    },

    selectTrack: (id, modifiers) => {
      if (id === null) {
        // Deselect all
        set({
          selectedTrackId: null,
          selectedTrackIds: [],
          lastSelectedTrackId: null,
        });
        return;
      }

      const state = get();
      const { shift, ctrl } = modifiers || {};

      if (shift && state.lastSelectedTrackId) {
        // Range selection: select all tracks between lastSelectedTrackId and id
        const trackIds = state.tracks.map((t) => t.id);
        const lastIndex = trackIds.indexOf(state.lastSelectedTrackId);
        const currentIndex = trackIds.indexOf(id);
        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const rangeIds = trackIds.slice(start, end + 1);
          // Merge with existing selection
          const newSelection = [
            ...new Set([...state.selectedTrackIds, ...rangeIds]),
          ];
          set({ selectedTrackIds: newSelection, selectedTrackId: id });
        }
      } else if (ctrl) {
        // Toggle selection: add or remove from selection
        const isSelected = state.selectedTrackIds.includes(id);
        if (isSelected) {
          const newSelection = state.selectedTrackIds.filter(
            (tid) => tid !== id,
          );
          set({
            selectedTrackIds: newSelection,
            selectedTrackId:
              newSelection.length > 0
                ? newSelection[newSelection.length - 1]
                : null,
            lastSelectedTrackId: id,
          });
        } else {
          set({
            selectedTrackIds: [...state.selectedTrackIds, id],
            selectedTrackId: id,
            lastSelectedTrackId: id,
          });
        }
      } else {
        // Single selection: replace selection with this track + all linked group members
        const linkedIds = getLinkedTrackIds(id, state.trackGroups);
        set({
          selectedTrackId: id,
          selectedTrackIds: linkedIds,
          lastSelectedTrackId: id,
        });
      }
    },

    selectAllTracks: () => {
      const state = get();
      const allIds = state.tracks.map((t) => t.id);
      set({
        selectedTrackIds: allIds,
        selectedTrackId: allIds.length > 0 ? allIds[0] : null,
      });
    },

    deselectAllTracks: () => {
      set({
        selectedTrackId: null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    deleteSelectedTracks: async () => {
      const state = get();
      const { selectedTrackIds, removeTrack } = state;

      // Delete all selected tracks (removeTrack handles backend sync)
      for (const trackId of selectedTrackIds) {
        await removeTrack(trackId);
      }

      // Clear selection after deletion
      set({
        selectedTrackId: null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    // ========== Track Audio Controls ==========
    setTrackVolume: async (id, volumeDB) => {
      if (_linkingInProgress.has("vol_" + id)) return;
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, get().trackGroups, "volume");
      const linear = Math.pow(10, volumeDB / 20);

      // Batch update all linked tracks in a single set()
      set((state) => ({
        tracks: state.tracks.map((t) =>
          linkedIds.includes(t.id) ? { ...t, volumeDB, volume: Math.min(1, linear) } : t,
        ),
      }));

      // Bridge calls for each linked track
      for (const tid of linkedIds) {
        _linkingInProgress.add("vol_" + tid);
        nativeBridge.setTrackVolume(tid, volumeDB);
      }
      for (const tid of linkedIds) _linkingInProgress.delete("vol_" + tid);

      // Auto-record automation: write points when playing + lane armed + mode is write/touch/latch
      if (get().transport.isPlaying) {
        const freshTrack = get().tracks.find((t) => t.id === id);
        const volLane = freshTrack?.automationLanes.find((l) => l.param === "volume");
        if (volLane && volLane.armed && (volLane.mode === "write" || volLane.mode === "touch" || volLane.mode === "latch")) {
          const now = Date.now();
          const key = `${id}_volume`;
          const lastRecorded = _autoRecordTimers.get(key) ?? 0;
          if (now - lastRecorded >= AUTO_RECORD_INTERVAL_MS) {
            _autoRecordTimers.set(key, now);
            const normalizedValue = Math.max(0, Math.min(1, (volumeDB + 60) / 66));
            get().addAutomationPoint(id, volLane.id, get().transport.currentTime, normalizedValue);
          }
        }
      }
    },

    setTrackPan: async (id, pan) => {
      if (_linkingInProgress.has("pan_" + id)) return;
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, get().trackGroups, "pan");

      set((state) => ({
        tracks: state.tracks.map((t) => (linkedIds.includes(t.id) ? { ...t, pan } : t)),
      }));

      for (const tid of linkedIds) {
        _linkingInProgress.add("pan_" + tid);
        nativeBridge.setTrackPan(tid, pan);
      }
      for (const tid of linkedIds) _linkingInProgress.delete("pan_" + tid);

      // Auto-record automation: write points when playing + lane armed + mode is write/touch/latch
      if (get().transport.isPlaying) {
        const freshTrack = get().tracks.find((t) => t.id === id);
        const panLane = freshTrack?.automationLanes.find((l) => l.param === "pan");
        if (panLane && panLane.armed && (panLane.mode === "write" || panLane.mode === "touch" || panLane.mode === "latch")) {
          const now = Date.now();
          const key = `${id}_pan`;
          const lastRecorded = _autoRecordTimers.get(key) ?? 0;
          if (now - lastRecorded >= AUTO_RECORD_INTERVAL_MS) {
            _autoRecordTimers.set(key, now);
            const normalizedValue = Math.max(0, Math.min(1, (pan + 1) / 2));
            get().addAutomationPoint(id, panLane.id, get().transport.currentTime, normalizedValue);
          }
        }
      }
    },

    toggleTrackMute: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "mute");
      const newMuted = !track.muted;
      // Capture old states for undo
      const oldStates = new Map<string, boolean>();
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) oldStates.set(tid, t.muted);
      }

      const command: Command = {
        type: "TOGGLE_TRACK_MUTE",
        description: newMuted ? "Mute track(s)" : "Unmute track(s)",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              linkedIds.includes(t.id) ? { ...t, muted: newMuted } : t,
            ),
          }));
          for (const tid of linkedIds) nativeBridge.setTrackMute(tid, newMuted);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldStates.get(t.id);
              return old !== undefined ? { ...t, muted: old } : t;
            }),
          }));
          for (const [tid, val] of oldStates) nativeBridge.setTrackMute(tid, val);
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleTrackSolo: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "solo");
      const newSoloed = !track.soloed;
      const oldStates = new Map<string, boolean>();
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) oldStates.set(tid, t.soloed);
      }

      const command: Command = {
        type: "TOGGLE_TRACK_SOLO",
        description: newSoloed ? "Solo track(s)" : "Unsolo track(s)",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              linkedIds.includes(t.id) ? { ...t, soloed: newSoloed } : t,
            ),
          }));
          for (const tid of linkedIds) nativeBridge.setTrackSolo(tid, newSoloed);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldStates.get(t.id);
              return old !== undefined ? { ...t, soloed: old } : t;
            }),
          }));
          for (const [tid, val] of oldStates) nativeBridge.setTrackSolo(tid, val);
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleTrackArmed: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      // Record-safe: prevent arming
      if (track.recordSafe && !track.armed) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "armed");
      const newArmed = !track.armed;

      // Filter out record-safe tracks from linked set when trying to arm
      const effectiveIds = newArmed
        ? linkedIds.filter((tid) => !state.tracks.find((t) => t.id === tid)?.recordSafe)
        : linkedIds;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          effectiveIds.includes(t.id) ? { ...t, armed: newArmed } : t,
        ),
      }));

      for (const tid of effectiveIds) await nativeBridge.setTrackRecordArm(tid, newArmed);
    },

    toggleTrackFXBypass: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "fxBypass");
      const newBypassed = !track.fxBypassed;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          linkedIds.includes(t.id) ? { ...t, fxBypassed: newBypassed } : t,
        ),
      }));

      // Bypass/unbypass all FX on all linked tracks
      for (const tid of linkedIds) {
        const linkedTrack = state.tracks.find((t) => t.id === tid);
        if (!linkedTrack) continue;
        for (let i = 0; i < linkedTrack.inputFxCount; i++)
          await nativeBridge.bypassTrackInputFX(tid, i, newBypassed);
        for (let i = 0; i < linkedTrack.trackFxCount; i++)
          await nativeBridge.bypassTrackFX(tid, i, newBypassed);
      }
    },

    toggleTrackMonitor: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const newMonitor = !track.monitorEnabled;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id ? { ...t, monitorEnabled: newMonitor } : t,
        ),
      }));

      await nativeBridge.setTrackInputMonitoring(id, newMonitor);
    },

    setTrackInput: async (id, startChannel, channelCount) => {
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === id
            ? {
                ...t,
                inputStartChannel: startChannel,
                inputChannelCount: channelCount,
              }
            : t,
        ),
      }));

      await nativeBridge.setTrackInputChannels(id, startChannel, channelCount);
    },

    // ========== Continuous Edit Begin/Commit (for undo/redo of fader drags) ==========
    beginTrackVolumeEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "volume");
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) _editSnapshots.set("vol_" + tid, t.volumeDB);
        // Signal touch begin to backend for touch/latch automation
        const volLane = t?.automationLanes.find((l) => l.param === "volume");
        if (volLane && volLane.armed && (volLane.mode === "touch" || volLane.mode === "latch")) {
          nativeBridge.beginTouchAutomation(tid, "volume");
        }
      }
    },
    commitTrackVolumeEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "volume");

      // Collect old/new values for all linked tracks
      const changes: Array<{ tid: string; oldVal: number; newVal: number }> = [];
      for (const tid of linkedIds) {
        const key = "vol_" + tid;
        const oldVal = _editSnapshots.get(key);
        _editSnapshots.delete(key);
        if (oldVal === undefined) continue;
        const t = state.tracks.find((tr) => tr.id === tid);
        if (!t || t.volumeDB === oldVal) continue;
        changes.push({ tid, oldVal, newVal: t.volumeDB });
      }
      if (changes.length === 0) return;

      const command: Command = {
        type: "SET_TRACK_VOLUME",
        description: "Adjust track volume",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, volumeDB: c.newVal, volume: Math.min(1, Math.pow(10, c.newVal / 20)) } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackVolume(c.tid, c.newVal);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, volumeDB: c.oldVal, volume: Math.min(1, Math.pow(10, c.oldVal / 20)) } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackVolume(c.tid, c.oldVal);
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });

      // Signal touch end to backend + clear throttle timers for touch/latch automation
      for (const c of changes) {
        const t = get().tracks.find((tr) => tr.id === c.tid);
        const volLane = t?.automationLanes.find((l) => l.param === "volume");
        if (volLane && volLane.armed && (volLane.mode === "touch" || volLane.mode === "latch")) {
          nativeBridge.endTouchAutomation(c.tid, "volume");
          _autoRecordTimers.delete(`${c.tid}_volume`);
        }
      }
    },
    beginTrackPanEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "pan");
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) _editSnapshots.set("pan_" + tid, t.pan);
        // Signal touch begin to backend for touch/latch automation
        const panLane = t?.automationLanes.find((l) => l.param === "pan");
        if (panLane && panLane.armed && (panLane.mode === "touch" || panLane.mode === "latch")) {
          nativeBridge.beginTouchAutomation(tid, "pan");
        }
      }
    },
    commitTrackPanEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "pan");

      const changes: Array<{ tid: string; oldVal: number; newVal: number }> = [];
      for (const tid of linkedIds) {
        const key = "pan_" + tid;
        const oldVal = _editSnapshots.get(key);
        _editSnapshots.delete(key);
        if (oldVal === undefined) continue;
        const t = state.tracks.find((tr) => tr.id === tid);
        if (!t || t.pan === oldVal) continue;
        changes.push({ tid, oldVal, newVal: t.pan });
      }
      if (changes.length === 0) return;

      const command: Command = {
        type: "SET_TRACK_PAN",
        description: "Adjust track pan",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, pan: c.newVal } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackPan(c.tid, c.newVal);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, pan: c.oldVal } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackPan(c.tid, c.oldVal);
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });

      // Signal touch end to backend + clear throttle timers for touch/latch automation
      for (const c of changes) {
        const t = get().tracks.find((tr) => tr.id === c.tid);
        const panLane = t?.automationLanes.find((l) => l.param === "pan");
        if (panLane && panLane.armed && (panLane.mode === "touch" || panLane.mode === "latch")) {
          nativeBridge.endTouchAutomation(c.tid, "pan");
          _autoRecordTimers.delete(`${c.tid}_pan`);
        }
      }
    },
    beginClipVolumeEdit: (clipId) => {
      for (const track of get().tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { _editSnapshots.set("clipVol_" + clipId, clip.volumeDB); break; }
      }
    },
    commitClipVolumeEdit: (clipId) => {
      const key = "clipVol_" + clipId;
      const oldValue = _editSnapshots.get(key);
      _editSnapshots.delete(key);
      if (oldValue === undefined) return;
      let newValue = oldValue;
      for (const track of get().tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { newValue = clip.volumeDB; break; }
      }
      if (newValue === oldValue) return;
      const command: Command = {
        type: "SET_CLIP_VOLUME",
        description: "Adjust clip volume",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, volumeDB: newValue } : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, volumeDB: oldValue } : clip,
              ),
            })),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== FX Undo/Redo ==========
    addTrackFXWithUndo: async (trackId, pluginPath, chainType) => {
      const addFn = chainType === "input" ? nativeBridge.addTrackInputFX.bind(nativeBridge) : nativeBridge.addTrackFX.bind(nativeBridge);
      const removeFn = chainType === "input" ? nativeBridge.removeTrackInputFX.bind(nativeBridge) : nativeBridge.removeTrackFX.bind(nativeBridge);

      const success = await addFn(trackId, pluginPath);
      if (!success) return false;

      // Get the new FX count to know the index of the just-added plugin
      const fxList = chainType === "input"
        ? await nativeBridge.getTrackInputFX(trackId)
        : await nativeBridge.getTrackFX(trackId);
      const newIndex = fxList.length - 1;

      // Update store FX counts
      const countField = chainType === "input" ? "inputFxCount" : "trackFxCount";
      get().updateTrack(trackId, { [countField]: fxList.length });

      const command: Command = {
        type: "ADD_TRACK_FX",
        description: `Add ${chainType} FX`,
        timestamp: Date.now(),
        execute: async () => {
          await addFn(trackId, pluginPath);
          const list = chainType === "input"
            ? await nativeBridge.getTrackInputFX(trackId)
            : await nativeBridge.getTrackFX(trackId);
          get().updateTrack(trackId, { [countField]: list.length });
        },
        undo: async () => {
          await removeFn(trackId, newIndex);
          const list = chainType === "input"
            ? await nativeBridge.getTrackInputFX(trackId)
            : await nativeBridge.getTrackFX(trackId);
          get().updateTrack(trackId, { [countField]: list.length });
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    removeTrackFXWithUndo: async (trackId, fxIndex, chainType) => {
      const isInput = chainType === "input";

      // Save plugin state and path before removing
      const fxList = isInput
        ? await nativeBridge.getTrackInputFX(trackId)
        : await nativeBridge.getTrackFX(trackId);
      const pluginInfo = fxList[fxIndex];
      const pluginPath = pluginInfo?.pluginPath || "";
      const savedState = await nativeBridge.getPluginState(trackId, fxIndex, isInput);

      const removeFn = isInput ? nativeBridge.removeTrackInputFX.bind(nativeBridge) : nativeBridge.removeTrackFX.bind(nativeBridge);
      const addFn = isInput ? nativeBridge.addTrackInputFX.bind(nativeBridge) : nativeBridge.addTrackFX.bind(nativeBridge);

      await removeFn(trackId, fxIndex);

      // Update store FX counts
      const countField = isInput ? "inputFxCount" : "trackFxCount";
      const newList = isInput
        ? await nativeBridge.getTrackInputFX(trackId)
        : await nativeBridge.getTrackFX(trackId);
      get().updateTrack(trackId, { [countField]: newList.length });

      const command: Command = {
        type: "REMOVE_TRACK_FX",
        description: `Remove ${chainType} FX`,
        timestamp: Date.now(),
        execute: async () => {
          await removeFn(trackId, fxIndex);
          const list = isInput
            ? await nativeBridge.getTrackInputFX(trackId)
            : await nativeBridge.getTrackFX(trackId);
          get().updateTrack(trackId, { [countField]: list.length });
        },
        undo: async () => {
          // Re-add the plugin and restore its state
          const success = await addFn(trackId, pluginPath);
          if (success && savedState) {
            // The re-added plugin is at the end; move it to original position if needed
            await nativeBridge.setPluginState(trackId, fxIndex, isInput, savedState);
          }
          const list = isInput
            ? await nativeBridge.getTrackInputFX(trackId)
            : await nativeBridge.getTrackFX(trackId);
          get().updateTrack(trackId, { [countField]: list.length });
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    // ========== Transport Controls ==========
    play: async () => {
      const { transport, syncClipsWithBackend, pixelsPerSecond, timeSelection } = get();

      // If time selection exists and loop is enabled, start from selection and sync loop bounds
      let startTime = transport.currentTime;
      if (timeSelection && transport.loopEnabled) {
        startTime = timeSelection.start;
        set((state) => ({
          transport: {
            ...state.transport,
            currentTime: timeSelection.start,
            loopStart: timeSelection.start,
            loopEnd: timeSelection.end,
          },
        }));
      } else if (transport.loopEnabled && transport.loopEnd > transport.loopStart) {
        // Loop enabled without time selection — if playhead is outside loop region, snap to loopStart
        if (startTime < transport.loopStart || startTime >= transport.loopEnd) {
          startTime = transport.loopStart;
          set((state) => ({
            transport: {
              ...state.transport,
              currentTime: transport.loopStart,
            },
          }));
        }
      }

      // Store the start position for stop behavior
      set({ playStartPosition: startTime });

      // Scroll timeline so playhead is visible (position it ~100px from left edge)
      set({ scrollX: Math.max(0, startTime * pixelsPerSecond - 100) });

      // Sync clips FIRST (slow, many bridge calls) so the position set and
      // play start happen back-to-back with minimal delay between them.
      await syncClipsWithBackend();

      // Position + play as close together as possible to minimize drift
      await nativeBridge.setTransportPosition(startTime);

      set((state) => ({
        transport: {
          ...state.transport,
          isPlaying: true,
          isPaused: false,
          isRecording: false, // Play mode does not record
        },
        recordingClips: [], // No recording clips in play mode
      }));
      await nativeBridge.setTransportPlaying(true);
    },

    record: async () => {
      const { tracks, transport, pixelsPerSecond, timeSelection } = get();
      const armedTracks = tracks
        .map((t) => ({ track: t }))
        .filter(({ track }) => track.armed);

      const wasAlreadyPlaying = transport.isPlaying;

      // If time selection exists and loop is enabled, start from selection
      if (!wasAlreadyPlaying && timeSelection && transport.loopEnabled) {
        set((state) => ({
          transport: {
            ...state.transport,
            currentTime: timeSelection.start,
            loopStart: timeSelection.start,
            loopEnd: timeSelection.end,
          },
        }));
      } else if (!wasAlreadyPlaying && transport.loopEnabled && transport.loopEnd > transport.loopStart) {
        // Loop enabled without time selection — if playhead is outside loop region, snap to loopStart
        if (transport.currentTime < transport.loopStart || transport.currentTime >= transport.loopEnd) {
          set((state) => ({
            transport: {
              ...state.transport,
              currentTime: transport.loopStart,
            },
          }));
        }
      }

      const currentTime = get().transport.currentTime;

      // Store the start position for stop behavior (only if not already playing)
      if (!wasAlreadyPlaying) {
        set({ playStartPosition: currentTime });
        // Scroll timeline so playhead is visible
        set({ scrollX: Math.max(0, currentTime * pixelsPerSecond - 100) });
      }

      // Create recording clips for armed tracks at current position
      const newRecordingClips: RecordingClip[] = armedTracks.map(
        ({ track }) => ({
          trackId: track.id,
          startTime: currentTime,
        }),
      );

      // Only sync clips with backend if we're starting fresh (not already playing)
      if (!wasAlreadyPlaying) {
        // Sync clips FIRST (slow), then position + play back-to-back
        await get().syncClipsWithBackend();
        await nativeBridge.setTransportPosition(transport.currentTime);
      } else {
        console.log(
          "[DAW] Punch-in recording: already playing, preserving playback state",
        );
      }

      set((state) => ({
        transport: {
          ...state.transport,
          isPlaying: true,
          isPaused: false,
          isRecording: armedTracks.length > 0,
        },
        recordingClips: newRecordingClips,
      }));

      // Sync punch range with backend before recording starts
      const punchState = get().transport;
      await nativeBridge.setPunchRange(punchState.punchStart, punchState.punchEnd, punchState.punchEnabled);

      // Start both playback and recording
      if (!wasAlreadyPlaying) {
        await nativeBridge.setTransportPlaying(true);
      }
      await nativeBridge.setTransportRecording(true);
    },

    pause: () => {
      set((state) => ({
        transport: { ...state.transport, isPlaying: false, isPaused: true },
      }));
      nativeBridge.setTransportPlaying(false);
    },

    stop: async () => {
      const { playStartPosition, transport, addClip, playheadStopBehavior } = get();
      const wasRecording = transport.isRecording;
      const wasPlaying = transport.isPlaying || transport.isPaused;
      console.log("[useDAWStore] STOP called. Was recording:", wasRecording);

      // Determine where to place playhead after stop
      // "stop-in-place": keep at current position (first stop press)
      // "return-to-start": go back to where play started (always)
      // Double-stop convention: if already stopped, go to start position
      let stopTime: number;
      if (!wasPlaying) {
        // Already stopped — return to play start position (double-stop)
        stopTime = playStartPosition;
      } else if (playheadStopBehavior === "stop-in-place") {
        stopTime = transport.currentTime;
      } else {
        stopTime = playStartPosition;
      }

      set((state) => ({
        transport: {
          ...state.transport,
          isPlaying: false,
          isPaused: false,
          isRecording: false,
          currentTime: stopTime,
        },
        recordingClips: [], // Clear recording clips
        // Reset scroll to bring playhead into view
        scrollX: Math.max(0, stopTime * state.pixelsPerSecond - 100), // Keep 100px margin
        // Reset all meter levels and automation display values to zero on stop
        masterLevel: 0,
        meterLevels: {},
        peakLevels: {},
        automatedParamValues: {},
      }));
      console.log(
        "[useDAWStore] STOP State updated. Transport stopped, recordingClips cleared.",
      );

      // Clear sync cache so next play does a fresh diff
      resetSyncCache();

      // Stop playback and recording
      await nativeBridge.setTransportPlaying(false);
      await nativeBridge.setTransportRecording(false);
      console.log("[useDAWStore] STOP Native transport stopped.");

      // If we were recording, fetch the new clips and add them to the tracks
      if (wasRecording) {
        const newClips = await nativeBridge.getLastCompletedClips();
        const currentTracks = get().tracks;
        const currentRecordMode = get().recordMode;
        console.log(
          "[useDAWStore] Received recorded clips:",
          JSON.stringify(newClips, null, 2),
          "mode:", currentRecordMode,
        );

        // Group clips by trackId for loop recording take handling
        const clipsByTrack = new Map<string, typeof newClips>();
        for (const clipInfo of newClips) {
          if (clipInfo.duration <= 0) continue;
          const existing = clipsByTrack.get(clipInfo.trackId) || [];
          existing.push(clipInfo);
          clipsByTrack.set(clipInfo.trackId, existing);
        }

        for (const [trackId, trackClips] of clipsByTrack) {
          const track = currentTracks.find((t) => t.id === trackId);
          const clipColor = track?.color || "#4361ee";

          // Create AudioClip objects for each recorded clip
          const recordedClips: AudioClip[] = trackClips.map((clipInfo, idx) => ({
            id: crypto.randomUUID(),
            name: trackClips.length > 1 ? `Take ${idx + 1}` : "Recording",
            filePath: clipInfo.filePath,
            startTime: clipInfo.startTime,
            duration: clipInfo.duration,
            offset: 0,
            color: clipColor,
            volumeDB: 0,
            fadeIn: 0,
            fadeOut: 0,
            sampleRate: get().audioDeviceSetup?.sampleRate || 44100,
          }));

          if (currentRecordMode === "replace" && recordedClips.length > 0) {
            const recStart = recordedClips[0].startTime;
            const recEnd = recStart + recordedClips[0].duration;
            set((s) => ({
              tracks: s.tracks.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      clips: t.clips.filter((c) => {
                        const clipEnd = c.startTime + c.duration;
                        return clipEnd <= recStart || c.startTime >= recEnd;
                      }),
                    }
                  : t,
              ),
            }));
          }

          if (recordedClips.length > 1) {
            // Loop recording: first clip is the main clip, rest are takes
            const mainClip = recordedClips[0];
            mainClip.takes = recordedClips.slice(1);
            mainClip.activeTakeIndex = recordedClips.length - 1; // Last take is active
            addClip(trackId, mainClip);
          } else if (recordedClips.length === 1) {
            addClip(trackId, recordedClips[0]);
          }

          // Register clips with backend
          for (const newClip of recordedClips) {
            console.log("[useDAWStore] Recording clip:", trackId,
              "startTime:", newClip.startTime.toFixed(3),
              "duration:", newClip.duration.toFixed(3),
              "file:", newClip.filePath);
          }

          // Register the active clip with the playback backend
          const activeClip = recordedClips.length > 1
            ? recordedClips[recordedClips.length - 1]
            : recordedClips[0];
          if (activeClip) {
            nativeBridge.addPlaybackClip(
              trackId,
              activeClip.filePath,
              activeClip.startTime,
              activeClip.duration,
              0,
              activeClip.volumeDB || 0,
              activeClip.fadeIn || 0,
              activeClip.fadeOut || 0,
              activeClip.id,
            ).catch((e) => console.warn("[useDAWStore] addPlaybackClip after record failed:", e));
          }
        }

        // Also fetch completed MIDI clips
        const newMIDIClips = await nativeBridge.getLastCompletedMIDIClips();
        console.log("[useDAWStore] Received MIDI clips:", newMIDIClips.length);

        for (const midiClipInfo of newMIDIClips) {
          if (midiClipInfo.events.length === 0) {
            console.warn("[useDAWStore] Skipping empty MIDI clip for track", midiClipInfo.trackId);
            continue;
          }

          const track = get().tracks.find((t) => t.id === midiClipInfo.trackId);
          const clipColor = track?.color || "#4361ee";

          // Convert backend events to frontend MIDIEvent format
          const events: MIDIEvent[] = midiClipInfo.events.map((e) => ({
            timestamp: e.timestamp,
            type: e.type as MIDIEvent["type"],
            note: e.note,
            velocity: e.velocity,
            controller: e.controller,
            value: e.value,
          }));

          const newMIDIClip: MIDIClip = {
            id: crypto.randomUUID(),
            name: "MIDI Recording",
            startTime: midiClipInfo.startTime,
            duration: midiClipInfo.duration,
            events,
            color: clipColor,
          };

          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === midiClipInfo.trackId
                ? { ...t, midiClips: [...t.midiClips, newMIDIClip] }
                : t,
            ),
            isModified: true,
          }));

          console.log("[useDAWStore] Added MIDI clip to track", midiClipInfo.trackId,
            "with", events.length, "events, duration:", midiClipInfo.duration.toFixed(3));
        }
      }

      // Reset backend position to match frontend stop position
      const finalStopTime = get().transport.currentTime;
      await nativeBridge.setTransportPosition(finalStopTime);
    },

    togglePlayPause: async () => {
      const { transport } = get();
      if (transport.isPlaying) {
        get().pause();
      } else {
        await get().play();
      }
    },

    setCurrentTime: (time) => {
      set((state) => ({
        transport: { ...state.transport, currentTime: time },
      }));
    },

    seekTo: async (time) => {
      const { transport } = get();
      const wasPlaying = transport.isPlaying && !transport.isPaused;
      const wasRecording = transport.isRecording;

      // If playing, pause first
      if (wasPlaying) {
        await nativeBridge.setTransportPlaying(false);
        if (wasRecording) {
          await nativeBridge.setTransportRecording(false);
        }
      }

      // Update position in store
      set((state) => ({
        transport: { ...state.transport, currentTime: time },
      }));

      // Sync position with backend
      await nativeBridge.setTransportPosition(time);

      // If was playing, resume playback from new position
      if (wasPlaying) {
        await nativeBridge.setTransportPlaying(true);
        if (wasRecording) {
          await nativeBridge.setTransportRecording(true);
        }
      }
    },

    setTempo: async (tempo) => {
      const oldTempo = get().transport.tempo;
      if (oldTempo === tempo) return;

      const command: Command = {
        type: "SET_TEMPO",
        description: `Set tempo to ${tempo} BPM`,
        timestamp: Date.now(),
        execute: async () => {
          set((s) => ({ transport: { ...s.transport, tempo } }));
          await nativeBridge.setTempo(tempo);
          if (get().metronomeTrackId) await get().generateMetronomeTrack();
        },
        undo: async () => {
          set((s) => ({ transport: { ...s.transport, tempo: oldTempo } }));
          await nativeBridge.setTempo(oldTempo);
          if (get().metronomeTrackId) await get().generateMetronomeTrack();
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleLoop: () => {
      const { projectRange, transport } = get();
      const enabling = !transport.loopEnabled;
      set((state) => ({
        transport: {
          ...state.transport,
          loopEnabled: enabling,
          // When enabling loop, sync to the project range
          ...(enabling && projectRange.end > projectRange.start
            ? { loopStart: projectRange.start, loopEnd: projectRange.end }
            : {}),
        },
      }));
    },

    setLoopRegion: (start, end) => {
      set((state) => ({
        transport: { ...state.transport, loopStart: start, loopEnd: end },
      }));
    },

    togglePunch: () => {
      const { transport, timeSelection } = get();
      const enabling = !transport.punchEnabled;
      set((state) => ({
        transport: {
          ...state.transport,
          punchEnabled: enabling,
          // When enabling punch, sync to time selection if it exists
          ...(enabling && timeSelection
            ? { punchStart: timeSelection.start, punchEnd: timeSelection.end }
            : {}),
        },
      }));
      // Sync with backend
      const t = get().transport;
      nativeBridge.setPunchRange(t.punchStart, t.punchEnd, t.punchEnabled).catch(() => {});
    },

    setPunchRange: (start, end) => {
      set((state) => ({
        transport: { ...state.transport, punchStart: start, punchEnd: end },
      }));
      const t = get().transport;
      nativeBridge.setPunchRange(start, end, t.punchEnabled).catch(() => {});
    },

    setTrackRecordSafe: (trackId, safe) => {
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId ? { ...t, recordSafe: safe, armed: safe ? false : t.armed } : t,
        ),
      }));
      nativeBridge.setTrackRecordSafe(trackId, safe).catch(() => {});
    },

    setTimeSelection: (start, end) => {
      set({ timeSelection: { start, end } });
    },

    clearTimeSelection: () => {
      set({ timeSelection: null });
    },

    setLoopToSelection: () => {
      const { timeSelection } = get();
      if (timeSelection) {
        set((state) => ({
          transport: {
            ...state.transport,
            loopEnabled: true,
            loopStart: timeSelection.start,
            loopEnd: timeSelection.end,
          },
        }));
      }
    },

    toggleMetronome: async () => {
      const current = get().metronomeEnabled;
      set({ metronomeEnabled: !current });
      await nativeBridge.setMetronomeEnabled(!current);
      // If enabling, sync current volume to backend
      if (!current) {
        await nativeBridge.setMetronomeVolume(get().metronomeVolume);
      }
    },

    setMetronomeVolume: async (volume) => {
      set({ metronomeVolume: volume });
      await nativeBridge.setMetronomeVolume(volume);
    },

    setMetronomeAccentBeats: async (accentBeats) => {
      set({ metronomeAccentBeats: accentBeats });
      await nativeBridge.setMetronomeAccentBeats(accentBeats);
      // Regenerate metronome track if it exists
      if (get().metronomeTrackId) {
        await get().generateMetronomeTrack();
      }
    },

    setTimeSignature: async (numerator, denominator) => {
      const oldTimeSig = { ...get().timeSignature };
      const oldAccents = [...get().metronomeAccentBeats];

      // Compute new accents
      const newAccents = Array(numerator).fill(false);
      newAccents[0] = true;
      for (let i = 1; i < Math.min(oldAccents.length, numerator); i++) {
        newAccents[i] = oldAccents[i];
      }

      const command: Command = {
        type: "SET_TIME_SIGNATURE",
        description: `Set time signature to ${numerator}/${denominator}`,
        timestamp: Date.now(),
        execute: async () => {
          set({ timeSignature: { numerator, denominator }, metronomeAccentBeats: newAccents });
          await nativeBridge.setTimeSignature(numerator, denominator);
          await nativeBridge.setMetronomeAccentBeats(newAccents);
          if (get().metronomeTrackId) await get().generateMetronomeTrack();
        },
        undo: async () => {
          set({ timeSignature: oldTimeSig, metronomeAccentBeats: oldAccents });
          await nativeBridge.setTimeSignature(oldTimeSig.numerator, oldTimeSig.denominator);
          await nativeBridge.setMetronomeAccentBeats(oldAccents);
          if (get().metronomeTrackId) await get().generateMetronomeTrack();
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    generateMetronomeTrack: async () => {
      const state = get();

      // Remove existing metronome track if any
      if (state.metronomeTrackId) {
        await get().removeMetronomeTrack();
      }

      const { projectRange } = get();

      // Call backend to render metronome to WAV file
      const filePath = await nativeBridge.renderMetronomeToFile(
        projectRange.start,
        projectRange.end,
      );

      if (!filePath) {
        console.error("[DAW] Failed to render metronome to file");
        return;
      }

      // Create a new track for the metronome
      const trackId = await nativeBridge.addTrack();
      if (!trackId) {
        console.error("[DAW] Failed to create metronome track");
        return;
      }

      // Add track to frontend state
      get().addTrack({
        id: trackId,
        name: "Metronome",
        color: "#f59e0b",
      });

      // Create the clip
      const duration = projectRange.end - projectRange.start;
      const clipId = crypto.randomUUID();
      const clip: AudioClip = {
        id: clipId,
        filePath: filePath,
        name: "Metronome",
        startTime: projectRange.start,
        duration: duration,
        offset: 0,
        color: "#f59e0b",
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
      };

      get().addClip(trackId, clip);

      // Register clip with backend for playback
      await nativeBridge.addPlaybackClip(
        trackId,
        filePath,
        projectRange.start,
        duration,
        0, 0, 0, 0,
        clip.id,
      );

      set({ metronomeTrackId: trackId, isModified: true });
    },

    removeMetronomeTrack: async () => {
      const { metronomeTrackId } = get();
      if (!metronomeTrackId) return;

      await get().removeTrack(metronomeTrackId);
      set({ metronomeTrackId: null });
    },

    setProjectRange: (start, end) => {
      const newStart = Math.max(0, start);
      const newEnd = Math.max(start, end);
      set({
        projectRange: { start: newStart, end: newEnd },
        isModified: true,
      });
      // Sync loop region when loop is active and range is valid
      if (get().transport.loopEnabled && newEnd > newStart) {
        set((state) => ({
          transport: {
            ...state.transport,
            loopStart: newStart,
            loopEnd: newEnd,
          },
        }));
      }
      // Regenerate metronome track if it exists
      if (get().metronomeTrackId) {
        get().generateMetronomeTrack();
      }
    },

    tapTempo: () => {
      const now = performance.now();
      const { tapTimestamps } = get();

      // Add new timestamp
      const newTimestamps = [...tapTimestamps, now];

      // Keep only last 8 taps
      const MAX_TAPS = 8;
      if (newTimestamps.length > MAX_TAPS) {
        newTimestamps.shift();
      }

      // Calculate BPM if we have at least 2 taps
      if (newTimestamps.length >= 2) {
        // Calculate intervals between taps
        const intervals: number[] = [];
        for (let i = 1; i < newTimestamps.length; i++) {
          intervals.push(newTimestamps[i] - newTimestamps[i - 1]);
        }

        // Calculate average interval in milliseconds
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

        // Convert to BPM (60000 ms per minute)
        const bpm = Math.round(60000 / avgInterval);

        // Clamp BPM to reasonable range (40-240)
        const clampedBpm = Math.max(40, Math.min(240, bpm));

        // Update tempo
        set({ tapTimestamps: newTimestamps });
        get().setTempo(clampedBpm);
      } else {
        // Just store the timestamp
        set({ tapTimestamps: newTimestamps });
      }

      // Reset tap timestamps after 2 seconds of inactivity
      setTimeout(() => {
        const { tapTimestamps: currentTaps } = get();
        if (currentTaps.length > 0 && performance.now() - currentTaps[currentTaps.length - 1] > 2000) {
          set({ tapTimestamps: [] });
        }
      }, 2000);
    },

    // ========== Master Controls ==========
    setMasterVolume: async (volume) => {
      set({ masterVolume: volume });
      await nativeBridge.setMasterVolume(volume);
    },

    setMasterPan: async (pan: number) => {
      set({ masterPan: pan });
      await nativeBridge.setMasterPan(pan);
    },

    toggleMasterMute: () => {
      const current = get().isMasterMuted;
      set({ isMasterMuted: !current });
      // When muted, send 0 to backend; when unmuted, restore volume
      nativeBridge.setMasterVolume(!current ? 0 : get().masterVolume);
    },
    toggleMasterMono: () => {
      const next = !get().masterMono;
      set({ masterMono: next });
      nativeBridge.setMasterMono(next).catch(() => {});
    },
    toggleMasterAutomation: () => set((s) => ({ showMasterAutomation: !s.showMasterAutomation })),
    addMasterAutomationLane: (param) => {
      const existing = get().masterAutomationLanes.find((l) => l.param === param);
      if (existing) {
        set((s) => ({
          showMasterAutomation: true,
          masterAutomationLanes: s.masterAutomationLanes.map((l) =>
            l.param === param ? { ...l, visible: true } : l,
          ),
        }));
        return existing.id;
      }
      const newId = `master-${param}`;
      set((s) => ({
        showMasterAutomation: true,
        masterAutomationLanes: [
          ...s.masterAutomationLanes,
          { id: newId, param, points: [], visible: true, mode: "read" as AutomationModeType, armed: false },
        ],
      }));
      return newId;
    },
    toggleMasterAutomationLaneVisibility: (laneId) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.id === laneId ? { ...l, visible: !l.visible } : l,
        ),
      }));
    },
    setMasterAutomationLaneMode: (laneId, mode) => {
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) {
        nativeBridge.setAutomationMode("master", lane.param, mode).catch(() => {});
      }
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.id === laneId ? { ...l, mode } : l,
        ),
      }));
    },
    armMasterAutomationLane: (laneId, armed) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.id === laneId ? { ...l, armed } : l,
        ),
      }));
    },
    setMasterTrackAutomationMode: (mode) => {
      const lanes = get().masterAutomationLanes;
      for (const lane of lanes) {
        nativeBridge.setAutomationMode("master", lane.param, mode).catch(() => {});
      }
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) => ({ ...l, mode })),
      }));
    },
    showAllActiveMasterEnvelopes: () => {
      set((s) => ({
        showMasterAutomation: true,
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.points.length > 0 ? { ...l, visible: true } : l,
        ),
      }));
    },
    hideAllMasterEnvelopes: () => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) => ({ ...l, visible: false })),
      }));
    },
    armAllVisibleMasterAutomationLanes: () => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) =>
          l.visible ? { ...l, armed: true } : l,
        ),
      }));
    },
    disarmAllMasterAutomationLanes: () => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((l) => ({ ...l, armed: false })),
      }));
    },
    addMasterAutomationPoint: (laneId, time, value) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((lane) => {
          if (lane.id !== laneId) return lane;
          const newPoints = [...lane.points, { time, value: Math.max(0, Math.min(1, value)) }];
          newPoints.sort((a, b) => a.time - b.time);
          return { ...lane, points: newPoints };
        }),
        isModified: true,
      }));
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend("master", lane);
    },
    removeMasterAutomationPoint: (laneId, pointIndex) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((lane) => {
          if (lane.id !== laneId) return lane;
          return { ...lane, points: lane.points.filter((_, i) => i !== pointIndex) };
        }),
        isModified: true,
      }));
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend("master", lane);
    },
    moveMasterAutomationPoint: (laneId, pointIndex, time, value) => {
      set((s) => ({
        masterAutomationLanes: s.masterAutomationLanes.map((lane) => {
          if (lane.id !== laneId) return lane;
          const newPoints = lane.points.map((p, i) =>
            i === pointIndex ? { time: Math.max(0, time), value: Math.max(0, Math.min(1, value)) } : p,
          );
          newPoints.sort((a, b) => a.time - b.time);
          return { ...lane, points: newPoints };
        }),
        isModified: true,
      }));
      const lane = get().masterAutomationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend("master", lane);
    },

    // ========== Metering ==========
    // Both actions write ONLY to meterLevels/peakLevels — never to `tracks`.
    // This keeps the tracks array reference stable during the 10Hz meter timer,
    // so App.tsx and Timeline never re-render from meter activity alone.
    setTrackMeterLevel: (trackId, level) => {
      set((state) => ({
        meterLevels: { ...state.meterLevels, [trackId]: level },
        peakLevels: {
          ...state.peakLevels,
          [trackId]: Math.max(state.peakLevels[trackId] ?? 0, level),
        },
      }));
    },

    batchUpdateMeterLevels: (levels, masterLevel) => {
      set((state) => {
        let anyChanged = false;
        let newMeter = state.meterLevels;
        let newPeak  = state.peakLevels;

        for (const track of state.tracks) {
          const level = levels[track.id];
          if (level === undefined || level === newMeter[track.id]) continue;
          if (!anyChanged) {
            // Lazy-clone on first change
            newMeter = { ...state.meterLevels };
            newPeak  = { ...state.peakLevels };
            anyChanged = true;
          }
          newMeter[track.id] = level;
          newPeak[track.id]  = Math.max(newPeak[track.id] ?? 0, level);
        }

        // Also update master level in meterLevels map so ChannelStrip can read it
        if (masterLevel !== state.meterLevels["master"]) {
          if (!anyChanged) {
            newMeter = { ...state.meterLevels };
            newPeak  = { ...state.peakLevels };
            anyChanged = true;
          }
          newMeter["master"] = masterLevel;
          newPeak["master"]  = Math.max(newPeak["master"] ?? 0, masterLevel);
        }

        if (!anyChanged && masterLevel === state.masterLevel) return state;
        if (!anyChanged) return { masterLevel };
        return { meterLevels: newMeter, peakLevels: newPeak, masterLevel };
      });
    },

    setMasterLevel: (level) => set({ masterLevel: level }),

    updateAutomatedValues: () => {
      const state = get();
      const time = state.transport.currentTime;
      const prev = state.automatedParamValues;
      const next: Record<string, Record<string, number>> = {};
      let changed = false;

      for (const track of state.tracks) {
        for (const lane of track.automationLanes) {
          if (lane.mode === "off" || lane.points.length === 0) continue;
          // Store normalized 0-1 values — consumers convert to display units as needed
          const normalized = interpolateAtTime(lane.points, time);
          const rounded = Math.round(normalized * 10000) / 10000;
          if (prev[track.id]?.[lane.param] !== rounded) changed = true;
          if (!next[track.id]) next[track.id] = {};
          next[track.id][lane.param] = rounded;
        }
      }

      if (changed) set({ automatedParamValues: next });
    },

    // ========== Timeline View ==========
    setZoom: (pixelsPerSecond) => {
      set({ pixelsPerSecond: Math.max(1, Math.min(1000, pixelsPerSecond)) });
    },

    setScroll: (x, y) => set({ scrollX: x, scrollY: y }),
    setTrackHeight: (height) => {
      const minH = getMinTrackHeight(get().tcpWidth);
      set({ trackHeight: Math.max(minH, Math.min(500, height)) });
    },
    setTcpWidth: (width) => {
      const clamped = Math.max(150, Math.min(600, width));
      const minH = getMinTrackHeight(clamped);
      const curHeight = get().trackHeight;
      // Auto-raise track height if shrinking TCP would clip content
      set({ tcpWidth: clamped, trackHeight: Math.max(minH, curHeight) });
    },

    toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
    setGridSize: (size) => set({ gridSize: size }),

    // ========== Tool Mode ==========
    setToolMode: (mode) => set({ toolMode: mode }),
    toggleSplitTool: () => set((state) => ({ toolMode: state.toolMode === "split" ? "select" : "split" })),
    toggleMuteTool: () => set((state) => ({ toolMode: state.toolMode === "mute" ? "select" : "mute" })),

    // ========== Clips ==========
    addClip: (trackId, clip) => {
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: [...t.clips, clip] } : t,
        ),
      }));
    },

    removeClip: (trackId, clipId) => {
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId
            ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
            : t,
        ),
      }));
    },

    syncClipsWithBackend: async () => {
      const syncStart = performance.now();
      const { tracks } = get();

      // Build current clip set with keys
      const currentClips = new Map<string, { trackId: string; filePath: string; startTime: number; duration: number; offset: number; volumeDB: number; fadeIn: number; fadeOut: number; clipId: string }>();
      for (const track of tracks) {
        for (const clip of track.clips) {
          if (clip.filePath && !clip.muted) {
            const offset = clip.offset || 0;
            const volumeDB = clip.volumeDB || 0;
            const fadeIn = clip.fadeIn || 0;
            const fadeOut = clip.fadeOut || 0;
            const key = makeClipKey(track.id, clip.filePath, clip.startTime, clip.duration, offset, volumeDB, fadeIn, fadeOut);
            currentClips.set(key, { trackId: track.id, filePath: clip.filePath, startTime: clip.startTime, duration: clip.duration, offset, volumeDB, fadeIn, fadeOut, clipId: clip.id });
          }
        }
      }

      const currentKeys = new Set(currentClips.keys());

      // Diff: find clips to remove (in old set but not in new)
      const toRemove: string[] = [];
      for (const key of _lastSyncedClipKeys) {
        if (!currentKeys.has(key)) toRemove.push(key);
      }

      // Diff: find clips to add (in new set but not in old)
      const toAdd: string[] = [];
      for (const key of currentKeys) {
        if (!_lastSyncedClipKeys.has(key)) toAdd.push(key);
      }

      // If more than 60% changed, just do a full clear+rebuild (cheaper than many removes)
      const t1 = performance.now();
      const totalOld = _lastSyncedClipKeys.size;
      if (totalOld === 0 || toRemove.length > totalOld * 0.6) {
        // Full rebuild — clear first, then batch-add all clips in parallel
        await nativeBridge.clearPlaybackClips();
        const allClips = Array.from(currentClips.values());
        if (allClips.length > 0) {
          await nativeBridge.addPlaybackClipsBatch(allClips);
        }
      } else {
        // Incremental: batch remove old in parallel, then batch add new in parallel
        if (toRemove.length > 0) {
          await Promise.all(
            toRemove.map((key) => {
              const parts = key.split("|");
              return nativeBridge.removePlaybackClip(parts[0], parts[1]);
            }),
          );
        }
        if (toAdd.length > 0) {
          const clipsToAdd = toAdd.map((key) => currentClips.get(key)!);
          await nativeBridge.addPlaybackClipsBatch(clipsToAdd);
        }
      }
      const t2 = performance.now();

      // Update cache
      _lastSyncedClipKeys = currentKeys;

      // Collect all fire-and-forget sync promises to run in parallel
      const syncPromises: Promise<any>[] = [];

      // Sync gain envelopes to backend for all clips that have them
      for (const track of tracks) {
        for (const clip of track.clips) {
          if (clip.gainEnvelope && clip.gainEnvelope.length > 0) {
            syncPromises.push(nativeBridge.setClipGainEnvelope(track.id, clip.id, clip.gainEnvelope).catch(() => {}));
          }
        }
      }

      // Sync automation lanes to backend (all lanes, even empty ones, to sync modes)
      for (const track of tracks) {
        for (const lane of track.automationLanes) {
          const parameterId = lane.param;
          const converted = lane.points.map((p) => ({
            time: p.time,
            value: automationToBackend(lane.param, p.value),
          }));
          syncPromises.push(nativeBridge.setAutomationPoints(track.id, parameterId, converted).catch(() => {}));
          if (lane.mode) {
            syncPromises.push(nativeBridge.setAutomationMode(track.id, parameterId, lane.mode).catch(() => {}));
          }
        }
      }
      // Sync master automation lanes
      for (const lane of get().masterAutomationLanes) {
        const parameterId = lane.param;
        const converted = lane.points.map((p) => ({
          time: p.time,
          value: automationToBackend(lane.param, p.value),
        }));
        syncPromises.push(nativeBridge.setAutomationPoints("master", parameterId, converted).catch(() => {}));
        if (lane.mode) {
          syncPromises.push(nativeBridge.setAutomationMode("master", parameterId, lane.mode).catch(() => {}));
        }
      }
      // Also sync tempo markers to backend
      syncTempoMarkersToBackend(get().tempoMarkers);

      // Wait for all auxiliary syncs in parallel (not sequentially)
      await Promise.all(syncPromises);
      const t3 = performance.now();

      console.log(`[DAW] syncClipsWithBackend: clips=${(t2 - t1).toFixed(0)}ms, aux=${(t3 - t2).toFixed(0)}ms, total=${(t3 - syncStart).toFixed(0)}ms (added: ${toAdd.length}, removed: ${toRemove.length}, auxCalls: ${syncPromises.length})`);
    },

    importMedia: async (filePath, trackId, startTime) => {
      try {
        // Call backend to import media file (handles video extraction if needed)
        const mediaInfo = await nativeBridge.importMediaFile(filePath);

        if (!mediaInfo || !mediaInfo.filePath || !mediaInfo.duration) {
          throw new Error("Unsupported file format or failed to read: " + filePath);
        }

        // Create a new clip from the imported media
        const track = get().tracks.find((t) => t.id === trackId);
        const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") || "Clip";
        const newClip: AudioClip = {
          id: crypto.randomUUID(),
          filePath: mediaInfo.filePath,
          name: fileName,
          startTime: startTime,
          duration: mediaInfo.duration,
          offset: 0,
          color: track?.color || "#4cc9f0",
          volumeDB: 0,
          fadeIn: 0,
          fadeOut: 0,
          sampleRate: mediaInfo.sampleRate,
          sourceLength: mediaInfo.duration,
        };

        // Add clip to track
        get().addClip(trackId, newClip);

        // Register clip with backend for playback
        await nativeBridge.addPlaybackClip(
          trackId,
          newClip.filePath,
          newClip.startTime,
          newClip.duration,
          newClip.offset || 0,
          newClip.volumeDB || 0,
          newClip.fadeIn || 0,
          newClip.fadeOut || 0,
          newClip.id,
        );

        console.log(
          `[DAWStore] Imported media: ${filePath} → track ${trackId} at ${startTime}s`,
        );
      } catch (error) {
        console.error(`[DAWStore] Failed to import media:`, error);
        throw error;
      }
    },

    // ========== Clip Editing ==========
    splitClipAtPlayhead: () => {
      const state = get();
      const playhead = state.transport.currentTime;

      // Collect clips to split: selected clips, or all clips under playhead if none selected
      const clipsToSplit: Array<{ clip: AudioClip; trackId: string }> = [];

      if (state.selectedClipIds.length > 0) {
        // Split selected clips
        for (const track of state.tracks) {
          for (const clip of track.clips) {
            if (state.selectedClipIds.includes(clip.id)) {
              const clipEnd = clip.startTime + clip.duration;
              if (playhead > clip.startTime && playhead < clipEnd) {
                clipsToSplit.push({ clip, trackId: track.id });
              }
            }
          }
        }
      } else {
        // No clips selected — split all clips under playhead
        for (const track of state.tracks) {
          for (const clip of track.clips) {
            const clipEnd = clip.startTime + clip.duration;
            if (playhead > clip.startTime && playhead < clipEnd) {
              clipsToSplit.push({ clip, trackId: track.id });
            }
          }
        }
      }

      if (clipsToSplit.length === 0) return;

      // Build left/right clips for each split
      const splitData = clipsToSplit.map(({ clip, trackId }) => {
        const leftId = crypto.randomUUID();
        const rightId = crypto.randomUUID();
        const leftDuration = playhead - clip.startTime;
        const rightDuration = clip.duration - leftDuration;

        const leftClip: AudioClip = {
          ...clip,
          id: leftId,
          duration: leftDuration,
          fadeOut: 0, // Remove fade out from left clip (split point)
        };

        const rightClip: AudioClip = {
          ...clip,
          id: rightId,
          startTime: playhead,
          duration: rightDuration,
          offset: clip.offset + leftDuration,
          fadeIn: 0, // Remove fade in from right clip (split point)
        };

        return { originalClip: clip, trackId, leftClip, rightClip };
      });

      const command: Command = {
        type: "SPLIT_CLIP",
        description: `Split ${splitData.length} clip${splitData.length > 1 ? "s" : ""} at cursor`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => {
              const splitsForTrack = splitData.filter((sd) => sd.trackId === track.id);
              if (splitsForTrack.length === 0) return track;

              const originalIds = new Set(splitsForTrack.map((sd) => sd.originalClip.id));
              const newClips = track.clips.filter((c) => !originalIds.has(c.id));
              for (const sd of splitsForTrack) {
                newClips.push(sd.leftClip, sd.rightClip);
              }
              return { ...track, clips: newClips };
            }),
            // Select the right-side clips after split
            selectedClipIds: splitData.map((sd) => sd.rightClip.id),
            selectedClipId: splitData.length > 0 ? splitData[0].rightClip.id : null,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => {
              const splitsForTrack = splitData.filter((sd) => sd.trackId === track.id);
              if (splitsForTrack.length === 0) return track;

              const splitIds = new Set(
                splitsForTrack.flatMap((sd) => [sd.leftClip.id, sd.rightClip.id])
              );
              const newClips = track.clips.filter((c) => !splitIds.has(c.id));
              for (const sd of splitsForTrack) {
                newClips.push(sd.originalClip);
              }
              return { ...track, clips: newClips };
            }),
            selectedClipIds: clipsToSplit.map((c) => c.clip.id),
            selectedClipId: clipsToSplit.length > 0 ? clipsToSplit[0].clip.id : null,
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
        isModified: true,
      });
    },

    splitClipAtPosition: (clipId, splitTime) => {
      const state = get();

      // Find the clip and its track
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          foundClip = clip;
          foundTrackId = track.id;
          break;
        }
      }
      if (!foundClip || !foundTrackId) return;

      const clip = foundClip;
      const trackId = foundTrackId;
      const clipEnd = clip.startTime + clip.duration;

      // Split must be strictly inside the clip
      if (splitTime <= clip.startTime || splitTime >= clipEnd) return;

      const leftId = crypto.randomUUID();
      const rightId = crypto.randomUUID();
      const leftDuration = splitTime - clip.startTime;
      const rightDuration = clip.duration - leftDuration;

      const leftClip: AudioClip = {
        ...clip,
        id: leftId,
        duration: leftDuration,
        fadeOut: 0,
      };

      const rightClip: AudioClip = {
        ...clip,
        id: rightId,
        startTime: splitTime,
        duration: rightDuration,
        offset: clip.offset + leftDuration,
        fadeIn: 0,
      };

      const command: Command = {
        type: "SPLIT_CLIP",
        description: "Split clip at position",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => {
              if (track.id !== trackId) return track;
              return {
                ...track,
                clips: [
                  ...track.clips.filter((c) => c.id !== clip.id),
                  leftClip,
                  rightClip,
                ],
              };
            }),
            selectedClipIds: [rightClip.id],
            selectedClipId: rightClip.id,
            isModified: true,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => {
              if (track.id !== trackId) return track;
              return {
                ...track,
                clips: [
                  ...track.clips.filter((c) => c.id !== leftId && c.id !== rightId),
                  clip,
                ],
              };
            }),
            selectedClipIds: [clip.id],
            selectedClipId: clip.id,
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
        isModified: true,
      });
    },

    splitMIDIClipAtPosition: (clipId, splitTime) => {
      const state = get();
      let foundClip: MIDIClip | null = null;
      let foundTrackId: string | null = null;
      for (const track of state.tracks) {
        const clip = track.midiClips.find((c) => c.id === clipId);
        if (clip) { foundClip = clip; foundTrackId = track.id; break; }
      }
      if (!foundClip || !foundTrackId) return;
      const clip = foundClip;
      const trackId = foundTrackId;
      const clipEnd = clip.startTime + clip.duration;
      if (splitTime <= clip.startTime || splitTime >= clipEnd) return;

      const splitOffset = splitTime - clip.startTime; // seconds into clip
      const leftId = crypto.randomUUID();
      const rightId = crypto.randomUUID();

      const leftClip: MIDIClip = {
        ...clip,
        id: leftId,
        duration: splitOffset,
        events: clip.events.filter((e) => e.timestamp < splitOffset),
        ccEvents: clip.ccEvents?.filter((e) => e.timestamp < splitOffset),
      };
      const rightClip: MIDIClip = {
        ...clip,
        id: rightId,
        startTime: splitTime,
        duration: clip.duration - splitOffset,
        // Shift event timestamps relative to new clip start
        events: clip.events
          .filter((e) => e.timestamp >= splitOffset)
          .map((e) => ({ ...e, timestamp: e.timestamp - splitOffset })),
        ccEvents: clip.ccEvents
          ?.filter((e) => e.timestamp >= splitOffset)
          .map((e) => ({ ...e, timestamp: e.timestamp - splitOffset })),
      };

      const newTracks = state.tracks.map((track) => {
        if (track.id !== trackId) return track;
        return {
          ...track,
          midiClips: [
            ...track.midiClips.filter((c) => c.id !== clip.id),
            leftClip,
            rightClip,
          ],
        };
      });

      commandManager.push({
        type: "SPLIT_MIDI_CLIP",
        description: "Split MIDI clip",
        timestamp: Date.now(),
        execute: () => {
          set({ tracks: newTracks, selectedClipIds: [rightId], selectedClipId: rightId, isModified: true });
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              if (t.id !== trackId) return t;
              return {
                ...t,
                midiClips: [...t.midiClips.filter((c) => c.id !== leftId && c.id !== rightId), clip],
              };
            }),
            selectedClipIds: [clip.id],
            selectedClipId: clip.id,
            isModified: true,
          }));
        },
      });
      set({ tracks: newTracks, selectedClipIds: [rightId], selectedClipId: rightId,
        canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo(), isModified: true });
    },

    selectClip: (clipId, modifiers) => {
      // Clear track selection when selecting a clip to avoid delete conflicts
      if (clipId === null) {
        set({ selectedClipId: null, selectedClipIds: [] });
        return;
      }

      const { ctrl } = modifiers || {};
      const state = get();

      if (ctrl) {
        // Toggle: add or remove from multi-selection
        const isSelected = state.selectedClipIds.includes(clipId);
        if (isSelected) {
          const newIds = state.selectedClipIds.filter((id) => id !== clipId);
          set({
            selectedClipIds: newIds,
            selectedClipId: newIds.length > 0 ? newIds[newIds.length - 1] : null,
          });
        } else {
          set({
            selectedClipIds: [...state.selectedClipIds, clipId],
            selectedClipId: clipId,
            selectedTrackIds: [],
            lastSelectedTrackId: null,
          });
        }
      } else {
        // Single selection — also select grouped clips
        const clickedClip = state.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
        let ids = [clipId];
        if (clickedClip?.groupId) {
          ids = state.tracks
            .flatMap((t) => t.clips)
            .filter((c) => c.groupId === clickedClip.groupId)
            .map((c) => c.id);
        }
        set({
          selectedClipId: clipId,
          selectedClipIds: ids,
          selectedTrackIds: [],
          lastSelectedTrackId: null,
        });
      }
    },

    selectAllClips: () => {
      const state = get();
      const allClipIds = state.tracks.flatMap((t) => t.clips.map((c) => c.id));
      set({
        selectedClipIds: allClipIds,
        selectedClipId: allClipIds.length > 0 ? allClipIds[0] : null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    setSelectedClipIds: (clipIds: string[]) => {
      set({
        selectedClipIds: clipIds,
        selectedClipId: clipIds.length > 0 ? clipIds[clipIds.length - 1] : null,
      });
    },

    moveClipToTrack: async (clipId, newTrackId, newStartTime) => {
      const state = get();

      // Find the clip and its current track
      let clipToMove: AudioClip | null = null;
      let sourceTrackId: string | null = null;

      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          clipToMove = clip;
          sourceTrackId = track.id;
        }
      });

      if (!clipToMove || !sourceTrackId) return;

      // Get target track color for color inheritance
      const targetTrack = state.tracks.find((t) => t.id === newTrackId);
      const targetColor = targetTrack?.color;

      // Update frontend state only - backend sync happens via syncClipsWithBackend()
      // at drag end or when play() is called. This avoids race conditions from
      // rapid async remove/add calls during drag moves.
      if (sourceTrackId === newTrackId) {
        // Moving within the same track - just update startTime
        set((state) => ({
          tracks: state.tracks.map((track) => {
            if (track.id === sourceTrackId) {
              return {
                ...track,
                clips: track.clips.map((c) =>
                  c.id === clipId ? { ...c, startTime: newStartTime } : c,
                ),
              };
            }
            return track;
          }),
        }));
      } else {
        // Moving to a different track - inherit target track's color
        const updatedClip = {
          ...(clipToMove as AudioClip),
          startTime: newStartTime,
          color: targetColor || (clipToMove as AudioClip).color,
        };

        set((state) => ({
          tracks: state.tracks.map((track) => {
            if (track.id === sourceTrackId) {
              return {
                ...track,
                clips: track.clips.filter((c) => c.id !== clipId),
              };
            } else if (track.id === newTrackId) {
              return { ...track, clips: [...track.clips, updatedClip] };
            }
            return track;
          }),
        }));
      }

      // Apply auto-crossfades on affected track(s)
      if (get().autoCrossfade) {
        get().applyAutoCrossfades(newTrackId);
        if (sourceTrackId !== newTrackId) {
          get().applyAutoCrossfades(sourceTrackId);
        }
      }
    },

    resizeClip: (clipId, newStartTime, newDuration, newOffset) => {
      const state = get();

      // Find old clip values
      let oldValues: {
        startTime: number;
        duration: number;
        offset: number;
      } | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldValues = {
            startTime: clip.startTime,
            duration: clip.duration,
            offset: clip.offset,
          };
          break;
        }
      }

      if (!oldValues) return;

      const command: Command = {
        type: "RESIZE_CLIP",
        description: "Resize clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId
                  ? {
                      ...clip,
                      startTime: newStartTime,
                      duration: newDuration,
                      offset: newOffset,
                    }
                  : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, ...oldValues } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    toggleClipMute: (clipId) => {
      let oldMuted = false;
      for (const track of get().tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { oldMuted = !!clip.muted; break; }
      }

      const command: Command = {
        type: "TOGGLE_CLIP_MUTE",
        description: oldMuted ? "Unmute clip" : "Mute clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: !oldMuted } : clip,
              ),
            })),
            isModified: true,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: oldMuted } : clip,
              ),
            })),
            isModified: true,
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setClipVolume: (clipId, volumeDB) => {
      set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, volumeDB } : clip,
          ),
        })),
      }));
    },

    setClipFades: (clipId, fadeIn, fadeOut) => {
      const state = get();

      // Find old fade values
      let oldValues: { fadeIn: number; fadeOut: number } | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldValues = { fadeIn: clip.fadeIn, fadeOut: clip.fadeOut };
          break;
        }
      }

      if (!oldValues) return;

      const command: Command = {
        type: "SET_CLIP_FADES",
        description: "Adjust clip fades",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, fadeIn, fadeOut } : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, ...oldValues } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    addClipGainPoint: (clipId, time, gain) => {
      const state = get();
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      const clampedGain = Math.max(0, Math.min(2, gain));
      const newPoint = { time, gain: clampedGain };

      const command: Command = {
        type: "ADD_CLIP_GAIN_POINT",
        description: "Add clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope, newPoint] : [newPoint];
                envelope.sort((a, b) => a.time - b.time);
                return { ...clip, gainEnvelope: envelope };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeClipGainPoint: (clipId, pointIndex) => {
      const state = get();
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      if (!oldEnvelope || pointIndex < 0 || pointIndex >= oldEnvelope.length) return;

      const command: Command = {
        type: "REMOVE_CLIP_GAIN_POINT",
        description: "Remove clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope] : [];
                envelope.splice(pointIndex, 1);
                return { ...clip, gainEnvelope: envelope.length > 0 ? envelope : undefined };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    moveClipGainPoint: (clipId, pointIndex, time, gain) => {
      const state = get();
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      if (!oldEnvelope || pointIndex < 0 || pointIndex >= oldEnvelope.length) return;

      const clampedGain = Math.max(0, Math.min(2, gain));

      const command: Command = {
        type: "MOVE_CLIP_GAIN_POINT",
        description: "Move clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope] : [];
                if (pointIndex < envelope.length) {
                  envelope[pointIndex] = { time, gain: clampedGain };
                  envelope.sort((a, b) => a.time - b.time);
                }
                return { ...clip, gainEnvelope: envelope };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    copyClip: (clipId) => {
      const state = get();
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;
      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { foundClip = clip; foundTrackId = track.id; }
      });

      if (foundClip && foundTrackId) {
        set({ clipboard: { clip: foundClip, clips: [{ clip: foundClip, trackId: foundTrackId }], isCut: false } });
      }
    },

    cutClip: (clipId) => {
      const state = get();
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;
      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { foundClip = clip; foundTrackId = track.id; }
      });

      if (foundClip && foundTrackId) {
        set({ clipboard: { clip: foundClip, clips: [{ clip: foundClip, trackId: foundTrackId }], isCut: true } });
      }
    },

    copySelectedClips: () => {
      const state = get();
      const clipEntries: Array<{ clip: AudioClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
      }
      if (clipEntries.length > 0) {
        set({ clipboard: { clip: clipEntries[0].clip, clips: clipEntries, isCut: false } });
      }
    },

    cutSelectedClips: () => {
      const state = get();
      const clipEntries: Array<{ clip: AudioClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
      }
      if (clipEntries.length > 0) {
        set({ clipboard: { clip: clipEntries[0].clip, clips: clipEntries, isCut: true } });
      }
    },

    pasteClip: (targetTrackId, targetTime) => {
      const state = get();
      const { clipboard } = state;
      if (!clipboard.clip) return;

      // Snapshot for undo
      const oldTracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const oldClipboard = clipboard;

      const newClip: AudioClip = {
        ...clipboard.clip,
        id: crypto.randomUUID(),
        startTime: targetTime,
      };

      set((s) => {
        let newTracks = s.tracks;
        if (clipboard.isCut) {
          newTracks = s.tracks.map((t) => ({
            ...t,
            clips: t.clips.filter((c) => c.id !== clipboard.clip!.id),
          }));
        }

        return {
          tracks: newTracks.map((t) =>
            t.id === targetTrackId ? { ...t, clips: [...t.clips, newClip] } : t,
          ),
          clipboard: clipboard.isCut
            ? { clip: null, clips: [], isCut: false }
            : s.clipboard,
          isModified: true,
        };
      });

      const newTracks = get().tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const newClipboardState = get().clipboard;

      commandManager.push({
        type: "PASTE_CLIP",
        description: "Paste clip",
        timestamp: Date.now(),
        execute: () => set({ tracks: newTracks, clipboard: newClipboardState, isModified: true }),
        undo: () => set({ tracks: oldTracks, clipboard: oldClipboard, isModified: true }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    pasteClips: () => {
      const state = get();
      const { clipboard } = state;
      if (clipboard.clips.length === 0) return;

      // Snapshot for undo
      const oldTracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const oldClipboard = clipboard;

      const currentTime = state.transport.currentTime;
      const earliestTime = Math.min(...clipboard.clips.map((c) => c.clip.startTime));

      if (clipboard.clips.length === 1) {
        const targetTrackId =
          state.selectedTrackIds.length > 0
            ? state.selectedTrackIds[0]
            : state.tracks.length > 0
              ? state.tracks[0].id
              : null;
        if (!targetTrackId) return;

        const newClip: AudioClip = {
          ...clipboard.clips[0].clip,
          id: crypto.randomUUID(),
          startTime: currentTime,
        };

        set((s) => {
          let newTracks = s.tracks;
          if (clipboard.isCut) {
            const origId = clipboard.clips[0].clip.id;
            newTracks = s.tracks.map((t) => ({
              ...t,
              clips: t.clips.filter((c) => c.id !== origId),
            }));
          }
          return {
            tracks: newTracks.map((t) =>
              t.id === targetTrackId ? { ...t, clips: [...t.clips, newClip] } : t,
            ),
            clipboard: clipboard.isCut ? { clip: null, clips: [], isCut: false } : s.clipboard,
            isModified: true,
          };
        });
      } else {
        const trackOrder = state.tracks.map((t) => t.id);
        const sourceTrackIndices = [...new Set(clipboard.clips.map((c) => c.trackId))];
        sourceTrackIndices.sort((a, b) => trackOrder.indexOf(a) - trackOrder.indexOf(b));

        const targetTrackIds: string[] = [];
        const newTracks: Array<{ id: string; name: string; color: string }> = [];

        if (state.selectedTrackIds.length >= sourceTrackIndices.length) {
          for (let i = 0; i < sourceTrackIndices.length; i++) {
            targetTrackIds.push(state.selectedTrackIds[i]);
          }
        } else {
          for (const srcTrackId of sourceTrackIndices) {
            const existingTrack = state.tracks.find((t) => t.id === srcTrackId);
            if (existingTrack) {
              targetTrackIds.push(srcTrackId);
            } else {
              const newId = crypto.randomUUID();
              newTracks.push({ id: newId, name: `Track ${state.tracks.length + newTracks.length + 1}`, color: "#3b82f6" });
              targetTrackIds.push(newId);
            }
          }
        }

        const trackMap = new Map<string, string>();
        sourceTrackIndices.forEach((srcId, i) => {
          trackMap.set(srcId, targetTrackIds[i]);
        });

        const newClips = clipboard.clips.map((entry) => ({
          clip: {
            ...entry.clip,
            id: crypto.randomUUID(),
            startTime: currentTime + (entry.clip.startTime - earliestTime),
          },
          targetTrackId: trackMap.get(entry.trackId) || targetTrackIds[0],
        }));

        set((s) => {
          let tracks = s.tracks;

          if (clipboard.isCut) {
            const origIds = new Set(clipboard.clips.map((c) => c.clip.id));
            tracks = tracks.map((t) => ({
              ...t,
              clips: t.clips.filter((c) => !origIds.has(c.id)),
            }));
          }

          const clipsByTrack = new Map<string, AudioClip[]>();
          for (const { clip, targetTrackId } of newClips) {
            if (!clipsByTrack.has(targetTrackId)) clipsByTrack.set(targetTrackId, []);
            clipsByTrack.get(targetTrackId)!.push(clip);
          }

          tracks = tracks.map((t) => {
            const addClips = clipsByTrack.get(t.id);
            return addClips ? { ...t, clips: [...t.clips, ...addClips] } : t;
          });

          return {
            tracks,
            clipboard: clipboard.isCut ? { clip: null, clips: [], isCut: false } : s.clipboard,
            isModified: true,
          };
        });

        for (const newTrack of newTracks) {
          get().addTrack(newTrack);
        }
      }

      // Undo tracking (captures full state after paste)
      const afterState = get();
      const newTracksSnapshot = afterState.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const newClipboardSnapshot = afterState.clipboard;

      commandManager.push({
        type: "PASTE_CLIPS",
        description: "Paste clips",
        timestamp: Date.now(),
        execute: () => set({ tracks: newTracksSnapshot, clipboard: newClipboardSnapshot, isModified: true }),
        undo: () => set({ tracks: oldTracks, clipboard: oldClipboard, isModified: true }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    nudgeClips: (direction, fine) => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      const amount = fine
        ? 0.01 // 10ms fine nudge
        : calculateGridInterval(state.transport.tempo, state.timeSignature, state.gridSize);
      const delta = direction === "right" ? amount : -amount;

      // Capture old positions for undo
      const clipPositions = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipPositions.set(clip.id, clip.startTime);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, startTime: Math.max(0, clip.startTime + delta) }
              : clip,
          ),
        })),
        isModified: true,
      }));

      const command: Command = {
        type: "NUDGE_CLIPS",
        description: `Nudge clips ${direction}`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clipPositions.has(clip.id)
                  ? { ...clip, startTime: Math.max(0, clipPositions.get(clip.id)! + delta) }
                  : clip,
              ),
            })),
            isModified: true,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clipPositions.has(clip.id)
                  ? { ...clip, startTime: clipPositions.get(clip.id)! }
                  : clip,
              ),
            })),
            isModified: true,
          }));
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    deleteClip: (clipId) => {
      const state = get();

      // Check if clip is locked
      const lockedClip = state.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      if (lockedClip?.locked) return;

      // Find the clip and its track
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;
      let clipIndex = 0;

      for (const track of state.tracks) {
        const idx = track.clips.findIndex((c) => c.id === clipId);
        if (idx !== -1) {
          foundClip = track.clips[idx];
          foundTrackId = track.id;
          clipIndex = idx;
          break;
        }
      }

      if (!foundClip || !foundTrackId) return;

      // Capture values for ripple editing and backend sync
      const clipFilePath = foundClip.filePath;
      const trackIdForBackend = foundTrackId;
      const rippleMode = state.rippleMode;
      const deletedDuration = foundClip.duration;
      const deletedEnd = foundClip.startTime + deletedDuration;

      // Create and execute command
      const command: Command = {
        type: "DELETE_CLIP",
        description: `Delete clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          // Remove from frontend state + apply ripple shift
          set((s) => ({
            tracks: s.tracks.map((track) => {
              let clips = track.clips.filter((c) => c.id !== clipId);

              // Ripple: shift downstream clips left by the deleted clip's duration
              if (rippleMode === "per_track" && track.id === foundTrackId) {
                clips = clips.map((c) =>
                  c.startTime >= deletedEnd
                    ? { ...c, startTime: Math.max(0, c.startTime - deletedDuration) }
                    : c,
                );
              } else if (rippleMode === "all_tracks") {
                clips = clips.map((c) =>
                  c.startTime >= deletedEnd
                    ? { ...c, startTime: Math.max(0, c.startTime - deletedDuration) }
                    : c,
                );
              }

              return { ...track, clips };
            }),
            selectedClipId:
              s.selectedClipId === clipId ? null : s.selectedClipId,
            selectedClipIds: s.selectedClipIds.filter((id) => id !== clipId),
          }));

          // Sync with backend - remove from playback engine
          if (clipFilePath) {
            try {
              await nativeBridge.removePlaybackClip(trackIdForBackend, clipFilePath);
              console.log(`[DAW] Clip deleted and removed from backend: ${clipFilePath}`);
            } catch (error) {
              console.error("[DAW] Failed to remove clip from backend:", error);
            }
          }
        },
        undo: async () => {
          // Restore to frontend state + reverse ripple shift
          set((s) => ({
            tracks: s.tracks.map((track) => {
              if (track.id === foundTrackId) {
                // Reverse ripple shift on this track
                let clips = [...track.clips];
                if (rippleMode !== "off") {
                  clips = clips.map((c) =>
                    c.startTime >= deletedEnd - deletedDuration
                      ? { ...c, startTime: c.startTime + deletedDuration }
                      : c,
                  );
                }
                clips.splice(clipIndex, 0, foundClip!);
                return { ...track, clips };
              }
              if (rippleMode === "all_tracks") {
                // Reverse ripple on other tracks too
                return {
                  ...track,
                  clips: track.clips.map((c) =>
                    c.startTime >= deletedEnd - deletedDuration
                      ? { ...c, startTime: c.startTime + deletedDuration }
                      : c,
                  ),
                };
              }
              return track;
            }),
          }));

          // Re-add to backend
          if (clipFilePath && foundClip) {
            try {
              await nativeBridge.addPlaybackClip(
                trackIdForBackend,
                clipFilePath,
                foundClip.startTime,
                foundClip.duration,
                foundClip.offset || 0,
                foundClip.volumeDB || 0,
                foundClip.fadeIn || 0,
                foundClip.fadeOut || 0,
                foundClip.id,
              );
              console.log(`[DAW] Clip restored to backend: ${clipFilePath}`);
            } catch (error) {
              console.error("[DAW] Failed to restore clip to backend:", error);
            }
          }
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    duplicateClip: (clipId) => {
      const state = get();

      // Find the clip and its track
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;

      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          foundClip = clip;
          foundTrackId = track.id;
          break;
        }
      }

      if (!foundClip || !foundTrackId) return;

      // Create new clip ID upfront so we can track it for undo
      const newClipId = crypto.randomUUID();
      const newClip: AudioClip = {
        ...foundClip,
        id: newClipId,
        startTime: foundClip.startTime + foundClip.duration,
      };

      const command: Command = {
        type: "DUPLICATE_CLIP",
        description: `Duplicate clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) =>
              track.id === foundTrackId
                ? { ...track, clips: [...track.clips, newClip] }
                : track,
            ),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.filter((c) => c.id !== newClipId),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    // ========== Advanced Clip Editing (Phase 4) ==========
    splitAtTimeSelection: () => {
      const state = get();
      const { timeSelection } = state;
      if (!timeSelection) return;

      const splitTimes = [timeSelection.start, timeSelection.end];
      const newClipEntries: Array<{ trackId: string; clips: AudioClip[] }> = [];

      for (const track of state.tracks) {
        const clipsToRemove: string[] = [];
        const clipsToAdd: AudioClip[] = [];

        for (const clip of track.clips) {
          let currentClip = clip;
          let wasSplit = false;

          for (const splitTime of splitTimes) {
            if (splitTime > currentClip.startTime && splitTime < currentClip.startTime + currentClip.duration) {
              if (!wasSplit) {
                clipsToRemove.push(clip.id);
                wasSplit = true;
              }
              const leftDuration = splitTime - currentClip.startTime;
              const leftClip: AudioClip = {
                ...currentClip,
                id: crypto.randomUUID(),
                duration: leftDuration,
                fadeOut: 0,
              };
              clipsToAdd.push(leftClip);

              currentClip = {
                ...currentClip,
                id: crypto.randomUUID(),
                startTime: splitTime,
                duration: currentClip.startTime + currentClip.duration - splitTime,
                offset: currentClip.offset + leftDuration,
                fadeIn: 0,
              };
            }
          }
          if (wasSplit) {
            clipsToAdd.push(currentClip);
          }
        }

        if (clipsToRemove.length > 0) {
          newClipEntries.push({ trackId: track.id, clips: clipsToAdd });
        }
      }

      if (newClipEntries.length === 0) return;

      set((s) => ({
        tracks: s.tracks.map((track) => {
          const entry = newClipEntries.find((e) => e.trackId === track.id);
          if (!entry) return track;
          const removeIds = new Set(
            track.clips
              .filter((c) => {
                const clipEnd = c.startTime + c.duration;
                return (
                  (timeSelection.start > c.startTime && timeSelection.start < clipEnd) ||
                  (timeSelection.end > c.startTime && timeSelection.end < clipEnd)
                );
              })
              .map((c) => c.id),
          );
          return {
            ...track,
            clips: [...track.clips.filter((c) => !removeIds.has(c.id)), ...entry.clips],
          };
        }),
        isModified: true,
      }));
    },

    groupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length < 2) return;

      // Capture old groupIds for undo
      const oldGroupIds = new Map<string, string | undefined>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldGroupIds.set(clip.id, clip.groupId);
          }
        }
      }

      const groupId = crypto.randomUUID();
      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, groupId }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "GROUP_CLIPS",
        description: "Group selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldGroupIds.has(c.id) ? { ...c, groupId } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldGroupIds.get(c.id);
              return old !== undefined || oldGroupIds.has(c.id) ? { ...c, groupId: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    ungroupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      // Capture old groupIds for undo
      const oldGroupIds = new Map<string, string | undefined>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldGroupIds.set(clip.id, clip.groupId);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, groupId: undefined }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "UNGROUP_CLIPS",
        description: "Ungroup selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldGroupIds.has(c.id) ? { ...c, groupId: undefined } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldGroupIds.get(c.id);
              return old !== undefined || oldGroupIds.has(c.id) ? { ...c, groupId: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    normalizeSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      // Capture old volumes for undo
      const oldVolumes = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldVolumes.set(clip.id, clip.volumeDB ?? 0);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, volumeDB: 0 }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "NORMALIZE_CLIPS",
        description: "Normalize selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldVolumes.has(c.id) ? { ...c, volumeDB: 0 } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldVolumes.get(c.id);
              return old !== undefined ? { ...c, volumeDB: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== Razor Edits ==========
    addRazorEdit: (trackId, start, end) => {
      set((s) => ({
        razorEdits: [...s.razorEdits, { trackId, start: Math.min(start, end), end: Math.max(start, end) }],
      }));
    },

    clearRazorEdits: () => {
      set({ razorEdits: [] });
    },

    deleteRazorEditContent: () => {
      const state = get();
      if (state.razorEdits.length === 0) return;

      // Snapshot for undo
      const oldTracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const oldRazorEdits = [...state.razorEdits];

      set((s) => ({
        tracks: s.tracks.map((track) => {
          const editsForTrack = s.razorEdits.filter((r) => r.trackId === track.id);
          if (editsForTrack.length === 0) return track;

          let clips = [...track.clips];
          for (const razor of editsForTrack) {
            const newClips: AudioClip[] = [];
            for (const clip of clips) {
              const clipEnd = clip.startTime + clip.duration;

              if (clipEnd <= razor.start || clip.startTime >= razor.end) {
                newClips.push(clip);
                continue;
              }

              if (clip.startTime < razor.start) {
                newClips.push({
                  ...clip,
                  id: crypto.randomUUID(),
                  duration: razor.start - clip.startTime,
                  fadeOut: 0,
                });
              }

              if (clipEnd > razor.end) {
                const trimmedOffset = razor.end - clip.startTime;
                newClips.push({
                  ...clip,
                  id: crypto.randomUUID(),
                  startTime: razor.end,
                  duration: clipEnd - razor.end,
                  offset: clip.offset + trimmedOffset,
                  fadeIn: 0,
                });
              }
            }
            clips = newClips;
          }

          return { ...track, clips };
        }),
        razorEdits: [],
        isModified: true,
      }));

      const newTracks = get().tracks.map(t => ({ ...t, clips: [...t.clips] }));

      commandManager.push({
        type: "DELETE_RAZOR_EDIT",
        description: "Delete razor edit content",
        timestamp: Date.now(),
        execute: () => {
          set({ tracks: newTracks, razorEdits: [], isModified: true });
          if (get().transport.isPlaying) get().syncClipsWithBackend();
        },
        undo: () => {
          set({ tracks: oldTracks, razorEdits: oldRazorEdits, isModified: true });
          if (get().transport.isPlaying) get().syncClipsWithBackend();
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      // Sync backend immediately if playing
      if (get().transport.isPlaying) get().syncClipsWithBackend();
    },

    // ========== Track Automation (Phase 5) ==========
    toggleTrackAutomation: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, showAutomation: !t.showAutomation } : t,
        ),
      }));
    },

    addAutomationLane: (trackId, param, _label) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return null;
      // Don't add duplicate lanes for the same param
      const existing = track.automationLanes.find((l) => l.param === param);
      if (existing) return existing.id;
      const laneId = `lane_${param}_${Date.now()}`;
      const newLane: AutomationLane = { id: laneId, param, points: [], visible: true, mode: "read", armed: false };
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return { ...t, automationLanes: [...t.automationLanes, newLane], showAutomation: true };
        }),
        isModified: true,
      }));
      return laneId;
    },

    addAutomationPoint: (trackId, laneId, time, value) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => {
              if (lane.id !== laneId) return lane;
              // Insert point in time-sorted order
              const newPoints = [...lane.points, { time, value: Math.max(0, Math.min(1, value)) }];
              newPoints.sort((a, b) => a.time - b.time);
              return { ...lane, points: newPoints };
            }),
          };
        }),
        isModified: true,
      }));
      // Sync to C++ backend
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend(trackId, lane);
    },

    removeAutomationPoint: (trackId, laneId, pointIndex) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => {
              if (lane.id !== laneId) return lane;
              return { ...lane, points: lane.points.filter((_, i) => i !== pointIndex) };
            }),
          };
        }),
        isModified: true,
      }));
      // Sync to C++ backend
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend(trackId, lane);
    },

    moveAutomationPoint: (trackId, laneId, pointIndex, time, value) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => {
              if (lane.id !== laneId) return lane;
              const newPoints = lane.points.map((p, i) =>
                i === pointIndex ? { time: Math.max(0, time), value: Math.max(0, Math.min(1, value)) } : p,
              );
              newPoints.sort((a, b) => a.time - b.time);
              return { ...lane, points: newPoints };
            }),
          };
        }),
        isModified: true,
      }));
      // Sync to C++ backend
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (lane) syncAutomationLaneToBackend(trackId, lane);
    },

    toggleAutomationLaneVisibility: (trackId, laneId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.id === laneId ? { ...lane, visible: !lane.visible } : lane,
            ),
          };
        }),
      }));
    },

    clearAutomationLane: (trackId, laneId) => {
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((l) =>
              l.id === laneId ? { ...l, points: [] } : l,
            ),
          };
        }),
        isModified: true,
      }));
      // Sync to C++ backend — clear the automation for this parameter
      if (lane) {
        const parameterId = lane.param === "mute" ? "mute" : lane.param;
        nativeBridge.clearAutomation(trackId, parameterId).catch(() => {});
      }
    },

    setAutomationLaneMode: (trackId, laneId, mode) => {
      // Auto-arm when setting to write/touch/latch, auto-disarm for read/off
      const shouldArm = mode === "write" || mode === "touch" || mode === "latch";
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.id === laneId ? { ...lane, mode, armed: shouldArm } : lane,
            ),
          };
        }),
      }));
      const track = get().tracks.find((t) => t.id === trackId);
      const lane = track?.automationLanes.find((l) => l.id === laneId);
      if (lane) nativeBridge.setAutomationMode(trackId, lane.param, mode).catch(() => {});
    },

    setTrackAutomationMode: (trackId, mode) => {
      // Auto-arm when setting to write/touch/latch, auto-disarm for read/off
      const shouldArm = mode === "write" || mode === "touch" || mode === "latch";
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => ({ ...lane, mode, armed: shouldArm })),
          };
        }),
      }));
      const track = get().tracks.find((t) => t.id === trackId);
      if (track) {
        for (const lane of track.automationLanes) {
          nativeBridge.setAutomationMode(trackId, lane.param, mode).catch(() => {});
        }
      }
    },

    armAutomationLane: (trackId, laneId, armed) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.id === laneId ? { ...lane, armed } : lane,
            ),
          };
        }),
      }));
    },

    armAllVisibleAutomationLanes: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.visible ? { ...lane, armed: true } : lane,
            ),
          };
        }),
      }));
    },

    disarmAllAutomationLanes: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) => ({ ...lane, armed: false })),
          };
        }),
      }));
    },

    showAllActiveEnvelopes: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            showAutomation: true,
            automationLanes: t.automationLanes.map((lane) =>
              lane.points.length > 0 ? { ...lane, visible: true } : lane,
            ),
          };
        }),
      }));
    },

    hideAllEnvelopes: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return { ...t, showAutomation: false };
        }),
      }));
    },

    // ========== Strip Silence (Phase 3.12) ==========
    stripSilence: (clipId, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs) => {
      const state = get();
      let sourceTrack: Track | undefined;
      let sourceClip: AudioClip | undefined;
      for (const t of state.tracks) {
        const c = t.clips.find((cl) => cl.id === clipId);
        if (c) { sourceTrack = t; sourceClip = c; break; }
      }
      if (!sourceTrack || !sourceClip) return;

      const trackId = sourceTrack.id;
      const clip = sourceClip;

      nativeBridge.detectSilentRegions(clip.filePath, thresholdDb, minSilenceMs, minSoundMs, preAttackMs, postReleaseMs)
        .then((regions) => {
          if (!regions || regions.length === 0) return;

          const oldClips = get().tracks.find((t) => t.id === trackId)?.clips ?? [];

          // Create new clips from detected regions
          const newClips: AudioClip[] = [];
          for (let i = 0; i < regions.length; i++) {
            const r = regions[i];
            // Region times are relative to the file; clip may have offset
            const regionStartInFile = r.startTime;
            const regionEndInFile = r.endTime;

            // Only include regions that overlap with the clip's content window
            const clipContentStart = clip.offset;
            const clipContentEnd = clip.offset + clip.duration;
            const overlapStart = Math.max(regionStartInFile, clipContentStart);
            const overlapEnd = Math.min(regionEndInFile, clipContentEnd);
            if (overlapEnd <= overlapStart) continue;

            const overlapDuration = overlapEnd - overlapStart;
            const timelineOffset = overlapStart - clipContentStart;

            newClips.push({
              ...clip,
              id: clip.id + "_ss_" + i,
              name: clip.name + " (" + (i + 1) + ")",
              startTime: clip.startTime + timelineOffset,
              duration: overlapDuration,
              offset: overlapStart,
              fadeIn: i === 0 ? clip.fadeIn : 0,
              fadeOut: i === regions.length - 1 ? clip.fadeOut : 0,
            });
          }

          if (newClips.length === 0) return;

          // Replace the original clip with the new clips
          const updatedClips = oldClips.filter((c) => c.id !== clipId).concat(newClips);

          const command: Command = {
            type: "strip-silence",
            description: `Strip silence from "${clip.name}"`,
            timestamp: Date.now(),
            execute: () => {
              set((s) => ({
                tracks: s.tracks.map((t) =>
                  t.id === trackId ? { ...t, clips: updatedClips } : t
                ),
                isModified: true,
              }));
            },
            undo: () => {
              set((s) => ({
                tracks: s.tracks.map((t) =>
                  t.id === trackId ? { ...t, clips: oldClips } : t
                ),
                isModified: true,
              }));
            },
          };
          commandManager.execute(command);
          set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        })
        .catch((err) => console.error("stripSilence failed:", err));
    },

    // ========== Track Freeze (Phase 3.13) ==========
    freezeTrack: (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track || track.frozen) return;

      // Save current clips before freeze
      const originalClips = [...track.clips];

      nativeBridge.freezeTrack(trackId)
        .then((result) => {
          if (!result.success || !result.filePath) {
            console.error("freezeTrack failed:", result.error);
            return;
          }

          const freezeClip: AudioClip = {
            id: trackId + "_freeze",
            filePath: result.filePath,
            name: track.name + " (frozen)",
            startTime: result.startTime ?? 0,
            duration: result.duration ?? 0,
            offset: 0,
            color: "#60a5fa", // blue tint for frozen
            volumeDB: 0,
            fadeIn: 0,
            fadeOut: 0,
            sampleRate: result.sampleRate,
          };

          const command: Command = {
            type: "freeze-track",
            description: `Freeze track "${track.name}"`,
            timestamp: Date.now(),
            execute: () => {
              set((s) => ({
                tracks: s.tracks.map((t) =>
                  t.id === trackId
                    ? { ...t, frozen: true, freezeFilePath: result.filePath, frozenOriginalClips: originalClips, clips: [freezeClip] }
                    : t
                ),
                isModified: true,
              }));
            },
            undo: () => {
              set((s) => ({
                tracks: s.tracks.map((t) =>
                  t.id === trackId
                    ? { ...t, frozen: false, freezeFilePath: undefined, frozenOriginalClips: undefined, clips: originalClips }
                    : t
                ),
                isModified: true,
              }));
              nativeBridge.unfreezeTrack(trackId).catch(() => {});
            },
          };
          commandManager.execute(command);
          set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        })
        .catch((err) => console.error("freezeTrack failed:", err));
    },

    unfreezeTrack: (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track || !track.frozen) return;

      const restoredClips = track.frozenOriginalClips ?? [];
      const frozenClips = [...track.clips];
      const frozenFilePath = track.freezeFilePath;

      const command: Command = {
        type: "unfreeze-track",
        description: `Unfreeze track "${track.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId
                ? { ...t, frozen: false, freezeFilePath: undefined, frozenOriginalClips: undefined, clips: restoredClips }
                : t
            ),
            isModified: true,
          }));
          nativeBridge.unfreezeTrack(trackId).catch(() => {});
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId
                ? { ...t, frozen: true, freezeFilePath: frozenFilePath, frozenOriginalClips: restoredClips, clips: frozenClips }
                : t
            ),
            isModified: true,
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== Comping / Takes (Phase 6) ==========
    promoteClipsToTake: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          // Move current clips into a new take lane, clear main clips
          return {
            ...t,
            takes: [...t.takes, t.clips],
            clips: [],
            activeTakeIndex: 0,
          };
        }),
        isModified: true,
      }));
      // Re-sync backend since clips[] changed (now empty for this track)
      if (get().transport.isPlaying) get().syncClipsWithBackend();
    },

    setActiveTake: (trackId, takeIndex) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          if (takeIndex === 0) {
            // Switch back to main clips (already in t.clips)
            return { ...t, activeTakeIndex: 0 };
          }
          if (takeIndex > 0 && takeIndex <= t.takes.length) {
            // Swap: store current clips into current take slot, load selected take
            const newTakes = [...t.takes];
            if (t.activeTakeIndex > 0 && t.activeTakeIndex <= newTakes.length) {
              newTakes[t.activeTakeIndex - 1] = t.clips;
            }
            const takeClips = newTakes[takeIndex - 1];
            newTakes[takeIndex - 1] = t.clips;
            return { ...t, clips: takeClips, takes: newTakes, activeTakeIndex: takeIndex };
          }
          return t;
        }),
      }));
      // Re-sync backend since clips[] swapped with a different take
      if (get().transport.isPlaying) get().syncClipsWithBackend();
    },

    deleteTake: (trackId, takeIndex) => {
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId || takeIndex < 1 || takeIndex > t.takes.length) return t;
          const newTakes = t.takes.filter((_, i) => i !== takeIndex - 1);
          return {
            ...t,
            takes: newTakes,
            activeTakeIndex: t.activeTakeIndex === takeIndex ? 0 : t.activeTakeIndex,
          };
        }),
        isModified: true,
      }));
    },

    // ========== Markers and Regions ==========
    addMarker: (time, name) => {
      const marker: Marker = {
        id: crypto.randomUUID(),
        time,
        name: name || `Marker ${get().markers.length + 1}`,
        color: "#60a5fa",
      };
      set((state) => ({
        markers: [...state.markers, marker],
      }));
    },

    removeMarker: (id) => {
      set((state) => ({
        markers: state.markers.filter((m) => m.id !== id),
      }));
    },

    updateMarker: (id, updates) => {
      set((state) => ({
        markers: state.markers.map((m) =>
          m.id === id ? { ...m, ...updates } : m
        ),
      }));
    },

    addRegion: (start, end, name) => {
      const region: Region = {
        id: crypto.randomUUID(),
        name: name || `Region ${get().regions.length + 1}`,
        startTime: Math.min(start, end),
        endTime: Math.max(start, end),
        color: "#8b5cf6",
      };
      set((state) => ({
        regions: [...state.regions, region],
      }));
    },

    removeRegion: (id) => {
      set((state) => ({
        regions: state.regions.filter((r) => r.id !== id),
      }));
    },

    updateRegion: (id, updates) => {
      set((state) => ({
        regions: state.regions.map((r) =>
          r.id === id ? { ...r, ...updates } : r
        ),
      }));
    },

    // ========== Tempo Map ==========
    addTempoMarker: (time, tempo) => {
      const marker: TempoMarker = {
        id: crypto.randomUUID(),
        time,
        tempo: Math.max(10, Math.min(300, tempo)),
      };
      set((state) => ({
        tempoMarkers: [...state.tempoMarkers, marker].sort((a, b) => a.time - b.time),
        isModified: true,
      }));
      syncTempoMarkersToBackend(get().tempoMarkers);
    },

    removeTempoMarker: (id) => {
      set((state) => ({
        tempoMarkers: state.tempoMarkers.filter((m) => m.id !== id),
        isModified: true,
      }));
      syncTempoMarkersToBackend(get().tempoMarkers);
    },

    updateTempoMarker: (id, updates) => {
      set((state) => ({
        tempoMarkers: state.tempoMarkers
          .map((m) => (m.id === id ? { ...m, ...updates } : m))
          .sort((a, b) => a.time - b.time),
        isModified: true,
      }));
      syncTempoMarkersToBackend(get().tempoMarkers);
    },

    getTempoAtTime: (time) => {
      const { tempoMarkers, transport } = get();
      if (tempoMarkers.length === 0) return transport.tempo;
      // Find the last tempo marker before or at the given time
      let activeTempo = transport.tempo;
      for (const marker of tempoMarkers) {
        if (marker.time <= time) {
          activeTempo = marker.tempo;
        } else {
          break;
        }
      }
      return activeTempo;
    },

    // ========== UI State ==========
    toggleMixer: () => set((state) => ({ showMixer: !state.showMixer })),
    toggleMasterTrackInTCP: () => set((state) => ({ showMasterTrackInTCP: !state.showMasterTrackInTCP })),
    openSettings: () => set({ showSettings: true }),
    closeSettings: () => set({ showSettings: false }),
    openProjectSettings: () => set({ showProjectSettings: true }),
    closeProjectSettings: () => set({ showProjectSettings: false }),
    openRenderModal: () => set({ showRenderModal: true }),
    closeRenderModal: () => set({ showRenderModal: false }),
    openPluginBrowser: (trackId) =>
      set({ showPluginBrowser: true, pluginBrowserTrackId: trackId }),
    closePluginBrowser: () =>
      set({ showPluginBrowser: false, pluginBrowserTrackId: null }),
    openEnvelopeManager: (trackId) =>
      set({ showEnvelopeManager: true, envelopeManagerTrackId: trackId }),
    closeEnvelopeManager: () =>
      set({ showEnvelopeManager: false, envelopeManagerTrackId: null }),
    openChannelStripEQ: (trackId) =>
      set({ showChannelStripEQ: true, channelStripEQTrackId: trackId }),
    closeChannelStripEQ: () =>
      set({ showChannelStripEQ: false, channelStripEQTrackId: null }),
    openTrackRouting: (trackId) =>
      set({ showTrackRouting: true, trackRoutingTrackId: trackId }),
    closeTrackRouting: () =>
      set({ showTrackRouting: false, trackRoutingTrackId: null }),
    toggleVirtualKeyboard: () =>
      set((state) => ({ showVirtualKeyboard: !state.showVirtualKeyboard })),
    toggleUndoHistory: () =>
      set((state) => ({ showUndoHistory: !state.showUndoHistory })),
    toggleCommandPalette: () =>
      set((state) => ({ showCommandPalette: !state.showCommandPalette })),
    toggleRegionMarkerManager: () =>
      set((state) => ({ showRegionMarkerManager: !state.showRegionMarkerManager })),
    toggleClipProperties: () =>
      set((state) => ({ showClipProperties: !state.showClipProperties })),
    toggleBigClock: () =>
      set((state) => ({ showBigClock: !state.showBigClock })),
    toggleBigClockFormat: () =>
      set((state) => ({ bigClockFormat: state.bigClockFormat === "time" ? "beats" : "time" })),
    toggleKeyboardShortcuts: () =>
      set((state) => ({ showKeyboardShortcuts: !state.showKeyboardShortcuts })),
    toggleContextualHelp: () =>
      set((state) => ({ showContextualHelp: !state.showContextualHelp })),
    toggleGettingStarted: () =>
      set((state) => ({ showGettingStarted: !state.showGettingStarted })),
    togglePreferences: () =>
      set((state) => ({ showPreferences: !state.showPreferences })),
    toggleScriptConsole: () =>
      set((state) => ({ showScriptConsole: !state.showScriptConsole })),
    openStemSeparation: (trackId, clipId, name, duration) =>
      set({ showStemSeparation: true, stemSepTrackId: trackId, stemSepClipId: clipId, stemSepClipName: name, stemSepClipDuration: duration }),
    closeStemSeparation: () =>
      set({ showStemSeparation: false, stemSepTrackId: null, stemSepClipId: null, stemSepClipName: "", stemSepClipDuration: 0 }),
    completeStemSeparation: (sourceTrackId, _sourceClipId, clipName, stemFiles, sourceClipStartTime) => {
      const STEM_COLORS: Record<string, string> = {
        Vocals: "#ec4899", Drums: "#f97316", Bass: "#3b82f6",
        Guitar: "#a855f7", Piano: "#06b6d4", Other: "#22c55e",
      };

      // Pre-generate IDs and build all data upfront
      const stemTrackIds: string[] = [];
      const stemTracks: Track[] = [];
      const clipMap = new Map<string, AudioClip>();
      let insertAfterId = sourceTrackId;

      for (const stem of stemFiles) {
        if (!stem.filePath) continue;
        const trackId = crypto.randomUUID();
        const clipId = crypto.randomUUID();
        stemTrackIds.push(trackId);

        const newTrack = createDefaultTrack(trackId, `${stem.name} - ${clipName}`, STEM_COLORS[stem.name] || "#666666");
        stemTracks.push({ ...newTrack, insertAfterTrackId: insertAfterId } as Track);

        clipMap.set(trackId, {
          id: clipId,
          name: stem.name,
          filePath: stem.filePath,
          startTime: sourceClipStartTime,
          duration: stem.duration || 0,
          offset: 0,
          color: STEM_COLORS[stem.name] || "#666666",
          volumeDB: 0,
          fadeIn: 0,
          fadeOut: 0,
          sampleRate: stem.sampleRate || 44100,
        });
        insertAfterId = trackId;
      }

      const groupName = `Stems: ${clipName}`;
      const wasSourceMuted = get().tracks.find((t) => t.id === sourceTrackId)?.muted ?? false;

      const command: Command = {
        type: "STEM_SEPARATION",
        description: `Separate stems: ${clipName}`,
        timestamp: Date.now(),
        execute: () => {
          // Single batched state update: insert all tracks with clips + mute source + add group
          set((state) => {
            let newTracks = [...state.tracks];
            for (const stemTrack of stemTracks) {
              const clip = clipMap.get(stemTrack.id)!;
              const trackWithClip = { ...stemTrack, clips: [clip] };
              const idx = newTracks.findIndex((t) => t.id === (stemTrack as any).insertAfterTrackId);
              if (idx >= 0) {
                newTracks.splice(idx + 1, 0, trackWithClip);
              } else {
                newTracks.push(trackWithClip);
              }
            }
            // Mute source track
            if (!wasSourceMuted) {
              newTracks = newTracks.map((t) => t.id === sourceTrackId ? { ...t, muted: true } : t);
            }
            const newGroups = stemTrackIds.length > 1
              ? [...state.trackGroups, {
                  id: crypto.randomUUID(), name: groupName,
                  leadTrackId: stemTrackIds[0], memberTrackIds: stemTrackIds,
                  linkedParams: ["volume", "mute", "solo"],
                }]
              : state.trackGroups;
            return { tracks: newTracks, trackGroups: newGroups };
          });
          // Register all new tracks in C++ backend and mute source
          Promise.all(stemTrackIds.map((tid) => nativeBridge.addTrack(tid))).catch(() => {});
          if (!wasSourceMuted) {
            nativeBridge.setTrackMute(sourceTrackId, true).catch(() => {});
          }
        },
        undo: () => {
          // Remove stem tracks + ungroup in single update
          set((s) => {
            let newTracks = s.tracks.filter((t) => !stemTrackIds.includes(t.id));
            if (!wasSourceMuted) {
              newTracks = newTracks.map((t) => t.id === sourceTrackId ? { ...t, muted: false } : t);
            }
            return {
              tracks: newTracks,
              trackGroups: s.trackGroups.filter((g) => g.name !== groupName),
            };
          });
          // Remove from C++ backend
          for (const tid of stemTrackIds) {
            nativeBridge.removeTrack(tid).catch(() => {});
          }
          if (!wasSourceMuted) {
            nativeBridge.setTrackMute(sourceTrackId, false).catch(() => {});
          }
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    setTimecodeMode: (mode) => set({ timecodeMode: mode }),
    setSmpteFrameRate: (rate) => set({ smpteFrameRate: rate }),
    setUIFontScale: (scale) => set({ uiFontScale: Math.max(0.75, Math.min(1.5, scale)) }),

    // ========== Detachable Panels ==========
    detachPanel: (panelId) =>
      set((state) => ({
        detachedPanels: state.detachedPanels.includes(panelId)
          ? state.detachedPanels
          : [...state.detachedPanels, panelId],
      })),
    attachPanel: (panelId) =>
      set((state) => ({
        detachedPanels: state.detachedPanels.filter((id) => id !== panelId),
      })),

    // ========== Cut/Copy within Time Selection ==========
    cutWithinTimeSelection: () => {
      const state = get();
      if (!state.timeSelection) return;
      const { start, end } = state.timeSelection;

      // Collect clips within the time selection
      const clipsInRange: Array<{ clip: AudioClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          const clipEnd = clip.startTime + clip.duration;
          if (clip.startTime < end && clipEnd > start) {
            const trimStart = Math.max(clip.startTime, start);
            const trimEnd = Math.min(clipEnd, end);
            const trimmedClip: AudioClip = {
              ...clip,
              id: crypto.randomUUID(),
              startTime: 0,
              offset: clip.offset + (trimStart - clip.startTime),
              duration: trimEnd - trimStart,
              fadeIn: 0,
              fadeOut: 0,
            };
            clipsInRange.push({ clip: trimmedClip, trackId: track.id });
          }
        }
      }

      if (clipsInRange.length === 0) return;

      // Snapshot for undo
      const oldTracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const oldClipboard = state.clipboard;

      // Store in clipboard
      set({
        clipboard: { clip: clipsInRange[0]?.clip || null, clips: clipsInRange, isCut: true },
      });

      // Remove content within the selection
      set((s) => ({
        tracks: s.tracks.map((track) => {
          const newClips: AudioClip[] = [];
          for (const clip of track.clips) {
            const clipEnd = clip.startTime + clip.duration;
            if (clipEnd <= start || clip.startTime >= end) {
              newClips.push(clip);
              continue;
            }
            if (clip.startTime < start) {
              newClips.push({ ...clip, id: crypto.randomUUID(), duration: start - clip.startTime, fadeOut: 0 });
            }
            if (clipEnd > end) {
              newClips.push({
                ...clip,
                id: crypto.randomUUID(),
                startTime: end,
                duration: clipEnd - end,
                offset: clip.offset + (end - clip.startTime),
                fadeIn: 0,
              });
            }
          }
          return { ...track, clips: newClips };
        }),
        isModified: true,
      }));

      const newTracks = get().tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const newClipboard = get().clipboard;

      commandManager.push({
        type: "CUT_WITHIN_TIME_SELECTION",
        description: "Cut within time selection",
        timestamp: Date.now(),
        execute: () => set({ tracks: newTracks, clipboard: newClipboard, isModified: true }),
        undo: () => set({ tracks: oldTracks, clipboard: oldClipboard, isModified: true }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    copyWithinTimeSelection: () => {
      const state = get();
      if (!state.timeSelection) return;
      const { start, end } = state.timeSelection;

      const clipsInRange: Array<{ clip: AudioClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          const clipEnd = clip.startTime + clip.duration;
          if (clip.startTime < end && clipEnd > start) {
            const trimStart = Math.max(clip.startTime, start);
            const trimEnd = Math.min(clipEnd, end);
            const trimmedClip: AudioClip = {
              ...clip,
              id: crypto.randomUUID(),
              startTime: 0,
              offset: clip.offset + (trimStart - clip.startTime),
              duration: trimEnd - trimStart,
              fadeIn: 0,
              fadeOut: 0,
            };
            clipsInRange.push({ clip: trimmedClip, trackId: track.id });
          }
        }
      }

      if (clipsInRange.length === 0) return;
      set({
        clipboard: { clip: clipsInRange[0]?.clip || null, clips: clipsInRange, isCut: false },
      });
    },

    deleteWithinTimeSelection: () => {
      const state = get();
      if (!state.timeSelection) return;
      const { start, end } = state.timeSelection;
      const selectionDuration = end - start;

      // Snapshot for undo
      const oldTracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const oldMarkers = [...state.markers];
      const oldRegions = [...state.regions];
      const oldTimeSelection = state.timeSelection;

      set((s) => ({
        tracks: s.tracks.map((track) => {
          const newClips: AudioClip[] = [];
          for (const clip of track.clips) {
            const clipEnd = clip.startTime + clip.duration;
            if (clipEnd <= start) {
              newClips.push(clip);
              continue;
            }
            if (clip.startTime >= end) {
              newClips.push({ ...clip, startTime: clip.startTime - selectionDuration });
              continue;
            }
            if (clip.startTime < start) {
              newClips.push({ ...clip, id: crypto.randomUUID(), duration: start - clip.startTime, fadeOut: 0 });
            }
            if (clipEnd > end) {
              newClips.push({
                ...clip,
                id: crypto.randomUUID(),
                startTime: start,
                duration: clipEnd - end,
                offset: clip.offset + (end - clip.startTime),
                fadeIn: 0,
              });
            }
          }
          return { ...track, clips: newClips };
        }),
        markers: s.markers.map((m) => {
          if (m.time >= end) return { ...m, time: m.time - selectionDuration };
          if (m.time > start) return { ...m, time: start };
          return m;
        }),
        regions: s.regions.map((r) => {
          if (r.startTime >= end) return { ...r, startTime: r.startTime - selectionDuration, endTime: r.endTime - selectionDuration };
          if (r.endTime <= start) return r;
          return { ...r, endTime: Math.min(r.endTime - selectionDuration, r.startTime < start ? start : r.startTime) };
        }).filter((r) => r.endTime > r.startTime),
        timeSelection: null,
        isModified: true,
      }));

      const newState = get();
      const newTracks = newState.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const newMarkers = [...newState.markers];
      const newRegions = [...newState.regions];

      commandManager.push({
        type: "DELETE_WITHIN_TIME_SELECTION",
        description: "Delete within time selection (ripple)",
        timestamp: Date.now(),
        execute: () => set({ tracks: newTracks, markers: newMarkers, regions: newRegions, timeSelection: null, isModified: true }),
        undo: () => set({ tracks: oldTracks, markers: oldMarkers, regions: oldRegions, timeSelection: oldTimeSelection, isModified: true }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    insertSilenceAtTimeSelection: () => {
      const state = get();
      if (!state.timeSelection) return;
      const { start: insertTime, end: selEnd } = state.timeSelection;
      const insertDuration = selEnd - insertTime;
      if (insertDuration <= 0) return;

      // Snapshot for undo
      const oldTracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const oldMarkers = [...state.markers];
      const oldRegions = [...state.regions];
      const oldTimeSelection = state.timeSelection;

      set((s) => ({
        tracks: s.tracks.map((track) => {
          const newClips: AudioClip[] = [];
          for (const clip of track.clips) {
            const clipEnd = clip.startTime + clip.duration;
            if (clipEnd <= insertTime) {
              newClips.push(clip);
            } else if (clip.startTime >= insertTime) {
              newClips.push({ ...clip, startTime: clip.startTime + insertDuration });
            } else {
              newClips.push({
                ...clip,
                id: crypto.randomUUID(),
                duration: insertTime - clip.startTime,
                fadeOut: 0,
              });
              newClips.push({
                ...clip,
                id: crypto.randomUUID(),
                startTime: insertTime + insertDuration,
                duration: clipEnd - insertTime,
                offset: clip.offset + (insertTime - clip.startTime),
                fadeIn: 0,
              });
            }
          }
          return { ...track, clips: newClips };
        }),
        markers: s.markers.map((m) =>
          m.time >= insertTime ? { ...m, time: m.time + insertDuration } : m
        ),
        regions: s.regions.map((r) => {
          if (r.startTime >= insertTime) return { ...r, startTime: r.startTime + insertDuration, endTime: r.endTime + insertDuration };
          if (r.endTime <= insertTime) return r;
          return { ...r, endTime: r.endTime + insertDuration };
        }),
        timeSelection: null,
        isModified: true,
      }));

      // Capture new state for redo
      const newState = get();
      const newTracks = newState.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const newMarkers = [...newState.markers];
      const newRegions = [...newState.regions];

      commandManager.push({
        type: "INSERT_SILENCE",
        description: "Insert silence",
        timestamp: Date.now(),
        execute: () => set({ tracks: newTracks, markers: newMarkers, regions: newRegions, timeSelection: null, isModified: true }),
        undo: () => set({ tracks: oldTracks, markers: oldMarkers, regions: oldRegions, timeSelection: oldTimeSelection, isModified: true }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== Record & Edit Modes ==========
    setRecordMode: (mode) => set({ recordMode: mode }),
    setRippleMode: (mode) => set({ rippleMode: mode }),
    setPlayheadStopBehavior: (mode) => set({ playheadStopBehavior: mode }),

    // ========== Auto-Crossfade ==========
    toggleAutoCrossfade: () => set((s) => ({ autoCrossfade: !s.autoCrossfade })),

    applyAutoCrossfades: (trackId) => {
      const state = get();
      if (!state.autoCrossfade) return;

      set((s) => ({
        tracks: s.tracks.map((track) => {
          if (track.id !== trackId) return track;
          const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime);
          const updated = sorted.map((clip, i) => {
            if (i === 0) return clip;
            const prev = sorted[i - 1];
            const prevEnd = prev.startTime + prev.duration;
            const overlap = prevEnd - clip.startTime;
            if (overlap > 0) {
              // Crossfade length matches the actual overlap
              return { ...clip, fadeIn: overlap };
            }
            return { ...clip, fadeIn: 0 };
          });
          // Also set fadeOut on clips that have a following overlap
          const final = updated.map((clip, i) => {
            if (i >= sorted.length - 1) return clip;
            const next = sorted[i + 1];
            const clipEnd = clip.startTime + clip.duration;
            const overlap = clipEnd - next.startTime;
            if (overlap > 0) {
              return { ...clip, fadeOut: overlap };
            }
            return { ...clip, fadeOut: 0 };
          });
          return { ...track, clips: final };
        }),
      }));
    },

    // ========== Clip Lock & Color ==========
    toggleClipLock: (clipId) => {
      const clip = get().tracks.flatMap(t => t.clips).find(c => c.id === clipId);
      if (!clip) return;
      const wasLocked = !!clip.locked;

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((c) =>
            c.id === clipId ? { ...c, locked: !c.locked } : c,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "TOGGLE_CLIP_LOCK",
        description: wasLocked ? "Unlock clip" : "Lock clip",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, locked: !wasLocked } : c) })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, locked: wasLocked } : c) })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setClipColor: (clipId, color) => {
      const clip = get().tracks.flatMap(t => t.clips).find(c => c.id === clipId);
      if (!clip) return;
      const oldColor = clip.color;

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((c) =>
            c.id === clipId ? { ...c, color } : c,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "SET_CLIP_COLOR",
        description: "Change clip color",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, color } : c) })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, color: oldColor } : c) })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== Piano Roll ==========
    openPianoRoll: (trackId, clipId) =>
      set({ showPianoRoll: true, pianoRollTrackId: trackId, pianoRollClipId: clipId }),
    closePianoRoll: () =>
      set({ showPianoRoll: false, pianoRollTrackId: null, pianoRollClipId: null }),
    addMIDIClip: (trackId, startTime, duration = 4) => {
      const clipId = crypto.randomUUID();
      const track = get().tracks.find((t) => t.id === trackId);
      const clipColor = track?.color || "#4361ee";

      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                midiClips: [
                  ...t.midiClips,
                  {
                    id: clipId,
                    name: `MIDI Clip ${t.midiClips.length + 1}`,
                    startTime,
                    duration,
                    events: [],
                    color: clipColor,
                  },
                ],
              }
            : t
        ),
        isModified: true,
      }));

      return clipId;
    },

    // ========== Audio Device ==========
    setAudioDeviceSetup: (setup) => set({ audioDeviceSetup: setup }),
    refreshAudioDeviceSetup: async () => {
      try {
        const response = await nativeBridge.getAudioDeviceSetup();
        // Backend returns { current: {...}, availableTypes: [...] }
        // We want to store just the 'current' part which matches AudioDeviceSetup interface
        set({ audioDeviceSetup: response.current || response });
      } catch (error) {
        console.error("Failed to refresh audio device setup:", error);
      }
    },

    // ========== Undo/Redo ==========
    undo: () => {
      if (commandManager.undo()) {
        set({
          canUndo: commandManager.canUndo(),
          canRedo: commandManager.canRedo(),
        });
      }
    },

    redo: () => {
      if (commandManager.redo()) {
        set({
          canUndo: commandManager.canUndo(),
          canRedo: commandManager.canRedo(),
        });
      }
    },

    executeCommand: (command) => {
      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    // ========== Empty Item (silent clip) ==========
    addEmptyClip: (trackId, startTime, duration) => {
      const clip: AudioClip = {
        id: crypto.randomUUID(),
        filePath: "",
        name: "(empty)",
        startTime,
        duration,
        offset: 0,
        color: "#555555",
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
      };
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: [...t.clips, clip] } : t
        ),
        isModified: true,
      }));
    },

    // ========== Lock Settings (granular) ==========
    toggleGlobalLock: () => set((state) => ({ globalLocked: !state.globalLocked })),
    setLockSetting: (key, value) =>
      set((state) => ({
        lockSettings: { ...state.lockSettings, [key]: value },
      })),

    // ========== Track Spacers ==========
    addSpacer: (afterTrackId) =>
      set((state) => ({
        spacers: [
          ...state.spacers,
          { id: crypto.randomUUID(), afterTrackId, height: 24 },
        ],
      })),
    removeSpacer: (spacerId) =>
      set((state) => ({
        spacers: state.spacers.filter((s) => s.id !== spacerId),
      })),
    setSpacerHeight: (spacerId, height) =>
      set((state) => ({
        spacers: state.spacers.map((s) =>
          s.id === spacerId ? { ...s, height: Math.max(8, Math.min(120, height)) } : s
        ),
      })),

    // ========== Recent Actions ==========
    trackRecentAction: (actionId) =>
      set((state) => ({
        recentActions: [
          actionId,
          ...state.recentActions.filter((id) => id !== actionId),
        ].slice(0, 10),
      })),

    // ========== Quantize Clips to Grid ==========
    quantizeSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;
      const gridInterval = calculateGridInterval(
        state.transport.tempo,
        state.timeSignature,
        state.gridSize,
      );

      // Capture old positions for undo
      const clipPositions = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipPositions.set(clip.id, clip.startTime);
          }
        }
      }

      // Compute new snapped positions
      const snappedPositions = new Map<string, number>();
      for (const [id, time] of clipPositions) {
        snappedPositions.set(id, Math.round(time / gridInterval) * gridInterval);
      }

      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            const snapped = snappedPositions.get(c.id);
            return snapped !== undefined ? { ...c, startTime: snapped } : c;
          }),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "QUANTIZE_CLIPS",
        description: "Quantize clips to grid",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => {
                const snapped = snappedPositions.get(c.id);
                return snapped !== undefined ? { ...c, startTime: snapped } : c;
              }),
            })),
            isModified: true,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => {
                const oldTime = clipPositions.get(c.id);
                return oldTime !== undefined ? { ...c, startTime: oldTime } : c;
              }),
            })),
            isModified: true,
          }));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== Move Envelope Points with Items ==========
    toggleMoveEnvelopesWithItems: () =>
      set((state) => ({ moveEnvelopesWithItems: !state.moveEnvelopesWithItems })),

    // ========== Screensets / Layouts ==========
    saveScreenset: (slotIndex, name) => {
      const state = get();
      const layout = {
        showMixer: state.showMixer,
        showPianoRoll: state.showPianoRoll,
        showBigClock: state.showBigClock,
        showClipProperties: state.showClipProperties,
        showUndoHistory: state.showUndoHistory,
        showRegionMarkerManager: state.showRegionMarkerManager,
        showScriptConsole: state.showScriptConsole,
        pixelsPerSecond: state.pixelsPerSecond,
        trackHeight: state.trackHeight,
        tcpWidth: state.tcpWidth,
      };
      set((s) => {
        const screensets = [...s.screensets];
        const existing = screensets.findIndex((ss) => ss.id === `screenset_${slotIndex}`);
        const entry = {
          id: `screenset_${slotIndex}`,
          name: name || `Screenset ${slotIndex + 1}`,
          layout,
        };
        if (existing >= 0) {
          screensets[existing] = entry;
        } else {
          screensets.push(entry);
        }
        localStorage.setItem("s13_screensets", JSON.stringify(screensets));
        return { screensets };
      });
    },
    loadScreenset: (slotIndex) => {
      const state = get();
      const screenset = state.screensets.find((ss) => ss.id === `screenset_${slotIndex}`);
      if (!screenset) return;
      set({
        showMixer: screenset.layout.showMixer,
        showPianoRoll: screenset.layout.showPianoRoll,
        showBigClock: screenset.layout.showBigClock,
        showClipProperties: screenset.layout.showClipProperties,
        showUndoHistory: screenset.layout.showUndoHistory,
        showRegionMarkerManager: screenset.layout.showRegionMarkerManager,
        showScriptConsole: screenset.layout.showScriptConsole ?? false,
        pixelsPerSecond: screenset.layout.pixelsPerSecond,
        trackHeight: screenset.layout.trackHeight,
        tcpWidth: screenset.layout.tcpWidth ?? 310,
      });
    },
    deleteScreenset: (slotIndex) => {
      set((s) => {
        const screensets = s.screensets.filter((ss) => ss.id !== `screenset_${slotIndex}`);
        localStorage.setItem("s13_screensets", JSON.stringify(screensets));
        return { screensets };
      });
    },

    // ========== Custom Actions (Macros) ==========
    addCustomAction: (name, steps, shortcut) => {
      set((s) => {
        const customActions = [
          ...s.customActions,
          { id: crypto.randomUUID(), name, steps, shortcut },
        ];
        localStorage.setItem("s13_customActions", JSON.stringify(customActions));
        return { customActions };
      });
    },
    removeCustomAction: (actionId) => {
      set((s) => {
        const customActions = s.customActions.filter((a) => a.id !== actionId);
        localStorage.setItem("s13_customActions", JSON.stringify(customActions));
        return { customActions };
      });
    },
    executeCustomAction: (actionId) => {
      const state = get();
      const macro = state.customActions.find((a) => a.id === actionId);
      if (!macro) return;
      // Use dynamic import to avoid circular dependency (actionRegistry imports useDAWStore)
      import("./actionRegistry").then(({ getRegisteredActions }) => {
        const actions = getRegisteredActions();
        for (const stepId of macro.steps) {
          const action = actions.find((a) => a.id === stepId);
          if (action) {
            action.execute();
          }
        }
      });
    },

    // ========== Render Queue ==========
    addToRenderQueue: (options) => {
      set((s) => ({
        renderQueue: [
          ...s.renderQueue,
          { id: crypto.randomUUID(), options, status: "pending" },
        ],
      }));
    },
    removeFromRenderQueue: (jobId) => {
      set((s) => ({
        renderQueue: s.renderQueue.filter((j) => j.id !== jobId),
      }));
    },
    clearRenderQueue: () => set({ renderQueue: [] }),
    executeRenderQueue: async () => {
      const queue = get().renderQueue.filter((j) => j.status === "pending");
      for (const job of queue) {
        set((s) => ({
          renderQueue: s.renderQueue.map((j) =>
            j.id === job.id ? { ...j, status: "rendering" as const } : j
          ),
        }));
        try {
          await get().syncClipsWithBackend();
          await nativeBridge.renderProject({
            source: job.options.source,
            startTime: job.options.startTime,
            endTime: job.options.endTime,
            filePath: `${job.options.directory}/${job.options.fileName}.${job.options.format}`,
            format: job.options.format,
            sampleRate: job.options.sampleRate,
            bitDepth: job.options.bitDepth,
            channels: job.options.channels === "mono" ? 1 : 2,
            normalize: job.options.normalize,
            addTail: job.options.addTail,
            tailLength: job.options.tailLength,
          });
          set((s) => ({
            renderQueue: s.renderQueue.map((j) =>
              j.id === job.id ? { ...j, status: "done" as const } : j
            ),
          }));
        } catch (err) {
          set((s) => ({
            renderQueue: s.renderQueue.map((j) =>
              j.id === job.id
                ? { ...j, status: "error" as const, error: String(err) }
                : j
            ),
          }));
        }
      }
    },
    toggleRenderQueue: () =>
      set((s) => ({ showRenderQueue: !s.showRenderQueue })),

    // ========== Phase 9: Audio Engine Enhancements ==========

    // 9A: Reverse Clip
    reverseClip: async (clipId: string) => {
      const state = get();
      let targetClip: AudioClip | null = null;
      let targetTrackId: string | null = null;

      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          targetClip = clip;
          targetTrackId = track.id;
          break;
        }
      }

      if (!targetClip || !targetTrackId || !targetClip.filePath) return;

      const oldFilePath = targetClip.filePath;
      const wasReversed = !!targetClip.reversed;

      const reversedPath = await nativeBridge.reverseAudioFile(targetClip.filePath);
      if (!reversedPath) return;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === targetTrackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? { ...c, filePath: reversedPath, reversed: !c.reversed }
                    : c
                ),
              }
            : t
        ),
        isModified: true,
      }));

      const capturedTrackId = targetTrackId;
      commandManager.push({
        type: "REVERSE_CLIP",
        description: "Reverse clip",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => t.id === capturedTrackId
            ? { ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, filePath: reversedPath, reversed: !wasReversed } : c) }
            : t),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => t.id === capturedTrackId
            ? { ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, filePath: oldFilePath, reversed: wasReversed } : c) }
            : t),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // 9B: Dynamic Split
    openDynamicSplit: (clipId?: string) => {
      const id = clipId || get().selectedClipId;
      if (id) {
        set({ showDynamicSplit: true, dynamicSplitClipId: id });
      }
    },
    closeDynamicSplit: () =>
      set({ showDynamicSplit: false, dynamicSplitClipId: null }),

    executeDynamicSplit: (clipId: string, transientTimes: number[]) => {
      const state = get();
      let targetTrackId: string | null = null;
      let targetClip: AudioClip | null = null;

      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          targetClip = { ...clip };
          targetTrackId = track.id;
          break;
        }
      }

      if (!targetClip || !targetTrackId) return;

      // Convert transient times (relative to file start) to absolute timeline times
      const absoluteTimes = transientTimes
        .map((t) => targetClip!.startTime + t - targetClip!.offset)
        .filter((t) => t > targetClip!.startTime && t < targetClip!.startTime + targetClip!.duration)
        .sort((a, b) => a - b);

      if (absoluteTimes.length === 0) return;

      // Create split clips from the original clip at each transient point
      const newClips: AudioClip[] = [];
      let currentStart = targetClip.startTime;
      let currentOffset = targetClip.offset;

      for (const splitTime of absoluteTimes) {
        const duration = splitTime - currentStart;
        if (duration > 0.001) {
          newClips.push({
            ...targetClip,
            id: crypto.randomUUID(),
            startTime: currentStart,
            duration,
            offset: currentOffset,
            fadeIn: currentStart === targetClip.startTime ? targetClip.fadeIn : 0,
            fadeOut: 0,
          });
        }
        currentOffset += splitTime - currentStart;
        currentStart = splitTime;
      }

      // Final segment
      const finalDuration = (targetClip.startTime + targetClip.duration) - currentStart;
      if (finalDuration > 0.001) {
        newClips.push({
          ...targetClip,
          id: crypto.randomUUID(),
          startTime: currentStart,
          duration: finalDuration,
          offset: currentOffset,
          fadeIn: 0,
          fadeOut: targetClip.fadeOut,
        });
      }

      // Replace the original clip with the split clips
      const trackId = targetTrackId;
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: [
                  ...t.clips.filter((c) => c.id !== clipId),
                  ...newClips,
                ],
              }
            : t
        ),
        showDynamicSplit: false,
        dynamicSplitClipId: null,
      }));
    },

    // 9C: Custom Metronome Sounds
    setMetronomeClickSound: async (filePath: string) => {
      const success = await nativeBridge.setMetronomeClickSound(filePath);
      if (success) set({ metronomeClickPath: filePath });
      return success;
    },
    setMetronomeAccentSound: async (filePath: string) => {
      const success = await nativeBridge.setMetronomeAccentSound(filePath);
      if (success) set({ metronomeAccentPath: filePath });
      return success;
    },
    resetMetronomeSounds: async () => {
      const success = await nativeBridge.resetMetronomeSounds();
      if (success) set({ metronomeClickPath: "", metronomeAccentPath: "" });
      return success;
    },

    // 9E: Dither
    setDitherType: (type) => set({ ditherType: type }),

    // 9F: Resample Quality
    setResampleQuality: (quality) => set({ resampleQuality: quality }),

    // ========== Phase 11: Send/Bus Routing ==========
    addTrackSend: async (sourceTrackId, destTrackId) => {
      await nativeBridge.addTrackSend(sourceTrackId, destTrackId);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: [...t.sends, { destTrackId, level: 0.5, pan: 0, enabled: true, preFader: false, phaseInvert: false }] }
            : t
        ),
      }));
    },
    removeTrackSend: async (sourceTrackId, sendIndex) => {
      await nativeBridge.removeTrackSend(sourceTrackId, sendIndex);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.filter((_, i) => i !== sendIndex) }
            : t
        ),
      }));
    },
    setTrackSendLevel: async (sourceTrackId, sendIndex, level) => {
      await nativeBridge.setTrackSendLevel(sourceTrackId, sendIndex, level);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, level } : sd) }
            : t
        ),
      }));
    },
    setTrackSendPan: async (sourceTrackId, sendIndex, pan) => {
      await nativeBridge.setTrackSendPan(sourceTrackId, sendIndex, pan);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, pan } : sd) }
            : t
        ),
      }));
    },
    setTrackSendEnabled: async (sourceTrackId, sendIndex, enabled) => {
      await nativeBridge.setTrackSendEnabled(sourceTrackId, sendIndex, enabled);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, enabled } : sd) }
            : t
        ),
      }));
    },
    setTrackSendPreFader: async (sourceTrackId, sendIndex, preFader) => {
      await nativeBridge.setTrackSendPreFader(sourceTrackId, sendIndex, preFader);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, preFader } : sd) }
            : t
        ),
      }));
    },
    setTrackSendPhaseInvert: async (sourceTrackId, sendIndex, invert) => {
      await nativeBridge.setTrackSendPhaseInvert(sourceTrackId, sendIndex, invert);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, phaseInvert: invert } : sd) }
            : t
        ),
      }));
    },
    setTrackPhaseInvert: async (trackId, invert) => {
      await nativeBridge.setTrackPhaseInvert(trackId, invert);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, phaseInverted: invert } : t),
      }));
    },
    setTrackStereoWidth: async (trackId, widthPercent) => {
      await nativeBridge.setTrackStereoWidth(trackId, widthPercent);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, stereoWidth: widthPercent } : t),
      }));
    },
    setTrackMasterSendEnabled: async (trackId, enabled) => {
      await nativeBridge.setTrackMasterSendEnabled(trackId, enabled);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, masterSendEnabled: enabled } : t),
      }));
    },
    setTrackOutputChannels: async (trackId, startChannel, numChannels) => {
      await nativeBridge.setTrackOutputChannels(trackId, startChannel, numChannels);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, outputStartChannel: startChannel, outputChannelCount: numChannels } : t),
      }));
    },
    setTrackPlaybackOffset: async (trackId, offsetMs) => {
      await nativeBridge.setTrackPlaybackOffset(trackId, offsetMs);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, playbackOffsetMs: offsetMs } : t),
      }));
    },
    setTrackChannelCount: async (trackId, numChannels) => {
      await nativeBridge.setTrackChannelCount(trackId, numChannels);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, trackChannelCount: numChannels } : t),
      }));
    },
    setTrackMIDIOutput: async (trackId, deviceName) => {
      await nativeBridge.setTrackMIDIOutput(trackId, deviceName);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, midiOutputDevice: deviceName } : t),
      }));
    },

    // Phase 11B: Routing Matrix
    toggleRoutingMatrix: () => set((s) => ({ showRoutingMatrix: !s.showRoutingMatrix })),

    // Phase 11C: Track Groups (VCA)
    addTrackGroup: (name, leadTrackId, memberTrackIds, linkedParams) => {
      set((s) => ({
        trackGroups: [...s.trackGroups, { id: crypto.randomUUID(), name, leadTrackId, memberTrackIds, linkedParams }],
      }));
    },
    removeTrackGroup: (groupId) => {
      set((s) => ({ trackGroups: s.trackGroups.filter((g) => g.id !== groupId) }));
    },
    updateTrackGroup: (groupId, updates) => {
      set((s) => ({
        trackGroups: s.trackGroups.map((g) => g.id === groupId ? { ...g, ...updates } : g),
      }));
    },

    // ========== Phase 10: Render Pipeline Expansion ==========
    selectRegion: (id, modifiers) => {
      set((s) => {
        if (modifiers?.ctrl) {
          const isSelected = s.selectedRegionIds.includes(id);
          return {
            selectedRegionIds: isSelected
              ? s.selectedRegionIds.filter((rid) => rid !== id)
              : [...s.selectedRegionIds, id],
          };
        }
        return { selectedRegionIds: [id] };
      });
    },
    deselectAllRegions: () => set({ selectedRegionIds: [] }),
    setRenderMetadata: (metadata) =>
      set((s) => ({ renderMetadata: { ...s.renderMetadata, ...metadata } })),
    setSecondaryOutputEnabled: (enabled) =>
      set({ secondaryOutputEnabled: enabled }),
    setSecondaryOutputFormat: (format) =>
      set({ secondaryOutputFormat: format }),
    setSecondaryOutputBitDepth: (bitDepth) =>
      set({ secondaryOutputBitDepth: bitDepth }),
    setOnlineRender: (enabled) => set({ onlineRender: enabled }),
    setAddToProjectAfterRender: (enabled) =>
      set({ addToProjectAfterRender: enabled }),
    toggleRegionRenderMatrix: () =>
      set((s) => ({ showRegionRenderMatrix: !s.showRegionRenderMatrix })),

    // ===== Phase 12: Media & File Management =====
    toggleMediaExplorer: () =>
      set((s) => ({ showMediaExplorer: !s.showMediaExplorer })),
    setMediaExplorerPath: (path) => set({ mediaExplorerPath: path }),
    addMediaExplorerRecentPath: (path) =>
      set((s) => {
        const recent = [path, ...s.mediaExplorerRecentPaths.filter((p) => p !== path)].slice(0, 10);
        return { mediaExplorerRecentPaths: recent };
      }),
    toggleCleanProject: () =>
      set((s) => ({ showCleanProject: !s.showCleanProject })),
    toggleBatchConverter: () =>
      set((s) => ({ showBatchConverter: !s.showBatchConverter })),
    exportProjectMIDI: async () => {
      const state = get();
      const midiTracks = state.tracks
        .filter((t) => (t.type === "midi" || t.type === "instrument") && t.midiClips.length > 0)
        .map((t) => ({
          name: t.name,
          clips: t.midiClips.map((c) => ({
            startTime: c.startTime,
            duration: c.duration,
            events: c.events,
          })),
        }));
      if (midiTracks.length === 0) return false;
      const filePath = await nativeBridge.showSaveDialog(undefined, "Export Project MIDI");
      if (!filePath) return false;
      return await nativeBridge.exportProjectMIDI(filePath, midiTracks);
    },
    consolidateTrack: async (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track || track.clips.length === 0) return null;
      const earliest = Math.min(...track.clips.map((c) => c.startTime));
      const latest = Math.max(...track.clips.map((c) => c.startTime + c.duration));
      const fileName = `${track.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_consolidated.wav`;
      const filePath = await nativeBridge.showRenderSaveDialog(fileName, "wav");
      if (!filePath) return null;
      const success = await nativeBridge.renderProject({
        source: `stem:${trackId}`,
        startTime: earliest,
        endTime: latest,
        filePath,
        format: "wav",
        sampleRate: state.projectSampleRate || 44100,
        bitDepth: state.projectBitDepth || 24,
        channels: 2,
        normalize: false,
        addTail: false,
        tailLength: 0,
      });
      if (success) {
        // Replace track clips with single consolidated clip
        const clipIds = track.clips.map((c) => c.id);
        clipIds.forEach((id) => state.deleteClip(id));
        state.addClip(trackId, {
          id: crypto.randomUUID(),
          filePath,
          name: `${track.name} (consolidated)`,
          startTime: earliest,
          duration: latest - earliest,
          offset: 0,
          color: track.color,
          volumeDB: 0,
          fadeIn: 0,
          fadeOut: 0,
        });
        return filePath;
      }
      return null;
    },

    renderClipInPlace: async (clipId) => {
      const state = get();
      // Find the clip and its track
      let sourceClip: AudioClip | null = null;
      let sourceTrack: Track | null = null;
      let sourceTrackIndex = -1;
      for (let i = 0; i < state.tracks.length; i++) {
        const clip = state.tracks[i].clips.find((c) => c.id === clipId);
        if (clip) {
          sourceClip = clip;
          sourceTrack = state.tracks[i];
          sourceTrackIndex = i;
          break;
        }
      }
      if (!sourceClip || !sourceTrack) return;

      const startTime = sourceClip.startTime;
      const endTime = sourceClip.startTime + sourceClip.duration;
      const safeName = sourceClip.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = await nativeBridge.showRenderSaveDialog(`${safeName}_rendered.wav`, "wav");
      if (!filePath) return;

      const success = await nativeBridge.renderProject({
        source: `stem:${sourceTrack.id}`,
        startTime,
        endTime,
        filePath,
        format: "wav",
        sampleRate: state.projectSampleRate || 44100,
        bitDepth: state.projectBitDepth || 24,
        channels: 2,
        normalize: false,
        addTail: true,
        tailLength: 1000,
      });
      if (!success) return;

      // Import rendered file for accurate duration
      const mediaInfo = await nativeBridge.importMediaFile(filePath);
      const renderedDuration = mediaInfo?.duration || (endTime - startTime);

      // Create new track below source
      const newTrackId = crypto.randomUUID();
      get().addTrack({ id: newTrackId, name: `${sourceTrack.name} (Rendered)`, type: "audio", color: sourceTrack.color });

      // Move new track to right below source track
      set((s) => {
        const tracks = [...s.tracks];
        const newIdx = tracks.findIndex((t) => t.id === newTrackId);
        if (newIdx !== -1) {
          const [moved] = tracks.splice(newIdx, 1);
          tracks.splice(sourceTrackIndex + 1, 0, moved);
        }
        return { tracks };
      });
      nativeBridge.reorderTrack(newTrackId, sourceTrackIndex + 1).catch(() => {});

      // Add rendered clip to new track
      get().addClip(newTrackId, {
        id: crypto.randomUUID(),
        filePath,
        name: `${sourceClip.name} (Rendered)`,
        startTime,
        duration: renderedDuration,
        offset: 0,
        color: sourceTrack.color,
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        sampleRate: mediaInfo?.sampleRate,
        sourceLength: renderedDuration,
      });

      // Mute the original clip
      get().toggleClipMute(clipId);
    },

    renderTrackInPlace: async (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track || track.clips.length === 0) return;

      const sourceTrackIndex = state.tracks.findIndex((t) => t.id === trackId);
      const earliest = Math.min(...track.clips.map((c) => c.startTime));
      const latest = Math.max(...track.clips.map((c) => c.startTime + c.duration));
      const safeName = track.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = await nativeBridge.showRenderSaveDialog(`${safeName}_rendered.wav`, "wav");
      if (!filePath) return;

      const success = await nativeBridge.renderProject({
        source: `stem:${trackId}`,
        startTime: earliest,
        endTime: latest,
        filePath,
        format: "wav",
        sampleRate: state.projectSampleRate || 44100,
        bitDepth: state.projectBitDepth || 24,
        channels: 2,
        normalize: false,
        addTail: true,
        tailLength: 1000,
      });
      if (!success) return;

      const mediaInfo = await nativeBridge.importMediaFile(filePath);
      const renderedDuration = mediaInfo?.duration || (latest - earliest);

      // Create new track below source
      const newTrackId = crypto.randomUUID();
      get().addTrack({ id: newTrackId, name: `${track.name} (Rendered)`, type: "audio", color: track.color });

      set((s) => {
        const tracks = [...s.tracks];
        const newIdx = tracks.findIndex((t) => t.id === newTrackId);
        if (newIdx !== -1) {
          const [moved] = tracks.splice(newIdx, 1);
          tracks.splice(sourceTrackIndex + 1, 0, moved);
        }
        return { tracks };
      });
      nativeBridge.reorderTrack(newTrackId, sourceTrackIndex + 1).catch(() => {});

      get().addClip(newTrackId, {
        id: crypto.randomUUID(),
        filePath,
        name: `${track.name} (Rendered)`,
        startTime: earliest,
        duration: renderedDuration,
        offset: 0,
        color: track.color,
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        sampleRate: mediaInfo?.sampleRate,
        sourceLength: renderedDuration,
      });

      // Mute the original track
      if (!track.muted) {
        get().toggleTrackMute(trackId);
      }
    },

    // ===== Phase 13: Advanced Editing =====
    setClipFadeInShape: (clipId, shape) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, fadeInShape: shape } : c,
          ),
        })),
      }));
    },
    setClipFadeOutShape: (clipId, shape) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, fadeOutShape: shape } : c,
          ),
        })),
      }));
    },
    openCrossfadeEditor: (clipId1, clipId2) =>
      set({ showCrossfadeEditor: true, crossfadeEditorClipIds: [clipId1, clipId2] }),
    closeCrossfadeEditor: () =>
      set({ showCrossfadeEditor: false, crossfadeEditorClipIds: null }),

    addClipTake: (clipId, take) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== clipId) return c;
            const takes = c.takes ? [...c.takes, take] : [take];
            return { ...c, takes, activeTakeIndex: takes.length - 1 };
          }),
        })),
      }));
    },
    setActiveClipTake: (clipId, takeIndex) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== clipId || !c.takes) return c;
            if (takeIndex < 0 || takeIndex >= c.takes.length) return c;
            const activeTake = c.takes[takeIndex];
            // Swap: current clip becomes a take, selected take becomes active
            const currentAsClip: AudioClip = { ...c, takes: undefined, activeTakeIndex: undefined };
            const newTakes = c.takes.map((tk, i) => (i === takeIndex ? currentAsClip : tk));
            return { ...activeTake, id: c.id, takes: newTakes, activeTakeIndex: takeIndex, startTime: c.startTime };
          }),
        })),
      }));
      // Re-sync backend since the active clip's audio changed
      if (get().transport.isPlaying) get().syncClipsWithBackend();
    },
    explodeTakes: (clipId) => {
      const state = get();
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip?.takes && clip.takes.length > 0) {
          // Create a new track for each take
          clip.takes.forEach((take, i) => {
            const newTrackId = crypto.randomUUID();
            state.addTrack({
              id: newTrackId,
              name: `${track.name} - Take ${i + 1}`,
              type: track.type,
            });
            state.addClip(newTrackId, {
              ...take,
              id: crypto.randomUUID(),
              startTime: clip.startTime,
              takes: undefined,
              activeTakeIndex: undefined,
            });
          });
          // Remove takes from original clip
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? { ...c, takes: undefined, activeTakeIndex: undefined } : c,
              ),
            })),
          }));
          break;
        }
      }
    },
    implodeTakes: (clipIds) => {
      if (clipIds.length < 2) return;
      const state = get();
      // Find all clips and their tracks
      const clipInfos: Array<{ clip: AudioClip; trackId: string }> = [];
      for (const cid of clipIds) {
        for (const track of state.tracks) {
          const clip = track.clips.find((c) => c.id === cid);
          if (clip) {
            clipInfos.push({ clip, trackId: track.id });
            break;
          }
        }
      }
      if (clipInfos.length < 2) return;
      // First clip becomes the main, rest become takes
      const main = clipInfos[0];
      const takes = clipInfos.slice(1).map((ci) => ({ ...ci.clip, takes: undefined, activeTakeIndex: undefined }));
      // Remove all but the first clip
      clipInfos.slice(1).forEach((ci) => state.deleteClip(ci.clip.id));
      // Update main clip with takes
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === main.clip.id ? { ...c, takes, activeTakeIndex: 0 } : c,
          ),
        })),
      }));
    },

    setClipPlaybackRate: async (clipId, rate) => {
      const state = get();
      let clip: AudioClip | undefined;
      let trackId: string | undefined;
      for (const track of state.tracks) {
        const found = track.clips.find((c) => c.id === clipId);
        if (found) { clip = found; trackId = track.id; break; }
      }
      if (!clip || !trackId) return;
      if (rate <= 0 || Math.abs(rate - 1.0) < 0.0001) {
        // Reset to original if rate ~1.0
        if (clip.originalFilePath && clip.originalFilePath !== clip.filePath) {
          const origPath = clip.originalFilePath;
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? { ...c, playbackRate: 1.0, filePath: origPath, originalFilePath: undefined } : c,
              ),
            })),
          }));
        }
        return;
      }

      // Snapshot for undo
      const oldClip = { ...clip };
      const sourceFile = clip.originalFilePath || clip.filePath;

      // Call backend to process
      const result = await nativeBridge.timeStretchClip(sourceFile, rate);
      if (!result.success || !result.filePath) return;

      const newDuration = result.duration || clip.duration / rate;
      const newSampleRate = result.sampleRate || clip.sampleRate;

      const command: Command = {
        type: "TIME_STRETCH_CLIP",
        description: `Time stretch clip to ${rate}x`,
        timestamp: Date.now(),
        execute: async () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? {
                  ...c,
                  playbackRate: rate,
                  filePath: result.filePath!,
                  originalFilePath: sourceFile,
                  duration: newDuration,
                  sampleRate: newSampleRate,
                  offset: 0,
                } : c,
              ),
            })),
          }));
        },
        undo: async () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? {
                  ...c,
                  playbackRate: oldClip.playbackRate,
                  filePath: oldClip.filePath,
                  originalFilePath: oldClip.originalFilePath,
                  duration: oldClip.duration,
                  sampleRate: oldClip.sampleRate,
                  offset: oldClip.offset,
                } : c,
              ),
            })),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    setClipPitch: async (clipId, semitones) => {
      const state = get();
      let clip: AudioClip | undefined;
      let trackId: string | undefined;
      for (const track of state.tracks) {
        const found = track.clips.find((c) => c.id === clipId);
        if (found) { clip = found; trackId = track.id; break; }
      }
      if (!clip || !trackId) return;
      if (Math.abs(semitones) < 0.01) {
        // Reset to original if ~0 semitones
        if (clip.originalFilePath && clip.originalFilePath !== clip.filePath) {
          const origPath = clip.originalFilePath;
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? { ...c, pitchSemitones: 0, filePath: origPath, originalFilePath: undefined } : c,
              ),
            })),
          }));
        }
        return;
      }

      // Snapshot for undo
      const oldClip = { ...clip };
      const sourceFile = clip.originalFilePath || clip.filePath;

      // Call backend to process
      const result = await nativeBridge.pitchShiftClip(sourceFile, semitones);
      if (!result.success || !result.filePath) return;

      const command: Command = {
        type: "PITCH_SHIFT_CLIP",
        description: `Pitch shift clip by ${semitones} semitones`,
        timestamp: Date.now(),
        execute: async () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? {
                  ...c,
                  pitchSemitones: semitones,
                  filePath: result.filePath!,
                  originalFilePath: sourceFile,
                  sampleRate: result.sampleRate || c.sampleRate,
                } : c,
              ),
            })),
          }));
        },
        undo: async () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? {
                  ...c,
                  pitchSemitones: oldClip.pitchSemitones,
                  filePath: oldClip.filePath,
                  originalFilePath: oldClip.originalFilePath,
                  sampleRate: oldClip.sampleRate,
                } : c,
              ),
            })),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleFreePositioning: () =>
      set((s) => ({ freePositioning: !s.freePositioning })),
    setClipFreeY: (clipId, freeY) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, freeY } : c,
          ),
        })),
      }));
    },

    // Phase 14: Theming & Customization
    setTheme: (themeName) => {
      set({ theme: themeName, customThemeOverrides: {} });
      applyTheme(themeName, {});
    },
    setCustomThemeOverride: (property, value) => {
      set((s) => {
        const newOverrides = { ...s.customThemeOverrides, [property]: value };
        applyTheme(s.theme, newOverrides);
        return { customThemeOverrides: newOverrides };
      });
    },
    clearCustomThemeOverrides: () => {
      const theme = get().theme;
      set({ customThemeOverrides: {} });
      applyTheme(theme, {});
    },
    toggleThemeEditor: () =>
      set((s) => ({ showThemeEditor: !s.showThemeEditor })),
    setMouseModifier: (context, modifiers, action) => {
      set((s) => ({
        mouseModifiers: {
          ...s.mouseModifiers,
          [context]: { ...s.mouseModifiers[context], [modifiers]: action },
        },
      }));
    },
    resetMouseModifiers: () => {
      set({
        mouseModifiers: {
          clip_drag: { none: "move", ctrl: "copy", shift: "constrain", alt: "bypass_snap" },
          clip_resize: { none: "resize", ctrl: "fine", shift: "symmetric", alt: "stretch" },
          timeline_click: { none: "seek", ctrl: "select_range", shift: "extend_selection", alt: "zoom" },
          track_header: { none: "select", ctrl: "toggle_select", shift: "range_select", alt: "solo" },
          automation_point: { none: "move", ctrl: "fine", shift: "constrain_y", alt: "delete" },
          fade_handle: { none: "adjust", ctrl: "fine", shift: "symmetric", alt: "shape_cycle" },
          ruler_click: { none: "seek", ctrl: "loop_set", shift: "time_select", alt: "zoom_to" },
        },
      });
    },
    setPanelPosition: (panelId, position) => {
      set((s) => ({
        panelPositions: {
          ...s.panelPositions,
          [panelId]: { ...s.panelPositions[panelId], ...position },
        },
      }));
    },
    togglePanelDock: (panelId, dock) => {
      set((s) => ({
        panelPositions: {
          ...s.panelPositions,
          [panelId]: { ...s.panelPositions[panelId], dock },
        },
      }));
    },

    // Phase 15: Platform & Extensibility
    toggleVideoWindow: () =>
      set((s) => ({ showVideoWindow: !s.showVideoWindow })),
    openVideoFile: async (filePath) => {
      try {
        const info = await nativeBridge.openVideoFile(filePath);
        set({ videoFilePath: filePath, videoInfo: info, showVideoWindow: true });
      } catch (err) {
        console.error("[Store] Failed to open video:", err);
      }
    },
    closeVideoFile: () => {
      nativeBridge.closeVideoFile();
      set({ videoFilePath: "", videoInfo: null });
    },
    toggleScriptEditor: () =>
      set((s) => ({ showScriptEditor: !s.showScriptEditor })),
    openPitchEditor: (trackId, clipId, fxIndex) => {
      set({ showPitchEditor: true, pitchEditorTrackId: trackId, pitchEditorClipId: clipId, pitchEditorFxIndex: fxIndex });
      usePitchEditorStore.getState().open(trackId, clipId, fxIndex);
    },
    closePitchEditor: () => {
      set({ showPitchEditor: false, pitchEditorTrackId: null, pitchEditorClipId: null });
      usePitchEditorStore.getState().close();
    },
    setLowerZoneHeight: (h) => set({ lowerZoneHeight: Math.max(150, Math.min(600, h)) }),
    executeScript: async (code) => {
      try {
        const result = await nativeBridge.executeScript(code);
        get().appendScriptConsole(`> ${result.result || "OK"}`);
        if (result.error) get().appendScriptConsole(`Error: ${result.error}`);
      } catch (err) {
        get().appendScriptConsole(`Error: ${err}`);
      }
    },
    addUserScript: (name, code) => {
      set((s) => ({
        userScripts: [...s.userScripts, { id: crypto.randomUUID(), name, code }],
      }));
    },
    removeUserScript: (scriptId) => {
      set((s) => ({
        userScripts: s.userScripts.filter((sc) => sc.id !== scriptId),
      }));
    },
    appendScriptConsole: (line) => {
      set((s) => ({
        scriptConsoleOutput: [...s.scriptConsoleOutput.slice(-199), line],
      }));
    },
    clearScriptConsole: () => set({ scriptConsoleOutput: [] }),
    addProjectTab: (name) => {
      const id = crypto.randomUUID();
      set((s) => ({
        projectTabs: [
          ...s.projectTabs.map((t) => ({ ...t, isActive: false })),
          { id, name: name || `Project ${s.projectTabs.length + 1}`, isActive: true },
        ],
        activeTabId: id,
      }));
    },
    closeProjectTab: (tabId) => {
      set((s) => {
        const remaining = s.projectTabs.filter((t) => t.id !== tabId);
        if (remaining.length === 0) return s; // Can't close last tab
        const needsNewActive = s.activeTabId === tabId;
        return {
          projectTabs: needsNewActive
            ? remaining.map((t, i) => ({ ...t, isActive: i === remaining.length - 1 }))
            : remaining,
          activeTabId: needsNewActive ? remaining[remaining.length - 1].id : s.activeTabId,
        };
      });
    },
    switchProjectTab: (tabId) => {
      set((s) => ({
        projectTabs: s.projectTabs.map((t) => ({ ...t, isActive: t.id === tabId })),
        activeTabId: tabId,
      }));
    },
    addCustomToolbar: (name) => {
      set((s) => ({
        customToolbars: [...s.customToolbars, { id: crypto.randomUUID(), name, visible: true, buttons: [] }],
      }));
    },
    removeCustomToolbar: (toolbarId) => {
      set((s) => ({
        customToolbars: s.customToolbars.filter((t) => t.id !== toolbarId),
      }));
    },
    addToolbarButton: (toolbarId, actionId, icon, label) => {
      set((s) => ({
        customToolbars: s.customToolbars.map((t) =>
          t.id === toolbarId
            ? { ...t, buttons: [...t.buttons, { actionId, icon, label }] }
            : t,
        ),
      }));
    },
    removeToolbarButton: (toolbarId, buttonIndex) => {
      set((s) => ({
        customToolbars: s.customToolbars.map((t) =>
          t.id === toolbarId
            ? { ...t, buttons: t.buttons.filter((_, i) => i !== buttonIndex) }
            : t,
        ),
      }));
    },
    toggleToolbarVisibility: (toolbarId) => {
      set((s) => ({
        customToolbars: s.customToolbars.map((t) =>
          t.id === toolbarId ? { ...t, visible: !t.visible } : t,
        ),
      }));
    },
    toggleToolbarEditor: () =>
      set((s) => ({ showToolbarEditor: !s.showToolbarEditor })),
    setLTCEnabled: async (enabled) => {
      try {
        await nativeBridge.setLTCOutput(enabled, get().ltcOutputChannel, get().ltcFrameRate);
        set({ ltcEnabled: enabled });
      } catch (err) {
        console.error("[Store] Failed to set LTC:", err);
      }
    },
    setLTCOutputChannel: (channel) => set({ ltcOutputChannel: channel }),
    setLTCFrameRate: (rate) => set({ ltcFrameRate: rate }),

    // Phase 16: Pro Audio & Compatibility
    setTrackChannelFormat: (trackId, format) => {
      set((s) => ({
        trackChannelFormats: { ...s.trackChannelFormats, [trackId]: format },
      }));
    },
    setMasterChannelFormat: (format) => set({ masterChannelFormat: format }),
    togglePluginBridge: () =>
      set((s) => ({ pluginBridgeEnabled: !s.pluginBridgeEnabled })),
    startLiveCapture: async () => {
      try {
        const filePath = await nativeBridge.startLiveCapture("wav");
        set({ liveCaptureEnabled: true, liveCaptureFilePath: filePath, liveCaptureDuration: 0 });
      } catch (err) {
        console.error("[Store] Failed to start live capture:", err);
      }
    },
    stopLiveCapture: async () => {
      try {
        const result = await nativeBridge.stopLiveCapture();
        set({ liveCaptureEnabled: false, liveCaptureDuration: result.duration });
      } catch (err) {
        console.error("[Store] Failed to stop live capture:", err);
      }
    },
    toggleDDPExport: () =>
      set((s) => ({ showDDPExport: !s.showDDPExport })),
    exportDDP: async (sourceWavPath, outputDir, catalogNumber) => {
      try {
        const regions = get().regions;
        // Convert regions to DDP track format: { startTime, endTime, title, isrc }
        const tracks = regions.map((r: any) => ({
          startTime: r.startTime ?? r.time ?? 0,
          endTime: r.endTime ?? (r.time + (r.duration ?? 0)),
          title: r.name ?? r.label ?? "",
          isrc: r.isrc ?? "",
        }));
        return await nativeBridge.exportDDP(sourceWavPath, outputDir, tracks, catalogNumber);
      } catch (err) {
        console.error("[Store] Failed to export DDP:", err);
        return false;
      }
    },

    // ========== Phase 4.2: Step Sequencer ==========
    toggleStep: (pitch, step) => {
      const s = get();
      const oldSteps = s.stepSequencer.steps;
      const oldValue = oldSteps[pitch]?.[step] ?? false;
      const newValue = !oldValue;

      // Build new steps array
      const newSteps = oldSteps.map((row, r) =>
        r === pitch ? row.map((v, c) => (c === step ? newValue : v)) : row,
      );

      set({
        stepSequencer: { ...s.stepSequencer, steps: newSteps },
        isModified: true,
      });

      // Undo support
      const undoSteps = oldSteps;
      commandManager.push({
        type: "step_sequencer_toggle",
        description: `Toggle step [${pitch}, ${step}] ${newValue ? "on" : "off"}`,
        timestamp: Date.now(),
        execute: () => set({ stepSequencer: { ...get().stepSequencer, steps: newSteps } }),
        undo: () => set({ stepSequencer: { ...get().stepSequencer, steps: undoSteps } }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setStepVelocity: (pitch, step, velocity) => {
      const s = get();
      const newVelocities = s.stepSequencer.velocities.map((row, r) =>
        r === pitch ? row.map((v, c) => (c === step ? Math.max(0, Math.min(127, velocity)) : v)) : row,
      );
      set({ stepSequencer: { ...s.stepSequencer, velocities: newVelocities } });
    },

    setStepCount: (count) => {
      const clamped = Math.max(4, Math.min(64, count));
      const s = get();
      const { steps, velocities, pitchCount } = s.stepSequencer;

      // Resize each row to the new step count
      const newSteps = Array.from({ length: pitchCount }, (_, r) => {
        const existing = steps[r] || [];
        return Array.from({ length: clamped }, (_, c) => existing[c] ?? false);
      });
      const newVelocities = Array.from({ length: pitchCount }, (_, r) => {
        const existing = velocities[r] || [];
        return Array.from({ length: clamped }, (_, c) => existing[c] ?? 100);
      });

      set({
        stepSequencer: { ...s.stepSequencer, stepCount: clamped, steps: newSteps, velocities: newVelocities },
      });
    },

    setStepSize: (size) => {
      set((s) => ({
        stepSequencer: { ...s.stepSequencer, stepSize: size },
      }));
    },

    clearStepSequencer: () => {
      const s = get();
      const oldSteps = s.stepSequencer.steps;
      const oldVelocities = s.stepSequencer.velocities;
      const { stepCount, pitchCount } = s.stepSequencer;

      const emptySteps = Array.from({ length: pitchCount }, () => Array(stepCount).fill(false));
      const defaultVelocities = Array.from({ length: pitchCount }, () => Array(stepCount).fill(100));

      set({
        stepSequencer: { ...s.stepSequencer, steps: emptySteps, velocities: defaultVelocities },
        isModified: true,
      });

      // Undo support
      commandManager.push({
        type: "step_sequencer_clear",
        description: "Clear step sequencer",
        timestamp: Date.now(),
        execute: () => set({ stepSequencer: { ...get().stepSequencer, steps: emptySteps, velocities: defaultVelocities } }),
        undo: () => set({ stepSequencer: { ...get().stepSequencer, steps: oldSteps, velocities: oldVelocities } }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    generateMIDIClipFromSteps: () => {
      const s = get();
      const { steps, velocities, stepCount, stepSize, pitchCount } = s.stepSequencer;
      const tempo = s.transport.tempo;

      // Calculate step duration in seconds
      let beatsPerStep = 0.25; // default 1/16
      if (stepSize === "1/8") beatsPerStep = 0.5;
      else if (stepSize === "1/4") beatsPerStep = 1;
      else if (stepSize === "1/16") beatsPerStep = 0.25;
      const stepDurationSec = (60 / tempo) * beatsPerStep;

      // Generate MIDI events from the step grid
      const events: MIDIEvent[] = [];
      const basePitch = 60 - Math.floor(pitchCount / 2); // Center around middle C

      for (let row = 0; row < pitchCount; row++) {
        for (let col = 0; col < stepCount; col++) {
          if (steps[row]?.[col]) {
            const time = col * stepDurationSec;
            const note = basePitch + (pitchCount - 1 - row); // Bottom row = lowest pitch
            const vel = velocities[row]?.[col] ?? 100;

            events.push({
              timestamp: time,
              type: "noteOn",
              note,
              velocity: vel,
            });
            events.push({
              timestamp: time + stepDurationSec * 0.9, // 90% gate
              type: "noteOff",
              note,
              velocity: 0,
            });
          }
        }
      }

      const totalDuration = stepCount * stepDurationSec;
      console.log(
        `[StepSequencer] Generated ${events.length} MIDI events, duration: ${totalDuration.toFixed(2)}s`,
        events,
      );

      // If a MIDI track is selected, add the clip to it
      const selectedTrackId = s.selectedTrackId;
      if (selectedTrackId) {
        const track = s.tracks.find((t) => t.id === selectedTrackId);
        if (track && (track.type === "midi" || track.type === "instrument")) {
          const clipId = crypto.randomUUID();
          const midiClip: MIDIClip = {
            id: clipId,
            name: "Step Pattern",
            startTime: s.transport.currentTime,
            duration: totalDuration,
            events,
            color: track.color || "#4361ee",
          };

          const newMidiClips = [...(track.midiClips || []), midiClip];
          set({
            tracks: s.tracks.map((t) =>
              t.id === selectedTrackId ? { ...t, midiClips: newMidiClips } : t,
            ),
            isModified: true,
          });

          commandManager.push({
            type: "step_sequencer_generate",
            description: "Generate MIDI clip from step sequencer",
            timestamp: Date.now(),
            execute: () => set({
              tracks: get().tracks.map((t) =>
                t.id === selectedTrackId ? { ...t, midiClips: [...(t.midiClips || []), midiClip] } : t,
              ),
            }),
            undo: () => set({
              tracks: get().tracks.map((t) =>
                t.id === selectedTrackId ? { ...t, midiClips: (t.midiClips || []).filter((c) => c.id !== clipId) } : t,
              ),
            }),
          });
          set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        }
      }
    },

    toggleStepSequencer: () =>
      set((s) => ({ showStepSequencer: !s.showStepSequencer })),

    // ========== Phase 4.1: Clip Launcher ==========
    triggerSlot: (trackIndex, slotIndex) => {
      nativeBridge.triggerSlot(trackIndex, slotIndex).catch((err) => {
        console.error("[Store] Failed to trigger slot:", err);
      });

      // Optimistically update local state
      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots, ti) =>
          trackSlots.map((slot, si) => {
            if (ti === trackIndex && si === slotIndex) {
              return { ...slot, isPlaying: true, isQueued: false };
            }
            // Stop other slots on the same track
            if (ti === trackIndex && si !== slotIndex && slot.isPlaying) {
              return { ...slot, isPlaying: false, isQueued: false };
            }
            return slot;
          }),
        );
        return { clipLauncher: { ...s.clipLauncher, slots } };
      });
    },

    stopSlot: (trackIndex, slotIndex) => {
      nativeBridge.stopSlot(trackIndex, slotIndex).catch((err) => {
        console.error("[Store] Failed to stop slot:", err);
      });

      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots, ti) =>
          trackSlots.map((slot, si) =>
            ti === trackIndex && si === slotIndex
              ? { ...slot, isPlaying: false, isQueued: false }
              : slot,
          ),
        );
        return { clipLauncher: { ...s.clipLauncher, slots } };
      });
    },

    triggerScene: (slotIndex) => {
      nativeBridge.triggerScene(slotIndex).catch((err) => {
        console.error("[Store] Failed to trigger scene:", err);
      });

      // Trigger all slots in this row
      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots) =>
          trackSlots.map((slot, si) => {
            if (si === slotIndex && slot.filePath) {
              return { ...slot, isPlaying: true, isQueued: false };
            }
            if (si !== slotIndex && slot.isPlaying) {
              return { ...slot, isPlaying: false };
            }
            return slot;
          }),
        );
        return { clipLauncher: { ...s.clipLauncher, slots } };
      });
    },

    stopAllSlots: () => {
      nativeBridge.stopAllSlots().catch((err) => {
        console.error("[Store] Failed to stop all slots:", err);
      });

      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots) =>
          trackSlots.map((slot) => ({ ...slot, isPlaying: false, isQueued: false })),
        );
        return { clipLauncher: { ...s.clipLauncher, slots } };
      });
    },

    setSlotClip: (trackIndex, slotIndex, filePath, name, duration) => {
      nativeBridge.setSlotClip(trackIndex, slotIndex, filePath, duration).catch((err) => {
        console.error("[Store] Failed to set slot clip:", err);
      });

      set((s) => {
        // Ensure the slots array is large enough
        const numTracks = Math.max(s.clipLauncher.numTracks, trackIndex + 1);
        const numSlots = Math.max(s.clipLauncher.numSlots, slotIndex + 1);
        const slots = Array.from({ length: numTracks }, (_, ti) =>
          Array.from({ length: numSlots }, (_, si) => {
            const existing = s.clipLauncher.slots[ti]?.[si] || {};
            if (ti === trackIndex && si === slotIndex) {
              return { ...existing, filePath, name, duration, isPlaying: false, isQueued: false };
            }
            return existing;
          }),
        );
        return {
          clipLauncher: { ...s.clipLauncher, slots, numTracks, numSlots },
          isModified: true,
        };
      });
    },

    clearSlot: (trackIndex, slotIndex) => {
      nativeBridge.clearSlot(trackIndex, slotIndex).catch((err) => {
        console.error("[Store] Failed to clear slot:", err);
      });

      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots, ti) =>
          trackSlots.map((slot, si) =>
            ti === trackIndex && si === slotIndex
              ? { isPlaying: false, isQueued: false }
              : slot,
          ),
        );
        return { clipLauncher: { ...s.clipLauncher, slots }, isModified: true };
      });
    },

    setClipLauncherQuantize: (quantize) => {
      set((s) => ({
        clipLauncher: { ...s.clipLauncher, quantize },
      }));
    },

    toggleClipLauncher: () =>
      set((s) => ({ showClipLauncher: !s.showClipLauncher })),

    toggleTimecodeSettings: () =>
      set((s) => ({ showTimecodeSettings: !s.showTimecodeSettings })),

    // Missing Media Resolver
    resolveMissingMedia: (originalPath: string, newPath: string) => {
      // Update all clips that reference the original path
      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.filePath === originalPath ? { ...clip, filePath: newPath } : clip,
          ),
        })),
        isModified: true,
      }));
    },
    closeMissingMedia: () => set({ showMissingMedia: false, missingMediaFiles: [] }),

    // Sprint 17: Visual Improvements
    addRecentColor: (color) => {
      set((s) => {
        const filtered = s.recentColors.filter((c) => c !== color);
        return { recentColors: [color, ...filtered].slice(0, 8) };
      });
    },

    // Sprint 18: Interaction/Workflow
    toggleAutoScroll: () =>
      set((s) => ({ autoScrollDuringPlayback: !s.autoScrollDuringPlayback })),

    zoomToSelection: () => {
      const { timeSelection } = get();
      if (!timeSelection) return;
      const duration = timeSelection.end - timeSelection.start;
      if (duration <= 0) return;
      // Fit selection into ~80% of viewport
      const viewportWidth = document.querySelector("[data-workspace]")?.clientWidth ?? 800;
      const newPps = (viewportWidth * 0.8) / duration;
      set({
        pixelsPerSecond: Math.max(1, Math.min(1000, newPps)),
        scrollX: Math.max(0, timeSelection.start * newPps - viewportWidth * 0.1),
      });
    },

    toggleQuantizeDialog: () =>
      set((s) => ({ showQuantizeDialog: !s.showQuantizeDialog })),

    toggleDrumEditor: () =>
      set((s) => ({ showDrumEditor: !s.showDrumEditor })),

    selectAllMIDINotes: () => {
      const { pianoRollClipId, tracks } = get();
      if (!pianoRollClipId) return;
      const clip = tracks.flatMap((t) => t.clips).find((c) => c.id === pianoRollClipId);
      if (!(clip as any).notes) return;
      const midiClip = clip as any;
      if (midiClip.notes) {
        set({ selectedNoteIds: midiClip.notes.map((n: any) => n.id) });
      }
    },

    updateMIDINotes: (clipId: string, notes: any[]) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, notes } : c,
          ),
        })),
        isModified: true,
      }));
    },

    updateMIDINoteVelocity: (trackId, clipId, noteTimestamp, noteNumber, velocity) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const noteOnIdx = clip.events.findIndex((e) => e.type === "noteOn" && e.note === noteNumber && Math.abs(e.timestamp - noteTimestamp) < 0.001);
      if (noteOnIdx === -1) return;
      const oldVelocity = clip.events[noteOnIdx].velocity || 80;
      const clampedVelocity = Math.max(1, Math.min(127, Math.round(velocity)));
      const applyVel = (s: any, vel: number) => ({ tracks: s.tracks.map((t: any) => t.id === trackId ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events: c.events.map((e: any) => e.type === "noteOn" && e.note === noteNumber && Math.abs(e.timestamp - noteTimestamp) < 0.001 ? { ...e, velocity: vel } : e) } : c) } : t) });
      set((s) => ({ ...applyVel(s, clampedVelocity), isModified: true }));
      commandManager.push({ type: "midi_velocity", description: `Set velocity to ${clampedVelocity}`, timestamp: Date.now(), execute: () => { set((s) => applyVel(s, clampedVelocity)); }, undo: () => { set((s) => applyVel(s, oldVelocity)); } });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    updateMIDICCEvents: (trackId, clipId, newCCEvents) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldCCEvents = clip.ccEvents ? [...clip.ccEvents] : [];
      const applyCc = (s: any, evts: MIDICCEvent[]) => ({ tracks: s.tracks.map((t: any) => t.id === trackId ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, ccEvents: evts } : c) } : t) });
      set((s) => ({ ...applyCc(s, newCCEvents), isModified: true }));
      commandManager.push({ type: "midi_cc", description: "Update MIDI CC events", timestamp: Date.now(), execute: () => { set((s) => applyCc(s, newCCEvents)); }, undo: () => { set((s) => applyCc(s, oldCCEvents)); } });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setPianoRollScaleRoot: (root) => set({ pianoRollScaleRoot: root }),
    setPianoRollScaleType: (scaleType) => set({ pianoRollScaleType: scaleType }),

    // ========== Step Input Mode ==========
    toggleStepInput: () => set((s) => ({
      stepInputEnabled: !s.stepInputEnabled,
      stepInputPosition: !s.stepInputEnabled ? 0 : s.stepInputPosition,
    })),
    setStepInputSize: (beats) => set({ stepInputSize: beats }),
    setStepInputPosition: (time) => set({ stepInputPosition: Math.max(0, time) }),
    advanceStepInput: () => {
      const { stepInputSize, stepInputPosition, transport } = get();
      const beatsPerSecond = transport.tempo / 60;
      const advanceSeconds = stepInputSize / beatsPerSecond;
      set({ stepInputPosition: stepInputPosition + advanceSeconds });
    },

    // ========== MIDI Transform ==========
    transposeMIDINotes: (clipId, semitones) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldEvents = [...clip.events];

      // Transpose all noteOn/noteOff events in the clip by the given semitones.
      // Operates on all notes (selectedNoteIds is not used for filtering since
      // the piano roll events don't carry per-note IDs).
      const newEvents = clip.events.map((e) => {
        if ((e.type === "noteOn" || e.type === "noteOff") && e.note !== undefined) {
          const newNote = Math.max(0, Math.min(127, e.note + semitones));
          return { ...e, note: newNote };
        }
        return e;
      });

      const applyEvents = (s: any, events: MIDIEvent[]) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events } : c) }
            : t,
        ),
      });
      set((s) => ({ ...applyEvents(s, newEvents), isModified: true }));
      commandManager.push({
        type: "midi_transpose",
        description: `Transpose ${semitones > 0 ? "+" : ""}${semitones} semitones`,
        timestamp: Date.now(),
        execute: () => set((s) => applyEvents(s, newEvents)),
        undo: () => set((s) => applyEvents(s, oldEvents)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    scaleMIDINoteVelocity: (clipId, factor) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldEvents = [...clip.events];

      const newEvents = clip.events.map((e) => {
        if (e.type === "noteOn" && e.velocity !== undefined) {
          const newVel = Math.max(1, Math.min(127, Math.round(e.velocity * factor)));
          return { ...e, velocity: newVel };
        }
        return e;
      });

      const applyEvents = (s: any, events: MIDIEvent[]) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events } : c) }
            : t,
        ),
      });
      set((s) => ({ ...applyEvents(s, newEvents), isModified: true }));
      commandManager.push({
        type: "midi_velocity_scale",
        description: `Scale velocity x${factor.toFixed(2)}`,
        timestamp: Date.now(),
        execute: () => set((s) => applyEvents(s, newEvents)),
        undo: () => set((s) => applyEvents(s, oldEvents)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    reverseMIDINotes: (clipId) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldEvents = [...clip.events];

      // Collect noteOn/noteOff pairs
      const noteOns = clip.events.filter((e) => e.type === "noteOn");
      const noteOffs = clip.events.filter((e) => e.type === "noteOff");
      const otherEvents = clip.events.filter((e) => e.type !== "noteOn" && e.type !== "noteOff");

      // Find the max end time of all notes
      let maxTime = 0;
      for (const on of noteOns) {
        const off = noteOffs.find((e) => e.note === on.note && e.timestamp > on.timestamp);
        if (off && off.timestamp > maxTime) maxTime = off.timestamp;
      }
      if (maxTime === 0) maxTime = clip.duration;

      // Reverse: mirror each note around the midpoint of the clip
      const newNoteEvents: MIDIEvent[] = [];
      for (const on of noteOns) {
        const off = noteOffs.find((e) => e.note === on.note && e.timestamp > on.timestamp);
        if (!off) continue;
        const dur = off.timestamp - on.timestamp;
        const newStart = maxTime - off.timestamp;
        newNoteEvents.push({ ...on, timestamp: Math.max(0, newStart) });
        newNoteEvents.push({ ...off, timestamp: Math.max(0, newStart + dur) });
      }

      const newEvents = [...otherEvents, ...newNoteEvents].sort((a, b) => a.timestamp - b.timestamp);

      const applyEvents = (s: any, events: MIDIEvent[]) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events } : c) }
            : t,
        ),
      });
      set((s) => ({ ...applyEvents(s, newEvents), isModified: true }));
      commandManager.push({
        type: "midi_reverse",
        description: "Reverse MIDI notes",
        timestamp: Date.now(),
        execute: () => set((s) => applyEvents(s, newEvents)),
        undo: () => set((s) => applyEvents(s, oldEvents)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    invertMIDINotes: (clipId) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldEvents = [...clip.events];

      // Find center pitch from noteOn events
      const noteOnPitches = clip.events
        .filter((e) => e.type === "noteOn" && e.note !== undefined)
        .map((e) => e.note!);
      if (noteOnPitches.length === 0) return;
      const minPitch = Math.min(...noteOnPitches);
      const maxPitch = Math.max(...noteOnPitches);
      const centerPitch = (minPitch + maxPitch) / 2;

      const newEvents = clip.events.map((e) => {
        if ((e.type === "noteOn" || e.type === "noteOff") && e.note !== undefined) {
          const inverted = Math.round(2 * centerPitch - e.note);
          const clamped = Math.max(0, Math.min(127, inverted));
          return { ...e, note: clamped };
        }
        return e;
      });

      const applyEvents = (s: any, events: MIDIEvent[]) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events } : c) }
            : t,
        ),
      });
      set((s) => ({ ...applyEvents(s, newEvents), isModified: true }));
      commandManager.push({
        type: "midi_invert",
        description: "Invert MIDI note pitches",
        timestamp: Date.now(),
        execute: () => set((s) => applyEvents(s, newEvents)),
        undo: () => set((s) => applyEvents(s, oldEvents)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setNoteExpression: (clipId, noteId, expr) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const [tsStr, noteStr] = noteId.split(":");
      const noteTimestamp = parseFloat(tsStr);
      const noteNumber = parseInt(noteStr, 10);
      const noteIdx = clip.events.findIndex(
        (e) => e.type === "noteOn" && e.note === noteNumber && Math.abs(e.timestamp - noteTimestamp) < 0.001,
      );
      if (noteIdx === -1) return;
      const oldEvent = clip.events[noteIdx];
      const oldExpr = { pitchBend: oldEvent.pitchBend, pressure: oldEvent.pressure, slide: oldEvent.slide };
      const newExpr = {
        pitchBend: expr.pitchBend !== undefined ? Math.max(-1, Math.min(1, expr.pitchBend)) : oldEvent.pitchBend,
        pressure: expr.pressure !== undefined ? Math.max(0, Math.min(1, expr.pressure)) : oldEvent.pressure,
        slide: expr.slide !== undefined ? Math.max(0, Math.min(1, expr.slide)) : oldEvent.slide,
      };
      const applyExpr = (s: any, ex: { pitchBend?: number; pressure?: number; slide?: number }) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? {
                ...t,
                midiClips: t.midiClips.map((c: any) =>
                  c.id === clipId
                    ? {
                        ...c,
                        events: c.events.map((e: any) =>
                          e.type === "noteOn" && e.note === noteNumber && Math.abs(e.timestamp - noteTimestamp) < 0.001
                            ? { ...e, ...ex }
                            : e,
                        ),
                      }
                    : c,
                ),
              }
            : t,
        ),
      });
      set((s) => ({ ...applyExpr(s, newExpr), isModified: true }));
      commandManager.push({
        type: "note_expression",
        description: "Set note expression",
        timestamp: Date.now(),
        execute: () => set((s) => applyExpr(s, newExpr)),
        undo: () => set((s) => applyExpr(s, oldExpr)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // Sprint 19: Plugin + Mixing
    toggleMediaPool: () =>
      set((s) => ({ showMediaPool: !s.showMediaPool })),

    // ========== Plugin A/B Comparison ==========
    storePluginState: async (trackId, fxIndex, slot, isInputFX) => {
      const key = `${trackId}-${fxIndex}`;
      const storeFn = slot === "a" ? nativeBridge.storePluginStateA : nativeBridge.storePluginStateB;
      try {
        const success = await storeFn.call(nativeBridge, trackId, fxIndex, isInputFX);
        if (success) {
          set((s) => ({
            pluginABStates: {
              ...s.pluginABStates,
              [key]: {
                ...s.pluginABStates[key],
                [slot]: "stored",
                active: s.pluginABStates[key]?.active || "a",
              },
            },
          }));
        }
      } catch (e) {
        console.error("[Store] Failed to store plugin state:", e);
      }
    },

    recallPluginState: async (trackId, fxIndex, slot, isInputFX) => {
      const key = `${trackId}-${fxIndex}`;
      const recallFn = slot === "a" ? nativeBridge.recallPluginStateA : nativeBridge.recallPluginStateB;
      try {
        const success = await recallFn.call(nativeBridge, trackId, fxIndex, isInputFX);
        if (success) {
          set((s) => ({
            pluginABStates: {
              ...s.pluginABStates,
              [key]: {
                ...s.pluginABStates[key],
                active: slot,
              },
            },
          }));
        }
      } catch (e) {
        console.error("[Store] Failed to recall plugin state:", e);
      }
    },

    togglePluginAB: async (trackId, fxIndex, isInputFX) => {
      const key = `${trackId}-${fxIndex}`;
      const current = get().pluginABStates[key];
      const currentSlot = current?.active || "a";
      const targetSlot = currentSlot === "a" ? "b" : "a";

      // First store the current state into the current slot
      const storeFn = currentSlot === "a" ? nativeBridge.storePluginStateA : nativeBridge.storePluginStateB;
      await storeFn.call(nativeBridge, trackId, fxIndex, isInputFX);

      // Then recall the target slot
      const recallFn = targetSlot === "a" ? nativeBridge.recallPluginStateA : nativeBridge.recallPluginStateB;
      const success = await recallFn.call(nativeBridge, trackId, fxIndex, isInputFX);

      if (success) {
        set((s) => ({
          pluginABStates: {
            ...s.pluginABStates,
            [key]: {
              ...s.pluginABStates[key],
              [currentSlot]: "stored",
              active: targetSlot,
            },
          },
        }));
      }
    },

    // ========== FX Chain Presets ==========
    saveFXChainPreset: async (trackId, name, chainType) => {
      try {
        let fxSlots: Array<{ name: string; pluginPath?: string }> = [];
        if (chainType === "master") {
          fxSlots = await nativeBridge.getMasterFX();
        } else if (chainType === "input") {
          fxSlots = await nativeBridge.getTrackInputFX(trackId);
        } else {
          fxSlots = await nativeBridge.getTrackFX(trackId);
        }

        const preset = {
          name,
          plugins: fxSlots.map((fx) => ({
            pluginId: fx.pluginPath || fx.name,
          })),
        };

        set((s) => ({
          fxChainPresets: [...s.fxChainPresets, preset],
          isModified: true,
        }));

        get().showToast(`FX chain preset "${name}" saved`, "success");
      } catch (e) {
        console.error("[Store] Failed to save FX chain preset:", e);
        get().showToast("Failed to save FX chain preset", "error");
      }
    },

    loadFXChainPreset: async (trackId, presetIndex, chainType) => {
      const { fxChainPresets, showToast } = get();
      const preset = fxChainPresets[presetIndex];
      if (!preset) return;

      try {
        // First, remove all existing FX from the chain
        let currentFx: Array<{ index: number }> = [];
        if (chainType === "master") {
          currentFx = await nativeBridge.getMasterFX();
        } else if (chainType === "input") {
          currentFx = await nativeBridge.getTrackInputFX(trackId);
        } else {
          currentFx = await nativeBridge.getTrackFX(trackId);
        }

        // Remove in reverse order so indices stay valid
        for (let i = currentFx.length - 1; i >= 0; i--) {
          if (chainType === "master") {
            await nativeBridge.removeMasterFX(currentFx[i].index);
          } else if (chainType === "input") {
            await nativeBridge.removeTrackInputFX(trackId, currentFx[i].index);
          } else {
            await nativeBridge.removeTrackFX(trackId, currentFx[i].index);
          }
        }

        // Add each plugin from the preset
        for (const plugin of preset.plugins) {
          if (chainType === "master") {
            await nativeBridge.addMasterFX(plugin.pluginId);
          } else if (chainType === "input") {
            await nativeBridge.addTrackInputFX(trackId, plugin.pluginId);
          } else {
            await nativeBridge.addTrackFX(trackId, plugin.pluginId);
          }
        }

        showToast(`Loaded FX chain preset "${preset.name}"`, "success");
      } catch (e) {
        console.error("[Store] Failed to load FX chain preset:", e);
        showToast("Failed to load FX chain preset", "error");
      }
    },

    deleteFXChainPreset: (index) => {
      set((s) => ({
        fxChainPresets: s.fxChainPresets.filter((_, i) => i !== index),
        isModified: true,
      }));
    },

    // Sprint 20: Metering + Analysis + Project
    toggleLoudnessMeter: () =>
      set((s) => ({ showLoudnessMeter: !s.showLoudnessMeter })),

    toggleSpectrumAnalyzer: () =>
      set((s) => ({ showSpectrumAnalyzer: !s.showSpectrumAnalyzer })),

    togglePhaseCorrelation: () =>
      set((s) => ({ showPhaseCorrelation: !s.showPhaseCorrelation })),

    toggleProjectTemplates: () =>
      set((s) => ({ showProjectTemplates: !s.showProjectTemplates })),

    archiveSession: async () => {
      const { projectPath, showToast } = get();
      if (!projectPath) {
        showToast("Save the project first before archiving.", "info");
        return;
      }
      try {
        const zipPath = projectPath.replace(/\.s13$/, "") + "_archive.zip";
        const success = await nativeBridge.archiveSession(projectPath, zipPath);
        if (success) {
          showToast(`Session archived to ${zipPath}`, "success");
        } else {
          showToast("Archive failed.", "error");
        }
      } catch {
        showToast("Archive not available.", "error");
      }
    },

    // Sprint 21: Timeline Interaction
    setTrackWaveformZoom: (trackId, zoom) => {
      const clamped = Math.max(0.1, Math.min(5.0, zoom));
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, waveformZoom: clamped } : t,
        ),
      }));
    },

    toggleSpectralView: (trackId: string) => {
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, spectralView: !t.spectralView } : t,
        ),
      }));
    },

    toggleCrosshair: () =>
      set((s) => ({ showCrosshair: !s.showCrosshair })),

    slipEditClip: (clipId, newOffset) => {
      const state = get();

      // Find the clip and its old offset
      let oldOffset: number | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldOffset = clip.offset;
          break;
        }
      }
      if (oldOffset === null || oldOffset === newOffset) return;

      const capturedOldOffset = oldOffset;
      const command: Command = {
        type: "SLIP_EDIT_CLIP",
        description: "Slip edit clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId
                  ? { ...clip, offset: newOffset }
                  : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId
                  ? { ...clip, offset: capturedOldOffset }
                  : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
        isModified: true,
      });
    },

    // ========== Mixer Snapshots ==========
    saveMixerSnapshot: (name: string) => {
      const state = get();
      const snapshot: MixerSnapshot = {
        name,
        timestamp: Date.now(),
        tracks: state.tracks.map((t) => ({
          id: t.id,
          volume: t.volumeDB,
          pan: t.pan,
          mute: t.muted,
          solo: t.soloed,
        })),
      };
      set((s) => {
        const updated = [...s.mixerSnapshots, snapshot];
        localStorage.setItem("s13_mixerSnapshots", JSON.stringify(updated));
        return { mixerSnapshots: updated, isModified: true };
      });
      get().showToast(`Mixer snapshot "${name}" saved`, "success");
    },

    recallMixerSnapshot: (index: number) => {
      const state = get();
      const snapshot = state.mixerSnapshots[index];
      if (!snapshot) return;

      // Capture old state for undo
      const oldTrackStates = state.tracks.map((t) => ({
        id: t.id,
        volumeDB: t.volumeDB,
        volume: t.volume,
        pan: t.pan,
        muted: t.muted,
        soloed: t.soloed,
      }));

      const command: Command = {
        type: "RECALL_MIXER_SNAPSHOT",
        description: `Recall mixer snapshot "${snapshot.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const saved = snapshot.tracks.find((st) => st.id === t.id);
              if (!saved) return t;
              const volume = saved.volume <= -60 ? 0 : Math.pow(10, saved.volume / 20);
              return {
                ...t,
                volumeDB: saved.volume,
                volume,
                pan: saved.pan,
                muted: saved.mute,
                soloed: saved.solo,
              };
            }),
          }));
          // Sync to backend
          for (const saved of snapshot.tracks) {
            nativeBridge.setTrackVolume(saved.id, saved.volume).catch(() => {});
            nativeBridge.setTrackPan(saved.id, saved.pan).catch(() => {});
            nativeBridge.setTrackMute(saved.id, saved.mute).catch(() => {});
            nativeBridge.setTrackSolo(saved.id, saved.solo).catch(() => {});
          }
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldTrackStates.find((ot) => ot.id === t.id);
              if (!old) return t;
              return {
                ...t,
                volumeDB: old.volumeDB,
                volume: old.volume,
                pan: old.pan,
                muted: old.muted,
                soloed: old.soloed,
              };
            }),
          }));
          // Sync old state to backend
          for (const old of oldTrackStates) {
            nativeBridge.setTrackVolume(old.id, old.volumeDB).catch(() => {});
            nativeBridge.setTrackPan(old.id, old.pan).catch(() => {});
            nativeBridge.setTrackMute(old.id, old.muted).catch(() => {});
            nativeBridge.setTrackSolo(old.id, old.soloed).catch(() => {});
          }
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      get().showToast(`Recalled mixer snapshot "${snapshot.name}"`, "success");
    },

    deleteMixerSnapshot: (index: number) => {
      set((s) => {
        const updated = s.mixerSnapshots.filter((_, i) => i !== index);
        localStorage.setItem("s13_mixerSnapshots", JSON.stringify(updated));
        return { mixerSnapshots: updated };
      });
    },

    // ========== Bus/Group Creation ==========
    createBusFromSelectedTracks: () => {
      const state = get();
      const selectedIds = state.selectedTrackIds;
      if (selectedIds.length === 0) {
        get().showToast("Select tracks first to create a bus.", "info");
        return;
      }

      const busId = crypto.randomUUID();
      const busName = `Bus ${state.tracks.filter((t) => t.type === "bus").length + 1}`;

      // Create the bus track (through addTrack which handles undo for the track creation)
      get().addTrack({ id: busId, name: busName, type: "bus" });

      // Set up sends from each selected track to the new bus
      for (const trackId of selectedIds) {
        get().addTrackSend(trackId, busId);
      }

      get().showToast(`Created bus "${busName}" with ${selectedIds.length} sends`, "success");
    },

    // ========== Project Templates ==========
    saveAsTemplate: (name: string) => {
      const state = get();
      // Capture track layout without clips
      const templateTracks = state.tracks.map((t) => ({
        ...t,
        clips: [],        // No clips in templates
        midiClips: [],     // No MIDI clips
        takes: [],         // No takes
        meterLevel: 0,
        peakLevel: 0,
        clipping: false,
      }));

      const template: ProjectTemplate = {
        name,
        tracks: templateTracks,
        masterVolume: state.masterVolume,
        masterPan: state.masterPan,
        tempo: state.transport.tempo,
        timeSignature: { ...state.timeSignature },
      };

      set((s) => {
        const updated = [...s.projectTemplates, template];
        localStorage.setItem("s13_projectTemplates", JSON.stringify(updated));
        return { projectTemplates: updated };
      });
      get().showToast(`Template "${name}" saved`, "success");
    },

    loadTemplate: (index: number) => {
      const state = get();
      const template = state.projectTemplates[index];
      if (!template) return;

      // Capture old state for undo
      const oldTracks = JSON.parse(JSON.stringify(state.tracks)) as Track[];
      const oldMasterVolume = state.masterVolume;
      const oldMasterPan = state.masterPan;
      const oldTempo = state.transport.tempo;
      const oldTimeSig = { ...state.timeSignature };

      const command: Command = {
        type: "LOAD_TEMPLATE",
        description: `Load template "${template.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          // Clear current project
          await get().newProject();

          // Restore global settings from template
          get().setTempo(template.tempo);
          get().setTimeSignature(template.timeSignature.numerator, template.timeSignature.denominator);
          get().setMasterVolume(template.masterVolume);
          get().setMasterPan(template.masterPan);

          // Add template tracks (skip undo for individual tracks during template load)
          for (const trackData of template.tracks) {
            const newId = crypto.randomUUID();
            const newTrack = {
              ...trackData,
              id: newId,
              clips: [],
              midiClips: [],
              takes: [],
              meterLevel: 0,
              peakLevel: 0,
              clipping: false,
            };
            set((s) => ({ tracks: [...s.tracks, newTrack] }));
            nativeBridge.addTrack(newId).catch(() => {});
            // Sync track properties to backend
            nativeBridge.setTrackVolume(newId, trackData.volumeDB).catch(() => {});
            nativeBridge.setTrackPan(newId, trackData.pan).catch(() => {});
            if (trackData.muted) nativeBridge.setTrackMute(newId, true).catch(() => {});
            if (trackData.soloed) nativeBridge.setTrackSolo(newId, true).catch(() => {});
          }

          set({ isModified: true });
          get().showToast(`Loaded template "${template.name}"`, "success");
        },
        undo: async () => {
          // Clear current project
          const currentTracks = get().tracks;
          for (let i = currentTracks.length - 1; i >= 0; i--) {
            await nativeBridge.removeTrack(currentTracks[i].id).catch(() => {});
          }

          // Restore old state
          set({
            tracks: oldTracks,
            masterVolume: oldMasterVolume,
            masterPan: oldMasterPan,
            transport: { ...get().transport, tempo: oldTempo },
            timeSignature: oldTimeSig,
          });

          // Sync old tracks to backend
          for (const t of oldTracks) {
            await nativeBridge.addTrack(t.id).catch(() => {});
            nativeBridge.setTrackVolume(t.id, t.volumeDB).catch(() => {});
            nativeBridge.setTrackPan(t.id, t.pan).catch(() => {});
          }
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    deleteTemplate: (index: number) => {
      set((s) => {
        const updated = s.projectTemplates.filter((_, i) => i !== index);
        localStorage.setItem("s13_projectTemplates", JSON.stringify(updated));
        return { projectTemplates: updated };
      });
    },

    // ========== Project Compare ==========
    toggleProjectCompare: () =>
      set((s) => ({ showProjectCompare: !s.showProjectCompare })),

    compareWithSavedProject: async () => {
      const state = get();
      const filePath = state.projectPath;
      if (!filePath) {
        set({ projectCompareData: { tracksDiff: [], clipsDiff: [], settingsDiff: [{ field: "Project", oldValue: "-", newValue: "Project has not been saved yet" }] } });
        set({ showProjectCompare: true });
        return;
      }

      try {
        const json = await nativeBridge.loadProjectFromFile(filePath);
        if (!json) {
          get().showToast("Could not read saved project file", "error");
          return;
        }
        const saved = JSON.parse(json);

        // --- Settings diff ---
        const settingsDiff: Array<{ field: string; oldValue: string; newValue: string }> = [];
        if (saved.projectName !== state.projectName) {
          settingsDiff.push({ field: "Project Name", oldValue: saved.projectName || "", newValue: state.projectName });
        }
        if ((saved.tempo || 120) !== state.transport.tempo) {
          settingsDiff.push({ field: "Tempo (BPM)", oldValue: String(saved.tempo || 120), newValue: String(state.transport.tempo) });
        }
        if (saved.timeSignature) {
          const savedTS = `${saved.timeSignature.numerator}/${saved.timeSignature.denominator}`;
          const currentTS = `${state.timeSignature.numerator}/${state.timeSignature.denominator}`;
          if (savedTS !== currentTS) {
            settingsDiff.push({ field: "Time Signature", oldValue: savedTS, newValue: currentTS });
          }
        }
        if ((saved.masterVolume ?? 1.0) !== state.masterVolume) {
          settingsDiff.push({ field: "Master Volume", oldValue: String(saved.masterVolume ?? 1.0), newValue: String(state.masterVolume) });
        }
        if ((saved.masterPan ?? 0.0) !== state.masterPan) {
          settingsDiff.push({ field: "Master Pan", oldValue: String(saved.masterPan ?? 0.0), newValue: String(state.masterPan) });
        }
        if ((saved.projectSampleRate || 44100) !== state.projectSampleRate) {
          settingsDiff.push({ field: "Sample Rate", oldValue: String(saved.projectSampleRate || 44100), newValue: String(state.projectSampleRate) });
        }
        if ((saved.projectBitDepth || 24) !== state.projectBitDepth) {
          settingsDiff.push({ field: "Bit Depth", oldValue: String(saved.projectBitDepth || 24), newValue: String(state.projectBitDepth) });
        }

        // --- Tracks diff ---
        const savedTrackMap = new Map<string, any>();
        for (const t of saved.tracks || []) savedTrackMap.set(t.id, t);
        const currentTrackMap = new Map<string, any>();
        for (const t of state.tracks) currentTrackMap.set(t.id, t);

        const tracksDiff: Array<{ type: "added" | "removed" | "modified"; id: string; name: string; details?: string }> = [];

        // Added tracks (in current but not saved)
        for (const t of state.tracks) {
          if (!savedTrackMap.has(t.id)) {
            tracksDiff.push({ type: "added", id: t.id, name: t.name });
          }
        }
        // Removed tracks (in saved but not current)
        for (const t of saved.tracks || []) {
          if (!currentTrackMap.has(t.id)) {
            tracksDiff.push({ type: "removed", id: t.id, name: t.name });
          }
        }
        // Modified tracks
        for (const t of state.tracks) {
          const st = savedTrackMap.get(t.id);
          if (!st) continue;
          const changes: string[] = [];
          if (st.name !== t.name) changes.push(`renamed: "${st.name}" -> "${t.name}"`);
          if (st.volumeDB !== t.volumeDB) changes.push(`volume: ${st.volumeDB}dB -> ${t.volumeDB}dB`);
          if (st.pan !== t.pan) changes.push(`pan: ${st.pan} -> ${t.pan}`);
          if (st.muted !== t.muted) changes.push(`muted: ${st.muted} -> ${t.muted}`);
          if (st.soloed !== t.soloed) changes.push(`soloed: ${st.soloed} -> ${t.soloed}`);
          if (changes.length > 0) {
            tracksDiff.push({ type: "modified", id: t.id, name: t.name, details: changes.join(", ") });
          }
        }

        // --- Clips diff ---
        const clipsDiff: Array<{ type: "added" | "removed" | "modified"; id: string; name: string; trackName: string; details?: string }> = [];

        // Build clip maps: clipId -> { clip, trackName }
        const savedClipMap = new Map<string, { clip: any; trackName: string }>();
        for (const t of saved.tracks || []) {
          for (const c of t.clips || []) {
            savedClipMap.set(c.id, { clip: c, trackName: t.name });
          }
        }
        const currentClipMap = new Map<string, { clip: any; trackName: string }>();
        for (const t of state.tracks) {
          for (const c of t.clips || []) {
            currentClipMap.set(c.id, { clip: c, trackName: t.name });
          }
        }

        // Added clips
        for (const [id, { clip, trackName }] of currentClipMap) {
          if (!savedClipMap.has(id)) {
            clipsDiff.push({ type: "added", id, name: clip.name || clip.filePath?.split(/[/\\]/).pop() || id, trackName });
          }
        }
        // Removed clips
        for (const [id, { clip, trackName }] of savedClipMap) {
          if (!currentClipMap.has(id)) {
            clipsDiff.push({ type: "removed", id, name: clip.name || clip.filePath?.split(/[/\\]/).pop() || id, trackName });
          }
        }
        // Modified clips
        for (const [id, { clip: cur, trackName }] of currentClipMap) {
          const saved = savedClipMap.get(id);
          if (!saved) continue;
          const sc = saved.clip;
          const changes: string[] = [];
          if (Math.abs((sc.startTime || 0) - (cur.startTime || 0)) > 0.001) changes.push(`moved: ${sc.startTime?.toFixed(3)}s -> ${cur.startTime?.toFixed(3)}s`);
          if (Math.abs((sc.duration || 0) - (cur.duration || 0)) > 0.001) changes.push(`duration: ${sc.duration?.toFixed(3)}s -> ${cur.duration?.toFixed(3)}s`);
          if ((sc.volumeDB || 0) !== (cur.volumeDB || 0)) changes.push(`volume: ${sc.volumeDB || 0}dB -> ${cur.volumeDB || 0}dB`);
          if (sc.muted !== cur.muted) changes.push(`muted: ${sc.muted} -> ${cur.muted}`);
          if (changes.length > 0) {
            clipsDiff.push({ type: "modified", id, name: cur.name || cur.filePath?.split(/[/\\]/).pop() || id, trackName, details: changes.join(", ") });
          }
        }

        set({ projectCompareData: { tracksDiff, clipsDiff, settingsDiff }, showProjectCompare: true });
      } catch (e) {
        console.error("[compareWithSavedProject]", e);
        get().showToast("Failed to compare project: " + String(e), "error");
      }
    },

    // ========== Collaborative Metadata ==========
    setProjectAuthor: (author: string) => {
      localStorage.setItem("s13_projectAuthor", author);
      set({ projectAuthor: author, isModified: true });
    },

    addRevisionNote: (note: string) => {
      const state = get();
      const entry = {
        timestamp: Date.now(),
        author: state.projectAuthor,
        note,
      };
      set((s) => ({
        projectRevisionNotes: [...s.projectRevisionNotes, entry],
        isModified: true,
      }));
    },

    deleteRevisionNote: (index: number) => {
      set((s) => ({
        projectRevisionNotes: s.projectRevisionNotes.filter((_, i) => i !== index),
        isModified: true,
      }));
    },
  })),
);

// ============================================
// Theme System
// ============================================

export interface ThemePreset {
  name: string;
  label: string;
  colors: Record<string, string>;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    name: "dark",
    label: "Dark (Default)",
    colors: {
      "--color-daw-dark": "#121212",
      "--color-daw-panel": "#1a1a1a",
      "--color-daw-lighter": "#252525",
      "--color-daw-selection": "#333333",
      "--color-daw-text": "#e0e0e0",
      "--color-daw-text-muted": "#888888",
      "--color-daw-text-dim": "#555555",
      "--color-daw-accent": "#0078d4",
      "--color-daw-border": "#2a2a2a",
      "--color-daw-border-light": "#3a3a3a",
    },
  },
  {
    name: "light",
    label: "Light",
    colors: {
      "--color-daw-dark": "#f0f0f0",
      "--color-daw-panel": "#ffffff",
      "--color-daw-lighter": "#e8e8e8",
      "--color-daw-selection": "#d0d0d0",
      "--color-daw-text": "#1a1a1a",
      "--color-daw-text-muted": "#666666",
      "--color-daw-text-dim": "#999999",
      "--color-daw-accent": "#2563eb",
      "--color-daw-border": "#d0d0d0",
      "--color-daw-border-light": "#c0c0c0",
    },
  },
  {
    name: "midnight",
    label: "Midnight",
    colors: {
      "--color-daw-dark": "#0a0a1a",
      "--color-daw-panel": "#10102a",
      "--color-daw-lighter": "#1a1a3a",
      "--color-daw-selection": "#2a2a4a",
      "--color-daw-text": "#d0d0e8",
      "--color-daw-text-muted": "#7070a0",
      "--color-daw-text-dim": "#4a4a7a",
      "--color-daw-accent": "#6366f1",
      "--color-daw-border": "#1a1a3a",
      "--color-daw-border-light": "#2a2a4a",
    },
  },
  {
    name: "high-contrast",
    label: "High Contrast",
    colors: {
      "--color-daw-dark": "#000000",
      "--color-daw-panel": "#0a0a0a",
      "--color-daw-lighter": "#1a1a1a",
      "--color-daw-selection": "#333333",
      "--color-daw-text": "#ffffff",
      "--color-daw-text-muted": "#cccccc",
      "--color-daw-text-dim": "#888888",
      "--color-daw-accent": "#ffcc00",
      "--color-daw-border": "#555555",
      "--color-daw-border-light": "#777777",
    },
  },
  {
    name: "reaper-gray",
    label: "REAPER Gray",
    colors: {
      "--color-daw-dark": "#484848",
      "--color-daw-panel": "#5a5a5a",
      "--color-daw-lighter": "#6a6a6a",
      "--color-daw-selection": "#7a7a7a",
      "--color-daw-text": "#e8e8e8",
      "--color-daw-text-muted": "#b0b0b0",
      "--color-daw-text-dim": "#8a8a8a",
      "--color-daw-accent": "#5b9bd5",
      "--color-daw-border": "#3e3e3e",
      "--color-daw-border-light": "#707070",
    },
  },
];

function applyTheme(themeName: string, overrides: Record<string, string>) {
  const preset = THEME_PRESETS.find((t) => t.name === themeName) || THEME_PRESETS[0];
  const root = document.documentElement;

  // Apply preset colors
  for (const [prop, value] of Object.entries(preset.colors)) {
    root.style.setProperty(prop, value);
  }

  // Apply user overrides on top
  for (const [prop, value] of Object.entries(overrides)) {
    root.style.setProperty(prop, value);
  }

  // Update body background for light theme
  const bgColor = overrides["--color-daw-dark"] || preset.colors["--color-daw-dark"];
  const textColor = overrides["--color-daw-text"] || preset.colors["--color-daw-text"];
  root.style.setProperty("background-color", bgColor);
  root.style.setProperty("color", textColor);
}

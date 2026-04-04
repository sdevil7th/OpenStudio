import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { nativeBridge, type AiToolsStatus } from "../services/NativeBridge";
import { Command, commandManager } from "./commands";
import { type GridSize } from "../utils/snapToGrid";
// automationToBackend moved to store/actions/automation.ts
import { logBridgeError } from "../utils/bridgeErrorHandler";
import { uiStateActions } from "./actions/uiState";
import { meteringActions } from "./actions/metering";
import { transportActions } from "./actions/transport";
import { clipActions } from "./actions/clips";
import { clipEditingActions } from "./actions/clipEditing";
import { mixerActions } from "./actions/mixer";
import { timelineActions } from "./actions/timeline";
import { trackActions } from "./actions/tracks";
import { automationActions } from "./actions/automation";
import { renderingActions } from "./actions/rendering";
import { projectActions } from "./actions/project";
import { midiActions } from "./actions/midi";
import { routingActions } from "./actions/routing";
import { clipLauncherActions } from "./actions/clipLauncher";
import { markerActions } from "./actions/markers";
import { screensetActions } from "./actions/screensets";
import { macroActions } from "./actions/macros";
import { renderQueueActions } from "./actions/renderQueue";
import { quantizeActions } from "./actions/quantize";


// Module-level helpers moved to store/actions/: _editSnapshots → tracks.ts,
// syncAutomationLaneToBackend → automation.ts, syncTempoMarkersToBackend → markers.ts,
// _linkingInProgress + getLinkedTrackIds → tracks.ts, projectJsonReplacer → project.ts

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

// Diff-based sync cache moved to store/actions/clips.ts
import { resetSyncCache } from "./actions/clips";
export { resetSyncCache };

function getBrowserStorage(): Storage | undefined {
  return typeof localStorage !== "undefined" ? localStorage : undefined;
}

function getStoredJSON<T>(key: string, fallback: T): T {
  try {
    const raw = getBrowserStorage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function getStoredString(key: string, fallback = ""): string {
  try {
    return getBrowserStorage()?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

const DEFAULT_AI_TOOLS_STATUS: AiToolsStatus = {
  state: "checking",
  progress: 0,
  available: false,
  installerAvailable: false,
  pythonDetected: false,
  scriptAvailable: false,
  runtimeInstalled: false,
  modelInstalled: false,
  installInProgress: false,
  message: "Checking AI tools...",
  helpUrl: "https://www.python.org/downloads/",
};

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

// Type guards for clip discrimination
export function isMIDIClip(clip: AudioClip | MIDIClip): clip is MIDIClip {
  return "events" in clip && Array.isArray(clip.events);
}
export function isAudioClip(clip: AudioClip | MIDIClip): clip is AudioClip {
  return "filePath" in clip;
}

// Supports built-in params plus plugin params like "plugin_0_3" (fxIndex_paramIndex)
export type AutomationParam = "volume" | "pan" | "mute" | (string & {});
export type AutomationModeType = "off" | "read" | "write" | "touch" | "latch";
export const AUTOMATION_LANE_HEIGHT = 60; // px per visible automation lane
export const DEFAULT_HORIZONTAL_SCROLLBAR_HEIGHT = 16;
export const BOTTOM_INTERACTION_BUFFER = 32;
export const TRACK_CLIP_VERTICAL_PADDING = 5;
export const MASTER_TRACK_HEADER_BASE_HEIGHT = 38;

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

export interface AutomationSuspendSnapshot {
  showAutomation: boolean;
  lanes: Record<string, { visible: boolean; armed: boolean; mode: AutomationModeType }>;
}

// ===== Automation Layout Helpers =====

export function getEffectiveTrackHeight(
  track: Pick<Track, "automationEnabled" | "showAutomation" | "automationLanes">,
  baseTrackHeight: number,
): number {
  if (!track.automationEnabled || !track.showAutomation) return baseTrackHeight;
  const visibleLaneCount = track.automationLanes.filter((l) => l.visible).length;
  return baseTrackHeight + visibleLaneCount * AUTOMATION_LANE_HEIGHT;
}

function getTrackHeaderControlWidth(track: Pick<Track, "type">): number {
  const commonWidth = 30 + 20 + 126 + 50 + 50 + 50;
  if (track.type === "audio") return commonWidth + 96;
  if (track.type === "instrument") return commonWidth + 92;
  if (track.type === "midi") return commonWidth + 74;
  return commonWidth;
}

export function getMinTrackHeaderHeight(
  track: Pick<Track, "type">,
  tcpWidth: number,
): number {
  const usable = Math.max(60, tcpWidth - 44);
  const rowHeight = 24;
  const gapY = 2;
  const padY = 8;
  const rows = Math.max(
    1,
    Math.ceil(getTrackHeaderControlWidth(track) / usable),
  );
  return rows * rowHeight + (rows - 1) * gapY + padY;
}

export function getTrackClipBodyHeight(
  track: Pick<Track, "type">,
  baseTrackHeight: number,
): number {
  const minBodyHeight =
    track.type === "midi" || track.type === "instrument" ? 56 : 32;
  return Math.max(minBodyHeight, baseTrackHeight - 10);
}

export function getTimelineRowMetrics(
  track: Pick<Track, "type" | "automationEnabled" | "showAutomation" | "automationLanes">,
  baseTrackHeight: number,
) {
  const rowHeight = getEffectiveTrackHeight(track, baseTrackHeight);
  const contentHeight = baseTrackHeight;
  const clipHeight = Math.min(
    contentHeight - 2,
    getTrackClipBodyHeight(track, baseTrackHeight),
  );
  const clipInsetY = Math.max(
    2,
    Math.floor((contentHeight - clipHeight) / 2),
  );

  return {
    rowHeight,
    contentHeight,
    clipHeight,
    clipInsetY,
    clipTopPadding: clipInsetY,
    clipBottomPadding: Math.max(2, contentHeight - clipInsetY - clipHeight),
  };
}

export function getMasterTrackHeaderHeight(visibleLaneCount: number) {
  return (
    MASTER_TRACK_HEADER_BASE_HEIGHT +
    visibleLaneCount * AUTOMATION_LANE_HEIGHT
  );
}

export function getMinimumVisibleTrackHeight(
  tracks: Pick<Track, "type">[],
  tcpWidth: number,
): number {
  if (tracks.length === 0) {
    return getMinTrackHeaderHeight({ type: "audio" }, tcpWidth);
  }
  return tracks.reduce(
    (maxHeight, track) =>
      Math.max(maxHeight, getMinTrackHeaderHeight(track, tcpWidth)),
    0,
  );
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
  pitchCorrectionSourceFilePath?: string; // Immutable source audio for repeated pitch renders
  name: string;
  startTime: number; // Position on timeline in seconds
  duration: number; // Duration in seconds
  offset: number; // Start offset within source file
  pitchCorrectionSourceOffset?: number; // Offset into the immutable source audio
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
  automationEnabled: boolean;
  suspendedAutomationState?: AutomationSuspendSnapshot | null;

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

export interface RecordingMIDIPreviewActiveNote {
  note: number;
  startTimestamp: number;
}

export interface RecordingMIDIPreview {
  generation: number;
  recordingStartTime: number;
  totalEventCount: number;
  events: MIDIEvent[];
  activeNotes: RecordingMIDIPreviewActiveNote[];
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
  numActiveInputChannels?: number;
  numActiveOutputChannels?: number;
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
  recordingMIDIPreviews: Record<string, RecordingMIDIPreview>; // Runtime-only MIDI note preview data for in-progress recording
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
  masterAutomationEnabled: boolean;
  suspendedMasterAutomationState: AutomationSuspendSnapshot | null;

  // Meter state — stored separately from `tracks` so that 10Hz meter updates
  // never give tracks a new array reference.  Only ChannelStrip / TrackHeader
  // subscribe to these; Timeline and App are completely unaffected.
  meterLevels: Record<string, number>;
  peakLevels: Record<string, number>;
  clippingStates: Record<string, boolean>;
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
  aiToolsStatus: AiToolsStatus;
  aiToolsStatusLoading: boolean;

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
  processingPrecision: "float32" | "hybrid64";

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
      showScriptConsole?: boolean;
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
  showDrumEditor: boolean;

  // Sprint 19: Plugin + Mixing
  showMediaPool: boolean;

  // Plugin A/B Comparison — per-plugin state slots keyed by "trackId-fxIndex"
  pluginABStates: Record<string, { a?: string; b?: string; active: "a" | "b" }>;

  // FX Chain Presets — save/load entire FX chains
  fxChainPresets: Array<{ name: string; plugins: Array<{ pluginId: string; state?: string }> }>;

  // Sprint 20: Metering + Analysis
  showLoudnessMeter: boolean;
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
  duplicateTrack: (trackId: string) => Promise<void>;
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
  toggleMasterAutomationEnabled: () => void;
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
  batchUpdateMeterLevels: (
    levels: Record<string, number>,
    masterLevel: number,
    clippingStates: Record<string, boolean>,
    masterClipping: boolean,
  ) => void;
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
  toggleTrackAutomationEnabled: (trackId: string) => void;
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
  reopenStemSeparation: () => void;
  refreshAiToolsStatus: (force?: boolean) => Promise<AiToolsStatus>;
  installAiTools: () => Promise<void>;
  cancelAiToolsInstall: () => Promise<void>;
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
  setProcessingPrecision: (mode: "float32" | "hybrid64") => Promise<void>;

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
  toggleDrumEditor: () => void;
  selectAllMIDINotes: () => void;
  updateMIDINotes: (clipId: string, notes: MIDIEvent[]) => void;

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

export const getRandomTrackColor = (): string => {
  return DEFAULT_TRACK_COLORS[
    Math.floor(Math.random() * DEFAULT_TRACK_COLORS.length)
  ];
};

export const createDefaultTrack = (
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
  automationEnabled: true,
  suspendedAutomationState: null,
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

export const initialTransport: TransportState = {
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
// getMinTrackHeight → moved to store/actions/timeline.ts

// ============================================
// State Serialization Helper
// ============================================

/**
 * Keys that represent transient/runtime state and should NOT be persisted
 * when saving a project. These include metering data (updated at 10-60 Hz),
 * UI interaction state, drag state, and ephemeral display flags.
 */
export const TRANSIENT_STATE_KEYS: ReadonlySet<string> = new Set([
  // Metering / automation display — updated at high frequency, meaningless after reload
  "meterLevels",
  "peakLevels",
  "clippingStates",
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
  "showDrumEditor",
  "showMediaPool",
  "showLoudnessMeter",
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

  // Live MIDI note preview while recording — runtime only
  "recordingMIDIPreviews",

  // Plugin A/B states — runtime comparison, not document state
  "pluginABStates",
]);

// projectJsonReplacer → moved to store/actions/project.ts

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
    recordingMIDIPreviews: {},
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
    masterAutomationEnabled: true,
    suspendedMasterAutomationState: null,
    meterLevels: {},
    peakLevels: {},
    clippingStates: {},
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
    aiToolsStatus: DEFAULT_AI_TOOLS_STATUS,
    aiToolsStatusLoading: true,
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
    processingPrecision: "float32",

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

    trackTemplates: getStoredJSON("s13_trackTemplates", []),

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
    screensets: getStoredJSON("s13_screensets", []),

    // Custom Actions (Macros)
    customActions: getStoredJSON("s13_customActions", []),

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
    showDrumEditor: false,

    // Sprint 19: Plugin + Mixing
    showMediaPool: false,

    // Plugin A/B Comparison
    pluginABStates: {},

    // FX Chain Presets
    fxChainPresets: [],

    // Sprint 20: Metering + Analysis
    showLoudnessMeter: false,
    showPhaseCorrelation: false,
    showProjectTemplates: false,

    // Sprint 21: Timeline Interaction
    showCrosshair: false,

    // Mixer Snapshots
    mixerSnapshots: getStoredJSON("s13_mixerSnapshots", []),

    // Project Templates
    projectTemplates: getStoredJSON("s13_projectTemplates", []),

    // Project Compare
    showProjectCompare: false,
    projectCompareData: null,

    // Collaborative Metadata
    projectAuthor: (() => {
      try {
        return getStoredString("s13_projectAuthor", "Unknown Author");
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
    refreshAiToolsStatus: async (force = false) => {
      const currentStatus = get().aiToolsStatus;
      set({ aiToolsStatusLoading: true });

      try {
        const nextStatus = force
          ? await nativeBridge.refreshAiToolsStatus()
          : await nativeBridge.getAiToolsStatus();

        set({ aiToolsStatus: nextStatus, aiToolsStatusLoading: false });
        return nextStatus;
      } catch (error) {
        const fallbackStatus: AiToolsStatus = {
          ...currentStatus,
          state: "error",
          installInProgress: false,
          message: "Failed to refresh AI tools status.",
          error: error instanceof Error ? error.message : String(error),
        };
        set({ aiToolsStatus: fallbackStatus, aiToolsStatusLoading: false });
        return fallbackStatus;
      }
    },
    installAiTools: async () => {
      const currentStatus = get().aiToolsStatus;
      if (currentStatus.installInProgress || currentStatus.available) return;

      if (currentStatus.state === "pythonMissing") {
        if (currentStatus.helpUrl) {
          await nativeBridge.openExternalURL(currentStatus.helpUrl);
        }
        return;
      }

      get().showToast("AI tools are being installed in the background.", "info");

      set({
        aiToolsStatus: {
          ...currentStatus,
          state: "checking",
          installInProgress: true,
          available: false,
          error: undefined,
          message: "Preparing AI tools installation...",
        },
      });

      try {
        const result = await nativeBridge.installAiTools();
        if (result.status) {
          set({ aiToolsStatus: result.status, aiToolsStatusLoading: false });
        } else {
          await get().refreshAiToolsStatus(true);
        }

        if (!result.started && result.error) {
          get().showToast(result.error, "error");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          aiToolsStatus: {
            ...get().aiToolsStatus,
            state: "error",
            installInProgress: false,
            message: "AI tools installation failed.",
            error: message,
          },
          aiToolsStatusLoading: false,
        });
        get().showToast(message, "error");
      }
    },
    cancelAiToolsInstall: async () => {
      await nativeBridge.cancelAiToolsInstall();
      await get().refreshAiToolsStatus(true);
    },


    // ========== Project Management → store/actions/project.ts ==========

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
        if (data.processingPrecision)
          await get().setProcessingPrecision(data.processingPrecision);

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
                    clip.pitchCorrectionSourceFilePath,
                    clip.pitchCorrectionSourceOffset,
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
    setProcessingPrecision: async (mode) => {
      await nativeBridge.setProcessingPrecision(mode);
      set({ processingPrecision: mode, isModified: true });
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


    // ========== Track Management + Audio Controls + Continuous Edit → store/actions/tracks.ts ==========

    // ========== FX Undo/Redo → store/actions/automation.ts ==========

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


    // ========== Track Automation → store/actions/automation.ts ==========

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
              nativeBridge.unfreezeTrack(trackId).catch(logBridgeError("sync"));
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
          nativeBridge.unfreezeTrack(trackId).catch(logBridgeError("sync"));
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


    // ========== Markers + Tempo Map → store/actions/markers.ts ==========

    // ========== UI State (extracted to store/actions/uiState.ts) ==========
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
              const insertAfterTrackId = (stemTrack as Track & { insertAfterTrackId?: string }).insertAfterTrackId;
              const idx = newTracks.findIndex((t) => t.id === insertAfterTrackId);
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
          Promise.all(stemTrackIds.map((tid) => nativeBridge.addTrack(tid))).catch(logBridgeError("sync"));
          if (!wasSourceMuted) {
            nativeBridge.setTrackMute(sourceTrackId, true).catch(logBridgeError("sync"));
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
            nativeBridge.removeTrack(tid).catch(logBridgeError("sync"));
          }
          if (!wasSourceMuted) {
            nativeBridge.setTrackMute(sourceTrackId, false).catch(logBridgeError("sync"));
          }
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    // setTimecodeMode, setSmpteFrameRate, setUIFontScale → store/actions/uiState.ts

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


    // ========== Piano Roll → store/actions/midi.ts ==========

    setAudioDeviceSetup: (setup) => set({ audioDeviceSetup: setup }),
    refreshAudioDeviceSetup: async () => {
      try {
        const response = await nativeBridge.getAudioDeviceSetup();
        // Backend returns { current: {...}, availableTypes: [...] }
        // We want to store just the 'current' part which matches AudioDeviceSetup interface
        const raw = response.current || response;
        set({ audioDeviceSetup: {
          deviceType: raw.audioDeviceType ?? raw.deviceType ?? "",
          inputDevice: raw.inputDevice ?? "",
          outputDevice: raw.outputDevice ?? "",
          sampleRate: raw.sampleRate ?? 44100,
          bufferSize: raw.bufferSize ?? 512,
          numInputChannels: (raw as Record<string, unknown>).numInputChannels as number ?? 2,
          numOutputChannels: (raw as Record<string, unknown>).numOutputChannels as number ?? 2,
          numActiveInputChannels: (raw as Record<string, unknown>).numActiveInputChannels as number ?? undefined,
          numActiveOutputChannels: (raw as Record<string, unknown>).numActiveOutputChannels as number ?? undefined,
          inputChannelNames: (raw as Record<string, unknown>).inputChannelNames as string[] | undefined,
          outputChannelNames: (raw as Record<string, unknown>).outputChannelNames as string[] | undefined,
        } });
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
    trackRecentAction: (actionId: string) =>
      set((state: any) => ({
        recentActions: [actionId, ...state.recentActions.filter((a: string) => a !== actionId)].slice(0, 10),
      })),

    // ========== Quantize Clips → store/actions/quantize.ts ==========
    toggleMoveEnvelopesWithItems: () => set((s: any) => ({ moveEnvelopesWithItems: !s.moveEnvelopesWithItems })),
    // ========== Screensets → store/actions/screensets.ts ==========
    // ========== Custom Actions (Macros) → store/actions/macros.ts ==========
    // ========== Render Queue → store/actions/renderQueue.ts ==========

    // ========== Engine Enhancements + Send/Bus + Render Pipeline → store/actions/rendering.ts ==========

    // ========== Step Sequencer → store/actions/midi.ts ==========

    // ========== Clip Launcher → store/actions/clipLauncher.ts ==========

    // ========== Step Input + MIDI Transform → store/actions/midi.ts ==========

    // ========== Plugin A/B + FX Chain Presets + Mixer Snapshots → store/actions/routing.ts ==========

    // ========== Bus/Group Creation (kept inline — small) ==========
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


    // ========== Project Templates → store/actions/project.ts ==========

    // ========== Collaborative Metadata → store/actions/project.ts ==========

    // Extracted domain actions (spread last to override any inline duplicates)
    ...uiStateActions(set),
    ...meteringActions(set, get),
    ...transportActions(set, get),
    ...clipActions(set, get),
    ...clipEditingActions(set, get),
    ...mixerActions(set, get),
    ...timelineActions(set, get),
    ...trackActions(set, get),
    ...automationActions(set, get),
    ...renderingActions(set, get),
    ...projectActions(set, get),
    ...midiActions(set, get),
    ...routingActions(set, get),
    ...clipLauncherActions(set, get),
    ...markerActions(set, get),
    ...screensetActions(set, get),
    ...macroActions(set, get),
    ...renderQueueActions(set, get),
    ...quantizeActions(set, get),
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

export function applyTheme(themeName: string, overrides: Record<string, string>) {
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

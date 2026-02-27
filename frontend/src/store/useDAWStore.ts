import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { nativeBridge } from "../services/NativeBridge";
import { Command, commandManager } from "./commands";
import { calculateGridInterval } from "../utils/snapToGrid";

// Module-level snapshot map for continuous edit undo/redo (volume/pan fader drags).
// Stores the value at edit start so we can create a single undo command on edit end.
const _editSnapshots = new Map<string, number>();

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

export type TrackType = "audio" | "midi" | "instrument";
export type InputType = "mono" | "stereo" | "midi";

// MIDI Event structure
export interface MIDIEvent {
  timestamp: number; // Time in seconds from clip start
  type: "noteOn" | "noteOff" | "cc" | "pitchBend";
  note?: number; // 0-127 for note events
  velocity?: number; // 0-127 for note events
  controller?: number; // CC number
  value?: number; // CC value or pitch bend
}

// MIDI Clip structure
export interface MIDIClip {
  id: string;
  name: string;
  startTime: number; // Position on timeline in seconds
  duration: number; // Duration in seconds
  events: MIDIEvent[];
  color: string;
}

export type AutomationParam = "volume" | "pan" | "mute";

export interface AutomationPoint {
  time: number; // Position in seconds
  value: number; // 0.0 to 1.0 normalized value
}

export interface AutomationLane {
  id: string;
  param: AutomationParam;
  points: AutomationPoint[];
  visible: boolean;
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
  freeY?: number; // Free positioning Y offset in pixels
  takes?: AudioClip[]; // Alternative takes for comping
  activeTakeIndex?: number; // Which take is active (undefined = main clip)
  sourceLength?: number; // Full duration of source audio file (for resize clamping after split)
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
  }>;

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

  // Meter state — stored separately from `tracks` so that 10Hz meter updates
  // never give tracks a new array reference.  Only ChannelStrip / TrackHeader
  // subscribe to these; Timeline and App are completely unaffected.
  meterLevels: Record<string, number>;
  peakLevels: Record<string, number>;

  // Record & Edit Modes
  recordMode: "normal" | "overdub" | "replace";
  rippleMode: "off" | "per_track" | "all_tracks";

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
  gridSize: "bar" | "beat" | "half_beat" | "quarter_beat";
  toolMode: "select" | "split";

  // UI State
  showMixer: boolean;
  showMasterTrackInTCP: boolean;
  showSettings: boolean;
  showRenderModal: boolean;
  showPluginBrowser: boolean;
  pluginBrowserTrackId: string | null;
  showVirtualKeyboard: boolean;
  showUndoHistory: boolean;
  showCommandPalette: boolean;
  showRegionMarkerManager: boolean;
  showClipProperties: boolean;
  showBigClock: boolean;
  bigClockFormat: "time" | "beats";
  showKeyboardShortcuts: boolean;
  showPreferences: boolean;
  timecodeMode: "time" | "beats" | "smpte";
  smpteFrameRate: 24 | 25 | 29.97 | 30;

  // Piano Roll
  showPianoRoll: boolean;
  pianoRollTrackId: string | null;
  pianoRollClipId: string | null;

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

  // Auto-Backup
  autoBackupEnabled: boolean;
  autoBackupInterval: number; // milliseconds

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

  // Track Templates
  saveTrackTemplate: (trackId: string, name: string) => void;
  loadTrackTemplate: (templateId: string) => void;
  deleteTrackTemplate: (templateId: string) => void;

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

  // Metering
  setTrackMeterLevel: (trackId: string, level: number) => void;
  batchUpdateMeterLevels: (levels: Record<string, number>, masterLevel: number) => void;
  setMasterLevel: (level: number) => void;

  // Timeline View
  setZoom: (pixelsPerSecond: number) => void;
  setScroll: (x: number, y: number) => void;
  setTrackHeight: (height: number) => void;
  setTcpWidth: (width: number) => void;
  toggleSnap: () => void;
  setGridSize: (size: "bar" | "beat" | "half_beat" | "quarter_beat") => void;

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
  setToolMode: (mode: "select" | "split") => void;
  toggleSplitTool: () => void;

  // Clip Editing
  splitClipAtPlayhead: () => void;
  splitClipAtPosition: (clipId: string, splitTime: number) => void;
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
  addAutomationPoint: (trackId: string, laneId: string, time: number, value: number) => void;
  removeAutomationPoint: (trackId: string, laneId: string, pointIndex: number) => void;
  moveAutomationPoint: (trackId: string, laneId: string, pointIndex: number, time: number, value: number) => void;
  toggleAutomationLaneVisibility: (trackId: string, laneId: string) => void;
  clearAutomationLane: (trackId: string, laneId: string) => void;

  // Track Freeze (Phase 5)
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
  toggleVirtualKeyboard: () => void;
  toggleUndoHistory: () => void;
  toggleCommandPalette: () => void;
  toggleRegionMarkerManager: () => void;
  toggleClipProperties: () => void;
  toggleBigClock: () => void;
  toggleBigClockFormat: () => void;
  toggleKeyboardShortcuts: () => void;
  togglePreferences: () => void;
  setTimecodeMode: (mode: "time" | "beats" | "smpte") => void;
  setSmpteFrameRate: (rate: 24 | 25 | 29.97 | 30) => void;

  // Cut/Copy within Time Selection
  cutWithinTimeSelection: () => void;
  copyWithinTimeSelection: () => void;

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
  exportDDP: (outputDir: string) => Promise<boolean>;
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
    { id: "vol", param: "volume", points: [], visible: true },
    { id: "pan", param: "pan", points: [], visible: false },
  ],
  showAutomation: false,
  frozen: false,
  takes: [],
  activeTakeIndex: 0,
  sends: [],
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
    meterLevels: {},
    peakLevels: {},
    pixelsPerSecond: 50,
    scrollX: 0,
    scrollY: 0,
    trackHeight: 100,
    tcpWidth: 310,
    recordMode: "normal",
    rippleMode: "off",
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
    showVirtualKeyboard: false,
    showUndoHistory: false,
    showClipProperties: false,
    showBigClock: false,
    bigClockFormat: "time",
    showKeyboardShortcuts: false,
    showPreferences: false,
    timecodeMode: "time",
    smpteFrameRate: 24,
    showCommandPalette: false,
    showRegionMarkerManager: false,
    showPianoRoll: false,
    pianoRollTrackId: null,
    pianoRollClipId: null,
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

    // ========== Toast ==========
    showToast: (message, type = "info") => {
      set({ toastMessage: message, toastType: type, toastVisible: true });
      setTimeout(() => set({ toastVisible: false }), 3000);
    },

    // ========== Project Management (F2) ==========
    newProject: async () => {
      // Stop playback
      get().stop();

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
      };

      const success = await nativeBridge.saveProjectToFile(
        path,
        JSON.stringify(projectData, null, 2),
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
            automationLanes: t.automationLanes ?? defaults.automationLanes,
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
        }));

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
          set((state) => ({
            tracks: [...state.tracks, fullTrack],
          }));
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

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "armed");
      const newArmed = !track.armed;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          linkedIds.includes(t.id) ? { ...t, armed: newArmed } : t,
        ),
      }));

      for (const tid of linkedIds) await nativeBridge.setTrackRecordArm(tid, newArmed);
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
    },
    beginTrackPanEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "pan");
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) _editSnapshots.set("pan_" + tid, t.pan);
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
      const { playStartPosition, transport, addClip } = get();
      const wasRecording = transport.isRecording;
      console.log("[useDAWStore] STOP called. Was recording:", wasRecording);

      set((state) => ({
        transport: {
          ...state.transport,
          isPlaying: false,
          isPaused: false,
          isRecording: false,
          currentTime: playStartPosition, // Return to start position
        },
        recordingClips: [], // Clear recording clips
        // Reset scroll to bring playhead into view (scroll to start position)
        scrollX: Math.max(0, playStartPosition * state.pixelsPerSecond - 100), // Keep 100px margin
        // Reset all meter levels to zero immediately on stop
        masterLevel: 0,
        meterLevels: {},
        peakLevels: {},
      }));
      console.log(
        "[useDAWStore] STOP State updated. Transport stopped, recordingClips cleared.",
      );

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

        for (const clipInfo of newClips) {
          console.log("[useDAWStore] Recording clip:", clipInfo.trackId,
            "startTime:", clipInfo.startTime.toFixed(3),
            "duration:", clipInfo.duration.toFixed(3),
            "file:", clipInfo.filePath);

          if (clipInfo.duration <= 0) {
            console.warn("[useDAWStore] Skipping 0-duration clip for track", clipInfo.trackId);
            continue;
          }

          const track = currentTracks.find((t) => t.id === clipInfo.trackId);
          const clipColor = track?.color || "#4361ee";

          const newClip: AudioClip = {
            id: crypto.randomUUID(),
            name: "Recording",
            filePath: clipInfo.filePath,
            startTime: clipInfo.startTime,
            duration: clipInfo.duration,
            offset: 0,
            color: clipColor,
            volumeDB: 0,
            fadeIn: 0,
            fadeOut: 0,
            sampleRate: get().audioDeviceSetup?.sampleRate || 44100,
          };

          if (currentRecordMode === "replace") {
            // Replace mode: remove any existing clips that overlap the recorded region
            const recStart = clipInfo.startTime;
            const recEnd = clipInfo.startTime + clipInfo.duration;
            set((s) => ({
              tracks: s.tracks.map((t) =>
                t.id === clipInfo.trackId
                  ? {
                      ...t,
                      clips: t.clips.filter((c) => {
                        const clipEnd = c.startTime + c.duration;
                        // Remove clips fully inside the recording range
                        // Trim clips partially overlapping (simple: remove if any overlap)
                        return clipEnd <= recStart || c.startTime >= recEnd;
                      }),
                    }
                  : t,
              ),
            }));
          }
          // Normal and overdub both layer on top (overdub is the default DAW behavior)
          addClip(clipInfo.trackId, newClip);

          // Register immediately with the playback backend so play() works right away
          // without needing syncClipsWithBackend() to know about this clip.
          nativeBridge.addPlaybackClip(
            clipInfo.trackId,
            clipInfo.filePath,
            clipInfo.startTime,
            clipInfo.duration,
            0, // offset — freshly recorded clips start at 0
            newClip.volumeDB || 0,
            newClip.fadeIn || 0,
            newClip.fadeOut || 0,
          ).catch((e) => console.warn("[useDAWStore] addPlaybackClip after record failed:", e));
        }
      }

      // Reset backend position to start position
      await nativeBridge.setTransportPosition(playStartPosition);
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
      const { tracks } = get();
      await nativeBridge.clearPlaybackClips();
      for (const track of tracks) {
        for (const clip of track.clips) {
          if (clip.filePath && !clip.muted) {
            await nativeBridge.addPlaybackClip(
              track.id,
              clip.filePath,
              clip.startTime,
              clip.duration,
              clip.offset || 0,
              clip.volumeDB || 0,
              clip.fadeIn || 0,
              clip.fadeOut || 0,
            );
          }
        }
      }
      console.log("[DAW] Synced all clips with backend");
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
      const { clipboard } = get();
      if (!clipboard.clip) return;

      // Generate new ID for pasted clip
      const newClip: AudioClip = {
        ...clipboard.clip,
        id: crypto.randomUUID(),
        startTime: targetTime,
      };

      set((state) => {
        // If it was a cut operation, remove original clip
        let newTracks = state.tracks;
        if (clipboard.isCut) {
          newTracks = state.tracks.map((t) => ({
            ...t,
            clips: t.clips.filter((c) => c.id !== clipboard.clip!.id),
          }));
        }

        return {
          tracks: newTracks.map((t) =>
            t.id === targetTrackId ? { ...t, clips: [...t.clips, newClip] } : t,
          ),
          // Clear clipboard if cut
          clipboard: clipboard.isCut
            ? { clip: null, clips: [], isCut: false }
            : state.clipboard,
        };
      });
    },

    pasteClips: () => {
      const state = get();
      const { clipboard } = state;
      if (clipboard.clips.length === 0) return;

      const currentTime = state.transport.currentTime;

      // Find the earliest clip time to compute relative offsets
      const earliestTime = Math.min(...clipboard.clips.map((c) => c.clip.startTime));

      if (clipboard.clips.length === 1) {
        // Single clip: paste on selected track (or first track), at playhead
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
          };
        });
      } else {
        // Multi clip: preserve relative track positions and time offsets
        // Group clips by their source track
        const trackOrder = state.tracks.map((t) => t.id);
        const sourceTrackIndices = [...new Set(clipboard.clips.map((c) => c.trackId))];
        sourceTrackIndices.sort((a, b) => trackOrder.indexOf(a) - trackOrder.indexOf(b));

        // Map source tracks to target tracks (selected tracks, or create new ones)
        const targetTrackIds: string[] = [];
        const newTracks: Array<{ id: string; name: string; color: string }> = [];

        if (state.selectedTrackIds.length >= sourceTrackIndices.length) {
          // Enough selected tracks — use them in order
          for (let i = 0; i < sourceTrackIndices.length; i++) {
            targetTrackIds.push(state.selectedTrackIds[i]);
          }
        } else {
          // Not enough tracks selected — use existing track positions or create new
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

        // Build the source→target track mapping
        const trackMap = new Map<string, string>();
        sourceTrackIndices.forEach((srcId, i) => {
          trackMap.set(srcId, targetTrackIds[i]);
        });

        // Create new clips with time offsets relative to playhead
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

          // If cut, remove originals
          if (clipboard.isCut) {
            const origIds = new Set(clipboard.clips.map((c) => c.clip.id));
            tracks = tracks.map((t) => ({
              ...t,
              clips: t.clips.filter((c) => !origIds.has(c.id)),
            }));
          }

          // Add new clips to target tracks
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
          };
        });

        // Add new tracks if needed (addTrack is async, do it after state update)
        for (const newTrack of newTracks) {
          get().addTrack(newTrack);
        }
      }
    },

    nudgeClips: (direction, fine) => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      const amount = fine
        ? 0.01 // 10ms fine nudge
        : calculateGridInterval(state.transport.tempo, state.timeSignature, state.gridSize);
      const delta = direction === "right" ? amount : -amount;

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
    },

    ungroupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

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
    },

    normalizeSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      // Normalize sets clip volume to 0 dB (reset any manual volume adjustment)
      // True peak normalization would require backend waveform analysis;
      // for now we reset volumeDB to 0 which is "unity gain"
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

      set((s) => ({
        tracks: s.tracks.map((track) => {
          const editsForTrack = s.razorEdits.filter((r) => r.trackId === track.id);
          if (editsForTrack.length === 0) return track;

          let clips = [...track.clips];
          for (const razor of editsForTrack) {
            const newClips: AudioClip[] = [];
            for (const clip of clips) {
              const clipEnd = clip.startTime + clip.duration;

              // No overlap — keep as is
              if (clipEnd <= razor.start || clip.startTime >= razor.end) {
                newClips.push(clip);
                continue;
              }

              // Left portion (before razor)
              if (clip.startTime < razor.start) {
                newClips.push({
                  ...clip,
                  id: crypto.randomUUID(),
                  duration: razor.start - clip.startTime,
                  fadeOut: 0,
                });
              }

              // Right portion (after razor)
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
              // Middle portion is deleted (not added to newClips)
            }
            clips = newClips;
          }

          return { ...track, clips };
        }),
        razorEdits: [],
        isModified: true,
      }));
    },

    // ========== Track Automation (Phase 5) ==========
    toggleTrackAutomation: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, showAutomation: !t.showAutomation } : t,
        ),
      }));
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
      set((s) => ({
        tracks: s.tracks.map((t) => {
          if (t.id !== trackId) return t;
          return {
            ...t,
            automationLanes: t.automationLanes.map((lane) =>
              lane.id === laneId ? { ...lane, points: [] } : lane,
            ),
          };
        }),
        isModified: true,
      }));
    },

    // ========== Track Freeze (Phase 5) ==========
    freezeTrack: (trackId) => {
      // Mark track as frozen — in a full implementation this would
      // render the track to a temp audio file and bypass FX
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, frozen: true } : t,
        ),
      }));
    },

    unfreezeTrack: (trackId) => {
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, frozen: false, freezeFilePath: undefined } : t,
        ),
      }));
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
    },

    removeTempoMarker: (id) => {
      set((state) => ({
        tempoMarkers: state.tempoMarkers.filter((m) => m.id !== id),
        isModified: true,
      }));
    },

    updateTempoMarker: (id, updates) => {
      set((state) => ({
        tempoMarkers: state.tempoMarkers
          .map((m) => (m.id === id ? { ...m, ...updates } : m))
          .sort((a, b) => a.time - b.time),
        isModified: true,
      }));
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
    togglePreferences: () =>
      set((state) => ({ showPreferences: !state.showPreferences })),
    setTimecodeMode: (mode) => set({ timecodeMode: mode }),
    setSmpteFrameRate: (rate) => set({ smpteFrameRate: rate }),

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
          // Clip overlaps the selection
          if (clip.startTime < end && clipEnd > start) {
            // Create a trimmed copy representing only the overlapping portion
            const trimStart = Math.max(clip.startTime, start);
            const trimEnd = Math.min(clipEnd, end);
            const trimmedClip: AudioClip = {
              ...clip,
              id: crypto.randomUUID(),
              startTime: 0, // Relative to paste position
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

      // Store in clipboard
      set({
        clipboard: { clip: clipsInRange[0]?.clip || null, clips: clipsInRange, isCut: true },
      });

      // Remove content within the selection (like razor edit)
      set((s) => ({
        tracks: s.tracks.map((track) => {
          let clips = [...track.clips];
          const newClips: AudioClip[] = [];
          for (const clip of clips) {
            const clipEnd = clip.startTime + clip.duration;
            if (clipEnd <= start || clip.startTime >= end) {
              newClips.push(clip);
              continue;
            }
            // Left portion
            if (clip.startTime < start) {
              newClips.push({ ...clip, id: crypto.randomUUID(), duration: start - clip.startTime, fadeOut: 0 });
            }
            // Right portion
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

    // ========== Record & Edit Modes ==========
    setRecordMode: (mode) => set({ recordMode: mode }),
    setRippleMode: (mode) => set({ rippleMode: mode }),

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
      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, locked: !clip.locked } : clip,
          ),
        })),
        isModified: true,
      }));
    },

    setClipColor: (clipId, color) => {
      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, color } : clip,
          ),
        })),
        isModified: true,
      }));
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
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (!s.selectedClipIds.includes(c.id)) return c;
            const snappedStart = Math.round(c.startTime / gridInterval) * gridInterval;
            return { ...c, startTime: snappedStart };
          }),
        })),
        isModified: true,
      }));
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

      // If already reversed, reverse again (which gives back original-like file)
      const reversedPath = await nativeBridge.reverseAudioFile(targetClip.filePath);
      if (!reversedPath) return;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === targetTrackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? {
                        ...c,
                        filePath: reversedPath,
                        reversed: !c.reversed,
                      }
                    : c
                ),
              }
            : t
        ),
      }));
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
            ? { ...t, sends: [...t.sends, { destTrackId, level: 0.5, pan: 0, enabled: true, preFader: false }] }
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
      for (const track of state.tracks) {
        clip = track.clips.find((c) => c.id === clipId);
        if (clip) break;
      }
      if (!clip) return;
      // Update the rate property (actual stretching requires backend call)
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, playbackRate: rate } : c,
          ),
        })),
      }));
    },
    setClipPitch: async (clipId, semitones) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, pitchSemitones: semitones } : c,
          ),
        })),
      }));
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
    exportDDP: async (outputDir) => {
      try {
        const regions = get().regions;
        return await nativeBridge.exportDDP(outputDir, regions);
      } catch (err) {
        console.error("[Store] Failed to export DDP:", err);
        return false;
      }
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
      "--color-daw-accent": "#00aaff",
      "--color-daw-border": "#444444",
      "--color-daw-border-light": "#666666",
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

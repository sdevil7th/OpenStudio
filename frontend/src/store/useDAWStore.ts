import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { nativeBridge } from "../services/NativeBridge";
import { Command, commandManager } from "./commands";

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
  metronomeAccentBeats: boolean[]; // Which beats in the bar should be accented (index 0 = beat 1, etc.)
  timeSignature: { numerator: number; denominator: number };
  tapTimestamps: number[]; // For tap tempo feature (stores last 8 taps)

  // Clip Editing
  selectedClipId: string | null;
  clipboard: {
    clip: AudioClip | null;
    isCut: boolean;
  };

  // Markers and Regions
  markers: Marker[];
  regions: Region[];

  // Master
  masterVolume: number;
  masterPan: number;
  masterLevel: number;
  isMasterMuted: boolean;

  // Timeline View
  pixelsPerSecond: number;
  scrollX: number;
  scrollY: number;
  trackHeight: number; // For Vertical Zoom
  snapEnabled: boolean;
  gridSize: "bar" | "beat" | "half_beat" | "quarter_beat";

  // UI State
  showMixer: boolean;
  showSettings: boolean;
  showRenderModal: boolean;
  showPluginBrowser: boolean;
  pluginBrowserTrackId: string | null;
  showVirtualKeyboard: boolean;

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
}

// ============================================
// Store Actions Interface
// ============================================

interface DAWActions {
  // Project Management (F2)
  newProject: () => Promise<void>;
  saveProject: (saveAs?: boolean) => Promise<boolean>;
  loadProject: (path?: string) => Promise<boolean>;
  setModified: (modified: boolean) => void;

  // Track Management
  addTrack: (track: Partial<Track> & { id: string; name: string }) => void;
  removeTrack: (id: string) => Promise<void>;
  updateTrack: (id: string, updates: Partial<Track>) => void;
  reorderTrack: (activeId: string, overId: string) => void;
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
  toggleTrackMonitor: (id: string) => Promise<void>;
  setTrackInput: (
    id: string,
    startChannel: number,
    channelCount: number,
  ) => Promise<void>;

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
  setMetronomeAccentBeats: (accentBeats: boolean[]) => void;
  setTimeSignature: (numerator: number, denominator: number) => void;
  tapTempo: () => void;

  // Master Controls
  setMasterVolume: (volume: number) => Promise<void>;
  setMasterPan: (pan: number) => Promise<void>;
  toggleMasterMute: () => void;

  // Metering
  setTrackMeterLevel: (trackId: string, level: number) => void;
  setMasterLevel: (level: number) => void;

  // Timeline View
  setZoom: (pixelsPerSecond: number) => void;
  setScroll: (x: number, y: number) => void;
  setTrackHeight: (height: number) => void;
  toggleSnap: () => void;
  setGridSize: (size: "bar" | "beat" | "half_beat" | "quarter_beat") => void;

  // Clips
  addClip: (trackId: string, clip: AudioClip) => void;
  removeClip: (trackId: string, clipId: string) => void;
  importMedia: (
    filePath: string,
    trackId: string,
    startTime: number,
  ) => Promise<void>;

  // Clip Editing
  selectClip: (clipId: string | null) => void;
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
  setClipVolume: (clipId: string, volumeDB: number) => void;
  setClipFades: (clipId: string, fadeIn: number, fadeOut: number) => void;
  copyClip: (clipId: string) => void;
  cutClip: (clipId: string) => void;
  pasteClip: (targetTrackId: string, targetTime: number) => void;
  deleteClip: (clipId: string) => void;
  duplicateClip: (clipId: string) => void;

  // Markers and Regions
  addMarker: (time: number, name?: string) => void;
  removeMarker: (id: string) => void;
  updateMarker: (id: string, updates: Partial<Marker>) => void;
  addRegion: (start: number, end: number, name?: string) => void;
  removeRegion: (id: string) => void;
  updateRegion: (id: string, updates: Partial<Region>) => void;

  // UI State
  toggleMixer: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openProjectSettings: () => void;
  closeProjectSettings: () => void;
  openRenderModal: () => void;
  closeRenderModal: () => void;
  openPluginBrowser: (trackId: string) => void;
  closePluginBrowser: () => void;
  toggleVirtualKeyboard: () => void;

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
  meterLevel: 0,
  peakLevel: 0,
  clipping: false,
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
    metronomeAccentBeats: [true, false, false, false], // Accent beat 1 by default (4/4 time)
    timeSignature: { numerator: 4, denominator: 4 },
    tapTimestamps: [],
    selectedClipId: null,
    clipboard: {
      clip: null,
      isCut: false,
    },
    markers: [],
    regions: [],
    masterVolume: 1.0,
    masterPan: 0.0,
    masterLevel: 0,
    isMasterMuted: false,
    pixelsPerSecond: 50,
    scrollX: 0,
    scrollY: 0,
    trackHeight: 100,
    snapEnabled: true,
    gridSize: "bar",
    showMixer: true,
    showSettings: false,
    showRenderModal: false,
    showPluginBrowser: false,
    pluginBrowserTrackId: null,
    showVirtualKeyboard: false,
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
        canUndo: false,
        canRedo: false,
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

      const state = get();

      // 1. Serialize Tracks with Plugin States
      const serializedTracks = await Promise.all(
        state.tracks.map(async (track) => {
          // Fetch input FX states
          const inputFXStates: string[] = [];
          // We assume inputType tells us something but we mostly rely on what's loaded
          // Since we don't track numInputFX in frontend strictly, we need to ask backend?
          // Actually, we should probably add getTrackInputFX/getTrackFX to nativeBridge to get the list
          // But for now, let's assume valid state is in store or we iterate a reasonable number?
          // BETTER: Use nativeBridge.getTrackInputFX(track.id) to get count/list

          const inputFXList = await nativeBridge.getTrackInputFX(track.id);
          for (let i = 0; i < inputFXList.length; i++) {
            const fxState = await nativeBridge.getPluginState(
              track.id,
              i,
              true,
            );
            if (fxState) inputFXStates.push(fxState);
          }

          const trackFXStates: string[] = [];
          const trackFXList = await nativeBridge.getTrackFX(track.id);
          for (let i = 0; i < trackFXList.length; i++) {
            const fxState = await nativeBridge.getPluginState(
              track.id,
              i,
              false,
            );
            if (fxState) trackFXStates.push(fxState);
          }

          return {
            id: track.id,
            name: track.name,
            color: track.color,
            type: track.type,
            volumeDB: track.volumeDB,
            pan: track.pan,
            muted: track.muted,
            soloed: track.soloed,
            armed: track.armed,
            monitorEnabled: track.monitorEnabled,
            inputChannel: track.inputChannel,
            clips: track.clips, // Clips are already serializable (paths are absolute)
            // MIDI clips...
            midiClips: track.midiClips,
            // Serialized plugin states
            inputFXStates,
            trackFXStates,
            // Instrument?
            instrumentPlugin: track.instrumentPlugin, // We might need state for this too if it's separate
          };
        }),
      );

      // 2. Master Bus
      // Serialize master FX here if we had them trackable in frontend
      // For now just volume/pan

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
      };

      const success = await nativeBridge.saveProjectToFile(
        path,
        JSON.stringify(projectData, null, 2),
      );

      if (success) {
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
        // TODO: Persist recentProjects to localStorage
        localStorage.setItem(
          "recentProjects",
          JSON.stringify(get().recentProjects),
        );
      }

      return success;
    },

    loadProject: async (path) => {
      if (!path) {
        path = await nativeBridge.showOpenDialog();
        if (!path) return false;
      }

      const json = await nativeBridge.loadProjectFromFile(path);
      if (!json) return false;

      try {
        const data = JSON.parse(json);

        // Result current project
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

        // Restore Tracks
        for (const trackData of data.tracks) {
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

            if (trackData.inputChannel) {
              await nativeBridge.setTrackInputChannels(
                trackData.id,
                trackData.inputStartChannel || 0,
                trackData.inputChannelCount || 2,
              );
            }

            // 3. Restore Clips (Backend)
            if (trackData.clips) {
              for (const clip of trackData.clips) {
                if (clip.filePath) {
                  await nativeBridge.addPlaybackClip(
                    trackData.id,
                    clip.filePath,
                    clip.startTime,
                    clip.duration,
                  );
                }
              }
            }

            // 4. Restore Plugins (TODO: backend needs to return plugin paths in getTrackFX to save them)
            // For now, we skip plugin instantiation.
          } catch (err) {
            console.error(`Failed to restore track ${trackData.name}`, err);
          }
        }

        // Update Store State
        set((state) => ({
          tracks: data.tracks, // Assume JSON structure matches Track interface
          projectPath: path,
          isModified: false,
          // ... other properties set above via getters or needing set() ...
          // Actually we should just update the state once with all data
          transport: { ...state.transport, tempo: data.tempo || 120 },
          timeSignature: data.timeSignature || { numerator: 4, denominator: 4 },
          masterVolume: data.masterVolume ?? 1.0,
          masterPan: data.masterPan ?? 0.0,
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

        return true;
      } catch (e) {
        console.error("Failed to parse project file", e);
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
      set((state) => ({
        tracks: [...state.tracks, { ...newTrack, ...trackData }],
      }));
    },

    removeTrack: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);

      // Clear clips from backend playback engine first
      if (track) {
        for (const clip of track.clips) {
          if (clip.filePath) {
            await nativeBridge.removePlaybackClip(id, clip.filePath);
          }
        }
      }

      // Remove track from backend
      await nativeBridge.removeTrack(id);

      // Remove from frontend state
      set((state) => ({
        tracks: state.tracks.filter((t) => t.id !== id),
        selectedTrackId:
          state.selectedTrackId === id ? null : state.selectedTrackId,
      }));
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
      set((state) => {
        const oldIndex = state.tracks.findIndex((t) => t.id === activeId);
        const newIndex = state.tracks.findIndex((t) => t.id === overId);

        if (oldIndex === -1 || newIndex === -1) return state;

        // Create new array with reordered tracks
        const newTracks = [...state.tracks];
        const [movedTrack] = newTracks.splice(oldIndex, 1);
        newTracks.splice(newIndex, 0, movedTrack);

        // Call backend to update order
        nativeBridge.reorderTrack(activeId, newIndex);

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
        // Single selection: replace selection with just this track
        set({
          selectedTrackId: id,
          selectedTrackIds: [id],
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
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      // Convert dB to linear for display
      const linear = Math.pow(10, volumeDB / 20);

      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === id ? { ...t, volumeDB, volume: Math.min(1, linear) } : t,
        ),
      }));

      await nativeBridge.setTrackVolume(id, volumeDB);
    },

    setTrackPan: async (id, pan) => {
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      set((state) => ({
        tracks: state.tracks.map((t) => (t.id === id ? { ...t, pan } : t)),
      }));

      await nativeBridge.setTrackPan(id, pan);
    },

    toggleTrackMute: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const newMuted = !track.muted;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id ? { ...t, muted: newMuted } : t,
        ),
      }));

      await nativeBridge.setTrackMute(id, newMuted);
    },

    toggleTrackSolo: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const newSoloed = !track.soloed;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id ? { ...t, soloed: newSoloed } : t,
        ),
      }));

      await nativeBridge.setTrackSolo(id, newSoloed);
    },

    toggleTrackArmed: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const newArmed = !track.armed;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id ? { ...t, armed: newArmed } : t,
        ),
      }));

      await nativeBridge.setTrackRecordArm(id, newArmed);
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

    // ========== Transport Controls ==========
    play: async () => {
      const { tracks, transport } = get();

      // Store the start position for stop behavior
      set({ playStartPosition: transport.currentTime });

      // Sync transport position with backend before starting
      await nativeBridge.setTransportPosition(transport.currentTime);

      // Sync all clips with backend for playback
      console.log("[DAW] Syncing clips with backend for playback...");
      await nativeBridge.clearPlaybackClips();

      for (const track of tracks) {
        for (const clip of track.clips) {
          await nativeBridge.addPlaybackClip(
            track.id,
            clip.filePath,
            clip.startTime,
            clip.duration,
          );
          console.log(`[DAW] Added clip to track ${track.id}: ${clip.name}`);
        }
      }

      console.log("[DAW] Clip sync complete, starting playback");

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
      const { tracks, transport } = get();
      const armedTracks = tracks
        .map((t) => ({ track: t }))
        .filter(({ track }) => track.armed);

      const wasAlreadyPlaying = transport.isPlaying;

      // Store the start position for stop behavior (only if not already playing)
      if (!wasAlreadyPlaying) {
        set({ playStartPosition: transport.currentTime });
      }

      // Create recording clips for armed tracks at current position
      const newRecordingClips: RecordingClip[] = armedTracks.map(
        ({ track }) => ({
          trackId: track.id,
          startTime: transport.currentTime,
        }),
      );

      // Only sync clips with backend if we're starting fresh (not already playing)
      if (!wasAlreadyPlaying) {
        // Sync transport position with backend before starting
        await nativeBridge.setTransportPosition(transport.currentTime);

        // Sync all clips with backend for playback
        console.log("[DAW] Syncing clips with backend for recording...");
        await nativeBridge.clearPlaybackClips();

        for (const track of tracks) {
          for (const clip of track.clips) {
            await nativeBridge.addPlaybackClip(
              track.id,
              clip.filePath,
              clip.startTime,
              clip.duration,
            );
            console.log(`[DAW] Added clip to track ${track.id}: ${clip.name}`);
          }
        }
        console.log("[DAW] Clip sync complete, starting recording");
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
        // Slight delay to ensure file handle is closed on backend?
        // Usually not needed if stopRecording is synchronous, which it is.
        const newClips = await nativeBridge.getLastCompletedClips();
        const currentTracks = get().tracks;
        console.log(
          "[useDAWStore] Received recorded clips:",
          JSON.stringify(newClips, null, 2),
        );

        newClips.forEach((clipInfo) => {
          // Find the track to get its color
          const track = currentTracks.find((t) => t.id === clipInfo.trackId);
          const clipColor = track?.color || "#4361ee"; // Use track color or default blue

          const newClip: AudioClip = {
            id: crypto.randomUUID(),
            name: "Recording", // Could use timestamp
            filePath: clipInfo.filePath,
            startTime: clipInfo.startTime,
            duration: clipInfo.duration,
            offset: 0,
            color: clipColor, // Use track's color
            volumeDB: 0,
            fadeIn: 0,
            fadeOut: 0,
          };
          addClip(clipInfo.trackId, newClip);
        });
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
      set((state) => ({
        transport: { ...state.transport, tempo },
      }));
      await nativeBridge.setTempo(tempo);
    },

    toggleLoop: () => {
      set((state) => ({
        transport: {
          ...state.transport,
          loopEnabled: !state.transport.loopEnabled,
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
    },

    setMetronomeAccentBeats: async (accentBeats) => {
      set({ metronomeAccentBeats: accentBeats });
      await nativeBridge.setMetronomeAccentBeats(accentBeats);
    },

    setTimeSignature: async (numerator, denominator) => {
      // Also update accent beats array to match new time signature
      const currentAccents = get().metronomeAccentBeats;
      const newAccents = Array(numerator).fill(false);
      // Preserve accents where possible, ensure beat 1 is always accented
      newAccents[0] = true;
      for (let i = 1; i < Math.min(currentAccents.length, numerator); i++) {
        newAccents[i] = currentAccents[i];
      }
      set({
        timeSignature: { numerator, denominator },
        metronomeAccentBeats: newAccents,
      });
      await nativeBridge.setTimeSignature(numerator, denominator);
      // Sync the updated accent beats to the backend
      await nativeBridge.setMetronomeAccentBeats(newAccents);
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
    setTrackMeterLevel: (trackId, level) => {
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                meterLevel: level,
                peakLevel: Math.max(t.peakLevel, level),
                clipping: level >= 0.95 || t.clipping, // Set clipping flag if >= 95%
              }
            : t,
        ),
      }));
    },

    setMasterLevel: (level) => set({ masterLevel: level }),

    // ========== Timeline View ==========
    setZoom: (pixelsPerSecond) => {
      set({ pixelsPerSecond: Math.max(10, Math.min(200, pixelsPerSecond)) });
    },

    setScroll: (x, y) => set({ scrollX: x, scrollY: y }),
    setTrackHeight: (height) => set({ trackHeight: height }),

    toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
    setGridSize: (size) => set({ gridSize: size }),

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

    importMedia: async (filePath, trackId, startTime) => {
      try {
        // Call backend to import media file (handles video extraction if needed)
        const mediaInfo = await nativeBridge.importMediaFile(filePath);

        // Create a new clip from the imported media
        const newClip: AudioClip = {
          id: crypto.randomUUID(),
          filePath: mediaInfo.filePath,
          startTime: startTime,
          duration: mediaInfo.duration,
          offset: 0,
          volumeDB: 0,
          fadeIn: 0,
          fadeOut: 0,
        };

        // Add clip to track
        get().addClip(trackId, newClip);

        // Register clip with backend for playback
        await nativeBridge.addPlaybackClip(
          trackId,
          newClip.filePath,
          newClip.startTime,
          newClip.duration,
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
    selectClip: (clipId) => {
      // Clear track selection when selecting a clip to avoid delete conflicts
      set({
        selectedClipId: clipId,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    moveClipToTrack: async (clipId, newTrackId, newStartTime) => {
      const state = get();

      // Find the clip and its current track
      let clipToMove: AudioClip | null = null;
      let sourceTrackId: string | null = null;
      let oldStartTime: number = 0;

      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          clipToMove = clip;
          sourceTrackId = track.id;
          oldStartTime = clip.startTime;
        }
      });

      if (!clipToMove || !sourceTrackId) return;

      // Get target track color for color inheritance
      const targetTrack = state.tracks.find((t) => t.id === newTrackId);
      const targetColor = targetTrack?.color;

      // Update local state first
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

        // Also sync with backend for same-track moves
        if ((clipToMove as AudioClip).filePath) {
          try {
            // Remove from old position and add at new position
            await nativeBridge.removePlaybackClip(
              sourceTrackId,
              (clipToMove as AudioClip).filePath,
            );
            await nativeBridge.addPlaybackClip(
              sourceTrackId,
              (clipToMove as AudioClip).filePath,
              newStartTime,
              (clipToMove as AudioClip).duration,
            );
            console.log(
              `[DAW] Clip moved within track: ${sourceTrackId}@${oldStartTime} -> ${sourceTrackId}@${newStartTime}`,
            );
          } catch (error) {
            console.error("[DAW] Failed to sync same-track clip move with backend:", error);
          }
        }
      } else {
        // Moving to a different track - inherit target track's color
        const updatedClip = {
          ...(clipToMove as AudioClip),
          startTime: newStartTime,
          color: targetColor || (clipToMove as AudioClip).color, // Inherit target track color
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

        // Sync with backend for cross-track moves
        // Only sync if clip has a file path (recorded/imported clips)
        if ((clipToMove as AudioClip).filePath) {
          try {
            // Remove from old track
            await nativeBridge.removePlaybackClip(
              sourceTrackId,
              (clipToMove as AudioClip).filePath,
            );
            // Add to new track at new position
            await nativeBridge.addPlaybackClip(
              newTrackId,
              (clipToMove as AudioClip).filePath,
              newStartTime,
              (clipToMove as AudioClip).duration,
            );
            console.log(
              `[DAW] Clip moved cross-track: ${sourceTrackId}@${oldStartTime} -> ${newTrackId}@${newStartTime}`,
            );
          } catch (error) {
            console.error("[DAW] Failed to sync cross-track clip move with backend:", error);
          }
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
      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) foundClip = clip;
      });

      if (foundClip) {
        set({ clipboard: { clip: foundClip, isCut: false } });
      }
    },

    cutClip: (clipId) => {
      const state = get();
      let foundClip: AudioClip | null = null;
      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) foundClip = clip;
      });

      if (foundClip) {
        set({ clipboard: { clip: foundClip, isCut: true } });
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
            ? { clip: null, isCut: false }
            : state.clipboard,
        };
      });
    },

    deleteClip: (clipId) => {
      const state = get();

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

      // Capture values for backend sync
      const clipFilePath = foundClip.filePath;
      const trackIdForBackend = foundTrackId;

      // Create and execute command
      const command: Command = {
        type: "DELETE_CLIP",
        description: `Delete clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          // Remove from frontend state
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.filter((c) => c.id !== clipId),
            })),
            selectedClipId:
              s.selectedClipId === clipId ? null : s.selectedClipId,
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
          // Restore to frontend state
          set((s) => ({
            tracks: s.tracks.map((track) => {
              if (track.id !== foundTrackId) return track;
              const newClips = [...track.clips];
              newClips.splice(clipIndex, 0, foundClip!);
              return { ...track, clips: newClips };
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

    // ========== UI State ==========
    toggleMixer: () => set((state) => ({ showMixer: !state.showMixer })),
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
  })),
);

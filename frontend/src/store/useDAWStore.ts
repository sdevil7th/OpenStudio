import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { nativeBridge } from "../services/NativeBridge";

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
  selectedTrackId: string | null;

  // Transport
  transport: TransportState;
  recordingClips: RecordingClip[]; // Tracks currently being recorded (for live visualization)
  playStartPosition: number; // Position where play/record was started (for stop behavior)

  // Metronome
  metronomeEnabled: boolean;
  metronomeAccentBeats: boolean[]; // Which beats in the bar should be accented (index 0 = beat 1, etc.)
  timeSignature: { numerator: number; denominator: number };

  // Clip Editing
  selectedClipId: string | null;
  clipboard: {
    clip: AudioClip | null;
    isCut: boolean;
  };

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

  // UI State
  showMixer: boolean;
  showSettings: boolean;
  showPluginBrowser: boolean;
  pluginBrowserTrackId: string | null;

  // Audio Device
  audioDeviceSetup: AudioDeviceSetup | null;
}

// ============================================
// Store Actions Interface
// ============================================

interface DAWActions {
  // Track Management
  addTrack: (track: Partial<Track> & { id: string; name: string }) => void;
  removeTrack: (id: string) => void;
  updateTrack: (id: string, updates: Partial<Track>) => void;
  reorderTrack: (activeId: string, overId: string) => void;
  selectTrack: (id: string | null) => void;

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
  toggleMetronome: () => void;
  setMetronomeAccentBeats: (accentBeats: boolean[]) => void;
  setTimeSignature: (numerator: number, denominator: number) => void;

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

  // Clips
  addClip: (trackId: string, clip: AudioClip) => void;
  removeClip: (trackId: string, clipId: string) => void;

  // Clip Editing
  selectClip: (clipId: string | null) => void;
  moveClipToTrack: (
    clipId: string,
    newTrackId: string,
    newStartTime: number,
  ) => void;
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

  // UI State
  toggleMixer: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openPluginBrowser: (trackId: string) => void;
  closePluginBrowser: () => void;

  // Audio Device
  setAudioDeviceSetup: (setup: AudioDeviceSetup) => void;
  refreshAudioDeviceSetup: () => Promise<void>;
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
    transport: initialTransport,
    recordingClips: [],
    playStartPosition: 0,
    metronomeEnabled: false,
    metronomeAccentBeats: [true, false, false, false], // Accent beat 1 by default (4/4 time)
    timeSignature: { numerator: 4, denominator: 4 },
    selectedClipId: null,
    clipboard: {
      clip: null,
      isCut: false,
    },
    masterVolume: 1.0,
    masterPan: 0.0,
    masterLevel: 0,
    isMasterMuted: false,
    pixelsPerSecond: 50,
    scrollX: 0,
    scrollY: 0,
    trackHeight: 100,
    showMixer: true,
    showSettings: false,
    showPluginBrowser: false,
    pluginBrowserTrackId: null,
    audioDeviceSetup: null,

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

    removeTrack: (id) => {
      set((state) => ({
        tracks: state.tracks.filter((t) => t.id !== id),
        selectedTrackId:
          state.selectedTrackId === id ? null : state.selectedTrackId,
      }));
    },

    updateTrack: (id, updates) => {
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === id ? { ...t, ...updates } : t,
        ),
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

    selectTrack: (id) => set({ selectedTrackId: id }),

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

      // Store the start position for stop behavior
      set({ playStartPosition: transport.currentTime });

      // Create recording clips for armed tracks
      const newRecordingClips: RecordingClip[] = armedTracks.map(
        ({ track }) => ({
          trackId: track.id,
          startTime: transport.currentTime,
        }),
      );

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
      await nativeBridge.setTransportPlaying(true);
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
        console.log(
          "[useDAWStore] Received recorded clips:",
          JSON.stringify(newClips, null, 2),
        );

        newClips.forEach((clipInfo) => {
          const newClip: AudioClip = {
            id: crypto.randomUUID(),
            name: "Recording", // Could use timestamp
            filePath: clipInfo.filePath,
            startTime: clipInfo.startTime,
            duration: clipInfo.duration,
            offset: 0,
            color: "#ff4444", // Default recording color
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

    // ========== Clip Editing ==========
    selectClip: (clipId) => {
      set({ selectedClipId: clipId });
    },

    moveClipToTrack: (clipId, newTrackId, newStartTime) => {
      set((state) => {
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

        if (!clipToMove || !sourceTrackId) return state;

        // If moving within the same track, just update the startTime
        if (sourceTrackId === newTrackId) {
          return {
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
          };
        }

        // Moving to a different track: remove from source and add to target
        const updatedClip = {
          ...(clipToMove as AudioClip),
          startTime: newStartTime,
        };

        return {
          tracks: state.tracks.map((track) => {
            if (track.id === sourceTrackId) {
              // Remove from source
              return {
                ...track,
                clips: track.clips.filter((c) => c.id !== clipId),
              };
            } else if (track.id === newTrackId) {
              // Add to target
              return { ...track, clips: [...track.clips, updatedClip] };
            }
            return track;
          }),
        };
      });
    },

    resizeClip: (clipId, newStartTime, newDuration, newOffset) => {
      set((state) => ({
        tracks: state.tracks.map((track) => ({
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
      set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, fadeIn, fadeOut } : clip,
          ),
        })),
      }));
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
      set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((c) => c.id !== clipId),
        })),
        selectedClipId:
          state.selectedClipId === clipId ? null : state.selectedClipId,
      }));
    },

    duplicateClip: (clipId) => {
      set((state) => ({
        tracks: state.tracks.map((track) => {
          const clip = track.clips.find((c) => c.id === clipId);
          if (!clip) return track;

          const newClip: AudioClip = {
            ...clip,
            id: crypto.randomUUID(),
            startTime: clip.startTime + clip.duration,
          };

          return {
            ...track,
            clips: [...track.clips, newClip],
          };
        }),
      }));
    },

    // ========== UI State ==========
    toggleMixer: () => set((state) => ({ showMixer: !state.showMixer })),
    openSettings: () => set({ showSettings: true }),
    closeSettings: () => set({ showSettings: false }),
    openPluginBrowser: (trackId) =>
      set({ showPluginBrowser: true, pluginBrowserTrackId: trackId }),
    closePluginBrowser: () =>
      set({ showPluginBrowser: false, pluginBrowserTrackId: null }),

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
  })),
);

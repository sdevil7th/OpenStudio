// @ts-nocheck
import { nativeBridge, type PolyNoteData } from "../../services/NativeBridge";
import { MIDI_NOTE_MIN_DURATION } from "../../utils/midiNotes";
import { commandManager, type Command } from "../commands";
import type { MIDIEvent } from "../useDAWStore";

type SetFn = (...args: any[]) => void;
type GetFn = () => any;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function midiEventPriority(event: MIDIEvent) {
  if (event.type === "noteOn") return 0;
  if (event.type === "noteOff") return 2;
  return 1;
}

function normalizeVelocity(value: unknown) {
  const numeric = Number(value);
  const raw = Number.isFinite(numeric)
    ? (numeric <= 1 ? numeric * 127 : numeric)
    : 90;
  return clamp(Math.round(raw), 1, 127);
}

export function mapPolyNotesToMIDIEvents(notes: PolyNoteData[] = [], clipDuration: number): MIDIEvent[] {
  const safeDuration = Math.max(MIDI_NOTE_MIN_DURATION, Number(clipDuration) || 0);
  const events: MIDIEvent[] = [];

  for (const note of notes) {
    const rawStart = Number(note?.startTime);
    const rawEnd = Number(note?.endTime);
    const rawPitch = Number(note?.midiPitch);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || !Number.isFinite(rawPitch)) {
      continue;
    }

    const start = clamp(rawStart, 0, safeDuration);
    const end = clamp(rawEnd, 0, safeDuration);
    if (end - start < MIDI_NOTE_MIN_DURATION) {
      continue;
    }

    const midiPitch = clamp(Math.round(rawPitch), 0, 127);
    events.push({
      timestamp: start,
      type: "noteOn",
      note: midiPitch,
      velocity: normalizeVelocity(note.velocity),
    });
    events.push({
      timestamp: end,
      type: "noteOff",
      note: midiPitch,
      velocity: 0,
    });
  }

  return events.sort((a, b) => (
    a.timestamp - b.timestamp
    || midiEventPriority(a) - midiEventPriority(b)
    || (a.note ?? 0) - (b.note ?? 0)
  ));
}

function findAudioClip(state: any, trackId: string, clipId: string) {
  const trackIndex = state.tracks.findIndex((track: any) => track.id === trackId);
  const track = trackIndex >= 0 ? state.tracks[trackIndex] : null;
  const clip = track?.clips.find((candidate: any) => candidate.id === clipId) ?? null;
  return { track, clip, trackIndex };
}

function insertGeneratedTrack(tracks: any[], sourceTrackId: string, generatedTrack: any) {
  if (tracks.some((track) => track.id === generatedTrack.id)) {
    return tracks;
  }

  const sourceIndex = tracks.findIndex((track) => track.id === sourceTrackId);
  const nextTracks = [...tracks];
  nextTracks.splice(sourceIndex >= 0 ? sourceIndex + 1 : tracks.length, 0, generatedTrack);
  return nextTracks;
}

async function syncGeneratedMIDITrack(get: GetFn, track: any) {
  await nativeBridge.addTrack(track.id, "midi").catch(() => "");
  await nativeBridge.setTrackType(track.id, "midi").catch(() => false);
  await get().syncMIDITrackToBackend?.(track.id, { debounce: false });
}

function createGeneratedMIDITrack(trackId: string, name: string, color: string) {
  return {
    id: trackId,
    name,
    color,
    type: "midi",
    inputType: "midi",
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
    midiPitchBendRangeUp: 2,
    midiPitchBendRangeDown: 2,
    midiPitchBendRangeLinked: true,
    instrumentPlugin: undefined,
    builtInInstrument: undefined,
    samplerSamplePath: undefined,
    samplerRootNote: 60,
    samplerSourceType: undefined,
    midiEffects: [],
    clips: [],
    midiClips: [],
    inputFxCount: 0,
    trackFxCount: 0,
    fxBypassed: false,
    meterLevel: 0,
    peakLevel: 0,
    clipping: false,
    automationLanes: [],
    showAutomation: false,
    automationReadEnabled: false,
    automationWriteEnabled: false,
    automationEnabled: false,
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
  };
}

export const audioToMidiActions = (set: SetFn, get: GetFn) => ({
  convertAudioClipToMIDI: async (trackId: string, clipId: string) => {
    const initial = findAudioClip(get(), trackId, clipId);
    if (!initial.track || !initial.clip) {
      get().showToast?.("Select an audio clip to convert to MIDI.", "error");
      return null;
    }

    const analysis = await nativeBridge.extractMidiFromAudio(trackId, clipId).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
      notes: [],
    }));

    if (!analysis) {
      get().showToast?.("Audio to MIDI analysis failed.", "error");
      return null;
    }
    if (analysis.error) {
      get().showToast?.(analysis.error, "error");
      return null;
    }

    const current = findAudioClip(get(), trackId, clipId);
    if (!current.track || !current.clip) {
      get().showToast?.("The source audio clip is no longer available.", "error");
      return null;
    }

    const clipDuration = Number(current.clip.duration);
    if (!Number.isFinite(clipDuration) || clipDuration <= 0) {
      get().showToast?.("Audio clip has no valid duration for MIDI conversion.", "error");
      return null;
    }

    const generatedTrackId = crypto.randomUUID();
    const generatedClipId = crypto.randomUUID();
    const sourceName = current.clip.name || "Audio";
    const events = mapPolyNotesToMIDIEvents(analysis.notes || [], clipDuration);
    const generatedTrack = {
      ...createGeneratedMIDITrack(
        generatedTrackId,
        `MIDI from ${sourceName}`,
        current.track.color || "#4361ee",
      ),
      midiClips: [{
        id: generatedClipId,
        name: `MIDI from ${sourceName}`,
        startTime: current.clip.startTime,
        duration: clipDuration,
        offset: 0,
        sourceStart: 0,
        sourceLength: clipDuration,
        loopEnabled: false,
        loopOffset: 0,
        loopLength: clipDuration,
        events,
        ccEvents: [],
        color: current.track.color || "#4361ee",
      }],
    };

    const command: Command = {
      type: "CONVERT_AUDIO_TO_MIDI",
      description: `Convert "${sourceName}" to MIDI`,
      timestamp: Date.now(),
      execute: () => {
        set((state: any) => ({
          tracks: insertGeneratedTrack(state.tracks, trackId, generatedTrack),
          selectedTrackId: generatedTrackId,
          selectedTrackIds: [generatedTrackId],
          lastSelectedTrackId: generatedTrackId,
          selectedClipId: generatedClipId,
          selectedClipIds: [generatedClipId],
          isModified: true,
        }));
        void syncGeneratedMIDITrack(get, generatedTrack).catch((error) => {
          console.error("[AudioToMIDI] Failed to sync generated MIDI track:", error);
        });
      },
      undo: () => {
        void nativeBridge.removeTrack(generatedTrackId).catch((error) => {
          console.error("[AudioToMIDI] Failed to remove generated MIDI track:", error);
        });
        set((state: any) => ({
          tracks: state.tracks.filter((track: any) => track.id !== generatedTrackId),
          selectedTrackId: state.selectedTrackId === generatedTrackId ? null : state.selectedTrackId,
          selectedTrackIds: state.selectedTrackIds.filter((id: string) => id !== generatedTrackId),
          lastSelectedTrackId: state.lastSelectedTrackId === generatedTrackId ? null : state.lastSelectedTrackId,
          selectedClipId: state.selectedClipId === generatedClipId ? null : state.selectedClipId,
          selectedClipIds: state.selectedClipIds.filter((id: string) => id !== generatedClipId),
          isModified: true,
        }));
      },
    };

    commandManager.execute(command);
    set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });

    get().showToast?.(
      events.length > 0
        ? `Converted ${events.length / 2} MIDI note${events.length === 2 ? "" : "s"}.`
        : "Created an empty MIDI clip. No pitched notes were detected.",
      events.length > 0 ? "success" : "info",
    );

    return { trackId: generatedTrackId, clipId: generatedClipId };
  },
});

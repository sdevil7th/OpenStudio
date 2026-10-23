import type { AudioClip, MIDIClip, Track, DAWActions, DAWState } from "../useDAWStore";
import type { AutomationClipMove } from "./clipEditing";
import { commandManager } from "../commands";
import { isClipEditLocked } from "../../utils/clipEditLock";
import { canTrackAcceptTimelineClip } from "../../utils/timelineClipboard";

export interface TimelineClipCopyPlacement {
  clipId: string;
  targetTrackId: string;
  targetStartTime: number;
}

export interface TimelineClipCopyOptions {
  recordUndo?: boolean;
  moveAutomation?: boolean;
  /** Let the owning gesture synchronize after creating all destination tracks. */
  syncBackend?: boolean;
}

type CopyStore = DAWState & DAWActions;
type SelectionSnapshot = Pick<DAWState,
  "selectedClipId" | "selectedClipIds" | "selectedTrackId" | "selectedTrackIds" | "lastSelectedTrackId">;
type CopySource = {
  trackId: string;
  targetTrack: Track;
  placement: TimelineClipCopyPlacement;
} & ({ kind: "audio"; clip: AudioClip } | { kind: "midi"; clip: MIDIClip });

interface TimelineClipCopyHooks {
  get: () => CopyStore;
  set: (state: Partial<CopyStore>) => void;
  cloneTracks: (tracks: Track[]) => Track[];
  cloneClip: <T extends AudioClip | MIDIClip>(clip: T, regenerateNestedTakeIds: boolean) => T;
  copyAutomation: (tracks: Track[], copies: AutomationClipMove[], sourceTracks: Track[]) => Track[];
  syncAudio: (context: string) => void;
  syncMIDI: (tracks: Track[]) => void;
  syncAutomation: (previousTracks: Track[], nextTracks: Track[]) => void;
}

function captureSelection(state: CopyStore): SelectionSnapshot {
  return {
    selectedClipId: state.selectedClipId,
    selectedClipIds: [...state.selectedClipIds],
    selectedTrackId: state.selectedTrackId,
    selectedTrackIds: [...state.selectedTrackIds],
    lastSelectedTrackId: state.lastSelectedTrackId,
  };
}

/** Strictly typed copy transaction; legacy action modules supply their shared clone/sync utilities. */
export function createTimelineClipCopyAction(hooks: TimelineClipCopyHooks): DAWActions["duplicateClipsToPositions"] {
  return (placements, options = {}) => {
    const state = hooks.get();
    if (!placements.length || isClipEditLocked(state)
      || new Set(placements.map(placement => placement.clipId)).size !== placements.length) return [];

    // Resolve and validate every member before generating IDs or changing state.
    const sources: CopySource[] = [];
    for (const placement of placements) {
      const targetTrack = state.tracks.find(track => track.id === placement.targetTrackId);
      if (!targetTrack || !Number.isFinite(placement.targetStartTime) || placement.targetStartTime < 0) return [];
      let source: CopySource | undefined;
      for (const track of state.tracks) {
        const audio = track.clips.find(clip => clip.id === placement.clipId);
        if (audio) {
          source = { kind: "audio", clip: audio, trackId: track.id, targetTrack, placement };
          break;
        }
        const midi = track.midiClips.find(clip => clip.id === placement.clipId);
        if (midi) {
          source = { kind: "midi", clip: midi, trackId: track.id, targetTrack, placement };
          break;
        }
      }
      if (!source || isClipEditLocked(state, source.clip)
        || !canTrackAcceptTimelineClip(targetTrack, source.kind === "midi")) return [];
      sources.push(source);
    }

    const oldTracks = hooks.cloneTracks(state.tracks);
    const selectionBefore = captureSelection(state);
    const additions = new Map<string, { audio: AudioClip[]; midi: MIDIClip[] }>();
    const newIds: string[] = [];
    for (const source of sources) {
      const id = crypto.randomUUID();
      newIds.push(id);
      const target = additions.get(source.targetTrack.id) ?? { audio: [], midi: [] };
      const properties = { id, startTime: source.placement.targetStartTime, color: source.targetTrack.color || source.clip.color };
      if (source.kind === "audio") target.audio.push({ ...hooks.cloneClip(source.clip, true), ...properties });
      else target.midi.push({ ...hooks.cloneClip(source.clip, true), ...properties });
      additions.set(source.targetTrack.id, target);
    }

    let newTracks = oldTracks.map(track => {
      const target = additions.get(track.id);
      return target ? { ...track, clips: [...track.clips, ...target.audio], midiClips: [...track.midiClips, ...target.midi] } : track;
    });
    if ((options.moveAutomation ?? state.moveEnvelopesWithItems) && !state.lockSettings.envelopes) {
      newTracks = hooks.copyAutomation(newTracks, sources.map(source => ({
        clipId: source.clip.id,
        sourceTrackId: source.trackId,
        targetTrackId: source.targetTrack.id,
        originalStartTime: source.clip.startTime,
        newStartTime: source.placement.targetStartTime,
        duration: source.clip.duration,
      })), oldTracks);
    }
    newTracks = hooks.cloneTracks(newTracks);
    const selectionAfter: SelectionSnapshot = { ...selectionBefore, selectedClipId: newIds[newIds.length - 1], selectedClipIds: newIds };
    const touchedAudio = sources.some(source => source.kind === "audio");
    const touchedMIDI = sources.some(source => source.kind === "midi");
    const applySnapshot = (tracks: Track[], selection: SelectionSnapshot, context: string) => {
      const previousTracks = hooks.cloneTracks(hooks.get().tracks);
      const nextTracks = hooks.cloneTracks(tracks);
      hooks.set({ tracks: nextTracks, ...selection, isModified: true });
      if (options.syncBackend !== false) {
        if (touchedAudio) hooks.syncAudio(context);
        if (touchedMIDI) hooks.syncMIDI(nextTracks);
        hooks.syncAutomation(previousTracks, nextTracks);
      }
    };
    if (options.recordUndo === false) {
      applySnapshot(newTracks, selectionAfter, "copy timeline clips");
    } else {
      commandManager.execute({
        type: "DUPLICATE_CLIPS_TO_POSITIONS",
        description: `Copy ${sources.length} timeline clip${sources.length === 1 ? "" : "s"}`,
        timestamp: Date.now(),
        execute: () => applySnapshot(newTracks, selectionAfter, "copy timeline clips"),
        undo: () => applySnapshot(oldTracks, selectionBefore, "undo copy timeline clips"),
      });
      hooks.set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    }
    return newIds;
  };
}

import { nativeBridge } from "../../services/NativeBridge";
import { clipSourceDescriptor } from "../../utils/clipSourceDescriptor";
import { getProjectEpoch } from "../../utils/projectLifetime";
import { isClipEditLocked } from "../../utils/clipEditLock";
import { joinMIDIClips } from "../../utils/joinMIDIClips";
import { analyzeMIDIClipTempo } from "../../utils/midiTempoAnalysis";
import { cloneCrossfadeLayers, resolveCrossfadeSelection, planClipCrossfades, type CrossfadeSettings } from "../../utils/clipCrossfades";
import { createDefaultTrack, type AudioClip, type DAWActions, type DAWState, type MIDIClip } from "../useDAWStore";
import { commandManager } from "../commands";
import {
  buildPostDeleteMIDIEditorState, buildSafeUndoMIDIEditorState, cloneMIDIEditorSnapshot,
  cloneSelectionSnapshot, cloneTracksForTimelineUndo, closeDeletedWindowedMIDIEditors,
  moveAutomationPointsWithClips, syncAutomationTrackSnapshots,
} from "./clipEditing";

type Store = DAWState & DAWActions;
type Setter = (update: Partial<Store>) => void;
export interface NewTimelineTrackRequest {
  placements: Array<{ clipId: string; startTime: number }>;
  insertIndex: number;
  type: "audio" | "midi";
  recordUndo?: boolean;
}
export type ClipCrossfadeOptions = CrossfadeSettings;

function selectedEntries(state: Store) {
  const selected = new Set(state.selectedClipIds.length ? state.selectedClipIds : state.selectedClipId ? [state.selectedClipId] : []);
  return state.tracks.flatMap(track => [
    ...track.clips.filter(clip => selected.has(clip.id)).map(clip => ({ clip, track, kind: "audio" as const })),
    ...track.midiClips.filter(clip => selected.has(clip.id)).map(clip => ({ clip, track, kind: "midi" as const })),
  ]);
}

export function midiJoinSelection(state: Store): { count: number; disabledReason?: string } {
  const entries = selectedEntries(state);
  const count = entries.length;
  const disabledReason = count < 2 ? "Select at least two MIDI clips on one track."
    : entries.some(entry => entry.kind !== "midi") ? "Select MIDI clips only."
    : entries.some(entry => entry.track.id !== entries[0].track.id) ? "Joining requires clips on the same track."
    : entries.some(entry => entry.track.frozen) ? "Unfreeze the track before joining."
    : entries.some(entry => isClipEditLocked(state, entry.clip)) ? "Unlock the selected clips before joining."
    : undefined;
  return { count, disabledReason };
}

export function canJoinSelectedMIDIClips(state: Store) {
  return midiJoinSelection(state).disabledReason === undefined;
}

export function selectedCrossfadePairs(state: Store): Array<[AudioClip, AudioClip]> {
  const entries = selectedEntries(state);
  if (entries.length < 2 || entries.some(entry => entry.kind !== "audio"
    || entry.track.id !== entries[0].track.id || entry.track.frozen || isClipEditLocked(state, entry.clip))) return [];
  const clips = entries.map(entry => entry.clip as AudioClip).sort((a, b) => a.startTime - b.startTime);
  const pairs: Array<[AudioClip, AudioClip]> = [];
  for (let first = 0; first < clips.length; first++) {
    for (let second = first + 1; second < clips.length; second++) {
      if (Math.max(clips[first].startTime, clips[second].startTime)
        < Math.min(clips[first].startTime + clips[first].duration, clips[second].startTime + clips[second].duration)) {
        pairs.push([clips[first], clips[second]]);
      }
    }
  }
  return pairs;
}

export function canEditSelectedCrossfade(state: Store): boolean {
  const entries = selectedEntries(state);
  return selectedCrossfadePairs(state).length > 0 || (entries.length > 0
    && entries.every(entry => entry.kind === "audio")
    && entries.some(entry => (entry.clip as AudioClip).crossfadeLayers?.length));
}

export const timelineEnhancementActions = (set: Setter, get: () => Store) => {
  const history = () => set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
  const sync = () => { void get().syncClipsWithBackend().catch(() => get().showToast("Could not synchronize edited clips with the audio engine", "error")); };
  const applyCrossfades = (clipIds: string[], options: ClipCrossfadeOptions = {}, clear = false) => {
    const state = get();
    const selection = { ...state, selectedClipIds: clipIds, selectedClipId: clipIds[0] ?? null };
    const selected = selectedEntries(selection);
    if (!selected.length || selected.length !== new Set(clipIds).size || selected.some(entry => entry.kind !== "audio")) return false;
    const affected = resolveCrossfadeSelection(state.tracks.flatMap(track => track.clips), clipIds);
    const entries = selectedEntries({ ...state, selectedClipIds: affected.clips.map(clip => clip.id) });
    if (entries.some(entry => entry.track.frozen || isClipEditLocked(state, entry.clip)
      || (!clear && entry.track.id !== entries[0].track.id))) return false;
    const clips = affected.clips;
    const id = [...affected.groupIds].sort()[0] ?? `crossfade:${crypto.randomUUID()}`;
    const plan = clear ? null : planClipCrossfades(clips, options, state.defaultCrossfadeLength, id);
    if (!clear && !plan) return false;
    const changes = new Map(clips.map(clip => {
      const existing = (clip.crossfadeLayers ?? []).filter(layer => !affected.groupIds.has(layer.id));
      const added = plan?.layers.get(clip.id);
      const after = added ? [...existing, added] : existing;
      return [clip.id, { before: cloneCrossfadeLayers(clip.crossfadeLayers), after: after.length ? after : undefined }];
    }));
    if ([...changes.values()].every(({ before, after }) => JSON.stringify(before) === JSON.stringify(after))) return false;
    const epoch = getProjectEpoch();
    const apply = (phase: "before" | "after") => {
      if (epoch !== getProjectEpoch()) return;
      set({ tracks: get().tracks.map(track => ({ ...track, clips: track.clips.map(clip => {
        const change = changes.get(clip.id);
        return change ? { ...clip, crossfadeLayers: cloneCrossfadeLayers(change[phase]) } : clip;
      }) })), isModified: true });
      sync();
    };
    commandManager.execute({ type: "CROSSFADE_CLIPS", description: clear ? "Remove selected crossfade" : "Crossfade selected audio clips", timestamp: Date.now(),
      execute: () => apply("after"), undo: () => apply("before") });
    history();
    return true;
  };
  return {
    openTempoDetection: (trackId: string, clipId: string) => {
      if (get().tracks.some(track => track.id === trackId && [...track.clips, ...track.midiClips].some(clip => clip.id === clipId))) {
        set({ tempoDetectionTarget: { trackId, clipId } });
      }
    },
    closeTempoDetection: () => set({ tempoDetectionTarget: null }),
    analyzeTempoDetectionTarget: async (rangeStartSeconds?: number, rangeDurationSeconds?: number, requestId?: string) => {
      const target = get().tempoDetectionTarget;
      const track = get().tracks.find(candidate => candidate.id === target?.trackId);
      const midi = track?.midiClips.find(clip => clip.id === target?.clipId);
      if (midi) return analyzeMIDIClipTempo(midi, { startSeconds: rangeStartSeconds, durationSeconds: rangeDurationSeconds });
      if (!target || !track?.clips.some(clip => clip.id === target.clipId)) {
        return { bpm: 0, confidence: 0, beatOffsetSeconds: 0, candidates: [], source: "audio" as const, error: "The selected clip is no longer available." };
      }
      const sourceClip = track.clips.find(clip => clip.id === target.clipId)!;
      const epoch = getProjectEpoch();
      const result = await nativeBridge.analyzeClipTempo(target.trackId, target.clipId, rangeStartSeconds, rangeDurationSeconds,
        clipSourceDescriptor(sourceClip), requestId);
      if (getProjectEpoch() !== epoch || get().tracks.find(item => item.id === target.trackId)?.clips.find(item => item.id === target.clipId) !== sourceClip)
        return { bpm: 0, confidence: 0, beatOffsetSeconds: 0, candidates: [], source: "audio" as const, error: "The clip changed. Analyze it again." };
      return result;
    },
    applyDetectedTempo: (bpm: number) => {
      if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400 || get().globalLocked || get().transport.tempo === bpm) return false;
      void get().setTempo(bpm);
      return true;
    },
    crossfadeSelectedClips: () => {
      const state = get(), ids = selectedEntries(state).map(entry => entry.clip.id);
      const affected = resolveCrossfadeSelection(state.tracks.flatMap(track => track.clips), ids);
      if (affected.expanded) {
        set({ showCrossfadeEditor: true, crossfadeEditorClipIds: ids });
        return false;
      }
      return applyCrossfades(ids);
    },
    applyClipCrossfade: (clipId1: string, clipId2: string, options: ClipCrossfadeOptions = {}) => {
      return applyCrossfades([clipId1, clipId2], options);
    },
    applyClipCrossfades: (clipIds: string[], options: ClipCrossfadeOptions = {}) => applyCrossfades(clipIds, options),
    clearClipCrossfades: (clipIds: string[]) => applyCrossfades(clipIds, {}, true),
    editSelectedCrossfade: () => {
      if (!canEditSelectedCrossfade(get())) return false;
      set({ showCrossfadeEditor: true, crossfadeEditorClipIds: selectedEntries(get()).map(entry => entry.clip.id) });
      return true;
    },
    joinSelectedMIDIClips: () => {
      const state = get();
      if (!canJoinSelectedMIDIClips(state)) return false;
      const entries = selectedEntries(state);
      const joined = joinMIDIClips(entries.map(entry => entry.clip as MIDIClip));
      if (!joined) return false;
      const joinedIds = new Set(entries.map(entry => entry.clip.id));
      const removedIds = new Set([...joinedIds].filter(id => id !== joined.id));
      const beforeTracks = cloneTracksForTimelineUndo(state.tracks);
      const afterTracks = beforeTracks.map(track => track.id === entries[0].track.id
        ? { ...track, midiClips: [...track.midiClips.filter((clip: MIDIClip) => !joinedIds.has(clip.id)), joined] } : track);
      const beforeSelection = cloneSelectionSnapshot(state);
      const beforeEditor = cloneMIDIEditorSnapshot(state);
      const afterEditor = buildPostDeleteMIDIEditorState(beforeEditor, removedIds);
      const undoEditor = buildSafeUndoMIDIEditorState(beforeEditor, removedIds);
      const apply = (tracks: typeof beforeTracks, selection: typeof beforeSelection, editor: typeof beforeEditor, joining: boolean) => {
        if (joining) closeDeletedWindowedMIDIEditors(beforeEditor, removedIds);
        set({ tracks: cloneTracksForTimelineUndo(tracks), ...selection, ...editor, isModified: true });
        void get().syncMIDITrackToBackend(entries[0].track.id, { debounce: false });
      };
      commandManager.execute({ type: "JOIN_MIDI_CLIPS", description: `Join ${entries.length} MIDI clips`, timestamp: Date.now(),
        execute: () => apply(afterTracks, { ...beforeSelection, selectedClipIds: [joined.id], selectedClipId: joined.id }, afterEditor, true),
        undo: () => apply(beforeTracks, beforeSelection, undoEditor, false) });
      history();
      return true;
    },
    moveTimelineClipsToNewTrack: async (request: NewTimelineTrackRequest): Promise<string | null> => {
      const state = get(), epoch = getProjectEpoch();
      if (!request.placements.length || !Number.isFinite(request.insertIndex) || isClipEditLocked(state)
        || new Set(request.placements.map(entry => entry.clipId)).size !== request.placements.length) return null;
      const all = state.tracks.flatMap(track => [...track.clips.map(clip => ({ track, clip, kind: "audio" })),
        ...track.midiClips.map(clip => ({ track, clip, kind: "midi" }))]);
      const sources = request.placements.map(placement => ({ placement, source: all.find(entry => entry.clip.id === placement.clipId) }));
      if (sources.some(({ placement, source }) => !source || source.track.frozen || source.track.isFolder
        || isClipEditLocked(state, source.clip) || !Number.isFinite(placement.startTime) || placement.startTime < 0)) return null;
      const index = Math.max(0, Math.min(state.tracks.length, Math.round(request.insertIndex)));
      // A divider inserts one destination per selected source row, preserving
      // their ordering and media types instead of collapsing a mixed group.
      const sourceTracks = state.tracks.filter(track => sources.some(entry => entry.source?.track.id === track.id));
      const newTracks = sourceTracks.map((sourceTrack, offset) => {
        const kind = sources.find(entry => entry.source?.track.id === sourceTrack.id)!.source!.kind as "audio" | "midi";
        const target = createDefaultTrack(crypto.randomUUID(), `${kind === "midi" ? "MIDI" : "Audio"} ${state.tracks.length + offset + 1}`, undefined, kind, state.tracks);
        if (kind === "audio") {
          const channels = sourceTrack.trackChannelCount === 1 ? 1 : 2;
          target.inputType = channels === 1 ? "mono" : "stereo";
          target.inputChannelCount = channels; target.trackChannelCount = channels;
        }
        return target;
      });
      const targetForSource = new Map(sourceTracks.map((track, offset) => [track.id, newTracks[offset]]));
      const targetForClip = new Map(sources.map(entry => [entry.placement.clipId, targetForSource.get(entry.source!.track.id)!]));
      const id = targetForClip.get(request.placements[0].clipId)!.id;
      const beforeTracks = cloneTracksForTimelineUndo(state.tracks), beforeSelection = cloneSelectionSnapshot(state);
      const beforeEditor = cloneMIDIEditorSnapshot(state);
      const movedIds = new Set(request.placements.map(placement => placement.clipId));
      let afterTracks = beforeTracks.map(track => ({ ...track,
        clips: track.clips.filter((clip: AudioClip) => !movedIds.has(clip.id)),
        midiClips: track.midiClips.filter((clip: MIDIClip) => !movedIds.has(clip.id)) }));
      for (const { placement, source } of sources) {
        const target = targetForClip.get(placement.clipId)!;
        const clip = { ...source!.clip, startTime: placement.startTime, color: target.color };
        if (source!.kind === "midi") target.midiClips.push(clip as MIDIClip);
        else target.clips.push(clip as AudioClip);
      }
      afterTracks.splice(index, 0, ...newTracks);
      if (state.moveEnvelopesWithItems && !state.lockSettings.envelopes) {
        afterTracks = moveAutomationPointsWithClips(afterTracks, sources.map(({ placement, source }) => ({
          clipId: source!.clip.id, sourceTrackId: source!.track.id, targetTrackId: targetForClip.get(source!.clip.id)!.id,
          originalStartTime: source!.clip.startTime, newStartTime: placement.startTime, duration: source!.clip.duration,
        })), beforeTracks);
      }
      const afterEditor = { ...beforeEditor, midiEditorSessions: beforeEditor.midiEditorSessions.map((session: Store["midiEditorSessions"][number]) =>
        movedIds.has(session.clipId) ? { ...session, trackId: targetForClip.get(session.clipId)!.id } : session),
        pianoRollTrackId: beforeEditor.pianoRollClipId && movedIds.has(beforeEditor.pianoRollClipId) ? targetForClip.get(beforeEditor.pianoRollClipId)!.id : beforeEditor.pianoRollTrackId };
      // Reserve/configure the native resource before publishing an undoable
      // insertion. Failure must leave both the arrangement and history intact.
      const nativeIds = new Set<string>();
      const prepare = async (target: typeof newTracks[number]) => {
        const added = await nativeBridge.addTrack(target.id, target.type);
        if (added) nativeIds.add(added);
        if (added !== target.id) throw new Error("The audio engine could not create the inserted track");
        if (!await nativeBridge.setTrackInputChannels(target.id, 0, target.inputChannelCount)
          || !await nativeBridge.setTrackChannelCount(target.id, target.trackChannelCount)) throw new Error("The track channel layout was rejected");
      };
      const release = async () => { for (const nativeId of nativeIds) await nativeBridge.removeTrack(nativeId).catch(() => false); nativeIds.clear(); };
      try {
        for (const target of newTracks) await prepare(target);
        if (epoch !== getProjectEpoch() || get().tracks !== state.tracks || isClipEditLocked(get())) {
          await release();
          return null;
        }
      } catch (error) {
        await release();
        console.error("[Timeline] Insert track preparation failed", error);
        get().showToast("Could not create the inserted track", "error");
        return null;
      }
      let desiredRevision = 0, tail = Promise.resolve();
      const synchronize = () => {
        const revision = ++desiredRevision;
        tail = tail.then(async () => {
          if (epoch !== getProjectEpoch() || revision !== desiredRevision) return;
          const present = get().tracks.some(track => track.id === id);
          for (const target of newTracks) {
            const wanted = get().tracks.find(track => track.id === target.id);
            if (wanted && !nativeIds.has(target.id)) await prepare(target);
            else if (!wanted && nativeIds.has(target.id)) {
              await nativeBridge.removeTrack(target.id); nativeIds.delete(target.id);
            }
            if (epoch !== getProjectEpoch()) { await release(); return; }
            if (revision !== desiredRevision) return;
            if (wanted) await nativeBridge.reorderTrack(target.id, get().tracks.findIndex(track => track.id === target.id));
          }
          if (epoch !== getProjectEpoch() || revision !== desiredRevision) return;
          await get().syncClipsWithBackend();
          syncAutomationTrackSnapshots(present ? beforeTracks : afterTracks, get().tracks);
        }).catch(error => { console.error("[Timeline] Insert track failed", error); get().showToast("Could not synchronize the inserted track with the audio engine", "error"); });
        return tail;
      };
      const apply = (tracks: typeof beforeTracks, selection: typeof beforeSelection, editor: typeof beforeEditor) => {
        if (epoch !== getProjectEpoch()) return;
        set({ tracks: cloneTracksForTimelineUndo(tracks), ...selection, ...editor, isModified: true });
        void synchronize();
      };
      const afterSelection = { ...beforeSelection, selectedTrackId: id, selectedTrackIds: newTracks.map(track => track.id), lastSelectedTrackId: id };
      const command = { type: "MOVE_CLIPS_TO_INSERTED_TRACK", description: "Move clips to a new track", timestamp: Date.now(),
        execute: () => apply(afterTracks, afterSelection, afterEditor), undo: () => apply(beforeTracks, beforeSelection, beforeEditor) };
      if (request.recordUndo === false) command.execute();
      else { commandManager.execute(command); history(); }
      await tail;
      return get().tracks.some(track => track.id === id) ? id : null;
    },
  };
};

import type { AudioClip, Track } from "../store/useDAWStore";
import { isClipEditLocked, type ClipEditLockState } from "./clipEditLock";
import type { FXChainType } from "./fxChain";

export interface PitchEntryState extends ClipEditLockState {
  tracks: Track[];
  selectedClipId?: string | null;
  selectedClipIds?: string[];
}

export interface PitchClipTarget { trackId: string; clipId: string; }
export interface PitchClipChoice extends PitchClipTarget {
  trackName: string;
  name: string;
  startTime: number;
  duration: number;
}

export function isPitchCorrectFX(slot: { type?: string; name?: string }): boolean {
  return slot.type === "builtin" && slot.name === "OpenStudio Pitch Correct";
}

/** Audio clips live in clips[]; MIDI clips must never be substituted for audio. */
export function resolvePitchClipTarget(state: PitchEntryState, target: PitchClipTarget): AudioClip | null {
  const track = state.tracks.find(candidate => candidate.id === target.trackId);
  const clip = track?.clips.find(candidate => candidate.id === target.clipId);
  if (!track || track.frozen || !clip || isClipEditLocked(state, clip)
    || !clip.filePath?.trim() || !Number.isFinite(clip.duration) || clip.duration <= 0
    || !Number.isFinite(clip.startTime) || !Number.isFinite(clip.offset) || clip.offset < 0
    || (clip.importStatus !== undefined && clip.importStatus !== "ready")) return null;
  return clip;
}

export function getPitchClipChoices(state: PitchEntryState, trackId?: string): PitchClipChoice[] {
  return state.tracks.flatMap(track => (trackId && track.id !== trackId) ? [] : track.clips.flatMap(clip => {
    if (!resolvePitchClipTarget(state, { trackId: track.id, clipId: clip.id })) return [];
    return [{ trackId: track.id, trackName: track.name, clipId: clip.id, name: clip.name,
      startTime: clip.startTime, duration: clip.duration }];
  }));
}

/** Only the track chain may infer a target, and only from one explicit selection. */
export function getSelectedPitchClip(state: PitchEntryState, trackId: string, chain: FXChainType): PitchClipTarget | null {
  if (chain !== "track") return null;
  const selected = new Set(state.selectedClipIds?.length ? state.selectedClipIds : state.selectedClipId ? [state.selectedClipId] : []);
  const candidates = getPitchClipChoices(state, trackId).filter(clip => selected.has(clip.clipId));
  return candidates.length === 1 ? { trackId, clipId: candidates[0].clipId } : null;
}

/** Follow audible sends as well as the direct track/master path, without cycles. */
export function getPitchPlaybackRoutes(tracks: Track[], trackId: string): { trackIds: string[]; master: boolean } {
  const visited = new Set<string>();
  const pending = [trackId];
  let master = false;
  while (pending.length) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    const track = tracks.find(candidate => candidate.id === id);
    if (!track) continue;
    visited.add(id);
    master ||= track.masterSendEnabled;
    for (const send of track.sends) if (send.enabled && send.level > 0) pending.push(send.destTrackId);
  }
  return { trackIds: [...visited], master };
}

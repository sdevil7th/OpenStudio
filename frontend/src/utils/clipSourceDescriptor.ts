import type { AudioClip } from "../store/useDAWStore";
import { getClipPlaybackGainEnvelope, type ClipGainPoint } from "./clipCrossfades";

/** Read-only source snapshot; mute controls timeline publication, not source access. */
export interface ClipSourceDescriptor {
  filePath: string; startTime: number; duration: number; offset: number;
  volumeDB: number; fadeIn: number; fadeOut: number; fadeInCurve: number; fadeOutCurve: number;
  gainEnvelope: ClipGainPoint[];
}

export function clipSourceDescriptor(clip: AudioClip): ClipSourceDescriptor {
  return { filePath: clip.filePath, startTime: clip.startTime, duration: clip.duration, offset: clip.offset,
    volumeDB: clip.volumeDB ?? 0, fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0,
    fadeInCurve: clip.fadeInShape ?? 0, fadeOutCurve: clip.fadeOutShape ?? 0,
    gainEnvelope: getClipPlaybackGainEnvelope(clip).map(point => ({ ...point })) };
}

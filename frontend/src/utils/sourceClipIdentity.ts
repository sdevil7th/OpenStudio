import { type AudioClip } from "../store/useDAWStore";

export function sourceClipIdentity(clip: AudioClip): string {
  return JSON.stringify([clip.filePath, clip.offset, clip.duration, clip.startTime,
    clip.sampleRate, clip.reversed, clip.playbackRate, clip.pitchSemitones,
    clip.pitchCorrectionSourceFilePath, clip.pitchCorrectionSourceOffset,
    clip.activeTakeIndex, clip.originalFilePath]);
}

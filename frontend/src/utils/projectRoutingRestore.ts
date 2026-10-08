import { nativeBridge } from "../services/NativeBridge";
import type { Track } from "../store/useDAWStore";

/** Restores scalar routing before FX load; send edges use atomic replaceTrackSends after all tracks exist. */
export async function restoreProjectRouting(tracks: readonly Track[]): Promise<string[]> {
  const issues: string[] = [];
  for (const track of tracks) {
    const apply = async (label: string, request: () => Promise<boolean>) => {
      try {
        if (await request() !== true) throw new Error("backend rejected the setting");
      } catch (error) { issues.push(`${track.name}: ${label} (${String(error)})`); }
    };
    await apply("channel count", () => nativeBridge.setTrackChannelCount(track.id, track.trackChannelCount));
    await apply("width", () => nativeBridge.setTrackStereoWidth(track.id, track.stereoWidth));
    await apply("phase", () => nativeBridge.setTrackPhaseInvert(track.id, track.phaseInverted));
    await apply("master send", () => nativeBridge.setTrackMasterSendEnabled(track.id, track.masterSendEnabled));
    await apply("hardware output", () => nativeBridge.setTrackOutputChannels(track.id, track.outputStartChannel, track.outputChannelCount));
    await apply("playback offset", () => nativeBridge.setTrackPlaybackOffset(track.id, track.playbackOffsetMs));
  }
  return issues;
}

import type { AudioDebugSnapshot } from "../services/NativeBridge";

export type NAMTunerHostTrack = {
  type: string;
  inputStartChannel: number;
  inputChannelCount: number;
  armed?: boolean;
  monitorEnabled?: boolean;
};

/**
 * Native tuner telemetry follows one live hardware-input route. A track rack
 * must only display it when that exact route is active for the host track.
 * Master/input-less rack addresses may continue to show the global input.
 */
export function isNAMTunerTelemetryForRack({
  snapshot,
  hostTrack,
  hasTrackAddress,
}: {
  snapshot: AudioDebugSnapshot | null;
  hostTrack: NAMTunerHostTrack | null;
  hasTrackAddress: boolean;
}): boolean {
  if (!hasTrackAddress) return true;
  if (!snapshot || !hostTrack || hostTrack.type !== "audio") return false;
  if (!hostTrack.armed && !hostTrack.monitorEnabled) return false;

  const sourceStart = snapshot.tunerInputStartChannel;
  const sourceCount = snapshot.tunerInputChannelCount;
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceCount)) return false;

  return sourceStart === hostTrack.inputStartChannel
    && sourceCount === hostTrack.inputChannelCount;
}

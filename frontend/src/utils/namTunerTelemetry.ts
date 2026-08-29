import type { AudioDebugSnapshot } from "../services/NativeBridge";

export type NormalizedNAMTunerState = "idle" | "acquiring" | "tracking" | "holding";

export type NAMTunerHostTrack = {
  type: string;
  inputStartChannel: number;
  inputChannelCount: number;
  armed?: boolean;
  monitorEnabled?: boolean;
};

export type NAMTunerActivationBridge = {
  setNAMTunerActive: (
    trackId: string,
    active: boolean,
    subscriberId: string,
  ) => Promise<boolean>;
};

export function normalizeNAMTunerState(
  value: AudioDebugSnapshot["tunerState"] | string | undefined,
): NormalizedNAMTunerState | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "idle"
    || normalized === "acquiring"
    || normalized === "tracking"
    || normalized === "holding"
    ? normalized
    : undefined;
}

export function resolveNAMTunerDisplayPitch(snapshot: AudioDebugSnapshot | null) {
  const state = normalizeNAMTunerState(snapshot?.tunerState);
  const averageFrequencyHz = Number(snapshot?.tunerAverageFrequencyHz);
  const instantaneousFrequencyHz = Number(snapshot?.tunerFrequencyHz);
  const frequencyHz = Number.isFinite(averageFrequencyHz) && averageFrequencyHz > 0
    ? averageFrequencyHz
    : Number.isFinite(instantaneousFrequencyHz) && instantaneousFrequencyHz > 0
      ? instantaneousFrequencyHz
      : undefined;
  const averageCents = Number(snapshot?.tunerAverageCents);
  const instantaneousCents = Number(snapshot?.tunerCents);
  const cents = Number.isFinite(averageCents)
    ? averageCents
    : Number.isFinite(instantaneousCents)
      ? instantaneousCents
      : undefined;
  const stateHasDisplayPitch = state === "tracking" || state === "holding";
  const legacyHasDisplayPitch = state === undefined && snapshot?.tunerPitchLocked === true;

  return {
    state,
    frequencyHz,
    cents,
    stateHasDisplayPitch,
    hasDisplayPitch: Boolean((stateHasDisplayPitch || legacyHasDisplayPitch) && frequencyHz),
  };
}

/**
 * Serializes activation and cleanup for one React tuner subscription. Cleanup
 * waits for an in-flight activation before deactivating the same stable ID, so
 * a rapidly mounted/unmounted rack cannot leave a late activation subscribed.
 */
export function startNAMTunerSubscription(
  bridge: NAMTunerActivationBridge,
  trackId: string,
  subscriberId: string,
) {
  const activation = bridge.setNAMTunerActive(trackId, true, subscriberId);
  const settledActivation = activation.catch(() => false);
  let disposal: Promise<boolean> | null = null;

  return {
    activation,
    dispose() {
      if (!disposal) {
        disposal = settledActivation.then(
          () => bridge.setNAMTunerActive(trackId, false, subscriberId),
        );
      }
      return disposal;
    },
  };
}

/**
 * Native tuner telemetry follows one selected host track. New native builds
 * publish that identity directly; older builds fall back to matching the live
 * hardware-input route. A master rack only accepts telemetry from its explicit
 * global-input tuner subscription.
 */
export function isNAMTunerTelemetryForRack({
  snapshot,
  hostTrack,
  hasTrackAddress,
  trackId,
}: {
  snapshot: AudioDebugSnapshot | null;
  hostTrack: NAMTunerHostTrack | null;
  hasTrackAddress: boolean;
  trackId?: string;
}): boolean {
  if (!snapshot) return false;

  const usesGlobalInput = snapshot.tunerUsesGlobalInput;
  if (!hasTrackAddress) return usesGlobalInput ?? true;
  if (usesGlobalInput) return false;

  const targetTrackId = trackId?.trim();
  const sourceTrackId = snapshot.tunerTrackId?.trim();
  if (sourceTrackId) return Boolean(targetTrackId && sourceTrackId === targetTrackId);

  if (!hostTrack || hostTrack.type !== "audio") return false;
  if (!hostTrack.armed && !hostTrack.monitorEnabled) return false;

  const sourceStart = snapshot.tunerInputStartChannel;
  const sourceCount = snapshot.tunerInputChannelCount;
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceCount)) return false;

  return sourceStart === hostTrack.inputStartChannel
    && sourceCount === hostTrack.inputChannelCount;
}

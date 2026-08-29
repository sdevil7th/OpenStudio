import { describe, expect, it } from "vitest";
import type { AudioDebugSnapshot } from "../services/NativeBridge";
import {
  isNAMTunerTelemetryForRack,
  resolveNAMTunerDisplayPitch,
  startNAMTunerSubscription,
} from "../utils/namTunerTelemetry";

const snapshot = (overrides: Partial<AudioDebugSnapshot> = {}): AudioDebugSnapshot => ({
  transportPlaying: false,
  transportRecording: false,
  transportPosition: 0,
  sampleRate: 48000,
  blockSize: 128,
  playbackClipCount: 0,
  activeOutputChannels: 2,
  postTrackPlaybackPeak: 0,
  postMonitoringInputPeak: 0,
  postMasterFxPeak: 0,
  postMonitoringFxPeak: 0,
  finalOutputPeak: 0,
  lastRecordingClipCountReturned: 0,
  playbackTracks: [],
  tunerInputStartChannel: 0,
  tunerInputChannelCount: 1,
  ...overrides,
});

const hostTrack = {
  type: "audio",
  inputStartChannel: 0,
  inputChannelCount: 1,
  monitorEnabled: true,
};

describe("NAM tuner telemetry routing", () => {
  it("accepts telemetry selected for this host track", () => {
    expect(isNAMTunerTelemetryForRack({
      snapshot: snapshot({
        tunerTrackId: "track-a",
        tunerInputStartChannel: 7,
        tunerInputChannelCount: 2,
      }),
      hostTrack,
      hasTrackAddress: true,
      trackId: "track-a",
    })).toBe(true);
  });

  it("rejects telemetry from another track even when both share an input", () => {
    expect(isNAMTunerTelemetryForRack({
      snapshot: snapshot({ tunerTrackId: "track-b" }),
      hostTrack,
      hasTrackAddress: true,
      trackId: "track-a",
    })).toBe(false);
  });

  it("falls back to input-route matching for older native snapshots", () => {
    expect(isNAMTunerTelemetryForRack({
      snapshot: snapshot(),
      hostTrack,
      hasTrackAddress: true,
      trackId: "track-a",
    })).toBe(true);
  });

  it("keeps global master telemetry separate from track tuners", () => {
    const globalSnapshot = snapshot({
      tunerUsesGlobalInput: true,
      tunerTrackId: "",
    });

    expect(isNAMTunerTelemetryForRack({
      snapshot: globalSnapshot,
      hostTrack: null,
      hasTrackAddress: false,
    })).toBe(true);
    expect(isNAMTunerTelemetryForRack({
      snapshot: globalSnapshot,
      hostTrack,
      hasTrackAddress: true,
      trackId: "track-a",
    })).toBe(false);
  });

  it("keeps the averaged note visible while native telemetry is holding", () => {
    const display = resolveNAMTunerDisplayPitch(snapshot({
      tunerState: "Holding",
      tunerPitchLocked: true,
      tunerFrequencyHz: 81.9,
      tunerAverageFrequencyHz: 82.4069,
      tunerCents: -10,
      tunerAverageCents: 1.5,
    }));

    expect(display).toEqual({
      state: "holding",
      frequencyHz: 82.4069,
      cents: 1.5,
      stateHasDisplayPitch: true,
      hasDisplayPitch: true,
    });
  });

  it("serializes rapid activation cleanup and deactivates a subscriber once", async () => {
    const calls: Array<{ trackId: string; active: boolean; subscriberId: string }> = [];
    let finishActivation: ((active: boolean) => void) | undefined;
    const activationGate = new Promise<boolean>((resolve) => {
      finishActivation = resolve;
    });
    const bridge = {
      setNAMTunerActive: async (trackId: string, active: boolean, subscriberId: string) => {
        calls.push({ trackId, active, subscriberId });
        return active ? activationGate : true;
      },
    };

    const subscription = startNAMTunerSubscription(
      bridge,
      "track-a",
      "subscriber-a",
    );
    const firstDisposal = subscription.dispose();
    const secondDisposal = subscription.dispose();

    expect(firstDisposal).toBe(secondDisposal);
    expect(calls).toEqual([
      { trackId: "track-a", active: true, subscriberId: "subscriber-a" },
    ]);

    finishActivation?.(true);
    await firstDisposal;

    expect(calls).toEqual([
      { trackId: "track-a", active: true, subscriberId: "subscriber-a" },
      { trackId: "track-a", active: false, subscriberId: "subscriber-a" },
    ]);
  });
});

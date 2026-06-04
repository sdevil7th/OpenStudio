import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import {
  getPlaybackContentBounds,
  shouldAutoStopPlayback,
  type TrackWithArrangementClips,
} from "../utils/transportAutoStop";

function arrangementClip(startTime: number, duration: number, extras: Record<string, unknown> = {}) {
  return { id: `${startTime}-${duration}`, startTime, duration, ...extras } as any;
}

function arrangementTrack(
  clips: any[] = [],
  midiClips: any[] = [],
  extras: Record<string, unknown> = {},
): TrackWithArrangementClips {
  return { clips, midiClips, ...extras } as unknown as TrackWithArrangementClips;
}

function transport(overrides: Record<string, unknown> = {}) {
  return {
    isPlaying: true,
    isRecording: false,
    currentTime: 0,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
    ...overrides,
  };
}

describe("transport auto-stop", () => {
  it("auto-stops an empty project when the metronome is off", () => {
    const decision = shouldAutoStopPlayback({
      tracks: [],
      transport: transport(),
      metronomeEnabled: false,
      nextTime: 0.016,
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.reason).toBe("empty");
  });

  it("keeps playing an empty project when the metronome is on", () => {
    const decision = shouldAutoStopPlayback({
      tracks: [],
      transport: transport(),
      metronomeEnabled: true,
      nextTime: 0.016,
    });

    expect(decision.shouldStop).toBe(false);
  });

  it("keeps recording even when no arrangement clips exist", () => {
    const decision = shouldAutoStopPlayback({
      tracks: [],
      transport: transport({ isRecording: true }),
      metronomeEnabled: false,
      nextTime: 0.016,
    });

    expect(decision.shouldStop).toBe(false);
  });

  it("counts both audio clips and MIDI clips when finding the latest playable end", () => {
    const bounds = getPlaybackContentBounds([
      arrangementTrack([arrangementClip(2, 3)], [arrangementClip(8, 4)]),
    ]);

    expect(bounds.hasContent).toBe(true);
    expect(bounds.latestEndTime).toBe(12);
  });

  it("counts muted clips and clips on muted or unsoloed tracks as timeline content", () => {
    const decision = shouldAutoStopPlayback({
      tracks: [
        arrangementTrack(
          [arrangementClip(0, 10, { muted: true })],
          [],
          { muted: true, solo: false },
        ),
      ],
      transport: transport({ currentTime: 2 }),
      metronomeEnabled: false,
      nextTime: 2.016,
    });

    expect(decision.shouldStop).toBe(false);
    expect(decision.bounds.latestEndTime).toBe(10);
  });

  it("ignores zero-duration and invalid clips", () => {
    const bounds = getPlaybackContentBounds([
      arrangementTrack([
        arrangementClip(0, 0),
        arrangementClip(1, -1),
        arrangementClip(Number.NaN, 4),
      ]),
    ]);

    expect(bounds.hasContent).toBe(false);
    expect(bounds.latestEndTime).toBe(0);
  });

  it("auto-stops when non-looping playback reaches the latest clip end", () => {
    const decision = shouldAutoStopPlayback({
      tracks: [arrangementTrack([arrangementClip(1, 4)])],
      transport: transport({ currentTime: 4.99 }),
      metronomeEnabled: false,
      nextTime: 5.01,
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.reason).toBe("end-of-content");
    expect(decision.stopTime).toBe(5);
  });

  it("auto-stops a loop region that contains no overlapping clips", () => {
    const decision = shouldAutoStopPlayback({
      tracks: [arrangementTrack([arrangementClip(1, 4)])],
      transport: transport({
        currentTime: 20,
        loopEnabled: true,
        loopStart: 20,
        loopEnd: 24,
      }),
      metronomeEnabled: false,
      nextTime: 20.016,
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.reason).toBe("silent-loop");
  });

  it("keeps looping when the loop region overlaps any clip", () => {
    const decision = shouldAutoStopPlayback({
      tracks: [arrangementTrack([arrangementClip(22, 1)])],
      transport: transport({
        currentTime: 23.99,
        loopEnabled: true,
        loopStart: 20,
        loopEnd: 24,
      }),
      metronomeEnabled: false,
      nextTime: 24.01,
    });

    expect(decision.shouldStop).toBe(false);
    expect(decision.bounds.loopHasContent).toBe(true);
  });

  it("checks auto-stop before loop wrapping in the app playback loop", () => {
    const autoStopIndex = appSource.indexOf("const autoStopDecision = shouldAutoStopPlayback");
    const loopWrapIndex = appSource.indexOf("// Loop: wrap back to loopStart");

    expect(autoStopIndex).toBeGreaterThanOrEqual(0);
    expect(loopWrapIndex).toBeGreaterThan(autoStopIndex);
    expect(appSource).toContain("let autoStopInFlight = false");
    expect(appSource).toContain("void currentState.stop()");
  });
});

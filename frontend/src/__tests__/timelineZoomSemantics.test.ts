import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRegisteredAction,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import {
  getTimelineProjectFitView,
  getTimelineRangeFitView,
} from "../utils/contextWheelBehaviors";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  registerShortcutSurface,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";

const originalState = useDAWStore.getState();
const cleanup: Array<() => void> = [];

beforeEach(() => {
  resetShortcutContextForTests();
  useDAWStore.setState({
    tracks: [],
    recordingClips: [],
    timeSelection: null,
    keyboardShortcutProfileId: "openstudio",
    customShortcuts: {},
    transport: { ...originalState.transport, currentTime: 0 },
  });
});

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
  vi.restoreAllMocks();
  resetShortcutContextForTests();
  useDAWStore.setState(originalState);
});

describe("Timeline zoom semantics", () => {
  it("fits mixed audio/MIDI content against the actual viewport and responds to resize", () => {
    const tracks = [{
      clips: [{ startTime: 2, duration: 8 }],
      midiClips: [{ startTime: 15, duration: 5 }],
    }];
    expect(getTimelineProjectFitView(tracks, undefined, 1000)).toEqual({
      pixelsPerSecond: 50,
      scrollX: 0,
    });
    expect(getTimelineProjectFitView(tracks, undefined, 500)).toEqual({
      pixelsPerSecond: 25,
      scrollX: 0,
    });
  });

  it("includes active recording extent, ignores invalid clips, and clamps supported zoom", () => {
    const tracks = [{
      clips: [
        { startTime: Number.NaN, duration: 10 },
        { startTime: 0, duration: -4 },
      ],
      midiClips: [{ startTime: Number.POSITIVE_INFINITY, duration: 1 }],
    }];
    expect(getTimelineProjectFitView(tracks, 4, 800)).toEqual({
      pixelsPerSecond: 200,
      scrollX: 0,
    });
    expect(getTimelineProjectFitView([{ clips: [{ startTime: 0, duration: 0.001 }], midiClips: [] }], null, 800))
      .toEqual({ pixelsPerSecond: 1000, scrollX: 0 });
    expect(getTimelineProjectFitView([{ clips: [{ startTime: 0, duration: 10_000 }], midiClips: [] }], null, 100))
      .toEqual({ pixelsPerSecond: 1, scrollX: 0 });
  });

  it("returns no fit for an empty/invalid viewport and fits normalized selections with margin", () => {
    expect(getTimelineProjectFitView([], undefined, 800)).toBeNull();
    expect(getTimelineProjectFitView([{ clips: [{ startTime: 0, duration: 1 }], midiClips: [] }], null, 0))
      .toBeNull();
    expect(getTimelineProjectFitView([{ clips: [{ startTime: 0, duration: 1 }], midiClips: [] }], null, Number.NaN))
      .toBeNull();
    expect(getTimelineRangeFitView(6, 2, 1000)).toEqual({
      pixelsPerSecond: 200,
      scrollX: 300,
    });
    expect(getTimelineRangeFitView(2, 2, 1000)).toBeNull();
    expect(getTimelineRangeFitView(Number.NaN, 2, 1000)).toBeNull();
  });

  it("routes both zoom commands only to the active Timeline owner", () => {
    const audio = createDefaultTrack("track", "Track", "#38bdf8", "audio");
    audio.clips = [{
      id: "clip",
      filePath: "C:/audio.wav",
      name: "Audio",
      startTime: 0,
      duration: 20,
      offset: 0,
      color: "#38bdf8",
      volumeDB: 0,
      fadeIn: 0,
      fadeOut: 0,
    }];
    useDAWStore.setState({
      tracks: [audio],
      timeSelection: { start: 2, end: 6 },
    });
    const executedActionIds: string[] = [];
    const execute = vi.fn((actionId: string) => {
      executedActionIds.push(actionId);
      return "handled" as const;
    });
    cleanup.push(registerScopedActionExecutor(
      { kind: "timeline" },
      execute,
      ["view.zoomToFit", "view.zoomToSelection"],
    ));
    activateShortcutContext({ kind: "timeline" });

    const fit = getRegisteredAction("view.zoomToFit")!;
    const selection = getRegisteredAction("view.zoomToSelection")!;
    expect(fit.canHandleShortcut?.()).toBe(true);
    expect(selection.canHandleShortcut?.()).toBe(true);
    fit.execute();
    selection.execute();
    expect(executedActionIds).toEqual([
      "view.zoomToFit",
      "view.zoomToSelection",
    ]);

    activateShortcutContext({ kind: "application" });
    expect(fit.canHandleShortcut?.()).toBe(false);
    expect(selection.canHandleShortcut?.()).toBe(false);
  });

  it("dispatches Waveform's F8 project-fit binding through the production resolver", () => {
    const midi = createDefaultTrack("midi", "MIDI", "#f72585", "midi");
    midi.midiClips = [{
      id: "midi-clip",
      name: "MIDI",
      startTime: 0,
      duration: 16,
      offset: 0,
      sourceStart: 0,
      sourceLength: 16,
      loopEnabled: false,
      loopOffset: 0,
      loopLength: 16,
      events: [],
      ccEvents: [],
      color: "#f72585",
    }];
    useDAWStore.setState({
      tracks: [midi],
      keyboardShortcutProfileId: "waveform",
    });
    const execute = vi.fn(() => "handled" as const);
    cleanup.push(registerShortcutSurface({ kind: "timeline" }, () => "unmatched"));
    cleanup.push(registerScopedActionExecutor(
      { kind: "timeline" },
      execute,
      ["view.zoomToFit"],
    ));
    activateShortcutContext({ kind: "timeline" });

    expect(dispatchGlobalShortcut({ key: "F8", code: "F8", source: "browser" }, "windows"))
      .toBe(true);
    expect(execute).toHaveBeenCalledWith("view.zoomToFit");
  });
});

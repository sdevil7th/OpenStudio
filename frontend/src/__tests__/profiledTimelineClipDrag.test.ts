import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  useDAWStore,
} from "../store/useDAWStore";
import { getMouseBehaviorProfile } from "../utils/mouseBehaviorProfiles";
import {
  resolveMouseModifierAction,
  type MouseModifierPlatform,
} from "../utils/mouseModifierResolver";
import {
  isTimelineCopyDropNoop,
  resolveProfiledTimelineClipDrag,
} from "../utils/profiledTimelineClipDrag";

const originalState = useDAWStore.getState();

function audioClip(id: string): AudioClip {
  return {
    id,
    filePath: `C:/audio/${id}.wav`,
    name: id,
    startTime: 3.25,
    duration: 2,
    offset: 0,
    color: "#224466",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function midiClip(id: string): MIDIClip {
  return {
    id,
    name: id,
    startTime: 5.5,
    duration: 1,
    sourceLength: 1,
    loopLength: 1,
    events: [
      { timestamp: 0, type: "noteOn", note: 60, velocity: 100 },
      { timestamp: 0.5, type: "noteOff", note: 60, velocity: 0 },
    ],
    ccEvents: [],
    color: "#664422",
  };
}

function resolveClipDrag(
  profileId: "studio_one" | "mixcraft",
  platform: MouseModifierPlatform,
  event: { altKey?: boolean; shiftKey?: boolean },
) {
  const profile = getMouseBehaviorProfile(
    profileId,
    platform === "macos" ? "macos" : "windows",
  );
  return resolveMouseModifierAction(event, "clip_drag", {
    platform,
    profile: profile.modifiers,
  });
}

beforeEach(() => {
  commandManager.clear();
  useDAWStore.setState({
    tracks: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    selectedClipId: null,
    selectedClipIds: [],
    globalLocked: false,
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    canUndo: false,
    canRedo: false,
    syncClipsWithBackend: vi.fn(async () => undefined),
    syncMIDITrackToBackend: vi.fn(async () => undefined),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("profiled Timeline clip drag", () => {
  it.each(["windows", "macos"] as const)(
    "starts Studio One normally on %s and evaluates Shift live after pointer-down",
    (platform) => {
      expect(resolveClipDrag("studio_one", platform, {})).toBe("move");
      // Shift is deliberately not a gesture starter in Studio One.
      expect(resolveClipDrag("studio_one", platform, { shiftKey: true })).toBe("none");

      const base = {
        profileId: "studio_one",
        copyOnDrag: false,
        snapBypassRequested: false,
        preserveTimeRequested: false,
        axisLockRequested: false,
        axisLock: null,
        rawDeltaX: 37,
        rawDeltaY: 14,
      } as const;

      expect(resolveProfiledTimelineClipDrag({
        ...base,
        liveModifiers: {},
      }).effectiveSnapBypass).toBe(false);
      expect(resolveProfiledTimelineClipDrag({
        ...base,
        liveModifiers: { shiftKey: true },
      }).effectiveSnapBypass).toBe(true);
      expect(resolveProfiledTimelineClipDrag({
        ...base,
        liveModifiers: { shiftKey: false },
      }).effectiveSnapBypass).toBe(false);
    },
  );

  it.each(["windows", "macos"] as const)(
    "resolves Mixcraft Alt/Option+Shift as copy-with-preserved-time on %s",
    (platform) => {
      expect(resolveClipDrag("mixcraft", platform, { altKey: true })).toBe("copy");
      expect(resolveClipDrag("mixcraft", platform, {
        altKey: true,
        shiftKey: true,
      })).toBe("copy_preserve_time");

      const base = {
        profileId: "mixcraft",
        copyOnDrag: true,
        snapBypassRequested: false,
        preserveTimeRequested: true,
        axisLockRequested: false,
        axisLock: null,
        rawDeltaX: 85,
        rawDeltaY: 72,
      } as const;
      expect(resolveProfiledTimelineClipDrag({
        ...base,
        liveModifiers: { altKey: true, shiftKey: true },
      })).toMatchObject({
        preserveTime: true,
        effectiveSnapBypass: false,
        axisLockRequested: true,
        axisLock: "y",
        deltaX: 0,
        deltaY: 72,
      });

      // Modifier changes are honored during the same established copy drag.
      expect(resolveProfiledTimelineClipDrag({
        ...base,
        liveModifiers: { altKey: true, shiftKey: false },
      })).toMatchObject({
        preserveTime: false,
        axisLockRequested: false,
        axisLock: null,
        deltaX: 85,
        deltaY: 72,
      });
      expect(resolveProfiledTimelineClipDrag({
        ...base,
        preserveTimeRequested: false,
        liveModifiers: { altKey: true, shiftKey: true },
      }).preserveTime).toBe(true);
    },
  );

  it("treats a preserved-time copy released on its source track as a true no-op", () => {
    expect(isTimelineCopyDropNoop({
      originalStartTime: 3.25,
      previewStartTime: 3.25,
      pixelsPerSecond: 100,
      anchorTrackIndex: 0,
      targetTrackIndex: 0,
      showGhostTrack: false,
    })).toBe(true);
    expect(isTimelineCopyDropNoop({
      originalStartTime: 3.25,
      previewStartTime: 3.25,
      pixelsPerSecond: 100,
      anchorTrackIndex: 0,
      targetTrackIndex: 1,
      showGhostTrack: false,
    })).toBe(false);
  });

  it.each(["audio", "midi"] as const)(
    "commits one atomic preserved-time %s copy and restores it exactly on undo/redo",
    (kind) => {
      const source = createDefaultTrack(
        "source",
        "Source",
        "#111111",
        kind,
        [],
      );
      const target = createDefaultTrack(
        "target",
        "Target",
        "#222222",
        kind,
        [],
      );
      const clip = kind === "audio" ? audioClip("source-clip") : midiClip("source-clip");
      if (kind === "audio") source.clips = [clip as AudioClip];
      else source.midiClips = [clip as MIDIClip];
      useDAWStore.setState({
        tracks: [source, target],
        selectedTrackId: source.id,
        selectedTrackIds: [source.id],
        selectedClipId: clip.id,
        selectedClipIds: [clip.id],
      });

      const copiedId = useDAWStore.getState().duplicateClipToPosition(
        clip.id,
        target.id,
        clip.startTime,
      );
      expect(copiedId).toBeTypeOf("string");
      expect(commandManager.getUndoStack()).toHaveLength(1);
      const copied = kind === "audio"
        ? useDAWStore.getState().tracks[1].clips[0]
        : useDAWStore.getState().tracks[1].midiClips[0];
      expect(copied).toMatchObject({ id: copiedId, startTime: clip.startTime });

      useDAWStore.getState().undo();
      expect(useDAWStore.getState().tracks[1].clips).toEqual([]);
      expect(useDAWStore.getState().tracks[1].midiClips).toEqual([]);
      expect(useDAWStore.getState().selectedClipIds).toEqual([clip.id]);

      useDAWStore.getState().redo();
      const redone = kind === "audio"
        ? useDAWStore.getState().tracks[1].clips[0]
        : useDAWStore.getState().tracks[1].midiClips[0];
      expect(redone).toMatchObject({ id: copiedId, startTime: clip.startTime });
    },
  );

  it("cancels a copy without history when a central lock engages before commit", () => {
    const source = createDefaultTrack("source", "Source", "#111111", "audio", []);
    const target = createDefaultTrack("target", "Target", "#222222", "audio", []);
    source.clips = [audioClip("source-clip")];
    useDAWStore.setState({
      tracks: [source, target],
      selectedClipId: "source-clip",
      selectedClipIds: ["source-clip"],
      globalLocked: true,
    });

    expect(useDAWStore.getState().duplicateClipToPosition(
      "source-clip",
      "target",
      3.25,
    )).toBeNull();
    expect(useDAWStore.getState().tracks[1].clips).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});

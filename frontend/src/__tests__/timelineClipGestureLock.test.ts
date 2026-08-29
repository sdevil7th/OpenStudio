import { describe, expect, it, vi } from "vitest";
import timelineSource from "../components/Timeline.tsx?raw";
import {
  isTimelineClipGestureLocked,
  runTimelineClipGestureMutation,
  type TimelineClipGestureLockState,
} from "../utils/clipEditLock";

function stateWithClips(): TimelineClipGestureLockState {
  return {
    globalLocked: false,
    lockSettings: { items: false },
    tracks: [{
      clips: [{ id: "audio-1", locked: false }],
      midiClips: [{ id: "midi-1", locked: false }],
    }],
  };
}

describe("timeline pointer gesture lock authority", () => {
  it.each([
    ["global lock", (state: TimelineClipGestureLockState) => { state.globalLocked = true; }, "audio-1"],
    ["item lock", (state: TimelineClipGestureLockState) => { state.lockSettings = { items: true }; }, "midi-1"],
    ["audio clip lock", (state: TimelineClipGestureLockState) => { state.tracks[0].clips[0].locked = true; }, "audio-1"],
    ["MIDI clip lock", (state: TimelineClipGestureLockState) => { state.tracks[0].midiClips[0].locked = true; }, "midi-1"],
  ])("blocks %s before preview, undo, or backend work", (_label, lock, clipId) => {
    const state = stateWithClips();
    lock(state);
    const preview = vi.fn();
    const commandPush = vi.fn();
    const backendSync = vi.fn();
    const restore = vi.fn();

    const handled = runTimelineClipGestureMutation(
      state,
      [clipId],
      () => {
        preview();
        commandPush();
        backendSync();
      },
      restore,
    );

    expect(handled).toBe(false);
    expect(restore).toHaveBeenCalledOnce();
    expect(preview).not.toHaveBeenCalled();
    expect(commandPush).not.toHaveBeenCalled();
    expect(backendSync).not.toHaveBeenCalled();
  });

  it("cancels a multi-clip gesture if any participating clip becomes locked", () => {
    const state = stateWithClips();
    expect(isTimelineClipGestureLocked(state, ["audio-1", "midi-1"])).toBe(false);

    state.tracks[0].midiClips[0].locked = true;

    expect(isTimelineClipGestureLocked(state, ["audio-1", "midi-1"])).toBe(true);
  });

  it("treats a deleted/replaced gesture target as locked", () => {
    expect(isTimelineClipGestureLocked(stateWithClips(), ["missing-clip"])).toBe(true);
  });

  it("restores the exact pre-gesture geometry when a lock engages mid-preview", () => {
    const state = stateWithClips();
    const before = { startTime: 2, duration: 4, offset: 0.5, isModified: false };
    let live = { ...before };

    expect(runTimelineClipGestureMutation(state, ["audio-1"], () => {
      live = { startTime: 7, duration: 1.5, offset: 1.25, isModified: true };
    })).toBe(true);

    state.lockSettings = { items: true };
    const undoPush = vi.fn();
    const backendSync = vi.fn();
    expect(runTimelineClipGestureMutation(
      state,
      ["audio-1"],
      () => {
        undoPush();
        backendSync();
      },
      () => { live = { ...before }; },
    )).toBe(false);

    expect(live).toEqual(before);
    expect(undoPush).not.toHaveBeenCalled();
    expect(backendSync).not.toHaveBeenCalled();
  });

  it("wires current-state gates into every Timeline pointer lifecycle", () => {
    expect(timelineSource).toContain("useDAWStore.subscribe((state) => {");
    expect(timelineSource).toContain("getTimelineGestureClipIds(activeGesture)");
    expect(timelineSource).toContain("cancelActiveTimelineClipGesture();");
    expect(timelineSource).toContain("cancelClipVolumeEdit(volumeGesture.clipId)");
    expect(timelineSource).toContain("restoreTimelineGestureUndo();");
    expect(timelineSource).toContain("runTimelineClipGestureMutation(");
    expect(timelineSource.match(/draggable=\{!clipEditLocked\}/g)).toHaveLength(6);
    expect(timelineSource).not.toContain("draggable={!clip.locked}");
  });
});

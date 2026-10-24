import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandManager } from "../store/commands";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, type AudioClip, type MIDIClip, useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();
function audio(id: string, startTime: number, duration: number): AudioClip {
  return { id, filePath: `${id}.wav`, name: id, startTime, duration, offset: 0, color: "#334455", volumeDB: 0, fadeIn: 0, fadeOut: 0 };
}
function midi(id: string, startTime: number): MIDIClip {
  return { id, name: id, startTime, duration: 2, sourceLength: 2, color: "#445566", events: [{ timestamp: 0.5, type: "noteOn", note: 64, velocity: 92 }], ccEvents: [{ cc: 1, time: 0.4, value: 60 }] };
}
beforeEach(() => {
  commandManager.clear();
  const source = createDefaultTrack("a", "Source", "#334455", "audio", []);
  source.clips = [audio("long", 1, 5), audio("short", 8, 1)];
  const notes = createDefaultTrack("m", "MIDI", "#445566", "midi", []);
  notes.midiClips = [midi("notes", 4)];
  useDAWStore.setState({ tracks: [source, notes], selectedClipId: "short", selectedClipIds: ["long", "notes", "short"], globalLocked: false, lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false }, canUndo: false, canRedo: false, syncClipsWithBackend: vi.fn(async () => undefined), syncMIDITrackToBackend: vi.fn(async () => undefined) });
});
afterEach(() => { commandManager.clear(); useDAWStore.setState(initialState); vi.restoreAllMocks(); });

describe("group duplication and copy placement", () => {
  it("duplicates an unequal-length, gapped, mixed selection immediately after its whole span", () => {
    const ids = useDAWStore.getState().duplicateSelectedClips();
    expect(ids).toHaveLength(3);
    const state = useDAWStore.getState();
    expect(state.tracks[0].clips.map((clip) => clip.startTime)).toEqual([1, 8, 9, 16]);
    expect(state.tracks[1].midiClips.map((clip) => clip.startTime)).toEqual([4, 12]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    state.undo();
    expect(useDAWStore.getState().selectedClipIds).toEqual(["long", "notes", "short"]);
    expect(useDAWStore.getState().tracks[0].clips).toHaveLength(2);
    state.redo();
    expect(useDAWStore.getState().selectedClipIds).toEqual(ids);
  });

  it("copies all clips at one time delta and keeps originals/nested MIDI content independent", () => {
    const ids = useDAWStore.getState().duplicateClipsToPositions([
      { clipId: "long", targetTrackId: "a", targetStartTime: 11 },
      { clipId: "notes", targetTrackId: "m", targetStartTime: 14 },
      { clipId: "short", targetTrackId: "a", targetStartTime: 18 },
    ]);
    const state = useDAWStore.getState();
    expect(ids).toHaveLength(3);
    expect(state.tracks[0].clips.map((clip) => clip.startTime)).toEqual([1, 8, 11, 18]);
    expect(state.tracks[1].midiClips.map((clip) => clip.startTime)).toEqual([4, 14]);
    expect(state.tracks[1].midiClips[1].events).not.toBe(state.tracks[1].midiClips[0].events);
    expect(state.tracks[1].midiClips[1].ccEvents).not.toBe(state.tracks[1].midiClips[0].ccEvents);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    state.undo();
    expect(useDAWStore.getState().tracks[1].midiClips).toHaveLength(1);
    state.redo();
    expect(useDAWStore.getState().selectedClipIds).toEqual(ids);
  });

  it("defers all backend writes while copying audio, MIDI and automation for an owning gesture", () => {
    const syncAutomation = vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
    const syncMode = vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
    const clearAutomation = vi.spyOn(nativeBridge, "clearAutomation").mockResolvedValue(true);
    const before = useDAWStore.getState();
    useDAWStore.setState({ moveEnvelopesWithItems: true, tracks: before.tracks.map(track => track.id !== "a" ? track : {
      ...track,
      automationLanes: [{ id: "volume", param: "volume", points: [{ id: "source-point", time: 2, value: 0.6 }], visible: true, mode: "read", armed: false, readEnabled: true }],
    }) });
    const ids = useDAWStore.getState().duplicateClipsToPositions([
      { clipId: "long", targetTrackId: "a", targetStartTime: 11 },
      { clipId: "notes", targetTrackId: "m", targetStartTime: 14 },
    ], { recordUndo: false, syncBackend: false });
    const after = useDAWStore.getState();
    expect(ids).toHaveLength(2);
    expect(after.tracks[0].clips).toHaveLength(3);
    expect(after.tracks[1].midiClips).toHaveLength(2);
    expect(after.tracks[0].automationLanes[0].points).toEqual([
      { id: "source-point", time: 2, value: 0.6 },
      { id: expect.any(String), time: 12, value: 0.6 },
    ]);
    expect(after.selectedClipIds).toEqual(ids);
    expect(after.syncClipsWithBackend).not.toHaveBeenCalled();
    expect(after.syncMIDITrackToBackend).not.toHaveBeenCalled();
    expect(syncAutomation).not.toHaveBeenCalled();
    expect(syncMode).not.toHaveBeenCalled();
    expect(clearAutomation).not.toHaveBeenCalled();
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("keeps nested audio takes and Undo snapshots independent from live copied content", () => {
    const before = useDAWStore.getState();
    useDAWStore.setState({ tracks: before.tracks.map(track => ({ ...track, clips: track.clips.map(clip => clip.id !== "long" ? clip : {
      ...clip, takes: [{ ...audio("nested-take", 1, 2), gainEnvelope: [{ time: 0.5, gain: 0.7 }] }],
    }) })) });
    const [id] = useDAWStore.getState().duplicateClipsToPositions([{ clipId: "long", targetTrackId: "a", targetStartTime: 11 }]);
    const copied = useDAWStore.getState().tracks[0].clips.find(clip => clip.id === id)!;
    expect(copied.takes?.[0].id).not.toBe("nested-take");
    copied.takes![0].gainEnvelope![0].gain = 0.2;
    expect(useDAWStore.getState().tracks[0].clips[0].takes?.[0].gainEnvelope?.[0].gain).toBe(0.7);
    useDAWStore.getState().undo();
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].clips.find(clip => clip.id === id)?.takes?.[0].gainEnvelope?.[0].gain).toBe(0.7);
  });

  it.each(["incompatible", "missing", "locked"])("rejects the entire copy group when one source or target is %s", (reason) => {
    if (reason === "locked") useDAWStore.setState({ globalLocked: true });
    const before = useDAWStore.getState().tracks;
    expect(useDAWStore.getState().duplicateClipsToPositions([
      { clipId: "long", targetTrackId: "a", targetStartTime: 11 },
      { clipId: "notes", targetTrackId: reason === "incompatible" ? "a" : reason === "missing" ? "missing" : "m", targetStartTime: 14 },
    ])).toEqual([]);
    expect(useDAWStore.getState().tracks).toBe(before);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});

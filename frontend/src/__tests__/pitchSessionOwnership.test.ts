import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge, type PitchNoteData } from "../services/NativeBridge";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { cancelPitchEditorGesture, getCommittedPitchNotes, usePitchEditorStore } from "../store/pitchEditorStore";
import { commandManager } from "../store/commands";
import { advanceProjectEpoch } from "../utils/projectLifetime";
import { startPitchEditorSessionController, usePitchWindowState, recoverPitchCheckpoint } from "../utils/pitchEditorSession";

const note: PitchNoteData = { id: "note", startTime: 0, endTime: 1, detectedPitch: 60, correctedPitch: 60,
  driftCorrectionAmount: 0, vibratoDepth: 1, vibratoRate: 0, transitionIn: 0, transitionOut: 0, formantShift: 0, gain: 0, voiced: true, pitchDrift: [] };
const original = useDAWStore.getState();
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { location: { hostname: "test.local" } });
  commandManager.clear();
  useDAWStore.setState({ tracks: [{ ...createDefaultTrack("track", "Track"), clips: [{ id: "clip", filePath: "C:/source.wav", name: "Source", startTime: 0, duration: 2, offset: 0, volumeDB: 0, fadeIn: 0, fadeOut: 0, color: "#123456", locked: false }] }],
    globalLocked: false, lockSettings: { ...original.lockSettings, items: false }, showPitchEditor: true, pitchEditorTrackId: "track", pitchEditorClipId: "clip" });
  usePitchEditorStore.getState().close();
  usePitchEditorStore.getState().open("track", "clip", 0);
  usePitchEditorStore.setState({ notes: [note], selectedNoteIds: ["note"] });
  vi.spyOn(nativeBridge, "applyPitchCorrection").mockResolvedValue({ success: true, outputFile: "" });
});
afterEach(() => {
  stop?.(); stop = undefined; cancelPitchEditorGesture(); usePitchEditorStore.getState().close();
  commandManager.clear(); useDAWStore.setState(original); vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
describe("one pitch session owner", () => {
  it("records one project command for many previews, with shared editor and global undo", () => {
    const s = usePitchEditorStore.getState();
    s.beginInteractivePreview("note"); s.pushUndo("Pitch +4");
    for (let pitch = 61; pitch <= 64; pitch++) s.updateNote("note", { correctedPitch: pitch });
    s.commitNoteEdit();
    expect(commandManager.canUndo()).toBe(true);
    s.setZoomX(300); s.setScrollX(0.25);
    s.undo(); expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);
    expect(usePitchEditorStore.getState().zoomX).toBe(300);
    expect(usePitchEditorStore.getState().scrollX).toBe(0.25);
    expect(commandManager.canUndo()).toBe(false);
    useDAWStore.getState().redo(); expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(64);
  });
  it("cancels an unfinished gesture without dropping committed history or moving the arrangement", () => {
    const s = usePitchEditorStore.getState();
    s.moveSelectedPitch(4);
    const arrangement = { zoom: useDAWStore.getState().pixelsPerSecond, scroll: useDAWStore.getState().scrollX };
    s.setZoomX(300); s.setScrollX(12);
    s.beginInteractivePreview("note"); s.pushUndo("unfinished"); s.updateNote("note", { correctedPitch: 70 });
    cancelPitchEditorGesture();
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(64);
    expect(useDAWStore.getState().pixelsPerSecond).toBe(arrangement.zoom);
    expect(useDAWStore.getState().scrollX).toBe(arrangement.scroll);
    useDAWStore.getState().undo(); expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);
  });
  it("preserves the same target's history and viewport when closed and reopened", () => {
    usePitchEditorStore.getState().moveSelectedPitch(4);
    usePitchEditorStore.getState().setScrollX(3);
    useDAWStore.getState().closePitchEditor();
    useDAWStore.getState().openPitchEditor("track", "clip", 0);
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(64);
    expect(usePitchEditorStore.getState().scrollX).toBe(3);
    useDAWStore.getState().undo(); expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);
  });
  it("does not replay a previous document's pitch command into the same IDs", () => {
    usePitchEditorStore.getState().moveSelectedPitch(4);
    advanceProjectEpoch();
    usePitchEditorStore.setState({ notes: [{ ...note, correctedPitch: 72 }] });
    useDAWStore.getState().undo();
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(72);
  });
  it("keeps unfinished preview values out of the accepted checkpoint", () => {
    const state = usePitchEditorStore.getState();
    state.moveSelectedPitch(4);
    state.beginInteractivePreview("note"); state.pushUndo("unfinished");
    state.updateNote("note", { correctedPitch: 75 });
    expect(getCommittedPitchNotes()[0].correctedPitch).toBe(64);
    state.commitNoteEdit();
    expect(getCommittedPitchNotes()[0].correctedPitch).toBe(75);
  });
  it("revokes the session when its source is replaced", async () => {
    vi.spyOn(nativeBridge, "pitchEditorSession").mockResolvedValue(true);
    stop = startPitchEditorSessionController();
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track,
      clips: track.clips.map(clip => ({ ...clip, filePath: "C:/replacement.wav" })) })) }));
    expect(usePitchEditorStore.getState().clipId).toBeNull();
    expect(usePitchWindowState.getState().detached).toBe(false);
  });
  it("requires the matching saved project/source and creates one undoable recovery edit", () => {
    const pitch = usePitchEditorStore.getState();
    const contour = { clipId: "clip", sampleRate: 48000, hopSize: 256, frames: { times: [], midi: [], confidence: [], rms: [], voiced: [] }, notes: [note] };
    usePitchEditorStore.setState({ contour });
    usePitchWindowState.setState({ recovery: { projectEpoch: 999, generation: 999, revision: 1,
      sessionId: "track:clip", sourceRevision: pitch.sourceRevision,
      projectPath: "C:/saved.osproj", ackSequence: 1, pitch: {}, committedNotes: [{ ...note, correctedPitch: 64 }] } });
    expect(recoverPitchCheckpoint()).toBe(false);
    useDAWStore.setState({ projectPath: "C:/saved.osproj" });
    expect(recoverPitchCheckpoint()).toBe(true);
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(64);
    useDAWStore.getState().undo(); expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);
  });
  it("the native close event cancels previews and retains accepted state", async () => {
    const events = new Map<string, (message: unknown) => void>();
    vi.spyOn(nativeBridge, "subscribe").mockImplementation((event, cb) => { events.set(event, cb); return () => events.delete(event); });
    vi.spyOn(nativeBridge, "pitchEditorSession").mockResolvedValue(true);
    stop = startPitchEditorSessionController();
    usePitchEditorStore.getState().moveSelectedPitch(4);
    usePitchEditorStore.getState().beginInteractivePreview("note");
    usePitchEditorStore.getState().pushUndo("unfinished");
    usePitchEditorStore.getState().updateNote("note", { correctedPitch: 80 });
    events.get("pitchEditorClosed")?.({ viewId: "retired" });
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(64);
    expect(usePitchWindowState.getState().detached).toBe(false);
    useDAWStore.getState().undo(); expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);
  });
});

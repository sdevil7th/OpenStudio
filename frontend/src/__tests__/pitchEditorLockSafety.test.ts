import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PitchCorrectionCompletionData, PitchNoteData } from "../services/NativeBridge";
import { nativeBridge } from "../services/NativeBridge";
import {
  handlePitchCorrectionComplete,
  usePitchEditorStore,
} from "../store/pitchEditorStore";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import {
  getRegisteredAction,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import { getPitchEditorEditActionBlockResult } from "../components/PitchEditorLowerZone";
import {
  activateShortcutContext,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";

const originalDAWState = {
  tracks: useDAWStore.getState().tracks,
  globalLocked: useDAWStore.getState().globalLocked,
  lockSettings: useDAWStore.getState().lockSettings,
  showPitchEditor: useDAWStore.getState().showPitchEditor,
  pitchEditorTrackId: useDAWStore.getState().pitchEditorTrackId,
  pitchEditorClipId: useDAWStore.getState().pitchEditorClipId,
  pitchEditorFxIndex: useDAWStore.getState().pitchEditorFxIndex,
  syncClipsWithBackend: useDAWStore.getState().syncClipsWithBackend,
};

const cleanups: Array<() => void> = [];

function makeNote(id: string, detectedPitch: number, startTime: number): PitchNoteData {
  return {
    id,
    startTime,
    endTime: startTime + 0.4,
    effectiveStartTime: startTime,
    effectiveEndTime: startTime + 0.4,
    detectedPitch,
    correctedPitch: detectedPitch,
    driftCorrectionAmount: 0,
    vibratoDepth: 1,
    vibratoRate: 0,
    transitionIn: 40,
    transitionOut: 60,
    formantShift: 0,
    gain: 0,
    voiced: true,
    wordGroupId: `word-${id}`,
    pitchDrift: [],
  };
}

function setupEditablePitchTarget() {
  const track = {
    ...createDefaultTrack("track-a", "Track A"),
    clips: [{
      id: "clip-a",
      filePath: "C:/authoritative.wav",
      name: "Audio",
      startTime: 0,
      duration: 4,
      offset: 0,
      color: "#123456",
      volumeDB: 0,
      fadeIn: 0,
      fadeOut: 0,
      locked: false,
    }],
  };
  useDAWStore.setState({
    tracks: [track],
    globalLocked: false,
    lockSettings: { ...useDAWStore.getState().lockSettings, items: false },
    showPitchEditor: true,
    pitchEditorTrackId: "track-a",
    pitchEditorClipId: "clip-a",
    pitchEditorFxIndex: -1,
    syncClipsWithBackend: vi.fn(async () => undefined),
  });
  usePitchEditorStore.getState().open("track-a", "clip-a", -1);
  usePitchEditorStore.setState({
    notes: [makeNote("note-a", 60, 0.2), makeNote("note-b", 64, 1.0)],
    selectedNoteIds: ["note-a"],
    contour: null,
    undoStack: [],
    redoStack: [],
    applyState: "idle",
    applyMessage: "",
    renderCoverage: [],
  });
}

function setEditLock(kind: "global" | "items" | "clip", locked: boolean) {
  if (kind === "global") {
    useDAWStore.setState({ globalLocked: locked });
    return;
  }
  if (kind === "items") {
    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, items: locked },
    }));
    return;
  }
  useDAWStore.setState((state) => ({
    tracks: state.tracks.map((track) => track.id === "track-a"
      ? {
          ...track,
          clips: track.clips.map((clip) => clip.id === "clip-a"
            ? { ...clip, locked }
            : clip),
        }
      : track),
  }));
}

function setTrackFrozen(frozen: boolean) {
  useDAWStore.setState((state) => ({
    tracks: state.tracks.map((track) => track.id === "track-a"
      ? { ...track, frozen }
      : track),
  }));
}

function currentClipFilePath() {
  return useDAWStore.getState().tracks[0]?.clips[0]?.filePath;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function completion(requestId: string, outputFile: string): PitchCorrectionCompletionData {
  return {
    clipId: "clip-a",
    requestId,
    outputFile,
    success: true,
    renderMode: "note_hq",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    location: { hostname: "test.local" },
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null },
  });
  vi.spyOn(nativeBridge, "applyPitchCorrection").mockResolvedValue({ outputFile: "", success: true });
  vi.spyOn(nativeBridge, "previewPitchCorrection").mockResolvedValue({ outputFile: "", success: true });
  vi.spyOn(nativeBridge, "cancelPitchCorrectionRequests").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "clearAllPitchPreviewRoutes").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "clearClipRenderedPreviewSegments").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "clearClipPitchPreview").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "stopPitchScrubPreview").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setPitchCorrectionBypass").mockResolvedValue(undefined);
  vi.spyOn(nativeBridge, "getPitchPreviewRoutingStatus").mockResolvedValue({
    monitorMode: "corrected_source",
    correctedSourceActive: true,
    renderedSegmentActive: false,
    clipLivePreviewActive: false,
    scrubPreviewActive: false,
  });
  setupEditablePitchTarget();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  resetShortcutContextForTests();
  usePitchEditorStore.getState().close();
  useDAWStore.setState(originalDAWState);
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pitch editor lock and freeze authority", () => {
  it("reverts an active drag and cancels its preview without creating an apply", async () => {
    const applySpy = vi.mocked(nativeBridge.applyPitchCorrection);
    const cancelSpy = vi.mocked(nativeBridge.cancelPitchCorrectionRequests);

    usePitchEditorStore.getState().pushUndo("Move note");
    usePitchEditorStore.getState().beginInteractivePreview("note-a");
    usePitchEditorStore.getState().updateNote("note-a", { correctedPitch: 67 });
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(67);

    setEditLock("global", true);
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);
    expect(usePitchEditorStore.getState().undoStack).toEqual([]);
    expect(usePitchEditorStore.getState().redoStack).toEqual([]);
    expect(cancelSpy).toHaveBeenCalledWith("clip-a", "C:/authoritative.wav");

    usePitchEditorStore.getState().commitNoteEdit();
    setEditLock("global", false);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("blocks every pitch-data mutation and native pitch request while item-locked", async () => {
    setEditLock("items", true);
    await flushPromises();
    const before = usePitchEditorStore.getState();
    const noteSnapshot = JSON.stringify(before.notes);

    const state = usePitchEditorStore.getState();
    state.beginInteractivePreview("note-a");
    state.pushUndo("Blocked edit");
    state.updateNote("note-a", { correctedPitch: 72 });
    state.commitNoteEdit();
    state.updateSelectedNotes({ gain: 3 });
    state.moveSelectedPitch(1);
    state.splitNote("note-a", 0.4);
    state.correctSelectedToScale();
    state.correctAllToScale();
    state.setNoteGain("note-a", 4);
    state.setNoteModulation("note-a", 20);
    state.setNoteDrift("note-a", 50);
    state.setNoteTransition("note-a", 100, 100);
    state.applyCorrectPitchMacro(1, 1, false);
    state.mergeNotes(["note-a", "note-b"]);
    state.beginDrawPitch();
    state.drawPitchOnNote("note-a", 0.3, 68);
    state.commitDrawPitch();
    state.toggleABCompare();
    await state.applyCorrection();
    await state.previewCorrection();

    const after = usePitchEditorStore.getState();
    expect(JSON.stringify(after.notes)).toBe(noteSnapshot);
    expect(after.undoStack).toEqual(before.undoStack);
    expect(after.redoStack).toEqual(before.redoStack);
    expect(after.abCompareMode).toBe(false);
    expect(nativeBridge.applyPitchCorrection).not.toHaveBeenCalled();
    expect(nativeBridge.previewPitchCorrection).not.toHaveBeenCalled();
    expect(nativeBridge.setPitchCorrectionBypass).not.toHaveBeenCalled();
  });

  it("claims a docked Pitch Editor shortcut as a locked no-op, then executes it after unlock", async () => {
    cleanups.push(registerScopedActionExecutor(
      { kind: "pitch_editor" },
      (actionId) => {
        const blocked = getPitchEditorEditActionBlockResult(actionId);
        if (blocked) return blocked;
        if (actionId === "pitch.moveUp") {
          usePitchEditorStore.getState().moveSelectedPitch(1);
          return "handled";
        }
        return "unmatched";
      },
      ["pitch.moveUp"],
    ));
    activateShortcutContext({ kind: "pitch_editor" });
    setEditLock("clip", true);
    await flushPromises();

    getRegisteredAction("pitch.moveUp")?.execute();
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);

    setEditLock("clip", false);
    await flushPromises();
    getRegisteredAction("pitch.moveUp")?.execute();
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(61);
  });

  for (const lockKind of ["global", "items", "clip"] as const) {
    it(`replays committed undo and redo while the ${lockKind} lock remains active`, async () => {
      const applySpy = vi.mocked(nativeBridge.applyPitchCorrection);
      usePitchEditorStore.getState().moveSelectedPitch(1);
      expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(61);
      expect(usePitchEditorStore.getState().undoStack).toHaveLength(1);

      setEditLock(lockKind, true);
      await flushPromises();
      usePitchEditorStore.getState().undo();
      expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);
      expect(usePitchEditorStore.getState().undoStack).toHaveLength(0);
      expect(usePitchEditorStore.getState().redoStack).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();
      expect(applySpy).toHaveBeenCalledTimes(1);

      usePitchEditorStore.getState().redo();
      expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(61);
      expect(usePitchEditorStore.getState().undoStack).toHaveLength(1);
      expect(usePitchEditorStore.getState().redoStack).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();
      expect(applySpy).toHaveBeenCalledTimes(2);
    });
  }

  it("hides on freeze, preserves history, and restores the editor and history after unfreeze", async () => {
    usePitchEditorStore.getState().moveSelectedPitch(1);
    expect(usePitchEditorStore.getState().undoStack).toHaveLength(1);

    setTrackFrozen(true);
    expect(useDAWStore.getState().showPitchEditor).toBe(false);
    const frozenNotes = JSON.stringify(usePitchEditorStore.getState().notes);
    usePitchEditorStore.getState().undo();
    expect(JSON.stringify(usePitchEditorStore.getState().notes)).toBe(frozenNotes);
    expect(usePitchEditorStore.getState().undoStack).toHaveLength(1);

    setTrackFrozen(false);
    await flushPromises();
    expect(useDAWStore.getState().showPitchEditor).toBe(true);
    expect(useDAWStore.getState().pitchEditorTrackId).toBe("track-a");
    expect(usePitchEditorStore.getState().undoStack).toHaveLength(1);
    usePitchEditorStore.getState().undo();
    expect(usePitchEditorStore.getState().notes[0].correctedPitch).toBe(60);
  });

  for (const authorityLoss of ["lock", "freeze"] as const) {
    it(`rejects a stale mid-render ${authorityLoss} completion and accepts a newer request`, async () => {
      const applySpy = vi.mocked(nativeBridge.applyPitchCorrection);
      const cancelSpy = vi.mocked(nativeBridge.cancelPitchCorrectionRequests);
      usePitchEditorStore.getState().moveSelectedPitch(1);
      await usePitchEditorStore.getState().applyCorrection();
      const staleRequestId = String(applySpy.mock.calls[applySpy.mock.calls.length - 1]?.[4]);
      expect(staleRequestId).not.toBe("undefined");

      if (authorityLoss === "lock") setEditLock("global", true);
      else setTrackFrozen(true);
      expect(cancelSpy).toHaveBeenCalledWith("clip-a", "C:/authoritative.wav");

      handlePitchCorrectionComplete(completion(staleRequestId, "C:/stale.wav"));
      expect(currentClipFilePath()).toBe("C:/authoritative.wav");

      if (authorityLoss === "lock") setEditLock("global", false);
      else setTrackFrozen(false);
      await flushPromises();
      usePitchEditorStore.getState().moveSelectedPitch(1);
      await usePitchEditorStore.getState().applyCorrection();
      const currentRequestId = String(applySpy.mock.calls[applySpy.mock.calls.length - 1]?.[4]);
      expect(currentRequestId).not.toBe(staleRequestId);

      handlePitchCorrectionComplete(completion(staleRequestId, "C:/still-stale.wav"));
      expect(currentClipFilePath()).toBe("C:/authoritative.wav");
      handlePitchCorrectionComplete(completion(currentRequestId, "C:/current.wav"));
      expect(currentClipFilePath()).toBe("C:/current.wav");
    });
  }
});

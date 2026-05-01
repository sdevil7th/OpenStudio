import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PitchNoteData } from "../services/NativeBridge";
import { usePitchEditorStore } from "../store/pitchEditorStore";

function makeNote(id: string, correctedPitch: number, wordGroupId = "word_a"): PitchNoteData {
  const index = Number(id.replace(/\D/g, "")) || 0;
  return {
    id,
    startTime: index * 0.5,
    endTime: index * 0.5 + 0.4,
    effectiveStartTime: index * 0.5,
    effectiveEndTime: index * 0.5 + 0.4,
    detectedPitch: correctedPitch,
    correctedPitch,
    driftCorrectionAmount: 0,
    vibratoDepth: 1,
    vibratoRate: 0,
    transitionIn: 40,
    transitionOut: 60,
    formantShift: 0,
    gain: 0,
    voiced: true,
    wordGroupId,
    pitchDrift: [],
  };
}

describe("pitch editor single-note ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { hostname: "test.local" },
    });
    usePitchEditorStore.setState({
      trackId: "track-a",
      clipId: "clip-a",
      clipDuration: 3,
      contour: null,
      notes: [
        makeNote("note1", 60, "word_a"),
        makeNote("note2", 62, "word_a"),
        makeNote("note3", 64, "word_b"),
      ],
      selectedNoteIds: [],
      undoStack: [],
      redoStack: [],
      renderCoverage: [],
      applyState: "idle",
      applyMessage: "",
      lastApplyRequestId: null,
      activeLogicalRequestId: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("selects only the clicked note even when nearby notes share a word group", () => {
    usePitchEditorStore.getState().selectNote("note1");

    expect(usePitchEditorStore.getState().selectedNoteIds).toEqual(["note1"]);
  });

  it("updates only the requested note during a drag", () => {
    usePitchEditorStore.getState().updateNote("note1", { correctedPitch: 66 });

    const notes = usePitchEditorStore.getState().notes;
    expect(notes.find((note) => note.id === "note1")?.correctedPitch).toBe(66);
    expect(notes.find((note) => note.id === "note2")?.correctedPitch).toBe(62);
    expect(notes.find((note) => note.id === "note3")?.correctedPitch).toBe(64);
  });

  it("bulk pitch actions affect only explicitly selected notes", () => {
    usePitchEditorStore.setState({ selectedNoteIds: ["note2"] });

    usePitchEditorStore.getState().moveSelectedPitch(1);

    const notes = usePitchEditorStore.getState().notes;
    expect(notes.find((note) => note.id === "note1")?.correctedPitch).toBe(60);
    expect(notes.find((note) => note.id === "note2")?.correctedPitch).toBe(63);
    expect(notes.find((note) => note.id === "note3")?.correctedPitch).toBe(64);
  });
});

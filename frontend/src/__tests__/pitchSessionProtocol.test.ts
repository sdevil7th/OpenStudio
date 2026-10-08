import { describe, expect, it } from "vitest";
import { PitchCommandGate, validPitchAction, type PitchSessionCommand } from "../utils/pitchSessionProtocol";

const identity = { projectEpoch: 2, sessionId: "track:clip", generation: 3, sourceRevision: "source-a" };
const command = (sequence: number, overrides: Partial<PitchSessionCommand> = {}): PitchSessionCommand => ({
  ...identity, viewId: "native-a", sequence, requestId: `request-${sequence}`, action: "moveSelectedPitch", args: [4], ...overrides,
});
describe("pitch session protocol", () => {
  it("rejects stale project, clip, source, generation and native view identities", () => {
    const gate = new PitchCommandGate(identity, "native-a");
    for (const override of [{ projectEpoch: 1 }, { sessionId: "track:other" }, { sourceRevision: "replaced" }, { generation: 1 }, { viewId: "forged" }])
      expect(gate.accept(command(1, override))).toBe("stale");
    expect(gate.sequence).toBe(0);
  });
  it("orders begin, previews and terminal commit and suppresses duplicate delivery", () => {
    const gate = new PitchCommandGate(identity, "native-a");
    expect(gate.accept(command(1, { action: "beginInteractivePreview", args: ["note"] }))).toBe("accept");
    expect(gate.accept(command(2, { action: "updateNote", args: ["note", { correctedPitch: 64 }] }))).toBe("accept");
    const commit = command(3, { action: "commitNoteEdit", args: [] });
    expect(gate.accept(commit)).toBe("accept");
    expect(gate.accept(commit)).toBe("duplicate");
    expect(gate.accept(command(5))).toBe("resync");
    expect(gate.sequence).toBe(3);
  });
  it("does not reuse edit authority through 50 close/reopen generations", () => {
    for (let generation = 4; generation <= 53; generation++) {
      const gate = new PitchCommandGate({ ...identity, generation }, `native-${generation}`);
      expect(gate.accept(command(1))).toBe("stale");
      expect(gate.accept(command(1, { generation, viewId: `native-${generation}` }))).toBe("accept");
    }
  });
  it.each([
    ["open", ["track", "clip", 0]], ["setState", [{}]], ["updateNote", ["n", { id: "overwrite" }]],
    ["updateNote", ["n", { correctedPitch: NaN }]], ["updateNote", ["n", { pitchDrift: [Infinity] }]],
    ["setZoomX", [-Infinity]], ["setTool", ["arbitrary"]], ["commitNoteEdit", ["extra"]],
  ])("rejects malformed or unauthorized %s payload", (action, args) => {
    expect(validPitchAction(action as string, args as unknown[])).toBe(false);
  });
  it.each([
    ["beginDrawPitch", []], ["drawPitchOnNote", ["note", 0.5, 64]], ["commitDrawPitch", []],
    ["mergeNotes", [["a", "b"]]], ["applyCorrectPitchMacro", [50, 70, true]],
    ["setScale", [9, "harmonic_minor"]], ["updateNote", ["n", { driftCorrectionAmount: 0.8 }]],
    ["cancelEdit", []], ["dock", []],
  ])("accepts the existing %s control's arguments", (action, args) => {
    expect(validPitchAction(action as string, args as unknown[])).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { applyEQPhaseTransition } from "../utils/eqPhaseTransition";
import { BuiltInPluginParamHistory } from "../utils/builtInPluginParamHistory";

const schema: BuiltInPluginSchema = {
  schemaVersion: 1, pluginId: "eq", name: "OpenStudio EQ", category: "EQ", chain: "track", fxIndex: 0,
  parameters: ["phaseMode", "minimumPhaseFIR"].map(id => ({ id, label: id, type: "toggle", min: 0, max: 1, value: 0, defaultValue: 0 })),
};

describe("EQ user phase transition", () => {
  it("flushes pending band edits before submitting one native configuration operation", async () => {
    const order: string[] = [];
    const onApplyState = vi.fn(async (state: string) => { order.push("apply"); expect(JSON.parse(state)).toEqual({ eqPhaseConfiguration: { phaseMode: 1, preserveBandDynamics: true } }); return true; });
    const onFlush = vi.fn(async () => { order.push("flush"); return true; });
    expect(await applyEQPhaseTransition(schema, "phaseMode", 1, { onFlush, onApplyState })).toBe(true);
    expect(order).toEqual(["flush", "apply"]); expect(onApplyState).toHaveBeenCalledTimes(1);
  });

  it("preserves full-state Undo/Redo through the same callback used by presets and Compare", async () => {
    const history = new BuiltInPluginParamHistory("eq-instance");
    const before = JSON.stringify({ name: schema.name, fullState: "minimum-with-active-band-dynamics" });
    const after = JSON.stringify({ name: schema.name, fullState: "prepared-fir-with-active-band-dynamics" });
    let state = before;
    const onApplyState = vi.fn(async (request: string) => {
      expect(JSON.parse(request).eqPhaseConfiguration).toEqual({ minimumPhaseFIR: 1, preserveBandDynamics: true });
      const previous = state; state = after; history.recordState(previous, state); return true;
    });
    expect(await applyEQPhaseTransition(schema, "minimumPhaseFIR", 1, { onFlush: async () => true, onApplyState })).toBe(true);
    expect(history.getUndoEntries()).toHaveLength(1);
    const replay = async (entry: Parameters<Parameters<typeof history.undo>[1]>[0], direction: "before" | "after") => { state = entry.state![direction]; return true; };
    expect(await history.undo(async () => true, replay)).toBe("applied"); expect(state).toBe(before);
    expect(await history.redo(async () => true, replay)).toBe("applied"); expect(state).toBe(after);
  });

  it("maps each visible processing mode to one native configuration", async () => {
    const onApplyState = vi.fn(async (_state: string) => true);
    const options = { onApplyState, onFlush: async () => true };
    for (const mode of [0, 1, 2]) expect(await applyEQPhaseTransition(schema, "processingMode", mode, options)).toBe(true);
    expect(onApplyState.mock.calls.map(([state]) => JSON.parse(state).eqPhaseConfiguration)).toEqual([
      { phaseMode: 0, minimumPhaseFIR: 0, preserveBandDynamics: true },
      { phaseMode: 1, preserveBandDynamics: true },
      { phaseMode: 0, minimumPhaseFIR: 1, preserveBandDynamics: true },
    ]);
    expect(await applyEQPhaseTransition(schema, "processingMode", 3, options)).toBe(false);
    expect(onApplyState).toHaveBeenCalledTimes(3);
  });

  it("does not dispatch for a prepared MIDI bank, invalid choice or failed parameter flush", async () => {
    const onApplyState = vi.fn(async () => true), onFlush = vi.fn(async () => true);
    const prepared = { ...schema, midiPrograms: { preparedConfigurations: true } } as BuiltInPluginSchema;
    expect(await applyEQPhaseTransition(prepared, "phaseMode", 1, { onApplyState, onFlush })).toBe(false);
    expect(await applyEQPhaseTransition(schema, "phaseMode", 2, { onApplyState, onFlush })).toBe(false);
    expect(onFlush).not.toHaveBeenCalled();
    expect(await applyEQPhaseTransition(schema, "phaseMode", 1, { onApplyState, onFlush: async () => false })).toBe(false);
    expect(onApplyState).not.toHaveBeenCalled();
    expect(await applyEQPhaseTransition(schema, "phaseMode", 1, { onApplyState: async () => false, onFlush })).toBe(false);
  });
});

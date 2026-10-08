import type { BuiltInPluginSchema } from "../services/NativeBridge";

export type EQPhaseField = "phaseMode" | "minimumPhaseFIR" | "processingMode";

/** User changes opt into continuity. Legacy/preset state loading stays untouched. */
export async function applyEQPhaseTransition(
  schema: BuiltInPluginSchema,
  field: EQPhaseField,
  value: number,
  callbacks: { onFlush: () => Promise<boolean>; onApplyState: (state: string) => Promise<boolean> },
): Promise<boolean> {
  if (schema.pluginId !== "eq" || schema.midiPrograms?.preparedConfigurations
    || !schema.parameters.some(parameter => parameter.id === (field === "processingMode" ? "phaseMode" : field))
    || (value !== 0 && value !== 1 && !(field === "processingMode" && value === 2))) return false;
  if (field === "processingMode" && value === 2 && !schema.parameters.some(parameter => parameter.id === "minimumPhaseFIR")) return false;
  if (!await callbacks.onFlush()) return false;
  // Native code resolves the latest bands and prepares the complete transition
  // under one publication lock. No stale descriptors or normalized aliases are
  // replayed here. The panel records before/after full state for Undo and Redo.
  const configuration = field === "processingMode"
    ? value === 1 ? { phaseMode: 1 } : { phaseMode: 0, minimumPhaseFIR: value === 2 ? 1 : 0 }
    : { [field]: value };
  return callbacks.onApplyState(JSON.stringify({ eqPhaseConfiguration: { ...configuration, preserveBandDynamics: true } }));
}

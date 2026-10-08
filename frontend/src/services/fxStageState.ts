export type FXStageSlotType = "builtin" | "jsfx" | "plugin" | "vst3" | "clap" | "lv2" | "au";

/** Durable native master/monitor slot. Parameter indices are not its identity. */
export interface FXStageSlotState {
  automationKey: string;
  name: string;
  type: FXStageSlotType;
  pluginPath: string;
  pluginFormat: string;
  state: string;
  bypassed: boolean;
  forceFloat: boolean;
}

const types = new Set<string>(["builtin", "jsfx", "plugin", "vst3", "clap", "lv2", "au"]);
const isSlotType = (value: string): value is FXStageSlotType => types.has(value);
export function parseFXStageState(value: unknown): FXStageSlotState[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid FX stage snapshot");
  const keys = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid FX stage slot");
    const slot = item as Record<string, unknown>;
    const text = (key: string): string => {
      const field = slot[key];
      if (typeof field !== "string") throw new Error(`Invalid FX stage ${key}`);
      return field;
    };
    const automationKey = text("automationKey"), name = text("name"), type = text("type"),
      pluginPath = text("pluginPath"), pluginFormat = text("pluginFormat"), state = text("state");
    if (!automationKey || keys.has(automationKey) || !pluginPath
      || !isSlotType(type) || typeof slot.bypassed !== "boolean" || typeof slot.forceFloat !== "boolean")
      throw new Error("Invalid or duplicate FX stage identity/state");
    keys.add(automationKey);
    return { automationKey, name, type, pluginPath, pluginFormat, state,
      bypassed: slot.bypassed, forceFloat: slot.forceFloat };
  });
}

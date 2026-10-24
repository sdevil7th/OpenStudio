import type { BuiltInParamDescriptor } from "../services/NativeBridge";

/** Display adapters only; automation and history retain their native IDs/units. */
export function reverbParameterPresentation(parameter: BuiltInParamDescriptor, type: number) {
  if (type === 36 && parameter.id === "roomSize") {
    const toDisplay = (value: number) => 25 + 1975 * value;
    return {
      parameter: { ...parameter, value: toDisplay(parameter.value), defaultValue: toDisplay(parameter.defaultValue), min: 25, max: 2000, unit: "ms" },
      toNative: (value: number) => Math.max(0, Math.min(1, (value - 25) / 1975)),
    };
  }
  return {
    parameter: type === 5 && parameter.id === "shimmerAmount" ? { ...parameter, defaultValue: .5 } : parameter,
    toNative: (value: number) => value,
  };
}

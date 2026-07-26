import type { BuiltInParamDescriptor } from "../services/NativeBridge";

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeParamValue(param: BuiltInParamDescriptor, value: number) {
  if (param.max <= param.min) return 0;
  return clampNumber((value - param.min) / (param.max - param.min), 0, 1);
}

export function normalizeParam(param: BuiltInParamDescriptor) {
  return normalizeParamValue(param, param.value);
}

export function formatParamValue(param: BuiltInParamDescriptor) {
  if (param.type === "toggle") return param.value >= 0.5 ? "On" : "Off";
  if (param.type === "enum") {
    return (
      param.enumOptions?.find((option) => Math.round(option.value) === Math.round(param.value))
        ?.label ?? String(Math.round(param.value))
    );
  }
  const span = Math.abs(param.max - param.min);
  const decimals = span <= 2 ? 2 : span <= 50 ? 1 : 0;
  return `${param.value.toFixed(decimals)}${param.unit ? ` ${param.unit}` : ""}`;
}

export function stepForParam(param: BuiltInParamDescriptor) {
  const span = Math.abs(param.max - param.min);
  if (param.type === "toggle" || param.type === "enum") return 1;
  if (param.unit === "Hz" && param.max > 1000) return 1;
  if (param.unit === "ms" || param.unit === "s" || param.unit === "dB" || param.unit === "st" || param.unit === "ct") {
    return Math.max(span / 500, 0.01);
  }
  return Math.max(span / 500, 0.001);
}

export function quantizeParamValue(param: BuiltInParamDescriptor, value: number) {
  const step = stepForParam(param);
  if (step <= 0) return clampNumber(value, param.min, param.max);
  const snapped = Math.round(value / step) * step;
  return clampNumber(Number(snapped.toFixed(6)), param.min, param.max);
}

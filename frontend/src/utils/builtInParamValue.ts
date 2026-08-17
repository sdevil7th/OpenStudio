import type { BuiltInParamDescriptor } from "../services/NativeBridge";

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const CHORUS_RATE_PARAM_ID = "chorusRateHz";
const CHORUS_RATE_MIN_HZ = 0.01;
const CHORUS_RATE_MID_HZ = 1;
const CHORUS_RATE_MAX_HZ = 8;
const CHORUS_RATE_NORMALIZED_STEP = 1 / 500;
const CHORUS_RATE_CURVE_K =
  (Math.log(CHORUS_RATE_MID_HZ / CHORUS_RATE_MIN_HZ) - Math.log(CHORUS_RATE_MAX_HZ / CHORUS_RATE_MID_HZ))
  / (Math.log(CHORUS_RATE_MID_HZ / CHORUS_RATE_MIN_HZ) + Math.log(CHORUS_RATE_MAX_HZ / CHORUS_RATE_MID_HZ));

export function isChorusRateParam(param: Pick<BuiltInParamDescriptor, "id">) {
  return param.id === CHORUS_RATE_PARAM_ID;
}

function chorusRateCurveUnit(value: number) {
  const x = clampNumber(value, 0, 1);
  return x + CHORUS_RATE_CURVE_K * x * (1 - x);
}

function inverseChorusRateCurveUnit(value: number) {
  const y = clampNumber(value, 0, 1);
  const onePlusK = 1 + CHORUS_RATE_CURVE_K;
  const discriminant = Math.max(
    0,
    onePlusK * onePlusK - 4 * CHORUS_RATE_CURVE_K * y,
  );
  return clampNumber(
    (onePlusK - Math.sqrt(discriminant)) / (2 * CHORUS_RATE_CURVE_K),
    0,
    1,
  );
}

export function chorusRateHzFromNormalized(normalized: number) {
  const n = clampNumber(normalized, 0, 1);
  if (n <= 0.5) {
    return CHORUS_RATE_MIN_HZ
      * Math.pow(CHORUS_RATE_MID_HZ / CHORUS_RATE_MIN_HZ, chorusRateCurveUnit(n * 2));
  }
  return CHORUS_RATE_MID_HZ
    * Math.pow(CHORUS_RATE_MAX_HZ / CHORUS_RATE_MID_HZ, chorusRateCurveUnit(n * 2 - 1));
}

export function chorusRateNormalizedFromHz(rateHz: number) {
  const hz = clampNumber(rateHz, CHORUS_RATE_MIN_HZ, CHORUS_RATE_MAX_HZ);
  if (hz <= CHORUS_RATE_MID_HZ) {
    const curveValue = Math.log(hz / CHORUS_RATE_MIN_HZ)
      / Math.log(CHORUS_RATE_MID_HZ / CHORUS_RATE_MIN_HZ);
    return 0.5 * inverseChorusRateCurveUnit(curveValue);
  }
  const curveValue = Math.log(hz / CHORUS_RATE_MID_HZ)
    / Math.log(CHORUS_RATE_MAX_HZ / CHORUS_RATE_MID_HZ);
  return 0.5 * (1 + inverseChorusRateCurveUnit(curveValue));
}

export function migrateLegacyChorusRateAutomationValue(
  legacyNormalized: number,
) {
  const oldNormalized = clampNumber(legacyNormalized, 0, 1);
  const oldRateHz = 0.05 + oldNormalized * (8 - 0.05);
  return chorusRateNormalizedFromHz(oldRateHz);
}

export function normalizeParamValue(param: BuiltInParamDescriptor, value: number) {
  if (isChorusRateParam(param)) return chorusRateNormalizedFromHz(value);
  if (param.max <= param.min) return 0;
  return clampNumber((value - param.min) / (param.max - param.min), 0, 1);
}

export function normalizeParam(param: BuiltInParamDescriptor) {
  return normalizeParamValue(param, param.value);
}

export function denormalizeParamValue(param: BuiltInParamDescriptor, normalized: number) {
  if (isChorusRateParam(param)) return chorusRateHzFromNormalized(normalized);
  return param.min + clampNumber(normalized, 0, 1) * Math.max(param.max - param.min, 0);
}

export function formatParamValue(param: BuiltInParamDescriptor) {
  if (param.type === "toggle") return param.value >= 0.5 ? "On" : "Off";
  if (param.type === "enum") {
    return (
      param.enumOptions?.find((option) => Math.round(option.value) === Math.round(param.value))
        ?.label ?? String(Math.round(param.value))
    );
  }
  if (isChorusRateParam(param)) {
    const decimals = param.value < 1 ? 3 : 2;
    return `${param.value.toFixed(decimals)} Hz`;
  }
  const span = Math.abs(param.max - param.min);
  const decimals = span <= 2 ? 2 : span <= 50 ? 1 : 0;
  return `${param.value.toFixed(decimals)}${param.unit ? ` ${param.unit}` : ""}`;
}

export function stepForParam(param: BuiltInParamDescriptor) {
  if (isChorusRateParam(param)) return CHORUS_RATE_NORMALIZED_STEP;
  const span = Math.abs(param.max - param.min);
  if (param.type === "toggle" || param.type === "enum") return 1;
  if (param.unit === "Hz" && param.max > 1000) return 1;
  if (param.unit === "ms" || param.unit === "s" || param.unit === "dB" || param.unit === "st" || param.unit === "ct") {
    return Math.max(span / 500, 0.01);
  }
  return Math.max(span / 500, 0.001);
}

export function quantizeParamValue(param: BuiltInParamDescriptor, value: number) {
  if (isChorusRateParam(param)) {
    const normalized = chorusRateNormalizedFromHz(value);
    const snapped = Math.round(normalized / CHORUS_RATE_NORMALIZED_STEP)
      * CHORUS_RATE_NORMALIZED_STEP;
    return Number(chorusRateHzFromNormalized(snapped).toFixed(6));
  }
  const step = stepForParam(param);
  if (step <= 0) return clampNumber(value, param.min, param.max);
  const snapped = Math.round(value / step) * step;
  return clampNumber(Number(snapped.toFixed(6)), param.min, param.max);
}

export function offsetParamValue(
  param: BuiltInParamDescriptor,
  value: number,
  stepCount: number,
) {
  if (isChorusRateParam(param)) {
    return chorusRateHzFromNormalized(
      chorusRateNormalizedFromHz(value)
        + CHORUS_RATE_NORMALIZED_STEP * stepCount,
    );
  }
  return value + stepForParam(param) * stepCount;
}

export function rangeInputValue(param: BuiltInParamDescriptor) {
  return isChorusRateParam(param) ? normalizeParam(param) : param.value;
}

export function rangeInputMin(param: BuiltInParamDescriptor) {
  return isChorusRateParam(param) ? 0 : param.min;
}

export function rangeInputMax(param: BuiltInParamDescriptor) {
  return isChorusRateParam(param) ? 1 : param.max;
}

export function rangeInputStep(param: BuiltInParamDescriptor) {
  return isChorusRateParam(param) ? CHORUS_RATE_NORMALIZED_STEP : stepForParam(param);
}

export function paramValueFromRangeInput(
  param: BuiltInParamDescriptor,
  rangeValue: number,
) {
  return isChorusRateParam(param)
    ? chorusRateHzFromNormalized(rangeValue)
    : rangeValue;
}

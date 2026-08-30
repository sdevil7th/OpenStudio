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

export const NAM_GRAPHIC_EQ_HPF_PARAM_ID = "eqHPFHz";
export const NAM_GRAPHIC_EQ_LPF_PARAM_ID = "eqLPFHz";
export const NAM_GRAPHIC_EQ_HPF_OFF_HZ = 0;
export const NAM_GRAPHIC_EQ_HPF_MIN_HZ = 20;
export const NAM_GRAPHIC_EQ_HPF_MAX_HZ = 500;
export const NAM_GRAPHIC_EQ_LPF_MIN_HZ = 3000;
export const NAM_GRAPHIC_EQ_LPF_MAX_HZ = 20000;
export const NAM_GRAPHIC_EQ_LPF_OFF_HZ = 24000;
export const NAM_PRE_EQ_HPF_PARAM_ID = "preEqHPFHz";
export const NAM_PRE_EQ_LPF_PARAM_ID = "preEqLPFHz";
export const NAM_PRE_EQ_HPF_OFF_HZ = 0;
export const NAM_PRE_EQ_HPF_MIN_HZ = 35;
export const NAM_PRE_EQ_HPF_MAX_HZ = 180;
export const NAM_PRE_EQ_LPF_MIN_HZ = 3000;
export const NAM_PRE_EQ_LPF_MAX_HZ = 20000;
export const NAM_PRE_EQ_LPF_OFF_HZ = 24000;

export type NAMGraphicEqRecallMemoryId =
  | "eqHPFLastActiveHz"
  | "eqLPFLastActiveHz"
  | "preEqHPFLastActiveHz"
  | "preEqLPFLastActiveHz";

export function namGraphicEqActiveRecallUpdate(
  paramId: string,
  value: number,
): readonly [NAMGraphicEqRecallMemoryId, number] | null {
  if (!Number.isFinite(value)) return null;
  if (
    paramId === NAM_GRAPHIC_EQ_HPF_PARAM_ID
    && value >= NAM_GRAPHIC_EQ_HPF_MIN_HZ
    && value <= NAM_GRAPHIC_EQ_HPF_MAX_HZ
  ) {
    return ["eqHPFLastActiveHz", value];
  }
  if (
    paramId === NAM_GRAPHIC_EQ_LPF_PARAM_ID
    && value >= NAM_GRAPHIC_EQ_LPF_MIN_HZ
    && value <= NAM_GRAPHIC_EQ_LPF_MAX_HZ
  ) {
    return ["eqLPFLastActiveHz", value];
  }
  if (
    paramId === NAM_PRE_EQ_HPF_PARAM_ID
    && value >= NAM_PRE_EQ_HPF_MIN_HZ
    && value <= NAM_PRE_EQ_HPF_MAX_HZ
  ) {
    return ["preEqHPFLastActiveHz", value];
  }
  if (
    paramId === NAM_PRE_EQ_LPF_PARAM_ID
    && value >= NAM_PRE_EQ_LPF_MIN_HZ
    && value <= NAM_PRE_EQ_LPF_MAX_HZ
  ) {
    return ["preEqLPFLastActiveHz", value];
  }
  return null;
}

// The two end stops deliberately reserve physical travel for OFF. This makes
// bypass visually unambiguous while keeping the audible cutoff range logarithmic.
export const NAM_GRAPHIC_EQ_FILTER_OFF_DETENT = 0.06;
const NAM_GRAPHIC_EQ_FILTER_NORMALIZED_STEP = 1 / 300;
const NAM_GRAPHIC_EQ_FILTER_BOUNDARY_EPSILON = 1.0e-9;

export function isNAMGraphicEqHPFParam(
  param: Pick<BuiltInParamDescriptor, "id">,
) {
  return param.id === NAM_GRAPHIC_EQ_HPF_PARAM_ID;
}

export function isNAMGraphicEqLPFParam(
  param: Pick<BuiltInParamDescriptor, "id">,
) {
  return param.id === NAM_GRAPHIC_EQ_LPF_PARAM_ID;
}

export function isNAMGraphicEqFilterParam(
  param: Pick<BuiltInParamDescriptor, "id">,
) {
  return isNAMGraphicEqHPFParam(param) || isNAMGraphicEqLPFParam(param);
}

export function isNAMPreEqHPFParam(
  param: Pick<BuiltInParamDescriptor, "id">,
) {
  return param.id === NAM_PRE_EQ_HPF_PARAM_ID;
}

export function isNAMPreEqLPFParam(
  param: Pick<BuiltInParamDescriptor, "id">,
) {
  return param.id === NAM_PRE_EQ_LPF_PARAM_ID;
}

export function isNAMPreEqFilterParam(
  param: Pick<BuiltInParamDescriptor, "id">,
) {
  return isNAMPreEqHPFParam(param) || isNAMPreEqLPFParam(param);
}

function isNAMEqFilterParam(param: Pick<BuiltInParamDescriptor, "id">) {
  return isNAMGraphicEqFilterParam(param) || isNAMPreEqFilterParam(param);
}

function logFrequencyFromUnit(unit: number, minHz: number, maxHz: number) {
  return minHz * Math.pow(maxHz / minHz, clampNumber(unit, 0, 1));
}

function logFrequencyUnit(frequencyHz: number, minHz: number, maxHz: number) {
  const hz = clampNumber(frequencyHz, minHz, maxHz);
  return Math.log(hz / minHz) / Math.log(maxHz / minHz);
}

export function namGraphicEqFilterHzFromNormalized(
  paramId: string,
  normalized: number,
) {
  const n = clampNumber(normalized, 0, 1);
  if (paramId === NAM_GRAPHIC_EQ_HPF_PARAM_ID) {
    if (n < NAM_GRAPHIC_EQ_FILTER_OFF_DETENT - NAM_GRAPHIC_EQ_FILTER_BOUNDARY_EPSILON) {
      return NAM_GRAPHIC_EQ_HPF_OFF_HZ;
    }
    const activeUnit = (n - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT)
      / (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT);
    return logFrequencyFromUnit(
      activeUnit,
      NAM_GRAPHIC_EQ_HPF_MIN_HZ,
      NAM_GRAPHIC_EQ_HPF_MAX_HZ,
    );
  }
  if (paramId === NAM_GRAPHIC_EQ_LPF_PARAM_ID) {
    if (n > 1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT + NAM_GRAPHIC_EQ_FILTER_BOUNDARY_EPSILON) {
      return NAM_GRAPHIC_EQ_LPF_OFF_HZ;
    }
    const activeUnit = n / (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT);
    return logFrequencyFromUnit(
      activeUnit,
      NAM_GRAPHIC_EQ_LPF_MIN_HZ,
      NAM_GRAPHIC_EQ_LPF_MAX_HZ,
    );
  }
  if (paramId === NAM_PRE_EQ_HPF_PARAM_ID) {
    if (n < NAM_GRAPHIC_EQ_FILTER_OFF_DETENT - NAM_GRAPHIC_EQ_FILTER_BOUNDARY_EPSILON) {
      return NAM_PRE_EQ_HPF_OFF_HZ;
    }
    return logFrequencyFromUnit(
      (n - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT) / (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT),
      NAM_PRE_EQ_HPF_MIN_HZ,
      NAM_PRE_EQ_HPF_MAX_HZ,
    );
  }
  if (paramId === NAM_PRE_EQ_LPF_PARAM_ID) {
    if (n > 1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT + NAM_GRAPHIC_EQ_FILTER_BOUNDARY_EPSILON) {
      return NAM_PRE_EQ_LPF_OFF_HZ;
    }
    return logFrequencyFromUnit(
      n / (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT),
      NAM_PRE_EQ_LPF_MIN_HZ,
      NAM_PRE_EQ_LPF_MAX_HZ,
    );
  }
  return n;
}

export function namGraphicEqFilterNormalizedFromHz(
  paramId: string,
  frequencyHz: number,
) {
  if (paramId === NAM_GRAPHIC_EQ_HPF_PARAM_ID) {
    if (!Number.isFinite(frequencyHz) || frequencyHz < NAM_GRAPHIC_EQ_HPF_MIN_HZ) return 0;
    return NAM_GRAPHIC_EQ_FILTER_OFF_DETENT
      + (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT)
        * logFrequencyUnit(
          frequencyHz,
          NAM_GRAPHIC_EQ_HPF_MIN_HZ,
          NAM_GRAPHIC_EQ_HPF_MAX_HZ,
        );
  }
  if (paramId === NAM_GRAPHIC_EQ_LPF_PARAM_ID) {
    if (!Number.isFinite(frequencyHz)
        || frequencyHz >= (NAM_GRAPHIC_EQ_LPF_MAX_HZ + NAM_GRAPHIC_EQ_LPF_OFF_HZ) / 2) {
      return 1;
    }
    return (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT)
      * logFrequencyUnit(
        frequencyHz,
        NAM_GRAPHIC_EQ_LPF_MIN_HZ,
        NAM_GRAPHIC_EQ_LPF_MAX_HZ,
      );
  }
  if (paramId === NAM_PRE_EQ_HPF_PARAM_ID) {
    if (!Number.isFinite(frequencyHz) || frequencyHz < NAM_PRE_EQ_HPF_MIN_HZ) return 0;
    return NAM_GRAPHIC_EQ_FILTER_OFF_DETENT
      + (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT)
        * logFrequencyUnit(
          frequencyHz,
          NAM_PRE_EQ_HPF_MIN_HZ,
          NAM_PRE_EQ_HPF_MAX_HZ,
        );
  }
  if (paramId === NAM_PRE_EQ_LPF_PARAM_ID) {
    if (!Number.isFinite(frequencyHz)
        || frequencyHz >= (NAM_PRE_EQ_LPF_MAX_HZ + NAM_PRE_EQ_LPF_OFF_HZ) / 2) {
      return 1;
    }
    return (1 - NAM_GRAPHIC_EQ_FILTER_OFF_DETENT)
      * logFrequencyUnit(
        frequencyHz,
        NAM_PRE_EQ_LPF_MIN_HZ,
        NAM_PRE_EQ_LPF_MAX_HZ,
      );
  }
  return clampNumber(frequencyHz, 0, 1);
}

export function isNAMGraphicEqFilterOff(
  param: Pick<BuiltInParamDescriptor, "id" | "value">,
) {
  if (isNAMGraphicEqHPFParam(param)) return param.value < NAM_GRAPHIC_EQ_HPF_MIN_HZ;
  if (isNAMGraphicEqLPFParam(param)) {
    return param.value >= (NAM_GRAPHIC_EQ_LPF_MAX_HZ + NAM_GRAPHIC_EQ_LPF_OFF_HZ) / 2;
  }
  if (isNAMPreEqHPFParam(param)) return param.value < NAM_PRE_EQ_HPF_MIN_HZ;
  if (isNAMPreEqLPFParam(param)) {
    return param.value >= (NAM_PRE_EQ_LPF_MAX_HZ + NAM_PRE_EQ_LPF_OFF_HZ) / 2;
  }
  return false;
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
  if (isNAMEqFilterParam(param)) {
    return namGraphicEqFilterNormalizedFromHz(param.id, value);
  }
  if (param.max <= param.min) return 0;
  return clampNumber((value - param.min) / (param.max - param.min), 0, 1);
}

export function normalizeParam(param: BuiltInParamDescriptor) {
  return normalizeParamValue(param, param.value);
}

export function denormalizeParamValue(param: BuiltInParamDescriptor, normalized: number) {
  if (isChorusRateParam(param)) return chorusRateHzFromNormalized(normalized);
  if (isNAMEqFilterParam(param)) {
    return namGraphicEqFilterHzFromNormalized(param.id, normalized);
  }
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
  if (isNAMEqFilterParam(param)) {
    if (isNAMGraphicEqFilterOff(param)) return "OFF";
    if (isNAMGraphicEqLPFParam(param) || isNAMPreEqLPFParam(param)) return `${(param.value / 1000).toFixed(1)} kHz`;
    return `${Math.round(param.value)} Hz`;
  }
  const span = Math.abs(param.max - param.min);
  const decimals = span <= 2 ? 2 : span <= 50 ? 1 : 0;
  return `${param.value.toFixed(decimals)}${param.unit ? ` ${param.unit}` : ""}`;
}

export function stepForParam(param: BuiltInParamDescriptor) {
  if (isChorusRateParam(param)) return CHORUS_RATE_NORMALIZED_STEP;
  if (isNAMEqFilterParam(param)) return NAM_GRAPHIC_EQ_FILTER_NORMALIZED_STEP;
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
  if (isNAMEqFilterParam(param)) {
    const normalized = namGraphicEqFilterNormalizedFromHz(param.id, value);
    const snapped = Math.round(normalized / NAM_GRAPHIC_EQ_FILTER_NORMALIZED_STEP)
      * NAM_GRAPHIC_EQ_FILTER_NORMALIZED_STEP;
    const hz = namGraphicEqFilterHzFromNormalized(param.id, snapped);
    if (hz === NAM_GRAPHIC_EQ_HPF_OFF_HZ || hz === NAM_GRAPHIC_EQ_LPF_OFF_HZ) return hz;
    return isNAMGraphicEqLPFParam(param) || isNAMPreEqLPFParam(param)
      ? Math.round(hz / 10) * 10
      : Math.round(hz);
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
  if (isNAMEqFilterParam(param)) {
    const valueParam = { id: param.id, value };
    if (isNAMGraphicEqHPFParam(param) && isNAMGraphicEqFilterOff(valueParam)) {
      return stepCount > 0 ? NAM_GRAPHIC_EQ_HPF_MIN_HZ : NAM_GRAPHIC_EQ_HPF_OFF_HZ;
    }
    if (isNAMPreEqHPFParam(param) && isNAMGraphicEqFilterOff(valueParam)) {
      return stepCount > 0 ? NAM_PRE_EQ_HPF_MIN_HZ : NAM_PRE_EQ_HPF_OFF_HZ;
    }
    if (isNAMGraphicEqLPFParam(param) && isNAMGraphicEqFilterOff(valueParam)) {
      return stepCount < 0 ? NAM_GRAPHIC_EQ_LPF_MAX_HZ : NAM_GRAPHIC_EQ_LPF_OFF_HZ;
    }
    if (isNAMPreEqLPFParam(param) && isNAMGraphicEqFilterOff(valueParam)) {
      return stepCount < 0 ? NAM_PRE_EQ_LPF_MAX_HZ : NAM_PRE_EQ_LPF_OFF_HZ;
    }
    return namGraphicEqFilterHzFromNormalized(
      param.id,
      namGraphicEqFilterNormalizedFromHz(param.id, value)
        + NAM_GRAPHIC_EQ_FILTER_NORMALIZED_STEP * stepCount,
    );
  }
  return value + stepForParam(param) * stepCount;
}

export function rangeInputValue(param: BuiltInParamDescriptor) {
  return isChorusRateParam(param) || isNAMEqFilterParam(param)
    ? normalizeParam(param)
    : param.value;
}

export function rangeInputMin(param: BuiltInParamDescriptor) {
  return isChorusRateParam(param) || isNAMEqFilterParam(param) ? 0 : param.min;
}

export function rangeInputMax(param: BuiltInParamDescriptor) {
  return isChorusRateParam(param) || isNAMEqFilterParam(param) ? 1 : param.max;
}

export function rangeInputStep(param: BuiltInParamDescriptor) {
  return stepForParam(param);
}

export function paramValueFromRangeInput(
  param: BuiltInParamDescriptor,
  rangeValue: number,
) {
  if (isChorusRateParam(param)) return chorusRateHzFromNormalized(rangeValue);
  if (isNAMEqFilterParam(param)) {
    return namGraphicEqFilterHzFromNormalized(param.id, rangeValue);
  }
  return rangeValue;
}

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, SlidersHorizontal, X } from "lucide-react";
import {
  BuiltInParamDescriptor,
  BuiltInPluginAddress,
  BuiltInPluginSchema,
  nativeBridge,
} from "../services/NativeBridge";
import { ParametricGraph } from "./ParametricGraph";
import type { GraphAxis, GraphNode, GraphNodeConfig } from "./ParametricGraph";
import { NAMRackPanel } from "./NAMRackPanel";
import { Button, ProfiledRangeInput } from "./ui";
import { registerScopedActionExecutor } from "../store/actionRegistry";
import {
  activateShortcutContext,
  getActiveShortcutContext,
  registerShortcutSurface,
} from "../utils/shortcutContext";
import { windowRole } from "../utils/windowEnvironment";
import {
  clampNumber as clamp,
  formatParamValue,
  isChorusRateParam,
  isNAMGraphicEqFilterParam,
  normalizeParam as normalize,
  normalizeParamValue,
  paramValueFromRangeInput,
  rangeInputMax,
  rangeInputMin,
  rangeInputStep,
  rangeInputValue,
  quantizeParamValue,
  stepForParam,
} from "../utils/builtInParamValue";

export { formatParamValue, stepForParam };

interface BuiltInPluginPanelProps {
  address: BuiltInPluginAddress;
  fallbackName: string;
  onClose?: () => void;
  initialSchema?: BuiltInPluginSchema;
  shortcutSessionId?: string;
}

function getParam(params: BuiltInParamDescriptor[], id: string) {
  return params.find((param) => param.id === id);
}

function makeFallbackParam(
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
  defaultValue: number,
  unit = "",
  graphRole = "controls",
  type: BuiltInParamDescriptor["type"] = "continuous",
  enumOptions?: BuiltInParamDescriptor["enumOptions"],
): BuiltInParamDescriptor {
  return {
    id,
    label,
    type,
    value,
    min,
    max,
    defaultValue,
    unit,
    automatable: type !== "meter",
    graphRole,
    enumOptions,
  };
}

function isNAMPluginName(name: string) {
  return name.toLowerCase().includes("nam");
}

export function createNAMBootSchema(address: BuiltInPluginAddress, fallbackName: string): BuiltInPluginSchema {
  return {
    schemaVersion: 1,
    name: fallbackName || "OpenStudio NAM Rack",
    category: "NAM",
    chain: address.chain,
    fxIndex: address.fxIndex ?? -1,
    parameters: [
      makeFallbackParam("inputTrimDb", "Input", 0, -24, 24, 0, "dB", "gain"),
      {
        ...makeFallbackParam("instrumentProfile", "Instrument", 0, 0, 1, 0, "", "global", "enum", [
          { value: 0, label: "Guitar" },
          { value: 1, label: "Bass" },
        ]),
        automatable: false,
      },
      makeFallbackParam("gateThresholdDb", "Gate", -80, -100, 0, -80, "dB", "dynamics"),
      makeFallbackParam("gateReleaseMs", "Gate Rel", 80, 5, 1000, 80, "ms", "dynamics"),
      makeFallbackParam("compressorEnabled", "Compressor", 0, 0, 1, 0, "", "dynamics", "toggle"),
      makeFallbackParam("compressorAttackMs", "Attack", 21.9, 0.1, 50, 21.9, "ms", "dynamics"),
      makeFallbackParam("compressorReleaseMs", "Release", 149.1, 50, 1000, 149.1, "ms", "dynamics"),
      makeFallbackParam("compressorToneDb", "Tone", 0, -6, 6, 0, "dB", "dynamics"),
      makeFallbackParam("compressorIntensity", "Intensity", 0, 0, 1, 0, "", "dynamics", "toggle"),
      makeFallbackParam("compressorSidechainHPF", "HPF", 1, 0, 2, 1, "", "dynamics", "enum", [
        { value: 0, label: "Off" },
        { value: 1, label: "80 Hz" },
        { value: 2, label: "240 Hz" },
      ]),
      makeFallbackParam("compressorMix", "Mix", 0.65, 0, 1, 0.65, "", "dynamics"),
      makeFallbackParam("compressorVolumeDb", "Level", 0, -18, 18, 0, "dB", "dynamics"),
      makeFallbackParam("compressorComp", "Comp", 0.35, 0, 1, 0.35, "", "dynamics"),
      makeFallbackParam("preEqEnabled", "PRE EQ", 0, 0, 1, 0, "", "preEq", "toggle"),
      makeFallbackParam("preEq120Db", "120 Hz", 0, -12, 12, 0, "dB", "preEq"),
      makeFallbackParam("preEq250Db", "250 Hz", 0, -12, 12, 0, "dB", "preEq"),
      makeFallbackParam("preEq500Db", "500 Hz", 0, -12, 12, 0, "dB", "preEq"),
      makeFallbackParam("preEq1kDb", "1 kHz", 0, -12, 12, 0, "dB", "preEq"),
      makeFallbackParam("preEq2k5Db", "2.5 kHz", 0, -12, 12, 0, "dB", "preEq"),
      makeFallbackParam("preEq5kDb", "5 kHz", 0, -12, 12, 0, "dB", "preEq"),
      makeFallbackParam("preEq8kDb", "8 kHz", 0, -12, 12, 0, "dB", "preEq"),
      makeFallbackParam("preEq12kDb", "12 kHz", 0, -12, 12, 0, "dB", "preEq"),
      makeFallbackParam("preEqHPFHz", "PRE HPF", 0, 0, 180, 0, "Hz", "preEq"),
      makeFallbackParam("preEqLPFHz", "PRE LPF", 24000, 3000, 24000, 24000, "Hz", "preEq"),
      makeFallbackParam("precisionDriveEnabled", "Precision Drive", 0, 0, 1, 0, "", "drive", "toggle"),
      makeFallbackParam("precisionDriveVolumeDb", "PD Volume", 9, -12, 12, 9, "dB", "drive"),
      makeFallbackParam("precisionDriveBright", "PD Bright", 0.55, 0, 1, 0.55, "", "drive"),
      makeFallbackParam("precisionDriveAttack", "PD Attack", 0.5, 0, 1, 0.5, "", "drive"),
      makeFallbackParam("precisionDriveGate", "PD Gate", 0, 0, 1, 0, "", "drive"),
      makeFallbackParam("precisionDriveDrive", "PD Drive", 0.35, 0, 1, 0.35, "", "drive"),
      makeFallbackParam("pedalMix", "Pedal Mix", 1, 0, 1, 1, "", "model"),
      makeFallbackParam("ampEnabled", "Amp Power", 1, 0, 1, 1, "", "model", "toggle"),
      makeFallbackParam("ampGainDb", "Gain", 0, -24, 24, 0, "dB", "model"),
      makeFallbackParam("ampBoost", "Tight Boost", 0, 0, 1, 0, "", "model", "toggle"),
      makeFallbackParam("ampVoice", "Bright Voice", 0, 0, 1, 0, "", "model", "toggle"),
      makeFallbackParam("ampMix", "Amp Mix", 1, 0, 1, 1, "", "model"),
      makeFallbackParam("ampOutputDb", "Post Level", 0, -24, 12, 0, "dB", "model"),
      makeFallbackParam("bassDb", "Bass", 0, -12, 12, 0, "dB", "tone"),
      makeFallbackParam("midDb", "Mid", 0, -12, 12, 0, "dB", "tone"),
      makeFallbackParam("trebleDb", "Treble", 0, -12, 12, 0, "dB", "tone"),
      makeFallbackParam("presenceDb", "Presence", 0, -12, 12, 0, "dB", "tone"),
      makeFallbackParam("eqHPFHz", "HPF", 0, 0, 500, 0, "Hz", "graphicEq"),
      makeFallbackParam("eq65Db", "65 Hz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eq125Db", "125 Hz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eq250Db", "250 Hz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eq500Db", "500 Hz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eq1kDb", "1 kHz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eq2kDb", "2 kHz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eq4kDb", "4 kHz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eq8kDb", "8 kHz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eq16kDb", "16 kHz", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eqLPFHz", "LPF", 24000, 3000, 24000, 24000, "Hz", "graphicEq"),
      makeFallbackParam("eqLevelDb", "Level", 0, -12, 12, 0, "dB", "graphicEq"),
      makeFallbackParam("eqEnabled", "EQ Power", 0, 0, 1, 0, "", "graphicEq", "toggle"),
      makeFallbackParam("cabEnabled", "Cab/IR", 0, 0, 1, 0, "", "cab", "toggle"),
      makeFallbackParam("cabLevelDb", "Cab Level", 0, -24, 12, 0, "dB", "cab"),
      makeFallbackParam("cabHPFHz", "Cab HPF", 80, 20, 500, 80, "Hz", "cab"),
      makeFallbackParam("cabLPFHz", "Cab LPF", 8500, 1000, 20000, 8500, "Hz", "cab"),
      makeFallbackParam("cabPhaseInvert", "Phase", 0, 0, 1, 0, "", "cab", "toggle"),
      makeFallbackParam("chorusMix", "Chorus", 0, 0, 1, 0, "", "modulation"),
      makeFallbackParam("chorusRateHz", "Chorus Rate", 0.75, 0.01, 8, 0.75, "Hz", "modulation"),
      makeFallbackParam("chorusDepth", "Chorus Depth", 0.32, 0, 1, 0.32, "", "modulation"),
      makeFallbackParam("delayMix", "Delay", 0.22, 0, 1, 0.22, "", "time"),
      makeFallbackParam("delayTimeMs", "Delay Time", 360, 1, 2000, 360, "ms", "time"),
      makeFallbackParam("delayFeedback", "Delay Fdbk", 0.22, 0, 0.85, 0.22, "", "time"),
      makeFallbackParam("delayMod", "Delay Mod", 0.18, 0, 1, 0.18, "", "time"),
      makeFallbackParam("delayDucker", "Ducker", 0.12, 0, 1, 0.12, "", "time"),
      makeFallbackParam("delayMode", "Delay Mode", 1, 0, 4, 1, "", "time", "enum", [
        { value: 0, label: "Digital" },
        { value: 1, label: "Tape" },
        { value: 2, label: "Analog" },
        { value: 3, label: "Multi" },
        { value: 4, label: "Dual" },
      ]),
      makeFallbackParam("delayPingPong", "Ping Pong", 1, 0, 1, 1, "", "time", "toggle"),
      makeFallbackParam("delayTempoSync", "Delay Sync", 0, 0, 1, 0, "", "time", "toggle"),
      makeFallbackParam("delayEnabled", "Delay Engage", 0, 0, 1, 0, "", "time", "toggle"),
      makeFallbackParam("reverbVoice", "Reverb Voice", 0, 0, 3, 0, "", "space", "enum", [
        { value: 0, label: "Studio" },
        { value: 1, label: "Plate" },
        { value: 2, label: "Hall" },
        { value: 3, label: "Room" },
      ]),
      makeFallbackParam("reverbEnabled", "Reverb Engage", 0, 0, 1, 0, "", "space", "toggle"),
      makeFallbackParam("reverbMix", "Reverb", 0.28, 0, 1, 0.28, "", "space"),
      makeFallbackParam("reverbDecaySec", "Decay", 2.2, 0.2, 12, 2.2, "s", "space"),
      makeFallbackParam("reverbPreDelayMs", "Pre Delay", 18, 0, 500, 18, "ms", "space"),
      makeFallbackParam("reverbLowCutHz", "Low Cut", 120, 20, 500, 120, "Hz", "space"),
      makeFallbackParam("reverbTone", "Verb Tone", 0.62, 0, 1, 0.62, "", "space"),
      makeFallbackParam("reverbShimmer", "Shimmer", 0, 0, 1, 0, "", "space"),
      makeFallbackParam("reverbPad", "Pad", 0, 0, 1, 0, "", "space", "toggle"),
      makeFallbackParam("outputTrimDb", "Output", 0, -24, 24, 0, "dB", "gain"),
    ],
    modelState: {
      pedalModelPath: "",
      ampModelPath: "",
      cabIRPath: "",
      hasPedalModel: false,
      hasAmpModel: false,
      hasSlimmableNAMModel: false,
      hasCabIR: false,
      namEffectsDspVersion: 19,
      lastLoadError: "",
    },
    visualization: {
      gainReductionDb: 0,
      inputLevelDb: -90,
      outputLevelDb: -90,
    },
  };
}

function isUsableSchema(schema: BuiltInPluginSchema | null | undefined) {
  return Boolean(schema && Array.isArray(schema.parameters) && schema.parameters.length > 0);
}

function valuesClose(param: BuiltInParamDescriptor, value: number) {
  if (isChorusRateParam(param) || isNAMGraphicEqFilterParam(param)) {
    return Math.abs(normalize(param) - normalizeParamValue(param, value)) <= 1 / 1000;
  }
  return Math.abs(param.value - value) <= Math.max(stepForParam(param), 0.0001) * 0.5;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId);
  });
}

export function createSchemaRequestGate() {
  let latestRequestId = 0;
  return {
    begin() {
      latestRequestId += 1;
      return latestRequestId;
    },
    isLatest(requestId: number) {
      return requestId === latestRequestId;
    },
    invalidate() {
      latestRequestId += 1;
    },
  };
}

type FailedParamWriteResolution = {
  matched: boolean;
  rollbackValue?: number;
};

/**
 * Keeps local parameter feedback responsive without treating that optimistic
 * value as native truth. Native schemas are remembered separately so a failed
 * write can restore the last value actually observed from the processor.
 */
export function createParamWriteReconciler(initialNativeSchema?: BuiltInPluginSchema | null) {
  let optimisticValues: Record<string, number> = {};
  let confirmedValues: Record<string, number> = {};
  let preWriteValues: Record<string, number> = {};

  const rememberNativeSchema = (nextSchema: BuiltInPluginSchema | null | undefined) => {
    if (!isUsableSchema(nextSchema)) return;
    const nextConfirmed = { ...confirmedValues };
    for (const param of nextSchema!.parameters) {
      if (Number.isFinite(param.value)) nextConfirmed[param.id] = param.value;
    }
    confirmedValues = nextConfirmed;
  };

  const clearOptimisticValue = (paramId: string) => {
    const { [paramId]: _optimistic, ...remainingOptimistic } = optimisticValues;
    const { [paramId]: _preWrite, ...remainingPreWrite } = preWriteValues;
    optimisticValues = remainingOptimistic;
    preWriteValues = remainingPreWrite;
  };

  const overlayOptimisticValues = (
    nextSchema: BuiltInPluginSchema | null | undefined,
    confirmMatchingValues: boolean,
  ) => {
    if (!nextSchema || !isUsableSchema(nextSchema)) return nextSchema ?? null;
    if (Object.keys(optimisticValues).length === 0) return nextSchema;

    let schemaChanged = false;
    const parameters = nextSchema.parameters.map((entry) => {
      const optimisticValue = optimisticValues[entry.id];
      if (typeof optimisticValue !== "number" || !Number.isFinite(optimisticValue)) return entry;
      const value = entry.type === "toggle"
        ? (optimisticValue >= 0.5 ? 1 : 0)
        : clamp(optimisticValue, entry.min, entry.max);

      if (valuesClose(entry, value)) {
        // Only a real native response may confirm an optimistic value. A boot
        // or cached schema can already contain the local value after setState.
        if (confirmMatchingValues) clearOptimisticValue(entry.id);
        return entry;
      }

      schemaChanged = true;
      return { ...entry, value };
    });

    return schemaChanged ? { ...nextSchema, parameters } : nextSchema;
  };

  rememberNativeSchema(initialNativeSchema);

  return {
    beginOptimisticWrite(paramId: string, value: number, previousDisplayedValue?: number) {
      if (
        optimisticValues[paramId] === undefined
        && typeof previousDisplayedValue === "number"
        && Number.isFinite(previousDisplayedValue)
      ) {
        preWriteValues = { ...preWriteValues, [paramId]: previousDisplayedValue };
      }
      optimisticValues = { ...optimisticValues, [paramId]: value };
    },

    applyToFallbackSchema(nextSchema: BuiltInPluginSchema | null | undefined) {
      return overlayOptimisticValues(nextSchema, false);
    },

    acceptNativeSchema(nextSchema: BuiltInPluginSchema | null | undefined) {
      rememberNativeSchema(nextSchema);
      return overlayOptimisticValues(nextSchema, true);
    },

    resolveSuccessfulWrite(paramId: string, value: number) {
      confirmedValues = { ...confirmedValues, [paramId]: value };
      if (!Object.is(optimisticValues[paramId], value)) return false;
      clearOptimisticValue(paramId);
      return true;
    },

    resolveFailedWrite(paramId: string, value: number): FailedParamWriteResolution {
      if (!Object.is(optimisticValues[paramId], value)) return { matched: false };
      const confirmedValue = confirmedValues[paramId];
      const preWriteValue = preWriteValues[paramId];
      clearOptimisticValue(paramId);
      const rollbackValue = Number.isFinite(confirmedValue) ? confirmedValue : preWriteValue;
      return Number.isFinite(rollbackValue)
        ? { matched: true, rollbackValue }
        : { matched: true };
    },
  };
}

export function shouldReadBackAfterParamWrite(
  currentSchema: BuiltInPluginSchema | null | undefined,
  paramId: string,
) {
  const type = currentSchema?.parameters.find((param) => param.id === paramId)?.type;
  return type === "toggle" || type === "enum";
}

type FrameCoalescedParamWriterOptions = {
  write: (paramId: string, value: number) => Promise<boolean>;
  onSuccess?: (paramId: string, value: number) => void;
  onFailure?: (paramId: string, value: number, error?: unknown) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (frameId: number) => void;
};

type PendingParamWrite = {
  pendingValue?: number;
  inFlightValue?: number;
  frameId: number | null;
};

export function createFrameCoalescedParamWriter({
  write,
  onSuccess,
  onFailure,
  requestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame = (frameId) => window.cancelAnimationFrame(frameId),
}: FrameCoalescedParamWriterOptions) {
  const writes = new Map<string, PendingParamWrite>();
  const flushWaiters = new Set<{
    failureCount: number;
    resolve: (ok: boolean) => void;
  }>();
  let acceptingWrites = true;
  let terminalFailureCount = 0;

  const entryFor = (paramId: string) => {
    const existing = writes.get(paramId);
    if (existing) return existing;
    const entry: PendingParamWrite = { frameId: null };
    writes.set(paramId, entry);
    return entry;
  };

  const hasOutstandingWrites = () => Array.from(writes.values()).some(
    (entry) => entry.frameId !== null
      || entry.pendingValue !== undefined
      || entry.inFlightValue !== undefined,
  );

  const resolveFlushWaitersIfIdle = () => {
    if (hasOutstandingWrites()) return;
    for (const waiter of flushWaiters) {
      waiter.resolve(terminalFailureCount === waiter.failureCount);
    }
    flushWaiters.clear();
  };

  const dispatch = async (paramId: string, entry: PendingParamWrite) => {
    if (entry.inFlightValue !== undefined || entry.pendingValue === undefined) return;
    const value = entry.pendingValue;
    entry.pendingValue = undefined;
    entry.inFlightValue = value;

    let ok = false;
    let writeError: unknown;
    try {
      ok = await write(paramId, value);
    } catch (error) {
      writeError = error;
    }

    entry.inFlightValue = undefined;
    if (ok) {
      // Repeated pointer events may have queued the same quantized value while
      // this write was in flight. The completed write already delivered it.
      if (entry.pendingValue !== undefined && Object.is(entry.pendingValue, value)) {
        entry.pendingValue = undefined;
      }
      onSuccess?.(paramId, value);
    } else if (entry.pendingValue === undefined && acceptingWrites) {
      // Recover only when the failed value is still the trailing value. A newer
      // pending value should get its chance to reach the processor first.
      terminalFailureCount += 1;
      onFailure?.(paramId, value, writeError);
    }

    if (entry.pendingValue !== undefined) {
      if (acceptingWrites) schedule(paramId, entry);
      else void dispatch(paramId, entry);
    }
    resolveFlushWaitersIfIdle();
  };

  const schedule = (paramId: string, entry: PendingParamWrite) => {
    if (
      !acceptingWrites
      || entry.frameId !== null
      || entry.inFlightValue !== undefined
      || entry.pendingValue === undefined
    ) {
      return;
    }
    if (flushWaiters.size > 0) {
      void dispatch(paramId, entry);
      return;
    }
    entry.frameId = requestFrame(() => {
      entry.frameId = null;
      void dispatch(paramId, entry);
    });
  };

  const queueValue = (paramId: string, value: number, dispatchNow: boolean) => {
    if (!acceptingWrites) return;
    const entry = entryFor(paramId);
    if (entry.pendingValue !== undefined && Object.is(entry.pendingValue, value)) return;
    // Do not suppress a value merely because this editor wrote it previously.
    // Preset recall, A/B compare, project restore, and automation can all change
    // the native parameter without passing through this writer. Treating the
    // last successful UI write as authoritative made the first toggle after a
    // preset recall update only the optimistic UI while leaving the DSP in its
    // recalled state.
    entry.pendingValue = value;
    if (dispatchNow && entry.frameId !== null) {
      cancelFrame(entry.frameId);
      entry.frameId = null;
    }
    if (dispatchNow) void dispatch(paramId, entry);
    else schedule(paramId, entry);
  };

  return {
    enqueue(paramId: string, value: number) {
      queueValue(paramId, value, false);
    },
    writeImmediately(paramId: string, value: number) {
      queueValue(paramId, value, true);
    },
    flush(): Promise<boolean> {
      if (!acceptingWrites) return Promise.resolve(false);
      const failureCount = terminalFailureCount;
      return new Promise<boolean>((resolve) => {
        flushWaiters.add({ failureCount, resolve });
        for (const [paramId, entry] of writes) {
          if (entry.frameId !== null) {
            cancelFrame(entry.frameId);
            entry.frameId = null;
          }
          if (entry.pendingValue !== undefined && entry.inFlightValue === undefined) {
            void dispatch(paramId, entry);
          }
        }
        resolveFlushWaitersIfIdle();
      });
    },
    dispose(flushPending = true) {
      acceptingWrites = false;
      for (const [paramId, entry] of writes) {
        if (entry.frameId !== null) {
          cancelFrame(entry.frameId);
          entry.frameId = null;
        }
        if (flushPending && entry.pendingValue !== undefined && entry.inFlightValue === undefined) {
          void dispatch(paramId, entry);
        } else if (!flushPending) {
          entry.pendingValue = undefined;
        }
      }
      resolveFlushWaitersIfIdle();
    },
  };
}

type BuiltInPluginKind =
  | "eq"
  | "dynamics"
  | "delay"
  | "reverb"
  | "modulation"
  | "saturation"
  | "pitch"
  | "nam"
  | "synth"
  | "piano"
  | "guitar"
  | "drums"
  | "generic";

export function getPluginKind(schema: BuiltInPluginSchema | null): BuiltInPluginKind {
  const label = `${schema?.category ?? ""} ${schema?.name ?? ""}`.toLowerCase();
  if (label.includes("eq")) return "eq";
  if (label.includes("compressor") || label.includes("gate") || label.includes("limiter") || label.includes("dynamics")) return "dynamics";
  if (label.includes("delay")) return "delay";
  if (label.includes("reverb")) return "reverb";
  if (label.includes("chorus") || label.includes("flanger") || label.includes("phaser") || label.includes("modulation")) return "modulation";
  if (label.includes("saturat")) return "saturation";
  if (label.includes("pitch")) return "pitch";
  if (label.includes("nam")) return "nam";
  if (label.includes("guitar")) return "guitar";
  if (label.includes("piano")) return "piano";
  if (label.includes("drum")) return "drums";
  if (label.includes("synth") || label.includes("sampler")) return "synth";
  return "generic";
}

export function primaryParamIdsForKind(kind: BuiltInPluginKind, schema: BuiltInPluginSchema | null) {
  const name = schema?.name.toLowerCase() ?? "";
  if (kind === "eq") return ["outputGain", "autoGain", "stereoMode", "auditionBand"];
  if (kind === "delay") return ["delayTimeL", "delayTimeR", "feedback", "mix", "ducking"];
  if (kind === "reverb") return ["algorithm", "roomSize", "decayTime", "wetLevel", "dryLevel"];
  if (kind === "modulation") return ["mode", "rate", "depth", "mix", "characterMode"];
  if (kind === "saturation") return ["satType", "drive", "mix", "outputGain", "oversampleMode"];
  if (kind === "pitch") return ["key", "scale", "retuneSpeed", "correctionStrength", "mix"];
  if (kind === "nam") return ["inputTrimDb", "gateThresholdDb", "cabEnabled", "chorusMix", "delayMix", "reverbMix", "outputTrimDb"];
  if (kind === "piano") return ["model", "tone", "body", "resonance", "outputGain"];
  if (kind === "guitar") return ["model", "tone", "body", "bendRangeSemitones", "outputGain"];
  if (kind === "drums") return ["kit", "mapPreset", "punch", "ambience", "outputGain"];
  if (kind === "synth") return ["brightness", "detuneCents", "subLevel", "noiseLevel", "outputGain"];
  if (kind === "dynamics" && name.includes("limiter")) return ["threshold", "ceiling", "lookaheadMs", "releaseMs"];
  if (kind === "dynamics" && name.includes("gate")) return ["threshold", "range", "attackMs", "releaseMs", "detectorMode"];
  if (kind === "dynamics") return ["threshold", "ratio", "attack", "release", "autoMakeup"];
  return [];
}

export function groupLabel(group: string) {
  const labels: Record<string, string> = {
    body: "Body",
    character: "Character",
    correction: "Correction",
    detection: "Detection",
    drive: "Drive",
    drums: "Kit",
    dynamic: "Dynamic Bands",
    dynamics: "Dynamics",
    envelope: "Envelope",
    eqBand: "Bands",
    feedback: "Feedback",
    formant: "Formants",
    instrument: "Instrument",
    midi: "MIDI",
    mix: "Mix",
    model: "Models",
    modulation: "Modulation",
    oscillator: "Oscillators",
    output: "Output",
    piano: "Piano",
    quality: "Quality",
    routing: "Routing",
    scale: "Scale",
    sidechain: "Sidechain",
    space: "Space",
    time: "Timing",
    tone: "Tone",
    width: "Stereo",
  };
  return labels[group] ?? group;
}

export function groupSortWeight(kind: BuiltInPluginKind, group: string) {
  const orderByKind: Record<BuiltInPluginKind, string[]> = {
    eq: ["eqBand", "dynamic", "routing", "output"],
    dynamics: ["dynamics", "detection", "sidechain", "character", "mix", "output"],
    delay: ["time", "feedback", "dynamics", "tone", "character", "width", "mix"],
    reverb: ["space", "time", "tone", "width", "mix"],
    modulation: ["modulation", "feedback", "character", "tone", "width", "mix"],
    saturation: ["drive", "character", "tone", "quality", "mix", "output"],
    pitch: ["scale", "correction", "detection", "formant", "midi", "mix"],
    nam: ["model", "gain", "dynamics", "cab", "tone", "modulation", "time", "space"],
    synth: ["oscillator", "tone", "envelope", "output"],
    piano: ["character", "tone", "body", "width", "envelope", "output"],
    guitar: ["character", "tone", "body", "midi", "space", "envelope", "output"],
    drums: ["drums", "character", "space", "width", "output"],
    generic: ["controls", "output"],
  };
  const order = orderByKind[kind] ?? orderByKind.generic;
  const index = order.indexOf(group);
  return index === -1 ? 100 : index;
}

export function BuiltInParamControl({
  param,
  onChange,
  compact = false,
}: {
  param: BuiltInParamDescriptor;
  onChange: (param: BuiltInParamDescriptor, value: number) => void;
  compact?: boolean;
}) {
  const pct = normalize(param);
  const style = { "--knob-pct": `${pct * 100}%` } as CSSProperties;

  if (param.type === "enum") {
    return (
      <label className="builtin-control builtin-control-enum" title={param.label}>
        <span className="builtin-control-label">{param.label}</span>
        <select
          value={Math.round(param.value)}
          onChange={(event) => onChange(param, Number(event.currentTarget.value))}
        >
          {(param.enumOptions ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === "toggle") {
    const active = param.value >= 0.5;
    return (
      <button
        type="button"
        className="builtin-control builtin-control-toggle"
        data-active={active}
        onClick={() => onChange(param, active ? 0 : 1)}
        aria-pressed={active}
        title={param.label}
      >
        <span className="builtin-control-label">{param.label}</span>
        <span className="builtin-switch" aria-hidden="true" />
      </button>
    );
  }

  return (
    <label className="builtin-control builtin-control-continuous" data-compact={compact} style={style} title={param.label}>
      <span className="builtin-knob" aria-hidden="true" />
      <span className="builtin-control-main">
        <span className="builtin-control-topline">
          <span className="builtin-control-label">{param.label}</span>
          <span className="builtin-param-value">{formatParamValue(param)}</span>
        </span>
        <ProfiledRangeInput
          min={rangeInputMin(param)}
          max={rangeInputMax(param)}
          step={rangeInputStep(param)}
          value={rangeInputValue(param)}
          onValueChange={(value) => onChange(
            param,
            paramValueFromRangeInput(param, value),
          )}
        />
      </span>
    </label>
  );
}

function BuiltInVisualization({
  schema,
  onParamChange,
}: {
  schema: BuiltInPluginSchema;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const params = schema.parameters;
  const category = `${schema.category} ${schema.name}`.toLowerCase();
  const width = 360;
  const height = 126;
  const [dynamicsHistory, setDynamicsHistory] = useState<number[]>(() => Array(56).fill(0));
  const gainReductionDb = schema.visualization?.gainReductionDb;

  useEffect(() => {
    setDynamicsHistory(Array(56).fill(0));
  }, [schema.chain, schema.fxIndex, schema.name]);

  useEffect(() => {
    if (typeof gainReductionDb !== "number" || !Number.isFinite(gainReductionDb)) return;
    setDynamicsHistory((history) => [...history.slice(1), clamp(Math.abs(gainReductionDb), 0, 36)]);
  }, [gainReductionDb]);

  if (category.includes("eq")) {
    const nodes: GraphNode[] = [];
    const dynamicGains = schema.visualization?.dynamicGainDb ?? [];
    for (let band = 0; band < 8; band += 1) {
      const enabled = (getParam(params, `band${band}.enabled`)?.value ?? 0) >= 0.5;
      const freq = getParam(params, `band${band}.freq`)?.value ?? 1000;
      const gain = getParam(params, `band${band}.gain`)?.value ?? 0;
      const dynamicValue = dynamicGains[band] ?? 0;
      nodes.push({
        id: `band-${band}`,
        x: freq,
        y: gain,
        z: getParam(params, `band${band}.q`)?.value ?? 1,
        enabled,
        label: `Band ${band + 1}`,
        color: Math.abs(dynamicValue) > 0.05 ? "#fbbf24" : undefined,
      });
    }
    const frequencies = schema.visualization?.frequencies ?? [];
    const responseCurve = schema.visualization?.responseDb?.map((value, index) => ({
      x: frequencies[index] ?? 20,
      y: clamp(value, -24, 24),
    }));
    const spectrumToGraphPoints = (values: number[] | undefined) =>
      values?.map((value, index) => ({
        x: frequencies[index] ?? 20,
        y: clamp(((value + 90) / 78) * 48 - 24, -24, 24),
      })) ?? [];
    const backgroundCurves = schema.visualization?.spectrumReady
      ? [
          {
            id: "spectrum-pre",
            points: spectrumToGraphPoints(schema.visualization.spectrumPreDb),
            color: "rgba(148, 163, 184, 0.72)",
            opacity: 0.42,
            strokeWidth: 1,
          },
          {
            id: "spectrum-post",
            points: spectrumToGraphPoints(schema.visualization.spectrumPostDb),
            color: "rgba(34, 197, 94, 0.76)",
            opacity: 0.58,
            strokeWidth: 1.15,
          },
        ]
      : [];
    const xAxis: GraphAxis = {
      label: "Frequency",
      min: 20,
      max: 20000,
      scale: "log",
      unit: "Hz",
      gridLines: [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000],
    };
    const yAxis: GraphAxis = {
      label: "Gain",
      min: -24,
      max: 24,
      scale: "linear",
      unit: "dB",
      gridLines: [-24, -12, 0, 12, 24],
    };
    const nodeConfig: GraphNodeConfig = {
      maxNodes: 8,
      zAxis: {
        label: "Q",
        min: 0.1,
        max: 30,
        default: 1,
        sensitivity: 0.01,
      },
    };
    return (
      <ParametricGraph
        width={width}
        height={height}
        xAxis={xAxis}
        yAxis={yAxis}
        nodes={nodes}
        nodeConfig={nodeConfig}
        responseCurve={responseCurve}
        backgroundCurves={backgroundCurves}
        className="builtin-visual builtin-eq-visual"
        onNodeChange={(id, changes) => {
          const band = Number(id.replace("band-", ""));
          if (!Number.isFinite(band)) return;
          const enabledParam = getParam(params, `band${band}.enabled`);
          const freqParam = getParam(params, `band${band}.freq`);
          const gainParam = getParam(params, `band${band}.gain`);
          const qParam = getParam(params, `band${band}.q`);
          if (enabledParam && enabledParam.value < 0.5) onParamChange(enabledParam, 1);
          if (freqParam && changes.x !== undefined) onParamChange(freqParam, changes.x);
          if (gainParam && changes.y !== undefined) onParamChange(gainParam, changes.y);
          if (qParam && changes.z !== undefined) onParamChange(qParam, changes.z);
        }}
      />
    );
  }

  if (category.includes("dynamics") || category.includes("compressor") || category.includes("gate") || category.includes("limiter")) {
    const threshold = normalize(getParam(params, "threshold") ?? { value: -18, min: -60, max: 0 } as BuiltInParamDescriptor);
    const ratio = normalize(getParam(params, "ratio") ?? { value: 4, min: 1, max: 20 } as BuiltInParamDescriptor);
    const knee = normalize(getParam(params, "knee") ?? { value: 0, min: 0, max: 24 } as BuiltInParamDescriptor);
    const x = threshold * width;
    const y = height - threshold * height;
    const endY = clamp(y - (1 - ratio) * height * 0.38 + knee * 8, 12, height - 10);
    const currentGr = clamp(Math.abs(gainReductionDb ?? 0), 0, 36);
    const inputLevel = clamp(schema.visualization?.inputLevelDb ?? -90, -90, 6);
    const outputLevel = clamp(schema.visualization?.outputLevelDb ?? -90, -90, 6);
    const levelY = (db: number) => height - 12 - clamp((db + 90) / 96, 0, 1) * (height - 22);
    const historyPoints = dynamicsHistory
      .map((value, index) => {
        const hx = 8 + (index / Math.max(1, dynamicsHistory.length - 1)) * (width - 86);
        const hy = height - 10 - (value / 36) * (height - 26);
        return `${hx},${hy}`;
      })
      .join(" ");
    return (
      <svg className="builtin-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} dynamics curve`}>
        <rect width={width} height={height} rx="6" />
        <polyline className="builtin-dynamics-curve" points={`0,${height - 12} ${x},${y} ${width - 70},${endY}`} />
        <polyline className="builtin-dynamics-history" points={historyPoints} />
        <rect className="builtin-dynamics-meter" x={width - 56} y={levelY(inputLevel)} width="8" height={height - 12 - levelY(inputLevel)} />
        <rect className="builtin-dynamics-meter" x={width - 42} y={levelY(outputLevel)} width="8" height={height - 12 - levelY(outputLevel)} />
        <rect className="builtin-dynamics-gr" x={width - 24} y={10} width="10" height={(currentGr / 36) * (height - 20)} />
        {typeof schema.visualization?.gateOpen === "boolean" && (
          <circle className="builtin-dynamics-status" cx={width - 19} cy={height - 13} r="4" data-active={schema.visualization.gateOpen} />
        )}
        <circle cx={x} cy={y} r="4.5" data-active="true" />
      </svg>
    );
  }

  if (category.includes("saturation")) {
    const drive = normalize(getParam(params, "drive") ?? { value: 6, min: 0, max: 30 } as BuiltInParamDescriptor);
    const bias = getParam(params, "asymmetry")?.value ?? 0;
    const curve = Array.from({ length: 44 }, (_, index) => {
      const xNorm = (index / 43) * 2 - 1;
      const yNorm = Math.tanh(xNorm * (1.2 + drive * 5) + bias * 0.4);
      const x = (index / 43) * width;
      const y = height * 0.5 - yNorm * height * 0.38;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg className="builtin-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} saturation curve`}>
        <rect width={width} height={height} rx="6" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
        <polyline points={curve} />
      </svg>
    );
  }

  if (category.includes("pitch")) {
    const detected = schema.visualization?.historyDetectedMidi ?? [];
    const corrected = schema.visualization?.historyCorrectedMidi ?? [];
    const confidence = schema.visualization?.historyConfidence ?? [];
    const pitchPoints = (values: number[]) =>
      values
        .map((value, index) => {
          const x = (index / Math.max(1, values.length - 1)) * width;
          const y = height - clamp((value - 36) / 48, 0, 1) * height;
          return `${x},${y}`;
        })
        .join(" ");
    const confidenceBars = confidence.filter((value) => value > 0.01).slice(-28);
    return (
      <svg className="builtin-visual builtin-pitch-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} pitch trace`}>
        <rect width={width} height={height} rx="6" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
        {confidenceBars.map((value, index) => {
          const barWidth = 4;
          const x = width - 124 + index * barWidth;
          return <rect key={index} className="builtin-pitch-confidence" x={x} y={height - 8 - value * 46} width="2.5" height={4 + value * 46} rx="1" />;
        })}
        <polyline className="builtin-pitch-detected" points={pitchPoints(detected)} />
        <polyline className="builtin-pitch-corrected" points={pitchPoints(corrected)} />
        <circle
          className="builtin-pitch-note"
          cx={width - 28}
          cy={height - clamp(((schema.visualization?.correctedHz ?? 0) > 0 ? 0.72 : 0.22), 0, 1) * height}
          r="5"
          data-active={(schema.visualization?.confidence ?? 0) > 0.2}
        />
      </svg>
    );
  }

  if (category.includes("delay")) {
    const delayL = normalize(getParam(params, "delayTimeL") ?? { value: 250, min: 1, max: 2000 } as BuiltInParamDescriptor);
    const delayR = normalize(getParam(params, "delayTimeR") ?? { value: 250, min: 1, max: 2000 } as BuiltInParamDescriptor);
    const feedbackValue = normalize(getParam(params, "feedback") ?? { value: 0.4, min: 0, max: 0.95 } as BuiltInParamDescriptor);
    const mixValue = normalize(getParam(params, "mix") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const tapL = 38 + delayL * 230;
    const tapR = 54 + delayR * 230;
    const repeats = Array.from({ length: 5 }, (_, index) => ({
      x: 54 + index * 58,
      y: height * 0.5 + Math.sin(index * 1.2) * 24 * mixValue,
      r: 5 + feedbackValue * 9 * Math.pow(0.72, index),
      opacity: 0.35 + feedbackValue * Math.pow(0.72, index) * 0.55,
    }));
    return (
      <svg className="builtin-visual builtin-delay-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} taps`}>
        <rect width={width} height={height} rx="6" />
        <line x1="28" y1={height / 2} x2={width - 28} y2={height / 2} />
        <path className="builtin-delay-feedback" d={`M ${tapL} ${height / 2 - 24} C ${width / 2} ${12 + feedbackValue * 12}, ${tapR} ${height / 2 - 24}, ${tapR} ${height / 2}`} />
        {repeats.map((repeat, index) => (
          <circle key={index} className="builtin-delay-repeat" cx={repeat.x} cy={repeat.y} r={repeat.r} style={{ opacity: repeat.opacity }} />
        ))}
        <circle className="builtin-delay-tap" cx={tapL} cy={height / 2 - 16} r="6" data-active="true" />
        <circle className="builtin-delay-tap" cx={tapR} cy={height / 2 + 16} r="6" data-active="true" />
      </svg>
    );
  }

  if (category.includes("reverb")) {
    const decayValue = normalize(getParam(params, "decayTime") ?? { value: 2, min: 0.1, max: 20 } as BuiltInParamDescriptor);
    const sizeValue = normalize(getParam(params, "roomSize") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const dampingValue = normalize(getParam(params, "damping") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const widthValue = normalize(getParam(params, "width") ?? { value: 1, min: 0, max: 1 } as BuiltInParamDescriptor);
    const tail = Array.from({ length: 72 }, (_, index) => {
      const t = index / 71;
      const envelope = Math.exp(-t * (2.2 - decayValue * 1.45));
      const ripple = Math.sin(t * Math.PI * (8 + sizeValue * 12)) * (1 - dampingValue * 0.65);
      const x = t * width;
      const y = height * 0.5 - envelope * ripple * height * 0.32;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg className="builtin-visual builtin-reverb-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} tail`}>
        <rect width={width} height={height} rx="6" />
        <ellipse className="builtin-reverb-space" cx={width / 2} cy={height / 2} rx={60 + sizeValue * 118} ry={22 + widthValue * 28} />
        <polyline className="builtin-reverb-tail" points={tail} />
        <line x1="24" y1={height / 2} x2={width - 24} y2={height / 2} />
      </svg>
    );
  }

  if (category.includes("modulation") || category.includes("chorus") || category.includes("flanger") || category.includes("phaser")) {
    const depthValue = normalize(getParam(params, "depth") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const spreadValue = normalize(getParam(params, "spread") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const feedbackValue = normalize(getParam(params, "fbAmount") ?? { value: 0, min: -1, max: 1 } as BuiltInParamDescriptor);
    const waveA = Array.from({ length: 80 }, (_, index) => {
      const t = index / 79;
      const x = t * width;
      const y = height * 0.5 + Math.sin(t * Math.PI * 4) * depthValue * height * 0.32;
      return `${x},${y}`;
    }).join(" ");
    const waveB = Array.from({ length: 80 }, (_, index) => {
      const t = index / 79;
      const x = t * width;
      const y = height * 0.5 + Math.sin(t * Math.PI * 4 + spreadValue * Math.PI) * depthValue * height * 0.26;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg className="builtin-visual builtin-mod-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} modulation`}>
        <rect width={width} height={height} rx="6" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
        <polyline className="builtin-mod-wave-a" points={waveA} />
        <polyline className="builtin-mod-wave-b" points={waveB} />
        <circle className="builtin-mod-feedback" cx={width - 28} cy={height - 18 - feedbackValue * 72} r="7" data-active={feedbackValue > 0.52} />
      </svg>
    );
  }

  if (category.includes("synth")) {
    const brightness = normalize(getParam(params, "brightness") ?? { value: 0.62, min: 0, max: 1 } as BuiltInParamDescriptor);
    const sub = normalize(getParam(params, "subLevel") ?? { value: 0.18, min: 0, max: 0.8 } as BuiltInParamDescriptor);
    const noise = normalize(getParam(params, "noiseLevel") ?? { value: 0.015, min: 0, max: 0.25 } as BuiltInParamDescriptor);
    const wave = Array.from({ length: 64 }, (_, index) => {
      const phase = index / 63;
      const saw = phase * 2 - 1;
      const square = phase < 0.5 ? 1 : -1;
      const yNorm = saw * (0.5 + brightness * 0.2) + square * brightness * 0.18 + Math.sin(phase * Math.PI * 2) * sub * 0.26;
      const x = phase * width;
      const y = height * 0.5 - yNorm * height * 0.34;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg className="builtin-visual builtin-instrument-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} oscillator`}>
        <rect width={width} height={height} rx="6" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
        <polyline className="builtin-instrument-primary" points={wave} />
        <rect className="builtin-instrument-accent" x="18" y={height - 18 - noise * 54} width="22" height={8 + noise * 54} rx="3" />
        <rect className="builtin-instrument-accent" x="48" y={height - 18 - sub * 54} width="22" height={8 + sub * 54} rx="3" />
      </svg>
    );
  }

  if (category.includes("piano")) {
    const toneValue = normalize(getParam(params, "tone") ?? { value: 0.58, min: 0, max: 1 } as BuiltInParamDescriptor);
    const bodyValue = normalize(getParam(params, "body") ?? { value: 0.72, min: 0, max: 1 } as BuiltInParamDescriptor);
    const resonanceValue = normalize(getParam(params, "resonance") ?? { value: 0.38, min: 0, max: 1 } as BuiltInParamDescriptor);
    const harmonics = [1, 2.003, 3.011, 5.031, 1.497].map((ratio, index) => {
      const value = [bodyValue, toneValue * 0.72, toneValue * 0.52, toneValue * 0.34, resonanceValue * 0.64][index];
      return { ratio, value };
    });
    return (
      <svg className="builtin-visual builtin-instrument-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} resonance`}>
        <rect width={width} height={height} rx="6" />
        {Array.from({ length: 18 }, (_, index) => (
          <rect key={index} className="builtin-piano-key" x={12 + index * 18} y="82" width="15" height="34" rx="2" data-active={index % 7 === 1 || index % 7 === 4} />
        ))}
        {harmonics.map((harmonic, index) => (
          <rect
            key={harmonic.ratio}
            className="builtin-instrument-accent"
            x={42 + index * 50}
            y={70 - harmonic.value * 44}
            width="18"
            height={10 + harmonic.value * 44}
            rx="4"
          />
        ))}
        <polyline className="builtin-instrument-primary" points={`18,68 72,${52 - bodyValue * 18} 142,${58 - resonanceValue * 22} 236,${50 - toneValue * 18} 342,64`} />
      </svg>
    );
  }

  if (category.includes("drum")) {
    const punchValue = normalize(getParam(params, "punch") ?? { value: 0.55, min: 0, max: 1 } as BuiltInParamDescriptor);
    const roomValue = normalize(getParam(params, "ambience") ?? { value: 0.18, min: 0, max: 1 } as BuiltInParamDescriptor);
    const widthValue = normalize(getParam(params, "stereoWidth") ?? { value: 0.7, min: 0, max: 1 } as BuiltInParamDescriptor);
    const shells = [
      { x: 176, y: 70, r: 26 + punchValue * 8 },
      { x: 116 - widthValue * 22, y: 56, r: 18 },
      { x: 238 + widthValue * 22, y: 56, r: 18 },
      { x: 72 - widthValue * 28, y: 34, r: 13 + roomValue * 5 },
      { x: 288 + widthValue * 28, y: 34, r: 13 + roomValue * 5 },
    ];
    return (
      <svg className="builtin-visual builtin-instrument-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} kit`}>
        <rect width={width} height={height} rx="6" />
        <ellipse className="builtin-drum-room" cx={width / 2} cy="68" rx={118 + roomValue * 52} ry={34 + roomValue * 18} />
        {shells.map((shell, index) => (
          <circle key={index} className="builtin-drum-shell" cx={shell.x} cy={shell.y} r={shell.r} data-active={index === 0} />
        ))}
        <line x1={width / 2} y1="24" x2={width / 2} y2="110" />
      </svg>
    );
  }

  const bars = params.slice(0, 14);
  return (
    <svg className="builtin-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} controls`}>
      <rect width={width} height={height} rx="6" />
      {bars.map((param, index) => {
        const barWidth = width / Math.max(1, bars.length);
        const value = normalize(param);
        const barHeight = 16 + value * (height - 34);
        return (
          <rect
            key={param.id}
            x={index * barWidth + 5}
            y={height - barHeight - 8}
            width={Math.max(4, barWidth - 10)}
            height={barHeight}
            rx="3"
            data-active="true"
          />
        );
      })}
    </svg>
  );
}

export function BuiltInPluginPanel({
  address,
  fallbackName,
  onClose,
  initialSchema,
  shortcutSessionId,
}: BuiltInPluginPanelProps) {
  const bootSchema = useMemo(
    () => (isNAMPluginName(fallbackName) ? createNAMBootSchema(address, fallbackName) : null),
    [address, fallbackName],
  );
  const [schema, setSchema] = useState<BuiltInPluginSchema | null>(initialSchema ?? bootSchema);
  const [loading, setLoading] = useState(false);
  const paramWriteReconcilerRef = useRef<ReturnType<typeof createParamWriteReconciler> | null>(null);
  if (!paramWriteReconcilerRef.current) {
    paramWriteReconcilerRef.current = createParamWriteReconciler(initialSchema);
  }
  const schemaRequestGateRef = useRef(createSchemaRequestGate());
  const schemaRef = useRef(schema);
  const closeRef = useRef(onClose);
  schemaRef.current = schema;
  closeRef.current = onClose;
  const pluginShortcutSessionId = shortcutSessionId
    ?? `builtin:${address.chain}:${address.trackId ?? "master"}:${address.fxIndex ?? -1}`;

  useEffect(() => {
    const context = { kind: "plugin", sessionId: pluginShortcutSessionId } as const;
    const fallback = getActiveShortcutContext();
    const unregisterSurface = registerShortcutSurface(
      context,
      () => "unmatched",
      fallback,
    );
    const unregisterActions = registerScopedActionExecutor(
      context,
      (actionId) => {
        if (actionId !== "fx.close") return "unmatched";
        if (!closeRef.current) return "claimed_noop";
        closeRef.current();
        return "handled";
      },
      ["fx.close"],
    );
    if (windowRole !== "main") activateShortcutContext(context);
    return () => {
      unregisterActions();
      unregisterSurface();
    };
  }, [pluginShortcutSessionId]);

  const applyOptimisticParamValues = useCallback((nextSchema: BuiltInPluginSchema | null | undefined) => {
    return paramWriteReconcilerRef.current!.applyToFallbackSchema(nextSchema);
  }, []);

  const loadSchema = useCallback(async (showLoading = true) => {
    const requestId = schemaRequestGateRef.current.begin();
    if (showLoading) setLoading(true);
    try {
      const nextSchema = await withTimeout(nativeBridge.getBuiltInPluginSchema(address), 2500, "Built-in plugin schema");
      if (!schemaRequestGateRef.current.isLatest(requestId)) return null;

      const acceptedSchema = isUsableSchema(nextSchema)
        ? paramWriteReconcilerRef.current!.acceptNativeSchema(nextSchema)
        : bootSchema
          ? (isUsableSchema(schemaRef.current)
              ? applyOptimisticParamValues(schemaRef.current)
              : applyOptimisticParamValues(bootSchema))
          : applyOptimisticParamValues(nextSchema);
      schemaRef.current = acceptedSchema;
      setSchema(acceptedSchema);
      return acceptedSchema;
    } catch (error) {
      if (!schemaRequestGateRef.current.isLatest(requestId)) return null;
      console.error("[BuiltInPluginPanel] Failed to load schema:", error);
      const current = schemaRef.current;
      const acceptedSchema = isUsableSchema(current)
        ? applyOptimisticParamValues(current)
        : applyOptimisticParamValues(bootSchema ?? current ?? {
          schemaVersion: 1,
          name: fallbackName,
          category: "Built-in",
          chain: address.chain,
          fxIndex: address.fxIndex ?? -1,
          parameters: [],
        });
      schemaRef.current = acceptedSchema;
      setSchema(acceptedSchema);
      return acceptedSchema;
    } finally {
      if (showLoading && schemaRequestGateRef.current.isLatest(requestId)) setLoading(false);
    }
  }, [address, applyOptimisticParamValues, bootSchema, fallbackName]);

  const loadSchemaRef = useRef(loadSchema);
  loadSchemaRef.current = loadSchema;

  const applyLocalParamValue = useCallback((paramId: string, value: number) => {
    const current = schemaRef.current;
    if (!current) return;
    const currentParam = current.parameters.find((param) => param.id === paramId);
    if (!currentParam || Object.is(currentParam.value, value)) return;
    const nextSchema = {
      ...current,
      parameters: current.parameters.map((param) => (
        param.id === paramId ? { ...param, value } : param
      )),
    };
    schemaRef.current = nextSchema;
    setSchema(nextSchema);
  }, []);

  const recoverFailedParamWrite = useCallback((paramId: string, value: number, error?: unknown) => {
    if (error !== undefined) {
      console.error("[BuiltInPluginPanel] Failed to set built-in parameter:", error);
    }
    const resolution = paramWriteReconcilerRef.current!.resolveFailedWrite(paramId, value);
    if (!resolution.matched) return;
    if (resolution.rollbackValue !== undefined) {
      applyLocalParamValue(paramId, resolution.rollbackValue);
    }
    void loadSchemaRef.current(false);
  }, [applyLocalParamValue]);

  const confirmSuccessfulParamWrite = useCallback((paramId: string, value: number) => {
    paramWriteReconcilerRef.current!.resolveSuccessfulWrite(paramId, value);
    // NAM deliberately has no recurring full-schema poll. Discrete controls get
    // one readback after their acknowledged write so the UI follows automation,
    // preset recall, or a processor that resolved the requested value differently.
    if (shouldReadBackAfterParamWrite(schemaRef.current, paramId)) {
      void loadSchemaRef.current(false);
    }
  }, []);

  const writeAddress = useMemo<BuiltInPluginAddress>(
    () => ({
      chain: address.chain,
      trackId: address.trackId,
      fxIndex: address.fxIndex,
    }),
    [address.chain, address.fxIndex, address.trackId],
  );

  const paramWriter = useMemo(
    () => createFrameCoalescedParamWriter({
      write: (paramId, value) => nativeBridge.setBuiltInPluginParam(writeAddress, paramId, value),
      onSuccess: confirmSuccessfulParamWrite,
      onFailure: recoverFailedParamWrite,
    }),
    [confirmSuccessfulParamWrite, recoverFailedParamWrite, writeAddress],
  );

  useEffect(() => {
    if (initialSchema) {
      schemaRequestGateRef.current.invalidate();
      const acceptedSchema = paramWriteReconcilerRef.current!.acceptNativeSchema(initialSchema);
      schemaRef.current = acceptedSchema;
      setSchema(acceptedSchema);
      setLoading(false);
      return;
    }
    if (bootSchema) setSchema((current) => (isUsableSchema(current) ? current : bootSchema));
    void loadSchema();
  }, [bootSchema, initialSchema, loadSchema]);

  useEffect(() => {
    const pluginKind = `${schema?.category ?? ""} ${schema?.name ?? ""}`.toLowerCase();
    // NAM has a dedicated low-cost diagnostics endpoint. Keep periodic meter
    // refreshes separate from rebuilding and transferring the complete schema.
    const needsLiveSchema = pluginKind.includes("eq")
      || pluginKind.includes("pitch")
      || pluginKind.includes("dynamics")
      || pluginKind.includes("compressor")
      || pluginKind.includes("gate")
      || pluginKind.includes("limiter");
    if (!needsLiveSchema) return;
    let refreshInFlight = false;
    const intervalId = window.setInterval(() => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      void loadSchema(false).finally(() => {
        refreshInFlight = false;
      });
    }, 500);
    return () => window.clearInterval(intervalId);
  }, [loadSchema, schema?.category, schema?.name]);

  useEffect(() => () => {
    schemaRequestGateRef.current.invalidate();
  }, []);

  useEffect(() => () => paramWriter.dispose(true), [paramWriter]);

  const pluginKind = useMemo(() => getPluginKind(schema), [schema]);

  const primaryParamIds = useMemo(
    () => primaryParamIdsForKind(pluginKind, schema),
    [pluginKind, schema],
  );

  const primaryParams = useMemo(() => {
    const params = schema?.parameters ?? [];
    return primaryParamIds
      .map((id) => params.find((param) => param.id === id))
      .filter((param): param is BuiltInParamDescriptor => Boolean(param));
  }, [primaryParamIds, schema]);

  const groupedParams = useMemo(() => {
    const primaryIds = new Set(primaryParams.map((param) => param.id));
    const groups = new Map<string, BuiltInParamDescriptor[]>();
    for (const param of schema?.parameters ?? []) {
      if (primaryIds.has(param.id)) continue;
      const group = param.graphRole || "controls";
      groups.set(group, [...(groups.get(group) ?? []), param]);
    }
    return Array.from(groups.entries())
      .sort(([groupA], [groupB]) => groupSortWeight(pluginKind, groupA) - groupSortWeight(pluginKind, groupB));
  }, [pluginKind, primaryParams, schema]);

  const handleParamChange = (param: BuiltInParamDescriptor, rawValue: number) => {
    const value = param.type === "toggle"
      ? (rawValue >= 0.5 ? 1 : 0)
      : quantizeParamValue(param, clamp(rawValue, param.min, param.max));
    const previousDisplayedValue = schemaRef.current?.parameters.find(
      (entry) => entry.id === param.id,
    )?.value ?? param.value;
    paramWriteReconcilerRef.current!.beginOptimisticWrite(
      param.id,
      value,
      previousDisplayedValue,
    );
    applyLocalParamValue(param.id, value);

    if (param.type === "continuous") {
      paramWriter.enqueue(param.id, value);
      return;
    }

    paramWriter.writeImmediately(param.id, value);
  };

  const title = schema?.name || fallbackName;
  const displayTitle = pluginKind === "nam" ? "NAM Rack" : title;

  return (
    <section
      className="builtin-plugin-panel"
      data-kind={pluginKind}
      data-shortcut-context={`plugin:${pluginShortcutSessionId}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDownCapture={() => activateShortcutContext({ kind: "plugin", sessionId: pluginShortcutSessionId })}
      onFocusCapture={() => activateShortcutContext({ kind: "plugin", sessionId: pluginShortcutSessionId })}
    >
      <div className="builtin-panel-header">
        <div className="builtin-panel-title">
          <Activity size={14} />
          <span data-qa={pluginKind === "nam" ? "nam-window-title" : undefined}>{displayTitle}</span>
        </div>
        {pluginKind === "nam" ? (
          <div className="builtin-window-controls" aria-label="Window controls">
            {onClose && (
              <button type="button" onClick={onClose} title="Close editor" aria-label={`Close ${displayTitle}`}>
                <X size={14} />
              </button>
            )}
          </div>
        ) : (
          onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close editor" aria-label={`Close ${title}`}>
              <X size={14} />
            </Button>
          )
        )}
      </div>

      {loading && !schema ? (
        <div className="builtin-empty">Loading</div>
      ) : pluginKind === "nam" ? (
        <NAMRackPanel
          address={address}
          schema={schema ?? bootSchema ?? createNAMBootSchema(address, fallbackName)}
          primaryParams={primaryParams}
          groupedParams={groupedParams}
          onParamChange={(param, value) => {
            void handleParamChange(param, value);
          }}
          onFlushPendingParamWrites={() => paramWriter.flush()}
          onRefreshRack={() => loadSchema(false)}
        />
      ) : !schema || schema.parameters.length === 0 ? (
        <div className="builtin-empty">No editable parameters</div>
      ) : (
        <>
          {schema.parameters.length > 0 && (
            <BuiltInVisualization
              schema={schema}
              onParamChange={(param, value) => {
                void handleParamChange(param, value);
              }}
            />
          )}
          <div className="builtin-param-groups">
            {primaryParams.length > 0 && (
              <div className="builtin-macro-strip" aria-label={`${title} primary controls`}>
                {primaryParams.map((param) => (
                  <BuiltInParamControl
                    key={param.id}
                    param={param}
                    compact
                    onChange={(nextParam, value) => {
                      void handleParamChange(nextParam, value);
                    }}
                  />
                ))}
              </div>
            )}
            {groupedParams.map(([group, params]) => (
              <div className="builtin-param-group" key={group}>
                <div className="builtin-group-title">
                  <SlidersHorizontal size={11} />
                  <span>{groupLabel(group)}</span>
                </div>
                <div className="builtin-param-grid">
                  {params.map((param) => (
                    <BuiltInParamControl
                      key={param.id}
                      param={param}
                      onChange={(nextParam, value) => {
                        void handleParamChange(nextParam, value);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

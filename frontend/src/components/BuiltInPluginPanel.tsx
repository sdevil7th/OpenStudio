import { resolveProfiledParameterWheel } from "../utils/parameterWheel";
import type { GainPhaseAlignmentEntry, GainPhaseAlignmentResult } from "../services/NativeBridge";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, X } from "lucide-react";
import {
  BuiltInParamDescriptor,
  BuiltInPluginAddress,
  BuiltInPluginSchema,
  nativeBridge,
} from "../services/NativeBridge";
import { getBuiltInEditor } from "./builtin/editorRegistry";
import { capturePluginState } from "./builtin/EQToolbar";
import { EQEditor } from "./builtin/EQEditor";
import { EQInstanceBrowser } from "./builtin/EQInstanceBrowser";
import { NAMRackPanel } from "./NAMRackPanel";
import { Button, ProfiledRangeInput } from "./ui";
import { registerScopedActionExecutor } from "../store/actionRegistry";
import { matchesActionShortcut } from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  getActiveShortcutContext,
  registerShortcutSurface,
  type ShortcutSurfaceHandler,
} from "../utils/shortcutContext";
import { windowRole } from "../utils/windowEnvironment";
import {
  BuiltInPluginParamHistory,
  type BuiltInPluginHistoryDirection,
  type BuiltInPluginParamHistoryEntry,
} from "../utils/builtInPluginParamHistory";
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
  chrome?: "embedded" | "detached";
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
  automatable = type !== "meter",
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
    automatable,
    graphRole,
    enumOptions,
  };
}

function isNAMPluginName(name: string) {
  return name.toLowerCase().includes("nam");
}

export function builtInPluginShortcutFocusIsActive(
  role: string,
  documentFocused: boolean,
): boolean {
  return role === "main" || (role === "pluginEditor" && documentFocused);
}

export function dispatchBuiltInPluginHistoryShortcut(
  event: Parameters<ShortcutSurfaceHandler>[0],
  options: {
    active: boolean;
    canUndo: boolean;
    canRedo: boolean;
    undo: () => void;
    redo: () => void;
  },
): ReturnType<ShortcutSurfaceHandler> {
  if (!options.active) return "unmatched";
  if (matchesActionShortcut(event, "edit.undo")) {
    if (event.repeat || !options.canUndo) return "claimed_noop";
    options.undo();
    return "handled";
  }
  if (matchesActionShortcut(event, "edit.redo")) {
    if (event.repeat || !options.canRedo) return "claimed_noop";
    options.redo();
    return "handled";
  }
  return "unmatched";
}

function currentDocumentHasFocus(): boolean {
  return typeof document !== "undefined"
    && typeof document.hasFocus === "function"
    && document.hasFocus();
}

function paramIdFromEventTarget(target: EventTarget | null): string | null {
  const candidate = target as (EventTarget & {
    closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null;
  }) | null;
  const owner = candidate?.closest?.("[data-param], [data-param-id]");
  const paramId = (
    owner?.getAttribute?.("data-param")
    ?? owner?.getAttribute?.("data-param-id")
  )?.trim();
  return paramId || null;
}

export function isBuiltInPluginParamShortcutTarget(target: EventTarget | null): boolean {
  return paramIdFromEventTarget(target) !== null;
}

const PARAM_ADJUSTMENT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

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
      makeFallbackParam("cabEngineVersion", "Cab Engine Version", 3, 1, 3, 3, "", "cabInternal", "continuous", undefined, false),
      makeFallbackParam("cabHPFEnabled", "Retired Cab HPF Power", 0, 0, 1, 0, "", "cabInternal", "toggle", undefined, false),
      makeFallbackParam("cabLPFEnabled", "Retired Cab LPF Power", 0, 0, 1, 0, "", "cabInternal", "toggle", undefined, false),
      makeFallbackParam("cabHPFHz", "Retired Cab HPF", 30, 20, 500, 30, "Hz", "cabInternal", "continuous", undefined, false),
      makeFallbackParam("cabLPFHz", "Retired Cab LPF", 16000, 1000, 20000, 16000, "Hz", "cabInternal", "continuous", undefined, false),
      makeFallbackParam("cabIRStereo", "Stereo IR", 0, 0, 1, 0, "", "cab", "toggle"),
      makeFallbackParam("cabDirectMix", "Direct Mix", 0, 0, 1, 0, "", "cab"),
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
      namEffectsDspVersion: 20,
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
  if (["preamp", "geq", "utility"].includes(schema?.pluginId ?? "")) return "generic";
  const identities: Record<string, BuiltInPluginKind> = { eq: "eq", compressor: "dynamics", gate: "dynamics", limiter: "dynamics", delay: "delay", reverb: "reverb", chorus: "modulation", saturator: "saturation", pitch: "pitch", synth: "synth", piano: "piano", drums: "drums", guitar: "guitar", nam: "nam" };
  if (schema?.pluginId && identities[schema.pluginId]) return identities[schema.pluginId];
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
      <label className="builtin-control builtin-control-enum" data-param={param.id} title={param.label}>
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
        data-param={param.id}
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
    <label
      className="builtin-control builtin-control-continuous"
      data-compact={compact}
      data-param={param.id}
      style={style}
      title={param.label}
    >
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

export function BuiltInPluginPanel(props: BuiltInPluginPanelProps) {
  const identity = `${props.address.instanceId ?? ""}:${props.address.chain}:${props.address.trackId}:${props.address.fxIndex}`;
  return <BuiltInPluginWorkspace key={identity} {...props} />;
}

function BuiltInPluginWorkspace(props: BuiltInPluginPanelProps) {
  const [selected, setSelected] = useState<BuiltInPluginAddress | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const histories = useRef(new Map<string, BuiltInPluginParamHistory>());
  const activeAddress = selected ?? props.address;
  const identity = activeAddress.instanceId ?? `${activeAddress.chain}:${activeAddress.trackId}:${activeAddress.fxIndex}`;
  const session = selected ? `builtin-instance:${identity}` : props.shortcutSessionId
    ?? `builtin:${activeAddress.chain}:${activeAddress.trackId ?? "master"}:${activeAddress.fxIndex ?? -1}`;
  let history = histories.current.get(identity);
  if (!history) { history = new BuiltInPluginParamHistory(session); histories.current.set(identity, history); }
  return <>
    <BuiltInPluginPanelContent {...props} key={identity} address={activeAddress}
      fallbackName={selected ? "OpenStudio EQ" : props.fallbackName} initialSchema={selected ? undefined : props.initialSchema}
      shortcutSessionId={history.getInstanceId()} retainedHistory={history}
      onBrowseInstances={(resolved, flush) => { void flush().then(ok => {
        if (ok) {
          if (resolved.instanceId) histories.current.set(resolved.instanceId, history!);
          setBrowsing(true);
        }
      }); }} />
    {browsing && <EQInstanceBrowser current={activeAddress} onClose={() => setBrowsing(false)} onSelect={address => { setSelected(address); setBrowsing(false); }} />}
  </>;
}

function BuiltInPluginPanelContent({
  address: requestedAddress,
  fallbackName,
  onClose,
  initialSchema,
  shortcutSessionId,
  chrome = "embedded",
  retainedHistory,
  onBrowseInstances,
}: BuiltInPluginPanelProps & { retainedHistory: BuiltInPluginParamHistory; onBrowseInstances: (address: BuiltInPluginAddress, flush: () => Promise<boolean>) => void }) {
  const address = useMemo(() => ({ ...requestedAddress }), [requestedAddress.instanceId, requestedAddress.chain, requestedAddress.trackId, requestedAddress.fxIndex]);
  const bootSchema = useMemo(
    () => (isNAMPluginName(fallbackName) ? createNAMBootSchema(address, fallbackName) : null),
    [address, fallbackName],
  );
  const suiteMutation = useRef(false);
  const [suiteBusy, setSuiteBusy] = useState(false);
  const [schema, setSchema] = useState<BuiltInPluginSchema | null>(initialSchema ?? bootSchema);
  const [loading, setLoading] = useState(false);
  const [, refreshHistory] = useState(0);
  const [historyReplayRevision, setHistoryReplayRevision] = useState(0);
  const historyChanged = useCallback(() => refreshHistory(value => value + 1), []);
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
  const pluginShortcutHandlerRef = useRef<ShortcutSurfaceHandler>(() => "unmatched");
  const paramHistoryOwnerRef = useRef<{
    instanceId: string;
    history: BuiltInPluginParamHistory;
  } | null>(null);
  if (paramHistoryOwnerRef.current?.instanceId !== pluginShortcutSessionId) {
    paramHistoryOwnerRef.current = {
      instanceId: pluginShortcutSessionId,
      history: retainedHistory,
    };
  }
  const paramHistory = paramHistoryOwnerRef.current.history;

  useEffect(() => {
    const context = { kind: "plugin", sessionId: pluginShortcutSessionId } as const;
    const fallback = getActiveShortcutContext();
    const unregisterSurface = registerShortcutSurface(
      context,
      (event) => pluginShortcutHandlerRef.current(event),
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
    if (windowRole === "pluginEditor") activateShortcutContext(context);
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
      if (nextSchema.instanceId) address.instanceId = nextSchema.instanceId;

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
      get instanceId() { return address.instanceId; },
    }),
    [address.chain, address.fxIndex, address.trackId],
  );

  const paramWriter = useMemo(
    () => createFrameCoalescedParamWriter({
      write: (paramId, value) => nativeBridge.setBuiltInPluginParam({ ...writeAddress, instanceId: address.instanceId }, paramId, value),
      onSuccess: confirmSuccessfulParamWrite,
      onFailure: recoverFailedParamWrite,
    }),
    [address, confirmSuccessfulParamWrite, recoverFailedParamWrite, writeAddress],
  );

  const paramCommitTimerRef = useRef<number | null>(null);
  const pointerParamRef = useRef<string | null>(null);
  const keyboardParamRef = useRef<string | null>(null);

  const clearScheduledParamCommit = useCallback(() => {
    if (paramCommitTimerRef.current === null) return;
    window.clearTimeout(paramCommitTimerRef.current);
    paramCommitTimerRef.current = null;
  }, []);

  const flushParamWrites = useCallback(() => paramWriter.flush(), [paramWriter]);
  const automationGestures = useRef(new Set<string>());
  const pendingGestureFinishes = useRef(new Set<Promise<boolean>>());
  const finishAutomationGestures = useCallback(() => {
    const params = [...automationGestures.current];
    automationGestures.current.clear();
    const operation = (async () => {
      let success = await flushParamWrites();
      for (const param of params) {
        if (!automationGestures.current.has(param))
          success = await nativeBridge.builtInPluginGesture(writeAddress, param, false) && success;
      }
      return success;
    })().catch(error => { console.warn("Could not finish the plugin automation gesture", error); return false; });
    pendingGestureFinishes.current.add(operation);
    void operation.finally(() => pendingGestureFinishes.current.delete(operation)).catch(() => {});
    return operation;
  }, [flushParamWrites, writeAddress]);

  useEffect(() => nativeBridge.registerAutomationEditorFlush(async () => {
    clearScheduledParamCommit();
    const success = await finishAutomationGestures();
    const pending = await Promise.all([...pendingGestureFinishes.current]);
    await paramHistory.commit(flushParamWrites);
    historyChanged();
    return success && pending.every(Boolean);
  }), [clearScheduledParamCommit, finishAutomationGestures, flushParamWrites, paramHistory, historyChanged]);

  const scheduleParamCommit = useCallback((delayMs = 220) => {
    clearScheduledParamCommit();
    paramCommitTimerRef.current = window.setTimeout(() => {
      paramCommitTimerRef.current = null;
      void paramHistory.commit(flushParamWrites).finally(historyChanged);
      void finishAutomationGestures();
    }, delayMs);
  }, [clearScheduledParamCommit, flushParamWrites, paramHistory, finishAutomationGestures, historyChanged]);

  const beginParamEdit = useCallback((paramId: string) => {
    const currentParam = schemaRef.current?.parameters.find((entry) => entry.id === paramId);
    if (!currentParam || currentParam.type === "meter") return false;
    if (!automationGestures.current.has(paramId)) {
      automationGestures.current.add(paramId);
      void nativeBridge.builtInPluginGesture(writeAddress, paramId, true);
    }
    return paramHistory.begin(paramId, currentParam.label, currentParam.value);
  }, [paramHistory, writeAddress]);

  const beginExclusiveParamGesture = useCallback((paramId: string) => {
    clearScheduledParamCommit();
    if (paramHistory.getActiveParamId() && !paramHistory.hasActiveParam(paramId)) {
      void paramHistory.commit(flushParamWrites).finally(historyChanged);
      void finishAutomationGestures();
    }
    return beginParamEdit(paramId);
  }, [beginParamEdit, clearScheduledParamCommit, flushParamWrites, paramHistory, finishAutomationGestures, historyChanged]);

  const replayParamHistory = useCallback(async (
    entry: BuiltInPluginParamHistoryEntry,
    direction: BuiltInPluginHistoryDirection,
  ) => {
    if (entry.instanceId !== pluginShortcutSessionId) return false;
    if (entry.state) {
      const state = JSON.parse(entry.state[direction]);
      if (typeof state.hostBypassed === "boolean") state.hostBypassHistoryReplay = true;
      const applied = state.alignmentGroup
        ? (await nativeBridge.gainPhaseAlignment("apply", state.alignmentGroup)).success
        : await nativeBridge.setBuiltInPluginState(address, state);
      await loadSchemaRef.current(false);
      if (applied) setHistoryReplayRevision(value => value + 1);
      return applied;
    }
    const currentParams = schemaRef.current?.parameters ?? [];
    const writes = entry.changes.map((change) => {
      const currentParam = currentParams.find((candidate) => candidate.id === change.paramId);
      if (!currentParam || currentParam.type === "meter") return null;
      const requestedValue = change[direction];
      const value = currentParam.type === "toggle"
        ? (requestedValue >= 0.5 ? 1 : 0)
        : currentParam.type === "continuous" && getPluginKind(schemaRef.current) !== "nam"
          ? clamp(requestedValue, currentParam.min, currentParam.max)
          : quantizeParamValue(
            currentParam,
            clamp(requestedValue, currentParam.min, currentParam.max),
          );
      return { currentParam, value };
    });
    if (writes.some((write) => write === null)) return false;

    for (const write of writes) {
      if (!write) continue;
      paramWriteReconcilerRef.current!.beginOptimisticWrite(
        write.currentParam.id,
        write.value,
        write.currentParam.value,
      );
      applyLocalParamValue(write.currentParam.id, write.value);
      paramWriter.writeImmediately(write.currentParam.id, write.value);
    }
    const applied = await paramWriter.flush();
    // A compound replay can partially fail at the bridge. Always read back the
    // processor so optimistic UI values converge on the native truth; the
    // history command remains on its original stack when `applied` is false.
    await loadSchemaRef.current(false);
    if (applied) setHistoryReplayRevision(value => value + 1);
    return applied;
  }, [address, applyLocalParamValue, paramWriter, pluginShortcutSessionId]);

  pluginShortcutHandlerRef.current = (event) => dispatchBuiltInPluginHistoryShortcut(event, {
    active: !suiteMutation.current && builtInPluginShortcutFocusIsActive(windowRole, currentDocumentHasFocus()),
    canUndo: paramHistory.canUndo(),
    canRedo: paramHistory.canRedo(),
    undo: () => {
      clearScheduledParamCommit();
      void paramHistory.undo(flushParamWrites, replayParamHistory).finally(historyChanged);
    },
    redo: () => {
      clearScheduledParamCommit();
      void paramHistory.redo(flushParamWrites, replayParamHistory).finally(historyChanged);
    },
  });

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
    const needsLiveSchema = !pluginKind.includes("nam");
    if (!needsLiveSchema) return;
    let refreshInFlight = false;
    const intervalId = window.setInterval(() => {
      if (refreshInFlight || document.hidden) return;
      refreshInFlight = true;
      void loadSchema(false).finally(() => {
        refreshInFlight = false;
      });
    }, pluginKind.includes("eq") || pluginKind.includes("pitch") ? 500 : 2000);
    return () => window.clearInterval(intervalId);
  }, [loadSchema, schema?.category, schema?.name]);

  useEffect(() => () => {
    schemaRequestGateRef.current.invalidate();
  }, []);

  useEffect(() => () => clearScheduledParamCommit(), [clearScheduledParamCommit]);
  useEffect(() => () => paramWriter.dispose(true), [paramWriter]);
  useEffect(() => () => { void finishAutomationGestures(); }, [finishAutomationGestures]);

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
    if (!Number.isFinite(rawValue)) return;
    let value = param.type === "toggle"
      ? (rawValue >= 0.5 ? 1 : 0)
      : param.type === "continuous" && getPluginKind(schemaRef.current) !== "nam"
        ? clamp(rawValue, param.min, param.max)
        : quantizeParamValue(param, clamp(rawValue, param.min, param.max));
    const dependencies: Array<{ parameter: BuiltInParamDescriptor; value: number }> = [];
    const currentParameters = schemaRef.current?.parameters ?? [];
    if (schemaRef.current?.pluginId === "eq" && param.id.endsWith(".detectorHighCut")) {
      const low = currentParameters.find(p => p.id === param.id.replace("HighCut", "LowCut"));
      if (low) value = Math.max(value, low.value * 1.05);
    }
    if (schemaRef.current?.pluginId === "eq" && param.id.endsWith(".detectorLowCut")) {
      const high = currentParameters.find(p => p.id === param.id.replace("LowCut", "HighCut"));
      if (high && high.value < value * 1.05) dependencies.push({ parameter: high, value: value * 1.05 });
    }
    if (param.id === "mpeLowerMembers" || param.id === "mpeUpperMembers") {
      value = Math.round(value);
      const other = currentParameters.find(p => p.id === (param.id === "mpeLowerMembers" ? "mpeUpperMembers" : "mpeLowerMembers"));
      if (other && value > 0 && other.value > 0 && value + other.value > 14) dependencies.push({ parameter: other, value: Math.max(0, 14 - value) });
    }
    const previousDisplayedValue = schemaRef.current?.parameters.find(
      (entry) => entry.id === param.id,
    )?.value ?? param.value;
    beginParamEdit(param.id);
    paramHistory.update(param.id, value);
    paramWriteReconcilerRef.current!.beginOptimisticWrite(
      param.id,
      value,
      previousDisplayedValue,
    );
    applyLocalParamValue(param.id, value);

    // Native coupled controls change more than the edited scalar. Keep those
    // values in the same gesture so Undo restores the complete valid pair.
    for (const dependent of dependencies) {
      beginParamEdit(dependent.parameter.id);
      paramHistory.update(dependent.parameter.id, dependent.value);
      paramWriteReconcilerRef.current!.beginOptimisticWrite(dependent.parameter.id, dependent.value, dependent.parameter.value);
      applyLocalParamValue(dependent.parameter.id, dependent.value);
      paramWriter.enqueue(dependent.parameter.id, dependent.value);
    }

    if (param.type === "continuous") {
      paramWriter.enqueue(param.id, value);
      const pointerOwnsEdit = getPluginKind(schemaRef.current) === "nam"
        ? pointerParamRef.current === param.id
        : pointerParamRef.current !== null;
      if (!pointerOwnsEdit && keyboardParamRef.current !== param.id) {
        scheduleParamCommit();
      }
      return;
    }

    paramWriter.writeImmediately(param.id, value);
    scheduleParamCommit(0);
  };

  const applySuiteValues = async (values: Record<string, number>) => {
    if (suiteMutation.current) return false;
    suiteMutation.current = true; setSuiteBusy(true);
    try {
    clearScheduledParamCommit();
    await paramHistory.commit(flushParamWrites);
    await finishAutomationGestures();
    const snapshot = await loadSchema(false);
    if (!snapshot) throw new Error("Could not read the processor before applying settings");
    const beforeState = await capturePluginState(address);
    for (const [id, value] of Object.entries(values)) {
      const parameter = schemaRef.current?.parameters.find(p => p.id === id);
      if (parameter && parameter.type !== "meter" && parameter.value !== value) handleParamChange(parameter, value);
    }
    clearScheduledParamCommit();
    const applied = await flushParamWrites();
    // Native compound controls can also change dependent parameters (type
    // banks and Send routing). Record the actual readback as one undo step.
    paramHistory.cancelActive();
    await finishAutomationGestures();
    const after = await loadSchema(false);
    if (after) {
      paramHistory.recordState(beforeState, await capturePluginState(address));
    }
    if (!applied) {
      historyChanged();
      throw new Error("Some settings were not applied. Undo restores the previous settings.");
    }
    historyChanged();
    return applied;
    } finally { suiteMutation.current = false; setSuiteBusy(false); }
  };

  const applyAlignmentGroup = async (entries: GainPhaseAlignmentEntry[]): Promise<GainPhaseAlignmentResult> => {
    if (suiteMutation.current) return { success: false, error: "An editor operation is still running" };
    suiteMutation.current = true; setSuiteBusy(true);
    try {
      clearScheduledParamCommit();
      await paramHistory.commit(flushParamWrites);
      await finishAutomationGestures();
      if (!await flushParamWrites()) return { success: false, error: "Pending parameter writes failed" };
      const result = await nativeBridge.gainPhaseAlignment("apply", entries);
      if (result.success && result.before && result.after) {
        paramHistory.recordState(JSON.stringify({ alignmentGroup: result.before }), JSON.stringify({ alignmentGroup: result.after }));
        await loadSchema(false); historyChanged();
      }
      return result;
    } finally { suiteMutation.current = false; setSuiteBusy(false); }
  };

  const applySuiteStateOperation = async (operation: () => Promise<boolean>, capture = () => capturePluginState(address)) => {
    if (suiteMutation.current) return false;
    suiteMutation.current = true; setSuiteBusy(true);
    try {
    clearScheduledParamCommit();
    await paramHistory.commit(flushParamWrites);
    await finishAutomationGestures();
    if (!await flushParamWrites()) return false;
    const before = await capture();
    let applied = false;
    try { applied = await operation(); }
    finally {
      const after = await capture();
      paramHistory.recordState(before, after);
      await loadSchema(false);
      historyChanged();
    }
    return applied;
    } finally { suiteMutation.current = false; setSuiteBusy(false); }
  };
  const applySuiteState = (state: string) => {
    const parsed = JSON.parse(state);
    return applySuiteStateOperation(() => nativeBridge.setBuiltInPluginState(address, parsed),
      typeof parsed.hostBypassed === "boolean" ? async () => {
        const current = await nativeBridge.getBuiltInPluginSchema(address);
        if (typeof current.hostBypassed !== "boolean") throw new Error("Host bypass is unavailable");
        return JSON.stringify({ hostBypassed: current.hostBypassed });
      } : undefined);
  };
  const recallSuitePreset = (name: string) => applySuiteStateOperation(async () => {
    const before = await nativeBridge.getBuiltInPluginSchema(address);
    const route = await nativeBridge.resolveBuiltInAddress(address);
    let applied = await nativeBridge.loadBuiltInFXPreset(route.trackId ?? "", route.fxIndex ?? -1, route.chain === "input", name, route.chain);
    if (before.pluginId === "reverb" && (before.parameters.find(p => p.id === "mixLock")?.value ?? 0) >= .5) {
      for (const id of ["sendMode", "wetLevel", "dryLevel", "insertWet", "insertDry", "mixLock"]) {
        const parameter = before.parameters.find(p => p.id === id);
        if (parameter) applied = await nativeBridge.setBuiltInPluginParam(address, id, parameter.value) && applied;
      }
    }
    return applied;
  });

  const finishPointerParamGesture = () => {
    const paramId = pointerParamRef.current;
    pointerParamRef.current = null;
    if (paramId && paramHistory.hasActiveParam(paramId)) {
      // Capture runs before the control's own pointer-up handler. Deferring the
      // commit keeps that handler's final value in the same history gesture.
      scheduleParamCommit(0);
    }
  };

  const title = schema?.name || fallbackName;
  const displayTitle = pluginKind === "nam" ? "NAM Rack" : title;

  const GeneralEditor = getBuiltInEditor(schema?.pluginId).component;
  return (
    <section inert={suiteBusy} aria-busy={suiteBusy}
      className="builtin-plugin-panel"
      data-kind={pluginKind}
      data-chrome={chrome}
      data-shortcut-context={`plugin:${pluginShortcutSessionId}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDownCapture={(event) => {
        activateShortcutContext({ kind: "plugin", sessionId: pluginShortcutSessionId });
        const paramId = paramIdFromEventTarget(event.target);
        pointerParamRef.current = paramId;
        if (paramId) beginExclusiveParamGesture(paramId);
        else if (paramHistory.getActiveParamId()) {
          clearScheduledParamCommit();
          void paramHistory.commit(flushParamWrites).finally(historyChanged);
          void finishAutomationGestures();
        }
      }}
      onPointerUpCapture={finishPointerParamGesture}
      onPointerCancelCapture={finishPointerParamGesture}
      onLostPointerCaptureCapture={finishPointerParamGesture}
      onWheelCapture={(event) => {
        const paramId = paramIdFromEventTarget(event.target);
        if (!paramId || resolveProfiledParameterWheel(event.nativeEvent).operation !== "adjust") return;
        beginExclusiveParamGesture(paramId);
        scheduleParamCommit();
      }}
      onKeyDownCapture={(event) => {
        if (!PARAM_ADJUSTMENT_KEYS.has(event.key)) return;
        const paramId = paramIdFromEventTarget(event.target);
        if (!paramId) return;
        keyboardParamRef.current = paramId;
        beginExclusiveParamGesture(paramId);
      }}
      onKeyUpCapture={(event) => {
        if (!PARAM_ADJUSTMENT_KEYS.has(event.key)) return;
        const paramId = keyboardParamRef.current;
        keyboardParamRef.current = null;
        if (paramId && paramHistory.hasActiveParam(paramId)) {
          scheduleParamCommit(0);
        }
      }}
      onFocusCapture={(event) => {
        activateShortcutContext({ kind: "plugin", sessionId: pluginShortcutSessionId });
        const paramId = paramIdFromEventTarget(event.target);
        if (paramId) beginExclusiveParamGesture(paramId);
      }}
      onBlur={(event) => {
        // Numeric fields commit in their own blur handler. Close the gesture
        // afterwards so its normal debounce cannot merge the next field edit.
        const paramId = paramIdFromEventTarget(event.target);
        if (!paramId || !paramHistory.hasActiveParam(paramId)) return;
        pointerParamRef.current = null;
        keyboardParamRef.current = null;
        scheduleParamCommit(0);
      }}
    >
      {(chrome !== "detached" || pluginKind === "nam") && <div className="builtin-panel-header">
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
      </div>}

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
      ) : pluginKind === "eq" ? (
        <EQEditor key={pluginShortcutSessionId} schema={schema} address={address} onChange={handleParamChange}
          onBrowseInstances={() => onBrowseInstances(address, async () => {
            clearScheduledParamCommit();
            if (paramHistory.getActiveParamId() && !await paramHistory.commit(flushParamWrites)) return false;
            await finishAutomationGestures(); historyChanged();
            return flushParamWrites();
          })}
          onHostBypass={value => applySuiteState(JSON.stringify({ hostBypassed: value }))} onApplyState={applySuiteState} onApplyValues={applySuiteValues} onRecallPreset={recallSuitePreset} onFlush={flushParamWrites}
          onGestureStart={(id) => { pointerParamRef.current = id; beginExclusiveParamGesture(id); }}
          onGestureEnd={finishPointerParamGesture}
          canUndo={paramHistory.canUndo()} canRedo={paramHistory.canRedo()}
          onUndo={() => { clearScheduledParamCommit(); void finishAutomationGestures(); void paramHistory.undo(flushParamWrites, replayParamHistory).finally(historyChanged); }}
          onRedo={() => { clearScheduledParamCommit(); void finishAutomationGestures(); void paramHistory.redo(flushParamWrites, replayParamHistory).finally(historyChanged); }} />
      ) : (
        <GeneralEditor key={pluginShortcutSessionId} historyReplayRevision={historyReplayRevision} schema={schema} address={address} onChange={handleParamChange}
          onApplyAlignment={applyAlignmentGroup} onHostBypass={value => applySuiteState(JSON.stringify({ hostBypassed: value }))} onApplyState={applySuiteState} onApplyValues={applySuiteValues} onRecallPreset={recallSuitePreset} onFlush={flushParamWrites}
          onGestureStart={(id) => { pointerParamRef.current = id; beginExclusiveParamGesture(id); }}
          onGestureEnd={finishPointerParamGesture}
          canUndo={paramHistory.canUndo()} canRedo={paramHistory.canRedo()}
          onUndo={() => { clearScheduledParamCommit(); void finishAutomationGestures(); void paramHistory.undo(flushParamWrites, replayParamHistory).finally(historyChanged); }}
          onRedo={() => { clearScheduledParamCommit(); void finishAutomationGestures(); void paramHistory.redo(flushParamWrites, replayParamHistory).finally(historyChanged); }} />
      )}
    </section>
  );
}

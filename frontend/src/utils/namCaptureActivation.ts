export type NAMCaptureActivationSlot = "amp" | "pedal" | "cab";
export type NAMCaptureUsePhase = "idle" | "downloading" | "preparing" | "activating" | "success" | "error";

export function namCaptureUsePhaseLabel(phase: NAMCaptureUsePhase, useLabel = "Use Capture") {
  if (phase === "downloading") return "Downloading...";
  if (phase === "preparing") return "Installing / Preparing...";
  if (phase === "activating") return "Activating...";
  if (phase === "success") return "Activated";
  if (phase === "error") return `Retry ${useLabel}`;
  return useLabel;
}

export type NAMCaptureActivationInspection = {
  verified: boolean;
  pathMatches: boolean;
  resourceLoaded: boolean;
  liveSource: boolean;
  slotAudible: boolean;
  requestedCabMatches: boolean;
  requestedCabEnabled: boolean;
  expectedEffectiveCabEnabled: boolean;
  cabTopologySafe: boolean;
  ampEnabled: boolean;
  ampMixActive: boolean;
  previewCleared: boolean;
  loadError: string;
  reason: string;
};

export type NAMCaptureActivationReadback = NAMCaptureActivationInspection & {
  state: Record<string, unknown> | null;
  attempts: number;
};

export type NAMCaptureSchemaLike = {
  parameters?: Array<{ id?: unknown; value?: unknown }>;
  modelState?: unknown;
  uiState?: unknown;
};

function normalizeLocalPath(path: unknown) {
  return String(path ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function namCaptureStateFromSchema(schema: NAMCaptureSchemaLike | null | undefined) {
  if (!schema) return null;
  const values: Record<string, unknown> = {};
  for (const parameter of schema.parameters ?? []) {
    if (typeof parameter?.id !== "string" || !parameter.id) continue;
    values[parameter.id] = parameter.value;
  }
  return {
    values,
    modelState: objectValue(schema.modelState),
    uiState: objectValue(schema.uiState),
  };
}

export function inspectNAMCaptureSchemaActivation(
  schema: NAMCaptureSchemaLike | null | undefined,
  slot: NAMCaptureActivationSlot,
  expectedPath: string,
  options: {
    requirePreviewCleared?: boolean;
    requireLiveSource?: boolean;
    expectedCabRequestedEnabled?: boolean;
  } = {},
) {
  return inspectNAMCaptureActivation(
    namCaptureStateFromSchema(schema),
    slot,
    expectedPath,
    options,
  );
}

export function expectedNAMEffectiveCabEnabled(
  requestedCabEnabled: boolean,
  ampIncludesCab: boolean,
) {
  return requestedCabEnabled && !ampIncludesCab;
}

export function inspectNAMCaptureActivation(
  state: unknown,
  slot: NAMCaptureActivationSlot,
  expectedPath: string,
  options: {
    requirePreviewCleared?: boolean;
    requireLiveSource?: boolean;
    expectedCabRequestedEnabled?: boolean;
  } = {},
): NAMCaptureActivationInspection {
  const root = objectValue(state);
  const models = objectValue(root.modelState);
  const values = objectValue(root.values);
  const uiState = objectValue(root.uiState);
  const pathKey = slot === "amp" ? "ampModelPath" : slot === "pedal" ? "pedalModelPath" : "cabIRPath";
  const loadedKey = slot === "amp" ? "hasAmpModel" : slot === "pedal" ? "hasPedalModel" : "hasCabIR";
  const expected = normalizeLocalPath(expectedPath);
  const actual = normalizeLocalPath(models[pathKey]);
  const pathMatches = Boolean(expected) && actual === expected;
  const resourceLoaded = models[loadedKey] === true;
  const loadError = String(models.lastLoadError ?? "").trim();
  const auditionSource = Number(values.auditionSource ?? 0);
  const liveSource = options.requireLiveSource === false
    || (Number.isFinite(auditionSource) && auditionSource < 0.5);
  const effectiveCabValue = Number(values.cabEnabled);
  const effectiveCabEnabled = Number.isFinite(effectiveCabValue)
    && effectiveCabValue >= 0.5;
  const requestedCabEnabled = typeof models.cabRequestedEnabled === "boolean"
    ? models.cabRequestedEnabled
    : effectiveCabEnabled;
  const requestedCabMatches = options.expectedCabRequestedEnabled === undefined
    || (
      typeof models.cabRequestedEnabled === "boolean"
      && requestedCabEnabled === options.expectedCabRequestedEnabled
    );
  const expectedEffectiveCabEnabled = expectedNAMEffectiveCabEnabled(
    requestedCabEnabled,
    models.ampIncludesCab === true,
  );
  const cabTopologySafe = Number.isFinite(effectiveCabValue)
    && effectiveCabEnabled === expectedEffectiveCabEnabled;
  const ampEnabled = slot !== "amp" || Number(values.ampEnabled ?? 0) >= 0.5;
  const ampMixActive = slot !== "amp" || Number(values.ampMix ?? 0) > 0.0001;
  const slotAudible = slot === "cab"
    ? effectiveCabEnabled && requestedCabEnabled
    : slot === "pedal"
      ? Number(values.pedalMix ?? 1) > 0.0001
      : ampEnabled && ampMixActive;
  const previewCleared = options.requirePreviewCleared !== true
    || uiState.namActivePreview === null
    || uiState.namActivePreview === undefined;

  let reason = "";
  if (!expected) reason = "The installed capture has no durable local path.";
  else if (loadError) reason = loadError;
  else if (!pathMatches) reason = "The rack read back a different capture path.";
  else if (!resourceLoaded) reason = "The rack retained the path but did not load the capture.";
  else if (!liveSource) reason = "The rack did not return to the live guitar input.";
  else if (!requestedCabMatches) reason = "The rack did not preserve the requested external-cabinet preference.";
  else if (!cabTopologySafe) reason = "The effective Cab/IR state did not match the requested preference and amp topology.";
  else if (slot === "amp" && !ampEnabled) reason = "The amp capture loaded but Amp Power remained off.";
  else if (slot === "amp" && !ampMixActive) reason = "The amp capture loaded but Capture Mix remained fully dry.";
  else if (!slotAudible) reason = slot === "cab"
    ? "The cabinet IR loaded but remained bypassed."
    : "The pedal capture loaded but remained bypassed.";
  else if (!previewCleared) reason = "The temporary audition marker was not cleared.";

  return {
    verified: !reason,
    pathMatches,
    resourceLoaded,
    liveSource,
    slotAudible,
    requestedCabMatches,
    requestedCabEnabled,
    expectedEffectiveCabEnabled,
    cabTopologySafe,
    ampEnabled,
    ampMixActive,
    previewCleared,
    loadError,
    reason,
  };
}

export async function waitForNAMCaptureActivation(
  readState: () => Promise<unknown>,
  slot: NAMCaptureActivationSlot,
  expectedPath: string,
  options: {
    attempts?: number;
    delayMs?: number;
    requirePreviewCleared?: boolean;
    requireLiveSource?: boolean;
    expectedCabRequestedEnabled?: boolean;
  } = {},
): Promise<NAMCaptureActivationReadback> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 4));
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 40));
  let latestState: Record<string, unknown> | null = null;
  let latestInspection = inspectNAMCaptureActivation(null, slot, expectedPath, options);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const state = await readState();
      latestState = state && typeof state === "object" ? state as Record<string, unknown> : null;
      latestInspection = inspectNAMCaptureActivation(latestState, slot, expectedPath, options);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The rack state could not be read.";
      latestInspection = {
        ...latestInspection,
        verified: false,
        reason,
      };
    }
    if (latestInspection.verified || attempt === attempts) {
      return {
        ...latestInspection,
        state: latestState,
        attempts: attempt,
      };
    }
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return {
    ...latestInspection,
    state: latestState,
    attempts,
  };
}

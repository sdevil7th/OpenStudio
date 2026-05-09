export type AssistantActionKind =
  | "app.executeRegisteredAction"
  | "ai.getRuntimeStatus"
  | "ai.openSetup"
  | "ai.openContextGeneration"
  | "ai.createAITrack"
  | "ai.setWorkflow"
  | "ai.setGenerationParams"
  | "ai.generateMusic"
  | "ai.cancelGeneration"
  | "ai.pollGeneration"
  | "ai.insertGeneratedClip"
  | "plugin.scan"
  | "plugin.listAvailable"
  | "plugin.add"
  | "plugin.openEditor"
  | "plugin.bypass"
  | "plugin.remove"
  | "plugin.reorder"
  | "plugin.listParameters"
  | "plugin.loadPreset";

export type AssistantActionRisk = "read" | "ui" | "project";

export interface AssistantActionBase<TKind extends AssistantActionKind, TParams extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: TKind;
  params: TParams;
  risk: AssistantActionRisk;
  summary?: string;
}

export interface AssistantExecuteRegisteredAction extends AssistantActionBase<"app.executeRegisteredAction", {
  actionId: string;
}> {}

export interface AssistantGetRuntimeStatusAction extends AssistantActionBase<"ai.getRuntimeStatus"> {
  risk: "read";
}

export interface AssistantOpenSetupAction extends AssistantActionBase<"ai.openSetup"> {
  risk: "ui";
}

export interface AssistantOpenContextGenerationAction extends AssistantActionBase<"ai.openContextGeneration", {
  trackId: string;
  clipId: string;
}> {
  risk: "ui";
}

export interface AssistantCreateAITrackAction extends AssistantActionBase<"ai.createAITrack", {
  trackName?: string;
  insertAfterTrackId?: string;
  workflowId?: string;
  params?: Record<string, unknown>;
}> {
  risk: "project";
}

export interface AssistantSetWorkflowAction extends AssistantActionBase<"ai.setWorkflow", {
  trackId: string;
  workflowId: string;
}> {
  risk: "project";
}

export interface AssistantSetGenerationParamsAction extends AssistantActionBase<"ai.setGenerationParams", {
  trackId: string;
  params: Record<string, unknown>;
}> {
  risk: "project";
}

export interface AssistantGenerateMusicAction extends AssistantActionBase<"ai.generateMusic", {
  trackId: string;
  workflowId?: string;
  params?: Record<string, unknown>;
}> {
  risk: "project";
}

export interface AssistantCancelGenerationAction extends AssistantActionBase<"ai.cancelGeneration", {
  trackId?: string;
}> {
  risk: "ui";
}

export interface AssistantPollGenerationAction extends AssistantActionBase<"ai.pollGeneration", {
  trackId?: string;
}> {
  risk: "read";
}

export interface AssistantInsertGeneratedClipAction extends AssistantActionBase<"ai.insertGeneratedClip", {
  trackId: string;
  filePath: string;
  startTime: number;
  clipName?: string;
}> {
  risk: "project";
}

export interface AssistantPluginScanAction extends AssistantActionBase<"plugin.scan"> {
  risk: "ui";
}

export interface AssistantPluginListAvailableAction extends AssistantActionBase<"plugin.listAvailable"> {
  risk: "read";
}

export interface AssistantPluginAddAction extends AssistantActionBase<"plugin.add", {
  target: "track" | "master";
  trackId?: string;
  chainType?: "track" | "input" | "master";
  pluginId: string;
  pluginType?: "builtin" | "s13fx" | "vst3" | "clap" | "lv2";
  openEditor?: boolean;
}> {
  risk: "project";
}

export interface AssistantPluginIndexedAction<TKind extends AssistantActionKind> extends AssistantActionBase<TKind, {
  target: "track" | "master";
  trackId?: string;
  fxIndex: number;
  chainType?: "track" | "input" | "master";
}> {}

export interface AssistantPluginBypassAction extends AssistantActionBase<"plugin.bypass", {
  target: "track" | "master";
  trackId?: string;
  fxIndex: number;
  chainType?: "track" | "input" | "master";
  bypassed: boolean;
}> {
  risk: "project";
}

export interface AssistantPluginReorderAction extends AssistantActionBase<"plugin.reorder", {
  trackId: string;
  fromIndex: number;
  toIndex: number;
  chainType?: "track" | "input";
}> {
  risk: "project";
}

export interface AssistantPluginLoadPresetAction extends AssistantActionBase<"plugin.loadPreset", {
  trackId: string;
  fxIndex: number;
  presetName: string;
  chainType?: "track" | "input";
}> {
  risk: "project";
}

export type AssistantAction =
  | AssistantExecuteRegisteredAction
  | AssistantGetRuntimeStatusAction
  | AssistantOpenSetupAction
  | AssistantOpenContextGenerationAction
  | AssistantCreateAITrackAction
  | AssistantSetWorkflowAction
  | AssistantSetGenerationParamsAction
  | AssistantGenerateMusicAction
  | AssistantCancelGenerationAction
  | AssistantPollGenerationAction
  | AssistantInsertGeneratedClipAction
  | AssistantPluginScanAction
  | AssistantPluginListAvailableAction
  | AssistantPluginAddAction
  | AssistantPluginIndexedAction<"plugin.openEditor">
  | AssistantPluginBypassAction
  | AssistantPluginIndexedAction<"plugin.remove">
  | AssistantPluginReorderAction
  | AssistantPluginIndexedAction<"plugin.listParameters">
  | AssistantPluginLoadPresetAction;

export interface AssistantActionPlan {
  id: string;
  title: string;
  intent: string;
  expectedImpact: string;
  requiresConfirmation: boolean;
  actions: AssistantAction[];
}

export interface AssistantActionValidationResult {
  ok: boolean;
  plan?: AssistantActionPlan;
  errors: string[];
}

const ACTION_KINDS = new Set<AssistantActionKind>([
  "app.executeRegisteredAction",
  "ai.getRuntimeStatus",
  "ai.openSetup",
  "ai.openContextGeneration",
  "ai.createAITrack",
  "ai.setWorkflow",
  "ai.setGenerationParams",
  "ai.generateMusic",
  "ai.cancelGeneration",
  "ai.pollGeneration",
  "ai.insertGeneratedClip",
  "plugin.scan",
  "plugin.listAvailable",
  "plugin.add",
  "plugin.openEditor",
  "plugin.bypass",
  "plugin.remove",
  "plugin.reorder",
  "plugin.listParameters",
  "plugin.loadPreset",
]);

const MUTATING_ACTIONS = new Set<AssistantActionKind>([
  "app.executeRegisteredAction",
  "ai.createAITrack",
  "ai.setWorkflow",
  "ai.setGenerationParams",
  "ai.generateMusic",
  "ai.insertGeneratedClip",
  "plugin.add",
  "plugin.bypass",
  "plugin.remove",
  "plugin.reorder",
  "plugin.loadPreset",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlaceholderId(value: unknown): boolean {
  if (!nonEmptyString(value)) return true;
  const normalized = value.trim().toLowerCase().replace(/[-\s]/g, "_");
  return [
    "selectedclipid",
    "selected_clip_id",
    "clipid",
    "clip_id",
    "selectedtrackid",
    "selected_track_id",
    "trackid",
    "track_id",
    "currenttrackid",
    "current_track_id",
    "selected",
    "selection",
  ].includes(normalized);
}

function requireRealId(params: Record<string, unknown>, key: string, label: string, errors: string[]) {
  if (!nonEmptyString(params[key])) {
    errors.push(`${label} requires ${key}.`);
  } else if (isPlaceholderId(params[key])) {
    errors.push(`${label} requires a real ${key}, not a placeholder.`);
  }
}

function validateAction(action: Record<string, unknown>, index: number): string[] {
  const errors: string[] = [];
  const kind = action.kind;
  const params = action.params;

  if (!nonEmptyString(action.id)) {
    errors.push(`Action ${index + 1} is missing an id.`);
  }
  if (!nonEmptyString(kind) || !ACTION_KINDS.has(kind as AssistantActionKind)) {
    errors.push(`Action ${index + 1} has unsupported kind: ${String(kind)}.`);
    return errors;
  }
  if (!isRecord(params)) {
    errors.push(`Action ${index + 1} params must be an object.`);
    return errors;
  }

  switch (kind as AssistantActionKind) {
    case "app.executeRegisteredAction":
      if (!nonEmptyString(params.actionId)) errors.push("app.executeRegisteredAction requires actionId.");
      break;
    case "ai.openContextGeneration":
      requireRealId(params, "trackId", "ai.openContextGeneration", errors);
      requireRealId(params, "clipId", "ai.openContextGeneration", errors);
      break;
    case "ai.createAITrack":
      if (params.workflowId !== undefined && !nonEmptyString(params.workflowId)) {
        errors.push("ai.createAITrack workflowId must be a non-empty string when provided.");
      }
      if (params.params !== undefined && !isRecord(params.params)) {
        errors.push("ai.createAITrack params must be an object when provided.");
      }
      break;
    case "ai.setWorkflow":
      requireRealId(params, "trackId", "ai.setWorkflow", errors);
      if (!nonEmptyString(params.workflowId)) errors.push("ai.setWorkflow requires workflowId.");
      break;
    case "ai.setGenerationParams":
      requireRealId(params, "trackId", "ai.setGenerationParams", errors);
      if (!isRecord(params.params)) errors.push("ai.setGenerationParams requires params.");
      break;
    case "ai.generateMusic":
      requireRealId(params, "trackId", "ai.generateMusic", errors);
      if (params.params !== undefined && !isRecord(params.params)) {
        errors.push("ai.generateMusic params must be an object when provided.");
      }
      break;
    case "ai.insertGeneratedClip":
      requireRealId(params, "trackId", "ai.insertGeneratedClip", errors);
      if (!nonEmptyString(params.filePath)) errors.push("ai.insertGeneratedClip requires filePath.");
      if (typeof params.startTime !== "number" || !Number.isFinite(params.startTime)) {
        errors.push("ai.insertGeneratedClip requires numeric startTime.");
      }
      break;
    case "plugin.add":
      if (params.target !== "track" && params.target !== "master") errors.push("plugin.add requires target track or master.");
      if (params.target === "track") requireRealId(params, "trackId", "plugin.add", errors);
      if (!nonEmptyString(params.pluginId)) errors.push("plugin.add requires pluginId.");
      if (params.chainType !== undefined && !["track", "input", "master"].includes(String(params.chainType))) {
        errors.push("plugin.add chainType must be track, input, or master.");
      }
      break;
    case "plugin.openEditor":
    case "plugin.remove":
    case "plugin.listParameters":
      if (params.target !== "track" && params.target !== "master") errors.push(`${kind} requires target track or master.`);
      if (params.target === "track") requireRealId(params, "trackId", kind, errors);
      if (typeof params.fxIndex !== "number" || !Number.isInteger(params.fxIndex) || params.fxIndex < 0) {
        errors.push(`${kind} requires non-negative integer fxIndex.`);
      }
      break;
    case "plugin.bypass":
      if (params.target !== "track" && params.target !== "master") errors.push("plugin.bypass requires target track or master.");
      if (params.target === "track") requireRealId(params, "trackId", "plugin.bypass", errors);
      if (typeof params.fxIndex !== "number" || !Number.isInteger(params.fxIndex) || params.fxIndex < 0) {
        errors.push("plugin.bypass requires non-negative integer fxIndex.");
      }
      if (typeof params.bypassed !== "boolean") errors.push("plugin.bypass requires bypassed boolean.");
      break;
    case "plugin.reorder":
      requireRealId(params, "trackId", "plugin.reorder", errors);
      if (typeof params.fromIndex !== "number" || !Number.isInteger(params.fromIndex) || params.fromIndex < 0) {
        errors.push("plugin.reorder requires non-negative integer fromIndex.");
      }
      if (typeof params.toIndex !== "number" || !Number.isInteger(params.toIndex) || params.toIndex < 0) {
        errors.push("plugin.reorder requires non-negative integer toIndex.");
      }
      break;
    case "plugin.loadPreset":
      requireRealId(params, "trackId", "plugin.loadPreset", errors);
      if (typeof params.fxIndex !== "number" || !Number.isInteger(params.fxIndex) || params.fxIndex < 0) {
        errors.push("plugin.loadPreset requires non-negative integer fxIndex.");
      }
      if (!nonEmptyString(params.presetName)) errors.push("plugin.loadPreset requires presetName.");
      break;
    default:
      break;
  }

  return errors;
}

export function validateAssistantActionPlan(value: unknown): AssistantActionValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["Plan must be an object."] };
  }

  if (!nonEmptyString(value.id)) errors.push("Plan is missing an id.");
  if (!nonEmptyString(value.title)) errors.push("Plan is missing a title.");
  if (!nonEmptyString(value.intent)) errors.push("Plan is missing intent.");
  if (!nonEmptyString(value.expectedImpact)) errors.push("Plan is missing expectedImpact.");
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    errors.push("Plan must contain at least one action.");
  }

  const actions = Array.isArray(value.actions) ? value.actions : [];
  for (let index = 0; index < actions.length; index += 1) {
    if (!isRecord(actions[index])) {
      errors.push(`Action ${index + 1} must be an object.`);
      continue;
    }
    errors.push(...validateAction(actions[index], index));
  }

  const hasMutation = actions.some(
    (action) => isRecord(action) && MUTATING_ACTIONS.has(action.kind as AssistantActionKind),
  );
  const requiresConfirmation = Boolean(value.requiresConfirmation) || hasMutation;

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    plan: {
      id: String(value.id),
      title: String(value.title),
      intent: String(value.intent),
      expectedImpact: String(value.expectedImpact),
      requiresConfirmation,
      actions: actions as AssistantAction[],
    },
  };
}

export function actionRequiresConfirmation(action: AssistantAction): boolean {
  return ACTION_KINDS.has(action.kind);
}

export function planRequiresConfirmation(plan: AssistantActionPlan): boolean {
  return plan.actions.length > 0 || plan.requiresConfirmation || plan.actions.some(actionRequiresConfirmation);
}

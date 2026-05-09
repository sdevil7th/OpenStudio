import { getAIWorkflow, mergeWorkflowParams } from "../data/aiWorkflows";
import { nativeBridge, type AIGenerationProgress } from "../services/NativeBridge";
import { getRegisteredActions } from "../store/actionRegistry";
import {
  type AITrackGenerationState,
  useDAWStore,
} from "../store/useDAWStore";
import {
  type AssistantAction,
  type AssistantActionPlan,
  planRequiresConfirmation,
} from "./actionSchema";

export interface AssistantExecutionStepResult {
  actionId: string;
  kind: AssistantAction["kind"];
  ok: boolean;
  result?: unknown;
  error?: string;
  summary?: string;
}

export interface AssistantExecutionResult {
  ok: boolean;
  steps: AssistantExecutionStepResult[];
  summary: string;
}

export interface AssistantExecutionOptions {
  confirmed?: boolean;
  onStep?: (step: AssistantExecutionStepResult) => void;
}

function formatPhaseLabel(phase?: string) {
  if (!phase) return "Preparing";
  return phase
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatProgressLabel(progress = 0) {
  return `${Math.max(0, Math.round(progress * 100))}%`;
}

function getDisplayState(progress: AIGenerationProgress): AITrackGenerationState {
  if (progress.state === "error") return "error";
  if (progress.state === "loading") return "loading";
  return "generating";
}

function progressToTrackUpdates(progress: AIGenerationProgress, fallbackBackend = "") {
  return {
    progress: progress.progress ?? 0,
    error: progress.error || "",
    phase: progress.phase,
    message:
      progress.message
      || `${formatPhaseLabel(progress.phase)} ${formatProgressLabel(progress.progress ?? 0)}`,
    backend: progress.backend || fallbackBackend,
    elapsedMs: progress.elapsedMs ?? 0,
    heartbeatTs: progress.heartbeatTs ?? 0,
    phaseProgress: progress.phaseProgress,
    etaMs: progress.etaMs,
    runMode: progress.runMode,
    runtimeProfile: progress.runtimeProfile,
    lmModel: progress.lmModel,
    statusNote: progress.statusNote,
    failureKind: progress.failureKind,
    sessionMode: progress.sessionMode,
    workerExitCode: progress.workerExitCode,
    lastStdoutLine: progress.lastStdoutLine,
    lastStderrLine: progress.lastStderrLine,
    attemptMode: progress.attemptMode,
    attemptIndex: progress.attemptIndex,
    protocolVersion: progress.protocolVersion,
    scriptVersion: progress.scriptVersion,
    requestId: progress.requestId,
    priorFailure: progress.priorFailure,
    lastProgressAgeMs: progress.lastProgressAgeMs,
    tracePath: progress.tracePath,
    failureDetail: progress.failureDetail,
    lmBackend: progress.lmBackend,
    lmStage: progress.lmStage,
  };
}

function getStringParam(params: Record<string, unknown>, key: string) {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

function getChainType(params: Record<string, unknown>) {
  const chainType = getStringParam(params, "chainType");
  return chainType === "input" ? "input" : "track";
}

function getTarget(params: Record<string, unknown>) {
  return getStringParam(params, "target") === "master" ? "master" : "track";
}

function getFxIndex(params: Record<string, unknown>) {
  const value = params.fxIndex;
  return typeof value === "number" && Number.isInteger(value) ? value : -1;
}

function getPluginType(params: Record<string, unknown>) {
  const value = getStringParam(params, "pluginType");
  return value === "builtin" || value === "s13fx" || value === "vst3" || value === "clap" || value === "lv2"
    ? value
    : "";
}

function summarizeAiToolsStatus(status: unknown) {
  if (!status || typeof status !== "object") return "AI tools status was refreshed.";
  const record = status as Record<string, unknown>;
  const assistantReady = Boolean(record.assistantRuntimeReady);
  const musicReady = Boolean(record.musicGenerationReady);
  const analyzerStatus = String(record.audioUnderstandingStatus ?? "not_installed");
  const analyzerMessage = String(record.audioUnderstandingStatusMessage ?? "");
  const analyzerProfile = String(record.audioUnderstandingSelectedProfile || record.audioUnderstandingPrefilterProfile || "");
  const parts = [
    `Qwen planner: ${assistantReady ? "verified" : "not verified"}`,
    `ACE-Step: ${musicReady ? "ready" : "not ready"}`,
    `core music analyzer: ${analyzerStatus.replace(/_/g, " ")}`,
  ];
  if (analyzerProfile) parts.push(`candidate/profile: ${analyzerProfile}`);
  if (analyzerMessage) parts.push(analyzerMessage);
  return parts.join(". ") + ".";
}

function summarizeOpenSetupResult(result: unknown) {
  const record =
    result && typeof result === "object" && "status" in result
      ? ((result as Record<string, unknown>).status as Record<string, unknown> | undefined)
      : result && typeof result === "object"
        ? (result as Record<string, unknown>)
        : undefined;
  if (!record) return "AI Tools Setup opened. Setup is still pending.";

  const plannerReady = Boolean(record.assistantRuntimeReady);
  const analyzerReady = Boolean(record.audioUnderstandingRuntimeReady);
  const analyzerStatus = String(record.audioUnderstandingStatus || "not_installed").replace(/_/g, " ");
  const parts = [
    `Qwen planner: ${plannerReady ? "verified" : "pending"}`,
    `core music analyzer: ${analyzerReady ? "verified" : analyzerStatus}`,
  ];

  if (plannerReady && analyzerReady) {
    return `AI Tools Setup opened. ${parts.join(". ")}.`;
  }
  return `AI Tools Setup opened. Setup is still pending. ${parts.join(". ")}.`;
}

function summarizeStep(action: AssistantAction, result: unknown) {
  switch (action.kind) {
    case "ai.getRuntimeStatus":
      return summarizeAiToolsStatus(result);
    case "ai.openSetup":
      return summarizeOpenSetupResult(result);
    case "app.executeRegisteredAction":
      return `Ran OpenStudio action ${action.params.actionId}.`;
    case "plugin.listAvailable":
      if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        return `Found ${record.total ?? 0} available plugin entries.`;
      }
      return "Listed available plugins.";
    case "plugin.scan":
      return "Plugin scan completed.";
    case "plugin.add":
      return "Plugin was added to the requested chain.";
    case "plugin.openEditor":
      return "Plugin editor was opened.";
    case "plugin.bypass":
      return action.params.bypassed ? "Plugin was bypassed." : "Plugin was enabled.";
    case "plugin.remove":
      return "Plugin was removed.";
    case "plugin.reorder":
      return "Plugin was reordered.";
    case "plugin.listParameters":
      return Array.isArray(result) ? `Loaded ${result.length} plugin parameters.` : "Loaded plugin parameters.";
    case "plugin.loadPreset":
      return `Loaded plugin preset ${action.params.presetName}.`;
    default:
      return `${action.summary || action.kind} completed.`;
  }
}

async function executeAction(action: AssistantAction): Promise<unknown> {
  const store = useDAWStore.getState();

  switch (action.kind) {
    case "app.executeRegisteredAction": {
      const actionDef = getRegisteredActions().find((entry) => entry.id === action.params.actionId);
      if (!actionDef) {
        throw new Error(`OpenStudio action not found: ${action.params.actionId}`);
      }
      if (actionDef.canHandleShortcut && !actionDef.canHandleShortcut()) {
        throw new Error(`OpenStudio action is unavailable right now: ${actionDef.name}`);
      }
      actionDef.execute();
      return { actionId: actionDef.id, name: actionDef.name, category: actionDef.category };
    }

    case "ai.getRuntimeStatus": {
      return await store.refreshAiToolsStatus(true);
    }

    case "ai.openSetup": {
      store.openAiToolsSetup();
      const status = await store.refreshAiToolsStatus(true).catch(() => store.aiToolsStatus);
      return { opened: true, status };
    }

    case "ai.openContextGeneration": {
      const sourceTrack = store.tracks.find((entry) => entry.id === action.params.trackId);
      const sourceClip = sourceTrack?.clips.find((entry) => entry.id === action.params.clipId);
      if (!sourceTrack || !sourceClip) {
        throw new Error(`Selected audio clip not found: ${action.params.clipId}`);
      }

      store.openAIContextGeneration(
        sourceTrack.id,
        sourceClip.id,
        sourceClip.name,
        sourceClip.duration,
        sourceClip.startTime,
        sourceClip.filePath,
        sourceTrack.name,
      );
      return { opened: true, trackId: sourceTrack.id, clipId: sourceClip.id };
    }

    case "ai.createAITrack": {
      const workflowId = getStringParam(action.params, "workflowId") || "text-to-music";
      const workflow = getAIWorkflow(workflowId);
      const params =
        typeof action.params.params === "object" && action.params.params !== null
          ? action.params.params as Record<string, unknown>
          : {};
      const trackId = crypto.randomUUID();
      const trackName =
        getStringParam(action.params, "trackName")
        || `AI ${workflow.label}`;

      store.addTrack({
        id: trackId,
        name: trackName,
        type: "ai",
        inputType: "stereo",
        inputChannelCount: 2,
        icon: "ai",
        aiWorkflow: workflow.id,
        aiWorkflowParams: mergeWorkflowParams(workflow.id, params),
        aiGenerationState: "idle",
        aiGenerationProgress: 0,
        aiGenerationError: "",
        aiGenerationPhase: "",
        aiGenerationMessage: "",
        insertAfterTrackId: getStringParam(action.params, "insertAfterTrackId") || undefined,
      });
      store.selectTrack(trackId);
      return { trackId };
    }

    case "ai.setWorkflow": {
      store.setAITrackWorkflow(action.params.trackId, action.params.workflowId);
      return { trackId: action.params.trackId, workflowId: action.params.workflowId };
    }

    case "ai.setGenerationParams": {
      store.setAITrackParams(action.params.trackId, action.params.params);
      return { trackId: action.params.trackId };
    }

    case "ai.generateMusic": {
      const track = store.tracks.find((entry) => entry.id === action.params.trackId);
      if (!track || track.type !== "ai") {
        throw new Error(`AI track not found: ${action.params.trackId}`);
      }
      const workflowId = action.params.workflowId || track.aiWorkflow || "text-to-music";
      const params = mergeWorkflowParams(workflowId, {
        ...(track.aiWorkflowParams ?? {}),
        ...(action.params.params ?? {}),
      });

      store.setAITrackGenerationState(track.id, "loading", {
        progress: 0.01,
        error: "",
        phase: "starting",
        message: "Starting ACE-Step...",
        backend: "",
        elapsedMs: 0,
        heartbeatTs: 0,
        runMode: "cold",
        runtimeProfile: "openstudio-ace-split",
        lmModel: "",
        statusNote: "Started by assistant action plan.",
        failureKind: "",
        sessionMode: "persistent",
        workerExitCode: 0,
        lastStdoutLine: "",
        lastStderrLine: "",
        attemptMode: "native_split_graph",
        attemptIndex: 1,
        protocolVersion: 0,
        scriptVersion: "",
        requestId: "",
        priorFailure: "",
        lastProgressAgeMs: 0,
        tracePath: "",
        failureDetail: "",
        lmBackend: "",
        lmStage: "",
      });

      const result = await nativeBridge.startAIGeneration(track.id, workflowId, params);
      if (!result.started) {
        store.setAITrackGenerationState(track.id, "error", {
          progress: 0,
          error: result.error || "Failed to start AI generation.",
          phase: "start_failed",
          message: result.error || "Failed to start AI generation.",
        });
        throw new Error(result.error || "Failed to start AI generation.");
      }
      return { started: true, trackId: track.id, workflowId };
    }

    case "ai.cancelGeneration": {
      await nativeBridge.cancelAIGeneration();
      if (action.params.trackId) {
        store.setAITrackGenerationState(action.params.trackId, "idle");
      }
      return { cancelled: true };
    }

    case "ai.pollGeneration": {
      const progress = await nativeBridge.getAIGenerationProgress();
      if (action.params.trackId) {
        if (progress.state === "done") {
          store.setAITrackGenerationState(action.params.trackId, "idle");
        } else if (progress.state === "error") {
          store.setAITrackGenerationState(action.params.trackId, "error", {
            ...progressToTrackUpdates(progress),
            error: progress.error || progress.message || "Generation failed.",
          });
        } else if (progress.state !== "idle" && progress.state !== "cancelled") {
          store.setAITrackGenerationState(
            action.params.trackId,
            getDisplayState(progress),
            progressToTrackUpdates(progress),
          );
        }
      }
      return progress;
    }

    case "ai.insertGeneratedClip": {
      await store.addGeneratedAudioClip(
        action.params.trackId,
        action.params.filePath,
        action.params.startTime,
        action.params.clipName,
      );
      return { inserted: true, trackId: action.params.trackId };
    }

    case "plugin.scan": {
      const scanned = await nativeBridge.scanForPlugins();
      return { scanned };
    }

    case "plugin.listAvailable": {
      const [plugins, builtIns, s13fx] = await Promise.all([
        nativeBridge.getAvailablePlugins().catch(() => []),
        nativeBridge.getAvailableBuiltInFX().catch(() => []),
        nativeBridge.getAvailableS13FX().catch(() => []),
      ]);
      return {
        total: plugins.length + builtIns.length + s13fx.length,
        plugins,
        builtIns,
        s13fx,
      };
    }

    case "plugin.add": {
      const target = action.params.target;
      const chainType = action.params.chainType === "input" ? "input" : "track";
      const pluginId = action.params.pluginId;
      const pluginType = getPluginType(action.params);
      const openEditor = action.params.openEditor !== false;
      let ok = false;

      if (target === "master") {
        if (pluginType === "builtin") ok = await nativeBridge.addMasterBuiltInFX(pluginId);
        else if (pluginType === "s13fx") ok = await nativeBridge.addMasterS13FX(pluginId);
        else ok = await nativeBridge.addMasterFX(pluginId);
      } else {
        const trackId = action.params.trackId || "";
        if (!trackId) throw new Error("Track plugin add requires a trackId.");
        if (pluginType === "builtin") ok = await nativeBridge.addTrackBuiltInFX(trackId, pluginId, chainType === "input");
        else if (pluginType === "s13fx") ok = await nativeBridge.addTrackS13FX(trackId, pluginId, chainType === "input");
        else if (chainType === "input") ok = await nativeBridge.addTrackInputFX(trackId, pluginId, openEditor);
        else ok = await nativeBridge.addTrackFX(trackId, pluginId, openEditor);
      }
      if (!ok) throw new Error(`Failed to add plugin: ${pluginId}`);
      return { added: true, target, pluginId };
    }

    case "plugin.openEditor": {
      const target = getTarget(action.params);
      const fxIndex = getFxIndex(action.params);
      if (target === "master") {
        return { opened: await nativeBridge.openMasterFXEditor(fxIndex) };
      }
      return {
        opened: await nativeBridge.openPluginEditor(
          action.params.trackId || "",
          fxIndex,
          getChainType(action.params) === "input",
        ),
      };
    }

    case "plugin.bypass": {
      const target = action.params.target;
      const fxIndex = action.params.fxIndex;
      const bypassed = action.params.bypassed;
      if (target === "master") {
        return { bypassed: await nativeBridge.bypassMasterFX(fxIndex, bypassed) };
      }
      const isInputFX = action.params.chainType === "input";
      const ok = isInputFX
        ? await nativeBridge.bypassTrackInputFX(action.params.trackId || "", fxIndex, bypassed)
        : await nativeBridge.bypassTrackFX(action.params.trackId || "", fxIndex, bypassed);
      return { bypassed: ok };
    }

    case "plugin.remove": {
      const target = getTarget(action.params);
      const fxIndex = getFxIndex(action.params);
      if (target === "master") {
        return { removed: await nativeBridge.removeMasterFX(fxIndex) };
      }
      const isInputFX = getChainType(action.params) === "input";
      const ok = isInputFX
        ? await nativeBridge.removeTrackInputFX(action.params.trackId || "", fxIndex)
        : await nativeBridge.removeTrackFX(action.params.trackId || "", fxIndex);
      return { removed: ok };
    }

    case "plugin.reorder": {
      const isInputFX = action.params.chainType === "input";
      const ok = isInputFX
        ? await nativeBridge.reorderTrackInputFX(action.params.trackId, action.params.fromIndex, action.params.toIndex)
        : await nativeBridge.reorderTrackFX(action.params.trackId, action.params.fromIndex, action.params.toIndex);
      return { reordered: ok };
    }

    case "plugin.listParameters": {
      if (getTarget(action.params) === "master") {
        return [];
      }
      return await nativeBridge.getPluginParameters(
        action.params.trackId || "",
        getFxIndex(action.params),
        getChainType(action.params) === "input",
      );
    }

    case "plugin.loadPreset": {
      const ok = await nativeBridge.loadPluginPreset(
        action.params.trackId,
        action.params.fxIndex,
        action.params.chainType === "input",
        action.params.presetName,
      );
      return { loaded: ok, presetName: action.params.presetName };
    }

    default:
      throw new Error(`Unsupported assistant action: ${(action as AssistantAction).kind}`);
  }
}

export function summarizeAssistantExecutionResult(result: AssistantExecutionResult): string {
  if (result.steps.length === 0) return "No actions ran.";
  const failed = result.steps.find((step) => !step.ok);
  if (failed) {
    return `Stopped at ${failed.kind}: ${failed.error || "action failed"}`;
  }
  return result.steps
    .map((step) => step.summary)
    .filter((summary): summary is string => Boolean(summary))
    .join("\n");
}

export async function executeAssistantActionPlan(
  plan: AssistantActionPlan,
  options: AssistantExecutionOptions = {},
): Promise<AssistantExecutionResult> {
  if (planRequiresConfirmation(plan) && !options.confirmed) {
    throw new Error("Assistant action plan requires explicit user confirmation before execution.");
  }

  const steps: AssistantExecutionStepResult[] = [];
  for (const action of plan.actions) {
    try {
      const result = await executeAction(action);
      const summary = summarizeStep(action, result);
      const step = {
        actionId: action.id,
        kind: action.kind,
        ok: true,
        result,
        summary,
      };
      steps.push(step);
      options.onStep?.(step);
    } catch (error) {
      const step = {
        actionId: action.id,
        kind: action.kind,
        ok: false,
        error: error instanceof Error ? error.message : "Assistant action failed.",
      };
      steps.push(step);
      options.onStep?.(step);
      return { ok: false, steps, summary: summarizeAssistantExecutionResult({ ok: false, steps, summary: "" }) };
    }
  }

  return { ok: true, steps, summary: summarizeAssistantExecutionResult({ ok: true, steps, summary: "" }) };
}

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import classNames from "classnames";
import { Power, Sparkles, SlidersHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  ACE_STEP_MODEL_ID,
  type AIWorkflow,
  getAIWorkflow,
  getAiMusicModel,
  mergeWorkflowParams,
  resolveAiMusicModelId,
} from "../data/aiWorkflows";
import { nativeBridge, type AIGenerationProgress } from "../services/NativeBridge";
import {
  getEffectiveTrackHeight,
  type AITrackGenerationState,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";
import { ColorPicker } from "./ColorPicker";
import { FXChainPanel } from "./FXChainPanel";
import { AIWorkflowModal } from "./AIWorkflowModal";
import { Button, Knob } from "./ui";
import { automationToBackend } from "../store/automationParams";
import { TrackNameEditor } from "./TrackNameEditor";
import {
  TCP_HEADER_BUTTON_PAIR_CLASS,
  TCP_HEADER_PRIMARY_BUTTON_CLASS,
  TCP_HEADER_TOGGLE_BUTTON_CLASS,
} from "./tcpHeaderButtonStyles";

interface AITrackHeaderProps {
  track: Track;
  isSelected?: boolean;
}

function formatPhaseLabel(phase?: string) {
  if (!phase) {
    return "Preparing";
  }

  return phase
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatElapsedLabel(elapsedMs?: number) {
  if (!elapsedMs || elapsedMs <= 0) {
    return "";
  }

  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatProgressAgeLabel(ageMs?: number) {
  if (!ageMs || ageMs <= 0) {
    return "";
  }

  const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
  if (totalSeconds < 1) {
    return "<1s since progress";
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${seconds}s since progress`
    : `${seconds}s since progress`;
}

function sanitizeAiSetupMessage(message: string): string {
  const lowered = message.toLowerCase();
  if (
    lowered.includes("vendor_runtime")
    || lowered.includes("nodes_ace.py")
    || lowered.includes("folder_paths.py")
    || lowered.includes("ace-step diffusers dependencies")
  ) {
    return "ACE-Step runtime files are missing. Repair or reinstall ACE-Step Audio Generation setup.";
  }
  return message;
}

function formatRuntimeProfileLabel(profile?: string) {
  switch (profile) {
    case "ace-diffusers":
      return "ACE-Step Diffusers";
    default:
      return profile ? formatPhaseLabel(profile) : "";
  }
}

function formatLmModelLabel(lmModel?: string) {
  if (!lmModel) {
    return "";
  }
  if (lmModel === "auto") {
    return "Auto LM";
  }
  return lmModel;
}

function formatSessionModeLabel(sessionMode?: string) {
  switch (sessionMode) {
    case "persistent":
      return "Persistent session";
    case "oneshot-fallback":
      return "One-shot fallback";
    case "oneshot":
      return "One-shot";
    default:
      return sessionMode ? formatPhaseLabel(sessionMode) : "";
  }
}

function formatAttemptModeLabel(attemptMode?: string) {
  switch (attemptMode) {
    case "lm_dit":
      return "LM First";
    case "dit_only":
      return "Direct DiT";
    case "native_split_graph":
      return "Native Split Graph";
    case "ace_diffusers":
      return "ACE Diffusers";
    case "legacy_ace_wrapper":
      return "Legacy Wrapper";
    default:
      return attemptMode ? formatPhaseLabel(attemptMode) : "";
  }
}

function formatFailureKindLabel(failureKind?: string) {
  switch (failureKind) {
    case "native_asset_missing":
      return "Native asset missing";
    case "native_conditioning_failure":
      return "Native conditioning failure";
    case "native_sampling_failure":
      return "Native sampling failure";
    case "native_decode_failure":
      return "Native decode failure";
    default:
      return failureKind ? formatPhaseLabel(failureKind) : "";
  }
}

function formatProgressLabel(progress: number) {
  return `${Math.max(0, Math.round(progress * 100))}%`;
}

function getProgressWidth(progress: number) {
  return `${Math.max(4, Math.round(progress * 100))}%`;
}

function getDisplayState(
  progress: AIGenerationProgress,
): AITrackGenerationState {
  if (progress.state === "error") {
    return "error";
  }

  if (progress.state === "loading") {
    return "loading";
  }

  return "generating";
}

function getStatusHeadline(track: Track) {
  const workflow = getAIWorkflow(track.aiWorkflow, track.aiMusicModelId, "ai-track");

  if (workflow.available === false) {
    return workflow.availabilityNote || "Workflow unavailable";
  }

  if (track.aiGenerationState === "error" && track.aiGenerationError) {
    if (track.aiGenerationFailureKind === "worker_protocol") {
      return `Worker session failed to start: ${track.aiGenerationError}`;
    }
    if (track.aiGenerationFailureKind === "decode_stalled") {
      return `Decode stalled: ${track.aiGenerationError}`;
    }
    if (track.aiGenerationFailureKind === "native_conditioning_failure") {
      return `ACE-Step conditioning failed: ${track.aiGenerationError}`;
    }
    return track.aiGenerationError;
  }

  if (track.aiGenerationState === "loading" || track.aiGenerationState === "generating") {
    return track.aiGenerationMessage
      || `${formatPhaseLabel(track.aiGenerationPhase)} ${formatProgressLabel(track.aiGenerationProgress ?? 0)}`;
  }

  return "Ready to generate";
}

function getStatusMeta(track: Track) {
  if (track.aiGenerationState === "error") {
    const parts = [
      track.aiGenerationFailureKind === "worker_protocol"
        ? "Worker protocol failure"
        : track.aiGenerationFailureKind === "decode_stalled"
          ? "Decode stalled"
          : formatFailureKindLabel(track.aiGenerationFailureKind),
      track.aiGenerationPhase
        ? `Last phase: ${formatPhaseLabel(track.aiGenerationPhase)}`
        : "Generation failed",
      track.aiGenerationSessionMode
        ? formatSessionModeLabel(track.aiGenerationSessionMode)
        : "",
      track.aiGenerationAttemptMode
        ? formatAttemptModeLabel(track.aiGenerationAttemptMode)
        : "",
      track.aiGenerationLmStage
        ? `LM stage: ${formatPhaseLabel(track.aiGenerationLmStage)}`
        : "",
      track.aiGenerationAttemptIndex && track.aiGenerationAttemptIndex > 1
        ? `Attempt ${track.aiGenerationAttemptIndex}`
        : "",
      formatProgressAgeLabel(track.aiGenerationLastProgressAgeMs),
      track.aiGenerationWorkerExitCode
        ? `Exit ${track.aiGenerationWorkerExitCode}`
        : "",
    ].filter(Boolean);

    return parts.join(" · ");
  }

  if (track.aiGenerationState === "loading" || track.aiGenerationState === "generating") {
    const parts = [
      track.aiGenerationRunMode ? track.aiGenerationRunMode.toUpperCase() : "",
      track.aiGenerationBackend
        ? track.aiGenerationBackend.toUpperCase()
        : "",
      track.aiGenerationSessionMode
        ? formatSessionModeLabel(track.aiGenerationSessionMode)
        : "",
      track.aiGenerationAttemptMode
        ? formatAttemptModeLabel(track.aiGenerationAttemptMode)
        : "",
      track.aiGenerationLmStage
        ? `LM stage: ${formatPhaseLabel(track.aiGenerationLmStage)}`
        : "",
      track.aiGenerationAttemptIndex && track.aiGenerationAttemptIndex > 1
        ? `Attempt ${track.aiGenerationAttemptIndex}`
        : "",
      formatElapsedLabel(track.aiGenerationElapsedMs),
      (track.aiGenerationLastProgressAgeMs ?? 0) >= 10000
        ? formatProgressAgeLabel(track.aiGenerationLastProgressAgeMs)
        : "",
      formatRuntimeProfileLabel(track.aiGenerationRuntimeProfile),
      formatLmModelLabel(track.aiGenerationLmModel),
    ].filter(Boolean);

    return parts.length > 0 ? parts.join(" • ") : "Worker active";
  }

  return track.aiGenerationBackend
    ? `Last backend: ${track.aiGenerationBackend.toUpperCase()}`
    : "Audio Generation idle";
}

function formatHeaderParamValue(key: string, value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (key === "duration" || key === "extension_duration") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${Math.round(numeric)}s` : "";
  }

  if (key === "bpm") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${Math.round(numeric)} BPM` : "";
  }

  if (key === "inferenceSteps" || key === "steps") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${Math.round(numeric)} steps` : "";
  }

  return String(value);
}

function getHeaderParamChips(workflow: AIWorkflow, params: Record<string, unknown>) {
  const priority = [
    "bpm",
    "duration",
    "extension_duration",
    "keyscale",
    "timesignature",
    "inferenceSteps",
    "steps",
  ];

  return priority
    .map((key) => {
      if (!workflow.params.some((param) => param.key === key)) return null;
      const text = formatHeaderParamValue(key, params[key]);
      return text ? { key, text } : null;
    })
    .filter((chip): chip is { key: string; text: string } => Boolean(chip))
    .slice(0, 3);
}

export const AITrackHeader = React.memo(function AITrackHeader({
  track,
  isSelected,
}: AITrackHeaderProps) {
  const {
    updateTrack,
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackFXBypass,
    setTrackVolume,
    setTrackPan,
    beginTrackVolumeEdit,
    commitTrackVolumeEdit,
    beginTrackPanEdit,
    commitTrackPanEdit,
    setAITrackModel,
    setAITrackWorkflow,
    setAITrackParams,
    setAITrackGenerationState,
    addGeneratedAudioClip,
    trackHeight,
    aiToolsStatus,
    openAiToolsSetup,
    autoValues,
    meterLevel,
  } = useDAWStore(
    useShallow((state) => ({
      updateTrack: state.updateTrack,
      toggleTrackMute: state.toggleTrackMute,
      toggleTrackSolo: state.toggleTrackSolo,
      toggleTrackFXBypass: state.toggleTrackFXBypass,
      setTrackVolume: state.setTrackVolume,
      setTrackPan: state.setTrackPan,
      beginTrackVolumeEdit: state.beginTrackVolumeEdit,
      commitTrackVolumeEdit: state.commitTrackVolumeEdit,
      beginTrackPanEdit: state.beginTrackPanEdit,
      commitTrackPanEdit: state.commitTrackPanEdit,
      setAITrackModel: state.setAITrackModel,
      setAITrackWorkflow: state.setAITrackWorkflow,
      setAITrackParams: state.setAITrackParams,
      setAITrackGenerationState: state.setAITrackGenerationState,
      addGeneratedAudioClip: state.addGeneratedAudioClip,
      trackHeight: state.trackHeight,
      aiToolsStatus: state.aiToolsStatus,
      openAiToolsSetup: state.openAiToolsSetup,
      autoValues: state.automatedParamValues[track.id],
      meterLevel: state.meterLevels[track.id] ?? 0,
    })),
  );

  const colorBarRef = useRef<HTMLDivElement>(null);
  const pollTimeoutRef = useRef<number | null>(null);
  const pollActiveRef = useRef(false);
  const generationStartTimeRef = useRef<number | null>(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [showFXChain, setShowFXChain] = useState(false);
  const modelId = resolveAiMusicModelId(track.aiMusicModelId);
  const model = getAiMusicModel(modelId);
  const workflow = getAIWorkflow(track.aiWorkflow, modelId, "ai-track");
  const workflowParams = mergeWorkflowParams(workflow.id, track.aiWorkflowParams, modelId);
  const headerParamChips = getHeaderParamChips(workflow, workflowParams);
  const isBusy =
    track.aiGenerationState === "loading"
    || track.aiGenerationState === "generating";
  const selectedModelStatus = aiToolsStatus.musicModels?.[modelId];
  const canStartMusicGeneration =
    workflow.available !== false
    && Boolean(
      selectedModelStatus?.ready
      ?? (
        modelId === ACE_STEP_MODEL_ID
          ? (
              aiToolsStatus.features?.audioGeneration?.ready
              ?? (
                aiToolsStatus.musicGenerationReady
                && aiToolsStatus.musicGenerationLayoutValid
              )
            )
          : false
      ),
    );
  const musicGenerationBlockedMessage = sanitizeAiSetupMessage(
    selectedModelStatus?.message
    || selectedModelStatus?.blockReason
    || aiToolsStatus.features?.audioGeneration?.message
    || aiToolsStatus.musicGenerationPerformanceStatusMessage
    || aiToolsStatus.musicGenerationStatusMessage
    || (!aiToolsStatus.musicGenerationLayoutValid
      && aiToolsStatus.musicGenerationModelId
      && aiToolsStatus.musicGenerationCheckpointRoot
        ? `Pinned ACE-Step native asset layout is not ready in ${aiToolsStatus.musicGenerationCheckpointRoot}.`
        : aiToolsStatus.error
          || aiToolsStatus.message
          || "Audio Generation is not ready yet."),
  );

  const stopPolling = () => {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    pollActiveRef.current = false;
  };

  const scheduleNextPoll = (startTime: number) => {
    stopPolling();
    pollTimeoutRef.current = window.setTimeout(() => {
      void pollGeneration(startTime);
    }, 250);
  };

  const applyProgressUpdate = async (
    progress: AIGenerationProgress,
    startTime: number,
  ) => {
    if (progress.state === "error") {
      stopPolling();
      generationStartTimeRef.current = null;
      setAITrackGenerationState(track.id, "error", {
        progress: progress.progress ?? 0,
        error: progress.error || progress.message || "Generation failed.",
        phase: progress.phase,
        message: progress.message || progress.error || "Generation failed.",
        backend: progress.backend || track.aiGenerationBackend || "",
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
      });
      return;
    }

    if (progress.state === "cancelled") {
      stopPolling();
      generationStartTimeRef.current = null;
      setAITrackGenerationState(track.id, "idle");
      return;
    }

    if (progress.state === "done") {
      stopPolling();
      generationStartTimeRef.current = null;

      if (!progress.outputFile) {
        setAITrackGenerationState(track.id, "error", {
          progress: progress.progress ?? 1,
          error: "Generation finished without producing an audio file.",
          phase: progress.phase || "done",
          message: progress.message || "Generation finished without producing an audio file.",
          backend: progress.backend || track.aiGenerationBackend || "",
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
        });
        return;
      }

      try {
        await addGeneratedAudioClip(track.id, progress.outputFile, startTime);
        setAITrackGenerationState(track.id, "idle");
        setShowParams(false);
      } catch (error) {
        setAITrackGenerationState(track.id, "error", {
          progress: progress.progress ?? 1,
          error:
            error instanceof Error
              ? error.message
              : "Audio rendered, but the generated clip could not be imported.",
          phase: "import_failed",
          message: "Audio rendered, but clip import failed.",
          backend: progress.backend || track.aiGenerationBackend || "",
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
        });
      }
      return;
    }

    setAITrackGenerationState(track.id, getDisplayState(progress), {
      progress: progress.progress ?? 0,
      error: "",
      phase: progress.phase,
      message:
        progress.message
        || `${formatPhaseLabel(progress.phase)} ${formatProgressLabel(progress.progress ?? 0)}`,
      backend: progress.backend || track.aiGenerationBackend || "",
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
    });

    scheduleNextPoll(startTime);
  };

  const pollGeneration = async (startTime: number) => {
    if (pollActiveRef.current) {
      return;
    }

    pollActiveRef.current = true;

    try {
      const progress = await nativeBridge.getAIGenerationProgress();
      await applyProgressUpdate(progress, startTime);
    } catch (error) {
      stopPolling();
      generationStartTimeRef.current = null;
      setAITrackGenerationState(track.id, "error", {
        progress: 0,
        error: error instanceof Error ? error.message : "Generation failed.",
        phase: "poll_failed",
        message: "The app lost contact with the generation worker.",
        tracePath: "",
        failureDetail: "",
        lmBackend: "",
        lmStage: "",
      });
    } finally {
      pollActiveRef.current = false;
    }
  };

  useEffect(() => {
    if (!isBusy) {
      stopPolling();
    }

    return stopPolling;
  }, [isBusy]);

  const handleGenerate = async () => {
    if (isBusy) {
      await nativeBridge.cancelAIGeneration();
      stopPolling();
      generationStartTimeRef.current = null;
      setAITrackGenerationState(track.id, "idle");
      return;
    }

    const startTime = useDAWStore.getState().transport.currentTime;
    const workflowId = workflow.id;
    const params = { ...(track.aiWorkflowParams ?? {}) };

    if (workflow.available === false) {
      setAITrackGenerationState(track.id, "error", {
        progress: 0,
        error:
          workflow.availabilityNote
          || "This workflow is not currently available in OpenStudio.",
        phase: "workflow_unavailable",
        message:
          workflow.availabilityNote
          || "This workflow is not currently available in OpenStudio.",
        tracePath: "",
        failureDetail: "",
        lmBackend: "",
        lmStage: "",
      });
      return;
    }

    if (!canStartMusicGeneration) {
      setAITrackGenerationState(track.id, "error", {
        progress: 0,
        error: musicGenerationBlockedMessage,
        phase: "runtime_blocked",
        message: musicGenerationBlockedMessage,
        tracePath: "",
        failureDetail: "",
        lmBackend: "",
        lmStage: "",
      });
      openAiToolsSetup("audioGeneration");
      return;
    }

    generationStartTimeRef.current = startTime;
    setAITrackGenerationState(track.id, "loading", {
      progress: 0.01,
      error: "",
      phase: "starting",
      message: `Starting ${model.shortLabel}...`,
      backend: "",
      elapsedMs: 0,
      heartbeatTs: 0,
      phaseProgress: undefined,
      etaMs: undefined,
      runMode: "cold",
      runtimeProfile: "ace-diffusers",
      lmModel: "",
      statusNote: "",
      failureKind: "",
      sessionMode: "persistent",
      workerExitCode: 0,
      lastStdoutLine: "",
      lastStderrLine: "",
      attemptMode: "ace_diffusers",
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

    try {
      const result = await nativeBridge.startAIGeneration(
        track.id,
        modelId,
        workflowId,
        params,
      );

      if (!result.started) {
        generationStartTimeRef.current = null;
        setAITrackGenerationState(track.id, "error", {
          progress: 0,
          error: result.error || "Failed to start AI generation.",
          phase: "start_failed",
          message: result.error || "Failed to start AI generation.",
          tracePath: "",
          failureDetail: "",
          lmBackend: "",
          lmStage: "",
        });
        return;
      }

      void pollGeneration(startTime);
    } catch (error) {
      stopPolling();
      generationStartTimeRef.current = null;
      setAITrackGenerationState(track.id, "error", {
        progress: 0,
        error: error instanceof Error ? error.message : "Generation failed.",
        phase: "start_failed",
        message: "Failed to start AI generation.",
        tracePath: "",
        failureDetail: "",
        lmBackend: "",
        lmStage: "",
      });
    }
  };

  const statusHeadline = getStatusHeadline(track);
  const statusMeta = getStatusMeta(track);
  const hasBypassableFx = track.inputFxCount + track.trackFxCount > 0;
  const hasFx = hasBypassableFx;
  const fxBypassTitle = hasFx
    ? track.fxBypassed
      ? "Enable FX"
      : "Bypass FX"
    : "No FX loaded";
  const formatVolume = (db: number) =>
    db <= -60 ? "-inf dB" : `${db.toFixed(1)} dB`;
  const formatPan = (pan: number) => {
    if (Math.abs(pan) < 0.005) return "C";
    return pan > 0
      ? `R${Math.round(Math.abs(pan * 100))}`
      : `L${Math.round(Math.abs(pan * 100))}`;
  };
  const meterHeight = `${Math.min(100, meterLevel > 0.001 ? Math.max(0, (20 * Math.log10(meterLevel) + 60) / 72) * 100 : 0)}%`;
  const meterColor = (() => {
    const dbNorm =
      meterLevel > 0.001
        ? Math.max(0, (20 * Math.log10(meterLevel) + 60) / 72)
        : 0;
    if (dbNorm > 0.92) return "#ef4444";
    if (dbNorm > 0.85) return "#facc15";
    return "#16a34a";
  })();

  return (
    <>
      <div
        className={`flex flex-col border-b border-neutral-900 relative overflow-hidden box-border ${isSelected ? "bg-neutral-700" : "bg-neutral-800"}`}
        style={{ height: getEffectiveTrackHeight(track, trackHeight) }}
      >
        <div className="flex shrink-0 overflow-hidden" style={{ height: trackHeight }}>
          <div
            ref={colorBarRef}
            onClick={() => setShowColorPicker(true)}
            className="w-2 shrink-0 cursor-pointer hover:brightness-125 transition-all relative group/color"
            style={{ background: track.color || "#666" }}
            title="Click to change track color"
            data-color-bar
            data-no-select
            data-no-drag
          >
            <div className="absolute inset-0 bg-white/20 opacity-0 group-hover/color:opacity-100 transition-opacity" />
          </div>
          {showColorPicker &&
            createPortal(
              <ColorPicker
                currentColor={track.color}
                anchorRef={colorBarRef}
                onColorChange={(color) => {
                  updateTrack(track.id, { color });
                  setShowColorPicker(false);
                }}
                onClose={() => setShowColorPicker(false)}
              />,
              document.body,
            )}

          <div className="flex-1 min-w-0 px-2 py-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 content-center">
              <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-300">
                <Sparkles size={11} />
                AI
              </span>

              <TrackNameEditor
                trackId={track.id}
                name={track.name}
                placeholder="AI Track Name"
                className="min-w-[56px] flex-1 basis-20"
                inputClassName="w-full min-w-0"
              />

              <Button
                variant="primary"
                size="icon-sm"
                shape="square"
                active={showParams}
                onClick={() => setShowParams(true)}
                title="Open AI generation parameters"
                aria-label="Open AI generation parameters"
                className="shrink-0"
                data-no-drag
                data-no-select
              >
                <SlidersHorizontal size={13} />
              </Button>

              <span
                className="flex items-center gap-1 shrink-0"
                data-no-drag
                data-no-select
              >
                <Knob
                  variant="volume"
                  size="sm"
                  min={-60}
                  max={12}
                  value={
                    autoValues?.volume !== undefined
                      ? automationToBackend("volume", autoValues.volume)
                      : track.volumeDB
                  }
                  defaultValue={0}
                  onChange={(value) => setTrackVolume(track.id, value)}
                  onBeginEdit={() => beginTrackVolumeEdit(track.id)}
                  onCommitEdit={() => commitTrackVolumeEdit(track.id)}
                  formatValue={formatVolume}
                  label="Volume"
                />
                <Knob
                  variant="pan"
                  size="sm"
                  min={-1}
                  max={1}
                  value={
                    autoValues?.pan !== undefined
                      ? automationToBackend("pan", autoValues.pan)
                      : track.pan
                  }
                  defaultValue={0}
                  onChange={(value) => setTrackPan(track.id, value)}
                  onBeginEdit={() => beginTrackPanEdit(track.id)}
                  onCommitEdit={() => commitTrackPanEdit(track.id)}
                  formatValue={formatPan}
                  label="Pan"
                  bipolarCenter={0}
                />
              </span>

              <span className="flex gap-px">
                <Button
                  variant="default"
                  size="icon-sm"
                  shape="square"
                  active={Boolean(track.muted)}
                  onClick={() => toggleTrackMute(track.id)}
                  title={track.muted ? "Unmute track" : "Mute track"}
                  aria-label={track.muted ? "Unmute track" : "Mute track"}
                  className="rounded-l"
                >
                  M
                </Button>
                <Button
                  variant="warning"
                  size="icon-sm"
                  shape="square"
                  active={Boolean(track.soloed)}
                  onClick={() => toggleTrackSolo(track.id)}
                  title={track.soloed ? "Unsolo track" : "Solo track"}
                  aria-label={track.soloed ? "Unsolo track" : "Solo track"}
                >
                  S
                </Button>
              </span>

              <span
                data-tcp-pair="fx"
                className={classNames(TCP_HEADER_BUTTON_PAIR_CLASS, "shrink-0")}
              >
                <Button
                  variant="default"
                  size="icon-sm"
                  shape="square"
                  onClick={() => setShowFXChain(true)}
                  title="FX Chain"
                  className={classNames(
                    TCP_HEADER_PRIMARY_BUTTON_CLASS,
                    hasBypassableFx && track.fxBypassed
                      ? "text-red-400! border-red-500! shadow-[0_0_6px_rgba(239,68,68,0.4)]"
                      : hasFx
                        ? "text-green-400! border-green-500! shadow-[0_0_6px_rgba(34,197,94,0.4)]"
                        : "hover:text-green-500 hover:border-green-500",
                  )}
                >
                  FX
                </Button>
                <Button
                  variant="default"
                  size="icon-xs"
                  shape="square"
                  onClick={() => {
                    if (!hasBypassableFx) {
                      setShowFXChain(true);
                    } else {
                      toggleTrackFXBypass(track.id);
                    }
                  }}
                  title={fxBypassTitle}
                  className={classNames(
                    TCP_HEADER_TOGGLE_BUTTON_CLASS,
                    hasBypassableFx && track.fxBypassed
                      ? "text-red-400! border-red-500!"
                      : hasFx
                        ? "text-green-400! border-green-500!"
                        : "hover:text-green-500 hover:border-green-500",
                  )}
                >
                  <Power size={10} strokeWidth={2.5} />
                </Button>
              </span>
            </div>

            <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-[10px]">
              <button
                type="button"
                onClick={() => setShowParams(true)}
                className="min-w-0 max-w-[180px] shrink rounded border border-neutral-700 bg-neutral-900/80 px-2 py-0.5 text-left text-[10px] uppercase tracking-[0.1em] text-daw-text-muted hover:border-cyan-500/70 hover:text-cyan-200"
                title={`${model.label} - ${workflow.label}`}
                data-no-drag
                data-no-select
              >
                <span className="block truncate">
                  {model.shortLabel} / {workflow.label}
                </span>
              </button>
              {headerParamChips.map((chip) => (
                <span
                  key={chip.key}
                  className="hidden shrink-0 rounded-full border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-daw-text-muted sm:inline-flex"
                  title={chip.text}
                >
                  {chip.text}
                </span>
              ))}
              <span
                className={classNames(
                  "min-w-[48px] flex-1 truncate",
                  track.aiGenerationState === "error"
                    ? "text-red-300"
                    : isBusy
                      ? "text-cyan-200"
                      : "text-neutral-400",
                )}
                title={isBusy || track.aiGenerationState === "error" ? `${statusHeadline} - ${statusMeta}` : statusMeta}
              >
                {isBusy || track.aiGenerationState === "error" ? statusHeadline : "Ready"}
              </span>
            </div>

            {isBusy ? (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 min-w-0 flex-1 rounded-full bg-neutral-900">
                  <div
                    className="h-1.5 rounded-full bg-cyan-400 transition-all duration-200"
                    style={{ width: getProgressWidth(track.aiGenerationProgress ?? 0) }}
                  />
                </div>
                <span className="shrink-0 text-[10px] tabular-nums text-daw-text-muted">
                  {formatProgressLabel(track.aiGenerationProgress ?? 0)}
                </span>
              </div>
            ) : null}
          </div>

          <div className="w-2 shrink-0 border-l border-neutral-800 bg-neutral-900 pt-1 mr-1 flex flex-col-reverse">
            <div
              className={classNames("w-full transition-all duration-75", meterLevel > 0.01 && "animate-pulse")}
              style={{
                height: meterHeight,
                background: `linear-gradient(to top, ${meterColor}, ${meterColor})`,
              }}
            />
          </div>
        </div>
      </div>

      {showFXChain && (
        <FXChainPanel
          trackId={track.id}
          trackName={track.name}
          chainType="track"
          onClose={() => setShowFXChain(false)}
        />
      )}

      <AIWorkflowModal
        track={track}
        aiToolsStatus={aiToolsStatus}
        isOpen={showParams}
        onClose={() => setShowParams(false)}
        onGenerate={handleGenerate}
        onCancel={async () => {
          await nativeBridge.cancelAIGeneration();
          stopPolling();
          generationStartTimeRef.current = null;
          setAITrackGenerationState(track.id, "idle");
        }}
        onOpenAiToolsSetup={openAiToolsSetup}
        onModelChange={(nextModelId) => setAITrackModel(track.id, nextModelId)}
        onWorkflowChange={(workflowId) => setAITrackWorkflow(track.id, workflowId)}
        onParamsChange={(params) => setAITrackParams(track.id, params)}
      />
    </>
  );
});

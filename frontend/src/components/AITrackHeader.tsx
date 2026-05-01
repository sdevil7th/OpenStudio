import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import classNames from "classnames";
import { Sparkles, SlidersHorizontal, Wand2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { AI_WORKFLOWS, getAIWorkflow } from "../data/aiWorkflows";
import { nativeBridge, type AIGenerationProgress } from "../services/NativeBridge";
import {
  getEffectiveTrackHeight,
  type AITrackGenerationState,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";
import { ColorPicker } from "./ColorPicker";
import { AIWorkflowModal } from "./AIWorkflowModal";
import { Button, Input, Select } from "./ui";
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

function formatEtaLabel(etaMs?: number) {
  if (!etaMs || etaMs <= 0) {
    return "";
  }

  const totalSeconds = Math.max(0, Math.floor(etaMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s left` : `${seconds}s left`;
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

function formatRuntimeProfileLabel(profile?: string) {
  switch (profile) {
    case "native-xl-turbo":
    case "openstudio-ace-split":
      return "OpenStudio ACE Split";
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
  if (lmModel.endsWith(".safetensors")) {
    return lmModel
      .replace("qwen_", "Qwen ")
      .replace("_ace15.safetensors", "")
      .replace("_", " ")
      .replace("b", "B");
  }
  return lmModel.replace("acestep-5Hz-lm-", "LM ");
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
  const workflow = getAIWorkflow(track.aiWorkflow);

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
      track.aiGenerationFailureKind === "decode_stalled"
        ? ""
        : formatEtaLabel(track.aiGenerationEtaMs),
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
    : "Music generation idle";
}

export const AITrackHeader = React.memo(function AITrackHeader({
  track,
  isSelected,
}: AITrackHeaderProps) {
  const {
    updateTrack,
    toggleTrackMute,
    setAITrackWorkflow,
    setAITrackParams,
    setAITrackGenerationState,
    addGeneratedAudioClip,
    trackHeight,
    aiToolsStatus,
    openAiToolsSetup,
  } = useDAWStore(
    useShallow((state) => ({
      updateTrack: state.updateTrack,
      toggleTrackMute: state.toggleTrackMute,
      setAITrackWorkflow: state.setAITrackWorkflow,
      setAITrackParams: state.setAITrackParams,
      setAITrackGenerationState: state.setAITrackGenerationState,
      addGeneratedAudioClip: state.addGeneratedAudioClip,
      trackHeight: state.trackHeight,
      aiToolsStatus: state.aiToolsStatus,
      openAiToolsSetup: state.openAiToolsSetup,
    })),
  );

  const colorBarRef = useRef<HTMLDivElement>(null);
  const pollTimeoutRef = useRef<number | null>(null);
  const pollActiveRef = useRef(false);
  const generationStartTimeRef = useRef<number | null>(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const workflow = getAIWorkflow(track.aiWorkflow);
  const isBusy =
    track.aiGenerationState === "loading"
    || track.aiGenerationState === "generating";
  const canStartMusicGeneration =
    workflow.available !== false
    && aiToolsStatus.musicGenerationReady
    && aiToolsStatus.musicGenerationLayoutValid
    && (aiToolsStatus.musicGenerationPerformanceReady ?? true);
  const musicGenerationBlockedMessage =
    aiToolsStatus.musicGenerationPerformanceStatusMessage
    || aiToolsStatus.musicGenerationStatusMessage
    || (!aiToolsStatus.musicGenerationLayoutValid
      && aiToolsStatus.musicGenerationModelId
      && aiToolsStatus.musicGenerationCheckpointRoot
        ? `Pinned ACE-Step native asset layout is not ready in ${aiToolsStatus.musicGenerationCheckpointRoot}.`
        : aiToolsStatus.error
          || aiToolsStatus.message
          || "AI music generation is not ready yet.");

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
    const workflowId = track.aiWorkflow ?? "text-to-music";
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

    if (
      !aiToolsStatus.musicGenerationReady
      || !aiToolsStatus.musicGenerationLayoutValid
      || !(aiToolsStatus.musicGenerationPerformanceReady ?? true)
    ) {
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
      openAiToolsSetup();
      return;
    }

    generationStartTimeRef.current = startTime;
    setAITrackGenerationState(track.id, "loading", {
      progress: 0.01,
      error: "",
      phase: "starting",
      message: "Starting ACE-Step...",
      backend: "",
      elapsedMs: 0,
      heartbeatTs: 0,
      phaseProgress: undefined,
      etaMs: undefined,
      runMode: "cold",
      runtimeProfile: "openstudio-ace-split",
      lmModel: "",
      statusNote: "",
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

    try {
      const result = await nativeBridge.startAIGeneration(
        track.id,
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

          <div className="flex-1 min-w-0 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">
                <Sparkles size={11} />
                AI
              </span>
              <div className="min-w-0 flex-1" data-no-drag data-no-select>
                <Select
                  value={track.aiWorkflow ?? "text-to-music"}
                  onChange={(value) => setAITrackWorkflow(track.id, String(value))}
                  options={AI_WORKFLOWS.map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                    disabled: entry.available === false,
                  }))}
                  size="sm"
                  fullWidth
                />
              </div>
              <Button
                variant={isBusy ? "danger" : "primary"}
                size="sm"
                onClick={() => void handleGenerate()}
                disabled={!canStartMusicGeneration && !isBusy}
                data-no-drag
                data-no-select
                className="shrink-0"
              >
                <Wand2 size={12} />
                {isBusy ? "Cancel" : "Generate"}
              </Button>
            </div>

            <div className="mt-1.5">
              <Input
                type="text"
                variant="inline"
                size="sm"
                value={track.name}
                onChange={(event) => updateTrack(track.id, { name: event.target.value })}
                placeholder="AI Track Name"
                inputClassName="w-full min-w-0"
              />
            </div>

            <div className="mt-1.5 flex items-start gap-2">
              <span
                className={classNames(
                  TCP_HEADER_BUTTON_PAIR_CLASS,
                  "shrink-0",
                )}
              >
                <Button
                  variant="default"
                  size="icon-sm"
                  shape="square"
                  active={Boolean(track.muted)}
                  onClick={() => toggleTrackMute(track.id)}
                  title={track.muted ? "Unmute track" : "Mute track"}
                  aria-label={track.muted ? "Unmute track" : "Mute track"}
                  className={TCP_HEADER_PRIMARY_BUTTON_CLASS}
                  data-no-drag
                  data-no-select
                >
                  M
                </Button>
                <Button
                  variant="default"
                  size="icon-sm"
                  shape="square"
                  active={showParams}
                  onClick={() => setShowParams(true)}
                  title="Open AI parameters"
                  aria-label="Open AI parameters"
                  className={TCP_HEADER_TOGGLE_BUTTON_CLASS}
                  data-no-drag
                  data-no-select
                >
                  <SlidersHorizontal size={12} />
                </Button>
              </span>

              <div className="min-w-0 flex-1">
                <div
                  className={classNames(
                    "truncate text-[11px] leading-4",
                    track.aiGenerationState === "error"
                      ? "text-red-300"
                      : "text-daw-text",
                  )}
                  title={statusHeadline}
                >
                  {statusHeadline}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-daw-text-muted">
                  {track.aiGenerationBackend ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-1.5 py-0.5 text-[9px] text-daw-text">
                      {track.aiGenerationBackend.toUpperCase()}
                    </span>
                  ) : null}
                  {track.aiGenerationRunMode ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-1.5 py-0.5 text-[9px] text-daw-text">
                      {track.aiGenerationRunMode.toUpperCase()}
                    </span>
                  ) : null}
                  <span className="truncate" title={statusMeta}>
                    {statusMeta}
                  </span>
                </div>
              </div>
            </div>

            {isBusy ? (
              <div className="mt-1.5 space-y-1">
                <div className="h-1.5 w-full rounded-full bg-neutral-900">
                  <div
                    className="h-1.5 rounded-full bg-cyan-400 transition-all duration-200"
                    style={{
                      width: getProgressWidth(track.aiGenerationProgress ?? 0),
                    }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-daw-text-muted">
                  <span className="truncate">{formatPhaseLabel(track.aiGenerationPhase)}</span>
                  <span>{formatProgressLabel(track.aiGenerationProgress ?? 0)}</span>
                </div>
                {track.aiGenerationStatusNote ? (
                  <div
                    className="text-[10px] leading-4 text-daw-text-muted"
                    title={track.aiGenerationStatusNote}
                  >
                    {track.aiGenerationStatusNote}
                  </div>
                ) : null}
                {track.aiGenerationPriorFailure ? (
                  <div
                    className="text-[10px] leading-4 text-daw-text-muted"
                    title={track.aiGenerationPriorFailure}
                  >
                    Prior failure: {track.aiGenerationPriorFailure}
                  </div>
                ) : null}
                {(track.aiGenerationLastProgressAgeMs ?? 0) >= 10000 ? (
                  <div className="text-[10px] leading-4 text-daw-text-muted">
                    {formatProgressAgeLabel(track.aiGenerationLastProgressAgeMs)}
                  </div>
                ) : null}
              </div>
            ) : null}
            {track.aiGenerationState === "error" ? (
              <div className="mt-1.5 space-y-1 text-[10px] leading-4 text-daw-text-muted">
                {track.aiGenerationFailureDetail ? (
                  <div title={track.aiGenerationFailureDetail}>
                    Detail: {track.aiGenerationFailureDetail}
                  </div>
                ) : null}
                {track.aiGenerationLmBackend ? (
                  <div title={track.aiGenerationLmBackend}>
                    LM backend: {track.aiGenerationLmBackend}
                  </div>
                ) : null}
                {track.aiGenerationLmStage ? (
                  <div title={track.aiGenerationLmStage}>
                    LM stage: {formatPhaseLabel(track.aiGenerationLmStage)}
                  </div>
                ) : null}
                {track.aiGenerationRequestId ? (
                  <div className="truncate" title={track.aiGenerationRequestId}>
                    Request: {track.aiGenerationRequestId}
                  </div>
                ) : null}
                {track.aiGenerationTracePath ? (
                  <div className="truncate" title={track.aiGenerationTracePath}>
                    Trace: {track.aiGenerationTracePath}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

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
        onWorkflowChange={(workflowId) => setAITrackWorkflow(track.id, workflowId)}
        onParamsChange={(params) => setAITrackParams(track.id, params)}
      />
    </>
  );
});

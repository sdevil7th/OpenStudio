import { useEffect, useMemo, useRef, useState } from "react";
import { Music2, Sparkles } from "lucide-react";
import { useShallow } from "zustand/shallow";
import {
  AI_WORKFLOWS,
  AI_WORKFLOW_SECTION_LABELS,
  type AIWorkflowParam,
  type AIWorkflowSection,
  getAIWorkflow,
  mergeWorkflowParams,
} from "../data/aiWorkflows";
import { nativeBridge, type AIGenerationProgress } from "../services/NativeBridge";
import {
  type AITrackGenerationState,
  useDAWStore,
} from "../store/useDAWStore";
import {
  AdvancedDisclosure,
  Button,
  Checkbox,
  FormGrid,
  FormSection,
  Input,
  Modal,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SliderField,
  StatusBanner,
  Textarea,
} from "./ui";

const CONTEXT_WORKFLOW_IDS = new Set([
  "reference-generate",
  "cover-remix",
  "repaint-edit",
]);

const PARAM_SECTION_ORDER: AIWorkflowSection[] = [
  "prompt",
  "source",
  "music",
  "sampling",
  "generation",
];

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

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00.000";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function formatOptionLabel(paramKey: string, option: string) {
  if (paramKey === "outputPlacement") {
    switch (option) {
      case "align-source":
        return "Align to source";
      case "playhead":
        return "At playhead";
      case "after-source":
        return "After source";
      case "custom":
        return "Custom time";
      default:
        return option;
    }
  }
  return option;
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

function buildContextDefaults(
  workflowId: string,
  context: {
    trackId: string;
    clipId: string;
    clipName: string;
    duration: number;
    startTime: number;
    filePath: string;
  },
  previous?: Record<string, unknown>,
) {
  return mergeWorkflowParams(workflowId, {
    ...(previous ?? {}),
    sourceTrackId: context.trackId,
    sourceClipId: context.clipId,
    sourceAudioPath: context.filePath,
    duration: context.duration || 30,
    repainting_start: 0,
    repainting_end: context.duration || 30,
    outputPlacement: previous?.outputPlacement ?? "align-source",
    customStartTime: previous?.customStartTime ?? context.startTime,
    prompt: previous?.prompt ?? "",
    lyrics: previous?.lyrics ?? "",
  });
}

function resolveOutputStartTime(params: Record<string, unknown>, clipStartTime: number, clipDuration: number) {
  const placement = String(params.outputPlacement ?? "align-source");
  if (placement === "playhead") {
    return Math.max(0, useDAWStore.getState().transport.currentTime);
  }
  if (placement === "after-source") {
    return Math.max(0, clipStartTime + clipDuration);
  }
  if (placement === "custom") {
    const parsed = Number(params.customStartTime ?? clipStartTime);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : clipStartTime;
  }
  return Math.max(0, clipStartTime);
}

function getWorkflowTrackName(workflowLabel: string, clipName: string) {
  const cleanClipName = (clipName || "Clip").replace(/\.[^.]+$/, "");
  return `AI ${workflowLabel} - ${cleanClipName}`;
}

export default function AIContextGenerationModal() {
  const {
    isOpen,
    sourceTrackId,
    sourceClipId,
    sourceClipName,
    sourceClipDuration,
    sourceClipStartTime,
    sourceClipFilePath,
    sourceTrackName,
    tracks,
    aiToolsStatus,
    closeAIContextGeneration,
    openAiToolsSetup,
    addTrack,
    setAITrackGenerationState,
    addGeneratedAudioClip,
    showToast,
  } = useDAWStore(
    useShallow((state) => ({
      isOpen: state.showAIContextGeneration,
      sourceTrackId: state.aiContextTrackId,
      sourceClipId: state.aiContextClipId,
      sourceClipName: state.aiContextClipName,
      sourceClipDuration: state.aiContextClipDuration,
      sourceClipStartTime: state.aiContextClipStartTime,
      sourceClipFilePath: state.aiContextClipFilePath,
      sourceTrackName: state.aiContextSourceTrackName,
      tracks: state.tracks,
      aiToolsStatus: state.aiToolsStatus,
      closeAIContextGeneration: state.closeAIContextGeneration,
      openAiToolsSetup: state.openAiToolsSetup,
      addTrack: state.addTrack,
      setAITrackGenerationState: state.setAITrackGenerationState,
      addGeneratedAudioClip: state.addGeneratedAudioClip,
      showToast: state.showToast,
    })),
  );

  const [workflowId, setWorkflowId] = useState("reference-generate");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [targetTrackId, setTargetTrackId] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [localError, setLocalError] = useState("");
  const pollTimeoutRef = useRef<number | null>(null);
  const pollActiveRef = useRef(false);
  const activeTrackIdRef = useRef<string | null>(null);

  const workflow = getAIWorkflow(workflowId);
  const targetTrack = useMemo(
    () => tracks.find((track) => track.id === targetTrackId),
    [targetTrackId, tracks],
  );
  const isBusy =
    isPreparing
    || targetTrack?.aiGenerationState === "loading"
    || targetTrack?.aiGenerationState === "generating";
  const isMusicGenerationReady = Boolean(
    aiToolsStatus.musicGenerationReady
    && aiToolsStatus.musicGenerationLayoutValid
    && (aiToolsStatus.musicGenerationPerformanceReady ?? true),
  );
  const blockedMessage =
    aiToolsStatus.musicGenerationPerformanceStatusMessage
    || aiToolsStatus.musicGenerationStatusMessage
    || aiToolsStatus.error
    || aiToolsStatus.message
    || "AI music generation is not ready yet.";

  const context = useMemo(
    () => ({
      trackId: sourceTrackId ?? "",
      clipId: sourceClipId ?? "",
      clipName: sourceClipName || "Audio Clip",
      duration: sourceClipDuration || 30,
      startTime: sourceClipStartTime || 0,
      filePath: sourceClipFilePath || "",
    }),
    [
      sourceTrackId,
      sourceClipId,
      sourceClipName,
      sourceClipDuration,
      sourceClipStartTime,
      sourceClipFilePath,
    ],
  );

  useEffect(() => {
    if (!isOpen || !sourceTrackId || !sourceClipId) return;
    setWorkflowId("reference-generate");
    setTargetTrackId(null);
    activeTrackIdRef.current = null;
    setLocalError("");
    setParams(buildContextDefaults("reference-generate", context));
  }, [context, isOpen, sourceClipId, sourceTrackId]);

  const stopPolling = () => {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    pollActiveRef.current = false;
  };

  useEffect(() => stopPolling, []);

  const schedulePoll = (trackId: string, startTime: number) => {
    stopPolling();
    pollTimeoutRef.current = window.setTimeout(() => {
      void pollGeneration(trackId, startTime);
    }, 250);
  };

  const applyProgressUpdate = async (
    trackId: string,
    progress: AIGenerationProgress,
    startTime: number,
  ) => {
    if (progress.state === "error") {
      stopPolling();
      activeTrackIdRef.current = null;
      setAITrackGenerationState(trackId, "error", {
        ...progressToTrackUpdates(progress),
        error: progress.error || progress.message || "Generation failed.",
        message: progress.message || progress.error || "Generation failed.",
      });
      setLocalError(progress.error || progress.message || "Generation failed.");
      return;
    }

    if (progress.state === "cancelled") {
      stopPolling();
      activeTrackIdRef.current = null;
      setAITrackGenerationState(trackId, "idle");
      return;
    }

    if (progress.state === "done") {
      stopPolling();
      activeTrackIdRef.current = null;
      if (!progress.outputFile) {
        const error = "Generation finished without producing an audio file.";
        setAITrackGenerationState(trackId, "error", {
          ...progressToTrackUpdates(progress),
          error,
          phase: progress.phase || "done",
          message: error,
        });
        setLocalError(error);
        return;
      }

      try {
        await addGeneratedAudioClip(
          trackId,
          progress.outputFile,
          startTime,
          `${workflow.label} - ${context.clipName}`,
        );
        setAITrackGenerationState(trackId, "idle");
        showToast("AI clip generated on a new track.", "success");
        closeAIContextGeneration();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Audio rendered, but the generated clip could not be imported.";
        setAITrackGenerationState(trackId, "error", {
          ...progressToTrackUpdates(progress),
          error: message,
          phase: "import_failed",
          message,
        });
        setLocalError(message);
      }
      return;
    }

    setAITrackGenerationState(trackId, getDisplayState(progress), {
      ...progressToTrackUpdates(progress),
      error: "",
    });
    schedulePoll(trackId, startTime);
  };

  const pollGeneration = async (trackId: string, startTime: number) => {
    if (pollActiveRef.current) return;
    pollActiveRef.current = true;

    try {
      const progress = await nativeBridge.getAIGenerationProgress();
      await applyProgressUpdate(trackId, progress, startTime);
    } catch (error) {
      stopPolling();
      activeTrackIdRef.current = null;
      const message = error instanceof Error ? error.message : "Generation failed.";
      setAITrackGenerationState(trackId, "error", {
        progress: 0,
        error: message,
        phase: "poll_failed",
        message: "The app lost contact with the generation worker.",
      });
      setLocalError(message);
    } finally {
      pollActiveRef.current = false;
    }
  };

  const handleWorkflowChange = (nextWorkflowId: string) => {
    setWorkflowId(nextWorkflowId);
    setLocalError("");
    setParams(buildContextDefaults(nextWorkflowId, context, params));
  };

  const handleParamChange = (key: string, value: unknown) => {
    setParams((previous) => ({
      ...previous,
      [key]: value,
    }));
  };

  const handleCancel = async () => {
    await nativeBridge.cancelAIGeneration();
    stopPolling();
    const activeTrackId = activeTrackIdRef.current;
    activeTrackIdRef.current = null;
    if (activeTrackId) {
      setAITrackGenerationState(activeTrackId, "idle");
    }
    setIsPreparing(false);
  };

  const handleClose = () => {
    if (isBusy) return;
    closeAIContextGeneration();
  };

  const handleGenerate = async () => {
    if (!sourceTrackId || !sourceClipId) {
      setLocalError("Select an audio clip before starting AI context generation.");
      return;
    }

    if (!isMusicGenerationReady) {
      setLocalError(blockedMessage);
      openAiToolsSetup();
      return;
    }

    if (workflow.available === false) {
      setLocalError(workflow.availabilityNote || "This workflow is not available.");
      return;
    }

    const outputStartTime = resolveOutputStartTime(
      params,
      sourceClipStartTime,
      sourceClipDuration,
    );
    const nextTrackId = crypto.randomUUID();
    setTargetTrackId(nextTrackId);
    activeTrackIdRef.current = nextTrackId;
    setLocalError("");
    setIsPreparing(true);

    try {
      let preparedAudioPath = "";
      let preparedDuration = sourceClipDuration;
      if (CONTEXT_WORKFLOW_IDS.has(workflowId)) {
        const contextResult = await nativeBridge.prepareAIClipContext(sourceTrackId, sourceClipId);
        if (!contextResult.success || !contextResult.filePath) {
          throw new Error(contextResult.error || "Could not prepare the selected clip for ACE-Step.");
        }
        preparedAudioPath = contextResult.filePath;
        preparedDuration = contextResult.duration || preparedDuration;
      }

      const finalParams = mergeWorkflowParams(workflowId, {
        ...params,
        sourceTrackId,
        sourceClipId,
        sourceAudioPath: preparedAudioPath || sourceClipFilePath,
        referenceAudioPath:
          workflowId === "reference-generate" ? preparedAudioPath : "",
        srcAudioPath:
          workflowId === "cover-remix" || workflowId === "repaint-edit"
            ? preparedAudioPath
            : "",
        duration: params.duration ?? preparedDuration,
        repainting_end:
          workflowId === "repaint-edit"
            ? params.repainting_end ?? preparedDuration
            : params.repainting_end,
        outputPlacement: params.outputPlacement,
        customStartTime: params.customStartTime,
      });

      addTrack({
        id: nextTrackId,
        name: getWorkflowTrackName(workflow.label, context.clipName),
        type: "ai",
        inputType: "stereo",
        inputChannelCount: 2,
        aiWorkflow: workflowId,
        aiWorkflowParams: finalParams,
        aiGenerationState: "idle",
        aiGenerationProgress: 0,
        aiGenerationError: "",
        aiGenerationPhase: "",
        aiGenerationMessage: "",
        aiGenerationBackend: "",
        aiGenerationElapsedMs: 0,
        aiGenerationHeartbeatTs: 0,
        aiGenerationRuntimeProfile: "",
        aiGenerationLmModel: "",
        aiGenerationStatusNote: "",
        aiGenerationFailureKind: "",
        aiGenerationSessionMode: "",
        aiGenerationWorkerExitCode: 0,
        aiGenerationLastStdoutLine: "",
        aiGenerationLastStderrLine: "",
        aiGenerationAttemptMode: "",
        aiGenerationAttemptIndex: 0,
        aiGenerationProtocolVersion: 0,
        aiGenerationScriptVersion: "",
        aiGenerationRequestId: "",
        aiGenerationPriorFailure: "",
        aiGenerationLastProgressAgeMs: 0,
        icon: "ai",
        insertAfterTrackId: sourceTrackId,
      });

      setAITrackGenerationState(nextTrackId, "loading", {
        progress: 0.01,
        error: "",
        phase: CONTEXT_WORKFLOW_IDS.has(workflowId) ? "preparing_context" : "starting",
        message: CONTEXT_WORKFLOW_IDS.has(workflowId)
          ? "Prepared the selected clip. Starting ACE-Step..."
          : "Starting ACE-Step...",
        backend: "",
        elapsedMs: 0,
        heartbeatTs: 0,
        runMode: "cold",
        runtimeProfile: CONTEXT_WORKFLOW_IDS.has(workflowId)
          ? "ace-step-inference"
          : "openstudio-ace-split",
        lmModel: "",
        statusNote: "",
        failureKind: "",
        sessionMode: "persistent",
        workerExitCode: 0,
        lastStdoutLine: "",
        lastStderrLine: "",
        attemptMode: CONTEXT_WORKFLOW_IDS.has(workflowId)
          ? "legacy_ace_wrapper"
          : "native_split_graph",
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

      const result = await nativeBridge.startAIGeneration(
        nextTrackId,
        workflowId,
        finalParams,
      );

      if (!result.started) {
        throw new Error(result.error || "Failed to start AI generation.");
      }

      setIsPreparing(false);
      void pollGeneration(nextTrackId, outputStartTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Generation failed.";
      setIsPreparing(false);
      setLocalError(message);
      setAITrackGenerationState(nextTrackId, "error", {
        progress: 0,
        error: message,
        phase: "start_failed",
        message,
      });
    }
  };

  const paramsBySection = useMemo(() => {
    return PARAM_SECTION_ORDER.map((section) => ({
      section,
      params: workflow.params.filter(
        (param) => param.section === section && !param.hidden,
      ),
    })).filter((group) => group.params.length > 0);
  }, [workflow.params]);

  const renderParam = (param: AIWorkflowParam) => {
    const value = params[param.key];

    if (param.type === "textarea") {
      return (
        <Textarea
          key={param.key}
          label={param.label}
          value={String(value ?? "")}
          onChange={(event) => handleParamChange(param.key, event.target.value)}
          placeholder={param.placeholder}
          helperText={param.description}
          rows={param.key === "lyrics" ? 8 : 5}
          fullWidth
        />
      );
    }

    if (param.type === "text" || param.type === "number") {
      return (
        <Input
          key={param.key}
          label={param.label}
          type={param.type === "number" ? "number" : "text"}
          value={String(value ?? "")}
          onChange={(event) =>
            handleParamChange(
              param.key,
              param.type === "number"
                ? Number(event.target.value)
                : event.target.value,
            )
          }
          placeholder={param.placeholder}
          helperText={param.description}
          min={param.min}
          max={param.max}
          step={param.step}
          unit={param.unit}
          size="sm"
          fullWidth
        />
      );
    }

    if (param.type === "slider") {
      const numericValue =
        typeof value === "number"
          ? value
          : Number(value ?? param.default ?? 0);
      return (
        <SliderField
          key={param.key}
          label={param.label}
          value={numericValue}
          min={param.min ?? 0}
          max={param.max ?? 100}
          step={param.step ?? 1}
          unit={param.unit}
          description={param.description}
          onChange={(nextValue) => handleParamChange(param.key, nextValue)}
        />
      );
    }

    if (param.type === "toggle") {
      return (
        <label
          key={param.key}
          className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950/70 px-3 py-2.5"
        >
          <span className="text-sm text-daw-text">{param.label}</span>
          <Checkbox
            checked={Boolean(value)}
            onChange={() => handleParamChange(param.key, !Boolean(value))}
          />
        </label>
      );
    }

    return (
      <Select
        key={param.key}
        label={param.label}
        value={String(value ?? "")}
        onChange={(nextValue) => handleParamChange(param.key, String(nextValue))}
        options={(param.options ?? []).map((option) => ({
          value: option,
          label: formatOptionLabel(param.key, option),
        }))}
        size="sm"
        fullWidth
      />
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="xl"
      closeOnEscape={!isBusy}
      closeOnOverlayClick={!isBusy}
    >
      <ModalHeader title="Generate with AI from Clip" />
      <ModalContent>
        <div className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <FormSection title="Source Context">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
                  <Music2 size={18} />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-daw-text">
                    {context.clipName}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
                    {sourceTrackName || "Source track"} at {formatTime(context.startTime)} for {formatTime(context.duration)}
                  </p>
                  {context.filePath ? (
                    <p className="mt-1 truncate text-[11px] text-daw-text-muted">
                      {context.filePath}
                    </p>
                  ) : null}
                </div>
              </div>
            </FormSection>

            <FormSection title="Mode">
              <Select
                label="Workflow"
                value={workflowId}
                onChange={(nextValue) => handleWorkflowChange(String(nextValue))}
                options={AI_WORKFLOWS.map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                  disabled: entry.available === false,
                }))}
                size="sm"
                fullWidth
              />
              <p className="mt-2 text-xs leading-5 text-daw-text-secondary">
                {workflow.description}
              </p>
            </FormSection>
          </div>

          <FormSection
            title="Output"
            description="The target track is fixed so generated context stays next to the source."
            meta={
              <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-300">
                <Sparkles size={11} />
                New AI track below source
              </span>
            }
          >
            <FormGrid>
              <Select
                label="Clip Placement"
                value={String(params.outputPlacement ?? "align-source")}
                onChange={(nextValue) => handleParamChange("outputPlacement", String(nextValue))}
                options={[
                  { value: "align-source", label: "Align to source" },
                  { value: "playhead", label: "At playhead" },
                  { value: "after-source", label: "After source" },
                  { value: "custom", label: "Custom time" },
                ]}
                size="sm"
                fullWidth
              />
              <Input
                label="Custom Start"
                type="number"
                value={String(params.customStartTime ?? context.startTime)}
                onChange={(event) => handleParamChange("customStartTime", Number(event.target.value))}
                disabled={params.outputPlacement !== "custom"}
                min={0}
                step={0.001}
                unit="s"
                size="sm"
                fullWidth
              />
            </FormGrid>
          </FormSection>

          {localError ? (
            <StatusBanner tone="danger" title="Generation issue">
              {localError}
            </StatusBanner>
          ) : null}

          {!isMusicGenerationReady ? (
            <StatusBanner tone="warning" title="AI tools are not ready">
              {blockedMessage}
            </StatusBanner>
          ) : null}

          {isPreparing ? (
            <StatusBanner tone="info" title="Preparing source clip">
              Rendering the selected clip's audible region into a temporary WAV for ACE-Step.
            </StatusBanner>
          ) : null}

          {targetTrack?.aiGenerationState === "loading"
            || targetTrack?.aiGenerationState === "generating" ? (
              <StatusBanner tone="info" title={formatPhaseLabel(targetTrack.aiGenerationPhase)}>
                <div className="space-y-3">
                  <p>{targetTrack.aiGenerationMessage || "AI generation is in progress."}</p>
                  <div className="h-2.5 w-full rounded-full bg-neutral-900">
                    <div
                      className="h-2.5 rounded-full bg-daw-accent transition-all duration-200"
                      style={{
                        width: `${Math.max(4, Math.round((targetTrack.aiGenerationProgress ?? 0) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              </StatusBanner>
            ) : null}

          {paramsBySection.map((group) => {
            const primaryParams = group.params.filter((param) => !param.advanced);
            const advancedParams = group.params.filter((param) => param.advanced);

            return (
              <FormSection
                key={group.section}
                title={AI_WORKFLOW_SECTION_LABELS[group.section]}
              >
                {primaryParams.length > 0 ? (
                  <FormGrid columns={group.section === "prompt" ? 1 : 2}>
                    {primaryParams.map(renderParam)}
                  </FormGrid>
                ) : null}
                {advancedParams.length > 0 ? (
                  <AdvancedDisclosure
                    title="Advanced"
                    className={primaryParams.length > 0 ? "mt-3" : undefined}
                  >
                    <FormGrid>
                      {advancedParams.map(renderParam)}
                    </FormGrid>
                  </AdvancedDisclosure>
                ) : null}
              </FormSection>
            );
          })}
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="secondary" onClick={handleClose} disabled={isBusy}>
          Close
        </Button>
        {isBusy ? (
          <Button variant="danger" onClick={() => void handleCancel()}>
            Cancel
          </Button>
        ) : (
          <>
            {!isMusicGenerationReady ? (
              <Button variant="secondary" onClick={openAiToolsSetup}>
                Open AI Tools Setup
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={() => void handleGenerate()}
              disabled={!isMusicGenerationReady || workflow.available === false}
            >
              Generate
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

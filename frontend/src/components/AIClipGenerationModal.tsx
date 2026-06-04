import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Music2, Settings2, WandSparkles } from "lucide-react";
import { useShallow } from "zustand/shallow";
import {
  ACE_STEP_MODEL_ID,
  AI_WORKFLOW_SECTION_LABELS,
  STABLE_AUDIO_3_MODEL_ID,
  type AIWorkflowParam,
  type AIWorkflowSection,
  getAIModelsForWorkflow,
  getAIWorkflow,
  getAiMusicModel,
  getClipInpaintRange,
  mergeWorkflowParams,
  normalizeWorkflowParams,
  resolveAiMusicModelId,
} from "../data/aiWorkflows";
import { nativeBridge, type AIGenerationProgress } from "../services/NativeBridge";
import { type AudioClip, useDAWStore } from "../store/useDAWStore";
import {
  Button,
  Checkbox,
  Input,
  Modal,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  Textarea,
} from "./ui";
import { NumericWorkflowParamField } from "./AIWorkflowParamField";

const SECTION_ORDER: AIWorkflowSection[] = [
  "prompt",
  "source",
  "sampling",
  "generation",
  "advanced",
];

const ADVANCED_SECTIONS = new Set<AIWorkflowSection>([
  "sampling",
  "generation",
  "advanced",
]);

const RANGE_PARAM_KEYS = new Set([
  "repainting_start",
  "repainting_end",
  "inpaint_start",
  "inpaint_end",
]);

const STABLE_SOURCE_WORKFLOW_IDS = new Set([
  "variation",
  "inpaint-selection",
  "continue-clip",
]);

export function buildAIClipGenerationRequestParams({
  params,
  modelId,
  sourceTrack,
  sourceClip,
  workflowRange,
  extensionDuration,
  transportTempo,
  timeSignature,
}: {
  params: Record<string, unknown>;
  modelId: string;
  sourceTrack: { id: string; name: string };
  sourceClip: AudioClip;
  workflowRange: { start: number; end: number } | null;
  extensionDuration: number;
  transportTempo: number;
  timeSignature: { numerator: number; denominator: number };
}) {
  const requestParams: Record<string, unknown> = { ...params };
  if (modelId === ACE_STEP_MODEL_ID) {
    requestParams.bpm = Math.round(Number.isFinite(transportTempo) ? transportTempo : 120);
    requestParams.timesignature = `${timeSignature.numerator}/${timeSignature.denominator}`;
  }

  return {
    ...requestParams,
    source: {
      filePath: sourceClip.filePath,
      clipOffset: sourceClip.offset || 0,
      clipDuration: sourceClip.duration,
      sourceTrackId: sourceTrack.id,
      sourceTrackName: sourceTrack.name,
      sourceClipId: sourceClip.id,
      sourceClipName: sourceClip.name,
      sourceClipStartTime: sourceClip.startTime,
      inpaintRange: workflowRange,
      extensionDuration,
    },
  };
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, seconds || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
}

function formatRange(range: { start: number; end: number } | null) {
  if (!range) return "No overlapping time selection";
  return `${range.start.toFixed(2)}s - ${range.end.toFixed(2)}s`;
}

function formatPhaseLabel(phase?: string) {
  if (!phase) return "Preparing";
  return phase
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatElapsedLabel(elapsedMs?: number) {
  if (!elapsedMs || elapsedMs <= 0) return "";
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s elapsed` : `${seconds}s elapsed`;
}

function formatRuntimeProfileLabel(profile?: string) {
  switch (profile) {
    case "ace-diffusers":
      return "ACE-Step Diffusers";
    default:
      return profile ? formatPhaseLabel(profile) : "";
  }
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

function progressWidth(progress?: number) {
  return `${Math.max(4, Math.round((progress ?? 0) * 100))}%`;
}

function shouldShowParam(workflowId: string, param: AIWorkflowParam) {
  if (workflowId === "variation") {
    return ![
      "extension_duration",
      "repainting_start",
      "repainting_end",
      "inpaint_start",
      "inpaint_end",
    ].includes(param.key);
  }

  if (workflowId === "inpaint-selection") {
    return !["extension_duration"].includes(param.key);
  }

  if (workflowId === "continue-clip") {
    return ![
      "duration",
      "repainting_start",
      "repainting_end",
      "inpaint_start",
      "inpaint_end",
    ].includes(param.key);
  }

  return true;
}

export default function AIClipGenerationModal() {
  const {
    showAIClipGeneration,
    aiClipGenerationTrackId,
    aiClipGenerationClipId,
    aiClipGenerationWorkflowId,
    aiClipGenerationModelId,
    aiClipGenerationParams,
    aiClipGenerationRange,
    aiClipGenerationError,
    tracks,
    transportTempo,
    timeSignature,
    aiToolsStatus,
    closeAIClipGeneration,
    setAIClipGenerationModel,
    setAIClipGenerationParams,
    setAIClipGenerationRange,
    setAIClipGenerationError,
    addGeneratedSourceAudioClip,
    openAiToolsSetup,
  } = useDAWStore(
    useShallow((state) => ({
      showAIClipGeneration: state.showAIClipGeneration,
      aiClipGenerationTrackId: state.aiClipGenerationTrackId,
      aiClipGenerationClipId: state.aiClipGenerationClipId,
      aiClipGenerationWorkflowId: state.aiClipGenerationWorkflowId,
      aiClipGenerationModelId: state.aiClipGenerationModelId,
      aiClipGenerationParams: state.aiClipGenerationParams,
      aiClipGenerationRange: state.aiClipGenerationRange,
      aiClipGenerationError: state.aiClipGenerationError,
      tracks: state.tracks,
      transportTempo: state.transport.tempo,
      timeSignature: state.timeSignature,
      aiToolsStatus: state.aiToolsStatus,
      closeAIClipGeneration: state.closeAIClipGeneration,
      setAIClipGenerationModel: state.setAIClipGenerationModel,
      setAIClipGenerationParams: state.setAIClipGenerationParams,
      setAIClipGenerationRange: state.setAIClipGenerationRange,
      setAIClipGenerationError: state.setAIClipGenerationError,
      addGeneratedSourceAudioClip: state.addGeneratedSourceAudioClip,
      openAiToolsSetup: state.openAiToolsSetup,
    })),
  );

  const [isGenerating, setIsGenerating] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [progress, setProgress] = useState<AIGenerationProgress>({ state: "idle", progress: 0 });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasGeneratingRef = useRef(false);

  const sourceTrack = useMemo(
    () => tracks.find((track) => track.id === aiClipGenerationTrackId),
    [aiClipGenerationTrackId, tracks],
  );
  const sourceClip = useMemo<AudioClip | undefined>(
    () => sourceTrack?.clips.find((clip) => clip.id === aiClipGenerationClipId),
    [aiClipGenerationClipId, sourceTrack],
  );
  const workflow = getAIWorkflow(
    aiClipGenerationWorkflowId,
    aiClipGenerationModelId,
    "clip-context",
  );
  const model = getAiMusicModel(aiClipGenerationModelId);
  const supportedModels = getAIModelsForWorkflow(workflow.id);
  const params = useMemo(
    () => mergeWorkflowParams(workflow.id, aiClipGenerationParams, aiClipGenerationModelId),
    [aiClipGenerationModelId, aiClipGenerationParams, workflow.id],
  );
  const selectedModelStatus = aiToolsStatus.musicModels?.[aiClipGenerationModelId];
  const isModelReady = Boolean(
    selectedModelStatus?.ready
    ?? (
      aiClipGenerationModelId === ACE_STEP_MODEL_ID
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
  const modelBlockedMessage =
    selectedModelStatus?.message
    || selectedModelStatus?.blockReason
    || aiToolsStatus.features?.audioGeneration?.message
    || aiToolsStatus.musicGenerationStatusMessage
    || aiToolsStatus.message
    || `${model.label} is not set up yet.`;

  const currentInpaintRange = sourceClip
    ? getClipInpaintRange(useDAWStore.getState().timeSelection, sourceClip)
    : null;

  useEffect(() => {
    if (!showAIClipGeneration || !sourceClip) return;

    const nextRange = workflow.id === "inpaint-selection" ? currentInpaintRange : null;
    const sameRange =
      (!nextRange && !aiClipGenerationRange)
      || (
        nextRange
        && aiClipGenerationRange
        && Math.abs(nextRange.start - aiClipGenerationRange.start) < 0.001
        && Math.abs(nextRange.end - aiClipGenerationRange.end) < 0.001
      );
    if (!sameRange) {
      setAIClipGenerationRange(nextRange);
    }

    const nextParams = {
      ...params,
      duration: sourceClip.duration,
      ...(nextRange
        ? {
            repainting_start: nextRange.start,
            repainting_end: nextRange.end,
            inpaint_start: nextRange.start,
            inpaint_end: nextRange.end,
          }
        : {}),
    };
    const normalized = normalizeWorkflowParams(workflow.id, nextParams, aiClipGenerationModelId);
    if (JSON.stringify(normalized) !== JSON.stringify(params)) {
      setAIClipGenerationParams(normalized);
    }
  }, [
    aiClipGenerationModelId,
    aiClipGenerationRange,
    currentInpaintRange,
    params,
    setAIClipGenerationParams,
    setAIClipGenerationRange,
    showAIClipGeneration,
    sourceClip,
    workflow.id,
  ]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  const paramsBySection = useMemo(() => {
    return SECTION_ORDER.map((section) => ({
      section,
      params: workflow.params.filter((param) => (
        param.section === section && shouldShowParam(workflow.id, param)
      )),
    })).filter((group) => group.params.length > 0);
  }, [workflow.id, workflow.params]);

  const primaryParamGroups = paramsBySection.filter((group) => !ADVANCED_SECTIONS.has(group.section));
  const advancedParamGroups = paramsBySection.filter((group) => ADVANCED_SECTIONS.has(group.section));
  const advancedControlCount = advancedParamGroups.reduce((count, group) => count + group.params.length, 0);
  const inpaintSelectionMissing = workflow.id === "inpaint-selection" && !aiClipGenerationRange;
  const stableSourcePromptMissing =
    aiClipGenerationModelId === STABLE_AUDIO_3_MODEL_ID
    && STABLE_SOURCE_WORKFLOW_IDS.has(workflow.id)
    && String(params.prompt ?? "").trim().length === 0;
  const progressChips = [
    progress.backend ? progress.backend.toUpperCase() : "",
    progress.runMode ? progress.runMode.toUpperCase() : "",
    formatSessionModeLabel(progress.sessionMode),
    formatRuntimeProfileLabel(progress.runtimeProfile),
  ].filter(Boolean);
  const hasProgressDetails = Boolean(
    progress.statusNote
    || progress.sourcePatternWarning
    || progressChips.length
    || progress.lastStderrLine
    || progress.lastStdoutLine,
  );

  const handleParamChange = (key: string, value: unknown) => {
    setAIClipGenerationParams(
      normalizeWorkflowParams(workflow.id, {
        ...params,
        [key]: value,
      }, aiClipGenerationModelId),
    );
  };

  const scrollStatusIntoView = () => {
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    if (isGenerating && !wasGeneratingRef.current) {
      scrollStatusIntoView();
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  const handleCancel = async () => {
    if (isGenerating) {
      completedRef.current = true;
      stopPolling();
      await nativeBridge.cancelAIGeneration();
      setIsGenerating(false);
      setProgress({ state: "idle", progress: 0 });
      return;
    }
    closeAIClipGeneration();
  };

  const handleGenerate = async () => {
    if (!sourceTrack || !sourceClip || !aiClipGenerationWorkflowId) {
      setAIClipGenerationError("Source clip is no longer available.");
      return;
    }
    if (!isModelReady) {
      openAiToolsSetup("audioGeneration");
      return;
    }
    if (stableSourcePromptMissing) {
      setAIClipGenerationError("Stable Audio source workflows need a direction prompt.");
      return;
    }
    if (inpaintSelectionMissing) {
      setAIClipGenerationError("Create a time selection that overlaps this clip before inpainting.");
      return;
    }

    completedRef.current = false;
    setIsGenerating(true);
    setProgress({ state: "loading", progress: 0.01, phase: "starting" });
    setAIClipGenerationError("");
    scrollStatusIntoView();

    const extensionDuration = Number(params.extension_duration ?? 20);
    const requestParams = buildAIClipGenerationRequestParams({
      params,
      modelId: aiClipGenerationModelId,
      sourceTrack,
      sourceClip,
      workflowRange: aiClipGenerationRange,
      extensionDuration,
      transportTempo,
      timeSignature,
    });

    try {
      const result = await nativeBridge.startAIGeneration(
        sourceTrack.id,
        aiClipGenerationModelId,
        workflow.id,
        requestParams,
      );

      if (!result.started) {
        setIsGenerating(false);
        setProgress({ state: "error", progress: 0, error: result.error });
        setAIClipGenerationError(result.error || "Failed to start AI generation.");
        return;
      }

      let idleCount = 0;
      pollRef.current = setInterval(async () => {
        if (completedRef.current) return;
        const nextProgress = await nativeBridge.getAIGenerationProgress();
        if (completedRef.current) return;
        setProgress(nextProgress);

        if (nextProgress.state === "idle") {
          idleCount += 1;
          if (idleCount >= 10) {
            completedRef.current = true;
            stopPolling();
            setIsGenerating(false);
            setAIClipGenerationError("Generation did not start. Open AI Tools Setup and check the selected model.");
          }
          return;
        }
        idleCount = 0;

        if (nextProgress.state === "done") {
          completedRef.current = true;
          stopPolling();
          setIsGenerating(false);
          if (!nextProgress.outputFile) {
            setAIClipGenerationError("Generation finished without producing an audio file.");
            return;
          }
          await addGeneratedSourceAudioClip({
            sourceTrackId: sourceTrack.id,
            sourceClipId: sourceClip.id,
            workflowId: workflow.id,
            filePath: nextProgress.outputFile,
            extensionDuration,
          });
          setTimeout(() => closeAIClipGeneration(), 500);
        } else if (nextProgress.state === "error") {
          completedRef.current = true;
          stopPolling();
          setIsGenerating(false);
          setAIClipGenerationError(nextProgress.error || nextProgress.message || "Generation failed.");
        } else if (nextProgress.state === "cancelled") {
          completedRef.current = true;
          stopPolling();
          setIsGenerating(false);
        }
      }, 250);
    } catch (error) {
      stopPolling();
      setIsGenerating(false);
      setAIClipGenerationError(error instanceof Error ? error.message : "Generation failed.");
    }
  };

  const renderParam = (param: AIWorkflowParam) => {
    const value = params[param.key];
    const isRangeParam = RANGE_PARAM_KEYS.has(param.key);

    if (param.type === "textarea") {
      return (
        <Textarea
          key={param.key}
          label={param.label}
          value={String(value ?? "")}
          onChange={(event) => handleParamChange(param.key, event.target.value)}
          placeholder={param.placeholder}
          rows={param.key === "lyrics" ? 7 : 4}
          fullWidth
        />
      );
    }

    if (param.type === "slider" || (param.type === "number" && param.min !== undefined && param.max !== undefined)) {
      return (
        <NumericWorkflowParamField
          key={param.key}
          param={param}
          value={value}
          disabled={isRangeParam}
          onChange={(nextValue) => handleParamChange(param.key, nextValue)}
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
              param.type === "number" ? Number(event.target.value) : event.target.value,
            )
          }
          placeholder={param.placeholder}
          disabled={isRangeParam}
          size="sm"
          fullWidth
        />
      );
    }

    if (param.type === "toggle") {
      return (
        <label
          key={param.key}
          className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950/70 px-3 py-2.5"
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
          label: option,
        }))}
        size="sm"
        fullWidth
      />
    );
  };

  const renderParamGroup = (group: { section: AIWorkflowSection; params: AIWorkflowParam[] }) => (
    <section
      key={group.section}
      className="rounded border border-neutral-800 bg-neutral-950/50 p-4"
    >
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">
        {AI_WORKFLOW_SECTION_LABELS[group.section]}
      </p>
      <div
        className={
          group.section === "prompt"
            ? "space-y-3"
            : "grid grid-cols-1 gap-3 md:grid-cols-2"
        }
      >
        {group.params.map(renderParam)}
      </div>
    </section>
  );

  if (!showAIClipGeneration) return null;

  const rangeSummary = workflow.id === "inpaint-selection"
    ? formatRange(aiClipGenerationRange)
    : workflow.id === "continue-clip"
      ? `${formatDuration(Number(params.extension_duration ?? 20))} tail`
      : "Full clip duration";

  return (
    <Modal isOpen={showAIClipGeneration} onClose={() => void handleCancel()} size="xl">
      <ModalHeader title={workflow.label} onClose={() => void handleCancel()} />
      <ModalContent ref={contentRef}>
        <div className="space-y-4">
          <section className="rounded border border-neutral-800 bg-neutral-950/60 p-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-daw-text-muted">
                    <WandSparkles size={12} />
                    Source audio
                  </span>
                  {isModelReady ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-700/40 bg-green-950/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-green-300">
                      <CheckCircle2 size={12} />
                      Ready
                    </span>
                  ) : null}
                </div>
                <p className="mt-3 text-sm leading-6 text-daw-text-secondary">{workflow.description}</p>
                <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.16em] text-daw-text-muted">Source Clip</p>
                    <p className="mt-1 truncate text-daw-text" title={sourceClip?.name}>
                      {sourceClip?.name || "Audio"}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.16em] text-daw-text-muted">Source Track</p>
                    <p className="mt-1 truncate text-daw-text" title={sourceTrack?.name}>
                      {sourceTrack?.name || "Track"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-daw-text-muted">Clip Duration</p>
                    <p className="mt-1 text-daw-text">{formatDuration(sourceClip?.duration ?? 0)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-daw-text-muted">Range</p>
                    <p className="mt-1 text-daw-text">{rangeSummary}</p>
                  </div>
                </div>
              </div>

              <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <Select
                  label="Model"
                  value={aiClipGenerationModelId}
                  onChange={(value) => setAIClipGenerationModel(resolveAiMusicModelId(String(value)))}
                  options={supportedModels.map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                  }))}
                  size="sm"
                  fullWidth
                />
                <div className="rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.16em] text-daw-text-muted">Workflow</p>
                  <p className="mt-1 flex items-center gap-2 text-sm text-daw-text">
                    <Music2 size={14} />
                    {workflow.label}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {model.attribution ? (
            <div className="rounded border border-neutral-800 bg-neutral-950/50 px-4 py-2 text-xs text-daw-text-secondary">
              {model.attribution}
            </div>
          ) : null}

          {!isModelReady ? (
            <div className="rounded border border-yellow-700/40 bg-yellow-950/20 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 shrink-0 text-yellow-300" size={20} />
                <div>
                  <p className="text-sm font-semibold text-yellow-200">{model.shortLabel} needs setup</p>
                  <p className="mt-1 text-sm leading-6 text-daw-text-secondary">{modelBlockedMessage}</p>
                  <Button className="mt-3" variant="secondary" size="sm" onClick={() => openAiToolsSetup("audioGeneration")}>
                    Set Up {model.shortLabel}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {inpaintSelectionMissing ? (
            <div className="rounded border border-yellow-700/40 bg-yellow-950/20 px-4 py-3 text-sm text-yellow-100">
              Create a time selection that overlaps this clip before using Inpaint Selection.
            </div>
          ) : null}

          {stableSourcePromptMissing ? (
            <div className="rounded border border-yellow-700/40 bg-yellow-950/20 px-4 py-3 text-sm text-yellow-100">
              Stable Audio source workflows need a direction prompt. Describe how the source should change or continue.
            </div>
          ) : null}

          {aiClipGenerationError ? (
            <div className="rounded border border-red-700/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">
              {aiClipGenerationError}
            </div>
          ) : null}

          {isGenerating ? (
            <div className="rounded border border-cyan-800/50 bg-cyan-950/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-daw-text">
                    {formatPhaseLabel(progress.phase)}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
                    {progress.message || `${workflow.label} is running.`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-daw-text-muted">
                  <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                    {Math.round((progress.progress ?? 0) * 100)}%
                  </span>
                  {progress.elapsedMs ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {formatElapsedLabel(progress.elapsedMs)}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="mt-3 h-2.5 w-full rounded-full bg-neutral-900">
                <div
                  className="h-2.5 rounded-full bg-daw-accent transition-all duration-200"
                  style={{ width: progressWidth(progress.progress) }}
                />
              </div>
              {hasProgressDetails ? (
                <div className="mt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDetailsOpen((value) => !value)}
                    icon={<ChevronDown size={14} />}
                  >
                    {detailsOpen ? "Hide details" : "Show details"}
                  </Button>
                  {detailsOpen ? (
                    <div className="mt-3 space-y-2 rounded border border-neutral-800 bg-black/30 p-3">
                      {progress.statusNote ? (
                        <p className="text-xs leading-5 text-daw-text-secondary">{progress.statusNote}</p>
                      ) : null}
                      {progress.sourcePatternWarning ? (
                        <p className="text-xs leading-5 text-amber-300">{progress.sourcePatternWarning}</p>
                      ) : null}
                      {progressChips.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {progressChips.map((chip) => (
                            <span
                              key={chip}
                              className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-daw-text-muted"
                            >
                              {chip}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {progress.lastStderrLine ? <p className="break-all text-xs text-daw-text-muted">{progress.lastStderrLine}</p> : null}
                      {progress.lastStdoutLine ? <p className="break-all text-xs text-daw-text-muted">{progress.lastStdoutLine}</p> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-4">
            {primaryParamGroups.map(renderParamGroup)}
            {advancedControlCount > 0 ? (
              <section className="rounded border border-neutral-800 bg-neutral-950/50 p-4">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 text-left"
                  onClick={() => setAdvancedOpen((value) => !value)}
                >
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">
                    <Settings2 size={14} />
                    Advanced
                  </span>
                  <span className="inline-flex items-center gap-2 text-xs text-daw-text-muted">
                    {advancedControlCount} controls
                    <ChevronDown
                      size={15}
                      className={advancedOpen ? "rotate-180 transition-transform" : "transition-transform"}
                    />
                  </span>
                </button>
                {advancedOpen ? (
                  <div className="mt-4 space-y-4">
                    {advancedParamGroups.map((group) => (
                      <div key={group.section}>
                        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">
                          {AI_WORKFLOW_SECTION_LABELS[group.section]}
                        </p>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          {group.params.map(renderParam)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="ghost" onClick={() => void handleCancel()}>
          {isGenerating ? "Cancel" : "Close"}
        </Button>
        {!isGenerating ? (
          <Button
            variant={isModelReady ? "primary" : "secondary"}
            onClick={() => void handleGenerate()}
            disabled={!sourceClip || (isModelReady && (inpaintSelectionMissing || stableSourcePromptMissing))}
          >
            {isModelReady ? "Generate" : `Set Up ${model.shortLabel}`}
          </Button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}

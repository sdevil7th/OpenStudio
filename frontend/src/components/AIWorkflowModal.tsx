import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Settings2, Sparkles } from "lucide-react";
import { type AiFeatureId, type AiToolsStatus } from "../services/NativeBridge";
import { type Track } from "../store/useDAWStore";
import {
  ACE_STEP_MODEL_ID,
  AI_MUSIC_MODELS,
  AI_WORKFLOW_SECTION_LABELS,
  type AIWorkflowParam,
  type AiMusicModelId,
  type AIWorkflowSection,
  getAIWorkflow,
  getAIWorkflowsForSurface,
  getAiMusicModel,
  mergeWorkflowParams,
  resolveAiMusicModelId,
} from "../data/aiWorkflows";
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

interface AIWorkflowModalProps {
  track: Track;
  aiToolsStatus: AiToolsStatus;
  isOpen: boolean;
  onClose: () => void;
  onGenerate: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onOpenAiToolsSetup: (requestedFeature?: AiFeatureId) => void;
  onModelChange: (modelId: AiMusicModelId) => void;
  onWorkflowChange: (workflowId: string) => void;
  onParamsChange: (params: Record<string, unknown>) => void;
  onBeginParamsEdit?: () => void;
  onCommitParamsEdit?: () => void;
}

const SECTION_ORDER: AIWorkflowSection[] = [
  "prompt",
  "source",
  "music",
  "sampling",
  "generation",
  "advanced",
];

const ADVANCED_SECTIONS = new Set<AIWorkflowSection>([
  "sampling",
  "generation",
  "advanced",
]);

function formatProgressLabel(progress: number) {
  return `${Math.max(0, Math.round(progress * 100))}%`;
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

function formatOptionLabel(paramKey: string, option: string) {
  if (paramKey === "runtimeProfile") {
    return formatRuntimeProfileLabel(option);
  }
  return option;
}

function progressWidth(progress?: number) {
  return `${Math.max(4, Math.round((progress ?? 0) * 100))}%`;
}

function getDetailChips(track: Track) {
  return [
    track.aiGenerationBackend ? track.aiGenerationBackend.toUpperCase() : "",
    track.aiGenerationRunMode ? track.aiGenerationRunMode.toUpperCase() : "",
    formatSessionModeLabel(track.aiGenerationSessionMode),
    formatRuntimeProfileLabel(track.aiGenerationRuntimeProfile),
    formatLmModelLabel(track.aiGenerationLmModel),
  ].filter(Boolean);
}

export function AIWorkflowModal({
  track,
  aiToolsStatus,
  isOpen,
  onClose,
  onGenerate,
  onCancel,
  onOpenAiToolsSetup,
  onModelChange,
  onWorkflowChange,
  onParamsChange,
  onBeginParamsEdit,
  onCommitParamsEdit,
}: AIWorkflowModalProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasBusyRef = useRef(false);
  const modelId = resolveAiMusicModelId(track.aiMusicModelId);
  const model = getAiMusicModel(modelId);
  const workflow = getAIWorkflow(track.aiWorkflow, modelId, "ai-track");
  const workflows = getAIWorkflowsForSurface("ai-track", modelId);
  const params = useMemo(
    () => mergeWorkflowParams(workflow.id, track.aiWorkflowParams, modelId),
    [modelId, track.aiWorkflowParams, workflow.id],
  );
  const isBusy =
    track.aiGenerationState === "loading"
    || track.aiGenerationState === "generating";
  const selectedModelStatus = aiToolsStatus.musicModels?.[modelId];
  const isMusicGenerationReady = Boolean(
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
  const musicGenerationBlockedMessage = !isMusicGenerationReady
    ? (selectedModelStatus?.message
      || selectedModelStatus?.blockReason
      || aiToolsStatus.features?.audioGeneration?.message
      || aiToolsStatus.musicGenerationPerformanceStatusMessage
      || aiToolsStatus.musicGenerationStatusMessage
      || aiToolsStatus.error
      || aiToolsStatus.message
      || `${model.label} is not set up yet.`)
    : "";
  const canSubmitGeneration =
    workflow.available !== false && isMusicGenerationReady && !isBusy;

  const paramsBySection = useMemo(() => {
    return SECTION_ORDER.map((section) => ({
      section,
      params: workflow.params.filter((param) => param.section === section),
    })).filter((group) => group.params.length > 0);
  }, [workflow.params]);

  const primaryParamGroups = paramsBySection.filter((group) => !ADVANCED_SECTIONS.has(group.section));
  const advancedParamGroups = paramsBySection.filter((group) => ADVANCED_SECTIONS.has(group.section));
  const advancedControlCount = advancedParamGroups.reduce((count, group) => count + group.params.length, 0);
  const detailChips = getDetailChips(track);
  const hasErrorDetails = Boolean(
    track.aiGenerationPhase
    || track.aiGenerationSessionMode
    || track.aiGenerationWorkerExitCode
    || track.aiGenerationStatusNote
    || track.aiGenerationLastStderrLine
    || track.aiGenerationLastStdoutLine,
  );
  const runningDetails = Boolean(detailChips.length || track.aiGenerationStatusNote);

  const handleParamChange = (key: string, value: unknown) => {
    const nextParams = {
      ...params,
      [key]: value,
    };
    onParamsChange(nextParams);
  };

  const scrollStatusIntoView = () => {
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    if (isBusy && !wasBusyRef.current) {
      scrollStatusIntoView();
    }
    wasBusyRef.current = isBusy;
  }, [isBusy]);

  const handleGenerateClick = () => {
    scrollStatusIntoView();
    void onGenerate();
  };

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
          rows={param.key === "lyrics" ? 10 : 6}
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
          onChange={(nextValue) => handleParamChange(param.key, nextValue)}
          onBeginEdit={onBeginParamsEdit}
          onCommitEdit={onCommitParamsEdit}
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
          label: formatOptionLabel(param.key, option),
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

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader title="AI Generation" onClose={onClose} />
      <ModalContent ref={contentRef}>
        <div className="space-y-4">
          <section className="rounded border border-neutral-800 bg-neutral-950/60 p-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-daw-text-muted">
                    <Sparkles size={12} />
                    AI track
                  </span>
                  {isMusicGenerationReady ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-700/40 bg-green-950/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-green-300">
                      <CheckCircle2 size={12} />
                      Ready
                    </span>
                  ) : null}
                </div>
                <h3 className="mt-3 truncate text-lg font-semibold text-daw-text" title={track.name}>
                  {track.name}
                </h3>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-daw-text-secondary">
                  {workflow.description}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <Select
                  label="Model"
                  value={modelId}
                  onChange={(value) => onModelChange(resolveAiMusicModelId(String(value)))}
                  options={AI_MUSIC_MODELS.map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                  }))}
                  size="sm"
                  fullWidth
                />
                <Select
                  label="Workflow"
                  value={workflow.id}
                  onChange={(value) => onWorkflowChange(String(value))}
                  options={workflows.map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                    disabled: entry.available === false,
                  }))}
                  size="sm"
                  fullWidth
                />
              </div>
            </div>
          </section>

          {model.attribution ? (
            <div className="rounded border border-neutral-800 bg-neutral-950/50 px-4 py-2 text-xs text-daw-text-secondary">
              {model.attribution}
            </div>
          ) : null}

          {workflow.available === false ? (
            <div className="rounded border border-yellow-700/40 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-200">
              {workflow.availabilityNote
                ?? "This workflow is not available in the current OpenStudio build."}
            </div>
          ) : null}

          {!isMusicGenerationReady ? (
            <div className="rounded border border-yellow-700/40 bg-yellow-950/20 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 shrink-0 text-yellow-300" size={20} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-yellow-200">{model.shortLabel} needs setup</p>
                  <p className="mt-1 text-sm leading-6 text-daw-text-secondary">
                    {musicGenerationBlockedMessage}
                  </p>
                  <Button
                    className="mt-3"
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpenAiToolsSetup("audioGeneration")}
                  >
                    Open AI Tools Setup
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {track.aiGenerationState === "error" && track.aiGenerationError ? (
            <div className="rounded border border-red-700/40 bg-red-950/30 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 shrink-0 text-red-300" size={20} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-red-200">Generation failed</p>
                  <p className="mt-1 text-sm leading-6 text-red-100/90">{track.aiGenerationError}</p>
                  {hasErrorDetails ? (
                    <Button
                      className="mt-3"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDetailsOpen((value) => !value)}
                      icon={<ChevronDown size={14} />}
                    >
                      {detailsOpen ? "Hide details" : "Show details"}
                    </Button>
                  ) : null}
                </div>
              </div>
              {detailsOpen && hasErrorDetails ? (
                <div className="mt-3 space-y-1 rounded border border-red-800/40 bg-black/30 p-3 text-xs leading-5 text-red-100/80">
                  {track.aiGenerationPhase ? <p>Last phase: {formatPhaseLabel(track.aiGenerationPhase)}</p> : null}
                  {track.aiGenerationSessionMode ? <p>{formatSessionModeLabel(track.aiGenerationSessionMode)}</p> : null}
                  {track.aiGenerationWorkerExitCode ? <p>Exit code: {track.aiGenerationWorkerExitCode}</p> : null}
                  {track.aiGenerationStatusNote ? <p>{track.aiGenerationStatusNote}</p> : null}
                  {track.aiGenerationLastStderrLine ? <p className="break-all">Last stderr: {track.aiGenerationLastStderrLine}</p> : null}
                  {track.aiGenerationLastStdoutLine ? <p className="break-all">Last stdout: {track.aiGenerationLastStdoutLine}</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {isBusy ? (
            <div className="rounded border border-cyan-800/50 bg-cyan-950/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-daw-text">
                    {formatPhaseLabel(track.aiGenerationPhase)}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
                    {track.aiGenerationMessage || "Audio generation is running."}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-daw-text-muted">
                  <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                    {formatProgressLabel(track.aiGenerationProgress ?? 0)}
                  </span>
                  {track.aiGenerationElapsedMs ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {formatElapsedLabel(track.aiGenerationElapsedMs)}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 h-2.5 w-full rounded-full bg-neutral-900">
                <div
                  className="h-2.5 rounded-full bg-daw-accent transition-all duration-200"
                  style={{ width: progressWidth(track.aiGenerationProgress) }}
                />
              </div>
              {runningDetails ? (
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
                      {track.aiGenerationStatusNote ? (
                        <p className="text-xs leading-5 text-daw-text-secondary">{track.aiGenerationStatusNote}</p>
                      ) : null}
                      {detailChips.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {detailChips.map((chip) => (
                            <span
                              key={chip}
                              className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-daw-text-muted"
                            >
                              {chip}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {workflow.available !== false ? (
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
          ) : null}
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={isBusy}>
          Close
        </Button>
        {isBusy ? (
          <Button variant="danger" onClick={() => void onCancel()}>
            Cancel
          </Button>
        ) : (
          <>
            {!isMusicGenerationReady ? (
              <Button variant="secondary" onClick={() => onOpenAiToolsSetup("audioGeneration")}>
                Set Up {model.shortLabel}
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={handleGenerateClick}
              disabled={!canSubmitGeneration}
            >
              Generate
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

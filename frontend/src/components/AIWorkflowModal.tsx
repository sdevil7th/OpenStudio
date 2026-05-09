import { useMemo } from "react";
import { type AiToolsStatus } from "../services/NativeBridge";
import { type Track } from "../store/useDAWStore";
import {
  AI_WORKFLOWS,
  AI_WORKFLOW_SECTION_LABELS,
  type AIWorkflowParam,
  type AIWorkflowSection,
  getAIWorkflow,
  mergeWorkflowParams,
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
  AdvancedDisclosure,
  FormGrid,
  FormSection,
  SliderField,
  StatusBanner,
  Textarea,
} from "./ui";

interface AIWorkflowModalProps {
  track: Track;
  aiToolsStatus: AiToolsStatus;
  isOpen: boolean;
  onClose: () => void;
  onGenerate: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onOpenAiToolsSetup: () => void;
  onWorkflowChange: (workflowId: string) => void;
  onParamsChange: (params: Record<string, unknown>) => void;
}

const SECTION_ORDER: AIWorkflowSection[] = [
  "source",
  "prompt",
  "music",
  "output",
  "sampling",
  "generation",
];

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

function formatEtaLabel(etaMs?: number) {
  if (!etaMs || etaMs <= 0) {
    return "";
  }

  const totalSeconds = Math.max(0, Math.floor(etaMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s left` : `${seconds}s left`;
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

function formatOptionLabel(paramKey: string, option: string) {
  if (paramKey === "runtimeProfile") {
    return formatRuntimeProfileLabel(option);
  }
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

export function AIWorkflowModal({
  track,
  aiToolsStatus,
  isOpen,
  onClose,
  onGenerate,
  onCancel,
  onOpenAiToolsSetup,
  onWorkflowChange,
  onParamsChange,
}: AIWorkflowModalProps) {
  const workflow = getAIWorkflow(track.aiWorkflow);
  const params = useMemo(
    () => mergeWorkflowParams(workflow.id, track.aiWorkflowParams),
    [track.aiWorkflowParams, workflow.id],
  );
  const isBusy =
    track.aiGenerationState === "loading"
    || track.aiGenerationState === "generating";
  const isMusicGenerationReady = Boolean(
    aiToolsStatus.musicGenerationReady
    && aiToolsStatus.musicGenerationLayoutValid
    && (aiToolsStatus.musicGenerationPerformanceReady ?? true),
  );
  const musicGenerationBlockedMessage = !isMusicGenerationReady
    ? (aiToolsStatus.musicGenerationPerformanceStatusMessage
      || aiToolsStatus.musicGenerationStatusMessage
      || (!aiToolsStatus.musicGenerationLayoutValid
        && aiToolsStatus.musicGenerationModelId
        && aiToolsStatus.musicGenerationCheckpointRoot
          ? `Pinned ACE-Step native asset layout is not ready in ${aiToolsStatus.musicGenerationCheckpointRoot}.`
          : aiToolsStatus.error
            || aiToolsStatus.message
            || "AI music generation is not ready yet."))
    : "";
  const canSubmitGeneration =
    workflow.available !== false && isMusicGenerationReady && !isBusy;

  const paramsBySection = useMemo(() => {
    return SECTION_ORDER.map((section) => ({
      section,
      params: workflow.params.filter(
        (param) => param.section === section && !param.hidden,
      ),
    })).filter((group) => group.params.length > 0);
  }, [workflow.params]);

  const handleParamChange = (key: string, value: unknown) => {
    const nextParams = {
      ...params,
      [key]: value,
    };
    onParamsChange(nextParams);
  };

  const renderParamControl = (param: AIWorkflowParam) => {
    const value = params[param.key];
    const controlDisabled =
      param.key === "customStartTime" && params.outputPlacement !== "custom";

    if (param.type === "textarea") {
      return (
        <Textarea
          key={param.key}
          label={param.label}
          value={String(value ?? "")}
          onChange={(event) =>
            handleParamChange(param.key, event.target.value)
          }
          placeholder={param.placeholder}
          rows={param.key === "lyrics" ? 10 : 6}
          helperText={param.description}
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
          disabled={controlDisabled}
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
          disabled={controlDisabled}
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
          <span className="text-sm text-daw-text">
            {param.label}
          </span>
          <Checkbox
            checked={Boolean(value)}
            disabled={controlDisabled}
            onChange={() =>
              handleParamChange(param.key, !Boolean(value))
            }
          />
        </label>
      );
    }

    return (
      <Select
        key={param.key}
        label={param.label}
        value={String(value ?? "")}
        onChange={(nextValue) =>
          handleParamChange(param.key, String(nextValue))
        }
        options={(param.options ?? []).map((option) => ({
          value: option,
          label: formatOptionLabel(param.key, option),
          disabled: false,
        }))}
        size="sm"
        disabled={controlDisabled}
        fullWidth
      />
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader title="AI Workflow Parameters" />
      <ModalContent>
        <div className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <FormSection title="Track" className="bg-neutral-950/70">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-daw-text">
                    {track.name}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
                    {workflow.description}
                  </p>
                </div>
                {track.aiGenerationBackend ? (
                  <span className="shrink-0 rounded-full border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-daw-text">
                    {track.aiGenerationBackend.toUpperCase()}
                  </span>
                ) : null}
              </div>
            </FormSection>

            <FormSection title="Mode">
              <Select
                label="Workflow"
                value={workflow.id}
                onChange={(value) => onWorkflowChange(String(value))}
                options={AI_WORKFLOWS.map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                  disabled: entry.available === false,
                }))}
                size="sm"
                fullWidth
              />
            </FormSection>
          </div>

          {workflow.available === false ? (
            <StatusBanner tone="warning">
              {workflow.availabilityNote
                ?? "This workflow is not available in the current OpenStudio build."}
            </StatusBanner>
          ) : null}

          {!isMusicGenerationReady ? (
            <StatusBanner tone="danger">
              <p>{musicGenerationBlockedMessage}</p>
              {aiToolsStatus.musicGenerationCheckpointRoot ? (
                <p className="text-xs text-red-100/80 break-all">
                  Checkpoint root: {aiToolsStatus.musicGenerationCheckpointRoot}
                </p>
              ) : null}
            </StatusBanner>
          ) : null}

          {track.aiGenerationState === "error" && track.aiGenerationError ? (
            <StatusBanner tone="danger" title="Generation failed">
              <p>{track.aiGenerationError}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs uppercase tracking-[0.12em] text-red-100/80">
                {track.aiGenerationPhase ? (
                  <span>Last phase: {formatPhaseLabel(track.aiGenerationPhase)}</span>
                ) : null}
                {track.aiGenerationSessionMode ? (
                  <span>{formatSessionModeLabel(track.aiGenerationSessionMode)}</span>
                ) : null}
                {track.aiGenerationWorkerExitCode ? (
                  <span>Exit code: {track.aiGenerationWorkerExitCode}</span>
                ) : null}
              </div>
              {track.aiGenerationStatusNote ? (
                <p className="text-xs leading-5 text-red-100/80">{track.aiGenerationStatusNote}</p>
              ) : null}
              {track.aiGenerationLastStderrLine ? (
                <p className="text-xs leading-5 text-red-100/80 break-all">
                  Last stderr: {track.aiGenerationLastStderrLine}
                </p>
              ) : null}
              {track.aiGenerationLastStdoutLine ? (
                <p className="text-xs leading-5 text-red-100/80 break-all">
                  Last stdout: {track.aiGenerationLastStdoutLine}
                </p>
              ) : null}
            </StatusBanner>
          ) : null}

          {isBusy ? (
            <StatusBanner tone="info">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-daw-text">
                    {formatPhaseLabel(track.aiGenerationPhase)}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
                    {track.aiGenerationMessage || "Music generation is in progress."}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-daw-text-muted">
                  <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                    {formatProgressLabel(track.aiGenerationProgress ?? 0)}
                  </span>
                  {track.aiGenerationBackend ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {track.aiGenerationBackend.toUpperCase()}
                    </span>
                  ) : null}
                  {track.aiGenerationRunMode ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {track.aiGenerationRunMode.toUpperCase()}
                    </span>
                  ) : null}
                  {track.aiGenerationSessionMode ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {formatSessionModeLabel(track.aiGenerationSessionMode)}
                    </span>
                  ) : null}
                  {track.aiGenerationElapsedMs ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {formatElapsedLabel(track.aiGenerationElapsedMs)}
                    </span>
                  ) : null}
                  {track.aiGenerationEtaMs ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {formatEtaLabel(track.aiGenerationEtaMs)}
                    </span>
                  ) : null}
                  {track.aiGenerationRuntimeProfile ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {formatRuntimeProfileLabel(track.aiGenerationRuntimeProfile)}
                    </span>
                  ) : null}
                  {track.aiGenerationLmModel ? (
                    <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-daw-text">
                      {formatLmModelLabel(track.aiGenerationLmModel)}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 h-2.5 w-full rounded-full bg-neutral-900">
                <div
                  className="h-2.5 rounded-full bg-daw-accent transition-all duration-200"
                  style={{
                    width: `${Math.max(4, Math.round((track.aiGenerationProgress ?? 0) * 100))}%`,
                  }}
                />
              </div>
              {track.aiGenerationStatusNote ? (
                <p className="mt-3 text-xs leading-5 text-daw-text-secondary">
                  {track.aiGenerationStatusNote}
                </p>
              ) : null}
            </StatusBanner>
          ) : null}

          {workflow.available !== false ? (
            <div className="space-y-4">
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
                        {primaryParams.map(renderParamControl)}
                      </FormGrid>
                    ) : null}

                    {advancedParams.length > 0 ? (
                      <AdvancedDisclosure
                        title="Advanced"
                        className={primaryParams.length > 0 ? "mt-3" : undefined}
                      >
                        <FormGrid>
                          {advancedParams.map(renderParamControl)}
                        </FormGrid>
                      </AdvancedDisclosure>
                    ) : null}
                  </FormSection>
                );
              })}
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
              <Button variant="secondary" onClick={onOpenAiToolsSetup}>
                Open AI Tools Setup
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={() => void onGenerate()}
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

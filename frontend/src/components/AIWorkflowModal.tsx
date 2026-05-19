import { useMemo } from "react";
import { type AiFeatureId, type AiToolsStatus } from "../services/NativeBridge";
import { type Track } from "../store/useDAWStore";
import {
  AI_WORKFLOWS,
  AI_WORKFLOW_SECTION_LABELS,
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
  Slider,
  Textarea,
} from "./ui";

interface AIWorkflowModalProps {
  track: Track;
  aiToolsStatus: AiToolsStatus;
  isOpen: boolean;
  onClose: () => void;
  onGenerate: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onOpenAiToolsSetup: (requestedFeature?: AiFeatureId) => void;
  onWorkflowChange: (workflowId: string) => void;
  onParamsChange: (params: Record<string, unknown>) => void;
}

const SECTION_ORDER: AIWorkflowSection[] = [
  "prompt",
  "music",
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
    aiToolsStatus.features?.audioGeneration?.ready
    ?? (
      aiToolsStatus.musicGenerationReady
      && aiToolsStatus.musicGenerationLayoutValid
      && (aiToolsStatus.musicGenerationPerformanceReady ?? true)
    ),
  );
  const musicGenerationBlockedMessage = !isMusicGenerationReady
    ? (aiToolsStatus.features?.audioGeneration?.message
      || aiToolsStatus.musicGenerationPerformanceStatusMessage
      || aiToolsStatus.musicGenerationStatusMessage
      || (!aiToolsStatus.musicGenerationLayoutValid
        && aiToolsStatus.musicGenerationModelId
        && aiToolsStatus.musicGenerationCheckpointRoot
          ? `Pinned ACE-Step native asset layout is not ready in ${aiToolsStatus.musicGenerationCheckpointRoot}.`
          : aiToolsStatus.error
            || aiToolsStatus.message
            || "Audio Generation is not ready yet."))
    : "";
  const canSubmitGeneration =
    workflow.available !== false && isMusicGenerationReady && !isBusy;

  const paramsBySection = useMemo(() => {
    return SECTION_ORDER.map((section) => ({
      section,
      params: workflow.params.filter((param) => param.section === section),
    })).filter((group) => group.params.length > 0);
  }, [workflow.params]);

  const handleParamChange = (key: string, value: unknown) => {
    const nextParams = {
      ...params,
      [key]: value,
    };
    onParamsChange(nextParams);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader title="AI Workflow Parameters" />
      <ModalContent>
        <div className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="rounded border border-neutral-800 bg-neutral-950/70 p-4">
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
            </div>

            <div className="rounded border border-neutral-800 bg-neutral-950/50 p-4">
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
            </div>
          </div>

          {workflow.available === false ? (
            <div className="rounded border border-yellow-700/40 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-200">
              {workflow.availabilityNote
                ?? "This workflow is not available in the current OpenStudio build."}
            </div>
          ) : null}

          {!isMusicGenerationReady ? (
            <div className="space-y-2 rounded border border-red-700/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">
              <p>{musicGenerationBlockedMessage}</p>
              {aiToolsStatus.musicGenerationCheckpointRoot ? (
                <p className="text-xs text-red-100/80 break-all">
                  Checkpoint root: {aiToolsStatus.musicGenerationCheckpointRoot}
                </p>
              ) : null}
            </div>
          ) : null}

          {track.aiGenerationState === "error" && track.aiGenerationError ? (
            <div className="space-y-1 rounded border border-red-700/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">
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
            </div>
          ) : null}

          {isBusy ? (
            <div className="rounded border border-cyan-800/50 bg-cyan-950/20 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-daw-text">
                    {formatPhaseLabel(track.aiGenerationPhase)}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
                    {track.aiGenerationMessage || "Audio Generation is in progress."}
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
            </div>
          ) : null}

          {workflow.available !== false ? (
            <div className="space-y-4">
              {paramsBySection.map((group) => (
                <section
                  key={group.section}
                  className="rounded border border-neutral-800 bg-neutral-950/50 p-4"
                >
                  <div className="mb-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">
                      {AI_WORKFLOW_SECTION_LABELS[group.section]}
                    </p>
                  </div>

                  <div
                    className={
                      group.section === "prompt"
                        ? "space-y-3"
                        : "grid grid-cols-1 gap-3 md:grid-cols-2"
                    }
                  >
                    {group.params.map((param) => {
                      const value = params[param.key];
                      const controlDisabled = false;

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
                          <div
                            key={param.key}
                            className="rounded border border-neutral-800 bg-neutral-950/70 p-3"
                          >
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <span className="text-xs font-medium uppercase tracking-[0.12em] text-daw-text-muted">
                                {param.label}
                              </span>
                              <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] text-daw-text">
                                {numericValue}
                              </span>
                            </div>
                            <Slider
                              value={numericValue}
                              min={param.min ?? 0}
                              max={param.max ?? 100}
                              step={param.step ?? 1}
                              disabled={controlDisabled}
                              onChange={(nextValue) =>
                                handleParamChange(param.key, nextValue)
                              }
                            />
                          </div>
                        );
                      }

                      if (param.type === "toggle") {
                        return (
                          <label
                            key={param.key}
                            className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950/70 px-3 py-2.5"
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
                    })}
                  </div>
                </section>
              ))}
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
                Set Up Audio Generation
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

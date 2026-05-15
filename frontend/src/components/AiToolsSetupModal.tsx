import { useEffect, useState } from "react";
import { useShallow } from "zustand/shallow";
import { nativeBridge, type AiFeatureId, type AiFeatureStatus, type AiToolsStatus } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Button, Modal, ModalContent, ModalFooter, ModalHeader } from "./ui";

const IS_WINDOWS = navigator.platform.startsWith("Win") || navigator.userAgent.includes("Windows");

const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";
const AI_FEATURES: AiFeatureId[] = ["stemSeparation", "audioGeneration"];

const FEATURE_COPY: Record<AiFeatureId, { label: string; requirements: string; description: string }> = {
  stemSeparation: {
    label: "Stem Separation",
    requirements: "8 GB system RAM minimum. CPU-only machines are supported.",
    description: "Split audio clips into vocals, drums, bass, and other stems.",
  },
  audioGeneration: {
    label: "Audio Generation",
    requirements: "16 GB system RAM plus CUDA or ROCm GPU with 8 GB memory minimum.",
    description: "Generate audio with the ACE-Step model runtime.",
  },
};

function Step({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-daw-accent flex items-center justify-center text-xs font-bold text-white">
        {number}
      </div>
      <div className="text-sm text-daw-text leading-relaxed">{children}</div>
    </div>
  );
}

function CodeSnip({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-neutral-900 text-green-400 text-xs px-1.5 py-0.5 rounded font-mono">
      {children}
    </code>
  );
}

function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return encodeURI(normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`);
}

function parentPath(path: string): string {
  const segments = path.split(/[/\\]+/);
  segments.pop();
  return segments.join("/");
}

function formatElapsed(ms?: number): string {
  const totalSeconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatBytes(bytes?: number): string {
  const value = Math.max(0, bytes ?? 0);
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatRuntimeProfileLabel(profile?: string): string {
  switch (profile) {
    case "native-xl-turbo":
    case "openstudio-ace-split":
      return "OpenStudio ACE Split";
    default:
      return profile ?? "";
  }
}

function isAudioGenerationReady(status: AiToolsStatus): boolean {
  const availableProfiles = status.musicGenerationAvailableProfiles ?? [];
  const nativeProfileReady = availableProfiles.length === 0 || availableProfiles.includes("native-xl-turbo");
  return Boolean(
    status.musicGenerationReady
      && status.musicGenerationLayoutValid
      && (status.musicGenerationPerformanceReady ?? true)
      && nativeProfileReady,
  );
}

function getFeatureStatus(status: AiToolsStatus, featureId: AiFeatureId): AiFeatureStatus {
  const existing = status.features?.[featureId];
  if (existing) {
    return existing as AiFeatureStatus;
  }

  if (featureId === "stemSeparation") {
    const systemRamMb = status.hardware?.systemRamMb ?? 0;
    const compatible = systemRamMb <= 0 || systemRamMb >= 8192;
    return {
      id: "stemSeparation",
      label: FEATURE_COPY.stemSeparation.label,
      ready: status.available,
      installed: status.available,
      compatible,
      blocked: !compatible,
      blockReason: compatible ? "" : "at least 8 GB system RAM is required",
      requiresGpu: false,
      minSystemRamMb: 8192,
    };
  }

  const ready = isAudioGenerationReady(status);
  return {
    id: "audioGeneration",
    label: FEATURE_COPY.audioGeneration.label,
    ready,
    installed: ready,
    compatible: false,
    blocked: !ready,
    blockReason: "supported GPU with at least 8 GB memory was not detected",
    message: ready
      ? "Audio Generation is ready."
      : "This machine does not meet Audio Generation requirements: supported GPU with at least 8 GB memory was not detected.",
    requiresGpu: true,
    minSystemRamMb: 16384,
    minGpuMemoryMb: 8192,
    supportedGpuBackends: ["cuda", "rocm"],
  };
}

function defaultSelectedFeatures(status: AiToolsStatus, requestedFeature: AiFeatureId | null): AiFeatureId[] {
  if (requestedFeature) {
    const feature = getFeatureStatus(status, requestedFeature);
    return feature.compatible && !feature.ready ? [requestedFeature] : [];
  }

  const stem = getFeatureStatus(status, "stemSeparation");
  return stem.compatible && !stem.ready ? ["stemSeparation"] : [];
}

function formatRequirementMemory(memoryMb?: number): string {
  if (!memoryMb || memoryMb <= 0) return "";
  return `${Math.round(memoryMb / 1024)} GB`;
}

function getUnavailableProfileDetails(
  runtimeProfiles: Record<string, unknown> | undefined,
  unavailableProfiles: Array<Record<string, unknown>>,
): string[] {
  const details: string[] = [];

  if (runtimeProfiles && typeof runtimeProfiles === "object") {
    for (const [profileId, rawProfile] of Object.entries(runtimeProfiles)) {
      if (!rawProfile || typeof rawProfile !== "object") continue;
      const profile = rawProfile as Record<string, unknown>;
      if (profile.available === true) continue;
      const missingAssets = Array.isArray(profile.missingAssets)
        ? profile.missingAssets
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
        : [];
      const label = formatRuntimeProfileLabel(String(profile.id ?? profileId));
      details.push(
        missingAssets.length > 0
          ? `${label}: ${missingAssets.join(", ")}`
          : label,
      );
    }
  }

  if (details.length > 0) {
    return details;
  }

  return unavailableProfiles
    .map((entry) => {
      const label = formatRuntimeProfileLabel(String(entry.id ?? ""));
      const missingAssets = Array.isArray(entry.missingAssets)
        ? entry.missingAssets
          .map((asset) => String(asset ?? "").trim())
          .filter(Boolean)
        : [];
      if (!label) return "";
      return missingAssets.length > 0 ? `${label}: ${missingAssets.join(", ")}` : label;
    })
    .filter(Boolean);
}

export default function AiToolsSetupModal() {
  const { showAiToolsSetup, aiToolsSetupRequestedFeature, closeAiToolsSetup, installAiTools, resetAiTools, aiToolsStatus } = useDAWStore(
    useShallow((s) => ({
      showAiToolsSetup: s.showAiToolsSetup,
      aiToolsSetupRequestedFeature: s.aiToolsSetupRequestedFeature,
      closeAiToolsSetup: s.closeAiToolsSetup,
      installAiTools: s.installAiTools,
      resetAiTools: s.resetAiTools,
      aiToolsStatus: s.aiToolsStatus,
    })),
  );
  const [selectedFeatures, setSelectedFeatures] = useState<AiFeatureId[]>([]);

  useEffect(() => {
    if (!showAiToolsSetup || aiToolsStatus.installInProgress) return;
    setSelectedFeatures(defaultSelectedFeatures(aiToolsStatus, aiToolsSetupRequestedFeature));
  }, [
    showAiToolsSetup,
    aiToolsSetupRequestedFeature,
    aiToolsStatus.installInProgress,
    aiToolsStatus.available,
    aiToolsStatus.musicGenerationReady,
    aiToolsStatus.musicGenerationLayoutValid,
    aiToolsStatus.musicGenerationPerformanceReady,
    aiToolsStatus.features,
  ]);

  if (!showAiToolsSetup) return null;

  const stemFeature = getFeatureStatus(aiToolsStatus, "stemSeparation");
  const audioFeature = getFeatureStatus(aiToolsStatus, "audioGeneration");
  const featureStatuses = {
    stemSeparation: stemFeature,
    audioGeneration: audioFeature,
  } satisfies Record<AiFeatureId, AiFeatureStatus>;
  const isPythonMissing = aiToolsStatus.state === "pythonMissing";
  const hasInstallError = aiToolsStatus.state === "error" || aiToolsStatus.state === "cancelled";
  const isStemSeparationReady = Boolean(stemFeature.ready || aiToolsStatus.available);
  const isMusicGenerationInstalled = Boolean(aiToolsStatus.musicGenerationReady && aiToolsStatus.musicGenerationLayoutValid);
  const isMusicGenerationPerformanceReady = aiToolsStatus.musicGenerationPerformanceReady ?? true;
  const isMusicGenerationFullyReady = Boolean(audioFeature.ready || (isMusicGenerationInstalled && isMusicGenerationPerformanceReady));
  const isPartiallyReady = isStemSeparationReady && !isMusicGenerationFullyReady;
  const isInstallComplete =
    selectedFeatures.length > 0
      ? selectedFeatures.every((featureId) => Boolean(featureStatuses[featureId].ready))
      : isStemSeparationReady && isMusicGenerationFullyReady;
  const showSetupModeCard = !isInstallComplete;
  const showSetupSteps = !isInstallComplete;
  const musicGenerationBlockedMessage =
    aiToolsStatus.musicGenerationPerformanceStatusMessage
    || (isMusicGenerationInstalled
      ? "Audio Generation is installed, but acceleration is incomplete in this managed runtime."
      : aiToolsStatus.musicGenerationStatusMessage
        || (!aiToolsStatus.musicGenerationLayoutValid
          ? "Pinned ACE-Step native split-model files are still missing."
          : "Audio Generation still needs the OpenStudio ACE split backend."));
  const isReconcilingInstallResult = aiToolsStatus.statusWarningCode === "reconciling_install_state";
  const requiresExternalPython = aiToolsStatus.requiresExternalPython;
  const buildRuntimeMode = aiToolsStatus.buildRuntimeMode ?? "downloaded-runtime";
  const isDownloadedRuntimeFlow =
    buildRuntimeMode === "downloaded-runtime" ||
    (aiToolsStatus.installSource === "downloadedRuntime" && !requiresExternalPython);
  const isModelFailure = (aiToolsStatus.errorCode ?? "").startsWith("model_");
  const isUnsupportedPlatform = aiToolsStatus.errorCode === "runtime_platform_unsupported";
  const isRuntimeManifestFailure =
    aiToolsStatus.errorCode === "runtime_manifest_missing" ||
    aiToolsStatus.errorCode === "runtime_manifest_unavailable" ||
    aiToolsStatus.errorCode === "runtime_manifest_invalid";
  const isRuntimeArchiveFailure =
    aiToolsStatus.errorCode === "runtime_download_failed" ||
    aiToolsStatus.errorCode === "runtime_checksum_failed" ||
    aiToolsStatus.errorCode === "runtime_extraction_failed" ||
    aiToolsStatus.errorCode === "runtime_verification_failed" ||
    aiToolsStatus.errorCode === "runtime_not_relocatable" ||
    aiToolsStatus.errorCode === "runtime_validation_failed" ||
    aiToolsStatus.errorCode === "runtime_python_unlaunchable" ||
    aiToolsStatus.errorCode === "installer_exited_incomplete" ||
    aiToolsStatus.errorCode === "installer_output_timeout" ||
    aiToolsStatus.errorCode === "model_preparation_incomplete";
  const terminalReason = aiToolsStatus.terminalReason ?? "";
  const isWindowsRuntimeLockFailure =
    IS_WINDOWS &&
    (terminalReason === "runtime_locked_rebuild_failed" ||
      terminalReason === "runtime_rebuild_remove_failed");
  const installLogPath = aiToolsStatus.detailLogPath;
  const activityLines = aiToolsStatus.activityLines ?? [];
  const hasActivityConsole = aiToolsStatus.installInProgress || activityLines.length > 0;
  const showLatestInstallerActivity = !isInstallComplete && hasActivityConsole && !aiToolsStatus.installInProgress;
  const hasByteProgress = (aiToolsStatus.bytesTotal ?? 0) > 0 && (aiToolsStatus.bytesDownloaded ?? 0) >= 0;
  const byteProgressRatio = hasByteProgress
    ? Math.max(0, Math.min((aiToolsStatus.bytesDownloaded ?? 0) / Math.max(aiToolsStatus.bytesTotal ?? 1, 1), 1))
    : 0;
  const visualProgressRatio = hasByteProgress ? byteProgressRatio : Math.max(0, Math.min(aiToolsStatus.progress ?? 0, 1));
  const progressPercent = Math.round(visualProgressRatio * 100);
  const transferText = hasByteProgress
    ? `${formatBytes(aiToolsStatus.bytesDownloaded)} / ${formatBytes(aiToolsStatus.bytesTotal)}`
    : "";
  const selectedReadyLabels = selectedFeatures.length > 0
    ? selectedFeatures.map((featureId) => FEATURE_COPY[featureId].label)
    : [];
  const completeTitle = selectedReadyLabels.length === 1
    ? `${selectedReadyLabels[0]} is ready`
    : "Selected AI features are ready";
  const availableProfiles = aiToolsStatus.musicGenerationAvailableProfiles ?? [];
  const unavailableProfiles = aiToolsStatus.musicGenerationUnavailableProfiles ?? [];
  const defaultProfile = aiToolsStatus.musicGenerationDefaultProfile ?? "";
  const unavailableProfileDetails = getUnavailableProfileDetails(
    aiToolsStatus.musicGenerationRuntimeProfiles as Record<string, unknown> | undefined,
    unavailableProfiles,
  );

  const errorTitle = isModelFailure
    ? "Model download needs attention"
    : isUnsupportedPlatform
      ? "AI Tools are not available on this Mac"
      : isWindowsRuntimeLockFailure
        ? "Windows blocked the AI runtime update"
      : isRuntimeManifestFailure
        ? "AI runtime download info is unavailable"
        : isRuntimeArchiveFailure
        ? "AI runtime setup failed"
      : aiToolsStatus.state === "cancelled"
        ? "AI tools setup was cancelled"
        : requiresExternalPython
          ? "AI tools setup needs Python help"
          : "AI tools setup needs attention";

  const recommendationText = isDownloadedRuntimeFlow
    ? "This release downloads the OpenStudio AI runtime the first time you use a selected AI feature, verifies it, and then downloads only the compatible selected model files. You can keep using the app while setup runs."
    : IS_WINDOWS
      ? "This dev build needs Python 3.11 on your machine first for the Windows ACE-Step runtime. Once Python is installed, OpenStudio will continue the rest of the AI setup automatically."
      : "This dev build needs Python 3.10 through 3.12 on your machine first. Once Python is installed, OpenStudio will continue the rest of the AI setup automatically.";

  const retryGuidance = isModelFailure
    ? "The runtime is already in place. Retry after checking your internet connection, VPN, firewall, or antivirus if the download keeps failing."
    : isUnsupportedPlatform
      ? "This release currently supports AI Tools on Apple Silicon Macs only. The base app can still be used normally on Intel Macs."
    : isWindowsRuntimeLockFailure
      ? "OpenStudio already attempted a runtime-only rebuild of stem-runtime after Windows denied access to a managed runtime file. Close any remaining helper processes, Python workers, or antivirus scanners that may still be touching the runtime, then retry. Retry keeps the downloaded stem models and ACE-Step checkpoints in place. Use Reset AI Tools only for a full cleanup, which also removes the downloaded models and checkpoints."
    : isRuntimeManifestFailure
      ? "Retry once in case the release metadata service was temporarily unavailable. If the same message appears again, OpenStudio may not be able to reach the published AI runtime metadata from this machine."
    : isDownloadedRuntimeFlow
      ? "Retry from this window to let OpenStudio download and prepare the managed AI runtime again. If the same error comes back, open the install log location for details."
      : aiToolsStatus.pythonDetected
        ? "Python was detected, so you can usually retry from this window. If the same error comes back, restart OpenStudio and reopen this setup window before trying again."
        : "OpenStudio could not confirm a usable Python installation yet. Install Python first, restart OpenStudio, then reopen this setup window and retry.";

  const handleDownloadPython = async () => {
    await nativeBridge.openExternalURL(PYTHON_DOWNLOAD_URL);
  };

  const handleOpenInstallLog = async () => {
    if (!installLogPath) return;
    await nativeBridge.openExternalURL(toFileUrl(parentPath(installLogPath)));
  };

  const toggleFeature = (featureId: AiFeatureId) => {
    const feature = featureStatuses[featureId];
    if (!feature.compatible || feature.ready || aiToolsStatus.installInProgress) return;
    setSelectedFeatures((current) =>
      current.includes(featureId)
        ? current.filter((id) => id !== featureId)
        : [...current, featureId],
    );
  };

  const handleRetry = async () => {
    await installAiTools({
      userConfirmedDownload: true,
      selectedFeatures,
      requestedFeature: aiToolsSetupRequestedFeature ?? selectedFeatures[0],
    });
  };

  const handleReset = async () => {
    await resetAiTools();
  };

  return (
    <Modal
      isOpen={showAiToolsSetup}
      onClose={closeAiToolsSetup}
      size="xl"
      fullHeight
      className="max-h-[80vh] w-[min(96vw,1100px)]"
    >
      <ModalHeader title="AI Tools Setup" />
      <ModalContent className="space-y-5">
        <div className="space-y-5">
          <div className="rounded bg-daw-dark p-3 space-y-1">
            <p className="text-sm font-medium text-daw-text">What is this?</p>
            <p className="text-xs text-daw-text-secondary leading-relaxed">
              AI Tools enables <span className="text-daw-text">Stem Separation</span> - splitting a
              clip into individual tracks like Vocals, Drums, Bass, Guitar, and more. It also powers
              <span className="text-daw-text"> Audio Generation</span> when ACE-Step is installed.
            </p>
          </div>

          {showSetupModeCard ? (
            <div className="rounded border border-neutral-800 bg-neutral-950/60 p-3 space-y-1">
              <p className="text-sm font-medium text-daw-text">
                {isDownloadedRuntimeFlow ? "OpenStudio-managed runtime setup" : "Python-based setup"}
              </p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">{recommendationText}</p>
              {!isInstallComplete ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Nothing downloads until you click <span className="text-daw-text font-medium">Download and Install</span>.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            {AI_FEATURES.map((featureId) => {
              const feature = featureStatuses[featureId];
              const copy = FEATURE_COPY[featureId];
              const selected = selectedFeatures.includes(featureId);
              const disabled = Boolean(aiToolsStatus.installInProgress || feature.ready || !feature.compatible);
              const statusLabel = feature.ready
                ? "Ready"
                : !feature.compatible
                  ? "Blocked"
                  : selected
                    ? "Selected"
                    : "Available";
              const statusClass = feature.ready
                ? "text-green-400"
                : !feature.compatible
                  ? "text-red-300"
                  : selected
                    ? "text-daw-accent"
                    : "text-daw-text-secondary";

              return (
                <label
                  key={featureId}
                  className={`block rounded border p-3 ${
                    feature.ready
                      ? "border-green-600/40 bg-green-950/20"
                      : !feature.compatible
                        ? "border-red-900/50 bg-red-950/10"
                        : selected
                          ? "border-daw-accent/60 bg-daw-accent/10"
                          : "border-neutral-800 bg-neutral-950/60"
                  } ${disabled ? "cursor-default" : "cursor-pointer"}`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-daw-accent"
                      checked={selected || Boolean(feature.ready)}
                      disabled={disabled}
                      onChange={() => toggleFeature(featureId)}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-daw-text">{copy.label}</p>
                        <span className={`text-xs font-medium ${statusClass}`}>{statusLabel}</span>
                      </div>
                      <p className="text-xs text-daw-text-secondary leading-relaxed">{copy.description}</p>
                      <p className="text-xs text-daw-text-secondary leading-relaxed">{copy.requirements}</p>
                      {feature.blockReason ? (
                        <p className="text-xs text-red-300 leading-relaxed">
                          This machine does not meet {copy.label} requirements: {feature.blockReason}.
                        </p>
                      ) : null}
                      {feature.minSystemRamMb ? (
                        <p className="text-[11px] text-daw-text-secondary leading-relaxed">
                          Required RAM: {formatRequirementMemory(feature.minSystemRamMb)}
                          {feature.minGpuMemoryMb ? `, GPU memory: ${formatRequirementMemory(feature.minGpuMemoryMb)}` : ""}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>

          {selectedFeatures.length === 0 && !aiToolsStatus.installInProgress && !isInstallComplete ? (
            <div className="rounded border border-yellow-700/40 bg-yellow-950/20 p-3">
              <p className="text-xs text-yellow-200 leading-relaxed">
                Select a compatible feature to download. Incompatible features are disabled and will not be installed.
              </p>
            </div>
          ) : null}

          {isInstallComplete ? (
            <div className="rounded border border-green-600/40 bg-green-950/30 p-3 space-y-2">
              <p className="text-sm font-semibold text-green-400">{completeTitle}</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                The selected AI feature modules are installed for this OpenStudio session.
                You can continue straight into the compatible AI workflow now.
              </p>
              {aiToolsStatus.selectedBackend ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Active backend: <span className="text-daw-text">{aiToolsStatus.selectedBackend}</span>
                </p>
              ) : null}
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                Audio Generation:{" "}
                <span className={isMusicGenerationFullyReady ? "text-green-400" : "text-yellow-300"}>
                  {isMusicGenerationFullyReady ? "Ready" : "Installed, but degraded"}
                </span>
                {aiToolsStatus.aceStepVersion ? ` (ACE-Step ${aiToolsStatus.aceStepVersion})` : ""}
              </p>
              {aiToolsStatus.musicGenerationModelId ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Pinned model: <span className="text-daw-text">{aiToolsStatus.musicGenerationModelId}</span>
                </p>
              ) : null}
              {aiToolsStatus.musicGenerationCheckpointRoot ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed break-all">
                  Checkpoint root: <span className="text-daw-text">{aiToolsStatus.musicGenerationCheckpointRoot}</span>
                </p>
              ) : null}
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                Checkpoint layout:{" "}
                <span className={aiToolsStatus.musicGenerationLayoutValid ? "text-green-400" : "text-yellow-300"}>
                  {aiToolsStatus.musicGenerationLayoutValid ? "Valid" : "Missing files"}
                </span>
              </p>
              {availableProfiles.length > 0 ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Available profiles: <span className="text-daw-text">{availableProfiles.map(formatRuntimeProfileLabel).join(", ")}</span>
                  {defaultProfile ? <span className="text-daw-text-secondary"> (default: {formatRuntimeProfileLabel(defaultProfile)})</span> : null}
                </p>
              ) : null}
            </div>
          ) : isPartiallyReady ? (
            <div className="rounded border border-yellow-600/40 bg-yellow-950/30 p-3 space-y-2">
              <p className="text-sm font-semibold text-yellow-300">Stem separation is ready</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                {musicGenerationBlockedMessage}
              </p>
              {aiToolsStatus.selectedBackend ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Active backend: <span className="text-daw-text">{aiToolsStatus.selectedBackend}</span>
                </p>
              ) : null}
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                Audio Generation: <span className="text-yellow-300">{isMusicGenerationInstalled ? "Installed, but degraded" : "Not ready yet"}</span>
                {aiToolsStatus.aceStepVersion ? ` (ACE-Step ${aiToolsStatus.aceStepVersion})` : ""}
              </p>
              {aiToolsStatus.musicGenerationModelId ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Pinned model: <span className="text-daw-text">{aiToolsStatus.musicGenerationModelId}</span>
                </p>
              ) : null}
              {aiToolsStatus.musicGenerationCheckpointRoot ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed break-all">
                  Checkpoint root: <span className="text-daw-text">{aiToolsStatus.musicGenerationCheckpointRoot}</span>
                </p>
              ) : null}
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                Checkpoint layout:{" "}
                <span className={aiToolsStatus.musicGenerationLayoutValid ? "text-green-400" : "text-yellow-300"}>
                  {aiToolsStatus.musicGenerationLayoutValid ? "Valid" : "Missing files"}
                </span>
                {aiToolsStatus.musicGenerationLayoutValid ? <span className="text-daw-text-secondary"> (the pinned files are present, but the OpenStudio ACE split backend is still unavailable)</span> : null}
              </p>
              {availableProfiles.length > 0 ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Available profiles: <span className="text-daw-text">{availableProfiles.map(formatRuntimeProfileLabel).join(", ")}</span>
                  {defaultProfile ? <span className="text-daw-text-secondary"> (default: {formatRuntimeProfileLabel(defaultProfile)})</span> : null}
                </p>
              ) : null}
              {unavailableProfileDetails.length > 0 ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Missing profile assets:{" "}
                  <span className="text-daw-text">
                    {unavailableProfileDetails.join("; ")}
                  </span>
                </p>
              ) : null}
            </div>
          ) : aiToolsStatus.installInProgress ? (
            <div className="rounded border border-daw-accent/40 bg-neutral-950/70 p-3 space-y-3">
              <p className="text-sm font-semibold text-daw-text">Installing AI Tools</p>
              <div className="w-full bg-neutral-900 rounded-full h-2">
                <div
                  className="bg-daw-accent h-2 rounded-full transition-all duration-200"
                  style={{ width: `${Math.max(4, progressPercent)}%` }}
                />
              </div>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                {aiToolsStatus.message || "Preparing AI Tools..."}
              </p>
              {aiToolsStatus.downloadHint ? (
                <p className="text-xs text-blue-300 leading-relaxed">{aiToolsStatus.downloadHint}</p>
              ) : null}
              <div className="grid gap-2 text-xs text-daw-text-secondary sm:grid-cols-3">
                <p>
                  Step: <span className="text-daw-text">{aiToolsStatus.stepLabel || aiToolsStatus.lastPhase || aiToolsStatus.state}</span>
                </p>
                <p>
                  Elapsed: <span className="text-daw-text">{formatElapsed(aiToolsStatus.elapsedMs)}</span>
                </p>
                <p>
                  {aiToolsStatus.stepCount && aiToolsStatus.stepIndex
                    ? <>Stage: <span className="text-daw-text">{aiToolsStatus.stepIndex} / {aiToolsStatus.stepCount}</span></>
                    : <>Progress: <span className="text-daw-text">{progressPercent}%</span></>}
                </p>
              </div>
              {hasByteProgress ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Transfer: <span className="text-daw-text">{transferText}</span>
                </p>
              ) : null}
              {aiToolsStatus.lastPhase ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Current phase: <span className="text-daw-text">{aiToolsStatus.lastPhase}</span>
                </p>
              ) : null}
              {aiToolsStatus.isLargeDownload ? (
                <p className="text-xs text-yellow-300 leading-relaxed">
                  This step downloads large AI packages and can take several minutes depending on your connection.
                </p>
              ) : null}
              {aiToolsStatus.statusWarning ? (
                <p className="rounded border border-yellow-600/30 bg-yellow-950/20 px-3 py-2 text-xs leading-relaxed text-yellow-200">
                  {aiToolsStatus.statusWarning}
                </p>
              ) : null}
              {aiToolsStatus.runtimeCandidate ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Runtime candidate: <span className="text-daw-text">{aiToolsStatus.runtimeCandidate}</span>
                </p>
              ) : null}
              {aiToolsStatus.installSessionId ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed break-all">
                  Install session: <span className="text-daw-text">{aiToolsStatus.installSessionId}</span>
                </p>
              ) : null}
              <div className="rounded-xl border border-neutral-800 bg-black px-3 py-3 font-mono text-[11px] text-green-300">
                <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-neutral-500">
                  <span>Installer Activity</span>
                  <span>{formatElapsed(aiToolsStatus.elapsedMs)}</span>
                </div>
                <div className="max-h-44 space-y-1 overflow-y-auto">
                  {(activityLines.length > 0 ? activityLines : [aiToolsStatus.message || "Preparing AI Tools..."]).map((line, index) => (
                    <div key={`${index}-${line}`} className="break-words">
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : isReconcilingInstallResult ? (
            <div className="rounded border border-yellow-600/40 bg-yellow-950/30 p-3 space-y-3">
              <p className="text-sm font-semibold text-yellow-300">Confirming the install result</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                OpenStudio temporarily lost contact with the installer, so it is now probing the installed runtime on disk before deciding whether setup succeeded.
              </p>
              {aiToolsStatus.statusWarning ? (
                <p className="rounded border border-yellow-600/30 bg-yellow-950/20 px-3 py-2 text-xs leading-relaxed text-yellow-200">
                  {aiToolsStatus.statusWarning}
                </p>
              ) : null}
              {aiToolsStatus.lastPhase ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Last observed phase: <span className="text-daw-text">{aiToolsStatus.lastPhase}</span>
                </p>
              ) : null}
              {aiToolsStatus.installSessionId ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed break-all">
                  Install session: <span className="text-daw-text">{aiToolsStatus.installSessionId}</span>
                </p>
              ) : null}
            </div>
          ) : isPythonMissing ? (
            <div className="rounded border border-yellow-600/40 bg-yellow-950/30 p-3 space-y-2">
              <p className="text-sm font-semibold text-yellow-400">Python is required</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                OpenStudio could not find a supported Python version on this machine. This dev
                build needs {IS_WINDOWS ? "Python 3.11" : "Python 3.10 through 3.12"} before AI Tools can be installed.
              </p>
            </div>
          ) : hasInstallError ? (
            <div className="rounded border border-red-600/40 bg-red-950/30 p-3 space-y-2">
              <p className="text-sm font-semibold text-red-400">{errorTitle}</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                {isModelFailure
                  ? "OpenStudio prepared the AI runtime, but the stem model download did not complete."
                  : isUnsupportedPlatform
                    ? "This OpenStudio release does not currently publish an AI runtime for this Mac architecture."
                  : isWindowsRuntimeLockFailure
                    ? "OpenStudio detected a locked file inside the managed Windows runtime and already attempted a runtime-only rebuild of stem-runtime."
                  : isRuntimeManifestFailure
                    ? "OpenStudio could not fetch the published AI runtime metadata needed for this setup."
                  : isRuntimeArchiveFailure
                    ? "OpenStudio could not download, verify, or extract its managed AI runtime on this machine."
                    : "OpenStudio could not finish the AI tools setup."}
              </p>
              {aiToolsStatus.error ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Error reported: <span className="text-daw-text">{aiToolsStatus.error}</span>
                </p>
              ) : null}
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                Install source:{" "}
                <span className="text-daw-text">
                  {isDownloadedRuntimeFlow ? "Downloaded OpenStudio runtime" : "External Python bootstrap"}
                </span>
              </p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                Build mode:{" "}
                <span className="text-daw-text">
                  {buildRuntimeMode === "downloaded-runtime" ? "Downloaded runtime release build" : "Unbundled dev runtime"}
                </span>
              </p>
              {aiToolsStatus.runtimeCandidate ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Runtime candidate: <span className="text-daw-text">{aiToolsStatus.runtimeCandidate}</span>
                </p>
              ) : null}
              {aiToolsStatus.fallbackAttempted ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  OpenStudio already attempted a fallback runtime candidate during this setup run.
                </p>
              ) : null}
              {aiToolsStatus.installSessionId ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed break-all">
                  Install session: <span className="text-daw-text">{aiToolsStatus.installSessionId}</span>
                </p>
              ) : null}
              {aiToolsStatus.lastPhase ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Failed phase: <span className="text-daw-text">{aiToolsStatus.lastPhase}</span>
                </p>
              ) : null}
              {aiToolsStatus.terminalReason ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Terminal reason: <span className="text-daw-text">{aiToolsStatus.terminalReason}</span>
                </p>
              ) : null}
              {isWindowsRuntimeLockFailure ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Retry keeps the downloaded stem models and ACE-Step checkpoints in place.{" "}
                  <span className="text-daw-text">Reset AI Tools</span> is the full cleanup option and removes those downloads too.
                </p>
              ) : null}
              {requiresExternalPython ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Python detected:{" "}
                  <span className={aiToolsStatus.pythonDetected ? "text-green-400" : "text-yellow-300"}>
                    {aiToolsStatus.pythonDetected ? "Yes" : "No"}
                  </span>
                </p>
              ) : null}
              {installLogPath ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed break-all">
                  Install log: <span className="text-daw-text">{installLogPath}</span>
                </p>
              ) : null}
              <p className="text-xs text-daw-text-secondary leading-relaxed">{retryGuidance}</p>
            </div>
          ) : null}

          {showSetupSteps && requiresExternalPython ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-daw-text-secondary uppercase tracking-wide">
                Python setup steps
              </p>
              <div className="space-y-3 pt-1">
                {IS_WINDOWS ? (
                  <>
                    <Step number={1}>
                      Click <span className="text-daw-text font-medium">Download Python</span> below.
                      Your browser will open the official Python website. Download the latest{" "}
                      <span className="text-daw-text font-medium">Python 3.11</span> installer for{" "}
                      <span className="text-daw-text font-medium">Windows 64-bit</span>.
                    </Step>
                    <Step number={2}>
                      Open the downloaded installer. On the very first screen, turn on the checkbox
                      that says{" "}
                      <span className="text-yellow-400 font-semibold">
                        Add python.exe to PATH
                      </span>
                      . This simply allows OpenStudio to find Python automatically later.
                    </Step>
                    <Step number={3}>
                      Click the normal install option and wait for setup to finish. If Windows asks
                      for permission, choose <span className="text-daw-text font-medium">Yes</span>.
                    </Step>
                    <Step number={4}>
                      After installation, restart OpenStudio completely, then click{" "}
                      <span className="text-daw-text font-medium">Retry After Python Install</span>.
                    </Step>
                    <Step number={5}>
                      Avoid Python 3.14 or newer for this dev fallback path. If OpenStudio still says
                      Python is missing, rerun the installer and make sure the{" "}
                      <span className="text-yellow-400 font-semibold">Add to PATH</span> box was enabled.
                    </Step>
                  </>
                ) : (
                  <>
                    <Step number={1}>
                      Click <span className="text-daw-text font-medium">Download Python</span> below.
                      This opens the official Python website. Download the latest{" "}
                      <span className="text-daw-text font-medium">Python 3.10, 3.11, or 3.12</span> installer for
                      macOS.
                    </Step>
                    <Step number={2}>
                      Open the downloaded installer package and follow the normal steps. If macOS
                      asks for permission, allow it and continue.
                    </Step>
                    <Step number={3}>
                      Restart OpenStudio completely, then click{" "}
                      <span className="text-daw-text font-medium">Retry After Python Install</span>.
                    </Step>
                    <Step number={4}>
                      Advanced option: if you already use Homebrew, you can install Python from
                      Terminal with <CodeSnip>brew install python@3.12</CodeSnip>, then restart
                      OpenStudio and retry from this window.
                    </Step>
                    <Step number={5}>
                      If OpenStudio still cannot find Python after installing it, restart your Mac
                      once and then reopen OpenStudio before retrying.
                    </Step>
                  </>
                )}
              </div>
            </div>
          ) : showSetupSteps ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-daw-text-secondary uppercase tracking-wide">
                Runtime download steps
              </p>
              <div className="space-y-3 pt-1">
                <Step number={1}>
                  Click <span className="text-daw-text font-medium">Retry Install</span> below.
                  OpenStudio will download its AI runtime in the background, verify it, and then
                  prepare it inside your user profile.
                </Step>
                <Step number={2}>
                  Keep OpenStudio open while setup runs. The progress halo around the{" "}
                  <CodeSnip>AI</CodeSnip> toolbar button shows that work is still happening.
                </Step>
                <Step number={3}>
                  If the error mentions the runtime download, checksum, or extraction, retry once
                  and then open the install log if it fails again.
                </Step>
                <Step number={4}>
                  If the message specifically mentions the model download, the runtime is already
                  prepared and you usually only need to retry with a working internet connection.
                </Step>
                <Step number={5}>
                  If setup keeps failing, use <span className="text-daw-text font-medium">Open Install Log</span>{" "}
                  to inspect the detailed log location before retrying again.
                </Step>
              </div>
            </div>
          ) : null}

          {showLatestInstallerActivity ? (
            <div className="rounded-xl border border-neutral-800 bg-black px-3 py-3 font-mono text-[11px] text-green-300">
              <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-neutral-500">
                <span>Latest Installer Activity</span>
                <span>{formatElapsed(aiToolsStatus.elapsedMs)}</span>
              </div>
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {activityLines.map((line, index) => (
                  <div key={`${index}-${line}`} className="break-words">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="border-t border-neutral-800 pt-3 space-y-2">
            <p className="text-xs text-daw-text-secondary leading-relaxed">
              {isInstallComplete
                ? "AI Tools finished installing in this session. You can close this window and continue working."
                : isPartiallyReady
                  ? `Stem separation is ready in this session. ${musicGenerationBlockedMessage} Select Audio Generation to finish that setup, or close this window if you only need stem separation right now.`
                  : "OpenStudio keeps the app responsive while setup runs. This window now shows the live install activity, current phase, and long-download hints."}
            </p>
          </div>
        </div>
      </ModalContent>
      <ModalFooter className="flex-wrap justify-end gap-3 sm:flex-nowrap">
        <Button variant="ghost" onClick={closeAiToolsSetup} className="whitespace-nowrap">
          Close
        </Button>
        {installLogPath ? (
          <Button
            variant="ghost"
            onClick={() => void handleOpenInstallLog()}
            className="whitespace-nowrap"
          >
            Open Install Log
          </Button>
        ) : null}
        {!aiToolsStatus.installInProgress ? (
          <Button variant="ghost" onClick={() => void handleReset()} className="whitespace-nowrap">
            Reset AI Tools
          </Button>
        ) : null}
        {requiresExternalPython && !isInstallComplete ? (
          <Button
            variant="secondary"
            onClick={() => void handleDownloadPython()}
            className="whitespace-nowrap"
          >
            Download Python
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => void (isInstallComplete ? closeAiToolsSetup() : handleRetry())}
          disabled={aiToolsStatus.installInProgress || isReconcilingInstallResult || (!isInstallComplete && selectedFeatures.length === 0)}
          className="whitespace-nowrap"
        >
          {isInstallComplete
              ? "Continue"
            : isPartiallyReady
              ? selectedFeatures.length === 0 ? "Select Feature" : "Install Selected"
              : aiToolsStatus.installInProgress
              ? "Installing..."
              : isReconcilingInstallResult
                ? "Checking Result..."
              : requiresExternalPython && isPythonMissing
                ? "Retry After Python Install"
                : selectedFeatures.length === 0 ? "Select Feature" : "Download and Install"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

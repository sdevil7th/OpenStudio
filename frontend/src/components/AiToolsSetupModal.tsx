import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  Info,
  Music2,
  LoaderCircle,
  RotateCcw,
  Scissors,
  Sparkles,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID, MINIMAX_MUSIC_3_MODEL_ID, isDiffusersImportModel, type AiMusicModelId } from "../data/aiWorkflows";
import { nativeBridge, type AiFeatureId, type AiFeatureStatus, type AiToolsStatus } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Button, Checkbox, Modal, ModalContent, ModalFooter, ModalHeader } from "./ui";
import "./AiToolsSetupModal.css";

const IS_WINDOWS = navigator.platform.startsWith("Win") || navigator.userAgent.includes("Windows");

const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";
const STABLE_AUDIO_MODEL_URL = "https://huggingface.co/stabilityai/stable-audio-3-medium";

const AI_FEATURES: AiFeatureId[] = ["stemSeparation", "audioGeneration"];

type SetupCatalogItemId = AiFeatureId | AiMusicModelId;
type SetupCatalogKind = "feature" | "model";
type SetupCatalogState = "ready" | "installing" | "failed" | "blocked" | "available";

interface SetupCatalogItem {
  id: SetupCatalogItemId;
  kind: SetupCatalogKind;
  label: string;
  shortLabel: string;
  description: string;
  ready: boolean;
  installing: boolean;
  failed: boolean;
  compatible: boolean;
  disabledReason: string;
  primaryAction: string;
  state: SetupCatalogState;
  featureId?: AiFeatureId;
  modelId?: AiMusicModelId;
}

const FEATURE_COPY: Record<AiFeatureId, { label: string; requirements: string; description: string; use: string }> = {
  stemSeparation: {
    label: "Stem Separation",
    requirements: "8 GB system RAM minimum. CPU-only machines are supported.",
    description: "Split audio clips into vocals, drums, bass, and other stems.",
    use: "Right-click an audio clip in the timeline and choose Separate Stems.",
  },
  audioGeneration: {
    label: "Audio Generation",
    requirements: "16 GB system RAM plus CUDA or ROCm GPU with 8 GB memory minimum.",
    description: "Generate audio with ACE-Step and Stable Audio models.",
    use: "Use AI tracks for prompt-first generation, or right-click clips for Variation, Inpaint, and Continue.",
  },
};

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

function compactPhaseLabel(phase?: string): string {
  if (!phase) return "Preparing";
  return phase
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sanitizeSetupMessage(message: string): string {
  const lowered = message.toLowerCase();
  if (
    lowered.includes("vendor_runtime")
    || lowered.includes("nodes_ace.py")
    || lowered.includes("folder_paths.py")
  ) {
    return "ACE-Step runtime files are missing. Repair or reinstall ACE-Step Audio Generation setup.";
  }
  if (message.length > 220) {
    return `${message.slice(0, 220).trim()}...`;
  }
  return message;
}

function isAudioGenerationReady(status: AiToolsStatus): boolean {
  const availableProfiles = status.musicGenerationAvailableProfiles ?? [];
  const nativeProfileReady = availableProfiles.length === 0 || availableProfiles.includes("ace-diffusers");
  return Boolean(status.musicGenerationReady && status.musicGenerationLayoutValid && nativeProfileReady);
}

function getHardwareAudioGenerationCompatible(status: AiToolsStatus): boolean {
  const hardware = status.hardware;
  if (hardware?.audioGenerationGpuSupported) return true;
  const backend = String(hardware?.gpuBackend ?? "").toLowerCase();
  const gpuOk = ["cuda", "rocm"].includes(backend) && (hardware?.gpuMemoryMb ?? 0) >= 8192;
  const ramOk = (hardware?.systemRamMb ?? 0) <= 0 || (hardware?.systemRamMb ?? 0) >= 16384;
  return gpuOk && ramOk;
}

function getFeatureStatus(status: AiToolsStatus, featureId: AiFeatureId): AiFeatureStatus {
  const existing = status.features?.[featureId];
  if (existing) return existing as AiFeatureStatus;

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
      blockReason: compatible ? "" : "This machine needs at least 8 GB system RAM for stem separation.",
      requiresGpu: false,
      minSystemRamMb: 8192,
    };
  }

  const ready = isAudioGenerationReady(status);
  const compatible = ready || getHardwareAudioGenerationCompatible(status);
  return {
    id: "audioGeneration",
    label: FEATURE_COPY.audioGeneration.label,
    ready,
    installed: ready,
    compatible,
    blocked: !compatible,
    blockReason: compatible
      ? ""
      : "This machine does not meet Audio Generation requirements: supported GPU with at least 8 GB memory was not detected.",
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

function getActiveInstallModelId(status: AiToolsStatus): SetupCatalogItemId | null {
  const requestedModels = status.requestedFeatures ?? [];
  if (!status.installInProgress && status.state !== "error" && status.state !== "cancelled") return null;
  if (status.requestedModelId) return status.requestedModelId;
  if (status.requestedFeature === "stemSeparation" || requestedModels.includes("stemSeparation")) {
    return "stemSeparation";
  }
  return status.setupProgressVersion && (status.requestedFeature === "audioGeneration" || requestedModels.includes("audioGeneration"))
    ? ACE_STEP_MODEL_ID : null;
}

function buildCatalogState(item: Omit<SetupCatalogItem, "state">): SetupCatalogState {
  if (item.installing) return "installing";
  if (item.ready) return "ready";
  if (item.failed) return "failed";
  if (!item.compatible) return "blocked";
  return "available";
}

function buildSetupCatalog(status: AiToolsStatus): SetupCatalogItem[] {
  const featureStatuses = AI_FEATURES.reduce((accumulator, featureId) => {
    accumulator[featureId] = getFeatureStatus(status, featureId);
    return accumulator;
  }, {} as Record<AiFeatureId, AiFeatureStatus>);
  const stem = featureStatuses.stemSeparation;
  const audio = featureStatuses.audioGeneration;
  const aceStatus = status.musicModels?.[ACE_STEP_MODEL_ID];
  const stableStatus = status.musicModels?.[STABLE_AUDIO_3_MODEL_ID];
  const activeInstallId = getActiveInstallModelId(status);
  const failed = status.state === "error" || status.state === "cancelled";
  const audioCompatible = Boolean(audio.ready || audio.compatible);

  const stemItem: Omit<SetupCatalogItem, "state"> = {
    id: "stemSeparation",
    kind: "feature",
    label: "Stem Separation",
    shortLabel: "Stems",
    description: FEATURE_COPY.stemSeparation.description,
    ready: Boolean(stem.ready),
    installing: status.installInProgress && activeInstallId === "stemSeparation",
    failed: failed && activeInstallId === "stemSeparation",
    compatible: Boolean(stem.ready || stem.compatible),
    disabledReason: stem.blockReason || "This machine does not meet the system RAM requirement.",
    primaryAction: "Install Stem Separation",
    featureId: "stemSeparation",
  };

  const aceReady = Boolean(aceStatus?.ready ?? audio.ready ?? isAudioGenerationReady(status));
  const aceItem: Omit<SetupCatalogItem, "state"> = {
    id: ACE_STEP_MODEL_ID,
    kind: "model",
    label: "ACE-Step 1.5 XL Turbo",
    shortLabel: "ACE-Step",
    description: "Text-to-music plus source clip variation, inpaint, and continuation.",
    ready: aceReady,
    installing: status.installInProgress && activeInstallId === ACE_STEP_MODEL_ID,
    failed: failed && activeInstallId === ACE_STEP_MODEL_ID,
    compatible: Boolean(aceReady || audioCompatible),
    disabledReason: aceStatus?.blockReason || audio.blockReason || "This machine does not meet the GPU/RAM requirement.",
    primaryAction: "Install ACE-Step",
    featureId: "audioGeneration",
    modelId: ACE_STEP_MODEL_ID,
  };

  const stableReady = Boolean(stableStatus?.ready);
  const stableCompatible = Boolean(stableReady || (stableStatus?.compatible ?? audioCompatible));
  const stableItem: Omit<SetupCatalogItem, "state"> = {
    id: STABLE_AUDIO_3_MODEL_ID,
    kind: "model",
    label: "Stable Audio 3 Medium",
    shortLabel: "Stable Audio",
    description: "Diffusers text-to-audio, source variation, selected-range replacement and continuation.",
    ready: stableReady,
    installing: status.installInProgress && activeInstallId === STABLE_AUDIO_3_MODEL_ID,
    failed: failed && activeInstallId === STABLE_AUDIO_3_MODEL_ID,
    compatible: stableCompatible,
    disabledReason: stableStatus?.blockReason || audio.blockReason || "This machine does not meet the GPU/RAM requirement.",
    primaryAction: "Download and Set Up",
    featureId: "audioGeneration",
    modelId: STABLE_AUDIO_3_MODEL_ID,
  };

  const miniStatus = status.musicModels?.[MINIMAX_MUSIC_3_MODEL_ID];
  const miniItem: Omit<SetupCatalogItem, "state"> = {
    ...stableItem, id: MINIMAX_MUSIC_3_MODEL_ID, modelId: MINIMAX_MUSIC_3_MODEL_ID,
    label: "MiniMax Music 3", shortLabel: "MiniMax",
    description: "Lyrics and structured songs through Modular Diffusers. No source-audio editing.",
    ready: Boolean(miniStatus?.ready), compatible: miniStatus?.compatible ?? true,
    disabledReason: miniStatus?.blockReason ?? "",
    installing: status.installInProgress && activeInstallId === MINIMAX_MUSIC_3_MODEL_ID,
    failed: failed && activeInstallId === MINIMAX_MUSIC_3_MODEL_ID,
  };
  return [stemItem, aceItem, stableItem, miniItem].map((item) => ({ ...item, state: buildCatalogState(item) }));
}

function statusDotClass(state: SetupCatalogState) {
  switch (state) {
    case "ready":
      return "bg-green-400 shadow-[0_0_12px_rgba(74,222,128,0.85)]";
    case "installing":
      return "animate-pulse bg-daw-accent shadow-[0_0_12px_rgba(0,120,212,0.7)]";
    case "failed":
      return "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.65)]";
    case "blocked":
      return "bg-neutral-600";
    default:
      return "bg-yellow-400 shadow-[0_0_10px_rgba(250,204,21,0.45)]";
  }
}

function statusLabel(item: SetupCatalogItem) {
  switch (item.state) {
    case "ready":
      return "Ready";
    case "installing":
      return "Installing";
    case "failed":
      return "Needs attention";
    case "blocked":
      return "Unsupported";
    default:
      return "Available";
  }
}

function getPrimaryUsage(item: SetupCatalogItem) {
  if (item.id === "stemSeparation") {
    return FEATURE_COPY.stemSeparation.use;
  }
  if (item.id === ACE_STEP_MODEL_ID) {
    return "Use AI tracks for Text to Music or Lyrics + Style. Right-click audio clips for Variation, Inpaint Selection, and Continue Clip.";
  }
  if (item.id === MINIMAX_MUSIC_3_MODEL_ID) return "Select MiniMax Music 3 in an AI track for Lyrics + Style or Structured Song.";
  return "Select Stable Audio 3 in an AI track for Text to Audio, or choose it inside the clip generation modal for source-audio workflows.";
}

function getSetupRequirement(item: SetupCatalogItem) {
  if (item.id === "stemSeparation") return FEATURE_COPY.stemSeparation.requirements;
  if (item.id === ACE_STEP_MODEL_ID) return FEATURE_COPY.audioGeneration.requirements;
  return "Downloads model files from Hugging Face. Accept the selected model license before setup.";
}

export default function AiToolsSetupModal() {
  const {
    showAiToolsSetup,
    aiToolsSetupRequestedFeature,
    closeAiToolsSetup,
    installAiTools,
    refreshAiToolsStatus,
    resetAiTools,
    cancelAiToolsInstall,
    aiToolsStatus,
  } = useDAWStore(
    useShallow((s) => ({
      showAiToolsSetup: s.showAiToolsSetup,
      aiToolsSetupRequestedFeature: s.aiToolsSetupRequestedFeature,
      closeAiToolsSetup: s.closeAiToolsSetup,
      installAiTools: s.installAiTools,
      refreshAiToolsStatus: s.refreshAiToolsStatus,
      resetAiTools: s.resetAiTools,
      cancelAiToolsInstall: s.cancelAiToolsInstall,
      aiToolsStatus: s.aiToolsStatus,
    })),
  );

  const [selectedItemId, setSelectedItemId] = useState<SetupCatalogItemId>("stemSeparation");
  const [selectedFeatures, setSelectedFeatures] = useState<AiFeatureId[]>([]);
  const [stableAudioLicenseAccepted, setStableAudioLicenseAccepted] = useState(false);
  const [stableAudioSetupError, setStableAudioSetupError] = useState("");
  const [stableAudioSelectedFolder, setStableAudioSelectedFolder] = useState("");
  const [stableAudioSetupBusy, setStableAudioSetupBusy] = useState(false);
  const [huggingFaceToken, setHuggingFaceToken] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    setStableAudioLicenseAccepted(false);
    setHuggingFaceToken("");
    setStableAudioSelectedFolder("");
    setStableAudioSetupError("");
  }, [selectedItemId, showAiToolsSetup]);

  const catalog = useMemo(() => buildSetupCatalog(aiToolsStatus), [aiToolsStatus]);
  const selectedItem = catalog.find((item) => item.id === selectedItemId) ?? catalog[0];
  const installLogPath = aiToolsStatus.detailLogPath;
  const displayActivityLines = (aiToolsStatus.activityLines ?? []).map(sanitizeSetupMessage);
  const activeInstallItem = catalog.find((item) => item.installing);
  const hasByteProgress = (aiToolsStatus.bytesTotal ?? 0) > 0;
  const bytesRemaining = Math.max(0, (aiToolsStatus.bytesTotal ?? 0) - (aiToolsStatus.bytesDownloaded ?? 0));
  const progressPercent = Math.round(
    hasByteProgress
      ? Math.max(0, Math.min((aiToolsStatus.bytesDownloaded ?? 0) / Math.max(aiToolsStatus.bytesTotal ?? 1, 1), 1)) * 100
      : 0,
  );
  const message = sanitizeSetupMessage(
    aiToolsStatus.error
      || aiToolsStatus.statusWarning
      || aiToolsStatus.message
      || aiToolsStatus.stepLabel
      || "Ready for setup.",
  );
  const isWindowsRuntimeLockFailure =
    IS_WINDOWS &&
    (aiToolsStatus.terminalReason === "runtime_locked_rebuild_failed" ||
      aiToolsStatus.terminalReason === "runtime_rebuild_remove_failed");
  const isReconcilingInstallResult = aiToolsStatus.statusWarningCode === "reconciling_install_state";

  useEffect(() => {
    if (!showAiToolsSetup) return;
    const currentStatus = useDAWStore.getState().aiToolsStatus;
    const defaults = defaultSelectedFeatures(currentStatus, aiToolsSetupRequestedFeature);
    setSelectedFeatures(defaults);

    const activeItemId = currentStatus.installInProgress ? getActiveInstallModelId(currentStatus) : null;
    if (activeItemId) {
      setSelectedItemId(activeItemId);
    } else if (aiToolsSetupRequestedFeature === "audioGeneration") {
      setSelectedItemId(ACE_STEP_MODEL_ID);
    } else if (aiToolsSetupRequestedFeature === "stemSeparation") {
      setSelectedItemId("stemSeparation");
    }
    // Choose an initial item only when opening the dialog or changing its request.
    // Status polling and clicks must not reset the user's model selection.
  }, [showAiToolsSetup, aiToolsSetupRequestedFeature]);

  if (!showAiToolsSetup) return null;

  const handleOpenStableAudioPage = async () => {
    await nativeBridge.openExternalURL(selectedItem.id === MINIMAX_MUSIC_3_MODEL_ID
      ? "https://huggingface.co/MiniMaxAI/MiniMax-Music3" : STABLE_AUDIO_MODEL_URL);
  };

  const handleOpenInstallLog = async () => {
    if (!installLogPath) return;
    await nativeBridge.revealLocalPath(installLogPath);
  };

  const handleDownloadPython = async () => {
    await nativeBridge.openExternalURL(PYTHON_DOWNLOAD_URL);
  };

  const runStableAudioSetup = async (folder?: string) => {
    setStableAudioSetupError("");
    if (!stableAudioLicenseAccepted) {
      setStableAudioSetupError("Accept the selected model license notices before setup.");
      return;
    }

    setStableAudioSelectedFolder(folder ?? "");
    setStableAudioSetupBusy(true);
    try {
      const result = await installAiTools({
        userConfirmedDownload: true,
        selectedFeatures: ["audioGeneration"],
        requestedFeature: "audioGeneration",
        modelId: selectedItem.modelId ?? STABLE_AUDIO_3_MODEL_ID,
        stableAudioModelPath: folder,
        huggingFaceToken: folder ? undefined : huggingFaceToken.trim() || undefined,
        stableAudioLicenseAccepted,
      });

      if (result?.error) {
        setStableAudioSetupError(sanitizeSetupMessage(result.error));
      } else if (result?.started) {
        setStableAudioSetupError("");
        await refreshAiToolsStatus(true);
      } else if (result?.message) {
        setStableAudioSetupError(sanitizeSetupMessage(result.message));
      }
    } catch (error) {
      setStableAudioSetupError(error instanceof Error ? sanitizeSetupMessage(error.message) : String(error));
    } finally {
      setStableAudioSetupBusy(false);
    }
  };

  const handleLocalModelImport = async () => {
    setStableAudioSetupError("");
    let folder = "";
    try {
      folder = await nativeBridge.browseForFolder("Select local audio model snapshot");
    } catch (error) {
      setStableAudioSetupError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (folder) await runStableAudioSetup(folder);
  };

  const handleInstallSelected = async () => {
    if (isDiffusersImportModel(selectedItem.id)) {
      await runStableAudioSetup();
      return;
    }

    const feature = selectedItem.featureId ?? "stemSeparation";
    setSelectedFeatures([feature]);
    await installAiTools({
      userConfirmedDownload: true,
      selectedFeatures: [feature],
      requestedFeature: feature,
      ...(selectedItem.modelId === ACE_STEP_MODEL_ID ? { modelId: ACE_STEP_MODEL_ID } : {}),
    });
  };

  const handleReset = async () => {
    await resetAiTools();
  };

  const renderReadyPane = () => (
    <div className="space-y-4">
      <div className="rounded border border-green-700/40 bg-green-950/20 p-4">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="text-green-400" size={22} />
          <div>
            <p className="text-sm font-semibold text-green-300">Ready to use</p>
            <p className="mt-1 text-xs leading-5 text-daw-text-secondary">{selectedItem.label} is installed and available.</p>
          </div>
        </div>
      </div>
      <div className="rounded border border-neutral-800 bg-neutral-950/60 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">Where to use it</p>
        <p className="mt-2 text-sm leading-6 text-daw-text">{getPrimaryUsage(selectedItem)}</p>
      </div>
    </div>
  );

  const renderBlockedPane = () => (
    <div className="space-y-4">
      <div className="rounded border border-yellow-700/40 bg-yellow-950/20 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 text-yellow-300" size={22} />
          <div>
            <p className="text-sm font-semibold text-yellow-200">Hardware not supported</p>
            <p className="mt-1 text-sm leading-6 text-daw-text-secondary">{selectedItem.disabledReason}</p>
          </div>
        </div>
      </div>
      <div className="rounded border border-neutral-800 bg-neutral-950/60 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">Requirement</p>
        <p className="mt-2 text-sm leading-6 text-daw-text">{getSetupRequirement(selectedItem)}</p>
      </div>
    </div>
  );

  const renderInstallProgress = () => (
    <section aria-label="Setup progress" className="shrink-0 border-b border-daw-border bg-daw-accent/5 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-daw-text">
          <LoaderCircle size={16} aria-hidden="true" className="shrink-0 animate-spin text-daw-accent motion-reduce:animate-none" />
          <span className="break-words">Setting up {activeInstallItem?.label ?? "AI Tools"}</span>
        </div>
        <span className="text-xs tabular-nums text-daw-text-muted">Elapsed {formatElapsed(aiToolsStatus.elapsedMs)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-2 text-xs">
        <p role="status" className="min-w-0 break-words text-daw-text-secondary">
          {compactPhaseLabel(aiToolsStatus.stepLabel || aiToolsStatus.state)}
        </p>
        <span className="shrink-0 tabular-nums text-daw-text">{hasByteProgress ? `${progressPercent}% downloaded` : "In progress"}</span>
      </div>
      <progress aria-label="AI setup progress" max={100} value={hasByteProgress ? progressPercent : undefined}
        className="ai-setup-progress mt-2 block h-2 w-full" />
      {hasByteProgress ? (
        <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
          {[
            ["Downloaded", formatBytes(aiToolsStatus.bytesDownloaded)],
            ["Remaining", formatBytes(bytesRemaining)],
            ["Download size", formatBytes(aiToolsStatus.bytesTotal)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-daw-text-muted">{label}</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums text-daw-text">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {hasByteProgress && (aiToolsStatus.bytesCached ?? 0) > 0 ? (
        <p className="mt-2 text-xs text-daw-text-muted">Includes {formatBytes(aiToolsStatus.bytesCached)} reused from cache.</p>
      ) : null}
      <p className="mt-2 text-xs leading-5 text-daw-text-muted">
        {!aiToolsStatus.setupProgressVersion && !hasByteProgress
          ? "Restart OpenStudio to enable detailed setup progress. Closing the app interrupts setup; completed cached files can be reused on retry."
          : aiToolsStatus.statusWarning || (aiToolsStatus.downloadHint ? sanitizeSetupMessage(aiToolsStatus.downloadHint) : "Setup is working. You can close this panel and return using the AI button.")}
      </p>
    </section>
  );

  const renderStableAudioPane = () => (
    <div className="space-y-4">
      <div className="rounded border border-neutral-800 bg-neutral-950/60 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">Download from Hugging Face</p>
        <p className="mt-2 text-sm leading-6 text-daw-text-secondary">
          {selectedItem.id === STABLE_AUDIO_3_MODEL_ID
            ? "OpenStudio downloads Stable Audio 3 Medium and prepares it for generation automatically. Setup needs extra disk space for conversion and can take several minutes."
            : "OpenStudio downloads the MiniMax Music 3 components needed for generation. This is a large download and requires substantial system RAM; CPU offload reduces GPU memory use."}
        </p>
        <p className="mt-2 text-sm leading-6 text-daw-text-secondary">
          {selectedItem.id === STABLE_AUDIO_3_MODEL_ID
            ? "First request access on the Hugging Face model page and accept the Stability AI and Gemma terms. Once access is approved, use a read token from the same account below."
            : "Review the model license on Hugging Face before downloading. A token is optional for public models."}
        </p>
        <Button className="mt-3" variant="secondary" size="sm" onClick={() => void handleOpenStableAudioPage()} icon={<ExternalLink size={14} />}>
          Open Hugging Face Model Page
        </Button>
      </div>

      <div className="rounded border border-neutral-800 bg-neutral-950/60 p-4">
        <label className="block text-sm text-daw-text" htmlFor="ai-hugging-face-token">Hugging Face read token (optional)</label>
        <input id="ai-hugging-face-token" type="password" autoComplete="off" spellCheck={false}
          value={huggingFaceToken} onChange={(event) => setHuggingFaceToken(event.target.value)}
          className="mt-2 w-full rounded border border-neutral-700 bg-daw-dark px-3 py-2 text-sm text-daw-text focus-visible:outline-2 focus-visible:outline-daw-accent"
          aria-describedby="ai-hugging-face-token-help" />
        <p id="ai-hugging-face-token-help" className="mt-2 text-xs leading-5 text-daw-text-muted">
          Used only for this setup, without saving the token. Leave blank to use your existing Hugging Face login or HF_TOKEN environment variable.
        </p>
        <Button className="mt-2" variant="ghost" size="sm" onClick={() => void nativeBridge.openExternalURL("https://huggingface.co/settings/tokens")} icon={<ExternalLink size={14} />}>
          Get a Read Token
        </Button>
      </div>

      <label className="flex items-start gap-3 rounded border border-neutral-800 bg-neutral-950/60 p-3">
        <Checkbox checked={stableAudioLicenseAccepted} onChange={() => setStableAudioLicenseAccepted((value) => !value)} />
        <span className="text-xs leading-5 text-daw-text-secondary">
          {selectedItem.id === STABLE_AUDIO_3_MODEL_ID
            ? "I have read and accepted the Stability AI and Gemma model licenses."
            : "I have read and accepted the MiniMax Music 3 model license."}
        </span>
      </label>

      <div className="rounded border border-neutral-800 bg-neutral-950/60 p-4">
        <p className="text-sm text-daw-text-secondary">Already downloaded this model? You can import a local folder instead.</p>
        <Button className="mt-2" variant="secondary" size="sm" onClick={() => void handleLocalModelImport()}
          disabled={aiToolsStatus.installInProgress || stableAudioSetupBusy || !stableAudioLicenseAccepted} icon={<FolderOpen size={14} />}>
          Import Local Model
        </Button>
      </div>

      {stableAudioSelectedFolder ? (
        <div className="rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs text-daw-text-secondary">
          Selected folder: <span className="text-daw-text">{stableAudioSelectedFolder}</span>
        </div>
      ) : null}

      {stableAudioSetupError ? (
        <div className="rounded border border-red-700/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {stableAudioSetupError}
        </div>
      ) : null}
    </div>
  );

  const renderInstallPane = () => {
    if (!selectedItem.compatible) return renderBlockedPane();
    if (isDiffusersImportModel(selectedItem.id)) return renderStableAudioPane();

    return (
      <div className="space-y-4">
        <div className="rounded border border-neutral-800 bg-neutral-950/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-daw-text-muted">Setup</p>
          <p className="mt-2 text-sm leading-6 text-daw-text-secondary">{selectedItem.description}</p>
          <p className="mt-3 text-sm leading-6 text-daw-text">{getSetupRequirement(selectedItem)}</p>
        </div>
        {aiToolsStatus.requiresExternalPython ? (
          <div className="rounded border border-yellow-700/40 bg-yellow-950/20 p-4">
            <p className="text-sm font-semibold text-yellow-200">Python is required</p>
            <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
              This dev fallback path needs {IS_WINDOWS ? "Python 3.11" : "Python 3.10 through 3.12"} before setup can continue.
            </p>
            <Button className="mt-3" variant="secondary" size="sm" onClick={() => void handleDownloadPython()} icon={<ExternalLink size={14} />}>
              Download Python
            </Button>
          </div>
        ) : null}
        {isWindowsRuntimeLockFailure ? (
          <div className="rounded border border-yellow-700/40 bg-yellow-950/20 p-4">
            <p className="text-sm font-semibold text-yellow-200">Runtime file was locked</p>
            <p className="mt-1 text-xs leading-5 text-daw-text-secondary">
              OpenStudio attempted a runtime-only rebuild. Retry keeps the downloaded stem models and ACE-Step Diffusers cache in place. Reset AI Tools performs a full cleanup.
            </p>
          </div>
        ) : null}
        <Button
          variant="primary"
          onClick={() => void handleInstallSelected()}
          disabled={aiToolsStatus.installInProgress || isReconcilingInstallResult}
          icon={<Download size={15} />}
        >
          {selectedItem.primaryAction}
        </Button>
        <p className="text-xs leading-5 text-daw-text-muted">
          Incompatible features are disabled and will not be installed.
        </p>
      </div>
    );
  };

  const renderDetails = () => {
    if (!detailsOpen) return null;
    return (
      <div className="rounded border border-neutral-800 bg-black/70 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Installer details</p>
          {installLogPath ? (
            <Button variant="ghost" size="sm" onClick={() => void handleOpenInstallLog()}>
              Open Install Log
            </Button>
          ) : null}
        </div>
        <div className="max-h-40 space-y-1 overflow-y-auto font-mono text-[11px] leading-5 text-green-300">
          {(displayActivityLines.length > 0 ? displayActivityLines : [message]).map((line, index) => (
            <div key={`${index}-${line}`} className="break-words">
              {line}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-daw-text-muted">
          Selected features: {selectedFeatures.length > 0 ? selectedFeatures.join(", ") : "none"}
        </p>
        {installLogPath ? (
          <p className="mt-2 break-all text-[11px] text-daw-text-muted">Log: {installLogPath}</p>
        ) : null}
      </div>
    );
  };

  return (
    <Modal isOpen={showAiToolsSetup} onClose={closeAiToolsSetup} size="xl">
      <ModalHeader title="AI Tools Setup" onClose={closeAiToolsSetup} />
      {aiToolsStatus.installInProgress ? renderInstallProgress() : null}
      <ModalContent className="p-0">
        <div className="grid min-h-[620px] grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="border-b border-neutral-800 bg-neutral-950/70 p-3 md:border-b-0 md:border-r">
            <div className="mb-3 px-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-daw-text-muted">Available tools</p>
            </div>
            <div className="space-y-2">
              {catalog.map((item) => {
                const selected = item.id === selectedItem.id;
                const disabled = !item.compatible && !item.ready;
                const Icon = item.id === "stemSeparation" ? Scissors : item.id === ACE_STEP_MODEL_ID ? Music2 : Sparkles;
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={disabled ? item.disabledReason : statusLabel(item)}
                    onClick={() => setSelectedItemId(item.id)}
                    className={[
                      "group flex w-full items-start gap-3 rounded border px-3 py-3 text-left transition",
                      selected ? "border-daw-accent bg-daw-accent/10" : "border-neutral-800 bg-neutral-950/50 hover:border-neutral-700 hover:bg-neutral-900/60",
                      disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
                    ].join(" ")}
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-neutral-800 bg-neutral-900 text-daw-text-muted">
                      <Icon size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-daw-text">{item.label}</span>
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass(item.state)}`} />
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-daw-text-secondary">{item.description}</span>
                      <span className="mt-2 inline-flex rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-daw-text-muted">
                        {statusLabel(item)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="min-w-0 space-y-4 p-5">
            <div className="flex flex-col gap-3 border-b border-neutral-800 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xl font-semibold text-daw-text">{selectedItem.label}</p>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-daw-text-secondary">{selectedItem.description}</p>
              </div>
              <span className="inline-flex w-fit items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-daw-text">
                <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass(selectedItem.state)}`} />
                {statusLabel(selectedItem)}
              </span>
            </div>

            {aiToolsStatus.installInProgress
              ? <div className="space-y-3 rounded border border-daw-border bg-daw-dark/50 p-4">
                  <p className="text-sm leading-6 text-daw-text-secondary">
                    {selectedItem.installing
                      ? "Setup will download, prepare, and check the model before marking it ready. Keep OpenStudio open while it finishes."
                      : "Another setup is running. Its progress stays visible above while you browse the available tools."}
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => setDetailsOpen((value) => !value)} icon={<ChevronDown size={14} />} aria-expanded={detailsOpen} aria-label={detailsOpen ? "Hide details" : "Show details"}>
                    {detailsOpen ? "Hide details" : "Show details"}
                  </Button>
                </div>
              : selectedItem.ready
                ? renderReadyPane()
                : renderInstallPane()}

            {(aiToolsStatus.state === "error" || aiToolsStatus.state === "cancelled") && selectedItem.failed ? (
              <div className="rounded border border-red-700/40 bg-red-950/30 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 text-red-300" size={20} />
                  <div>
                    <p className="text-sm font-semibold text-red-200">Setup needs attention</p>
                    <p className="mt-1 text-sm leading-6 text-red-100/80">{message}</p>
                  </div>
                </div>
              </div>
            ) : null}

            {renderDetails()}
          </main>
        </div>
      </ModalContent>
      <ModalFooter className="flex-wrap justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={closeAiToolsSetup}>
            Close
          </Button>
          {installLogPath ? (
            <Button variant="ghost" onClick={() => void handleOpenInstallLog()} icon={<Info size={14} />}>
              Open Install Log
            </Button>
          ) : null}
          {!aiToolsStatus.installInProgress ? (
            <Button variant="ghost" onClick={() => void handleReset()} icon={<RotateCcw size={14} />}>
              Reset AI Tools
            </Button>
          ) : null}
        </div>
        {aiToolsStatus.installInProgress ? (
          <Button variant="danger" onClick={() => void cancelAiToolsInstall()}>
            Cancel Setup
          </Button>
        ) : selectedItem.ready ? (
          <Button variant="primary" onClick={closeAiToolsSetup} icon={<CheckCircle2 size={15} />}>
            Continue
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => void handleInstallSelected()}
            disabled={!selectedItem.compatible || isReconcilingInstallResult || stableAudioSetupBusy || (isDiffusersImportModel(selectedItem.id) && !stableAudioLicenseAccepted)}
            icon={<Download size={15} />}
          >
            {selectedItem.primaryAction}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

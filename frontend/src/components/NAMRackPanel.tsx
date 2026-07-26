import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Cable,
  CircleDot,
  Copy,
  Download,
  Edit3,
  FolderOpen,
  Gauge,
  GripVertical,
  EllipsisVertical,
  Library,
  MessageSquare,
  Mic2,
  Plus,
  RotateCcw,
  Save,
  Search,
  Star,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import type {
  AudioDebugSnapshot,
  BuiltInParamDescriptor,
  BuiltInPluginAddress,
  BuiltInPluginSchema,
  NAMCalibrationState,
} from "../services/NativeBridge";
import { nativeBridge } from "../services/NativeBridge";
import { useTONE3000Session } from "../services/tone3000Session";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import {
  NAMExplorer,
  getNAMSourceFlowConfig,
  type NAMExplorerIntent,
  type NAMLibraryFlowMode,
  type OpenStudioFXModuleId,
} from "./NAMExplorer";
import { NAMRackAmpCabStage } from "./NAMRackAmpCabStage";
import {
  NAMRackModeRail,
  NAMRackStageFooter,
  type NAMRackModeRailStatus,
  type RackRightRailTab,
} from "./NAMRackChrome";
import { RackModule } from "./NAMRackChainModule";
import {
  NAMRackDiagnostics,
  type NAMRackDiagnosticsAction,
  type NAMRackDiagnosticsState,
} from "./NAMRackDiagnostics";
import { NAMRackDesignPort, delaySyncDisplay, type NAMRackDesignRecovery } from "./NAMRackDesignPort";
import {
  NAM_RACK_ADVANCED_CONTROL_IDS,
  NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS,
  NAMRackMixerView,
  namRackAdvancedStageForCompactModule,
  orderNAMRackMixerStages,
  projectNAMRackParamForUI,
  type NAMRackAdvancedStageId,
  type RackMixerStripSpec,
} from "./NAMRackMixer";
import {
  type NAMSignalChainPostModule,
  type NAMSignalChainRouteModule,
} from "./NAMSignalChainTypes";
import { NAMCompactChain } from "./NAMCompactChain";
import { resolveNAMRackCabPresentation } from "./NAMCabPresentation";
import { NAMRackRightRail } from "./NAMRackRightRail";
import {
  PEDAL_FACEPLATE_MODULES,
  PedalHardwareStage,
  type PedalFaceplateModuleId,
  type RackModuleId,
} from "./NAMRackPedalHardware";
import { moduleHardwareArt } from "./NAMRackHardwareArt";
import {
  NAM_RACK_SECTIONS,
  deviceSkinForModule,
  deviceSkinsForSection,
  isRackSectionId,
  rackSectionForModule,
  type RackSectionId,
  type NAMRackDeviceSkin,
  type NAMRackVisualMode,
} from "./NAMRackNeuralSkinRegistry";
import { footswitchAssetForState, ledAssetForState } from "./NAMRackControlAssets";
import { NAMRackSceneDevice, sceneForSkin } from "./NAMRackSceneGraph";
import { RackKnob } from "./NAMRackKnob";
import {
  NAMToneSaveModal,
  buildNAMToneSaveDraft,
  normalizeNAMActivePreview,
  saveDraftToMetadata,
  saveNAMTone,
  type NAMToneSaveDraft,
  type NAMToneSlot,
} from "./NAMToneSave";
import { formatParamValue, normalizeParam, quantizeParamValue, stepForParam } from "../utils/builtInParamValue";
import { firstNAMDisplayName, namDisplayNameFromPath, namHardwareDisplayName, resolveNAMToneIdentity } from "../utils/namDisplayName";
import { isNAMNonPortableStateKey, omitNAMNonPortableState } from "../utils/namPortableState";
import { resolveNAMRackMissingAssets, type NAMRackMissingAsset } from "../utils/namAssetRecovery";
import { mutateStoredNAMPreset } from "../utils/namPresetLibrary";
import {
  buildNAMRackRollbackPatch,
  resolveNAMHeaderPresetNavigation,
  type NAMHeaderPresetTarget,
} from "../utils/namRackPresetTransactions";
import { persistOptimisticNAMRackOrder } from "../utils/namRackOrderPersistence";
import { isNAMTunerTelemetryForRack } from "../utils/namTunerTelemetry";
import {
  formatNAMRuntimeDeviceLabel,
  formatNAMRuntimeInputLabel,
  normalizeNAMRuntimeDevice,
  normalizeNAMRuntimeTrack,
  resolveNAMRackWindowCapabilities,
  type NAMRackRuntimeDevice,
  type NAMRackRuntimeTrack,
} from "../utils/namDetachedRuntime";
import { windowRole } from "../utils/windowEnvironment";
import { summarizeNAMCalibrationStatuses, type NAMCalibrationSummaryStatus } from "../utils/namCalibrationSummary";
import { resolveAudioDeadlineStatus } from "../utils/audioDeadlineStatus";
import {
  clampNAMMeterDb,
  namMeterFraction,
  resolveNAMLinkedMeterDb,
} from "../utils/namMeterLevel";
import { Modal } from "./ui";

type NAMRackPanelProps = {
  address: BuiltInPluginAddress;
  schema: BuiltInPluginSchema;
  primaryParams: BuiltInParamDescriptor[];
  groupedParams: Array<[string, BuiltInParamDescriptor[]]>;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
  onRefreshRack: () => BuiltInPluginSchema | null | Promise<BuiltInPluginSchema | null>;
};

type CompareSlot = "A" | "B";
type NAMProductView = "rack" | "browse" | "mixer";
type NAMLibraryFlowState = NAMLibraryFlowMode | null;
type RackSlotBrowserCategory = Exclude<RackModuleId, "pedal"> | "utility";
type NAMRackStageSizePercent = 80 | 100 | 140 | 180 | 220;
type UserRackPreset = { name: string; path?: string; metadataPath?: string; metadata?: UserRackPresetMetadata };
type NAMRackPrompt = {
  kind: "input" | "confirm";
  title: string;
  message: string;
  value: string;
  placeholder?: string;
  confirmLabel: string;
  destructive?: boolean;
  multiline?: boolean;
};
type UserRackPresetMetadata = {
  favorite?: boolean;
  folder?: string;
  tags?: string[];
  notes?: string;
  lastUsed?: number;
  updatedAt?: number;
  importedAt?: number;
  exportedAt?: number;
  sourcePath?: string;
};

const NAM_DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function namDialogFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(NAM_DIALOG_FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

function useNAMOverlayDialog<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const dialogRef = useRef<T | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const animationFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const initialTarget = dialog.querySelector<HTMLElement>("[data-nam-dialog-initial-focus]")
        ?? namDialogFocusableElements(dialog)[0]
        ?? dialog;
      initialTarget.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, [open]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<T>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = namDialogFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const activeElement = document.activeElement;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }, [onClose]);

  return { dialogRef, onKeyDown };
}

type NAMRackPresetExportBundle = {
  schemaVersion: 1;
  kind: "openstudio.namRackPreset";
  app: "OpenStudio";
  appVersion?: string;
  pluginName: typeof NAM_RACK_PLUGIN_NAME;
  presetName: string;
  exportedAt: string;
  metadata: UserRackPresetMetadata;
  state: unknown;
};

type NAMStoredPresetPayload = {
  format: "openstudio.ospreset.base64";
  dataBase64: string;
};

function isNAMStoredPresetPayload(value: unknown): value is NAMStoredPresetPayload {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return source.format === "openstudio.ospreset.base64"
    && typeof source.dataBase64 === "string"
    && source.dataBase64.length > 0;
}

const DEFAULT_RACK_SLOT_ORDER: RackModuleId[] = ["gate", "pedal", "amp", "cab", "eq", "mod", "delay", "reverb"];
const LOCKED_RACK_SPINE: RackModuleId[] = ["gate", "pedal", "amp", "cab"];
const DEFAULT_POST_FX_ORDER: RackModuleId[] = ["eq", "mod", "delay", "reverb"];
const NAM_RACK_PLUGIN_NAME = "OpenStudio NAM Rack";
const NAM_RACK_STAGE_SIZE_OPTIONS = [80, 100, 140, 180, 220] as const satisfies readonly NAMRackStageSizePercent[];
const NAM_RACK_PRESET_METADATA_KEY = "openstudio_nam_rack_preset_metadata";
const NAM_RACK_IR_LIBRARY_KEY = "openstudio_nam_rack_ir_library";
const NAM_RACK_PRESET_BUNDLE_KIND = "openstudio.namRackPreset";
const NAM_RACK_PRESET_METADATA_KIND = "openstudio.namRackPresetMetadata";
const NAM_RACK_PRESET_BUNDLE_EXT = ".s13nampreset";
const DEFAULT_PRESET_FOLDERS = ["Clean", "Crunch", "Lead", "Studio"];
const NAM_RACK_GRAPHIC_EQ_PARAM_IDS = ["eq65Db", "eq125Db", "eq250Db", "eq500Db", "eq1kDb", "eq2kDb", "eq4kDb", "eq8kDb", "eq16kDb"];
const NAM_RACK_GRAPHIC_EQ_NEUTRAL_VALUES: Record<string, number> = Object.fromEntries(
  NAM_RACK_GRAPHIC_EQ_PARAM_IDS.map((id) => [id, 0]),
);
const NAM_RACK_GLOBAL_DEFAULT_VALUES: Record<string, number> = {
  inputMode: 0,
  compressorEnabled: 0,
  compressorDetail: 0.55,
  compressorMix: 0.65,
  compressorVolumeDb: 0,
  compressorComp: 0.35,
  tapeEchoEnabled: 0,
  tapeEchoMix: 0.28,
  tapeEchoTimeMs: 360,
  tapeEchoFeedback: 0.28,
  tapeEchoMod: 0.18,
  tapeEchoTone: 0.58,
  octaverEnabled: 0,
  octaverDownMix: 0.32,
  octaverUpMix: 0.18,
  octaverDirectMix: 1,
  precisionDriveEnabled: 0,
  precisionDriveVolumeDb: 0,
  precisionDriveBright: 0.55,
  precisionDriveAttack: 0.5,
  precisionDriveGate: 0,
  precisionDriveDrive: 0.35,
  chaosEnabled: 0,
  chaosDrive: 0.62,
  chaosTone: 0.55,
  chaosMix: 1,
  chaosLevelDb: 0,
  laserEnabled: 0,
  laserMode: 3,
  laserMix: 0.35,
  laserSpeedHz: 1.2,
  laserSensitivity: 0.45,
  laserEnvelopeMode: 0,
  laserTrigger: 0,
  ampEnabled: 1,
  ampGainDb: 0,
  ampBoost: 0,
  ampVoice: 0,
  ampOutputDb: 0,
  cabMicPosition: 0.5,
  cabMicDistance: 0,
  cabMicBlend: 0.5,
  cabRoomSend: 0,
  cabPan: 0,
  eqEnabled: 0,
  chorusMix: 0.3,
  delayMod: 0.18,
  delayDucker: 0.12,
  delayMode: 1,
  delayPingPong: 1,
  delayTempoSync: 0,
  delayMix: 0.22,
  delayEnabled: 0,
  reverbMix: 0.28,
  reverbEnabled: 0,
  reverbPreDelayMs: 18,
  reverbLowCutHz: 120,
  reverbShimmer: 0,
  chorusCharacter: 1,
  modulatorMode: 0,
  modulatorFeedback: 0.1,
  modulatorAutoRandom: 0,
  modulatorAutoSpeed: 0.35,
  modulatorEnabled: 0,
  modulatorPedalMode: 1,
  modulatorPedalPosition: 0.5,
};

type RackCompareSnapshot = {
  values: Record<string, number>;
  modelState: {
    pedalModelPath?: string;
    ampModelPath?: string;
    cabIRPath?: string;
    pedalDeclaredCaptureType?: string;
    ampDeclaredCaptureType?: string;
    cabRequestedEnabled?: boolean;
    clearPedalModel?: boolean;
    clearAmpModel?: boolean;
    clearCabIR?: boolean;
  };
  postFxOrder?: RackModuleId[];
  presetId: string;
  focusedModule: RackModuleId;
  capturedAt: number;
};

type RackComparePersistence = {
  compareSlot: CompareSlot;
  snapshots: Partial<Record<CompareSlot, RackCompareSnapshot>>;
};

type RackModuleCopy = {
  moduleId: RackModuleId;
  label: string;
  values: Record<string, number>;
  modelState?: RackCompareSnapshot["modelState"];
  capturedAt: number;
};

type RackSlotsPersistence = {
  order: RackModuleId[];
  favorites: RackModuleId[];
  moduleCopies: Partial<Record<RackModuleId, RackModuleCopy>>;
};

type IRLibraryEntry = {
  path: string;
  favorite?: boolean;
  lastUsed: number;
};

function initialNAMProductView(): NAMProductView {
  if (typeof window === "undefined") return "rack";
  const value = new URLSearchParams(window.location.search).get("namView");
  if (value === "browse") return "browse";
  if (value === "mixer" || value === "advanced") return "mixer";
  return "rack";
}

function initialCompactChainOpen() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const legacyView = params.get("namView");
  return params.get("namChain") === "1"
    || legacyView === "pedalboard"
    || legacyView === "pedals"
    || legacyView === "chain";
}

function isNAMLibraryFlowMode(value: unknown): value is NAMLibraryFlowMode {
  return value === "amp" || value === "ir" || value === "fx";
}

function initialNAMLibraryFlow(): NAMLibraryFlowState {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("namLibraryFlow");
  return isNAMLibraryFlowMode(value) ? value : null;
}

function initialNAMLibraryFXModule(): OpenStudioFXModuleId | undefined {
  if (typeof window === "undefined" || initialNAMLibraryFlow() !== "fx") return undefined;
  const value = new URLSearchParams(window.location.search).get("namSourceFilter");
  return value === "eq" || value === "mod" || value === "delay" || value === "reverb" ? value : undefined;
}

function rackModuleForNAMLibraryFlow(flow: NAMLibraryFlowMode): RackModuleId {
  const flowFocus: Record<NAMLibraryFlowMode, RackModuleId> = {
    amp: "amp",
    pedal: "pedal",
    ir: "cab",
    fx: "delay",
  };
  return flowFocus[flow];
}

function rackSectionForNAMLibraryFlow(flow: NAMLibraryFlowMode): RackSectionId {
  if (flow === "fx") return "post";
  return rackSectionForModule(rackModuleForNAMLibraryFlow(flow));
}

function explorerIntentForNAMLibraryFlow(
  flow: NAMLibraryFlowMode,
  sourceFilter?: OpenStudioFXModuleId,
): Omit<NAMExplorerIntent, "token"> {
  const flowIntent: Record<NAMLibraryFlowMode, Omit<NAMExplorerIntent, "token">> = {
    amp: {
      tab: "trending",
      query: "",
      architecture: "all",
      gearFilter: "amp_amp-cab",
      libraryFlow: "amp",
    },
    pedal: {
      tab: "trending",
      query: "",
      architecture: "all",
      gearFilter: "pedal",
      libraryFlow: "pedal",
    },
    ir: {
      tab: "trending",
      query: "ir",
      architecture: "all",
      gearFilter: "ir",
      libraryFlow: "ir",
    },
    fx: {
      tab: "latest",
      query: "",
      architecture: "all",
      gearFilter: "",
      libraryFlow: "fx",
    },
  };
  return sourceFilter ? { ...flowIntent[flow], sourceFilter } : flowIntent[flow];
}

function initialNAMExplorerIntent(): NAMExplorerIntent | null {
  const flow = initialNAMLibraryFlow();
  if (!flow) return null;
  const intent: NAMExplorerIntent = { token: Date.now(), ...explorerIntentForNAMLibraryFlow(flow) };
  if (typeof window === "undefined") return intent;
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("namTab");
  const query = params.get("namQuery");
  const architecture = params.get("namArch");
  const gearFilter = params.get("namGear");
  const sourceFilter = params.get("namSourceFilter");
  if (tab === "latest" || tab === "trending" || tab === "downloads-all-time" || tab === "installed" || tab === "favorites") {
    intent.tab = tab;
  }
  if (query !== null) intent.query = query;
  if (architecture === "a1" || architecture === "a2" || architecture === "custom" || architecture === "all") {
    intent.architecture = architecture;
  }
  if (gearFilter !== null) intent.gearFilter = gearFilter;
  if (flow === "fx" && (sourceFilter === "eq" || sourceFilter === "mod" || sourceFilter === "delay" || sourceFilter === "reverb")) {
    intent.sourceFilter = sourceFilter;
  }
  return intent;
}

const NAM_RACK_PRESETS: Array<{
  id: string;
  name: string;
  focus: RackModuleId;
  description: string;
  requiresAmpModel: true;
  values: Record<string, number>;
}> = [
  {
    id: "clean-twin",
    name: "Current Capture · Clean Polish",
    focus: "amp",
    description: "Template for Current Capture: polished clean effect settings. No NAM Capture or IR is included.",
    requiresAmpModel: true,
    values: {
      inputTrimDb: 0,
      gateThresholdDb: -78,
      gateReleaseMs: 120,
      pedalMix: 0,
      ampMix: 1,
      bassDb: 1.2,
      midDb: -0.6,
      trebleDb: 2.1,
      presenceDb: 1.4,
      cabLevelDb: 0,
      cabHPFHz: 80,
      cabLPFHz: 8500,
      cabPhaseInvert: 0,
      chorusMix: 0,
      chorusRateHz: 0.75,
      chorusDepth: 0.32,
      chorusCharacter: 0,
      delayMix: 0.08,
      delayTimeMs: 310,
      delayFeedback: 0.16,
      reverbMix: 0.18,
      reverbDecaySec: 2.4,
      reverbTone: 0.62,
      reverbShimmer: 0,
      outputTrimDb: 0,
    },
  },
  {
    id: "jc-chorus-clean",
    name: "Current Capture · Wide Chorus",
    focus: "mod",
    description: "Template for Current Capture: chorus and ambience effect settings. No NAM Capture or IR is included.",
    requiresAmpModel: true,
    values: {
      inputTrimDb: -1,
      gateThresholdDb: -82,
      gateReleaseMs: 160,
      pedalMix: 0,
      ampMix: 1,
      bassDb: 0.2,
      midDb: -1.4,
      trebleDb: 1.5,
      presenceDb: 2.2,
      cabLevelDb: -0.8,
      cabHPFHz: 90,
      cabLPFHz: 9200,
      cabPhaseInvert: 0,
      chorusMix: 0.34,
      chorusRateHz: 0.58,
      chorusDepth: 0.58,
      chorusCharacter: 1,
      delayMix: 0.04,
      delayTimeMs: 360,
      delayFeedback: 0.12,
      reverbMix: 0.2,
      reverbDecaySec: 2.8,
      reverbTone: 0.72,
      reverbShimmer: 0,
      // V2 equal-power Chorus is 2.41 dB above the V1 linear-mix reference
      // for this exact CC0 DI setting; preserve the template's prior loudness.
      outputTrimDb: -2.9,
    },
  },
  {
    id: "edge-clean",
    name: "Current Capture · Edge & Echo",
    focus: "delay",
    description: "Template for Current Capture: input, EQ, and delay effect settings. No NAM Capture or IR is included.",
    requiresAmpModel: true,
    values: {
      inputTrimDb: 2,
      gateThresholdDb: -70,
      gateReleaseMs: 95,
      pedalMix: 0.28,
      ampMix: 1,
      bassDb: -0.8,
      midDb: 1.1,
      trebleDb: 1.8,
      presenceDb: 2.4,
      cabLevelDb: -0.5,
      cabHPFHz: 95,
      cabLPFHz: 7800,
      cabPhaseInvert: 0,
      chorusMix: 0.08,
      chorusRateHz: 0.85,
      chorusDepth: 0.26,
      chorusCharacter: 0,
      delayMix: 0.18,
      delayTimeMs: 430,
      delayFeedback: 0.28,
      reverbMix: 0.16,
      reverbDecaySec: 2.1,
      reverbTone: 0.58,
      reverbShimmer: 0,
      outputTrimDb: -1,
    },
  },
  {
    id: "crunch",
    name: "Current Capture · Mid Push",
    focus: "pedal",
    description: "Template for Current Capture: pedal balance and mid-push effect settings. No NAM Capture or IR is included.",
    requiresAmpModel: true,
    values: {
      inputTrimDb: 3.5,
      gateThresholdDb: -64,
      gateReleaseMs: 75,
      pedalMix: 0.72,
      precisionDriveEnabled: 1,
      precisionDriveVolumeDb: 0,
      precisionDriveBright: 0.6,
      precisionDriveAttack: 0.7,
      precisionDriveGate: 0.15,
      precisionDriveDrive: 0.55,
      ampMix: 1,
      bassDb: -1.2,
      midDb: 2.4,
      trebleDb: 0.8,
      presenceDb: 1.2,
      cabLevelDb: -1.5,
      cabHPFHz: 105,
      cabLPFHz: 6800,
      cabPhaseInvert: 0,
      chorusMix: 0,
      chorusRateHz: 0.75,
      chorusDepth: 0.28,
      chorusCharacter: 0,
      delayMix: 0.06,
      delayTimeMs: 290,
      delayFeedback: 0.14,
      reverbMix: 0.12,
      reverbDecaySec: 1.7,
      reverbTone: 0.48,
      reverbShimmer: 0,
      outputTrimDb: -2,
    },
  },
  {
    id: "modern-high-gain",
    name: "Current Capture · Tight High Gain",
    focus: "gate",
    description: "Template for Current Capture: gate, EQ, and ambience effect settings. No NAM Capture or IR is included.",
    requiresAmpModel: true,
    values: {
      inputTrimDb: 1.5,
      gateThresholdDb: -54,
      gateReleaseMs: 55,
      pedalMix: 1,
      precisionDriveEnabled: 0,
      precisionDriveVolumeDb: -1.2,
      precisionDriveBright: 0.62,
      precisionDriveAttack: 0.78,
      precisionDriveGate: 0.28,
      precisionDriveDrive: 0.72,
      chaosEnabled: 1,
      chaosDrive: 0.78,
      chaosTone: 0.58,
      chaosMix: 1,
      chaosLevelDb: -1.2,
      ampMix: 1,
      bassDb: -0.2,
      midDb: 1.6,
      trebleDb: 1,
      presenceDb: 2.8,
      cabLevelDb: -2,
      cabHPFHz: 115,
      cabLPFHz: 6200,
      cabPhaseInvert: 0,
      chorusMix: 0,
      chorusRateHz: 0.75,
      chorusDepth: 0.24,
      chorusCharacter: 2,
      delayMix: 0.05,
      delayTimeMs: 360,
      delayFeedback: 0.1,
      reverbMix: 0.09,
      reverbDecaySec: 1.4,
      reverbTone: 0.44,
      reverbShimmer: 0,
      outputTrimDb: -3,
    },
  },
  {
    id: "shimmer-bloom",
    name: "Current Capture · Shimmer Bloom",
    focus: "reverb",
    description: "Template for Current Capture: restrained Ensemble width and octave-feedback ambience. No NAM Capture or IR is included.",
    requiresAmpModel: true,
    values: {
      inputTrimDb: -1,
      gateThresholdDb: -78,
      gateReleaseMs: 150,
      pedalMix: 0,
      ampMix: 1,
      bassDb: -0.4,
      midDb: -0.8,
      trebleDb: 1.2,
      presenceDb: 1.4,
      cabLevelDb: -1,
      cabHPFHz: 90,
      cabLPFHz: 8600,
      cabPhaseInvert: 0,
      chorusMix: 0.16,
      chorusRateHz: 0.46,
      chorusDepth: 0.42,
      chorusCharacter: 1,
      delayMix: 0.08,
      delayTimeMs: 410,
      delayFeedback: 0.16,
      reverbMix: 0.26,
      reverbDecaySec: 3.8,
      reverbTone: 0.62,
      reverbPreDelayMs: 18,
      reverbLowCutHz: 180,
      reverbShimmer: 0.55,
      outputTrimDb: -1.5,
    },
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatPercentParam(param: BuiltInParamDescriptor | undefined, label: string, fallback: string) {
  return param ? `${label} ${Math.round(normalizeParam(param) * 100)}%` : fallback;
}

function coerceRackStageSizePercent(value: number): NAMRackStageSizePercent {
  return NAM_RACK_STAGE_SIZE_OPTIONS.reduce((nearest, option) => (
    Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest
  ), 140 as NAMRackStageSizePercent);
}

function initialRackStageSizePercent(): NAMRackStageSizePercent {
  if (typeof window === "undefined") return 140;
  const rawParam = new URLSearchParams(window.location.search).get("namRackSize");
  if (!rawParam?.trim()) return 140;
  const rawValue = Number(rawParam);
  return Number.isFinite(rawValue) ? coerceRackStageSizePercent(rawValue) : 140;
}

function paramById(params: BuiltInParamDescriptor[], id: string) {
  return params.find((param) => param.id === id);
}

function presetValuesWithRackDefaults(values: Record<string, number>) {
  const merged: Record<string, number> = {
    ...NAM_RACK_GRAPHIC_EQ_NEUTRAL_VALUES,
    ...NAM_RACK_GLOBAL_DEFAULT_VALUES,
    ...values,
  };
  if (!NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS.some((option) => option.value === Math.round(merged.laserMode))) {
    merged.laserMode = NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[0].value;
  }
  return merged;
}

function fileName(path: string | undefined) {
  return namDisplayNameFromPath(path);
}

function formatIRLastUsed(value: number | undefined) {
  if (!value) return "Recent";
  const ageMs = Date.now() - value;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "Recent";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

function presetDirty(preset: typeof NAM_RACK_PRESETS[number], params: BuiltInParamDescriptor[]) {
  return Object.entries(presetValuesWithRackDefaults(preset.values)).some(([id, expected]) => {
    const param = paramById(params, id);
    if (!param) return false;
    return Math.abs(param.value - expected) > Math.max(stepForParam(param) * 2, 0.01);
  });
}

function snapshotDiffers(current: RackCompareSnapshot, saved?: RackCompareSnapshot) {
  if (!saved) return true;
  const ids = new Set([...Object.keys(current.values), ...Object.keys(saved.values)]);
  for (const id of ids) {
    if (Math.abs((current.values[id] ?? 0) - (saved.values[id] ?? 0)) > 0.0001) return true;
  }

  for (const key of [
    "pedalModelPath",
    "ampModelPath",
    "cabIRPath",
    "pedalDeclaredCaptureType",
    "ampDeclaredCaptureType",
  ] as const) {
    if ((current.modelState[key] ?? "") !== (saved.modelState[key] ?? "")) return true;
  }
  const currentCabRequest = typeof current.modelState.cabRequestedEnabled === "boolean"
    ? current.modelState.cabRequestedEnabled
    : Number.isFinite(current.values.cabEnabled)
      ? current.values.cabEnabled >= 0.5
      : undefined;
  const savedCabRequest = typeof saved.modelState.cabRequestedEnabled === "boolean"
    ? saved.modelState.cabRequestedEnabled
    : Number.isFinite(saved.values.cabEnabled)
      ? saved.values.cabEnabled >= 0.5
      : undefined;
  if (
    (currentCabRequest !== undefined || savedCabRequest !== undefined)
    && currentCabRequest !== savedCabRequest
  ) {
    return true;
  }

  // Old persisted snapshots did not include routing order. Preserve their
  // existing behaviour, while every newly captured snapshot compares the
  // audible post-FX route as part of the tone.
  if (
    current.postFxOrder
    && saved.postFxOrder
    && !sameRackSlotOrder(current.postFxOrder, saved.postFxOrder)
  ) {
    return true;
  }

  return false;
}

function isCompareSlot(value: unknown): value is CompareSlot {
  return value === "A" || value === "B";
}

function isRackModuleId(value: unknown): value is RackModuleId {
  return (
    value === "gate" ||
    value === "pedal" ||
    value === "amp" ||
    value === "cab" ||
    value === "eq" ||
    value === "mod" ||
    value === "delay" ||
    value === "reverb"
  );
}

function isPedalFaceplateModuleId(value: RackModuleId): value is PedalFaceplateModuleId {
  return PEDAL_FACEPLATE_MODULES.includes(value as PedalFaceplateModuleId);
}

function initialRackFocus(): RackModuleId {
  if (typeof window === "undefined") return "amp";
  const value = new URLSearchParams(window.location.search).get("namFocus");
  return isRackModuleId(value) ? value : "amp";
}

function initialRackSection(): RackSectionId {
  if (typeof window === "undefined") return "amp";
  const searchParams = new URLSearchParams(window.location.search);
  const value = searchParams.get("namSection");
  if (isRackSectionId(value)) return value === "special" ? "post" : value;
  return rackSectionForModule(initialRackFocus());
}

function initialNAMRackVisualMode(): NAMRackVisualMode {
  if (typeof window === "undefined") return "approved-parity-2d";
  const value = new URLSearchParams(window.location.search).get("namVisualMode");
  return value === "debug-anchors" ? "debug-anchors" : "approved-parity-2d";
}

function initialPresetManagerOpen() {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get("namPresetManager");
  return value === "1" || value === "true";
}

function sanitizePresetName(value: string) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function sanitizePresetTag(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 28);
}

function sanitizePresetFolder(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").slice(0, 42);
}

function sanitizePresetNotes(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 280);
}

function parsePresetTags(value: string) {
  return Array.from(new Set(
    value
      .split(",")
      .map(sanitizePresetTag)
      .filter(Boolean),
  )).slice(0, 8);
}

function compactPresetMetadata(metadata: unknown): UserRackPresetMetadata {
  const source = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as UserRackPresetMetadata
    : {};
  const next: UserRackPresetMetadata = {};
  if (source.favorite) next.favorite = true;
  const folder = sanitizePresetFolder(source.folder ?? "");
  if (folder) next.folder = folder;
  const rawTags = Array.isArray(source.tags) ? source.tags : [];
  const tags = Array.from(new Set(rawTags.map((tag) => sanitizePresetTag(String(tag))).filter(Boolean))).slice(0, 8);
  if (tags.length) next.tags = tags;
  const notes = sanitizePresetNotes(source.notes ?? "");
  if (notes) next.notes = notes;
  for (const key of ["lastUsed", "updatedAt", "importedAt", "exportedAt"] as const) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) next[key] = value;
  }
  const sourcePath = typeof source.sourcePath === "string" ? source.sourcePath.trim() : "";
  if (sourcePath) next.sourcePath = sourcePath.slice(0, 512);
  return next;
}

function fallbackPresetMetadata(name: string, metadata: UserRackPresetMetadata | undefined): UserRackPresetMetadata {
  const compact = compactPresetMetadata(metadata);
  return {
    ...compact,
    folder: compact.folder || "Studio",
    tags: compact.tags?.length ? compact.tags : parsePresetTags(name),
  };
}

function presetFileStem(name: string) {
  const stem = sanitizePresetName(name).replace(/\s+/g, "_").replace(/_+/g, "_");
  return stem || "OpenStudio_NAM_Rack";
}

function presetMetadataPath(entry: UserRackPreset | undefined) {
  if (!entry) return "";
  if (entry.metadataPath) return entry.metadataPath;
  return entry.path ? `${entry.path}.metadata.json` : "";
}

function normalizePresetSidecar(raw: unknown, fallbackName: string): UserRackPresetMetadata | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const kind = typeof source.kind === "string" ? source.kind : "";
  if (kind && kind !== NAM_RACK_PRESET_METADATA_KIND) return undefined;
  const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? source.metadata
    : source;
  const compact = compactPresetMetadata(metadata);
  const fallback = fallbackPresetMetadata(fallbackName, compact);
  return Object.keys(compact).length ? { ...fallback, ...compact } : undefined;
}

async function savePresetMetadataSidecar(presetName: string, metadata: UserRackPresetMetadata, metadataPath: string) {
  if (!metadataPath) return false;
  const safeName = sanitizePresetName(presetName);
  if (!safeName) return false;
  const updatedAt = typeof metadata.updatedAt === "number" && Number.isFinite(metadata.updatedAt)
    ? metadata.updatedAt
    : Date.now();
  const payload = {
    schemaVersion: 1,
    kind: NAM_RACK_PRESET_METADATA_KIND,
    pluginName: NAM_RACK_PLUGIN_NAME,
    presetName: safeName,
    updatedAt: new Date(updatedAt).toISOString(),
    metadata: {
      ...compactPresetMetadata(metadata),
      updatedAt,
    },
  };
  return nativeBridge.saveProjectToFile(metadataPath, JSON.stringify(payload, null, 2));
}

function normalizePresetBundle(raw: unknown): { presetName: string; metadata: UserRackPresetMetadata; state: unknown } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const kind = typeof source.kind === "string" ? source.kind : "";
  if (kind && kind !== NAM_RACK_PRESET_BUNDLE_KIND) return undefined;

  const presetName = sanitizePresetName(
    typeof source.presetName === "string"
      ? source.presetName
      : typeof source.name === "string"
        ? source.name
        : "Imported NAM Rack Preset",
  );
  if (!presetName) return undefined;

  const state = source.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;

  const metadata = compactPresetMetadata(
    source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
      ? source.metadata as UserRackPresetMetadata
      : {},
  );

  return { presetName, metadata, state };
}

function loadPresetMetadata(): Record<string, UserRackPresetMetadata> {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const devDefaults: Record<string, UserRackPresetMetadata> = params.get("mockPlugin") === "nam"
    ? {
      "JC Chorus Wide": { favorite: true, folder: "Clean", tags: ["chorus", "wide"], notes: "Wide chorus clean for DI guitar and glassy A2 captures.", lastUsed: Date.now() - 120000 },
      "Tele Clean Saved": { folder: "Studio", tags: ["tele", "clean"], notes: "Bright edge-clean preset kept for single-coil auditioning.", lastUsed: Date.now() - 3600000 },
    }
    : {};
  try {
    const raw = window.localStorage.getItem(NAM_RACK_PRESET_METADATA_KEY);
    if (!raw) return devDefaults;
    const parsed = JSON.parse(raw);
    const stored = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, UserRackPresetMetadata>
      : {};
    return { ...devDefaults, ...stored };
  } catch {
    return devDefaults;
  }
}

function savePresetMetadata(metadata: Record<string, UserRackPresetMetadata>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NAM_RACK_PRESET_METADATA_KEY, JSON.stringify(metadata));
}

function normalizeIRLibrary(raw: unknown): IRLibraryEntry[] {
  const entries = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const source = entry as Record<string, unknown>;
      const path = typeof source.path === "string" ? source.path.trim() : "";
      if (!path || seen.has(path)) return null;
      seen.add(path);
      const lastUsed = typeof source.lastUsed === "number" && Number.isFinite(source.lastUsed)
        ? source.lastUsed
        : 0;
      const normalized: IRLibraryEntry = {
        path,
        favorite: source.favorite === true,
        lastUsed,
      };
      return normalized;
    })
    .filter((entry): entry is IRLibraryEntry => Boolean(entry))
    .sort((left, right) => (right.favorite ? 1 : 0) - (left.favorite ? 1 : 0) || right.lastUsed - left.lastUsed)
    .slice(0, 24);
}

function loadIRLibrary(): IRLibraryEntry[] {
  if (typeof window === "undefined") return [];
  const params = new URLSearchParams(window.location.search);
  const devDefaults: IRLibraryEntry[] = params.get("mockPlugin") === "nam"
    ? [
      { path: "C:\\OpenStudio\\IRs\\Studio 2x12 Bright.wav", favorite: true, lastUsed: Date.now() - 180000 },
      { path: "C:\\OpenStudio\\IRs\\Open Back Clean Room.wav", favorite: true, lastUsed: Date.now() - 420000 },
      { path: "C:\\OpenStudio\\IRs\\Tight 1x12 Ribbon.wav", lastUsed: Date.now() - 2400000 },
      { path: "C:\\OpenStudio\\IRs\\Wide JC Chorus Cab.wav", lastUsed: Date.now() - 7200000 },
    ]
    : [];
  try {
    const raw = window.localStorage.getItem(NAM_RACK_IR_LIBRARY_KEY);
    if (!raw) return devDefaults;
    return normalizeIRLibrary([...normalizeIRLibrary(JSON.parse(raw)), ...devDefaults]);
  } catch {
    return devDefaults;
  }
}

function saveIRLibrary(entries: IRLibraryEntry[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NAM_RACK_IR_LIBRARY_KEY, JSON.stringify(normalizeIRLibrary(entries)));
}

function normalizeCompareSnapshot(raw: unknown): RackCompareSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const rawValues = source.values && typeof source.values === "object"
    ? (source.values as Record<string, unknown>)
    : {};
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawValues)) {
    if (
      key !== "transposeSemitones"
      && !isNAMNonPortableStateKey(key)
      && typeof value === "number"
      && Number.isFinite(value)
    ) {
      values[key] = key === "laserMode"
        && !NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS.some((option) => option.value === Math.round(value))
        ? NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[0].value
        : value;
    }
  }

  const rawModel = source.modelState && typeof source.modelState === "object"
    ? (source.modelState as Record<string, unknown>)
    : {};
  const modelState: RackCompareSnapshot["modelState"] = {};
  for (const key of [
    "pedalModelPath",
    "ampModelPath",
    "cabIRPath",
    "pedalDeclaredCaptureType",
    "ampDeclaredCaptureType",
  ] as const) {
    if (typeof rawModel[key] === "string" && rawModel[key]) modelState[key] = rawModel[key] as string;
  }
  for (const key of ["clearPedalModel", "clearAmpModel", "clearCabIR"] as const) {
    if (rawModel[key] === true) modelState[key] = true;
  }
  if (typeof rawModel.cabRequestedEnabled === "boolean") {
    modelState.cabRequestedEnabled = rawModel.cabRequestedEnabled;
  } else if (Number.isFinite(values.cabEnabled)) {
    // Legacy snapshots only stored the effective Cab scalar. Promote the only
    // intent they contain into the new explicit field so recall and dirty-state
    // comparison cannot silently mutate a hidden cabinet preference.
    modelState.cabRequestedEnabled = values.cabEnabled >= 0.5;
  }
  const postFxOrder = Array.isArray(source.postFxOrder)
    ? normalizeRackSlotOrder(source.postFxOrder).filter((moduleId) => !isLockedSpineModule(moduleId))
    : undefined;

  return {
    values,
    modelState,
    ...(postFxOrder ? { postFxOrder } : {}),
    presetId: typeof source.presetId === "string" ? source.presetId : NAM_RACK_PRESETS[0].id,
    focusedModule: isRackModuleId(source.focusedModule) ? source.focusedModule : "amp",
    capturedAt: typeof source.capturedAt === "number" && Number.isFinite(source.capturedAt)
      ? source.capturedAt
      : Date.now(),
  };
}

function normalizeCompareUiState(uiState: unknown): RackComparePersistence | undefined {
  if (!uiState || typeof uiState !== "object") return undefined;
  const source = (uiState as Record<string, unknown>).namRackCompare;
  if (!source || typeof source !== "object") return undefined;
  const raw = source as Record<string, unknown>;
  const rawSnapshots = raw.snapshots && typeof raw.snapshots === "object"
    ? (raw.snapshots as Record<string, unknown>)
    : {};
  const snapshots: Partial<Record<CompareSlot, RackCompareSnapshot>> = {};
  for (const slot of ["A", "B"] as CompareSlot[]) {
    const snapshot = normalizeCompareSnapshot(rawSnapshots[slot]);
    if (snapshot) snapshots[slot] = snapshot;
  }

  return {
    compareSlot: isCompareSlot(raw.compareSlot) ? raw.compareSlot : "A",
    snapshots,
  };
}

function normalizeRackSlotOrder(rawOrder: unknown): RackModuleId[] {
  const source = Array.isArray(rawOrder) ? rawOrder : [];
  const seen = new Set<RackModuleId>();
  const order: RackModuleId[] = [...LOCKED_RACK_SPINE];
  for (const moduleId of LOCKED_RACK_SPINE) seen.add(moduleId);
  for (const item of source) {
    if (!isRackModuleId(item) || seen.has(item) || isLockedSpineModule(item)) continue;
    order.push(item);
    seen.add(item);
  }
  for (const moduleId of DEFAULT_RACK_SLOT_ORDER) {
    if (!seen.has(moduleId) && !isLockedSpineModule(moduleId)) order.push(moduleId);
  }
  return order;
}

function normalizeRackSlotFavorites(rawFavorites: unknown): RackModuleId[] {
  const source = Array.isArray(rawFavorites) ? rawFavorites : [];
  const seen = new Set<RackModuleId>();
  const favorites: RackModuleId[] = [];
  for (const item of source) {
    if (!isRackModuleId(item) || seen.has(item)) continue;
    favorites.push(item);
    seen.add(item);
  }
  return favorites;
}

function moduleParamIds(moduleId: RackModuleId) {
  const map: Record<RackModuleId, string[]> = {
    gate: ["gateThresholdDb", "gateReleaseMs"],
    pedal: [
      "precisionDriveVolumeDb", "precisionDriveBright", "precisionDriveAttack",
      "precisionDriveGate", "precisionDriveDrive", "precisionDriveEnabled",
      "chaosEnabled", "chaosDrive", "chaosTone", "chaosMix", "chaosLevelDb",
    ],
    amp: ["ampEnabled", "ampGainDb", "ampBoost", "ampVoice", "bassDb", "midDb", "trebleDb", "presenceDb", "ampMix", "ampOutputDb"],
    cab: ["cabEnabled", "cabMicPosition", "cabMicDistance", "cabMicBlend", "cabRoomSend", "cabLevelDb", "cabPan", "cabHPFHz", "cabLPFHz", "cabPhaseInvert"],
    eq: ["eqEnabled", ...NAM_RACK_GRAPHIC_EQ_PARAM_IDS],
    mod: ["modulatorEnabled", "chorusMix", "chorusRateHz", "chorusDepth", "chorusCharacter", "modulatorMode", "modulatorFeedback", "modulatorAutoRandom", "modulatorAutoSpeed", "modulatorPedalMode", "modulatorPedalPosition"],
    delay: ["delayEnabled", "delayMix", "delayTimeMs", "delayFeedback", "delayMod", "delayDucker", "delayMode", "delayPingPong", "delayTempoSync"],
    reverb: ["reverbEnabled", "reverbMix", "reverbDecaySec", "reverbPreDelayMs", "reverbLowCutHz", "reverbTone", "reverbShimmer"],
  };
  return map[moduleId];
}

function normalizeRackModuleCopy(raw: unknown): RackModuleCopy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  if (!isRackModuleId(source.moduleId)) return undefined;
  const rawValues = source.values && typeof source.values === "object"
    ? source.values as Record<string, unknown>
    : {};
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawValues)) {
    if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
  }
  if (Object.keys(values).length === 0) return undefined;

  const copy: RackModuleCopy = {
    moduleId: source.moduleId,
    label: typeof source.label === "string" && source.label.trim()
      ? source.label.trim()
      : `${moduleTitle(source.moduleId)} copy`,
    values,
    capturedAt: typeof source.capturedAt === "number" && Number.isFinite(source.capturedAt)
      ? source.capturedAt
      : Date.now(),
  };

  const snapshot = normalizeCompareSnapshot({
    values: {},
    modelState: source.modelState,
    presetId: NAM_RACK_PRESETS[0].id,
    focusedModule: source.moduleId,
    capturedAt: copy.capturedAt,
  });
  if (snapshot?.modelState && Object.keys(snapshot.modelState).length > 0) copy.modelState = snapshot.modelState;
  return copy;
}

function normalizeRackModuleCopies(rawCopies: unknown): Partial<Record<RackModuleId, RackModuleCopy>> {
  const source = rawCopies && typeof rawCopies === "object" ? rawCopies as Record<string, unknown> : {};
  const copies: Partial<Record<RackModuleId, RackModuleCopy>> = {};
  for (const [key, rawCopy] of Object.entries(source)) {
    if (!isRackModuleId(key)) continue;
    const copy = normalizeRackModuleCopy(rawCopy);
    if (copy && copy.moduleId === key) copies[key] = copy;
  }
  return copies;
}

function normalizeRackSlotsUiState(uiState: unknown): RackSlotsPersistence {
  const fallback: RackSlotsPersistence = { order: DEFAULT_RACK_SLOT_ORDER, favorites: [], moduleCopies: {} };
  if (!uiState || typeof uiState !== "object") return fallback;
  const source = (uiState as Record<string, unknown>).namRackSlots;
  if (!source || typeof source !== "object") return fallback;
  const raw = source as Record<string, unknown>;
  return {
    order: normalizeRackSlotOrder(raw.order),
    favorites: normalizeRackSlotFavorites(raw.favorites),
    moduleCopies: normalizeRackModuleCopies(raw.moduleCopies),
  };
}

function postFxOrderFromPluginState(state: unknown): RackModuleId[] | undefined {
  if (!state || typeof state !== "object") return undefined;
  const uiState = (state as Record<string, unknown>).uiState;
  if (!uiState || typeof uiState !== "object") return undefined;
  const rackSlots = (uiState as Record<string, unknown>).namRackSlots;
  if (!rackSlots || typeof rackSlots !== "object") return undefined;
  const rawOrder = (rackSlots as Record<string, unknown>).order;
  if (!Array.isArray(rawOrder)) return undefined;
  return normalizeRackSlotOrder(rawOrder).filter((moduleId) => !isLockedSpineModule(moduleId));
}

function sameRackSlotOrder(left: RackModuleId[], right: RackModuleId[]) {
  return left.length === right.length && left.every((moduleId, index) => moduleId === right[index]);
}

function moveRackSlot(order: RackModuleId[], moduleId: RackModuleId, toIndex: number) {
  const fromIndex = order.indexOf(moduleId);
  if (fromIndex < 0) return order;
  const next = order.filter((entry) => entry !== moduleId);
  next.splice(clamp(toIndex, 0, next.length), 0, moduleId);
  return normalizeRackSlotOrder(next);
}

function isLockedSpineModule(moduleId: RackModuleId) {
  return LOCKED_RACK_SPINE.includes(moduleId);
}

function isValidRackSlotDrop(order: RackModuleId[], dragged: RackModuleId, target: RackModuleId) {
  if (dragged === target) return false;
  if (isLockedSpineModule(dragged) || isLockedSpineModule(target)) return false;
  return order.indexOf(dragged) >= 0 && order.indexOf(target) >= 0;
}

function moduleTitle(moduleId: RackModuleId) {
  const titles: Record<RackModuleId, string> = {
    gate: "Gate And Input",
    pedal: "Pedal Capture",
    amp: "Amp Capture",
    cab: "Cabinet And IR",
    eq: "Tone Stack",
    mod: "Modulation",
    delay: "Delay",
    reverb: "Reverb",
  };
  return titles[moduleId];
}

function moduleStageBody(moduleId: RackModuleId) {
  switch (moduleId) {
    case "pedal": return "NAM pedal slot before the amp/full-rig capture.";
    case "gate": return "Set the input floor and release before the capture sees the guitar.";
    case "eq": return "OpenStudio post-Capture EQ controls. These are effect controls, not NAM Capture parameters.";
    case "mod": return "Chorus-style width for clean and edge-clean guitar tones.";
    case "delay": return "OpenStudio delay after the Capture and IR stages, with mix, time, and feedback.";
    case "reverb": return "OpenStudio reverb at the end of the rack, with mix, decay, and tone.";
    case "cab": return "Convolution IR loading plus HPF, LPF, level, and phase controls.";
    case "amp": return "A1/A2 neural amp capture host.";
  }
}

function juceMeterClamp(levelDb: number) {
  return clampNAMMeterDb(levelDb);
}

function meterPercent(levelDb: number | undefined) {
  return namMeterFraction(levelDb);
}

function formatDb(levelDb: number | undefined) {
  if (typeof levelDb !== "number" || !Number.isFinite(levelDb)) return "-- dB";
  return `${clamp(levelDb, -90, 24).toFixed(1)} dB`;
}

function numberFromRecord(source: Record<string, unknown> | null | undefined, key: string) {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringFromRecord(source: Record<string, unknown> | null | undefined, key: string) {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanFromRecord(source: Record<string, unknown> | null | undefined, key: string) {
  const value = source?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function MeterTrimControl({
  label,
  levelDb,
  param,
  onChange,
}: {
  label: string;
  levelDb?: number;
  param?: BuiltInParamDescriptor;
  onChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const hasLevel = typeof levelDb === "number" && Number.isFinite(levelDb);
  const clampedLevel = hasLevel ? juceMeterClamp(levelDb) : -60;
  const targetPct = meterPercent(levelDb);
  const [meterMotion, setMeterMotion] = useState({
    levelPct: targetPct,
    peakPct: targetPct,
  });
  const levelPctRef = useRef(targetPct);
  const peakPctRef = useRef(targetPct);
  const peakHoldUntilRef = useRef(0);
  const faderRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ pointerId: number } | null>(null);

  useEffect(() => {
    let animationFrame = 0;
    let previousTime = performance.now();

    const animate = (now: number) => {
      const elapsedMs = Math.min(64, Math.max(1, now - previousTime));
      previousTime = now;
      const currentLevel = levelPctRef.current;
      const levelTimeConstantMs = targetPct >= currentLevel ? 38 : 310;
      const levelCoefficient = 1 - Math.exp(-elapsedMs / levelTimeConstantMs);
      const nextLevel = currentLevel + (targetPct - currentLevel) * levelCoefficient;

      let nextPeak = peakPctRef.current;
      if (targetPct > nextPeak + 0.0005) {
        nextPeak = targetPct;
        peakHoldUntilRef.current = now + 720;
      } else if (now >= peakHoldUntilRef.current) {
        const peakCoefficient = 1 - Math.exp(-elapsedMs / 640);
        nextPeak += (targetPct - nextPeak) * peakCoefficient;
      }

      levelPctRef.current = Math.abs(nextLevel - targetPct) < 0.0005
        ? targetPct
        : nextLevel;
      peakPctRef.current = Math.abs(nextPeak - targetPct) < 0.0005
        ? targetPct
        : nextPeak;
      setMeterMotion({
        levelPct: levelPctRef.current,
        peakPct: peakPctRef.current,
      });

      const levelMoving = Math.abs(levelPctRef.current - targetPct) >= 0.0005;
      const peakMoving =
        now < peakHoldUntilRef.current
        || Math.abs(peakPctRef.current - targetPct) >= 0.0005;
      if (levelMoving || peakMoving) {
        animationFrame = requestAnimationFrame(animate);
      }
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [targetPct]);

  const isSilent = !hasLevel || clampedLevel <= -59.5;
  const isClipping = hasLevel && clampedLevel >= 0;
  const trimValue = param ? quantizeParamValue(param, param.value) : 0;
  const trimLabel = param ? formatParamValue({ ...param, value: trimValue }) : "0.0 dB";
  const trimSpan = param ? Math.max(param.max - param.min, 0.0001) : 48;
  const trimPct = param ? clamp((trimValue - param.min) / trimSpan, 0, 1) : 0.5;
  const style = {
    "--nam-meter-pct": `${meterMotion.levelPct * 100}%`,
    "--nam-meter-peak-pct": `${meterMotion.peakPct * 100}%`,
    "--nam-trim-pct": `${trimPct * 100}%`,
    "--nam-trim-angle": `${-135 + trimPct * 270}deg`,
  } as CSSProperties;
  const setValue = useCallback(
    (value: number) => {
      if (param) onChange(param, quantizeParamValue(param, value));
    },
    [onChange, param],
  );
  const pointerToValue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!param) return;
      const rect = faderRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
      const pct = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      setValue(param.min + pct * Math.max(param.max - param.min, 0.0001));
    },
    [param, setValue],
  );
  const dragToValue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || !param || drag.pointerId !== event.pointerId) return;
      pointerToValue(event);
    },
    [param, pointerToValue],
  );
  const stepByWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!param) return;
    event.preventDefault();
    const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 1 : 4;
    const direction = event.deltaY > 0 ? -1 : 1;
    setValue(param.value + stepForParam(param) * fine * direction);
  };
  const title = hasLevel
    ? `${label}: linked peak ${clampedLevel.toFixed(1)} dBFS, trim ${trimLabel}`
    : `${label}: no live meter data, trim ${trimLabel}`;
  return (
    <div
      className="nam-mini-meter nam-meter-trim"
      data-active={meterMotion.levelPct > 0.005}
      data-silent={isSilent}
      data-clip={isClipping}
      data-meter-mode="linked-peak"
      data-enabled={Boolean(param)}
      data-qa={`nam-${label.toLowerCase()}-meter-trim`}
      style={style}
      title={title}
      role={param ? "slider" : undefined}
      tabIndex={param ? 0 : undefined}
      aria-label={param ? `${label} trim` : label}
      aria-valuemin={param?.min}
      aria-valuemax={param?.max}
      aria-valuenow={param ? trimValue : undefined}
      onPointerDown={(event) => {
        if (!param || event.button !== 0) return;
        event.preventDefault();
        pointerToValue(event);
        dragRef.current = {
          pointerId: event.pointerId,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => dragToValue(event)}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) {
          dragToValue(event);
          dragRef.current = null;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onWheel={stepByWheel}
      onDoubleClick={(event) => {
        if (!param) return;
        event.preventDefault();
        setValue(param.defaultValue ?? 0);
      }}
      onKeyDown={(event) => {
        if (!param) return;
        if (event.key === "ArrowUp" || event.key === "ArrowRight") {
          event.preventDefault();
          setValue(param.value + stepForParam(param));
        } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
          event.preventDefault();
          setValue(param.value - stepForParam(param));
        } else if (event.key === "PageUp") {
          event.preventDefault();
          setValue(param.value + stepForParam(param) * 8);
        } else if (event.key === "PageDown") {
          event.preventDefault();
          setValue(param.value - stepForParam(param) * 8);
        } else if (event.key === "Home") {
          event.preventDefault();
          setValue(param.min);
        } else if (event.key === "End") {
          event.preventDefault();
          setValue(param.max);
        }
      }}
    >
      <span className="nam-meter-label">{label}</span>
      <i className="nam-meter-level" aria-hidden="true"><b /></i>
      <strong className="nam-meter-readout">{isClipping ? "clip" : hasLevel ? `${clampedLevel.toFixed(1)} dB` : "--"}</strong>
      <i className="nam-meter-fader" ref={faderRef} aria-hidden="true"><span className="nam-meter-trim-handle" /></i>
      <em className="nam-meter-trim-value">{trimLabel}</em>
      <small>{param ? "Linked peak · drag trim · double-click reset" : "Linked peak meter"}</small>
    </div>
  );
}

function neuralSectionIcon(sectionId: RackSectionId) {
  switch (sectionId) {
    case "pre": return <Zap size={22} />;
    case "amp": return <Activity size={22} />;
    case "cab": return <Mic2 size={22} />;
    case "eq": return <SlidersHorizontal size={22} />;
    case "post": return <Cable size={22} />;
    case "special": return <Sparkles size={22} />;
    case "browser": return <Library size={22} />;
    case "tuner": return <Gauge size={22} />;
    case "settings": return <SlidersHorizontal size={22} />;
  }
}

function neuralAnchorStyle(anchor: NAMRackDeviceSkin["controls"][number]): CSSProperties {
  return {
    "--nam-neural-x": `${anchor.x * 100}%`,
    "--nam-neural-y": `${anchor.y * 100}%`,
    "--nam-neural-w": `${anchor.width * 100}%`,
    "--nam-neural-h": `${anchor.height * 100}%`,
  } as CSSProperties;
}

function NeuralSkinDebugOverlay({ skin }: { skin: NAMRackDeviceSkin | undefined }) {
  if (!skin) return null;
  return (
    <div className="nam-neural-anchor-debug" aria-hidden="true">
      {skin.controls.map((anchor) => (
        <span key={anchor.id} data-kind={anchor.kind} data-anchor-id={anchor.id} style={neuralAnchorStyle(anchor)} />
      ))}
    </div>
  );
}

function NeuralParameterReadout({
  label,
  param,
}: {
  label: string;
  param?: BuiltInParamDescriptor;
}) {
  return (
    <div className="nam-neural-readout">
      <span>{label}</span>
      <strong>{param ? formatParamValue(param) : "--"}</strong>
    </div>
  );
}

type NeuralControlAnchor = NAMRackDeviceSkin["controls"][number];

function NeuralGraphicEqFader({
  anchor,
  param,
  onParamChange,
}: {
  anchor: NeuralControlAnchor;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const pct = param ? normalizeParam(param) : 0.5;
  const label = anchor.label ?? param?.label ?? anchor.id;
  const valueLabel = param ? formatParamValue(param) : anchor.valueLabel ?? "0.0 dB";
  const style = {
    ...neuralAnchorStyle(anchor),
    "--nam-fader-pct": `${pct * 100}%`,
  } as CSSProperties;
  const dragRef = useRef<number | null>(null);
  const setFromPointer = useCallback(
    (event: PointerEvent<HTMLLabelElement>) => {
      if (!param) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const nextPct = clamp(1 - (event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
      const nextValue = param.min + nextPct * (param.max - param.min);
      onParamChange(param, quantizeParamValue(param, nextValue));
    },
    [onParamChange, param],
  );

  return (
    <label
      className="nam-neural-control-anchor nam-neural-eq-fader"
      data-anchor-id={anchor.id}
      data-param={param?.id ?? ""}
      data-bound={Boolean(param)}
      style={style}
      title={param ? `${label}: ${valueLabel}` : `${label}: visual band pending DSP expansion`}
      aria-disabled={!param}
      onPointerDown={(event) => {
        if (!param || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (dragRef.current === event.pointerId) setFromPointer(event);
      }}
      onPointerUp={(event) => {
        if (dragRef.current === event.pointerId) {
          setFromPointer(event);
          dragRef.current = null;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        if (dragRef.current === event.pointerId) dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onWheel={(event: WheelEvent<HTMLLabelElement>) => {
        if (!param) return;
        event.preventDefault();
        event.stopPropagation();
        const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 1 : 4;
        const direction = event.deltaY > 0 ? -1 : 1;
        onParamChange(param, quantizeParamValue(param, param.value + stepForParam(param) * fine * direction));
      }}
      onDoubleClick={(event) => {
        if (!param) return;
        event.preventDefault();
        event.stopPropagation();
        onParamChange(param, param.defaultValue ?? 0);
      }}
    >
      <em>{valueLabel}</em>
      <span className="nam-neural-eq-fader-track" aria-hidden="true">
        <i />
        <b />
      </span>
      <strong>{label}</strong>
      {param && (
        <input
          className="nam-neural-eq-fader-input"
          type="range"
          min={param.min}
          max={param.max}
          step={stepForParam(param)}
          value={param.value}
          aria-label={label}
          onChange={(event) => onParamChange(param, Number(event.currentTarget.value))}
        />
      )}
    </label>
  );
}

function NeuralTreadleAnchor({
  anchor,
  param,
  onParamChange,
}: {
  anchor: NeuralControlAnchor;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const pct = param ? normalizeParam(param) : 0.5;
  const label = anchor.label ?? param?.label ?? anchor.id;
  const valueLabel = param ? formatParamValue(param) : anchor.valueLabel ?? "50%";
  const style = {
    ...neuralAnchorStyle(anchor),
    "--nam-treadle-pct": `${pct * 100}%`,
  } as CSSProperties;
  const dragRef = useRef<number | null>(null);
  const setFromPointer = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (!param) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const nextPct = clamp(1 - (event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
      const nextValue = param.min + nextPct * (param.max - param.min);
      onParamChange(param, quantizeParamValue(param, nextValue));
    },
    [onParamChange, param],
  );

  return (
    <button
      type="button"
      className="nam-neural-treadle-anchor"
      data-anchor-id={anchor.id}
      data-param={param?.id ?? ""}
      data-bound={Boolean(param)}
      style={style}
      title={param ? `${label}: ${valueLabel}` : `${label}: visual treadle pending DSP expansion`}
      disabled={!param}
      onPointerDown={(event) => {
        if (!param || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (dragRef.current === event.pointerId) setFromPointer(event);
      }}
      onPointerUp={(event) => {
        if (dragRef.current === event.pointerId) {
          setFromPointer(event);
          dragRef.current = null;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        if (dragRef.current === event.pointerId) dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onWheel={(event: WheelEvent<HTMLButtonElement>) => {
        if (!param) return;
        event.preventDefault();
        event.stopPropagation();
        const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 1 : 4;
        const direction = event.deltaY > 0 ? -1 : 1;
        onParamChange(param, quantizeParamValue(param, param.value + stepForParam(param) * fine * direction));
      }}
      onDoubleClick={(event) => {
        if (!param) return;
        event.preventDefault();
        event.stopPropagation();
        onParamChange(param, param.defaultValue ?? 0);
      }}
    >
      <span aria-hidden="true">
        <i />
      </span>
      <strong>{label}</strong>
    </button>
  );
}

function NeuralDecorativeKnobAnchor({ anchor }: { anchor: NeuralControlAnchor }) {
  return (
    <div
      className="nam-neural-control-anchor nam-neural-decorative-knob"
      data-anchor-id={anchor.id}
      data-param=""
      data-bound="false"
      style={neuralAnchorStyle(anchor)}
      title={`${anchor.label ?? anchor.id}: visual control pending Phase 6 DSP`}
      aria-hidden="true"
    >
      <span className="nam-neural-decorative-knob-cap">
        <i />
      </span>
      <strong>{anchor.label ?? anchor.id}</strong>
      <em>{anchor.valueLabel ?? "Phase 6"}</em>
    </div>
  );
}

function NeuralDecorativeSwitchAnchor({ anchor }: { anchor: NeuralControlAnchor }) {
  return (
    <div
      className="nam-neural-decorative-switch-anchor"
      data-anchor-id={anchor.id}
      data-param=""
      data-bound="false"
      style={neuralAnchorStyle(anchor)}
      title={`${anchor.label ?? anchor.id}: visual switch pending Phase 6 DSP`}
      aria-hidden="true"
    >
      <span>
        <i />
      </span>
      <strong>{anchor.label ?? anchor.id}</strong>
    </div>
  );
}

function NeuralMeterAnchor({ anchor }: { anchor: NeuralControlAnchor }) {
  return (
    <div
      className="nam-neural-meter-anchor"
      data-anchor-id={anchor.id}
      style={neuralAnchorStyle(anchor)}
      aria-hidden="true"
    >
      <span>{anchor.label ?? "Meter"}</span>
      <i><b /></i>
    </div>
  );
}

function NeuralLabelAnchor({ anchor }: { anchor: NeuralControlAnchor }) {
  return (
    <div
      className="nam-neural-label-anchor"
      data-anchor-id={anchor.id}
      style={neuralAnchorStyle(anchor)}
      aria-hidden="true"
    >
      <span>{anchor.label ?? anchor.id}</span>
    </div>
  );
}

const SEVEN_SEGMENT_ORDER = ["a", "b", "c", "d", "e", "f", "g"] as const;
const SEVEN_SEGMENT_DIGITS: Record<string, readonly (typeof SEVEN_SEGMENT_ORDER)[number][]> = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "d", "e", "g"],
  "3": ["a", "b", "c", "d", "g"],
  "4": ["b", "c", "f", "g"],
  "5": ["a", "c", "d", "f", "g"],
  "6": ["a", "c", "d", "e", "f", "g"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
};

function NeuralSevenSegmentValue({ value }: { value: string }) {
  const display = value.trim();
  if (!/^\d+$/.test(display)) {
    return <strong>{value}</strong>;
  }
  return (
    <strong className="nam-neural-seven-segment" aria-label={display}>
      {display.split("").map((digit, index) => {
        const activeSegments = new Set(SEVEN_SEGMENT_DIGITS[digit] ?? []);
        return (
          <span className="nam-neural-seven-segment-digit" data-digit={digit} key={`${digit}-${index}`}>
            {SEVEN_SEGMENT_ORDER.map((segment) => (
              <i key={segment} data-segment={segment} data-on={activeSegments.has(segment)} />
            ))}
          </span>
        );
      })}
    </strong>
  );
}

function NeuralRasterLed({ active }: { active: boolean }) {
  const asset = ledAssetForState(active);
  const style = {
    "--nam-control-led-image": `url("${asset.href}")`,
  } as CSSProperties;
  return (
    <div
      className="nam-neural-led nam-raster-led-cap"
      data-active={active}
      data-control-asset={asset.id}
      style={style}
      aria-hidden="true"
    />
  );
}

function NeuralRasterFootswitch({ active }: { active: boolean }) {
  const asset = footswitchAssetForState(active);
  const style = {
    "--nam-control-footswitch-image": `url("${asset.href}")`,
  } as CSSProperties;
  return <span className="nam-raster-footswitch-cap" data-control-asset={asset.id} style={style} aria-hidden="true" />;
}

function NeuralAmpHeadBackdrop() {
  return (
    <div className="nam-neural-amp-head-backdrop" aria-hidden="true">
      <span className="nam-neural-amp-handle" />
      <span className="nam-neural-amp-grille" />
      <span className="nam-neural-amp-glow" />
      <span className="nam-neural-amp-faceplate" />
      <span className="nam-neural-amp-cable" />
    </div>
  );
}

function NeuralCabMicRoomBackdrop() {
  return (
    <div className="nam-neural-cab-room-backdrop" aria-hidden="true">
      <span data-cone="left" />
      <span data-cone="right" />
      <i />
    </div>
  );
}

function NeuralCabMicAnchor({
  anchor,
  param,
  onParamChange,
}: {
  anchor: NeuralControlAnchor;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const valueLabel = param ? formatParamValue(param) : (anchor.valueLabel ?? "0.000");
  const active = param ? Math.abs(param.value - (param.defaultValue ?? 0)) > stepForParam(param) * 0.5 : false;
  const stepMicValue = () => {
    if (!param) return;
    const step = Math.max(stepForParam(param), (param.max - param.min) / 10);
    const next = param.value + step > param.max ? param.min : param.value + step;
    onParamChange(param, quantizeParamValue(param, next));
  };

  if (param) {
    return (
      <button
        type="button"
        className="nam-neural-mic-anchor nam-neural-cab-mic"
        data-anchor-id={anchor.id}
        data-param={param.id}
        data-bound="true"
        data-active={active}
        style={neuralAnchorStyle(anchor)}
        onClick={(event) => {
          event.stopPropagation();
          stepMicValue();
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onParamChange(param, param.defaultValue ?? 0);
        }}
        title={`${param.label}: ${valueLabel}`}
      >
        <span>
          <i />
          <b />
        </span>
        <strong>{anchor.label ?? param.label}</strong>
        <em>{valueLabel}</em>
      </button>
    );
  }

  return (
    <div
      className="nam-neural-mic-anchor nam-neural-cab-mic"
      data-anchor-id={anchor.id}
      data-bound="false"
      style={neuralAnchorStyle(anchor)}
      aria-hidden="true"
    >
      <span>
        <i />
        <b />
      </span>
      <strong>{anchor.label ?? "Mic"}</strong>
      <em>{valueLabel}</em>
    </div>
  );
}

function NeuralGraphicEqBackdrop() {
  return (
    <div className="nam-neural-eq-backdrop" aria-hidden="true">
      <span data-line="-12" />
      <span data-line="-6" />
      <span data-line="0" />
      <span data-line="+6" />
      <span data-line="+12" />
    </div>
  );
}

type NAMNeuralStageDevice = {
  skin: NAMRackDeviceSkin;
  moduleId?: RackModuleId;
  title: string;
  subtitle: string;
  display: string;
  active: boolean;
  accent: string;
  params: BuiltInParamDescriptor[];
  actionLabel?: string;
  onAction?: () => void;
  onPowerToggle?: () => void;
};

function NAMRackNeuralSectionSuite({
  sectionId,
  devices,
  activeModule,
  visualMode,
  renderKnob,
  onFocusDevice,
  onParamChange,
}: {
  sectionId: RackSectionId;
  devices: NAMNeuralStageDevice[];
  activeModule: RackModuleId;
  visualMode: NAMRackVisualMode;
  renderKnob: (param: BuiltInParamDescriptor) => ReactNode;
  onFocusDevice: (sectionId: RackSectionId, moduleId?: RackModuleId) => void;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  return (
    <div className="nam-neural-section-suite nam-stage-large" data-section={sectionId} data-debug-anchors={visualMode === "debug-anchors"}>
      {devices.map((device) => {
        const scene = sceneForSkin(device.skin.id);
        if (scene) {
          return (
            <NAMRackSceneDevice
              key={device.skin.id}
              sectionId={sectionId}
              device={device}
              scene={scene}
              activeModule={activeModule}
              visualMode={visualMode}
              onFocusDevice={onFocusDevice}
              onParamChange={onParamChange}
            />
          );
        }
        const paramsById = new Map(device.params.map((param) => [param.id, param]));
        const displayAnchor = device.skin.controls.find((anchor) => anchor.kind === "display");
        const footswitchAnchors = device.skin.controls.filter((anchor) => anchor.kind === "footswitch");
        const footswitchAnchor = footswitchAnchors[0];
        const switchAnchors = device.skin.controls.filter((anchor) => (
          anchor.kind === "switch"
          || anchor.kind === "button"
          || (anchor.kind === "footswitch" && anchor.id !== footswitchAnchor?.id)
        ) && anchor.paramId);
        const decorativeSwitchAnchors = device.skin.controls.filter((anchor) => anchor.kind === "switch" && !anchor.paramId);
        const freeButtonAnchors = device.skin.controls.filter((anchor) => anchor.kind === "button" && !anchor.paramId);
        const decorativeKnobAnchors = device.skin.controls.filter((anchor) => anchor.kind === "knob" && !anchor.paramId);
        const faderAnchors = device.skin.controls.filter((anchor) => anchor.kind === "fader");
        const treadleAnchors = device.skin.controls.filter((anchor) => anchor.kind === "treadle");
        const labelAnchors = device.skin.controls.filter((anchor) => anchor.kind === "label");
        const micAnchors = device.skin.controls.filter((anchor) => anchor.kind === "mic");
        const meterAnchors = device.skin.controls.filter((anchor) => anchor.kind === "meter");
        return (
          <article
            key={device.skin.id}
            className="nam-neural-device nam-neural-section-device"
            data-section={device.skin.section}
            data-skin={device.skin.id}
            data-module={device.moduleId ?? device.skin.id}
            data-material={device.skin.material}
            data-active={device.active}
            data-focused={device.moduleId ? activeModule === device.moduleId : false}
            style={{ "--nam-neural-accent": device.accent } as CSSProperties}
            onClick={() => onFocusDevice(sectionId, device.moduleId)}
          >
            <img className="nam-neural-device-skin" src={device.skin.assetUrl} alt="" loading="eager" aria-hidden="true" />
            <div className="nam-neural-device-plate">
              {device.skin.section === "amp" && <NeuralAmpHeadBackdrop />}
              {device.skin.section === "cab" && <NeuralCabMicRoomBackdrop />}
              {device.skin.section === "eq" && <NeuralGraphicEqBackdrop />}
              <div className="nam-neural-device-head">
                <span>{device.subtitle}</span>
                <strong>{device.title}</strong>
              </div>
              <NeuralRasterLed active={device.active} />
              <div
                className="nam-neural-mini-display nam-neural-device-display"
                data-anchored={Boolean(displayAnchor)}
                style={displayAnchor ? neuralAnchorStyle(displayAnchor) : undefined}
              >
                <span>{device.display}</span>
                <i aria-hidden="true" />
              </div>
              {device.skin.controls.filter((anchor) => anchor.kind === "knob" && anchor.paramId).map((anchor) => {
                const param = paramsById.get(anchor.paramId ?? "");
                if (!param) return null;
                return (
                  <div
                    key={anchor.id}
                    className="nam-neural-control-anchor"
                    data-anchor-id={anchor.id}
                    data-param={param.id}
                    data-bound={Boolean(param)}
                    style={neuralAnchorStyle(anchor)}
                  >
                    {renderKnob(param)}
                  </div>
                );
              })}
              {decorativeKnobAnchors.map((anchor) => (
                <NeuralDecorativeKnobAnchor key={anchor.id} anchor={anchor} />
              ))}
              {decorativeSwitchAnchors.map((anchor) => (
                <NeuralDecorativeSwitchAnchor key={anchor.id} anchor={anchor} />
              ))}
              {faderAnchors.map((anchor) => (
                <NeuralGraphicEqFader
                  key={anchor.id}
                  anchor={anchor}
                  param={anchor.paramId ? paramsById.get(anchor.paramId) : undefined}
                  onParamChange={onParamChange}
                />
              ))}
              {treadleAnchors.map((anchor) => (
                <NeuralTreadleAnchor
                  key={anchor.id}
                  anchor={anchor}
                  param={anchor.paramId ? paramsById.get(anchor.paramId) : undefined}
                  onParamChange={onParamChange}
                />
              ))}
              {labelAnchors.map((anchor) => (
                <NeuralLabelAnchor key={anchor.id} anchor={anchor} />
              ))}
              {micAnchors.map((anchor) => (
                <NeuralCabMicAnchor
                  key={anchor.id}
                  anchor={anchor}
                  param={anchor.paramId ? paramsById.get(anchor.paramId) : undefined}
                  onParamChange={onParamChange}
                />
              ))}
              {meterAnchors.map((anchor) => (
                <NeuralMeterAnchor key={anchor.id} anchor={anchor} />
              ))}
              {switchAnchors.map((anchor) => {
                const param = paramsById.get(anchor.paramId ?? "");
                if (!param) return null;
                const isEnum = param.type === "enum";
                const active = isEnum
                  ? (typeof anchor.resetValue === "number" ? Math.round(param.value) === Math.round(anchor.resetValue) : param.value > param.min)
                  : param.value >= (param.max + param.min) / 2;
                const enumOptionLabel = isEnum && typeof anchor.resetValue !== "number"
                  ? param.enumOptions?.find((option) => Math.round(option.value) === Math.round(param.value))?.label
                  : undefined;
                return (
                  <button
                    key={anchor.id}
                    type="button"
                    className="nam-neural-anchor-button"
                    data-kind={anchor.kind}
                    data-active={active}
                    data-anchor-id={anchor.id}
                    data-param={param.id}
                    data-bound={Boolean(param)}
                    style={neuralAnchorStyle(anchor)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isEnum) {
                        const next = typeof anchor.resetValue === "number"
                          ? anchor.resetValue
                          : (Math.round(param.value) >= param.max ? param.min : Math.round(param.value) + 1);
                        onParamChange(param, next);
                      } else {
                        onParamChange(param, active ? param.min : param.max);
                      }
                    }}
                    title={isEnum ? `Change ${param.label}` : `${active ? "Disable" : "Enable"} ${param.label}`}
                  >
                    <span aria-hidden="true" />
                    <strong>{enumOptionLabel ?? anchor.label ?? (anchor.kind === "switch" ? "Switch" : param.label)}</strong>
                  </button>
                );
              })}
              {freeButtonAnchors.map((anchor) => (
                <button
                  key={anchor.id}
                  type="button"
                  className="nam-neural-anchor-button"
                  data-kind="button"
                  data-active={Boolean(device.onAction)}
                  data-anchor-id={anchor.id}
                  style={neuralAnchorStyle(anchor)}
                  onClick={(event) => {
                    event.stopPropagation();
                    device.onAction?.();
                  }}
                  disabled={!device.onAction}
                  title={device.actionLabel ?? device.title}
                >
                  <span aria-hidden="true" />
                  <strong>{anchor.label ?? device.actionLabel ?? "Action"}</strong>
                </button>
              ))}
              {footswitchAnchor && (
                <button
                  type="button"
                  className="nam-neural-footswitch nam-neural-footswitch-anchor"
                  data-active={device.active}
                  data-anchor-id={footswitchAnchor.id}
                  data-param={footswitchAnchor.paramId ?? ""}
                  data-bound={Boolean(footswitchAnchor.paramId && paramsById.has(footswitchAnchor.paramId))}
                  style={neuralAnchorStyle(footswitchAnchor)}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (device.onPowerToggle) device.onPowerToggle();
                    else onFocusDevice(sectionId, device.moduleId);
                  }}
                  title={device.onPowerToggle ? `${device.active ? "Bypass" : "Enable"} ${device.title}` : `Focus ${device.title}`}
                >
                  <NeuralRasterFootswitch active={device.active} />
                  <strong>{footswitchAnchor.label ?? (device.active ? "On" : "Off")}</strong>
                </button>
              )}
              <NeuralSkinDebugOverlay skin={device.skin} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function NAMRackPostFxSuite({
  devices,
  activeModule,
  visualMode,
  renderKnob,
  onFocusModule,
  onParamChange,
}: {
  devices: Array<{
    moduleId: Extract<RackModuleId, "mod" | "delay" | "reverb">;
    title: string;
    subtitle: string;
    display: string;
    active: boolean;
    accent: string;
    params: BuiltInParamDescriptor[];
  }>;
  activeModule: RackModuleId;
  visualMode: NAMRackVisualMode;
  renderKnob: (param: BuiltInParamDescriptor) => ReactNode;
  onFocusModule: (moduleId: RackModuleId) => void;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  return (
    <div className="nam-neural-post-suite nam-stage-large" data-debug-anchors={visualMode === "debug-anchors"}>
      {devices.map((device) => {
        const skin = deviceSkinForModule(device.moduleId);
        const scene = skin ? sceneForSkin(skin.id) : undefined;
        if (skin && scene) {
          return (
            <NAMRackSceneDevice
              key={device.moduleId}
              sectionId="post"
              device={{ ...device, skin }}
              scene={scene}
              activeModule={activeModule}
              visualMode={visualMode}
              onFocusDevice={(_, moduleId) => onFocusModule(moduleId ?? device.moduleId)}
              onParamChange={onParamChange}
            />
          );
        }
        const paramsById = new Map(device.params.map((param) => [param.id, param]));
        const displayAnchor = skin?.controls.find((anchor) => anchor.kind === "display");
        const footswitchAnchors = skin?.controls.filter((anchor) => anchor.kind === "footswitch") ?? [];
        const footswitchAnchor = footswitchAnchors[0];
        const switchAnchors = skin?.controls.filter((anchor) => (
          anchor.kind === "switch"
          || anchor.kind === "button"
          || (anchor.kind === "footswitch" && anchor.id !== footswitchAnchor?.id)
        ) && anchor.paramId) ?? [];
        const treadleAnchors = skin?.controls.filter((anchor) => anchor.kind === "treadle") ?? [];
        const footswitchParam = footswitchAnchor?.paramId ? paramsById.get(footswitchAnchor.paramId) : undefined;
        return (
          <article
            key={device.moduleId}
            className="nam-neural-device"
            data-section={skin?.section ?? "post"}
            data-skin={skin?.id}
            data-module={device.moduleId}
            data-material={skin?.material}
            data-active={device.active}
            data-focused={activeModule === device.moduleId}
            style={{ "--nam-neural-accent": device.accent } as CSSProperties}
            onClick={() => onFocusModule(device.moduleId)}
          >
            {skin && (
              <img className="nam-neural-device-skin" src={skin.assetUrl} alt="" loading="eager" aria-hidden="true" />
            )}
            <div className="nam-neural-device-plate">
              <div className="nam-neural-device-head">
                <span>{device.subtitle}</span>
                <strong>{device.title}</strong>
              </div>
              <NeuralRasterLed active={device.active} />
              {device.moduleId === "delay" && (
                <div
                  className="nam-neural-delay-display"
                  data-anchored={Boolean(displayAnchor)}
                  style={displayAnchor ? neuralAnchorStyle(displayAnchor) : undefined}
                >
                  <NeuralSevenSegmentValue value={device.display} />
                  <span>FREE MS</span>
                  <span>BPM</span>
                  <span>PING PONG</span>
                  <span>DUCKING</span>
                </div>
              )}
              {device.moduleId !== "delay" && (
                <div
                  className="nam-neural-mini-display"
                  data-anchored={Boolean(displayAnchor)}
                  style={displayAnchor ? neuralAnchorStyle(displayAnchor) : undefined}
                >
                  <span>{device.display}</span>
                  <i aria-hidden="true" />
                </div>
              )}
              {skin?.controls.filter((anchor) => anchor.kind === "knob" && anchor.paramId).map((anchor) => {
                const param = paramsById.get(anchor.paramId ?? "");
                if (!param) return null;
                return (
                  <div
                    key={anchor.id}
                    className="nam-neural-control-anchor"
                    data-anchor-id={anchor.id}
                    data-param={param.id}
                    data-bound={Boolean(param)}
                    style={neuralAnchorStyle(anchor)}
                  >
                    {renderKnob(param)}
                  </div>
                );
              })}
              {treadleAnchors.map((anchor) => (
                <NeuralTreadleAnchor
                  key={anchor.id}
                  anchor={anchor}
                  param={anchor.paramId ? paramsById.get(anchor.paramId) : undefined}
                  onParamChange={onParamChange}
                />
              ))}
              {switchAnchors.map((anchor) => {
                const param = paramsById.get(anchor.paramId ?? "");
                if (!param) return null;
                const isEnum = param.type === "enum";
                const active = isEnum
                  ? (typeof anchor.resetValue === "number" ? Math.round(param.value) === Math.round(anchor.resetValue) : param.value > param.min)
                  : param.value >= (param.max + param.min) / 2;
                const enumOptionLabel = isEnum && typeof anchor.resetValue !== "number"
                  ? param.enumOptions?.find((option) => Math.round(option.value) === Math.round(param.value))?.label
                  : undefined;
                return (
                  <button
                    key={anchor.id}
                    type="button"
                    className={anchor.kind === "footswitch" ? "nam-neural-footswitch nam-neural-footswitch-anchor" : "nam-neural-anchor-button"}
                    data-kind={anchor.kind}
                    data-active={active}
                    data-anchor-id={anchor.id}
                    data-param={param.id}
                    data-bound={Boolean(param)}
                    style={neuralAnchorStyle(anchor)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isEnum) {
                        const next = typeof anchor.resetValue === "number"
                          ? anchor.resetValue
                          : (Math.round(param.value) >= param.max ? param.min : Math.round(param.value) + 1);
                        onParamChange(param, next);
                      } else {
                        onParamChange(param, active ? param.min : param.max);
                      }
                    }}
                    title={isEnum ? `Change ${param.label}` : `${active ? "Disable" : "Enable"} ${param.label}`}
                  >
                    {anchor.kind === "footswitch" ? <NeuralRasterFootswitch active={active} /> : <span aria-hidden="true" />}
                    <strong>{enumOptionLabel ?? anchor.label ?? param.label}</strong>
                  </button>
                );
              })}
              <button
                type="button"
                className={`nam-neural-footswitch${footswitchAnchor ? " nam-neural-footswitch-anchor" : ""}`}
                data-active={device.active}
                data-anchor-id={footswitchAnchor?.id}
                data-param={footswitchAnchor?.paramId ?? ""}
                data-bound={Boolean(footswitchParam)}
                style={footswitchAnchor ? neuralAnchorStyle(footswitchAnchor) : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  if (footswitchParam) {
                    const active = footswitchParam.value >= (footswitchParam.max + footswitchParam.min) / 2;
                    onParamChange(footswitchParam, active ? footswitchParam.min : footswitchParam.max);
                  } else {
                    onFocusModule(device.moduleId);
                  }
                }}
                title={footswitchParam ? `${device.active ? "Bypass" : "Enable"} ${device.title}` : `Focus ${device.title}`}
              >
                <NeuralRasterFootswitch active={device.active} />
                <strong>{footswitchAnchor?.label ?? (device.active ? "On" : "Off")}</strong>
              </button>
              <NeuralSkinDebugOverlay skin={skin} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function NAMRackPanel({
  address,
  schema,
  onParamChange,
  onRefreshRack,
}: NAMRackPanelProps) {
  const [activeView, setActiveView] = useState<NAMProductView>(() => initialNAMProductView());
  const [libraryFlow, setLibraryFlow] = useState<NAMLibraryFlowState>(() => initialNAMLibraryFlow());
  const [chainOpen, setChainOpen] = useState(() => initialCompactChainOpen());
  const [advancedFocus, setAdvancedFocus] = useState<NAMRackAdvancedStageId | null>(null);
  const [rackRailTab, setRackRailTab] = useState<RackRightRailTab>("tones");
  const [explorerIntent, setExplorerIntent] = useState<NAMExplorerIntent | null>(() => initialNAMExplorerIntent());
  // Loading the first amp capture starts an unsaved rig; it does not apply the
  // first factory template.
  const [presetId, setPresetId] = useState("");
  const [compareSlot, setCompareSlot] = useState<CompareSlot>("A");
  const [compareSnapshots, setCompareSnapshots] = useState<Partial<Record<CompareSlot, RackCompareSnapshot>>>({});
  const [focusedModule, setFocusedModule] = useState<RackModuleId>(() => {
    const flow = initialNAMLibraryFlow();
    return flow ? initialNAMLibraryFXModule() ?? rackModuleForNAMLibraryFlow(flow) : initialRackFocus();
  });
  const [activeRackSection, setActiveRackSection] = useState<RackSectionId>(() => {
    const flow = initialNAMLibraryFlow();
    const fxModule = initialNAMLibraryFXModule();
    return flow ? fxModule === "eq" ? "eq" : rackSectionForNAMLibraryFlow(flow) : initialRackSection();
  });
  const [visualMode] = useState<NAMRackVisualMode>(() => initialNAMRackVisualMode());
  const [presetBusy, setPresetBusy] = useState(false);
  const [cabBusy, setCabBusy] = useState(false);
  const [recoveryBusySlot, setRecoveryBusySlot] = useState<NAMRackMissingAsset["slot"] | null>(null);
  const recoveryBusyRef = useRef(false);
  const [recoveryActionStatus, setRecoveryActionStatus] = useState<{
    slot: NAMRackMissingAsset["slot"];
    message: string;
  } | null>(null);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [presetManagerOpen, setPresetManagerOpen] = useState(() => initialPresetManagerOpen());
  const [presetManagerBusy, setPresetManagerBusy] = useState(false);
  const [userPresets, setUserPresets] = useState<UserRackPreset[]>([]);
  const [presetMetadata, setPresetMetadata] = useState<Record<string, UserRackPresetMetadata>>(() => loadPresetMetadata());
  const [presetSearch, setPresetSearch] = useState("");
  const [presetFolderFilter, setPresetFolderFilter] = useState("all");
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetFolderDraft, setPresetFolderDraft] = useState("Studio");
  const [presetTagsDraft, setPresetTagsDraft] = useState("");
  const [presetNotesDraft, setPresetNotesDraft] = useState("");
  const [presetStatus, setPresetStatus] = useState("");
  const [presetPrompt, setPresetPrompt] = useState<NAMRackPrompt | null>(null);
  const presetPromptResolverRef = useRef<((result: string | null) => void) | null>(null);
  const uiStatePersistenceRef = useRef<Promise<void>>(Promise.resolve());
  const [saveToneOpen, setSaveToneOpen] = useState(false);
  const [saveToneBusy, setSaveToneBusy] = useState(false);
  const [saveToneDraft, setSaveToneDraft] = useState<NAMToneSaveDraft>(() => buildNAMToneSaveDraft({ title: "NAM Rack Preset" }));
  const closeCalibrationDialog = useCallback(() => setCalibrationOpen(false), []);
  const closePresetManagerDialog = useCallback(() => setPresetManagerOpen(false), []);
  const { dialogRef: calibrationDialogRef, onKeyDown: onCalibrationDialogKeyDown } = useNAMOverlayDialog<HTMLElement>(calibrationOpen, closeCalibrationDialog);
  const { dialogRef: presetManagerDialogRef, onKeyDown: onPresetManagerDialogKeyDown } = useNAMOverlayDialog<HTMLElement>(presetManagerOpen, closePresetManagerDialog);
  const [powerMemory, setPowerMemory] = useState<Record<string, Record<string, number>>>({});
  const [slotOrder, setSlotOrder] = useState<RackModuleId[]>(() => DEFAULT_RACK_SLOT_ORDER);
  const [slotOrderBusy, setSlotOrderBusy] = useState(false);
  const [slotOrderError, setSlotOrderError] = useState("");
  const slotOrderPersistencePendingRef = useRef(false);
  const [favoriteSlots, setFavoriteSlots] = useState<RackModuleId[]>([]);
  const [moduleCopies, setModuleCopies] = useState<Partial<Record<RackModuleId, RackModuleCopy>>>({});
  const [slotBrowserOpen, setSlotBrowserOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("namSlotBrowser") === "1";
  });
  const [slotBrowserCategory, setSlotBrowserCategory] = useState<RackSlotBrowserCategory>(() => {
    if (typeof window === "undefined") return "amp";
    const value = new URLSearchParams(window.location.search).get("namSlotCategory");
    return (isRackModuleId(value) && value !== "pedal") || value === "utility" ? value : "amp";
  });
  const [slotActionStatus, setSlotActionStatus] = useState("");
  const [draggedSlot, setDraggedSlot] = useState<RackModuleId | null>(null);
  const [dropTargetSlot, setDropTargetSlot] = useState<RackModuleId | null>(null);
  const [dragPreviewOrder, setDragPreviewOrder] = useState<RackModuleId[] | null>(null);
  const dragOriginOrderRef = useRef<RackModuleId[] | null>(null);
  const dropCommittedRef = useRef(false);
  const [irLibrary, setIRLibrary] = useState<IRLibraryEntry[]>(() => loadIRLibrary());
  const [stageLocked, setStageLocked] = useState(false);
  const [rackStageSizePercent, setRackStageSizePercent] = useState<NAMRackStageSizePercent>(() => initialRackStageSizePercent());
  const stageViewRef = useRef<HTMLElement | null>(null);
  const tone3000Session = useTONE3000Session();
  const {
    hostTrack,
    audioDeviceSetup,
    openSettings,
    openTrackRouting,
    tempo,
    timeSignature,
  } = useDAWStore(
    useShallow((state) => ({
      hostTrack: state.tracks.find((track) => track.id === address.trackId) ?? null,
      audioDeviceSetup: state.audioDeviceSetup,
      openSettings: state.openSettings,
      openTrackRouting: state.openTrackRouting,
      tempo: state.transport.tempo,
      timeSignature: state.timeSignature,
    })),
  );
  const [audioDebugSnapshot, setAudioDebugSnapshot] = useState<AudioDebugSnapshot | null>(null);
  const [rackLiveDiagnostics, setRackLiveDiagnostics] = useState<Record<string, unknown> | null>(null);
  const meterFreshnessRef = useRef<{
    processedBlockCount: number | null;
    lastAdvanceAtMs: number;
  }>({
    processedBlockCount: null,
    lastAdvanceAtMs: Date.now(),
  });
  const rackWindowCapabilities = useMemo(
    () => resolveNAMRackWindowCapabilities(windowRole, address),
    [address.chain, address.trackId],
  );
  const [detachedRuntime, setDetachedRuntime] = useState<{
    tempo?: number;
    timeSignature?: { numerator: number; denominator: number };
    device?: NAMRackRuntimeDevice | null;
    track?: NAMRackRuntimeTrack | null;
  }>({});

  useEffect(() => {
    if (!rackWindowCapabilities.detached) return;

    let cancelled = false;
    let refreshInFlight = false;
    let deviceCapabilitiesLoaded = false;
    const refreshDetachedRuntime = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const routingPromise = address.trackId
          ? nativeBridge.getTrackRoutingInfo(address.trackId)
          : Promise.resolve(null);
        // Device enumeration is expensive for ASIO drivers and writes a large
        // diagnostic payload. It is static for the lifetime of this detached
        // editor; live sample-rate/block-size telemetry comes from the much
        // lighter getAudioDebugSnapshot poll below.
        const devicePromise = deviceCapabilitiesLoaded
          ? Promise.resolve(null)
          : nativeBridge.getAudioDeviceSetup();
        const [tempoResult, signatureResult, deviceResult, routingResult] =
          await Promise.allSettled([
            nativeBridge.getTempo(),
            nativeBridge.getTimeSignature(),
            devicePromise,
            routingPromise,
          ] as const);

        if (cancelled) return;
        if (deviceResult.status === "fulfilled" && deviceResult.value !== null) {
          deviceCapabilitiesLoaded = true;
        }
        setDetachedRuntime((current) => {
          const nextTempo = tempoResult.status === "fulfilled"
            && Number.isFinite(tempoResult.value)
            && tempoResult.value > 0
            ? tempoResult.value
            : current.tempo;
          const nextSignature = signatureResult.status === "fulfilled"
            && Number.isFinite(signatureResult.value.numerator)
            && signatureResult.value.numerator > 0
            && Number.isFinite(signatureResult.value.denominator)
            && signatureResult.value.denominator > 0
            ? {
              numerator: Math.trunc(signatureResult.value.numerator),
              denominator: Math.trunc(signatureResult.value.denominator),
            }
            : current.timeSignature;
          return {
            tempo: nextTempo,
            timeSignature: nextSignature,
            device: deviceResult.status === "fulfilled" && deviceResult.value !== null
              ? normalizeNAMRuntimeDevice(deviceResult.value)
              : current.device,
            track: routingResult.status === "fulfilled"
              ? normalizeNAMRuntimeTrack(routingResult.value)
              : current.track,
          };
        });
      } catch (error) {
        if (!cancelled) {
          console.warn("[NAMRackPanel] Could not synchronize detached rack context", error);
        }
      } finally {
        refreshInFlight = false;
      }
    };

    void refreshDetachedRuntime();
    const timer = window.setInterval(() => {
      void refreshDetachedRuntime();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [address.chain, address.trackId, rackWindowCapabilities.detached]);

  const runtimeTempo = rackWindowCapabilities.detached
    ? detachedRuntime.tempo ?? Number.NaN
    : tempo;
  const runtimeTimeSignature = rackWindowCapabilities.detached
    ? detachedRuntime.timeSignature
    : timeSignature;
  const runtimeAudioDeviceSetup = rackWindowCapabilities.detached
    ? detachedRuntime.device
    : audioDeviceSetup;
  const runtimeHostTrack: NAMRackRuntimeTrack | null | undefined =
    rackWindowCapabilities.detached
      ? detachedRuntime.track
      : hostTrack
        ? {
          type: hostTrack.type,
          inputStartChannel: hostTrack.inputStartChannel,
          inputChannelCount: hostTrack.inputChannelCount,
          armed: hostTrack.armed,
          monitorEnabled: hostTrack.monitorEnabled,
          inputMonitoring: hostTrack.monitorEnabled,
          recordArmed: hostTrack.armed,
        }
        : null;
  const params = schema.parameters;
  const modelState = schema.modelState;
  const persistedCompareStateKey = useMemo(() => JSON.stringify(schema.uiState?.namRackCompare ?? null), [schema.uiState]);
  const persistedCompareState = useMemo(
    () => normalizeCompareUiState(schema.uiState),
    [persistedCompareStateKey],
  );
  const persistedSlotStateKey = useMemo(() => JSON.stringify(schema.uiState?.namRackSlots ?? null), [schema.uiState]);
  const persistedRackSlots = useMemo(
    () => normalizeRackSlotsUiState(schema.uiState),
    [persistedSlotStateKey],
  );
  const preset = NAM_RACK_PRESETS.find((entry) => entry.id === presetId) ?? NAM_RACK_PRESETS[0];
  const pedalPathName = fileName(modelState?.pedalModelPath);
  const ampPathName = fileName(modelState?.ampModelPath);
  const cabPathName = fileName(modelState?.cabIRPath);
  const inputTrim = paramById(params, "inputTrimDb");
  const inputModeParam = paramById(params, "inputMode");
  const calibrationReferenceParam = paramById(params, "calibrationReferenceDbu");
  const pedalCalibrationModeParam = paramById(params, "pedalCalibrationMode");
  const pedalOverrideInputParam = paramById(params, "pedalOverrideInputLevelDbu");
  const pedalOverrideOutputParam = paramById(params, "pedalOverrideOutputLevelDbu");
  const ampCalibrationModeParam = paramById(params, "ampCalibrationMode");
  const ampOverrideInputParam = paramById(params, "ampOverrideInputLevelDbu");
  const ampOverrideOutputParam = paramById(params, "ampOverrideOutputLevelDbu");
  const gateThreshold = paramById(params, "gateThresholdDb");
  const outputTrim = paramById(params, "outputTrimDb");
  const compressorEnabledParam = paramById(params, "compressorEnabled");
  const compressorMixParam = paramById(params, "compressorMix");
  const compressorCompParam = paramById(params, "compressorComp");
  const tapeEchoEnabledParam = paramById(params, "tapeEchoEnabled");
  const tapeEchoMixParam = paramById(params, "tapeEchoMix");
  const tapeEchoTimeParam = paramById(params, "tapeEchoTimeMs");
  const octaverEnabledParam = paramById(params, "octaverEnabled");
  const octaverDownParam = paramById(params, "octaverDownMix");
  const octaverUpParam = paramById(params, "octaverUpMix");
  const precisionDriveEnabledParam = paramById(params, "precisionDriveEnabled");
  const precisionDriveDriveParam = paramById(params, "precisionDriveDrive");
  const chaosEnabledParam = paramById(params, "chaosEnabled");
  const chaosMixParam = paramById(params, "chaosMix");
  const laserEnabledParam = paramById(params, "laserEnabled");
  const rawLaserModeParam = paramById(params, "laserMode");
  const laserModeParam = rawLaserModeParam ? projectNAMRackParamForUI(rawLaserModeParam) : undefined;
  const laserMixParam = paramById(params, "laserMix");
  const laserSpeedParam = paramById(params, "laserSpeedHz");
  const laserEnvelopeModeParam = paramById(params, "laserEnvelopeMode");
  const laserTriggerParam = paramById(params, "laserTrigger");
  const laserSpeedOverridden =
    (laserEnvelopeModeParam?.value ?? 0) >= 0.5
    || (laserTriggerParam?.value ?? 0) >= 0.5;
  const laserSpeedOverrideReason = (laserTriggerParam?.value ?? 0) >= 0.5
    ? "Latch controls motion. Turn Latch off to use LFO Speed."
    : "Envelope controls motion. Turn Envelope off to use LFO Speed.";
  const pedalMix = paramById(params, "pedalMix");
  const ampEnabledParam = paramById(params, "ampEnabled");
  const ampGainParam = paramById(params, "ampGainDb");
  const ampOutputParam = paramById(params, "ampOutputDb");
  const ampMix = paramById(params, "ampMix");
  const cabEnabledParam = paramById(params, "cabEnabled");
  const cabPhaseInvertParam = paramById(params, "cabPhaseInvert");
  const eqEnabledParam = paramById(params, "eqEnabled");
  const modulatorEnabledParam = paramById(params, "modulatorEnabled");
  const modulatorPedalModeParam = paramById(params, "modulatorPedalMode");
  const modulatorPedalPositionParam = paramById(params, "modulatorPedalPosition");
  const chorusMixParam = paramById(params, "chorusMix");
  const chorusRateParam = paramById(params, "chorusRateHz");
  const modulatorModeParam = paramById(params, "modulatorMode");
  const delayMixParam = paramById(params, "delayMix");
  const delayTimeParam = paramById(params, "delayTimeMs");
  const delayFeedbackParam = paramById(params, "delayFeedback");
  const delayModParam = paramById(params, "delayMod");
  const delayPingPongParam = paramById(params, "delayPingPong");
  const delayEnabledParam = paramById(params, "delayEnabled");
  const delayTempoSyncParam = paramById(params, "delayTempoSync");
  const reverbEnabledParam = paramById(params, "reverbEnabled");
  const reverbMixParam = paramById(params, "reverbMix");
  const reverbDecayParam = paramById(params, "reverbDecaySec");
  const reverbPreDelayParam = paramById(params, "reverbPreDelayMs");
  useEffect(() => {
    if (
      !rawLaserModeParam
      || NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS.some(
        (option) => option.value === Math.round(rawLaserModeParam.value),
      )
    ) {
      return;
    }
    onParamChange(rawLaserModeParam, NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[0].value);
  }, [onParamChange, rawLaserModeParam]);
  const gateActive = gateThreshold ? gateThreshold.value > gateThreshold.min + 0.5 : true;
  const compressorPowerActive = (compressorEnabledParam?.value ?? 0) >= 0.5;
  const compressorActive = compressorPowerActive && (compressorMixParam?.value ?? 0) > 0.0001;
  const tapeEchoActive = (tapeEchoEnabledParam?.value ?? 0) >= 0.5 && (tapeEchoMixParam?.value ?? 0) > 0.0001;
  const octaverActive = (octaverEnabledParam?.value ?? 0) >= 0.5 && (((octaverDownParam?.value ?? 0) > 0.0001) || ((octaverUpParam?.value ?? 0) > 0.0001));
  const precisionDriveActive = (precisionDriveEnabledParam?.value ?? 0) >= 0.5;
  const chaosActive = (chaosEnabledParam?.value ?? 0) >= 0.5 && (chaosMixParam?.value ?? 0) > 0.0001;
  const laserActive = (laserEnabledParam?.value ?? 0) >= 0.5 && (laserMixParam?.value ?? 0) > 0.0001;
  const pedalActive = Boolean(modelState?.hasPedalModel) && (pedalMix?.value ?? 0) > 0.0001;
  const ampPowerActive = (ampEnabledParam?.value ?? 1) >= 0.5;
  const ampActive = ampPowerActive && Boolean(modelState?.hasAmpModel) && (ampMix?.value ?? 0) > 0.0001;
  const cabActive = (cabEnabledParam?.value ?? 0) >= 0.5;
  const hasPedalModel = Boolean(modelState?.hasPedalModel);
  const hasAmpModel = Boolean(modelState?.hasAmpModel);
  const hasCabIR = Boolean(modelState?.hasCabIR);
  const previouslyHadAmpModelRef = useRef(hasAmpModel);
  useEffect(() => {
    if (!previouslyHadAmpModelRef.current && hasAmpModel) {
      setPresetId("");
    }
    previouslyHadAmpModelRef.current = hasAmpModel;
  }, [hasAmpModel]);
  const missingRackAssets = useMemo(() => resolveNAMRackMissingAssets(schema), [schema]);
  const sectionRecoverySlot = activeRackSection === "pre" ? "pedal" : activeRackSection === "amp" ? "amp" : activeRackSection === "cab" ? "cab" : null;
  const activeMissingRackAsset = missingRackAssets.find((asset) => asset.slot === sectionRecoverySlot);
  const missingAmpAsset = missingRackAssets.find((asset) => asset.slot === "amp");
  const currentCabIRPath = modelState?.cabIRPath?.trim() ?? "";
  const activeNAMPreview = useMemo(
    () => normalizeNAMActivePreview(schema.uiState?.namActivePreview),
    [schema.uiState],
  );
  const hasTemporaryNAMPreview = Boolean(activeNAMPreview && !activeNAMPreview.saved);
  const blockResourceChangeWhilePreviewing = (actionLabel: string) => {
    if (!hasTemporaryNAMPreview) return false;
    setPresetStatus(
      `${actionLabel} is unavailable while a temporary ${activeNAMPreview?.slot === "cab" ? "IR" : "Capture"} audition is active. Use it or choose Stop Audition in the browser first.`,
    );
    return true;
  };
  const embeddedCabCapture = Boolean(modelState?.ampIncludesCab || activeNAMPreview?.includesCab);
  const cabPresentation = resolveNAMRackCabPresentation({
    hasAmpCapture: hasAmpModel,
    hasCabIR,
    embeddedCabCapture,
  });
  const cabControlsUnavailableReason = cabPresentation.mode === "embedded"
    ? "This full-rig Capture already includes its cabinet. Load an amp-only Capture to use the external Cab/IR controls."
    : cabPresentation.mode === "required"
      ? "Choose a cabinet IR to enable the Cab/IR shaper for this amp Capture."
      : cabPresentation.mode === "empty"
        ? "Choose a cabinet IR to enable the external Cab/IR controls."
        : undefined;
  const savedNAMTone = schema.uiState?.namSavedTone;
  const savedNAMToneSlot = typeof savedNAMTone === "object" && savedNAMTone !== null && "slot" in savedNAMTone
    ? String((savedNAMTone as { slot?: unknown }).slot ?? "")
    : "";
  const identityForRackSlot = (targetSlot: NAMToneSlot, localPath: string) => resolveNAMToneIdentity({
    activePreview: activeNAMPreview?.slot === targetSlot ? activeNAMPreview : null,
    savedTone: savedNAMToneSlot === targetSlot ? savedNAMTone : null,
    installedRecord: activeNAMPreview?.slot === targetSlot ? activeNAMPreview.record : null,
    localPath,
    titleFallback: namDisplayNameFromPath(localPath),
  });
  const pedalIdentity = identityForRackSlot("pedal", modelState?.pedalModelPath || "");
  const ampIdentity = identityForRackSlot("amp", modelState?.ampModelPath || "");
  const cabIdentity = identityForRackSlot("cab", modelState?.cabIRPath || "");
  const pedalName = firstNAMDisplayName(pedalIdentity.title, pedalPathName);
  const ampName = firstNAMDisplayName(ampIdentity.title, ampPathName);
  const cabName = firstNAMDisplayName(cabIdentity.title, cabPathName);
  const missingAmpLabel = namHardwareDisplayName(firstNAMDisplayName(ampName, ampPathName), "amp capture");
  const hardwareAmpLabel = hasAmpModel
    ? namHardwareDisplayName(firstNAMDisplayName(ampName, ampPathName), "Amp capture loaded")
    : missingAmpAsset
      ? (/^missing\b/i.test(missingAmpLabel) ? missingAmpLabel : `Missing ${missingAmpLabel}`)
      : "No amp capture loaded";
  const hardwareCabLabel = cabPresentation.mode === "loaded"
    ? namHardwareDisplayName(firstNAMDisplayName(cabName, cabPathName), cabPresentation.label)
    : cabPresentation.label;
  const currentIREntry = currentCabIRPath ? irLibrary.find((entry) => entry.path === currentCabIRPath) : undefined;
  const favoriteIRs = irLibrary.filter((entry) => entry.favorite).slice(0, 6);
  const recentIRs = irLibrary.filter((entry) => !entry.favorite).slice(0, 8);
  const visibleFavoriteIRs = favoriteIRs.slice(0, 2);
  const visibleRecentIRs = recentIRs.slice(0, visibleFavoriteIRs.length > 0 ? 1 : 3);
  const schemaInputMeterDb = schema.visualization?.inputLevelDb;
  const schemaOutputMeterDb = schema.visualization?.outputLevelDb;
  const schemaRackDiagnostics =
    schema.visualization && "diagnostics" in schema.visualization && typeof schema.visualization.diagnostics === "object"
      ? schema.visualization.diagnostics as Record<string, unknown>
      : null;
  const rackDiagnostics = rackLiveDiagnostics ?? schemaRackDiagnostics;
  const processedBlockCount = numberFromRecord(rackDiagnostics, "processedBlockCount");
  const meterFreshness = meterFreshnessRef.current;
  if (
    processedBlockCount !== undefined
    && processedBlockCount !== meterFreshness.processedBlockCount
  ) {
    meterFreshness.processedBlockCount = processedBlockCount;
    meterFreshness.lastAdvanceAtMs = Date.now();
  }
  // If the host stops scheduling this processor, no further blocks arrive to
  // release its peak hold. Clear the presentation after the hold window rather
  // than leaving a former yellow/red peak frozen indefinitely.
  const meterTelemetryFresh = processedBlockCount === undefined
    || Date.now() - meterFreshness.lastAdvanceAtMs <= 900;
  const pedalModelSampleRate = Number(rackDiagnostics?.pedalModelSampleRate ?? 0);
  const ampModelSampleRate = Number(rackDiagnostics?.ampModelSampleRate ?? 0);
  const dualNAMActive = Boolean(
    rackDiagnostics?.dualNAMActive
      ?? (hasPedalModel && hasAmpModel),
  );
  const dualNAMCommonSampleRate = dualNAMActive
    && pedalModelSampleRate > 1000
    && Math.abs(pedalModelSampleRate - ampModelSampleRate) <= 1
      ? pedalModelSampleRate
      : 0;
  const inputMeterDb = meterTelemetryFresh
    ? resolveNAMLinkedMeterDb("input", rackDiagnostics, schemaInputMeterDb)
    : -90;
  const outputMeterDb = meterTelemetryFresh
    ? resolveNAMLinkedMeterDb("output", rackDiagnostics, schemaOutputMeterDb)
    : -90;
  const rawInputDb = meterTelemetryFresh
    ? Number(rackDiagnostics?.lastRawInputPeakDb ?? inputMeterDb ?? -90)
    : -90;
  const postRackInputDb = meterTelemetryFresh
    ? Number(rackDiagnostics?.lastInputPeakDb ?? inputMeterDb ?? -90)
    : -90;
  const auditionSourceActive = Boolean(rackDiagnostics?.auditionSourceActive);
  const auditionSourceRendered = Boolean(rackDiagnostics?.auditionSourceRendered);
  const modelProcessFailCount = Number(rackDiagnostics?.modelProcessFailCount ?? 0);
  const resizeAvoidedCount = Number(rackDiagnostics?.audioThreadResizeAvoidedCount ?? 0);
  const oversizeBypassCount = Number(rackDiagnostics?.oversizeBypassCount ?? 0);
  const realtimeDSPBlocked = Boolean(rackDiagnostics?.realtimeDSPBlocked);
  const audioDebugBlockSize = Number(audioDebugSnapshot?.blockSize ?? runtimeAudioDeviceSetup?.bufferSize ?? 0);
  const audioDebugSampleRate = Number(audioDebugSnapshot?.sampleRate ?? runtimeAudioDeviceSetup?.sampleRate ?? 0);
  const dualNAMRateMismatch = Boolean(
    dualNAMActive
      && audioDebugSampleRate > 1000
      && (
        (pedalModelSampleRate > 1000 && Math.abs(pedalModelSampleRate - audioDebugSampleRate) > 1)
        || (ampModelSampleRate > 1000 && Math.abs(ampModelSampleRate - audioDebugSampleRate) > 1)
      ),
  );
  const dualNAMRateAdvice = dualNAMRateMismatch
    ? dualNAMCommonSampleRate > 1000
      ? ` Both captures run at ${(dualNAMCommonSampleRate / 1000).toFixed(dualNAMCommonSampleRate % 1000 === 0 ? 0 : 1)} kHz; matching the interface sample rate avoids two serial resampling round trips.`
      : " The Pedal and Amp captures use model rates that differ from the interface; use the next larger buffer for this dual-NAM chain."
    : "";
  const audioBlockBudgetMs = audioDebugBlockSize > 0 && audioDebugSampleRate > 0
    ? (audioDebugBlockSize / audioDebugSampleRate) * 1000
    : 0;
  const audioCallbackMs = Number(audioDebugSnapshot?.lastAudioCallbackProcessMs ?? 0);
  const audioCallbackMaxMs = Number(audioDebugSnapshot?.maxAudioCallbackProcessMs ?? 0);
  const audioDeadlineStatus = resolveAudioDeadlineStatus(audioDebugSnapshot);
  const audioDeadlineMisses = audioDeadlineStatus.deviceSessionMissCount;
  const audioDeadlineWarning = audioDeadlineStatus.shouldWarn;
  const audioDebugRecord = audioDebugSnapshot as Record<string, unknown> | null;
  const nativeCpuUsage = numberFromRecord(audioDebugRecord, "cpuUsage");
  const tunerTelemetryForRack = isNAMTunerTelemetryForRack({
    snapshot: audioDebugSnapshot,
    hostTrack: runtimeHostTrack ?? null,
    hasTrackAddress: Boolean(address.trackId),
  });
  const tunerFrequencyHz = tunerTelemetryForRack ? numberFromRecord(audioDebugRecord, "tunerFrequencyHz") : undefined;
  const tunerCents = tunerTelemetryForRack ? numberFromRecord(audioDebugRecord, "tunerCents") : undefined;
  const tunerConfidence = tunerTelemetryForRack ? numberFromRecord(audioDebugRecord, "tunerConfidence") : undefined;
  const tunerInputLevelDb = tunerTelemetryForRack
    ? numberFromRecord(audioDebugRecord, "tunerInputLevelDb") ?? rawInputDb
    : -120;
  const tunerNoteName = tunerTelemetryForRack ? stringFromRecord(audioDebugRecord, "tunerNoteName") : undefined;
  const tunerSignalPresent = tunerTelemetryForRack && (
    booleanFromRecord(audioDebugRecord, "tunerSignalPresent")
      ?? (tunerInputLevelDb > -62 && !auditionSourceRendered)
  );
  const tunerPitchLocked = Boolean(booleanFromRecord(audioDebugRecord, "tunerPitchLocked") && tunerFrequencyHz && tunerFrequencyHz > 0 && tunerNoteName);
  const tunerCentsClamped = clamp(tunerCents ?? 0, -50, 50);
  const tunerNeedlePct = tunerPitchLocked ? clamp(((tunerCentsClamped + 50) / 100) * 100, 0, 100) : 50;
  const tunerFrequencyLabel = tunerPitchLocked && tunerFrequencyHz
    ? `${tunerFrequencyHz.toFixed(tunerFrequencyHz >= 100 ? 1 : 2)} Hz`
    : "--";
  const tunerConfidenceLabel = tunerPitchLocked && tunerConfidence !== undefined
    ? `${Math.round(clamp(tunerConfidence, 0, 1) * 100)}%`
    : "--";
  const tunerStatusLabel = tunerPitchLocked
    ? Math.abs(tunerCentsClamped) <= 3
      ? "In tune"
      : `${Math.abs(tunerCentsClamped).toFixed(0)} cents ${tunerCentsClamped < 0 ? "flat" : "sharp"}`
    : tunerSignalPresent
      ? "Signal detected"
      : "No pitch lock";
  const dspBudgetPct = audioBlockBudgetMs > 0 && audioCallbackMs > 0
    ? clamp((audioCallbackMs / audioBlockBudgetMs) * 100, 0, 999)
    : undefined;
  const dspMaxBudgetPct = audioBlockBudgetMs > 0 && audioCallbackMaxMs > 0
    ? clamp((audioCallbackMaxMs / audioBlockBudgetMs) * 100, 0, 999)
    : undefined;
  const formatStatusPercent = (value: number | undefined) => {
    if (value === undefined) return "--";
    return `${(value >= 100 ? value.toFixed(0) : value.toFixed(1)).replace(/\.0$/, "")}%`;
  };
  const dspBudgetLabel = formatStatusPercent(dspBudgetPct);
  const dspMaxBudgetLabel = formatStatusPercent(dspMaxBudgetPct);
  const nativeCpuUsagePct = nativeCpuUsage === undefined ? undefined : clamp(nativeCpuUsage, 0, 100);
  const dspBudgetMeterPct = dspBudgetPct === undefined ? undefined : clamp(dspBudgetPct, 0, 100);
  const namRealtimeBlocked = Boolean(
    ampActive && realtimeDSPBlocked,
  );
  const dspBudgetAlert = Boolean(
    namRealtimeBlocked
    || audioDeadlineWarning
    || (dspBudgetPct ?? 0) >= 80,
  );
  const selectedInputLabel = formatNAMRuntimeInputLabel({
    address,
    track: runtimeHostTrack,
    device: runtimeAudioDeviceSetup,
  });
  const runtimeDeviceLabel = formatNAMRuntimeDeviceLabel(runtimeAudioDeviceSetup);
  const hasMultipleHardwareInputs = (runtimeAudioDeviceSetup?.numInputChannels ?? 0) >= 2
    || (runtimeAudioDeviceSetup?.inputChannelNames?.length ?? 0) >= 2;
  const monoInputOneWarning = Boolean(
    runtimeHostTrack
    && runtimeHostTrack.type === "audio"
    && runtimeHostTrack.inputChannelCount === 1
    && runtimeHostTrack.inputStartChannel === 0
    && hasMultipleHardwareInputs
    && ampActive,
  );
  const cabMissingWarning = Boolean(ampActive && cabPresentation.needsCabIR);
  const liveInputDetected = rawInputDb > -60 && !auditionSourceRendered;
  const inputDiagnosticTone =
    modelProcessFailCount > 0 || resizeAvoidedCount > 0 || oversizeBypassCount > 0 || realtimeDSPBlocked ? "error" :
    audioDeadlineWarning || (dspBudgetPct ?? 0) >= 80 ? "warning" :
    monoInputOneWarning || cabMissingWarning ? "warning" :
    liveInputDetected ? "success" :
    auditionSourceRendered ? "info" :
    "idle";
  const modeRailStatus: NAMRackModeRailStatus = {
    cpu: nativeCpuUsage === undefined ? undefined : {
      label: `${clamp(nativeCpuUsage, 0, 999).toFixed(0)}%`,
      alert: nativeCpuUsage >= 85,
      meterPct: nativeCpuUsagePct,
    },
    dsp: {
      label: namRealtimeBlocked ? "Blocked" : dspBudgetLabel,
      alert: dspBudgetAlert,
      meterPct: namRealtimeBlocked ? undefined : dspBudgetMeterPct,
      title: audioBlockBudgetMs > 0
        ? `Callback ${audioCallbackMs.toFixed(2)} ms / ${audioBlockBudgetMs.toFixed(2)} ms block budget; device-session max ${audioCallbackMaxMs.toFixed(2)} ms (${dspMaxBudgetLabel}); over-budget callbacks ${audioDeadlineMisses}`
        : "DSP callback budget is waiting for native audio debug data",
    },
    sampleRateLabel: audioDebugSampleRate > 0
      ? `${(audioDebugSampleRate / 1000).toFixed(audioDebugSampleRate % 1000 === 0 ? 0 : 1)} kHz`
      : "--",
    bufferLabel: audioDebugBlockSize > 0 ? `${audioDebugBlockSize} smp` : "--",
    latencyLabel: audioBlockBudgetMs > 0 ? `Block ${audioBlockBudgetMs.toFixed(1)} ms` : "--",
  };
  const openRoutingForHostTrack = () => {
    if (rackWindowCapabilities.canOpenTrackRouting && address.trackId) {
      openTrackRouting(address.trackId);
    }
  };
  const settlePresetPrompt = useCallback((result: string | null) => {
    const resolver = presetPromptResolverRef.current;
    presetPromptResolverRef.current = null;
    setPresetPrompt(null);
    resolver?.(result);
  }, []);
  const requestPresetPrompt = useCallback((request: Omit<NAMRackPrompt, "value"> & { value?: string }) => {
    presetPromptResolverRef.current?.(null);
    return new Promise<string | null>((resolve) => {
      presetPromptResolverRef.current = resolve;
      setPresetPrompt({ ...request, value: request.value ?? "" });
    });
  }, []);
  useEffect(() => () => {
    presetPromptResolverRef.current?.(null);
    presetPromptResolverRef.current = null;
  }, []);
  useEffect(() => {
    let cancelled = false;
    let refreshInFlight = false;

    const refreshAudioDebugSnapshot = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const snapshot = await nativeBridge.getAudioDebugSnapshot();
        if (!cancelled) setAudioDebugSnapshot(snapshot);
      } catch (error) {
        if (!cancelled) {
          console.warn("[NAMRackPanel] Could not refresh audio debug snapshot", error);
        }
      } finally {
        refreshInFlight = false;
      }
    };

    void refreshAudioDebugSnapshot();
    const refreshMs = rackRailTab === "tuner" ? 100 : 750;
    const timer = window.setInterval(() => {
      void refreshAudioDebugSnapshot();
    }, refreshMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rackRailTab]);
  useEffect(() => {
    let cancelled = false;
    let refreshInFlight = false;

    const refreshRackDiagnostics = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const diagnostics = await nativeBridge.getNAMRackDiagnostics(address);
        if (!cancelled && diagnostics) setRackLiveDiagnostics(diagnostics);
      } catch (error) {
        if (!cancelled) {
          console.warn("[NAMRackPanel] Could not refresh NAM diagnostics", error);
        }
      } finally {
        refreshInFlight = false;
      }
    };

    setRackLiveDiagnostics(null);
    void refreshRackDiagnostics();
    const timer = window.setInterval(() => {
      void refreshRackDiagnostics();
    }, 100);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [address.chain, address.fxIndex, address.trackId]);
  const focusedParamIds = useMemo(() => {
    return moduleParamIds(focusedModule);
  }, [focusedModule]);
  const focusedParams = useMemo(
    () =>
      focusedParamIds
        .map((id) => paramById(params, id))
        .filter((param): param is BuiltInParamDescriptor => Boolean(param)),
    [focusedParamIds, params],
  );
  const ampFaceplateParams = useMemo(
    () => [
      ["ampGainDb", "Input"],
      ["ampBoost", "Tight"],
      ["ampVoice", "Bright"],
      ["bassDb", "Post Bass"],
      ["midDb", "Post Mid"],
      ["trebleDb", "Post Treble"],
      ["presenceDb", "Post Presence"],
      ["ampMix", "Capture Mix"],
      ["ampOutputDb", "Post Level"],
    ]
      .map(([id, label]) => {
        const param = paramById(params, id);
        return param ? { ...param, label } : undefined;
      })
      .filter((param): param is BuiltInParamDescriptor => Boolean(param)),
    [params],
  );
  const pedalStageParams = useMemo(
    () => focusedModule === "pedal"
      ? focusedParams.filter((param) => param.id !== "inputTrimDb" && param.id !== "outputTrimDb")
      : focusedParams,
    [focusedModule, focusedParams],
  );
  const cabRoomKnobs = useMemo(
    () => focusedModule === "cab"
      ? focusedParams.filter((param) => param.id !== "cabEnabled" && param.id !== "cabPhaseInvert")
      : [],
    [focusedModule, focusedParams],
  );
  const postCabOrder = useMemo(
    () => slotOrder.filter((moduleId) => moduleId === "eq" || moduleId === "mod" || moduleId === "delay" || moduleId === "reverb"),
    [slotOrder],
  );
  const postCabOrderLabel = useMemo(
    () => postCabOrder.map((moduleId) => moduleTitle(moduleId)).join(" > "),
    [postCabOrder],
  );
  const renderPedalKnob = useCallback(
    (param: BuiltInParamDescriptor) => (
      <RackKnob param={param} onChange={onParamChange} size="large" />
    ),
    [onParamChange],
  );
  const eqParamIds = NAM_RACK_GRAPHIC_EQ_PARAM_IDS;

  useEffect(() => {
    if (!persistedCompareState) return;
    setCompareSlot(persistedCompareState.compareSlot);
    setCompareSnapshots(persistedCompareState.snapshots);
  }, [persistedCompareState]);

  useEffect(() => {
    setSlotOrder((current) => (
      sameRackSlotOrder(current, persistedRackSlots.order) ? current : persistedRackSlots.order
    ));
    setFavoriteSlots((current) => (
      current.length === persistedRackSlots.favorites.length && current.every((moduleId, index) => moduleId === persistedRackSlots.favorites[index])
        ? current
        : persistedRackSlots.favorites
    ));
    setModuleCopies((current) => {
      const currentKey = JSON.stringify(current);
      const nextKey = JSON.stringify(persistedRackSlots.moduleCopies);
      return currentKey === nextKey ? current : persistedRackSlots.moduleCopies;
    });
  }, [persistedSlotStateKey]);

  const currentSnapshot = useMemo<RackCompareSnapshot>(() => {
    const values: Record<string, number> = {};
    for (const param of params) {
      if (["calibrationReferenceDbu", "auditionSource", "laserTrigger"].includes(param.id)) continue;
      values[param.id] = param.id === "laserMode"
        ? projectNAMRackParamForUI(param).value
        : param.value;
    }

    const modelSnapshot: RackCompareSnapshot["modelState"] = {};
    const pedalPath = modelState?.pedalModelPath?.trim() ?? "";
    const ampPath = modelState?.ampModelPath?.trim() ?? "";
    const cabPath = modelState?.cabIRPath?.trim() ?? "";
    if (pedalPath) modelSnapshot.pedalModelPath = pedalPath;
    else modelSnapshot.clearPedalModel = true;
    if (ampPath) modelSnapshot.ampModelPath = ampPath;
    else modelSnapshot.clearAmpModel = true;
    if (cabPath) modelSnapshot.cabIRPath = cabPath;
    else modelSnapshot.clearCabIR = true;
    if (typeof modelState?.cabRequestedEnabled === "boolean") {
      modelSnapshot.cabRequestedEnabled = modelState.cabRequestedEnabled;
    }
    if (pedalPath && modelState?.pedalDeclaredCaptureType) {
      modelSnapshot.pedalDeclaredCaptureType = modelState.pedalDeclaredCaptureType;
    }
    if (ampPath && modelState?.ampDeclaredCaptureType) {
      modelSnapshot.ampDeclaredCaptureType = modelState.ampDeclaredCaptureType;
    }

    return {
      values,
      modelState: modelSnapshot,
      postFxOrder: postCabOrder,
      presetId,
      focusedModule,
      capturedAt: Date.now(),
    };
  }, [
    focusedModule,
    modelState?.ampDeclaredCaptureType,
    modelState?.ampModelPath,
    modelState?.cabIRPath,
    modelState?.cabRequestedEnabled,
    modelState?.pedalDeclaredCaptureType,
    modelState?.pedalModelPath,
    params,
    postCabOrder,
    presetId,
  ]);
  const activeUserPresetName = typeof schema.uiState?.namActivePresetName === "string"
    ? schema.uiState.namActivePresetName.trim()
    : "";
  const activeUserPresetBaseline = normalizeCompareSnapshot(schema.uiState?.namPresetBaseline);
  const hasFactoryPresetSelection = NAM_RACK_PRESETS.some(
    (entry) => entry.id === presetId,
  );
  const displayPresetName = activeUserPresetName
    || (hasFactoryPresetSelection
      ? preset.name
      : firstNAMDisplayName(ampName, "New Rig"));
  const displayPresetEyebrow = activeUserPresetName || hasFactoryPresetSelection
    ? "Current Preset"
    : "Loaded Amp Capture";
  const headerPresetNavigation = useMemo(
    () => resolveNAMHeaderPresetNavigation({
      factoryPresets: NAM_RACK_PRESETS,
      userPresets,
      activeFactoryId: hasFactoryPresetSelection ? preset.id : "",
      activeUserPresetName,
    }),
    [activeUserPresetName, hasFactoryPresetSelection, preset.id, userPresets],
  );
  const isPresetDirty = activeUserPresetName
    ? snapshotDiffers(currentSnapshot, activeUserPresetBaseline) || schema.uiState?.namPresetDirty === true
    : hasFactoryPresetSelection
      ? presetDirty(preset, params)
        || !sameRackSlotOrder(postCabOrder, DEFAULT_POST_FX_ORDER)
        || schema.uiState?.namPresetDirty === true
      : schema.uiState?.namPresetDirty === true;
  const currentCompareDirty = snapshotDiffers(currentSnapshot, compareSnapshots[compareSlot]);
  const updatePresetDirtyMarker = async (
    dirty: boolean,
    identity?: { name?: string; baseline?: RackCompareSnapshot; clear?: boolean },
  ) => {
    const latestState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
    const latestUiState = latestState?.uiState && typeof latestState.uiState === "object"
      ? latestState.uiState as Record<string, unknown>
      : { ...(schema.uiState ?? {}) };
    const nextUiState: Record<string, unknown> = {
      ...latestUiState,
      namPresetDirty: dirty,
    };
    if (identity?.clear) {
      nextUiState.namActivePresetName = null;
      nextUiState.namPresetBaseline = null;
    } else {
      if (identity?.name) nextUiState.namActivePresetName = identity.name;
      if (identity?.baseline) nextUiState.namPresetBaseline = identity.baseline;
    }
    return nativeBridge.setBuiltInPluginState(address, {
      uiState: {
        ...nextUiState,
      },
    });
  };
  const filteredFactoryPresets = useMemo(() => {
    const needle = presetSearch.trim().toLowerCase();
    if (!needle) return NAM_RACK_PRESETS;
    return NAM_RACK_PRESETS.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(needle));
  }, [presetSearch]);
  const filteredUserPresets = useMemo(() => {
    const needle = presetSearch.trim().toLowerCase();
    const rows = userPresets.filter((entry) => {
      const metadata = presetMetadata[entry.name] ?? {};
      const tags = metadata.tags ?? [];
      const folder = metadata.folder ?? "";
      const notes = metadata.notes ?? "";
      const matchesFolder =
        presetFolderFilter === "all" ||
        (presetFolderFilter === "favorites" && metadata.favorite) ||
        (presetFolderFilter === "recent" && metadata.lastUsed) ||
        folder === presetFolderFilter;
      if (!matchesFolder) return false;
      if (!needle) return true;
      return `${entry.name} ${entry.path ?? ""} ${folder} ${tags.join(" ")} ${notes}`.toLowerCase().includes(needle);
    });
    return rows.sort((left, right) => {
      if (presetFolderFilter === "recent") {
        return (presetMetadata[right.name]?.lastUsed ?? 0) - (presetMetadata[left.name]?.lastUsed ?? 0);
      }
      if (presetMetadata[left.name]?.favorite !== presetMetadata[right.name]?.favorite) {
        return presetMetadata[left.name]?.favorite ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }, [presetFolderFilter, presetMetadata, presetSearch, userPresets]);
  const presetFolders = useMemo(() => {
    const folders = new Set(DEFAULT_PRESET_FOLDERS);
    for (const metadata of Object.values(presetMetadata)) {
      if (metadata.folder) folders.add(metadata.folder);
    }
    return [...folders].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  }, [presetMetadata]);
  const presetFolderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of userPresets) {
      const folder = presetMetadata[entry.name]?.folder || "Unfiled";
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    return counts;
  }, [presetMetadata, userPresets]);

  const persistNAMUiStatePatch = (patch: Record<string, unknown>, warning: string): Promise<boolean> => {
    const operation = uiStatePersistenceRef.current
      .catch(() => undefined)
      .then(async () => {
        const latestState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
        const latestStateRecord = latestState && typeof latestState === "object"
          ? latestState as Record<string, unknown>
          : {};
        const latestUiState = latestStateRecord.uiState && typeof latestStateRecord.uiState === "object"
          ? latestStateRecord.uiState as Record<string, unknown>
          : {};
        const fallbackUiState = schema.uiState && typeof schema.uiState === "object"
          ? schema.uiState as Record<string, unknown>
          : {};
        const ok = await nativeBridge.setBuiltInPluginState(address, {
          uiState: {
            ...fallbackUiState,
            ...latestUiState,
            ...patch,
          },
        });
        if (!ok) throw new Error(warning);
        return true;
      })
      .catch((error) => {
        console.warn(`[NAMRackPanel] ${warning}`, error);
        return false;
      });
    uiStatePersistenceRef.current = operation.then(() => undefined);
    return operation;
  };

  const persistCompareState = (
    nextSlot: CompareSlot,
    nextSnapshots: Partial<Record<CompareSlot, RackCompareSnapshot>>,
  ) => {
    persistNAMUiStatePatch({
      namRackCompare: {
        schemaVersion: 1,
        compareSlot: nextSlot,
        snapshots: nextSnapshots,
      },
    }, "Could not persist compare state");
  };

  const persistSlotOrder = async (nextOrder: RackModuleId[]): Promise<boolean> => {
    if (slotOrderPersistencePendingRef.current) {
      setSlotActionStatus("Wait for the current post-FX order change to finish.");
      return false;
    }

    slotOrderPersistencePendingRef.current = true;
    setSlotOrderBusy(true);
    setSlotOrderError("");
    const previousOrder = [...slotOrder];
    const normalizedOrder = normalizeRackSlotOrder(nextOrder);
    setSlotActionStatus("Saving post-FX order…");

    const result = await persistOptimisticNAMRackOrder({
      previousOrder,
      nextOrder: normalizedOrder,
      applyOrder: setSlotOrder,
      persistOrder: (order) => persistNAMUiStatePatch({
        namRackSlots: {
          schemaVersion: 1,
          order,
          favorites: favoriteSlots,
          moduleCopies,
        },
      }, "Could not persist rack slot order"),
    });

    slotOrderPersistencePendingRef.current = false;
    setSlotOrderBusy(false);
    if (!result.ok) {
      const errorMessage = result.errorMessage ?? "The post-FX order could not be saved.";
      setSlotOrderError(errorMessage);
      setSlotActionStatus(errorMessage);
      return false;
    }

    setSlotActionStatus("Post-FX order saved");
    return true;
  };

  const persistSlotUiState = (nextState: Partial<RackSlotsPersistence>) => {
    const nextOrder = nextState.order ? normalizeRackSlotOrder(nextState.order) : slotOrder;
    const nextFavorites = nextState.favorites ? normalizeRackSlotFavorites(nextState.favorites) : favoriteSlots;
    const nextCopies = nextState.moduleCopies ? normalizeRackModuleCopies(nextState.moduleCopies) : moduleCopies;
    setSlotOrder(nextOrder);
    setFavoriteSlots(nextFavorites);
    setModuleCopies(nextCopies);
    persistNAMUiStatePatch({
      namRackSlots: {
        schemaVersion: 1,
        order: nextOrder,
        favorites: nextFavorites,
        moduleCopies: nextCopies,
      },
    }, "Could not persist rack slot UI state");
  };

  const refreshUserPresets = useCallback(async (): Promise<UserRackPreset[]> => {
    try {
      const presets = await nativeBridge.getBuiltInFXPresets(NAM_RACK_PLUGIN_NAME);
      const normalized = presets
        .map((entry) => ({
          name: String(entry.name ?? "").trim(),
          path: typeof entry.path === "string" ? entry.path : undefined,
          metadataPath: typeof entry.metadataPath === "string" ? entry.metadataPath : undefined,
          metadata: normalizePresetSidecar(entry.metadata, String(entry.name ?? "").trim()),
        }))
        .filter((entry) => entry.name)
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
      setUserPresets(normalized);
      const sidecarMetadata = normalized
        .filter((entry) => entry.metadata)
        .map((entry) => [entry.name, entry.metadata] as const);
      if (sidecarMetadata.length > 0) {
        setPresetMetadata((current) => {
          let changed = false;
          const next = { ...current };
          for (const [name, metadata] of sidecarMetadata) {
            if (!metadata) continue;
            const currentUpdatedAt = current[name]?.updatedAt ?? 0;
            const sidecarUpdatedAt = metadata.updatedAt ?? 0;
            if (!current[name] || sidecarUpdatedAt >= currentUpdatedAt) {
              next[name] = compactPresetMetadata({ ...current[name], ...metadata });
              changed = true;
            }
          }
          if (changed) savePresetMetadata(next);
          return changed ? next : current;
        });
      }
      return normalized;
    } catch (error) {
      console.warn("[NAMRackPanel] Could not refresh user presets", error);
      setPresetStatus("User presets unavailable");
      return [];
    }
  }, []);

  useEffect(() => {
    void refreshUserPresets();
  }, [refreshUserPresets]);

  useEffect(() => {
    if (presetManagerOpen) void refreshUserPresets();
  }, [presetManagerOpen, refreshUserPresets]);

  const updatePresetMetadata = (
    presetName: string,
    patch: UserRackPresetMetadata | ((current: UserRackPresetMetadata) => UserRackPresetMetadata),
    metadataPathOverride = "",
  ) => {
    const name = sanitizePresetName(presetName);
    if (!name) return;
    const targetMetadataPath = metadataPathOverride || presetMetadataPath(userPresets.find((entry) => entry.name === name));
    setPresetMetadata((current) => {
      const currentEntry = current[name] ?? {};
      const nextEntry = typeof patch === "function" ? patch(currentEntry) : { ...currentEntry, ...patch };
      const persistedEntry = compactPresetMetadata({ ...nextEntry, updatedAt: Date.now() });
      const next = { ...current, [name]: persistedEntry };
      savePresetMetadata(next);
      if (targetMetadataPath) {
        void savePresetMetadataSidecar(name, persistedEntry, targetMetadataPath).catch((error) => {
          console.warn("[NAMRackPanel] Could not save preset metadata sidecar", error);
        });
      }
      return next;
    });
  };

  const movePresetMetadata = (
    fromName: string,
    toName: string,
    keepOriginal = false,
    toMetadataPath = "",
    fromMetadataPath = "",
  ) => {
    const from = sanitizePresetName(fromName);
    const to = sanitizePresetName(toName);
    if (!from || !to) return;
    setPresetMetadata((current) => {
      const next = { ...current };
      if (current[from]) {
        next[to] = compactPresetMetadata({ ...current[from], updatedAt: Date.now() });
        if (!keepOriginal) delete next[from];
        if (toMetadataPath) {
          void savePresetMetadataSidecar(to, next[to], toMetadataPath).catch((error) => {
            console.warn("[NAMRackPanel] Could not move preset metadata sidecar", error);
          });
        }
        if (!keepOriginal && fromMetadataPath) {
          void nativeBridge.deleteFiles([fromMetadataPath]).catch((error) => {
            console.warn("[NAMRackPanel] Could not delete old preset metadata sidecar", error);
          });
        }
      }
      savePresetMetadata(next);
      return next;
    });
  };

  const storeCompareSnapshot = (slot = compareSlot, snapshot = currentSnapshot, activeSlot = compareSlot) => {
    const nextSnapshots = {
      ...compareSnapshots,
      [slot]: snapshot,
    };
    setCompareSnapshots(nextSnapshots);
    persistCompareState(activeSlot, nextSnapshots);
  };

  const recallCompareSlot = async (slot: CompareSlot) => {
    if (slot === compareSlot) {
      storeCompareSnapshot(slot, currentSnapshot, slot);
      return;
    }

    const target = compareSnapshots[slot];
    if (target?.modelState && blockResourceChangeWhilePreviewing(`Compare ${slot}`)) return;
    const nextSnapshots = {
      ...compareSnapshots,
      [compareSlot]: currentSnapshot,
    };
    if (!target) {
      setCompareSnapshots(nextSnapshots);
      setCompareSlot(slot);
      persistCompareState(slot, nextSnapshots);
      return;
    }

    setPresetBusy(true);
    try {
      const targetPostFxOrder = target.postFxOrder
        ? normalizeRackSlotOrder(target.postFxOrder).filter((moduleId) => !isLockedSpineModule(moduleId))
        : undefined;
      const latestState = targetPostFxOrder
        ? await nativeBridge.getBuiltInPluginState(address).catch(() => null)
        : null;
      const latestUiState = latestState?.uiState && typeof latestState.uiState === "object"
        ? latestState.uiState as Record<string, unknown>
        : { ...(schema.uiState ?? {}) };
      const latestRackSlots = latestUiState.namRackSlots && typeof latestUiState.namRackSlots === "object"
        ? latestUiState.namRackSlots as Record<string, unknown>
        : {};
      const ok = await nativeBridge.setBuiltInPluginState(address, {
        values: target.values,
        modelState: target.modelState,
        ...(targetPostFxOrder
          ? {
              uiState: {
                ...latestUiState,
                namRackSlots: {
                  ...latestRackSlots,
                  schemaVersion: 1,
                  order: [...LOCKED_RACK_SPINE, ...targetPostFxOrder],
                },
              },
            }
          : {}),
      });
      if (ok) {
        if (targetPostFxOrder) setSlotOrder([...LOCKED_RACK_SPINE, ...targetPostFxOrder]);
        setCompareSnapshots(nextSnapshots);
        setCompareSlot(slot);
        persistCompareState(slot, nextSnapshots);
        setPresetId(target.presetId);
        setFocusedModule(target.focusedModule);
        setPresetStatus(`Recalled compare slot ${slot}`);
        onRefreshRack();
      } else {
        setPresetStatus(`Compare slot ${slot} could not be recalled; the current Preset was retained`);
      }
    } catch (error) {
      console.warn(`[NAMRackPanel] Could not recall compare slot ${slot}`, error);
      setPresetStatus(`Compare slot ${slot} could not be recalled; the current Preset was retained`);
    } finally {
      setPresetBusy(false);
    }
  };

  const rememberValues = (moduleId: RackModuleId, ids: string[]) => {
    const captured: Record<string, number> = {};
    for (const id of ids) {
      const param = paramById(params, id);
      if (param) captured[id] = param.value;
    }
    if (Object.keys(captured).length === 0) return;
    setPowerMemory((current) => ({
      ...current,
      [moduleId]: {
        ...(current[moduleId] ?? {}),
        ...captured,
      },
    }));
  };

  const restoredValue = (moduleId: RackModuleId, param: BuiltInParamDescriptor, fallback: number) => {
    return clamp(powerMemory[moduleId]?.[param.id] ?? fallback, param.min, param.max);
  };

  const toggleParamPower = (
    moduleId: RackModuleId,
    param: BuiltInParamDescriptor | undefined,
    active: boolean,
    offValue: number,
    onFallback: number,
  ) => {
    if (!param) return;
    if (active) {
      rememberValues(moduleId, [param.id]);
      onParamChange(param, offValue);
    } else {
      onParamChange(param, restoredValue(moduleId, param, onFallback));
    }
  };

  const toggleCabPower = () => {
    if (!cabPresentation.canToggleExternalCab) {
      setSlotActionStatus(
        embeddedCabCapture
          ? "This amp capture already includes a cabinet. Load an amp-only capture before enabling the external Cab/IR."
          : hasAmpModel
            ? "Choose a cabinet IR before enabling the external Cab/IR stage."
            : "Load an amp capture and cabinet IR before enabling the external Cab/IR stage.",
      );
      return;
    }
    toggleParamPower("cab", cabEnabledParam, cabActive, 0, 1);
  };

  const modelStateForModule = (moduleId: RackModuleId): RackCompareSnapshot["modelState"] | undefined => {
    if (moduleId === "pedal") {
      return modelState?.pedalModelPath
        ? {
            pedalModelPath: modelState.pedalModelPath,
            pedalDeclaredCaptureType: modelState.pedalDeclaredCaptureType ?? "unknown",
          }
        : { clearPedalModel: true };
    }
    if (moduleId === "amp") {
      return modelState?.ampModelPath
        ? {
            ampModelPath: modelState.ampModelPath,
            ampDeclaredCaptureType: modelState.ampDeclaredCaptureType ?? "unknown",
          }
        : { clearAmpModel: true };
    }
    if (moduleId === "cab") {
      return {
        ...(modelState?.cabIRPath ? { cabIRPath: modelState.cabIRPath } : { clearCabIR: true }),
        ...(typeof modelState?.cabRequestedEnabled === "boolean"
          ? { cabRequestedEnabled: modelState.cabRequestedEnabled }
          : {}),
      };
    }
    return undefined;
  };

  const toggleSlotFavorite = (moduleId: RackModuleId) => {
    const nextFavorites = favoriteSlots.includes(moduleId)
      ? favoriteSlots.filter((entry) => entry !== moduleId)
      : [...favoriteSlots, moduleId];
    persistSlotUiState({ favorites: nextFavorites });
    setSlotActionStatus(
      nextFavorites.includes(moduleId)
        ? `${moduleTitle(moduleId)} added to slot favorites`
        : `${moduleTitle(moduleId)} removed from slot favorites`,
    );
  };

  const duplicateSlotSettings = (moduleId: RackModuleId) => {
    const values: Record<string, number> = {};
    for (const id of moduleParamIds(moduleId)) {
      const param = paramById(params, id);
      if (param) values[id] = param.value;
    }
    if (Object.keys(values).length === 0) {
      setSlotActionStatus(`${moduleTitle(moduleId)} has no editable settings to copy`);
      return;
    }

    const copy: RackModuleCopy = {
      moduleId,
      label: `${moduleTitle(moduleId)} copy`,
      values,
      modelState: modelStateForModule(moduleId),
      capturedAt: Date.now(),
    };
    persistSlotUiState({ moduleCopies: { ...moduleCopies, [moduleId]: copy } });
    setSlotActionStatus(`${moduleTitle(moduleId)} settings duplicated for quick recall`);
  };

  const applySlotCopy = async (moduleId: RackModuleId) => {
    const copy = moduleCopies[moduleId];
    if (!copy) {
      setSlotActionStatus(`Duplicate ${moduleTitle(moduleId)} settings first`);
      return;
    }
    if (copy.modelState && blockResourceChangeWhilePreviewing(`Apply ${moduleTitle(moduleId)} copy`)) return;
    const ok = await nativeBridge.setBuiltInPluginState(address, {
      values: copy.values,
      modelState: copy.modelState ?? {},
    });
    if (ok) {
      setFocusedModule(moduleId);
      setSlotActionStatus(`${moduleTitle(moduleId)} duplicate applied`);
      onRefreshRack();
    }
  };

  const resetSlotModule = async (moduleId: RackModuleId) => {
    const values: Record<string, number> = {};
    for (const id of moduleParamIds(moduleId)) {
      const param = paramById(params, id);
      if (param) values[id] = param.defaultValue ?? 0;
    }
    const ok = await nativeBridge.setBuiltInPluginState(address, { values });
    if (ok) {
      setSlotActionStatus(`${moduleTitle(moduleId)} reset`);
      onRefreshRack();
    }
  };

  const removeSlotModule = async (moduleId: RackModuleId) => {
    if ((moduleId === "pedal" || moduleId === "cab")
      && blockResourceChangeWhilePreviewing(`Remove ${moduleTitle(moduleId)}`)) return;
    const values: Record<string, number> = {};
    const nextModelState: RackCompareSnapshot["modelState"] = {};
    if (moduleId === "gate") {
      const gateParam = paramById(params, "gateThresholdDb");
      if (gateParam) values.gateThresholdDb = gateParam.min;
    } else if (moduleId === "pedal") {
      values.pedalMix = 0;
      values.precisionDriveEnabled = 0;
      nextModelState.clearPedalModel = true;
    } else if (moduleId === "amp") {
      values.ampMix = 1;
      await resetSlotModule("amp");
      setSlotActionStatus("Amp Capture is the required rack spine, so it was reset instead of removed");
      return;
    } else if (moduleId === "cab") {
      values.cabEnabled = 0;
      nextModelState.clearCabIR = true;
    } else if (moduleId === "eq") {
      for (const id of eqParamIds) values[id] = 0;
    } else if (moduleId === "mod") {
      values.chorusMix = 0;
    } else if (moduleId === "delay") {
      values.delayMix = 0;
    } else if (moduleId === "reverb") {
      values.reverbMix = 0;
    }

    const ok = await nativeBridge.setBuiltInPluginState(address, {
      values,
      modelState: nextModelState,
    });
    if (ok) {
      setSlotActionStatus(`${moduleTitle(moduleId)} removed from the active rig`);
      onRefreshRack();
    }
  };

  const applyPreset = async (nextPreset = preset) => {
    if (nextPreset.requiresAmpModel && !hasAmpModel) {
      setFocusedModule("amp");
      setSlotActionStatus("Load an Amp Capture first. Templates for Current Capture adjust supported effect settings; they do not include a NAM Capture or IR.");
      return;
    }
    const presetValues = presetValuesWithRackDefaults(nextPreset.values);
    setPresetBusy(true);
    try {
      const ok = await nativeBridge.setBuiltInPluginState(address, {
        values: presetValues,
      });
      if (ok) {
        await updatePresetDirtyMarker(false, { clear: true });
        setPresetId(nextPreset.id);
        storeCompareSnapshot(compareSlot, {
          ...currentSnapshot,
          values: {
            ...currentSnapshot.values,
            ...presetValues,
          },
          presetId: nextPreset.id,
          focusedModule: nextPreset.focus,
          capturedAt: Date.now(),
        });
        setFocusedModule(nextPreset.focus);
        onRefreshRack();
      }
    } finally {
      setPresetBusy(false);
    }
  };

  const saveUserPreset = async () => {
    const activePreviewPath = activeNAMPreview?.localPath?.replace(/\\/g, "/").toLowerCase() ?? "";
    const hasUncommittedPreview = Boolean(activeNAMPreview && (
      !activeNAMPreview.saved
      || activeNAMPreview.previewDownload
      || activePreviewPath.includes("/previews/")
    ));
    if (hasUncommittedPreview) {
      setPresetManagerOpen(true);
      setPresetStatus(`A temporary ${activeNAMPreview?.slot === "cab" ? "IR" : "Capture"} audition is active. Choose ${activeNAMPreview?.slot === "cab" ? "Use IR" : "Use Capture"} or Stop Audition in the browser before saving the Preset.`);
      return;
    }

    const name = sanitizePresetName(presetNameDraft || `${displayPresetName} custom`);
    if (!name) {
      setPresetStatus("Name the preset first");
      return;
    }

    setPresetManagerBusy(true);
    setPresetStatus("Saving preset");
    try {
      const ok = await nativeBridge.saveBuiltInFXPreset(
        address.trackId ?? "",
        address.fxIndex ?? 0,
        address.chain === "input",
        name,
        address.chain,
      );
      if (!ok) {
        setPresetStatus("Preset could not be saved");
        return;
      }
      await updatePresetDirtyMarker(false, { name, baseline: currentSnapshot });
      const refreshed = await refreshUserPresets();
      const savedPreset = refreshed.find((entry) => entry.name === name);
      setPresetNameDraft("");
      const folderDraft = sanitizePresetFolder(presetFolderDraft);
      const tagsDraft = parsePresetTags(presetTagsDraft);
      const notesDraft = sanitizePresetNotes(presetNotesDraft);
      updatePresetMetadata(name, (current) => ({
        ...current,
        folder: folderDraft || current.folder || "Studio",
        tags: tagsDraft.length ? tagsDraft : current.tags?.length ? current.tags : [focusedModule, preset.id].map(sanitizePresetTag).filter(Boolean),
        notes: notesDraft || current.notes,
        lastUsed: Date.now(),
      }), presetMetadataPath(savedPreset));
      if (tagsDraft.length) setPresetTagsDraft("");
      if (notesDraft) setPresetNotesDraft("");
      setPresetStatus(`Saved ${name}`);
    } catch (error) {
      console.warn("[NAMRackPanel] Could not save user preset", error);
      setPresetStatus("Preset could not be saved");
    } finally {
      setPresetManagerBusy(false);
    }
  };

  const currentRackToneSlot = (): NAMToneSlot => {
    if (activeNAMPreview?.slot) return activeNAMPreview.slot;
    if (focusedModule === "pedal" || focusedModule === "amp" || focusedModule === "cab") return focusedModule;
    if (hasAmpModel) return "amp";
    if (hasPedalModel) return "pedal";
    if (hasCabIR) return "cab";
    return "amp";
  };

  const identityForToneSlot = (toneSlot: NAMToneSlot) => (
    toneSlot === "pedal" ? pedalIdentity :
    toneSlot === "cab" ? cabIdentity :
    ampIdentity
  );

  const openSaveToneModal = () => {
    const toneSlot = currentRackToneSlot();
    const toneIdentity = identityForToneSlot(toneSlot);
    const title = activeUserPresetName || activeNAMPreview?.title || toneIdentity.title || ampName || pedalName || cabName || `${displayPresetName} preset`;
    const tags = [
      toneSlot,
      focusedModule,
      preset.id,
      hasPedalModel ? "pedal" : "",
      hasAmpModel ? "amp" : "",
      hasCabIR ? "cab" : "",
    ].filter(Boolean);
    setSaveToneDraft(buildNAMToneSaveDraft({
      schema,
      activePreview: activeNAMPreview,
      title,
      creator: activeNAMPreview?.creator || toneIdentity.creator || "OpenStudio",
      sourceUrl: activeNAMPreview?.sourceUrl || toneIdentity.sourceUrl,
      license: activeNAMPreview?.license || toneIdentity.license,
      tags,
    }));
    setSaveToneOpen(true);
  };

  const saveRackTone = async () => {
    const metadata = saveDraftToMetadata(saveToneDraft);
    if (!metadata.toneName.trim()) {
      setPresetStatus("Name the Preset first");
      return;
    }

    setSaveToneBusy(true);
    setPresetStatus("Saving Preset");
    try {
      const toneSlot = currentRackToneSlot();
      const toneIdentity = identityForToneSlot(toneSlot);
      const result = await saveNAMTone({
        address,
        schema,
        metadata,
        activePreview: activeNAMPreview,
        selectedRecord: activeNAMPreview?.record ?? null,
        slotHint: toneSlot,
        sourceIds: {
          toneId: activeNAMPreview?.toneId || toneIdentity.toneId,
          modelId: activeNAMPreview?.modelId || toneIdentity.modelId,
        },
        modelNameFallback: toneIdentity.modelName || ampName || pedalName || cabName || metadata.toneName,
        creatorFallback: activeNAMPreview?.creator || toneIdentity.creator || "OpenStudio",
      });

      if (!result.success) {
        setPresetStatus(result.error || "Preset could not be saved");
        return;
      }

      await refreshUserPresets();
      const savedState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
      const savedBaseline = normalizeCompareSnapshot({
        values: savedState?.values,
        modelState: savedState?.modelState,
        postFxOrder: postFxOrderFromPluginState(savedState),
        presetId,
        focusedModule,
        capturedAt: Date.now(),
      });
      await updatePresetDirtyMarker(false, {
        name: metadata.toneName.trim(),
        baseline: savedBaseline ?? currentSnapshot,
      });
      setSaveToneOpen(false);
      setPresetStatus(result.committed ? "Preset saved; previewed resource kept" : "Preset saved with the complete rack");
      onRefreshRack();
    } catch (error) {
      console.warn("[NAMRackPanel] Could not save NAM Preset", error);
      setPresetStatus("Preset could not be saved");
    } finally {
      setSaveToneBusy(false);
    }
  };

  const loadUserPreset = async (name: string) => {
    const presetName = sanitizePresetName(name);
    if (!presetName) return;
    if (blockResourceChangeWhilePreviewing(`Load ${presetName}`)) return;

    setPresetManagerBusy(true);
    setPresetStatus(`Loading ${presetName}`);
    try {
      const ok = await nativeBridge.loadBuiltInFXPreset(
        address.trackId ?? "",
        address.fxIndex ?? 0,
        address.chain === "input",
        presetName,
        address.chain,
      );
      if (!ok) {
        setPresetStatus("Preset could not be loaded");
        return;
      }
      const loadedState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
      const loadedBaseline = normalizeCompareSnapshot({
        values: loadedState?.values,
        modelState: loadedState?.modelState,
        postFxOrder: postFxOrderFromPluginState(loadedState),
        presetId,
        focusedModule,
        capturedAt: Date.now(),
      });
      await updatePresetDirtyMarker(false, {
        name: presetName,
        baseline: loadedBaseline ?? currentSnapshot,
      });
      updatePresetMetadata(presetName, { lastUsed: Date.now() });
      setPresetStatus(`Loaded ${presetName}`);
      onRefreshRack();
    } catch (error) {
      console.warn("[NAMRackPanel] Could not load user preset", error);
      setPresetStatus("Preset could not be loaded");
    } finally {
      setPresetManagerBusy(false);
    }
  };

  const applyHeaderPresetTarget = async (target: NAMHeaderPresetTarget | undefined) => {
    if (!target) return;
    if (target.kind === "user") {
      await loadUserPreset(target.name);
      return;
    }
    const targetPreset = NAM_RACK_PRESETS.find((entry) => entry.id === target.id);
    if (targetPreset) await applyPreset(targetPreset);
  };

  const headerPresetTargetLabel = (
    direction: "Previous" | "Next",
    target: NAMHeaderPresetTarget | undefined,
  ) => target
    ? `${direction} ${target.kind === "user" ? "user preset" : "template"}: ${target.name}`
    : `${direction} preset unavailable`;

  const deleteUserPreset = async (name: string) => {
    const presetName = sanitizePresetName(name);
    if (!presetName) return;
    const presetEntry = userPresets.find((entry) => entry.name === presetName);
    const metadataPath = presetMetadataPath(presetEntry);
    const confirmed = await requestPresetPrompt({
      kind: "confirm",
      title: "Delete preset?",
      message: `“${presetName}” will be removed from your NAM Rack preset library.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (confirmed === null) return;

    setPresetManagerBusy(true);
    setPresetStatus(`Deleting ${presetName}`);
    try {
      const ok = await nativeBridge.deleteBuiltInFXPreset(NAM_RACK_PLUGIN_NAME, presetName);
      if (!ok) {
        setPresetStatus("Preset could not be deleted");
        return;
      }
      if (activeUserPresetName === presetName) await updatePresetDirtyMarker(false, { clear: true });
      setPresetMetadata((current) => {
        const next = { ...current };
        delete next[presetName];
        savePresetMetadata(next);
        return next;
      });
      if (metadataPath) {
        void nativeBridge.deleteFiles([metadataPath]).catch((error) => {
          console.warn("[NAMRackPanel] Could not delete preset metadata sidecar", error);
        });
      }
      setPresetStatus(`Deleted ${presetName}`);
      await refreshUserPresets();
    } catch (error) {
      console.warn("[NAMRackPanel] Could not delete user preset", error);
      setPresetStatus("Preset could not be deleted");
    } finally {
      setPresetManagerBusy(false);
    }
  };

  const duplicateUserPreset = async (name: string) => {
    const presetName = sanitizePresetName(name);
    if (!presetName) return;
    const sourceEntry = userPresets.find((entry) => entry.name === presetName);
    const nextName = sanitizePresetName(await requestPresetPrompt({
      kind: "input",
      title: "Duplicate preset",
      message: "Choose a name for the new independent copy.",
      value: `${presetName} Copy`,
      confirmLabel: "Duplicate",
    }) ?? "");
    if (!nextName || nextName === presetName) return;
    if (userPresets.some((entry) => entry.name.localeCompare(nextName, undefined, { sensitivity: "base" }) === 0)) {
      setPresetStatus(`A preset named ${nextName} already exists. Choose a unique name.`);
      return;
    }

    setPresetManagerBusy(true);
    setPresetStatus(`Duplicating ${presetName}`);
    try {
      const result = await mutateStoredNAMPreset(
        nativeBridge,
        NAM_RACK_PLUGIN_NAME,
        presetName,
        nextName,
        "duplicate",
      );
      if (!result.success) {
        setPresetStatus("Preset could not be duplicated");
        return;
      }
      const refreshed = await refreshUserPresets();
      const targetEntry = refreshed.find((entry) => entry.name === nextName);
      movePresetMetadata(presetName, nextName, true, presetMetadataPath(targetEntry), presetMetadataPath(sourceEntry));
      updatePresetMetadata(nextName, { lastUsed: Date.now() }, presetMetadataPath(targetEntry));
      setPresetStatus(`Duplicated ${nextName}`);
    } catch (error) {
      console.warn("[NAMRackPanel] Could not duplicate user preset", error);
      setPresetStatus("Preset could not be duplicated");
    } finally {
      setPresetManagerBusy(false);
    }
  };

  const renameUserPreset = async (name: string) => {
    const presetName = sanitizePresetName(name);
    if (!presetName) return;
    const sourceEntry = userPresets.find((entry) => entry.name === presetName);
    const nextName = sanitizePresetName(await requestPresetPrompt({
      kind: "input",
      title: "Rename preset",
      message: "Enter the new preset name.",
      value: presetName,
      confirmLabel: "Rename",
    }) ?? "");
    if (!nextName || nextName === presetName) return;
    if (userPresets.some((entry) => entry.name.localeCompare(nextName, undefined, { sensitivity: "base" }) === 0)) {
      setPresetStatus(`A preset named ${nextName} already exists. Choose a unique name.`);
      return;
    }

    setPresetManagerBusy(true);
    setPresetStatus(`Renaming ${presetName}`);
    try {
      const result = await mutateStoredNAMPreset(
        nativeBridge,
        NAM_RACK_PLUGIN_NAME,
        presetName,
        nextName,
        "rename",
      );
      if (!result.success && result.failure === "copy-failed") {
        setPresetStatus("Preset could not be renamed");
        return;
      }
      const refreshed = await refreshUserPresets();
      const targetEntry = refreshed.find((entry) => entry.name === nextName);
      if (!result.success) {
        movePresetMetadata(presetName, nextName, true, presetMetadataPath(targetEntry), presetMetadataPath(sourceEntry));
        setPresetStatus(`Saved ${nextName}, but ${presetName} could not be deleted. Both presets remain.`);
        return;
      }
      movePresetMetadata(presetName, nextName, false, presetMetadataPath(targetEntry), presetMetadataPath(sourceEntry));
      updatePresetMetadata(nextName, { lastUsed: Date.now() }, presetMetadataPath(targetEntry));
      if (activeUserPresetName === presetName) {
        const identityUpdated = await updatePresetDirtyMarker(isPresetDirty, {
          name: nextName,
          baseline: activeUserPresetBaseline ?? currentSnapshot,
        });
        if (!identityUpdated) {
          setPresetStatus(`Renamed ${nextName}, but the active Preset label could not be updated`);
          return;
        }
      }
      setPresetStatus(`Renamed ${nextName}`);
    } catch (error) {
      console.warn("[NAMRackPanel] Could not rename user preset", error);
      setPresetStatus("Preset could not be renamed");
    } finally {
      setPresetManagerBusy(false);
    }
  };

  const togglePresetFavorite = (name: string) => {
    updatePresetMetadata(name, (current) => ({ ...current, favorite: !current.favorite }));
  };

  const editPresetFolder = async (name: string) => {
    const presetName = sanitizePresetName(name);
    if (!presetName) return;
    const current = presetMetadata[presetName]?.folder || "";
    const result = await requestPresetPrompt({
      kind: "input",
      title: "Preset collection",
      message: `Organize “${presetName}” in a collection. Leave blank for Unfiled.`,
      value: current || "Studio",
      placeholder: "Studio",
      confirmLabel: "Save collection",
    });
    if (result === null) return;
    const folder = sanitizePresetFolder(result);
    updatePresetMetadata(presetName, { folder });
  };

  const editPresetTags = async (name: string) => {
    const presetName = sanitizePresetName(name);
    if (!presetName) return;
    const current = (presetMetadata[presetName]?.tags ?? []).join(", ");
    const result = await requestPresetPrompt({
      kind: "input",
      title: "Preset tags",
      message: `Add comma-separated tags to “${presetName}”.`,
      value: current,
      placeholder: "clean, ambient, A2",
      confirmLabel: "Save tags",
    });
    if (result === null) return;
    const tags = parsePresetTags(result);
    updatePresetMetadata(presetName, { tags });
  };

  const editPresetNotes = async (name: string) => {
    const presetName = sanitizePresetName(name);
    if (!presetName) return;
    const current = presetMetadata[presetName]?.notes || "";
    const result = await requestPresetPrompt({
      kind: "input",
      title: "Preset notes",
      message: `Keep a short note with “${presetName}”.`,
      value: current,
      placeholder: "Pickup, tuning, or performance notes",
      confirmLabel: "Save notes",
      multiline: true,
    });
    if (result === null) return;
    const notes = sanitizePresetNotes(result);
    updatePresetMetadata(presetName, { notes });
  };

  const writePresetBundle = async (presetName: string, state: unknown, metadata: UserRackPresetMetadata) => {
    const safeName = sanitizePresetName(presetName) || "OpenStudio NAM Rack";
    const targetPath = await nativeBridge.showSaveDialog(
      `${presetFileStem(safeName)}${NAM_RACK_PRESET_BUNDLE_EXT}`,
      "Export NAM Rack Preset",
      `*${NAM_RACK_PRESET_BUNDLE_EXT};*.json`,
    );
    if (!targetPath) return { success: false, canceled: true, exportedAt: 0 };

    const exportedAt = Date.now();
    const appVersion = await nativeBridge.getAppVersion().catch(() => "");
    const payload: NAMRackPresetExportBundle = {
      schemaVersion: 1,
      kind: NAM_RACK_PRESET_BUNDLE_KIND,
      app: "OpenStudio",
      appVersion,
      pluginName: NAM_RACK_PLUGIN_NAME,
      presetName: safeName,
      exportedAt: new Date(exportedAt).toISOString(),
      metadata: {
        ...fallbackPresetMetadata(safeName, metadata),
        exportedAt,
      },
      state,
    };

    const success = await nativeBridge.saveProjectToFile(targetPath, JSON.stringify(payload, omitNAMNonPortableState, 2));
    return { success, canceled: false, exportedAt };
  };

  const exportCurrentPreset = async () => {
    const defaultName = sanitizePresetName(presetNameDraft || `${displayPresetName}${isPresetDirty ? " Edited" : ""}`);
    const exportName = sanitizePresetName(await requestPresetPrompt({
      kind: "input",
      title: "Export current rack",
      message: "Name this NAM Rack preset file. It stores rack settings and references your local NAM and IR files.",
      value: defaultName,
      confirmLabel: "Choose location",
    }) ?? "");
    if (!exportName) return;

    setPresetManagerBusy(true);
    setPresetStatus(`Exporting ${exportName}`);
    try {
      const state = await nativeBridge.getBuiltInPluginState(address);
      const result = await writePresetBundle(exportName, state, {
        folder: "Studio",
        tags: [focusedModule, preset.id].map(sanitizePresetTag).filter(Boolean),
      });
      if (result.canceled) {
        setPresetStatus("Export canceled");
        return;
      }
      if (!result.success) {
        setPresetStatus("Preset could not be exported");
        return;
      }
      setPresetStatus(`Exported ${exportName}`);
    } catch (error) {
      console.warn("[NAMRackPanel] Could not export current preset", error);
      setPresetStatus("Preset could not be exported");
    } finally {
      setPresetManagerBusy(false);
    }
  };

  const exportUserPreset = async (name: string) => {
    const presetName = sanitizePresetName(name);
    if (!presetName) return;

    setPresetManagerBusy(true);
    setPresetStatus(`Preparing ${presetName}`);
    try {
      const dataBase64 = await nativeBridge.getBuiltInFXPresetData(
        NAM_RACK_PLUGIN_NAME,
        presetName,
      );
      if (!dataBase64) {
        setPresetStatus("Preset could not be exported");
        return;
      }

      const result = await writePresetBundle(
        presetName,
        {
          format: "openstudio.ospreset.base64",
          dataBase64,
        } satisfies NAMStoredPresetPayload,
        presetMetadata[presetName],
      );
      if (result.canceled) {
        setPresetStatus("Export canceled");
        return;
      }
      if (!result.success) {
        setPresetStatus("Preset could not be exported");
        return;
      }
      updatePresetMetadata(presetName, { exportedAt: result.exportedAt });
      setPresetStatus(`Exported ${presetName}`);
    } catch (error) {
      console.warn("[NAMRackPanel] Could not export user preset", error);
      setPresetStatus("Preset could not be exported");
    } finally {
      setPresetManagerBusy(false);
    }
  };

  const importUserPreset = async () => {
    if (blockResourceChangeWhilePreviewing("Import Preset")) return;
    let rollbackFailedImport: ((message: string, removeImportedPreset?: boolean) => Promise<void>) | null = null;
    setPresetManagerBusy(true);
    setPresetStatus("Importing preset");
    try {
      const path = await nativeBridge.showOpenDialog("Import NAM Rack Preset", `*${NAM_RACK_PRESET_BUNDLE_EXT};*.json`);
      if (!path) {
        setPresetStatus("Import canceled");
        return;
      }

      const json = await nativeBridge.loadProjectFromFile(path);
      if (!json.trim()) {
        setPresetStatus("Preset file is empty");
        return;
      }

      const bundle = normalizePresetBundle(JSON.parse(json, omitNAMNonPortableState));
      if (!bundle) {
        setPresetStatus("Preset file is not a NAM Rack bundle");
        return;
      }

      const nextName = sanitizePresetName(await requestPresetPrompt({
        kind: "input",
        title: "Import preset",
        message: "Choose the name that will appear in your preset library.",
        value: bundle.presetName,
        confirmLabel: "Import",
      }) ?? "");
      if (!nextName) {
        setPresetStatus("Import canceled");
        return;
      }
      if (userPresets.some((entry) => entry.name.localeCompare(nextName, undefined, { sensitivity: "base" }) === 0)) {
        setPresetStatus(`A preset named ${nextName} already exists. Choose a unique name.`);
        return;
      }

      const rackStateBeforeImport = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
      const rollbackPatch = buildNAMRackRollbackPatch(rackStateBeforeImport);
      const rollbackImport = async (message: string, removeImportedPreset = false) => {
        if (removeImportedPreset) {
          await nativeBridge.deleteBuiltInFXPreset(NAM_RACK_PLUGIN_NAME, nextName).catch(() => false);
        }
        const restored = rollbackPatch
          ? await nativeBridge.setBuiltInPluginState(address, rollbackPatch).catch(() => false)
          : false;
        setPresetStatus(restored
          ? `${message} The previous rack was restored.`
          : `${message} The previous rack could not be restored; reload the last Preset before continuing.`);
        if (restored) onRefreshRack();
      };
      rollbackFailedImport = rollbackImport;
      if (!rollbackPatch) {
        setPresetStatus("The current rack could not be captured, so Import was canceled without making changes.");
        return;
      }

      if (isNAMStoredPresetPayload(bundle.state)) {
        const saved = await nativeBridge.saveBuiltInFXPresetData(
          NAM_RACK_PLUGIN_NAME,
          nextName,
          bundle.state.dataBase64,
        );
        if (!saved) {
          setPresetStatus("Preset data could not be imported");
          return;
        }
        const applied = await nativeBridge.loadBuiltInFXPreset(
          address.trackId ?? "",
          address.fxIndex ?? 0,
          address.chain === "input",
          nextName,
          address.chain,
        );
        if (!applied) {
          await rollbackImport("Preset data was valid, but it could not be applied to this rack.", true);
          return;
        }
      } else {
        const applied = await nativeBridge.setBuiltInPluginState(address, bundle.state);
        if (!applied) {
          await rollbackImport("Preset could not be applied.");
          return;
        }

        const saved = await nativeBridge.saveBuiltInFXPreset(
          address.trackId ?? "",
          address.fxIndex ?? 0,
          address.chain === "input",
          nextName,
          address.chain,
        );
        if (!saved) {
          await rollbackImport("Preset could not be saved.", true);
          return;
        }
      }

      const refreshed = await refreshUserPresets();
      const importedEntry = refreshed.find((entry) => entry.name === nextName);
      if (!importedEntry) {
        await rollbackImport("The imported Preset could not be verified in the library.", true);
        return;
      }
      const importedState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
      const importedBaseline = normalizeCompareSnapshot({
        values: importedState?.values,
        modelState: importedState?.modelState,
        postFxOrder: postFxOrderFromPluginState(importedState),
        presetId,
        focusedModule,
        capturedAt: Date.now(),
      });
      const identityUpdated = await updatePresetDirtyMarker(false, {
        name: nextName,
        baseline: importedBaseline ?? currentSnapshot,
      });
      if (!identityUpdated) {
        await rollbackImport("The imported Preset identity could not be persisted.", true);
        return;
      }
      updatePresetMetadata(nextName, {
        ...fallbackPresetMetadata(nextName, bundle.metadata),
        importedAt: Date.now(),
        lastUsed: Date.now(),
        sourcePath: path,
      }, presetMetadataPath(importedEntry));
      setPresetNameDraft("");
      setPresetStatus(`Imported ${nextName}`);
      onRefreshRack();
    } catch (error) {
      console.warn("[NAMRackPanel] Could not import user preset", error);
      if (rollbackFailedImport) {
        await rollbackFailedImport("Preset could not be imported.", true);
      } else {
        setPresetStatus("Preset could not be imported");
      }
    } finally {
      setPresetManagerBusy(false);
    }
  };

  const rememberIRPath = (path: string, patch: Partial<IRLibraryEntry> = {}) => {
    const cleanPath = path.trim();
    if (!cleanPath) return;
    setIRLibrary((current) => {
      const existing = current.find((entry) => entry.path === cleanPath);
      const nextEntry: IRLibraryEntry = {
        path: cleanPath,
        favorite: patch.favorite ?? existing?.favorite,
        lastUsed: patch.lastUsed ?? Date.now(),
      };
      const next = normalizeIRLibrary([nextEntry, ...current.filter((entry) => entry.path !== cleanPath)]);
      saveIRLibrary(next);
      return next;
    });
  };

  useEffect(() => {
    if (!currentCabIRPath || !hasCabIR) return;
    rememberIRPath(currentCabIRPath);
  }, [currentCabIRPath, hasCabIR]);

  const applyCabIRPath = async (path: string) => {
    const cleanPath = path.trim();
    if (!cleanPath) return;
    if (blockResourceChangeWhilePreviewing("Load Cab/IR")) return;
    if (embeddedCabCapture) {
      setSlotActionStatus("This amp capture already includes a cabinet. Revert or load an amp-only capture before selecting an external Cab/IR.");
      return;
    }
    setCabBusy(true);
    try {
      const ok = await nativeBridge.setBuiltInPluginState(address, {
        modelState: { cabIRPath: cleanPath },
        values: { cabEnabled: 1 },
      });
      if (ok) {
        rememberIRPath(cleanPath);
        onRefreshRack();
      }
    } finally {
      setCabBusy(false);
    }
  };

  const loadCabIR = async () => {
    if (!cabPresentation.canLoadLocalIR) {
      setActiveRackSection("cab");
      setFocusedModule("cab");
      setSlotActionStatus("This full-rig Capture already includes its cabinet. Load an amp-only Capture before choosing an external IR.");
      return;
    }
    const path = await nativeBridge.browseForFile("Select cabinet impulse response", "*.wav;*.aiff;*.aif;*.flac");
    if (!path) return;
    await applyCabIRPath(path);
  };

  const openRackToneRail = (intent: Omit<NAMExplorerIntent, "token"> = {}) => {
    setLibraryFlow(null);
    setExplorerIntent({ token: Date.now(), ...intent });
    setRackRailTab("tones");
    setActiveView("rack");
  };

  const returnFromLibraryFlow = () => {
    setLibraryFlow(null);
    setActiveView("rack");
    setRackRailTab("gear");
  };

  const openSourceFlow = (flow: NAMLibraryFlowMode, sourceFilter?: OpenStudioFXModuleId, categoryFilter?: string) => {
    const moduleId = flow === "fx" && sourceFilter ? sourceFilter : rackModuleForNAMLibraryFlow(flow);
    const categoryGearFilter = categoryFilter
      ? getNAMSourceFlowConfig(flow).filterControls.find((control) => control.category === categoryFilter)?.gearFilter
      : undefined;
    setChainOpen(false);
    setFocusedModule(moduleId);
    setActiveRackSection(moduleId === "eq" ? "eq" : rackSectionForNAMLibraryFlow(flow));
    setExplorerIntent({
      token: Date.now(),
      ...explorerIntentForNAMLibraryFlow(flow, sourceFilter),
      ...(categoryFilter ? { categoryFilter } : {}),
      ...(categoryGearFilter !== undefined ? { gearFilter: categoryGearFilter } : {}),
    });
    setRackRailTab("tones");
    setLibraryFlow(flow);
    setActiveView("rack");
  };

  const openNAMCaptureLibrary = (moduleId: "amp") => {
    openSourceFlow(moduleId);
  };

  const openLocalNAMCaptureLibrary = (moduleId: "amp") => {
    openSourceFlow(moduleId, undefined, "local");
  };

  const openAmpOnlyCaptureLibrary = () => {
    openSourceFlow("amp", undefined, "amp");
  };

  const openCabIRLibrary = () => {
    if (!cabPresentation.canBrowseExternalIR) {
      setChainOpen(false);
      setLibraryFlow(null);
      setActiveView("rack");
      setActiveRackSection("cab");
      setFocusedModule("cab");
      setSlotActionStatus("Cab included in this full-rig Capture. Browse amp-only Captures to use an external IR.");
      return;
    }
    openSourceFlow("ir");
  };

  const openPostFXCollection = (moduleId: OpenStudioFXModuleId = "delay") => {
    openSourceFlow("fx", moduleId);
  };

  const openRackCabToneSearch = () => {
    openRackToneRail({
      tab: "latest",
      query: "ir",
      architecture: "all",
      gearFilter: "ir",
    });
  };

  const clearCabIR = async () => {
    if (blockResourceChangeWhilePreviewing("Remove Cab/IR")) return;
    setCabBusy(true);
    try {
      const ok = await nativeBridge.setBuiltInPluginState(address, {
        modelState: { clearCabIR: true },
        values: { cabEnabled: 0 },
      });
      if (ok) onRefreshRack();
    } finally {
      setCabBusy(false);
    }
  };

  const locateMissingRackAsset = async (asset: NAMRackMissingAsset) => {
    if (blockResourceChangeWhilePreviewing(`Relink ${asset.slotLabel}`)) return;
    if (recoveryBusyRef.current) return;
    recoveryBusyRef.current = true;
    setRecoveryBusySlot(asset.slot);
    setSlotActionStatus(`Locating ${asset.slotLabel}…`);
    setRecoveryActionStatus({ slot: asset.slot, message: `Choose the replacement file for ${asset.slotLabel}.` });
    try {
      const path = await nativeBridge.browseForFile(
        asset.slot === "cab" ? "Locate missing cabinet impulse response" : `Locate missing ${asset.slotLabel}`,
        asset.slot === "cab" ? "*.wav;*.aiff;*.aif;*.flac" : "*.nam",
      );
      const cleanPath = path.trim();
      if (!cleanPath) {
        setRecoveryActionStatus(null);
        setSlotActionStatus("");
        return;
      }
      const recoveredModelState = asset.slot === "amp"
        ? { ampModelPath: cleanPath }
        : { cabIRPath: cleanPath };
      const ok = await nativeBridge.setBuiltInPluginState(address, { modelState: recoveredModelState });
      if (!ok) {
        const message = `${asset.slotLabel} could not be relinked. The unavailable slot remains safely isolated.`;
        setRecoveryActionStatus({ slot: asset.slot, message });
        setSlotActionStatus(message);
        return;
      }
      const dirtyMarked = await updatePresetDirtyMarker(true).catch(() => false);
      const message = dirtyMarked
        ? `${asset.slotLabel} relinked to ${fileName(cleanPath) || cleanPath}.`
        : `${asset.slotLabel} relinked, but the Preset edited marker could not be saved.`;
      setRecoveryActionStatus({ slot: asset.slot, message });
      setSlotActionStatus(message);
      onRefreshRack();
    } catch (error) {
      console.warn("[NAMRackPanel] Missing asset relink failed", error);
      const message = `${asset.slotLabel} relink could not be confirmed. The unavailable slot remains safely isolated.`;
      setRecoveryActionStatus({ slot: asset.slot, message });
      setSlotActionStatus(message);
    } finally {
      recoveryBusyRef.current = false;
      setRecoveryBusySlot(null);
    }
  };

  const bypassMissingRackAsset = async (asset: NAMRackMissingAsset) => {
    if (asset.bypassed || recoveryBusyRef.current) return;
    recoveryBusyRef.current = true;
    setRecoveryBusySlot(asset.slot);
    setRecoveryActionStatus({ slot: asset.slot, message: `Bypassing the unavailable ${asset.slotLabel} stage…` });
    try {
      const ok = await nativeBridge.setBuiltInPluginParam(address, asset.bypassParamId, 0);
      if (!ok) {
        const message = `${asset.slotLabel} bypass could not be confirmed.`;
        setRecoveryActionStatus({ slot: asset.slot, message });
        setSlotActionStatus(message);
        return;
      }
      const dirtyMarked = await updatePresetDirtyMarker(true).catch(() => false);
      const message = dirtyMarked
        ? `${asset.slotLabel} is bypassed. Locate the original file or choose a replacement when ready.`
        : `${asset.slotLabel} is bypassed, but the Preset edited marker could not be saved.`;
      setRecoveryActionStatus({ slot: asset.slot, message });
      setSlotActionStatus(message);
      onRefreshRack();
    } catch (error) {
      console.warn("[NAMRackPanel] Missing asset bypass failed", error);
      const message = `${asset.slotLabel} bypass could not be confirmed.`;
      setRecoveryActionStatus({ slot: asset.slot, message });
      setSlotActionStatus(message);
    } finally {
      recoveryBusyRef.current = false;
      setRecoveryBusySlot(null);
    }
  };

  const replaceMissingRackAsset = (asset: NAMRackMissingAsset) => {
    if (recoveryBusyRef.current) return;
    setRecoveryActionStatus(null);
    setSlotActionStatus("");
    if (asset.slot === "cab") {
      if (embeddedCabCapture) openAmpOnlyCaptureLibrary();
      else openCabIRLibrary();
      return;
    }
    openNAMCaptureLibrary(asset.slot);
  };

  const toggleIRFavorite = (path: string) => {
    const cleanPath = path.trim();
    if (!cleanPath) return;
    setIRLibrary((current) => {
      const existing = current.find((entry) => entry.path === cleanPath);
      const nextEntry: IRLibraryEntry = {
        path: cleanPath,
        favorite: !existing?.favorite,
        lastUsed: existing?.lastUsed ?? Date.now(),
      };
      const next = normalizeIRLibrary([nextEntry, ...current.filter((entry) => entry.path !== cleanPath)]);
      saveIRLibrary(next);
      return next;
    });
  };

  const removeIRFromLibrary = (path: string) => {
    const cleanPath = path.trim();
    if (!cleanPath) return;
    setIRLibrary((current) => {
      const next = current.filter((entry) => entry.path !== cleanPath);
      saveIRLibrary(next);
      return next;
    });
  };

  const eqPowerActive = (eqEnabledParam?.value ?? 0) >= 0.5;
  const eqShaped = eqParamIds.some((id) => Math.abs(paramById(params, id)?.value ?? 0) > 0.01);
  const eqActive = eqPowerActive && eqShaped;
  const modulatorPowerActive = (modulatorEnabledParam?.value ?? 0) >= 0.5;
  const chorusActive = modulatorPowerActive && (chorusMixParam?.value ?? 0) > 0.0001;
  const delayPowerActive = (delayEnabledParam?.value ?? 0) >= 0.5;
  const reverbPowerActive = (reverbEnabledParam?.value ?? 0) >= 0.5;
  const delayActive = delayPowerActive && (delayMixParam?.value ?? 0) > 0.0001;
  const reverbActive = reverbPowerActive && (reverbMixParam?.value ?? 0) > 0.0001;
  const postFxDevices = useMemo(
    () => {
      const stageParams = (ids: string[]) => ids
        .map((id) => paramById(params, id))
        .filter((param): param is BuiltInParamDescriptor => Boolean(param))
        .map(projectNAMRackParamForUI);
      return [
        {
          moduleId: "mod" as const,
          title: "MODULATOR",
          subtitle: "CHORUS / FLANGER",
          display: !modulatorPowerActive
            ? "BYPASS"
            : `${(modulatorModeParam?.value ?? 0) >= 0.5 ? "FLANGER" : `${(chorusRateParam?.value ?? 0).toFixed(2)} Hz`} / ${(modulatorPedalModeParam?.value ?? 1) >= 0.5 ? "AUTO" : `${Math.round((modulatorPedalPositionParam?.value ?? 0.5) * 100)}%`}`,
          active: modulatorPowerActive,
          accent: "#c58a73",
          params: stageParams(["modulatorEnabled", "chorusRateHz", "chorusDepth", "chorusMix", "chorusCharacter", "modulatorMode", "modulatorFeedback", "modulatorAutoRandom", "modulatorAutoSpeed", "modulatorPedalMode", "modulatorPedalPosition"]),
        },
        {
          moduleId: "delay" as const,
          title: "STEREO DELAY",
          subtitle: "SYNC / MODE",
          display: !delayPowerActive
            ? "BYPASS"
            : (delayTempoSyncParam?.value ?? 0) >= 0.5
              ? `${delaySyncDisplay(delayModParam?.value ?? 0, (delayPingPongParam?.value ?? 0) >= 0.5)} · ${Number.isFinite(runtimeTempo) ? runtimeTempo.toFixed(1) : "--"} BPM`
              : `${Math.round(delayTimeParam?.value ?? 0)} ms`,
          active: delayPowerActive,
          accent: "#ef4d52",
          params: stageParams(["delayEnabled", "delayMix", "delayTimeMs", "delayFeedback", "delayMod", "delayDucker", "delayMode", "delayPingPong", "delayTempoSync"]),
        },
        {
          moduleId: "reverb" as const,
          title: "REVERB",
          subtitle: "DECAY / TONE",
          display: !reverbPowerActive
            ? "BYPASS"
            : `${(reverbDecayParam?.value ?? 0).toFixed(1)} s / ${Math.round(reverbPreDelayParam?.value ?? 0)} ms`,
          active: reverbPowerActive,
          accent: "#74b7ff",
          params: stageParams(["reverbEnabled", "reverbDecaySec", "reverbPreDelayMs", "reverbLowCutHz", "reverbTone", "reverbShimmer", "reverbMix"]),
        },
      ];
    },
    [chorusActive, chorusRateParam, delayFeedbackParam, delayModParam, delayPingPongParam, delayPowerActive, delayTempoSyncParam, delayTimeParam, modulatorModeParam, modulatorPedalModeParam, modulatorPedalPositionParam, modulatorPowerActive, params, reverbDecayParam, reverbPowerActive, reverbPreDelayParam, runtimeTempo],
  );
  const neuralSectionDevices = useMemo<NAMNeuralStageDevice[]>(() => {
    const stageParams = (ids: string[], labels: Record<string, string> = {}) => ids
      .map((id) => {
        const param = paramById(params, id);
        return param ? projectNAMRackParamForUI({ ...param, label: labels[id] ?? param.label }) : undefined;
      })
      .filter((param): param is BuiltInParamDescriptor => Boolean(param));

    return deviceSkinsForSection(activeRackSection).map((skin) => {
      if (skin.section === "pre" && skin.id === "pre-compressor-design-a") {
        return {
          skin,
          title: "GATE DRIVE",
          subtitle: "PRE-FX GATE DRIVE",
          display: compressorActive ? (compressorCompParam ? formatParamValue(compressorCompParam) : "COMP") : "BYPASS",
          active: compressorActive,
          accent: "#e1e4e9",
          params: stageParams(["compressorDetail", "compressorMix", "compressorVolumeDb", "compressorComp", "compressorEnabled"], {
            compressorDetail: "Detail",
            compressorMix: "Mix",
            compressorVolumeDb: "Volume",
            compressorComp: "Comp",
            compressorEnabled: "Engage",
          }),
          onPowerToggle: () => compressorEnabledParam && onParamChange(compressorEnabledParam, compressorActive ? 0 : 1),
        };
      }

      if (skin.section === "pre" && skin.id === "pre-tape-echo-design-a") {
        return {
          skin,
          title: "BOOSTER",
          subtitle: "PRE-FX BOOST",
          display: tapeEchoActive ? (tapeEchoTimeParam ? formatParamValue(tapeEchoTimeParam) : "TAPE") : "BYPASS",
          active: tapeEchoActive,
          accent: "#9aaa88",
          params: stageParams(["tapeEchoMix", "tapeEchoFeedback", "tapeEchoTimeMs", "tapeEchoMod", "tapeEchoTone", "tapeEchoEnabled"], {
            tapeEchoMix: "Level",
            tapeEchoFeedback: "Boost",
            tapeEchoTimeMs: "Range",
            tapeEchoMod: "Feel",
            tapeEchoTone: "Tone",
            tapeEchoEnabled: "Engage",
          }),
          onPowerToggle: () => tapeEchoEnabledParam && onParamChange(tapeEchoEnabledParam, tapeEchoActive ? 0 : 1),
        };
      }

      if (skin.section === "pre" && skin.id === "pre-dual-octaver-design-a") {
        return {
          skin,
          title: "TONE SHAPER",
          subtitle: "PRE-FX TONE",
          display: octaverActive ? `${Math.round((octaverDownParam?.value ?? 0) * 100)} / ${Math.round((octaverUpParam?.value ?? 0) * 100)}` : "BYPASS",
          active: octaverActive,
          accent: "#c9b89c",
          params: stageParams(["octaverDownMix", "octaverUpMix", "octaverDirectMix", "octaverEnabled"], {
            octaverDownMix: "Low",
            octaverUpMix: "High",
            octaverDirectMix: "Body",
            octaverEnabled: "Engage",
          }),
          onPowerToggle: () => octaverEnabledParam && onParamChange(octaverEnabledParam, octaverActive ? 0 : 1),
        };
      }

      if (skin.section === "pre" && skin.moduleId === "gate") {
        return {
          skin,
          moduleId: "gate",
          title: "INPUT GATE",
          subtitle: "THRESHOLD / RELEASE",
          display: gateThreshold ? formatParamValue(gateThreshold) : "OPEN",
          active: gateActive,
          accent: "#d7d9df",
          params: stageParams(["gateThresholdDb", "gateReleaseMs"], {
            gateThresholdDb: "Threshold",
            gateReleaseMs: "Release",
          }),
          onPowerToggle: () => toggleParamPower("gate", gateThreshold, gateActive, gateThreshold?.min ?? -100, -80),
        };
      }

      if (skin.section === "pre" && skin.moduleId === "pedal") {
        return {
          skin,
          moduleId: "pedal",
          title: "PRECISION DRIVE",
          subtitle: "DEDICATED TIGHT OVERDRIVE",
          display: precisionDriveActive ? "PRECISION" : "BYPASS",
          active: precisionDriveActive,
          accent: "#1b242c",
          params: stageParams(["precisionDriveVolumeDb", "precisionDriveBright", "precisionDriveAttack", "precisionDriveGate", "precisionDriveDrive", "precisionDriveEnabled"], {
            precisionDriveVolumeDb: "Vol",
            precisionDriveBright: "Bright",
            precisionDriveAttack: "Attack",
            precisionDriveGate: "Gate",
            precisionDriveDrive: "Drive",
            precisionDriveEnabled: "Engage",
          }),
          onPowerToggle: () => precisionDriveEnabledParam && onParamChange(precisionDriveEnabledParam, precisionDriveActive ? 0 : 1),
        };
      }

      if (skin.section === "pre" && skin.id === "pre-chaos-design-a") {
        return {
          skin,
          title: "DISTORTION",
          subtitle: "DEDICATED HIGH-GAIN DISTORTION",
          display: chaosActive ? "ENGAGED" : "BYPASS",
          active: chaosActive,
          accent: "#a16062",
          params: stageParams(["chaosDrive", "chaosTone", "chaosMix", "chaosLevelDb", "chaosEnabled"], {
            chaosDrive: "Drive",
            chaosTone: "Tone",
            chaosMix: "Mix",
            chaosLevelDb: "Level",
            chaosEnabled: "Engage",
          }),
          onPowerToggle: () => chaosEnabledParam && onParamChange(chaosEnabledParam, chaosActive ? 0 : 1),
        };
      }

      if (skin.section === "amp" && skin.moduleId === "amp") {
        return {
          skin,
          moduleId: "amp",
          title: "AMP CAPTURE",
          subtitle: "A2 MODEL HOST",
          display: !ampPowerActive
            ? "POWER OFF"
            : hardwareAmpLabel || ampName || `${ampGainParam ? formatParamValue(ampGainParam) : "0.0 dB"} / ${ampOutputParam ? formatParamValue(ampOutputParam) : "0.0 dB"}`,
          active: ampActive,
          accent: "#3b3e42",
          params: stageParams(["ampEnabled", "ampGainDb", "ampBoost", "ampVoice", "bassDb", "midDb", "trebleDb", "presenceDb", "ampMix", "ampOutputDb"], {
            ampEnabled: "Power",
            ampGainDb: "Capture Input",
            ampBoost: "Tight Boost",
            ampVoice: "Bright Voice",
            bassDb: "Post Bass",
            midDb: "Post Mid",
            trebleDb: "Post Treble",
            presenceDb: "Post Presence",
            ampMix: "Capture Mix",
            ampOutputDb: "Post Level",
          }),
          actionLabel: "BROWSE",
          onAction: () => openNAMCaptureLibrary("amp"),
          onPowerToggle: () => toggleParamPower("amp", ampEnabledParam, ampPowerActive, 0, 1),
        };
      }

      if (skin.section === "cab" && skin.moduleId === "cab") {
        return {
          skin,
          moduleId: "cab",
          title: "CABINET ROOM",
          subtitle: "IR / FILTER / PHASE",
          display: cabName || (cabActive ? "FILTER" : "BYPASS"),
          active: cabActive,
          accent: "#202326",
          params: stageParams(["cabMicPosition", "cabMicDistance", "cabMicBlend", "cabRoomSend", "cabLevelDb", "cabPan", "cabHPFHz", "cabLPFHz", "cabPhaseInvert", "cabEnabled"], {
            cabMicPosition: "Tone Edge",
            cabMicDistance: "Tone Damp",
            cabMicBlend: "Shaper Blend",
            cabRoomSend: "Low Bloom",
            cabLevelDb: "Level",
            cabPan: "Pan",
            cabHPFHz: "HPF",
            cabLPFHz: "LPF",
            cabPhaseInvert: "Phase",
            cabEnabled: "Power",
          }),
          actionLabel: hasCabIR ? "CLEAR IR" : "LOCAL IR",
          onAction: hasCabIR ? () => void clearCabIR() : () => void loadCabIR(),
          onPowerToggle: toggleCabPower,
        };
      }

      if (skin.section === "eq" && skin.moduleId === "eq") {
        return {
          skin,
          moduleId: "eq",
          title: "GRAPHIC EQ",
          subtitle: "GRAPHIC WRAPPER EQ",
          display: !eqPowerActive ? "OFF" : eqShaped ? "SHAPED" : "FLAT",
          active: eqPowerActive,
          accent: "#3f4141",
          params: stageParams(["eqEnabled", ...eqParamIds], {
            eqEnabled: "Power",
            eq65Db: "62 Hz",
            eq125Db: "125 Hz",
            eq250Db: "250 Hz",
            eq500Db: "500 Hz",
            eq1kDb: "1 kHz",
            eq2kDb: "2 kHz",
            eq4kDb: "4 kHz",
            eq8kDb: "8 kHz",
            eq16kDb: "16 kHz",
          }),
          onPowerToggle: () => eqEnabledParam && onParamChange(eqEnabledParam, eqPowerActive ? 0 : 1),
        };
      }

      if (skin.section === "special" && skin.moduleId === "mod") {
        const laserModeLabel = NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS.find(
          (option) => option.value === Math.round(laserModeParam?.value ?? NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[0].value),
        )?.label ?? NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[0].label;
        return {
          skin,
          moduleId: "mod",
          title: "EXPRESSION",
          subtitle: laserSpeedOverridden
            ? ((laserTriggerParam?.value ?? 0) >= 0.5 ? "LATCHED CONTROL" : "ENVELOPE CONTROL")
            : "LFO CONTROL",
          display: laserActive
            ? `${laserModeLabel.toUpperCase()} / ${laserSpeedOverridden
                ? ((laserTriggerParam?.value ?? 0) >= 0.5 ? "LATCHED" : "ENVELOPE")
                : `${(laserSpeedParam?.value ?? 0).toFixed(2)} Hz`}`
            : "BYPASS",
          active: laserActive,
          accent: "#7e789b",
          params: stageParams([
            "laserMode",
            "laserMix",
            ...(laserSpeedOverridden ? [] : ["laserSpeedHz"]),
            "laserSensitivity",
            "laserEnvelopeMode",
            "laserTrigger",
            "laserEnabled",
          ], {
            laserMode: "Mode",
            laserMix: "Intensity",
            laserSpeedHz: "LFO Speed",
            laserSensitivity: "Sensitivity",
            laserEnvelopeMode: "Envelope",
            laserTrigger: "Latch",
            laserEnabled: "Engage",
          }),
          onPowerToggle: () => laserEnabledParam && onParamChange(laserEnabledParam, laserActive ? 0 : 1),
        };
      }

      return {
        skin,
        moduleId: skin.moduleId,
        title: skin.title.toUpperCase(),
        subtitle: "NAM RACK",
        display: "READY",
        active: false,
        accent: "#707783",
        params: stageParams(skin.controls.map((anchor) => anchor.paramId ?? "").filter(Boolean)),
      };
    });
  }, [
    activeRackSection,
    ampActive,
    ampEnabledParam,
    ampGainParam,
    ampMix,
    ampName,
    ampOutputParam,
    ampPowerActive,
    cabActive,
    cabEnabledParam,
    cabName,
    chaosActive,
    chaosEnabledParam,
    chaosMixParam,
    precisionDriveActive,
    precisionDriveDriveParam,
    precisionDriveEnabledParam,
    chorusActive,
    chorusMixParam,
    chorusRateParam,
    compressorActive,
    compressorCompParam,
    compressorEnabledParam,
    eqActive,
    eqEnabledParam,
    eqPowerActive,
    eqShaped,
    gateActive,
    gateThreshold,
    hardwareAmpLabel,
    hasCabIR,
    laserActive,
    laserEnabledParam,
    laserEnvelopeModeParam,
    laserModeParam,
    laserSpeedOverridden,
    laserSpeedParam,
    laserTriggerParam,
    modulatorModeParam,
    octaverActive,
    octaverDownParam,
    octaverEnabledParam,
    octaverUpParam,
    params,
    pedalActive,
    pedalMix,
    pedalName,
    onParamChange,
    tapeEchoActive,
    tapeEchoEnabledParam,
    tapeEchoTimeParam,
  ]);

  const mixerStageSpecs = useMemo<RackMixerStripSpec[]>(() => {
    const stageParams = (ids: readonly string[], labels: Record<string, string> = {}) => ids
      .map((id) => paramById(params, id))
      .filter((param): param is BuiltInParamDescriptor => Boolean(param))
      .map((param) => projectNAMRackParamForUI(labels[param.id] ? { ...param, label: labels[param.id] } : param));
    const ampRequiredReason = "Load an Amp NAM capture to use this effect.";

    return orderNAMRackMixerStages([
      {
        id: "input",
        label: "Input",
        caption: `${selectedInputLabel} · ${inputTrim ? formatParamValue(inputTrim) : "Unity trim"}`,
        active: true,
        meterDb: inputMeterDb,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.input),
        warning: monoInputOneWarning,
      },
      {
        id: "gate",
        label: "Gate",
        caption: gateThreshold ? formatParamValue(gateThreshold) : "Gate open",
        active: gateActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.gate),
      },
      {
        id: "compressor",
        label: "Comp",
        caption: compressorActive ? (compressorCompParam ? formatParamValue(compressorCompParam) : "Active") : "Bypassed",
        active: compressorActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.compressor),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
      },
      {
        id: "tape-echo",
        label: "Tape",
        caption: tapeEchoActive ? (tapeEchoTimeParam ? formatParamValue(tapeEchoTimeParam) : "Echo") : "Bypassed",
        active: tapeEchoActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS["tape-echo"]),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
      },
      {
        id: "octaver",
        label: "Oct",
        caption: octaverActive ? `${Math.round((octaverDownParam?.value ?? 0) * 100)} / ${Math.round((octaverUpParam?.value ?? 0) * 100)}` : "Bypassed",
        active: octaverActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.octaver),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
      },
      {
        id: "precision-drive",
        label: "Precision Drive",
        caption: precisionDriveActive
          ? `${precisionDriveDriveParam ? formatParamValue(precisionDriveDriveParam) : "Drive"}`
          : "Bypassed",
        active: precisionDriveActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS["precision-drive"]),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
      },
      {
        id: "chaos",
        label: "Distortion",
        caption: chaosActive ? (chaosMixParam ? formatParamValue(chaosMixParam) : "Active") : "Bypassed",
        active: chaosActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.chaos),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
      },
      {
        id: "laser",
        label: "Laser",
        caption: laserActive
          ? `${laserModeParam?.enumOptions?.find((option) => Math.round(option.value) === Math.round(laserModeParam.value))?.label ?? "Active"}${laserSpeedOverridden ? " · external control" : ""}`
          : "Bypassed",
        active: laserActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.laser, {
          laserSpeedHz: "LFO Speed",
        }),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
        disabledParamIds: laserSpeedOverridden ? ["laserSpeedHz"] : undefined,
        disabledParamReasons: laserSpeedOverridden
          ? { laserSpeedHz: laserSpeedOverrideReason }
          : undefined,
        dependencyNote: laserSpeedOverridden
          ? laserSpeedOverrideReason
          : "LFO Speed controls motion while Envelope and Latch are off.",
      },
      {
        id: "amp",
        label: "Amp",
        caption: hasAmpModel ? ampName || "Capture loaded" : "Load an Amp capture",
        active: ampActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.amp),
        available: hasAmpModel,
        unavailableReason: "Load an Amp NAM capture to enable the faceplate controls.",
      },
      {
        id: "cab",
        label: "Cab/IR",
        caption: cabName || (cabActive ? "Filter" : "Bypassed"),
        active: cabActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.cab),
        warning: cabMissingWarning,
        available: cabPresentation.mode === "loaded",
        unavailableReason: cabControlsUnavailableReason,
      },
      {
        id: "eq",
        label: "EQ",
        caption: !eqPowerActive ? "Off" : eqShaped ? "Graphic" : "Flat",
        active: eqActive,
        params: stageParams([...NAM_RACK_ADVANCED_CONTROL_IDS.eq, ...eqParamIds]),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
      },
      {
        id: "mod",
        label: "Mod",
        caption: !modulatorPowerActive ? "Bypassed" : (modulatorModeParam?.value ?? 0) >= 0.5 ? "Flanger" : (chorusMixParam ? formatParamValue(chorusMixParam) : "Chorus"),
        active: modulatorPowerActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.mod),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
        disabledParamIds: (modulatorPedalModeParam?.value ?? 1) >= 0.5 ? ["modulatorPedalPosition"] : undefined,
        dependencyNote: (modulatorPedalModeParam?.value ?? 1) >= 0.5
          ? "Pedal Sweep is inactive while Pedal Mode is Auto. Choose Pedal to control it manually."
          : undefined,
      },
      {
        id: "delay",
        label: "Delay",
        caption: !delayPowerActive ? "Bypassed" : delayMixParam ? formatParamValue(delayMixParam) : "Delay",
        active: delayActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.delay),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
        disabledParamIds: (delayTempoSyncParam?.value ?? 0) >= 0.5 ? ["delayTimeMs"] : undefined,
        dependencyNote: (delayTempoSyncParam?.value ?? 0) >= 0.5
          ? "Delay Time is inactive while Sync is on. Delay Mod selects the displayed division and also shapes delay character."
          : undefined,
      },
      {
        id: "reverb",
        label: "Reverb",
        caption: !reverbPowerActive ? "Bypassed" : reverbMixParam ? formatParamValue(reverbMixParam) : "Reverb",
        active: reverbActive,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.reverb),
        available: hasAmpModel,
        unavailableReason: ampRequiredReason,
      },
      {
        id: "output",
        label: "Output",
        caption: postCabOrderLabel || "Post-rack path",
        active: ampActive || pedalActive || precisionDriveActive || chaosActive || laserActive || cabActive || eqActive || chorusActive || delayActive || reverbActive,
        meterDb: outputMeterDb,
        params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS.output),
      },
    ], postCabOrder);
  }, [
    ampActive,
    ampName,
    cabActive,
    cabControlsUnavailableReason,
    cabMissingWarning,
    cabName,
    cabPresentation.mode,
    chaosActive,
    chaosMixParam,
    chorusActive,
    chorusMixParam,
    compressorActive,
    compressorCompParam,
    delayActive,
    delayPowerActive,
    delayMixParam,
    delayTempoSyncParam,
    eqActive,
    gateActive,
    gateThreshold,
    hasAmpModel,
    hasPedalModel,
    inputMeterDb,
    inputTrim,
    laserActive,
    laserModeParam,
    laserSpeedOverridden,
    laserSpeedOverrideReason,
    modulatorPowerActive,
    monoInputOneWarning,
    modulatorModeParam,
    modulatorPedalModeParam,
    octaverActive,
    octaverDownParam,
    octaverUpParam,
    outputMeterDb,
    params,
    pedalActive,
    pedalName,
    postCabOrder,
    postCabOrderLabel,
    precisionDriveActive,
    precisionDriveDriveParam,
    reverbActive,
    reverbPowerActive,
    reverbMixParam,
    selectedInputLabel,
    tapeEchoActive,
    tapeEchoTimeParam,
  ]);

  const focusedPedalPower = isPedalFaceplateModuleId(focusedModule)
    ? (() => {
      switch (focusedModule) {
        case "gate":
          return {
            active: gateActive,
            disabled: !gateThreshold,
            title: gateActive ? "Bypass gate" : "Enable gate",
            onToggle: () => toggleParamPower("gate", gateThreshold, gateActive, gateThreshold?.min ?? -100, -80),
          };
        case "pedal":
          return {
            active: precisionDriveActive,
            disabled: !precisionDriveEnabledParam,
            title: precisionDriveActive ? "Bypass precision drive" : "Enable precision drive",
            onToggle: () => precisionDriveEnabledParam && onParamChange(precisionDriveEnabledParam, precisionDriveActive ? 0 : 1),
          };
        case "eq":
          return {
            active: eqPowerActive,
            disabled: !eqEnabledParam,
            title: eqPowerActive ? "Power off graphic EQ" : "Power on graphic EQ",
            onToggle: () => eqEnabledParam && onParamChange(eqEnabledParam, eqPowerActive ? 0 : 1),
          };
        case "mod":
          return {
            active: modulatorPowerActive,
            disabled: !modulatorEnabledParam,
            title: modulatorPowerActive ? "Bypass modulation" : "Enable modulation",
            onToggle: () => {
              if (!modulatorEnabledParam) return;
              onParamChange(modulatorEnabledParam, modulatorPowerActive ? 0 : 1);
              if (!modulatorPowerActive && chorusMixParam && chorusMixParam.value <= 0.0001) {
                onParamChange(chorusMixParam, 0.25);
              }
            },
          };
        case "delay":
          return {
            active: delayPowerActive,
            disabled: !delayEnabledParam,
            title: delayPowerActive ? "Bypass delay" : "Enable delay",
            onToggle: () => {
              if (!delayEnabledParam) return;
              onParamChange(delayEnabledParam, delayPowerActive ? 0 : 1);
              if (!delayPowerActive && delayMixParam && delayMixParam.value <= 0.0001) {
                onParamChange(delayMixParam, 0.12);
              }
            },
          };
        case "reverb":
          return {
            active: reverbPowerActive,
            disabled: !reverbEnabledParam,
            title: reverbPowerActive ? "Bypass reverb" : "Enable reverb",
            onToggle: () => {
              if (!reverbEnabledParam) return;
              onParamChange(reverbEnabledParam, reverbPowerActive ? 0 : 1);
              if (!reverbPowerActive && reverbMixParam && reverbMixParam.value <= 0.0001) {
                onParamChange(reverbMixParam, 0.18);
              }
            },
          };
      }
    })()
    : null;

  const moveSlotBy = (moduleId: RackModuleId, delta: number) => {
    if (stageLocked || slotOrderBusy) return;
    if (isLockedSpineModule(moduleId)) return;
    const movable = slotOrder.filter((entry) => !isLockedSpineModule(entry));
    const fromIndex = movable.indexOf(moduleId);
    const toIndex = fromIndex + delta;
    if (fromIndex < 0 || toIndex < 0 || toIndex >= movable.length) return;
    const nextMovable = [...movable];
    nextMovable.splice(fromIndex, 1);
    nextMovable.splice(toIndex, 0, moduleId);
    const nextOrder = normalizeRackSlotOrder([...LOCKED_RACK_SPINE, ...nextMovable]);
    void persistSlotOrder(nextOrder).then((ok) => {
      if (ok) setSlotActionStatus(`${moduleTitle(moduleId)} moved ${delta < 0 ? "left" : "right"}`);
    });
  };

  const beginSlotDrag = (moduleId: RackModuleId) => {
    if (stageLocked || slotOrderBusy || isLockedSpineModule(moduleId)) return;
    dragOriginOrderRef.current = slotOrder;
    dropCommittedRef.current = false;
    setDragPreviewOrder(slotOrder);
    setDraggedSlot(moduleId);
    setSlotActionStatus(`Moving ${moduleTitle(moduleId)}`);
  };

  const previewSlotDrop = (moduleId: RackModuleId) => {
    const currentPreview = dragPreviewOrder ?? slotOrder;
    if (stageLocked || slotOrderBusy || !draggedSlot || !isValidRackSlotDrop(currentPreview, draggedSlot, moduleId)) {
      setDropTargetSlot(moduleId);
      return;
    }
    setDropTargetSlot(moduleId);
    const next = moveRackSlot(currentPreview, draggedSlot, currentPreview.indexOf(moduleId));
    if (!sameRackSlotOrder(currentPreview, next)) setDragPreviewOrder(next);
  };

  const dropSlotOn = (moduleId: RackModuleId) => {
    if (stageLocked || slotOrderBusy || !draggedSlot) {
      endSlotDrag(false);
      return;
    }
    const finalOrder = dragPreviewOrder
      ?? (isValidRackSlotDrop(slotOrder, draggedSlot, moduleId)
        ? moveRackSlot(slotOrder, draggedSlot, slotOrder.indexOf(moduleId))
        : null);
    if (!finalOrder) {
      endSlotDrag(false);
      return;
    }
    dropCommittedRef.current = true;
    const movedModuleTitle = moduleTitle(draggedSlot);
    void persistSlotOrder(finalOrder).then((ok) => {
      if (ok) setSlotActionStatus(`${movedModuleTitle} moved`);
    });
    dragOriginOrderRef.current = null;
    setDragPreviewOrder(null);
    setDraggedSlot(null);
    setDropTargetSlot(null);
  };

  const endSlotDrag = (restore = true) => {
    if (restore && !dropCommittedRef.current && dragOriginOrderRef.current) setSlotOrder(dragOriginOrderRef.current);
    dragOriginOrderRef.current = null;
    dropCommittedRef.current = false;
    setDragPreviewOrder(null);
    setDraggedSlot(null);
    setDropTargetSlot(null);
  };

  const resetSlotOrder = () => {
    if (slotOrderBusy) return;
    void persistSlotOrder(DEFAULT_RACK_SLOT_ORDER);
    dragOriginOrderRef.current = null;
    dropCommittedRef.current = false;
    setDragPreviewOrder(null);
    setDropTargetSlot(null);
    setDraggedSlot(null);
  };

  const rackModuleSpecs: Record<RackModuleId, {
    icon: React.ReactNode;
    label: string;
    caption: string;
    active: boolean;
    power?: {
      active: boolean;
      disabled?: boolean;
      title: string;
      onToggle: () => void;
    };
    extraAction?: {
      title: string;
      onClick: () => void;
      icon?: React.ReactNode;
    };
  }> = {
    gate: {
      icon: <Gauge size={16} />,
      label: "Gate",
      caption: gateThreshold ? formatParamValue(gateThreshold) : "Wrapper",
      active: gateActive,
      power: {
        active: gateActive,
        disabled: !gateThreshold,
        title: gateActive ? "Bypass gate" : "Enable gate",
        onToggle: () => toggleParamPower("gate", gateThreshold, gateActive, gateThreshold?.min ?? -100, -80),
      },
    },
    pedal: {
      icon: <Zap size={16} />,
      label: "Pre FX Drives",
      caption: precisionDriveActive || chaosActive ? "Drive circuit engaged" : "Bypassed",
      active: precisionDriveActive || chaosActive,
      power: {
        active: precisionDriveActive,
        disabled: !precisionDriveEnabledParam || !hasAmpModel,
        title: precisionDriveActive ? "Bypass precision drive" : "Enable precision drive",
        onToggle: () => precisionDriveEnabledParam && onParamChange(precisionDriveEnabledParam, precisionDriveActive ? 0 : 1),
      },
    },
    amp: {
      icon: <Activity size={16} />,
      label: "Amp NAM",
      caption: ampName || "Empty",
      active: ampActive,
      power: {
        active: ampPowerActive,
        disabled: !ampEnabledParam || !modelState?.hasAmpModel,
        title: ampPowerActive ? "Power off amp capture" : "Power on amp capture",
        onToggle: () => toggleParamPower("amp", ampEnabledParam, ampPowerActive, 0, 1),
      },
      extraAction: {
        title: "Browse amp and full-rig captures",
        onClick: () => openNAMCaptureLibrary("amp"),
        icon: <Library size={11} />,
      },
    },
    cab: {
      icon: <Mic2 size={16} />,
      label: "Cab/IR",
      caption: hardwareCabLabel,
      active: embeddedCabCapture || cabActive,
      power: {
        active: embeddedCabCapture || cabActive,
        disabled: !cabEnabledParam || !cabPresentation.canToggleExternalCab,
        title: embeddedCabCapture ? "Cabinet is included in the full-rig Capture" : cabActive ? "Bypass cabinet stage" : "Enable cabinet stage",
        onToggle: toggleCabPower,
      },
      extraAction: {
        title: embeddedCabCapture ? "Browse amp-only Captures" : cabPresentation.recommendedActionLabel,
        onClick: embeddedCabCapture ? openAmpOnlyCaptureLibrary : openCabIRLibrary,
        icon: <Library size={11} />,
      },
    },
    eq: {
      icon: <SlidersHorizontal size={16} />,
      label: "EQ",
      caption: !eqPowerActive ? "Off" : eqShaped ? "Graphic EQ" : "Flat",
      active: eqActive,
      power: {
        active: eqPowerActive,
        disabled: !eqEnabledParam || !hasAmpModel,
        title: eqPowerActive ? "Power off graphic EQ" : "Power on graphic EQ",
        onToggle: () => eqEnabledParam && onParamChange(eqEnabledParam, eqPowerActive ? 0 : 1),
      },
      extraAction: {
        title: "Focus EQ controls",
        onClick: () => enterRackModule("eq"),
      },
    },
    mod: {
      icon: <CircleDot size={16} />,
      label: "Mod",
      caption: !modulatorPowerActive ? "Bypassed" : formatPercentParam(chorusMixParam, "Mix", "Chorus / Flanger"),
      active: modulatorPowerActive,
      power: {
        active: modulatorPowerActive,
        disabled: !modulatorEnabledParam || !hasAmpModel,
        title: modulatorPowerActive ? "Bypass modulation" : "Enable modulation",
        onToggle: () => {
          if (!modulatorEnabledParam) return;
          onParamChange(modulatorEnabledParam, modulatorPowerActive ? 0 : 1);
          if (!modulatorPowerActive && chorusMixParam && chorusMixParam.value <= 0.0001) {
            onParamChange(chorusMixParam, 0.25);
          }
        },
      },
      extraAction: {
        title: "Open OpenStudio FX Collection",
        onClick: () => openPostFXCollection("mod"),
        icon: <Library size={11} />,
      },
    },
    delay: {
      icon: <Cable size={16} />,
      label: "Delay",
      caption: !delayPowerActive ? "Bypassed" : formatPercentParam(delayMixParam, "Mix", "Delay"),
      active: delayPowerActive,
      power: {
        active: delayPowerActive,
        disabled: !delayEnabledParam || !hasAmpModel,
        title: delayPowerActive ? "Bypass delay" : "Enable delay",
        onToggle: () => {
          if (!delayEnabledParam) return;
          onParamChange(delayEnabledParam, delayPowerActive ? 0 : 1);
          if (!delayPowerActive && delayMixParam && delayMixParam.value <= 0.0001) {
            onParamChange(delayMixParam, 0.12);
          }
        },
      },
      extraAction: {
        title: "Open OpenStudio FX Collection",
        onClick: () => openPostFXCollection("delay"),
        icon: <Library size={11} />,
      },
    },
    reverb: {
      icon: <Volume2 size={16} />,
      label: "Reverb",
      caption: !reverbPowerActive ? "Bypassed" : formatPercentParam(reverbMixParam, "Mix", "Reverb"),
      active: reverbPowerActive,
      power: {
        active: reverbPowerActive,
        disabled: !reverbEnabledParam || !hasAmpModel,
        title: reverbPowerActive ? "Bypass reverb" : "Enable reverb",
        onToggle: () => {
          if (!reverbEnabledParam) return;
          onParamChange(reverbEnabledParam, reverbPowerActive ? 0 : 1);
          if (!reverbPowerActive && reverbMixParam && reverbMixParam.value <= 0.0001) {
            onParamChange(reverbMixParam, 0.18);
          }
        },
      },
      extraAction: {
        title: "Open OpenStudio FX Collection",
        onClick: () => openPostFXCollection("reverb"),
        icon: <Library size={11} />,
      },
    },
  };

  const slotBrowserCategories: Array<{ id: RackSlotBrowserCategory; label: string; modules: RackModuleId[] }> = [
    { id: "amp", label: "Amp/Full Rig", modules: ["amp"] },
    { id: "cab", label: "Cab/IR", modules: ["cab"] },
    { id: "eq", label: "EQ", modules: ["eq"] },
    { id: "mod", label: "Mod", modules: ["mod"] },
    { id: "delay", label: "Delay", modules: ["delay"] },
    { id: "reverb", label: "Reverb", modules: ["reverb"] },
    { id: "utility", label: "Utility", modules: ["gate"] },
  ];
  const activeSlotBrowserCategory = slotBrowserCategories.find((category) => category.id === slotBrowserCategory) ?? slotBrowserCategories[0];

  const enterRackModule = (moduleId: RackModuleId) => {
    setLibraryFlow(null);
    setFocusedModule(moduleId);
    setActiveRackSection(rackSectionForModule(moduleId));
    setActiveView("rack");
  };
  const focusRackDevice = (sectionId: RackSectionId, moduleId?: RackModuleId) => {
    setLibraryFlow(null);
    if (moduleId) setFocusedModule(moduleId);
    setActiveRackSection(sectionId);
    setActiveView("rack");
  };
  const enterRackSection = (sectionId: RackSectionId, targetModule: RackModuleId) => {
    setLibraryFlow(null);
    setActiveRackSection(sectionId);
    setFocusedModule(targetModule);
    setActiveView("rack");
  };
  const openDesignPortLibrary = (sectionId: RackSectionId) => {
    if (sectionId === "pre") {
      openAdvancedControls("precision-drive");
      return;
    }
    if (sectionId === "amp") {
      openNAMCaptureLibrary("amp");
      return;
    }
    if (sectionId === "cab") {
      openCabIRLibrary();
      return;
    }
    if (sectionId === "eq") {
      openPostFXCollection("eq");
      return;
    }
    if (sectionId === "post") {
      const target = focusedModule === "mod" || focusedModule === "delay" || focusedModule === "reverb"
        ? focusedModule
        : "delay";
      openPostFXCollection(target);
    }
  };
  const cycleStageZoom = () => {
    setRackStageSizePercent((current) => {
      const index = NAM_RACK_STAGE_SIZE_OPTIONS.indexOf(current);
      return NAM_RACK_STAGE_SIZE_OPTIONS[(index + 1) % NAM_RACK_STAGE_SIZE_OPTIONS.length];
    });
  };
  const toggleCompactChain = () => {
    setLibraryFlow(null);
    setSlotBrowserOpen(false);
    setActiveView("rack");
    setChainOpen((open) => !open);
  };
  const advancedStageForCurrentRackContext = (): NAMRackAdvancedStageId => {
    if (activeRackSection === "pre") return "compressor";
    if (activeRackSection === "amp") return "amp";
    if (activeRackSection === "cab") return "cab";
    if (activeRackSection === "eq") return "eq";
    if (focusedModule === "mod" || focusedModule === "delay" || focusedModule === "reverb") {
      return focusedModule;
    }
    return "mod";
  };
  const openAdvancedControls = (stageId?: NAMRackAdvancedStageId) => {
    setLibraryFlow(null);
    setChainOpen(false);
    setAdvancedFocus(stageId ?? advancedStageForCurrentRackContext());
    setActiveView("mixer");
  };
  const openContextualAdvancedControls = () => openAdvancedControls(advancedStageForCurrentRackContext());
  const toggleEffectPower = (
    enabledParam: BuiltInParamDescriptor | undefined,
    active: boolean,
    wetParam?: BuiltInParamDescriptor,
    wetFallback = 0.25,
  ) => {
    if (!enabledParam) return;
    if (!active && wetParam && wetParam.value <= 0.0001) {
      onParamChange(wetParam, clamp(wetFallback, wetParam.min, wetParam.max));
    }
    onParamChange(enabledParam, active ? 0 : 1);
  };
  const toggleCompressor = () => toggleEffectPower(compressorEnabledParam, compressorPowerActive, compressorMixParam, 0.65);
  const toggleTapeEcho = () => toggleEffectPower(tapeEchoEnabledParam, tapeEchoActive, tapeEchoMixParam, 0.22);
  const toggleOctaver = () => {
    if (!octaverEnabledParam) return;
    if (!octaverActive && (octaverDownParam?.value ?? 0) <= 0.0001 && (octaverUpParam?.value ?? 0) <= 0.0001 && octaverDownParam) {
      onParamChange(octaverDownParam, clamp(0.35, octaverDownParam.min, octaverDownParam.max));
    }
    onParamChange(octaverEnabledParam, octaverActive ? 0 : 1);
  };
  const togglePrecisionDrive = () => toggleEffectPower(precisionDriveEnabledParam, precisionDriveActive);
  const toggleChaos = () => toggleEffectPower(chaosEnabledParam, chaosActive, chaosMixParam, 0.25);
  const toggleLaser = () => toggleEffectPower(laserEnabledParam, laserActive, laserMixParam, 0.25);
  const editFromCompactChain = (action: () => void) => () => {
    setChainOpen(false);
    action();
  };
  const editAdvancedFromCompactChain = (moduleId: string) => {
    const stageId = namRackAdvancedStageForCompactModule(moduleId);
    return editFromCompactChain(() => {
      if (stageId) openAdvancedControls(stageId);
    });
  };

  const signalChainFixedPre: NAMSignalChainRouteModule[] = [
    {
      id: "input",
      label: "Input",
      caption: selectedInputLabel,
      status: (inputModeParam?.value ?? 0) >= 0.5 ? "Mono" : "Stereo Sum",
      enabled: true,
      icon: <Cable size={15} />,
      onEdit: editAdvancedFromCompactChain("input"),
      editLabel: "Edit Input in Device Controls",
    },
    {
      id: "gate",
      label: "Gate",
      caption: gateThreshold ? formatParamValue(gateThreshold) : "Input gate",
      status: gateActive ? "Engaged" : "Bypassed",
      enabled: gateActive,
      icon: <Gauge size={15} />,
      onToggle: gateThreshold
        ? () => toggleParamPower("gate", gateThreshold, gateActive, gateThreshold.min, -58)
        : undefined,
      onEdit: editAdvancedFromCompactChain("gate"),
      editLabel: "Edit Gate in Device Controls",
    },
    {
      id: "compressor",
      label: "Compressor",
      caption: formatPercentParam(compressorCompParam, "Comp", "Dynamics"),
      status: !compressorPowerActive ? "Bypassed" : compressorActive ? "Engaged" : "Mix at 0%",
      enabled: compressorPowerActive,
      disabled: !hasAmpModel,
      icon: <Activity size={15} />,
      onToggle: compressorEnabledParam ? toggleCompressor : undefined,
      onEdit: editAdvancedFromCompactChain("compressor"),
      editLabel: "Edit Compressor in Device Controls",
    },
    {
      id: "tape-echo",
      label: "Tape Echo",
      caption: tapeEchoTimeParam ? formatParamValue(tapeEchoTimeParam) : "Pre-amp echo",
      enabled: tapeEchoActive,
      disabled: !hasAmpModel,
      icon: <Cable size={15} />,
      onToggle: tapeEchoEnabledParam ? toggleTapeEcho : undefined,
      onEdit: editAdvancedFromCompactChain("tape-echo"),
      editLabel: "Edit Tape Echo in Device Controls",
    },
    {
      id: "octaver",
      label: "Mono Octaver",
      caption: `Monophonic · Down ${Math.round((octaverDownParam?.value ?? 0) * 100)}% · Up ${Math.round((octaverUpParam?.value ?? 0) * 100)}%`,
      enabled: octaverActive,
      disabled: !hasAmpModel,
      icon: <CircleDot size={15} />,
      onToggle: octaverEnabledParam ? toggleOctaver : undefined,
      onEdit: editAdvancedFromCompactChain("octaver"),
      editLabel: "Edit Mono Octaver in Device Controls",
    },
    {
      id: "precision-drive",
      label: "Precision Drive",
      caption: formatPercentParam(precisionDriveDriveParam, "Drive", "Drive amount"),
      enabled: precisionDriveActive,
      disabled: !hasAmpModel,
      icon: <Zap size={15} />,
      onToggle: precisionDriveEnabledParam ? togglePrecisionDrive : undefined,
      onEdit: editAdvancedFromCompactChain("precision-drive"),
      editLabel: "Edit Precision Drive in Device Controls",
    },
    {
      id: "chaos",
      label: "Distortion",
      caption: "Dedicated high-gain distortion",
      enabled: chaosActive,
      disabled: !hasAmpModel,
      icon: <Sparkles size={15} />,
      onToggle: chaosEnabledParam ? toggleChaos : undefined,
      onEdit: editAdvancedFromCompactChain("chaos"),
      editLabel: "Edit Distortion in Device Controls",
    },
    {
      id: "laser",
      label: "Laser",
      caption: "Creative pre effect",
      enabled: laserActive,
      disabled: !hasAmpModel,
      icon: <Sparkles size={15} />,
      onToggle: laserEnabledParam ? toggleLaser : undefined,
      onEdit: editAdvancedFromCompactChain("laser"),
      editLabel: "Edit Laser in Device Controls",
    },
  ];

  const signalChainCaptureCore: NAMSignalChainRouteModule[] = [
    {
      id: "amp-nam",
      label: "Amp Capture",
      caption: ampName || "No capture loaded",
      status: !hasAmpModel
        ? "Empty"
        : !ampPowerActive
          ? "Bypassed"
          : (ampMix?.value ?? 0) <= 0.0001
            ? "Mix at 0%"
            : "Engaged",
      enabled: hasAmpModel && ampPowerActive,
      icon: <Activity size={15} />,
      onToggle: hasAmpModel && ampEnabledParam
        ? () => toggleParamPower("amp", ampEnabledParam, ampPowerActive, 0, 1)
        : undefined,
      onEdit: editAdvancedFromCompactChain("amp-nam"),
      editLabel: "Edit Amp NAM in Device Controls",
    },
    {
      id: "cab-ir",
      label: "Cab / IR",
      caption: hardwareCabLabel,
      status: embeddedCabCapture ? "Included" : cabPresentation.needsCabIR ? "Choose IR" : cabActive ? "Engaged" : "Bypassed",
      enabled: embeddedCabCapture || cabActive,
      icon: <Mic2 size={15} />,
      onToggle: !cabEnabledParam || !cabPresentation.canToggleExternalCab ? undefined : toggleCabPower,
      onEdit: editAdvancedFromCompactChain("cab-ir"),
      editLabel: "Edit Cab / IR in Device Controls",
    },
  ];

  const signalChainPost: NAMSignalChainPostModule[] = postCabOrder.map((moduleId, index) => {
    const spec = rackModuleSpecs[moduleId];
    const power = spec.power;
    return {
      id: moduleId,
      label: spec.label,
      caption: spec.caption,
      status: power?.active ? "Engaged" : "Bypassed",
      enabled: power?.active ?? spec.active,
      icon: spec.icon,
      disabled: power?.disabled,
      onToggle: () => power?.onToggle(),
      onEdit: editAdvancedFromCompactChain(moduleId),
      editLabel: `Edit ${spec.label} in Device Controls`,
      canMoveLeft: !stageLocked && !slotOrderBusy && index > 0,
      canMoveRight: !stageLocked && !slotOrderBusy && index < postCabOrder.length - 1,
      onMoveLeft: () => moveSlotBy(moduleId, -1),
      onMoveRight: () => moveSlotBy(moduleId, 1),
    };
  });

  const signalChainTail: NAMSignalChainRouteModule[] = [
    {
      id: "output",
      label: "Output",
      caption: outputTrim ? formatParamValue(outputTrim) : "Output trim",
      status: "Active",
      enabled: true,
      icon: <Volume2 size={15} />,
      onEdit: editAdvancedFromCompactChain("output"),
      editLabel: "Edit output in Device Controls",
    },
  ];
  const visibleSlotOrder = dragPreviewOrder ?? slotOrder;
  const rightRailGear = {
    pedalTitle: modelState?.pedalModelPath,
    pedalLabel: pedalName || "Empty",
    ampTitle: modelState?.ampModelPath,
    ampLabel: hardwareAmpLabel,
    cabTitle: modelState?.cabIRPath,
    cabLabel: hardwareCabLabel,
  };
  const rightRailCab = {
    title: modelState?.cabIRPath,
    label: hardwareCabLabel,
    status: cabPresentation.hasRetainedExternalIR
      ? "External IR retained and will be restored for an amp-only Capture"
      : cabPresentation.status,
    active: embeddedCabCapture || cabActive,
    hasIR: hasCabIR && !embeddedCabCapture,
    busy: cabBusy,
    irItems: [...favoriteIRs, ...recentIRs].slice(0, 6).map((entry) => ({
      path: entry.path,
      label: fileName(entry.path) || "Impulse response",
      subtitle: entry.favorite ? "Favorite" : formatIRLastUsed(entry.lastUsed),
      active: entry.path === currentCabIRPath,
    })),
  };
  const rightRailSaved = {
    heading: filteredUserPresets.length > 0 ? `${filteredUserPresets.length} user presets` : "Templates for Current Capture",
    status: isPresetDirty
      ? "Current rack has unsaved edits"
      : activeUserPresetName || hasFactoryPresetSelection
        ? "Current rack matches its selected preset"
        : "No template selected",
    saveToneBusy,
    userPresets: filteredUserPresets.slice(0, 5).map((entry) => ({
      key: `user-${entry.name}`,
      name: entry.name,
      subtitle: presetMetadata[entry.name]?.folder || "User preset",
      title: entry.path,
    })),
    factoryPresets: filteredFactoryPresets.slice(0, 5).map((entry) => ({
      key: `factory-${entry.id}`,
      id: entry.id,
      name: entry.name,
      subtitle: entry.description,
    })),
  };
  const designPortLibraryItems = NAM_RACK_PRESETS.map((entry) => ({
    id: entry.id,
    name: entry.name.replace(/^Current Capture\s*·\s*/i, ""),
    subtitle: "Effect settings for the loaded Capture",
    active: hasFactoryPresetSelection && entry.id === presetId,
  }));
  const onDesignPortParamChange = (param: BuiltInParamDescriptor, value: number) => {
    if (param.id.startsWith("cab") && cabPresentation.mode !== "loaded") {
      setSlotActionStatus(cabControlsUnavailableReason ?? "Choose a cabinet IR before changing the Cab/IR controls.");
      return;
    }
    onParamChange(param, value);
  };
  const rightRailTuner = {
    signalPresent: tunerSignalPresent,
    pitchLocked: tunerPitchLocked,
    noteLabel: tunerPitchLocked ? (tunerNoteName ?? "--") : "--",
    statusLabel: tunerStatusLabel,
    centsPct: tunerNeedlePct,
    frequencyLabel: tunerFrequencyLabel,
    inputLevelLabel: formatDb(tunerInputLevelDb),
    confidenceLabel: tunerConfidenceLabel,
    routeLabel: selectedInputLabel,
    meterPct: meterPercent(tunerInputLevelDb) * 100,
  };
  const diagnosticsMessage =
    modelProcessFailCount > 0
      ? "The NAM model faulted while processing, so the rack bypassed it instead of crashing."
      : realtimeDSPBlocked
        ? "NAM processing entered its internal safety bypass after a processing fault. The selected device buffer has not been changed."
        : audioDeadlineWarning
            ? audioDeadlineStatus.recording
              ? `Audio processing exceeded the ${audioBlockBudgetMs.toFixed(2)} ms buffer while recording${audioDeadlineStatus.lastMissProcessMs > 0 ? ` (last ${audioDeadlineStatus.lastMissProcessMs.toFixed(2)} ms)` : ""}. Raise the buffer before retrying.${dualNAMRateAdvice}`
              : `Audio processing repeatedly exceeded the ${audioBlockBudgetMs.toFixed(2)} ms buffer${audioDeadlineStatus.lastMissProcessMs > 0 ? ` (last ${audioDeadlineStatus.lastMissProcessMs.toFixed(2)} ms)` : ""}. Raise the buffer if clicks continue.${dualNAMRateAdvice}`
            : (dspBudgetPct ?? 0) >= 80
              ? `The latest audio callback used ${dspBudgetLabel} of the available ${audioBlockBudgetMs.toFixed(2)} ms block budget. If clicks occur, disable unused stages or try the next larger driver-supported buffer.${dualNAMRateAdvice}`
            : resizeAvoidedCount > 0 || oversizeBypassCount > 0
              ? "The audio block exceeded the prepared NAM buffer, so preview was bypassed to avoid artifacts."
              : monoInputOneWarning
                ? rackWindowCapabilities.canOpenTrackRouting
                  ? "Track is feeding mono Input 1 into the amp. If your guitar is plugged into Input 2, the amp will amplify Input 1 noise."
                  : "Track is feeding mono Input 1 into the amp. Change this track's input in the main OpenStudio window if the guitar is connected elsewhere."
                : cabMissingWarning
                  ? "Amp is active with no cabinet IR configured. That can sound harsh; open the Cab/IR library for a cabinet."
                  : dualNAMRateMismatch
                    ? `Pedal NAM and Amp NAM are active through sample-rate conversion.${dualNAMRateAdvice}`
                  : liveInputDetected
                    ? "Live guitar input is reaching the rack."
                    : auditionSourceRendered
                      ? "An internal diagnostic source is active. Stop the audition to return to live guitar input."
                      : "No strong live input is reaching the rack yet. Arm or monitor the track and check the selected input.";
  const diagnosticsActions = [
    rackWindowCapabilities.canOpenTrackRouting && runtimeHostTrack ? {
      id: "routing",
      label: "Routing",
      title: "Open this track's input routing",
      icon: "routing",
      onClick: openRoutingForHostTrack,
    } : null,
    rackWindowCapabilities.canOpenAppAudio
      && (audioDeadlineWarning || (dspBudgetPct ?? 0) >= 80) ? {
      id: "buffer",
      label: "Buffer",
      title: "Open audio settings and raise the buffer size",
      icon: "buffer",
      onClick: openSettings,
    } : null,
    rackWindowCapabilities.canOpenTrackRouting && monoInputOneWarning ? {
      id: "check-input-2",
      label: "Check Input 2",
      title: "Switch this track to the input your guitar is plugged into",
      onClick: openRoutingForHostTrack,
    } : null,
    cabMissingWarning ? {
      id: "cab-ir",
      label: "Cab/IR",
      title: "Open TONE3000 cabinet IRs",
      icon: "cab",
      onClick: openCabIRLibrary,
    } : null,
  ].filter((action): action is NAMRackDiagnosticsAction => Boolean(action));
  const tone3000AuthReady = Boolean(tone3000Session.status?.authenticated && !tone3000Session.status.expired);
  const inputDiagnostics: NAMRackDiagnosticsState = {
    tone: inputDiagnosticTone,
    selectedInputLabel,
    levelLine: `Raw ${formatDb(rawInputDb)} / Rack ${formatDb(postRackInputDb)}${auditionSourceActive ? auditionSourceRendered ? " - diagnostic source active" : " - live input detected" : ""}`,
    bufferLine: runtimeDeviceLabel || audioDebugBlockSize > 0
      ? `${runtimeDeviceLabel ? `${runtimeDeviceLabel} · ` : ""}${audioDebugBlockSize > 0
        ? `Buffer ${audioDebugBlockSize} samples${audioBlockBudgetMs > 0 ? ` (${audioBlockBudgetMs.toFixed(2)} ms)` : ""}${audioCallbackMs > 0 ? ` / callback ${audioCallbackMs.toFixed(2)} ms` : ""}${audioCallbackMaxMs > 0 ? ` / session max ${audioCallbackMaxMs.toFixed(2)} ms` : ""}${audioDeadlineMisses > 0 ? ` / session overruns ${audioDeadlineMisses}` : ""}`
        : "Audio device ready"}`
      : undefined,
    message: diagnosticsMessage,
    authReady: tone3000AuthReady,
    authLabel: !tone3000Session.bootstrapped || tone3000Session.busy
      ? "TONE3000 checking"
      : tone3000AuthReady
        ? "TONE3000 ready"
        : tone3000Session.status?.hasRefreshToken
          ? "TONE3000 refresh needed"
          : "TONE3000 offline",
    actions: diagnosticsActions,
  };

  const formatCalibrationValue = (value: number | undefined, unit: "dBu" | "dB") => (
    Number.isFinite(value) ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(1)} ${unit}` : "—"
  );
  const calibrationBadgeLabelForState = (state: NAMCalibrationState | undefined) => (
    state?.status === "complete" ? "Model metadata" :
    state?.status === "partial" ? "Partial metadata" :
    state?.status === "override" ? "Manual override" :
    state?.status === "off" ? "Off" :
    "Metadata unavailable"
  );
  const calibrationStatusForState = (state: NAMCalibrationState | undefined): "complete" | "partial" | "override" | "off" | "unavailable" => (
    state?.status === "complete"
    || state?.status === "partial"
    || state?.status === "override"
    || state?.status === "off"
      ? state.status
      : "unavailable"
  );
  const calibrationBadgeSlots = [
    ...(hasPedalModel ? [{ label: "Pedal", state: modelState?.pedalCalibration }] : []),
    ...(hasAmpModel ? [{ label: "Amp", state: modelState?.ampCalibration }] : []),
  ];
  const calibrationBadgeStatuses = calibrationBadgeSlots
    .map(({ state }) => calibrationStatusForState(state) as NAMCalibrationSummaryStatus);
  const calibrationBadgeSummary = summarizeNAMCalibrationStatuses(calibrationBadgeStatuses);
  const calibrationBadgeStatus = calibrationBadgeSummary.status;
  const calibrationBadgeLabel = calibrationBadgeSummary.label;
  const calibrationBadgeTitle = calibrationBadgeSlots.length > 0
    ? `${calibrationBadgeSlots.map(({ label, state }) => `${label}: ${calibrationBadgeLabelForState(state)}`).join(" · ")}. Open NAM dBu calibration settings.`
    : "No NAM captures loaded. Open NAM dBu calibration settings.";
  const renderCalibrationSlot = (
    label: string,
    loaded: boolean,
    captureName: string,
    state: NAMCalibrationState | undefined,
    modeParam: BuiltInParamDescriptor | undefined,
    overrideInputParam: BuiltInParamDescriptor | undefined,
    overrideOutputParam: BuiltInParamDescriptor | undefined,
  ) => {
    const mode = Math.round(modeParam?.value ?? 0);
    return (
      <article className="nam-calibration-slot" data-status={state?.status ?? "unavailable"} data-loaded={loaded}>
        <header>
          <div>
            <span>{label}</span>
            <strong>{loaded ? captureName || "Loaded capture" : "No capture"}</strong>
            {loaded && <small>{state?.status === "off" ? "Calibration off" : `${calibrationBadgeLabelForState(state)} · applied live`}</small>}
          </div>
          <select
            aria-label={`${label} calibration mode`}
            value={mode}
            disabled={!modeParam}
            onChange={(event) => modeParam && onParamChange(modeParam, Number(event.currentTarget.value))}
          >
            <option value={0}>Off</option>
            <option value={1}>Model metadata</option>
            <option value={2}>Override</option>
          </select>
        </header>
        <dl>
          <div><dt>Capture IN</dt><dd>{formatCalibrationValue(state?.metadataInputLevelDbu, "dBu")}</dd></div>
          <div><dt>Capture OUT</dt><dd>{formatCalibrationValue(state?.metadataOutputLevelDbu, "dBu")}</dd></div>
          <div><dt>Applied IN</dt><dd>{formatCalibrationValue(state?.appliedInputGainDb, "dB")}</dd></div>
          <div><dt>Applied OUT</dt><dd>{formatCalibrationValue(state?.appliedOutputGainDb, "dB")}</dd></div>
        </dl>
        {mode === 2 && (
          <div className="nam-calibration-overrides">
            <label>
              Override IN
              <input
                type="number"
                min={overrideInputParam?.min ?? -20}
                max={overrideInputParam?.max ?? 30}
                step={0.1}
                value={overrideInputParam?.value ?? 12}
                onChange={(event) => overrideInputParam && onParamChange(overrideInputParam, Number(event.currentTarget.value))}
              />
              <span>dBu</span>
            </label>
            <label>
              Override OUT
              <input
                type="number"
                min={overrideOutputParam?.min ?? -20}
                max={overrideOutputParam?.max ?? 30}
                step={0.1}
                value={overrideOutputParam?.value ?? 12}
                onChange={(event) => overrideOutputParam && onParamChange(overrideOutputParam, Number(event.currentTarget.value))}
              />
              <span>dBu</span>
            </label>
          </div>
        )}
      </article>
    );
  };

  const designPortRecovery: NAMRackDesignRecovery | undefined = activeMissingRackAsset
    ? {
        slot: activeMissingRackAsset.slot,
        slotLabel: activeMissingRackAsset.slotLabel,
        assetLabel: activeMissingRackAsset.assetLabel,
        pathLabel: fileName(activeMissingRackAsset.path) || activeMissingRackAsset.path,
        detail: recoveryActionStatus?.slot === activeMissingRackAsset.slot
          ? recoveryActionStatus.message
          : activeMissingRackAsset.bypassed
            ? "This unavailable stage is bypassed. Locate the original file or choose a supported replacement."
            : "The saved file could not be opened. Locate it, replace it, or bypass this stage while the rest of the rack stays available.",
        busy: recoveryBusySlot !== null,
        bypassed: activeMissingRackAsset.bypassed,
        additionalMissingCount: Math.max(0, missingRackAssets.length - 1),
        onLocate: () => void locateMissingRackAsset(activeMissingRackAsset),
        onReplace: () => replaceMissingRackAsset(activeMissingRackAsset),
        onBypass: () => void bypassMissingRackAsset(activeMissingRackAsset),
      }
    : undefined;

  // Inactive compatibility references: the old scene renderers and their data
  // stay compiled for rollback/debugging, but the native design-port owns the
  // active main rack visual surface.
  void NAMRackAmpCabStage;
  void PedalHardwareStage;
  void moduleHardwareArt;
  void NAMRackNeuralSectionSuite;
  void NAMRackPostFxSuite;
  void cabPhaseInvertParam;
  void currentIREntry;
  void visibleRecentIRs;
  void ampFaceplateParams;
  void pedalStageParams;
  void cabRoomKnobs;
  void renderPedalKnob;
  void toggleIRFavorite;
  void removeIRFromLibrary;
  void postFxDevices;
  void neuralSectionDevices;
  void focusedPedalPower;
  void focusRackDevice;

  return (
    <div
      className="nam-product nam-neural-product"
      data-view={activeView}
      data-rack-section={activeRackSection}
      data-visual-mode={visualMode}
      data-rack-size={rackStageSizePercent}
      data-design-port-active={activeView === "rack"}
      data-chain-open={chainOpen}
      style={{
        "--nam-rack-stage-size": rackStageSizePercent,
        "--nam-rack-stage-scale": rackStageSizePercent / 140,
      } as CSSProperties}
    >
      <section className="nam-neural-section-rail" aria-label="NAM Rack signal sections">
        {NAM_RACK_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            data-section={section.id}
            data-active={activeView === "rack" && activeRackSection === section.id}
            onClick={() => enterRackSection(section.id, section.targetModule)}
            title={`Open ${section.label}`}
          >
            {neuralSectionIcon(section.id)}
            <span>{section.label}</span>
            <i aria-hidden="true" />
          </button>
        ))}
      </section>

      <section className="nam-neural-global-strip" aria-label="NAM Rack global controls">
        <div className="nam-neural-global-side nam-neural-global-side-left">
          <MeterTrimControl label="Input" levelDb={inputMeterDb} param={inputTrim} onChange={onParamChange} />
          <button
            type="button"
            className="nam-calibration-badge"
            data-status={calibrationBadgeStatus}
            data-open={calibrationOpen}
            onClick={() => setCalibrationOpen((open) => !open)}
            title={calibrationBadgeTitle}
            aria-controls="nam-calibration-dialog"
            aria-expanded={calibrationOpen}
            aria-haspopup="dialog"
          >
            <Gauge size={17} />
            <span>CAL</span>
            <strong>{calibrationBadgeLabel}</strong>
          </button>
          <div className="nam-neural-global-knob" data-disabled={!gateThreshold} data-active={gateActive}>
            <div>
              <span>Gate</span>
              <button
                type="button"
                data-active={gateActive}
                aria-pressed={gateActive}
                disabled={!gateThreshold}
                onClick={() => toggleParamPower("gate", gateThreshold, gateActive, gateThreshold?.min ?? -80, -58)}
                title={gateActive ? "Bypass gate" : "Enable gate"}
              >
                <i />
              </button>
            </div>
            {gateThreshold ? <RackKnob param={gateThreshold} onChange={onParamChange} /> : <NeuralParameterReadout label="Threshold" />}
          </div>
          <div className="nam-neural-input-mode" role="group" aria-label="Input mode" data-bound={Boolean(inputModeParam)}>
            <span>Input Mode</span>
            <button type="button" title="Fold a stereo track to mono before a mono NAM capture" data-active={(inputModeParam?.value ?? 0) < 0.5} aria-pressed={(inputModeParam?.value ?? 0) < 0.5} disabled={!inputModeParam} onClick={() => inputModeParam && onParamChange(inputModeParam, 0)}>Stereo Sum</button>
            <button type="button" data-active={(inputModeParam?.value ?? 0) >= 0.5} aria-pressed={(inputModeParam?.value ?? 0) >= 0.5} disabled={!inputModeParam} onClick={() => inputModeParam && onParamChange(inputModeParam, 1)}>Mono</button>
          </div>
        </div>

        <div className="nam-neural-preset-hub" aria-label="NAM Rack preset navigation">
          <div className="nam-neural-preset-actions">
            <button
              type="button"
              onClick={() => void applyHeaderPresetTarget(headerPresetNavigation.previous)}
              disabled={presetBusy || presetManagerBusy || !headerPresetNavigation.previous}
              title={headerPresetTargetLabel("Previous", headerPresetNavigation.previous)}
              aria-label={headerPresetTargetLabel("Previous", headerPresetNavigation.previous)}
            >
              <ArrowLeft size={17} />
            </button>
            <button
              type="button"
              onClick={() => void applyHeaderPresetTarget(headerPresetNavigation.next)}
              disabled={presetBusy || presetManagerBusy || !headerPresetNavigation.next}
              title={headerPresetTargetLabel("Next", headerPresetNavigation.next)}
              aria-label={headerPresetTargetLabel("Next", headerPresetNavigation.next)}
            >
              <ArrowRight size={17} />
            </button>
            <button
              type="button"
              onClick={() => setPresetManagerOpen(true)}
              disabled={presetBusy}
              aria-controls="nam-preset-manager-dialog"
              aria-expanded={presetManagerOpen}
              aria-haspopup="dialog"
            >Edit</button>
            <button type="button" data-qa="nam-save-tone-trigger" onClick={openSaveToneModal} disabled={saveToneBusy}>Save Preset</button>
          </div>
          <div className="nam-neural-preset-select">
            <button
              type="button"
              className="nam-neural-preset-icon-button"
              onClick={() => {
                setPresetFolderFilter("favorites");
                setPresetManagerOpen(true);
              }}
              title="Open preset favorites"
              aria-controls="nam-preset-manager-dialog"
              aria-expanded={presetManagerOpen}
              aria-haspopup="dialog"
            >
              <Star size={18} />
            </button>
            <select
              aria-label="Current Preset or Template for Current Capture"
              title="Choose a Template for Current Capture; saved user Presets recall the complete rack"
              value={activeUserPresetName ? "__active-user-preset__" : presetId}
              onChange={(event) => {
                const selectedPreset = NAM_RACK_PRESETS.find((entry) => entry.id === event.currentTarget.value);
                if (selectedPreset) void applyPreset(selectedPreset);
              }}
              disabled={presetBusy}
            >
              {!activeUserPresetName && !hasFactoryPresetSelection && (
                <option value="" disabled>Choose a template...</option>
              )}
              {activeUserPresetName && (
                <optgroup label="Current User Preset">
                  <option value="__active-user-preset__">{activeUserPresetName}{isPresetDirty ? " *" : ""}</option>
                </optgroup>
              )}
              <optgroup label="Templates for Current Capture">
                {NAM_RACK_PRESETS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}{hasFactoryPresetSelection && entry.id === presetId && isPresetDirty ? " *" : ""}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              type="button"
              className="nam-neural-preset-library-button"
              onClick={() => openRackToneRail()}
              data-active={activeView === "browse" || rackRailTab === "tones"}
              title="Open Capture Library"
            >
              <FolderOpen size={18} />
            </button>
          </div>
        </div>

        <div className="nam-neural-global-side nam-neural-global-side-right">
          <MeterTrimControl label="Output" levelDb={outputMeterDb} param={outputTrim} onChange={onParamChange} />
        </div>
      </section>

      {calibrationOpen && (
        <section
          ref={calibrationDialogRef}
          id="nam-calibration-dialog"
          className="nam-calibration-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nam-calibration-dialog-title"
          tabIndex={-1}
          onKeyDown={onCalibrationDialogKeyDown}
        >
          <header>
            <div>
              <span>LEVEL CALIBRATION</span>
              <strong id="nam-calibration-dialog-title">Capture dBu alignment</strong>
              <p>Calibration is applied inside each NAM wet path. It does not move the Input or Output trim controls.</p>
            </div>
            <button type="button" onClick={closeCalibrationDialog} aria-label="Close calibration settings">×</button>
          </header>
          <div className="nam-calibration-reference">
            <label htmlFor="nam-calibration-reference">Interface 0 dBFS reference</label>
            <div>
              <input
                id="nam-calibration-reference"
                data-nam-dialog-initial-focus="true"
                type="number"
                min={calibrationReferenceParam?.min ?? -20}
                max={calibrationReferenceParam?.max ?? 30}
                step={0.1}
                value={calibrationReferenceParam?.value ?? 12}
                onChange={(event) => calibrationReferenceParam && onParamChange(calibrationReferenceParam, Number(event.currentTarget.value))}
              />
              <span>dBu</span>
            </div>
            <small>Match this to your interface specification and physical input gain. Changing hardware gain invalidates the reference.</small>
          </div>
          <div className="nam-calibration-grid">
            {hasPedalModel
              ? renderCalibrationSlot("Pedal capture", true, pedalName, modelState?.pedalCalibration, pedalCalibrationModeParam, pedalOverrideInputParam, pedalOverrideOutputParam)
              : null}
            {renderCalibrationSlot("Amp capture", hasAmpModel, ampName, modelState?.ampCalibration, ampCalibrationModeParam, ampOverrideInputParam, ampOverrideOutputParam)}
          </div>
          <footer className="nam-calibration-footer">
            <span><i aria-hidden="true" />Changes are applied live inside the NAM wet paths.</span>
            <button type="button" onClick={closeCalibrationDialog}>Done</button>
          </footer>
        </section>
      )}

      {activeView !== "rack" && (
        <section className="nam-product-topbar" aria-label="NAM Rack global controls">
          <div className="nam-reference-brand" aria-label="NAM Rack">
            <span className="nam-reference-menu" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <strong><b>NAM</b> Rack</strong>
          </div>
          <MeterTrimControl label="Input" levelDb={inputMeterDb} param={inputTrim} onChange={onParamChange} />

          <div className="nam-preset-cluster" aria-label="NAM Rack preset navigation">
            <button
              type="button"
              className="nam-preset-step"
              onClick={() => void applyHeaderPresetTarget(headerPresetNavigation.previous)}
              disabled={presetBusy || presetManagerBusy || !headerPresetNavigation.previous}
              title={headerPresetTargetLabel("Previous", headerPresetNavigation.previous)}
              aria-label={headerPresetTargetLabel("Previous", headerPresetNavigation.previous)}
            >
              <ArrowLeft size={14} />
            </button>
            <label className="nam-preset-select" title="Apply a Template for Current Capture">
              <Sparkles size={14} />
              <select
                value={presetId}
                onChange={(event) => {
                  const selectedPreset = NAM_RACK_PRESETS.find((entry) => entry.id === event.currentTarget.value);
                  if (selectedPreset) void applyPreset(selectedPreset);
                }}
                disabled={presetBusy}
              >
                {!hasFactoryPresetSelection && (
                  <option value="" disabled>Choose a template...</option>
                )}
                <optgroup label="Templates for Current Capture">
                  {NAM_RACK_PRESETS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}{hasFactoryPresetSelection && entry.id === presetId && isPresetDirty ? " *" : ""}
                    </option>
                  ))}
                </optgroup>
              </select>
              {isPresetDirty && <span className="nam-preset-dirty" title="Preset has unsaved edits after applying the template">Edited</span>}
            </label>
            <button
              type="button"
              className="nam-preset-favorite-shortcut"
              data-active={presetManagerOpen && presetFolderFilter === "favorites"}
              onClick={() => {
                setPresetFolderFilter("favorites");
                setPresetManagerOpen(true);
              }}
              title="Open preset favorites"
              aria-label="Open preset favorites"
              aria-controls="nam-preset-manager-dialog"
              aria-expanded={presetManagerOpen}
              aria-haspopup="dialog"
            >
              <Star size={13} />
            </button>
            <button
              type="button"
              className="nam-preset-step"
              onClick={() => void applyHeaderPresetTarget(headerPresetNavigation.next)}
              disabled={presetBusy || presetManagerBusy || !headerPresetNavigation.next}
              title={headerPresetTargetLabel("Next", headerPresetNavigation.next)}
              aria-label={headerPresetTargetLabel("Next", headerPresetNavigation.next)}
            >
              <ArrowRight size={14} />
            </button>
          </div>

          <button
            type="button"
            className="nam-save-tone-topbar"
            data-qa="nam-save-tone-trigger"
            onClick={openSaveToneModal}
            disabled={saveToneBusy}
            title="Save the complete NAM Rack as a Preset"
            aria-label="Save Preset"
          >
            <Save size={15} />
            {saveToneBusy ? "Saving" : "Save Preset"}
          </button>

          <button
            type="button"
            className="nam-library-cta"
            data-active={activeView === "browse"}
            onClick={() => openRackToneRail()}
            title="Open the TONE3000 Capture Library"
          >
            <Library size={15} />
            Capture Library
          </button>

          <div className="nam-top-actions" aria-label="Rack compare and utility controls">
            <button
              type="button"
              className="nam-header-preset-manager-action"
              data-qa="nam-header-preset-manager"
              data-active={presetManagerOpen}
              onClick={() => setPresetManagerOpen((open) => !open)}
              title="Open preset manager"
              aria-label="Open preset manager"
              aria-controls="nam-preset-manager-dialog"
              aria-expanded={presetManagerOpen}
              aria-haspopup="dialog"
            >
              <Library size={14} />
            </button>
            {(["A", "B"] as CompareSlot[]).map((slot) => (
              <button
                key={slot}
                type="button"
                data-qa={`nam-compare-slot-${slot.toLowerCase()}`}
                data-active={compareSlot === slot}
                aria-pressed={compareSlot === slot}
                data-dirty={compareSlot === slot && currentCompareDirty}
                onClick={() => void recallCompareSlot(slot)}
                title={
                  compareSlot === slot
                    ? `Store current rack in compare slot ${slot}`
                    : compareSnapshots[slot]
                      ? `Recall compare slot ${slot}`
                      : `Start compare slot ${slot}`
                }
              >
                {slot}
              </button>
            ))}
            <button
              type="button"
              data-qa="nam-header-undo"
              onClick={() => void applyPreset()}
              disabled={presetBusy}
              title="Reapply selected rack preset"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              data-qa="nam-header-more"
              data-active={presetManagerOpen}
              onClick={() => setPresetManagerOpen((open) => !open)}
              title="More rack options"
              aria-label="More rack options"
              aria-controls="nam-preset-manager-dialog"
              aria-expanded={presetManagerOpen}
              aria-haspopup="dialog"
            >
              <EllipsisVertical size={15} />
            </button>
          </div>

          <MeterTrimControl label="Output" levelDb={outputMeterDb} param={outputTrim} onChange={onParamChange} />
        </section>
      )}

      {presetManagerOpen && (
        <section
          ref={presetManagerDialogRef}
          id="nam-preset-manager-dialog"
          className="nam-preset-manager"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nam-preset-manager-dialog-title"
          tabIndex={-1}
          onKeyDown={onPresetManagerDialogKeyDown}
        >
          <div className="nam-preset-manager-head">
            <div>
              <span>Preset Library</span>
              <strong id="nam-preset-manager-dialog-title">{displayPresetName}{isPresetDirty ? " - edited" : ""}</strong>
            </div>
            <button type="button" onClick={closePresetManagerDialog} title="Close preset manager" aria-label="Close preset manager">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="nam-preset-search">
            <Search size={14} />
            <input
              data-nam-dialog-initial-focus="true"
              aria-label="Search presets"
              value={presetSearch}
              onChange={(event) => setPresetSearch(event.currentTarget.value)}
              placeholder="Search presets"
            />
          </div>
          <div className="nam-preset-filter-row" aria-label="Preset filters">
            {[
              ["all", "All"],
              ["favorites", "Favorites"],
              ["recent", "Recent"],
              ...presetFolders.map((folder) => [folder, folder] as [string, string]),
            ].map(([id, label]) => (
              <button
                type="button"
                key={id}
                data-active={presetFolderFilter === id}
                aria-pressed={presetFolderFilter === id}
                onClick={() => setPresetFolderFilter(id)}
                title={id === "all" ? `${userPresets.length} user presets` : id === "favorites" || id === "recent" ? label : `${presetFolderCounts.get(id) ?? 0} presets in ${label}`}
              >
                {label}
                {id !== "all" && id !== "favorites" && id !== "recent" && (
                  <small>{presetFolderCounts.get(id) ?? 0}</small>
                )}
              </button>
            ))}
          </div>
          <div className="nam-preset-save-row">
            <div className="nam-preset-save-fields">
              <input
                value={presetNameDraft}
                onChange={(event) => setPresetNameDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveUserPreset();
                }}
                placeholder={`${displayPresetName} custom`}
                aria-label="Preset name"
              />
              <input
                value={presetFolderDraft}
                onChange={(event) => setPresetFolderDraft(sanitizePresetFolder(event.currentTarget.value))}
                placeholder="Collection"
                aria-label="Preset collection"
                list="nam-preset-folder-list"
              />
              <datalist id="nam-preset-folder-list">
                {presetFolders.map((folder) => (
                  <option key={folder} value={folder} />
                ))}
              </datalist>
              <input
                value={presetTagsDraft}
                onChange={(event) => setPresetTagsDraft(event.currentTarget.value)}
                placeholder="Tags, comma separated"
                aria-label="Preset tags"
              />
              <input
                value={presetNotesDraft}
                onChange={(event) => setPresetNotesDraft(event.currentTarget.value)}
                placeholder="Notes"
                aria-label="Preset notes"
              />
            </div>
            <button type="button" onClick={() => void saveUserPreset()} disabled={presetManagerBusy}>
              <Save size={13} />
              Save As
            </button>
          </div>
          <div className="nam-preset-transfer-row" aria-label="Preset import and export">
            <button type="button" onClick={() => void importUserPreset()} disabled={presetManagerBusy || presetBusy}>
              <Upload size={13} />
              Import
            </button>
            <button type="button" onClick={() => void exportCurrentPreset()} disabled={presetManagerBusy || presetBusy}>
              <Download size={13} />
              Export Current
            </button>
          </div>
          {presetStatus && <p className="nam-preset-status">{presetStatus}</p>}
          <div className="nam-preset-manager-grid">
            <div className="nam-preset-column">
              <span>Templates for Current Capture</span>
              <div className="nam-preset-list">
                {filteredFactoryPresets.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    data-active={entry.id === presetId}
                    aria-current={entry.id === presetId ? "true" : undefined}
                    onClick={() => void applyPreset(entry)}
                    disabled={presetBusy || presetManagerBusy}
                  >
                    <strong>{entry.name}</strong>
                    <small>{entry.description}</small>
                  </button>
                ))}
                {filteredFactoryPresets.length === 0 && <em>No Templates for Current Capture match</em>}
              </div>
            </div>
            <div className="nam-preset-column">
              <span>User Presets</span>
              <div className="nam-preset-list">
                {filteredUserPresets.map((entry) => (
                  <div className="nam-user-preset-row" key={entry.name} data-favorite={Boolean(presetMetadata[entry.name]?.favorite)}>
                    <button
                      type="button"
                      onClick={() => void loadUserPreset(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title={entry.path}
                    >
                      <strong>{entry.name}</strong>
                      <small>{presetMetadata[entry.name]?.folder || "Unfiled"}{presetMetadata[entry.name]?.lastUsed ? " - Recent" : ""}</small>
                      {(presetMetadata[entry.name]?.tags ?? []).length > 0 && (
                        <span>
                          {(presetMetadata[entry.name]?.tags ?? []).slice(0, 4).map((tag) => (
                            <em key={tag}>{tag}</em>
                          ))}
                        </span>
                      )}
                      {presetMetadata[entry.name]?.notes && <small>{presetMetadata[entry.name]?.notes}</small>}
                    </button>
                    <button
                      type="button"
                      onClick={() => togglePresetFavorite(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title={presetMetadata[entry.name]?.favorite ? "Unfavorite preset" : "Favorite preset"}
                      aria-label={presetMetadata[entry.name]?.favorite ? `Remove ${entry.name} from favorites` : `Add ${entry.name} to favorites`}
                      aria-pressed={Boolean(presetMetadata[entry.name]?.favorite)}
                    >
                      <Star size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => editPresetFolder(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title="Set folder"
                    >
                      <FolderOpen size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => editPresetTags(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title="Set tags"
                    >
                      <Tag size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => editPresetNotes(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title="Edit notes"
                    >
                      <MessageSquare size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void exportUserPreset(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title="Export preset"
                    >
                      <Download size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void duplicateUserPreset(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title="Duplicate preset"
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void renameUserPreset(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title="Rename preset"
                    >
                      <Edit3 size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteUserPreset(entry.name)}
                      disabled={presetBusy || presetManagerBusy}
                      title="Delete preset"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                {filteredUserPresets.length === 0 && <em>No saved presets yet</em>}
              </div>
            </div>
          </div>
        </section>
      )}

      <Modal
        isOpen={Boolean(presetPrompt)}
        onClose={() => settlePresetPrompt(null)}
        size="sm"
        title={presetPrompt?.title}
        className="nam-rack-prompt-modal"
        footer={presetPrompt ? (
          <>
            <button type="button" className="nam-rack-prompt-cancel" onClick={() => settlePresetPrompt(null)}>Cancel</button>
            <button
              type="button"
              className="nam-rack-prompt-confirm"
              data-destructive={Boolean(presetPrompt.destructive)}
              onClick={() => settlePresetPrompt(presetPrompt.kind === "confirm" ? "confirmed" : presetPrompt.value)}
            >
              {presetPrompt.confirmLabel}
            </button>
          </>
        ) : undefined}
      >
        {presetPrompt && (
          <div className="nam-rack-prompt-body">
            <p>{presetPrompt.message}</p>
            {presetPrompt.kind === "input" && (presetPrompt.multiline ? (
              <textarea
                autoFocus
                rows={4}
                value={presetPrompt.value}
                placeholder={presetPrompt.placeholder}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setPresetPrompt((current) => current ? { ...current, value } : current);
                }}
              />
            ) : (
              <input
                autoFocus
                value={presetPrompt.value}
                placeholder={presetPrompt.placeholder}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setPresetPrompt((current) => current ? { ...current, value } : current);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") settlePresetPrompt(presetPrompt.value);
                }}
              />
            ))}
          </div>
        )}
      </Modal>

      {(activeView === "browse" || activeView === "mixer") && (
        <section className="nam-chain" aria-label="NAM Rack signal chain" data-editable={!stageLocked && !slotOrderBusy} data-locked={stageLocked || slotOrderBusy} data-slot-status={slotActionStatus}>
        <div className="nam-chain-meta">
          <span>Rig Lane</span>
          <strong>Post-cab order is editable. Capture spine routing is fixed.</strong>
          <button
            type="button"
            onClick={resetSlotOrder}
            disabled={slotOrderBusy || sameRackSlotOrder(slotOrder, DEFAULT_RACK_SLOT_ORDER)}
            title="Reset rig lane order"
          >
            <RotateCcw size={12} />
            Reset
          </button>
          <button
            type="button"
            onClick={() => setSlotBrowserOpen((open) => !open)}
            data-active={slotBrowserOpen}
            title="Open slot browser"
          >
            <Plus size={12} />
            Slots
          </button>
        </div>
        <div className="nam-chain-slots">
          {visibleSlotOrder.map((moduleId) => {
            const spec = rackModuleSpecs[moduleId];
            const slotIndex = visibleSlotOrder.indexOf(moduleId);
            const draggable = !stageLocked && !slotOrderBusy && !isLockedSpineModule(moduleId);
            const previousSlot = visibleSlotOrder[slotIndex - 1];
            const nextSlot = visibleSlotOrder[slotIndex + 1];
            const canMovePrevious = draggable && Boolean(previousSlot) && isValidRackSlotDrop(slotOrder, moduleId, previousSlot);
            const canMoveNext = draggable && Boolean(nextSlot) && isValidRackSlotDrop(slotOrder, moduleId, nextSlot);
            const dropAllowed = Boolean(draggedSlot && isValidRackSlotDrop(visibleSlotOrder, draggedSlot, moduleId));
            return (
              <RackModule
                key={moduleId}
                icon={spec.icon}
                label={spec.label}
                caption={spec.caption}
                active={spec.active}
                favorite={favoriteSlots.includes(moduleId)}
                selected={false}
                onClick={() => enterRackModule(moduleId)}
                power={spec.power}
                draggable={draggable}
                dragging={draggedSlot === moduleId}
                dropTarget={dropTargetSlot === moduleId}
                dropAllowed={dropAllowed}
                onDragStart={(event) => {
                  if (!draggable) return;
                  beginSlotDrag(moduleId);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", moduleId);
                }}
                onDragEnd={() => endSlotDrag()}
                onDragOver={(event) => {
                  if (stageLocked || slotOrderBusy || !draggedSlot) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = dropAllowed ? "move" : "none";
                  previewSlotDrop(moduleId);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  dropSlotOn(moduleId);
                }}
                canMovePrevious={canMovePrevious}
                canMoveNext={canMoveNext}
                onMovePrevious={() => moveSlotBy(moduleId, -1)}
                onMoveNext={() => moveSlotBy(moduleId, 1)}
                extraAction={spec.extraAction}
              />
            );
          })}
          {draggedSlot && (
            <div className="nam-chain-drag-overlay" data-qa="nam-chain-drag-overlay" aria-hidden="true">
              <GripVertical size={13} />
              <span>{moduleTitle(draggedSlot)}</span>
            </div>
          )}
        </div>
        </section>
      )}

      {slotBrowserOpen && (
        <section className="nam-slot-browser" aria-label="NAM Rack slot browser">
          <div className="nam-slot-browser-tabs">
            {slotBrowserCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                data-active={slotBrowserCategory === category.id}
                onClick={() => setSlotBrowserCategory(category.id)}
              >
                {category.label}
              </button>
            ))}
          </div>
          <div className="nam-slot-browser-grid">
            {activeSlotBrowserCategory.modules.map((moduleId) => {
              const spec = rackModuleSpecs[moduleId];
              const copy = moduleCopies[moduleId];
              const isFavorite = favoriteSlots.includes(moduleId);
              const embeddedCabSlot = moduleId === "cab" && embeddedCabCapture;
              const canBrowse = moduleId === "amp" || moduleId === "cab";
              return (
                <article key={moduleId} className="nam-slot-browser-card" data-active={spec.active} data-favorite={isFavorite}>
                  <div className="nam-slot-browser-card-head">
                    <span className="nam-chain-icon">{spec.icon}</span>
                    <div>
                      <strong>{spec.label}</strong>
                      <small>{spec.caption}</small>
                    </div>
                  </div>
                  <p>{moduleStageBody(moduleId)}</p>
                  <div className="nam-slot-browser-actions">
                    <button type="button" onClick={() => enterRackModule(moduleId)}>
                      <SlidersHorizontal size={12} />
                      Focus
                    </button>
                    {canBrowse && (
                      <button
                        type="button"
                        onClick={() => {
                          if (embeddedCabSlot) openAmpOnlyCaptureLibrary();
                          else if (moduleId === "cab") openCabIRLibrary();
                          else if (moduleId === "amp") {
                            openNAMCaptureLibrary(moduleId);
                          }
                        }}
                      >
                        <Library size={12} />
                        {embeddedCabSlot ? "Amp-Only Captures" : "Replace"}
                      </button>
                    )}
                    {!embeddedCabSlot && <button type="button" onClick={() => toggleSlotFavorite(moduleId)} data-active={isFavorite}>
                      <Star size={12} />
                      {isFavorite ? "Favorited" : "Favorite"}
                    </button>}
                    {!embeddedCabSlot && <button type="button" onClick={() => duplicateSlotSettings(moduleId)}>
                      <Copy size={12} />
                      Duplicate
                    </button>}
                    {copy && !embeddedCabSlot && (
                      <button type="button" onClick={() => void applySlotCopy(moduleId)}>
                        <Download size={12} />
                        Apply Copy
                      </button>
                    )}
                    {!embeddedCabSlot && <button type="button" onClick={() => void resetSlotModule(moduleId)}>
                      <RotateCcw size={12} />
                      Reset
                    </button>}
                    {!embeddedCabSlot && <button type="button" onClick={() => void removeSlotModule(moduleId)}>
                      <Trash2 size={12} />
                      {moduleId === "amp" ? "Reset Amp" : "Remove"}
                    </button>}
                  </div>
                  {copy && !embeddedCabSlot && (
                    <small className="nam-slot-browser-copy">
                      Duplicate saved {formatIRLastUsed(copy.capturedAt)}
                    </small>
                  )}
                </article>
              );
            })}
          </div>
          {slotActionStatus && <p className="nam-slot-browser-status">{slotActionStatus}</p>}
        </section>
      )}

      {modelState?.lastLoadError && (
        <div className="nam-rack-error" role="status">
          {modelState.lastLoadError}
        </div>
      )}
      {slotOrderError && (
        <div className="nam-rack-error" role="alert" data-qa="nam-post-order-error">
          {slotOrderError}
        </div>
      )}

      <NAMRackDiagnostics state={inputDiagnostics} />

      <main
        className="nam-product-main"
        data-view={activeView}
        inert={calibrationOpen || presetManagerOpen || saveToneOpen ? true : undefined}
        aria-hidden={calibrationOpen || presetManagerOpen || saveToneOpen ? true : undefined}
      >
        {activeView === "rack" && (
          <section className="nam-rack-stage-view" data-module={focusedModule} data-locked={stageLocked || slotOrderBusy} ref={stageViewRef}>
            {libraryFlow ? (
              <section className="nam-source-flow-host" data-flow={libraryFlow} aria-label="NAM Rack source library">
                <NAMExplorer
                  address={address}
                  schema={schema}
                  onRefreshRack={onRefreshRack}
                  intent={explorerIntent}
                  variant="source-flow"
                  libraryFlow={libraryFlow}
                  runtimeStatus={{
                    sampleRateLabel: modeRailStatus.sampleRateLabel,
                    bufferLabel: modeRailStatus.bufferLabel,
                    latencyLabel: modeRailStatus.latencyLabel,
                    cpuLabel: modeRailStatus.cpu?.label,
                    cpuAlert: modeRailStatus.cpu?.alert,
                    dspLabel: modeRailStatus.dsp.label,
                    dspAlert: modeRailStatus.dsp.alert,
                    inputLevelDb: inputMeterDb,
                    outputLevelDb: outputMeterDb,
                  }}
                  runtimeTempo={runtimeTempo}
                  runtimeTimeSignature={runtimeTimeSignature}
                  rackSizePercent={rackStageSizePercent}
                  rackPresetName={hasAmpModel || Boolean(missingAmpAsset) ? displayPresetName : "Start a New Rig"}
                  rackPresetDirty={(hasAmpModel || Boolean(missingAmpAsset)) && isPresetDirty}
                  compareSlot={compareSlot}
                  calibration={{
                    label: calibrationBadgeLabel,
                    status: calibrationBadgeStatus,
                    open: calibrationOpen,
                  }}
                  tunerOpen={rackRailTab === "tuner"}
                  signalChainOpen={chainOpen}
                  sourceOriginLabel={libraryFlow === "fx" ? focusedModule === "eq" ? "EQ" : moduleTitle(focusedModule) : undefined}
                  sourceReturnLabel={libraryFlow === "fx" ? `Back to ${focusedModule === "eq" ? "EQ" : moduleTitle(focusedModule)}` : undefined}
                  onReturn={returnFromLibraryFlow}
                  onOpenIRSources={() => openSourceFlow("ir")}
                  onEnterRackSection={(sectionId) => enterRackSection(sectionId, {
                    pre: "pedal",
                    amp: "amp",
                    cab: "cab",
                    eq: "eq",
                    post: "delay",
                  }[sectionId] as RackModuleId)}
                  onPreviousPreset={headerPresetNavigation.previous
                    ? () => void applyHeaderPresetTarget(headerPresetNavigation.previous)
                    : undefined}
                  onNextPreset={headerPresetNavigation.next
                    ? () => void applyHeaderPresetTarget(headerPresetNavigation.next)
                    : undefined}
                  onSavePreset={openSaveToneModal}
                  onOpenPresetManager={() => setPresetManagerOpen((open) => !open)}
                  onRecallCompare={(slot) => void recallCompareSlot(slot)}
                  onOpenCalibration={() => setCalibrationOpen((open) => !open)}
                  onOpenTuner={() => {
                    setLibraryFlow(null);
                    setActiveView("rack");
                    setRackRailTab((current) => current === "tuner" ? "tones" : "tuner");
                  }}
                  onOpenSignalChain={toggleCompactChain}
                  onOpenAdvanced={openContextualAdvancedControls}
                  onCycleSize={cycleStageZoom}
                  onMaxSize={() => setRackStageSizePercent(220)}
                />
              </section>
            ) : (
            <>
            <div className="nam-stage-hero">
              <div className="nam-stage-hero-head">
                <div className="nam-focus-copy">
                  <span>{moduleTitle(focusedModule)}</span>
                  <strong>{displayPresetName}{isPresetDirty ? " - edited" : ""}</strong>
                  <small>{preset.description}</small>
                </div>
                <div className="nam-focus-actions">
                  {focusedModule === "amp" && (
                    <>
                      <button
                        type="button"
                        className="nam-primary-stage-action"
                        onClick={() => openNAMCaptureLibrary(focusedModule)}
                        title="Open the Capture Library"
                      >
                        <Library size={14} />
                        Browse Captures
                      </button>
                      <button
                        type="button"
                        onClick={() => openLocalNAMCaptureLibrary(focusedModule)}
                        title="Open the Local .nam loader for the Amp slot"
                      >
                        <FolderOpen size={14} />
                        Local .nam...
                      </button>
                    </>
                  )}
                  {focusedModule === "cab" && (
                    <>
                      {embeddedCabCapture ? (
                        <button type="button" className="nam-primary-stage-action" onClick={openAmpOnlyCaptureLibrary} title="Choose an amp-only Capture before using an external IR">
                          <Library size={14} />
                          Browse Amp-Only Captures
                        </button>
                      ) : (
                        <>
                          <button type="button" className="nam-primary-stage-action" onClick={openCabIRLibrary} title="Open the cabinet IR library">
                            <Library size={14} />
                            {cabPresentation.recommendedActionLabel}
                          </button>
                          {cabPresentation.canLoadLocalIR && (
                            <button type="button" onClick={() => void loadCabIR()} disabled={cabBusy} title="Load a local cabinet impulse response">
                              <FolderOpen size={14} />
                              {cabBusy ? "Loading" : "Local IR"}
                            </button>
                          )}
                        </>
                      )}
                      {cabPresentation.canClearExternalIR && (
                        <button type="button" onClick={() => void clearCabIR()} disabled={cabBusy} title="Clear cabinet impulse response">
                          Clear IR
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              <NAMRackDesignPort
                sectionId={activeRackSection}
                rackSizePercent={rackStageSizePercent}
                parameters={params}
                rig={{
                  presetName: displayPresetName,
                  presetEyebrow: displayPresetEyebrow,
                  presetDirty: isPresetDirty,
                  pedalLabel: pedalName,
                  hasPedalCapture: hasPedalModel,
                  ampLabel: hardwareAmpLabel,
                  cabLabel: hardwareCabLabel,
                  cabStatus: rightRailCab.status,
                  hasAmpCapture: hasAmpModel,
                  ampCaptureMissing: Boolean(missingAmpAsset),
                  hasCabIR,
                  cabMode: cabPresentation.mode,
                }}
                runtime={{
                  tempo: runtimeTempo,
                  timeSignatureLabel: runtimeTimeSignature
                    ? `${runtimeTimeSignature.numerator}/${runtimeTimeSignature.denominator}`
                    : "--",
                  sampleRateLabel: modeRailStatus.sampleRateLabel,
                  bufferLabel: modeRailStatus.bufferLabel,
                  latencyLabel: modeRailStatus.latencyLabel,
                  cpuLabel: modeRailStatus.cpu?.label,
                  cpuAlert: modeRailStatus.cpu?.alert,
                  dspLabel: modeRailStatus.dsp.label,
                  dspAlert: modeRailStatus.dsp.alert,
                  diagnosticTone: modelState?.lastLoadError ? "error" : inputDiagnosticTone,
                  diagnosticMessage: modelState?.lastLoadError || diagnosticsMessage,
                  inputLevelDb: inputMeterDb,
                  outputLevelDb: outputMeterDb,
                }}
                recovery={designPortRecovery}
                tuner={rightRailTuner}
                calibration={{
                  label: calibrationBadgeLabel,
                  status: calibrationBadgeStatus,
                  open: calibrationOpen,
                }}
                libraryItems={designPortLibraryItems}
                compareSlot={compareSlot}
                tunerOpen={rackRailTab === "tuner"}
                signalChainOpen={chainOpen}
                onParamChange={onDesignPortParamChange}
                onEnterSection={enterRackSection}
                onOpenAdvancedStage={openAdvancedControls}
                onBrowseAmpCapture={() => openNAMCaptureLibrary("amp")}
                onBrowseLocalAmpCapture={() => openSourceFlow("amp", undefined, "local")}
                onBrowseAmpOnlyCapture={openAmpOnlyCaptureLibrary}
                onBrowseCabIR={cabPresentation.canBrowseExternalIR ? openCabIRLibrary : undefined}
                onBrowseLocalCabIR={cabPresentation.canLoadLocalIR ? () => void loadCabIR() : undefined}
                onOpenLibrary={openDesignPortLibrary}
                onPreviousPreset={headerPresetNavigation.previous
                  ? () => void applyHeaderPresetTarget(headerPresetNavigation.previous)
                  : undefined}
                onNextPreset={headerPresetNavigation.next
                  ? () => void applyHeaderPresetTarget(headerPresetNavigation.next)
                  : undefined}
                onSaveTone={openSaveToneModal}
                onOpenPresetManager={() => setPresetManagerOpen((open) => !open)}
                onRecallCompare={(slot) => void recallCompareSlot(slot)}
                onOpenCalibration={() => setCalibrationOpen((open) => !open)}
                onSelectLibraryItem={(itemId) => {
                  const selectedPreset = NAM_RACK_PRESETS.find((entry) => entry.id === itemId);
                  if (selectedPreset) void applyPreset(selectedPreset);
                }}
                onOpenTuner={() => setRackRailTab((current) => current === "tuner" ? "tones" : "tuner")}
                onOpenSignalChain={toggleCompactChain}
                onOpenSettings={rackWindowCapabilities.canOpenAppAudio ? openSettings : undefined}
                onOpenAdvanced={openContextualAdvancedControls}
                onCycleSize={cycleStageZoom}
                onMaxSize={() => setRackStageSizePercent(220)}
              />
              <NAMRackStageFooter
                diagnosticTone={inputDiagnosticTone}
                tempo={runtimeTempo}
                timeSignature={runtimeTimeSignature}
                stageLocked={stageLocked || slotOrderBusy}
                stageZoomPercent={rackStageSizePercent}
                onToggleLock={() => {
                  if (!slotOrderBusy) setStageLocked((locked) => !locked);
                }}
                onCycleZoom={cycleStageZoom}
                onSetZoomPercent={(zoomPercent) => setRackStageSizePercent(coerceRackStageSizePercent(zoomPercent))}
              />
            </div>

            <NAMRackRightRail
              rackRailTab={rackRailTab}
              address={address}
              schema={schema}
              explorerIntent={explorerIntent}
              gear={rightRailGear}
              cab={rightRailCab}
              saved={rightRailSaved}
              tuner={rightRailTuner}
              onRefreshRack={onRefreshRack}
              onShowGear={() => setRackRailTab("gear")}
              onOpenTones={() => openRackToneRail()}
              onOpenCab={openCabIRLibrary}
              onShowSaved={() => setRackRailTab("saved")}
              onBrowseAmp={() => openNAMCaptureLibrary("amp")}
              onSearchIRs={openRackCabToneSearch}
              onLoadLocalIR={() => void loadCabIR()}
              onClearIR={() => void clearCabIR()}
              onApplyIRPath={(path) => void applyCabIRPath(path)}
              onOpenPresetManager={() => setPresetManagerOpen((open) => !open)}
              onSaveTone={openSaveToneModal}
              onLoadUserPreset={(name) => void loadUserPreset(name)}
              onLoadFactoryPreset={(id) => {
                const selectedPreset = filteredFactoryPresets.find((entry) => entry.id === id);
                if (selectedPreset) void applyPreset(selectedPreset);
              }}
            />

            <NAMRackModeRail
              rackRailTab={rackRailTab}
              slotBrowserOpen={chainOpen}
              status={modeRailStatus}
              onShowGear={() => setRackRailTab("gear")}
              onToggleChain={toggleCompactChain}
              onOpenMixer={openContextualAdvancedControls}
              onOpenTuner={() => setRackRailTab("tuner")}
            />
            {chainOpen && (
              <NAMCompactChain
                fixedPre={signalChainFixedPre}
                captureCore={signalChainCaptureCore}
                reorderablePost={signalChainPost}
                tail={signalChainTail}
                postOrderLocked={stageLocked || slotOrderBusy}
                onTogglePostOrderLock={() => {
                  if (!slotOrderBusy) setStageLocked((locked) => !locked);
                }}
                onResetPostOrder={resetSlotOrder}
                resetPostOrderDisabled={slotOrderBusy || sameRackSlotOrder(slotOrder, DEFAULT_RACK_SLOT_ORDER)}
                onClose={() => setChainOpen(false)}
              />
            )}
            </>
            )}
          </section>
        )}

        {activeView === "browse" && (
          <section className="nam-browser-drawer nam-browser-drawer-full">
            <div className="nam-browser-title">
              <Library size={15} />
            <div>
              <strong>TONE3000 Explorer</strong>
              <small>TONE3000 Capture catalog</small>
            </div>
            </div>
            <NAMExplorer address={address} schema={schema} onRefreshRack={onRefreshRack} intent={explorerIntent} />
          </section>
        )}

        {activeView === "mixer" && (
          <NAMRackMixerView
            stages={mixerStageSpecs}
            postCabOrderLabel={postCabOrderLabel}
            ampActive={ampActive}
            hasCabIR={hasCabIR}
            onParamChange={onDesignPortParamChange}
            formatDb={formatDb}
            meterPercent={meterPercent}
            focusedStageId={advancedFocus}
            onSelectStage={setAdvancedFocus}
            onClose={() => {
              setAdvancedFocus(null);
              setActiveView("rack");
            }}
          />
        )}
      </main>
      <NAMToneSaveModal
        isOpen={saveToneOpen}
        draft={saveToneDraft}
        busy={saveToneBusy}
        onDraftChange={setSaveToneDraft}
        onClose={() => setSaveToneOpen(false)}
        onSave={() => void saveRackTone()}
      />
    </div>
  );
}

import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Funnel,
  Grid2X2,
  HardDrive,
  Heart,
  Info,
  KeyRound,
  List,
  LogIn,
  LogOut,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Square,
  Star,
  Trash2,
  WifiOff,
} from "lucide-react";
import {
  BuiltInPluginAddress,
  BuiltInPluginSchema,
  NAMCatalogModel,
  NAMCatalogTone,
  NAMInstalledModel,
  TONE3000AuthStatus,
  nativeBridge,
} from "../services/NativeBridge";
import {
  clearTONE3000Session,
  completeTONE3000ManualAuth,
  ensureTONE3000Session,
  refreshTONE3000Session,
  refreshTONE3000SessionStatus,
  startTONE3000InteractiveAuth,
  useTONE3000Session,
} from "../services/tone3000Session";
import {
  createNAMExplorerSessionEpoch,
  getNAMExplorerSessionView,
  NAMSessionResourceInvalidatedError,
  NAM_EXPLORER_SESSION_TTL_MS,
  namCatalogSession,
  namInstalledLibrarySession,
  namLibraryInfoSession,
  namLiveSearchPageSession,
  namToneDetailSession,
  setNAMExplorerSessionView,
  updateNAMExplorerSessionScroll,
} from "../services/namExplorerSession";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, Input, Modal } from "./ui";
import {
  NAMToneSaveModal,
  buildNAMToneSaveDraft,
  clearNAMActivePreview,
  emptyToneSaveDraft,
  makeNAMActivePreview,
  normalizeNAMActivePreview,
  saveDraftToMetadata,
  saveNAMTone,
  type NAMToneSaveDraft,
  type NAMPreviewBaseline,
  type NAMToneSlot,
} from "./NAMToneSave";
import {
  getNAMDesignBodyAsset,
  getNAMDesignControlAsset,
  type NAMDesignBodyAssetId,
  type NAMDesignControlAssetId,
} from "./NAMDesignAssets";
import {
  NAMRackSourceFlowDesignPort,
  sourceFlowDesignBoardForMode,
  type NAMSourceFlowDesignActionId,
  type NAMSourceFlowDesignConfig,
  type NAMSourceFlowDesignPortMessage,
  type NAMSourceFlowDesignResult,
  type NAMRackDesignCalibrationSummary,
  type NAMRackDesignRuntimeStatus,
} from "./NAMRackDesignPort";
import { firstNAMDisplayName, namDisplayNameFromPath, resolveNAMToneIdentity } from "../utils/namDisplayName";
import {
  captureIncludesCab,
  captureTypeForInstalled,
  captureTypeForToneModel,
  normalizeNAMCaptureType,
  targetSlotForCapture,
  type NAMCaptureType,
} from "../utils/namCaptureType";
import { buildNAMModulePresetCommitValues } from "../utils/namRackPresetTransactions";
import {
  buildTONE3000LiveSearchSnapshot,
  createTONE3000QueryDebouncer,
  createTONE3000SearchEpoch,
  type TONE3000LiveSearchSnapshot,
} from "../utils/tone3000LiveSearch";
import {
  createTONE3000AppendGate,
  observeTONE3000AppendSentinel,
  shouldRetryTONE3000Append,
  type TONE3000LiveSearchFailure,
} from "../utils/tone3000InfiniteAppend";
import {
  expectedNAMEffectiveCabEnabled,
  inspectNAMCaptureSchemaActivation,
  namCaptureUsePhaseLabel,
  waitForNAMCaptureActivation,
  type NAMCaptureUsePhase,
} from "../utils/namCaptureActivation";
import { windowRole } from "../utils/windowEnvironment";
import {
  namInstrumentLabelsAreCompatible,
  normalizeNAMInstrumentProfile,
  type NAMInstrumentProfile,
} from "../utils/namInstrumentProfile";

type NAMTab = "latest" | "trending" | "downloads-all-time" | "installed" | "favorites";
type NAMSlot = "amp" | "pedal";
type NAMTargetSlot = NAMToneSlot;
export type NAMLibraryFlowMode = "amp" | "pedal" | "ir" | "fx";
type NAMExplorerVariant = "full" | "rail" | "source-flow";
type NAMSourceFlowMode = "tone3000-amp-nam" | "tone3000-pedal-nam" | "ir-sources" | "openstudio-fx-collection";
type NAMSourceReturnTarget = "amp" | "pre" | "cab" | "post";
type NAMSourceFlowHeroKind = "model" | "ir" | "fx-preset";
type NAMSourceFlowRowActionPolicy = "model-preview" | "cab-ir-load" | "source-only" | "fx-preset";
export type OpenStudioFXModuleId = "eq" | "mod" | "delay" | "reverb";
type NAMSourceFlowFilterControl = {
  id: string;
  label: string;
  category: string;
  gearFilter?: string;
  localAction?: "load-local-ir" | "load-local-nam";
  externalSource?: boolean;
};
export type NAMExplorerIntent = {
  token: number;
  tab?: NAMTab;
  query?: string;
  architecture?: string;
  gearFilter?: string;
  libraryFlow?: NAMLibraryFlowMode;
  sourceFilter?: OpenStudioFXModuleId;
  categoryFilter?: string;
};
type NAMViewMode = "cards" | "list";
type NAMCatalogMode = "cache" | "live";
type NAMFeedbackTone = "info" | "success" | "warning" | "error" | "busy";
export type NAMLibraryAction = "select" | "live-preview" | "save" | "revert";
type NAMSortMode = "newest" | "trending" | "downloads-all-time" | "favorites-count" | "name-az";
type NAMShelf = "featured" | "latest-a2" | "trending" | "downloaded" | "clean" | "high-gain" | "pedals" | "full-rigs" | "irs" | "installed" | "favorites";
type NAMCatalogRow = {
  key: string;
  tone: NAMCatalogTone;
  model: NAMCatalogModel;
};

export function resolveNAMCatalogSelection(
  rows: NAMCatalogRow[],
  selectedKey: string,
  fallback: NAMCatalogRow | null = null,
) {
  const exact = rows.find((row) => row.key === selectedKey);
  if (exact) return exact;

  // Live search rows intentionally begin as summary-only records with a
  // placeholder model ID. Hydrating the chosen tone replaces that placeholder
  // with real model rows and therefore changes their keys. Keep the selected
  // tone visible throughout that transaction instead of mistaking the key
  // change for an empty search result.
  const selectedKeyParts = selectedKey.split(":");
  const selectedToneId = Number.parseInt(selectedKeyParts[0] ?? "", 10);
  const selectedModelId = Number.parseInt(selectedKeyParts[1] ?? "", 10);
  if (Number.isFinite(selectedToneId)) {
    if (Number.isFinite(selectedModelId) && selectedModelId > 0) {
      const sameModel = rows.find((row) => (
        toneIdOf(row.tone) === selectedToneId
        && modelIdOf(row.model) === selectedModelId
      ));
      if (sameModel) return sameModel;
    }
    const sameTone = rows.find((row) => toneIdOf(row.tone) === selectedToneId);
    if (sameTone) return sameTone;
  }

  return selectedKey ? null : fallback;
}
export type NAMSourceFlowConfig = {
  mode: NAMLibraryFlowMode;
  sourceMode: NAMSourceFlowMode;
  originLabel: string;
  returnLabel: string;
  returnTarget: NAMSourceReturnTarget;
  sourceLabel: string;
  targetLabel: string;
  targetSlot: NAMTargetSlot | "delay";
  breadcrumb: string;
  searchPlaceholder: string;
  defaultQuery: string;
  defaultGearFilter: string;
  detailTitle: string;
  detailSubtitle: string;
  sourceOnlyDetailTitle?: string;
  sourceOnlyDetailSubtitle?: string;
  heroKind: NAMSourceFlowHeroKind;
  rowActionPolicy: NAMSourceFlowRowActionPolicy;
  emptyTitle: string;
  emptyBody: string;
  showArchitectureFilter?: boolean;
  bodyAssetId: NAMDesignBodyAssetId;
  fxBodyAssetIds?: Record<OpenStudioFXModuleId, NAMDesignBodyAssetId>;
  controlAssetIds: NAMDesignControlAssetId[];
  lanes: Array<{ id: string; label: string; detail: string; active?: boolean; loadable?: boolean }>;
  filters: string[];
  filterControls: NAMSourceFlowFilterControl[];
};
export type OpenStudioFXPreset = {
  id: string;
  moduleId: OpenStudioFXModuleId;
  name: string;
  source: "openstudio";
  category: OpenStudioFXModuleId;
  description: string;
  values: Record<string, number>;
};
export type NAMRailCatalogActionState = {
  primaryTitle: string;
  primaryDisabled: boolean;
  primaryDisabledReason: string;
  loadTitle: string;
  loadDisabled: boolean;
  loadDisabledReason: string;
  loadIcon: "download" | "load" | "restore";
};
export type NAMRailInstalledActionState = {
  primaryTitle: string;
  primaryDisabled: boolean;
  primaryDisabledReason: string;
  loadTitle: string;
  loadDisabled: boolean;
  loadDisabledReason: string;
  loadIcon: "load" | "restore";
};
type NAMAuditionState = {
  key: string;
  slot: NAMTargetSlot;
  toneId: number;
  modelId: number;
  title: string;
  modelName: string;
  creator: string;
  localPath: string;
  previousPath: string;
  source: "catalog" | "installed" | "local";
  previewDownload: boolean;
  saved: boolean;
  action: NAMLibraryAction;
  record?: NAMInstalledModel;
  sourceUrl?: string;
  license?: string;
  checksum?: string;
  captureType: NAMCaptureType;
  includesCab: boolean;
  baseline: NAMPreviewBaseline;
  provisionalPublication?: {
    slot: NAMTargetSlot;
    localPath: string;
    cabRequestedEnabled?: boolean;
    effectiveCabEnabled?: number;
    pedalMix?: number;
    ampEnabled?: number;
    ampMix?: number;
  };
};

type NAMQueuedRackAction = {
  generation: number;
  label: string;
  run: () => Promise<void>;
};

type NAMRackTransactionEntry = {
  busy: boolean;
  generation: number;
  listeners: Set<(busy: boolean) => void>;
};

const namRackTransactions = new Map<string, NAMRackTransactionEntry>();

function namRackTransactionKey(address: BuiltInPluginAddress) {
  return `${address.trackId || ""}\u0000${address.chain}\u0000${address.fxIndex ?? -1}`;
}

function namRackTransactionEntry(key: string) {
  let entry = namRackTransactions.get(key);
  if (!entry) {
    entry = { busy: false, generation: 0, listeners: new Set() };
    namRackTransactions.set(key, entry);
  }
  return entry;
}

function notifyNAMRackTransaction(entry: NAMRackTransactionEntry) {
  for (const listener of entry.listeners) listener(entry.busy);
}

function beginNAMRackTransaction(key: string) {
  const entry = namRackTransactionEntry(key);
  if (entry.busy) return null;
  entry.busy = true;
  entry.generation += 1;
  notifyNAMRackTransaction(entry);
  return entry.generation;
}

function isNAMRackTransactionCurrent(key: string, generation: number) {
  const entry = namRackTransactionEntry(key);
  return entry.busy && entry.generation === generation;
}

function isNAMRackTransactionLatest(key: string, generation: number) {
  return namRackTransactionEntry(key).generation === generation;
}

function isNAMRackTransactionBusy(key: string) {
  return namRackTransactionEntry(key).busy;
}

function finishNAMRackTransaction(key: string, generation: number) {
  const entry = namRackTransactionEntry(key);
  if (!entry.busy || entry.generation !== generation) return;
  entry.busy = false;
  notifyNAMRackTransaction(entry);
}

function subscribeNAMRackTransaction(key: string, listener: (busy: boolean) => void) {
  const entry = namRackTransactionEntry(key);
  entry.listeners.add(listener);
  listener(entry.busy);
  return () => entry.listeners.delete(listener);
}

function previewBaselineFromState(state: unknown, fallback: BuiltInPluginSchema): NAMPreviewBaseline {
  const stateRecord = state && typeof state === "object" ? state as Record<string, any> : {};
  const modelState = stateRecord.modelState && typeof stateRecord.modelState === "object"
    ? stateRecord.modelState as Record<string, unknown>
    : fallback.modelState ?? {};
  const values = stateRecord.values && typeof stateRecord.values === "object"
    ? stateRecord.values as Record<string, unknown>
    : Object.fromEntries(fallback.parameters.map((param) => [param.id, param.value]));
  return {
    pedalModelPath: String(modelState.pedalModelPath ?? ""),
    ampModelPath: String(modelState.ampModelPath ?? ""),
    cabIRPath: String(modelState.cabIRPath ?? ""),
    pedalDeclaredCaptureType: firstDeclaredCaptureType(
      modelState.pedalDeclaredCaptureType,
      modelState.pedalCaptureType,
    ),
    ampDeclaredCaptureType: firstDeclaredCaptureType(
      modelState.ampDeclaredCaptureType,
      modelState.ampCaptureType,
    ),
    cabEnabled: Number(values.cabEnabled ?? 0),
    cabRequestedEnabled: typeof modelState.cabRequestedEnabled === "boolean"
      ? modelState.cabRequestedEnabled
      : Number(values.cabEnabled ?? 0) >= 0.5,
    pedalMix: Number(values.pedalMix ?? 0),
    ampEnabled: Number(values.ampEnabled ?? 1),
    ampMix: Number(values.ampMix ?? 1),
    pedalCalibrationMode: Number(values.pedalCalibrationMode ?? 1),
    pedalOverrideInputLevelDbu: Number(values.pedalOverrideInputLevelDbu ?? 12),
    pedalOverrideOutputLevelDbu: Number(values.pedalOverrideOutputLevelDbu ?? 12),
    ampCalibrationMode: Number(values.ampCalibrationMode ?? 1),
    ampOverrideInputLevelDbu: Number(values.ampOverrideInputLevelDbu ?? 12),
    ampOverrideOutputLevelDbu: Number(values.ampOverrideOutputLevelDbu ?? 12),
  };
}

function auditionFromActivePreview(preview: ReturnType<typeof normalizeNAMActivePreview>, fallback: BuiltInPluginSchema): NAMAuditionState | null {
  if (!preview?.localPath) return null;
  const source = preview.source === "installed" || preview.source === "local" ? preview.source : "catalog";
  const baseline = preview.baseline ?? previewBaselineFromState(null, fallback);
  return {
    key: preview.key || `${preview.slot}:${preview.modelId || preview.localPath}`,
    slot: preview.slot,
    toneId: Number(preview.toneId || 0),
    modelId: Number(preview.modelId || 0),
    title: preview.title || preview.record?.toneTitle || preview.record?.name || "NAM preview",
    modelName: preview.modelName || preview.record?.name || "NAM model",
    creator: preview.creator || preview.record?.creator || "TONE3000",
    localPath: preview.localPath,
    previousPath: preview.previousPath || (preview.slot === "amp" ? baseline.ampModelPath : preview.slot === "pedal" ? baseline.pedalModelPath : baseline.cabIRPath),
    source,
    previewDownload: Boolean(preview.previewDownload),
    saved: Boolean(preview.saved),
    action: preview.action ?? "live-preview",
    record: preview.record,
    sourceUrl: preview.sourceUrl,
    license: preview.license,
    checksum: preview.checksum,
    captureType: preview.captureType ?? (preview.record ? captureTypeForInstalled(preview.record) : "unknown"),
    includesCab: Boolean(preview.includesCab),
    baseline,
  };
}

export function provisionalNAMPreviewMatchesState(
  state: unknown,
  audition: NAMAuditionState | null,
) {
  const publication = audition?.provisionalPublication;
  if (!audition || audition.saved || !publication || !audition.localPath.trim()) return false;
  if (publication.slot !== audition.slot || !sameLocalPath(publication.localPath, audition.localPath)) return false;
  const stateRecord = state && typeof state === "object" ? state as Record<string, unknown> : {};
  const modelState = stateRecord.modelState && typeof stateRecord.modelState === "object"
    ? stateRecord.modelState as Record<string, unknown>
    : {};
  const values = stateRecord.values && typeof stateRecord.values === "object"
    ? stateRecord.values as Record<string, unknown>
    : {};
  const loadedPath = audition.slot === "amp"
    ? modelState.ampModelPath
    : audition.slot === "pedal"
      ? modelState.pedalModelPath
      : modelState.cabIRPath;
  const hasLoadedModel = audition.slot === "amp"
    ? modelState.hasAmpModel
    : audition.slot === "pedal"
      ? modelState.hasPedalModel
      : modelState.hasCabIR;
  if (!Boolean(hasLoadedModel) || !sameLocalPath(String(loadedPath ?? ""), audition.localPath)) return false;
  const pedalMix = Number(values.pedalMix);
  const ampEnabled = Number(values.ampEnabled);
  const ampMix = Number(values.ampMix);
  const effectiveCabEnabled = Number(values.cabEnabled);
  const requestedCabEnabled = modelState.cabRequestedEnabled;
  const expectedEffectiveCabEnabled = expectedNAMEffectiveCabEnabled(
    requestedCabEnabled === true,
    modelState.ampIncludesCab === true,
  );
  const cabinetInvariantHolds = typeof requestedCabEnabled === "boolean"
    && Number.isFinite(effectiveCabEnabled)
    && (effectiveCabEnabled >= 0.5) === expectedEffectiveCabEnabled;
  return cabinetInvariantHolds
    && (publication.cabRequestedEnabled === undefined
      || (typeof requestedCabEnabled === "boolean"
        && requestedCabEnabled === publication.cabRequestedEnabled))
    && (publication.effectiveCabEnabled === undefined
      || (Number.isFinite(effectiveCabEnabled)
        && Math.abs(effectiveCabEnabled - publication.effectiveCabEnabled) < 0.01))
    && (publication.pedalMix === undefined
      || (Number.isFinite(pedalMix) && Math.abs(pedalMix - publication.pedalMix) < 0.01))
    && (publication.ampEnabled === undefined
      || (Number.isFinite(ampEnabled) && Math.abs(ampEnabled - publication.ampEnabled) < 0.01))
    && (publication.ampMix === undefined
      || (Number.isFinite(ampMix) && Math.abs(ampMix - publication.ampMix) < 0.01));
}

function auditionFromAuthoritativeState(
  state: unknown,
  fallback: BuiltInPluginSchema,
  localAudition: NAMAuditionState | null,
) {
  const stateRecord = state && typeof state === "object" ? state as Record<string, unknown> : {};
  const uiState = stateRecord.uiState && typeof stateRecord.uiState === "object"
    ? stateRecord.uiState as Record<string, unknown>
    : {};
  const modelState = stateRecord.modelState && typeof stateRecord.modelState === "object"
    ? stateRecord.modelState as Record<string, unknown>
    : {};
  const verifiedLocalAudition = provisionalNAMPreviewMatchesState(state, localAudition)
    ? localAudition
    : null;
  if (verifiedLocalAudition) return verifiedLocalAudition;
  const backendAudition = auditionFromActivePreview(normalizeNAMActivePreview(uiState.namActivePreview), fallback);
  if (!backendAudition) return null;
  const loadedPath = backendAudition.slot === "amp"
    ? modelState.ampModelPath
    : backendAudition.slot === "pedal"
      ? modelState.pedalModelPath
      : modelState.cabIRPath;
  const hasLoadedModel = backendAudition.slot === "amp"
    ? modelState.hasAmpModel
    : backendAudition.slot === "pedal"
      ? modelState.hasPedalModel
      : modelState.hasCabIR;
  if (!Boolean(hasLoadedModel) || !sameLocalPath(String(loadedPath ?? ""), backendAudition.localPath)) {
    return null;
  }
  const localMatches = Boolean(localAudition
    && localAudition.slot === backendAudition.slot
    && sameLocalPath(localAudition.localPath, backendAudition.localPath));
  if (!localMatches || !localAudition) return backendAudition;
  return {
    ...localAudition,
    ...backendAudition,
    record: backendAudition.record ?? localAudition.record,
  };
}

const FAVORITES_KEY = "openstudio_nam_favorites";
const TONE3000_CLIENT_ID_KEY = "openstudio_tone3000_client_id";
const TONE3000_REDIRECT_URI_KEY = "openstudio_tone3000_redirect_uri";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:18762/tone3000/callback";
const NAM_TONE_CARD_ART = new URL("../assets/nam/amp-cab-card-v2.webp", import.meta.url).href;
const NAM_TONE_PREMIUM_ART = new URL("../assets/nam/amp-cab-premium-v2.webp", import.meta.url).href;
const NAM_TONE_FRONT_ART = new URL("../assets/nam/amp-cab-premium-front.webp", import.meta.url).href;
const NAM_PEDAL_CARD_ART = new URL("../assets/nam/pedal-card-v2.webp", import.meta.url).href;
const NAM_PEDAL_PREMIUM_ART = new URL("../assets/nam/pedal-premium-v2.webp", import.meta.url).href;
const NAM_PEDAL_BOOST_ART = new URL("../assets/nam/pedal-boost-library-v1.webp", import.meta.url).href;
const NAM_PEDAL_OVERDRIVE_ART = new URL("../assets/nam/pedal-overdrive-library-v1.webp", import.meta.url).href;
const NAM_PEDAL_FUZZ_ART = new URL("../assets/nam/pedal-fuzz-library-v1.webp", import.meta.url).href;
const NAM_PEDAL_DISTORTION_ART = new URL("../assets/nam/pedal-distortion-library-v1.webp", import.meta.url).href;
const NAM_CAB_CARD_ART = new URL("../assets/nam/cab-card.webp", import.meta.url).href;
const NAM_ROOM_CARD_ART = new URL("../assets/nam/room-ir-library-v1.webp", import.meta.url).href;
const NAM_FX_CHORUS_ART = new URL("../assets/nam/fx-chorus-library-v1.webp", import.meta.url).href;
const NAM_LIVE_PAGE_TARGETS: Record<NAMExplorerVariant, number> = {
  rail: 4,
  "source-flow": 12,
  full: 24,
};
const NAM_SORT_OPTIONS: Array<{ value: NAMSortMode; label: string; local: boolean }> = [
  { value: "trending", label: "Trending", local: false },
  { value: "newest", label: "Newest", local: false },
  { value: "downloads-all-time", label: "Most Downloaded", local: false },
  { value: "favorites-count", label: "Most Liked", local: false },
  { value: "name-az", label: "Name A-Z", local: true },
];
export const SUPPORTED_TONE3000_PEDAL_CATEGORIES = ["drive", "boost", "fuzz", "distortion", "overdrive"] as const;
const NAM_SOURCE_FLOW_CONFIGS: Record<NAMLibraryFlowMode, NAMSourceFlowConfig> = {
  amp: {
    mode: "amp",
    sourceMode: "tone3000-amp-nam",
    originLabel: "AMP",
    returnLabel: "Back to Amp",
    returnTarget: "amp",
    sourceLabel: "TONE3000 NAM",
    targetLabel: "Amp Capture",
    targetSlot: "amp",
    breadcrumb: "AMP / Capture Library / TONE3000 NAM / Amp Capture",
    searchPlaceholder: "Search TONE3000 amps, heads, full rigs",
    defaultQuery: "",
    defaultGearFilter: "amp_amp-cab",
    detailTitle: "Selected capture - Amp slot",
    detailSubtitle: "TONE3000 capture metadata",
    heroKind: "model",
    rowActionPolicy: "model-preview",
    emptyTitle: "No amp captures match",
    emptyBody: "Try a broader search, switch architecture, or return to Amp and load a local .nam capture.",
    showArchitectureFilter: true,
    bodyAssetId: "amp-head-body-wide",
    controlAssetIds: ["knob-black-top", "knob-metal-top", "toggle-chrome-top", "led-amber-on-top", "washer-chrome-top"],
    filters: ["All Amp Captures", "Amp Only (No Cab)", "Full Rig", "Local .nam", "A1", "A2"],
    filterControls: [
      { id: "amp-all", label: "All Amp Captures", category: "all", gearFilter: "amp_amp-cab" },
      { id: "amp-only", label: "Amp Only (No Cab)", category: "amp", gearFilter: "amp" },
      { id: "full-rig", label: "Full Rig", category: "full-rig", gearFilter: "amp-cab" },
      { id: "local-nam", label: "Local .nam", category: "local", localAction: "load-local-nam" },
    ],
    lanes: [
      { id: "tone3000", label: "TONE3000 NAM", detail: "Amp-only and full-rig captures", active: true, loadable: true },
      { id: "local-nam", label: "Local .nam", detail: "Load from disk into the Amp Capture slot", loadable: true },
      { id: "amp-target", label: "Amp Capture", detail: "Live-guitar audition routes here", active: true, loadable: true },
      { id: "cab-link", label: "Cab/IR", detail: "Open from Cab" },
    ],
  },
  pedal: {
    mode: "pedal",
    sourceMode: "tone3000-pedal-nam",
    originLabel: "PEDALS",
    returnLabel: "Back to Pedals",
    returnTarget: "pre",
    sourceLabel: "TONE3000 NAM Pedals",
    targetLabel: "Pedal Capture",
    targetSlot: "pedal",
    breadcrumb: "PEDALS / Capture Library / TONE3000 NAM Pedals / Pedal Capture",
    searchPlaceholder: "Search drive, boost, fuzz, distortion, overdrive",
    defaultQuery: "",
    defaultGearFilter: "pedal",
    detailTitle: "Selected capture - Pedal slot",
    detailSubtitle: "TONE3000 pedal metadata",
    heroKind: "model",
    rowActionPolicy: "model-preview",
    emptyTitle: "No supported pedal captures match",
    emptyBody: "Only Drive, Boost, Fuzz, Distortion, and Overdrive NAM captures can load into the Pedal Capture slot.",
    showArchitectureFilter: true,
    bodyAssetId: "stompbox-body-dark",
    controlAssetIds: ["knob-metal-top", "knob-black-top", "led-amber-on-top", "footswitch-chrome-off-top", "screw-phillips-top"],
    filters: ["Drive", "Boost", "Fuzz", "Distortion", "Overdrive", "Local .nam"],
    filterControls: [
      { id: "pedal-all", label: "All Pedals", category: "all", gearFilter: "pedal" },
      { id: "drive", label: "Drive", category: "drive", gearFilter: "pedal" },
      { id: "boost", label: "Boost", category: "boost", gearFilter: "pedal" },
      { id: "fuzz", label: "Fuzz", category: "fuzz", gearFilter: "pedal" },
      { id: "distortion", label: "Distortion", category: "distortion", gearFilter: "pedal" },
      { id: "overdrive", label: "Overdrive", category: "overdrive", gearFilter: "pedal" },
      { id: "local-nam", label: "Local .nam", category: "local", localAction: "load-local-nam" },
    ],
    lanes: [
      { id: "pedal-source", label: "TONE3000 NAM Pedals", detail: "Supported drive-family captures only", active: true, loadable: true },
      { id: "local-nam", label: "Local .nam", detail: "Load from disk into the Pedal Capture slot", loadable: true },
      { id: "drive", label: "Drive", detail: "Allowed pedal NAM type", active: true, loadable: true },
      { id: "boost", label: "Boost", detail: "Allowed pedal NAM type", active: true, loadable: true },
      { id: "fuzz", label: "Fuzz", detail: "Allowed pedal NAM type", active: true, loadable: true },
      { id: "distortion", label: "Distortion", detail: "Allowed pedal NAM type", active: true, loadable: true },
      { id: "overdrive", label: "Overdrive", detail: "Allowed pedal NAM type", active: true, loadable: true },
    ],
  },
  ir: {
    mode: "ir",
    sourceMode: "ir-sources",
    originLabel: "CAB",
    returnLabel: "Back to Cab",
    returnTarget: "cab",
    sourceLabel: "IR Sources",
    targetLabel: "Cab/IR",
    targetSlot: "cab",
    breadcrumb: "CAB / IR Library / IR Sources / Cab/IR",
    searchPlaceholder: "Search cabinet IRs",
    defaultQuery: "ir",
    defaultGearFilter: "ir",
    detailTitle: "Selected cabinet IR",
    detailSubtitle: "Cabinet IR metadata",
    heroKind: "ir",
    rowActionPolicy: "cab-ir-load",
    emptyTitle: "No cabinet IRs match",
    emptyBody: "Try a broader cabinet search or load a local .wav, .aiff, .aif, or .flac impulse response.",
    bodyAssetId: "cabinet-body",
    controlAssetIds: ["mic-dynamic-57", "mic-ribbon-121", "knob-cream-top", "slider-metal-top", "screw-phillips-top"],
    filters: ["Cabinet IR", "Local .wav/.aiff/.aif/.flac"],
    filterControls: [
      { id: "ir-all", label: "All IR", category: "all", gearFilter: "ir" },
      { id: "cabinet-ir", label: "Cabinet IR", category: "cabinet-ir", gearFilter: "ir" },
      { id: "local-ir", label: "Local IR File", category: "local", gearFilter: "ir", localAction: "load-local-ir" },
    ],
    lanes: [
      { id: "tone3000-cabinet-ir", label: "TONE3000 Cabinet IR", detail: "Loads into Cab/IR", active: true, loadable: true },
      { id: "local-ir", label: "Local .wav/.aiff/.aif/.flac", detail: "Uses the native file picker", loadable: true },
    ],
  },
  fx: {
    mode: "fx",
    sourceMode: "openstudio-fx-collection",
    originLabel: "POST FX",
    returnLabel: "Back to Post FX",
    returnTarget: "post",
    sourceLabel: "OpenStudio FX Collection",
    targetLabel: "EQ / Mod / Delay / Reverb",
    targetSlot: "delay",
    breadcrumb: "POST FX / Preset Library / OpenStudio FX Collection / EQ / Mod / Delay / Reverb",
    searchPlaceholder: "Search OpenStudio EQ, mod, delay, and reverb presets",
    defaultQuery: "",
    defaultGearFilter: "",
    detailTitle: "Selected preset - Post FX",
    detailSubtitle: "OpenStudio FX Collection",
    heroKind: "fx-preset",
    rowActionPolicy: "fx-preset",
    emptyTitle: "No FX presets match",
    emptyBody: "Search EQ, Mod, Delay, or Reverb presets from the OpenStudio FX Collection.",
    bodyAssetId: "wide-pedal-body-copper-deep",
    fxBodyAssetIds: {
      eq: "wide-pedal-body-dark-deep",
      mod: "wide-pedal-body-navy-deep",
      delay: "wide-pedal-body-copper-deep",
      reverb: "wide-pedal-body-dark-deep",
    },
    controlAssetIds: ["knob-metal-top", "knob-black-top", "led-amber-on-top", "footswitch-chrome-off-top", "slider-metal-top", "toggle-chrome-top"],
    filters: ["EQ", "Mod", "Delay", "Reverb"],
    filterControls: [
      { id: "fx-all", label: "All FX", category: "all" },
      { id: "eq", label: "EQ", category: "eq" },
      { id: "mod", label: "Mod", category: "mod" },
      { id: "delay", label: "Delay", category: "delay" },
      { id: "reverb", label: "Reverb", category: "reverb" },
    ],
    lanes: [
      { id: "openstudio", label: "OpenStudio FX Collection", detail: "Built-in EQ, Mod, Delay, and Reverb presets", active: true, loadable: true },
      { id: "eq", label: "EQ", detail: "Wrapper graphic EQ target", loadable: true },
      { id: "mod", label: "Mod", detail: "Wrapper modulation target", loadable: true },
      { id: "delay", label: "Delay", detail: "Wrapper delay target", active: true, loadable: true },
      { id: "reverb", label: "Reverb", detail: "Wrapper reverb target", loadable: true },
      { id: "ir-sources", label: "Open IR Sources", detail: "Separate space/reverb IR material" },
    ],
  },
};
export const OPENSTUDIO_FX_COLLECTION_PRESETS: OpenStudioFXPreset[] = [
  {
    id: "studio-contour",
    moduleId: "eq",
    name: "Studio Contour",
    source: "openstudio",
    category: "eq",
    description: "A gentle low trim and presence lift using the built-in nine-band graphic EQ.",
    values: {
      eqEnabled: 1,
      eq65Db: -1.5,
      eq125Db: -0.75,
      eq250Db: 0,
      eq500Db: -0.5,
      eq1kDb: 0,
      eq2kDb: 0.75,
      eq4kDb: 1,
      eq8kDb: 0.5,
      eq16kDb: -0.5,
    },
  },
  {
    id: "wide-chorus",
    moduleId: "mod",
    name: "Wide Chorus",
    source: "openstudio",
    category: "mod",
    description: "Slow, wide post-cab chorus for clean and edge rigs.",
    values: {
      modulatorEnabled: 1,
      modulatorMode: 0,
      modulatorPedalMode: 1,
      modulatorPedalPosition: 0.58,
      chorusMix: 0.34,
      chorusRateHz: 0.58,
      chorusDepth: 0.58,
    },
  },
  {
    id: "tape-quarter",
    moduleId: "delay",
    name: "Tape Quarter",
    source: "openstudio",
    category: "delay",
    description: "Tempo-friendly tape delay with restrained modulation.",
    values: {
      delayEnabled: 1,
      delayMix: 0.18,
      delayTimeMs: 430,
      delayFeedback: 0.28,
      delayMod: 0.18,
      delayDucker: 0.12,
      delayMode: 1,
      delayPingPong: 1,
      delayTempoSync: 0,
    },
  },
  {
    id: "plate-room",
    moduleId: "reverb",
    name: "Plate Room",
    source: "openstudio",
    category: "reverb",
    description: "Short plate-room blend for guitar ambience after delay.",
    values: {
      reverbEnabled: 1,
      reverbVoice: 1,
      reverbMix: 0.2,
      reverbDecaySec: 2.4,
      reverbPreDelayMs: 18,
      reverbLowCutHz: 120,
      reverbTone: 0.62,
      reverbShimmer: 0,
    },
  },
];

export function getNAMSourceFlowConfig(mode: NAMLibraryFlowMode): NAMSourceFlowConfig {
  return NAM_SOURCE_FLOW_CONFIGS[mode];
}

export function getNAMSourceFlowUseLabel(mode: NAMLibraryFlowMode): "Use Capture" | "Use IR" | "Apply Preset" {
  if (mode === "ir") return "Use IR";
  if (mode === "fx") return "Apply Preset";
  return "Use Capture";
}

export function getNAMSourceFlowRowActionPolicy(mode: NAMLibraryFlowMode, category: string): NAMSourceFlowRowActionPolicy {
  if (mode === "fx") return "fx-preset";
  if (mode === "ir") return category === "cabinet-ir" ? "cab-ir-load" : "source-only";
  return isNAMSourceFlowCategoryAllowed(mode, category) ? "model-preview" : "source-only";
}

const OPENSTUDIO_FX_MODULE_PARAM_PREFIXES: Record<OpenStudioFXPreset["moduleId"], readonly string[]> = {
  eq: ["eq"],
  mod: ["modulator", "chorus"],
  delay: ["delay"],
  reverb: ["reverb"],
};

export function buildOpenStudioFXPresetStatePatch(preset: OpenStudioFXPreset) {
  const allowedPrefixes = OPENSTUDIO_FX_MODULE_PARAM_PREFIXES[preset.moduleId] ?? [];
  const values = Object.fromEntries(
    Object.entries(preset.values).filter(([paramId]) => allowedPrefixes.some((prefix) => paramId.startsWith(prefix))),
  );
  return { values };
}

export function classifyNAMSourceCategory(...values: unknown[]) {
  let genericPedalCapture = false;
  for (const value of values) {
    const captureType = normalizeNAMCaptureType(value);
    if (captureIncludesCab(captureType)) return "full-rig";
    if (captureType === "pedal") genericPedalCapture = true;
    if (captureType === "amp" || captureType === "pedal_amp" || captureType === "preamp") return "amp";
    if (captureType === "studio") return "studio";
  }
  const label = values
    .map((value) => gearLabel(value) || firstString(value))
    .join(" ")
    .toLowerCase();
  if (/\b(full[- _]?rig|rig)\b/.test(label)) return "full-rig";
  if (/\b(space|spaces|reverb ir|room ir|convolution|openair|echo ?thief)\b/.test(label)) return "space-ir";
  if (/\b(ir|cab|cabinet|impulse|wav|aiff?|flac)\b/.test(label)) return "cabinet-ir";
  if (/\bfuzz\b/.test(label)) return "fuzz";
  if (/\b(overdrive|od)\b/.test(label)) return "overdrive";
  if (/\bdistortion\b/.test(label)) return "distortion";
  if (/\bboost\b/.test(label)) return "boost";
  if (/\b(drive|stomp|pedal)\b/.test(label)) return "drive";
  if (genericPedalCapture) return "drive";
  if (/\b(head|amp)\b/.test(label)) return "amp";
  return "unknown";
}

export function isSupportedTONE3000PedalCategory(category: string) {
  return (SUPPORTED_TONE3000_PEDAL_CATEGORIES as readonly string[]).includes(category);
}

export function buildNAMRailCatalogActionState({
  targetSlot,
  isBusy,
  toneId,
  installedRecord,
  hasDownloadUrl,
  onlineAvailable = true,
}: {
  targetSlot: NAMTargetSlot;
  isBusy: boolean;
  toneId: number;
  installedRecord?: NAMInstalledModel;
  hasDownloadUrl: boolean;
  onlineAvailable?: boolean;
}): NAMRailCatalogActionState {
  const canResolveTone = toneId > 0 || hasDownloadUrl;
  const needsOnline = !installedRecord || Boolean(installedRecord.missing);
  const disabledReason = isBusy
    ? "This tone is already being prepared."
    : needsOnline && !onlineAvailable
      ? "Connect TONE3000 before downloading or auditioning this tone."
      : canResolveTone
        ? ""
        : "This result is missing both a TONE3000 tone id and a downloadable model URL.";
  const primaryTitle = targetSlot === "cab"
    ? "Audition cabinet IR"
    : hasDownloadUrl
      ? "Audition with live guitar"
      : "Load model details and audition";
  const loadIcon = installedRecord && !installedRecord.missing
    ? "load"
    : installedRecord?.missing
      ? "restore"
      : "download";
  const loadTitle = installedRecord && !installedRecord.missing
    ? targetSlot === "cab" ? "Load saved local cabinet IR" : "Load saved local tone"
    : installedRecord?.missing
      ? "Restore missing tone"
      : hasDownloadUrl
        ? targetSlot === "cab" ? "Download and load cabinet IR" : "Download and load tone"
        : "Load details, download, and load tone";

  return {
    primaryTitle,
    primaryDisabled: Boolean(disabledReason),
    primaryDisabledReason: disabledReason,
    loadTitle,
    loadDisabled: Boolean(disabledReason),
    loadDisabledReason: disabledReason,
    loadIcon,
  };
}

export function buildNAMRailInstalledActionState({
  targetSlot,
  isBusy,
  missing,
  canRestoreMissing,
  onlineAvailable = true,
}: {
  targetSlot: NAMTargetSlot;
  isBusy: boolean;
  missing: boolean;
  canRestoreMissing: boolean;
  onlineAvailable?: boolean;
}): NAMRailInstalledActionState {
  const busyReason = isBusy ? "This saved tone is already being prepared." : "";
  const primaryMissingReason = missing ? "Restore this missing tone before auditioning it." : "";
  const restoreMissingReason = missing && !canRestoreMissing
    ? "This saved tone is missing download metadata."
    : missing && !onlineAvailable
      ? "Connect TONE3000 before restoring this missing tone."
      : "";
  return {
    primaryTitle: targetSlot === "cab" ? "Audition cabinet IR" : "Audition with live guitar",
    primaryDisabled: Boolean(busyReason || primaryMissingReason),
    primaryDisabledReason: busyReason || primaryMissingReason,
    loadTitle: missing
      ? canRestoreMissing ? "Restore missing tone" : "Missing download metadata"
      : targetSlot === "cab" ? "Load local cabinet IR" : "Load local tone",
    loadDisabled: Boolean(busyReason || restoreMissingReason),
    loadDisabledReason: busyReason || restoreMissingReason,
    loadIcon: missing ? "restore" : "load",
  };
}
const NAM_SHELVES: Array<[NAMShelf, string]> = [
  ["featured", "Featured"],
  ["latest-a2", "Latest A2"],
  ["trending", "Trending"],
  ["downloaded", "Most Downloaded"],
  ["clean", "Clean"],
  ["high-gain", "High Gain"],
  ["pedals", "Pedals"],
  ["full-rigs", "Full Rigs"],
  ["irs", "IRs"],
  ["installed", "Installed"],
  ["favorites", "Favorites"],
];
const INSTRUMENT_METADATA_KEYS = ["instrument", "instrument_type", "instrumentType", "instruments", "target_instrument", "targetInstrument"];
const CHARACTER_METADATA_KEYS = ["character", "characters", "tone_character", "toneCharacter", "traits", "tags"];
const CAPTURE_METADATA_FIELDS: Array<{ label: string; keys: string[] }> = [
  {
    label: "Capture input reference",
    keys: ["input_level_dbu", "inputLevelDbu"],
  },
  {
    label: "Capture output reference",
    keys: ["output_level_dbu", "outputLevelDbu"],
  },
  {
    label: "Calibration",
    keys: [
      "calibration",
      "calibrationDb",
      "calibration_db",
      "inputCalibration",
      "input_calibration",
      "inputCalibrationDb",
      "input_calibration_db",
      "captureCalibrationDb",
      "capture_calibration_db",
    ],
  },
  {
    label: "Input Level",
    keys: [
      "inputLevel",
      "input_level",
      "inputLevelDb",
      "input_level_db",
      "captureInputDb",
      "capture_input_db",
      "calibratedInputDb",
      "calibrated_input_db",
    ],
  },
  {
    label: "Normalization",
    keys: [
      "normalization",
      "normalizationMode",
      "normalization_mode",
      "normalized",
      "targetLufs",
      "target_lufs",
      "lufs",
      "peakDb",
      "peak_db",
    ],
  },
];
const NESTED_CAPTURE_METADATA_KEYS = ["metadata", "capture", "captureMetadata", "capture_metadata", "training", "calibration", "normalization"];

function modelIdOf(model: NAMCatalogModel | NAMInstalledModel) {
  return Number((model as NAMCatalogModel).id ?? (model as NAMCatalogModel).model_id ?? (model as NAMInstalledModel).modelId ?? 0);
}

function toneIdOf(toneOrModel: NAMCatalogTone | NAMCatalogModel | NAMInstalledModel) {
  return Number(
    (toneOrModel as NAMCatalogTone).id ??
    (toneOrModel as NAMCatalogTone).toneId ??
    (toneOrModel as NAMCatalogModel).tone_id ??
    (toneOrModel as NAMInstalledModel).toneId ??
    0,
  );
}

export function tone3000LivePageSizing(variant: NAMExplorerVariant, architecture: string) {
  const targetPageSize = NAM_LIVE_PAGE_TARGETS[variant];
  const normalizedArchitecture = architecture.trim().toLowerCase();
  const combinesA1AndA2 = normalizedArchitecture === "" || normalizedArchitecture === "all";
  return {
    targetPageSize,
    // TONE3000 deliberately excludes A2 when architecture is omitted, so the native
    // bridge performs one server request for A1 and one for A2. Split the visible
    // budget between them instead of accidentally returning twice the UI page size.
    apiPageSize: combinesA1AndA2
      ? Math.max(1, Math.floor(targetPageSize / 2))
      : targetPageSize,
  };
}

export function boundNAMCatalogRowsForDisplay<T>(
  rows: readonly T[],
  variant: NAMExplorerVariant,
  catalogMode: NAMCatalogMode,
  tab: NAMTab,
) {
  if (catalogMode === "live" || tab === "installed" || tab === "favorites") return rows;
  return rows.slice(0, NAM_LIVE_PAGE_TARGETS[variant]);
}

function tone3000ToneIdentity(tone: NAMCatalogTone) {
  const toneId = toneIdOf(tone);
  if (toneId > 0) return `tone:${toneId}`;

  const modelIds = (tone.models ?? [])
    .map((model) => modelIdOf(model))
    .filter((modelId) => modelId > 0)
    .sort((left, right) => left - right);
  if (modelIds.length > 0) return `models:${modelIds.join(",")}`;

  const sourceUrl = String(tone.url ?? tone.source_url ?? tone.sourceUrl ?? "").trim().toLowerCase();
  const creator = String(tone.creator ?? tone.user?.username ?? "").trim().toLowerCase();
  const title = String(tone.title ?? tone.name ?? "").trim().toLowerCase();
  return `anonymous:${sourceUrl}:${creator}:${title}`;
}

export function mergeTONE3000TonePages(
  current: NAMCatalogTone[],
  incoming: NAMCatalogTone[],
  append: boolean,
) {
  const merged = append ? [...current, ...incoming] : incoming;
  const seen = new Set<string>();
  return merged.filter((tone) => {
    const key = tone3000ToneIdentity(tone);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const NAM_SOURCE_POST_STAGE_LABELS: Record<OpenStudioFXModuleId, string> = {
  eq: "EQ",
  mod: "Modulation",
  delay: "Delay",
  reverb: "Reverb",
};

export function makeNAMSourceFlowRoute(
  flow: NAMLibraryFlowMode,
  previewFxModule: OpenStudioFXModuleId | null,
  storedOrder: unknown,
  octaverLabel = "Octaver",
) {
  const allowedPostStages = new Set<OpenStudioFXModuleId>(["eq", "mod", "delay", "reverb"]);
  const postOrder: OpenStudioFXModuleId[] = [];
  if (Array.isArray(storedOrder)) {
    for (const entry of storedOrder) {
      const id = String(entry) as OpenStudioFXModuleId;
      if (allowedPostStages.has(id) && !postOrder.includes(id)) postOrder.push(id);
    }
  }
  for (const id of ["eq", "mod", "delay", "reverb"] as const) {
    if (!postOrder.includes(id)) postOrder.push(id);
  }

  const stageLabel = (id: OpenStudioFXModuleId) => (
    flow === "fx" && id === previewFxModule
      ? `${NAM_SOURCE_POST_STAGE_LABELS[id]} Preview`
      : NAM_SOURCE_POST_STAGE_LABELS[id]
  );
  return [
    "Input",
    "Gate",
    "Compressor",
    "Tape Echo",
    octaverLabel,
    "Precision Drive",
    "High Gain Distortion",
    flow === "amp" ? "Amp NAM Preview" : "Amp NAM",
    flow === "ir" ? "Cab/IR Preview" : "Cab/IR",
    ...postOrder.map(stageLabel),
    "Output",
  ].join(" \u2192 ");
}

function architectureLabel(value: unknown) {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "2" || raw === "a2") return "A2";
  if (raw === "1" || raw === "a1") return "A1";
  if (raw === "custom") return "Custom";
  return raw ? raw.toUpperCase() : "NAM";
}

function gearLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) return String((value as { name?: string }).name ?? "");
  return "";
}

function licenseLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) return String((value as { name?: string }).name ?? "");
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanMetadataLabel(value: unknown) {
  return String(value ?? "").trim().replace(/[_-]+/g, " ");
}

function metadataLabelsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(metadataLabelsFromValue);
  if (typeof value === "string" || typeof value === "number") {
    const label = cleanMetadataLabel(value);
    return label ? [label] : [];
  }

  const object = asRecord(value);
  if (!object) return [];

  for (const key of ["name", "title", "label", "display_name", "displayName", "slug"]) {
    const label = cleanMetadataLabel(object[key]);
    if (label) return [label];
  }

  return [];
}

function metadataLabelsFromSources(sources: unknown[], keys: string[]) {
  const labels = new Set<string>();
  for (const source of sources) {
    const object = asRecord(source);
    if (!object) continue;
    for (const key of keys) {
      for (const label of metadataLabelsFromValue(object[key])) labels.add(label);
    }
  }
  return sortedFilterValues(labels);
}

function rowInstrumentLabels(tone: NAMCatalogTone, model: NAMCatalogModel) {
  return metadataLabelsFromSources([model, tone], INSTRUMENT_METADATA_KEYS);
}

function rowCharacterLabels(tone: NAMCatalogTone, model: NAMCatalogModel) {
  return metadataLabelsFromSources([model, tone], CHARACTER_METADATA_KEYS);
}

function installedMetadataSources(record: NAMInstalledModel) {
  return [record, record.latestMetadata, record.lastSeenMetadata].filter(Boolean);
}

function installedInstrumentLabels(record: NAMInstalledModel) {
  return metadataLabelsFromSources(installedMetadataSources(record), INSTRUMENT_METADATA_KEYS);
}

function installedCharacterLabels(record: NAMInstalledModel) {
  return metadataLabelsFromSources(installedMetadataSources(record), CHARACTER_METADATA_KEYS);
}

function availabilityFromSource(source: unknown): "Free" | "Paid" | "" {
  const object = asRecord(source);
  if (!object) return "";

  for (const key of ["is_paid", "isPaid", "paid", "is_premium", "isPremium", "premium", "requires_purchase", "requiresPurchase"]) {
    const value = object[key];
    if (typeof value === "boolean") return value ? "Paid" : "Free";
    const label = cleanMetadataLabel(value).toLowerCase();
    if (["paid", "premium", "purchase", "requires purchase", "commercial"].includes(label)) return "Paid";
    if (["free", "no", "false"].includes(label)) return "Free";
  }

  for (const key of ["is_free", "isFree", "free"]) {
    const value = object[key];
    if (typeof value === "boolean") return value ? "Free" : "";
    const label = cleanMetadataLabel(value).toLowerCase();
    if (["free", "yes", "true"].includes(label)) return "Free";
  }

  for (const key of ["price", "price_cents", "priceCents", "amount", "cost"]) {
    const value = object[key];
    if (typeof value === "number") return value > 0 ? "Paid" : value === 0 ? "Free" : "";
    const label = cleanMetadataLabel(value).toLowerCase();
    if (label === "free") return "Free";
    const numeric = Number(label.replace(/[^0-9.]+/g, ""));
    if (Number.isFinite(numeric) && numeric > 0) return "Paid";
  }

  for (const key of ["purchase_url", "purchaseUrl", "vendor_url", "vendorUrl", "checkout_url", "checkoutUrl"]) {
    if (cleanMetadataLabel(object[key])) return "Paid";
  }

  return "";
}

function rowAvailabilityLabel(tone: NAMCatalogTone, model: NAMCatalogModel) {
  return availabilityFromSource(model) || availabilityFromSource(tone);
}

function installedAvailabilityLabel(record: NAMInstalledModel) {
  for (const source of installedMetadataSources(record)) {
    const availability = availabilityFromSource(source);
    if (availability) return availability;
  }
  return "";
}

function formatNumericMetadataValue(value: number, key: string) {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes("dbu")) return `${value >= 0 ? "+" : ""}${value.toFixed(1).replace(/\.0$/, "")} dBu`;
  if (normalizedKey.includes("lufs")) return `${value.toFixed(1).replace(/\.0$/, "")} LUFS`;
  if (
    normalizedKey.includes("db") ||
    normalizedKey.includes("gain") ||
    normalizedKey.includes("level") ||
    normalizedKey.includes("calibration") ||
    normalizedKey.includes("peak")
  ) {
    return `${value > 0 ? "+" : ""}${value.toFixed(1).replace(/\.0$/, "")} dB`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, "");
}

function formatCaptureMetadataValue(value: unknown, key: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return formatNumericMetadataValue(value, key);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((entry) => formatCaptureMetadataValue(entry, key)).filter(Boolean).join(", ");
  }

  const object = asRecord(value);
  if (!object) return "";

  const label = firstString(object.label, object.name, object.mode, object.value, object.status);
  if (label) return label;

  const parts: string[] = [];
  for (const [partLabel, keys] of [
    ["input", ["input_level_dbu", "inputLevelDbu"]],
    ["output", ["output_level_dbu", "outputLevelDbu"]],
    ["input", ["inputDb", "input_db", "inputLevelDb", "input_level_db"]],
    ["gain", ["gainDb", "gain_db", "calibrationDb", "calibration_db"]],
    ["target", ["targetLufs", "target_lufs", "lufs"]],
    ["peak", ["peakDb", "peak_db"]],
    ["mode", ["normalizationMode", "normalization_mode", "mode"]],
  ] as Array<[string, string[]]>) {
    for (const nestedKey of keys) {
      const nestedValue = formatCaptureMetadataValue(object[nestedKey], nestedKey);
      if (nestedValue) {
        parts.push(`${partLabel} ${nestedValue}`);
        break;
      }
    }
  }
  return parts.join(", ");
}

function captureMetadataSourceRecords(sources: unknown[]) {
  const records: Record<string, unknown>[] = [];
  for (const source of sources) {
    const sourceRecord = asRecord(source);
    if (!sourceRecord) continue;
    records.push(sourceRecord);
    for (const key of NESTED_CAPTURE_METADATA_KEYS) {
      const nested = asRecord(sourceRecord[key]);
      if (nested) records.push(nested);
    }
  }
  return records;
}

function captureMetadataDetails(sources: unknown[]) {
  const records = captureMetadataSourceRecords(sources);
  const details: Array<{ label: string; value: string }> = [];

  for (const field of CAPTURE_METADATA_FIELDS) {
    for (const record of records) {
      const hitKey = field.keys.find((key) => record[key] !== undefined && record[key] !== null && record[key] !== "");
      if (!hitKey) continue;
      const value = formatCaptureMetadataValue(record[hitKey], hitKey);
      if (value) {
        details.push({ label: field.label, value });
        break;
      }
    }
  }

  return details;
}

function rowCaptureMetadataDetails(tone: NAMCatalogTone, model: NAMCatalogModel) {
  return captureMetadataDetails([model, tone]);
}

function installedCaptureMetadataDetails(record: NAMInstalledModel) {
  return captureMetadataDetails(installedMetadataSources(record));
}

function downloadUrlOf(model: NAMCatalogModel) {
  return String(model.model_url ?? model.modelUrl ?? "");
}

function sourceUrlOf(tone: NAMCatalogTone, model: NAMCatalogModel) {
  return String(tone.url ?? tone.source ?? downloadUrlOf(model) ?? "");
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested: string = firstString(...value);
      if (nested) return nested;
    } else if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function artBackgroundStyle(url: string): CSSProperties | undefined {
  return url ? { "--nam-card-profile-image": `url(${JSON.stringify(url)})` } as CSSProperties : undefined;
}

function stableArtVariant(values: unknown[], count: number) {
  const label = values
    .map((value) => gearLabel(value) || firstString(value))
    .join("|")
    .toLowerCase();
  let hash = 0;
  for (let index = 0; index < label.length; index += 1)
    hash = ((hash * 31) + label.charCodeAt(index)) | 0;
  return count > 0 ? Math.abs(hash) % count : 0;
}

function fallbackArtForGear(...values: unknown[]) {
  const profile = fallbackArtProfileForGear(...values);
  if (profile === "pedal") {
    const variants = [NAM_PEDAL_CARD_ART, NAM_PEDAL_PREMIUM_ART];
    return variants[stableArtVariant(values, variants.length)];
  }
  if (profile === "cab") {
    const label = values.map((value) => gearLabel(value) || firstString(value)).join(" ").toLowerCase();
    return /\b(space|room|reverb|convolution|hall|plate)\b/.test(label) ? NAM_ROOM_CARD_ART : NAM_CAB_CARD_ART;
  }
  const variants = [NAM_TONE_CARD_ART, NAM_TONE_PREMIUM_ART, NAM_TONE_FRONT_ART];
  return variants[stableArtVariant(values, variants.length)];
}

function sourceLibraryArtForCategory(category: string, ...values: unknown[]) {
  if (category === "boost") return NAM_PEDAL_BOOST_ART;
  if (category === "drive" || category === "overdrive") return NAM_PEDAL_OVERDRIVE_ART;
  if (category === "fuzz") return NAM_PEDAL_FUZZ_ART;
  if (category === "distortion") return NAM_PEDAL_DISTORTION_ART;
  if (category === "space-ir") return NAM_ROOM_CARD_ART;
  return fallbackArtForGear(...values);
}

function openStudioFXArt(moduleId: OpenStudioFXModuleId) {
  if (moduleId === "eq") return NAM_TONE_FRONT_ART;
  if (moduleId === "mod") return NAM_FX_CHORUS_ART;
  if (moduleId === "reverb") return NAM_ROOM_CARD_ART;
  return NAM_PEDAL_CARD_ART;
}

function fallbackArtProfileForGear(...values: unknown[]) {
  const label = values
    .map((value) => gearLabel(value) || firstString(value))
    .join(" ")
    .toLowerCase();
  if (label.includes("pedal") || label.includes("drive") || label.includes("boost") || label.includes("fuzz")) return "pedal";
  if (label.includes("ir") || label.includes("cab")) return "cab";
  if (label.includes("metal") || label.includes("modern") || label.includes("high gain") || label.includes("lead")) return "high-gain";
  if (label.includes("crunch") || label.includes("edge") || label.includes("breakup")) return "crunch";
  if (label.includes("clean") || label.includes("twin") || label.includes("jc") || label.includes("tele") || label.includes("strat")) return "clean";
  return "amp";
}

function hasAudioIRExtension(...values: unknown[]) {
  const label = values
    .map((value) => gearLabel(value) || firstString(value))
    .join(" ");
  return /\.(wav|wave|aif|aiff|flac)(?:[?#].*)?$/i.test(label);
}

function isCabIRTarget(...values: unknown[]) {
  return hasAudioIRExtension(...values) || fallbackArtProfileForGear(...values) === "cab";
}

function preferredNAMSlot(...values: unknown[]): NAMSlot {
  const label = values
    .map((value) => gearLabel(value) || firstString(value))
    .join(" ")
    .toLowerCase();
  if (
    label.includes("pedal") ||
    label.includes("boost") ||
    label.includes("drive") ||
    label.includes("overdrive") ||
    label.includes("distortion") ||
    label.includes("fuzz") ||
    label.includes("stomp")
  ) {
    return "pedal";
  }
  return "amp";
}

function preferredSlotForToneModel(tone: NAMCatalogTone, model: NAMCatalogModel): NAMSlot {
  const captureType = captureTypeForToneModel(tone, model);
  if (captureType !== "unknown") return targetSlotForCapture(captureType);
  return preferredNAMSlot(
    model.gear,
    model.gearType,
    model.name,
    model.title,
    tone.gear,
    tone.gearType,
    tone.title,
    tone.name,
    tone.description,
  );
}

function preferredTargetForToneModel(tone: NAMCatalogTone, model: NAMCatalogModel): NAMTargetSlot {
  const captureType = captureTypeForToneModel(tone, model);
  if (captureIncludesCab(captureType)) return "amp";
  if (captureType !== "unknown") return targetSlotForCapture(captureType);
  if (isCabIRTarget(
    model.gear,
    model.gearType,
    model.name,
    model.title,
    model.model_url,
    model.modelUrl,
    tone.gear,
    tone.gearType,
    tone.title,
    tone.name,
    tone.description,
  )) {
    return "cab";
  }
  return preferredSlotForToneModel(tone, model);
}

function firstDeclaredCaptureType(...values: unknown[]): NAMCaptureType {
  for (const value of values) {
    const captureType = normalizeNAMCaptureType(value);
    if (captureType !== "unknown") return captureType;
  }
  return "unknown";
}

function isDeclaredAmpOnlyCapture(captureType: NAMCaptureType) {
  return captureType === "amp"
    || captureType === "pedal_amp"
    || captureType === "preamp";
}

export function hasPositiveAmpOnlyToneMetadata(
  tone: NAMCatalogTone,
  model: NAMCatalogModel,
) {
  const modelMetadata = asRecord(model.metadata);
  const toneMetadata = asRecord(tone.metadata);
  return isDeclaredAmpOnlyCapture(firstDeclaredCaptureType(
    modelMetadata?.gear_type,
    modelMetadata?.gearType,
    model.captureType,
    model.gear_type,
    model.gearType,
    model.gear,
    toneMetadata?.gear_type,
    toneMetadata?.gearType,
    tone.captureType,
    tone.gearType,
    tone.gear,
  ));
}

export function hasPositiveAmpOnlyInstalledMetadata(record: NAMInstalledModel) {
  const localMetadata = asRecord(record.namMetadata);
  const lastSeen = asRecord(record.lastSeenMetadata);
  const lastSeenMetadata = asRecord(lastSeen?.metadata);
  const latest = asRecord(record.latestMetadata);
  const latestMetadata = asRecord(latest?.metadata);
  return isDeclaredAmpOnlyCapture(firstDeclaredCaptureType(
    localMetadata?.gear_type,
    localMetadata?.gearType,
    record.captureType,
    record.gear_type,
    record.gearType,
    record.gear,
    lastSeenMetadata?.gear_type,
    lastSeenMetadata?.gearType,
    lastSeen?.gear_type,
    lastSeen?.gearType,
    lastSeen?.gear,
    latestMetadata?.gear_type,
    latestMetadata?.gearType,
    latest?.gear_type,
    latest?.gearType,
    latest?.gear,
  ));
}

export function sourceCategoryForToneModel(tone: NAMCatalogTone, model: NAMCatalogModel) {
  const category = classifyNAMSourceCategory(
    captureTypeForToneModel(tone, model),
    model.gear,
    model.gearType,
    model.name,
    model.title,
    model.model_url,
    model.modelUrl,
    tone.gear,
    tone.gearType,
    tone.title,
    tone.name,
    tone.description,
    tone.format,
    tone.platform,
  );
  return category === "amp" && !hasPositiveAmpOnlyToneMetadata(tone, model)
    ? "unknown"
    : category;
}

export function sourceCategoryForInstalled(record: NAMInstalledModel) {
  const category = classifyNAMSourceCategory(
    captureTypeForInstalled(record),
    record.gear,
    record.gearType,
    record.name,
    record.toneTitle,
    record.localPath,
    record.modelUrl,
    record.latestModelUrl,
    record.lastSeenMetadata?.gear,
    record.lastSeenMetadata?.gearType,
    record.lastSeenMetadata?.name,
    record.lastSeenMetadata?.model_url,
    record.lastSeenMetadata?.modelUrl,
    record.latestMetadata?.gear,
    record.latestMetadata?.gearType,
    record.latestMetadata?.name,
    record.latestMetadata?.model_url,
    record.latestMetadata?.modelUrl,
  );
  return category === "amp" && !hasPositiveAmpOnlyInstalledMetadata(record)
    ? "unknown"
    : category;
}

export function isNAMSourceFlowCategoryAllowed(mode: NAMLibraryFlowMode, category: string) {
  if (mode === "amp") {
    return category === "amp"
      || category === "full-rig"
      || category === "studio"
      || category === "unknown";
  }
  if (mode === "pedal") return isSupportedTONE3000PedalCategory(category);
  if (mode === "ir") return category === "cabinet-ir";
  return false;
}

function preferredSlotForInstalled(record: NAMInstalledModel): NAMSlot {
  const captureType = captureTypeForInstalled(record);
  if (captureType !== "unknown") return targetSlotForCapture(captureType);
  return preferredNAMSlot(
    record.gear,
    record.gearType,
    record.name,
    record.toneTitle,
    record.lastSeenMetadata?.gear,
    record.lastSeenMetadata?.gearType,
    record.lastSeenMetadata?.name,
    record.latestMetadata?.gear,
    record.latestMetadata?.gearType,
    record.latestMetadata?.name,
  );
}

function preferredTargetForInstalled(record: NAMInstalledModel): NAMTargetSlot {
  const captureType = captureTypeForInstalled(record);
  if (captureIncludesCab(captureType)) return "amp";
  if (captureType !== "unknown") return targetSlotForCapture(captureType);
  if (isCabIRTarget(
    record.gear,
    record.gearType,
    record.name,
    record.toneTitle,
    record.localPath,
    record.modelUrl,
    record.latestModelUrl,
    record.lastSeenMetadata?.gear,
    record.lastSeenMetadata?.gearType,
    record.lastSeenMetadata?.name,
    record.lastSeenMetadata?.model_url,
    record.lastSeenMetadata?.modelUrl,
    record.latestMetadata?.gear,
    record.latestMetadata?.gearType,
    record.latestMetadata?.name,
    record.latestMetadata?.model_url,
    record.latestMetadata?.modelUrl,
  )) {
    return "cab";
  }
  return preferredSlotForInstalled(record);
}

function targetLabelForSlot(targetSlot: NAMTargetSlot) {
  if (targetSlot === "cab") return "Cab/IR";
  return targetSlot === "amp" ? "Amp" : "Pedal";
}

function imageUrlOf(tone: NAMCatalogTone, model: NAMCatalogModel) {
  const toneRecord = asRecord(tone);
  const modelRecord = asRecord(model);
  return firstString(
    modelRecord?.image_url,
    modelRecord?.imageUrl,
    modelRecord?.thumbnail_url,
    modelRecord?.thumbnailUrl,
    modelRecord?.artwork_url,
    modelRecord?.artworkUrl,
    toneRecord?.image_url,
    toneRecord?.imageUrl,
    toneRecord?.thumbnail_url,
    toneRecord?.thumbnailUrl,
    toneRecord?.artwork_url,
    toneRecord?.artworkUrl,
    toneRecord?.images,
  );
}

function creatorAvatarUrl(tone: NAMCatalogTone) {
  return firstString(tone.user?.avatar_url, tone.user?.avatarUrl, asRecord(tone)?.creator_avatar_url, asRecord(tone)?.creatorAvatarUrl);
}

function creatorProfileUrlFromSource(source: unknown) {
  const object = asRecord(source);
  const user = asRecord(object?.user);
  return firstString(
    user?.url,
    user?.profile_url,
    user?.profileUrl,
    object?.creator_url,
    object?.creatorUrl,
    object?.profile_url,
    object?.profileUrl,
    object?.user_url,
    object?.userUrl,
  );
}

function creatorProfileUrl(tone: NAMCatalogTone) {
  return creatorProfileUrlFromSource(tone);
}

function installedImageUrl(record: NAMInstalledModel) {
  const sources = [record.latestMetadata, record.lastSeenMetadata, record];
  return firstString(...sources.flatMap((source) => {
    const object = asRecord(source);
    return [
      object?.image_url,
      object?.imageUrl,
      object?.thumbnail_url,
      object?.thumbnailUrl,
      object?.artwork_url,
      object?.artworkUrl,
      object?.images,
    ];
  }));
}

function installedCreatorProfileUrl(record: NAMInstalledModel) {
  return firstString(...installedMetadataSources(record).map(creatorProfileUrlFromSource));
}

function toneTitle(tone: NAMCatalogTone, model: NAMCatalogModel) {
  const toneRecord = asRecord(tone);
  return firstNAMDisplayName(
    tone.title,
    String(toneRecord?.toneTitle ?? toneRecord?.tone_title ?? ""),
    tone.name,
    model.title,
    model.name,
    namDisplayNameFromPath(downloadUrlOf(model)),
    "NAM tone",
  );
}

function modelTitle(model: NAMCatalogModel) {
  return firstNAMDisplayName(
    model.title,
    model.name,
    namDisplayNameFromPath(downloadUrlOf(model)),
    "NAM model",
  );
}

function installedTitle(record: NAMInstalledModel) {
  const latest = asRecord(record.latestMetadata);
  const lastSeen = asRecord(record.lastSeenMetadata);
  return firstNAMDisplayName(
    record.toneTitle,
    record.name,
    String(latest?.title ?? latest?.toneTitle ?? latest?.name ?? ""),
    String(lastSeen?.title ?? lastSeen?.toneTitle ?? lastSeen?.name ?? ""),
    namDisplayNameFromPath(record.localPath),
    "Installed NAM model",
  );
}

function dateMs(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function sortCatalogRows(rows: NAMCatalogRow[], sortMode: NAMSortMode, preserveServerOrder = false) {
  const sorted = [...rows];
  if (preserveServerOrder) return sorted;
  sorted.sort((left, right) => {
    if (sortMode === "name-az") return toneTitle(left.tone, left.model).localeCompare(toneTitle(right.tone, right.model));
    if (sortMode === "downloads-all-time") return Number(right.tone.downloads_count || 0) - Number(left.tone.downloads_count || 0);
    if (sortMode === "favorites-count") return Number(right.tone.favorites_count || 0) - Number(left.tone.favorites_count || 0);
    if (sortMode === "newest") {
      const leftDate = dateMs(left.tone.updated_at, left.tone.updatedAt, left.tone.created_at, left.tone.createdAt);
      const rightDate = dateMs(right.tone.updated_at, right.tone.updatedAt, right.tone.created_at, right.tone.createdAt);
      return rightDate - leftDate;
    }
    const leftScore = Number(left.tone.favorites_count || 0) * 4 + Number(left.tone.downloads_count || 0);
    const rightScore = Number(right.tone.favorites_count || 0) * 4 + Number(right.tone.downloads_count || 0);
    return rightScore - leftScore;
  });
  return sorted;
}

function sortInstalledRows(rows: NAMInstalledModel[], sortMode: NAMSortMode) {
  const sorted = [...rows];
  sorted.sort((left, right) => {
    if (sortMode === "name-az") return installedTitle(left).localeCompare(installedTitle(right));
    if (sortMode === "newest") {
      return dateMs(right.updatedAt, right.manifestUpdatedAt, right.installedAt) - dateMs(left.updatedAt, left.manifestUpdatedAt, left.installedAt);
    }
    if (sortMode === "favorites-count") return Number(Boolean(right.favorite)) - Number(Boolean(left.favorite));
    return installedTitle(left).localeCompare(installedTitle(right));
  });
  return sorted;
}

function creatorLabel(tone: NAMCatalogTone) {
  return String(tone.user?.username || tone.creator || "TONE3000");
}

export function modelArchitecture(tone: NAMCatalogTone, model: NAMCatalogModel) {
  return architectureLabel(
    model.architecture_version
      ?? model.architecture
      ?? tone.searchArchitecture
      ?? tone.architecture,
  );
}

function shortPath(path: string) {
  return path ? path.split(/[\\/]/).slice(-3).join("/") : "";
}

function normalizeLocalPathForCompare(path?: string | null) {
  return String(path || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function sameLocalPath(a?: string | null, b?: string | null) {
  return normalizeLocalPathForCompare(a) === normalizeLocalPathForCompare(b);
}

function formatDateLabel(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFileSize(bytes?: number) {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatCompactCount(value?: number | string | null) {
  const count = Math.max(0, Number(value || 0));
  if (!Number.isFinite(count)) return "0";
  if (count >= 1_000_000) {
    const compact = count / 1_000_000;
    return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (count >= 1_000) {
    const compact = count / 1_000;
    return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(Math.round(count));
}

function catalogStatsLabel(tone: NAMCatalogTone) {
  return `${formatCompactCount(tone.downloads_count)} dl / ${formatCompactCount(tone.favorites_count)} fav`;
}

function catalogDescriptorLabel(tone: NAMCatalogTone, model: NAMCatalogModel) {
  return firstString(
    rowCharacterLabels(tone, model)[0],
    rowInstrumentLabels(tone, model)[0],
    gearLabel(tone.gear),
    gearLabel(model.gear),
    modelArchitecture(tone, model),
  );
}

function installedDescriptorLabel(record: NAMInstalledModel) {
  return firstString(
    installedCharacterLabels(record)[0],
    installedInstrumentLabels(record)[0],
    gearLabel(record.gear),
    gearLabel(record.gearType),
    architectureLabel(record.architecture),
  );
}

function catalogDateMs(value: string) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function catalogAgeLabel(value: string, fallbackMs = 0) {
  const time = catalogDateMs(value) || fallbackMs;
  if (!time) return "Not refreshed yet";
  const ageMs = Math.max(0, Date.now() - time);
  if (ageMs < 60_000) return "Updated just now";
  if (ageMs < 60 * 60_000) {
    const minutes = Math.max(1, Math.round(ageMs / 60_000));
    return `Updated ${minutes} min ago`;
  }
  if (ageMs < 48 * 60 * 60_000) {
    const hours = Math.max(1, Math.round(ageMs / (60 * 60_000)));
    return `Updated ${hours} hr ago`;
  }
  const days = Math.max(1, Math.round(ageMs / (24 * 60 * 60_000)));
  return `Updated ${days} days ago`;
}

function catalogIsStale(value: string, fallbackMs = 0) {
  const time = catalogDateMs(value) || fallbackMs;
  return !time || Date.now() - time > 36 * 60 * 60_000;
}

function sortedFilterValues(values: Set<string>) {
  return [...values].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function joinMetadataLabels(labels: string[]) {
  return labels.join(", ");
}

function installedKey(record: NAMInstalledModel) {
  return `installed:${record.modelId ?? record.localPath}`;
}

function makeInstallPayload(tone: NAMCatalogTone, model: NAMCatalogModel): NAMCatalogModel {
  const sourceUrl = sourceUrlOf(tone, model);
  const creator = creatorLabel(tone);
  const license = licenseLabel(tone.license);
  const gear = gearLabel(tone.gear);
  const title = toneTitle(tone, model);
  const instrument = rowInstrumentLabels(tone, model)[0] ?? "";
  const character = rowCharacterLabels(tone, model).join(", ");
  const availability = rowAvailabilityLabel(tone, model);
  const captureType = captureTypeForToneModel(tone, model);
  const preciseGearType = firstString(model.gear_type, model.gearType, model.gear)
    || (captureType !== "unknown" ? captureType : gear);
  return {
    ...model,
    tone_id: Number(model.tone_id ?? toneIdOf(tone)),
    toneId: Number(model.toneId ?? toneIdOf(tone)),
    tone_title: title,
    toneTitle: title,
    creator,
    creator_name: creator,
    license,
    license_name: license,
    gearType: preciseGearType,
    gear_type: preciseGearType,
    captureType,
    includesCab: captureIncludesCab(captureType),
    instrument,
    character,
    availability,
    sourceUrl,
    source_url: sourceUrl,
  };
}

function makeReinstallPayload(record: NAMInstalledModel): NAMCatalogModel | null {
  const metadata: NAMCatalogModel = record.lastSeenMetadata && typeof record.lastSeenMetadata === "object"
    ? { ...record.lastSeenMetadata }
    : {};
  const modelUrl = String(metadata.model_url ?? metadata.modelUrl ?? record.modelUrl ?? "");
  if (!modelUrl) return null;

  const modelId = modelIdOf(record);
  const toneId = toneIdOf(record);
  const name = String(metadata.name ?? metadata.title ?? record.name ?? "NAM model");
  return {
    ...metadata,
    id: Number(metadata.id ?? metadata.model_id ?? modelId),
    model_id: Number(metadata.model_id ?? metadata.id ?? modelId),
    tone_id: Number(metadata.tone_id ?? metadata.toneId ?? toneId),
    toneId: Number(metadata.toneId ?? metadata.tone_id ?? toneId),
    name,
    title: String(metadata.title ?? metadata.name ?? name),
    model_url: modelUrl,
    modelUrl,
    architecture_version: metadata.architecture_version ?? metadata.architecture ?? record.architecture,
    architecture: metadata.architecture ?? metadata.architecture_version ?? record.architecture,
    source_url: String(metadata.source_url ?? metadata.sourceUrl ?? record.sourceUrl ?? ""),
    sourceUrl: String(metadata.sourceUrl ?? metadata.source_url ?? record.sourceUrl ?? ""),
    license_name: String(metadata.license_name ?? metadata.license ?? record.license ?? ""),
    license: String(metadata.license ?? metadata.license_name ?? record.license ?? ""),
    creator_name: String(metadata.creator_name ?? metadata.creator ?? record.creator ?? ""),
    creator: String(metadata.creator ?? metadata.creator_name ?? record.creator ?? ""),
    gear_type: String(metadata.gear_type ?? metadata.gearType ?? record.gearType ?? ""),
    gearType: String(metadata.gearType ?? metadata.gear_type ?? record.gearType ?? ""),
    tone_title: String(metadata.tone_title ?? metadata.toneTitle ?? record.toneTitle ?? record.name ?? ""),
    toneTitle: String(metadata.toneTitle ?? metadata.tone_title ?? record.toneTitle ?? record.name ?? ""),
    checksum: String(metadata.checksum ?? metadata.sha256 ?? record.checksum ?? ""),
    sha256: String(metadata.sha256 ?? metadata.checksum ?? record.checksum ?? ""),
  };
}

function makeUpdatePayload(record: NAMInstalledModel): NAMCatalogModel | null {
  const metadata: NAMCatalogModel = record.latestMetadata && typeof record.latestMetadata === "object"
    ? { ...record.latestMetadata }
    : record.lastSeenMetadata && typeof record.lastSeenMetadata === "object"
      ? { ...record.lastSeenMetadata }
      : {};
  const modelUrl = String(metadata.model_url ?? metadata.modelUrl ?? record.latestModelUrl ?? record.modelUrl ?? "");
  if (!modelUrl) return null;

  const latestModelId = Number(metadata.id ?? metadata.model_id ?? record.latestModelId ?? record.modelId ?? 0);
  const latestToneId = Number(metadata.tone_id ?? metadata.toneId ?? record.latestToneId ?? record.toneId ?? 0);
  const name = String(metadata.name ?? metadata.title ?? record.name ?? "NAM model");
  return {
    ...metadata,
    id: latestModelId,
    model_id: Number(metadata.model_id ?? metadata.id ?? latestModelId),
    tone_id: latestToneId,
    toneId: Number(metadata.toneId ?? metadata.tone_id ?? latestToneId),
    name,
    title: String(metadata.title ?? metadata.name ?? name),
    model_url: modelUrl,
    modelUrl,
    architecture_version: metadata.architecture_version ?? metadata.architecture ?? record.architecture,
    architecture: metadata.architecture ?? metadata.architecture_version ?? record.architecture,
    source_url: String(metadata.source_url ?? metadata.sourceUrl ?? record.sourceUrl ?? ""),
    sourceUrl: String(metadata.sourceUrl ?? metadata.source_url ?? record.sourceUrl ?? ""),
    license_name: String(metadata.license_name ?? metadata.license ?? record.license ?? ""),
    license: String(metadata.license ?? metadata.license_name ?? record.license ?? ""),
    creator_name: String(metadata.creator_name ?? metadata.creator ?? record.creator ?? ""),
    creator: String(metadata.creator ?? metadata.creator_name ?? record.creator ?? ""),
    gear_type: String(metadata.gear_type ?? metadata.gearType ?? record.gearType ?? ""),
    gearType: String(metadata.gearType ?? metadata.gear_type ?? record.gearType ?? ""),
    tone_title: String(metadata.tone_title ?? metadata.toneTitle ?? record.toneTitle ?? record.name ?? ""),
    toneTitle: String(metadata.toneTitle ?? metadata.tone_title ?? record.toneTitle ?? record.name ?? ""),
    checksum: String(metadata.checksum ?? metadata.sha256 ?? record.checksum ?? ""),
    sha256: String(metadata.sha256 ?? metadata.checksum ?? record.checksum ?? ""),
  };
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set<string>();
  }
}

function saveFavorites(favorites: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}

function loadStoredValue(key: string, fallback = "") {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function parseOAuthCallback(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { code: "", state: "" };

  try {
    const parsed = new URL(trimmed);
    return {
      code: parsed.searchParams.get("code") || "",
      state: parsed.searchParams.get("state") || "",
    };
  } catch {
    const codeMatch = trimmed.match(/[?&]code=([^&]+)/);
    const stateMatch = trimmed.match(/[?&]state=([^&]+)/);
    return {
      code: codeMatch ? decodeURIComponent(codeMatch[1]) : trimmed,
      state: stateMatch ? decodeURIComponent(stateMatch[1]) : "",
    };
  }
}

function formatAuthStatus(authStatus: TONE3000AuthStatus | null) {
  if (!authStatus) return "Checking TONE3000";
  if (authStatus.error) return authStatus.error;
  if (authStatus.integrationState === "client_id_required") return "Client ID required";
  if (!authStatus.authenticated) return "Not connected";
  return authStatus.expired ? "Token expired" : "Connected";
}

function feedbackToneForStatus(status: string): NAMFeedbackTone {
  const text = status.toLowerCase();
  if (!text) return "info";
  if (/(rate limit|expired|reconnect|missing|canceled|removed|deleted|outside the nam library)/.test(text)) return "warning";
  if (/(failed|could not|unavailable|error|invalid|required)/.test(text)) return "error";
  if (/(saved|connected|updated|refreshed|loaded|re-downloaded|favorite|ready|auditioning)/.test(text)) return "success";
  if (/(loading|opening|waiting|refreshing|saving|reverting|restoring|searching|preparing)/.test(text)) return "busy";
  return "info";
}

function feedbackDetailsForStatus(status: string) {
  const text = status.toLowerCase();
  if (text.includes("rate limit")) {
    return {
      title: "TONE3000 is taking a breather",
      body: "Your installed Captures and saved Presets stay available. Wait a moment, then retry this search.",
      retryLabel: "Retry search",
    };
  }
  if (text.includes("catalog unavailable") || text.includes("search failed")) {
    return {
      title: "Online tones are unavailable",
      body: status,
      retryLabel: "Try again",
    };
  }
  if (text.includes("expired") || text.includes("reconnect")) {
    return {
      title: "Reconnect TONE3000",
      body: status,
      retryLabel: "Reconnect",
    };
  }
  if (text.includes("missing")) {
    return {
      title: "Model needs attention",
      body: status,
      retryLabel: "Retry",
    };
  }
  if (text.includes("saving")) {
    return { title: "Saving Preset", body: status, retryLabel: "Retry" };
  }
  if (text.includes("saved")) {
    return { title: "Preset saved", body: status, retryLabel: "Retry" };
  }
  if (text.includes("auditioning")) {
    return { title: "Auditioning tone", body: status, retryLabel: "Retry" };
  }
  if (text.includes("loading") || text.includes("preparing")) {
    return { title: "Preparing tone", body: status, retryLabel: "Retry" };
  }
  if (/(failed|could not|unavailable|error|invalid|required)/.test(text)) {
    return { title: "Action did not complete", body: status, retryLabel: "Try again" };
  }
  return { title: status, body: "", retryLabel: "Retry" };
}

function feedbackIconForTone(tone: NAMFeedbackTone) {
  if (tone === "success") return <CheckCircle2 size={15} />;
  if (tone === "warning" || tone === "error") return <AlertTriangle size={15} />;
  if (tone === "busy") return <RefreshCw size={15} />;
  return <Info size={15} />;
}

function NAMFeedbackBanner({
  status,
  tone,
  onRetry,
}: {
  status: string;
  tone: NAMFeedbackTone;
  onRetry?: () => void;
}) {
  const details = feedbackDetailsForStatus(status);
  return (
    <div className="nam-feedback" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <span className="nam-feedback-icon" aria-hidden="true">
        {feedbackIconForTone(tone)}
      </span>
      <span className="nam-feedback-copy">
        <strong>{details.title}</strong>
        {details.body && details.body !== details.title && <small>{details.body}</small>}
      </span>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          <RefreshCw size={13} />
          {details.retryLabel}
        </Button>
      )}
    </div>
  );
}

function NAMResultsSkeleton({ viewMode, count = 8 }: { viewMode: NAMViewMode; count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <article className="nam-result-card nam-result-skeleton" data-view={viewMode} key={`skeleton-${index}`} aria-hidden="true">
          <div className="nam-card-art" />
          <div className="nam-result-copy">
            <strong />
            <span />
            <small />
          </div>
          <div className="nam-stats">
            <span />
            <span />
          </div>
          <div className="nam-result-actions">
            <i />
          </div>
        </article>
      ))}
    </>
  );
}

function NAMEmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="nam-empty-state">
      <span aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function getNAMSourceFlowBodyAssetId(
  mode: NAMLibraryFlowMode,
  options: { moduleId?: OpenStudioFXModuleId } = {},
): NAMDesignBodyAssetId {
  const config = getNAMSourceFlowConfig(mode);
  if (mode === "fx" && options.moduleId && config.fxBodyAssetIds?.[options.moduleId]) {
    return config.fxBodyAssetIds[options.moduleId];
  }
  return config.bodyAssetId;
}

export function getNAMSourceFlowControlAssetIds(mode: NAMLibraryFlowMode): NAMDesignControlAssetId[] {
  return [...getNAMSourceFlowConfig(mode).controlAssetIds];
}

function NAMSourceFlowDesignArt({
  className,
  mode,
  moduleId,
  label,
  title,
  compact = false,
}: {
  className: string;
  mode: NAMLibraryFlowMode;
  moduleId?: OpenStudioFXModuleId;
  label: string;
  title: string;
  compact?: boolean;
}) {
  const bodyAsset = getNAMDesignBodyAsset(getNAMSourceFlowBodyAssetId(mode, { moduleId }));
  const controls = getNAMSourceFlowControlAssetIds(mode).map(getNAMDesignControlAsset);
  const designKind = mode === "fx" ? moduleId ?? "fx" : mode;
  return (
    <div
      className={`${className} nam-design-hardware-art`}
      data-has-art="true"
      data-provider-art="false"
      data-design-kind={designKind}
      data-design-body-asset-id={bodyAsset.id}
      data-design-body-file={bodyAsset.fileName}
      data-design-art-size={compact ? "compact" : "full"}
      style={{ "--nam-design-aspect": bodyAsset.aspectRatio } as CSSProperties}
      aria-hidden="true"
    >
      <img
        className="nam-design-body"
        src={bodyAsset.href}
        width={bodyAsset.width}
        height={bodyAsset.height}
        alt=""
        loading="eager"
        data-design-asset-kind="body"
        data-design-asset-id={bodyAsset.id}
      />
      <div className="nam-design-controls" data-control-count={controls.length}>
        {controls.slice(0, compact ? 4 : 6).map((asset, index) => (
          <img
            key={`${asset.id}-${index}`}
            className="nam-design-control"
            src={asset.href}
            width={asset.width}
            height={asset.height}
            alt=""
            loading="eager"
            data-design-asset-kind="control"
            data-design-asset-id={asset.id}
            data-control-index={index}
          />
        ))}
      </div>
      <div className="nam-design-hardware-label">
        <span>{label}</span>
        <strong>{title}</strong>
      </div>
    </div>
  );
}

function NAMDetailSkeleton() {
  return (
    <div className="nam-detail-skeleton" aria-hidden="true">
      <div />
      <strong />
      <p />
      <p />
      <ul>
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} />
        ))}
      </ul>
    </div>
  );
}

function defaultSortForTab(tab: NAMTab): NAMSortMode {
  if (tab === "latest") return "newest";
  if (tab === "downloads-all-time") return "downloads-all-time";
  if (tab === "trending") return "trending";
  return "name-az";
}

function apiSortForMode(sortMode: NAMSortMode) {
  if (sortMode === "favorites-count") return "trending";
  if (sortMode === "name-az") return "best-match";
  return sortMode;
}

export function resolveNAMSearchGearFilter(
  sourceFlow: NAMLibraryFlowMode | null | undefined,
  sourceCategory: string,
  selectedGearFilter: string,
) {
  if (sourceFlow === "ir") return "cab";
  if (sourceFlow === "amp" && sourceCategory === "amp") return "amp";
  if (sourceFlow === "amp" && sourceCategory === "full-rig") return "amp-cab";
  return selectedGearFilter;
}

export function resolveNAMSearchFormat(
  sourceFlow: NAMLibraryFlowMode | null | undefined,
) {
  return sourceFlow === "ir" ? "ir" : "nam";
}

export function resolveNAMSearchArchitecture(
  sourceFlow: NAMLibraryFlowMode | null | undefined,
  selectedArchitecture: string,
) {
  return sourceFlow === "ir" ? "" : selectedArchitecture;
}

function tabBucketForSort(tab: NAMTab, sort: string) {
  if (tab === "latest") return `latest ${sort}`;
  if (tab === "downloads-all-time") return `downloads-all-time ${sort}`;
  return tab;
}

function isNAMSortMode(value: string | null): value is NAMSortMode {
  return NAM_SORT_OPTIONS.some((option) => option.value === value);
}

const DEV_MOCK_AUDITION_KEY = "53101:5310102:latest newest trending clean:0:0";

function initialDevMockAudition(): NAMAuditionState | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("mockPlugin") !== "nam" || params.get("mockNAMAudition") !== "1") return null;
  return {
    key: DEV_MOCK_AUDITION_KEY,
    slot: "amp",
    toneId: 53101,
    modelId: 5310102,
    title: "Crisp Twin Clean A2",
    modelName: "Crisp Twin Clean A2",
    creator: "OpenStudio QA",
    localPath: "OpenStudio/NAM/library/dev-preview/crisp-twin-clean-a2.nam",
    previousPath: "OpenStudio/NAM/library/Clean Twin-style A2.nam",
    source: "catalog",
    previewDownload: true,
    saved: false,
    action: "live-preview",
    sourceUrl: "https://www.tone3000.com/",
    license: "Demo",
    captureType: "amp",
    includesCab: false,
    baseline: {
      pedalModelPath: "",
      ampModelPath: "OpenStudio/NAM/library/Clean Twin-style A2.nam",
      cabIRPath: "OpenStudio/NAM/library/Studio 2x12 Open IR.wav",
      cabEnabled: 1,
      cabRequestedEnabled: true,
      pedalMix: 0,
      ampEnabled: 1,
      ampMix: 1,
    },
  };
}

function initialDevScenarioStatus() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  if (params.get("mockPlugin") !== "nam") return "";
  const scenario = params.get("mockNAMScenario") ?? "";
  if (scenario === "rate-limit") return "TONE3000 rate limit reached. Wait before searching again.";
  return "";
}

function initialNAMTab(): NAMTab {
  if (typeof window === "undefined") return "trending";
  const value = new URLSearchParams(window.location.search).get("namTab");
  return value === "latest" ||
    value === "trending" ||
    value === "downloads-all-time" ||
    value === "installed" ||
    value === "favorites"
    ? value
    : "trending";
}

function initialNAMSortMode(): NAMSortMode {
  if (typeof window === "undefined") return "trending";
  const params = new URLSearchParams(window.location.search);
  const value = params.get("namSort");
  return isNAMSortMode(value) ? value : defaultSortForTab(initialNAMTab());
}

function initialNAMViewMode(): NAMViewMode {
  if (typeof window === "undefined") return "cards";
  const value = new URLSearchParams(window.location.search).get("namLayout");
  return value === "list" ? "list" : "cards";
}

function initialNAMFiltersOpen() {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get("namFilters");
  return value === "1" || value === "true";
}

function initialNAMQuery() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("namQuery") ?? "";
}

function initialNAMArchitecture() {
  if (typeof window === "undefined") return "all";
  const value = new URLSearchParams(window.location.search).get("namArch");
  return value === "a1" || value === "a2" || value === "custom" ? value : "all";
}

function initialNAMGearFilter() {
  if (typeof window === "undefined") return "amp_amp-cab";
  const value = new URLSearchParams(window.location.search).get("namGear");
  return value ?? "amp_amp-cab";
}

function initialNAMSourceFilter() {
  if (typeof window === "undefined") return "all";
  return new URLSearchParams(window.location.search).get("namSourceFilter") ?? "all";
}

interface NAMExplorerProps {
  address: BuiltInPluginAddress;
  schema: BuiltInPluginSchema;
  onRefreshRack: () => BuiltInPluginSchema | null | Promise<BuiltInPluginSchema | null>;
  onFlushPendingParamWrites?: () => Promise<boolean>;
  intent?: NAMExplorerIntent | null;
  variant?: NAMExplorerVariant;
  libraryFlow?: NAMLibraryFlowMode | null;
  onReturn?: () => void;
  onLoadLocalIR?: () => void;
  onOpenIRSources?: () => void;
  runtimeStatus?: Partial<NAMRackDesignRuntimeStatus>;
  runtimeTempo?: number;
  runtimeTimeSignature?: { numerator: number; denominator: number };
  rackSizePercent?: number;
  rackPresetName?: string;
  rackPresetDirty?: boolean;
  compareSlot?: "A" | "B";
  calibration?: NAMRackDesignCalibrationSummary;
  tunerOpen?: boolean;
  signalChainOpen?: boolean;
  sourceOriginLabel?: string;
  sourceReturnLabel?: string;
  onEnterRackSection?: (sectionId: "pre" | "amp" | "cab" | "eq" | "post") => void;
  onPreviousPreset?: () => void;
  onNextPreset?: () => void;
  previousPresetLabel?: string;
  nextPresetLabel?: string;
  onSavePreset?: () => void;
  onOpenPresetManager?: () => void;
  onRecallCompare?: (slot: "A" | "B") => void;
  onOpenCalibration?: () => void;
  onOpenTuner?: () => void;
  onOpenSignalChain?: () => void;
  onOpenAdvanced?: () => void;
  onCycleSize?: () => void;
  onMaxSize?: () => void;
  instrumentProfile?: NAMInstrumentProfile;
}

export function NAMExplorer({
  address,
  schema,
  onRefreshRack,
  onFlushPendingParamWrites,
  intent,
  variant = "full",
  libraryFlow: libraryFlowProp = null,
  onReturn,
  onLoadLocalIR,
  onOpenIRSources,
  runtimeStatus,
  runtimeTempo,
  runtimeTimeSignature,
  rackSizePercent,
  rackPresetName,
  rackPresetDirty,
  compareSlot,
  calibration,
  tunerOpen,
  signalChainOpen,
  sourceOriginLabel,
  sourceReturnLabel,
  onEnterRackSection,
  onPreviousPreset,
  onNextPreset,
  previousPresetLabel,
  nextPresetLabel,
  onSavePreset,
  onOpenPresetManager,
  onRecallCompare,
  onOpenCalibration,
  onOpenTuner,
  onOpenSignalChain,
  onOpenAdvanced,
  onCycleSize,
  onMaxSize,
  instrumentProfile: instrumentProfileProp = 0,
}: NAMExplorerProps) {
  const instrumentProfile = normalizeNAMInstrumentProfile(instrumentProfileProp);
  const railMode = variant === "rail";
  const sourceFlowMode = variant === "source-flow";
  const sourceFlow = libraryFlowProp ?? intent?.libraryFlow ?? null;
  const sourceFlowConfig = sourceFlow ? getNAMSourceFlowConfig(sourceFlow) : null;
  const sessionViewKey = `${variant}:${sourceFlow ?? "catalog"}`;
  const sessionEpochRef = useRef(createNAMExplorerSessionEpoch(sessionViewKey));
  sessionEpochRef.current.update(sessionViewKey);
  const initialSessionViewRef = useRef(getNAMExplorerSessionView(sessionViewKey));
  const initialSessionView = initialSessionViewRef.current;
  const intentSessionKeyRef = useRef(sessionViewKey);
  const persistenceSessionKeyRef = useRef(sessionViewKey);
  const sessionKeyTransition = intentSessionKeyRef.current !== sessionViewKey;
  const [sessionRestoreRevision, bumpSessionRestoreRevision] = useState(0);
  const initialCatalogEntryRef = useRef(namCatalogSession.peek());
  const initialLibraryInfoEntryRef = useRef(namLibraryInfoSession.peek());
  const initialInstalledEntryRef = useRef(namInstalledLibrarySession.peek());
  const initialCatalogPayload = initialCatalogEntryRef.current?.value;
  const initialLibraryInfoPayload = initialLibraryInfoEntryRef.current?.value;
  const initialInstalledPayload = initialInstalledEntryRef.current?.value;
  const initialCatalogRows = (initialCatalogPayload?.tones || initialCatalogPayload?.data || []) as NAMCatalogTone[];
  const initialSessionCatalogIsLive = initialSessionView?.catalogMode === "live";
  const initialRestoredCatalog = initialSessionCatalogIsLive
    ? initialSessionView?.catalog ?? []
    : initialCatalogEntryRef.current
      ? initialCatalogRows
      : initialSessionView?.catalog ?? initialCatalogRows;
  const initialLiveViewFresh = Boolean(
    initialSessionView?.catalogMode === "live"
    && initialSessionView.liveSearchSignature
    && Date.now() - initialSessionView.catalogRefreshedAtMs < NAM_EXPLORER_SESSION_TTL_MS,
  );
  const [tab, setTabState] = useState<NAMTab>(() => initialSessionView?.tab as NAMTab || initialNAMTab());
  const [sortMode, setSortModeState] = useState<NAMSortMode>(() => initialSessionView?.sortMode as NAMSortMode || initialNAMSortMode());
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const initialQueryRef = useRef(initialSessionView?.query ?? initialNAMQuery());
  const [query, setQueryState] = useState(initialQueryRef.current);
  const [committedQuery, setCommittedQuery] = useState(initialSessionView?.committedQuery ?? initialQueryRef.current);
  const [architecture, setArchitectureState] = useState(() => initialSessionView?.architecture ?? initialNAMArchitecture());
  const [slot, setSlot] = useState<NAMSlot>("amp");
  const [viewMode, setViewMode] = useState<NAMViewMode>(() => railMode ? "list" : initialSessionView?.viewMode as NAMViewMode || initialNAMViewMode());
  const [filtersOpen, setFiltersOpen] = useState(() => initialSessionView?.filtersOpen ?? initialNAMFiltersOpen());
  const [catalogMode, setCatalogMode] = useState<NAMCatalogMode>(initialSessionCatalogIsLive ? "live" : "cache");
  const [selectedKey, setSelectedKey] = useState(() => initialDevMockAudition() ? DEV_MOCK_AUDITION_KEY : "");
  const [catalog, setCatalog] = useState<NAMCatalogTone[]>(() => initialRestoredCatalog);
  const [catalogGeneratedAt, setCatalogGeneratedAt] = useState(() => initialSessionCatalogIsLive
    ? initialSessionView?.catalogGeneratedAt ?? ""
    : initialCatalogEntryRef.current
      ? String(initialCatalogPayload?.generatedAt || "")
      : initialSessionView?.catalogGeneratedAt ?? "");
  const [catalogSource, setCatalogSource] = useState(() => initialSessionCatalogIsLive
    ? initialSessionView?.catalogSource ?? ""
    : initialCatalogEntryRef.current
      ? String(initialCatalogPayload?.source || "")
      : initialSessionView?.catalogSource ?? "");
  const [catalogRefreshedAtMs, setCatalogRefreshedAtMs] = useState(() => initialSessionCatalogIsLive
    ? initialSessionView?.catalogRefreshedAtMs ?? 0
    : initialCatalogEntryRef.current?.at ?? initialSessionView?.catalogRefreshedAtMs ?? 0);
  const [installed, setInstalled] = useState<NAMInstalledModel[]>(() => (initialInstalledPayload?.installed || []) as NAMInstalledModel[]);
  const [libraryPath, setLibraryPath] = useState(() => initialLibraryInfoPayload?.libraryPath ?? "");
  const [gearFilter, setGearFilterState] = useState(() => initialSessionView?.gearFilter ?? initialNAMGearFilter());
  const [livePage, setLivePage] = useState(() => initialSessionView?.livePage ?? 1);
  const [liveTotalPages, setLiveTotalPages] = useState(() => initialSessionView?.liveTotalPages ?? 1);
  const [liveTotal, setLiveTotal] = useState(() => initialSessionView?.liveTotal ?? 0);
  const [liveHasMore, setLiveHasMore] = useState(() => initialSessionView?.liveHasMore ?? false);
  const [liveSearchSignature, setLiveSearchSignature] = useState(() => initialSessionView?.liveSearchSignature ?? "");
  const [liveBusy, setLiveBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [clientId, setClientId] = useState(() => loadStoredValue(TONE3000_CLIENT_ID_KEY));
  const [redirectUri, setRedirectUri] = useState(() => loadStoredValue(TONE3000_REDIRECT_URI_KEY, DEFAULT_REDIRECT_URI));
  const [callbackValue, setCallbackValue] = useState("");
  const [creatorFilter, setCreatorFilter] = useState(() => initialSessionView?.creatorFilter ?? "all");
  const [licenseFilter, setLicenseFilter] = useState(() => initialSessionView?.licenseFilter ?? "all");
  const [instrumentFilter, setInstrumentFilter] = useState(() => initialSessionView?.instrumentFilter ?? "all");
  const [characterFilter, setCharacterFilter] = useState(() => initialSessionView?.characterFilter ?? "all");
  const [availabilityFilter, setAvailabilityFilter] = useState(() => initialSessionView?.availabilityFilter ?? "all");
  const [sourceFlowCategoryFilter, setSourceFlowCategoryFilterState] = useState(() => initialSessionView?.sourceFlowCategoryFilter ?? initialNAMSourceFilter());
  const [busyModelId, setBusyModelId] = useState<number | null>(null);
  const [busyLibraryKey, setBusyLibraryKey] = useState<string | null>(null);
  const [audition, setAudition] = useState<NAMAuditionState | null>(() => (
    auditionFromActivePreview(normalizeNAMActivePreview(schema.uiState?.namActivePreview), schema)
    ?? initialDevMockAudition()
  ));
  const auditionRef = useRef<NAMAuditionState | null>(audition);
  const rackTransactionKey = namRackTransactionKey(address);
  const mountedRef = useRef(true);
  const pendingRackActionRef = useRef<NAMQueuedRackAction | null>(null);
  const pendingRackActionGenerationRef = useRef(0);
  const installedLibraryMutationOwnerRef = useRef<number | null>(null);
  const installedLibraryMutationSequenceRef = useRef(0);
  const liveSearchEpochRef = useRef(createTONE3000SearchEpoch());
  const liveSearchIntentSignatureRef = useRef("");
  const lastLiveSearchFailureRef = useRef<TONE3000LiveSearchFailure | null>(null);
  const lastAutomaticLiveSearchSignatureRef = useRef(initialLiveViewFresh ? initialSessionView?.liveSearchSignature ?? "" : "");
  const queryDraftRef = useRef(initialQueryRef.current);
  const committedQueryRef = useRef(initialSessionView?.committedQuery ?? initialQueryRef.current);
  const resultsScrollRef = useRef<HTMLDivElement | null>(null);
  const appendSentinelRef = useRef<HTMLDivElement | null>(null);
  const appendGateRef = useRef(createTONE3000AppendGate());
  const commitLiveSearchQueryRef = useRef<(nextQuery: string) => void>(() => undefined);
  commitLiveSearchQueryRef.current = (nextQuery) => {
    committedQueryRef.current = nextQuery;
    setCommittedQuery(nextQuery);
  };
  const queryDebouncerRef = useRef<ReturnType<typeof createTONE3000QueryDebouncer> | null>(null);
  if (queryDebouncerRef.current === null) {
    queryDebouncerRef.current = createTONE3000QueryDebouncer((nextQuery) => {
      commitLiveSearchQueryRef.current(nextQuery);
    });
  }
  const [rackTransactionBusy, setRackTransactionBusy] = useState(() => isNAMRackTransactionBusy(rackTransactionKey));
  const [installedLibraryMutationPending, setInstalledLibraryMutationPending] = useState(false);
  const [queuedRackActionLabel, setQueuedRackActionLabel] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authAdvancedOpen, setAuthAdvancedOpen] = useState(false);
  const [fallbackAuthUrl, setFallbackAuthUrl] = useState("");
  const [status, setStatus] = useState(() => initialDevScenarioStatus());
  const [captureUseProgress, setCaptureUseProgress] = useState<{
    phase: NAMCaptureUsePhase;
    rowId: string;
    message: string;
  }>({ phase: "idle", rowId: "", message: "" });
  const [removeCandidate, setRemoveCandidate] = useState<NAMInstalledModel | null>(null);
  const [rowActionErrors, setRowActionErrors] = useState<Record<string, string>>({});
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
  const [saveToneOpen, setSaveToneOpen] = useState(false);
  const [saveToneDraft, setSaveToneDraft] = useState<NAMToneSaveDraft>(() => emptyToneSaveDraft());
  const [saveToneBusy, setSaveToneBusy] = useState(false);
  const [fxPreview, setFxPreview] = useState<{
    preset: OpenStudioFXPreset;
    previousValues: Record<string, number>;
    applied: boolean;
  } | null>(null);
  const [selectedFXPresetId, setSelectedFXPresetId] = useState(
    OPENSTUDIO_FX_COLLECTION_PRESETS.find((preset) => preset.moduleId === "delay")?.id
      ?? OPENSTUDIO_FX_COLLECTION_PRESETS[0]?.id
      ?? "",
  );
  const tone3000Session = useTONE3000Session();
  const authStatus = tone3000Session.status;
  const authUiBusy = authBusy || tone3000Session.busy;
  const rackActionsBusy = rackTransactionBusy || installedLibraryMutationPending || saveToneBusy;
  const {
    hostTrack,
    openSettings,
    tempo,
    timeSignature,
    toggleTrackMonitor,
  } = useDAWStore(
    useShallow((state) => ({
      hostTrack: state.tracks.find((track) => track.id === address.trackId) ?? null,
      openSettings: state.openSettings,
      tempo: state.transport.tempo,
      timeSignature: state.timeSignature,
      toggleTrackMonitor: state.toggleTrackMonitor,
    })),
  );

  const sourceFlowTempo = Number.isFinite(runtimeTempo) ? Number(runtimeTempo) : tempo;
  const sourceFlowTimeSignature = runtimeTimeSignature ?? timeSignature;

  const invalidateLiveSearchIntent = () => {
    liveSearchEpochRef.current.invalidate();
    lastLiveSearchFailureRef.current = null;
    setLiveBusy(false);
  };

  const flushPendingQueryForIntentChange = () => {
    if (queryDraftRef.current === committedQueryRef.current) return;
    queryDebouncerRef.current?.flush(queryDraftRef.current);
  };

  const setQuery = (nextQuery: string) => {
    if (nextQuery === queryDraftRef.current && nextQuery === committedQueryRef.current) return;
    invalidateLiveSearchIntent();
    queryDraftRef.current = nextQuery;
    setQueryState(nextQuery);
    queryDebouncerRef.current?.schedule(nextQuery);
  };

  const setTab = (nextTab: NAMTab) => {
    if (nextTab === tab) return;
    invalidateLiveSearchIntent();
    flushPendingQueryForIntentChange();
    setTabState(nextTab);
  };

  const setSortMode = (nextSortMode: NAMSortMode) => {
    if (nextSortMode === sortMode) return;
    invalidateLiveSearchIntent();
    flushPendingQueryForIntentChange();
    setSortModeState(nextSortMode);
  };

  const setArchitecture = (nextArchitecture: string) => {
    if (nextArchitecture === architecture) return;
    invalidateLiveSearchIntent();
    flushPendingQueryForIntentChange();
    setArchitectureState(nextArchitecture);
  };

  const setGearFilter = (nextGearFilter: string) => {
    if (nextGearFilter === gearFilter) return;
    invalidateLiveSearchIntent();
    flushPendingQueryForIntentChange();
    setGearFilterState(nextGearFilter);
  };

  const setSourceFlowCategoryFilter = (nextCategory: string) => {
    if (nextCategory === sourceFlowCategoryFilter) return;
    invalidateLiveSearchIntent();
    flushPendingQueryForIntentChange();
    setSourceFlowCategoryFilterState(nextCategory);
  };

  const updateAudition = (next: NAMAuditionState | null) => {
    auditionRef.current = next;
    setAudition(next);
  };

  const beginRackTransaction = () => {
    if (installedLibraryMutationOwnerRef.current !== null) return null;
    return beginNAMRackTransaction(rackTransactionKey);
  };

  const beginInstalledLibraryMutation = (actionLabel: string): number | null => {
    if (installedLibraryMutationOwnerRef.current !== null) {
      setStatus(`Wait for the current installed-library change before ${actionLabel}.`);
      return null;
    }
    if (isNAMRackTransactionBusy(rackTransactionKey)) {
      setStatus(`Wait for the active rack change before ${actionLabel}.`);
      return null;
    }
    const owner = ++installedLibraryMutationSequenceRef.current;
    installedLibraryMutationOwnerRef.current = owner;
    setInstalledLibraryMutationPending(true);
    return owner;
  };

  const finishInstalledLibraryMutation = (
    owner: number,
    libraryKey: string,
    modelId?: number,
  ) => {
    if (installedLibraryMutationOwnerRef.current !== owner) return;
    setBusyLibraryKey((current) => current === libraryKey ? null : current);
    if (modelId !== undefined) {
      setBusyModelId((current) => current === modelId ? null : current);
    }
    installedLibraryMutationOwnerRef.current = null;
    if (mountedRef.current) setInstalledLibraryMutationPending(false);
  };

  const isRackTransactionCurrent = (generation: number) => (
    isNAMRackTransactionCurrent(rackTransactionKey, generation)
  );

  const canUpdateRackTransactionUI = (generation: number) => (
    mountedRef.current && isRackTransactionCurrent(generation)
  );

  const finishRackTransaction = (generation: number) => {
    finishNAMRackTransaction(rackTransactionKey, generation);
  };

  useEffect(() => {
    auditionRef.current = audition;
  }, [audition]);

  useEffect(() => {
    mountedRef.current = true;
    if (queryDraftRef.current !== committedQueryRef.current) {
      queryDebouncerRef.current?.schedule(queryDraftRef.current);
    }
    const unsubscribe = subscribeNAMRackTransaction(rackTransactionKey, setRackTransactionBusy);
    return () => {
      mountedRef.current = false;
      pendingRackActionRef.current = null;
      pendingRackActionGenerationRef.current += 1;
      liveSearchEpochRef.current.invalidate();
      queryDebouncerRef.current?.cancel();
      unsubscribe();
    };
  }, [rackTransactionKey]);

  useEffect(() => {
    if (!sortMenuOpen) return;

    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && sortMenuRef.current?.contains(target)) return;
      setSortMenuOpen(false);
    };

    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSortMenuOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [sortMenuOpen]);

  const clearRowActionError = (key: string) => {
    setRowActionErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const clearAllRowActionErrors = () => {
    setRowActionErrors((current) => Object.keys(current).length === 0 ? current : {});
  };

  const recordRowActionError = (key: string, message: string) => {
    setRowActionErrors((current) => ({ ...current, [key]: message }));
  };

  const refreshLibrary = async (force = false, isCurrent: () => boolean = () => true) => {
    const cachedInfo = namLibraryInfoSession.peek();
    const cachedLibrary = namInstalledLibrarySession.peek();
    if (isCurrent()) {
      if (cachedInfo) setLibraryPath(cachedInfo.value.libraryPath || "");
      if (cachedLibrary) setInstalled((cachedLibrary.value.installed || []) as NAMInstalledModel[]);
    }

    let info: Awaited<ReturnType<typeof nativeBridge.getNAMLibraryInfo>>;
    let libraryPayload: Awaited<ReturnType<typeof nativeBridge.getNAMLibrary>>;
    try {
      [info, libraryPayload] = await Promise.all([
        namLibraryInfoSession.load(() => nativeBridge.getNAMLibraryInfo(), { force }),
        namInstalledLibrarySession.load(() => nativeBridge.getNAMLibrary(), { force }),
        refreshTONE3000SessionStatus().catch(() => authStatus),
      ]);
    } catch (error) {
      // A successful install/remove may supersede a library read that began
      // before the mutation. The newer generation owns publication.
      if (error instanceof NAMSessionResourceInvalidatedError) return;
      throw error;
    }
    if (!isCurrent()) return;
    setLibraryPath(info.libraryPath || "");
    setInstalled((libraryPayload.installed || []) as NAMInstalledModel[]);
  };

  const refreshInstalledLibraryAfterMutation = async (
    isCurrent: () => boolean = () => true,
  ) => {
    namInstalledLibrarySession.invalidate();
    await refreshLibrary(true, isCurrent);
  };

  const refresh = async (force = false) => {
    const sessionToken = sessionEpochRef.current.capture();
    const isCurrentSession = () => (
      mountedRef.current && sessionEpochRef.current.isCurrent(sessionToken)
    );
    const preserveLiveView = !force && catalogMode === "live" && Boolean(liveSearchSignature);
    const cachedInfo = namLibraryInfoSession.peek();
    const cachedCatalog = namCatalogSession.peek();
    const cachedLibrary = namInstalledLibrarySession.peek();
    if (cachedInfo && isCurrentSession()) setLibraryPath(cachedInfo.value.libraryPath || "");
    if (cachedLibrary && isCurrentSession()) setInstalled((cachedLibrary.value.installed || []) as NAMInstalledModel[]);
    if (cachedCatalog && !preserveLiveView && isCurrentSession()) {
      const cachedPayload = cachedCatalog.value;
      setCatalog((cachedPayload.tones || cachedPayload.data || []) as NAMCatalogTone[]);
      setCatalogGeneratedAt(String(cachedPayload.generatedAt || ""));
      setCatalogSource(String(cachedPayload.source || "saved"));
      setCatalogRefreshedAtMs(cachedCatalog.at);
    }

    const [info, catalogPayload, libraryPayload] = await Promise.all([
      namLibraryInfoSession.load(() => nativeBridge.getNAMLibraryInfo(), { force }),
      namCatalogSession.load(() => nativeBridge.getNAMCatalog(), { force }),
      namInstalledLibrarySession.load(() => nativeBridge.getNAMLibrary(), { force }),
      refreshTONE3000SessionStatus().catch(() => authStatus),
    ]);
    if (!isCurrentSession()) return;
    setLibraryPath(info.libraryPath || "");
    setInstalled((libraryPayload.installed || []) as NAMInstalledModel[]);
    if (!preserveLiveView) {
      setCatalog((catalogPayload.tones || catalogPayload.data || []) as NAMCatalogTone[]);
      setCatalogGeneratedAt(String(catalogPayload.generatedAt || ""));
      setCatalogSource(String(catalogPayload.source || "saved"));
      setCatalogRefreshedAtMs(namCatalogSession.peek()?.at ?? Date.now());
      setCatalogMode("cache");
      setLivePage(1);
      setLiveTotal(0);
      setLiveTotalPages(1);
      setLiveHasMore(false);
      setLiveSearchSignature("");
    }
  };

  useEffect(() => {
    void refresh().catch((error) => {
      if (error instanceof NAMSessionResourceInvalidatedError) return;
      console.error("[NAMExplorer] Failed to load NAM catalog:", error);
      if (!namCatalogSession.peek() && catalog.length === 0) setStatus("Catalog unavailable");
    });
  }, []);

  useEffect(() => {
    if (!intent) return;
    const intentFlow = intent.libraryFlow ? getNAMSourceFlowConfig(intent.libraryFlow) : sourceFlowConfig;
    const savedSessionView = getNAMExplorerSessionView(sessionViewKey);
    const cachedCatalog = namCatalogSession.peek();
    const cachedLibrary = namInstalledLibrarySession.peek();
    const cachedInfo = namLibraryInfoSession.peek();
    const sessionKeyChanged = intentSessionKeyRef.current !== sessionViewKey;
    intentSessionKeyRef.current = sessionViewKey;
    if (sessionKeyChanged) {
      if (savedSessionView) {
        setTabState(savedSessionView.tab as NAMTab);
        setSortModeState(savedSessionView.sortMode as NAMSortMode);
        queryDraftRef.current = savedSessionView.query;
        committedQueryRef.current = savedSessionView.committedQuery;
        setQueryState(savedSessionView.query);
        setCommittedQuery(savedSessionView.committedQuery);
        setArchitectureState(savedSessionView.architecture);
        setGearFilterState(savedSessionView.gearFilter);
        setSourceFlowCategoryFilterState(savedSessionView.sourceFlowCategoryFilter);
        setCreatorFilter(savedSessionView.creatorFilter);
        setLicenseFilter(savedSessionView.licenseFilter);
        setInstrumentFilter(savedSessionView.instrumentFilter);
        setCharacterFilter(savedSessionView.characterFilter);
        setAvailabilityFilter(savedSessionView.availabilityFilter);
        setViewMode(savedSessionView.viewMode as NAMViewMode);
        setFiltersOpen(savedSessionView.filtersOpen);
        if (savedSessionView.catalogMode === "live") {
          setCatalogMode("live");
          setCatalog(savedSessionView.catalog);
          setCatalogGeneratedAt(savedSessionView.catalogGeneratedAt);
          setCatalogSource(savedSessionView.catalogSource);
          setCatalogRefreshedAtMs(savedSessionView.catalogRefreshedAtMs);
        } else {
          setCatalogMode("cache");
          setCatalog((cachedCatalog?.value.tones || cachedCatalog?.value.data || savedSessionView.catalog) as NAMCatalogTone[]);
          setCatalogGeneratedAt(String(cachedCatalog?.value.generatedAt || savedSessionView.catalogGeneratedAt));
          setCatalogSource(String(cachedCatalog?.value.source || savedSessionView.catalogSource || "saved"));
          setCatalogRefreshedAtMs(cachedCatalog?.at ?? savedSessionView.catalogRefreshedAtMs);
        }
        if (cachedLibrary) setInstalled((cachedLibrary.value.installed || []) as NAMInstalledModel[]);
        if (cachedInfo) setLibraryPath(cachedInfo.value.libraryPath || "");
        setLivePage(savedSessionView.livePage);
        setLiveTotalPages(savedSessionView.liveTotalPages);
        setLiveTotal(savedSessionView.liveTotal);
        setLiveHasMore(savedSessionView.liveHasMore);
        setLiveSearchSignature(savedSessionView.liveSearchSignature);
        const savedLiveViewFresh = savedSessionView.catalogMode === "live"
          && Date.now() - savedSessionView.catalogRefreshedAtMs < NAM_EXPLORER_SESSION_TTL_MS;
        lastAutomaticLiveSearchSignatureRef.current = savedLiveViewFresh ? savedSessionView.liveSearchSignature : "";
      } else {
        setCatalog((cachedCatalog?.value.tones || cachedCatalog?.value.data || []) as NAMCatalogTone[]);
        setCatalogGeneratedAt(String(cachedCatalog?.value.generatedAt || ""));
        setCatalogSource(String(cachedCatalog?.value.source || "saved"));
        setCatalogRefreshedAtMs(cachedCatalog?.at ?? 0);
        setInstalled((cachedLibrary?.value.installed || []) as NAMInstalledModel[]);
        setLibraryPath(cachedInfo?.value.libraryPath || "");
        setCatalogMode("cache");
        setLivePage(1);
        setLiveTotalPages(1);
        setLiveTotal(0);
        setLiveHasMore(false);
        setLiveSearchSignature("");
        lastAutomaticLiveSearchSignatureRef.current = "";
      }
      bumpSessionRestoreRevision((current) => current + 1);
    }
    const restoreSourceFlowSession = sourceFlowMode && Boolean(savedSessionView);
    invalidateLiveSearchIntent();
    queryDebouncerRef.current?.cancel();
    if (intent.tab && !restoreSourceFlowSession) {
      setTabState(intent.tab);
      setSortModeState(defaultSortForTab(intent.tab));
    }
    const nextQuery = restoreSourceFlowSession
      ? undefined
      : intent.query !== undefined ? intent.query : intentFlow?.defaultQuery;
    if (nextQuery !== undefined) {
      queryDraftRef.current = nextQuery;
      committedQueryRef.current = nextQuery;
      setQueryState(nextQuery);
      setCommittedQuery(nextQuery);
    }
    if (!restoreSourceFlowSession && intent.architecture !== undefined) setArchitectureState(intent.architecture);
    else if (!restoreSourceFlowSession && intentFlow) setArchitectureState("all");
    if (intent.gearFilter !== undefined && (!restoreSourceFlowSession || intent.categoryFilter !== undefined)) setGearFilterState(intent.gearFilter);
    else if (!restoreSourceFlowSession && intentFlow) setGearFilterState(intentFlow.defaultGearFilter);
    if (intentFlow?.targetSlot === "amp" || intentFlow?.targetSlot === "pedal") setSlot(intentFlow.targetSlot);
    if (intentFlow) {
      const requestedSourceFilter = intent.sourceFilter;
      const requestedCategory = requestedSourceFilter ?? intent.categoryFilter;
      if (requestedCategory !== undefined || !restoreSourceFlowSession) {
        setSourceFlowCategoryFilterState(requestedCategory ?? initialNAMSourceFilter());
      }
      if (intentFlow.mode === "fx" && requestedSourceFilter) {
        const matchingPreset = OPENSTUDIO_FX_COLLECTION_PRESETS.find((preset) => preset.moduleId === requestedSourceFilter);
        if (matchingPreset) setSelectedFXPresetId(matchingPreset.id);
      }
    }
    if (sourceFlowMode) {
      setViewMode("list");
      setFiltersOpen(false);
    } else {
      setFiltersOpen(true);
    }
    setSelectedKey("");
  }, [intent?.token, sessionViewKey, sourceFlowMode]);

  useEffect(() => {
    // A profile change intentionally changes discovery context. Do not leave a
    // hidden record or an opposite manual filter selected after the context
    // changes. Untagged catalog entries remain discoverable.
    setInstrumentFilter("all");
    setSelectedKey("");
  }, [instrumentProfile]);

  useEffect(() => {
    localStorage.setItem(TONE3000_CLIENT_ID_KEY, clientId);
  }, [clientId]);

  useEffect(() => {
    localStorage.setItem(TONE3000_REDIRECT_URI_KEY, redirectUri);
  }, [redirectUri]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("mockPlugin") !== "nam" || params.get("namSelect") !== "missing") return;
    const missing = installed.find((record) => record.missing);
    if (!missing) return;
    const nextKey = installedKey(missing);
    if (selectedKey !== nextKey) {
      setTab("installed");
      setSelectedKey(nextKey);
    }
  }, [installed, selectedKey]);

  const installedByModelId = useMemo(() => {
    const map = new Map<number, NAMInstalledModel>();
    for (const record of installed) {
      const modelId = modelIdOf(record);
      if (modelId > 0) map.set(modelId, record);
    }
    return map;
  }, [installed]);

  const filterOptions = useMemo(() => {
    const creators = new Set<string>();
    const licenses = new Set<string>();
    const instruments = new Set<string>();
    const characters = new Set<string>();
    const availability = new Set<string>();

    for (const tone of catalog) {
      const creator = creatorLabel(tone).trim();
      const license = licenseLabel(tone.license).trim();
      if (creator) creators.add(creator);
      if (license) licenses.add(license);

      const models = tone.models?.length ? tone.models : [{} as NAMCatalogModel];
      for (const model of models) {
        for (const instrument of rowInstrumentLabels(tone, model)) instruments.add(instrument);
        for (const character of rowCharacterLabels(tone, model)) characters.add(character);
        const availabilityLabel = rowAvailabilityLabel(tone, model);
        if (availabilityLabel) availability.add(availabilityLabel);
      }
    }

    for (const record of installed) {
      const creator = String(record.creator ?? "").trim();
      const license = String(record.license ?? "").trim();
      if (creator) creators.add(creator);
      if (license) licenses.add(license);
      for (const instrument of installedInstrumentLabels(record)) instruments.add(instrument);
      for (const character of installedCharacterLabels(record)) characters.add(character);
      const availabilityLabel = installedAvailabilityLabel(record);
      if (availabilityLabel) availability.add(availabilityLabel);
    }

    return {
      creators: sortedFilterValues(creators),
      licenses: sortedFilterValues(licenses),
      instruments: sortedFilterValues(instruments),
      characters: sortedFilterValues(characters),
      availability: sortedFilterValues(availability),
    };
  }, [catalog, installed]);

  const rows = useMemo<NAMCatalogRow[]>(() => {
    const needle = query.trim().toLowerCase();
    const flattened = catalog.flatMap((tone, toneIndex) => {
      const models = tone.models?.length ? tone.models : [{} as NAMCatalogModel];
      return models.map((model, modelIndex) => ({
        key: `${toneIdOf(tone)}:${modelIdOf(model)}:${tone.sortBucket ?? ""}:${toneIndex}:${modelIndex}`,
        tone,
        model,
      }));
    });

    const filtered = flattened.filter(({ tone, model }) => {
      const modelId = modelIdOf(model);
      const favoriteKey = `${toneIdOf(tone)}:${modelId}`;
      const arch = modelArchitecture(tone, model).toLowerCase();
      const bucket = String(tone.sortBucket ?? "");
      const matchesTab =
        tab === "installed" ? installedByModelId.has(modelId) :
        tab === "favorites" ? favorites.has(favoriteKey) :
        tab === "latest" ? bucket.includes("latest") || bucket.includes("newest") :
        bucket.includes(tab);
      if (!matchesTab) return false;
      if (architecture !== "all" && arch !== architecture) return false;
      if (creatorFilter !== "all" && creatorLabel(tone) !== creatorFilter) return false;
      if (licenseFilter !== "all" && licenseLabel(tone.license) !== licenseFilter) return false;
      const instrumentLabels = rowInstrumentLabels(tone, model);
      if (!namInstrumentLabelsAreCompatible(instrumentLabels, instrumentProfile)) return false;
      if (instrumentFilter !== "all" && !instrumentLabels.includes(instrumentFilter)) return false;
      if (characterFilter !== "all" && !rowCharacterLabels(tone, model).includes(characterFilter)) return false;
      if (availabilityFilter !== "all" && rowAvailabilityLabel(tone, model) !== availabilityFilter) return false;
      if (sourceFlow && sourceFlow !== "fx") {
        const sourceCategory = sourceCategoryForToneModel(tone, model);
        if (!isNAMSourceFlowCategoryAllowed(sourceFlow, sourceCategory)) return false;
        if (sourceFlowCategoryFilter !== "all" && sourceCategory !== sourceFlowCategoryFilter) return false;
      }
      if (!needle) return true;
      const haystack = [
        tone.title,
        tone.name,
        tone.description,
        tone.creator,
        tone.user?.username,
        gearLabel(tone.gear),
        licenseLabel(tone.license),
        ...rowInstrumentLabels(tone, model),
        ...rowCharacterLabels(tone, model),
        rowAvailabilityLabel(tone, model),
        model.name,
        model.title,
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
    return sortCatalogRows(
      filtered,
      sortMode,
      catalogMode === "live" && (Boolean(needle) || sortMode === "trending"),
    );
  }, [architecture, availabilityFilter, catalog, catalogMode, characterFilter, creatorFilter, favorites, installedByModelId, instrumentFilter, instrumentProfile, licenseFilter, query, sortMode, sourceFlow, sourceFlowCategoryFilter, tab]);
  const displayRows = boundNAMCatalogRowsForDisplay(rows, variant, catalogMode, tab);

  const installedRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = installed.filter((record) => {
      if (tab !== "installed" && tab !== "favorites") return false;
      if (tab === "favorites" && !record.favorite) return false;
      if (architecture !== "all" && architectureLabel(record.architecture).toLowerCase() !== architecture) return false;
      if (creatorFilter !== "all" && String(record.creator ?? "") !== creatorFilter) return false;
      if (licenseFilter !== "all" && String(record.license ?? "") !== licenseFilter) return false;
      const instrumentLabels = installedInstrumentLabels(record);
      if (!namInstrumentLabelsAreCompatible(instrumentLabels, instrumentProfile)) return false;
      if (instrumentFilter !== "all" && !instrumentLabels.includes(instrumentFilter)) return false;
      if (characterFilter !== "all" && !installedCharacterLabels(record).includes(characterFilter)) return false;
      if (availabilityFilter !== "all" && installedAvailabilityLabel(record) !== availabilityFilter) return false;
      if (sourceFlow && sourceFlow !== "fx") {
        const sourceCategory = sourceCategoryForInstalled(record);
        if (!isNAMSourceFlowCategoryAllowed(sourceFlow, sourceCategory)) return false;
        if (sourceFlowCategoryFilter !== "all" && sourceCategory !== sourceFlowCategoryFilter) return false;
      }
      if (!needle) return true;
      return `${installedTitle(record)} ${record.name ?? ""} ${record.creator ?? ""} ${record.gearType ?? ""} ${record.updateReason ?? ""} ${installedInstrumentLabels(record).join(" ")} ${installedCharacterLabels(record).join(" ")} ${installedAvailabilityLabel(record)} ${record.localPath ?? ""}`.toLowerCase().includes(needle);
    });
    return sortInstalledRows(filtered, sortMode);
  }, [architecture, availabilityFilter, characterFilter, creatorFilter, installed, instrumentFilter, instrumentProfile, licenseFilter, query, sortMode, sourceFlow, sourceFlowCategoryFilter, tab]);

  const selectedInstalled = tab === "installed" || tab === "favorites"
    ? installedRows.find((record) => installedKey(record) === selectedKey) ?? (!selectedKey ? installedRows[0] ?? null : null)
    : null;
  const selectedCatalogRow = selectedInstalled
    ? null
    : resolveNAMCatalogSelection(rows, selectedKey, displayRows[0] ?? null);
  const currentAmp = schema.modelState?.ampModelPath || "";
  const currentPedal = schema.modelState?.pedalModelPath || "";
  const rackActivePreview = normalizeNAMActivePreview(schema.uiState?.namActivePreview);
  const rackPreviewSessionKey = rackActivePreview
    ? `${rackActivePreview.slot}:${rackActivePreview.localPath ?? ""}:${rackActivePreview.createdAt ?? ""}`
    : "";
  const lastRackPreviewSessionKeyRef = useRef(rackPreviewSessionKey);
  useEffect(() => {
    if (rackTransactionBusy) return;
    const previousSessionKey = lastRackPreviewSessionKeyRef.current;
    lastRackPreviewSessionKeyRef.current = rackPreviewSessionKey;
    const current = auditionRef.current;
    const schemaState = {
      modelState: schema.modelState ?? {},
      values: Object.fromEntries(schema.parameters.map((parameter) => [parameter.id, parameter.value])),
    };
    // A publication whose recovery-metadata write failed is intentionally
    // held in memory. Do not let an older persisted preview session overwrite
    // it after the rack transaction becomes idle.
    if (provisionalNAMPreviewMatchesState(schemaState, current)) return;
    if (!rackActivePreview) {
      if (previousSessionKey && current && !current.saved) updateAudition(null);
      return;
    }
    const restored = auditionFromActivePreview(rackActivePreview, schema);
    if (!restored) return;
    if (current?.localPath !== restored.localPath || current?.slot !== restored.slot) updateAudition(restored);
  }, [rackPreviewSessionKey, rackTransactionBusy]);
  const rackSavedTone = schema.uiState?.namSavedTone;
  const rackSavedToneSlot = typeof rackSavedTone === "object" && rackSavedTone !== null && "slot" in rackSavedTone
    ? String((rackSavedTone as { slot?: unknown }).slot ?? "")
    : "";
  const sidebarPedalIdentity = resolveNAMToneIdentity({
    activePreview: rackActivePreview?.slot === "pedal" ? rackActivePreview : null,
    savedTone: rackSavedToneSlot === "pedal" ? rackSavedTone : null,
    installedRecord: rackActivePreview?.slot === "pedal" ? rackActivePreview.record : null,
    localPath: currentPedal,
  });
  const sidebarAmpIdentity = resolveNAMToneIdentity({
    activePreview: rackActivePreview?.slot === "amp" ? rackActivePreview : null,
    savedTone: rackSavedToneSlot === "amp" ? rackSavedTone : null,
    installedRecord: rackActivePreview?.slot === "amp" ? rackActivePreview.record : null,
    localPath: currentAmp,
  });
  const pathForSlot = (targetSlot: NAMTargetSlot) => (
    targetSlot === "amp" ? currentAmp :
    targetSlot === "cab" ? schema.modelState?.cabIRPath || "" :
    currentPedal
  );
  const isActivePreviewRecord = (record: NAMInstalledModel) => (
    Boolean(audition?.previewDownload && !audition.saved && audition.localPath === record.localPath)
  );

  const toggleFavorite = (tone: NAMCatalogTone, model: NAMCatalogModel) => {
    const key = `${toneIdOf(tone)}:${modelIdOf(model)}`;
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveFavorites(next);
      return next;
    });
  };

  const activeShelf = useMemo<NAMShelf | "">(() => {
    const needle = query.trim().toLowerCase();
    if (tab === "installed") return "installed";
    if (tab === "favorites") return "favorites";
    if (tab === "downloads-all-time") return "downloaded";
    if (tab === "latest" && architecture === "a2" && !needle) return "latest-a2";
    if (needle.includes("high gain")) return "high-gain";
    if (needle.includes("full rig")) return "full-rigs";
    if (needle.includes("ir") || needle.includes("cab")) return "irs";
    if (needle.includes("pedal")) return "pedals";
    if (needle.includes("clean")) return "clean";
    if (tab === "trending") return "trending";
    return "";
  }, [architecture, query, tab]);

  const selectShelf = (shelf: NAMShelf) => {
    setSelectedKey("");
    if (shelf === "featured") {
      setTab("trending");
      setArchitecture("all");
      setQuery("");
    } else if (shelf === "latest-a2") {
      setTab("latest");
      setArchitecture("a2");
      setQuery("");
    } else if (shelf === "trending") {
      setTab("trending");
      setArchitecture("all");
      setQuery("");
    } else if (shelf === "downloaded") {
      setTab("downloads-all-time");
      setArchitecture("all");
      setQuery("");
    } else if (shelf === "installed") {
      setTab("installed");
      setQuery("");
    } else if (shelf === "favorites") {
      setTab("favorites");
      setQuery("");
    } else {
      setTab("latest");
      setArchitecture("all");
      setQuery(
        shelf === "high-gain" ? "high gain" :
        shelf === "full-rigs" ? "full rig" :
        shelf === "irs" ? "ir" :
        shelf,
      );
    }
  };

  const startAuth = async () => {
    setAuthBusy(true);
    setFallbackAuthUrl("");
    setCallbackValue("");
    setStatus("Opening TONE3000 in your browser. Sign in or create an account there; OpenStudio never sees your password.");
    try {
      const result = await startTONE3000InteractiveAuth(clientId.trim() ? { clientId: clientId.trim() } : {});
      if (!result.success && result.status !== "connected") {
        if (result.authUrl) setFallbackAuthUrl(result.authUrl);
        if (result.fallbackRequired) setAuthAdvancedOpen(true);
        setStatus(result.error || (result.status === "canceled" ? "TONE3000 sign-in canceled" : "Could not connect TONE3000"));
        return;
      }
      await refreshLibrary(true);
      setStatus(result.toneId ? "TONE3000 connected. Selected tone metadata is ready to load." : "TONE3000 connected");
    } catch (error) {
      console.error("[NAMExplorer] TONE3000 auth flow failed:", error);
      setAuthAdvancedOpen(true);
      setStatus("TONE3000 sign-in failed. Advanced / Developer fallback is available.");
    } finally {
      setAuthBusy(false);
    }
  };

  const cancelAuth = async () => {
    try {
      await nativeBridge.cancelTONE3000AuthFlow();
      setStatus("TONE3000 sign-in canceled");
    } finally {
      setAuthBusy(false);
      void refreshLibrary(true).catch((error) => console.error("[NAMExplorer] Auth status refresh failed:", error));
    }
  };

  const startManualAuth = async () => {
    if (!clientId.trim()) {
      setStatus("Set a TONE3000 client_id in Advanced / Developer first");
      return;
    }
    if (!redirectUri.trim()) {
      setStatus("Set a redirect URI in Advanced / Developer first");
      return;
    }

    setAuthBusy(true);
    setStatus("");
    try {
      const result = await nativeBridge.createTONE3000AuthRequest(clientId.trim(), redirectUri.trim());
      if (!result.success || !result.authUrl) {
        setStatus(result.error || "Could not start TONE3000 manual auth");
        return;
      }
      setFallbackAuthUrl(result.authUrl);
      const opened = await nativeBridge.openExternalURL(result.authUrl);
      setStatus(opened ? "Complete sign-in, then paste the callback URL or code in Advanced / Developer." : "Could not open browser. Use the generated auth URL in Advanced / Developer.");
    } finally {
      setAuthBusy(false);
    }
  };

  const completeAuth = async () => {
    const { code, state } = parseOAuthCallback(callbackValue);
    if (!code || !state) {
      setStatus("Paste the complete callback URL, including its OAuth code and security state.");
      return;
    }

    setAuthBusy(true);
    setStatus("");
    try {
      const result = await completeTONE3000ManualAuth(code, state, clientId.trim(), redirectUri.trim());
      if (!result.success) {
        setStatus(result.error || "TONE3000 auth failed");
        return;
      }
      setCallbackValue("");
      await refreshLibrary(true);
      setStatus("TONE3000 connected");
    } finally {
      setAuthBusy(false);
    }
  };

  const refreshAuth = async (automatic = false) => {
    setAuthBusy(true);
    setStatus(automatic ? "Refreshing TONE3000 session..." : "");
    try {
      const result = await refreshTONE3000Session(authStatus?.clientId || clientId.trim());
      if (!result.success) {
        setStatus(result.error || (automatic ? "TONE3000 session refresh failed. Reconnect to browse online tones." : "Token refresh failed"));
        return;
      }
      await refreshLibrary(true);
      setStatus(automatic ? "TONE3000 session ready" : "TONE3000 token refreshed");
    } finally {
      setAuthBusy(false);
    }
  };

  const clearAuth = async () => {
    setAuthBusy(true);
    setStatus("");
    try {
      await clearTONE3000Session();
      setStatus("TONE3000 disconnected");
    } finally {
      setAuthBusy(false);
    }
  };

  const ensureTONE3000Auth = async (
    actionLabel: string,
    isCurrent: () => boolean = () => true,
    canUpdateUI: () => boolean = isCurrent,
  ) => {
    const result = await ensureTONE3000Session(actionLabel, clientId.trim());
    if (!isCurrent()) return false;
    if (!result.ok) {
      if (canUpdateUI()) setStatus(result.message || `Connect TONE3000 before ${actionLabel}.`);
      return false;
    }
    return true;
  };

  const refreshCatalogCache = async () => {
    setCatalogBusy(true);
    setStatus("Refreshing TONE3000 tones for offline browsing");
    try {
      if (!(await ensureTONE3000Auth("updating the NAM catalog"))) return;
      const result = await nativeBridge.refreshNAMCatalog({
        page_size: 25,
        pages: 1,
        max_model_fetches: 60,
        min_interval: 0.75,
        gears: gearFilter || "amp_amp-cab",
        architecture: architecture === "all" ? "" : architecture,
      });

      if (!result.success) {
        setStatus(result.error || "Could not refresh NAM catalog");
        return;
      }

      const catalogPayload = result.catalog || await nativeBridge.getNAMCatalog();
      const catalogEntry = namCatalogSession.set(catalogPayload);
      setCatalog((catalogPayload.tones || catalogPayload.data || []) as NAMCatalogTone[]);
      setCatalogGeneratedAt(String(catalogPayload.generatedAt || ""));
      setCatalogSource(String(catalogPayload.source || "saved"));
      setCatalogRefreshedAtMs(catalogEntry.at);
      setCatalogMode("cache");
      setTab(tab === "installed" || tab === "favorites" ? "latest" : tab);
      setSelectedKey("");
      setLivePage(1);
      setLiveTotal(0);
      setLiveTotalPages(1);
      setLiveHasMore(false);
      setLiveSearchSignature("");
      await refreshInstalledLibraryAfterMutation();
      const rowCount = Number(result.toneRows ?? (catalogPayload.tones || catalogPayload.data || []).length);
      setStatus(`Offline tone library updated (${rowCount.toLocaleString()} tone row${rowCount === 1 ? "" : "s"})`);
    } catch (error) {
      console.error("[NAMExplorer] NAM catalog refresh failed:", error);
      setStatus("NAM catalog refresh failed");
    } finally {
      setCatalogBusy(false);
    }
  };

  const hydrateModelsForTone = async (
    tone: NAMCatalogTone,
    requestedArchitecture: string,
    isCurrent: () => boolean = () => true,
    canUpdateUI: () => boolean = isCurrent,
  ) => {
    const toneId = toneIdOf(tone);
    if (toneId <= 0) {
      if (canUpdateUI()) setStatus("This tone has no TONE3000 ID.");
      return [] as NAMCatalogModel[];
    }

    const detailCacheKey = `${toneId}:${requestedArchitecture || "all"}`;
    const cachedPayload = namToneDetailSession.peekFresh(detailCacheKey)?.value ?? null;
    if (!cachedPayload && !(await ensureTONE3000Auth("loading tone details", isCurrent, canUpdateUI))) return [] as NAMCatalogModel[];
    if (!isCurrent()) return [] as NAMCatalogModel[];
    const result = cachedPayload ?? await namToneDetailSession.load(
      detailCacheKey,
      () => nativeBridge.getTONE3000ToneDetail(toneId, requestedArchitecture),
    );
    if (!isCurrent()) return [] as NAMCatalogModel[];
    if (!result.success) {
      namToneDetailSession.delete(detailCacheKey);
      if (canUpdateUI()) setStatus(result.statusCode === 429 ? "TONE3000 rate limit reached. Try again shortly." : result.error || "Could not load tone details");
      return [] as NAMCatalogModel[];
    }

    const models = ((result.models || result.tone?.models || []) as NAMCatalogModel[]).filter((model) => downloadUrlOf(model));
    if (models.length === 0) {
      if (canUpdateUI()) setStatus("This tone has no downloadable NAM model exposed yet.");
      return [] as NAMCatalogModel[];
    }

    const requestedArchLabel = architectureLabel(requestedArchitecture).toLowerCase();
    const isAllArchitecture = requestedArchitecture === "all" || requestedArchLabel === "all" || requestedArchLabel === "nam";
    if (canUpdateUI()) setCatalog((current) => current.map((existingTone) => {
      if (toneIdOf(existingTone) !== toneId) return existingTone;

      const existingArchLabel = architectureLabel(existingTone.searchArchitecture ?? existingTone.architecture).toLowerCase();
      if (!isAllArchitecture && existingArchLabel && existingArchLabel !== "nam" && existingArchLabel !== requestedArchLabel) {
        return existingTone;
      }

      return {
        ...existingTone,
        ...(result.tone || {}),
        source: existingTone.source || result.tone?.source,
        sortBucket: existingTone.sortBucket,
        architecture: existingTone.architecture ?? requestedArchitecture,
        models,
      } as NAMCatalogTone;
    }));

    return models;
  };

  const discardUnloadedPreview = async (
    record: NAMInstalledModel,
    localPath: string,
    reportFailure = false,
    isCurrent: () => boolean = () => true,
    canUpdateUI: () => boolean = isCurrent,
  ) => {
    if (!localPath) return false;
    try {
      const rackState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return false;
      if (!rackState?.modelState || typeof rackState.modelState !== "object") {
        const message = "The rack state could not be verified, so the previous preview file was kept.";
        if (reportFailure && canUpdateUI()) setStatus(message);
        else console.warn(`[NAMExplorer] ${message}`);
        return false;
      }
      const models = rackState.modelState;
      const stillLoaded = [models.ampModelPath, models.pedalModelPath, models.cabIRPath]
        .some((path) => sameLocalPath(String(path ?? ""), localPath));
      if (stillLoaded) {
        const message = "The previous preview is still loaded in the rack, so its file was kept.";
        if (reportFailure && canUpdateUI()) setStatus(message);
        else console.warn(`[NAMExplorer] ${message}`);
        return false;
      }
      const result = await nativeBridge.discardNAMPreview(record, address);
      if (!isCurrent()) return false;
      if (!result.success) {
        if (reportFailure && canUpdateUI()) setStatus(result.error || "Could not remove unsaved preview download.");
        else console.warn("[NAMExplorer] Could not remove unsaved preview download:", result.error);
        return false;
      }
      if (canUpdateUI()) await refreshInstalledLibraryAfterMutation(canUpdateUI);
      return true;
    } catch (error) {
      console.warn("[NAMExplorer] Preview cleanup failed:", error);
      if (reportFailure && canUpdateUI()) setStatus("Could not remove unsaved preview download.");
      return false;
    }
  };

  const cleanupPreviewAudition = async (
    target: NAMAuditionState | null,
    reportFailure = false,
    isCurrent: () => boolean = () => true,
    canUpdateUI: () => boolean = isCurrent,
  ) => {
    if (!target?.previewDownload || target.saved || !target.localPath) return false;
    return await discardUnloadedPreview(target.record ?? {
      modelId: target.modelId,
      toneId: target.toneId,
      localPath: target.localPath,
    } as NAMInstalledModel, target.localPath, reportFailure, isCurrent, canUpdateUI);
  };

  const enableLiveTrackMonitoring = async (
    isCurrent: () => boolean = () => true,
    canUpdateUI: () => boolean = isCurrent,
  ) => {
    if (!isCurrent() || !hostTrack || hostTrack.monitorEnabled) return;
    try {
      await toggleTrackMonitor(hostTrack.id);
    } catch (error) {
      console.warn("[NAMExplorer] Could not enable host track monitoring for live preview", error);
      if (canUpdateUI()) setStatus("Tone loaded for live guitar, but track monitoring could not be enabled automatically.");
    }
  };

  const restoreAuditionSnapshot = async (
    snapshot: NAMPreviewBaseline,
    isCurrent: () => boolean = () => true,
  ) => {
    try {
      const calibrationValues: Record<string, number> = {};
      const calibrationEntries: Array<[string, number | undefined]> = [
        ["pedalCalibrationMode", snapshot.pedalCalibrationMode],
        ["pedalOverrideInputLevelDbu", snapshot.pedalOverrideInputLevelDbu],
        ["pedalOverrideOutputLevelDbu", snapshot.pedalOverrideOutputLevelDbu],
        ["ampCalibrationMode", snapshot.ampCalibrationMode],
        ["ampOverrideInputLevelDbu", snapshot.ampOverrideInputLevelDbu],
        ["ampOverrideOutputLevelDbu", snapshot.ampOverrideOutputLevelDbu],
      ];
      for (const [id, value] of calibrationEntries) {
        if (value !== undefined && Number.isFinite(value)) calibrationValues[id] = value;
      }
      const modelState: Record<string, unknown> = {
        ...(snapshot.ampModelPath
          ? {
              ampModelPath: snapshot.ampModelPath,
              ampDeclaredCaptureType: snapshot.ampDeclaredCaptureType ?? "unknown",
            }
          : { clearAmpModel: true }),
        ...(snapshot.pedalModelPath
          ? {
              pedalModelPath: snapshot.pedalModelPath,
              pedalDeclaredCaptureType: snapshot.pedalDeclaredCaptureType ?? "unknown",
            }
          : { clearPedalModel: true }),
        ...(snapshot.cabIRPath ? { cabIRPath: snapshot.cabIRPath } : { clearCabIR: true, cabIRPath: "" }),
        cabRequestedEnabled: snapshot.cabRequestedEnabled,
      };
      const applied = await nativeBridge.setBuiltInPluginState(address, {
        modelState,
        values: {
          // cabEnabled is a request; native derives the topology-safe effective
          // value. A full rig can therefore read back effective Off while still
          // preserving the user's requested external-cab preference.
          cabEnabled: snapshot.cabRequestedEnabled ? 1 : 0,
          pedalMix: snapshot.pedalMix,
          ampEnabled: snapshot.ampEnabled,
          ampMix: snapshot.ampMix,
          ...calibrationValues,
        },
      });
      if (!applied || !isCurrent()) return false;
      const liveInputRestored = await nativeBridge.setNAMRackInternalAuditionSource(address, false);
      if (!liveInputRestored || !isCurrent()) return false;
      const restoredState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return false;
      const restoredModels = restoredState?.modelState && typeof restoredState.modelState === "object" ? restoredState.modelState : {};
      const restoredValues = restoredState?.values && typeof restoredState.values === "object" ? restoredState.values : {};
      const modelMatches = (path: unknown, hasModel: unknown, expectedPath: string) => expectedPath
        ? sameLocalPath(String(path ?? ""), expectedPath) && Boolean(hasModel)
        : !String(path ?? "").trim() && !Boolean(hasModel);
      const valueMatches = (id: string, expected: number | undefined) => expected === undefined
        || (Number.isFinite(Number(restoredValues[id])) && Math.abs(Number(restoredValues[id]) - expected) < 0.01);
      return modelMatches(restoredModels.ampModelPath, restoredModels.hasAmpModel, snapshot.ampModelPath)
        && modelMatches(restoredModels.pedalModelPath, restoredModels.hasPedalModel, snapshot.pedalModelPath)
        && modelMatches(restoredModels.cabIRPath, restoredModels.hasCabIR, snapshot.cabIRPath)
        && restoredModels.cabRequestedEnabled === snapshot.cabRequestedEnabled
        && Math.abs(Number(restoredValues.cabEnabled ?? 0) - snapshot.cabEnabled) < 0.01
        && Math.abs(Number(restoredValues.pedalMix ?? 0) - snapshot.pedalMix) < 0.01
        && Math.abs(Number(restoredValues.ampEnabled ?? 0) - snapshot.ampEnabled) < 0.01
        && Math.abs(Number(restoredValues.ampMix ?? 0) - snapshot.ampMix) < 0.01
        && valueMatches("pedalCalibrationMode", snapshot.pedalCalibrationMode)
        && valueMatches("pedalOverrideInputLevelDbu", snapshot.pedalOverrideInputLevelDbu)
        && valueMatches("pedalOverrideOutputLevelDbu", snapshot.pedalOverrideOutputLevelDbu)
        && valueMatches("ampCalibrationMode", snapshot.ampCalibrationMode)
        && valueMatches("ampOverrideInputLevelDbu", snapshot.ampOverrideInputLevelDbu)
        && valueMatches("ampOverrideOutputLevelDbu", snapshot.ampOverrideOutputLevelDbu);
    } catch (error) {
      console.warn("[NAMExplorer] Could not restore preview baseline", error);
      return false;
    }
  };

  const loadRecordForAudition = async (
    record: NAMInstalledModel,
    auditionKey: string,
    source: "catalog" | "installed" | "local",
    previousPath = pathForSlot(preferredSlotForInstalled(record)),
    previewDownload = false,
    targetSlot: NAMSlot = preferredSlotForInstalled(record),
    action: NAMLibraryAction = "live-preview",
    generation = namRackTransactionEntry(rackTransactionKey).generation,
    declaredCaptureType: NAMCaptureType = "unknown",
  ) => {
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    if (record.missing) {
      if (canUpdateUI()) setStatus("This saved tone is missing locally. Restore it before auditioning.");
      return false;
    }

    const modelId = modelIdOf(record);
    const localAudition = auditionRef.current;
    let previousAudition: NAMAuditionState | null = null;
    const requestedCaptureType = firstDeclaredCaptureType(
      declaredCaptureType,
      captureTypeForInstalled(record),
    );
    const requestedIncludesCab = targetSlot === "amp" && captureIncludesCab(requestedCaptureType);
    setSlot(targetSlot);
    setBusyModelId(modelId || null);
    setStatus("Preparing live guitar audition...");
    let publicationAccepted = false;
    let publishedAudition: NAMAuditionState | null = null;
    try {
      const beforeState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return false;
      previousAudition = auditionFromAuthoritativeState(beforeState, schema, localAudition);
      if (canUpdateUI()) {
        const current = auditionRef.current;
        const authoritativeChanged = current?.slot !== previousAudition?.slot
          || !sameLocalPath(current?.localPath ?? "", previousAudition?.localPath ?? "");
        if (authoritativeChanged) updateAudition(previousAudition);
      }
      const rollbackSnapshot = previewBaselineFromState(beforeState, schema);
      const beforeModelState = beforeState?.modelState && typeof beforeState.modelState === "object"
        ? beforeState.modelState as Record<string, unknown>
        : {};
      const authoritativeAmpIncludesCabBefore = typeof beforeModelState.ampIncludesCab === "boolean"
        ? beforeModelState.ampIncludesCab
        : undefined;
      const activeTemporaryPreview = previousAudition && !previousAudition.saved ? previousAudition : null;
      const baseline = activeTemporaryPreview?.baseline ?? rollbackSnapshot;
      const baselinePreviousPath = targetSlot === "amp"
        ? baseline.ampModelPath
        : targetSlot === "pedal"
          ? baseline.pedalModelPath
          : previousPath;

      // Publish the capture and the small set of preview-only scalar changes in
      // one native transaction. The explicit direct-load policy lets the native
      // rack reset calibration from the new capture metadata and own embedded
      // Cab/IR bypass/restore decisions without a later frontend scalar write
      // overwriting them.
      const publicationPedalMix = targetSlot === "pedal"
        ? (baseline.pedalMix > 0.0001 ? baseline.pedalMix : 1)
        : undefined;
      const publicationAmpEnabled = targetSlot === "amp" ? 1 : undefined;
      const publicationAmpMix = targetSlot === "amp"
        ? (baseline.ampMix > 0.0001 ? baseline.ampMix : 1)
        : undefined;
      const makePublishedAudition = (
        captureType: NAMCaptureType,
        includesCab: boolean,
        authoritativeAmpIncludesCab?: boolean,
      ): NAMAuditionState => ({
        key: auditionKey,
        slot: targetSlot,
        toneId: toneIdOf(record),
        modelId,
        title: record.toneTitle || record.name || "Auditioned NAM tone",
        modelName: record.name || "NAM model",
        creator: record.creator || "TONE3000",
        localPath: record.localPath,
        previousPath: baselinePreviousPath,
        source,
        previewDownload,
        saved: false,
        action,
        record,
        sourceUrl: record.sourceUrl,
        license: record.license,
        checksum: record.checksum,
        captureType,
        includesCab,
        baseline,
        provisionalPublication: {
          slot: targetSlot,
          localPath: record.localPath,
          cabRequestedEnabled: baseline.cabRequestedEnabled,
          ...(authoritativeAmpIncludesCab === undefined ? {} : {
            effectiveCabEnabled: expectedNAMEffectiveCabEnabled(
              baseline.cabRequestedEnabled,
              authoritativeAmpIncludesCab,
            ) ? 1 : 0,
          }),
          pedalMix: publicationPedalMix,
          ampEnabled: publicationAmpEnabled,
          ampMix: publicationAmpMix,
        },
      });
      const liveInputReady = await nativeBridge.setNAMRackInternalAuditionSource(address, false);
      if (!liveInputReady || !isCurrent()) return false;
      const ok = await nativeBridge.setBuiltInPluginState(address, {
        applyDirectLoadPolicy: true,
        modelState: targetSlot === "amp"
          ? {
              ampModelPath: record.localPath,
              ampDeclaredCaptureType: requestedCaptureType,
              cabRequestedEnabled: baseline.cabRequestedEnabled,
            }
          : {
              pedalModelPath: record.localPath,
              pedalDeclaredCaptureType: requestedCaptureType,
              cabRequestedEnabled: baseline.cabRequestedEnabled,
            },
        values: {
          ...(publicationPedalMix === undefined ? {} : { pedalMix: publicationPedalMix }),
          ...(publicationAmpEnabled === undefined ? {} : {
            ampEnabled: publicationAmpEnabled,
            ampMix: publicationAmpMix,
          }),
        },
      });
      if (ok) {
        publicationAccepted = true;
        // Establish an in-memory Cancel/Use baseline immediately. Readback and
        // recovery-metadata persistence are follow-up verification; they must
        // not erase knowledge of an already-audible publication if they fail.
        publishedAudition = makePublishedAudition(
          requestedCaptureType,
          requestedIncludesCab,
          targetSlot === "pedal" ? authoritativeAmpIncludesCabBefore : undefined,
        );
      }
      if (!isCurrent()) return false;
      if (!ok) {
        const currentState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
        if (!isCurrent()) return false;
        if (canUpdateUI()) {
          updateAudition(auditionFromAuthoritativeState(currentState, schema, auditionRef.current));
          setStatus("The capture was not published. The current authoritative rack state was kept; a newer rack change may have superseded this request.");
          onRefreshRack();
        }
        return false;
      }
      await enableLiveTrackMonitoring(isCurrent, canUpdateUI);
      if (!isCurrent()) return false;

      const verifiedState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return false;
      const verifiedValues = verifiedState?.values && typeof verifiedState.values === "object" ? verifiedState.values : {};
      const verifiedModelState = verifiedState?.modelState && typeof verifiedState.modelState === "object" ? verifiedState.modelState : {};
      const verifiedPath = targetSlot === "amp" ? verifiedModelState.ampModelPath : verifiedModelState.pedalModelPath;
      const verifiedHasModel = targetSlot === "amp"
        ? Boolean(verifiedModelState.hasAmpModel)
        : Boolean(verifiedModelState.hasPedalModel);
      const backendCaptureType = targetSlot === "amp"
        ? normalizeNAMCaptureType(verifiedModelState.ampCaptureType)
        : normalizeNAMCaptureType(verifiedModelState.pedalCaptureType);
      const captureType = backendCaptureType !== "unknown" ? backendCaptureType : requestedCaptureType;
      const includesCab = targetSlot === "amp"
        && Boolean(verifiedModelState.ampIncludesCab);
      const verifiedCabEnabled = Number(verifiedValues.cabEnabled);
      const verifiedCabRequestedEnabled = verifiedModelState.cabRequestedEnabled;
      const verifiedPedalMix = Number(verifiedValues.pedalMix ?? 0);
      const verifiedAmpEnabled = Number(verifiedValues.ampEnabled ?? 0);
      const verifiedAmpMix = Number(verifiedValues.ampMix ?? 0);
      const expectedVerifiedCabEnabled = expectedNAMEffectiveCabEnabled(
        baseline.cabRequestedEnabled,
        verifiedModelState.ampIncludesCab === true,
      );
      const effectiveCabMismatch = !Number.isFinite(verifiedCabEnabled)
        || (verifiedCabEnabled >= 0.5) !== expectedVerifiedCabEnabled;
      const verifiedDiagnostics =
        verifiedState?.visualization?.diagnostics && typeof verifiedState.visualization.diagnostics === "object"
          ? verifiedState.visualization.diagnostics
          : null;
      if (verifiedDiagnostics) {
        console.info("[NAM audition diagnostics:start]", verifiedDiagnostics);
      }
      const pedalMixMismatch = publicationPedalMix !== undefined
        && (!Number.isFinite(verifiedPedalMix) || Math.abs(verifiedPedalMix - publicationPedalMix) >= 0.01);
      const ampEnabledMismatch = publicationAmpEnabled !== undefined
        && (!Number.isFinite(verifiedAmpEnabled) || Math.abs(verifiedAmpEnabled - publicationAmpEnabled) >= 0.01);
      const ampMixMismatch = publicationAmpMix !== undefined
        && (!Number.isFinite(verifiedAmpMix) || Math.abs(verifiedAmpMix - publicationAmpMix) >= 0.01);
      if (!sameLocalPath(verifiedPath, record.localPath)
        || !verifiedHasModel
        || verifiedCabRequestedEnabled !== baseline.cabRequestedEnabled
        || effectiveCabMismatch
        || pedalMixMismatch
        || ampEnabledMismatch
        || ampMixMismatch) {
        if (canUpdateUI()) {
          updateAudition(auditionFromAuthoritativeState(verifiedState, schema, auditionRef.current));
          setStatus("The requested preview was superseded before verification. The current authoritative rack state was kept.");
          onRefreshRack();
        }
        return false;
      }

      const nextAudition = makePublishedAudition(
        captureType,
        includesCab,
        Boolean(verifiedModelState.ampIncludesCab),
      );
      publishedAudition = nextAudition;
      const verifiedUiState = verifiedState && typeof verifiedState.uiState === "object" && verifiedState.uiState !== null
        ? verifiedState.uiState
        : schema.uiState && typeof schema.uiState === "object"
          ? schema.uiState
          : {};
      let previewStateSaved = false;
      try {
        previewStateSaved = await nativeBridge.setBuiltInPluginState(address, {
          uiState: {
            ...verifiedUiState,
            namActivePreview: makeNAMActivePreview(record, {
              key: auditionKey,
              slot: targetSlot,
              toneId: nextAudition.toneId,
              modelId: nextAudition.modelId,
              title: nextAudition.title,
              modelName: nextAudition.modelName,
              creator: nextAudition.creator,
              localPath: nextAudition.localPath,
              previousPath: nextAudition.previousPath,
              source,
              previewDownload,
              saved: false,
              action,
              sourceUrl: nextAudition.sourceUrl,
              license: nextAudition.license,
              checksum: nextAudition.checksum,
              captureType: nextAudition.captureType,
              includesCab: nextAudition.includesCab,
              baseline: nextAudition.baseline,
            }),
          },
        });
      } catch (error) {
        console.warn("[NAMExplorer] Could not persist active preview", error);
      }
      if (!isCurrent()) return false;
      const recoverableAudition = previewStateSaved
        ? { ...nextAudition, provisionalPublication: undefined }
        : nextAudition;
      publishedAudition = recoverableAudition;
      if (canUpdateUI()) updateAudition(recoverableAudition);
      if (previousAudition?.localPath !== record.localPath) {
        await cleanupPreviewAudition(previousAudition, false, isCurrent, canUpdateUI);
        if (!isCurrent()) return false;
      }
      const ampMissingNotice = targetSlot === "pedal" && !currentAmp
        ? " Pedal captures need an amp/full-rig tone after them for a complete guitar sound."
        : "";
      if (canUpdateUI()) setStatus(
        !previewStateSaved
          ? "The audition is audible, but its session recovery metadata could not be saved. Use it or choose Stop Audition before closing this rack."
          : sourceFlow === "amp" || sourceFlow === "pedal"
            ? `Auditioning the ${targetSlot} capture with live guitar. This is temporary; choose Use Capture to keep it or Stop Audition to restore the previous capture.` + ampMissingNotice
            : `${previewDownload ? "Loaded unsaved" : "Loaded"} ${targetSlot} Capture for live guitar. Track monitoring is ${hostTrack?.monitorEnabled ? "on" : "requested"}; Save Preset stores the complete rack.` + ampMissingNotice,
      );
      window.setTimeout(() => {
        if (!mountedRef.current || !isNAMRackTransactionLatest(rackTransactionKey, generation)
          || !sameLocalPath(auditionRef.current?.localPath ?? "", record.localPath)) return;
        void nativeBridge.getBuiltInPluginState(address).then((state) => {
          if (!mountedRef.current || !isNAMRackTransactionLatest(rackTransactionKey, generation)
            || !sameLocalPath(auditionRef.current?.localPath ?? "", record.localPath)) return;
          const diagnostics =
            state?.visualization?.diagnostics && typeof state.visualization.diagnostics === "object"
              ? state.visualization.diagnostics
              : null;
          if (!diagnostics) return;

          console.info("[NAM audition diagnostics:post-start]", diagnostics);
          const lastBlockSize = Number(diagnostics.lastBlockSize ?? 0);
          const resizeAvoided = Number(diagnostics.audioThreadResizeAvoidedCount ?? 0);
          const oversizeBypasses = Number(diagnostics.oversizeBypassCount ?? 0);
          const processFails = Number(diagnostics.modelProcessFailCount ?? 0);
          const outputDb = Number(diagnostics.lastOutputPeakDb ?? -90);

          if (processFails > 0) {
            setStatus("The NAM model faulted while processing, so OpenStudio bypassed it to avoid a crash. Try another tone while I inspect the model path.");
          } else if (resizeAvoided > 0 || oversizeBypasses > 0) {
            setStatus("The audio callback exceeded the prepared NAM buffer capacity, so OpenStudio bypassed the preview instead of glitching. Increase buffer size or send the diagnostics.");
          } else if (lastBlockSize <= 0) {
            setStatus("The tone loaded, but the audio engine has not processed the rack yet. Start playback or enable monitoring while I finish the preview-routing fix.");
          } else if (outputDb <= -85) {
            setStatus("The tone loaded and the rack processed, but output is still silent. Check the track/master output routing and meters.");
          }
        }).catch(() => {});
      }, 750);
      if (canUpdateUI()) {
        // Keep the rack transaction busy until the parent accepts the schema
        // containing this preview. Otherwise the idle reconciliation effect can
        // observe the previous schema and restore the previous audition.
        await Promise.resolve(onRefreshRack());
        if (!isCurrent()) return false;
      }
      return true;
    } catch (error) {
      console.error("[NAMExplorer] Preview transaction failed:", error);
      if (publicationAccepted) {
        if (canUpdateUI()) {
          if (publishedAudition) updateAudition(publishedAudition);
          setStatus("The audition is audible, but verification or session recovery metadata could not be completed. Use it or choose Stop Audition before closing this rack.");
          onRefreshRack();
        }
        return true;
      }
      const currentState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
      if (canUpdateUI()) {
        updateAudition(auditionFromAuthoritativeState(currentState, schema, auditionRef.current));
        setStatus("Preview preparation failed. No frontend rollback was published; the current authoritative rack state was kept.");
        onRefreshRack();
      }
      return false;
    } finally {
      if (previewDownload && !publicationAccepted && isCurrent()) {
        await discardUnloadedPreview(record, record.localPath, false, isCurrent, canUpdateUI);
      }
      if (canUpdateUI()) setBusyModelId(null);
    }
  };

  const loadRecordIntoCabIR = async (
    record: NAMInstalledModel,
    source: "catalog" | "installed" | "local",
    previewDownload = false,
    generation = namRackTransactionEntry(rackTransactionKey).generation,
  ) => {
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    if (record.missing) {
      if (canUpdateUI()) setStatus("This saved IR is missing locally. Restore it before loading.");
      return false;
    }

    const modelId = modelIdOf(record);
    const localAudition = auditionRef.current;
    let previousAudition: NAMAuditionState | null = null;
    setBusyModelId(modelId || null);
    setStatus("Loading Cab/IR...");
    let publicationAccepted = false;
    let publishedAudition: NAMAuditionState | null = null;
    try {
      const beforeState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return false;
      previousAudition = auditionFromAuthoritativeState(beforeState, schema, localAudition);
      if (canUpdateUI()) {
        const current = auditionRef.current;
        const authoritativeChanged = current?.slot !== previousAudition?.slot
          || !sameLocalPath(current?.localPath ?? "", previousAudition?.localPath ?? "");
        if (authoritativeChanged) updateAudition(previousAudition);
      }
      const rollbackSnapshot = previewBaselineFromState(beforeState, schema);
      const activeTemporaryPreview = previousAudition && !previousAudition.saved ? previousAudition : null;
      const baseline = activeTemporaryPreview?.baseline ?? rollbackSnapshot;
      const baselinePreviousPath = baseline.cabIRPath;

      const currentModels = beforeState?.modelState && typeof beforeState.modelState === "object" ? beforeState.modelState : {};
      if (Boolean(currentModels.ampIncludesCab)) {
        if (canUpdateUI()) setStatus("This amp capture already includes a cabinet. Stop its audition or load an amp-only capture before auditioning an external Cab/IR.");
        return false;
      }

      const makePublishedAudition = (): NAMAuditionState => ({
        key: `cab:${record.modelId ?? record.localPath}`,
        slot: "cab",
        toneId: toneIdOf(record),
        modelId,
        title: record.toneTitle || record.name || "Cab/IR tone",
        modelName: record.name || "Cab/IR",
        creator: record.creator || "TONE3000",
        localPath: record.localPath,
        previousPath: baselinePreviousPath,
        source,
        previewDownload,
        saved: false,
        action: "live-preview",
        record,
        sourceUrl: record.sourceUrl,
        license: record.license,
        checksum: record.checksum,
        captureType: "unknown",
        includesCab: false,
        baseline,
        provisionalPublication: {
          slot: "cab",
          localPath: record.localPath,
          cabRequestedEnabled: true,
          effectiveCabEnabled: 1,
        },
      });
      const ok = await nativeBridge.setBuiltInPluginState(address, {
        modelState: {
          cabIRPath: record.localPath,
          cabRequestedEnabled: true,
        },
        values: { cabEnabled: 1 },
      });
      if (ok) {
        publicationAccepted = true;
        publishedAudition = makePublishedAudition();
      }
      if (!isCurrent()) return false;
      if (!ok) {
        const currentState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
        if (!isCurrent()) return false;
        if (canUpdateUI()) {
          updateAudition(auditionFromAuthoritativeState(currentState, schema, auditionRef.current));
          setStatus("The IR was not published. The current authoritative rack state was kept; a newer rack change may have superseded this request.");
          onRefreshRack();
        }
        return false;
      }

      const verifiedState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return false;
      const verifiedModelState = verifiedState?.modelState && typeof verifiedState.modelState === "object"
        ? verifiedState.modelState
        : {};
      const verifiedValues = verifiedState?.values && typeof verifiedState.values === "object" ? verifiedState.values : {};
      if (!sameLocalPath(String(verifiedModelState.cabIRPath ?? ""), record.localPath)
        || verifiedModelState.cabRequestedEnabled !== true
        || Number(verifiedValues.cabEnabled ?? 0) < 0.5) {
        if (canUpdateUI()) {
          updateAudition(auditionFromAuthoritativeState(verifiedState, schema, auditionRef.current));
          setStatus("The requested IR was superseded before verification. The current authoritative rack state was kept.");
          onRefreshRack();
        }
        return false;
      }

      const verifiedUiState = verifiedState && typeof verifiedState.uiState === "object" && verifiedState.uiState !== null
        ? verifiedState.uiState
        : schema.uiState && typeof schema.uiState === "object"
          ? schema.uiState
          : {};
      const nextAudition = makePublishedAudition();
      publishedAudition = nextAudition;
      let previewStateSaved = false;
      try {
        previewStateSaved = await nativeBridge.setBuiltInPluginState(address, {
          uiState: {
            ...verifiedUiState,
            namActivePreview: makeNAMActivePreview(record, {
              key: nextAudition.key,
              slot: "cab",
              toneId: nextAudition.toneId,
              modelId: nextAudition.modelId,
              title: nextAudition.title,
              modelName: nextAudition.modelName,
              creator: nextAudition.creator,
              localPath: nextAudition.localPath,
              previousPath: nextAudition.previousPath,
              source,
              previewDownload,
              saved: false,
              action: "live-preview",
              sourceUrl: nextAudition.sourceUrl,
              license: nextAudition.license,
              checksum: nextAudition.checksum,
              captureType: nextAudition.captureType,
              includesCab: false,
              baseline: nextAudition.baseline,
            }),
          },
        });
      } catch (error) {
        console.warn("[NAMExplorer] Could not persist active Cab/IR preview", error);
      }
      if (!isCurrent()) return false;

      const recoverableAudition = previewStateSaved
        ? { ...nextAudition, provisionalPublication: undefined }
        : nextAudition;
      publishedAudition = recoverableAudition;
      if (canUpdateUI()) updateAudition(recoverableAudition);
      if (previousAudition?.localPath !== record.localPath) {
        await cleanupPreviewAudition(previousAudition, false, isCurrent, canUpdateUI);
        if (!isCurrent()) return false;
      }

      await refreshLibrary(false, canUpdateUI);
      if (!isCurrent()) return false;
      if (canUpdateUI()) {
        await Promise.resolve(onRefreshRack());
        if (!isCurrent()) return false;
      }
      const sourceLabel = source === "catalog" || previewDownload ? "Downloaded and loaded" : "Loaded";
      if (canUpdateUI()) setStatus(!previewStateSaved
        ? "The IR audition is audible, but its session recovery metadata could not be saved. Use it or choose Stop Audition before closing this rack."
        : sourceFlow === "ir"
          ? `Auditioning IR${record.name ? `: ${record.name}` : ""}. This is temporary; choose Use IR to keep it or Stop Audition to restore the previous IR.`
          : `${sourceLabel} Cab/IR${record.name ? `: ${record.name}` : ""}.`);
      return true;
    } catch (error) {
      console.error("[NAMExplorer] Cab/IR preview transaction failed:", error);
      if (publicationAccepted) {
        if (canUpdateUI()) {
          if (publishedAudition) updateAudition(publishedAudition);
          setStatus("The IR audition is audible, but verification or session recovery metadata could not be completed. Use it or choose Stop Audition before closing this rack.");
          onRefreshRack();
        }
        return true;
      }
      const currentState = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
      if (canUpdateUI()) {
        updateAudition(auditionFromAuthoritativeState(currentState, schema, auditionRef.current));
        setStatus("Cab/IR preview preparation failed. No frontend rollback was published; the current authoritative rack state was kept.");
        onRefreshRack();
      }
      return false;
    } finally {
      if (previewDownload && !publicationAccepted && isCurrent()) {
        await discardUnloadedPreview(record, record.localPath, false, isCurrent, canUpdateUI);
      }
      if (canUpdateUI()) setBusyModelId(null);
    }
  };

  const loadLocalIRFile = async () => {
    const generation = beginRackTransaction();
    if (generation === null) {
      setStatus("Wait for the active rack change to finish, then choose Local IR again.");
      return false;
    }
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    try {
      const path = await nativeBridge.browseForFile("Select cabinet impulse response", "*.wav;*.aiff;*.aif;*.flac");
      if (!isCurrent()) return false;
      const localPath = path.trim();
      if (!localPath) return false;
      const record: NAMInstalledModel = {
        modelId: 0,
        toneId: 0,
        name: namDisplayNameFromPath(localPath) || "Local IR",
        toneTitle: namDisplayNameFromPath(localPath) || "Local IR",
        localPath,
        source: "local",
        sourceProvider: "local-file",
        gearType: "cabinet-ir",
      };
      return await loadRecordIntoCabIR(record, "local", false, generation);
    } catch (error) {
      console.error("[NAMExplorer] Local IR selection failed:", error);
      if (canUpdateUI()) setStatus("Could not load the selected Cab/IR file.");
      return false;
    } finally {
      finishRackTransaction(generation);
    }
  };

  const loadLocalNAMFile = async (requestedSlot: NAMSlot = sourceFlow === "pedal" ? "pedal" : "amp") => {
    const generation = beginRackTransaction();
    if (generation === null) {
      setStatus(`Wait for the active rack change to finish, then choose the local ${requestedSlot === "pedal" ? "pedal" : "amp"} capture again.`);
      return false;
    }
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    try {
      const path = await nativeBridge.browseForFile(
        requestedSlot === "pedal" ? "Select a pedal NAM capture" : "Select an amp NAM capture",
        "*.nam",
      );
      if (!isCurrent()) return false;
      const localPath = path.trim();
      if (!localPath) return false;

      const title = namDisplayNameFromPath(localPath) || (requestedSlot === "pedal" ? "Local Pedal NAM" : "Local Amp NAM");
      const record: NAMInstalledModel = {
        modelId: 0,
        toneId: 0,
        name: title,
        toneTitle: title,
        localPath,
        source: "local",
        sourceProvider: "local-file",
        gearType: requestedSlot === "pedal" ? "pedal" : "amp",
      };
      const auditionKey = `local:${requestedSlot}:${localPath}`;
      if (canUpdateUI()) setSelectedKey("");
      return await loadRecordForAudition(
        record,
        auditionKey,
        "local",
        pathForSlot(requestedSlot),
        false,
        requestedSlot,
        "live-preview",
        generation,
      );
    } catch (error) {
      console.error("[NAMExplorer] Local NAM selection failed:", error);
      if (canUpdateUI()) setStatus("Could not load the selected NAM capture.");
      return false;
    } finally {
      finishRackTransaction(generation);
    }
  };

  const auditionInstalled = async (record: NAMInstalledModel, action: NAMLibraryAction = "live-preview") => {
    const key = installedKey(record);
    const sourceCategory = sourceCategoryForInstalled(record);
    if (sourceFlow && sourceFlow !== "fx" && !isNAMSourceFlowCategoryAllowed(sourceFlow, sourceCategory)) {
      setStatus("This source is not supported in the current library flow.");
      return false;
    }
    if (sourceFlow === "ir" && sourceCategory !== "cabinet-ir") {
      setStatus("Space/Reverb IRs are source material only here. Use a cabinet IR or local IR for the Cab/IR slot.");
      return false;
    }
    const forcedTarget = sourceFlowConfig?.targetSlot !== "delay" ? sourceFlowConfig?.targetSlot : undefined;
    const targetSlot = forcedTarget ?? preferredTargetForInstalled(record);

    const generation = beginRackTransaction();
    if (generation === null) return false;
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    setSelectedKey(key);

    try {
      if (record.missing) {
        const payload = makeReinstallPayload(record);
        if (!payload) {
          if (canUpdateUI()) setStatus("This saved tone is missing download metadata. Open the source page or refresh the catalog.");
          return false;
        }

        setBusyLibraryKey(key);
        setBusyModelId(modelIdOf(record) || null);
        setStatus("Restoring tone...");
        if (!(await ensureTONE3000Auth("restoring the tone", isCurrent, canUpdateUI))) return false;
        if (!isCurrent()) return false;
        const result = await nativeBridge.installNAMModel(payload);
        if (!isCurrent()) return false;
        if (!result.success || !result.record) {
          if (canUpdateUI()) setStatus(result.error || "Could not restore tone.");
          return false;
        }
        await refreshInstalledLibraryAfterMutation(canUpdateUI);
        if (!isCurrent()) return false;
        const restoredTargetSlot = forcedTarget ?? preferredTargetForInstalled(result.record);
        if (restoredTargetSlot === "cab") {
          return await loadRecordIntoCabIR(result.record, "installed", false, generation);
        }
        return await loadRecordForAudition(result.record, key, "installed", pathForSlot(restoredTargetSlot), false, restoredTargetSlot, action, generation);
      }

      if (targetSlot === "cab") {
        return await loadRecordIntoCabIR(record, "installed", isActivePreviewRecord(record), generation);
      }

      return await loadRecordForAudition(record, key, "installed", pathForSlot(targetSlot), isActivePreviewRecord(record), targetSlot, action, generation);
    } catch (error) {
      console.error("[NAMExplorer] Saved tone audition failed:", error);
      if (canUpdateUI()) setStatus("Could not audition the saved tone.");
      return false;
    } finally {
      if (canUpdateUI()) {
        setBusyLibraryKey(null);
        setBusyModelId(null);
      }
      finishRackTransaction(generation);
    }
  };

  const auditionCatalogTone = async (row: NAMCatalogRow, action: NAMLibraryAction = "live-preview") => {
    const { tone } = row;
    let model = row.model;
    let sourceCategory = sourceCategoryForToneModel(tone, model);
    if (sourceFlow && sourceFlow !== "fx" && !isNAMSourceFlowCategoryAllowed(sourceFlow, sourceCategory)) {
      setStatus("This source is not supported in the current library flow.");
      return false;
    }
    if (sourceFlow === "ir" && sourceCategory !== "cabinet-ir") {
      setStatus("Space/Reverb IRs are source material only here. Use a cabinet IR or local IR for the Cab/IR slot.");
      return false;
    }
    const toneId = toneIdOf(tone);
    const requestedArchitecture = resolveNAMSearchArchitecture(
      sourceFlow,
      String(tone.searchArchitecture ?? tone.architecture ?? (architecture === "all" ? "all" : architecture) ?? "all"),
    );
    const detailKey = `tone-models:${toneId}:${requestedArchitecture}`;

    const generation = beginRackTransaction();
    if (generation === null) return false;
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    let unownedPreviewRecord: NAMInstalledModel | null = null;
    setSelectedKey(row.key);
    setStatus(downloadUrlOf(model) ? "Preparing live guitar audition..." : "Loading model details...");

    try {
      if (!downloadUrlOf(model)) {
        setBusyLibraryKey(detailKey);
        const models = await hydrateModelsForTone(tone, requestedArchitecture, isCurrent, canUpdateUI);
        if (!isCurrent()) return false;
        if (canUpdateUI()) setBusyLibraryKey(null);
        if (models.length === 0) {
          if (canUpdateUI()) setStatus("No downloadable model was found for this tone.");
          return false;
        }
        const forcedTarget = sourceFlowConfig?.targetSlot !== "delay" ? sourceFlowConfig?.targetSlot : undefined;
        const requestedTarget: NAMTargetSlot = forcedTarget ?? (gearFilter === "ir" ? "cab" : slot);
        model =
          models.find((candidate) => preferredTargetForToneModel(tone, candidate) === requestedTarget) ??
          models.find((candidate) => preferredTargetForToneModel(tone, candidate) === "amp") ??
          models[0];
        if (canUpdateUI()) {
          // `rows` belongs to the render that began this async transaction and
          // still contains the summary placeholder. Store a stable tone/model
          // identity now; selection resolution maps it to the hydrated row on
          // the next render, even when this tone exposes multiple models.
          setSelectedKey(`${toneId}:${modelIdOf(model)}`);
        }
        sourceCategory = sourceCategoryForToneModel(tone, model);
        if (sourceFlow && sourceFlow !== "fx" && !isNAMSourceFlowCategoryAllowed(sourceFlow, sourceCategory)) {
          if (canUpdateUI()) setStatus("The downloadable model for this tone is not supported in the current library flow.");
          return false;
        }
        if (sourceFlow === "ir" && sourceCategory !== "cabinet-ir") {
          if (canUpdateUI()) setStatus("Space/Reverb IRs are source material only here. Use a cabinet IR or local IR for the Cab/IR slot.");
          return false;
        }
      }

      const modelId = modelIdOf(model);
      const forcedTarget = sourceFlowConfig?.targetSlot !== "delay" ? sourceFlowConfig?.targetSlot : undefined;
      const targetSlot = forcedTarget ?? preferredTargetForToneModel(tone, model);
      const catalogCaptureType = captureTypeForToneModel(tone, model);
      const installedRecord = modelId > 0 ? installedByModelId.get(modelId) : undefined;
      if (installedRecord && !installedRecord.missing) {
        const installedTargetSlot = forcedTarget ?? targetSlot;
        if (installedTargetSlot === "cab") {
          return await loadRecordIntoCabIR(installedRecord, "catalog", isActivePreviewRecord(installedRecord), generation);
        }
        return await loadRecordForAudition(
          installedRecord,
          `${toneId}:${modelId}`,
          "catalog",
          pathForSlot(installedTargetSlot),
          isActivePreviewRecord(installedRecord),
          installedTargetSlot,
          action,
          generation,
          catalogCaptureType,
        );
      }

      if (!(await ensureTONE3000Auth("loading the tone", isCurrent, canUpdateUI))) return false;
      if (!isCurrent()) return false;
      setBusyModelId(modelId || null);
      if (canUpdateUI()) setStatus("Downloading audition...");
      const result = await nativeBridge.installNAMModel(makeInstallPayload(tone, model), { mode: "preview" });
      if (!isCurrent()) return false;
      if (!result.success || !result.record) {
        if (canUpdateUI()) setStatus(result.error || "Could not prepare tone.");
        return false;
      }
      unownedPreviewRecord = result.record;

      if (canUpdateUI()) setStatus("Preparing live guitar audition...");
      await refreshInstalledLibraryAfterMutation(canUpdateUI);
      if (!isCurrent()) return false;
      const installedTargetSlot = forcedTarget ?? targetSlot;
      const preparedRecord = result.record;
      unownedPreviewRecord = null;
      if (installedTargetSlot === "cab" || targetSlot === "cab") {
        return await loadRecordIntoCabIR(preparedRecord, "catalog", true, generation);
      }
      return await loadRecordForAudition(
        preparedRecord,
        `${toneId}:${modelIdOf(preparedRecord) || modelId}`,
        "catalog",
        pathForSlot(installedTargetSlot),
        true,
        installedTargetSlot,
        action,
        generation,
        catalogCaptureType,
      );
    } catch (error) {
      console.error("[NAMExplorer] Tone audition failed:", error);
      if (canUpdateUI()) setStatus("Could not audition tone.");
      return false;
    } finally {
      if (unownedPreviewRecord && isCurrent()) {
        await discardUnloadedPreview(unownedPreviewRecord, unownedPreviewRecord.localPath, false, isCurrent, canUpdateUI);
      }
      if (canUpdateUI()) {
        setBusyLibraryKey(null);
        setBusyModelId(null);
      }
      finishRackTransaction(generation);
    }
  };

  const openSaveToneModal = () => {
    if (isNAMRackTransactionBusy(rackTransactionKey)) return;
    const title = audition?.title ||
      selectedInstalled?.name ||
      (selectedCatalogRow ? toneTitle(selectedCatalogRow.tone, selectedCatalogRow.model) : selectedFXPreset ? `${selectedFXPreset.name} NAM Rack` : "NAM Rack Preset");
    const creator = audition?.creator ||
      selectedInstalled?.creator ||
      (selectedCatalogRow ? creatorLabel(selectedCatalogRow.tone) : selectedFXPreset ? "OpenStudio" : "");
    const sourceUrl = audition?.sourceUrl ||
      selectedInstalled?.sourceUrl ||
      (selectedCatalogRow ? sourceUrlOf(selectedCatalogRow.tone, selectedCatalogRow.model) : "");
    const license = audition?.license ||
      selectedInstalled?.license ||
      (selectedCatalogRow ? licenseLabel(selectedCatalogRow.tone.license) : "");
    const tags = selectedInstalled
      ? [...installedInstrumentLabels(selectedInstalled), ...installedCharacterLabels(selectedInstalled)]
      : selectedCatalogRow
        ? [...rowInstrumentLabels(selectedCatalogRow.tone, selectedCatalogRow.model), ...rowCharacterLabels(selectedCatalogRow.tone, selectedCatalogRow.model)]
        : selectedFXPreset
          ? ["OpenStudio FX", selectedFXPreset.category, selectedFXPreset.moduleId]
        : [];

    setSaveToneDraft(buildNAMToneSaveDraft({
      schema,
      title,
      creator,
      sourceUrl,
      license,
      tags: tags.slice(0, 8),
      favorite: Boolean(selectedInstalled?.favorite),
      selectedRecord: audition?.record ?? selectedInstalled ?? null,
    }));
    setSaveToneOpen(true);
  };

  const saveAuditionTone = async () => {
    const metadata = saveDraftToMetadata(saveToneDraft);
    const toneName = metadata.toneName.trim();
    if (!toneName) {
      setStatus("Name the Preset first.");
      return;
    }

    const generation = beginRackTransaction();
    if (generation === null) return;
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    setSaveToneBusy(true);
    setStatus("Saving Preset...");
    try {
      if (onFlushPendingParamWrites && !await onFlushPendingParamWrites()) {
        if (canUpdateUI()) {
          setStatus("Preset was not saved because the latest control change could not be written to the rack.");
        }
        return;
      }
      const beforeState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return;
      const localAudition = auditionRef.current;
      const activeAudition = auditionFromAuthoritativeState(beforeState, schema, localAudition);
      const beforeUiState = beforeState?.uiState && typeof beforeState.uiState === "object" ? beforeState.uiState : {};
      const backendPreviewMetadata = normalizeNAMActivePreview(beforeUiState.namActivePreview);
      if (backendPreviewMetadata && !activeAudition) {
        const stalePreviewCleared = await clearNAMActivePreview(address, schema);
        if (!isCurrent()) return;
        if (!stalePreviewCleared) {
          if (canUpdateUI()) setStatus("The rack has stale audition recovery metadata that could not be cleared, so the Preset was not saved.");
          return;
        }
      }
      if (canUpdateUI()) {
        if (activeAudition) updateAudition(activeAudition);
        else if (localAudition && !localAudition.saved) updateAudition(null);
      }
      const beforeModels = beforeState?.modelState && typeof beforeState.modelState === "object" ? beforeState.modelState : {};
      const selectedSlot = selectedInstalled ? preferredSlotForInstalled(selectedInstalled) : undefined;
      const selectedSlotPath = selectedSlot === "amp"
        ? beforeModels.ampModelPath
        : selectedSlot === "pedal"
          ? beforeModels.pedalModelPath
          : selectedSlot === "cab"
            ? beforeModels.cabIRPath
            : "";
      const selectedIsTemporary = Boolean(selectedInstalled?.preview
        || String(selectedInstalled?.localPath ?? "").replace(/\\/g, "/").toLowerCase().includes("/previews/"));
      const selectedMatchesRack = Boolean(selectedInstalled?.localPath
        && sameLocalPath(selectedInstalled.localPath, String(selectedSlotPath ?? "")));
      const selectedRecordForSave = activeAudition?.record
        ?? (activeAudition && selectedInstalled && sameLocalPath(selectedInstalled.localPath, activeAudition.localPath)
          ? selectedInstalled
          : !activeAudition && selectedInstalled && !selectedIsTemporary && selectedMatchesRack
            ? selectedInstalled
            : null);
      const currentSlot: NAMTargetSlot | undefined = activeAudition?.slot
        ?? (Boolean(beforeModels.hasAmpModel) ? "amp"
          : Boolean(beforeModels.hasPedalModel) ? "pedal"
            : Boolean(beforeModels.hasCabIR) ? "cab" : undefined);
      const activePreview = activeAudition?.record
        ? makeNAMActivePreview(activeAudition.record, {
          key: activeAudition.key,
          slot: activeAudition.slot,
          toneId: activeAudition.toneId,
          modelId: activeAudition.modelId,
          title: activeAudition.title,
          modelName: activeAudition.modelName,
          creator: activeAudition.creator,
          localPath: activeAudition.localPath,
          previousPath: activeAudition.previousPath,
          source: activeAudition.source,
          previewDownload: activeAudition.previewDownload,
          saved: activeAudition.saved,
          action: activeAudition.action,
          sourceUrl: activeAudition.sourceUrl,
          license: activeAudition.license,
          checksum: activeAudition.checksum,
          captureType: activeAudition.captureType,
          includesCab: activeAudition.includesCab,
          baseline: activeAudition.baseline,
        })
        : activeAudition ? backendPreviewMetadata : null;
      const result = await saveNAMTone({
        address,
        schema,
        metadata,
        activePreview,
        selectedRecord: selectedRecordForSave,
        slotHint: currentSlot,
        sourceIds: {
          toneId: activeAudition?.toneId ?? selectedRecordForSave?.toneId ?? 0,
          modelId: activeAudition?.modelId ?? selectedRecordForSave?.modelId ?? 0,
        },
        modelNameFallback: activeAudition && selectedCatalogRow ? modelTitle(selectedCatalogRow.model) : toneName,
        creatorFallback: activeAudition && selectedCatalogRow ? creatorLabel(selectedCatalogRow.tone) : undefined,
      });
      if (!isCurrent()) return;
      if (!result.success) {
        if (canUpdateUI()) setStatus(result.error || "Could not save Preset.");
        return;
      }

      const savedState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return;
      const savedUiState = savedState?.uiState && typeof savedState.uiState === "object" ? savedState.uiState : {};
      const identityUpdated = await nativeBridge.setBuiltInPluginState(address, {
        uiState: {
          ...savedUiState,
          namPresetDirty: false,
          namActivePresetName: toneName,
          namPresetBaseline: {
            values: savedState?.values ?? {},
            modelState: savedState?.modelState ?? {},
            presetId: "user",
            focusedModule: sourceFlow === "fx" && selectedFXPreset ? selectedFXPreset.moduleId : sourceFlowConfig?.targetSlot ?? "amp",
            capturedAt: Date.now(),
          },
        },
      });
      if (!isCurrent()) return;
      await onRefreshRack();
      if (!isCurrent()) return;

      await refreshInstalledLibraryAfterMutation(canUpdateUI);
      if (!isCurrent()) return;
      if (activeAudition && canUpdateUI()) {
        updateAudition({
          ...activeAudition,
          localPath: result.committedRecord?.localPath ?? activeAudition.localPath,
          record: result.committedRecord ?? activeAudition.record,
          previewDownload: false,
          saved: true,
        });
      }
      if (canUpdateUI()) {
        setSaveToneOpen(false);
        setStatus(
          identityUpdated
            ? "Preset saved with the complete rack settings."
            : "Preset saved, but the current rack could not be verified as its clean baseline.",
        );
      }
    } catch (error) {
      console.error("[NAMExplorer] Save Preset failed:", error);
      if (canUpdateUI()) setStatus("Could not save Preset.");
    } finally {
      if (canUpdateUI()) setSaveToneBusy(false);
      finishRackTransaction(generation);
    }
  };

  const revertAuditionInTransaction = async (generation: number) => {
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);

    setStatus("Stopping audition...");

    try {
      const beforeState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return false;
      const localAudition = auditionRef.current;
      const activeAudition = auditionFromAuthoritativeState(beforeState, schema, localAudition);
      if (!activeAudition) {
        const beforeUiState = beforeState?.uiState && typeof beforeState.uiState === "object"
          ? beforeState.uiState
          : {};
        const stalePreview = normalizeNAMActivePreview(beforeUiState.namActivePreview);
        if (stalePreview) {
          const stalePreviewCleared = await clearNAMActivePreview(address, schema);
          if (!isCurrent()) return false;
          if (!stalePreviewCleared) {
            if (canUpdateUI()) setStatus("Stale audition recovery metadata could not be cleared. Stay in the browser and retry Stop Audition.");
            return false;
          }
        }
        if (canUpdateUI()) {
          if (localAudition && !localAudition.saved) updateAudition(null);
          setStatus(stalePreview
            ? "The stale audition marker was cleared; the audible rack was left unchanged."
            : "No verified active audition is loaded, so Stop Audition did not change the rack.");
        }
        return true;
      }
      if (canUpdateUI()) updateAudition(activeAudition);
      const restored = await restoreAuditionSnapshot(activeAudition.baseline, isCurrent);
      if (!isCurrent()) return false;
      if (!restored) {
        if (canUpdateUI()) setStatus("Could not verify the restored model, Cab/IR, and source state. All audition downloads and recovery metadata were kept.");
        return false;
      }
      const previewCleared = await clearNAMActivePreview(address, schema);
      if (!isCurrent()) return false;
      if (!previewCleared) {
        if (canUpdateUI()) setStatus("The rack was restored, but audition recovery metadata could not be cleared. The audition download was kept.");
        return false;
      }
      const cleanedPreview = await cleanupPreviewAudition(activeAudition, true, isCurrent, canUpdateUI);
      if (!isCurrent()) return false;
      if (canUpdateUI()) {
        updateAudition(null);
        setStatus(activeAudition.previewDownload && !cleanedPreview
          ? "Audition stopped, but its download could not be removed."
          : "Audition stopped.");
        onRefreshRack();
      }
      return true;
    } catch (error) {
      console.error("[NAMExplorer] Revert audition failed:", error);
      if (canUpdateUI()) setStatus("Could not stop the audition.");
      return false;
    }
  };

  const revertAudition = async () => {
    const generation = beginRackTransaction();
    if (generation === null) return false;
    try {
      return await revertAuditionInTransaction(generation);
    } finally {
      finishRackTransaction(generation);
    }
  };

  const reinstallInstalled = async (record: NAMInstalledModel) => {
    const key = installedKey(record);
    const modelId = modelIdOf(record);
    const owner = beginInstalledLibraryMutation("re-downloading this model");
    if (owner === null) return;
    setBusyLibraryKey(key);
    setBusyModelId(modelId || null);
    setStatus("");
    let mutationCompleted = false;
    try {
      const payload = makeReinstallPayload(record);
      if (!payload) {
        setStatus("Missing model download metadata. Refresh the catalog or open the TONE3000 source page.");
        return;
      }
      if (!(await ensureTONE3000Auth("re-downloading NAM models"))) return;
      const result = await nativeBridge.installNAMModel(payload);
      if (!result.success) {
        setStatus(result.error || "Re-download failed");
        return;
      }
      mutationCompleted = true;
      await refreshInstalledLibraryAfterMutation();
      setStatus("Re-downloaded");
    } catch (error) {
      console.warn("[NAMExplorer] Re-download failed", error);
      setStatus(mutationCompleted
        ? "Re-downloaded, but the installed library could not be refreshed. Retry Refresh."
        : "Re-download failed");
    } finally {
      finishInstalledLibraryMutation(owner, key, modelId || undefined);
    }
  };

  const updateInstalled = async (record: NAMInstalledModel) => {
    const key = installedKey(record);
    const modelId = modelIdOf(record);
    const owner = beginInstalledLibraryMutation("updating this model");
    if (owner === null) return;
    setBusyLibraryKey(key);
    setBusyModelId(modelId || null);
    setStatus("");
    let mutationCompleted = false;
    try {
      const payload = makeUpdatePayload(record);
      if (!payload) {
        setStatus("No update metadata available. Refresh the catalog first.");
        return;
      }
      if (!(await ensureTONE3000Auth("updating NAM models"))) return;
      const result = await nativeBridge.installNAMModel(payload);
      if (!result.success) {
        setStatus(result.error || "Update failed");
        return;
      }
      mutationCompleted = true;
      await refreshInstalledLibraryAfterMutation();
      setStatus("Updated");
    } catch (error) {
      console.warn("[NAMExplorer] Installed-model update failed", error);
      setStatus(mutationCompleted
        ? "Updated, but the installed library could not be refreshed. Retry Refresh."
        : "Update failed");
    } finally {
      finishInstalledLibraryMutation(owner, key, modelId || undefined);
    }
  };

  const toggleInstalledFavorite = async (record: NAMInstalledModel) => {
    const key = installedKey(record);
    const owner = beginInstalledLibraryMutation("changing this favorite");
    if (owner === null) return;
    setBusyLibraryKey(key);
    setStatus("");
    let mutationCompleted = false;
    try {
      const result = await nativeBridge.setNAMModelFavorite(modelIdOf(record), record.localPath, !record.favorite);
      if (!result.success) {
        setStatus(result.error || "Could not update favorite");
        return;
      }
      mutationCompleted = true;
      await refreshInstalledLibraryAfterMutation();
      setStatus(!record.favorite ? "Added to favorites" : "Removed from favorites");
    } catch (error) {
      console.warn("[NAMExplorer] Favorite update failed", error);
      setStatus(mutationCompleted
        ? "Favorite changed, but the installed library could not be refreshed. Retry Refresh."
        : "Could not update favorite");
    } finally {
      finishInstalledLibraryMutation(owner, key);
    }
  };

  const removeInstalled = async (record: NAMInstalledModel) => {
    const key = installedKey(record);
    const owner = beginInstalledLibraryMutation("removing this model");
    if (owner === null) return;
    setRemoveCandidate(null);
    setBusyLibraryKey(key);
    setStatus("");
    let mutationCompleted = false;
    try {
      const result = await nativeBridge.removeNAMModel(modelIdOf(record), record.localPath, false);
      if (!result.success) {
        setStatus(result.error || "Could not remove model");
        return;
      }
      mutationCompleted = true;
      setSelectedKey("");
      await refreshInstalledLibraryAfterMutation();
      const warning = typeof result.warning === "string" ? result.warning.trim() : "";
      setStatus(warning ? `Removed from library. ${warning}` : "Removed from library; file retained on disk");
    } catch (error) {
      console.warn("[NAMExplorer] Installed-model removal failed", error);
      setStatus(mutationCompleted
        ? "Removed from the library, but the installed list could not be refreshed. Retry Refresh."
        : "Could not remove model");
    } finally {
      finishInstalledLibraryMutation(owner, key);
    }
  };

  const snapshotValues = (ids: string[]) => {
    const values: Record<string, number> = {};
    for (const id of ids) {
      const param = schema.parameters.find((entry) => entry.id === id);
      if (param) values[id] = param.value;
    }
    return values;
  };

  const applyOpenStudioFXPreset = async (
    preset: OpenStudioFXPreset,
    mode: "preview" | "apply" = "preview",
    existingGeneration?: number,
  ) => {
    const ownsTransaction = existingGeneration === undefined;
    const generation = existingGeneration ?? beginRackTransaction();
    if (generation === null) {
      setStatus("Wait for the active rack change to finish before changing an effect preset.");
      return false;
    }
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    if (canUpdateUI()) setStatus(`${mode === "preview" ? "Previewing" : "Applying"} ${preset.name}...`);

    try {
      const beforeState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return false;
      const authoritativeValues = beforeState?.values && typeof beforeState.values === "object"
        ? beforeState.values as Record<string, unknown>
        : {};
      const fallbackValues = snapshotValues(Object.keys(preset.values));
      const currentBaseline: Record<string, number> = {};
      for (const id of Object.keys(preset.values)) {
        const authoritativeValue = Number(authoritativeValues[id]);
        if (Number.isFinite(authoritativeValue)) currentBaseline[id] = authoritativeValue;
        else if (fallbackValues[id] !== undefined) currentBaseline[id] = fallbackValues[id];
      }
      const previousValues = mode === "preview" && fxPreview?.applied
        ? { ...currentBaseline, ...fxPreview.previousValues }
        : currentBaseline;
      const presetPatch = buildOpenStudioFXPresetStatePatch(preset);
      const publishedPresetPatch = {
        ...presetPatch,
        values: buildNAMModulePresetCommitValues(presetPatch.values, fxPreview),
      };
      const authoritativeUiState = beforeState?.uiState && typeof beforeState.uiState === "object" && beforeState.uiState !== null
        ? beforeState.uiState
        : schema.uiState ?? {};
      const ok = await nativeBridge.setBuiltInPluginState(address, mode === "apply"
        ? {
          ...publishedPresetPatch,
          uiState: {
            ...authoritativeUiState,
            namPresetDirty: true,
          },
        }
        : publishedPresetPatch);
      if (!isCurrent()) return false;
      if (!ok) {
        if (canUpdateUI()) setStatus(
          mode === "preview"
            ? "The FX preview was not published; the current rack state was kept."
            : "The FX preset was not applied; the current rack state was kept.",
        );
        return false;
      }
      if (canUpdateUI()) {
        if (mode === "preview") {
          setFxPreview({ preset, previousValues, applied: true });
          setStatus(`Previewing preset: ${preset.name}`);
        } else {
          setFxPreview(null);
          setStatus(`Applied FX preset: ${preset.name}`);
        }
        onRefreshRack();
      }
      return true;
    } catch (error) {
      console.warn("[NAMExplorer] FX preset transaction failed", error);
      if (canUpdateUI()) setStatus(
        mode === "preview"
          ? "Could not preview the FX preset; the current rack state was kept."
          : "Could not apply the FX preset; the current rack state was kept.",
      );
      return false;
    } finally {
      if (ownsTransaction) finishRackTransaction(generation);
    }
  };

  const revertOpenStudioFXPreset = async (existingGeneration?: number) => {
    const previewToRevert = fxPreview;
    if (!previewToRevert) return true;
    const ownsTransaction = existingGeneration === undefined;
    const generation = existingGeneration ?? beginRackTransaction();
    if (generation === null) {
      setStatus("Wait for the active rack change to finish before cancelling the effect preview.");
      return false;
    }
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    if (canUpdateUI()) setStatus("Reverting FX preset...");
    try {
      const ok = await nativeBridge.setBuiltInPluginState(address, { values: previewToRevert.previousValues });
      if (!isCurrent()) return false;
      if (!ok) {
        if (canUpdateUI()) setStatus("Could not revert the FX preset; the current rack state was kept.");
        return false;
      }
      if (canUpdateUI()) {
        setFxPreview(null);
        setStatus("Preset preview cancelled; previous effect settings restored.");
        onRefreshRack();
      }
      return true;
    } catch (error) {
      console.warn("[NAMExplorer] FX preset revert failed", error);
      if (canUpdateUI()) setStatus("Could not revert the FX preset; the current rack state was kept.");
      return false;
    } finally {
      if (ownsTransaction) finishRackTransaction(generation);
    }
  };

  const liveSearchTab = tab === "installed" || tab === "favorites" ? "trending" : tab;
  const liveSearchSort = apiSortForMode(sortMode);
  const livePageSizing = tone3000LivePageSizing(variant, architecture);
  const liveSearchGearFilter = resolveNAMSearchGearFilter(
    sourceFlow,
    sourceFlowCategoryFilter,
    gearFilter,
  );
  const liveSearchFormat = resolveNAMSearchFormat(sourceFlow);
  const liveSearchArchitecture = resolveNAMSearchArchitecture(sourceFlow, architecture);
  const buildLiveSearchSnapshot = (
    page = 1,
    queryOverride = committedQuery,
  ) => buildTONE3000LiveSearchSnapshot({
    query: queryOverride,
    page,
    pageSize: livePageSizing.apiPageSize,
    targetPageSize: livePageSizing.targetPageSize,
    requestedSort: liveSearchSort,
    sortMode,
    tab: liveSearchTab,
    gearFilter: liveSearchGearFilter,
    format: liveSearchFormat,
    architecture: liveSearchArchitecture,
    sourceFlow: sourceFlow ?? "",
    sourceFlowCategoryFilter,
    includeModels: false,
  });
  const currentLiveSearchSnapshot = buildLiveSearchSnapshot();
  const currentLiveSearchSignature = currentLiveSearchSnapshot.signature;
  liveSearchIntentSignatureRef.current = currentLiveSearchSignature;

  const runLiveSearch = async (
    page = 1,
    mode: "replace" | "append" = "replace",
    requestOverride?: TONE3000LiveSearchSnapshot,
  ): Promise<"success" | "error" | "stale"> => {
    const request = requestOverride ?? buildLiveSearchSnapshot(page);
    if (liveSearchIntentSignatureRef.current !== request.signature) return "stale";
    const requestToken = liveSearchEpochRef.current.begin(request.signature);
    const isCurrent = () => (
      mountedRef.current
      && liveSearchEpochRef.current.isCurrent(requestToken)
      && liveSearchIntentSignatureRef.current === request.signature
    );
    const cachedPayload = namLiveSearchPageSession.peekFresh(request.cacheKey)?.value ?? null;

    if (!cachedPayload) {
      setLiveBusy(true);
      setStatus("");
    }
    if (mode !== "append") clearAllRowActionErrors();
    try {
      if (!cachedPayload && !(await ensureTONE3000Auth("live search", isCurrent))) {
        return isCurrent() ? "error" : "stale";
      }
      if (!isCurrent()) return "stale";
      const payload = cachedPayload
        ? cachedPayload
        : await namLiveSearchPageSession.load(request.cacheKey, () => nativeBridge.searchTONE3000NAM({
            query: request.query,
            page: request.page,
            page_size: request.pageSize,
            sort: request.sort,
            gears: request.gearFilter,
            format: request.format,
            architecture: request.architecture,
            // Search returns only the paged tone summaries. Download/model metadata is
            // hydrated for the one tone the user previews instead of issuing an N+1
            // burst for every card on every page.
            includeModels: request.includeModels,
          }));
      if (!isCurrent()) return "stale";

      if (payload.success === false) {
        namLiveSearchPageSession.delete(request.cacheKey);
        const failureStatus = payload.statusCode === 429
          ? "TONE3000 rate limit reached. Wait before searching again."
          : payload.error || "Live TONE3000 search failed";
        lastLiveSearchFailureRef.current = {
          mode,
          page: request.page,
          signature: request.signature,
          status: failureStatus,
        };
        setStatus(failureStatus);
        return "error";
      }

      const bucket = tabBucketForSort(request.tab as NAMTab, request.sortMode as NAMSortMode);
      const liveTones = ((payload.tones || payload.data || []) as NAMCatalogTone[]).map((tone) => ({
        ...tone,
        source: "tone3000-live",
        sortBucket: bucket,
      }));
      setCatalog((current) => {
        return mergeTONE3000TonePages(
          current,
          liveTones,
          mode === "append" && catalogMode === "live" && liveSearchSignature === request.signature,
        );
      });
      setCatalogGeneratedAt(String(payload.generatedAt || new Date().toISOString()));
      setCatalogSource(String(payload.source || "tone3000-live"));
      setCatalogRefreshedAtMs(Date.now());
      setCatalogMode("live");
      setTabState(request.tab as NAMTab);
      if (mode !== "append") setSelectedKey("");
      const responsePage = Math.max(1, Number(payload.page || request.page) || request.page);
      const responsePageSize = Math.max(
        1,
        Number(payload.page_size || payload.pageSize || request.pageSize) || request.pageSize,
      );
      const reportedTotalPages = Number(payload.total_pages || payload.totalPages || 0);
      const explicitHasMore = payload.has_more ?? payload.hasMore;
      const nextPage = Number(payload.next_page ?? payload.nextPage ?? 0);
      const hasMore = typeof explicitHasMore === "boolean"
        ? explicitHasMore
        : nextPage > responsePage
          ? true
          : Number.isFinite(reportedTotalPages) && reportedTotalPages > 0
            ? responsePage < reportedTotalPages
            : liveTones.length >= responsePageSize;
      const effectiveTotalPages = Number.isFinite(reportedTotalPages) && reportedTotalPages > 0
        ? reportedTotalPages
        : hasMore
          ? responsePage + 1
          : responsePage;
      setLivePage(responsePage);
      setLiveTotal(Number(payload.total || liveTones.length));
      setLiveTotalPages(Math.max(1, effectiveTotalPages));
      setLiveHasMore(hasMore);
      setLiveSearchSignature(request.signature);
      lastLiveSearchFailureRef.current = null;
      const modelErrorCount = Array.isArray(payload.errors) ? payload.errors.length : 0;
      setStatus(modelErrorCount > 0
        ? `Online tones loaded with ${modelErrorCount} detail warning${modelErrorCount === 1 ? "" : "s"}`
        : `${cachedPayload ? "Cached" : "Online"} tones ${mode === "append" ? "appended" : "loaded"} (${liveTones.length.toLocaleString()} shown)`);
      return "success";
    } catch (error) {
      console.error("[NAMExplorer] Live TONE3000 search failed:", error);
      if (isCurrent()) {
        const failureStatus = "Live TONE3000 search failed";
        lastLiveSearchFailureRef.current = {
          mode,
          page: request.page,
          signature: request.signature,
          status: failureStatus,
        };
        setStatus(failureStatus);
      }
      return isCurrent() ? "error" : "stale";
    } finally {
      if (isCurrent()) setLiveBusy(false);
    }
  };

  const submitLiveSearch = (page = 1, mode: "replace" | "append" = "replace") => {
    const nextQuery = queryDraftRef.current;
    invalidateLiveSearchIntent();
    queryDebouncerRef.current?.flush(nextQuery);
    const request = buildLiveSearchSnapshot(page, nextQuery);
    liveSearchIntentSignatureRef.current = request.signature;
    lastAutomaticLiveSearchSignatureRef.current = request.signature;
    return runLiveSearch(page, mode, request);
  };

  const catalogAuditionIsActive = (row: NAMCatalogRow) => Boolean(
    audition
    && (audition.key === row.key
      || (audition.modelId > 0 && audition.modelId === modelIdOf(row.model))),
  );

  const installedAuditionIsActive = (record: NAMInstalledModel) => Boolean(
    audition
    && (audition.key === installedKey(record)
      || sameLocalPath(audition.localPath, record.localPath)
      || (audition.modelId > 0 && audition.modelId === modelIdOf(record))),
  );

  const toggleCatalogAudition = async (row: NAMCatalogRow) => {
    if (catalogAuditionIsActive(row)) return await revertAudition();
    return await auditionCatalogTone(row, "live-preview");
  };

  const toggleInstalledAudition = async (record: NAMInstalledModel) => {
    if (installedAuditionIsActive(record)) return await revertAudition();
    return await auditionInstalled(record, "live-preview");
  };

  const renderCatalogAction = (row: NAMCatalogRow) => {
    const { tone, model } = row;
    const modelId = modelIdOf(model);
    const installedRecord = installedByModelId.get(modelId);
    const modelUrl = downloadUrlOf(model);
    const category = sourceCategoryForToneModel(tone, model);
    if (sourceFlow === "ir" && category !== "cabinet-ir") {
      const sourceUrl = sourceUrlOf(tone, model);
      return (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => sourceUrl ? void nativeBridge.openExternalURL(sourceUrl) : undefined}
          disabled={!sourceUrl}
          title="Open convolution/source material page"
        >
          <ExternalLink size={13} />
          Open Source
        </Button>
      );
    }
    const forcedTarget = sourceFlowConfig?.targetSlot !== "delay" ? sourceFlowConfig?.targetSlot : undefined;
    const targetSlot = forcedTarget ?? (installedRecord ? preferredTargetForInstalled(installedRecord) : preferredTargetForToneModel(tone, model));
    const targetLabel = targetLabelForSlot(targetSlot);
    const TargetIcon = targetSlot === "cab" ? FolderOpen : Play;
    if (installedRecord) {
      const reinstallPayload = makeReinstallPayload(installedRecord);
      if (installedRecord.missing) {
        return (
          <Button size="sm" onClick={() => void reinstallInstalled(installedRecord)} disabled={rackActionsBusy || busyModelId === modelId || busyLibraryKey === installedKey(installedRecord) || !reinstallPayload}>
            <Download size={13} />
            {reinstallPayload ? "Reinstall" : "Missing"}
          </Button>
        );
      }

      if (targetSlot !== "cab") {
        return (
          <Button size="sm" onClick={() => void toggleInstalledAudition(installedRecord)} disabled={rackActionsBusy || busyModelId === modelId}>
            {installedAuditionIsActive(installedRecord) ? <RotateCcw size={13} /> : <Play size={13} />}
            {installedAuditionIsActive(installedRecord) ? "Stop" : "Audition"}
          </Button>
        );
      }

      return (
        <Button size="sm" onClick={() => void toggleInstalledAudition(installedRecord)} disabled={rackActionsBusy || busyModelId === modelId}>
          {installedAuditionIsActive(installedRecord) ? <RotateCcw size={13} /> : <TargetIcon size={13} />}
          {installedAuditionIsActive(installedRecord) ? "Stop" : `Audition ${targetLabel}`}
        </Button>
      );
    }
    if (!modelUrl) {
      const toneId = toneIdOf(tone);
      const requestedArchitecture = String(tone.searchArchitecture ?? tone.architecture ?? (architecture === "all" ? "all" : architecture) ?? "all");
      const requestKey = `tone-models:${toneId}:${requestedArchitecture}`;
      if (targetSlot !== "cab") {
        return (
          <Button size="sm" onClick={() => void toggleCatalogAudition(row)} disabled={rackActionsBusy || toneId <= 0 || busyLibraryKey === requestKey}>
            {busyLibraryKey === requestKey ? <RefreshCw size={13} /> : catalogAuditionIsActive(row) ? <RotateCcw size={13} /> : <Play size={13} />}
            {busyLibraryKey === requestKey ? "Loading" : catalogAuditionIsActive(row) ? "Stop" : "Audition"}
          </Button>
        );
      }
      return (
        <Button size="sm" onClick={() => void toggleCatalogAudition(row)} disabled={rackActionsBusy || toneId <= 0 || busyLibraryKey === requestKey}>
          {busyLibraryKey === requestKey ? <RefreshCw size={13} /> : catalogAuditionIsActive(row) ? <RotateCcw size={13} /> : <TargetIcon size={13} />}
          {busyLibraryKey === requestKey ? "Loading" : catalogAuditionIsActive(row) ? "Stop" : `Audition ${targetLabel}`}
        </Button>
      );
    }
    if (targetSlot !== "cab") {
      return (
        <Button size="sm" onClick={() => void toggleCatalogAudition(row)} disabled={rackActionsBusy || busyModelId === modelId}>
          {catalogAuditionIsActive(row) ? <RotateCcw size={13} /> : <Play size={13} />}
          {catalogAuditionIsActive(row) ? "Stop" : "Audition"}
        </Button>
      );
    }
    return (
      <Button size="sm" onClick={() => void toggleCatalogAudition(row)} disabled={rackActionsBusy || busyModelId === modelId}>
        {catalogAuditionIsActive(row) ? <RotateCcw size={13} /> : <TargetIcon size={13} />}
        {catalogAuditionIsActive(row) ? "Stop" : `Audition ${targetLabel}`}
      </Button>
    );
  };

  const runRailCatalogAction = async (row: NAMCatalogRow, action: NAMLibraryAction, failureMessage: string) => {
    if (isNAMRackTransactionBusy(rackTransactionKey)) return;
    clearRowActionError(row.key);
    try {
      const ok = await auditionCatalogTone(row, action);
      if (!ok) recordRowActionError(row.key, failureMessage);
    } catch (error) {
      console.error("[NAMExplorer] Rack rail catalog action failed:", error);
      recordRowActionError(row.key, failureMessage);
    }
  };

  const runRailInstalledAction = async (record: NAMInstalledModel, action: NAMLibraryAction, failureMessage: string) => {
    if (isNAMRackTransactionBusy(rackTransactionKey)) return;
    const key = installedKey(record);
    clearRowActionError(key);
    try {
      const ok = await auditionInstalled(record, action);
      if (!ok) recordRowActionError(key, failureMessage);
    } catch (error) {
      console.error("[NAMExplorer] Rack rail installed action failed:", error);
      recordRowActionError(key, failureMessage);
    }
  };

  const renderRailCatalogActions = (
    row: NAMCatalogRow,
    favoriteKey: string,
    targetSlot: NAMTargetSlot,
    isBusy: boolean,
  ) => {
    const { tone, model } = row;
    const modelId = modelIdOf(model);
    const toneId = toneIdOf(tone);
    const installedRecord = installedByModelId.get(modelId);
    const favoriteActive = favorites.has(favoriteKey);
    const actionState = buildNAMRailCatalogActionState({
      targetSlot,
      isBusy,
      toneId,
      installedRecord,
      hasDownloadUrl: Boolean(downloadUrlOf(model)),
      onlineAvailable: Boolean(authConnected || authRefreshAvailable),
    });
    const primaryAction: NAMLibraryAction = "live-preview";
    const loadIcon = actionState.loadIcon === "load" ? <FolderOpen size={14} /> : <Download size={14} />;

    return (
      <>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void runRailCatalogAction(row, primaryAction, "Could not prepare this tone for preview.")}
          disabled={actionState.primaryDisabled}
          title={actionState.primaryDisabledReason || actionState.primaryTitle}
          aria-label={actionState.primaryTitle}
        >
          {isBusy ? <RefreshCw size={14} /> : <Play size={14} />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => toggleFavorite(tone, model)}
          title={favoriteActive ? "Remove favorite" : "Favorite"}
          aria-label={favoriteActive ? "Remove favorite" : "Favorite"}
          aria-pressed={favoriteActive}
          data-active={favoriteActive}
        >
          <Heart size={14} />
        </Button>
        {installedRecord?.missing && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void runRailCatalogAction(row, "live-preview", "Could not restore or audition this tone.")}
            disabled={actionState.loadDisabled}
            title={actionState.loadDisabledReason || actionState.loadTitle}
            aria-label={actionState.loadTitle}
          >
            {isBusy ? <RefreshCw size={14} /> : loadIcon}
          </Button>
        )}
      </>
    );
  };

  const renderRailInstalledActions = (
    record: NAMInstalledModel,
    targetSlot: NAMTargetSlot,
    isBusy: boolean,
  ) => {
    const favoriteActive = Boolean(record.favorite);
    const actionState = buildNAMRailInstalledActionState({
      targetSlot,
      isBusy,
      missing: Boolean(record.missing),
      canRestoreMissing: Boolean(makeReinstallPayload(record)),
      onlineAvailable: Boolean(authConnected || authRefreshAvailable),
    });
    const primaryAction: NAMLibraryAction = "live-preview";

    return (
      <>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void runRailInstalledAction(record, primaryAction, "Could not prepare this saved tone for preview.")}
          disabled={actionState.primaryDisabled}
          title={actionState.primaryDisabledReason || actionState.primaryTitle}
          aria-label={actionState.primaryTitle}
        >
          {isBusy ? <RefreshCw size={14} /> : <Play size={14} />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void toggleInstalledFavorite(record)}
          disabled={rackActionsBusy || busyLibraryKey === installedKey(record)}
          title={favoriteActive ? "Remove favorite" : "Favorite"}
          aria-label={favoriteActive ? "Remove favorite" : "Favorite"}
          aria-pressed={favoriteActive}
          data-active={favoriteActive}
        >
          <Heart size={14} />
        </Button>
        {record.missing && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void runRailInstalledAction(record, "live-preview", "Could not restore or audition this saved tone.")}
            disabled={actionState.loadDisabled}
            title={actionState.loadDisabledReason || actionState.loadTitle}
            aria-label={actionState.loadTitle}
          >
            {isBusy ? <RefreshCw size={14} /> : actionState.loadIcon === "load" ? <FolderOpen size={14} /> : <Download size={14} />}
          </Button>
        )}
      </>
    );
  };

  const renderCatalogResult = (row: NAMCatalogRow, index = 0) => {
    const { tone, model } = row;
    const modelId = modelIdOf(model);
    const favoriteKey = `${toneIdOf(tone)}:${modelId}`;
    const arch = modelArchitecture(tone, model);
    const installedRecord = installedByModelId.get(modelId);
    const sourceCategory = sourceCategoryForToneModel(tone, model);
    const artUrl = imageUrlOf(tone, model);
    const displayArtUrl = artUrl || sourceLibraryArtForCategory(sourceCategory, tone.gear, model.gear, tone.title, model.name);
    const sourceOnlyCatalogRow = sourceFlow ? getNAMSourceFlowRowActionPolicy(sourceFlow, sourceCategory) === "source-only" : false;
    const fallbackArtProfile = artUrl
      ? "provider"
      : fallbackArtProfileForGear(tone.gear, model.gear, tone.title, tone.name, tone.description, model.title, model.name);
    const avatarUrl = creatorAvatarUrl(tone);
    const creatorUrl = creatorProfileUrl(tone);
    const isAuditioning = Boolean(audition && (audition.key === row.key || (audition.modelId > 0 && audition.modelId === modelId)));
    const targetSlot = sourceFlowForcedTarget ?? preferredTargetForToneModel(tone, model);
    const targetLabel = targetLabelForSlot(targetSlot);
    const toneId = toneIdOf(tone);
    const requestedArchitecture = String(tone.searchArchitecture ?? tone.architecture ?? (architecture === "all" ? "all" : architecture) ?? "all");
    const isBusy = rackActionsBusy || busyModelId === modelId || busyLibraryKey === `tone-models:${toneId}:${requestedArchitecture}`;
    const rowActionError = rowActionErrors[row.key] || "";
    const actionLabel = isBusy
      ? "Preparing"
      : isAuditioning
        ? audition?.saved ? "Saved" : "Stop"
        : installedRecord?.missing ? "Restore Tone" : sourceOnlyCatalogRow ? "Source Material" : `Audition ${targetLabel}`;
    const gear = gearLabel(tone.gear) || gearLabel(model.gear) || "Amp";
    const availability = rowAvailabilityLabel(tone, model);
    const license = licenseLabel(tone.license);
    const rowStatus = isAuditioning
      ? audition?.previewDownload ? "Unsaved audition" : "Audition active"
      : installedRecord?.missing ? "Restore required" : installedRecord ? "Saved locally" : "Ready to audition";
    const sourceFlowRowStatus = sourceOnlyCatalogRow ? "Convolution source material" : rowStatus;
    const railDownloads = formatCompactCount(tone.downloads_count);
    const railFavorites = formatCompactCount(tone.favorites_count);
    const railStats = catalogStatsLabel(tone);
    const railSmallText = rowActionError || ((isBusy || isAuditioning || installedRecord?.missing) ? rowStatus : railStats);
    const showRailStatsLine = railMode && !rowActionError && railSmallText === railStats;
    const showRailNewBadge = railMode
      && catalogMode === "live"
      && sortMode === "newest"
      && index < 2;
    const catalogMetaLine = railMode
      ? [creatorLabel(tone), catalogDescriptorLabel(tone, model)]
          .map((item) => item.trim())
          .filter(Boolean)
          .join(" / ")
      : `${creatorLabel(tone)} - ${modelTitle(model)}`;
    return (
      <article
        className="nam-result-card tone-feed-row"
        data-view={viewMode}
        data-selected={selectedCatalogRow?.key === row.key}
        data-audition={isAuditioning}
        data-busy={isBusy}
        data-source="tone3000"
        data-category={sourceCategory}
        data-has-art={Boolean(displayArtUrl)}
        data-provider-art={Boolean(artUrl)}
        data-fallback-profile={fallbackArtProfile}
        data-action-error={rowActionError ? "true" : undefined}
        data-rail-stats={railMode ? railStats : undefined}
        data-new={showRailNewBadge ? "true" : undefined}
        key={row.key}
        onClick={() => setSelectedKey(row.key)}
        onDoubleClick={() => {
          if (!sourceOnlyCatalogRow) void auditionCatalogTone(row, "live-preview");
        }}
      >
        <button
          type="button"
          className="nam-result-select-target"
          onClick={(event) => {
            event.stopPropagation();
            setSelectedKey(row.key);
          }}
          aria-label={`Select ${toneTitle(tone, model)} details`}
        />
        <button
          type="button"
          className="nam-favorite"
          data-active={favorites.has(favoriteKey)}
          onClick={(event) => {
            event.stopPropagation();
            toggleFavorite(tone, model);
          }}
          title="Favorite"
          aria-label={favorites.has(favoriteKey) ? "Remove favorite" : "Favorite"}
          aria-pressed={favorites.has(favoriteKey)}
        >
          <Star size={14} />
        </button>
        {showRailNewBadge && <span className="nam-rail-new-tag">NEW</span>}
        {sourceFlow ? (
          <NAMSourceFlowDesignArt
            className="nam-card-art"
            mode={sourceFlow}
            label={arch}
            title={gear}
            compact
          />
        ) : (
          <div className="nam-card-art" data-arch={arch.toLowerCase()} style={artBackgroundStyle(displayArtUrl)}>
            <span>{arch}</span>
            <strong>{gear}</strong>
            <div className="nam-card-titleplate">
              <b>{toneTitle(tone, model)}</b>
              <small>{creatorLabel(tone)} - {modelTitle(model)}</small>
            </div>
            <em className="nam-card-audition-puck" aria-hidden="true">
              {isBusy ? <RefreshCw size={13} /> : targetSlot === "cab" ? <FolderOpen size={13} /> : <Play size={13} />}
              {actionLabel}
            </em>
          </div>
        )}
        <div className="nam-result-copy">
          <strong>{toneTitle(tone, model)}</strong>
          <span className="nam-creator-line">
            {avatarUrl && <img src={avatarUrl} alt="" loading="lazy" />}
            {catalogMetaLine}
          </span>
          <small
            className={showRailStatsLine ? "nam-rail-stats-line" : undefined}
            data-kind={rowActionError ? "error" : showRailStatsLine ? "stats" : "status"}
            data-downloads={showRailStatsLine ? railDownloads : undefined}
            data-favorites={showRailStatsLine ? railFavorites : undefined}
            title={rowActionError || (showRailStatsLine ? sourceFlowRowStatus : undefined)}
            aria-label={showRailStatsLine ? `${railDownloads} downloads, ${railFavorites} favorites` : undefined}
          >
            {showRailStatsLine ? (
              <>
                <span><Download size={10} />{railDownloads}</span>
                <span><Heart size={10} />{railFavorites}</span>
              </>
            ) : railMode ? railSmallText : sourceFlowRowStatus}
          </small>
        </div>
        <div className="nam-result-badges">
          <span>{arch}</span>
          <span>{gear}</span>
          {(availability || license) && <span>{availability || license}</span>}
        </div>
        <div className="nam-stats">
          <span>{Number(tone.downloads_count || 0).toLocaleString()} dl</span>
          <span>{Number(tone.favorites_count || 0).toLocaleString()} fav</span>
        </div>
        <div className="nam-result-actions" onClick={(event) => event.stopPropagation()}>
          {railMode ? renderRailCatalogActions(row, favoriteKey, targetSlot, isBusy) : renderCatalogAction(row)}
          {!railMode && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setSelectedKey(row.key)}>
                Details
              </Button>
              {sourceUrlOf(tone, model) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void nativeBridge.openExternalURL(sourceUrlOf(tone, model))}
                  title="Open source"
                  aria-label="Open source"
                >
                  <ExternalLink size={13} />
                </Button>
              )}
              {!sourceFlowConfig && creatorUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void nativeBridge.openExternalURL(creatorUrl)}
                  title="Open creator profile"
                  aria-label="Open creator profile"
                >
                  <Info size={13} />
                  Creator
                </Button>
              )}
            </>
          )}
        </div>
      </article>
    );
  };

  const renderInstalledResult = (record: NAMInstalledModel) => {
    const key = installedKey(record);
    const hasUpdate = Boolean(record.updateAvailable && !record.missing);
    const artUrl = installedImageUrl(record);
    const displayArtUrl = artUrl || fallbackArtForGear(record.gear, record.lastSeenMetadata?.gear, record.latestMetadata?.gear);
    const fallbackArtProfile = artUrl
      ? "provider"
      : fallbackArtProfileForGear(
          record.gear,
          record.gearType,
          record.name,
          record.toneTitle,
          record.lastSeenMetadata?.gear,
          record.lastSeenMetadata?.name,
          record.latestMetadata?.gear,
          record.latestMetadata?.name,
        );
    const isAuditioning = Boolean(audition && (audition.key === key || (audition.modelId > 0 && audition.modelId === modelIdOf(record))));
    const targetSlot = sourceFlowForcedTarget ?? preferredTargetForInstalled(record);
    const targetLabel = targetLabelForSlot(targetSlot);
    const isBusy = rackActionsBusy || busyLibraryKey === key || busyModelId === record.modelId;
    const rowActionError = rowActionErrors[key] || "";
    const sourceCategory = sourceCategoryForInstalled(record);
    const sourceOnlyInstalledIR = sourceFlow === "ir" && getNAMSourceFlowRowActionPolicy("ir", sourceCategory) === "source-only";
    const actionLabel = isBusy
      ? "Preparing"
      : record.missing ? "Restore Tone" : sourceOnlyInstalledIR ? "Source Material" : isAuditioning ? audition?.saved ? "Saved" : "Stop" : `Audition ${targetLabel}`;
    const arch = architectureLabel(record.architecture);
    const gear = gearLabel(record.gear) || gearLabel(record.gearType) || "Installed";
    const availability = installedAvailabilityLabel(record);
    const installedLabel = formatDateLabel(record.installedAt);
    const updatedLabel = formatDateLabel(record.updatedAt || record.manifestUpdatedAt);
    const sizeLabel = formatFileSize(Number(record.fileSizeBytes));
    const recordTitle = installedTitle(record);
    const installedMetaLine = railMode
      ? [record.creator, installedDescriptorLabel(record)]
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .join(" / ") || "Installed locally"
      : record.creator || installedLabel || "Installed locally";
    const installedRailStatus = rowActionError || (record.missing
      ? "Missing local file"
      : hasUpdate
        ? `Update available${record.updateReason ? ` - ${record.updateReason}` : ""}`
        : sourceOnlyInstalledIR ? "Convolution source material"
        : isAuditioning ? audition?.previewDownload ? "Unsaved audition" : "Audition active" : installedLabel || "Saved locally");
    return (
      <article
        className="nam-result-card tone-feed-row"
        data-view={viewMode}
        data-selected={selectedInstalled === record}
        data-update={hasUpdate}
        data-audition={isAuditioning}
        data-busy={isBusy}
        data-source={record.sourceProvider || record.source || "local"}
        data-category={sourceCategory}
        data-has-art={Boolean(displayArtUrl)}
        data-provider-art={Boolean(artUrl)}
        data-fallback-profile={fallbackArtProfile}
        data-action-error={rowActionError ? "true" : undefined}
        key={key}
        onClick={() => setSelectedKey(key)}
        onDoubleClick={() => {
          if (!sourceOnlyInstalledIR) void auditionInstalled(record, "live-preview");
        }}
      >
        <button
          type="button"
          className="nam-result-select-target"
          onClick={(event) => {
            event.stopPropagation();
            setSelectedKey(key);
          }}
          aria-label={`Select ${recordTitle} details`}
        />
        <button
          type="button"
          className="nam-favorite"
          data-active={Boolean(record.favorite)}
          onClick={(event) => {
            event.stopPropagation();
            void toggleInstalledFavorite(record);
          }}
          disabled={rackActionsBusy || busyLibraryKey === key}
          title={record.favorite ? "Remove favorite" : "Favorite"}
          aria-label={record.favorite ? "Remove favorite" : "Favorite"}
          aria-pressed={Boolean(record.favorite)}
        >
          <Star size={14} />
        </button>
        {sourceFlow ? (
          <NAMSourceFlowDesignArt
            className="nam-card-art"
            mode={sourceFlow}
            label={arch}
            title={gear}
            compact
          />
        ) : (
          <div className="nam-card-art" data-arch={arch.toLowerCase()} style={artBackgroundStyle(displayArtUrl)}>
            <HardDrive size={18} />
            <strong>{arch}</strong>
            <div className="nam-card-titleplate">
            <b>{recordTitle}</b>
              <small>{record.creator || installedLabel || "Installed locally"}</small>
            </div>
            <em className="nam-card-audition-puck" aria-hidden="true">
              {isBusy ? <RefreshCw size={13} /> : targetSlot === "cab" ? <FolderOpen size={13} /> : <Play size={13} />}
              {actionLabel}
            </em>
          </div>
        )}
        <div className="nam-result-copy">
          <strong>{recordTitle}</strong>
          <span>{installedMetaLine}</span>
          <small title={rowActionError || record.localPath} data-kind={rowActionError ? "error" : "status"}>
            {railMode ? installedRailStatus : record.missing
              ? "Missing local file"
              : hasUpdate
                ? `Update available${record.updateReason ? ` - ${record.updateReason}` : ""}`
                : sourceOnlyInstalledIR
                  ? "Convolution source material"
                : isAuditioning ? audition?.previewDownload ? "Unsaved audition" : "Audition active" : shortPath(record.localPath)}
          </small>
        </div>
        <div className="nam-result-badges">
          <span>{arch}</span>
          <span>{gear}</span>
          {availability && <span>{availability}</span>}
          {sizeLabel && !record.missing && <span>{sizeLabel}</span>}
          {updatedLabel && hasUpdate && <span>Seen {updatedLabel}</span>}
        </div>
        <div className="nam-result-actions" onClick={(event) => event.stopPropagation()}>
          {railMode ? renderRailInstalledActions(record, targetSlot, isBusy) : sourceOnlyInstalledIR ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => record.sourceUrl ? void nativeBridge.openExternalURL(record.sourceUrl) : undefined}
              disabled={!record.sourceUrl}
              title="Open convolution/source material page"
            >
              <ExternalLink size={13} />
              Open Source
            </Button>
          ) : record.missing ? (
            <Button size="sm" onClick={() => void reinstallInstalled(record)} disabled={rackActionsBusy || busyLibraryKey === key || !makeReinstallPayload(record)}>
              <Download size={13} />
              {makeReinstallPayload(record) ? "Restore" : "Missing"}
            </Button>
          ) : targetSlot === "cab" ? (
            <Button size="sm" onClick={() => void toggleInstalledAudition(record)} disabled={rackActionsBusy || busyModelId === record.modelId}>
              {installedAuditionIsActive(record) ? <RotateCcw size={13} /> : <FolderOpen size={13} />}
              {installedAuditionIsActive(record) ? "Stop" : `Audition ${targetLabel}`}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void toggleInstalledAudition(record)} disabled={rackActionsBusy || busyModelId === record.modelId}>
              {installedAuditionIsActive(record) ? <RotateCcw size={13} /> : <Play size={13} />}
              {installedAuditionIsActive(record) ? "Stop" : "Audition"}
            </Button>
          )}
          {!railMode && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setSelectedKey(key)}>
                Details
              </Button>
              {record.sourceUrl && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void nativeBridge.openExternalURL(record.sourceUrl || "")}
                  title="Open source"
                  aria-label="Open source"
                >
                  <ExternalLink size={13} />
                </Button>
              )}
            </>
          )}
        </div>
      </article>
    );
  };

  const selectedInstalledProviderArtUrl = selectedInstalled ? installedImageUrl(selectedInstalled) : "";
  const selectedCatalogProviderArtUrl = selectedCatalogRow ? imageUrlOf(selectedCatalogRow.tone, selectedCatalogRow.model) : "";
  const selectedInstalledCreatorUrl = selectedInstalled ? installedCreatorProfileUrl(selectedInstalled) : "";
  const selectedCatalogCreatorUrl = selectedCatalogRow ? creatorProfileUrl(selectedCatalogRow.tone) : "";
  const sourceFlowForcedTarget = sourceFlowConfig?.targetSlot !== "delay" ? sourceFlowConfig?.targetSlot : undefined;
  const selectedInstalledTargetSlot = selectedInstalled ? sourceFlowForcedTarget ?? preferredTargetForInstalled(selectedInstalled) : sourceFlowForcedTarget ?? "amp";
  const selectedInstalledTargetLabel = targetLabelForSlot(selectedInstalledTargetSlot);
  const selectedInstalledCaptureDetails = selectedInstalled ? installedCaptureMetadataDetails(selectedInstalled) : [];
  const selectedCatalogCaptureDetails = selectedCatalogRow ? rowCaptureMetadataDetails(selectedCatalogRow.tone, selectedCatalogRow.model) : [];
  const selectedInstalledSourceCategory = selectedInstalled ? sourceCategoryForInstalled(selectedInstalled) : "";
  const selectedCatalogSourceCategory = selectedCatalogRow ? sourceCategoryForToneModel(selectedCatalogRow.tone, selectedCatalogRow.model) : "";
  const selectedInstalledPolicy = sourceFlow && selectedInstalled
    ? getNAMSourceFlowRowActionPolicy(sourceFlow, selectedInstalledSourceCategory)
    : null;
  const selectedCatalogPolicy = sourceFlow && selectedCatalogRow
    ? getNAMSourceFlowRowActionPolicy(sourceFlow, selectedCatalogSourceCategory)
    : null;
  const selectedInstalledSourceOnly = selectedInstalledPolicy === "source-only";
  const selectedCatalogSourceOnly = selectedCatalogPolicy === "source-only";
  const selectedCatalogCanCommit = !selectedCatalogSourceOnly;
  const selectedInstalledCanCommit = !selectedInstalledSourceOnly;
  const detailHeaderTitle =
    sourceFlow === "fx" ? sourceFlowConfig?.detailTitle ?? "Preset Detail" :
    selectedInstalledSourceOnly || selectedCatalogSourceOnly ? sourceFlowConfig?.sourceOnlyDetailTitle ?? "Source Detail" :
    sourceFlowConfig?.detailTitle ?? "Model Detail";
  const detailHeaderSubtitle =
    sourceFlow === "fx" ? sourceFlowConfig?.detailSubtitle ?? "OpenStudio FX Collection" :
    selectedInstalledSourceOnly || selectedCatalogSourceOnly ? sourceFlowConfig?.sourceOnlyDetailSubtitle ?? "Convolution/source material" :
    selectedInstalled ? "Local library" :
    sourceFlowConfig?.detailSubtitle ?? "TONE3000 metadata";
  const selectedInstalledFallbackProfile = selectedInstalledProviderArtUrl
    ? "provider"
    : selectedInstalled
      ? fallbackArtProfileForGear(
          selectedInstalled.gear,
          selectedInstalled.gearType,
          selectedInstalled.name,
          selectedInstalled.toneTitle,
          selectedInstalled.lastSeenMetadata?.gear,
          selectedInstalled.lastSeenMetadata?.name,
          selectedInstalled.latestMetadata?.gear,
          selectedInstalled.latestMetadata?.name,
        )
      : "amp";
  const selectedCatalogFallbackProfile = selectedCatalogProviderArtUrl
    ? "provider"
    : selectedCatalogRow
      ? fallbackArtProfileForGear(
          selectedCatalogRow.tone.gear,
          selectedCatalogRow.model.gear,
          selectedCatalogRow.tone.title,
          selectedCatalogRow.tone.name,
          selectedCatalogRow.tone.description,
          selectedCatalogRow.model.title,
          selectedCatalogRow.model.name,
        )
      : "amp";
  const selectedInstalledArtUrl = selectedInstalled
    ? selectedInstalledProviderArtUrl || sourceLibraryArtForCategory(
        selectedInstalledSourceCategory,
        selectedInstalled.gear,
        selectedInstalled.gearType,
        selectedInstalled.name,
        selectedInstalled.toneTitle,
      )
    : "";
  const selectedCatalogArtUrl = selectedCatalogRow
    ? selectedCatalogProviderArtUrl || sourceLibraryArtForCategory(
        selectedCatalogSourceCategory,
        selectedCatalogRow.tone.gear,
        selectedCatalogRow.model.gear,
        selectedCatalogRow.tone.title,
        selectedCatalogRow.model.name,
      )
    : "";
  const selectedRailTitle =
    (selectedInstalled ? installedTitle(selectedInstalled) : "") ||
    (selectedCatalogRow ? toneTitle(selectedCatalogRow.tone, selectedCatalogRow.model) : "") ||
    audition?.title ||
    "";
  const selectedRailSubtitle = selectedInstalled
    ? `${selectedInstalled.creator || "Local library"} - ${selectedInstalled.missing ? "Restore required" : "Ready in library"}`
    : selectedCatalogRow
      ? `${creatorLabel(selectedCatalogRow.tone)} - ${modelTitle(selectedCatalogRow.model)}`
      : audition
        ? `${audition.creator || "Local file"} - ${audition.modelName} - ${targetLabelForSlot(audition.slot)} slot`
        : "";
  const selectedRailArtUrl = selectedInstalled ? selectedInstalledArtUrl : selectedCatalogArtUrl;
  const selectedRailFallbackProfile = selectedInstalled ? selectedInstalledFallbackProfile : selectedCatalogFallbackProfile;
  const selectedRailArch = selectedInstalled
    ? selectedInstalledTargetSlot === "cab" ? "IR" : architectureLabel(selectedInstalled.architecture)
    : selectedCatalogRow
      ? preferredTargetForToneModel(selectedCatalogRow.tone, selectedCatalogRow.model) === "cab" ? "IR" : modelArchitecture(selectedCatalogRow.tone, selectedCatalogRow.model)
      : audition ? "NAM" : "";
  const selectedRailGear = selectedInstalled
    ? selectedInstalledTargetSlot === "cab"
      ? selectedInstalledTargetLabel
      : gearLabel(selectedInstalled.gear) || gearLabel(selectedInstalled.gearType) || "Installed"
    : selectedCatalogRow
      ? preferredTargetForToneModel(selectedCatalogRow.tone, selectedCatalogRow.model) === "cab"
        ? "Cab/IR"
        : gearLabel(selectedCatalogRow.tone.gear) || gearLabel(selectedCatalogRow.model.gear) || "Amp"
      : audition ? `${targetLabelForSlot(audition.slot)} slot` : "";
  const hasSelectedRail = Boolean(selectedRailTitle);
  const selectedHeroStats = selectedCatalogRow
    ? [
      `${Number(selectedCatalogRow.tone.downloads_count || 0).toLocaleString()} downloads`,
      `${Number(selectedCatalogRow.tone.favorites_count || 0).toLocaleString()} favorites`,
    ]
    : selectedInstalled
      ? [
        selectedInstalled.missing ? "Missing locally" : selectedInstalled.updateAvailable ? "Update available" : "Saved locally",
        selectedInstalled.installedAt ? "Installed" : "Library",
      ]
      : [];
  const selectedHeroTags = [
    selectedRailArch,
    selectedRailGear,
    selectedInstalled
      ? selectedInstalled.license || installedAvailabilityLabel(selectedInstalled)
      : selectedCatalogRow
        ? licenseLabel(selectedCatalogRow.tone.license) || rowAvailabilityLabel(selectedCatalogRow.tone, selectedCatalogRow.model)
        : "",
    selectedInstalled
      ? installedCharacterLabels(selectedInstalled)[0] || installedInstrumentLabels(selectedInstalled)[0]
      : selectedCatalogRow
        ? rowCharacterLabels(selectedCatalogRow.tone, selectedCatalogRow.model)[0] || rowInstrumentLabels(selectedCatalogRow.tone, selectedCatalogRow.model)[0]
      : "",
  ].filter(Boolean);
  const fxRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return OPENSTUDIO_FX_COLLECTION_PRESETS.filter((preset) => {
      if (sourceFlowCategoryFilter !== "all" && preset.category !== sourceFlowCategoryFilter) return false;
      if (!needle) return true;
      return `${preset.name} ${preset.moduleId} ${preset.category} ${preset.description}`.toLowerCase().includes(needle);
    });
  }, [query, sourceFlowCategoryFilter]);
  const selectedFXPreset = fxRows.find((preset) => preset.id === selectedFXPresetId) ?? fxRows[0] ?? null;
  const selectedSourceFlowRowId = sourceFlow === "fx"
    ? selectedFXPreset?.id || ""
    : selectedInstalled
      ? installedKey(selectedInstalled)
      : selectedCatalogRow?.key || audition?.key || "";
  const captureUseInFlight = captureUseProgress.phase === "downloading"
    || captureUseProgress.phase === "preparing"
    || captureUseProgress.phase === "activating";
  const captureUsePhaseForSelectedRow = (captureUseInFlight
    || captureUseProgress.rowId === selectedSourceFlowRowId)
    ? captureUseProgress.phase
    : "idle";
  const selectedSourceAuditionActive = sourceFlow !== "fx" && Boolean(
    selectedInstalled
      ? installedAuditionIsActive(selectedInstalled)
      : selectedCatalogRow
        ? catalogAuditionIsActive(selectedCatalogRow)
        : audition && audition.key === selectedSourceFlowRowId,
  );
  const resultCount =
    sourceFlow === "fx" ? fxRows.length :
    tab === "installed" ? installedRows.length :
    tab === "favorites" ? installedRows.length + displayRows.length :
    displayRows.length;
  const resultNoun = sourceFlow === "fx" ? "preset" : sourceFlow === "ir" ? "source" : "tone";
  const activeSortLabel = NAM_SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? "Trending";
  const tabLabel = tab === "downloads-all-time" ? "Most downloaded" : tab[0].toUpperCase() + tab.slice(1);
  const catalogFreshnessLabel = catalogAgeLabel(catalogGeneratedAt, catalogRefreshedAtMs);
  const catalogStale = catalogMode !== "live" && catalogIsStale(catalogGeneratedAt, catalogRefreshedAtMs);
  const catalogSourceLabel = catalogMode === "live"
    ? "Online TONE3000"
    : catalogSource === "dev-mock"
      ? "QA catalog"
      : "Saved catalog";
  const activeFilterChips = [
    query.trim() ? `Search: ${query.trim()}` : "",
    `Sort: ${activeSortLabel}`,
    architecture !== "all" ? architecture.toUpperCase() : "",
    gearFilter !== "amp_amp-cab" ? gearFilter || "All NAM gear" : "",
    creatorFilter !== "all" ? `Creator: ${creatorFilter}` : "",
    licenseFilter !== "all" ? `License: ${licenseFilter}` : "",
    instrumentFilter !== "all" ? `Instrument: ${instrumentFilter}` : "",
    characterFilter !== "all" ? characterFilter : "",
    availabilityFilter !== "all" ? availabilityFilter : "",
    sourceFlowCategoryFilter !== "all" ? `Source: ${sourceFlowCategoryFilter}` : "",
  ].filter(Boolean);
  const librarySummarySourceLabel = sourceFlowConfig
    ? sourceFlowConfig.sourceLabel
    : catalogSourceLabel;
  const resultPrimaryLabel =
    sourceFlow === "fx" ? "Preset" :
    sourceFlow === "ir" ? "Source" :
    "Tone";
  const resultModelLabel =
    sourceFlow === "fx" ? "Module" :
    sourceFlow === "ir" ? "Type" :
    "Model";
  const detailHydrating = Boolean(busyLibraryKey?.startsWith("tone-models:"));
  const showResultsSkeleton = (liveBusy || catalogBusy) && resultCount === 0;
  const showResultsRefreshOverlay = (liveBusy || catalogBusy || detailHydrating) && resultCount > 0;
  const livePaginationCurrent = query === committedQuery
    && catalogMode === "live"
    && liveSearchSignature === currentLiveSearchSignature;
  const liveCanLoadMore = livePaginationCurrent && liveHasMore;
  const requestNextLivePage = async (trigger: "observer" | "manual") => {
    if (catalogMode !== "live" || !liveCanLoadMore || liveBusy) return;
    const nextPage = livePage + 1;
    const appendKey = `${currentLiveSearchSignature}:page:${nextPage}`;
    const token = appendGateRef.current.begin(appendKey, trigger === "manual");
    if (!token) return;
    const outcome = await runLiveSearch(nextPage, "append");
    appendGateRef.current.settle(token, outcome);
  };
  const retryLiveSearch = () => {
    const failedRequest = lastLiveSearchFailureRef.current;
    if (shouldRetryTONE3000Append(
      failedRequest,
      currentLiveSearchSignature,
      status,
      liveCanLoadMore,
    )) {
      void requestNextLivePage("manual");
      return;
    }
    void submitLiveSearch(1);
  };
  const feedbackTone = feedbackToneForStatus(status);
  const authConnected = Boolean(authStatus?.authenticated && !authStatus.expired);
  const authClientConfigured = Boolean(authStatus?.configuredClientId || clientId.trim());
  const authExpired = Boolean(authStatus?.expired);
  const authRefreshAvailable = Boolean(authStatus?.hasRefreshToken && (!authStatus.authenticated || authStatus.expired));
  const authChecking = !tone3000Session.bootstrapped || authUiBusy;
  const showConnectAction = !authConnected && !authUiBusy && !authRefreshAvailable;
  const canRetryStatus =
    status.toLowerCase().includes("rate limit") ||
    status.toLowerCase().includes("search failed") ||
    status.toLowerCase().includes("catalog unavailable") ||
    status.toLowerCase().includes("refresh failed");

  useEffect(() => {
    if (sessionKeyTransition) return;
    if (!authConnected || authChecking || catalogBusy) return;
    if (sourceFlow === "fx" || sourceFlowCategoryFilter === "local") return;
    if (tab === "installed" || tab === "favorites") return;
    if (lastAutomaticLiveSearchSignatureRef.current === currentLiveSearchSignature) return;
    lastAutomaticLiveSearchSignatureRef.current = currentLiveSearchSignature;
    void runLiveSearch(1, "replace", currentLiveSearchSnapshot).catch((error) => {
      console.error("[NAMExplorer] Automatic live search failed:", error);
    });
  }, [authChecking, authConnected, catalogBusy, currentLiveSearchSignature, sessionKeyTransition, sourceFlow, sourceFlowCategoryFilter, tab]);

  useEffect(() => {
    if (persistenceSessionKeyRef.current !== sessionViewKey) {
      persistenceSessionKeyRef.current = sessionViewKey;
      return;
    }
    const previousScrollTop = getNAMExplorerSessionView(sessionViewKey)?.scrollTop
      ?? initialSessionView?.scrollTop
      ?? 0;
    setNAMExplorerSessionView(sessionViewKey, {
      tab,
      sortMode,
      query,
      committedQuery,
      architecture,
      gearFilter,
      sourceFlowCategoryFilter,
      creatorFilter,
      licenseFilter,
      instrumentFilter,
      characterFilter,
      availabilityFilter,
      viewMode,
      filtersOpen,
      catalogMode,
      catalog,
      catalogGeneratedAt,
      catalogSource,
      catalogRefreshedAtMs,
      livePage,
      liveTotalPages,
      liveTotal,
      liveHasMore,
      liveSearchSignature,
      scrollTop: previousScrollTop,
    });
  }, [
    architecture,
    availabilityFilter,
    catalog,
    catalogGeneratedAt,
    catalogMode,
    catalogRefreshedAtMs,
    catalogSource,
    characterFilter,
    committedQuery,
    creatorFilter,
    filtersOpen,
    gearFilter,
    instrumentFilter,
    licenseFilter,
    liveHasMore,
    livePage,
    liveSearchSignature,
    liveTotal,
    liveTotalPages,
    query,
    sessionRestoreRevision,
    sessionViewKey,
    sortMode,
    sourceFlowCategoryFilter,
    tab,
    viewMode,
  ]);

  useEffect(() => {
    if (sourceFlowMode) return;
    const scrollTop = getNAMExplorerSessionView(sessionViewKey)?.scrollTop ?? 0;
    if (resultsScrollRef.current) resultsScrollRef.current.scrollTop = scrollTop;
  }, [sessionViewKey, sourceFlowMode]);

  useEffect(() => {
    appendGateRef.current.reset();
  }, [currentLiveSearchSignature]);

  useEffect(() => {
    if (sessionKeyTransition || sourceFlowMode || catalogMode !== "live" || !liveCanLoadMore || liveBusy) return;
    return observeTONE3000AppendSentinel(
      appendSentinelRef.current,
      resultsScrollRef.current,
      () => void requestNextLivePage("observer"),
    );
  }, [catalogMode, currentLiveSearchSignature, liveBusy, liveCanLoadMore, livePage, sessionKeyTransition, sourceFlowMode]);

  const clearExplorerFilters = () => {
    setQuery(sourceFlowConfig?.defaultQuery ?? "");
    setArchitecture("all");
    setGearFilter(sourceFlowConfig?.defaultGearFilter ?? "amp_amp-cab");
    setSourceFlowCategoryFilter("all");
    setCreatorFilter("all");
    setLicenseFilter("all");
    setInstrumentFilter("all");
    setCharacterFilter("all");
    setAvailabilityFilter("all");
    setSelectedKey("");
  };

  const applySourceFlowFilterControl = (control: NAMSourceFlowFilterControl) => {
    setSelectedKey("");
    if (control.localAction === "load-local-nam") {
      void loadLocalNAMFile(sourceFlow === "pedal" ? "pedal" : "amp");
      return;
    }
    if (control.localAction === "load-local-ir") {
      if (onLoadLocalIR) onLoadLocalIR();
      else void loadLocalIRFile();
      return;
    }
    setSourceFlowCategoryFilter(control.category || "all");
    if (control.gearFilter !== undefined) setGearFilter(control.gearFilter);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    if (sourceFlow === "fx") return;
    if (tab === "installed" || tab === "favorites") return;
    event.preventDefault();
    void submitLiveSearch(1);
  };

  const applySortMode = (nextSortMode: NAMSortMode) => {
    setSortMode(nextSortMode);
    setSelectedKey("");
    setSortMenuOpen(false);
  };

  const sourceFlowFilterButtons = sourceFlowConfig ? (
    sourceFlow === "amp"
      ? sourceFlowConfig.filters.map((label) => ({
        id: label === "A1" ? "arch-a1" : label === "A2" ? "arch-a2" : sourceFlowConfig.filterControls.find((control) => control.label === label)?.id ?? label.toLowerCase().replace(/\s+/g, "-"),
        label,
        active:
          (label === "A1" && architecture === "a1") ||
          (label === "A2" && architecture === "a2") ||
          sourceFlowConfig.filterControls.some((control) => control.label === label && sourceFlowCategoryFilter === control.category),
      }))
      : sourceFlow === "ir" || sourceFlow === "fx"
        ? sourceFlowConfig.filterControls
          .filter((control) => !control.id.endsWith("-all"))
          .map((control) => ({
            id: control.id,
            label: sourceFlow === "ir" && control.id === "cabinet-ir" ? "TONE3000 Cabinet IR" : control.label,
            active: sourceFlowCategoryFilter === control.category || (sourceFlowCategoryFilter === "all" && ["cabinet-ir", "delay"].includes(control.category)),
          }))
        : sourceFlowConfig.filters.map((label) => ({
          id: sourceFlowConfig.filterControls.find((control) => control.label === label)?.id ?? label.toLowerCase(),
          label,
          active: sourceFlowCategoryFilter === label.toLowerCase(),
        }))
  ) : [];

  const sourceFlowTabs = sourceFlow === "fx" ? ["Factory"] : ["Browse", "Installed", "Favorites"];
  const sourceFlowActiveTab = sourceFlow === "fx" ? 0 : tab === "installed" ? 1 : tab === "favorites" ? 2 : 0;

  const sourceFlowTargetCards = sourceFlowConfig ? (
    sourceFlow === "fx"
      ? [
        { id: "eq", label: "EQ", model: selectedFXPreset?.moduleId === "eq" ? selectedFXPreset.name : "9-Band Graphic", meta: "OpenStudio preset", active: selectedFXPreset?.moduleId === "eq", preview: selectedFXPreset?.moduleId === "eq" },
        { id: "mod", label: "Mod", model: selectedFXPreset?.moduleId === "mod" ? selectedFXPreset.name : "Chorus", meta: "OpenStudio preset", active: selectedFXPreset?.moduleId === "mod", preview: selectedFXPreset?.moduleId === "mod" },
        { id: "delay", label: "Delay", model: selectedFXPreset?.moduleId === "delay" ? selectedFXPreset.name : "1/4 D Stereo", meta: "OpenStudio preset", active: !selectedFXPreset || selectedFXPreset.moduleId === "delay", preview: selectedFXPreset?.moduleId === "delay" },
        { id: "reverb", label: "Reverb", model: selectedFXPreset?.moduleId === "reverb" ? selectedFXPreset.name : "Plate", meta: "OpenStudio preset", active: selectedFXPreset?.moduleId === "reverb", preview: selectedFXPreset?.moduleId === "reverb" },
      ]
      : [
        {
          id: "pedal",
          label: "Pedal Capture",
          model: sourceFlow === "pedal"
            ? selectedRailTitle
              || (captureUseInFlight ? captureUseProgress.message : "Selected Pedal Capture slot")
            : sidebarPedalIdentity.title || namDisplayNameFromPath(currentPedal) || "Open from Pedals",
          meta: sourceFlow === "pedal"
            ? captureUseInFlight ? captureUseProgress.message : "Audition target"
            : "Separate pedal flow",
          active: sourceFlow === "pedal",
          preview: sourceFlow === "pedal",
        },
        {
          id: "amp",
          label: "Amp Capture",
          model: sourceFlow === "amp"
            ? selectedRailTitle
              || (captureUseInFlight ? captureUseProgress.message : "Selected Amp slot")
            : sidebarAmpIdentity.title || namDisplayNameFromPath(currentAmp) || "Open from Amp",
          meta: sourceFlow === "amp"
            ? captureUseInFlight ? captureUseProgress.message : "Audition target"
            : "Separate amp flow",
          active: sourceFlow === "amp",
          preview: sourceFlow === "amp",
        },
        {
          id: "cab",
          label: "Cab/IR",
          model: sourceFlow === "ir"
            ? selectedRailTitle
              || (captureUseInFlight ? captureUseProgress.message : "Selected Cab/IR slot")
            : namDisplayNameFromPath(schema.modelState?.cabIRPath || "") || "Open from Cab",
          meta: sourceFlow === "ir"
            ? captureUseInFlight ? captureUseProgress.message : "Cab screen target"
            : "IR flow separate",
          active: sourceFlow === "ir",
          preview: sourceFlow === "ir",
        },
      ]
  ) : [];

  const sourceCategoryLabel = (category: string) => {
    if (category === "eq") return "EQ";
    if (category === "amp") return "Amp Only (No Cab)";
    if (category === "studio") return "Studio Capture (Cab Unknown)";
    if (category === "unknown") return "Unknown Capture";
    if (category === "cabinet-ir") return "Cabinet IR";
    if (category === "space-ir") return "Space/Reverb IR";
    if (category === "external-space-ir") return "External Space IR";
    if (category === "full-rig") return "Full Rig";
    return category
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ") || "NAM";
  };

  const sourceFlowCatalogResult = (row: NAMCatalogRow): NAMSourceFlowDesignResult => {
    const { tone, model } = row;
    const category = sourceCategoryForToneModel(tone, model);
    const modelId = modelIdOf(model);
    const installedRecord = installedByModelId.get(modelId);
    const policy = sourceFlow ? getNAMSourceFlowRowActionPolicy(sourceFlow, category) : "model-preview";
    const isAuditioning = Boolean(audition && (audition.key === row.key || (audition.modelId > 0 && audition.modelId === modelId)));
    const targetSlot = sourceFlowForcedTarget ?? preferredTargetForToneModel(tone, model);
    const sourceArchitecture = targetSlot === "cab" ? "IR" : modelArchitecture(tone, model);
    const missingInstalledRecord = Boolean(installedRecord?.missing);
    return {
      id: row.key,
      name: toneTitle(tone, model),
      creator: creatorLabel(tone),
      kind: sourceCategoryLabel(category),
      arch: sourceArchitecture,
      category,
      tags: [
        sourceCategoryLabel(category),
        sourceArchitecture,
        rowAvailabilityLabel(tone, model) || licenseLabel(tone.license),
      ].filter(Boolean).slice(0, 3),
      downloads: formatCompactCount(tone.downloads_count),
      likes: formatCompactCount(tone.favorites_count),
      stateLabel: policy === "source-only"
        ? "Source"
        : isAuditioning
          ? "Auditioning"
          : installedRecord?.missing
            ? "Missing"
            : installedRecord
              ? "Installed"
              : "Online",
      state: policy === "source-only" ? "external" : isAuditioning ? "preview" : installedRecord?.missing ? "missing" : installedRecord ? "installed" : "online",
      action: policy === "source-only"
        ? "Open Source"
        : missingInstalledRecord
          ? "Re-download"
          : isAuditioning ? "Stop" : targetSlot === "cab" ? "Audition IR" : "Audition",
      actionId: policy === "source-only" ? "open-source" : isAuditioning ? "revert" : "preview",
      active: selectedCatalogRow?.key === row.key || isAuditioning,
      artUrl: imageUrlOf(tone, model) || sourceLibraryArtForCategory(category, tone.gear, model.gear, tone.title, model.name),
      favorite: favorites.has(`${toneIdOf(tone)}:${modelId}`),
      source: category === "space-ir" ? "external" : "tone3000",
    };
  };

  const sourceFlowInstalledResult = (record: NAMInstalledModel): NAMSourceFlowDesignResult => {
    const category = sourceCategoryForInstalled(record);
    const policy = sourceFlow ? getNAMSourceFlowRowActionPolicy(sourceFlow, category) : "model-preview";
    const key = installedKey(record);
    const isAuditioning = Boolean(audition && (audition.key === key || (audition.modelId > 0 && audition.modelId === modelIdOf(record))));
    const targetSlot = sourceFlowForcedTarget ?? preferredTargetForInstalled(record);
    const sourceArchitecture = targetSlot === "cab" ? "IR" : architectureLabel(record.architecture);
    const localMissing = Boolean(record.missing && (record.source === "local" || record.sourceProvider === "local-file"));
    return {
      id: key,
      name: installedTitle(record),
      creator: record.creator || record.sourceProvider || "Local library",
      kind: sourceCategoryLabel(category),
      arch: sourceArchitecture,
      category,
      tags: [
        sourceCategoryLabel(category),
        sourceArchitecture,
        installedAvailabilityLabel(record) || record.license || "Installed",
      ].filter(Boolean).slice(0, 3),
      downloads: "Local",
      likes: record.favorite ? "Favorite" : "Saved",
      stateLabel: policy === "source-only"
        ? "Source"
        : isAuditioning
          ? "Auditioning"
          : record.missing
            ? "Missing"
            : "Installed",
      state: policy === "source-only" ? "external" : isAuditioning ? "preview" : record.missing ? "missing" : "installed",
      action: policy === "source-only"
        ? "Open Source"
        : localMissing
          ? targetSlot === "cab" ? "Locate IR" : "Locate .nam"
          : record.missing
            ? "Re-download"
            : isAuditioning ? "Stop" : targetSlot === "cab" ? "Audition IR" : "Audition",
      actionId: policy === "source-only"
        ? "open-source"
        : localMissing
          ? targetSlot === "cab" ? "load-local-ir" : "load-local-nam"
          : isAuditioning ? "revert" : "preview",
      active: selectedInstalled === record || isAuditioning,
      artUrl: installedImageUrl(record) || sourceLibraryArtForCategory(category, record.gear, record.gearType, record.name),
      favorite: Boolean(record.favorite),
      source: record.source === "local" || record.sourceProvider === "local-file" ? "local" : category === "space-ir" ? "external" : "tone3000",
    };
  };

  const sourceFlowFXResult = (preset: OpenStudioFXPreset): NAMSourceFlowDesignResult => {
    const previewing = fxPreview?.preset.id === preset.id;
    return {
      id: preset.id,
      name: preset.name,
      creator: "OpenStudio",
      kind: `${sourceCategoryLabel(preset.category)} Preset`,
      arch: "FX",
      category: preset.category,
      tags: [sourceCategoryLabel(preset.category), "Factory", "OpenStudio"],
      downloads: "Local",
      likes: "Preset",
      stateLabel: previewing ? "Previewing" : "Installed",
      state: previewing ? "preview" : "installed",
      action: previewing ? "Previewing" : "Preview Preset",
      actionId: "preview",
      active: selectedFXPreset?.id === preset.id || previewing,
      artUrl: openStudioFXArt(preset.moduleId),
      source: "openstudio",
    };
  };

  const sourceFlowResults = sourceFlow === "fx"
    ? fxRows.map(sourceFlowFXResult)
    : tab === "installed"
      ? installedRows.map(sourceFlowInstalledResult)
      : tab === "favorites"
        ? [...installedRows.map(sourceFlowInstalledResult), ...displayRows.map(sourceFlowCatalogResult)]
        : displayRows.map(sourceFlowCatalogResult);
  const sourceFlowPagination = sourceFlow !== "fx"
    && tab !== "installed"
    && tab !== "favorites"
    && catalogMode === "live"
    ? {
      requestKey: `${currentLiveSearchSignature}:page:${livePage + 1}`,
      page: livePage,
      totalPages: liveTotalPages,
      totalResults: liveTotal,
      hasPrevious: livePaginationCurrent && livePage > 1,
      hasMore: livePaginationCurrent && liveHasMore,
      canLoadMore: livePaginationCurrent && liveHasMore,
      mode: "live" as const,
    }
    : undefined;

  const selectedSourceOnly = sourceFlow === "ir" && (selectedInstalledSourceOnly || selectedCatalogSourceOnly);
  const sourceFlowPreviewBody = sourceFlow
    ? getNAMDesignBodyAsset(getNAMSourceFlowBodyAssetId(sourceFlow, { moduleId: selectedFXPreset?.moduleId })).fileName
    : "";
  const activeSourceSlotPath = sourceFlow === "amp"
    ? currentAmp
    : sourceFlow === "pedal"
      ? currentPedal
      : sourceFlow === "ir"
        ? schema.modelState?.cabIRPath || ""
        : "";
  const sourceFlowDetailName = sourceFlow === "fx"
    ? selectedFXPreset?.name || "OpenStudio FX Preset"
    : selectedRailTitle
      || (captureUseInFlight ? captureUseProgress.message : sourceFlowConfig?.emptyTitle || "No selection");
  const sourceFlowDetailMetaLine = sourceFlow === "fx"
    ? selectedFXPreset
      ? `OpenStudio FX Collection - ${sourceCategoryLabel(selectedFXPreset.category)} preset - local library`
      : "OpenStudio FX Collection"
    : selectedSourceOnly
      ? `Convolution/source material - ${selectedRailSubtitle || "Open source only"}`
      : captureUseInFlight
        ? `${captureUseProgress.message} Keeping the selected ${sourceFlow === "ir" ? "IR" : "capture"} visible while native activation is verified.`
      : sourceFlow === "ir" && sourceFlowCategoryFilter === "local"
        ? "Local IR uses native file picker"
      : selectedRailSubtitle || sourceFlowConfig?.emptyBody || "";
  const sourceFlowUseLabel = sourceFlow ? getNAMSourceFlowUseLabel(sourceFlow) : "Use Capture";
  const captureUseActionLabel = namCaptureUsePhaseLabel(captureUsePhaseForSelectedRow, sourceFlowUseLabel);
  const sourceFlowDetailActions: NAMSourceFlowDesignConfig["actions"] = sourceFlow === "fx"
    ? [
      { id: "preview", label: "Preview Preset", disabled: rackActionsBusy },
      { id: "apply-preset", label: "Apply Preset", primary: true, disabled: rackActionsBusy },
      { id: "revert", label: "Cancel Preview", disabled: rackActionsBusy || !fxPreview },
    ]
    : selectedSourceOnly
      ? [
        { id: "open-source", label: "Open Source", primary: true },
        { id: "open-ir-sources", label: "Open IR Sources" },
      ]
      : sourceFlow === "ir"
        ? [
          {
            id: selectedSourceAuditionActive ? "revert" : "preview",
            label: selectedSourceAuditionActive ? "Stop Audition" : "Audition IR",
            disabled: rackActionsBusy,
          },
          { id: "use-selection", label: captureUseActionLabel, primary: true, disabled: rackActionsBusy },
        ]
        : [
          {
            id: selectedSourceAuditionActive ? "revert" : "preview",
            label: selectedSourceAuditionActive ? "Stop Audition" : "Audition",
            disabled: rackActionsBusy,
          },
          { id: "use-selection", label: captureUseActionLabel, primary: true, disabled: rackActionsBusy },
        ];

  const sourceFlowOrigin = sourceOriginLabel ?? sourceFlowConfig?.originLabel ?? "the rack";
  const sourceFlowTransactionDetail = sourceFlow === "fx"
    ? "Preview Preset is temporary. Apply Preset keeps the settings; Cancel Preview restores the previous effect settings."
    : sourceFlow === "ir"
      ? `Audition is temporary. Use IR keeps it and returns to ${sourceFlowOrigin}; Stop restores the previous IR.`
      : `Audition is temporary and uses live guitar. Use Capture keeps it and returns to ${sourceFlowOrigin}; Stop restores the previous capture.`;

  const sourceFlowRackSlots = schema.uiState?.namRackSlots && typeof schema.uiState.namRackSlots === "object"
    ? schema.uiState.namRackSlots as Record<string, unknown>
    : {};
  const sourceFlowOctaverLabel = schema.parameters.find(
    (parameter) => parameter.id === "octaverEnabled",
  )?.label ?? "Octaver";
  const sourceFlowRoute = sourceFlow
    ? makeNAMSourceFlowRoute(
        sourceFlow,
        selectedFXPreset?.moduleId ?? null,
        sourceFlowRackSlots.order,
        sourceFlowOctaverLabel,
      )
    : "";
  const sourceFlowRateLimited = status.toLowerCase().includes("rate limit");
  const sourceFlowDesignConfig: NAMSourceFlowDesignConfig | null = sourceFlow && sourceFlowConfig ? {
    boardId: sourceFlowDesignBoardForMode(sourceFlow),
    mode: sourceFlow,
    originId: sourceFlow === "fx" && intent?.sourceFilter === "eq" ? "eq" : sourceFlowConfig.returnTarget,
    originLabel: sourceOriginLabel ?? sourceFlowConfig.originLabel,
    sourceMode: sourceFlowConfig.sourceMode,
    sourceLabel: sourceFlowConfig.sourceLabel,
    targetSlot: sourceFlow === "fx" ? selectedFXPreset?.moduleId || "delay" : sourceFlowConfig.targetSlot,
    targetLabel: sourceFlow === "fx" && selectedFXPreset
      ? `${selectedFXPreset.moduleId === "eq" ? "EQ" : sourceCategoryLabel(selectedFXPreset.moduleId)} Effect`
      : sourceFlowConfig.targetLabel,
    returnLabel: sourceReturnLabel ?? sourceFlowConfig.returnLabel,
    authState: sourceFlow === "fx" ? "local" : sourceFlowRateLimited ? "warning" : authConnected ? "connected" : "offline",
    authTitle: sourceFlow === "fx"
      ? "Local library"
      : authChecking
        ? "Checking"
        : sourceFlowRateLimited
          ? "Rate limited"
          : authConnected
            ? "Connected"
            : authRefreshAvailable
              ? "Refresh available"
              : "Offline",
    authDetail: sourceFlow === "fx"
      ? "Factory and installed presets"
      : status || (authConnected ? "TONE3000 session ready" : authRefreshAvailable ? "Saved session can refresh" : "Connect TONE3000 to browse online"),
    statusAction: sourceFlow !== "fx" && canRetryStatus
      ? { id: "retry", label: sourceFlowRateLimited ? "Retry search" : "Retry" }
      : undefined,
    searchLabel: sourceFlow === "fx" ? "Search OpenStudio FX" : sourceFlow === "ir" ? "Search IR sources" : sourceFlowConfig.searchPlaceholder,
    searchText: query.trim() || sourceFlowConfig.defaultQuery || sourceFlowConfig.searchPlaceholder,
    searchAction: sourceFlow === "fx" ? "Search FX" : sourceFlow === "ir" ? "Search IRs" : "Search Live",
    query,
    tabs: sourceFlowTabs,
    activeTab: sourceFlowActiveTab < 0 ? 0 : sourceFlowActiveTab,
    filters: sourceFlowFilterButtons,
    sortValue: sourceFlow === "fx" ? "factory" : sortMode,
    sortOptions: sourceFlow === "fx"
      ? [{ value: "factory", label: "Factory order" }]
      : NAM_SORT_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    targets: sourceFlowTargetCards,
    localTitle: sourceFlow === "fx" ? "Source rule" : sourceFlow === "ir" ? "Local IR file" : "Local NAM file",
    localDetail: sourceFlow === "fx"
      ? "EQ, Mod, Delay, and Reverb presets use supported OpenStudio effects"
      : sourceFlow === "ir"
        ? `Uses the native file picker for local .wav/.aiff/.flac files. ${sourceFlowTransactionDetail}`
        : `Load a local .nam capture into ${sourceFlowConfig.targetLabel}. ${sourceFlowTransactionDetail}`,
    feedTitle: sourceFlow === "fx"
      ? "Rack effect presets"
      : sourceFlow === "ir"
        ? "Cabinet IRs"
        : sourceFlow === "pedal"
          ? "Pedal captures"
          : sourceFlowCategoryFilter === "amp"
            ? "Amp Only (No Cab)"
            : sourceFlowCategoryFilter === "full-rig"
              ? "Full Rig"
              : sourceFlowCategoryFilter === "local"
                ? "Local .nam captures"
                : "All Amp Captures",
    sortLabel: sourceFlow === "fx" ? "Sort: Factory order" : `Sort: ${activeSortLabel}`,
    viewLabel: sourceFlow === "fx" ? `Target: ${sourceCategoryLabel(selectedFXPreset?.moduleId || "delay")}` : `View: ${viewMode === "cards" ? "Compact" : "List"}`,
    results: sourceFlowResults,
    pagination: sourceFlowPagination,
    sessionKey: sessionViewKey,
    initialScrollTop: getNAMExplorerSessionView(sessionViewKey)?.scrollTop ?? initialSessionView?.scrollTop ?? 0,
    detailEyebrow: selectedSourceOnly
      ? sourceFlowConfig.sourceOnlyDetailTitle || "Selected source - Space/Reverb IR"
      : sourceFlowConfig.detailTitle,
    selectedRowId: selectedSourceFlowRowId,
    selectedName: sourceFlowDetailName,
    selectedMeta: sourceFlowDetailMetaLine,
    selectedAvailable: sourceFlow === "fx" ? Boolean(selectedFXPreset) : hasSelectedRail,
    selectedArtUrl: sourceFlow === "fx"
      ? openStudioFXArt(selectedFXPreset?.moduleId || "delay")
      : selectedRailArtUrl || (sourceFlow === "ir" ? NAM_CAB_CARD_ART : sourceFlow === "pedal" ? NAM_PEDAL_CARD_ART : NAM_TONE_CARD_ART),
    selectedTags: sourceFlow === "fx"
      ? ["OpenStudio", selectedFXPreset ? `${sourceCategoryLabel(selectedFXPreset.category)} preset` : "Post FX", "Post FX"]
      : selectedHeroTags,
    selectedStats: sourceFlow === "fx" ? ["Local factory preset"] : selectedHeroStats,
    detailMeta: sourceFlow === "fx"
      ? [
        fxPreview?.preset.id === selectedFXPreset?.id ? "State: FX preset preview active" : "State: Ready to preview",
        `Target: ${sourceCategoryLabel(selectedFXPreset?.moduleId || "delay")} module in Post FX`,
        "OpenStudio in-house effect",
      ]
      : selectedSourceOnly
        ? ["Source material only", "Not loaded into the Cab stage"]
        : [
          ...(selectedInstalled ? selectedInstalledCaptureDetails : selectedCatalogCaptureDetails)
            .map((detail) => `${detail.label}: ${detail.value}`)
            .slice(0, 4),
          `Target: ${sourceFlowConfig.targetLabel}`,
        ],
    previewBody: sourceFlowPreviewBody,
    controlAssetIds: getNAMSourceFlowControlAssetIds(sourceFlow),
    previewText: `${sourceFlowConfig.sourceLabel} \u2192 ${sourceFlowConfig.targetLabel}`,
    actions: sourceFlowDetailActions,
    statusTitle: queuedRackActionLabel
      ? "Selection queue"
      : sourceFlow === "fx" ? "FX route" : sourceFlow === "ir" ? "IR route" : "Audition route",
    route: sourceFlowRoute,
    statusDetail: queuedRackActionLabel
      ? `Queued: ${queuedRackActionLabel}. The active safety check finishes first; only this latest queued selection will load.`
      : status || sourceFlowTransactionDetail,
    resultCount: sourceFlowResults.length,
    resultTotal: sourceFlow === "fx"
      ? fxRows.length
      : tab === "installed"
        ? installedRows.length
        : tab === "favorites"
          ? installedRows.length + rows.length
          : catalogMode === "live"
            ? liveTotal
            : rows.length,
    busy: sessionKeyTransition || rackActionsBusy || showResultsSkeleton || showResultsRefreshOverlay,
    emptyTitle: sourceFlowCategoryFilter === "local"
      ? sourceFlow === "ir" ? "Choose a local cabinet IR" : "Choose a local NAM capture"
      : sourceFlowConfig.emptyTitle,
    emptyBody: sourceFlowCategoryFilter === "local"
      ? sourceFlow === "ir"
        ? "Open a .wav, .aiff, or .flac impulse response from this computer."
        : "Open a .nam file from this computer. It will enter temporary Preview until you choose Use Capture."
      : sourceFlowConfig.emptyBody,
    emptyAction: sourceFlowCategoryFilter === "local" && sourceFlow !== "fx"
      ? {
        id: sourceFlow === "ir" ? "load-local-ir" : "load-local-nam",
        label: sourceFlow === "ir" ? "Choose Local IR…" : "Choose Local .nam…",
        primary: true,
      }
      : undefined,
  } : null;

  const findSourceFlowRow = (rowId?: string) => {
    const id = rowId || "";
    const preset = id ? fxRows.find((entry) => entry.id === id) : selectedFXPreset;
    const installedRecord = id ? installedRows.find((entry) => installedKey(entry) === id) : selectedInstalled;
    const catalogRow = id ? rows.find((entry) => entry.key === id) : selectedCatalogRow;
    const activeLocalRecord = audition?.record && (!id || audition.key === id) ? audition.record : null;
    return { preset: preset ?? null, installedRecord: installedRecord ?? activeLocalRecord, catalogRow: catalogRow ?? null };
  };

  const openSourceFlowSourceUrl = (rowId?: string) => {
    const { preset, installedRecord, catalogRow } = findSourceFlowRow(rowId);
    if (preset) {
      onOpenIRSources?.();
      return;
    }
    const url = installedRecord?.sourceUrl || (catalogRow ? sourceUrlOf(catalogRow.tone, catalogRow.model) : "");
    if (url) void nativeBridge.openExternalURL(url);
    else setStatus("No source URL is available for this item.");
  };

  const runSourceFlowPreviewAction = async (
    rowId: string | undefined,
    mode: "preview" | "load" | "apply" = "preview",
    queuedGeneration?: number,
  ) => {
    if (queuedGeneration !== undefined && queuedGeneration !== pendingRackActionGenerationRef.current) return;
    if (isNAMRackTransactionBusy(rackTransactionKey)) {
      const pendingSelection = findSourceFlowRow(rowId);
      const pendingName = pendingSelection.preset?.name
        || pendingSelection.installedRecord?.toneTitle
        || pendingSelection.installedRecord?.name
        || (pendingSelection.catalogRow ? toneTitle(pendingSelection.catalogRow.tone, pendingSelection.catalogRow.model) : "selected source");
      const actionLabel = `audition of ${pendingName}`;
      const replacedQueuedAction = Boolean(pendingRackActionRef.current);
      const generation = pendingRackActionGenerationRef.current + 1;
      pendingRackActionGenerationRef.current = generation;
      pendingRackActionRef.current = {
        generation,
        label: actionLabel,
        run: () => runSourceFlowPreviewAction(rowId, mode, generation),
      };
      setQueuedRackActionLabel(actionLabel);
      setStatus(`Waiting: ${actionLabel} is queued${replacedQueuedAction ? " and replaces the previous queued selection" : ""}. The current model safety check will finish first.`);
      return;
    }
    if (queuedGeneration === undefined) {
      pendingRackActionGenerationRef.current += 1;
      pendingRackActionRef.current = null;
      setQueuedRackActionLabel("");
    }
    const { preset, installedRecord, catalogRow } = findSourceFlowRow(rowId);
    if (preset) {
      await applyOpenStudioFXPreset(preset, mode === "apply" ? "apply" : "preview");
      return;
    }
    if (installedRecord) {
      await auditionInstalled(installedRecord, "live-preview");
      return;
    }
    if (catalogRow) {
      await auditionCatalogTone(catalogRow, "live-preview");
      return;
    }
    setStatus("Select a source item first.");
  };

  useEffect(() => {
    if (rackTransactionBusy || !queuedRackActionLabel) return;
    const pending = pendingRackActionRef.current;
    pendingRackActionRef.current = null;
    setQueuedRackActionLabel("");
    if (!pending || !mountedRef.current) return;
    setStatus(`Loading queued selection: ${pending.label}…`);
    void Promise.resolve().then(async () => {
      if (!mountedRef.current || pending.generation !== pendingRackActionGenerationRef.current) return;
      try {
        await pending.run();
      } catch (error) {
        console.warn("[NAMExplorer] Queued selection failed", error);
        if (mountedRef.current && pending.generation === pendingRackActionGenerationRef.current) {
          setStatus(`Queued selection failed: ${pending.label}. The current rack state was kept.`);
        }
      }
    });
  }, [queuedRackActionLabel, rackTransactionBusy]);

  const useSourceFlowSelection = async (rowId?: string) => {
    if (!sourceFlow) return;
    if (isNAMRackTransactionBusy(rackTransactionKey)) {
      setStatus("Wait for the active model safety check to finish before committing this selection.");
      return;
    }
    const selected = findSourceFlowRow(rowId);

    if (sourceFlow === "fx") {
      const preset = selected.preset ?? fxPreview?.preset;
      if (!preset) {
        setStatus("Select an effect preset first.");
        return;
      }
      if (await applyOpenStudioFXPreset(preset, "apply")) onReturn?.();
      return;
    }

    if (!selected.installedRecord && !selected.catalogRow && !auditionRef.current?.record) {
      setStatus(sourceFlow === "ir" ? "Select an IR first." : "Select a capture first.");
      return;
    }

    const generation = beginRackTransaction();
    if (generation === null) return;
    const isCurrent = () => isRackTransactionCurrent(generation);
    const canUpdateUI = () => canUpdateRackTransactionUI(generation);
    const progressRowId = rowId || selectedSourceFlowRowId;
    const yieldForProgressPaint = async () => {
      if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    };
    const publishUseProgress = async (phase: NAMCaptureUsePhase, message: string) => {
      if (!canUpdateUI()) return;
      setCaptureUseProgress({ phase, rowId: progressRowId, message });
      setStatus(message);
      await yieldForProgressPaint();
    };
    const failUse = async (message: string) => {
      if (!canUpdateUI()) return;
      setCaptureUseProgress({ phase: "error", rowId: progressRowId, message });
      setStatus(message);
      await Promise.resolve(onRefreshRack());
    };

    try {
      const beforeState = await nativeBridge.getBuiltInPluginState(address);
      if (!isCurrent()) return;
      const activePreview = auditionFromAuthoritativeState(beforeState, schema, auditionRef.current);
      const rollbackSnapshot = previewBaselineFromState(beforeState, schema);
      const rollbackUiState = beforeState?.uiState && typeof beforeState.uiState === "object"
        ? beforeState.uiState as Record<string, unknown>
        : { ...(schema.uiState ?? {}) };
      const restoreAuthoritativeRack = async () => {
        const resourcesRestored = await restoreAuditionSnapshot(rollbackSnapshot, isCurrent);
        if (!resourcesRestored || !isCurrent()) return false;
        const uiRestored = await nativeBridge.setBuiltInPluginState(address, {
          uiState: rollbackUiState,
        });
        if (!uiRestored || !isCurrent()) return false;
        const restoredState = await nativeBridge.getBuiltInPluginState(address);
        if (!isCurrent()) return false;
        const restoredUi = restoredState?.uiState && typeof restoredState.uiState === "object"
          ? restoredState.uiState as Record<string, unknown>
          : {};
        const expectedPreview = normalizeNAMActivePreview(rollbackUiState.namActivePreview);
        const actualPreview = normalizeNAMActivePreview(restoredUi.namActivePreview);
        const previewMatches = expectedPreview
          ? Boolean(actualPreview
            && actualPreview.slot === expectedPreview.slot
            && sameLocalPath(actualPreview.localPath ?? "", expectedPreview.localPath ?? ""))
          : !actualPreview;
        const presetDirtyMatches = Boolean(restoredUi.namPresetDirty) === Boolean(rollbackUiState.namPresetDirty);
        return previewMatches && presetDirtyMatches;
      };
      const selectedRecordMatchesPreview = Boolean(
        selected.installedRecord?.localPath
        && activePreview
        && sameLocalPath(selected.installedRecord.localPath, activePreview.localPath),
      );
      const selectedCatalogMatchesPreview = Boolean(
        selected.catalogRow
        && activePreview
        && modelIdOf(selected.catalogRow.model) > 0
        && modelIdOf(selected.catalogRow.model) === activePreview.modelId,
      );
      const selectedPreview = selectedRecordMatchesPreview || selectedCatalogMatchesPreview
        ? activePreview
        : null;
      const selectedDeclaredCaptureType = firstDeclaredCaptureType(
        selectedPreview?.captureType,
        selected.catalogRow
          ? captureTypeForToneModel(
              selected.catalogRow.tone,
              selected.catalogRow.model,
            )
          : undefined,
        selected.installedRecord
          ? captureTypeForInstalled(selected.installedRecord)
          : undefined,
      );
      const previewToCleanup = activePreview && !activePreview.saved ? activePreview : null;
      const forcedTarget = sourceFlowConfig?.targetSlot !== "delay" ? sourceFlowConfig?.targetSlot : undefined;
      const targetSlot: NAMTargetSlot = forcedTarget
        ?? selectedPreview?.slot
        ?? (selected.installedRecord
          ? preferredTargetForInstalled(selected.installedRecord)
          : selected.catalogRow
            ? preferredTargetForToneModel(selected.catalogRow.tone, selected.catalogRow.model)
            : sourceFlow === "ir" ? "cab" : sourceFlow === "pedal" ? "pedal" : "amp");
      let durableRecord: NAMInstalledModel | null = selectedPreview?.record ?? selected.installedRecord ?? null;
      let durablePath = selectedPreview?.localPath || durableRecord?.localPath || "";
      let displayName = selectedPreview?.title
        || durableRecord?.toneTitle
        || durableRecord?.name
        || (selected.catalogRow ? toneTitle(selected.catalogRow.tone, selected.catalogRow.model) : "")
        || (targetSlot === "cab" ? "selected IR" : "selected capture");
      const recordIsTemporary = (record: NAMInstalledModel | null) => Boolean(
        record?.preview
        || String(record?.localPath ?? "").replace(/\\/g, "/").toLowerCase().includes("/previews/"),
      );

      if (selectedPreview?.previewDownload || recordIsTemporary(durableRecord)) {
        const previewRecord = selectedPreview?.record ?? durableRecord;
        if (!previewRecord) {
          await failUse("The temporary audition record is missing. Stop the audition and retry the download.");
          return;
        }
        await publishUseProgress("preparing", `Installing and preparing ${displayName}...`);
        const commitResult = await nativeBridge.commitNAMPreviewTone(
          previewRecord,
          {
            toneName: selectedPreview?.title || previewRecord.toneTitle || previewRecord.name || (targetSlot === "cab" ? "Cabinet IR" : "NAM Capture"),
            creator: selectedPreview?.creator || previewRecord.creator,
            sourceUrl: selectedPreview?.sourceUrl || previewRecord.sourceUrl,
            license: selectedPreview?.license || previewRecord.license,
            notes: `Installed from the ${targetSlot === "cab" ? "IR" : "capture"} browser.`,
            componentOnly: true,
          },
          {
            componentOnly: true,
            slot: targetSlot,
            sourceIds: {
              toneId: selectedPreview?.toneId ?? toneIdOf(previewRecord),
              modelId: selectedPreview?.modelId ?? modelIdOf(previewRecord),
            },
          },
        );
        if (!isCurrent()) return;
        if (!commitResult.success || !commitResult.record?.localPath) {
          await failUse(commitResult.error || "Could not install the temporary audition into the local library. Retry Use or stop the audition.");
          return;
        }
        durableRecord = commitResult.record;
        durablePath = commitResult.record.localPath;
        displayName = commitResult.record.toneTitle || commitResult.record.name || displayName;
      } else if (durableRecord?.missing) {
        const payload = makeReinstallPayload(durableRecord);
        if (!payload) {
          await failUse("This saved capture is missing its download metadata. Refresh the catalog or open its source page.");
          return;
        }
        if (!(await ensureTONE3000Auth("downloading the selected capture", isCurrent, canUpdateUI))) {
          await failUse("Connect TONE3000, then retry Use.");
          return;
        }
        await publishUseProgress("downloading", `Downloading ${displayName}...`);
        setBusyLibraryKey(installedKey(durableRecord));
        setBusyModelId(modelIdOf(durableRecord) || null);
        const installResult = await nativeBridge.installNAMModel(payload, { mode: "library" });
        if (!isCurrent()) return;
        if (!installResult.success || !installResult.record?.localPath) {
          await failUse(installResult.error || `Could not download ${displayName}. Retry Use.`);
          return;
        }
        durableRecord = installResult.record;
        durablePath = installResult.record.localPath;
        await publishUseProgress("preparing", `Installing and preparing ${displayName}...`);
      } else if (!durableRecord && selected.catalogRow) {
        const tone = selected.catalogRow.tone;
        let model = selected.catalogRow.model;
        const requestedArchitecture = resolveNAMSearchArchitecture(
          sourceFlow,
          String(tone.searchArchitecture ?? tone.architecture ?? (architecture === "all" ? "all" : architecture) ?? "all"),
        );
        if (!downloadUrlOf(model)) {
          await publishUseProgress("preparing", `Preparing model details for ${displayName}...`);
          const models = await hydrateModelsForTone(tone, requestedArchitecture, isCurrent, canUpdateUI);
          if (!isCurrent()) return;
          if (models.length === 0) {
            await failUse("No downloadable model is available for this capture.");
            return;
          }
          const requestedTarget = forcedTarget ?? (sourceFlow === "ir" ? "cab" : sourceFlow === "pedal" ? "pedal" : "amp");
          model = models.find((candidate) => preferredTargetForToneModel(tone, candidate) === requestedTarget)
            ?? models.find((candidate) => preferredTargetForToneModel(tone, candidate) === "amp")
            ?? models[0];
        }
        const installedRecord = modelIdOf(model) > 0 ? installedByModelId.get(modelIdOf(model)) : undefined;
        if (installedRecord && !installedRecord.missing) {
          durableRecord = installedRecord;
          durablePath = installedRecord.localPath;
          await publishUseProgress("preparing", `Preparing ${displayName}...`);
        } else {
          if (!(await ensureTONE3000Auth("downloading the selected capture", isCurrent, canUpdateUI))) {
            await failUse("Connect TONE3000, then retry Use.");
            return;
          }
          await publishUseProgress("downloading", `Downloading ${displayName}...`);
          setBusyModelId(modelIdOf(model) || null);
          const installResult = await nativeBridge.installNAMModel(
            makeInstallPayload(tone, model),
            { mode: "library" },
          );
          if (!isCurrent()) return;
          if (!installResult.success || !installResult.record?.localPath) {
            await failUse(installResult.error || `Could not download ${displayName}. Retry Use.`);
            return;
          }
          durableRecord = installResult.record;
          durablePath = installResult.record.localPath;
          await publishUseProgress("preparing", `Installing and preparing ${displayName}...`);
        }
      }

      if (!durableRecord || !durablePath.trim()) {
        await failUse("The selected component has no installed local file. Retry the download.");
        return;
      }

      const beforeValues = beforeState?.values && typeof beforeState.values === "object" ? beforeState.values : {};
      const requestedCabEnabled = targetSlot === "cab"
        ? true
        : rollbackSnapshot.cabRequestedEnabled;
      const activatedAmpMix = Number(beforeValues.ampMix ?? 0) > 0.0001
        ? Number(beforeValues.ampMix)
        : 1;
      const declaredCaptureType = firstDeclaredCaptureType(
        selectedDeclaredCaptureType,
        captureTypeForInstalled(durableRecord),
      );
      const modelState = targetSlot === "pedal"
        ? {
            pedalModelPath: durablePath,
            pedalDeclaredCaptureType: declaredCaptureType,
            cabRequestedEnabled: requestedCabEnabled,
          }
        : targetSlot === "amp"
          ? {
              ampModelPath: durablePath,
              ampDeclaredCaptureType: declaredCaptureType,
              cabRequestedEnabled: requestedCabEnabled,
            }
          : {
              cabIRPath: durablePath,
              cabRequestedEnabled: requestedCabEnabled,
            };
      await publishUseProgress("activating", `Activating ${displayName} in the ${targetLabelForSlot(targetSlot)} slot...`);
      const liveInputReady = await nativeBridge.setNAMRackInternalAuditionSource(address, false);
      if (!isCurrent()) return;
      if (!liveInputReady) {
        await failUse("Live guitar input could not be restored before activating the selected component.");
        return;
      }
      const used = await nativeBridge.setBuiltInPluginState(address, {
        applyDirectLoadPolicy: true,
        values: {
          ...(targetSlot === "pedal"
            ? { pedalMix: Number(beforeValues.pedalMix ?? 0) > 0.0001 ? Number(beforeValues.pedalMix) : 1 }
            : {}),
          ...(targetSlot === "amp"
            ? { ampEnabled: 1, ampMix: activatedAmpMix }
            : {}),
          ...(targetSlot === "cab" ? { cabEnabled: 1 } : {}),
        },
        modelState,
      });
      if (!isCurrent()) return;
      if (!used) {
        const restored = await restoreAuthoritativeRack();
        if (!isCurrent()) return;
        await failUse(
          "The capture was installed, but the rack rejected activation. "
          + (restored ? "The previous rack was restored and verified; retry Use." : "The previous rack could not be verified; stay here and retry."),
        );
        return;
      }

      const activation = await waitForNAMCaptureActivation(
        () => nativeBridge.getBuiltInPluginState(address),
        targetSlot,
        durablePath,
        {
          attempts: 4,
          delayMs: 45,
          requireLiveSource: true,
          expectedCabRequestedEnabled: requestedCabEnabled,
        },
      );
      if (!isCurrent()) return;
      if (!activation.verified) {
        const restored = await restoreAuthoritativeRack();
        if (!isCurrent()) return;
        await failUse(
          `${activation.reason || "The rack could not verify the selected capture."} `
          + (restored ? "The previous rack was restored; retry Use." : "The previous rack could not be verified, so stay here and retry."),
        );
        return;
      }

      const activatedUiState = activation.state?.uiState && typeof activation.state.uiState === "object"
        ? activation.state.uiState as Record<string, unknown>
        : {};
      const startingNewRig =
        targetSlot === "amp"
        && !rollbackSnapshot.ampModelPath;
      const finalized = await nativeBridge.setBuiltInPluginState(address, {
        uiState: {
          ...activatedUiState,
          namActivePreview: null,
          namPresetDirty: true,
          ...(startingNewRig
            ? {
                namActivePresetName: null,
                namPresetBaseline: null,
              }
            : {}),
        },
      });
      if (!isCurrent()) return;
      if (!finalized) {
        const restored = await restoreAuthoritativeRack();
        if (!isCurrent()) return;
        await failUse(
          "The capture loaded, but the rack could not finalize its saved selection. "
          + (restored ? "The previous rack was restored and verified; retry Use." : "The previous rack could not be verified; stay here and retry."),
        );
        return;
      }

      const finalReadback = await waitForNAMCaptureActivation(
        () => nativeBridge.getBuiltInPluginState(address),
        targetSlot,
        durablePath,
        {
          attempts: 4,
          delayMs: 45,
          requireLiveSource: true,
          requirePreviewCleared: true,
          expectedCabRequestedEnabled: requestedCabEnabled,
        },
      );
      if (!isCurrent()) return;
      if (!finalReadback.verified) {
        const restored = await restoreAuthoritativeRack();
        if (!isCurrent()) return;
        await failUse(
          `${finalReadback.reason || "Final activation readback failed."} `
          + (restored ? "The previous rack was restored and verified; retry Use." : "The previous rack could not be verified; stay here and retry."),
        );
        return;
      }

      await enableLiveTrackMonitoring(isCurrent, canUpdateUI);
      if (!isCurrent()) return;
      await cleanupPreviewAudition(previewToCleanup, false, isCurrent, canUpdateUI);
      if (!isCurrent()) return;
      updateAudition(null);
      await refreshInstalledLibraryAfterMutation(canUpdateUI);
      if (!isCurrent()) return;
      let refreshedSchema: BuiltInPluginSchema | null = null;
      let refreshedSchemaInspection = inspectNAMCaptureSchemaActivation(
        null,
        targetSlot,
        durablePath,
        {
          requireLiveSource: true,
          requirePreviewCleared: true,
          expectedCabRequestedEnabled: requestedCabEnabled,
        },
      );
      for (let refreshAttempt = 1; refreshAttempt <= 3; refreshAttempt += 1) {
        refreshedSchema = await Promise.resolve(onRefreshRack());
        if (!isCurrent()) return;
        refreshedSchemaInspection = inspectNAMCaptureSchemaActivation(
          refreshedSchema,
          targetSlot,
          durablePath,
          {
            requireLiveSource: true,
            requirePreviewCleared: true,
            expectedCabRequestedEnabled: requestedCabEnabled,
          },
        );
        if (refreshedSchemaInspection.verified) break;
        if (refreshAttempt < 3) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 45));
        }
      }
      if (!refreshedSchemaInspection.verified) {
        await failUse(
          `${refreshedSchemaInspection.reason || "The rack view did not accept the activated capture."} `
          + "The capture remains active in the audio engine; retry Use to refresh the rack view.",
        );
        return;
      }
      const successMessage = targetSlot === "cab"
        ? `${displayName} is installed and active in Cab/IR.`
        : `${displayName} is installed and active in ${targetLabelForSlot(targetSlot)}.`;
      if (canUpdateUI()) {
        setCaptureUseProgress({ phase: "success", rowId: progressRowId, message: successMessage });
        setStatus(successMessage);
        onReturn?.();
      }
    } catch (error) {
      console.error("[NAMExplorer] Use component failed:", error);
      await failUse("Could not finish using the selected component. The library selection is still available; retry Use.");
    } finally {
      if (canUpdateUI()) {
        setBusyLibraryKey(null);
        setBusyModelId(null);
      }
      finishRackTransaction(generation);
    }
  };

  const applySourceFlowDesignTab = (value: string) => {
    const normalized = value.toLowerCase();
    setSelectedKey("");
    if (sourceFlow === "ir") {
      if (normalized.includes("installed")) setTab("installed");
      else if (normalized.includes("favorite")) setTab("favorites");
      else {
        setTab("trending");
        setSortMode("trending");
        setSourceFlowCategoryFilter("cabinet-ir");
      }
      return;
    }
    if (sourceFlow === "fx") {
      setSourceFlowCategoryFilter("all");
      return;
    }
    const nextTab: NAMTab =
      normalized.includes("download") ? "downloads-all-time" :
      normalized.includes("installed") ? "installed" :
      normalized.includes("favorite") ? "favorites" :
      normalized.includes("trending") ? "trending" :
      "trending";
    setTab(nextTab);
    setSortMode(defaultSortForTab(nextTab));
  };

  const applySourceFlowDesignFilter = (value: string) => {
    if (!sourceFlowConfig) return;
    if (value === "arch-a1" || value === "A1") {
      setArchitecture("a1");
      setSelectedKey("");
      return;
    }
    if (value === "arch-a2" || value === "A2") {
      setArchitecture("a2");
      setSelectedKey("");
      return;
    }
    const control = sourceFlowConfig.filterControls.find((entry) => (
      entry.id === value || entry.label.toLowerCase() === value.toLowerCase()
    ));
    if (control) applySourceFlowFilterControl(control);
  };

  const handleSourceFlowReturn = async () => {
    const returnGeneration = beginRackTransaction();
    if (returnGeneration === null) {
      setStatus("Wait for the active rack change to finish before returning to the rack.");
      return false;
    }
    const isCurrent = () => isRackTransactionCurrent(returnGeneration);
    const canUpdateUI = () => canUpdateRackTransactionUI(returnGeneration);
    try {
      const previewResolved = sourceFlow === "fx"
        ? await revertOpenStudioFXPreset(returnGeneration)
        : await revertAuditionInTransaction(returnGeneration);
      if (!isCurrent()) return false;
      if (!previewResolved) {
        if (canUpdateUI()) {
          setStatus(sourceFlow === "fx"
            ? "Preset preview could not be cancelled. Choose Apply Preset or Cancel Preview before leaving."
            : "The temporary capture/IR audition could not be stopped. Choose Use or retry Stop Audition before leaving.");
        }
        return false;
      }
      const liveInputRestored = await nativeBridge.setNAMRackInternalAuditionSource(address, false);
      if (!isCurrent()) return false;
      if (!liveInputRestored) {
        if (canUpdateUI()) setStatus("The browser stayed open because live guitar input could not be restored.");
        return false;
      }
      if (mountedRef.current) onReturn?.();
      return true;
    } catch (error) {
      console.warn("[NAMExplorer] Could not finish the source-flow return", error);
      if (canUpdateUI()) setStatus("Could not safely return to the rack.");
      return false;
    } finally {
      finishRackTransaction(returnGeneration);
    }
  };

  const handleSourceFlowDesignAction = (message: NAMSourceFlowDesignPortMessage) => {
    const action = message.action as NAMSourceFlowDesignActionId;
    if (action === "return") {
      void handleSourceFlowReturn();
      return;
    }
    if (action === "search") {
      if (sourceFlow !== "fx" && tab !== "installed" && tab !== "favorites") void submitLiveSearch(1);
      else setSelectedKey("");
      return;
    }
    if (action === "retry") {
      if (sourceFlow !== "fx") retryLiveSearch();
      return;
    }
    if (action === "load-more" || action === "auto-load-more") {
      if (catalogMode === "live" && liveCanLoadMore) {
        void requestNextLivePage(action === "load-more" ? "manual" : "observer");
      }
      return;
    }
    if (action === "scroll") {
      const scrollTop = Number(message.value);
      if (Number.isFinite(scrollTop)) updateNAMExplorerSessionScroll(sessionViewKey, scrollTop);
      return;
    }
    if (action === "query") {
      setQuery(message.value || "");
      setSelectedKey("");
      return;
    }
    if (action === "sort") {
      if (isNAMSortMode(message.value || "")) applySortMode(message.value as NAMSortMode);
      return;
    }
    if (action === "clear-filters") {
      clearExplorerFilters();
      return;
    }
    if (action === "tab") {
      applySourceFlowDesignTab(message.value || "");
      return;
    }
    if (action === "filter") {
      applySourceFlowDesignFilter(message.value || "");
      return;
    }
    if (action === "select-row") {
      const { preset } = findSourceFlowRow(message.rowId);
      if (preset) setSelectedFXPresetId(preset.id);
      else setSelectedKey(message.rowId || "");
      return;
    }
    if (action === "favorite") {
      const { installedRecord, catalogRow } = findSourceFlowRow(message.rowId);
      if (installedRecord) void toggleInstalledFavorite(installedRecord);
      else if (catalogRow) toggleFavorite(catalogRow.tone, catalogRow.model);
      return;
    }
    if (action === "preview") {
      void runSourceFlowPreviewAction(message.rowId, "preview");
      return;
    }
    if (action === "load") {
      void runSourceFlowPreviewAction(message.rowId, "load");
      return;
    }
    if (action === "apply-preset") {
      void useSourceFlowSelection(message.rowId);
      return;
    }
    if (action === "save-preset") {
      openSaveToneModal();
      return;
    }
    if (action === "use-selection") {
      void useSourceFlowSelection(message.rowId);
      return;
    }
    if (action === "revert") {
      if (sourceFlow === "fx") void revertOpenStudioFXPreset();
      else void revertAudition();
      return;
    }
    if (action === "load-local-nam") {
      void loadLocalNAMFile(sourceFlow === "pedal" ? "pedal" : "amp");
      return;
    }
    if (action === "load-local-ir") {
      if (onLoadLocalIR) onLoadLocalIR();
      else void loadLocalIRFile();
      return;
    }
    if (action === "open-ir-sources") {
      onOpenIRSources?.();
      return;
    }
    if (action === "open-source") {
      openSourceFlowSourceUrl(message.rowId);
    }
  };

  if (sourceFlowMode && sourceFlowDesignConfig) {
    const sourceFlowNavigationLocked = rackActionsBusy
      || Boolean(fxPreview)
      || Boolean(audition && !audition.saved);
    return (
      <>
        <NAMRackSourceFlowDesignPort
          config={sourceFlowDesignConfig}
          rackSizePercent={rackSizePercent}
          parameters={schema.parameters}
          presetName={sourceFlow === "amp" && captureUseInFlight && !activeSourceSlotPath
            ? captureUseProgress.message
            : rackPresetName}
          presetEyebrow={sourceFlow === "amp" && captureUseInFlight && !activeSourceSlotPath
            ? "Preparing First Amp Capture"
            : undefined}
          presetDirty={rackPresetDirty}
          compareSlot={compareSlot}
          calibration={calibration}
          tunerOpen={tunerOpen}
          signalChainOpen={signalChainOpen}
          runtime={{
            tempo: sourceFlowTempo,
            timeSignatureLabel: `${sourceFlowTimeSignature.numerator}/${sourceFlowTimeSignature.denominator}`,
            sampleRateLabel: runtimeStatus?.sampleRateLabel ?? "--",
            bufferLabel: runtimeStatus?.bufferLabel ?? "--",
            latencyLabel: runtimeStatus?.latencyLabel ?? "--",
            cpuLabel: runtimeStatus?.cpuLabel,
            cpuAlert: runtimeStatus?.cpuAlert,
            dspLabel: runtimeStatus?.dspLabel,
            dspAlert: runtimeStatus?.dspAlert,
            inputLevelDb: runtimeStatus?.inputLevelDb ?? schema.visualization?.inputLevelDb,
            outputLevelDb: runtimeStatus?.outputLevelDb ?? schema.visualization?.outputLevelDb,
          }}
          onEnterSection={sourceFlowNavigationLocked ? undefined : onEnterRackSection}
          onCloseLibrary={rackActionsBusy ? undefined : () => void handleSourceFlowReturn()}
          onPreviousPreset={sourceFlowNavigationLocked ? undefined : onPreviousPreset}
          onNextPreset={sourceFlowNavigationLocked ? undefined : onNextPreset}
          previousPresetLabel={previousPresetLabel}
          nextPresetLabel={nextPresetLabel}
          onSavePreset={sourceFlowNavigationLocked ? undefined : onSavePreset}
          onOpenPresetManager={sourceFlowNavigationLocked ? undefined : onOpenPresetManager}
          onRecallCompare={sourceFlowNavigationLocked ? undefined : onRecallCompare}
          onOpenCalibration={sourceFlowNavigationLocked ? undefined : onOpenCalibration}
          onOpenTuner={sourceFlowNavigationLocked ? undefined : onOpenTuner}
          onOpenSignalChain={sourceFlowNavigationLocked ? undefined : onOpenSignalChain}
          onOpenSettings={sourceFlowNavigationLocked || windowRole === "pluginEditor" ? undefined : openSettings}
          onOpenAdvanced={sourceFlowNavigationLocked ? undefined : onOpenAdvanced}
          onCycleSize={onCycleSize}
          onMaxSize={onMaxSize}
          onAction={handleSourceFlowDesignAction}
        />
        <NAMToneSaveModal
          isOpen={saveToneOpen}
          draft={saveToneDraft}
          busy={rackActionsBusy}
          onDraftChange={setSaveToneDraft}
          onClose={() => setSaveToneOpen(false)}
          onSave={() => void saveAuditionTone()}
        />
      </>
    );
  }

  const renderEmptyResults = () => {
    if (tab === "installed") {
      return (
        <NAMEmptyState
          icon={<HardDrive size={26} />}
          title="No saved Presets yet"
          body="Audition a Capture, then use Save Preset to store the complete rack in this user's OpenStudio NAM library."
          action={(
            <Button variant="ghost" size="sm" onClick={() => { setTab("latest"); setSelectedKey(""); }}>
              <Search size={13} />
              Browse tones
            </Button>
          )}
        />
      );
    }

    if (tab === "favorites") {
      return (
        <NAMEmptyState
          icon={<Star size={26} />}
          title="No favorites yet"
          body="Favorite tones from search results or your local library to build a fast audition shortlist."
          action={(
            <Button variant="ghost" size="sm" onClick={() => { setTab("trending"); setSelectedKey(""); }}>
              <Radio size={13} />
              Explore trending
            </Button>
          )}
        />
      );
    }

    if (authChecking && catalog.length === 0) {
      return (
        <NAMEmptyState
          icon={<RefreshCw size={26} />}
          title="Checking TONE3000"
          body="Looking for a saved TONE3000 session before asking you to connect."
        />
      );
    }

    if (!authStatus?.authenticated && !authRefreshAvailable && catalog.length === 0) {
      return (
        <NAMEmptyState
          icon={<WifiOff size={26} />}
          title="Connect to browse tones"
          body="Sign in with your own TONE3000 account, then search NAM captures and cabinet IRs directly in this rack."
          action={(
            <Button size="sm" onClick={() => void startAuth()} disabled={authUiBusy}>
              <LogIn size={13} />
              Connect TONE3000
            </Button>
          )}
        />
      );
    }

    return (
      <NAMEmptyState
        icon={<Search size={26} />}
        title={sourceFlowConfig?.emptyTitle ?? "No tones match"}
        body={sourceFlowConfig?.emptyBody ?? "Try clearing the search, broadening the architecture or gear filters, or switching to Online search."}
        action={(
          <Button variant="ghost" size="sm" onClick={clearExplorerFilters}>
            <SlidersHorizontal size={13} />
            Clear filters
          </Button>
        )}
      />
    );
  };

  const renderFXCollectionResults = () => {
    if (fxRows.length === 0) {
      return (
        <NAMEmptyState
          icon={<SlidersHorizontal size={26} />}
          title={sourceFlowConfig?.emptyTitle ?? "No FX presets match"}
          body={sourceFlowConfig?.emptyBody ?? "Search EQ, Mod, Delay, or Reverb presets from the OpenStudio FX Collection."}
          action={(
            <Button variant="ghost" size="sm" onClick={clearExplorerFilters}>
              <SlidersHorizontal size={13} />
              Clear filters
            </Button>
          )}
        />
      );
    }

    return fxRows.map((preset) => {
      const isSelected = selectedFXPreset?.id === preset.id;
      const isPreviewing = fxPreview?.preset.id === preset.id;
      return (
        <article
          key={preset.id}
          className="nam-result-card tone-feed-row"
          data-view="list"
          data-selected={isSelected}
          data-source="openstudio"
          data-category={preset.category}
          onClick={() => setSelectedFXPresetId(preset.id)}
          onDoubleClick={() => void applyOpenStudioFXPreset(preset, "apply")}
        >
          <button
            type="button"
            className="nam-result-select-target"
            onClick={(event) => {
              event.stopPropagation();
              setSelectedFXPresetId(preset.id);
            }}
            aria-label={`Select ${preset.name} details`}
          />
          <NAMSourceFlowDesignArt
            className="nam-card-art"
            mode="fx"
            moduleId={preset.moduleId}
            label={preset.category.toUpperCase()}
            title={preset.moduleId}
            compact
          />
          <div className="nam-result-copy">
            <strong>{preset.name}</strong>
            <span>OpenStudio FX Collection - {preset.moduleId}</span>
            <small>{preset.description}</small>
          </div>
          <div className="nam-result-badges">
            <span>OpenStudio preset</span>
            <span>{preset.category}</span>
          </div>
          <div className="nam-stats">
            <span>Wrapper FX</span>
            <span>Post FX</span>
          </div>
          <div className="nam-result-actions tone-action-grid">
            <Button size="sm" onClick={() => void applyOpenStudioFXPreset(preset)}>
              <Play size={13} />
              {isPreviewing ? "Previewing" : "Preview Preset"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void applyOpenStudioFXPreset(preset, "apply")}>
              <CheckCircle2 size={13} />
              Apply Preset
            </Button>
          </div>
        </article>
      );
    });
  };

  const legacySourceFlowTargetCards = sourceFlowConfig ? [
    { slot: "pedal", label: "Pedal NAM", detail: sourceFlowConfig.mode === "pedal" ? "Selected Pre FX pedal slot" : sidebarPedalIdentity.title || namDisplayNameFromPath(currentPedal) || "Open from Pre FX" },
    { slot: "amp", label: "Amp NAM", detail: sourceFlowConfig.mode === "amp" ? "Selected Amp slot" : sidebarAmpIdentity.title || namDisplayNameFromPath(currentAmp) || "Open from Amp" },
    { slot: "cab", label: "Cab/IR", detail: sourceFlowConfig.mode === "ir" ? "Selected Cab/IR slot" : namDisplayNameFromPath(schema.modelState?.cabIRPath || "") || "Open from Cab" },
  ] as Array<{ slot: NAMTargetSlot; label: string; detail: string }> : [];

  return (
    <section
      className={`nam-explorer${sourceFlowConfig ? " tone-source-flow" : ""}`}
      data-variant={variant}
      data-library-mode={sourceFlowConfig ? "source-flow" : undefined}
      data-source-mode={sourceFlowConfig?.sourceMode}
    >
      {sourceFlowConfig && (
        <div className="tone-source-flow-head">
          <button
            type="button"
            className="tone-return-button"
            data-return-target={sourceFlowConfig.returnTarget}
            onClick={onReturn}
          >
            <ChevronLeft size={14} />
            {sourceReturnLabel ?? sourceFlowConfig.returnLabel}
          </button>
          <div className="tone-breadcrumb" aria-label="Tone Library breadcrumb">
            <span>{sourceFlowConfig.breadcrumb}</span>
          </div>
          <div className="tone-source-summary">
            <span>Source: <b>{sourceFlowConfig.sourceLabel}</b></span>
            <span>Target: <b>{sourceFlowConfig.targetLabel}</b></span>
          </div>
        </div>
      )}
      <aside className="nam-explorer-sidebar">
        {sourceFlowConfig ? (
          <div className="tone-source-sidebar">
            <div className="tone-target-list" aria-label="Tone Library targets">
              {legacySourceFlowTargetCards.map((target) => (
                <article
                  key={target.slot}
                  className="tone-target-card"
                  data-slot={target.slot}
                  data-active={sourceFlowConfig.targetSlot === target.slot}
                >
                  <span>{target.label}</span>
                  <strong>{target.detail}</strong>
                </article>
              ))}
              {sourceFlowConfig.mode === "fx" && (
                <article className="tone-target-card" data-slot="delay" data-active="true">
                  <span>Post FX</span>
                  <strong>Mod / Delay / Reverb</strong>
                </article>
              )}
            </div>
            <div className="tone-source-lanes" aria-label="Tone Library source lanes">
              {sourceFlowConfig.lanes.map((lane) => (
                <button
                  key={lane.id}
                  type="button"
                  data-lane={lane.id}
                  data-active={Boolean(lane.active)}
                  data-loadable={Boolean(lane.loadable)}
                  onClick={() => {
                    if (lane.id === "local-nam") {
                      void loadLocalNAMFile(sourceFlow === "pedal" ? "pedal" : "amp");
                    }
                    if (lane.id === "local-ir") {
                      if (onLoadLocalIR) onLoadLocalIR();
                      else void loadLocalIRFile();
                    }
                    if (lane.id === "ir-sources") onOpenIRSources?.();
                  }}
                >
                  <span>{lane.label}</span>
                  <small>{lane.detail}</small>
                </button>
              ))}
            </div>
            <div className="tone-filter-row" aria-label="Source flow filters">
              {sourceFlowConfig.filters.map((filter) => (
                <span
                  key={filter}
                  data-supported-pedal={sourceFlowConfig.mode === "pedal" && isSupportedTONE3000PedalCategory(filter.toLowerCase())}
                >
                  {filter}
                </span>
              ))}
            </div>
            {sourceFlowConfig.mode === "ir" && (
              <button type="button" className="tone-local-path" onClick={() => {
                if (onLoadLocalIR) onLoadLocalIR();
                else void loadLocalIRFile();
              }}>
                <FolderOpen size={13} />
                Load Local File
              </button>
            )}
            {sourceFlowConfig.mode === "fx" && (
              <button type="button" className="tone-local-path" onClick={() => onOpenIRSources?.()}>
                <ExternalLink size={13} />
                Open IR Sources
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="nam-rack-slots">
              <div>
                <span>Pedal</span>
                <strong title={currentPedal}>{sidebarPedalIdentity.title || namDisplayNameFromPath(currentPedal) || "Empty"}</strong>
              </div>
              <div>
                <span>Amp</span>
                <strong title={currentAmp}>{sidebarAmpIdentity.title || namDisplayNameFromPath(currentAmp) || "Empty"}</strong>
              </div>
            </div>

            <div className="nam-shelves" aria-label="NAM catalog shelves">
              {NAM_SHELVES.map(([id, label]) => (
                <button key={id} type="button" data-active={activeShelf === id} onClick={() => selectShelf(id)}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {sourceFlow !== "fx" && (
        <div className="nam-auth" data-busy={authChecking || authUiBusy}>
          <div className="nam-auth-head">
            <span>
              <KeyRound size={13} />
              {formatAuthStatus(authStatus)}
            </span>
            <div>
              {authConnected && (
                <span className="nam-auth-ready">
                  <CheckCircle2 size={13} />
                  Ready
                </span>
              )}
              {showConnectAction && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!authClientConfigured) {
                      setAuthAdvancedOpen(true);
                      setStatus("Set a registered TONE3000 publishable client_id in Advanced / Developer.");
                      return;
                    }
                    void startAuth();
                  }}
                  title={!authClientConfigured ? "Configure a registered TONE3000 client_id" : authExpired ? "Reconnect TONE3000" : "Connect TONE3000"}
                >
                  <LogIn size={14} />
                  {!authClientConfigured ? "Configure" : authExpired ? "Reconnect" : "Connect"}
                </Button>
              )}
              {authUiBusy && (
                <Button variant="ghost" size="sm" onClick={() => void cancelAuth()} title="Cancel TONE3000 sign-in">
                  Cancel
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" onClick={() => void refreshAuth()} disabled={authUiBusy || !authStatus?.hasRefreshToken} title="Refresh token">
                <RefreshCw size={14} />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void clearAuth()} disabled={authUiBusy || (!authStatus?.authenticated && !authStatus?.hasRefreshToken)} title="Disconnect TONE3000">
                <LogOut size={14} />
              </Button>
            </div>
          </div>
          <p className="nam-auth-copy">
            {authChecking
              ? authRefreshAvailable
                ? "Refreshing saved TONE3000 session."
                : "Checking for a saved TONE3000 session."
              : authConnected
                ? "Account ready for TONE3000 tones."
                : authRefreshAvailable
                  ? "Saved TONE3000 session found. Refreshing automatically."
                : authExpired
                  ? authStatus?.hasRefreshToken
                    ? "Token expired. Refresh or reconnect to keep browsing online tones."
                    : "Token expired. Reconnect in the browser to keep browsing online tones."
                : authStatus?.configuredClientId || clientId.trim()
                  ? "Create or sign in to your own TONE3000 account in the browser."
                  : "This dev build needs a TONE3000 publishable client_id in Advanced / Developer."}
          </p>
          <span className="nam-auth-library" title={libraryPath}>
            {catalogMode === "live"
              ? "Online TONE3000"
              : libraryPath
                ? `${catalogStale ? "Saved catalog needs refresh" : "Saved catalog ready"} - ${shortPath(libraryPath)}`
                : "Saved catalog"}
          </span>
          <details className="nam-auth-advanced" open={authAdvancedOpen} onToggle={(event) => setAuthAdvancedOpen(event.currentTarget.open)}>
            <summary>Advanced / Developer</summary>
            <div className="nam-auth-grid">
              <Input value={clientId} onChange={(event) => setClientId(event.currentTarget.value)} placeholder="TONE3000 client_id" />
              <Input value={redirectUri} onChange={(event) => setRedirectUri(event.currentTarget.value)} placeholder="Redirect URI" />
              <Button size="sm" onClick={() => void startManualAuth()} disabled={authUiBusy || !clientId.trim()}>
                Start manual auth
              </Button>
              {fallbackAuthUrl && (
                <Button variant="ghost" size="sm" onClick={() => void nativeBridge.openExternalURL(fallbackAuthUrl)} title={fallbackAuthUrl}>
                  Open auth URL
                </Button>
              )}
              <Input value={callbackValue} onChange={(event) => setCallbackValue(event.currentTarget.value)} placeholder="Complete callback URL" />
              <Button size="sm" onClick={() => void completeAuth()} disabled={authUiBusy || !callbackValue.trim()}>
                Complete
              </Button>
            </div>
          </details>
        </div>
        )}
      </aside>

      <div className="nam-explorer-main">
        {railMode && (
          <div className="nam-rail-tone-status" data-connected={authConnected} data-busy={authChecking || authUiBusy}>
            <div>
              <span>Tone Library</span>
              <strong>{authChecking || authUiBusy ? "Checking" : authConnected ? "Connected" : authRefreshAvailable ? "Refresh available" : "Offline"}</strong>
            </div>
            <em>TONE3000</em>
          </div>
        )}

        {sourceFlow === "fx" && selectedFXPreset ? (
          <div className="nam-browse-hero tone-fx-hero" data-saved={Boolean(fxPreview?.preset.id === selectedFXPreset.id)} data-audition={Boolean(fxPreview?.preset.id === selectedFXPreset.id)} data-has-art="true">
            <NAMSourceFlowDesignArt
              className="nam-browse-hero-art"
              mode="fx"
              moduleId={selectedFXPreset.moduleId}
              label={selectedFXPreset.category.toUpperCase()}
              title={selectedFXPreset.moduleId}
            />
            <div className="nam-browse-hero-copy">
              <span>OpenStudio FX Collection</span>
              <strong>{selectedFXPreset.name}</strong>
              <small>{selectedFXPreset.description}</small>
              <div className="nam-browse-hero-tags" aria-label="Selected FX preset metadata">
                <span>{selectedFXPreset.moduleId}</span>
                <span>{selectedFXPreset.category}</span>
                <span>Wrapper FX</span>
                <span>OpenStudio preset</span>
              </div>
            </div>
            <div className="nam-browse-hero-side">
              <div className="nam-browse-hero-stats" aria-label="Selected FX preset stats">
                <span>Post FX</span>
                <span>Built-in preset</span>
              </div>
              <div className="nam-browse-hero-actions tone-action-grid">
                <Button size="sm" onClick={() => void applyOpenStudioFXPreset(selectedFXPreset)} disabled={rackActionsBusy}>
                  <Play size={14} />
                  Preview Preset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void applyOpenStudioFXPreset(selectedFXPreset, "apply")} disabled={rackActionsBusy}>
                  <CheckCircle2 size={14} />
                  Apply Preset
                </Button>
                <Button className="nam-save-tone-button" size="sm" onClick={() => void useSourceFlowSelection()} disabled={rackActionsBusy}>
                  <CheckCircle2 size={14} />
                  {sourceFlowUseLabel}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void revertOpenStudioFXPreset()} disabled={rackActionsBusy || !fxPreview}>
                  <RotateCcw size={14} />
                  Revert
                </Button>
              </div>
            </div>
          </div>
        ) : hasSelectedRail && (
          <div className="nam-browse-hero" data-saved={Boolean(audition?.saved)} data-audition={Boolean(audition && !audition.saved)} data-has-art={sourceFlow ? "true" : Boolean(selectedRailArtUrl)}>
            {sourceFlow ? (
              <NAMSourceFlowDesignArt
                className="nam-browse-hero-art"
                mode={sourceFlow}
                label={selectedRailArch}
                title={selectedRailGear}
              />
            ) : (
              <div
                className="nam-browse-hero-art"
                data-has-art={Boolean(selectedRailArtUrl)}
                data-provider-art={selectedRailFallbackProfile === "provider"}
                data-fallback-profile={selectedRailFallbackProfile}
                style={artBackgroundStyle(selectedRailArtUrl)}
                aria-hidden="true"
              >
                <span>{selectedRailArch}</span>
                <strong>{selectedRailGear}</strong>
              </div>
            )}
            <div className="nam-browse-hero-copy">
              <span>{audition ? audition.saved ? "Saved tone" : audition.previewDownload ? "Unsaved preview" : "Auditioning" : selectedInstalled ? "Library tone" : "Featured tone"}</span>
              <strong>{selectedRailTitle}</strong>
              <small>{selectedRailSubtitle}</small>
              <div className="nam-browse-hero-tags" aria-label="Selected tone metadata">
                {selectedHeroTags.slice(0, 4).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </div>
            <div className="nam-browse-hero-side">
              <div className="nam-browse-hero-stats" aria-label="Selected tone stats">
                {selectedHeroStats.map((stat) => (
                  <span key={stat}>{stat}</span>
                ))}
              </div>
              <div className="nam-browse-hero-actions">
                {audition ? (
                  <>
                    <Button className="nam-save-tone-button" size="sm" onClick={openSaveToneModal} disabled={rackActionsBusy || audition.saved}>
                      <Save size={14} />
                      {audition.saved ? "Preset Saved" : "Save Preset"}
                    </Button>
                    {sourceFlowConfig && (
                      <Button className="nam-save-tone-button" size="sm" onClick={() => void useSourceFlowSelection()} disabled={rackActionsBusy || audition.saved}>
                        <CheckCircle2 size={14} />
                        {sourceFlowUseLabel}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void revertAudition()} disabled={rackActionsBusy}>
                      <Square size={14} />
                      Stop Audition
                    </Button>
                  </>
                ) : selectedInstalled ? (
                  selectedInstalledSourceOnly ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => selectedInstalled.sourceUrl ? void nativeBridge.openExternalURL(selectedInstalled.sourceUrl) : undefined}
                      disabled={!selectedInstalled.sourceUrl}
                      title="Open convolution/source material page"
                    >
                      <ExternalLink size={13} />
                      Open Source
                    </Button>
                  ) : selectedInstalled.missing ? (
                    <Button size="sm" onClick={() => void reinstallInstalled(selectedInstalled)} disabled={rackActionsBusy || busyLibraryKey === installedKey(selectedInstalled) || !makeReinstallPayload(selectedInstalled)}>
                      <Download size={13} />
                      {makeReinstallPayload(selectedInstalled) ? "Restore" : "Missing"}
                    </Button>
                  ) : (
                    <>
                      {selectedInstalled.updateAvailable && (
                        <Button variant="ghost" size="sm" onClick={() => void updateInstalled(selectedInstalled)} disabled={rackActionsBusy || busyLibraryKey === installedKey(selectedInstalled) || !makeUpdatePayload(selectedInstalled)}>
                          <RefreshCw size={13} />
                          Update
                        </Button>
                      )}
                      {selectedInstalledCanCommit && (
                        <Button className="nam-save-tone-button" size="sm" onClick={openSaveToneModal} disabled={rackActionsBusy}>
                          <Save size={14} />
                          Save Preset
                        </Button>
                      )}
                      {sourceFlowConfig && selectedInstalledCanCommit && (
                        <Button className="nam-save-tone-button" size="sm" onClick={() => void useSourceFlowSelection()} disabled={rackActionsBusy}>
                          <CheckCircle2 size={14} />
                          {sourceFlowUseLabel}
                        </Button>
                      )}
                      {selectedInstalledTargetSlot === "cab" ? (
                        <Button size="sm" onClick={() => void toggleInstalledAudition(selectedInstalled)} disabled={rackActionsBusy || busyModelId === selectedInstalled.modelId}>
                          {installedAuditionIsActive(selectedInstalled) ? <RotateCcw size={13} /> : <FolderOpen size={13} />}
                          {installedAuditionIsActive(selectedInstalled) ? "Stop" : `Audition ${selectedInstalledTargetLabel}`}
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => void toggleInstalledAudition(selectedInstalled)} disabled={rackActionsBusy || busyModelId === selectedInstalled.modelId}>
                          {installedAuditionIsActive(selectedInstalled) ? <RotateCcw size={13} /> : <Play size={13} />}
                          {installedAuditionIsActive(selectedInstalled) ? "Stop" : "Audition"}
                        </Button>
                      )}
                    </>
                  )
                ) : selectedCatalogRow ? (
                  <>
                    {selectedCatalogCanCommit && (
                      <Button className="nam-save-tone-button" size="sm" onClick={openSaveToneModal} disabled={rackActionsBusy}>
                        <Save size={14} />
                        Save Preset
                      </Button>
                    )}
                    {sourceFlowConfig && selectedCatalogCanCommit && (
                      <Button className="nam-save-tone-button" size="sm" onClick={() => void useSourceFlowSelection()} disabled={rackActionsBusy}>
                        <CheckCircle2 size={14} />
                        {sourceFlowUseLabel}
                      </Button>
                    )}
                    {renderCatalogAction(selectedCatalogRow)}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        )}

        <div className="nam-toolbar">
          <div className="nam-tabs">
            {sourceFlow === "fx" ? (
              <>
                <button type="button" data-active="true">OpenStudio FX Collection</button>
                <button type="button" data-active="false">Built-in presets</button>
              </>
            ) : ([
                ["latest", "Latest"],
                ["trending", "Trending"],
                ["downloads-all-time", "Downloaded"],
                ["installed", "Installed"],
                ["favorites", "Favorites"],
              ] as Array<[NAMTab, string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  data-active={tab === id}
                  onClick={() => {
                    setTab(id);
                    setSortMode(defaultSortForTab(id));
                    setSelectedKey("");
                  }}
                >
                  {label}
                </button>
              ))}
          </div>
          <div className="nam-view-actions">
            {!railMode && (
              <Button size="sm" onClick={openSaveToneModal} title="Save the complete NAM Rack Preset" disabled={rackActionsBusy}>
                <Save size={14} />
                Save Preset
              </Button>
            )}
            {!railMode && sourceFlow !== "fx" && (
              <>
                <Button variant="ghost" size="sm" onClick={() => void submitLiveSearch(1)} disabled={tab === "installed" || tab === "favorites"} title="Search TONE3000 with current filters" aria-label="Search TONE3000 online">
                  <Radio size={14} />
                  Online
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setViewMode(viewMode === "cards" ? "list" : "cards")} title="Toggle card/list view" aria-label="Toggle card/list view">
                  {viewMode === "cards" ? <List size={14} /> : <Grid2X2 size={14} />}
                </Button>
              </>
            )}
            {!railMode && sourceFlow !== "fx" && (
              <>
                <Button variant="ghost" size="sm" onClick={() => void refreshCatalogCache()} disabled={catalogBusy} title="Refresh TONE3000 results for offline browsing">
                  <RefreshCw size={14} />
                  Refresh
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => void refresh(true)} disabled={catalogBusy} title="Reload offline library" aria-label="Reload offline library">
                  <HardDrive size={14} />
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="nam-search-row" data-variant={variant} data-source-flow={sourceFlow ?? undefined}>
          <label className="nam-search-box">
            <Search size={13} />
            <Input
              value={query}
              onChange={(event) => { setQuery(event.currentTarget.value); setSelectedKey(""); }}
              onKeyDown={handleSearchKeyDown}
              placeholder={sourceFlowConfig?.searchPlaceholder ?? "Search tones, creators, gear"}
            />
          </label>
          {railMode && (
            <Button className="nam-rail-search-action" variant="ghost" size="icon-sm" onClick={() => void submitLiveSearch(1)} disabled={tab === "installed" || tab === "favorites"} title="Search TONE3000 with current filters" aria-label="Search TONE3000 online">
              <Radio size={14} />
            </Button>
          )}
          {!railMode && !sourceFlowMode && (
            <select className="nam-slot-select" value={slot} onChange={(event) => setSlot(event.currentTarget.value as NAMSlot)}>
              <option value="amp">Amp slot</option>
              <option value="pedal">Pedal slot</option>
            </select>
          )}
          {sourceFlowConfig?.showArchitectureFilter && (
            <label className="nam-source-architecture-control" title="Filter NAM architecture">
              <span>Arch</span>
              <select value={architecture} onChange={(event) => { setArchitecture(event.currentTarget.value); setSelectedKey(""); }}>
                <option value="all">A1 + A2</option>
                <option value="a2">A2</option>
                <option value="a1">A1</option>
                <option value="custom">Custom</option>
              </select>
            </label>
          )}
          {railMode ? (
            <div className="nam-sort-control nam-sort-menu" data-open={sortMenuOpen} ref={sortMenuRef}>
              <span>Sort by</span>
              <button
                type="button"
                className="nam-sort-menu-trigger"
                data-qa="nam-rail-sort-trigger"
                onClick={() => setSortMenuOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={sortMenuOpen}
                title="Sort tones"
              >
                {activeSortLabel}
                <ChevronDown size={13} />
              </button>
              {sortMenuOpen && (
                <div className="nam-sort-menu-popover" role="listbox" aria-label="Sort tones">
                  {NAM_SORT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={sortMode === option.value}
                      data-active={sortMode === option.value}
                      onClick={() => applySortMode(option.value)}
                    >
                      <span>{option.label}</span>
                      {sortMode === option.value && <CheckCircle2 size={12} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : sourceFlow !== "fx" ? (
            <label className="nam-sort-control" title="Sort tones">
              <span>Sort by</span>
              <select value={sortMode} onChange={(event) => applySortMode(event.currentTarget.value as NAMSortMode)}>
                {NAM_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}{option.local ? " (local)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {railMode && (
            <div className="nam-rail-view-toggle" role="group" aria-label="Tone result view">
              <button
                type="button"
                data-active={viewMode === "cards"}
                onClick={() => setViewMode("cards")}
                title="Card view"
                aria-label="Card view"
                aria-pressed={viewMode === "cards"}
              >
                <Grid2X2 size={13} />
              </button>
              <button
                type="button"
                data-active={viewMode === "list"}
                onClick={() => setViewMode("list")}
                title="List view"
                aria-label="List view"
                aria-pressed={viewMode === "list"}
              >
                <List size={13} />
              </button>
            </div>
          )}
          {!sourceFlowMode && (
            <Button variant={filtersOpen ? "default" : "ghost"} size="sm" onClick={() => setFiltersOpen((open) => !open)} title="Show or hide catalog filters">
              {railMode ? <Funnel size={14} /> : <SlidersHorizontal size={14} />}
              {!railMode && "Filters"}
            </Button>
          )}
        </div>

        {sourceFlowConfig && (
          <div className="tone-source-filter-controls" aria-label="Source flow filter controls">
            {sourceFlowConfig.filterControls.map((control) => (
              <button
                key={control.id}
                type="button"
                data-kind={control.localAction ? "local-file" : control.externalSource ? "external-source" : "category"}
                data-category={control.category}
                data-active={control.localAction || control.externalSource ? false : sourceFlowCategoryFilter === control.category}
                data-supported-pedal={sourceFlowConfig.mode === "pedal" && (control.category === "all" || isSupportedTONE3000PedalCategory(control.category))}
                onClick={() => applySourceFlowFilterControl(control)}
              >
                {control.label}
              </button>
            ))}
          </div>
        )}

        {!sourceFlowMode && (
        <div className="nam-filters" data-open={filtersOpen}>
          <select value={architecture} onChange={(event) => { setArchitecture(event.currentTarget.value); setSelectedKey(""); }}>
            <option value="all">A1 + A2</option>
            <option value="a2">A2</option>
            <option value="a1">A1</option>
            <option value="custom">Custom</option>
          </select>
          <select value={gearFilter} onChange={(event) => { setGearFilter(event.currentTarget.value); setSelectedKey(""); }}>
            <option value="amp_amp-cab">All Amp Captures</option>
            <option value="amp">Amp Only (No Cab)</option>
            <option value="amp-cab">Full Rig</option>
            <option value="pedal">Pedal</option>
            <option value="ir">IR</option>
            <option value="">All NAM Gear</option>
          </select>
          <select value={creatorFilter} onChange={(event) => { setCreatorFilter(event.currentTarget.value); setSelectedKey(""); }}>
            <option value="all">All creators</option>
            {filterOptions.creators.map((creator) => (
              <option key={creator} value={creator}>{creator}</option>
            ))}
          </select>
          <select value={licenseFilter} onChange={(event) => { setLicenseFilter(event.currentTarget.value); setSelectedKey(""); }}>
            <option value="all">All licenses</option>
            {filterOptions.licenses.map((license) => (
              <option key={license} value={license}>{license}</option>
            ))}
          </select>
          <select value={instrumentFilter} onChange={(event) => { setInstrumentFilter(event.currentTarget.value); setSelectedKey(""); }}>
            <option value="all">All instruments</option>
            {filterOptions.instruments.map((instrument) => (
              <option key={instrument} value={instrument}>{instrument}</option>
            ))}
          </select>
          <select value={characterFilter} onChange={(event) => { setCharacterFilter(event.currentTarget.value); setSelectedKey(""); }}>
            <option value="all">All characters</option>
            {filterOptions.characters.map((character) => (
              <option key={character} value={character}>{character}</option>
            ))}
          </select>
          <select value={availabilityFilter} onChange={(event) => { setAvailabilityFilter(event.currentTarget.value); setSelectedKey(""); }}>
            <option value="all">All availability</option>
            {filterOptions.availability.map((availability) => (
              <option key={availability} value={availability}>{availability}</option>
            ))}
          </select>
        </div>
        )}

        {status && (
          <NAMFeedbackBanner
            status={status}
            tone={feedbackTone}
            onRetry={canRetryStatus ? retryLiveSearch : undefined}
          />
        )}
        <div className="nam-library-summary">
          <div>
            <strong>{resultCount.toLocaleString()} {resultNoun}{resultCount === 1 ? "" : "s"}</strong>
            <span>{sourceFlow === "fx" ? "Preset view" : tabLabel} - {librarySummarySourceLabel} - {viewMode === "cards" ? "Card view" : "List view"}</span>
          </div>
          <div className="nam-catalog-health" data-stale={catalogStale}>
            <span>{catalogFreshnessLabel}</span>
            <span>{catalogStale ? "Refresh recommended" : catalogMode === "live" ? "Live session" : "Offline ready"}</span>
            {catalogGeneratedAt && <span title={catalogGeneratedAt}>{formatDateLabel(catalogGeneratedAt)}</span>}
          </div>
          <div className="nam-active-filters" aria-label="Active NAM filters">
            {activeFilterChips.length === 0 ? (
              <span className="nam-filter-chip" data-muted="true">Default filters</span>
            ) : (
              activeFilterChips.slice(0, 5).map((chip) => (
                <span className="nam-filter-chip" key={chip}>{chip}</span>
              ))
            )}
            {activeFilterChips.length > 5 && <span className="nam-filter-chip" data-muted="true">+{activeFilterChips.length - 5}</span>}
            {activeFilterChips.length > 0 && (
              <button type="button" onClick={clearExplorerFilters}>Clear</button>
            )}
          </div>
        </div>
        {viewMode === "list" && resultCount > 0 && !showResultsSkeleton && (
          <div className="nam-results-header" aria-hidden="true">
            <span>{resultPrimaryLabel}</span>
            <span>{resultModelLabel}</span>
            <span>Tags</span>
            <span>Stats</span>
            <span>Actions</span>
          </div>
        )}
        <div className="nam-results-wrap" data-refreshing={showResultsRefreshOverlay}>
          <div
            className="nam-results"
            data-view={viewMode}
            ref={resultsScrollRef}
            onScroll={(event) => updateNAMExplorerSessionScroll(sessionViewKey, event.currentTarget.scrollTop)}
          >
            {sourceFlow === "fx" ? (
              renderFXCollectionResults()
            ) : showResultsSkeleton ? (
              <NAMResultsSkeleton viewMode={viewMode} count={viewMode === "list" ? 7 : 8} />
            ) : tab === "installed" ? (
              installedRows.length === 0 ? renderEmptyResults() : installedRows.map(renderInstalledResult)
            ) : tab === "favorites" ? (
              installedRows.length === 0 && displayRows.length === 0 ? renderEmptyResults() : (
                <>
                  {installedRows.map(renderInstalledResult)}
                  {displayRows.map(renderCatalogResult)}
                </>
              )
            ) : displayRows.length === 0 ? (
              renderEmptyResults()
            ) : displayRows.map(renderCatalogResult)}
            {catalogMode === "live" && (
              <div
                ref={appendSentinelRef}
                data-qa="tone3000-append-sentinel"
                aria-hidden="true"
                style={{ gridColumn: "1 / -1", height: 1 }}
              />
            )}
          </div>
          {showResultsRefreshOverlay && (
            <div className="nam-results-refresh" role="status" aria-live="polite">
              <RefreshCw size={14} />
              {detailHydrating ? "Loading model details" : catalogBusy ? "Refreshing catalog" : "Loading online tones"}
            </div>
          )}
        </div>
        {catalogMode === "live" && (
          <div className="nam-live-pager nam-live-pager-footer" data-variant={railMode ? "rail" : "full"}>
            <span className="nam-live-page-label">
              {livePaginationCurrent
                ? `${displayRows.length.toLocaleString()} shown of ${liveTotal.toLocaleString()} result${liveTotal === 1 ? "" : "s"}${railMode ? "" : ` - Sorted by ${activeSortLabel}`}`
                : "Filters changed - search to load results"}
            </span>
            <Button
              size="sm"
              onClick={() => void requestNextLivePage("manual")}
              disabled={liveBusy || !liveCanLoadMore}
              title={liveCanLoadMore ? "Append the next page of online tones" : "All available tones are loaded"}
              aria-label="Load more online tones"
            >
              {liveBusy ? <RefreshCw size={14} /> : <Download size={14} />}
              {liveBusy ? "Loading" : liveCanLoadMore ? "Load more" : "All loaded"}
            </Button>
          </div>
        )}
      </div>

      <aside className="nam-detail">
        <div className="nam-detail-head">
          <SlidersHorizontal size={15} />
          <div>
            <strong>{detailHeaderTitle}</strong>
            <span>{detailHeaderSubtitle}</span>
          </div>
        </div>

        {sourceFlow === "fx" && selectedFXPreset ? (
          <>
            <NAMSourceFlowDesignArt
              className="nam-detail-art"
              mode="fx"
              moduleId={selectedFXPreset.moduleId}
              label={selectedFXPreset.category.toUpperCase()}
              title={selectedFXPreset.moduleId}
            />
            <h4>{selectedFXPreset.name}</h4>
            <p>{selectedFXPreset.description}</p>
            <dl>
              <div><dt>Source</dt><dd>OpenStudio FX Collection</dd></div>
              <div><dt>Target</dt><dd>{selectedFXPreset.moduleId === "mod" ? "Mod" : selectedFXPreset.moduleId === "delay" ? "Delay" : "Reverb"}</dd></div>
              <div><dt>Provider</dt><dd>OpenStudio frontend preset</dd></div>
              <div><dt>Route</dt><dd>DI - Gate - Pedal NAM - Amp NAM - Cab/IR - EQ - Post FX</dd></div>
            </dl>
            <div className="nam-detail-actions tone-action-grid">
              <Button onClick={() => void applyOpenStudioFXPreset(selectedFXPreset)} disabled={rackActionsBusy}>
                <Play size={13} />
                Preview Preset
              </Button>
              <Button variant="ghost" onClick={() => void applyOpenStudioFXPreset(selectedFXPreset, "apply")} disabled={rackActionsBusy}>
                <CheckCircle2 size={13} />
                Apply Preset
              </Button>
              <Button className="nam-save-tone-button" onClick={() => void useSourceFlowSelection()} disabled={rackActionsBusy}>
                <CheckCircle2 size={13} />
                {sourceFlowUseLabel}
              </Button>
              <Button variant="ghost" onClick={() => void revertOpenStudioFXPreset()} disabled={rackActionsBusy || !fxPreview}>
                <RotateCcw size={13} />
                Revert
              </Button>
              <Button variant="ghost" onClick={() => onOpenIRSources?.()}>
                <ExternalLink size={13} />
                Open IR Sources
              </Button>
            </div>
          </>
        ) : detailHydrating ? (
          <NAMDetailSkeleton />
        ) : selectedInstalled ? (
          <>
            {sourceFlow ? (
              <NAMSourceFlowDesignArt
                className="nam-detail-art"
                mode={sourceFlow}
                label={architectureLabel(selectedInstalled.architecture)}
                title={gearLabel(selectedInstalled.gear) || gearLabel(selectedInstalled.gearType) || "Installed"}
              />
            ) : (
              <div
                className="nam-detail-art"
                data-has-art={Boolean(selectedInstalledArtUrl)}
                data-provider-art={Boolean(selectedInstalledProviderArtUrl)}
                data-fallback-profile={selectedInstalledFallbackProfile}
                style={artBackgroundStyle(selectedInstalledArtUrl)}
              >
                <HardDrive size={24} />
                <strong>{architectureLabel(selectedInstalled.architecture)}</strong>
              </div>
            )}
            <h4>{installedTitle(selectedInstalled)}</h4>
            <dl>
              <div><dt>Status</dt><dd>{selectedInstalled.missing ? "Missing local file" : selectedInstalled.updateAvailable ? "Update available" : selectedInstalledSourceOnly ? "Convolution source material" : "Ready"}</dd></div>
              {selectedInstalled.updateAvailable && selectedInstalled.updateReason && (
                <div><dt>Update</dt><dd>{selectedInstalled.updateReason}</dd></div>
              )}
              <div><dt>Installed</dt><dd>{formatDateLabel(selectedInstalled.installedAt) || "Local"}</dd></div>
              {selectedInstalled.updatedAt && (
                <div><dt>Updated</dt><dd>{formatDateLabel(selectedInstalled.updatedAt)}</dd></div>
              )}
              {selectedInstalled.manifestUpdatedAt && (
                <div><dt>Library Check</dt><dd>{formatDateLabel(selectedInstalled.manifestUpdatedAt)}</dd></div>
              )}
              {selectedInstalled.lastSeenAt && (
                <div><dt>Catalog Seen</dt><dd>{formatDateLabel(selectedInstalled.lastSeenAt)}</dd></div>
              )}
              {selectedInstalled.missing && selectedInstalled.missingSince && (
                <div><dt>Missing Since</dt><dd>{formatDateLabel(selectedInstalled.missingSince)}</dd></div>
              )}
              {!selectedInstalled.missing && formatFileSize(Number(selectedInstalled.fileSizeBytes)) && (
                <div><dt>File Size</dt><dd>{formatFileSize(Number(selectedInstalled.fileSizeBytes))}</dd></div>
              )}
              {selectedInstalled.checksum && (
                <div><dt>Checksum</dt><dd title={selectedInstalled.checksum}>{selectedInstalled.checksum.slice(0, 12)}...</dd></div>
              )}
              <div>
                <dt>Creator</dt>
                <dd>
                  {selectedInstalledCreatorUrl ? (
                    <a href={selectedInstalledCreatorUrl} target="_blank" rel="noreferrer">{selectedInstalled.creator || "Creator profile"}</a>
                  ) : selectedInstalled.creator || "Unknown"}
                </dd>
              </div>
              <div><dt>License</dt><dd>{selectedInstalled.license || "Unknown"}</dd></div>
              <div><dt>Provider</dt><dd>{selectedInstalled.sourceProvider || selectedInstalled.source || "Local"}</dd></div>
              {installedInstrumentLabels(selectedInstalled).length > 0 && (
                <div><dt>Instrument</dt><dd>{joinMetadataLabels(installedInstrumentLabels(selectedInstalled))}</dd></div>
              )}
              {installedCharacterLabels(selectedInstalled).length > 0 && (
                <div><dt>Character</dt><dd>{joinMetadataLabels(installedCharacterLabels(selectedInstalled))}</dd></div>
              )}
              {installedAvailabilityLabel(selectedInstalled) && (
                <div><dt>Availability</dt><dd>{installedAvailabilityLabel(selectedInstalled)}</dd></div>
              )}
              {selectedInstalledCaptureDetails.map((detail) => (
                <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
              ))}
              <div><dt>Slot</dt><dd>{selectedInstalledSourceOnly ? "Source material" : selectedInstalledTargetLabel}</dd></div>
              <div><dt>Path</dt><dd title={selectedInstalled.localPath}>{shortPath(selectedInstalled.localPath)}</dd></div>
            </dl>
            <div className="nam-detail-actions">
              {selectedInstalledSourceOnly ? (
                <Button
                  variant="ghost"
                  onClick={() => selectedInstalled.sourceUrl ? void nativeBridge.openExternalURL(selectedInstalled.sourceUrl) : undefined}
                  disabled={!selectedInstalled.sourceUrl}
                  title="Open convolution/source material page"
                >
                  <ExternalLink size={13} />
                  Open Source
                </Button>
              ) : selectedInstalled.missing ? (
                <Button onClick={() => void reinstallInstalled(selectedInstalled)} disabled={rackActionsBusy || busyLibraryKey === installedKey(selectedInstalled) || !makeReinstallPayload(selectedInstalled)}>
                  <Download size={13} />
                  {makeReinstallPayload(selectedInstalled) ? "Reinstall" : "Missing"}
                </Button>
              ) : (
                <>
                  {selectedInstalled.updateAvailable && (
                    <Button onClick={() => void updateInstalled(selectedInstalled)} disabled={rackActionsBusy || busyLibraryKey === installedKey(selectedInstalled) || !makeUpdatePayload(selectedInstalled)}>
                      <RefreshCw size={13} />
                      Update
                    </Button>
                  )}
                  {selectedInstalledCanCommit && (
                    <Button onClick={openSaveToneModal} disabled={rackActionsBusy}>
                      <Save size={13} />
                      Save Preset
                    </Button>
                  )}
                  {sourceFlowConfig && selectedInstalledCanCommit && (
                    <Button onClick={() => void useSourceFlowSelection()} disabled={rackActionsBusy}>
                      <CheckCircle2 size={13} />
                      {sourceFlowUseLabel}
                    </Button>
                  )}
                  {selectedInstalledTargetSlot === "cab" ? (
                    <Button variant={selectedInstalled.updateAvailable ? "ghost" : "default"} onClick={() => void toggleInstalledAudition(selectedInstalled)} disabled={rackActionsBusy || busyModelId === selectedInstalled.modelId}>
                      {installedAuditionIsActive(selectedInstalled) ? <RotateCcw size={13} /> : <FolderOpen size={13} />}
                      {installedAuditionIsActive(selectedInstalled) ? "Stop" : `Audition ${selectedInstalledTargetLabel}`}
                    </Button>
                  ) : (
                    <Button variant={selectedInstalled.updateAvailable ? "ghost" : "default"} onClick={() => void toggleInstalledAudition(selectedInstalled)} disabled={rackActionsBusy || busyModelId === selectedInstalled.modelId}>
                      {installedAuditionIsActive(selectedInstalled) ? <RotateCcw size={13} /> : <Play size={13} />}
                      {installedAuditionIsActive(selectedInstalled) ? "Stop" : "Audition"}
                    </Button>
                  )}
                </>
              )}
              <Button variant="ghost" aria-pressed={Boolean(selectedInstalled.favorite)} onClick={() => void toggleInstalledFavorite(selectedInstalled)} disabled={rackActionsBusy || busyLibraryKey === installedKey(selectedInstalled)}>
                <Star size={13} />
                {selectedInstalled.favorite ? "Unfavorite" : "Favorite"}
              </Button>
              <Button variant="ghost" onClick={() => setRemoveCandidate(selectedInstalled)} disabled={rackActionsBusy || busyLibraryKey === installedKey(selectedInstalled)}>
                <Trash2 size={13} />
                Remove from Library
              </Button>
            </div>
            {selectedInstalled.sourceUrl && (
              <a className="nam-source-link" href={selectedInstalled.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={13} />
                Source
              </a>
            )}
            {selectedInstalledCreatorUrl && (
              <a className="nam-source-link" href={selectedInstalledCreatorUrl} target="_blank" rel="noreferrer">
                <Info size={13} />
                Creator
              </a>
            )}
          </>
        ) : selectedCatalogRow ? (
          <>
            {sourceFlow ? (
              <NAMSourceFlowDesignArt
                className="nam-detail-art"
                mode={sourceFlow}
                label={modelArchitecture(selectedCatalogRow.tone, selectedCatalogRow.model)}
                title={gearLabel(selectedCatalogRow.tone.gear) || gearLabel(selectedCatalogRow.model.gear) || "Amp"}
              />
            ) : (
              <div
                className="nam-detail-art"
                data-arch={modelArchitecture(selectedCatalogRow.tone, selectedCatalogRow.model).toLowerCase()}
                data-has-art={Boolean(selectedCatalogArtUrl)}
                data-provider-art={Boolean(selectedCatalogProviderArtUrl)}
                data-fallback-profile={selectedCatalogFallbackProfile}
                style={artBackgroundStyle(selectedCatalogArtUrl)}
              >
                <span>{modelArchitecture(selectedCatalogRow.tone, selectedCatalogRow.model)}</span>
                <strong>{gearLabel(selectedCatalogRow.tone.gear) || "Amp"}</strong>
              </div>
            )}
            <h4>{toneTitle(selectedCatalogRow.tone, selectedCatalogRow.model)}</h4>
            <p>{selectedCatalogRow.tone.description || (selectedCatalogRow.tone.source === "tone3000-live" ? "Online TONE3000 result. Open the source page for full creator notes when available." : "Offline TONE3000 metadata. Open the source page for full creator notes when available.")}</p>
            <dl>
              <div>
                <dt>Creator</dt>
                <dd>
                  {selectedCatalogCreatorUrl ? (
                    <a href={selectedCatalogCreatorUrl} target="_blank" rel="noreferrer">{creatorLabel(selectedCatalogRow.tone)}</a>
                  ) : creatorLabel(selectedCatalogRow.tone)}
                </dd>
              </div>
              <div><dt>Model</dt><dd>{modelTitle(selectedCatalogRow.model)}</dd></div>
              <div><dt>License</dt><dd>{licenseLabel(selectedCatalogRow.tone.license) || "Unknown"}</dd></div>
              {rowInstrumentLabels(selectedCatalogRow.tone, selectedCatalogRow.model).length > 0 && (
                <div><dt>Instrument</dt><dd>{joinMetadataLabels(rowInstrumentLabels(selectedCatalogRow.tone, selectedCatalogRow.model))}</dd></div>
              )}
              {rowCharacterLabels(selectedCatalogRow.tone, selectedCatalogRow.model).length > 0 && (
                <div><dt>Character</dt><dd>{joinMetadataLabels(rowCharacterLabels(selectedCatalogRow.tone, selectedCatalogRow.model))}</dd></div>
              )}
              {rowAvailabilityLabel(selectedCatalogRow.tone, selectedCatalogRow.model) && (
                <div><dt>Availability</dt><dd>{rowAvailabilityLabel(selectedCatalogRow.tone, selectedCatalogRow.model)}</dd></div>
              )}
              {selectedCatalogCaptureDetails.map((detail) => (
                <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
              ))}
              <div><dt>Source</dt><dd>{selectedCatalogRow.tone.source === "tone3000-live" ? "Online" : "Offline"}</dd></div>
              <div><dt>Downloads</dt><dd>{Number(selectedCatalogRow.tone.downloads_count || 0).toLocaleString()}</dd></div>
              <div><dt>Favorites</dt><dd>{Number(selectedCatalogRow.tone.favorites_count || 0).toLocaleString()}</dd></div>
            </dl>
            <div className="nam-detail-actions">
              {sourceFlowConfig && selectedCatalogCanCommit && (
                <Button onClick={() => void useSourceFlowSelection()} disabled={rackActionsBusy}>
                  <CheckCircle2 size={13} />
                  {sourceFlowUseLabel}
                </Button>
              )}
              {renderCatalogAction(selectedCatalogRow)}
              <Button
                variant="ghost"
                aria-pressed={favorites.has(`${toneIdOf(selectedCatalogRow.tone)}:${modelIdOf(selectedCatalogRow.model)}`)}
                onClick={() => toggleFavorite(selectedCatalogRow.tone, selectedCatalogRow.model)}
              >
                <Star size={13} />
                Favorite
              </Button>
            </div>
            {sourceUrlOf(selectedCatalogRow.tone, selectedCatalogRow.model) && (
              <a className="nam-source-link" href={sourceUrlOf(selectedCatalogRow.tone, selectedCatalogRow.model)} target="_blank" rel="noreferrer">
                <ExternalLink size={13} />
                Source
              </a>
            )}
            {selectedCatalogCreatorUrl && (
              <a className="nam-source-link" href={selectedCatalogCreatorUrl} target="_blank" rel="noreferrer">
                <Info size={13} />
                Creator
              </a>
            )}
          </>
        ) : (
          <div className="nam-empty">Select a model</div>
        )}
      </aside>

      <Modal
        isOpen={Boolean(removeCandidate)}
        onClose={() => setRemoveCandidate(null)}
        size="sm"
        title="Remove from library?"
        className="nam-rack-prompt-modal"
        footer={removeCandidate ? (
          <>
            <button type="button" className="nam-rack-prompt-cancel" onClick={() => setRemoveCandidate(null)}>Cancel</button>
            <button type="button" className="nam-rack-prompt-confirm" data-destructive="true" onClick={() => void removeInstalled(removeCandidate)} disabled={rackActionsBusy || busyLibraryKey === installedKey(removeCandidate)}>Remove</button>
          </>
        ) : undefined}
      >
        {removeCandidate && (
          <div className="nam-rack-prompt-body">
            <p>“{removeCandidate.name || "NAM model"}” will be removed from the OpenStudio library. Its .nam file will remain on disk so existing racks and projects keep working.</p>
          </div>
        )}
      </Modal>

      <NAMToneSaveModal
        isOpen={saveToneOpen}
        draft={saveToneDraft}
        busy={rackActionsBusy}
        onDraftChange={setSaveToneDraft}
        onClose={() => setSaveToneOpen(false)}
        onSave={() => void saveAuditionTone()}
      />
    </section>
  );
}

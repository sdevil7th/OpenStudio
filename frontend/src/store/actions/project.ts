// @ts-nocheck
import { normalizeTrimDB } from "../../utils/automationTrim";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

/**
 * Project management — save, load, new, settings, templates, auto-backup.
 * Extracted from useDAWStore.ts.
 */
import { nativeBridge, type MissingMediaEntry } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { usePitchEditorStore } from "../pitchEditorStore";
import { advanceProjectEpoch, getProjectEpoch, getRecoveryDocumentId, getProjectEditRevision, markProjectEdited, serializeProjectSave } from "../../utils/projectLifetime";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { resetSyncCache } from "./clips";
import { createFreshProjectDocumentState } from "../useDAWStore";
import { syncAutomationLaneToBackend, syncTempoMarkersToBackend } from "./storeHelpers";
import { parseSendAutomationParamId } from "../automationParams";
import {
  DEFAULT_AI_MUSIC_MODEL_ID,
  getDefaultWorkflowForModel,
  getDefaultWorkflowParams,
  normalizeWorkflowId,
  normalizeWorkflowParams,
  resolveAiMusicModelId,
} from "../../data/aiWorkflows";
import { normalizeMIDIClipLoopLength, serializeMIDIClipsForBackend, syncTrackMIDIClipsToBackend } from "../../utils/midiClipSerialization";
import { FACTORY_QUANTIZE_PRESETS, GRID_SIZE_GROUPS, SNAP_TYPE_OPTIONS } from "../../utils/snapToGrid";
import {
  findNAMAssetByIdentity,
  withStableNAMAssetIdentity,
} from "../../utils/namAssetIdentity";
import {
  collectNAMProjectAssetReferences,
  summarizeNAMProjectStateIssues,
  type NAMProjectStateIssue,
} from "../../utils/namProjectState";
import { isRetiredNAMRackAutomationParamId } from "../../utils/namPortableState";
import { migrateLegacyChorusRateAutomationValue } from "../../utils/builtInParamValue";
import { parseValidatedProject } from "../../utils/projectValidation";
import { restoreMetronomeProjectSounds } from "../../utils/metronomeProjectSounds";
import { compatibleAutomationMetadata, normalizeSavedSafeParameters, savedAutomationAddress, prepareUnavailableFXForLoad, recoveredAutomationLabel, resolveSavedPluginParameter, resolveSavedSafeParameter, unavailableFXKey } from "../../utils/automationRecovery";
import { automationParameterMetadata } from "../automationParams";
import { normalizeSavedMIDILearnMappings, resolveSavedMIDILearnParameter, savedMIDILearnMapping } from "../../utils/midiLearnRecovery";
import { registerPluginParameterManifest, validatePluginAutomationLane } from "../../utils/pluginParameterManifest";
import { notifyFXChainChanged, notifyInstrumentChanged } from "../../utils/fxChain";

const AUTOMATION_CURVE_VERSION = 2;
const SAVED_GRID_VALUES = new Set([
  ...GRID_SIZE_GROUPS.flatMap(group => [...group.options]),
  "half_bar", "quarter_bar", "eighth_bar", "half_beat", "quarter_beat",
]);

const BUILT_IN_PLUGIN_NAMES = new Set([
  "OpenStudio Piano",
  "OpenStudio Drums",
  "OpenStudio Basic Synth",
  "OpenStudio Clean Guitar",
  "OpenStudio EQ",
  "OpenStudio Compressor",
  "OpenStudio Gate",
  "OpenStudio Limiter",
  "OpenStudio Delay",
  "OpenStudio Reverb",
  "OpenStudio Chorus",
  "OpenStudio Saturator",
  "OpenStudio Preamp",
  "OpenStudio Graphic EQ",
  "OpenStudio Gain Phase",
  "OpenStudio NAM Rack",
  "OpenStudio Pitch Correct",
]);

function isBuiltInPluginPath(pluginPath: string | undefined): boolean {
  return Boolean(pluginPath && BUILT_IN_PLUGIN_NAMES.has(pluginPath));
}

function isBuiltInInstrumentPluginPath(pluginPath: string | undefined): boolean {
  return pluginPath === "OpenStudio Piano" ||
    pluginPath === "OpenStudio Drums" ||
    pluginPath === "OpenStudio Basic Synth" ||
    pluginPath === "OpenStudio Clean Guitar";
}

function isNAMRackPluginPath(pluginPath: string | undefined): boolean {
  return pluginPath === "OpenStudio NAM Rack";
}

function pathKey(path: unknown): string {
  return String(path || "").replace(/\\/g, "/").toLowerCase();
}

function buildNAMInstalledPathIndex(installed: any[] = []) {
  const byPath = new Map<string, any>();
  for (const record of installed) {
    const key = pathKey(record?.localPath);
    if (key) byPath.set(key, record);
  }
  return byPath;
}

function enrichNAMAssetTarget(target: any, metadata: any = {}) {
  return withStableNAMAssetIdentity({
    ...target,
    modelId: Number(metadata.modelId ?? metadata.id ?? metadata.model_id ?? target.modelId ?? 0) || undefined,
    toneId: Number(metadata.toneId ?? metadata.tone_id ?? target.toneId ?? 0) || undefined,
    modelUrl: String(metadata.modelUrl ?? metadata.model_url ?? target.modelUrl ?? ""),
    sourceUrl: String(metadata.sourceUrl ?? metadata.source_url ?? target.sourceUrl ?? ""),
    license: String(metadata.license ?? metadata.license_name ?? target.license ?? ""),
    creator: String(metadata.creator ?? metadata.creator_name ?? target.creator ?? ""),
    gearType: String(metadata.gearType ?? metadata.gear_type ?? target.gearType ?? ""),
    toneTitle: String(metadata.toneTitle ?? metadata.tone_title ?? metadata.name ?? target.toneTitle ?? ""),
    architecture: metadata.architecture ?? metadata.architecture_version ?? target.architecture,
    checksum: metadata.fileSha256 ?? metadata.checksum ?? metadata.sha256 ?? target.checksum,
    assetId: metadata.assetId ?? target.assetId,
    fileSizeBytes: Number(metadata.fileSizeBytes ?? target.fileSizeBytes ?? 0) || undefined,
    originalFileName: String(metadata.originalFileName ?? target.originalFileName ?? ""),
    lastSeenMetadata: metadata.lastSeenMetadata ?? target.lastSeenMetadata,
  });
}

function savedNAMAssetKey(asset: any) {
  return `${asset?.trackId || ""}:${asset?.chain || ""}:${Number(asset?.fxIndex ?? -1)}:${asset?.slot || ""}:${asset?.compareSlot || ""}:${pathKey(asset?.path)}`;
}

function collectNAMAssetsFromPluginState(
  state: any,
  baseTarget: any,
  installedByPath: Map<string, any>,
) {
  return collectNAMProjectAssetReferences(state, baseTarget).map((asset) =>
    enrichNAMAssetTarget(asset, installedByPath.get(pathKey(asset.path))),
  );
}

function indexSavedNAMAssets(savedAssets: any[] = []) {
  const byKey = new Map<string, any>();
  const byPath = new Map<string, any>();
  for (const asset of savedAssets) {
    if (!asset?.path) continue;
    byKey.set(savedNAMAssetKey(asset), asset);
    byPath.set(pathKey(asset.path), asset);
  }
  return { byKey, byPath };
}

function addMissingNAMTarget(entries: any[], target: any) {
  const key = pathKey(target.path);
  if (!key) return;
  let entry = entries.find((candidate) => candidate.kind === "nam" && pathKey(candidate.path) === key);
  if (!entry) {
    entry = { path: target.path, kind: "nam", clipIds: [], namTargets: [] };
    entries.push(entry);
  }
  const targetKey = `${target.trackId}:${target.chain}:${target.fxIndex}:${target.slot}:${target.compareSlot || ""}`;
  if (!entry.namTargets.some((candidate: any) => `${candidate.trackId}:${candidate.chain}:${candidate.fxIndex}:${candidate.slot}:${candidate.compareSlot || ""}` === targetKey)) {
    entry.namTargets.push(target);
  }
}

async function collectRestoredMissingNAMAssets(data: any) {
  const savedAssetIndex = indexSavedNAMAssets(Array.isArray(data.namAssets) ? data.namAssets : []);
  const libraryPayload = await nativeBridge.getNAMLibrary().catch(() => ({ installed: [] }));
  const installedRecords = libraryPayload.installed || [];
  const installedByPath = buildNAMInstalledPathIndex(installedRecords);
  const targets = new Map<string, any>();

  const addTarget = (target: any) => {
    const saved = savedAssetIndex.byKey.get(savedNAMAssetKey(target)) || savedAssetIndex.byPath.get(pathKey(target.path));
    const installed = installedByPath.get(pathKey(target.path))
      || findNAMAssetByIdentity(installedRecords, saved || target);
    targets.set(savedNAMAssetKey(target), enrichNAMAssetTarget(target, installed || saved || {}));
  };

  for (const trackData of data.tracks || []) {
    for (const chainInfo of [
      { chain: "input", paths: trackData.inputFXPaths || [] },
      { chain: "track", paths: trackData.trackFXPaths || [] },
    ]) {
      for (let fxIndex = 0; fxIndex < chainInfo.paths.length; fxIndex++) {
        const pluginPath = chainInfo.paths[fxIndex];
        if (!isNAMRackPluginPath(pluginPath)) continue;
        const state = await nativeBridge.getBuiltInPluginState({
          trackId: trackData.id,
          chain: chainInfo.chain,
          fxIndex,
        }).catch(() => null);
        const assets = collectNAMAssetsFromPluginState(state, {
          trackId: trackData.id,
          trackName: trackData.name,
          chain: chainInfo.chain,
          fxIndex,
          pluginName: pluginPath,
        }, installedByPath);
        for (const asset of assets) addTarget(asset);
      }
    }
  }

  for (let fxIndex = 0; fxIndex < (data.masterFXPaths || []).length; fxIndex++) {
    const pluginPath = data.masterFXPaths[fxIndex];
    if (!isNAMRackPluginPath(pluginPath)) continue;
    const state = await nativeBridge.getBuiltInPluginState({
      trackId: "",
      chain: "master",
      fxIndex,
    }).catch(() => null);
    const assets = collectNAMAssetsFromPluginState(state, {
      trackId: "",
      trackName: "Master",
      chain: "master",
      fxIndex,
      pluginName: pluginPath,
    }, installedByPath);
    for (const asset of assets) addTarget(asset);
  }

  for (const saved of savedAssetIndex.byKey.values()) {
    addTarget(saved);
  }

  const missing: any[] = [];
  for (const target of targets.values()) {
    if (!target.path) continue;
    const exists = await nativeBridge.fileExists(target.path).catch(() => true);
    if (!exists) {
      const installedCandidate = findNAMAssetByIdentity(installedRecords, target);
      const candidatePath = String(installedCandidate?.localPath || "");
      const candidateExists = candidatePath && pathKey(candidatePath) !== pathKey(target.path)
        ? await nativeBridge.fileExists(candidatePath).catch(() => false)
        : false;
      addMissingNAMTarget(missing, candidateExists
        ? { ...target, relinkCandidatePath: candidatePath }
        : target);
    }
  }
  return missing;
}

const TRANSIENT_STATE_KEYS: ReadonlySet<string> = new Set([
  "meterLevels", "midiInputLevels", "peakLevels", "masterLevel", "automatedParamValues",
  "recordingClips", "recordingMIDIPreviews", "playStartPosition",
  "selectedTrackId", "selectedTrackIds", "lastSelectedTrackId",
  "selectedClipId", "selectedClipIds", "clipboard", "midiNoteClipboard",
  "selectedAutomationTarget",
  "selectedNoteIds", "pianoRollEditCursorTime", "selectedRegionIds", "razorEdits", "timeSelection",
  "showMixer", "showSettings", "showRenderModal", "showPluginBrowser", "pluginBrowserTrackId",
  "showVirtualKeyboard", "showUndoHistory", "showCommandPalette", "showRegionMarkerManager",
  "showClipProperties", "showBigClock", "showKeyboardShortcuts", "showContextualHelp",
  "showGettingStarted", "showPreferences", "showScriptConsole", "showPianoRoll",
  "showProjectSettings", "showDynamicSplit", "showRenderQueue", "showRoutingMatrix",
  "showMediaExplorer", "showCleanProject", "showBatchConverter", "showCrossfadeEditor",
  "showThemeEditor", "showVideoWindow", "showScriptEditor", "showToolbarEditor",
  "showDDPExport", "showStepSequencer", "showClipLauncher", "showTimecodeSettings",
  "showDrumEditor", "showMediaPool", "showLoudnessMeter",
  "showPhaseCorrelation", "showProjectTemplates",
  "showRegionRenderMatrix", "showMasterTrackInTCP", "showCrosshair", "showProjectCompare",
  "projectCompareData",
  "pianoRollTrackId", "pianoRollClipId", "dynamicSplitClipId", "crossfadeEditorClipIds",
  "stepInputEnabled", "stepInputSize", "stepInputPosition",
  "audioDeviceSetup", "canUndo", "canRedo",
  "isProjectLoading", "projectLoadingMessage",
  "metronomePracticeEnabled", "metronomePracticePending", "metronomePracticeError",
  "toastMessage", "toastType", "toastVisible",
  "tapTimestamps", "recentActions", "scriptConsoleOutput", "pluginABStates",
]);

function projectJsonReplacer(key: string, value: unknown): unknown {
  if (key && TRANSIENT_STATE_KEYS.has(key)) return undefined;
  if (key === "meterLevel" || key === "peakLevel" || key === "clipping") return undefined;
  return value;
}

function sanitizeRecentProjects(projects: unknown[]): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const project of projects) {
    if (typeof project !== "string") continue;
    const path = project.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    sanitized.push(path);
    if (sanitized.length >= 10) break;
  }
  return sanitized;
}

function readBrowserRecentProjects(): string[] {
  try {
    const stored = localStorage.getItem("recentProjects");
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? sanitizeRecentProjects(parsed) : [];
  } catch {
    return [];
  }
}

function persistRecentProjects(projects: string[]) {
  const sanitized = sanitizeRecentProjects(projects);
  try {
    localStorage.setItem("recentProjects", JSON.stringify(sanitized));
  } catch {
    // Native persistence below keeps the list available across WebView origins.
  }
  nativeBridge.setRecentProjects(sanitized).catch(logBridgeError("recent projects"));
}

function normalizeAutomationWriteBehavior(value: unknown) {
  return ["latch", "overwrite", "touch-latch", "cross-over"].includes(String(value)) ? value : "touch";
}

function automationLaneReadFromLegacy(lane: any): boolean {
  if (typeof lane?.readEnabled === "boolean") return lane.readEnabled;
  if (Array.isArray(lane?.points) && lane.points.length > 0) return true;
  return lane?.mode !== "off";
}

function isLegacyPlaceholderAutomationLane(lane: any): boolean {
  return (
    (lane?.id === "vol" && lane?.param === "volume") ||
    (lane?.id === "pan" && lane?.param === "pan") ||
    (lane?.id === "master-vol" && lane?.param === "volume") ||
    (lane?.id === "master-pan" && lane?.param === "pan")
  );
}

function isRetiredNAMRackAutomationLane(lane: any): boolean {
  return isRetiredNAMRackAutomationParamId(lane?.param);
}

function hasMeaningfulAutomationLane(lane: any, ownerData: any = {}): boolean {
  if (isRetiredNAMRackAutomationLane(lane)) return false;
  const hasPoints = Array.isArray(lane?.points) && lane.points.length > 0;
  if (hasPoints) return true;
  if (Boolean(ownerData?.showAutomation) && Boolean(lane?.visible)) return true;
  return !isLegacyPlaceholderAutomationLane(lane);
}

function isNAMRackChorusRateAutomationLane(lane: any) {
  return /^builtin_(?:input|track)_\d+_chorusRateHz$/.test(String(lane?.param || ""));
}

function persistedAutomationPointId(lane: any, point: any, index: number) {
  if (typeof point?.id === "string" && point.id.length > 0) return point.id;
  const laneKey = String(lane?.id || lane?.param || "automation").replace(/[^a-zA-Z0-9_-]/g, "-");
  const time = Math.max(0, Number(point?.time) || 0);
  const value = Math.max(0, Math.min(1, Number(point?.value) || 0));
  return `project-automation-point-${laneKey}-${index}-${Math.round(time * 1_000_000)}-${Math.round(value * 1_000_000)}`;
}

function normalizeAutomationLane(lane: any, automationCurveVersion = 1) {
  const readEnabled = automationLaneReadFromLegacy(lane);
  const migrateChorusRate =
    automationCurveVersion < AUTOMATION_CURVE_VERSION
    && isNAMRackChorusRateAutomationLane(lane);
  const points = Array.isArray(lane?.points)
    ? lane.points
        .map((point: any, index: number) => ({
          id: persistedAutomationPointId(lane, point, index),
          time: Math.max(0, Number(point?.time) || 0),
          value: migrateChorusRate
            ? migrateLegacyChorusRateAutomationValue(Number(point?.value) || 0)
            : Math.max(0, Math.min(1, Number(point?.value) || 0)),
        }))
        .sort((a: any, b: any) => a.time - b.time)
    : [];
  return {
    ...lane,
    id: lane?.id || `lane_${lane?.param || "automation"}_${Date.now()}`,
    param: lane?.param || "volume",
    points,
    visible: Boolean(lane?.visible),
    mode: readEnabled ? "read" : "off",
    armed: false,
    readEnabled,
  };
}

function normalizeAutomationLanes(
  lanes: any[],
  ownerData: any = {},
  automationCurveVersion = 1,
) {
  return (Array.isArray(lanes) ? lanes : [])
    .filter((lane) => hasMeaningfulAutomationLane(lane, ownerData))
    .map((lane) => normalizeAutomationLane(lane, automationCurveVersion));
}

function resolveLoadedAutomationLaneModes(lanes: any[], readEnabled: boolean) {
  return lanes.map((lane) => ({
    ...lane,
    mode: readEnabled && lane.readEnabled ? "read" : "off",
    armed: false,
  }));
}

function deriveAutomationReadEnabled(data: any, lanes: any[]): boolean {
  if (lanes.length === 0) return false;
  if (typeof data?.automationReadEnabled === "boolean") return data.automationReadEnabled;
  if (typeof data?.automationEnabled === "boolean") return data.automationEnabled;
  if (lanes.some((lane) => lane.readEnabled || (lane.points || []).length > 0)) return true;
  return false;
}

function serializeAutomationLanesForProject(lanes: any[]) {
  return (Array.isArray(lanes) ? lanes : []).map((lane) => {
    const readEnabled = automationLaneReadFromLegacy(lane);
    const { referenceGeneration: _runtimeGeneration, ...persistentMetadata } = lane.metadata ?? {};
    return {
      ...lane,
      ...(lane.metadata ? { metadata: persistentMetadata } : {}),
      points: (Array.isArray(lane?.points) ? lane.points : []).map((point: any, index: number) => ({
        ...point,
        id: persistedAutomationPointId(lane, point, index),
      })),
      readEnabled,
      mode: readEnabled ? "read" : "off",
      armed: false,
    };
  });
}

function buildProjectResetState() {
  const freshProjectState = createFreshProjectDocumentState();
  return {
    lastTouchedAutomationParameter: null,
    masterAutomationSafeParams: [],
    masterAutomationSafeParameters: [],
    unavailableFXStages: {},
    automationTouchReturnSeconds: 0,
    automationTrimCoalesce: "manual",
    automationAutoJoinEnabled:false,
    automationJoinSession:null,
    automationRecoveryBusy: false,
    projectRestoreError: "",
    ...freshProjectState,
    showPluginBrowser: false,
    pluginBrowserTrackId: null,
    showEnvelopeManager: false,
    envelopeManagerTrackId: null,
    showChannelStripEQ: false,
    channelStripEQTrackId: null,
    showTrackRouting: false,
    trackRoutingTrackId: null,
    showPianoRoll: false,
    pianoRollTrackId: null,
    pianoRollClipId: null,
    showPitchEditor: false,
    pitchEditorTrackId: null,
    pitchEditorClipId: null,
    pitchEditorFxIndex: 0,
    showClipProperties: false,
    showDynamicSplit: false,
    dynamicSplitClipId: null,
    showCrossfadeEditor: false,
    crossfadeEditorClipIds: null,
    showClipLauncher: false,
    showStemSeparation: false,
    stemSepTrackId: null,
    stemSepClipId: null,
    stemSepClipName: "",
    stemSepClipDuration: 0,
    showAIClipGeneration: false,
    aiClipGenerationTrackId: null,
    aiClipGenerationClipId: null,
    aiClipGenerationWorkflowId: null,
    aiClipGenerationModelId: DEFAULT_AI_MUSIC_MODEL_ID,
    aiClipGenerationParams: {},
    aiClipGenerationRange: null,
    aiClipGenerationError: "",
    showProjectCompare: false,
    projectCompareData: null,
    showRegionRenderMatrix: false,
    showUnsavedChangesDialog: false,
    pendingProjectAction: null,
    pendingProjectActionLabel: "",
  };
}

function buildSerializedProjectData(
  state: any,
  serializedTracks: any[],
  masterFXPaths: string[],
  masterFXStates: string[],
  namAssets: any[] = [],
  midiLearnMappings: any[] = [],
) {
  return {
    version: "1.2.0",
    automationCurveVersion: AUTOMATION_CURVE_VERSION,
    savedAt: Date.now(),
    projectName: state.projectName,
    projectPersistentId: state.projectPersistentId,
    projectNotes: state.projectNotes,
    projectSampleRate: state.projectSampleRate,
    projectBitDepth: state.projectBitDepth,
    processingPrecision: state.processingPrecision,
    tempo: state.transport.tempo,
    timeSignature: state.timeSignature,
    metronomeEnabled: state.metronomeEnabled,
    metronomeVolume: state.metronomeVolume,
    metronomeAccentBeats: state.metronomeAccentBeats,
    metronomeClickPath: state.metronomeClickPath,
    metronomeAccentPath: state.metronomeAccentPath,
    metronomeTrackId: state.metronomeTrackId,
    projectRange: state.projectRange,
    snapEnabled: state.snapEnabled,
    snapType: state.snapType,
    gridSize: state.gridSize,
    quantizePresetId: state.quantizePresetId,
    quantizePresets: state.quantizePresets,
    markers: state.markers,
    regions: state.regions,
    tempoMarkers: state.tempoMarkers,
    masterVolume: state.masterVolume,
    masterPan: state.masterPan,
    masterTrimVolumeDB: normalizeTrimDB(state.masterTrimVolumeDB),
    isMasterMuted: state.isMasterMuted,
    masterMono: state.masterMono,
    masterAutomationLanes: serializeAutomationLanesForProject(state.masterAutomationLanes),
    showMasterAutomation: state.showMasterAutomation,
    masterAutomationReadEnabled: deriveAutomationReadEnabled(
      {
        automationReadEnabled: state.masterAutomationReadEnabled,
        automationEnabled: state.masterAutomationEnabled,
      },
      state.masterAutomationLanes || [],
    ),
    masterAutomationWriteEnabled: false,
    masterAutomationTrimWriteEnabled: false,
    masterAutomationEnabled: deriveAutomationReadEnabled(
      {
        automationReadEnabled: state.masterAutomationReadEnabled,
        automationEnabled: state.masterAutomationEnabled,
      },
      state.masterAutomationLanes || [],
    ),
    automationWriteBehavior: normalizeAutomationWriteBehavior(state.automationWriteBehavior),
    automationTouchReturnSeconds: Math.max(0, Math.min(5, state.automationTouchReturnSeconds ?? 0)),
    automationTrimCoalesce: state.automationTrimCoalesce ?? "manual",
    automationAutoJoinEnabled: state.automationAutoJoinEnabled ?? false,
    masterAutomationSafeParams: state.masterAutomationSafeParams ?? [],
    masterAutomationSafeParameters: state.masterAutomationSafeParameters ?? [],
    unavailableFXStages: state.unavailableFXStages ?? {},
    suspendedMasterAutomationState: null,
    tracks: serializedTracks,
    masterFXPaths,
    masterFXStates,
    namAssets,
    midiLearnMappings,
    mixerSnapshots: state.mixerSnapshots,
    trackGroups: state.trackGroups,
    clipLauncher: state.clipLauncher,
    renderMetadata: state.renderMetadata,
    renderDialogOptions: state.renderDialogOptions,
    secondaryOutputEnabled: state.secondaryOutputEnabled,
    secondaryOutputFormat: state.secondaryOutputFormat,
    secondaryOutputBitDepth: state.secondaryOutputBitDepth,
    onlineRender: state.onlineRender,
    addToProjectAfterRender: state.addToProjectAfterRender,
    projectAuthor: state.projectAuthor,
    projectRevisionNotes: state.projectRevisionNotes,
    undoHistory: commandManager.serialize(),
  };
}

function documentFingerprint(state: any) {
  const document = buildSerializedProjectData(state, state.tracks, [], []);
  return JSON.stringify({ ...document, savedAt: 0, undoHistory: undefined }, projectJsonReplacer);
}

async function teardownCurrentProject(get: GetFn, set: SetFn) {
  if (!await get().cancelAutomationPreview()) return [{ location: "Automation Preview", phase: "remove", detail: "temporary values could not be restored" }];
  const retiredDocumentId = getRecoveryDocumentId();
  advanceProjectEpoch();
  const freshProjectState = createFreshProjectDocumentState();
  const removalIssues: NAMProjectStateIssue[] = [];
  await get().stop();
  // Stop the session-only clock before changing any routing or removing FX.
  // A failed native stop must not be hidden by replacing the frontend state.
  if (!await get().setMetronomePracticeEnabled(false)) {
    removalIssues.push({ phase: "remove", location: "Metronome", detail: "could not stop click-only playback" });
    return removalIssues;
  }
  await nativeBridge.closeAllPluginWindows().catch(() => false);
  for (const lane of get().masterAutomationLanes) {
    await nativeBridge.setAutomationMode("master", lane.param, "off");
    await nativeBridge.clearAutomation("master", lane.param);
  }

  const currentMasterFX = await nativeBridge.getMasterFX().catch((error) => {
    removalIssues.push({
      phase: "remove",
      location: "Master FX",
      detail: `could not inspect the current chain (${String(error)})`,
    });
    return null;
  });
  if (currentMasterFX) {
    for (let index = currentMasterFX.length - 1; index >= 0; index--) {
      const plugin = currentMasterFX[index];
      const removed = await nativeBridge.removeMasterFX(plugin.index).catch(() => false);
      if (!removed) {
        removalIssues.push({
          phase: "remove",
          location: `Master FX ${plugin.name || plugin.pluginPath || plugin.index}`,
          detail: "native removal failed",
        });
      }
    }

    const remainingMasterFX = await nativeBridge.getMasterFX().catch(() => currentMasterFX);
    for (const plugin of remainingMasterFX) {
      const location = `Master FX ${plugin.name || plugin.pluginPath || plugin.index}`;
      if (!removalIssues.some((issue) => issue.location === location)) {
        removalIssues.push({
          phase: "remove",
          location,
          detail: "remained in the native chain after project reset",
        });
      }
    }
  }

  if (removalIssues.length > 0) {
    return removalIssues;
  }

  if (typeof get().closePitchEditor === "function")
    get().closePitchEditor();
  usePitchEditorStore.getState().close();
  if (typeof get().closePianoRoll === "function")
    get().closePianoRoll();
  if (typeof get().closePluginBrowser === "function")
    get().closePluginBrowser();
  if (typeof get().closeEnvelopeManager === "function")
    get().closeEnvelopeManager();
  if (typeof get().closeChannelStripEQ === "function")
    get().closeChannelStripEQ();
  if (typeof get().closeTrackRouting === "function")
    get().closeTrackRouting();
  if (typeof get().closeStemSeparation === "function")
    get().closeStemSeparation();
  if (typeof get().closeDynamicSplit === "function")
    get().closeDynamicSplit();
  if (typeof get().closeCrossfadeEditor === "function")
    get().closeCrossfadeEditor();

  await resetSyncCache();

  const tracks = [...get().tracks];
  for (let i = tracks.length - 1; i >= 0; i--) {
    await get().removeTrack(tracks[i].id);
  }

  set(buildProjectResetState());
  await nativeBridge.dismissProjectRecovery(retiredDocumentId, true).catch(logBridgeError("sync"));
  await nativeBridge.setProcessingPrecision(freshProjectState.processingPrecision).catch(logBridgeError("sync"));
  await nativeBridge.setTempo(freshProjectState.transport.tempo).catch(logBridgeError("sync"));
  await nativeBridge.setTimeSignature(
    freshProjectState.timeSignature.numerator,
    freshProjectState.timeSignature.denominator,
  ).catch(logBridgeError("sync"));
  await nativeBridge.setMetronomeEnabled(false).catch(logBridgeError("sync"));
  await nativeBridge.resetMetronomeSounds().catch(logBridgeError("sync"));
  await nativeBridge.setMetronomeAccentBeats(freshProjectState.metronomeAccentBeats).catch(logBridgeError("sync"));
  await nativeBridge.setMetronomeVolume(freshProjectState.metronomeVolume).catch(logBridgeError("sync"));
  await nativeBridge.setMasterVolume(freshProjectState.masterVolume).catch(logBridgeError("sync"));
  await nativeBridge.setAutomationTrimValue("master", 0).catch(logBridgeError("sync"));
  await nativeBridge.setMasterMute(false).catch(logBridgeError("sync"));
  await nativeBridge.setMasterPan(freshProjectState.masterPan).catch(logBridgeError("sync"));
  await nativeBridge.setMasterMono(Boolean(freshProjectState.masterMono)).catch(logBridgeError("sync"));
  await nativeBridge.setMIDILearnMappings([]).catch(logBridgeError("sync"));
  syncTempoMarkersToBackend([]);
  for (const lane of freshProjectState.masterAutomationLanes) {
    syncAutomationLaneToBackend("master", lane);
  }
  commandManager.clear();
  return removalIssues;
}

async function performPendingProjectAction(action: any, get: GetFn) {
  if (!action) return false;

  switch (action.type) {
    case "newProject":
    case "closeProject":
      return Boolean(await get().newProject());
    case "openProject":
      return await get().loadProject(action.path, action.options);
    case "quit":
      await nativeBridge.quitApplication();
      return true;
    case "loadTemplate":
      get().loadTemplate(action.index);
      return true;
    default:
      return false;
  }
}

async function verifyAndRepairLoadedMIDISync(get: GetFn) {
  const midiTracks = get().tracks.filter((track: any) =>
    track.type === "midi" || track.type === "instrument" || (track.midiClips || []).length > 0,
  );
  if (midiTracks.length === 0) return;

  const diagnostics = await nativeBridge.getMidiDiagnostics().catch(() => null);
  const diagnosticTracks = new Map<string, any>();
  for (const track of diagnostics?.tracks || []) {
    if (track?.trackId) diagnosticTracks.set(track.trackId, track);
  }

  const mismatches: Array<{ trackId: string; expectedClips: number; expectedEvents: number; actualClips: number; actualEvents: number }> = [];
  for (const track of midiTracks) {
    const serialized = serializeMIDIClipsForBackend(track.midiClips || [], track.midiEffects || []);
    const expectedClips = serialized.length;
    const expectedEvents = serialized.reduce((sum: number, clip: any) => sum + (clip.events?.length || 0), 0);
    const actual = diagnosticTracks.get(track.id);
    const actualClips = Number(actual?.scheduledMIDIClipCount ?? 0);
    const actualEvents = Number(actual?.scheduledMIDIEventCount ?? 0);

    if (expectedClips !== actualClips || expectedEvents !== actualEvents) {
      mismatches.push({ trackId: track.id, expectedClips, expectedEvents, actualClips, actualEvents });
      await syncTrackMIDIClipsToBackend(track.id, track.midiClips || [], track.midiEffects || []).catch(logBridgeError("midi load repair"));
    }
  }

  if (mismatches.length > 0) {
    console.warn("[loadProject] MIDI backend schedule mismatch repaired", mismatches);
    await nativeBridge.panicMIDI().catch(() => false);
    get().showToast(`Re-synced ${mismatches.length} MIDI track${mismatches.length === 1 ? "" : "s"} after load`, "success");
  }
}

export const projectActions = (set: SetFn, get: GetFn) => ({
    hydrateRecentProjects: async () => {
      const browserRecent = readBrowserRecentProjects();
      const nativeRecent = await nativeBridge.getRecentProjects().catch(() => []);
      const merged = sanitizeRecentProjects([...browserRecent, ...nativeRecent]);
      if (merged.length === 0) return;

      const current = sanitizeRecentProjects(get().recentProjects || []);
      if (JSON.stringify(current) !== JSON.stringify(merged)) {
        set({ recentProjects: merged });
      }
      persistRecentProjects(merged);
    },

    newProject: async () => {
      const removalIssues = await teardownCurrentProject(get, set);
      if (removalIssues.length > 0) {
        const detail = removalIssues
          .slice(0, 3)
          .map((issue) => `${issue.location}: ${issue.detail}`)
          .join("; ");
        console.error("[newProject] Native project teardown failed", removalIssues);
        get().showToast(`Could not reset project. ${detail}`, "error");
        return false;
      }
      return true;
    },

    requestNewProject: async () => {
      const action = { type: "newProject" };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before creating a new project",
      });
      return true;
    },

    requestOpenProject: async (path, options) => {
      const action = { type: "openProject", path, options };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before opening another project",
      });
      return true;
    },

    requestCloseProject: async () => {
      const action = { type: "closeProject" };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before closing the current project",
      });
      return true;
    },

    requestQuit: async (installPreparedUpdate = false) => {
      if (installPreparedUpdate) {
        const state = get();
        // Update consent cannot survive a deferred unsaved-changes dialog.
        if (state.isModified || state.transport.isPlaying || state.transport.isRecording)
          return false;
        await nativeBridge.quitApplication(true);
        return true;
      }
      const action = { type: "quit" };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before closing OpenStudio",
      });
      return true;
    },

    requestLoadTemplate: async (index) => {
      const action = { type: "loadTemplate", index };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before loading a project template",
      });
      return true;
    },

    dismissUnsavedChangesDialog: () =>
      set({
        showUnsavedChangesDialog: false,
        pendingProjectAction: null,
        pendingProjectActionLabel: "",
      }),

    resolveUnsavedChanges: async (choice) => {
      const pendingAction = get().pendingProjectAction;
      if (!pendingAction) {
        get().dismissUnsavedChangesDialog();
        return;
      }

      if (choice === "cancel") {
        get().dismissUnsavedChangesDialog();
        return;
      }

      if (choice === "save") {
        const saved = await get().saveProject(!get().projectPath);
        if (!saved)
          return;
      }

      set({
        showUnsavedChangesDialog: false,
        pendingProjectAction: null,
        pendingProjectActionLabel: "",
      });

      await performPendingProjectAction(pendingAction, get);
    },

    setModified: (modified) => { if (modified) markProjectEdited(); set({ isModified: modified }); },

    saveProject: (saveAs = false, recoveryOnly = false) => serializeProjectSave(async () => {
      if (!await get().cancelAutomationPreview()) return false;
      if (get().projectRestoreError) {
        get().showToast("Project restoration was incomplete. Reopen the original saved project before saving so its retained data is not overwritten.", "error");
        return false;
      }
      const epoch = getProjectEpoch();
      const documentId = getRecoveryDocumentId();
      let path = get().projectPath;

      if (!recoveryOnly && (!path || saveAs)) {
        path = await nativeBridge.showSaveDialog(path || undefined);
        if (!path) return false;
      }

      try {
      const state = get();
      if (epoch !== getProjectEpoch()) return false;
      const savedRevision = commandManager.getRevision();
      const savedEditRevision = getProjectEditRevision();
      const savedFingerprint = documentFingerprint(state);
      const namLibraryPayload = await nativeBridge.getNAMLibrary().catch(() => ({ installed: [] }));
      const namInstalledByPath = buildNAMInstalledPathIndex(namLibraryPayload.installed || []);

      // 1. Serialize Tracks with Plugin States
      const serializedTrackResults = await Promise.all(
        state.tracks.map(async (track) => {
          const inputFXStates: string[] = [];
          const trackNAMAssets: any[] = [];

          const inputFXList = await nativeBridge.getTrackInputFX(track.id);
          const inputFXTypes = inputFXList.map(item => item.type || "plugin");
          const inputFXPaths: string[] = [];
          for (let i = 0; i < inputFXList.length; i++) {
            const item = inputFXList[i];
            if (!item.pluginPath) throw new Error(`Cannot save input FX ${i + 1} on ${track.name}: missing plugin identity`);
            inputFXPaths.push(item.pluginPath);
            const fxState = await nativeBridge.getPluginState(track.id, i, true);
            inputFXStates.push(fxState || "");
            if (isNAMRackPluginPath(item.pluginPath)) {
              const builtInState = await nativeBridge.getBuiltInPluginState({ trackId: track.id, chain: "input", fxIndex: i }).catch(() => null);
              trackNAMAssets.push(...collectNAMAssetsFromPluginState(builtInState, {
                trackId: track.id,
                trackName: track.name,
                chain: "input",
                fxIndex: i,
                pluginName: item.pluginPath,
              }, namInstalledByPath));
            }
          }

          const trackFXSidechains: string[] = [];
          const trackFXStates: string[] = [];
          const trackFXPaths: string[] = [];
          const trackFXList = await nativeBridge.getTrackFX(track.id);
          const trackFXTypes = trackFXList.map(item => item.type || "plugin");
          for (let i = 0; i < trackFXList.length; i++) {
            const item = trackFXList[i];
            if (!item.pluginPath) throw new Error(`Cannot save track FX ${i + 1} on ${track.name}: missing plugin identity`);
            trackFXPaths.push(item.pluginPath);
            const fxState = await nativeBridge.getPluginState(track.id, i, false);
            trackFXStates.push(fxState || "");
            trackFXSidechains.push(await nativeBridge.getSidechainSource(track.id, i));
            if (isNAMRackPluginPath(item.pluginPath)) {
              const builtInState = await nativeBridge.getBuiltInPluginState({ trackId: track.id, chain: "track", fxIndex: i }).catch(() => null);
              trackNAMAssets.push(...collectNAMAssetsFromPluginState(builtInState, {
                trackId: track.id,
                trackName: track.name,
                chain: "track",
                fxIndex: i,
                pluginName: item.pluginPath,
              }, namInstalledByPath));
            }
          }

          const instrumentState = track.instrumentPlugin
            ? await nativeBridge.getInstrumentState(track.id)
            : "";
          const trackAutomationReadEnabled = deriveAutomationReadEnabled(track, track.automationLanes || []);

          const automationSafeParameters = [];
          const safeSchemas = new Map<string, Awaited<ReturnType<typeof nativeBridge.getPluginParameters>>>();
          for (const param of track.automationSafeParams ?? []) {
            const address = /^(builtin|plugin)_(input|track|instrument)_(\d+)_(.+)$/.exec(param);
            if (!address) continue;
            const input = address[2] === "input", index = address[2] === "instrument" ? -1 : Number(address[3]);
            const expected = index === -1 ? track.instrumentPlugin || (address[1] === "builtin" && ["instrument", "midi"].includes(track.type)) : (input ? inputFXList : trackFXList)[index];
            if (!expected) throw new Error(`Cannot save Automation Safe control ${param}: its FX is unavailable`);
            const schemaKey = `${address[2]}:${index}`;
            if (!safeSchemas.has(schemaKey)) safeSchemas.set(schemaKey, await nativeBridge.getPluginParameters(track.id, index, input));
            const parameter = resolveSavedSafeParameter({ param }, safeSchemas.get(schemaKey)!);
            if (!parameter) throw new Error(`Cannot save Automation Safe control ${param}: its parameter is unavailable`);
            const { referenceGeneration: _generation, ...metadata } = automationParameterMetadata(parameter);
            automationSafeParameters.push({ param, metadata });
          }
          if (automationSafeParameters.length) {
            for (const [input, expected] of [[true, inputFXList], [false, trackFXList]] as const) {
              const current = await (input ? nativeBridge.getTrackInputFX(track.id) : nativeBridge.getTrackFX(track.id));
              if (current.length !== expected.length || expected.some((item, index) => item.instanceId
                ? item.instanceId !== current[index]?.instanceId : item.pluginPath !== current[index]?.pluginPath))
                throw new Error("The FX chain changed while saving Automation Safe controls. Save again after the edit finishes.");
            }
          }

          const serializedTrack = {
            id: track.id,
            name: track.name,
            color: track.color,
            type: track.type,
            inputType: track.inputType,
            inputStartChannel: track.inputStartChannel,
            inputChannelCount: track.inputChannelCount,
            volumeDB: track.volumeDB,
            sends: (track.sends ?? []).map(send => ({ ...send, sourceChannel: send.sourceChannel ?? 0 })),
            masterSendEnabled: track.masterSendEnabled !== false,
            phaseInverted: !!track.phaseInverted,
            stereoWidth: track.stereoWidth ?? 100,
            outputStartChannel: track.outputStartChannel ?? 0,
            outputChannelCount: track.outputChannelCount ?? 2,
            playbackOffsetMs: track.playbackOffsetMs ?? 0,
            trackChannelCount: track.trackChannelCount ?? 2,
            pan: track.pan,
            muted: track.muted,
            soloed: track.soloed,
            soloSafe: !!track.soloSafe,
            armed: track.armed,
            monitorEnabled: track.monitorEnabled,
            inputChannel: track.inputChannel,
            clips: track.clips,
            midiClips: track.midiClips,
            midiEffects: track.midiEffects || [],
            midiInputDevice: track.midiInputDevice,
            midiChannel: track.midiChannel,
            midiOutputDevice: track.midiOutputDevice,
            midiOutputMergeKeys: Boolean(track.midiOutputMergeKeys),
            midiPitchBendRangeUp: track.midiPitchBendRangeUp ?? 2,
            midiPitchBendRangeDown: track.midiPitchBendRangeDown ?? track.midiPitchBendRangeUp ?? 2,
            midiPitchBendRangeLinked: track.midiPitchBendRangeLinked ?? true,
            samplerSamplePath: track.samplerSamplePath,
            samplerRootNote: track.samplerRootNote ?? 60,
            samplerSourceType: track.samplerSourceType,
            builtInInstrument: track.builtInInstrument,
            icon: track.icon,
            aiMusicModelId: track.aiMusicModelId,
            aiWorkflow: track.aiWorkflow,
            aiWorkflowParams: track.aiWorkflowParams,
            inputFXPaths,
            inputFXTypes,
            inputFXStates,
            trackFXPaths,
            trackFXTypes,
            trackFXStates,
            trackFXSidechains,
            instrumentPlugin: track.instrumentPlugin,
            instrumentState,
            automationLanes: serializeAutomationLanesForProject(track.automationLanes),
            automationSafeParams: track.automationSafeParams ?? [],
            automationSafeParameters,
            unavailableFX: track.unavailableFX ?? [],
            showAutomation: Boolean(track.showAutomation),
            automationReadEnabled: trackAutomationReadEnabled,
            automationWriteEnabled: false,
            automationTrimWriteEnabled: false,
            trimVolumeDB: normalizeTrimDB(track.trimVolumeDB),
            automationEnabled: trackAutomationReadEnabled,
            suspendedAutomationState: null,
          };

          return { track: serializedTrack, namAssets: trackNAMAssets };
        }),
      );
      const serializedTracks = serializedTrackResults.map((result) => result.track);
      const rawNAMAssets = serializedTrackResults.flatMap((result) => result.namAssets);

      // 2. Master Bus FX serialization
      const masterFXPaths: string[] = [];
      const masterFXStates: string[] = [];
      try {
        const masterFXList = await nativeBridge.getMasterFX();
        for (let i = 0; i < masterFXList.length; i++) {
          const path = masterFXList[i].pluginPath || masterFXList[i].name;
          masterFXPaths.push(path || "");
          const fxState = await nativeBridge.getMasterPluginState(i);
          masterFXStates.push(fxState || "");
          if (isNAMRackPluginPath(path)) {
            const builtInState = await nativeBridge.getBuiltInPluginState({
              trackId: "",
              chain: "master",
              fxIndex: i,
            }).catch(() => null);
            rawNAMAssets.push(...collectNAMAssetsFromPluginState(builtInState, {
              trackId: "",
              trackName: "Master",
              chain: "master",
              fxIndex: i,
              pluginName: path,
            }, namInstalledByPath));
          }
        }
      } catch (e) {
        console.warn("[saveProject] Failed to serialize master FX:", e);
      }

      const inspectionByPath = new Map<string, Promise<any>>();
      const namAssets = await Promise.all(rawNAMAssets.map(async (asset) => {
        const identified = withStableNAMAssetIdentity(asset);
        const key = pathKey(asset.path);
        if (!inspectionByPath.has(key)) {
          inspectionByPath.set(key, nativeBridge.inspectNAMAsset(asset.path).catch(() => null));
        }
        const inspection = await inspectionByPath.get(key);
        if (!inspection?.success) return identified;
        return withStableNAMAssetIdentity({
          ...identified,
          checksum: inspection.checksum,
          assetId: inspection.assetId,
          fileSizeBytes: inspection.fileSizeBytes,
          originalFileName: inspection.fileName,
        });
      }));
      // A failed snapshot must not overwrite the last save with an empty CC map.
      const activeMIDILearnMappings = await nativeBridge.getMIDILearnMappings();
      const midiParameters = new Map();
      const midiLearnMappings = await Promise.all(activeMIDILearnMappings.map(async mapping => {
        const key = `${mapping.trackId}:${mapping.chainType}:${mapping.pluginIndex}`;
        if (!midiParameters.has(key)) midiParameters.set(key,
          nativeBridge.getPluginParameters(mapping.trackId, mapping.pluginIndex, mapping.chainType === "input"));
        const parameters = await midiParameters.get(key);
        return savedMIDILearnMapping(mapping, resolveSavedMIDILearnParameter(mapping, parameters));
      }));

      const projectData = buildSerializedProjectData(
        state,
        serializedTracks,
        masterFXPaths,
        masterFXStates,
        namAssets,
        midiLearnMappings,
      );
      // Optional fields preserve old-project compatibility and slot identities.
      const [masterFXStageState, monitorFXStageState] = await Promise.all([
        nativeBridge.getFXStageState("master"), nativeBridge.getFXStageState("monitor"),
      ]);
      if (masterFXStageState) projectData.masterFXStageState = masterFXStageState;
      if (monitorFXStageState) projectData.monitorFXStageState = monitorFXStageState;
      const stageSafeParameters = [];
      for (const chain of ["master", "monitor"]) {
        const safe = (state.masterAutomationSafeParams ?? []).filter(param => savedAutomationAddress(param)?.chain === chain);
        if (!safe.length) continue;
        const slots = await (chain === "master" ? nativeBridge.getMasterFX() : nativeBridge.getMonitoringFX());
        const schemas = await Promise.all(slots.map(slot => nativeBridge.getPluginParameters(chain, slot.index, false)));
        for (const param of safe) {
          const address = savedAutomationAddress(param);
          const schema = schemas.find(parameters => parameters.some(parameter => parameter.automationId?.startsWith(address.prefix)));
          const parameter = schema && resolveSavedSafeParameter({ param }, schema);
          if (!parameter) {
            const retained = state.masterAutomationSafeParameters?.find(entry => entry.param === param);
            if (state.unavailableFXStages?.[chain]?.length && retained) { stageSafeParameters.push(retained); continue; }
            throw new Error(`Cannot save Automation Safe control ${param}: its stage parameter is unavailable`);
          }
          const { referenceGeneration: _generation, ...metadata } = automationParameterMetadata(parameter);
          stageSafeParameters.push({ param, metadata });
        }
        const current = await nativeBridge.getFXStageState(chain);
        const expected = chain === "master" ? masterFXStageState : monitorFXStageState;
        const identities = items => items?.map(item => [item.automationKey, item.pluginPath, item.type]);
        if (JSON.stringify(identities(current)) !== JSON.stringify(identities(expected)))
          throw new Error("The FX stage changed while saving Automation Safe controls. Save again after the edit finishes.");
      }
      projectData.masterAutomationSafeParameters = stageSafeParameters;

      if (epoch !== getProjectEpoch()) return false;
      const success = await nativeBridge.saveProjectToFile(
        path || "",
        JSON.stringify(projectData, projectJsonReplacer, 2),
        recoveryOnly,
        state.autoSaveMaxVersions,
        documentId,
      );

      if (epoch !== getProjectEpoch()) return false;
      if (recoveryOnly) {
        if (!success) get().showToast("Recovery backup failed; your last saved project was retained.", "error");
        return success; // A recovery copy does not replace Save or clear dirty state.
      }
      if (success) {
        get().showToast("Project saved", "success");
        set((ctx) => {
          const newRecent = [
            path!,
            ...ctx.recentProjects.filter((p) => p !== path),
          ].slice(0, 10);
          return {
            projectPath: path,
            isModified: commandManager.getRevision() !== savedRevision
              || getProjectEditRevision() !== savedEditRevision
              || documentFingerprint(ctx) !== savedFingerprint,
            recentProjects: newRecent,
          };
        });
        persistRecentProjects(get().recentProjects);
        if (!get().isModified)
          await nativeBridge.dismissProjectRecovery(documentId, true).catch(logBridgeError("sync"));
      } else {
        console.error(`[saveProject] Save failed for path: ${path}`);
        get().showToast("Failed to save project", "error");
      }

      return success;
      } catch (e) {
        console.error("[saveProject] Exception during save:", e);
        get().showToast("Save failed: " + String(e), "error");
        return false;
      }
    }),

    saveNewVersion: async () => {
      const state = get();
      let basePath = state.projectPath;
      if (!basePath) {
        // No existing path — fallback to Save As
        return get().saveProject(true);
      }

      // Increment version: "project.osproj" → "project_v2.osproj" → "project_v3.osproj"
      const ext = basePath.match(/\.[^.]+$/)?.[0] || ".osproj";
      const base = basePath.replace(/\.[^.]+$/, "");
      const versionMatch = base.match(/_v(\d+)$/);
      let newPath: string;
      if (versionMatch) {
        const nextVersion = parseInt(versionMatch[1], 10) + 1;
        newPath = base.replace(/_v\d+$/, `_v${nextVersion}`) + ext;
      } else {
        newPath = base + "_v2" + ext;
      }

      // Update projectPath and save
      set({ projectPath: newPath });
      return get().saveProject(false);
    },

    loadProject: async (path, options) => {
      if (!await get().cancelAutomationPreview()) return false;
      await resetSyncCache();

      const bypassFX = options?.bypassFX ?? false;
      const recoveryCopy = options?.recoveryCopy ?? false;
      if (!path) {
        path = await nativeBridge.showOpenDialog();
        if (!path) return false;
      }

      set({ isProjectLoading: true, projectLoadingMessage: "Opening project..." });
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve(undefined));
        } else {
          setTimeout(resolve, 0);
        }
      });

      let json: string;
      try {
        json = await nativeBridge.loadProjectFromFile(path);
        if (!json) throw new Error("The project file could not be read");
      } catch (error) {
        set({ isProjectLoading: false, projectLoadingMessage: "" });
        console.error("[loadProject] File read failed", path, error);
        get().showToast(`Could not open project: ${String(error)}`, "error");
        return false;
      }

      set({ projectLoadingMessage: "Parsing project..." });
      await new Promise((r) => setTimeout(r, 0));

      try {
        const data = parseValidatedProject(json);
        const namProjectStateIssues: NAMProjectStateIssue[] = [];
        const pluginRestoreIssues: string[] = [];
        const recordNAMProjectStateIssue = (
          phase: NAMProjectStateIssue["phase"],
          location: string,
          detail: string,
        ) => {
          namProjectStateIssues.push({ phase, location, detail });
          console.error(`[loadProject] NAM ${phase} failure at ${location}: ${detail}`);
        };
        console.log(`[DEBUG LOAD] Parsed project. ${data.tracks?.length || 0} tracks.`);
        for (const t of data.tracks || []) {
          console.log(`[DEBUG LOAD] Saved track "${t.name}": inputFXPaths=${JSON.stringify(t.inputFXPaths || [])}, trackFXPaths=${JSON.stringify(t.trackFXPaths || [])}, inputFXStates=${(t.inputFXStates || []).length} states, trackFXStates=${(t.trackFXStates || []).length} states`);
        }
        if (data.masterFXPaths) {
          console.log(`[DEBUG LOAD] Saved masterFXPaths=${JSON.stringify(data.masterFXPaths)}`);
        }

        set({ projectLoadingMessage: "Resetting current project..." });
        await new Promise((r) => setTimeout(r, 0));

        const resetSucceeded = await get().newProject();
        if (!resetSucceeded) {
          set({ isProjectLoading: false, projectLoadingMessage: "" });
          return false;
        }
        const freshProjectState = createFreshProjectDocumentState();
        const loadedTempo = data.tempo || 120;
        const loadedTimeSignature = data.timeSignature || freshProjectState.timeSignature;
        const loadedMasterVolume = data.masterVolume ?? 1.0;
        const loadedMasterPan = data.masterPan ?? 0.0;
        const loadedProcessingPrecision =
          data.processingPrecision || freshProjectState.processingPrecision;
        const loadedMetronomeVolume = data.metronomeVolume ?? freshProjectState.metronomeVolume;
        const loadedMetronomeAccentBeats =
          Array.isArray(data.metronomeAccentBeats) && data.metronomeAccentBeats.length > 0
            ? data.metronomeAccentBeats
            : freshProjectState.metronomeAccentBeats;
        const loadedMasterAutomationLanesRaw =
          Array.isArray(data.masterAutomationLanes) && data.masterAutomationLanes.length > 0
            ? data.masterAutomationLanes
            : freshProjectState.masterAutomationLanes;
        const loadedMasterAutomationLanesNormalized = normalizeAutomationLanes(
          loadedMasterAutomationLanesRaw,
          { showAutomation: Boolean(data.showMasterAutomation) },
          Number(data.automationCurveVersion) || 1,
        );
        const loadedMasterAutomationRead = deriveAutomationReadEnabled(
          {
            automationReadEnabled: data.masterAutomationReadEnabled,
            automationEnabled: data.masterAutomationEnabled,
          },
          loadedMasterAutomationLanesNormalized,
        );
        const loadedMasterAutomationLanes = resolveLoadedAutomationLaneModes(
          loadedMasterAutomationLanesNormalized,
          loadedMasterAutomationRead,
        );
        const loadedAutomationWriteBehavior = normalizeAutomationWriteBehavior(data.automationWriteBehavior);
        const loadedRenderMetadata = {
          ...freshProjectState.renderMetadata,
          ...(data.renderMetadata || {}),
        };
        const loadedRenderDialogOptions = {
          ...freshProjectState.renderDialogOptions,
          ...(data.renderDialogOptions || {}),
        };
        const loadedClipLauncher = {
          ...freshProjectState.clipLauncher,
          ...(data.clipLauncher || {}),
        };
        const loadedQuantizePresets = Array.isArray(data.quantizePresets) && data.quantizePresets.length > 0
          ? data.quantizePresets
          : [...FACTORY_QUANTIZE_PRESETS];
        const loadedQuantizePresetId = loadedQuantizePresets.some((preset) => preset.id === data.quantizePresetId)
          ? data.quantizePresetId
          : "factory-1/16";

        await nativeBridge.setProcessingPrecision(loadedProcessingPrecision).catch(logBridgeError("sync"));
        await nativeBridge.setTempo(loadedTempo).catch(logBridgeError("sync"));
        await nativeBridge.setTimeSignature(
          loadedTimeSignature.numerator,
          loadedTimeSignature.denominator,
        ).catch(logBridgeError("sync"));
        await nativeBridge.setMetronomeAccentBeats(loadedMetronomeAccentBeats).catch(logBridgeError("sync"));
        await nativeBridge.setMetronomeVolume(loadedMetronomeVolume).catch(logBridgeError("sync"));
        const restoredClicks = await restoreMetronomeProjectSounds(data);
        await nativeBridge.setMetronomeEnabled(Boolean(data.metronomeEnabled)).catch(logBridgeError("sync"));
        await nativeBridge.setMasterVolume(loadedMasterVolume).catch(logBridgeError("sync"));
        await nativeBridge.setMasterPan(loadedMasterPan).catch(logBridgeError("sync"));
        await nativeBridge.setAutomationTrimValue("master", normalizeTrimDB(data.masterTrimVolumeDB)).catch(logBridgeError("sync"));
        await nativeBridge.setMasterMono(Boolean(data.masterMono)).catch(logBridgeError("sync"));

        set({
          projectName: data.projectName || "Untitled Project",
          projectPersistentId: typeof data.projectPersistentId === "string" && /^[a-f0-9-]{36}$/i.test(data.projectPersistentId)
            ? data.projectPersistentId : freshProjectState.projectPersistentId,
          projectNotes: data.projectNotes || "",
          projectSampleRate: data.projectSampleRate || 44100,
          projectBitDepth: data.projectBitDepth || 24,
          processingPrecision: loadedProcessingPrecision,
          projectAuthor: data.projectAuthor || "",
          projectRevisionNotes: data.projectRevisionNotes || [],
          transport: { ...freshProjectState.transport, tempo: loadedTempo },
          timeSignature: loadedTimeSignature,
          metronomeEnabled: Boolean(data.metronomeEnabled),
          metronomeVolume: loadedMetronomeVolume,
          metronomeAccentBeats: loadedMetronomeAccentBeats,
          metronomeClickPath: restoredClicks.metronomeClickPath,
          metronomeAccentPath: restoredClicks.metronomeAccentPath,
          metronomeTrackId: data.metronomeTrackId ?? null,
          projectRange: data.projectRange || freshProjectState.projectRange,
          snapEnabled: typeof data.snapEnabled === "boolean" ? data.snapEnabled : freshProjectState.snapEnabled,
          snapType: SNAP_TYPE_OPTIONS.some(option => option.value === data.snapType) ? data.snapType : freshProjectState.snapType,
          gridSize: SAVED_GRID_VALUES.has(data.gridSize) ? data.gridSize : freshProjectState.gridSize,
          quantizePresetId: loadedQuantizePresetId,
          quantizePresets: loadedQuantizePresets,
          markers: Array.isArray(data.markers) ? data.markers : freshProjectState.markers,
          regions: Array.isArray(data.regions) ? data.regions : freshProjectState.regions,
          tempoMarkers: Array.isArray(data.tempoMarkers) ? data.tempoMarkers : freshProjectState.tempoMarkers,
          masterVolume: loadedMasterVolume,
          masterPan: loadedMasterPan,
          masterTrimVolumeDB: normalizeTrimDB(data.masterTrimVolumeDB),
          automationTrimLiveValues: {},
          automationPreviewSession: null,
          automationCapturedPreview: null,
          isMasterMuted: Boolean(data.isMasterMuted),
          masterMono: Boolean(data.masterMono),
          masterAutomationLanes: loadedMasterAutomationLanes,
          showMasterAutomation: Boolean(data.showMasterAutomation),
          masterAutomationReadEnabled: loadedMasterAutomationRead,
          masterAutomationWriteEnabled: false,
          masterAutomationTrimWriteEnabled: false,
          masterAutomationEnabled: loadedMasterAutomationRead,
          automationWriteBehavior: loadedAutomationWriteBehavior,
          automationTouchReturnSeconds: Math.max(0, Math.min(5, Number(data.automationTouchReturnSeconds) || 0)),
          automationTrimCoalesce: ["after-pass","on-exit"].includes(data.automationTrimCoalesce) ? data.automationTrimCoalesce : "manual",
          automationAutoJoinEnabled:data.automationAutoJoinEnabled === true,
          masterAutomationSafeParams: Array.isArray(data.masterAutomationSafeParams) ? data.masterAutomationSafeParams.filter(param => typeof param === "string") : [],
          masterAutomationSafeParameters: normalizeSavedSafeParameters(data.masterAutomationSafeParameters),
          // Suspension is an in-session editing state. Never carry its saved
          // owner/lane snapshot into a newly loaded project.
          suspendedMasterAutomationState: null,
          mixerSnapshots: Array.isArray(data.mixerSnapshots) ? data.mixerSnapshots : [],
          trackGroups: Array.isArray(data.trackGroups) ? data.trackGroups : [],
          clipLauncher: loadedClipLauncher,
          renderMetadata: loadedRenderMetadata,
          renderDialogOptions: loadedRenderDialogOptions,
          secondaryOutputEnabled: Boolean(data.secondaryOutputEnabled),
          secondaryOutputFormat:
            data.secondaryOutputFormat || freshProjectState.secondaryOutputFormat,
          secondaryOutputBitDepth:
            data.secondaryOutputBitDepth ?? freshProjectState.secondaryOutputBitDepth,
          onlineRender: Boolean(data.onlineRender),
          addToProjectAfterRender: Boolean(data.addToProjectAfterRender),
        });
        if (restoredClicks.warnings.length > 0)
          get().showToast(restoredClicks.warnings.join(" "), "warning");
        syncTempoMarkersToBackend(
          Array.isArray(data.tempoMarkers) ? data.tempoMarkers : [],
        );
        await nativeBridge.setMasterMute(Boolean(data.isMasterMuted)).catch(logBridgeError("sync"));

        const pendingSidechains: Array<{ trackId: string; fxIndex: number; sourceTrackId: string }> = [];
        const restoredMIDILearnMappings = [];
        const savedMIDILearnMappings = normalizeSavedMIDILearnMappings(data.midiLearnMappings);
        const totalTracks = data.tracks.length;
        for (let ti = 0; ti < totalTracks; ti++) {
          const trackData = prepareUnavailableFXForLoad(data.tracks[ti]);
          const plannedMIDILearnMappings = savedMIDILearnMappings.filter(mapping => mapping.trackId === trackData.id).flatMap(mapping => {
            const index = trackData.liveIndices[mapping.chainType].get(mapping.pluginIndex);
            return index === undefined ? [] : [{ ...mapping, pluginIndex: index }];
          });
          for (const slot of trackData.unavailableFX ?? []) {
            const index = [...trackData.recoveryKeys[slot.chain]].find(([, key]) => key === slot.key)?.[0];
            if (index !== undefined) plannedMIDILearnMappings.push(...(slot.midiLearnMappings ?? [])
              .filter(mapping => mapping.trackId === trackData.id && mapping.chainType === slot.chain)
              .map(mapping => ({ ...mapping, pluginIndex: index })));
          }
          const unavailableFX = [];
          const restoredParameters = { input: new Map(), track: new Map() };
          const verifyParameters = async (chain, originalIndex, index) => {
            const candidates = (trackData.automationLanes ?? []).filter(lane => new RegExp(`^(builtin|plugin)_${chain}_${originalIndex}_`).test(lane.param));
            const midiCandidates = plannedMIDILearnMappings.filter(mapping => mapping.chainType === chain && mapping.pluginIndex === originalIndex);
            const safeCandidates = (trackData.automationSafeParameters ?? []).filter(entry => new RegExp(`^(builtin|plugin)_${chain}_${originalIndex}_`).test(entry.param));
            if (!candidates.length && !midiCandidates.length && !safeCandidates.length) return true;
            const parameters = await nativeBridge.getPluginParameters(trackData.id, index, chain === "input");
            restoredParameters[chain].set(originalIndex, parameters);
            if (!safeCandidates.every(entry => resolveSavedSafeParameter(entry, parameters))) return false;
            if (!trackData.recoveryKeys[chain].has(originalIndex)) return true;
            return midiCandidates.every(mapping => resolveSavedMIDILearnParameter(mapping, parameters)) && candidates.every(lane => {
              const parameter = resolveSavedPluginParameter(lane, parameters);
              return parameter && compatibleAutomationMetadata(lane.metadata, automationParameterMetadata(parameter));
            });
          };
          const retainUnavailableFX = (chain, index, pluginPath) => {
            const input = chain === "input";
            const key = trackData.recoveryKeys[chain].get(index) ?? unavailableFXKey(chain, index, pluginPath);
            const existing = trackData.unavailableFX?.find(slot => slot.key === key);
            unavailableFX.push({ key, chain, pluginPath, originalIndex: index,
              pluginType: (input ? trackData.inputFXTypes : trackData.trackFXTypes)?.[index] || (isBuiltInPluginPath(pluginPath) ? "builtin" : /\.jsfx$/i.test(pluginPath) ? "jsfx" : "plugin"),
              state: (input ? trackData.inputFXStates : trackData.trackFXStates)?.[index] ?? existing?.state ?? "",
              sidechain: input ? "" : trackData.trackFXSidechains?.[index] ?? existing?.sidechain ?? "",
              safeParams: (trackData.automationSafeParams ?? []).filter(param => new RegExp(`^(builtin|plugin)_${chain}_${index}_`).test(param)),
              safeParameters: (trackData.automationSafeParameters ?? []).filter(entry => new RegExp(`^(builtin|plugin)_${chain}_${index}_`).test(entry.param)),
              midiLearnMappings: plannedMIDILearnMappings.filter(mapping => mapping.chainType === chain && mapping.pluginIndex === index),
            });
            return key;
          };
          set({ projectLoadingMessage: `Loading track ${ti + 1}/${totalTracks}: ${trackData.name}` });
          await new Promise((r) => setTimeout(r, 0));

          console.log("Loading track:", trackData.name, trackData.id);

          try {
            const restoredTrackType = trackData.type || "audio";
            await nativeBridge.addTrack(trackData.id, restoredTrackType);
            await nativeBridge.setTrackType(trackData.id, restoredTrackType).catch(logBridgeError("sync"));
            await nativeBridge.setTrackVolume(trackData.id, trackData.volumeDB);
            await nativeBridge.setTrackPan(trackData.id, trackData.pan);
            await nativeBridge.setAutomationTrimValue(trackData.id, normalizeTrimDB(trackData.trimVolumeDB));
            await nativeBridge.setTrackPhaseInvert(trackData.id, !!trackData.phaseInverted);
            await nativeBridge.setTrackStereoWidth(trackData.id, trackData.stereoWidth ?? 100);
            await nativeBridge.setTrackOutputChannels(trackData.id, trackData.outputStartChannel ?? 0, trackData.outputChannelCount ?? 2);
            await nativeBridge.setTrackPlaybackOffset(trackData.id, trackData.playbackOffsetMs ?? 0);
            await nativeBridge.setTrackChannelCount(trackData.id, trackData.trackChannelCount ?? 2);

            if (trackData.muted)
              await nativeBridge.setTrackMute(trackData.id, true);
            await nativeBridge.setTrackSoloSafe(trackData.id, !!trackData.soloSafe);
            if (trackData.soloed)
              await nativeBridge.setTrackSolo(trackData.id, true);
            if (trackData.armed)
              await nativeBridge.setTrackRecordArm(trackData.id, true);
            if (trackData.monitorEnabled)
              await nativeBridge.setTrackInputMonitoring(trackData.id, true);

            const inputStartCh = trackData.inputStartChannel ?? 0;
            const inputChCount = trackData.inputChannelCount ?? 2;
            await nativeBridge.setTrackInputChannels(
              trackData.id,
              inputStartCh,
              inputChCount,
            );

            if (
              trackData.type === "midi" ||
              trackData.type === "instrument" ||
              trackData.inputType === "midi" ||
              trackData.midiInputDevice
            ) {
              if (trackData.midiInputDevice)
                await nativeBridge.openMIDIDevice(trackData.midiInputDevice).catch(logBridgeError("sync"));

              await nativeBridge.setTrackMIDIInput(
                trackData.id,
                trackData.midiInputDevice || "",
                trackData.midiChannel ?? 0,
              ).catch(logBridgeError("sync"));
            }

            await nativeBridge.setTrackMIDIOutputMergeKeys(trackData.id, Boolean(trackData.midiOutputMergeKeys)).catch(logBridgeError("sync"));
            if (trackData.midiOutputDevice) {
              await nativeBridge.setTrackMIDIOutput(trackData.id, trackData.midiOutputDevice)
                .catch(logBridgeError("sync"));
            }

            let restoredInstrumentPlugin: string | undefined;
            if (!bypassFX && trackData.instrumentPlugin) {
              set({ projectLoadingMessage: `Restoring instrument for ${trackData.name}...` });
              await new Promise((r) => setTimeout(r, 0));
              const success = await nativeBridge.loadInstrument(trackData.id, trackData.instrumentPlugin);
              console.log(`[DEBUG LOAD]   loadInstrument result: ${success}`);
              if (success) {
                if (trackData.instrumentState) {
                  const restored = await nativeBridge.setInstrumentState(trackData.id, trackData.instrumentState).catch(() => false);
                  if (!restored) pluginRestoreIssues.push(`${trackData.name}: instrument state could not be restored`);
                }
                restoredInstrumentPlugin = trackData.instrumentPlugin;
              } else {
                pluginRestoreIssues.push(`${trackData.name}: ${trackData.instrumentPlugin} could not be loaded`);
              }
            }

            if (trackData.clips) {
              for (const clip of trackData.clips) {
                if (clip.filePath) {
                  await nativeBridge.addPlaybackClip(
                    trackData.id,
                    clip.filePath,
                    clip.startTime,
                    clip.duration,
                    clip.offset || 0,
                    clip.volumeDB || 0,
                    clip.fadeIn || 0,
                    clip.fadeOut || 0,
                    clip.id,
                    clip.pitchCorrectionSourceFilePath,
                    clip.pitchCorrectionSourceOffset,
                  );
                }
              }
            }

            console.log(`[DEBUG LOAD] Track "${trackData.name}" FX data from file: bypassFX=${bypassFX}, inputFXPaths=${JSON.stringify(trackData.inputFXPaths || "MISSING")}, trackFXPaths=${JSON.stringify(trackData.trackFXPaths || "MISSING")}`);
            let inputFxRestored = 0;
            const restoredInputIndices = new Map<number, number>();
            const restoredTrackIndices = new Map<number, number>();
            if (!bypassFX && trackData.inputFXPaths && trackData.inputFXPaths.length > 0) {
              set({ projectLoadingMessage: `Restoring input FX for ${trackData.name}...` });
              await new Promise((r) => setTimeout(r, 0));
              for (let i = 0; i < trackData.inputFXPaths.length; i++) {
                console.log(`[DEBUG LOAD]   Restoring input FX[${i}]: "${trackData.inputFXPaths[i]}"`);
                const fxPath = trackData.inputFXPaths[i];
                const isNAMRack = isNAMRackPluginPath(fxPath);
                const restoredFxIndex = inputFxRestored;
                const success = await (
                  isBuiltInPluginPath(fxPath)
                    ? nativeBridge.addTrackBuiltInFX(trackData.id, fxPath, true)
                    : trackData.inputFXTypes?.[i] === "jsfx" || /\.jsfx$/i.test(fxPath)
                      ? nativeBridge.addTrackJSFX(trackData.id, fxPath, true)
                    : nativeBridge.addTrackInputFX(trackData.id, fxPath, false)
                ).catch((error) => {
                  if (isNAMRack) {
                    recordNAMProjectStateIssue(
                      "add",
                      `${trackData.name} / Input FX ${i + 1}`,
                      `${fxPath} threw while being added (${String(error)})`,
                    );
                  }
                  return false;
                });
                console.log(`[DEBUG LOAD]   addInputFX result: ${success}`);
                if (!success) retainUnavailableFX("input", i, fxPath);
                if (!isNAMRack && !success) pluginRestoreIssues.push(`${trackData.name} / Input FX ${i + 1}: ${fxPath} could not be loaded`);
                if (success) {
                  restoredInputIndices.set(i, restoredFxIndex);
                  if (trackData.inputFXStates && trackData.inputFXStates[i]) {
                    const stateResult = await nativeBridge
                      .setPluginState(trackData.id, restoredFxIndex, true, trackData.inputFXStates[i])
                      .catch(() => false);
                    console.log(`[DEBUG LOAD]   setPluginState(input) result: ${stateResult}`);
                    if (!stateResult) {
                      if (isNAMRack) recordNAMProjectStateIssue("restore", `${trackData.name} / Input FX ${i + 1}`, `${fxPath} was added, but its saved NAM state was rejected`);
                      retainUnavailableFX("input", i, fxPath);
                      restoredInputIndices.delete(i);
                      if (!await nativeBridge.removeTrackInputFX(trackData.id, restoredFxIndex)) throw new Error("Could not roll back rejected input FX recovery");
                      pluginRestoreIssues.push(`${trackData.name} / Input FX ${i + 1}: ${fxPath} state could not be restored; original data retained`);
                      continue;
                    }

                  }
                  if (!await verifyParameters("input", i, restoredFxIndex)) {
                    retainUnavailableFX("input", i, fxPath); restoredInputIndices.delete(i);
                    if (!await nativeBridge.removeTrackInputFX(trackData.id, restoredFxIndex)) throw new Error("Could not roll back incompatible input FX recovery");
                    pluginRestoreIssues.push(`${trackData.name} / Input FX ${i + 1}: saved automation parameters changed; original data retained`);
                    continue;
                  }
                  inputFxRestored++;
                } else if (isNAMRack && !namProjectStateIssues.some((issue) =>
                  issue.phase === "add" && issue.location === `${trackData.name} / Input FX ${i + 1}`)) {
                  recordNAMProjectStateIssue(
                    "add",
                    `${trackData.name} / Input FX ${i + 1}`,
                    `${fxPath} could not be added`,
                  );
                }
              }
            }

            let trackFxRestored = 0;
            let restoredBuiltInInstrumentFX = false;
            if (!bypassFX && trackData.trackFXPaths && trackData.trackFXPaths.length > 0) {
              set({ projectLoadingMessage: `Restoring track FX for ${trackData.name}...` });
              await new Promise((r) => setTimeout(r, 0));
              for (let i = 0; i < trackData.trackFXPaths.length; i++) {
                console.log(`[DEBUG LOAD]   Restoring track FX[${i}]: "${trackData.trackFXPaths[i]}"`);
                const fxPath = trackData.trackFXPaths[i];
                const isNAMRack = isNAMRackPluginPath(fxPath);
                const restoredFxIndex = trackFxRestored;
                restoredBuiltInInstrumentFX = restoredBuiltInInstrumentFX || isBuiltInInstrumentPluginPath(fxPath);
                const success = await (
                  isBuiltInPluginPath(fxPath)
                    ? nativeBridge.addTrackBuiltInFX(trackData.id, fxPath, false)
                    : trackData.trackFXTypes?.[i] === "jsfx" || /\.jsfx$/i.test(fxPath)
                      ? nativeBridge.addTrackJSFX(trackData.id, fxPath, false)
                    : nativeBridge.addTrackFX(trackData.id, fxPath, false)
                ).catch((error) => {
                  if (isNAMRack) {
                    recordNAMProjectStateIssue(
                      "add",
                      `${trackData.name} / Track FX ${i + 1}`,
                      `${fxPath} threw while being added (${String(error)})`,
                    );
                  }
                  return false;
                });
                console.log(`[DEBUG LOAD]   addTrackFX result: ${success}`);
                if (!success) retainUnavailableFX("track", i, fxPath);
                if (!isNAMRack && !success) pluginRestoreIssues.push(`${trackData.name} / Track FX ${i + 1}: ${fxPath} could not be loaded`);
                if (success) {
                  restoredTrackIndices.set(i, restoredFxIndex);
                  if (trackData.trackFXStates && trackData.trackFXStates[i]) {
                    const stateResult = await nativeBridge
                      .setPluginState(trackData.id, restoredFxIndex, false, trackData.trackFXStates[i])
                      .catch(() => false);
                    console.log(`[DEBUG LOAD]   setPluginState(track) result: ${stateResult}`);
                    if (!stateResult) {
                      if (isNAMRack) recordNAMProjectStateIssue("restore", `${trackData.name} / Track FX ${i + 1}`, `${fxPath} was added, but its saved NAM state was rejected`);
                      retainUnavailableFX("track", i, fxPath);
                      restoredTrackIndices.delete(i);
                      if (!await nativeBridge.removeTrackFX(trackData.id, restoredFxIndex)) throw new Error("Could not roll back rejected track FX recovery");
                      pluginRestoreIssues.push(`${trackData.name} / Track FX ${i + 1}: ${fxPath} state could not be restored; original data retained`);
                      continue;
                    }

                  }
                  if (!await verifyParameters("track", i, restoredFxIndex)) {
                    retainUnavailableFX("track", i, fxPath); restoredTrackIndices.delete(i);
                    if (!await nativeBridge.removeTrackFX(trackData.id, restoredFxIndex)) throw new Error("Could not roll back incompatible track FX recovery");
                    pluginRestoreIssues.push(`${trackData.name} / Track FX ${i + 1}: saved automation parameters changed; original data retained`);
                    continue;
                  }
                  const sourceTrackId = trackData.trackFXSidechains?.[i];
                  if (typeof sourceTrackId === "string" && sourceTrackId)
                    pendingSidechains.push({ trackId: trackData.id, fxIndex: restoredFxIndex, sourceTrackId });
                  trackFxRestored++;
                } else if (isNAMRack && !namProjectStateIssues.some((issue) =>
                  issue.phase === "add" && issue.location === `${trackData.name} / Track FX ${i + 1}`)) {
                  recordNAMProjectStateIssue(
                    "add",
                    `${trackData.name} / Track FX ${i + 1}`,
                    `${fxPath} could not be added`,
                  );
                }
              }
            }

            if (restoredBuiltInInstrumentFX) {
              await nativeBridge.setTrackType(trackData.id, "instrument").catch(logBridgeError("built-in instrument type restore"));
            }

            if (bypassFX) for (const chain of ["input", "track"]) {
              const paths = chain === "input" ? trackData.inputFXPaths : trackData.trackFXPaths;
              (paths ?? []).forEach((path, index) => retainUnavailableFX(chain, index, path));
            }
            for (const mapping of plannedMIDILearnMappings) {
              const index = (mapping.chainType === "input" ? restoredInputIndices : restoredTrackIndices).get(mapping.pluginIndex);
              if (index === undefined) continue;
              const parameters = restoredParameters[mapping.chainType].get(mapping.pluginIndex) ?? [];
              const parameter = resolveSavedMIDILearnParameter(mapping, parameters);
              if (parameter) restoredMIDILearnMappings.push({ ...mapping, pluginIndex: index, paramIndex: parameter.index });
              else pluginRestoreIssues.push(`${trackData.name}: MIDI CC ${mapping.ccNumber} parameter is unavailable; relearn this control`);
            }

            console.log(`[DEBUG LOAD] Track "${trackData.name}" restored ${inputFxRestored} input FX and ${trackFxRestored} track FX`);

            const restoredMidiClips = (trackData.midiClips || []).map((clip: any) =>
              normalizeMIDIClipLoopLength(clip),
            );
            const instrumentSafe = (trackData.automationSafeParams ?? []).filter(param => savedAutomationAddress(param)?.chain === "instrument");
            const needsInstrumentSchema = instrumentSafe.length || (trackData.automationLanes ?? []).some(lane => savedAutomationAddress(lane.param)?.chain === "instrument");
            let samplerLoaded = false;
            if (trackData.samplerSamplePath) {
              samplerLoaded = await nativeBridge.setTrackSamplerSample(trackData.id, trackData.samplerSamplePath, trackData.samplerRootNote ?? 60)
                .catch(logBridgeError("sampler load"));
            } else if (trackData.type === "instrument" && trackData.builtInInstrument) {
              const modeMap = { synth: 0, piano: 1, drums: 2 };
              await nativeBridge.setBuiltInPluginParam({ trackId: trackData.id, chain: "instrument", fxIndex: -1 },
                "instrumentMode", modeMap[trackData.builtInInstrument] ?? 0).catch(logBridgeError("built-in instrument load"));
            }
            const instrumentParameters = (restoredInstrumentPlugin || ["instrument", "midi"].includes(trackData.type)) && needsInstrumentSchema
              ? await nativeBridge.getPluginParameters(trackData.id, -1, false) : undefined;
            if (instrumentParameters) for (const kind of ["plugin", "builtin"])
              registerPluginParameterManifest(trackData.id, `${kind}_instrument_0_`, instrumentParameters, restoredInstrumentPlugin);
            if (instrumentSafe.some(param => !instrumentParameters || !resolveSavedSafeParameter(
              trackData.automationSafeParameters?.find(entry => entry.param === param) ?? { param,
                metadata: trackData.automationLanes?.find(lane => lane.param === param)?.metadata }, instrumentParameters)))
              throw new Error(`${trackData.name}: the saved instrument Automation Safe control is unavailable or changed meaning. Restore the compatible instrument before saving.`);
            const normalizedAutomationLanes = normalizeAutomationLanes(
              trackData.automationLanes || [],
              trackData,
              Number(data.automationCurveVersion) || 1,
            ).map(lane => {
              if (savedAutomationAddress(lane.param)?.chain === "instrument") {
                if (instrumentParameters) return validatePluginAutomationLane(trackData.id, lane);
                return { ...lane, param: `unavailable_parameter:${lane.param}`, unavailableParameter: {
                  param: lane.param, pluginPath: trackData.instrumentPlugin ?? "", parameterOnly: true } };
              }
              const address = /^(builtin|plugin)_(input|track)_(\d+)_(.+)$/.exec(lane.param);
              if (!address) return lane;
              const mapping = address[2] === "input" ? restoredInputIndices : restoredTrackIndices;
              const originalIndex = Number(address[3]);
              const restoredIndex = mapping.get(originalIndex);
              if (restoredIndex !== undefined) {
                const parameters = restoredParameters[address[2]].get(originalIndex);
                const parameter = parameters && resolveSavedPluginParameter(lane, parameters);
                const bound = { ...lane, param: `${address[1]}_${address[2]}_${restoredIndex}_${parameter && address[1] === "plugin" ? parameter.index : address[4]}`,
                  ...(lane.unavailableParameter ? { unavailableParameter: undefined, label: (recoveredAutomationLabel(lane) ?? lane.metadata?.name ?? lane.param).replace(/ \(parameter unavailable\)$/, "") } : {}) };
                if (parameters) {
                  const prefix = `${address[1]}_${address[2]}_${restoredIndex}_`;
                  const path = (address[2] === "input" ? trackData.inputFXPaths : trackData.trackFXPaths)?.[originalIndex] ?? "";
                  registerPluginParameterManifest(trackData.id, prefix, parameters, path);
                  return validatePluginAutomationLane(trackData.id, bound);
                }
                return bound;
              }
              const pluginPath = (address[2] === "input" ? trackData.inputFXPaths : trackData.trackFXPaths)?.[originalIndex] ?? "";
              return { ...lane, param: `unavailable:${lane.param}:${encodeURIComponent(pluginPath)}`,
                label: `${recoveredAutomationLabel(lane) || lane.metadata?.name || lane.param} (FX unavailable)`,
                unavailableParameter: { param: lane.param, pluginPath,
                  fxKey: unavailableFX.find(slot => slot.chain === address[2] && slot.originalIndex === originalIndex)?.key,
                  safe: (trackData.automationSafeParams ?? []).includes(lane.param) } };
            });
            const restoredSafeParams = (Array.isArray(trackData.automationSafeParams) ? trackData.automationSafeParams : [])
              .filter(param => typeof param === "string").flatMap(param => {
                const instrumentAddress = savedAutomationAddress(param);
                if (instrumentAddress?.chain === "instrument") {
                  const parameter = resolveSavedSafeParameter(trackData.automationSafeParameters?.find(entry => entry.param === param)
                    ?? { param, metadata: trackData.automationLanes?.find(lane => lane.param === param)?.metadata }, instrumentParameters);
                  return [parameter.automationId ?? `${instrumentAddress.prefix}${instrumentAddress.kind === "builtin" ? parameter.paramId : parameter.index}`];
                }
                const address = /^(builtin|plugin)_(input|track)_(\d+)_(.+)$/.exec(param);
                if (!address) return [param];
                const index = (address[2] === "input" ? restoredInputIndices : restoredTrackIndices).get(Number(address[3]));
                if (index === undefined) return [];
                const contract = trackData.automationSafeParameters?.find(entry => entry.param === param);
                const parameters = restoredParameters[address[2]].get(Number(address[3]));
                const parameter = parameters && resolveSavedSafeParameter(contract ?? { param }, parameters);
                return [`${address[1]}_${address[2]}_${index}_${parameter && address[1] === "plugin" ? parameter.index : address[4]}`];
              });
            const automationReadEnabled = deriveAutomationReadEnabled(trackData, normalizedAutomationLanes);
            const restoredAutomationLanes = resolveLoadedAutomationLaneModes(
              normalizedAutomationLanes,
              automationReadEnabled,
            );

            const aiMusicModelId = trackData.type === "ai"
              ? resolveAiMusicModelId(trackData.aiMusicModelId)
              : trackData.aiMusicModelId;
            const aiWorkflowId = trackData.type === "ai"
              ? (
                  normalizeWorkflowId(trackData.aiWorkflow)
                  ?? getDefaultWorkflowForModel(aiMusicModelId, "ai-track").id
                )
              : trackData.aiWorkflow;

            const frontendTrack: Track = {
              ...trackData,
              type: restoredInstrumentPlugin || restoredBuiltInInstrumentFX ? "instrument" : trackData.type,
              aiMusicModelId,
              aiWorkflow:
                trackData.type === "ai"
                  ? aiWorkflowId
                  : trackData.aiWorkflow,
              aiWorkflowParams:
                trackData.type === "ai"
                  ? normalizeWorkflowParams(
                      aiWorkflowId,
                      trackData.aiWorkflowParams || getDefaultWorkflowParams(aiWorkflowId, aiMusicModelId),
                      aiMusicModelId,
                    )
                  : trackData.aiWorkflowParams,
              aiGenerationState:
                trackData.type === "ai"
                  ? "idle"
                  : trackData.aiGenerationState,
              aiGenerationProgress:
                trackData.type === "ai"
                  ? 0
                  : trackData.aiGenerationProgress,
              aiGenerationError:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationError,
              aiGenerationPhase:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationPhase,
              aiGenerationMessage:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationMessage,
              aiGenerationBackend:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationBackend,
              aiGenerationElapsedMs:
                trackData.type === "ai"
                  ? 0
                  : trackData.aiGenerationElapsedMs,
              aiGenerationHeartbeatTs:
                trackData.type === "ai"
                  ? 0
                  : trackData.aiGenerationHeartbeatTs,
              aiGenerationPhaseProgress:
                trackData.type === "ai"
                  ? undefined
                  : trackData.aiGenerationPhaseProgress,
              aiGenerationEtaMs:
                trackData.type === "ai"
                  ? undefined
                  : trackData.aiGenerationEtaMs,
              aiGenerationRunMode:
                trackData.type === "ai"
                  ? undefined
                  : trackData.aiGenerationRunMode,
              aiGenerationRuntimeProfile:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationRuntimeProfile,
              aiGenerationLmModel:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationLmModel,
              aiGenerationStatusNote:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationStatusNote,
              aiGenerationFailureKind:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationFailureKind,
              aiGenerationSessionMode:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationSessionMode,
              aiGenerationWorkerExitCode:
                trackData.type === "ai"
                  ? 0
                  : trackData.aiGenerationWorkerExitCode,
              aiGenerationLastStdoutLine:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationLastStdoutLine,
              aiGenerationLastStderrLine:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationLastStderrLine,
              aiGenerationAttemptMode:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationAttemptMode,
              aiGenerationAttemptIndex:
                trackData.type === "ai"
                  ? 0
                  : trackData.aiGenerationAttemptIndex,
              aiGenerationProtocolVersion:
                trackData.type === "ai"
                  ? 0
                  : trackData.aiGenerationProtocolVersion,
              aiGenerationScriptVersion:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationScriptVersion,
              aiGenerationRequestId:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationRequestId,
              aiGenerationPriorFailure:
                trackData.type === "ai"
                  ? ""
                  : trackData.aiGenerationPriorFailure,
              aiGenerationLastProgressAgeMs:
                trackData.type === "ai"
                  ? 0
                  : trackData.aiGenerationLastProgressAgeMs,
              clips: trackData.clips || [],
              midiClips: restoredMidiClips,
              midiEffects: trackData.midiEffects || [],
              samplerSamplePath: trackData.samplerSamplePath || undefined,
              samplerRootNote: trackData.samplerRootNote ?? 60,
              samplerSourceType: trackData.samplerSourceType || (String(trackData.samplerSamplePath || "").toLowerCase().endsWith(".sf2") ? "soundfont" : undefined),
              builtInInstrument: trackData.builtInInstrument || undefined,
              midiPitchBendRangeUp: trackData.midiPitchBendRangeUp ?? 2,
              midiPitchBendRangeDown: trackData.midiPitchBendRangeDown ?? trackData.midiPitchBendRangeUp ?? 2,
              midiPitchBendRangeLinked: trackData.midiPitchBendRangeLinked ?? true,
              automationLanes: restoredAutomationLanes,
              inputFxCount: inputFxRestored,
              trackFxCount: trackFxRestored,
              automationSafeParams: restoredSafeParams,
              unavailableFX,
              showAutomation: Boolean(trackData.showAutomation),
              automationReadEnabled,
              automationWriteEnabled: false,
              automationTrimWriteEnabled: false,
              trimVolumeDB: normalizeTrimDB(trackData.trimVolumeDB),
              automationEnabled: automationReadEnabled,
              meterLevel: 0,
              peakLevel: 0,
              clipping: false,
              instrumentPlugin: restoredInstrumentPlugin,
              suspendedAutomationState: null,
            };

            if (frontendTrack.samplerSamplePath) {
              if (samplerLoaded && !frontendTrack.instrumentPlugin) {
                frontendTrack.type = "instrument";
              }
            }

            if (
              frontendTrack.type === "midi" ||
              frontendTrack.type === "instrument" ||
              (frontendTrack.midiClips || []).length > 0
            ) {
              await syncTrackMIDIClipsToBackend(frontendTrack.id, frontendTrack.midiClips || [], frontendTrack.midiEffects || [])
                .catch(logBridgeError("midi load sync"));
            }

            set((state) => ({ tracks: [...state.tracks, frontendTrack] }));
            notifyFXChainChanged({ trackId: frontendTrack.id, chainType: "input" });
            notifyFXChainChanged({ trackId: frontendTrack.id, chainType: "track" });
            notifyInstrumentChanged({ trackId: frontendTrack.id });
            for (const lane of frontendTrack.automationLanes) {
              if (!parseSendAutomationParamId(lane.param)) syncAutomationLaneToBackend(frontendTrack.id, lane);
            }
          } catch (trackError) {
            console.error(`[DEBUG LOAD] Failed to load track "${trackData.name}"`, trackError);
            set({ projectRestoreError: String(trackError) });
            throw trackError;
          }
        }

        // Restore graph edges only after all destination tracks and their processors exist.
        for (const track of get().tracks) {
          await nativeBridge.setTrackMasterSendEnabled(track.id, track.masterSendEnabled !== false)
            .catch(logBridgeError("restore master send"));
          try {
            if (!await nativeBridge.replaceTrackSends(track.id, track.sends ?? []))
              throw new Error("complete send configuration rejected");
            for (const lane of track.automationLanes)
              if (parseSendAutomationParamId(lane.param)) await syncAutomationLaneToBackend(track.id, lane);
          } catch (error) {
            // Native rejection leaves this newly-created track with no sends.
            // Reflect that safe state; the saved file remains available to retry.
            set(state => ({ tracks: state.tracks.map(item => item.id === track.id
              ? { ...item, sends: [] } : item) }));
            pluginRestoreIssues.push(`Sends from ${track.name} could not be restored: ${String(error)}`);
          }
        }

        for (const route of pendingSidechains) {
          const restored = await nativeBridge.setSidechainSource(route.trackId, route.fxIndex, route.sourceTrackId).catch(() => false);
          if (!restored) pluginRestoreIssues.push(`Sidechain for ${route.trackId} / FX ${route.fxIndex + 1}: source ${route.sourceTrackId} could not be restored`);
        }
        set({ projectLoadingMessage: "Verifying MIDI signal path..." });
        await verifyAndRepairLoadedMIDISync(get);

        let restoredMasterFxCount = 0;
        const unavailableFXStages = {};
        const stagePlan = (chain, saved) => {
          const pending = data.unavailableFXStages?.[chain];
          if (!Array.isArray(pending)) return saved;
          const keys = new Set(pending.map(slot => slot.automationKey));
          return [...pending, ...(Array.isArray(saved) ? saved.filter(slot => !keys.has(slot.automationKey)) : [])];
        };
        const legacyMasterStage = Array.isArray(data.masterFXPaths) ? data.masterFXPaths.map((pluginPath, index) => {
          const builtIn = isBuiltInPluginPath(pluginPath), script = /\.jsfx$/i.test(pluginPath);
          return { automationKey: crypto.randomUUID(), name: pluginPath.split(/[\\/]/).pop() || pluginPath,
            type: builtIn ? "builtin" : script ? "jsfx" : "plugin", pluginPath,
            pluginFormat: builtIn ? "Built-in" : script ? "JSFX" : /\.vst3$/i.test(pluginPath) ? "VST3" : /\.clap$/i.test(pluginPath) ? "CLAP" : "Plugin",
            state: typeof data.masterFXStates?.[index] === "string" ? data.masterFXStates[index] : "", bypassed: false, forceFloat: false };
        }) : undefined;
        const masterStagePlan = stagePlan("master", data.masterFXStageState ?? legacyMasterStage);
        const monitorStagePlan = stagePlan("monitor", data.monitorFXStageState);
        const restoredStageChains = [];
        if (Array.isArray(masterStagePlan)) {
          const restored = !bypassFX && await nativeBridge.setFXStageState("master", masterStagePlan).catch(() => false);
          if (restored) { restoredMasterFxCount = masterStagePlan.length; restoredStageChains.push("master"); }
          else if (masterStagePlan.length) {
            unavailableFXStages.master = masterStagePlan;
            pluginRestoreIssues.push("The saved master FX stage could not be restored; its settings and envelopes are retained for recovery.");
          }
        }

        if (Array.isArray(monitorStagePlan)) {
          const restored = !bypassFX && await nativeBridge.setFXStageState("monitor", monitorStagePlan).catch(() => false);
          if (restored) restoredStageChains.push("monitor");
          if (!restored && monitorStagePlan.length) {
            unavailableFXStages.monitor = monitorStagePlan;
            pluginRestoreIssues.push("The saved monitor FX stage could not be restored; its settings and envelopes are retained for recovery.");
          }
        }
        set({ masterFxCount: restoredMasterFxCount, unavailableFXStages });
        let stageSafe = [...(get().masterAutomationSafeParams ?? [])];
        for (const chain of restoredStageChains) {
          const slots = await (chain === "master" ? nativeBridge.getMasterFX() : nativeBridge.getMonitoringFX());
          const schemas = await Promise.all(slots.map(slot => nativeBridge.getPluginParameters(chain, slot.index, false)));
          schemas.forEach((parameters, index) => {
            const prefixes = new Set(parameters.map(parameter => parameter.automationId && savedAutomationAddress(parameter.automationId)?.prefix).filter(Boolean));
            for (const prefix of prefixes) registerPluginParameterManifest("master", prefix, parameters, slots[index]?.pluginPath ?? "");
          });
          stageSafe = stageSafe.map(param => {
            const address = savedAutomationAddress(param);
            if (address?.chain !== chain) return param;
            const schema = schemas.find(parameters => parameters.some(parameter => parameter.automationId?.startsWith(address.prefix)));
            const contract = get().masterAutomationSafeParameters?.find(entry => entry.param === param)
              ?? { param, metadata: get().masterAutomationLanes.find(lane => lane.param === param)?.metadata };
            const parameter = schema && resolveSavedSafeParameter(contract, schema);
            if (!parameter) throw new Error(`The saved ${chain} Automation Safe control is unavailable or changed meaning. Restore compatible FX before saving.`);
            return parameter.automationId ?? `${address.prefix}${address.kind === "builtin" ? parameter.paramId : parameter.index}`;
          });
        }
        set({ masterAutomationSafeParams: stageSafe, masterAutomationLanes: get().masterAutomationLanes.map(lane => validatePluginAutomationLane("master", lane)) });
        notifyFXChainChanged({ trackId: "master", chainType: "master" });
        notifyFXChainChanged({ trackId: "master", chainType: "monitor" });
        for (const lane of get().masterAutomationLanes) {
          syncAutomationLaneToBackend("master", lane);
        }

        if (data.undoHistory) {
          commandManager.deserialize(data.undoHistory);
          set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        }

        set((ctx) => {
          const newRecent = recoveryCopy ? ctx.recentProjects : [
            path,
            ...ctx.recentProjects.filter((p) => p !== path),
          ].slice(0, 10);

          return {
            projectPath: recoveryCopy ? null : path,
            isModified: recoveryCopy,
            recentProjects: newRecent,
          };
        });
        persistRecentProjects(get().recentProjects);

        try {
          if (!await nativeBridge.setMIDILearnMappings(restoredMIDILearnMappings))
            throw new Error("The native host rejected the saved MIDI Learn controls");
        } catch (error) {
          set({ projectRestoreError: `MIDI Learn restoration failed: ${String(error)}` });
          throw error;
        }

        set({ projectLoadingMessage: "Checking media files..." });
        await new Promise((r) => setTimeout(r, 0));
        const missingFiles: MissingMediaEntry[] = [];
        const checkedPaths = new Map<string, boolean>();
        for (const track of get().tracks) {
          for (const clip of track.clips) {
            if (!clip.filePath) continue;
            if (!checkedPaths.has(clip.filePath)) {
              const exists = await nativeBridge.fileExists(clip.filePath).catch(() => true);
              checkedPaths.set(clip.filePath, exists);
            }
            if (!checkedPaths.get(clip.filePath)) {
              const existing = missingFiles.find((entry) => entry.kind === "media" && entry.path === clip.filePath);
              if (existing) {
                existing.clipIds.push(clip.id);
              } else {
                missingFiles.push({ path: clip.filePath, kind: "media", clipIds: [clip.id] });
              }
            }
          }
        }
        const missingNAMAssets = await collectRestoredMissingNAMAssets(data);
        missingFiles.push(...missingNAMAssets);
        if (missingFiles.length > 0) {
          set({ showMissingMedia: true, missingMediaFiles: missingFiles });
        }

        set({ isProjectLoading: false, projectLoadingMessage: "" });
        if (pluginRestoreIssues.length > 0) {
          get().showToast(`Project opened with plugin errors: ${pluginRestoreIssues.join("; ")}${namProjectStateIssues.length ? "; " + summarizeNAMProjectStateIssues(namProjectStateIssues) : ""}`, "error");
        } else if (namProjectStateIssues.length > 0) {
          get().showToast(summarizeNAMProjectStateIssues(namProjectStateIssues), "error");
        } else if (missingNAMAssets.length > 0) {
          get().showToast(
            `Project loaded with ${missingNAMAssets.length} missing NAM resource file${missingNAMAssets.length === 1 ? "" : "s"}. Relink or reinstall them in Missing Media.`,
            "error",
          );
        } else {
          get().showToast(`Loaded project "${data.projectName || "Untitled Project"}"`, "success");
        }
        return true;
      } catch (e) {
        console.error("[loadProject]", e);
        set({ isProjectLoading: false, projectLoadingMessage: "", projectRestoreError: get().projectRestoreError || String(e) });
        get().showToast("Failed to load project: " + String(e), "error");
        return false;
      }
    },


    saveAsTemplate: (name: string) => {
      const state = get();
      // Capture track layout without clips
      const templateTracks = state.tracks.map((t) => ({
        ...t,
        clips: [],        // No clips in templates
        midiClips: [],     // No MIDI clips
        takes: [],         // No takes
        automationLanes: serializeAutomationLanesForProject(t.automationLanes),
        automationReadEnabled: deriveAutomationReadEnabled(t, t.automationLanes || []),
        automationWriteEnabled: false,
        automationTrimWriteEnabled: false,
        trimVolumeDB: normalizeTrimDB(t.trimVolumeDB),
        automationEnabled: deriveAutomationReadEnabled(t, t.automationLanes || []),
        meterLevel: 0,
        peakLevel: 0,
        clipping: false,
      }));

      const template: ProjectTemplate = {
        name,
        automationCurveVersion: AUTOMATION_CURVE_VERSION,
        tracks: templateTracks,
        masterVolume: state.masterVolume,
        masterPan: state.masterPan,
    masterTrimVolumeDB: normalizeTrimDB(state.masterTrimVolumeDB),
        tempo: state.transport.tempo,
        timeSignature: { ...state.timeSignature },
      };

      set((s) => {
        const updated = [...s.projectTemplates, template];
        localStorage.setItem("openstudio_projectTemplates", JSON.stringify(updated));
        return { projectTemplates: updated };
      });
      get().showToast(`Template "${name}" saved`, "success");
    },

    loadTemplate: (index: number) => {
      const state = get();
      const template = state.projectTemplates[index];
      if (!template) return;

      // Capture old state for undo
      const oldTracks = JSON.parse(JSON.stringify(state.tracks)) as Track[];
      const oldMasterVolume = state.masterVolume;
      const oldMasterPan = state.masterPan;
      const oldTempo = state.transport.tempo;
      const oldTimeSig = { ...state.timeSignature };

      const command: Command = {
        type: "LOAD_TEMPLATE",
        description: `Load template "${template.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          // Clear current project
          if (!(await get().newProject())) {
            return;
          }

          // Restore global settings from template
          get().setTempo(template.tempo);
          get().setTimeSignature(template.timeSignature.numerator, template.timeSignature.denominator);
          get().setMasterVolume(template.masterVolume);
          get().setMasterPan(template.masterPan);

          // Add template tracks (skip undo for individual tracks during template load)
          for (const trackData of template.tracks) {
            const newId = crypto.randomUUID();
            const normalizedAutomationLanes = normalizeAutomationLanes(
              trackData.automationLanes || [],
              trackData,
              Number(template.automationCurveVersion) || 1,
            );
            const automationReadEnabled = deriveAutomationReadEnabled(trackData, normalizedAutomationLanes);
            const newTrack = {
              ...trackData,
              id: newId,
              clips: [],
              midiClips: [],
              takes: [],
              automationLanes: resolveLoadedAutomationLaneModes(
                normalizedAutomationLanes,
                automationReadEnabled,
              ),
              automationReadEnabled,
              automationWriteEnabled: false,
              automationTrimWriteEnabled: false,
              trimVolumeDB: normalizeTrimDB(trackData.trimVolumeDB),
              automationEnabled: automationReadEnabled,
              meterLevel: 0,
              peakLevel: 0,
              clipping: false,
            };
            set((s) => ({ tracks: [...s.tracks, newTrack] }));
            nativeBridge.addTrack(newId, newTrack.type).catch(logBridgeError("sync"));
            // Sync track properties to backend
            nativeBridge.setTrackVolume(newId, trackData.volumeDB).catch(logBridgeError("sync"));
            nativeBridge.setTrackPan(newId, trackData.pan).catch(logBridgeError("sync"));
            nativeBridge.setAutomationTrimValue(newId, normalizeTrimDB(trackData.trimVolumeDB)).catch(logBridgeError("sync"));
            if (trackData.muted) nativeBridge.setTrackMute(newId, true).catch(logBridgeError("sync"));
            void nativeBridge.setTrackSoloSafe(newId, !!trackData.soloSafe);
            if (trackData.soloed) nativeBridge.setTrackSolo(newId, true).catch(logBridgeError("sync"));
          }

          set({ isModified: true });
          get().showToast(`Loaded template "${template.name}"`, "success");
        },
        undo: async () => {
          // Clear current project
          const currentTracks = get().tracks;
          for (let i = currentTracks.length - 1; i >= 0; i--) {
            await nativeBridge.removeTrack(currentTracks[i].id).catch(logBridgeError("sync"));
          }

          // Restore old state
          set({
            tracks: oldTracks,
            masterVolume: oldMasterVolume,
            masterPan: oldMasterPan,
            transport: { ...get().transport, tempo: oldTempo },
            timeSignature: oldTimeSig,
          });

          // Sync old tracks to backend
          for (const t of oldTracks) {
            await nativeBridge.addTrack(t.id, t.type).catch(logBridgeError("sync"));
            nativeBridge.setTrackVolume(t.id, t.volumeDB).catch(logBridgeError("sync"));
            nativeBridge.setTrackPan(t.id, t.pan).catch(logBridgeError("sync"));
          }
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    deleteTemplate: (index: number) => {
      set((s) => {
        const updated = s.projectTemplates.filter((_, i) => i !== index);
        localStorage.setItem("openstudio_projectTemplates", JSON.stringify(updated));
        return { projectTemplates: updated };
      });
    },

    // toggleProjectCompare → store/actions/uiState.ts

    compareWithSavedProject: async () => {
      const state = get();
      const filePath = state.projectPath;
      if (!filePath) {
        set({ projectCompareData: { tracksDiff: [], clipsDiff: [], settingsDiff: [{ field: "Project", oldValue: "-", newValue: "Project has not been saved yet" }] } });
        set({ showProjectCompare: true });
        return;
      }

      try {
        const json = await nativeBridge.loadProjectFromFile(filePath);
        if (!json) {
          get().showToast("Could not read saved project file", "error");
          return;
        }
        const saved = JSON.parse(json);

        // --- Settings diff ---
        const settingsDiff: Array<{ field: string; oldValue: string; newValue: string }> = [];
        if (saved.projectName !== state.projectName) {
          settingsDiff.push({ field: "Project Name", oldValue: saved.projectName || "", newValue: state.projectName });
        }
        if ((saved.tempo || 120) !== state.transport.tempo) {
          settingsDiff.push({ field: "Tempo (BPM)", oldValue: String(saved.tempo || 120), newValue: String(state.transport.tempo) });
        }
        if (saved.timeSignature) {
          const savedTS = `${saved.timeSignature.numerator}/${saved.timeSignature.denominator}`;
          const currentTS = `${state.timeSignature.numerator}/${state.timeSignature.denominator}`;
          if (savedTS !== currentTS) {
            settingsDiff.push({ field: "Time Signature", oldValue: savedTS, newValue: currentTS });
          }
        }
        if ((saved.masterVolume ?? 1.0) !== state.masterVolume) {
          settingsDiff.push({ field: "Master Volume", oldValue: String(saved.masterVolume ?? 1.0), newValue: String(state.masterVolume) });
        }
        if ((saved.masterPan ?? 0.0) !== state.masterPan) {
          settingsDiff.push({ field: "Master Pan", oldValue: String(saved.masterPan ?? 0.0), newValue: String(state.masterPan) });
        }
        if ((saved.projectSampleRate || 44100) !== state.projectSampleRate) {
          settingsDiff.push({ field: "Sample Rate", oldValue: String(saved.projectSampleRate || 44100), newValue: String(state.projectSampleRate) });
        }
        if ((saved.projectBitDepth || 24) !== state.projectBitDepth) {
          settingsDiff.push({ field: "Bit Depth", oldValue: String(saved.projectBitDepth || 24), newValue: String(state.projectBitDepth) });
        }
        if ((saved.processingPrecision || "float32") !== state.processingPrecision) {
          settingsDiff.push({ field: "Processing Precision", oldValue: String(saved.processingPrecision || "float32"), newValue: String(state.processingPrecision) });
        }

        // --- Tracks diff ---
        const savedTrackMap = new Map<string, any>();
        for (const t of saved.tracks || []) savedTrackMap.set(t.id, t);
        const currentTrackMap = new Map<string, any>();
        for (const t of state.tracks) currentTrackMap.set(t.id, t);

        const tracksDiff: Array<{ type: "added" | "removed" | "modified"; id: string; name: string; details?: string }> = [];

        // Added tracks (in current but not saved)
        for (const t of state.tracks) {
          if (!savedTrackMap.has(t.id)) {
            tracksDiff.push({ type: "added", id: t.id, name: t.name });
          }
        }
        // Removed tracks (in saved but not current)
        for (const t of saved.tracks || []) {
          if (!currentTrackMap.has(t.id)) {
            tracksDiff.push({ type: "removed", id: t.id, name: t.name });
          }
        }
        // Modified tracks
        for (const t of state.tracks) {
          const st = savedTrackMap.get(t.id);
          if (!st) continue;
          const changes: string[] = [];
          if (st.name !== t.name) changes.push(`renamed: "${st.name}" -> "${t.name}"`);
          if (st.volumeDB !== t.volumeDB) changes.push(`volume: ${st.volumeDB}dB -> ${t.volumeDB}dB`);
          if (st.pan !== t.pan) changes.push(`pan: ${st.pan} -> ${t.pan}`);
          if (st.muted !== t.muted) changes.push(`muted: ${st.muted} -> ${t.muted}`);
          if (st.soloed !== t.soloed) changes.push(`soloed: ${st.soloed} -> ${t.soloed}`);
          if (changes.length > 0) {
            tracksDiff.push({ type: "modified", id: t.id, name: t.name, details: changes.join(", ") });
          }
        }

        // --- Clips diff ---
        const clipsDiff: Array<{ type: "added" | "removed" | "modified"; id: string; name: string; trackName: string; details?: string }> = [];

        // Build clip maps: clipId -> { clip, trackName }
        const savedClipMap = new Map<string, { clip: any; trackName: string }>();
        for (const t of saved.tracks || []) {
          for (const c of t.clips || []) {
            savedClipMap.set(c.id, { clip: c, trackName: t.name });
          }
        }
        const currentClipMap = new Map<string, { clip: any; trackName: string }>();
        for (const t of state.tracks) {
          for (const c of t.clips || []) {
            currentClipMap.set(c.id, { clip: c, trackName: t.name });
          }
        }

        // Added clips
        for (const [id, { clip, trackName }] of currentClipMap) {
          if (!savedClipMap.has(id)) {
            clipsDiff.push({ type: "added", id, name: clip.name || clip.filePath?.split(/[/\\]/).pop() || id, trackName });
          }
        }
        // Removed clips
        for (const [id, { clip, trackName }] of savedClipMap) {
          if (!currentClipMap.has(id)) {
            clipsDiff.push({ type: "removed", id, name: clip.name || clip.filePath?.split(/[/\\]/).pop() || id, trackName });
          }
        }
        // Modified clips
        for (const [id, { clip: cur, trackName }] of currentClipMap) {
          const saved = savedClipMap.get(id);
          if (!saved) continue;
          const sc = saved.clip;
          const changes: string[] = [];
          if (Math.abs((sc.startTime || 0) - (cur.startTime || 0)) > 0.001) changes.push(`moved: ${sc.startTime?.toFixed(3)}s -> ${cur.startTime?.toFixed(3)}s`);
          if (Math.abs((sc.duration || 0) - (cur.duration || 0)) > 0.001) changes.push(`duration: ${sc.duration?.toFixed(3)}s -> ${cur.duration?.toFixed(3)}s`);
          if ((sc.volumeDB || 0) !== (cur.volumeDB || 0)) changes.push(`volume: ${sc.volumeDB || 0}dB -> ${cur.volumeDB || 0}dB`);
          if (sc.muted !== cur.muted) changes.push(`muted: ${sc.muted} -> ${cur.muted}`);
          if (changes.length > 0) {
            clipsDiff.push({ type: "modified", id, name: cur.name || cur.filePath?.split(/[/\\]/).pop() || id, trackName, details: changes.join(", ") });
          }
        }

        set({ projectCompareData: { tracksDiff, clipsDiff, settingsDiff }, showProjectCompare: true });
      } catch (e) {
        console.error("[compareWithSavedProject]", e);
        get().showToast("Failed to compare project: " + String(e), "error");
      }
    },

    // ========== Collaborative Metadata ==========
    setProjectAuthor: (author) => {
      set({ projectAuthor: author, isModified: true });
    },
    addRevisionNote: (note) => {
      set((s) => ({
        projectRevisionNotes: [...s.projectRevisionNotes, { date: new Date().toISOString(), note }],
        isModified: true,
      }));
    },
    deleteRevisionNote: (index) => {
      set((s) => ({
        projectRevisionNotes: s.projectRevisionNotes.filter((_, i) => i !== index),
        isModified: true,
      }));
    },
});

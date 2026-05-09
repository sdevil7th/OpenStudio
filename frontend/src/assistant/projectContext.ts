import { useDAWStore } from "../store/useDAWStore";
import { getRegisteredActions } from "../store/actionRegistry";
import { nativeBridge } from "../services/NativeBridge";

const MAX_TRACKS = 24;
const MAX_CLIPS_PER_TRACK = 16;
const MAX_ACTIONS = 220;
const MAX_PLUGINS = 80;

interface AssistantContextOptions {
  recentConversation?: Array<{ role: string; text: string }>;
  lastExecutionResult?: unknown;
}

function roundSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : 0;
}

function actionRisk(category: string, id: string) {
  const key = `${category} ${id}`.toLowerCase();
  if (/(delete|remove|cut|paste|insert|new|record|render|save|load|open|import|export|track|clip|fx|theme|settings|generate)/.test(key)) {
    return "project";
  }
  if (/(toggle|view|show|hide|open|close|select|navigate|zoom)/.test(key)) {
    return "ui";
  }
  return "read";
}

async function buildPluginContext(selectedTrackIds: string[]) {
  const [availablePlugins, builtIns, s13fx] = await Promise.all([
    nativeBridge.getAvailablePlugins().catch(() => []),
    nativeBridge.getAvailableBuiltInFX().catch(() => []),
    nativeBridge.getAvailableS13FX().catch(() => []),
  ]);

  const currentFxChains = await Promise.all(
    selectedTrackIds.slice(0, 4).map(async (trackId) => ({
      trackId,
      inputFx: await nativeBridge.getTrackInputFX(trackId).catch(() => []),
      trackFx: await nativeBridge.getTrackFX(trackId).catch(() => []),
    })),
  );

  return {
    pluginCatalog: {
      availablePlugins: availablePlugins.slice(0, MAX_PLUGINS).map((plugin: any) => ({
        name: String(plugin.name ?? ""),
        manufacturer: String(plugin.manufacturer ?? ""),
        category: String(plugin.category ?? ""),
        pluginFormatName: String(plugin.pluginFormatName ?? ""),
        fileOrIdentifier: String(plugin.fileOrIdentifier ?? ""),
        isInstrument: Boolean(plugin.isInstrument),
      })),
      builtIns: builtIns.slice(0, 40).map((plugin) => ({
        name: plugin.name,
        category: plugin.category,
      })),
      s13fx: s13fx.slice(0, 40).map((plugin: any) => ({
        name: String(plugin.name ?? ""),
        author: String(plugin.author ?? ""),
        fileOrIdentifier: String(plugin.fileOrIdentifier ?? plugin.path ?? ""),
      })),
    },
    currentFxChains,
  };
}

export async function buildAssistantProjectContext(options: AssistantContextOptions = {}) {
  const state = useDAWStore.getState();
  const selectedClipIds = [...state.selectedClipIds];
  const selectedTrackIds = [...state.selectedTrackIds];
  const actionCatalog = getRegisteredActions().slice(0, MAX_ACTIONS).map((action) => ({
    id: action.id,
    name: action.name,
    category: action.category,
    shortcut: action.shortcut,
    shortcutScope: action.shortcutScope,
    risk: actionRisk(action.category, action.id),
    available: action.canHandleShortcut ? action.canHandleShortcut() : true,
  }));

  const tracks = state.tracks.slice(0, MAX_TRACKS).map((track) => ({
    id: track.id,
    name: track.name,
    type: track.type,
    muted: track.muted,
    soloed: track.soloed,
    armed: track.armed,
    volume: track.volume,
    pan: track.pan,
    aiWorkflow: track.aiWorkflow,
    selected: selectedTrackIds.includes(track.id),
    clips: track.clips.slice(0, MAX_CLIPS_PER_TRACK).map((clip) => ({
      id: clip.id,
      name: clip.name,
      filePath: clip.filePath,
      startTime: roundSeconds(clip.startTime),
      duration: roundSeconds(clip.duration),
      offset: roundSeconds(clip.offset),
      muted: Boolean(clip.muted),
      selected: selectedClipIds.includes(clip.id),
    })),
  }));
  const pluginContext = await buildPluginContext(selectedTrackIds);

  return {
    app: "OpenStudio",
    schemaVersion: 1,
    tempo: state.transport.tempo,
    timeSignature: state.timeSignature,
    currentTime: roundSeconds(state.transport.currentTime),
    selectedTrackIds,
    selectedClipIds,
    trackCount: state.tracks.length,
    tracks,
    aiToolsStatus: state.aiToolsStatus,
    actionCatalog,
    ...pluginContext,
    recentConversation: options.recentConversation ?? [],
    lastExecutionResult: options.lastExecutionResult ?? null,
  };
}

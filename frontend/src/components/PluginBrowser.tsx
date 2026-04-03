import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Waves,
  Timer,
  SlidersHorizontal,
  Gauge,
  Zap,
  Activity,
  AudioWaveform,
  Music,
  Box,
  Code,
  Star,
  FolderOpen,
} from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import {
  getFXChainSlots,
  notifyFXChainChanged,
  notifyInstrumentChanged,
  waitForFXChainLength,
  waitForInstrumentPlugin,
} from "../utils/fxChain";
import { Button, Input, Select } from "./ui";

// Persist favorites in localStorage
const FAVORITES_KEY = "studio13_plugin_favorites";
function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
function saveFavorites(favs: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]));
}

interface Plugin {
  name: string;
  manufacturer: string;
  category: string;
  fileOrIdentifier: string;
  isInstrument: boolean;
  snapshot?: string; // base64 data URL from C++ snapshot lookup
  pluginFormat?: string;
  pluginFormatName?: string;
  pluginType?: "vst3" | "lv2" | "clap" | "s13fx" | "builtin"; // Plugin format type
  producesMidi?: boolean;
  isMidiEffect?: boolean;
  supportsDoublePrecision?: boolean;
}

type PluginCapabilityPatch = Pick<
  Plugin,
  | "pluginType"
  | "pluginFormat"
  | "isInstrument"
  | "producesMidi"
  | "isMidiEffect"
  | "supportsDoublePrecision"
>;

const pluginCatalogCache: {
  plugins: Plugin[] | null;
  loadPromise: Promise<Plugin[]> | null;
  capabilityPromise: Promise<Plugin[]> | null;
  capabilityPatches: Map<string, PluginCapabilityPatch>;
} = {
  plugins: null,
  loadPromise: null,
  capabilityPromise: null,
  capabilityPatches: new Map(),
};

function applyCachedCapabilities(plugin: Plugin): Plugin {
  const cached = pluginCatalogCache.capabilityPatches.get(plugin.fileOrIdentifier);
  return cached ? { ...plugin, ...cached } : plugin;
}

async function fetchPluginCatalog(): Promise<Plugin[]> {
  if (pluginCatalogCache.plugins) {
    return pluginCatalogCache.plugins;
  }

  if (pluginCatalogCache.loadPromise) {
    return pluginCatalogCache.loadPromise;
  }

  pluginCatalogCache.loadPromise = (async () => {
    const pluginList = await nativeBridge.getAvailablePlugins();
    const hostPlugins: Plugin[] = pluginList.map((p: any) => {
      const fmt = (p.pluginFormat || p.pluginFormatName || "").toLowerCase();
      let pluginType: Plugin["pluginType"] = "vst3";
      if (fmt.includes("lv2")) pluginType = "lv2";
      else if (fmt.includes("clap")) pluginType = "clap";
      return applyCachedCapabilities({ ...p, pluginType });
    });

    let s13fxPlugins: Plugin[] = [];
    try {
      const scripts = await nativeBridge.getAvailableS13FX();
      s13fxPlugins = scripts.map((s: any) => ({
        name: s.name,
        manufacturer: s.author || "S13FX",
        category: s.tags?.[0] || "Script",
        fileOrIdentifier: s.filePath,
        isInstrument: false,
        pluginType: "s13fx" as const,
      }));
    } catch {
      // S13FX not available, that's OK
    }

    const combined = [...hostPlugins, ...s13fxPlugins];
    pluginCatalogCache.plugins = combined;
    return combined;
  })();

  try {
    return await pluginCatalogCache.loadPromise;
  } finally {
    pluginCatalogCache.loadPromise = null;
  }
}

async function hydratePluginCapabilities(catalog: Plugin[]): Promise<Plugin[]> {
  const hostPluginsNeedingCapabilities = catalog.filter(
    (plugin) =>
      plugin.pluginType !== "s13fx" &&
      !pluginCatalogCache.capabilityPatches.has(plugin.fileOrIdentifier),
  );

  if (hostPluginsNeedingCapabilities.length === 0) {
    return pluginCatalogCache.plugins ?? catalog;
  }

  if (pluginCatalogCache.capabilityPromise) {
    return pluginCatalogCache.capabilityPromise;
  }

  pluginCatalogCache.capabilityPromise = (async () => {
    await Promise.all(
      hostPluginsNeedingCapabilities.map(async (plugin) => {
        try {
          const capabilities = await nativeBridge.getPluginCapabilities(
            plugin.fileOrIdentifier,
          );

          if (!capabilities?.success) {
            return;
          }

          const fmt = (
            capabilities.pluginFormat ||
            plugin.pluginFormat ||
            plugin.pluginFormatName ||
            ""
          ).toLowerCase();

          let pluginType: Plugin["pluginType"] = plugin.pluginType ?? "vst3";
          if (fmt.includes("lv2")) pluginType = "lv2";
          else if (fmt.includes("clap")) pluginType = "clap";
          else if (fmt.includes("builtin")) pluginType = "builtin";
          else pluginType = "vst3";

          pluginCatalogCache.capabilityPatches.set(plugin.fileOrIdentifier, {
            pluginType,
            pluginFormat: capabilities.pluginFormat || plugin.pluginFormat,
            isInstrument:
              typeof capabilities.isInstrument === "boolean"
                ? capabilities.isInstrument
                : plugin.isInstrument,
            producesMidi:
              typeof capabilities.producesMidi === "boolean"
                ? capabilities.producesMidi
                : plugin.producesMidi,
            isMidiEffect:
              typeof capabilities.isMidiEffect === "boolean"
                ? capabilities.isMidiEffect
                : plugin.isMidiEffect,
            supportsDoublePrecision:
              typeof capabilities.supportsDoublePrecision === "boolean"
                ? capabilities.supportsDoublePrecision
                : plugin.supportsDoublePrecision,
          });
        } catch {
          // Ignore capability failures and keep cached scan metadata.
        }
      }),
    );

    const mergedCatalog = (pluginCatalogCache.plugins ?? catalog).map(applyCachedCapabilities);
    pluginCatalogCache.plugins = mergedCatalog;
    return mergedCatalog;
  })();

  try {
    return await pluginCatalogCache.capabilityPromise;
  } finally {
    pluginCatalogCache.capabilityPromise = null;
  }
}

function invalidatePluginCatalogCache() {
  pluginCatalogCache.plugins = null;
  pluginCatalogCache.loadPromise = null;
  pluginCatalogCache.capabilityPromise = null;
  pluginCatalogCache.capabilityPatches.clear();
}

// Map VST3 category substrings to Lucide icons and colors
const CATEGORY_ICON_MAP: Array<{
  match: string;
  Icon: React.ComponentType<{ size?: number }>;
  color: string;
}> = [
  { match: "Reverb", Icon: Waves, color: "#3b82f6" },
  { match: "Delay", Icon: Timer, color: "#8b5cf6" },
  { match: "EQ", Icon: SlidersHorizontal, color: "#22c55e" },
  { match: "Dynamics", Icon: Gauge, color: "#f59e0b" },
  { match: "Compressor", Icon: Gauge, color: "#f59e0b" },
  { match: "Limiter", Icon: Gauge, color: "#f59e0b" },
  { match: "Distortion", Icon: Zap, color: "#ef4444" },
  { match: "Modulation", Icon: Activity, color: "#06b6d4" },
  { match: "Chorus", Icon: Activity, color: "#06b6d4" },
  { match: "Flanger", Icon: Activity, color: "#06b6d4" },
  { match: "Phaser", Icon: Activity, color: "#06b6d4" },
  { match: "Synth", Icon: AudioWaveform, color: "#a855f7" },
  { match: "Instrument", Icon: Music, color: "#ec4899" },
];

function getCategoryIcon(category: string) {
  const lowerCat = category.toLowerCase();
  for (const entry of CATEGORY_ICON_MAP) {
    if (lowerCat.includes(entry.match.toLowerCase())) {
      return entry;
    }
  }
  return { match: "Other", Icon: Box, color: "#6b7280" };
}

// ---- Plugin Category Groups ----
// Maps VST3 category strings (e.g. "Fx|Dynamics", "Instrument|Synth") to
// predefined groups for easy filtering.
const CATEGORY_GROUPS = [
  { id: "all",         label: "All",         keywords: [] },
  { id: "instruments", label: "Instruments",  keywords: ["instrument", "synth", "sampler", "piano", "organ", "drum"] },
  { id: "effects",     label: "Effects",      keywords: ["fx", "effect"] },
  { id: "dynamics",    label: "Dynamics",     keywords: ["dynamics", "compressor", "limiter", "gate", "expander"] },
  { id: "eq",          label: "EQ",           keywords: ["eq", "equalizer", "filter"] },
  { id: "reverb",      label: "Reverb",       keywords: ["reverb", "room", "hall", "plate"] },
  { id: "delay",       label: "Delay",        keywords: ["delay", "echo"] },
  { id: "modulation",  label: "Modulation",   keywords: ["modulation", "chorus", "flanger", "phaser", "tremolo", "vibrato"] },
  { id: "distortion",  label: "Distortion",   keywords: ["distortion", "saturation", "overdrive", "bitcrusher", "waveshaper"] },
  { id: "other",       label: "Other",        keywords: [] },
] as const;

type CategoryGroupId = typeof CATEGORY_GROUPS[number]["id"];

function getPluginGroupId(plugin: { category: string; isInstrument: boolean }): CategoryGroupId {
  if (plugin.isInstrument) return "instruments";
  const lowerCat = plugin.category.toLowerCase();
  for (const group of CATEGORY_GROUPS) {
    if (group.id === "all" || group.id === "other") continue;
    if (group.keywords.some((kw) => lowerCat.includes(kw))) return group.id;
  }
  // If it has "Fx" in category but no specific match, classify as "effects"
  if (lowerCat.includes("fx") || lowerCat.includes("effect")) return "effects";
  return "other";
}

interface PluginBrowserProps {
  trackId: string;
  targetChain: "input" | "track" | "master" | "instrument";
  trackType?: "audio" | "midi" | "instrument" | "bus";
  onClose: () => void;
  embedded?: boolean;
}

export function PluginBrowser({
  trackId,
  targetChain,
  trackType,
  onClose,
  embedded = false,
}: PluginBrowserProps) {
  const [plugins, setPlugins] = useState<Plugin[]>(() => pluginCatalogCache.plugins ?? []);
  const [loading, setLoading] = useState(() => pluginCatalogCache.plugins == null);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [categoryGroupFilter, setCategoryGroupFilter] = useState<CategoryGroupId>("all");
  const [addingPlugin, setAddingPlugin] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  const toggleFavorite = (pluginId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(pluginId)) next.delete(pluginId);
      else next.add(pluginId);
      saveFavorites(next);
      return next;
    });
  };

  const loadPlugins = async () => {
    try {
      if (pluginCatalogCache.plugins) {
        setPlugins(pluginCatalogCache.plugins);
        setLoading(false);

        void hydratePluginCapabilities(pluginCatalogCache.plugins)
          .then((hydratedCatalog) => {
            setPlugins(hydratedCatalog);
          })
          .catch((e) => {
            console.error("[PluginBrowser] Failed to hydrate cached capabilities:", e);
          });
        return;
      }

      setLoading(true);
      const catalog = await fetchPluginCatalog();
      setPlugins(catalog);
      setLoading(false);

      void hydratePluginCapabilities(catalog)
        .then((hydratedCatalog) => {
          setPlugins(hydratedCatalog);
        })
        .catch((e) => {
          console.error("[PluginBrowser] Failed to hydrate plugin capabilities:", e);
        });
    } catch (e) {
      console.error("[PluginBrowser] Failed to load plugins:", e);
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPlugins();
  }, []);

  const handleScan = async () => {
    setLoading(true);
    try {
      await nativeBridge.scanForPlugins();
      invalidatePluginCatalogCache();
      await loadPlugins();
    } catch (e) {
      console.error("[PluginBrowser] Failed to scan:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleAddPlugin = async (plugin: Plugin) => {
    setAddingPlugin(plugin.fileOrIdentifier);
    try {
      let success = false;
      let shouldNotifyChain = false;
      const store = useDAWStore.getState();

      if (plugin.pluginType === "s13fx") {
        // S13FX script — use dedicated bridge
        if (targetChain === "master") {
          success = await nativeBridge.addMasterS13FX(plugin.fileOrIdentifier);
          shouldNotifyChain = success;
        } else {
          const fxTargetChain =
            targetChain === "input" || targetChain === "track"
              ? targetChain
              : null;
          const isInputFX = fxTargetChain === "input";
          const expectedLength =
            fxTargetChain !== null
              ? (await getFXChainSlots(trackId, fxTargetChain)).length + 1
              : null;
          success = await nativeBridge.addTrackS13FX(
            trackId,
            plugin.fileOrIdentifier,
            isInputFX,
          );
          if (success && expectedLength !== null && fxTargetChain !== null) {
            await waitForFXChainLength(trackId, fxTargetChain, expectedLength);
            shouldNotifyChain = true;
          }
        }
      } else if (targetChain === "instrument") {
        success = await nativeBridge.loadInstrument(
          trackId,
          plugin.fileOrIdentifier,
        );
        if (success) {
          store.updateTrack(trackId, {
            instrumentPlugin: plugin.fileOrIdentifier,
          });
          await waitForInstrumentPlugin(
            trackId,
            plugin.fileOrIdentifier,
            (candidateTrackId) =>
              useDAWStore
                .getState()
                .tracks.find((track) => track.id === candidateTrackId)?.instrumentPlugin,
          );
          notifyInstrumentChanged({
            trackId,
            instrumentPlugin: plugin.fileOrIdentifier,
          });
          await nativeBridge.openInstrumentEditor(trackId);
        }
      } else if (targetChain === "input") {
        success = await store.addTrackFXWithUndo(
          trackId,
          plugin.fileOrIdentifier,
          "input",
        );
      } else if (targetChain === "track") {
        success = await store.addTrackFXWithUndo(
          trackId,
          plugin.fileOrIdentifier,
          "track",
        );
      } else if (targetChain === "master") {
        success = await nativeBridge.addMasterFX(plugin.fileOrIdentifier);
        shouldNotifyChain = success;
      }

      if (success) {
        if (shouldNotifyChain && targetChain !== "instrument") {
          notifyFXChainChanged({
            trackId,
            chainType: targetChain,
          });
        }
        console.log(
          `[PluginBrowser] Added ${plugin.name} to ${targetChain}`,
        );
        onClose();
      }
    } catch (e) {
      console.error("[PluginBrowser] Failed to add plugin:", e);
    } finally {
      setAddingPlugin(null);
    }
  };

  // Filter plugins based on targetChain and track type
  const basePlugins = useMemo(() => {
    if (targetChain === "instrument") {
      // Only show instrument plugins
      return plugins.filter((p) => p.isInstrument);
    }
    // For FX chains (input/track/master), exclude instrument plugins
    let filtered = plugins.filter((p) => !p.isInstrument);
    // For pure MIDI tracks (no instrument loaded), audio FX won't work
    // — only show S13FX and plugins that explicitly support MIDI
    if (trackType === "midi") {
      filtered = filtered.filter(
        (p) => p.pluginType === "s13fx" || p.producesMidi || p.isMidiEffect,
      );
    }
    return filtered;
  }, [plugins, targetChain, trackType]);

  const categories = [
    "All",
    ...Array.from(new Set(basePlugins.map((p) => p.category))),
  ];

  // Compute available category groups (only show tabs that have plugins)
  const availableGroups = useMemo(() => {
    const groupCounts = new Map<CategoryGroupId, number>();
    for (const p of basePlugins) {
      const gid = getPluginGroupId(p);
      groupCounts.set(gid, (groupCounts.get(gid) || 0) + 1);
    }
    return CATEGORY_GROUPS.filter(
      (g) => g.id === "all" || (groupCounts.get(g.id) || 0) > 0
    ).map((g) => ({
      ...g,
      count: g.id === "all" ? basePlugins.length : groupCounts.get(g.id) || 0,
    }));
  }, [basePlugins]);

  // Enhanced search: match against name, manufacturer, AND category
  const filteredPlugins = basePlugins.filter((p) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      p.name.toLowerCase().includes(term) ||
      p.manufacturer.toLowerCase().includes(term) ||
      p.category.toLowerCase().includes(term);
    const matchesCategory =
      categoryFilter === "All" || p.category === categoryFilter;
    const matchesGroup =
      categoryGroupFilter === "all" || getPluginGroupId(p) === categoryGroupFilter;
    const matchesFavorite = !showFavoritesOnly || favorites.has(p.fileOrIdentifier);
    return matchesSearch && matchesCategory && matchesGroup && matchesFavorite;
  });

  // Sort: favorites first, then alphabetical
  const sortedPlugins = useMemo(() => {
    return [...filteredPlugins].sort((a, b) => {
      const aFav = favorites.has(a.fileOrIdentifier) ? 0 : 1;
      const bFav = favorites.has(b.fileOrIdentifier) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      return a.name.localeCompare(b.name);
    });
  }, [filteredPlugins, favorites]);

  const content = (
    <>
      <div
        className={
          embedded
            ? "flex gap-2 p-2 bg-neutral-800"
            : "flex gap-2 p-3 border-b border-neutral-700 bg-neutral-800 rounded-t-lg"
        }
      >
        <Input
          type="text"
          variant="default"
          size="md"
          placeholder="Search by name, manufacturer, or category..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="flex-1"
        />
        <Select
          variant="default"
          size="md"
          value={categoryFilter}
          onChange={(val) => setCategoryFilter(val as string)}
          options={categories.map((cat) => ({ value: cat, label: cat }))}
          className="min-w-[150px]"
        />
        <Button
          variant={showFavoritesOnly ? "primary" : "default"}
          size="md"
          onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
          title="Show favorites only"
        >
          <Star size={14} fill={showFavoritesOnly ? "currentColor" : "none"} />
        </Button>
        <Button
          variant="default"
          size="md"
          onClick={() => nativeBridge.openUserEffectsFolder()}
          title="Open user JSFX effects folder — drop .jsfx scripts here, then click Scan"
        >
          <FolderOpen size={14} />
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleScan}
          disabled={loading}
        >
          {loading ? "Scanning..." : "Scan"}
        </Button>
      </div>

      {/* Category Group Filter Tabs */}
      <div
        className={
          embedded
            ? "flex gap-1 px-2 py-1.5 bg-neutral-850 overflow-x-auto"
            : "flex gap-1 px-3 py-1.5 bg-neutral-800/50 border-b border-neutral-700 overflow-x-auto"
        }
      >
        {availableGroups.map((group) => (
          <button
            key={group.id}
            onClick={() => setCategoryGroupFilter(group.id)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${
              categoryGroupFilter === group.id
                ? "bg-blue-600 text-white"
                : "bg-neutral-700/50 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
            }`}
          >
            {group.label}
            <span className={`text-[10px] ${categoryGroupFilter === group.id ? "text-blue-200" : "text-neutral-500"}`}>
              {group.count}
            </span>
          </button>
        ))}
      </div>

      <div
        className={
          embedded
            ? "flex-1 overflow-y-auto p-2"
            : "flex-1 overflow-y-auto p-4 bg-neutral-900 rounded-b-lg"
        }
      >
        {loading ? (
          <div className="p-2 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-3 bg-neutral-800 border border-daw-border rounded animate-pulse"
              >
                {/* Icon skeleton */}
                <div className="w-10 h-10 rounded bg-neutral-700 shrink-0" />
                {/* Text skeleton */}
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="h-4 bg-neutral-700 rounded w-3/5" />
                  <div className="h-3 bg-neutral-700/60 rounded w-2/5" />
                  <div className="h-2.5 bg-neutral-700/40 rounded w-1/4" />
                </div>
                {/* Button skeleton */}
                <div className="w-14 h-7 rounded bg-neutral-700 shrink-0" />
              </div>
            ))}
            <div className="text-center text-xs text-daw-text-muted mt-2">
              Loading available plugins...
            </div>
          </div>
        ) : sortedPlugins.length === 0 ? (
          <div className="text-center p-10 text-neutral-400">
            {showFavoritesOnly ? "No favorite plugins. Click the star on a plugin to favorite it." : "No plugins found. Click \"Scan\" to search your system."}
          </div>
        ) : (
          sortedPlugins.map((plugin, idx) => {
            const isScript = plugin.pluginType === "s13fx";
            const isFav = favorites.has(plugin.fileOrIdentifier);
            const { Icon, color } = isScript
              ? { Icon: Code, color: "#84cc16" }
              : getCategoryIcon(plugin.category);
            return (
              <div
                key={idx}
                className={`flex items-center gap-3 p-3 bg-neutral-800 border rounded mb-2 hover:border-blue-500 transition-colors ${
                  isScript ? "border-lime-700/40" : "border-neutral-700"
                }`}
              >
                {/* Favorite star */}
                <button
                  className="shrink-0 p-0.5 hover:scale-110 transition-transform"
                  onClick={() => toggleFavorite(plugin.fileOrIdentifier)}
                  title={isFav ? "Remove from favorites" : "Add to favorites"}
                >
                  <Star size={14} fill={isFav ? "#eab308" : "none"} stroke={isFav ? "#eab308" : "#666"} />
                </button>
                {/* Snapshot or category icon */}
                {plugin.snapshot ? (
                  <img
                    src={plugin.snapshot}
                    alt={plugin.name}
                    className="w-10 h-10 rounded object-cover shrink-0"
                  />
                ) : (
                  <div
                    className="w-10 h-10 rounded flex items-center justify-center shrink-0"
                    style={{ backgroundColor: color + "20", border: `1px solid ${color}40` }}
                  >
                    <Icon size={20} />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-white mb-0.5 truncate">
                    {plugin.name}
                    {isScript && (
                      <span className="ml-2 text-[10px] font-normal text-lime-400 bg-lime-900/30 px-1.5 py-0.5 rounded">
                        S13FX
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-400">
                    {plugin.manufacturer}
                  </div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">
                    {isScript ? "JSFX Script" : plugin.category}
                  </div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleAddPlugin(plugin)}
                  disabled={addingPlugin !== null}
                  className="shrink-0"
                >
                  {addingPlugin === plugin.fileOrIdentifier ? "Adding..." : "Add"}
                </Button>
              </div>
            );
          })
        )}
      </div>
    </>
  );

  if (embedded) {
    return <div className="flex flex-col h-full">{content}</div>;
  }

  return createPortal(
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-2000"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[90%] max-w-[800px] max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-4 border-b border-neutral-700">
          <h2 className="m-0 text-lg text-white font-semibold">
            {targetChain === "instrument" ? "Instrument Browser" : `Plugin Browser - ${targetChain.toUpperCase()} FX`}
          </h2>
          <Button
            variant="ghost"
            size="icon-md"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </div>
        {content}
      </div>
    </div>,
    document.body
  );
}

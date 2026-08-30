import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/shallow";
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
  FolderCog,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  nativeBridge,
  type PluginScanConfiguration,
  type PluginScanReport,
} from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { guardModalContextMenu } from "../utils/modalEventGuards";
import {
  getFXChainSlots,
  notifyFXChainChanged,
  notifyInstrumentChanged,
  waitForFXChainLength,
  waitForInstrumentPlugin,
} from "../utils/fxChain";
import { Button, Input, Select } from "./ui";
import { registerScopedActionExecutor } from "../store/actionRegistry";
import {
  activateShortcutContext,
  getActiveShortcutContext,
  registerShortcutSurface,
} from "../utils/shortcutContext";

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
  identifier?: string;
  isInstrument: boolean;
  snapshot?: string; // base64 data URL from C++ snapshot lookup
  pluginFormat?: string;
  pluginFormatName?: string;
  pluginType?: "vst3" | "lv2" | "clap" | "s13fx" | "builtin"; // Plugin format type
  producesMidi?: boolean;
  isMidiEffect?: boolean;
  supportsDoublePrecision?: boolean;
  numInputChannels?: number;
  numOutputChannels?: number;
}

const pluginCatalogCache: {
  plugins: Plugin[] | null;
  loadPromise: Promise<Plugin[]> | null;
  generation: number;
} = {
  plugins: null,
  loadPromise: null,
  generation: 0,
};

function getPluginIdentity(
  plugin: Pick<Plugin, "identifier" | "fileOrIdentifier">,
): string {
  return plugin.identifier?.trim() || plugin.fileOrIdentifier;
}

function getPluginLoadTarget(plugin: Plugin): string {
  return plugin.pluginType === "s13fx" || plugin.pluginType === "builtin"
    ? plugin.fileOrIdentifier
    : getPluginIdentity(plugin);
}

function getComparableBlacklistIdentity(value: string): string {
  const trimmed = value.trim();
  const isWindowsPath = /^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith("\\\\");
  if (!isWindowsPath) return trimmed;

  const normalized = trimmed.replace(/\//g, "\\");
  const bundleMatch = normalized.match(/^(.+?\.(?:vst3|clap|lv2))(?:\\.*)?$/i);
  return (bundleMatch?.[1] ?? normalized).toLowerCase();
}

function isPluginFavorite(plugin: Plugin, favorites: Set<string>): boolean {
  const identity = getPluginIdentity(plugin);
  return (
    favorites.has(identity) ||
    (identity !== plugin.fileOrIdentifier &&
      favorites.has(plugin.fileOrIdentifier))
  );
}

async function fetchPluginCatalog(): Promise<Plugin[]> {
  if (pluginCatalogCache.plugins) {
    return pluginCatalogCache.plugins;
  }

  if (pluginCatalogCache.loadPromise) {
    return pluginCatalogCache.loadPromise;
  }

  const requestGeneration = pluginCatalogCache.generation;
  const request = (async () => {
    const pluginList = await nativeBridge.getAvailablePlugins();
    const hostPlugins: Plugin[] = pluginList.map((p: any) => {
      const fmt = (p.pluginFormat || p.pluginFormatName || "").toLowerCase();
      let pluginType: Plugin["pluginType"] = "vst3";
      if (fmt.includes("lv2")) pluginType = "lv2";
      else if (fmt.includes("clap")) pluginType = "clap";
      return { ...p, pluginType };
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

    return [...hostPlugins, ...s13fxPlugins];
  })();
  pluginCatalogCache.loadPromise = request;

  try {
    const catalog = await request;
    if (requestGeneration !== pluginCatalogCache.generation) {
      // The invalidation may have happened while this request was in flight.
      // Detach the stale promise before retrying; otherwise fetchPluginCatalog
      // would immediately hand the already-resolved stale request back to us.
      if (pluginCatalogCache.loadPromise === request) {
        pluginCatalogCache.loadPromise = null;
      }
      return await fetchPluginCatalog();
    }
    pluginCatalogCache.plugins = catalog;
    return catalog;
  } finally {
    if (pluginCatalogCache.loadPromise === request) {
      pluginCatalogCache.loadPromise = null;
    }
  }
}

export function invalidatePluginCatalogCache() {
  pluginCatalogCache.generation += 1;
  pluginCatalogCache.plugins = null;
  pluginCatalogCache.loadPromise = null;
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

function getPluginCategoryTokens(category: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const rawToken of category.split("|")) {
    const token = rawToken.trim();
    const identity = token.toLowerCase();
    if (!token || seen.has(identity)) continue;
    seen.add(identity);
    tokens.push(token);
  }
  return tokens;
}

function pluginMatchesCategoryGroup(
  plugin: { category: string; isInstrument: boolean },
  groupId: CategoryGroupId,
): boolean {
  if (groupId === "all") return true;
  if (groupId === "instruments") return plugin.isInstrument;
  if (plugin.isInstrument) return false;

  const lowerCategory = getPluginCategoryTokens(plugin.category)
    .join(" ")
    .toLowerCase();
  const group = CATEGORY_GROUPS.find((candidate) => candidate.id === groupId);
  if (!group) return false;

  if (groupId === "other") {
    return !CATEGORY_GROUPS.some(
      (candidate) =>
        candidate.id !== "all" &&
        candidate.id !== "instruments" &&
        candidate.id !== "other" &&
        candidate.keywords.some((keyword) =>
          lowerCategory.includes(keyword),
        ),
    );
  }

  return group.keywords.some((keyword) => lowerCategory.includes(keyword));
}

interface PluginBrowserProps {
  trackId: string;
  targetChain: "input" | "track" | "master" | "instrument";
  trackType?: "audio" | "midi" | "instrument" | "bus" | "ai";
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
  const [showScanFolders, setShowScanFolders] = useState(false);
  const [scanConfiguration, setScanConfiguration] =
    useState<PluginScanConfiguration | null>(null);
  const [scanConfigurationLoading, setScanConfigurationLoading] = useState(false);
  const [scanFolderBusy, setScanFolderBusy] = useState(false);
  const [scanFolderError, setScanFolderError] = useState("");
  const [scanReport, setScanReport] = useState<PluginScanReport | null>(null);
  const [scanError, setScanError] = useState("");
  const [retryingBlacklistedPlugin, setRetryingBlacklistedPlugin] = useState<
    string | null
  >(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const browserActionExecutorRef = useRef<(actionId: string) => "handled" | "claimed_noop" | "unmatched">(
    () => "unmatched",
  );
  const { currentInstrumentPlugin, removeInstrumentWithUndo } = useDAWStore(
    useShallow((state) => {
      const track = state.tracks.find((candidate) => candidate.id === trackId);
      return {
        currentInstrumentPlugin: track?.instrumentPlugin,
        removeInstrumentWithUndo: state.removeInstrumentWithUndo,
      };
    }),
  );

  const toggleFavorite = (plugin: Plugin) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      const identity = getPluginIdentity(plugin);
      if (isPluginFavorite(plugin, next)) {
        next.delete(identity);
        next.delete(plugin.fileOrIdentifier);
      } else {
        next.add(identity);
      }
      saveFavorites(next);
      return next;
    });
  };

  const loadPlugins = useCallback(async () => {
    try {
      if (pluginCatalogCache.plugins) {
        setPlugins(pluginCatalogCache.plugins);
        setLoading(false);
        return;
      }

      setLoading(true);
      const catalog = await fetchPluginCatalog();
      setPlugins(catalog);
      setLoading(false);
    } catch (e) {
      console.error("[PluginBrowser] Failed to load plugins:", e);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  useEffect(() => {
    const handleCatalogChanged = () => {
      invalidatePluginCatalogCache();
      void loadPlugins();
    };

    window.addEventListener(
      "openstudio:plugin-catalog-changed",
      handleCatalogChanged,
    );
    return () => {
      window.removeEventListener(
        "openstudio:plugin-catalog-changed",
        handleCatalogChanged,
      );
    };
  }, [loadPlugins]);

  const loadScanConfiguration = useCallback(async () => {
    setScanConfigurationLoading(true);
    setScanFolderError("");
    try {
      setScanConfiguration(await nativeBridge.getPluginScanConfiguration());
    } catch (e) {
      console.error("[PluginBrowser] Failed to load scan folders:", e);
      setScanFolderError("OpenStudio could not read the plug-in scan folders.");
    } finally {
      setScanConfigurationLoading(false);
    }
  }, []);

  const handleToggleScanFolders = () => {
    const nextVisible = !showScanFolders;
    setShowScanFolders(nextVisible);
    if (nextVisible && scanConfiguration === null) {
      void loadScanConfiguration();
    }
  };

  const handleAddScanFolder = async () => {
    setScanFolderBusy(true);
    setScanFolderError("");
    try {
      const selectedPath = (
        await nativeBridge.browseForFolder("Choose a plug-in scan folder")
      ).trim();
      if (!selectedPath) return;

      if (!(await nativeBridge.addPluginScanPath(selectedPath))) {
        setScanFolderError(
          "That folder could not be added. Choose an existing plug-in folder.",
        );
        return;
      }

      await loadScanConfiguration();
    } catch (e) {
      console.error("[PluginBrowser] Failed to add scan folder:", e);
      setScanFolderError("OpenStudio could not add that scan folder.");
    } finally {
      setScanFolderBusy(false);
    }
  };

  const handleRemoveScanFolder = async (path: string) => {
    setScanFolderBusy(true);
    setScanFolderError("");
    try {
      if (!(await nativeBridge.removePluginScanPath(path))) {
        setScanFolderError("OpenStudio could not remove that scan folder.");
        return;
      }
      await loadScanConfiguration();
    } catch (e) {
      console.error("[PluginBrowser] Failed to remove scan folder:", e);
      setScanFolderError("OpenStudio could not remove that scan folder.");
    } finally {
      setScanFolderBusy(false);
    }
  };

  const handleScan = async (forceRescan = false) => {
    setLoading(true);
    setScanError("");
    setScanReport(null);
    try {
      const report = await nativeBridge.scanForPlugins(forceRescan);

      // NativeBridge announces catalog changes. The fallback keeps this
      // component correct in hosts that cannot dispatch DOM events.
      if (pluginCatalogCache.plugins !== null || pluginCatalogCache.loadPromise === null) {
        invalidatePluginCatalogCache();
      }
      await loadPlugins();
      await loadScanConfiguration();
      setScanReport(report);
    } catch (e) {
      console.error("[PluginBrowser] Failed to scan:", e);
      setScanError(
        "The scan did not complete. The previous plug-in catalog is still available.",
      );
    } finally {
      setLoading(false);
    }
  };

  browserActionExecutorRef.current = (actionId) => {
    if (actionId === "browser.close") {
      onClose();
      return "handled";
    }
    if (actionId === "browser.focusSearch") {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return searchInputRef.current ? "handled" : "claimed_noop";
    }
    if (actionId === "browser.toggleFavorites") {
      setShowFavoritesOnly((visible) => !visible);
      return "handled";
    }
    if (actionId === "browser.openUserEffectsFolder") {
      void nativeBridge.openUserEffectsFolder();
      return "handled";
    }
    if (actionId === "browser.toggleScanFolders") {
      handleToggleScanFolders();
      return "handled";
    }
    if (actionId === "browser.addScanFolder") {
      if (scanFolderBusy || scanConfigurationLoading) return "claimed_noop";
      void handleAddScanFolder();
      return "handled";
    }
    if (actionId === "browser.scanPlugins" || actionId === "browser.deepScanPlugins") {
      if (loading) return "claimed_noop";
      void handleScan(actionId === "browser.deepScanPlugins");
      return "handled";
    }
    if (actionId === "browser.removeCurrentInstrument") {
      if (targetChain !== "instrument" || !currentInstrumentPlugin) return "claimed_noop";
      void removeInstrumentWithUndo(trackId);
      return "handled";
    }
    return "unmatched";
  };

  useEffect(() => {
    const context = { kind: "browser" } as const;
    const fallback = getActiveShortcutContext();
    const unregisterSurface = registerShortcutSurface(context, () => "unmatched", fallback);
    const unregisterActions = registerScopedActionExecutor(
      context,
      (actionId) => browserActionExecutorRef.current(actionId),
      [
        "browser.close",
        "browser.focusSearch",
        "browser.toggleFavorites",
        "browser.openUserEffectsFolder",
        "browser.toggleScanFolders",
        "browser.addScanFolder",
        "browser.scanPlugins",
        "browser.deepScanPlugins",
        ...(targetChain === "instrument" && currentInstrumentPlugin
          ? ["browser.removeCurrentInstrument"]
          : []),
      ],
    );
    activateShortcutContext(context);
    return () => {
      unregisterActions();
      unregisterSurface();
    };
  }, [currentInstrumentPlugin, targetChain]);

  const handleRetryBlacklistedPlugin = async (path: string) => {
    setRetryingBlacklistedPlugin(path);
    setScanError("");
    try {
      if (!(await nativeBridge.retryBlacklistedPlugin(path))) {
        setScanError(
          "That plug-in could not be removed from the safety blacklist.",
        );
        return;
      }

      await loadScanConfiguration();
      await handleScan(true);
    } catch (error) {
      console.error("[PluginBrowser] Failed to retry blacklisted plug-in:", error);
      setScanError(
        "The plug-in could not be retried. The previous catalog remains available.",
      );
    } finally {
      setRetryingBlacklistedPlugin(null);
    }
  };

  const handleAddPlugin = async (plugin: Plugin) => {
    const pluginTarget = getPluginLoadTarget(plugin);
    setAddingPlugin(getPluginIdentity(plugin));
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
        success = await store.loadInstrumentWithUndo(
          trackId,
          pluginTarget,
        );
        if (success) {
          await waitForInstrumentPlugin(
            trackId,
            pluginTarget,
            (candidateTrackId) =>
              useDAWStore
                .getState()
                .tracks.find((track) => track.id === candidateTrackId)?.instrumentPlugin,
          );
          notifyInstrumentChanged({
            trackId,
            instrumentPlugin: pluginTarget,
          });
          await nativeBridge.openInstrumentEditor(trackId);
        }
      } else if (targetChain === "input") {
        success = await store.addTrackFXWithUndo(
          trackId,
          pluginTarget,
          "input",
        );
      } else if (targetChain === "track") {
        success = await store.addTrackFXWithUndo(
          trackId,
          pluginTarget,
          "track",
        );
      } else if (targetChain === "master") {
        success = await nativeBridge.addMasterFX(pluginTarget);
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
    // MIDI production is a runtime capability. Keep every scanned effect
    // visible instead of instantiating third-party binaries to classify it.
    const filtered = plugins.filter((p) => !p.isInstrument);
    return filtered;
  }, [plugins, targetChain]);

  const scannedInstrumentCount = useMemo(
    () => plugins.filter((plugin) => plugin.isInstrument).length,
    [plugins],
  );
  const scannedEffectCount = plugins.length - scannedInstrumentCount;

  const categories = useMemo(() => {
    const categoryByIdentity = new Map<string, string>();
    for (const plugin of basePlugins) {
      for (const category of getPluginCategoryTokens(plugin.category)) {
        const identity = category.toLowerCase();
        if (!categoryByIdentity.has(identity)) {
          categoryByIdentity.set(identity, category);
        }
      }
    }
    return [
      "All",
      ...Array.from(categoryByIdentity.values()).sort((a, b) =>
        a.localeCompare(b),
      ),
    ];
  }, [basePlugins]);

  // A VST3 can advertise several categories, so one plug-in may belong to
  // multiple useful tabs (for example Effects, Distortion, Dynamics, Reverb).
  const availableGroups = useMemo(() => {
    const groupCounts = new Map<CategoryGroupId, number>();
    for (const group of CATEGORY_GROUPS) {
      if (group.id === "all") continue;
      groupCounts.set(
        group.id,
        basePlugins.filter((plugin) =>
          pluginMatchesCategoryGroup(plugin, group.id),
        ).length,
      );
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
      categoryFilter === "All" ||
      getPluginCategoryTokens(p.category).some(
        (category) =>
          category.toLowerCase() === categoryFilter.toLowerCase(),
      );
    const matchesGroup =
      pluginMatchesCategoryGroup(p, categoryGroupFilter);
    const matchesFavorite = !showFavoritesOnly || isPluginFavorite(p, favorites);
    return matchesSearch && matchesCategory && matchesGroup && matchesFavorite;
  });

  // Sort: favorites first, then alphabetical
  const sortedPlugins = useMemo(() => {
    return [...filteredPlugins].sort((a, b) => {
      const aFav = isPluginFavorite(a, favorites) ? 0 : 1;
      const bFav = isPluginFavorite(b, favorites) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      return a.name.localeCompare(b.name);
    });
  }, [filteredPlugins, favorites]);

  const currentInstrumentName = useMemo(() => {
    if (!currentInstrumentPlugin) return "";
    const known = plugins.find(
      (plugin) =>
        getPluginLoadTarget(plugin) === currentInstrumentPlugin ||
        plugin.fileOrIdentifier === currentInstrumentPlugin,
    );
    return known?.name || currentInstrumentPlugin.split(/[\\/]/).pop() || "Instrument";
  }, [currentInstrumentPlugin, plugins]);

  const emptyCatalogMessage = useMemo(() => {
    if (plugins.length === 0) {
      return "No plug-ins are cataloged yet. Scan the standard folders or add the folder where your plug-ins are installed.";
    }
    if (basePlugins.length === 0) {
      if (targetChain === "instrument") {
        return `${plugins.length} catalog entries are available, but none report themselves as instruments. This slot hides audio effects.`;
      }
      return `${plugins.length} catalog entries are available, but this FX slot hides instruments.`;
    }
    const normalizedSearch = searchTerm.trim().toLowerCase();
    if (normalizedSearch) {
      const hiddenMatches = plugins.filter((plugin) => {
        const hiddenBySlot =
          targetChain === "instrument" ? !plugin.isInstrument : plugin.isInstrument;
        return (
          hiddenBySlot &&
          (plugin.name.toLowerCase().includes(normalizedSearch) ||
            plugin.manufacturer.toLowerCase().includes(normalizedSearch) ||
            plugin.category.toLowerCase().includes(normalizedSearch))
        );
      }).length;
      if (hiddenMatches > 0) {
        return targetChain === "instrument"
          ? `${hiddenMatches} matching audio effect${hiddenMatches === 1 ? " is" : "s are"} scanned, but this instrument slot only lists instruments.`
          : `${hiddenMatches} matching instrument${hiddenMatches === 1 ? " is" : "s are"} scanned. Open the Instrument Browser on a MIDI or instrument track to load ${hiddenMatches === 1 ? "it" : "them"}.`;
      }
    }
    return "No plug-ins match the current search, category, or favorites filters.";
  }, [basePlugins.length, plugins, searchTerm, targetChain]);

  const blacklistedPluginPaths = useMemo(
    () =>
      new Set(
        (scanConfiguration?.blacklistedPlugins ?? []).map(
          getComparableBlacklistIdentity,
        ),
      ),
    [scanConfiguration],
  );
  const isBlacklistedPlugin = (path: string) =>
    blacklistedPluginPaths.has(getComparableBlacklistIdentity(path));

  const scanHasIssues =
    scanReport !== null &&
    (!scanReport.success ||
      scanReport.failedCount > 0 ||
      scanReport.skippedCount > 0);
  const scanSummary = scanReport
    ? scanReport.success
      ? `${scanReport.forceRescan ? "Deep scan" : "Scan"} found ${scanReport.pluginCount} plug-in ${scanReport.pluginCount === 1 ? "class" : "classes"}${
          scanReport.candidateCount > 0
            ? ` from ${scanReport.candidateCount} candidate${scanReport.candidateCount === 1 ? "" : "s"}`
            : ""
        }.${
          scanReport.failedCount > 0
            ? ` ${scanReport.failedCount} candidate${scanReport.failedCount === 1 ? " was" : "s were"} not loadable.`
            : ""
        }${
          scanReport.skippedCount > 0
            ? ` ${scanReport.skippedCount} candidate${scanReport.skippedCount === 1 ? " was" : "s were"} skipped.`
            : ""
        }`
      : `${scanReport.error || "The scan did not complete."} ${scanReport.pluginCount} known plug-in ${scanReport.pluginCount === 1 ? "class remains" : "classes remain"} available.`
    : "";

  const content = (
    <>
      <div
        className={
          embedded
            ? "flex flex-wrap items-center gap-2 p-2 bg-neutral-800"
            : "flex flex-wrap items-center gap-2 p-3 border-b border-neutral-700 bg-neutral-800 rounded-t-lg"
        }
      >
        <div className="relative flex-[2_1_360px] min-w-[280px]">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-300 pointer-events-none"
          />
          <Input
            ref={searchInputRef}
            type="text"
            variant="default"
            size="md"
            placeholder="Search plugins, makers, categories..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            fullWidth
            className="block w-full"
            inputClassName="w-full pl-9 bg-neutral-950 border-neutral-500 text-white placeholder:text-neutral-400 shadow-inner focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30"
          />
        </div>
        <Select
          variant="default"
          size="md"
          value={categoryFilter}
          onChange={(val) => setCategoryFilter(val as string)}
          options={categories.map((cat) => ({ value: cat, label: cat }))}
          className="min-w-[170px] flex-[1_1_180px]"
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
          variant={showScanFolders ? "primary" : "default"}
          size="md"
          onClick={handleToggleScanFolders}
          title="Manage additional VST3, CLAP, and LV2 scan folders"
          aria-expanded={showScanFolders}
        >
          <FolderCog size={14} />
          Folders
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={() => void handleScan(false)}
          disabled={loading}
          title="Incremental scan: reuse unchanged plug-in metadata"
        >
          {loading ? "Scanning..." : "Scan"}
        </Button>
        <Button
          variant="default"
          size="md"
          onClick={() => void handleScan(true)}
          disabled={loading}
          title="Deep scan: inspect every configured plug-in again"
        >
          <RefreshCw size={14} />
          Deep Scan
        </Button>
      </div>

      {showScanFolders && (
        <div className="px-3 py-3 bg-neutral-900 border-b border-neutral-700">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-neutral-100">
                Additional scan folders
              </div>
              <div className="text-xs text-neutral-400 mt-0.5">
                Standard system folders are included automatically. Add vendor or application-specific folders here, then run Scan.
              </div>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleAddScanFolder()}
              disabled={scanFolderBusy || scanConfigurationLoading}
              className="shrink-0"
            >
              <Plus size={13} />
              Add Folder
            </Button>
          </div>

          {scanConfigurationLoading ? (
            <div className="text-xs text-neutral-400 py-2">Loading folders...</div>
          ) : scanConfiguration ? (
            <>
              {scanConfiguration.customPaths.length === 0 ? (
                <div className="rounded border border-neutral-700 bg-neutral-950/60 px-3 py-2 text-xs text-neutral-400">
                  No additional folders. OpenStudio will scan its standard locations.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {scanConfiguration.customPaths.map((path) => (
                    <div
                      key={path}
                      className="flex items-center gap-2 rounded border border-neutral-700 bg-neutral-950/60 px-2.5 py-1.5"
                    >
                      <FolderOpen size={13} className="text-blue-400 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={path}>
                        {path}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleRemoveScanFolder(path)}
                        disabled={scanFolderBusy}
                        className="p-1 rounded text-neutral-500 hover:text-red-300 hover:bg-red-950/40 disabled:opacity-40"
                        title="Remove scan folder"
                        aria-label={`Remove scan folder ${path}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-2 text-[11px] text-neutral-500">
                Supported: {scanConfiguration.supportedFormats.join(", ") || "No host formats reported"}
                {scanConfiguration.effectivePaths.length > 0 &&
                  ` · ${scanConfiguration.effectivePaths.filter((entry) => entry.exists).length} active scan locations`}
              </div>
              {scanConfiguration.unsupportedFormats &&
                scanConfiguration.unsupportedFormats.length > 0 && (
                  <div className="mt-1 text-[11px] text-neutral-500">
                    Not hostable: {scanConfiguration.unsupportedFormats.join(", ")}.
                  </div>
                )}
              {scanConfiguration.contentLibraryNote && (
                <div className="mt-1 text-[11px] text-neutral-500">
                  {scanConfiguration.contentLibraryNote}
                </div>
              )}

              {scanConfiguration.blacklistedPlugins.length > 0 && (
                <div className="mt-3 rounded border border-amber-800/60 bg-amber-950/20 p-2.5">
                  <div className="text-xs font-medium text-amber-200">
                    Skipped for safety
                  </div>
                  <div className="mt-0.5 text-[11px] text-neutral-400">
                    These candidates were blocked after a previous scan or load
                    failure. Retry removes one entry from the safety blacklist
                    and runs a deep scan.
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {scanConfiguration.blacklistedPlugins.map((path) => (
                      <div
                        key={path}
                        className="flex items-center gap-2 rounded border border-amber-900/50 bg-neutral-950/60 px-2.5 py-1.5"
                      >
                        <AlertTriangle
                          size={13}
                          className="shrink-0 text-amber-400"
                        />
                        <span
                          className="min-w-0 flex-1 truncate text-xs text-neutral-200"
                          title={path}
                        >
                          {path}
                        </span>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() =>
                            void handleRetryBlacklistedPlugin(path)
                          }
                          disabled={retryingBlacklistedPlugin !== null || loading}
                          title="Remove from the safety blacklist and deep scan"
                        >
                          <RefreshCw size={12} />
                          {retryingBlacklistedPlugin === path
                            ? "Retrying..."
                            : "Retry"}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}

          {scanFolderError && (
            <div role="alert" className="mt-2 text-xs text-red-300">
              {scanFolderError}
            </div>
          )}
        </div>
      )}

      {(scanReport || scanError) && (
        <div
          className={`px-3 py-2 border-b text-xs ${
            scanError || scanHasIssues
              ? "border-amber-800/60 bg-amber-950/30 text-amber-200"
              : "border-emerald-800/50 bg-emerald-950/20 text-emerald-200"
          }`}
          role={scanError || scanHasIssues ? "alert" : "status"}
          aria-live="polite"
        >
          <div className="flex items-start gap-2">
            {scanError || scanHasIssues ? (
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div>{scanError || scanSummary}</div>
              {scanReport &&
                (scanReport.failures.length > 0 ||
                  scanReport.skipped.length > 0 ||
                  scanReport.paths.length > 0 ||
                  Boolean(scanReport.debugLogPath)) && (
                  <details className="mt-1 text-neutral-400">
                    <summary className="cursor-pointer select-none hover:text-neutral-200">
                      Scan details
                    </summary>
                    <div className="mt-1.5 space-y-1 pl-1">
                      <div>
                        {scanReport.paths.length} configured location{scanReport.paths.length === 1 ? "" : "s"}.
                      </div>
                      {scanReport.failures.slice(0, 6).map((failure) => (
                        <div key={`${failure.format}:${failure.path}`} className="break-words">
                          {failure.format}: {failure.path} — {failure.reason}
                        </div>
                      ))}
                      {scanReport.failures.length > 6 && (
                        <div>{scanReport.failures.length - 6} more failures are recorded in the scan log.</div>
                      )}
                      {scanReport.skipped.slice(0, 6).map((skipped) => (
                        <div
                          key={`skipped:${skipped.format}:${skipped.path}`}
                          className="flex items-start gap-2 break-words"
                        >
                          <span className="min-w-0 flex-1">
                            Skipped {skipped.format}: {skipped.path} - {skipped.reason}
                          </span>
                          {isBlacklistedPlugin(skipped.path) && (
                            <Button
                              variant="default"
                              size="sm"
                              onClick={() =>
                                void handleRetryBlacklistedPlugin(skipped.path)
                              }
                              disabled={retryingBlacklistedPlugin !== null || loading}
                              className="shrink-0"
                              title="Remove from the safety blacklist and deep scan"
                            >
                              <RefreshCw size={12} />
                              Retry
                            </Button>
                          )}
                        </div>
                      ))}
                      {scanReport.skipped.length > 6 && (
                        <div>{scanReport.skipped.length - 6} more skipped candidates are recorded in the scan log.</div>
                      )}
                      {scanReport.debugLogPath && (
                        <div className="break-all" title={scanReport.debugLogPath}>
                          Log: {scanReport.debugLogPath}
                        </div>
                      )}
                    </div>
                  </details>
                )}
            </div>
          </div>
        </div>
      )}

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

      {trackType === "midi" && targetChain !== "instrument" && (
        <div className="px-3 py-1.5 border-b border-neutral-800 bg-neutral-900 text-[11px] text-neutral-500">
          MIDI and audio effects are both listed. Audio-only effects need an
          instrument or another audio-producing route on this track.
        </div>
      )}

      {targetChain !== "instrument" && scannedInstrumentCount > 0 && (
        <div className="px-3 py-2 border-b border-blue-900/50 bg-blue-950/20 text-[11px] text-blue-200/80">
          This is an FX slot, so instrument plug-ins are intentionally hidden. {scannedInstrumentCount} scanned instrument
          {scannedInstrumentCount === 1 ? " is" : "s are"} available from the
          track's Instrument button.
        </div>
      )}

      {targetChain === "instrument" && scannedEffectCount > 0 && (
        <div className="px-3 py-2 border-b border-amber-900/60 bg-amber-950/20 text-[11px] text-amber-200/90">
          This is the Instrument slot. Guitar amp suites and other audio effects
          are intentionally hidden here, not missing from the scan. Use the
          track's FX button to browse {scannedEffectCount} scanned audio effect
          {scannedEffectCount === 1 ? "" : "s"}.
        </div>
      )}

      {targetChain === "instrument" && currentInstrumentPlugin && (
        <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900 border-b border-neutral-700">
          <Music size={14} className="text-purple-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-neutral-400">Loaded instrument</div>
            <div className="text-sm text-white truncate" title={currentInstrumentPlugin}>
              {currentInstrumentName}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              void removeInstrumentWithUndo(trackId);
            }}
            title="Remove instrument"
            aria-label="Remove loaded instrument"
          >
            <X size={14} />
          </Button>
        </div>
      )}

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
            {showFavoritesOnly
              ? "No favorite plug-ins match this slot and the current filters."
              : emptyCatalogMessage}
          </div>
        ) : (
          sortedPlugins.map((plugin) => {
            const isScript = plugin.pluginType === "s13fx";
            const pluginIdentity = getPluginIdentity(plugin);
            const isFav = isPluginFavorite(plugin, favorites);
            const { Icon, color } = isScript
              ? { Icon: Code, color: "#84cc16" }
              : getCategoryIcon(plugin.category);
            return (
              <div
                key={pluginIdentity}
                className={`flex items-center gap-3 p-3 bg-neutral-800 border rounded mb-2 hover:border-blue-500 transition-colors ${
                  isScript ? "border-lime-700/40" : "border-neutral-700"
                }`}
              >
                {/* Favorite star */}
                <button
                  className="shrink-0 p-0.5 hover:scale-110 transition-transform"
                  onClick={() => toggleFavorite(plugin)}
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
                  {addingPlugin === pluginIdentity ? "Adding..." : "Add"}
                </Button>
              </div>
            );
          })
        )}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div
        className="flex flex-col h-full"
        onPointerDownCapture={() => activateShortcutContext({ kind: "browser" })}
        onFocusCapture={() => activateShortcutContext({ kind: "browser" })}
        data-shortcut-context="browser"
      >
        {content}
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-[10000]"
      data-modal-root="true"
      onPointerDownCapture={() => activateShortcutContext({ kind: "browser" })}
      onFocusCapture={() => activateShortcutContext({ kind: "browser" })}
      data-shortcut-context="browser"
      onClick={onClose}
      onContextMenu={guardModalContextMenu}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[90%] max-w-[800px] max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={guardModalContextMenu}
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

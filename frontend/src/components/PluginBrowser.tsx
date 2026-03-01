import { useState, useEffect } from "react";
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
} from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Button, Input, Select } from "./ui";

interface Plugin {
  name: string;
  manufacturer: string;
  category: string;
  fileOrIdentifier: string;
  isInstrument: boolean;
  snapshot?: string; // base64 data URL from C++ snapshot lookup
  pluginType?: "vst3" | "s13fx"; // Distinguishes VST3 from S13FX scripts
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

interface PluginBrowserProps {
  trackId: string;
  targetChain: "input" | "track" | "master" | "instrument";
  onClose: () => void;
  embedded?: boolean;
}

export function PluginBrowser({
  trackId,
  targetChain,
  onClose,
  embedded = false,
}: PluginBrowserProps) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [addingPlugin, setAddingPlugin] = useState<string | null>(null);

  useEffect(() => {
    loadPlugins();
  }, []);

  const loadPlugins = async () => {
    setLoading(true);
    try {
      const pluginList = await nativeBridge.getAvailablePlugins();
      const vst3Plugins: Plugin[] = pluginList.map((p: any) => ({
        ...p,
        pluginType: "vst3" as const,
      }));

      // Also load S13FX scripts (not for instrument target)
      let s13fxPlugins: Plugin[] = [];
      if (targetChain !== "instrument") {
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
      }

      setPlugins([...vst3Plugins, ...s13fxPlugins]);
    } catch (e) {
      console.error("[PluginBrowser] Failed to load plugins:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleScan = async () => {
    setLoading(true);
    try {
      await nativeBridge.scanForPlugins();
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

      if (plugin.pluginType === "s13fx") {
        // S13FX script — use dedicated bridge
        if (targetChain === "master") {
          success = await nativeBridge.addMasterS13FX(plugin.fileOrIdentifier);
        } else {
          const isInputFX = targetChain === "input";
          success = await nativeBridge.addTrackS13FX(
            trackId,
            plugin.fileOrIdentifier,
            isInputFX,
          );
        }
      } else if (targetChain === "instrument") {
        success = await nativeBridge.loadInstrument(
          trackId,
          plugin.fileOrIdentifier,
        );
        if (success) {
          useDAWStore.getState().updateTrack(trackId, {
            instrumentPlugin: plugin.fileOrIdentifier,
          });
          await nativeBridge.openInstrumentEditor(trackId);
        }
      } else if (targetChain === "input") {
        success = await nativeBridge.addTrackInputFX(
          trackId,
          plugin.fileOrIdentifier,
        );
      } else if (targetChain === "track") {
        success = await nativeBridge.addTrackFX(
          trackId,
          plugin.fileOrIdentifier,
        );
      } else if (targetChain === "master") {
        success = await nativeBridge.addMasterFX(plugin.fileOrIdentifier);
      }

      if (success) {
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

  // Filter plugins based on targetChain
  const basePlugins = targetChain === "instrument"
    ? plugins.filter((p) => p.isInstrument)
    : plugins.filter((p) => !p.isInstrument);

  const categories = [
    "All",
    ...Array.from(new Set(basePlugins.map((p) => p.category))),
  ];

  // Enhanced search: match against name, manufacturer, AND category
  const filteredPlugins = basePlugins.filter((p) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      p.name.toLowerCase().includes(term) ||
      p.manufacturer.toLowerCase().includes(term) ||
      p.category.toLowerCase().includes(term);
    const matchesCategory =
      categoryFilter === "All" || p.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

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
          variant="primary"
          size="md"
          onClick={handleScan}
          disabled={loading}
        >
          {loading ? "Scanning..." : "Scan"}
        </Button>
      </div>

      <div
        className={
          embedded
            ? "flex-1 overflow-y-auto p-2"
            : "flex-1 overflow-y-auto p-4 bg-neutral-900 rounded-b-lg"
        }
      >
        {loading ? (
          <div className="text-center p-10 text-neutral-400">
            Loading plugins...
          </div>
        ) : filteredPlugins.length === 0 ? (
          <div className="text-center p-10 text-neutral-400">
            No plugins found. Click "Scan" to search your system.
          </div>
        ) : (
          filteredPlugins.map((plugin, idx) => {
            const isScript = plugin.pluginType === "s13fx";
            const { Icon, color } = isScript
              ? { match: "Script", Icon: Code, color: "#84cc16" }
              : getCategoryIcon(plugin.category);
            return (
              <div
                key={idx}
                className={`flex items-center gap-3 p-3 bg-neutral-800 border rounded mb-2 hover:border-blue-500 transition-colors ${
                  isScript ? "border-lime-700/40" : "border-neutral-700"
                }`}
              >
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

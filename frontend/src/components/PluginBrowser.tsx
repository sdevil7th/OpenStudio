import { useState, useEffect } from "react";
import { nativeBridge } from "../services/NativeBridge";

interface Plugin {
  name: string;
  manufacturer: string;
  category: string;
  fileOrIdentifier: string;
  isInstrument: boolean;
}

interface PluginBrowserProps {
  trackId: string;
  targetChain: "input" | "track" | "master";
  onClose: () => void;
  embedded?: boolean; // If true, renders without overlay/modal wrapper
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

  useEffect(() => {
    loadPlugins();
  }, []);

  const loadPlugins = async () => {
    setLoading(true);
    try {
      const pluginList = await nativeBridge.getAvailablePlugins();
      setPlugins(pluginList);
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
    try {
      let success = false;
      if (targetChain === "input") {
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
          `[PluginBrowser] Added ${plugin.name} to ${targetChain} chain`,
        );
        onClose(); // Notify parent that plugin was added
      }
    } catch (e) {
      console.error("[PluginBrowser] Failed to add plugin:", e);
    }
  };

  const categories = [
    "All",
    ...Array.from(new Set(plugins.map((p) => p.category))),
  ];
  const filteredPlugins = plugins.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.manufacturer.toLowerCase().includes(searchTerm.toLowerCase());
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
        <input
          type="text"
          className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-600"
          placeholder="Search plugins..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <select
          className="bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-white text-sm min-w-[150px] focus:outline-none focus:border-blue-600"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
        <button
          className="bg-blue-600 border-none rounded px-4 py-2 text-white font-semibold cursor-pointer hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleScan}
          disabled={loading}
        >
          {loading ? "Scanning..." : "Scan"}
        </button>
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
          filteredPlugins.map((plugin, idx) => (
            <div
              key={idx}
              className="flex justify-between items-center p-3 bg-neutral-800 border border-neutral-700 rounded mb-2 hover:border-blue-500 transition-colors"
            >
              <div className="flex-1">
                <div className="font-semibold text-white mb-1">
                  {plugin.name}
                </div>
                <div className="text-xs text-neutral-400">
                  {plugin.manufacturer}
                </div>
                <div className="text-[11px] text-neutral-500 mt-0.5">
                  {plugin.category}
                </div>
              </div>
              <button
                className="bg-blue-600 border-none rounded px-4 py-1.5 text-white font-semibold cursor-pointer hover:bg-blue-500"
                onClick={() => handleAddPlugin(plugin)}
              >
                Add
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );

  if (embedded) {
    // Embedded mode: render content directly without overlay
    return <div className="flex flex-col h-full">{content}</div>;
  }

  // Modal mode: render with overlay
  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-[1000]"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[90%] max-w-[800px] max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-4 border-b border-neutral-700">
          <h2 className="m-0 text-lg text-white font-semibold">
            Plugin Browser - {targetChain.toUpperCase()} FX
          </h2>
          <button
            className="bg-transparent border-none text-neutral-400 text-2xl cursor-pointer p-0 w-8 h-8 hover:text-white"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {content}
      </div>
    </div>
  );
}

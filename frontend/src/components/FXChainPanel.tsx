import { useState, useEffect } from "react";
import { nativeBridge } from "../services/NativeBridge";
import { Button, Input, Select } from "./ui";
import "./FXChainPanel.css";

interface FXChainPanelProps {
  trackId: string;
  trackName: string;
  chainType: "input" | "track";
  onClose: () => void;
}

interface FXSlot {
  index: number;
  name: string;
}

interface Plugin {
  name: string;
  manufacturer: string;
  category: string;
  fileOrIdentifier: string;
  isInstrument: boolean;
}

export function FXChainPanel({
  trackId,
  trackName,
  chainType,
  onClose,
}: FXChainPanelProps) {
  const [fxSlots, setFxSlots] = useState<FXSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // Plugin browser state
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");

  useEffect(() => {
    loadPlugins();
    loadAvailablePlugins();
  }, [trackId, chainType]);

  const loadPlugins = async () => {
    setLoading(true);
    try {
      const plugins =
        chainType === "input"
          ? await nativeBridge.getTrackInputFX(trackId)
          : await nativeBridge.getTrackFX(trackId);
      setFxSlots(plugins);
    } catch (e) {
      console.error("[FXChain] Failed to load plugins:", e);
    } finally {
      setLoading(false);
    }
  };

  const loadAvailablePlugins = async () => {
    setPluginsLoading(true);
    try {
      const pluginList = await nativeBridge.getAvailablePlugins();
      setPlugins(pluginList);
    } catch (e) {
      console.error("[FXChain] Failed to load available plugins:", e);
    } finally {
      setPluginsLoading(false);
    }
  };

  const handleScan = async () => {
    setPluginsLoading(true);
    try {
      await nativeBridge.scanForPlugins();
      await loadAvailablePlugins();
    } catch (e) {
      console.error("[FXChain] Failed to scan:", e);
    } finally {
      setPluginsLoading(false);
    }
  };

  const handleAddPlugin = async (plugin: Plugin) => {
    try {
      const success =
        chainType === "input"
          ? await nativeBridge.addTrackInputFX(trackId, plugin.fileOrIdentifier)
          : await nativeBridge.addTrackFX(trackId, plugin.fileOrIdentifier);

      if (success) {
        console.log(`[FXChain] Added ${plugin.name} to ${chainType} chain`);
        await loadPlugins(); // Reload FX list
      }
    } catch (e) {
      console.error("[FXChain] Failed to add plugin:", e);
    }
  };

  const handleOpenEditor = async (fxIndex: number) => {
    try {
      const isInputFX = chainType === "input";
      await nativeBridge.openPluginEditor(trackId, fxIndex, isInputFX);
      console.log(
        `[FXChain] Opened editor for ${chainType} FX ${fxIndex} on track ${trackId}`,
      );
    } catch (e) {
      console.error("[FXChain] Failed to open editor:", e);
    }
  };

  const handleRemove = async (fxIndex: number) => {
    try {
      const success =
        chainType === "input"
          ? await nativeBridge.removeTrackInputFX(trackId, fxIndex)
          : await nativeBridge.removeTrackFX(trackId, fxIndex);

      if (success) {
        console.log(`[FXChain] Removed ${chainType} FX ${fxIndex}`);
        await loadPlugins();
      }
    } catch (e) {
      console.error("[FXChain] Failed to remove plugin:", e);
    }
  };

  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDraggedIndex(null);
      return;
    }

    try {
      const success =
        chainType === "input"
          ? await nativeBridge.reorderTrackInputFX(
              trackId,
              draggedIndex,
              dropIndex,
            )
          : await nativeBridge.reorderTrackFX(trackId, draggedIndex, dropIndex);

      if (success) {
        console.log(
          `[FXChain] Reordered ${chainType} FX from ${draggedIndex} to ${dropIndex}`,
        );
        await loadPlugins();
      }
    } catch (e) {
      console.error("[FXChain] Failed to reorder:", e);
    } finally {
      setDraggedIndex(null);
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

  return (
    <div className="fx-chain-overlay z-20" onClick={onClose}>
      <div
        className="fx-chain-panel-two-column"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fx-chain-header">
          <h3>
            {chainType === "input" ? "Input FX Chain" : "Track FX Chain"} -{" "}
            {trackName}
          </h3>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            ×
          </Button>
        </div>

        <div className="fx-chain-two-column-content">
          {/* Left Column: Loaded FX */}
          <div className="fx-chain-loaded-column">
            <div className="fx-column-header">
              <h4>Loaded FX</h4>
              <span className="fx-count">
                {fxSlots.length} plugin{fxSlots.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="fx-slots-list overflow-y-auto">
              {loading ? (
                <div className="fx-empty-state">
                  <p>Loading plugins...</p>
                </div>
              ) : fxSlots.length === 0 ? (
                <div className="fx-empty-state">
                  <p>No plugins loaded</p>
                  <p className="hint">Add plugins from the browser →</p>
                </div>
              ) : (
                fxSlots.map((fx, index) => (
                  <div
                    key={fx.index}
                    className={`fx-slot-item ${draggedIndex === index ? "dragging" : ""}`}
                    draggable
                    onDragStart={() => handleDragStart(index)}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, index)}
                    onClick={() => handleOpenEditor(fx.index)}
                  >
                    <div className="fx-drag-handle" title="Drag to reorder">
                      ☰
                    </div>
                    <div className="fx-slot-info">
                      <div className="fx-slot-number">{index + 1}</div>
                      <div
                        className="fx-slot-name"
                        onClick={() => handleOpenEditor(fx.index)}
                        title="Click to open editor"
                      >
                        {fx.name}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleRemove(fx.index)}
                      title="Remove plugin"
                      className="fx-remove-btn"
                    >
                      ×
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Column: Plugin Browser */}
          <div className="fx-chain-browser-column overflow-y-auto">
            <div className="fx-column-header">
              <h4>Available Plugins</h4>
            </div>

            {/* Search and Filter */}
            <div className="flex gap-2 p-2 bg-neutral-800">
              <Input
                type="text"
                variant="default"
                size="md"
                placeholder="Search plugins..."
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
                disabled={pluginsLoading}
              >
                {pluginsLoading ? "Scanning..." : "Scan"}
              </Button>
            </div>

            {/* Plugin List */}
            <div className="flex-1 overflow-y-auto p-2">
              {pluginsLoading ? (
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
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleAddPlugin(plugin)}
                    >
                      Add
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

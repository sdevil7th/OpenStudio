import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  X,
  GripVertical,
  Waves,
  Timer,
  SlidersHorizontal,
  Gauge,
  Zap,
  Activity,
  AudioWaveform,
  Music,
  Box,
} from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Button, Input, Select } from "./ui";
import "./FXChainPanel.css";

interface FXChainPanelProps {
  trackId: string;
  trackName: string;
  chainType: "input" | "track" | "master";
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
  snapshot?: string;
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

export function FXChainPanel({
  trackId,
  trackName,
  chainType,
  onClose,
}: FXChainPanelProps) {
  const { updateTrack, addTrackFXWithUndo, removeTrackFXWithUndo } = useDAWStore(
    useShallow((s) => ({
      updateTrack: s.updateTrack,
      addTrackFXWithUndo: s.addTrackFXWithUndo,
      removeTrackFXWithUndo: s.removeTrackFXWithUndo,
    }))
  );
  const [fxSlots, setFxSlots] = useState<FXSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [addingPlugin, setAddingPlugin] = useState<string | null>(null);

  // Plugin browser state
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");

  useEffect(() => {
    loadPlugins();
    loadAvailablePlugins();
  }, [trackId, chainType]);

  // Sync FX counts to the store so track headers/channel strips can show indicators
  const updateFxCounts = async () => {
    try {
      const inputFx = await nativeBridge.getTrackInputFX(trackId);
      const trackFx = await nativeBridge.getTrackFX(trackId);
      updateTrack(trackId, {
        inputFxCount: inputFx.length,
        trackFxCount: trackFx.length,
      });
    } catch (e) {
      // Non-critical, ignore
    }
  };

  const loadPlugins = async () => {
    setLoading(true);
    try {
      const plugins =
        chainType === "master"
          ? await nativeBridge.getMasterFX()
          : chainType === "input"
            ? await nativeBridge.getTrackInputFX(trackId)
            : await nativeBridge.getTrackFX(trackId);
      setFxSlots(plugins);
      // Update store FX counts
      if (chainType === "master") {
        useDAWStore.setState({ masterFxCount: plugins.length });
      } else {
        updateFxCounts();
      }
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
    setAddingPlugin(plugin.fileOrIdentifier);
    try {
      let success = false;
      if (chainType === "master") {
        success = await nativeBridge.addMasterFX(plugin.fileOrIdentifier);
      } else if (chainType === "input" || chainType === "track") {
        success = await addTrackFXWithUndo(trackId, plugin.fileOrIdentifier, chainType);
      }

      if (success) {
        console.log(`[FXChain] Added ${plugin.name} to ${chainType} chain`);
        await loadPlugins(); // Reload FX list
      }
    } catch (e) {
      console.error("[FXChain] Failed to add plugin:", e);
    } finally {
      setAddingPlugin(null);
    }
  };

  const handleOpenEditor = async (fxIndex: number) => {
    try {
      if (chainType === "master") {
        await nativeBridge.openMasterFXEditor(fxIndex);
      } else {
        await nativeBridge.openPluginEditor(trackId, fxIndex, chainType === "input");
      }
      console.log(
        `[FXChain] Opened editor for ${chainType} FX ${fxIndex} on track ${trackId}`,
      );
    } catch (e) {
      console.error("[FXChain] Failed to open editor:", e);
    }
  };

  const handleRemove = async (fxIndex: number) => {
    try {
      let success = false;
      if (chainType === "master") {
        await nativeBridge.removeMasterFX(fxIndex);
        success = true;
      } else if (chainType === "input" || chainType === "track") {
        success = await removeTrackFXWithUndo(trackId, fxIndex, chainType);
      }

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
      let success = false;
      if (chainType === "master") {
        // Master FX reorder not yet supported
        success = false;
      } else if (chainType === "input") {
        success = await nativeBridge.reorderTrackInputFX(trackId, draggedIndex, dropIndex);
      } else {
        success = await nativeBridge.reorderTrackFX(trackId, draggedIndex, dropIndex);
      }

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
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      p.name.toLowerCase().includes(term) ||
      p.manufacturer.toLowerCase().includes(term) ||
      p.category.toLowerCase().includes(term);
    const matchesCategory =
      categoryFilter === "All" || p.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  return createPortal(
    <div className="fx-chain-overlay" onClick={onClose}>
      <div
        className="fx-chain-panel-two-column"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fx-chain-header">
          <h3>
            {chainType === "master" ? "Master FX Chain" : chainType === "input" ? "Input FX Chain" : "Track FX Chain"} -{" "}
            {trackName}
          </h3>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X size={16} />
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
                      <GripVertical size={14} />
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
                      <X size={14} />
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
                filteredPlugins.map((plugin, idx) => {
                  const { Icon, color } = getCategoryIcon(plugin.category);
                  return (
                    <div
                      key={idx}
                      className="flex items-center gap-2 p-2 bg-neutral-800 border border-neutral-700 rounded mb-2 hover:border-blue-500 transition-colors"
                    >
                      {/* Snapshot or category icon */}
                      {plugin.snapshot ? (
                        <img
                          src={plugin.snapshot}
                          alt={plugin.name}
                          className="w-8 h-8 rounded object-cover shrink-0"
                        />
                      ) : (
                        <div
                          className="w-8 h-8 rounded flex items-center justify-center shrink-0"
                          style={{ backgroundColor: color + "20", border: `1px solid ${color}40` }}
                        >
                          <Icon size={16} />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-white text-sm truncate">
                          {plugin.name}
                        </div>
                        <div className="text-[10px] text-neutral-400">
                          {plugin.manufacturer}
                        </div>
                        <div className="text-[9px] text-neutral-500">
                          {plugin.category}
                        </div>
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleAddPlugin(plugin)}
                        disabled={addingPlugin !== null}
                      >
                        {addingPlugin === plugin.fileOrIdentifier ? "Adding..." : "Add"}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

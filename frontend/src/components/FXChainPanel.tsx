import { useState, useEffect, useRef, useCallback } from "react";
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
  Code,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ArrowLeftRight,
  Save,
  FolderOpen,
  Trash2,
  List,
  Disc3,
  Radio,
} from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Button, Input, Select } from "./ui";
import {
  EQGraph,
  CompressorGraph,
  GateGraph,
  DelayGraph,
  ReverbGraph,
  SaturationGraph,
  ChorusGraph,
} from "./ParametricGraph";
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
  type?: "vst3" | "lv2" | "clap" | "s13fx";
  pluginPath?: string;
}

interface S13FXSlider {
  index: number;
  name: string;
  min: number;
  max: number;
  def: number;
  inc: number;
  value: number;
  isEnum: boolean;
  enumNames?: string[];
}

interface PluginParam {
  index: number;
  name: string;
  value: number;
  text: string;
}

interface Plugin {
  name: string;
  manufacturer: string;
  category: string;
  fileOrIdentifier: string;
  isInstrument: boolean;
  snapshot?: string;
  pluginType?: "vst3" | "lv2" | "clap" | "s13fx";
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
  const {
    updateTrack, addTrackFXWithUndo, removeTrackFXWithUndo,
    pluginABStates, togglePluginAB,
    fxChainPresets, saveFXChainPreset, loadFXChainPreset, deleteFXChainPreset,
    addAutomationLane,
  } = useDAWStore(
    useShallow((s) => ({
      updateTrack: s.updateTrack,
      addTrackFXWithUndo: s.addTrackFXWithUndo,
      removeTrackFXWithUndo: s.removeTrackFXWithUndo,
      pluginABStates: s.pluginABStates,
      togglePluginAB: s.togglePluginAB,
      fxChainPresets: s.fxChainPresets,
      saveFXChainPreset: s.saveFXChainPreset,
      loadFXChainPreset: s.loadFXChainPreset,
      deleteFXChainPreset: s.deleteFXChainPreset,
      addAutomationLane: s.addAutomationLane,
    }))
  );
  const [fxSlots, setFxSlots] = useState<FXSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [addingPlugin, setAddingPlugin] = useState<string | null>(null);
  const [bypassedFx, setBypassedFx] = useState<Set<number>>(new Set());
  const [expandedS13FX, setExpandedS13FX] = useState<number | null>(null);
  const [s13fxSliders, setS13fxSliders] = useState<S13FXSlider[]>([]);
  const [showRawSliders, setShowRawSliders] = useState(false);
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [presetName, setPresetName] = useState("");

  // Plugin parameter list state (per-slot)
  const [expandedParamsFx, setExpandedParamsFx] = useState<number | null>(null);
  const [pluginParams, setPluginParams] = useState<PluginParam[]>([]);
  const [paramsLoading, setParamsLoading] = useState(false);

  // Plugin presets state (per-slot)
  const [expandedPresetsFx, setExpandedPresetsFx] = useState<number | null>(null);
  const [pluginPresetsList, setPluginPresetsList] = useState<string[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [savePresetName, setSavePresetName] = useState("");

  // MIDI Learn state
  const [midiLearnActive, setMidiLearnActive] = useState<{ fxIndex: number; paramIndex: number } | null>(null);
  const midiLearnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleStartMIDILearn = useCallback(async (fxIndex: number, paramIndex: number) => {
    // Cancel any existing learn session
    if (midiLearnActive) {
      await nativeBridge.cancelPluginMIDILearn();
      if (midiLearnTimerRef.current) clearTimeout(midiLearnTimerRef.current);
    }
    setMidiLearnActive({ fxIndex, paramIndex });
    await nativeBridge.startPluginMIDILearn(trackId, fxIndex, paramIndex);
    // Auto-cancel after 10 seconds
    midiLearnTimerRef.current = setTimeout(async () => {
      await nativeBridge.cancelPluginMIDILearn();
      setMidiLearnActive(null);
      midiLearnTimerRef.current = null;
    }, 10000);
  }, [midiLearnActive, trackId]);

  const handleCancelMIDILearn = useCallback(async () => {
    if (midiLearnTimerRef.current) clearTimeout(midiLearnTimerRef.current);
    midiLearnTimerRef.current = null;
    await nativeBridge.cancelPluginMIDILearn();
    setMidiLearnActive(null);
  }, []);

  // Clean up MIDI learn timer on unmount
  useEffect(() => {
    return () => {
      if (midiLearnTimerRef.current) {
        clearTimeout(midiLearnTimerRef.current);
        nativeBridge.cancelPluginMIDILearn();
      }
    };
  }, []);

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
      // Reset bypass tracking when FX list changes (indices may have shifted)
      setBypassedFx(new Set());
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
      const vst3Plugins: Plugin[] = pluginList.map((p: any) => {
        const fmt = (p.pluginFormatName || "").toLowerCase();
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
        // S13FX not available
      }

      setPlugins([...vst3Plugins, ...s13fxPlugins]);
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

      if (plugin.pluginType === "s13fx") {
        if (chainType === "master") {
          success = await nativeBridge.addMasterS13FX(plugin.fileOrIdentifier);
        } else {
          const isInputFX = chainType === "input";
          success = await nativeBridge.addTrackS13FX(trackId, plugin.fileOrIdentifier, isInputFX);
        }
      } else if (chainType === "master") {
        success = await nativeBridge.addMasterFX(plugin.fileOrIdentifier);
      } else if (chainType === "input" || chainType === "track") {
        success = await addTrackFXWithUndo(trackId, plugin.fileOrIdentifier, chainType);
      }

      if (success) {
        console.log(`[FXChain] Added ${plugin.name} to ${chainType} chain`);
        await loadPlugins();
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

  const handleToggleBypass = async (fxIndex: number) => {
    const isBypassed = bypassedFx.has(fxIndex);
    const newBypassed = !isBypassed;
    try {
      let success = false;
      if (chainType === "master") {
        // Master FX bypass not supported in backend yet
        success = false;
      } else if (chainType === "input") {
        success = await nativeBridge.bypassTrackInputFX(trackId, fxIndex, newBypassed);
      } else {
        success = await nativeBridge.bypassTrackFX(trackId, fxIndex, newBypassed);
      }
      if (success) {
        setBypassedFx((prev) => {
          const next = new Set(prev);
          if (newBypassed) next.add(fxIndex);
          else next.delete(fxIndex);
          return next;
        });
      }
    } catch (e) {
      console.error("[FXChain] Failed to toggle bypass:", e);
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

  const handleToggleS13FXSliders = async (fxIndex: number) => {
    if (expandedS13FX === fxIndex) {
      setExpandedS13FX(null);
      setS13fxSliders([]);
      return;
    }
    try {
      const isInputFX = chainType === "input";
      const sliders = await nativeBridge.getS13FXSliders(trackId, fxIndex, isInputFX);
      setS13fxSliders(sliders);
      setExpandedS13FX(fxIndex);
    } catch (e) {
      console.error("[FXChain] Failed to load S13FX sliders:", e);
    }
  };

  const handleS13FXSliderChange = async (sliderIndex: number, value: number) => {
    if (expandedS13FX === null) return;
    const isInputFX = chainType === "input";
    await nativeBridge.setS13FXSlider(trackId, expandedS13FX, isInputFX, sliderIndex, value);
    setS13fxSliders((prev) =>
      prev.map((s) => (s.index === sliderIndex ? { ...s, value } : s)),
    );
  };

  const handleReloadS13FX = async (fxIndex: number) => {
    try {
      const isInputFX = chainType === "input";
      const success = await nativeBridge.reloadS13FX(trackId, fxIndex, isInputFX);
      if (success) {
        console.log("[FXChain] Reloaded S13FX at index", fxIndex);
        await loadPlugins();
        if (expandedS13FX === fxIndex) {
          const sliders = await nativeBridge.getS13FXSliders(trackId, fxIndex, isInputFX);
          setS13fxSliders(sliders);
        }
      }
    } catch (e) {
      console.error("[FXChain] Failed to reload S13FX:", e);
    }
  };

  // ---- Plugin Parameter List handlers ----
  const handleToggleParams = async (fxIndex: number) => {
    if (expandedParamsFx === fxIndex) {
      setExpandedParamsFx(null);
      setPluginParams([]);
      return;
    }
    setParamsLoading(true);
    try {
      const isInputFX = chainType === "input";
      const params = await nativeBridge.getPluginParameters(trackId, fxIndex, isInputFX);
      setPluginParams(params);
      setExpandedParamsFx(fxIndex);
      // Close presets panel if open on another slot
      setExpandedPresetsFx(null);
    } catch (e) {
      console.error("[FXChain] Failed to load plugin parameters:", e);
    } finally {
      setParamsLoading(false);
    }
  };

  const handleAutomateParam = (fxIndex: number, param: PluginParam) => {
    if (chainType === "master") return; // Master automation not supported
    const automationParam = `plugin_${fxIndex}_${param.index}`;
    addAutomationLane(trackId, automationParam, `${fxSlots.find((f) => f.index === fxIndex)?.name || "Plugin"}: ${param.name}`);
  };

  // ---- Plugin Presets handlers ----
  const handleTogglePluginPresets = async (fxIndex: number) => {
    if (expandedPresetsFx === fxIndex) {
      setExpandedPresetsFx(null);
      setPluginPresetsList([]);
      return;
    }
    setPresetsLoading(true);
    try {
      const isInputFX = chainType === "input";
      const presets = await nativeBridge.getPluginPresets(trackId, fxIndex, isInputFX);
      setPluginPresetsList(presets);
      setExpandedPresetsFx(fxIndex);
      // Close params panel if open on another slot
      setExpandedParamsFx(null);
    } catch (e) {
      console.error("[FXChain] Failed to load plugin presets:", e);
    } finally {
      setPresetsLoading(false);
    }
  };

  const handleLoadPluginPreset = async (fxIndex: number, presetNameStr: string) => {
    try {
      const isInputFX = chainType === "input";
      await nativeBridge.loadPluginPreset(trackId, fxIndex, isInputFX, presetNameStr);
      console.log(`[FXChain] Loaded preset "${presetNameStr}" on FX ${fxIndex}`);
    } catch (e) {
      console.error("[FXChain] Failed to load plugin preset:", e);
    }
  };

  const handleSavePluginPreset = async (fxIndex: number) => {
    const name = savePresetName.trim();
    if (!name) return;
    try {
      const isInputFX = chainType === "input";
      await nativeBridge.savePluginPreset(trackId, fxIndex, isInputFX, name);
      console.log(`[FXChain] Saved preset "${name}" on FX ${fxIndex}`);
      setSavePresetName("");
      // Refresh the presets list
      const presets = await nativeBridge.getPluginPresets(trackId, fxIndex, isInputFX);
      setPluginPresetsList(presets);
    } catch (e) {
      console.error("[FXChain] Failed to save plugin preset:", e);
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
              <div className="flex items-center gap-1.5">
                <span className="fx-count">
                  {fxSlots.length} plugin{fxSlots.length !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={() => setShowPresetMenu(!showPresetMenu)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
                  title="FX Chain Presets"
                >
                  <FolderOpen size={11} />
                  Presets
                </button>
              </div>
            </div>

            {/* FX Chain Presets Panel */}
            {showPresetMenu && (
              <div className="bg-neutral-800 border border-neutral-700 rounded mx-1 mb-1 p-2 space-y-2">
                {/* Save Current Chain */}
                <div className="flex gap-1.5">
                  <Input
                    type="text"
                    variant="default"
                    size="sm"
                    placeholder="Preset name..."
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    className="flex-1 text-xs"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!presetName.trim() || fxSlots.length === 0}
                    onClick={async () => {
                      await saveFXChainPreset(trackId, presetName.trim(), chainType);
                      setPresetName("");
                    }}
                    title="Save current FX chain as preset"
                  >
                    <Save size={12} />
                  </Button>
                </div>

                {/* Preset List */}
                {fxChainPresets.length === 0 ? (
                  <div className="text-[10px] text-neutral-500 text-center py-1">
                    No presets saved yet
                  </div>
                ) : (
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {fxChainPresets.map((preset, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-neutral-700/50 hover:bg-neutral-700 transition-colors group"
                      >
                        <span className="flex-1 text-xs text-neutral-300 truncate">
                          {preset.name}
                        </span>
                        <span className="text-[9px] text-neutral-500">
                          {preset.plugins.length} fx
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={async () => {
                            await loadFXChainPreset(trackId, idx, chainType);
                            await loadPlugins();
                            setShowPresetMenu(false);
                          }}
                          title={`Load preset "${preset.name}"`}
                          className="opacity-60 group-hover:opacity-100"
                        >
                          <FolderOpen size={11} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => deleteFXChainPreset(idx)}
                          title={`Delete preset "${preset.name}"`}
                          className="opacity-60 group-hover:opacity-100 hover:text-red-400"
                        >
                          <Trash2 size={11} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

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
                fxSlots.map((fx, index) => {
                  const isS13FX = fx.type === "s13fx";
                  return (
                    <div key={fx.index}>
                      <div
                        className={`fx-slot-item ${draggedIndex === index ? "dragging" : ""} ${isS13FX ? "border-l-2 border-l-lime-500" : ""}`}
                        draggable
                        onDragStart={() => handleDragStart(index)}
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDrop(e, index)}
                        onClick={() => isS13FX ? handleToggleS13FXSliders(fx.index) : handleOpenEditor(fx.index)}
                      >
                        <div className="fx-drag-handle" title="Drag to reorder">
                          <GripVertical size={14} />
                        </div>
                        <input
                          type="checkbox"
                          checked={!bypassedFx.has(fx.index)}
                          onChange={(e) => { e.stopPropagation(); handleToggleBypass(fx.index); }}
                          onClick={(e) => e.stopPropagation()}
                          title={bypassedFx.has(fx.index) ? "Enable plugin" : "Bypass plugin"}
                          className="fx-bypass-checkbox"
                          style={{ accentColor: "#22c55e", width: 14, height: 14, cursor: "pointer", flexShrink: 0 }}
                        />
                        <div className="fx-slot-info" style={{ opacity: bypassedFx.has(fx.index) ? 0.4 : 1 }}>
                          <div className="fx-slot-number">
                            {isS13FX ? <Code size={12} className="text-lime-400" /> : index + 1}
                          </div>
                          <div
                            className="fx-slot-name"
                            title={isS13FX ? "Click to show sliders" : "Click to open editor"}
                          >
                            {fx.name}
                          </div>
                        </div>
                        {isS13FX && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={(e) => { e.stopPropagation(); handleReloadS13FX(fx.index); }}
                            title="Reload script"
                            className="fx-remove-btn"
                          >
                            <RefreshCw size={12} />
                          </Button>
                        )}
                        {/* A/B Comparison Toggle */}
                        {!isS13FX && (() => {
                          const abKey = `${trackId}-${fx.index}`;
                          const abState = pluginABStates[abKey];
                          const activeSlot = abState?.active || "a";
                          return (
                            <button
                              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors shrink-0 ${
                                activeSlot === "a"
                                  ? "bg-blue-600/30 text-blue-400 border border-blue-500/50"
                                  : "bg-orange-600/30 text-orange-400 border border-orange-500/50"
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePluginAB(trackId, fx.index, chainType === "input");
                              }}
                              title={`A/B Compare - Active: ${activeSlot.toUpperCase()}. Click to toggle.`}
                            >
                              <ArrowLeftRight size={10} />
                              {activeSlot.toUpperCase()}
                            </button>
                          );
                        })()}
                        {/* Parameters button */}
                        {!isS13FX && (
                          <button
                            className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors shrink-0 ${
                              expandedParamsFx === fx.index
                                ? "bg-cyan-600/30 text-cyan-400 border border-cyan-500/50"
                                : "text-neutral-400 hover:text-white hover:bg-neutral-700"
                            }`}
                            onClick={(e) => { e.stopPropagation(); handleToggleParams(fx.index); }}
                            title="Browse automatable parameters"
                          >
                            <List size={10} />
                          </button>
                        )}
                        {/* Presets button */}
                        {!isS13FX && (
                          <button
                            className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors shrink-0 ${
                              expandedPresetsFx === fx.index
                                ? "bg-purple-600/30 text-purple-400 border border-purple-500/50"
                                : "text-neutral-400 hover:text-white hover:bg-neutral-700"
                            }`}
                            onClick={(e) => { e.stopPropagation(); handleTogglePluginPresets(fx.index); }}
                            title="Plugin presets"
                          >
                            <Disc3 size={10} />
                          </button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => { e.stopPropagation(); handleRemove(fx.index); }}
                          title="Remove plugin"
                          className="fx-remove-btn"
                        >
                          <X size={14} />
                        </Button>
                      </div>

                      {/* Plugin Parameter Automation List */}
                      {!isS13FX && expandedParamsFx === fx.index && (
                        <div className="bg-neutral-900 border border-neutral-700 border-t-0 rounded-b p-2">
                          <div className="text-[10px] text-neutral-400 mb-1.5 font-medium">Automatable Parameters</div>
                          {paramsLoading ? (
                            <div className="text-[10px] text-neutral-500 text-center py-2">Loading parameters...</div>
                          ) : pluginParams.length === 0 ? (
                            <div className="text-[10px] text-neutral-500 text-center py-2">No parameters available</div>
                          ) : (
                            <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                              {pluginParams.map((param) => {
                                const isLearning = midiLearnActive?.fxIndex === fx.index && midiLearnActive?.paramIndex === param.index;
                                return (
                                  <div
                                    key={param.index}
                                    className={`flex items-center gap-1.5 px-1.5 py-1 rounded bg-neutral-800/50 hover:bg-neutral-800 transition-colors group ${isLearning ? "ring-1 ring-amber-500/60" : ""}`}
                                  >
                                    <span className="flex-1 text-[11px] text-neutral-300 truncate" title={param.name}>
                                      {param.name}
                                    </span>
                                    <span className="text-[9px] text-neutral-500 shrink-0 w-14 text-right truncate" title={param.text}>
                                      {param.text}
                                    </span>
                                    {/* MIDI Learn button */}
                                    {isLearning ? (
                                      <button
                                        className="text-[9px] px-1.5 py-0.5 rounded bg-amber-700/40 text-amber-300 hover:bg-amber-700/70 transition-colors shrink-0 animate-pulse"
                                        onClick={() => handleCancelMIDILearn()}
                                        title="Cancel MIDI Learn"
                                      >
                                        Listening...
                                      </button>
                                    ) : (
                                      <button
                                        className="text-[9px] px-1.5 py-0.5 rounded bg-amber-700/20 text-amber-400 hover:bg-amber-700/50 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                                        onClick={() => handleStartMIDILearn(fx.index, param.index)}
                                        title={`MIDI Learn: assign a CC to "${param.name}"`}
                                      >
                                        <Radio size={9} className="inline mr-0.5" />
                                        Learn
                                      </button>
                                    )}
                                    {chainType !== "master" && (
                                      <button
                                        className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-700/30 text-cyan-400 hover:bg-cyan-700/60 transition-colors opacity-60 group-hover:opacity-100 shrink-0"
                                        onClick={() => handleAutomateParam(fx.index, param)}
                                        title={`Create automation lane for "${param.name}"`}
                                      >
                                        Automate
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Plugin Presets Browser */}
                      {!isS13FX && expandedPresetsFx === fx.index && (
                        <div className="bg-neutral-900 border border-neutral-700 border-t-0 rounded-b p-2">
                          <div className="text-[10px] text-neutral-400 mb-1.5 font-medium">Plugin Presets</div>
                          {/* Save Preset */}
                          <div className="flex gap-1.5 mb-2">
                            <input
                              type="text"
                              placeholder="Save as..."
                              value={savePresetName}
                              onChange={(e) => setSavePresetName(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              className="flex-1 bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-[11px] text-white placeholder-neutral-500 outline-none focus:border-purple-500"
                            />
                            <button
                              className="text-[9px] px-2 py-0.5 rounded bg-purple-700/40 text-purple-300 hover:bg-purple-700/70 transition-colors disabled:opacity-30"
                              onClick={() => handleSavePluginPreset(fx.index)}
                              disabled={!savePresetName.trim()}
                              title="Save current settings as a preset"
                            >
                              <Save size={10} />
                            </button>
                          </div>
                          {/* Preset List */}
                          {presetsLoading ? (
                            <div className="text-[10px] text-neutral-500 text-center py-2">Loading presets...</div>
                          ) : pluginPresetsList.length === 0 ? (
                            <div className="text-[10px] text-neutral-500 text-center py-2">No presets available</div>
                          ) : (
                            <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                              {pluginPresetsList.map((preset, idx) => (
                                <button
                                  key={idx}
                                  className="w-full text-left flex items-center gap-1.5 px-1.5 py-1 rounded bg-neutral-800/50 hover:bg-neutral-800 transition-colors text-[11px] text-neutral-300"
                                  onClick={() => handleLoadPluginPreset(fx.index, preset)}
                                  title={`Load preset "${preset}"`}
                                >
                                  <Disc3 size={10} className="text-purple-400 shrink-0" />
                                  <span className="truncate">{preset}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* S13FX inline sliders + advanced graph */}
                      {isS13FX && expandedS13FX === fx.index && s13fxSliders.length > 0 && (() => {
                        const advancedType = fx.pluginPath?.match(/(\w+)_advanced\.jsfx/)?.[1];
                        const hasGraph = !!advancedType && ["eq", "compressor", "gate", "delay", "reverb", "saturation", "chorus"].includes(advancedType);
                        const graphProps = { sliders: s13fxSliders, onSliderChange: handleS13FXSliderChange, width: 340, height: 180 };
                        return (
                          <div className="bg-neutral-900 border border-neutral-700 border-t-0 rounded-b p-2 space-y-1.5">
                            {/* Advanced parametric graph */}
                            {advancedType === "eq" && <EQGraph {...graphProps} />}
                            {advancedType === "compressor" && <CompressorGraph {...graphProps} />}
                            {advancedType === "gate" && <GateGraph {...graphProps} />}
                            {advancedType === "delay" && <DelayGraph {...graphProps} />}
                            {advancedType === "reverb" && <ReverbGraph {...graphProps} />}
                            {advancedType === "saturation" && <SaturationGraph {...graphProps} />}
                            {advancedType === "chorus" && <ChorusGraph {...graphProps} />}

                            {/* Raw sliders toggle when graph is present */}
                            {hasGraph && (
                              <button
                                onClick={() => setShowRawSliders((v) => !v)}
                                className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors"
                              >
                                {showRawSliders ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                {showRawSliders ? "Hide" : "Show"} raw sliders
                              </button>
                            )}

                            {/* Raw sliders (always shown if no graph, toggleable if graph present) */}
                            {(!hasGraph || showRawSliders) && s13fxSliders.map((slider) => (
                              <div key={slider.index} className="flex items-center gap-2 text-xs">
                                <span className="text-neutral-400 w-24 truncate shrink-0" title={slider.name}>
                                  {slider.name}
                                </span>
                                {slider.isEnum && slider.enumNames ? (
                                  <select
                                    value={slider.value}
                                    onChange={(e) => handleS13FXSliderChange(slider.index, Number(e.target.value))}
                                    className="flex-1 bg-neutral-800 border border-neutral-600 rounded px-1 py-0.5 text-white text-xs"
                                  >
                                    {slider.enumNames.map((name, i) => (
                                      <option key={i} value={i}>{name}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type="range"
                                    min={slider.min}
                                    max={slider.max}
                                    step={slider.inc || 0.001}
                                    value={slider.value}
                                    onChange={(e) => handleS13FXSliderChange(slider.index, Number(e.target.value))}
                                    className="flex-1 accent-lime-500"
                                  />
                                )}
                                <span className="text-neutral-500 w-12 text-right shrink-0">
                                  {slider.value.toFixed(slider.inc >= 1 ? 0 : 2)}
                                </span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })
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
                  const isScript = plugin.pluginType === "s13fx";
                  const { Icon, color } = isScript
                    ? { match: "Script", Icon: Code, color: "#84cc16" }
                    : getCategoryIcon(plugin.category);
                  return (
                    <div
                      key={idx}
                      className={`flex items-center gap-2 p-2 bg-neutral-800 border rounded mb-2 hover:border-blue-500 transition-colors ${
                        isScript ? "border-lime-700/40" : "border-neutral-700"
                      }`}
                    >
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
                          {isScript && (
                            <span className="ml-1.5 text-[9px] font-normal text-lime-400 bg-lime-900/30 px-1 py-0.5 rounded">
                              S13FX
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-neutral-400">
                          {plugin.manufacturer}
                        </div>
                        <div className="text-[9px] text-neutral-500">
                          {isScript ? "JSFX Script" : plugin.category}
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

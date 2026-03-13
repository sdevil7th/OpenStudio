import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";

import { X, Save, Trash2, ExternalLink, ArrowDownToLine, Plus, Power } from "lucide-react";
import { ChannelStrip } from "./ChannelStrip";
import { SortableTrack } from "./SortableTrack";
import { DetachablePanel } from "./DetachablePanel";
import { useDAWStore, Track, MixerSnapshot } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { nativeBridge } from "../services/NativeBridge";
import { Button } from "./ui";
import { useCallback, useState, useEffect } from "react";

interface MixerPanelProps {
  isVisible: boolean;
  isDetached?: boolean;
  onDetach?: () => void;
  onAttach?: () => void;
  onClose?: () => void;
}

export function MixerPanel({ isVisible, isDetached = false, onDetach, onAttach, onClose }: MixerPanelProps) {
  const {
    tracks,
    masterVolume,
    masterPan,
    masterLevel,
    masterFxCount,
    toggleMixer,
    reorderTrack,
    selectedTrackIds,
    selectTrack,
    deselectAllTracks,
    mixerSnapshots,
    saveMixerSnapshot,
    recallMixerSnapshot,
    deleteMixerSnapshot,
  } = useDAWStore(useShallow((s) => ({
    tracks: s.tracks,
    masterVolume: s.masterVolume,
    masterPan: s.masterPan,
    masterLevel: s.masterLevel,
    masterFxCount: s.masterFxCount,
    toggleMixer: s.toggleMixer,
    reorderTrack: s.reorderTrack,
    selectedTrackIds: s.selectedTrackIds,
    selectTrack: s.selectTrack,
    deselectAllTracks: s.deselectAllTracks,
    mixerSnapshots: s.mixerSnapshots,
    saveMixerSnapshot: s.saveMixerSnapshot,
    recallMixerSnapshot: s.recallMixerSnapshot,
    deleteMixerSnapshot: s.deleteMixerSnapshot,
  })));

  const handleDetach = useCallback(() => onDetach?.(), [onDetach]);
  const handleAttach = useCallback(() => onAttach?.(), [onAttach]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      reorderTrack(active.id.toString(), over.id.toString());
    }
  };

  // --- Monitoring FX state ---
  interface MonitorFXSlot {
    index: number;
    name: string;
    pluginPath?: string;
    bypassed?: boolean;
  }
  const [monitorFXList, setMonitorFXList] = useState<MonitorFXSlot[]>([]);
  const [showMonitorPluginPicker, setShowMonitorPluginPicker] = useState(false);
  const [availablePlugins, setAvailablePlugins] = useState<{ name: string; fileOrIdentifier: string }[]>([]);
  const [monitorPluginSearch, setMonitorPluginSearch] = useState("");
  const [addingMonitorPlugin, setAddingMonitorPlugin] = useState(false);

  const refreshMonitorFX = useCallback(async () => {
    try {
      const list = await nativeBridge.getMonitoringFX();
      setMonitorFXList(list);
    } catch (e) {
      console.error("[MixerPanel] Failed to get monitoring FX:", e);
    }
  }, []);

  useEffect(() => {
    if (isVisible) {
      refreshMonitorFX();
    }
  }, [isVisible, refreshMonitorFX]);

  const handleAddMonitorFX = useCallback(async (pluginPath: string) => {
    setAddingMonitorPlugin(true);
    try {
      const success = await nativeBridge.addMonitoringFX(pluginPath);
      if (success) {
        await refreshMonitorFX();
        setShowMonitorPluginPicker(false);
        setMonitorPluginSearch("");
      }
    } catch (e) {
      console.error("[MixerPanel] Failed to add monitoring FX:", e);
    } finally {
      setAddingMonitorPlugin(false);
    }
  }, [refreshMonitorFX]);

  const handleRemoveMonitorFX = useCallback(async (fxIndex: number) => {
    try {
      await nativeBridge.removeMonitoringFX(fxIndex);
      await refreshMonitorFX();
    } catch (e) {
      console.error("[MixerPanel] Failed to remove monitoring FX:", e);
    }
  }, [refreshMonitorFX]);

  const handleBypassMonitorFX = useCallback(async (fxIndex: number, bypassed: boolean) => {
    try {
      await nativeBridge.bypassMonitoringFX(fxIndex, bypassed);
      await refreshMonitorFX();
    } catch (e) {
      console.error("[MixerPanel] Failed to bypass monitoring FX:", e);
    }
  }, [refreshMonitorFX]);

  const handleOpenMonitorFXEditor = useCallback(async (fxIndex: number) => {
    try {
      await nativeBridge.openMonitoringFXEditor(fxIndex);
    } catch (e) {
      console.error("[MixerPanel] Failed to open monitoring FX editor:", e);
    }
  }, []);

  const handleOpenMonitorPluginPicker = useCallback(async () => {
    try {
      const plugins = await nativeBridge.getAvailablePlugins();
      setAvailablePlugins(
        plugins
          .filter((p: any) => !p.isInstrument)
          .map((p: any) => ({ name: p.name, fileOrIdentifier: p.fileOrIdentifier }))
      );
    } catch (e) {
      console.error("[MixerPanel] Failed to load plugins for monitor FX:", e);
    }
    setShowMonitorPluginPicker(true);
  }, []);

  const filteredMonitorPlugins = availablePlugins.filter((p) =>
    p.name.toLowerCase().includes(monitorPluginSearch.toLowerCase())
  );

  const masterVolumeDB = masterVolume > 0 ? 20 * Math.log10(masterVolume) : -60;

  // Create a virtual master track for the ChannelStrip component
  const masterTrack: Track = {
    id: "master",
    name: "MASTER",
    color: "#0078d4",
    type: "audio",
    inputType: "stereo",
    volume: masterVolume,
    volumeDB: masterVolumeDB,
    pan: masterPan,
    muted: false,
    soloed: false,
    armed: false,
    recordSafe: false,
    monitorEnabled: false,
    inputChannel: null,
    inputStartChannel: 0,
    inputChannelCount: 2,
    clips: [],
    midiClips: [],
    inputFxCount: 0,
    trackFxCount: masterFxCount,
    fxBypassed: false,
    meterLevel: masterLevel,
    peakLevel: masterLevel,
    clipping: false,
    automationLanes: [],
    showAutomation: false,
    frozen: false,
    takes: [],
    activeTakeIndex: 0,
    sends: [],
    phaseInverted: false,
    stereoWidth: 100,
    masterSendEnabled: true,
    outputStartChannel: 0,
    outputChannelCount: 2,
    playbackOffsetMs: 0,
    trackChannelCount: 2,
    midiOutputDevice: "",
  };

  const mixerContent = (
    <section
      aria-label="Mixer"
      className="bg-neutral-800 border-t-2 border-neutral-950 flex flex-col shrink-0 overflow-hidden"
      style={isDetached
        ? { height: "100vh" }
        : {
            height: isVisible ? 340 : 0,
            opacity: isVisible ? 1 : 0,
            transition: "height 0.2s ease-in-out, opacity 0.15s ease-in-out",
          }
      }
    >
      {/* Header */}
      <div className="h-5 bg-neutral-900 border-b border-neutral-700 flex items-center justify-between px-2 shrink-0">
        <span className="text-[9px] font-semibold text-neutral-400 uppercase tracking-wider">
          Mixer
        </span>
        <div className="flex items-center gap-0.5">
          {isDetached ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleAttach}
              title="Dock Mixer"
              aria-label="Dock mixer back into main window"
            >
              <ArrowDownToLine size={12} />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleDetach}
              title="Pop Out Mixer"
              aria-label="Detach mixer into separate window"
            >
              <ExternalLink size={12} />
            </Button>
          )}
          {!isDetached && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose || toggleMixer}
              title="Close Mixer"
              aria-label="Close mixer panel"
            >
              <X size={14} />
            </Button>
          )}
        </div>
      </div>

      {/* Mixer Snapshots Toolbar */}
      <div className="h-6 bg-neutral-900/60 border-b border-neutral-700/50 flex items-center gap-1 px-2 shrink-0 overflow-x-auto">
        <span className="text-[9px] text-neutral-500 uppercase tracking-wider mr-1 whitespace-nowrap">
          Snapshots
        </span>
        {mixerSnapshots.map((snap: MixerSnapshot, idx: number) => (
          <div key={`${snap.name}-${snap.timestamp}`} className="flex items-center gap-0.5 shrink-0">
            <button
              className="px-2 py-0.5 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded cursor-pointer transition-colors whitespace-nowrap"
              onClick={() => recallMixerSnapshot(idx)}
              title={`Recall "${snap.name}" (${new Date(snap.timestamp).toLocaleTimeString()})`}
              aria-label={`Recall mixer snapshot ${snap.name}`}
            >
              {snap.name}
            </button>
            <button
              className="text-neutral-500 hover:text-red-400 cursor-pointer transition-colors"
              onClick={() => deleteMixerSnapshot(idx)}
              title={`Delete "${snap.name}"`}
              aria-label={`Delete mixer snapshot ${snap.name}`}
            >
              <Trash2 size={10} />
            </button>
          </div>
        ))}
        <button
          className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] bg-neutral-700/50 hover:bg-neutral-600 text-neutral-400 hover:text-neutral-200 rounded cursor-pointer transition-colors whitespace-nowrap"
          onClick={() => {
            const name = prompt("Snapshot name:", `Snapshot ${mixerSnapshots.length + 1}`);
            if (name) saveMixerSnapshot(name);
          }}
          title="Save current mixer state as snapshot"
          aria-label="Save mixer snapshot"
        >
          <Save size={10} />
          Save
        </button>
      </div>

      {/* Channel Strips Container */}
      <div
        className="relative flex-1 flex overflow-x-auto overflow-y-hidden bg-neutral-900 p-1 gap-px pl-0"
        onClick={(e) => {
          if (e.target === e.currentTarget) deselectAllTracks();
        }}
      >
        <ChannelStrip track={masterTrack} trackIndex={-1} isMaster={true} />
        <div className="w-px bg-neutral-600 shrink-0 my-1" />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tracks.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tracks.map((track, index) => (
              <SortableTrack
                key={track.id}
                track={track}
                trackIndex={index}
                isSelected={selectedTrackIds.includes(track.id)}
                onSelect={(e) => selectTrack(track.id, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Monitor FX Section */}
        <div className="w-px bg-neutral-600 shrink-0 my-1" />
        <div className="flex flex-col shrink-0 w-[140px] bg-neutral-800/60 border border-dashed border-amber-700/40 rounded mx-0.5 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-2 py-1 bg-amber-900/20 border-b border-amber-700/30">
            <span className="text-[9px] font-semibold text-amber-400 uppercase tracking-wider">
              Monitor FX
            </span>
            <button
              className="text-amber-500 hover:text-amber-300 transition-colors cursor-pointer"
              onClick={handleOpenMonitorPluginPicker}
              title="Add Monitor FX"
              aria-label="Add monitoring effect plugin"
            >
              <Plus size={12} />
            </button>
          </div>

          {/* "Monitor Only" label */}
          <div className="px-2 py-0.5 bg-amber-900/10 border-b border-amber-700/20">
            <span className="text-[8px] text-amber-600 italic">
              Monitor Only — not in renders
            </span>
          </div>

          {/* FX Slots */}
          <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
            {monitorFXList.length === 0 ? (
              <div className="text-[9px] text-neutral-500 text-center py-4 px-1">
                No monitoring plugins. Click + to add.
              </div>
            ) : (
              monitorFXList.map((fx) => (
                <div
                  key={fx.index}
                  className={`flex items-center gap-1 px-1.5 py-1 rounded text-[10px] transition-colors ${
                    fx.bypassed
                      ? "bg-neutral-700/30 text-neutral-500"
                      : "bg-amber-900/20 text-amber-200"
                  }`}
                >
                  <button
                    className={`shrink-0 transition-colors cursor-pointer ${
                      fx.bypassed
                        ? "text-neutral-600 hover:text-amber-400"
                        : "text-amber-400 hover:text-amber-300"
                    }`}
                    onClick={() => handleBypassMonitorFX(fx.index, !fx.bypassed)}
                    title={fx.bypassed ? "Enable" : "Bypass"}
                    aria-label={fx.bypassed ? `Enable monitor effect ${fx.name}` : `Bypass monitor effect ${fx.name}`}
                  >
                    <Power size={10} />
                  </button>
                  <button
                    className={`flex-1 truncate text-left cursor-pointer bg-transparent border-none p-0 text-inherit hover:text-amber-100 transition-colors ${fx.bypassed ? "line-through" : ""}`}
                    onClick={() => handleOpenMonitorFXEditor(fx.index)}
                    title={`Open editor for ${fx.name}`}
                    aria-label={`Open editor for monitor effect ${fx.name}`}
                  >
                    {fx.name}
                  </button>
                  <button
                    className="shrink-0 text-neutral-500 hover:text-red-400 transition-colors cursor-pointer"
                    onClick={() => handleRemoveMonitorFX(fx.index)}
                    title="Remove"
                    aria-label={`Remove monitor effect ${fx.name}`}
                  >
                    <X size={9} />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Inline Plugin Picker */}
          {showMonitorPluginPicker && (
            <div className="border-t border-amber-700/30 bg-neutral-900 flex flex-col max-h-45">
              <div className="flex items-center gap-1 p-1">
                <input
                  type="text"
                  className="flex-1 bg-neutral-800 border border-neutral-600 rounded px-1.5 py-0.5 text-[10px] text-daw-text placeholder-neutral-500 outline-none focus:border-amber-500"
                  placeholder="Search plugins..."
                  value={monitorPluginSearch}
                  onChange={(e) => setMonitorPluginSearch(e.target.value)}
                  autoFocus
                  aria-label="Search monitor effect plugins"
                />
                <button
                  className="text-neutral-400 hover:text-neutral-200 cursor-pointer"
                  onClick={() => {
                    setShowMonitorPluginPicker(false);
                    setMonitorPluginSearch("");
                  }}
                  aria-label="Close plugin picker"
                >
                  <X size={10} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-1 pb-1 space-y-px">
                {filteredMonitorPlugins.length === 0 ? (
                  <div className="text-[9px] text-neutral-500 text-center py-2">
                    No plugins found
                  </div>
                ) : (
                  filteredMonitorPlugins.slice(0, 50).map((plugin) => (
                    <button
                      key={plugin.fileOrIdentifier}
                      className="w-full text-left px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-amber-900/30 hover:text-amber-200 rounded truncate transition-colors cursor-pointer disabled:opacity-50"
                      onClick={() => handleAddMonitorFX(plugin.fileOrIdentifier)}
                      disabled={addingMonitorPlugin}
                      title={plugin.name}
                    >
                      {plugin.name}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );

  return (
    <DetachablePanel
      title="Mixer"
      width={1200}
      height={400}
      isDetached={isDetached}
      onDetach={handleDetach}
      onAttach={handleAttach}
    >
      {mixerContent}
    </DetachablePanel>
  );
}

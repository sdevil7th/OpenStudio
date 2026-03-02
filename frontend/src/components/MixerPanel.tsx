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

import { X, Save, Trash2, ExternalLink, ArrowDownToLine } from "lucide-react";
import { ChannelStrip } from "./ChannelStrip";
import { SortableTrack } from "./SortableTrack";
import { DetachablePanel } from "./DetachablePanel";
import { useDAWStore, Track, MixerSnapshot } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./ui";
import { useCallback } from "react";

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
  };

  const mixerContent = (
    <div
      className="bg-neutral-800 border-t-2 border-neutral-950 flex flex-col shrink-0 overflow-hidden"
      style={isDetached
        ? { height: "100vh" }
        : {
            maxHeight: isVisible ? 340 : 0,
            opacity: isVisible ? 1 : 0,
            transition: "max-height 0.2s ease-in-out, opacity 0.15s ease-in-out",
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
            >
              <ArrowDownToLine size={12} />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleDetach}
              title="Pop Out Mixer"
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
            >
              {snap.name}
            </button>
            <button
              className="text-neutral-500 hover:text-red-400 cursor-pointer transition-colors"
              onClick={() => deleteMixerSnapshot(idx)}
              title={`Delete "${snap.name}"`}
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
      </div>
    </div>
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

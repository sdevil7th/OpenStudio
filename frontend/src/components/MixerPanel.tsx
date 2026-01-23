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

import { ChannelStrip } from "./ChannelStrip";
import { SortableTrack } from "./SortableTrack";
import { useDAWStore, Track } from "../store/useDAWStore";

interface MixerPanelProps {
  isVisible: boolean;
  onClose?: () => void;
}

export function MixerPanel({ isVisible, onClose }: MixerPanelProps) {
  const {
    tracks,
    masterVolume,
    masterPan,
    masterLevel,
    toggleMixer,
    reorderTrack,
  } = useDAWStore();

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

  if (!isVisible) return null;

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
    monitorEnabled: false,
    inputChannel: null,
    inputStartChannel: 0,
    inputChannelCount: 2,
    clips: [],
    midiClips: [],
    meterLevel: masterLevel,
    peakLevel: masterLevel,
    clipping: false,
  };

  return (
    <div className="h-[340px] bg-neutral-800 border-t-2 border-neutral-950 flex flex-col shrink-0">
      {/* Header */}
      <div className="h-5 bg-neutral-900 border-b border-neutral-700 flex items-center justify-between px-2">
        <span className="text-[9px] font-semibold text-neutral-400 uppercase tracking-wider">
          Mixer
        </span>
        <button
          onClick={onClose || toggleMixer}
          className="w-4 h-4 flex items-center justify-center text-neutral-400 hover:text-white 
                               hover:bg-red-700 rounded text-xs transition-colors"
          title="Close Mixer"
        >
          ×
        </button>
      </div>

      {/* Channel Strips Container */}
      <div className="relative flex-1 flex overflow-x-auto overflow-y-hidden bg-neutral-800 p-1 gap-1 pl-0">
        {/* Master Channel - Fixed position */}
        <ChannelStrip track={masterTrack} trackIndex={-1} isMaster={true} />

        {/* Track Channels - Sortable */}
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
              <SortableTrack key={track.id} track={track} trackIndex={index} />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

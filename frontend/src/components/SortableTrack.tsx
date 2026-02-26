import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChannelStrip } from "./ChannelStrip";
import { Track } from "../store/useDAWStore";

interface SortableTrackProps {
  track: Track;
  trackIndex: number;
  isSelected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
}

export function SortableTrack({ track, trackIndex, isSelected, onSelect }: SortableTrackProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: track.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    touchAction: "none", // Required for touch devices if we want to drag without scrolling issues
  };

  return (
    <div ref={setNodeRef} style={style} className="h-full flex shrink-0">
      {/* 
                We pass the drag handle props to a specific part of the ChannelStrip 
                or wrap the whole strip if we want the whole thing to be draggable.
                For now, let's assume we want a specific handle, but since ChannelStrip 
                doesn't export a handle slot yet, we might validly wrap it or pass props down.
                
                Actually, usually for mixer channels, you retain scrollability. 
                We might want to pass 'attributes' and 'listeners' to a drag handle in ChannelStrip.
                However, to minimize changes to ChannelStrip right now, let's wrap it 
                and maybe add a small drag handle div above/below or just make the header draggable.
                
                Let's try creating a wrapper container that IS draggable for now.
                The ChannelStrip is inside this div.
             */}

      {/* 
                Better UX: drag handle in the track number/name area.
                For now, to keep it simple, I'll pass attributes/listeners to a small overlay handle 
                or require ChannelStrip to accept a dragHandleRef?
                
                Let's inspect ChannelStrip again... it has a "Track Name Header".
                Ideally, we pass `listeners` and `attributes` to that header.
                
                But allowing the whole strip to be the handle might conflict with sliders.
                
                Proposed solution: 
                Modify ChannelStrip to accept `dragHandleProps` (listeners + attributes).
                
                For this step, I'll stick to creating this wrapper component. 
                I'll verify if ChannelStrip can hold a handle or if I should wrap it with a handle here.
            */}

      <div className="relative h-full flex flex-col">
        <div
          {...attributes}
          {...listeners}
          className="h-3 w-full cursor-grab active:cursor-grabbing hover:brightness-125 flex items-center justify-center mb-0.5 rounded-t-sm transition-all"
          style={{ backgroundColor: track.color || "#171717" }}
          title="Drag to reorder"
        >
          <div className="flex gap-0.5">
            <div className="w-0.5 h-0.5 bg-white/50 rounded-full"></div>
            <div className="w-0.5 h-0.5 bg-white/50 rounded-full"></div>
            <div className="w-0.5 h-0.5 bg-white/50 rounded-full"></div>
          </div>
        </div>

        <div className="flex-1 min-h-0">
          <ChannelStrip track={track} trackIndex={trackIndex} isSelected={isSelected} onSelect={onSelect} />
        </div>
      </div>
    </div>
  );
}

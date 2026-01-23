import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Track } from "../store/useDAWStore";
import { TrackHeader } from "./TrackHeader";

interface SortableTrackHeaderProps {
  track: Track;
  children?: React.ReactNode;
}

export function SortableTrackHeader({ track }: SortableTrackHeaderProps) {
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
    position: "relative" as const,
    zIndex: isDragging ? 999 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div className="relative group">
        {/* Drag Handle - Absolutely positioned to the left or integrated */}
        <div
          {...listeners}
          className="absolute left-0 top-0 bottom-0 w-3 cursor-move z-10 flex items-center justify-center
                               opacity-0 group-hover:opacity-100 transition-opacity bg-neutral-800/50 hover:bg-neutral-700/80"
          title="Drag to reorder"
        >
          <div className="flex flex-col gap-0.5">
            <div className="w-0.5 h-0.5 bg-neutral-400 rounded-full"></div>
            <div className="w-0.5 h-0.5 bg-neutral-400 rounded-full"></div>
            <div className="w-0.5 h-0.5 bg-neutral-400 rounded-full"></div>
          </div>
        </div>

        {/* Track Content */}
        <div className="pl-1">
          <TrackHeader track={track} />
        </div>
      </div>
    </div>
  );
}

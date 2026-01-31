import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Track, useDAWStore } from "../store/useDAWStore";
import { TrackHeader } from "./TrackHeader";
import { useContextMenu, MenuItem } from "./ContextMenu";

interface SortableTrackHeaderProps {
  track: Track;
  children?: React.ReactNode;
}

// Preset colors for track color picker
const TRACK_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6b7280",
  "#ffffff",
];

export function SortableTrackHeader({ track }: SortableTrackHeaderProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: track.id });

  const {
    selectedTrackIds,
    selectTrack,
    removeTrack,
    updateTrack,
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackArmed,
    addTrack,
  } = useDAWStore();

  const isSelected = selectedTrackIds.includes(track.id);
  const { showContextMenu, ContextMenuComponent } = useContextMenu();

  const handleClick = (e: React.MouseEvent) => {
    // Prevent selection when clicking on interactive elements or color bar
    const target = e.target as HTMLElement;
    if (
      target.closest(
        "button, input, select, [data-color-bar], [data-no-select]",
      )
    ) {
      return;
    }
    selectTrack(track.id, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    const menuItems: MenuItem[] = [
      {
        label: "Delete Track",
        shortcut: "Del",
        onClick: () => removeTrack(track.id),
      },
      {
        label: "Duplicate Track",
        onClick: async () => {
          // Create a copy of the track
          const newId = crypto.randomUUID();
          addTrack({
            id: newId,
            name: `${track.name} (copy)`,
            color: track.color,
          });
        },
      },
      { divider: true, label: "" },
      {
        label: track.muted ? "Unmute Track" : "Mute Track",
        shortcut: "M",
        onClick: () => toggleTrackMute(track.id),
      },
      {
        label: track.soloed ? "Unsolo Track" : "Solo Track",
        shortcut: "S",
        onClick: () => toggleTrackSolo(track.id),
      },
      {
        label: track.armed ? "Disarm Record" : "Arm for Recording",
        shortcut: "R",
        onClick: () => toggleTrackArmed(track.id),
      },
      { divider: true, label: "" },
      {
        label: "Track Color",
        submenu: TRACK_COLORS.map((color) => ({
          label: color === track.color ? `● ${color}` : color,
          onClick: () => updateTrack(track.id, { color }),
        })),
      },
    ];

    showContextMenu(e, menuItems);
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 999 : 1,
  };

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={isSelected ? "ring-2 ring-blue-500 ring-inset" : ""}
      >
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
      {ContextMenuComponent}
    </>
  );
}

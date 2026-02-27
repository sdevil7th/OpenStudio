import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Track, useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { TrackHeader } from "./TrackHeader";
import { TRACK_COLORS } from "./ColorPicker";
import { useContextMenu, MenuItem } from "./ContextMenu";

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

  const {
    selectedTrackIds,
    selectTrack,
    removeTrack,
    deleteSelectedTracks,
    updateTrack,
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackArmed,
    addTrack,
    trackGroups,
    addTrackGroup,
    removeTrackGroup,
    updateTrackGroup,
  } = useDAWStore(useShallow((s) => ({
    selectedTrackIds: s.selectedTrackIds,
    selectTrack: s.selectTrack,
    removeTrack: s.removeTrack,
    deleteSelectedTracks: s.deleteSelectedTracks,
    updateTrack: s.updateTrack,
    toggleTrackMute: s.toggleTrackMute,
    toggleTrackSolo: s.toggleTrackSolo,
    toggleTrackArmed: s.toggleTrackArmed,
    addTrack: s.addTrack,
    trackGroups: s.trackGroups,
    addTrackGroup: s.addTrackGroup,
    removeTrackGroup: s.removeTrackGroup,
    updateTrackGroup: s.updateTrackGroup,
  })));

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
    // If right-clicking a selected track while multiple are selected → bulk menu
    const isMulti = isSelected && selectedTrackIds.length > 1;
    const count = selectedTrackIds.length;

    if (!isSelected) {
      // Right-click on unselected track → select it first (single select)
      selectTrack(track.id);
    }

    // Check if this track belongs to a group
    const trackGroup = trackGroups.find((g) => g.memberTrackIds.includes(track.id));
    // Check if ALL selected tracks are already in the same group
    const allInSameGroup = isMulti && trackGroups.find((g) =>
      selectedTrackIds.every((id) => g.memberTrackIds.includes(id)),
    );

    const ALL_LINKED_PARAMS = ["volume", "pan", "mute", "solo", "armed", "fxBypass"];

    const menuItems: MenuItem[] = isMulti
      ? [
          {
            label: `Delete ${count} Tracks`,
            shortcut: "Del",
            onClick: () => deleteSelectedTracks(),
          },
          { divider: true, label: "" },
          ...(!allInSameGroup
            ? [
                {
                  label: `Link ${count} Tracks`,
                  onClick: () => {
                    addTrackGroup(
                      `Group`,
                      selectedTrackIds[0],
                      [...selectedTrackIds],
                      ALL_LINKED_PARAMS,
                    );
                  },
                },
              ]
            : [
                {
                  label: "Unlink Entire Group",
                  onClick: () => {
                    if (allInSameGroup) removeTrackGroup(allInSameGroup.id);
                  },
                },
              ]),
          { divider: true, label: "" },
          {
            label: `Mute ${count} Tracks`,
            onClick: () => selectedTrackIds.forEach((id) => toggleTrackMute(id)),
          },
          {
            label: `Solo ${count} Tracks`,
            onClick: () => selectedTrackIds.forEach((id) => toggleTrackSolo(id)),
          },
          {
            label: `Arm ${count} Tracks`,
            onClick: () => selectedTrackIds.forEach((id) => toggleTrackArmed(id)),
          },
          { divider: true, label: "" },
          {
            label: "Track Color",
            submenu: TRACK_COLORS.map((c) => ({
              label: c.value === track.color ? `● ${c.name}` : c.name,
              onClick: () =>
                selectedTrackIds.forEach((id) => updateTrack(id, { color: c.value })),
            })),
          },
        ]
      : [
          {
            label: "Delete Track",
            shortcut: "Del",
            onClick: () => removeTrack(track.id),
          },
          {
            label: "Duplicate Track",
            onClick: async () => {
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
            submenu: TRACK_COLORS.map((c) => ({
              label: c.value === track.color ? `● ${c.name}` : c.name,
              onClick: () => updateTrack(track.id, { color: c.value }),
            })),
          },
          ...(trackGroup
            ? [
                { divider: true, label: "" },
                {
                  label: "Unlink This Track",
                  onClick: () => {
                    const remaining = trackGroup.memberTrackIds.filter((id) => id !== track.id);
                    if (remaining.length <= 1) {
                      removeTrackGroup(trackGroup.id);
                    } else {
                      updateTrackGroup(trackGroup.id, { memberTrackIds: remaining });
                    }
                  },
                },
                {
                  label: "Unlink Entire Group",
                  onClick: () => removeTrackGroup(trackGroup.id),
                },
              ]
            : []),
          { divider: true, label: "" },
          {
            label: track.showAutomation ? "Hide Automation" : "Show Automation",
            onClick: () => useDAWStore.getState().toggleTrackAutomation(track.id),
          },
          {
            label: track.frozen ? "Unfreeze Track" : "Freeze Track",
            onClick: () => {
              const store = useDAWStore.getState();
              track.frozen ? store.unfreezeTrack(track.id) : store.freezeTrack(track.id);
            },
          },
          {
            label: "Consolidate Track...",
            onClick: () => { useDAWStore.getState().consolidateTrack(track.id); },
            disabled: track.clips.length === 0,
          },
          { divider: true, label: "" },
          {
            label: "Save as Track Template...",
            onClick: () => {
              const name = prompt("Template name:", track.name);
              if (name) useDAWStore.getState().saveTrackTemplate(track.id, name);
            },
          },
          {
            label: "Load Track Template",
            submenu: (() => {
              const templates = useDAWStore.getState().trackTemplates;
              if (templates.length === 0) return [{ label: "(no templates)", disabled: true }];
              return templates.map((t) => ({
                label: t.name,
                onClick: () => useDAWStore.getState().loadTrackTemplate(t.id),
              }));
            })(),
          },
          { divider: true, label: "" },
          {
            label: "Insert Spacer Below",
            onClick: () => useDAWStore.getState().addSpacer(track.id),
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

  // Filter drag listeners so interactive elements (buttons, inputs, selects, color bar)
  // don't initiate drag — only empty space in the track header does.
  const filteredListeners = listeners
    ? Object.fromEntries(
        Object.entries(listeners).map(([key, handler]) => [
          key,
          (e: any) => {
            const target = e.target as HTMLElement;
            if (target.closest("button, input, select, [data-no-drag], [data-color-bar]")) {
              return;
            }
            (handler as any)?.(e);
          },
        ]),
      )
    : {};

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...filteredListeners}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={`cursor-grab active:cursor-grabbing ${isSelected ? "shadow-[inset_0_0_0_2px_#3b82f6]" : ""}`}
      >
        <TrackHeader track={track} isSelected={isSelected} />
      </div>
      {ContextMenuComponent}
    </>
  );
}

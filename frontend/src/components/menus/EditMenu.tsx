import { MenuDropdown, MenuItemProps } from "./MenuDropdown";
import { useDAWStore } from "../../store/useDAWStore";

/**
 * Edit Menu Component
 * Contains undo/redo, clipboard, and selection operations
 */
export function EditMenu() {
  const {
    canUndo,
    canRedo,
    undo,
    redo,
    selectedClipId,
    selectedTrackIds,
    copyClip,
    cutClip,
    pasteClip,
    deleteClip,
    duplicateClip,
    selectAllTracks,
    deselectAllTracks,
    deleteSelectedTracks,
    transport,
  } = useDAWStore();

  const menuItems: MenuItemProps[] = [
    {
      label: "Undo",
      shortcut: "Ctrl+Z",
      onClick: undo,
      disabled: !canUndo,
    },
    {
      label: "Redo",
      shortcut: "Ctrl+Shift+Z",
      onClick: redo,
      disabled: !canRedo,
      dividerAfter: true,
    },
    {
      label: "Cut",
      shortcut: "Ctrl+X",
      onClick: () => selectedClipId && cutClip(selectedClipId),
      disabled: !selectedClipId,
    },
    {
      label: "Copy",
      shortcut: "Ctrl+C",
      onClick: () => selectedClipId && copyClip(selectedClipId),
      disabled: !selectedClipId,
    },
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      onClick: () => {
        const clipboard = useDAWStore.getState().clipboard;
        if (clipboard.clip && selectedTrackIds.length > 0) {
          pasteClip(selectedTrackIds[0], transport.currentTime);
        }
      },
      disabled: !useDAWStore.getState().clipboard.clip,
    },
    {
      label: "Duplicate",
      shortcut: "Ctrl+D",
      onClick: () => selectedClipId && duplicateClip(selectedClipId),
      disabled: !selectedClipId,
    },
    {
      label: "Delete",
      shortcut: "Delete",
      onClick: () => {
        if (selectedTrackIds.length > 0) {
          deleteSelectedTracks();
        } else if (selectedClipId) {
          deleteClip(selectedClipId);
        }
      },
      disabled: !selectedClipId && selectedTrackIds.length === 0,
      dividerAfter: true,
    },
    {
      label: "Split at Cursor",
      shortcut: "S",
      onClick: () => useDAWStore.getState().splitClipAtPlayhead(),
    },
    {
      label: "Split at Time Selection",
      onClick: () => useDAWStore.getState().splitAtTimeSelection(),
      disabled: !useDAWStore.getState().timeSelection,
    },
    {
      label: "Cut within Time Selection",
      onClick: () => useDAWStore.getState().cutWithinTimeSelection(),
      disabled: !useDAWStore.getState().timeSelection,
    },
    {
      label: "Copy within Time Selection",
      onClick: () => useDAWStore.getState().copyWithinTimeSelection(),
      disabled: !useDAWStore.getState().timeSelection,
    },
    {
      label: "Delete within Time Selection (Ripple)",
      onClick: () => useDAWStore.getState().deleteWithinTimeSelection(),
      disabled: !useDAWStore.getState().timeSelection,
    },
    {
      label: "Insert Silence",
      onClick: () => useDAWStore.getState().insertSilenceAtTimeSelection(),
    },
    {
      label: "Delete Razor Edit Content",
      onClick: () => useDAWStore.getState().deleteRazorEditContent(),
      disabled: useDAWStore.getState().razorEdits.length === 0,
    },
    {
      label: "Dynamic Split...",
      onClick: () => useDAWStore.getState().openDynamicSplit(),
      disabled: !selectedClipId,
    },
    {
      label: "Reverse Clip",
      onClick: () => { if (selectedClipId) void useDAWStore.getState().reverseClip(selectedClipId); },
      disabled: !selectedClipId,
      dividerAfter: true,
    },
    {
      label: "Group Selected Clips",
      shortcut: "Ctrl+G",
      onClick: () => useDAWStore.getState().groupSelectedClips(),
      disabled: !selectedClipId,
    },
    {
      label: "Ungroup Selected Clips",
      shortcut: "Ctrl+Shift+G",
      onClick: () => useDAWStore.getState().ungroupSelectedClips(),
      disabled: !selectedClipId,
    },
    {
      label: "Normalize Selected Clips",
      onClick: () => useDAWStore.getState().normalizeSelectedClips(),
      disabled: !selectedClipId,
    },
    {
      label: "Quantize Items to Grid",
      onClick: () => useDAWStore.getState().quantizeSelectedClips(),
      disabled: useDAWStore.getState().selectedClipIds.length === 0,
      dividerAfter: true,
    },
    {
      label: "Select All Tracks",
      shortcut: "Ctrl+A",
      onClick: selectAllTracks,
    },
    {
      label: "Select All Clips",
      shortcut: "Ctrl+Shift+A",
      onClick: () => useDAWStore.getState().selectAllClips(),
    },
    {
      label: "Deselect All",
      shortcut: "Esc",
      onClick: deselectAllTracks,
    },
  ];

  return <MenuDropdown label="Edit" items={menuItems} />;
}

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
      label: "Select All Tracks",
      shortcut: "Ctrl+A",
      onClick: selectAllTracks,
    },
    {
      label: "Deselect All",
      shortcut: "Esc",
      onClick: deselectAllTracks,
    },
  ];

  return <MenuDropdown label="Edit" items={menuItems} />;
}

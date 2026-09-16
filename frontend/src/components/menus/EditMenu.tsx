import { useCallback, useRef, useSyncExternalStore } from "react";
import { MenuDropdown, MenuItemProps } from "./MenuDropdown";
import { getDisplayEffectiveShortcut, getRegisteredAction } from "../../store/actionRegistry";
import { useDAWStore } from "../../store/useDAWStore";
import { usePitchEditorStore } from "../../store/pitchEditorStore";
import {
  getActiveShortcutContext,
  subscribeShortcutContext,
} from "../../utils/shortcutContext";
import { useShallow } from "zustand/shallow";

/**
 * Edit Menu Component
 * Contains undo/redo, clipboard, and selection operations
 */
export function EditMenu() {
  useDAWStore(useShallow(s => [s.clipboard, s.selectedClipIds, s.timeSelection, s.razorEdits, s.globalLocked, s.lockSettings, s.tracks]));
  const run = (id: string) => { const action = getRegisteredAction(id); if (action && (!action.canHandleShortcut || action.canHandleShortcut())) action.execute(); };
  const unavailable = (id: string) => getRegisteredAction(id)?.canHandleShortcut?.() === false;
  const {
    canUndo,
    canRedo,
    undo,
    redo,
    selectedClipId,
    selectAllTracks,
    keyboardShortcutProfileId,
    customShortcuts,
  } = useDAWStore(useShallow((s) => ({
    canUndo: s.canUndo,
    canRedo: s.canRedo,
    undo: s.undo,
    redo: s.redo,
    selectedClipId: s.selectedClipId,
    selectAllTracks: s.selectAllTracks,
    keyboardShortcutProfileId: s.keyboardShortcutProfileId,
    customShortcuts: s.customShortcuts,
  })));
  const {
    pitchUndo,
    pitchRedo,
    pitchCanUndo,
    pitchCanRedo,
  } = usePitchEditorStore(useShallow((s) => ({
    pitchUndo: s.undo,
    pitchRedo: s.redo,
    pitchCanUndo: s.undoStack.length > 0,
    pitchCanRedo: s.redoStack.length > 0,
  })));
  const activeShortcutContext = useSyncExternalStore(
    subscribeShortcutContext,
    getActiveShortcutContext,
    getActiveShortcutContext,
  );
  const editorContext = useRef(activeShortcutContext);
  if (activeShortcutContext.kind !== "modal") editorContext.current = activeShortcutContext;
  const pitchOwnsHistory = editorContext.current.kind === "pitch_editor";
  const effectiveUndo = pitchOwnsHistory ? pitchUndo : undo;
  const effectiveRedo = pitchOwnsHistory ? pitchRedo : redo;
  const effectiveCanUndo = pitchOwnsHistory ? pitchCanUndo : canUndo;
  const effectiveCanRedo = pitchOwnsHistory ? pitchCanRedo : canRedo;
  const shortcut = useCallback(
    (actionId: string, fallback: string) => getDisplayEffectiveShortcut(actionId) ?? fallback,
    [customShortcuts, keyboardShortcutProfileId],
  );
  const trackSelectionOwnsDelete = editorContext.current.kind === "track_control_panel"
    || editorContext.current.kind === "mixer";

  const menuItems: MenuItemProps[] = [
    {
      label: "Undo",
      shortcut: shortcut("edit.undo", "Ctrl+Z"),
      onClick: effectiveUndo,
      disabled: !effectiveCanUndo,
    },
    {
      label: "Redo",
      shortcut: shortcut("edit.redo", "Ctrl+Shift+Z"),
      onClick: effectiveRedo,
      disabled: !effectiveCanRedo,
      dividerAfter: true,
    },
    {
      label: "Cut",
      shortcut: shortcut("edit.cut", "Ctrl+X"),
      onClick: () => run("edit.cut"),
      disabled: unavailable("edit.cut"),
    },
    {
      label: "Copy",
      shortcut: shortcut("edit.copy", "Ctrl+C"),
      onClick: () => run("edit.copy"),
      disabled: unavailable("edit.copy"),
    },
    {
      label: "Paste",
      shortcut: shortcut("edit.paste", "Ctrl+V"),
      onClick: () => run("edit.paste"),
      disabled: unavailable("edit.paste"),
    },
    {
      label: "Duplicate",
      shortcut: shortcut("edit.duplicateClips", "Ctrl+D"),
      onClick: () => run("edit.duplicateClips"),
      disabled: unavailable("edit.duplicateClips"),
    },
    {
      label: "Delete",
      shortcut: shortcut(trackSelectionOwnsDelete ? "track.deleteSelected" : "edit.delete", "Delete"),
      onClick: () => run(trackSelectionOwnsDelete ? "track.deleteSelected" : "edit.delete"),
      disabled: unavailable(trackSelectionOwnsDelete ? "track.deleteSelected" : "edit.delete"),
      dividerAfter: true,
    },
    {
      label: "Split at Playhead",
      shortcut: shortcut("edit.splitAtCursor", "S"),
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
      shortcut: shortcut("edit.groupClips", "Ctrl+G"),
      onClick: () => useDAWStore.getState().groupSelectedClips(),
      disabled: !selectedClipId,
    },
    {
      label: "Ungroup Selected Clips",
      shortcut: shortcut("edit.ungroupClips", "Ctrl+Shift+G"),
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
      shortcut: shortcut("track.selectAll", "Ctrl+A"),
      onClick: selectAllTracks,
    },
    {
      label: "Select All Clips",
      shortcut: shortcut("edit.selectAllClips", "Ctrl+Shift+A"),
      onClick: () => useDAWStore.getState().selectAllClips(),
    },
    {
      label: "Deselect All",
      shortcut: shortcut(trackSelectionOwnsDelete ? "track.deselectAll" : "edit.deselectAll", "Esc"),
      onClick: () => run("edit.deselectAll"),
    },
  ];

  return <MenuDropdown label="Edit" items={menuItems} />;
}

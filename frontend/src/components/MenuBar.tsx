import { useState, useEffect, useCallback } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import { EditMenu } from "./menus/EditMenu";
import { MenuDropdown, MenuItemProps } from "./menus/MenuDropdown";
import { useDAWStore, THEME_PRESETS } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";

/**
 * Main Menu Bar Component
 * Contains File, Edit, View, Insert, Track, Options, Actions, Help menus
 */
export function MenuBar() {
  const {
    toggleMixer,
    showMixer,
    showMasterTrackInTCP,
    toggleMasterTrackInTCP,
    openSettings,
    openProjectSettings,
    openRenderModal,
    newProject,
    saveProject,
    loadProject,
    snapEnabled,
    toggleSnap,
    gridSize,
    setGridSize,
    recentProjects,
    clearRecentProjects,
    showVirtualKeyboard,
    toggleVirtualKeyboard,
    showUndoHistory,
    toggleUndoHistory,
  } = useDAWStore();

  const [isMaximized, setIsMaximized] = useState(false);

  // Query maximize state on mount
  useEffect(() => {
    nativeBridge.isWindowMaximized().then(setIsMaximized);
  }, []);

  const handleMinimize = useCallback(() => {
    nativeBridge.minimizeWindow();
  }, []);

  const handleMaximize = useCallback(async () => {
    const newState = await nativeBridge.maximizeWindow();
    setIsMaximized(newState);
  }, []);

  const handleClose = useCallback(() => {
    nativeBridge.closeWindow();
  }, []);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only drag from the empty space (not from menus or buttons)
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    if (e.button !== 0) return;
    nativeBridge.startWindowDrag();
  }, []);

  const handleDoubleClick = useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    const newState = await nativeBridge.maximizeWindow();
    setIsMaximized(newState);
  }, []);

  // Helper to get just the filename from a full path
  const getFileName = (path: string) => {
    return path.split("\\").pop() || path.split("/").pop() || path;
  };

  // File menu - fully implemented
  const fileMenuItems: MenuItemProps[] = [
    {
      label: "New Project",
      shortcut: "Ctrl+N",
      onClick: () => {
        if (
          confirm(
            "Are you sure you want to start a new project? Unsaved changes will be lost.",
          )
        ) {
          newProject();
        }
      },
    },
    {
      label: "Open Project...",
      shortcut: "Ctrl+O",
      onClick: () => {
        loadProject().then((success) => {
          if (!success) console.error("Failed to load project");
        });
      },
    },
    {
      label: "Open Recent",
      disabled: recentProjects.length === 0,
      submenu:
        recentProjects.length > 0
          ? [
              ...recentProjects.map((projectPath) => ({
                label: getFileName(projectPath),
                onClick: async () => {
                  const success = await loadProject(projectPath);
                  if (!success) {
                    console.error("Failed to load recent project:", projectPath);
                  }
                },
              })),
              {
                label: "Clear Recent Projects",
                onClick: clearRecentProjects,
                dividerAfter: false,
              },
            ]
          : undefined,
      dividerAfter: true,
    },
    {
      label: "Save Project",
      shortcut: "Ctrl+S",
      onClick: () => {
        saveProject(false).then((success) => {
          if (success) console.log("Project saved successfully");
        });
      },
    },
    {
      label: "Save Project As...",
      shortcut: "Ctrl+Shift+S",
      onClick: () => {
        saveProject(true).then((success) => {
          if (success) console.log("Project saved as new file");
        });
      },
    },
    {
      label: "Save New Version",
      onClick: () => {
        useDAWStore.getState().saveNewVersion().then((success) => {
          if (success) console.log("New version saved");
        });
      },
      dividerAfter: true,
    },
    {
      label: "Close Project",
      shortcut: "Ctrl+F4",
      onClick: () => {
        const state = useDAWStore.getState();
        if (state.isModified) {
          if (confirm("Save changes before closing?")) {
            state.saveProject().then(() => state.newProject());
          } else {
            state.newProject();
          }
        } else {
          state.newProject();
        }
      },
      dividerAfter: true,
    },
    {
      label: "Project Settings...",
      shortcut: "Alt+Enter",
      onClick: openProjectSettings,
    },
    {
      label: "Render...",
      shortcut: "Ctrl+Alt+R",
      onClick: openRenderModal,
    },
    {
      label: "Region Render Matrix...",
      onClick: () => useDAWStore.getState().toggleRegionRenderMatrix(),
    },
    {
      label: "Export Project MIDI...",
      onClick: () => { useDAWStore.getState().exportProjectMIDI(); },
    },
    {
      label: "Clean Project Directory...",
      onClick: () => useDAWStore.getState().toggleCleanProject(),
    },
    {
      label: "Batch File Converter...",
      onClick: () => useDAWStore.getState().toggleBatchConverter(),
    },
    {
      label: "DDP Disc Image Export...",
      onClick: () => useDAWStore.getState().toggleDDPExport(),
    },
    {
      label: "Capture Output",
      checked: useDAWStore.getState().liveCaptureEnabled,
      onClick: () => {
        const state = useDAWStore.getState();
        if (state.liveCaptureEnabled) {
          state.stopLiveCapture();
        } else {
          state.startLiveCapture();
        }
      },
      dividerAfter: true,
    },
    {
      label: "Open Project (Safe Mode)...",
      shortcut: "Ctrl+Shift+O",
      onClick: () => {
        useDAWStore.getState().loadProject(undefined, { bypassFX: true }).then((success) => {
          if (success) console.log("Project loaded in Safe Mode (FX bypassed)");
        });
      },
      dividerAfter: true,
    },
    {
      label: "Quit",
      shortcut: "Ctrl+Q",
      onClick: () => {
        nativeBridge.closeWindow();
      },
    },
  ];

  // View menu - frontend only
  const viewMenuItems: MenuItemProps[] = [
    {
      label: "Show Mixer",
      shortcut: "Ctrl+M",
      onClick: toggleMixer,
      checked: showMixer,
    },
    {
      label: "Show Master Track in TCP",
      onClick: toggleMasterTrackInTCP,
      checked: showMasterTrackInTCP,
    },
    {
      label: "Show Virtual MIDI Keyboard",
      shortcut: "Alt+B",
      onClick: toggleVirtualKeyboard,
      checked: showVirtualKeyboard,
    },
    {
      label: "Undo History",
      shortcut: "Ctrl+Alt+Z",
      onClick: toggleUndoHistory,
      checked: showUndoHistory,
    },
    {
      label: "Region/Marker Manager",
      onClick: () => useDAWStore.getState().toggleRegionMarkerManager(),
      checked: useDAWStore.getState().showRegionMarkerManager,
    },
    {
      label: "Clip Properties",
      shortcut: "F2",
      onClick: () => useDAWStore.getState().toggleClipProperties(),
      checked: useDAWStore.getState().showClipProperties,
    },
    {
      label: "Big Clock",
      onClick: () => useDAWStore.getState().toggleBigClock(),
      checked: useDAWStore.getState().showBigClock,
    },
    {
      label: "Render Queue",
      onClick: () => useDAWStore.getState().toggleRenderQueue(),
      checked: useDAWStore.getState().showRenderQueue,
    },
    {
      label: "Routing Matrix",
      onClick: () => useDAWStore.getState().toggleRoutingMatrix(),
      checked: useDAWStore.getState().showRoutingMatrix,
    },
    {
      label: "Media Explorer",
      onClick: () => useDAWStore.getState().toggleMediaExplorer(),
      checked: useDAWStore.getState().showMediaExplorer,
    },
    {
      label: "Free Item Positioning",
      onClick: () => useDAWStore.getState().toggleFreePositioning(),
      checked: useDAWStore.getState().freePositioning,
    },
    {
      label: "Video Window",
      onClick: () => useDAWStore.getState().toggleVideoWindow(),
      checked: useDAWStore.getState().showVideoWindow,
    },
    {
      label: "Script Editor",
      onClick: () => useDAWStore.getState().toggleScriptEditor(),
      checked: useDAWStore.getState().showScriptEditor,
    },
    {
      label: "Toolbar Editor...",
      onClick: () => useDAWStore.getState().toggleToolbarEditor(),
    },
    {
      label: "Toolbars",
      submenu: (() => {
        const toolbars = useDAWStore.getState().customToolbars;
        if (toolbars.length === 0) return [{ label: "(no custom toolbars)", disabled: true }];
        return toolbars.map((t) => ({
          label: t.name,
          checked: t.visible,
          onClick: () => useDAWStore.getState().toggleToolbarVisibility(t.id),
        }));
      })(),
      dividerAfter: true,
    },
    {
      label: "Audio Settings...",
      onClick: openSettings,
    },
    {
      label: "Render...",
      shortcut: "Ctrl+Alt+R",
      onClick: openRenderModal,
    },
    {
      label: "Region Render Matrix...",
      onClick: () => useDAWStore.getState().toggleRegionRenderMatrix(),
      dividerAfter: true,
    },
    {
      label: "Zoom In",
      shortcut: "Ctrl++",
      onClick: () => {
        const { pixelsPerSecond, setZoom } = useDAWStore.getState();
        setZoom(Math.min(pixelsPerSecond * 1.5, 500));
      },
    },
    {
      label: "Zoom Out",
      shortcut: "Ctrl+-",
      onClick: () => {
        const { pixelsPerSecond, setZoom } = useDAWStore.getState();
        setZoom(Math.max(pixelsPerSecond / 1.5, 10));
      },
    },
    {
      label: "Zoom to Fit",
      shortcut: "Ctrl+0",
      onClick: () => {
        useDAWStore.getState().setZoom(50);
      },
      dividerAfter: true,
    },
    {
      label: "Loop Enabled",
      shortcut: "L",
      onClick: () => useDAWStore.getState().toggleLoop(),
      checked: useDAWStore.getState().transport.loopEnabled,
    },
    {
      label: "Set Loop to Selection",
      shortcut: "Ctrl+L",
      onClick: () => {
        const { setLoopToSelection, timeSelection } = useDAWStore.getState();
        if (timeSelection) {
          setLoopToSelection();
        } else {
          alert("No time selection. Please select a time range first.");
        }
      },
      dividerAfter: true,
    },
    {
      label: "Snap Enabled",
      onClick: toggleSnap,
      checked: snapEnabled,
    },
    {
      label: "Auto-Crossfade",
      onClick: () => useDAWStore.getState().toggleAutoCrossfade(),
      checked: useDAWStore.getState().autoCrossfade,
      dividerAfter: true,
    },
    {
      label: "Screensets",
      submenu: [
        {
          label: "Save Screenset 1",
          shortcut: "Ctrl+Shift+1",
          onClick: () => useDAWStore.getState().saveScreenset(0),
        },
        {
          label: "Save Screenset 2",
          shortcut: "Ctrl+Shift+2",
          onClick: () => useDAWStore.getState().saveScreenset(1),
        },
        {
          label: "Save Screenset 3",
          shortcut: "Ctrl+Shift+3",
          onClick: () => useDAWStore.getState().saveScreenset(2),
        },
        {
          label: "Load Screenset 1",
          shortcut: "Ctrl+1",
          onClick: () => useDAWStore.getState().loadScreenset(0),
        },
      ],
    },
    {
      label: "Grid Size",
      submenu: [
        {
          label: "Bar",
          onClick: () => setGridSize("bar"),
          checked: gridSize === "bar",
        },
        {
          label: "Beat",
          onClick: () => setGridSize("beat"),
          checked: gridSize === "beat",
        },
        {
          label: "Half Beat",
          onClick: () => setGridSize("half_beat"),
          checked: gridSize === "half_beat",
        },
        {
          label: "Quarter Beat",
          onClick: () => setGridSize("quarter_beat"),
          checked: gridSize === "quarter_beat",
        },
      ],
    },
  ];

  // Insert menu - add tracks
  const insertMenuItems: MenuItemProps[] = [
    {
      label: "Media file...",
      shortcut: "Insert",
      onClick: async () => {
        const { selectedTrackIds, tracks, transport, importMedia } =
          useDAWStore.getState();

        // Show file open dialog
        const filePath = await nativeBridge.showOpenDialog(
          "Import Audio/Video File",
        );
        if (!filePath) return; // User cancelled

        // Find the target track (first selected, or first audio track)
        let targetTrackId = selectedTrackIds[0];
        if (!targetTrackId) {
          const firstAudioTrack = tracks.find((t) => t.type === "audio");
          if (!firstAudioTrack) {
            alert(
              "No audio track available. Please create an audio track first.",
            );
            return;
          }
          targetTrackId = firstAudioTrack.id;
        }

        // Import at current playhead position
        try {
          await importMedia(filePath, targetTrackId, transport.currentTime);
          console.log(`Media imported successfully: ${filePath}`);
        } catch (error) {
          alert(`Failed to import media: ${error}`);
        }
      },
      dividerAfter: true,
    },
    {
      label: "New Audio Track",
      shortcut: "Ctrl+T",
      onClick: () => {
        const { addTrack, tracks } = useDAWStore.getState();
        addTrack({
          id: crypto.randomUUID(),
          name: `Audio ${tracks.length + 1}`,
          type: "audio",
        });
      },
    },
    {
      label: "New MIDI Track",
      shortcut: "Ctrl+Shift+T",
      onClick: () => {
        const { addTrack, tracks } = useDAWStore.getState();
        addTrack({
          id: crypto.randomUUID(),
          name: `MIDI ${tracks.length + 1}`,
          type: "midi",
        });
      },
    },
    {
      label: "Virtual Instrument on New Track...",
      onClick: () => {
        const { addTrack, tracks, openPluginBrowser } = useDAWStore.getState();
        const trackId = crypto.randomUUID();
        addTrack({
          id: trackId,
          name: `Instrument ${tracks.filter((t) => t.type === "instrument").length + 1}`,
          type: "instrument",
          armed: true,
          monitorEnabled: true,
        });
        // Open plugin browser for this track so user can pick a VSTi
        openPluginBrowser(trackId);
      },
      dividerAfter: true,
    },
    {
      label: "Insert Multiple Tracks...",
      onClick: () => {
        const countStr = prompt("How many tracks to insert?", "4");
        if (countStr === null) return;
        const count = Math.min(100, Math.max(1, parseInt(countStr, 10) || 1));
        const typeStr = prompt("Track type? (audio / midi)", "audio");
        const trackType = typeStr === "midi" ? "midi" : "audio";
        const { addTrack, tracks } = useDAWStore.getState();
        for (let i = 0; i < count; i++) {
          addTrack({
            id: crypto.randomUUID(),
            name: `${trackType === "midi" ? "MIDI" : "Audio"} ${tracks.length + i + 1}`,
            type: trackType,
          });
        }
      },
    },
    {
      label: "Empty Item (Silent)",
      onClick: () => {
        const state = useDAWStore.getState();
        const targetTrackId = state.selectedTrackIds[0];
        if (!targetTrackId) {
          const audioTrack = state.tracks.find((t) => t.type === "audio");
          if (!audioTrack) {
            alert("No audio track. Create one first.");
            return;
          }
          state.addEmptyClip(audioTrack.id, state.transport.currentTime, 4);
        } else {
          state.addEmptyClip(targetTrackId, state.transport.currentTime, 4);
        }
      },
    },
    {
      label: "Empty MIDI Clip",
      onClick: () => {
        const state = useDAWStore.getState();
        const targetTrackId = state.selectedTrackIds[0];
        if (!targetTrackId) {
          const midiTrack = state.tracks.find((t) => t.type === "midi" || t.type === "instrument");
          if (!midiTrack) {
            alert("No MIDI or instrument track. Create one first.");
            return;
          }
          state.addMIDIClip(midiTrack.id, state.transport.currentTime, 4);
        } else {
          state.addMIDIClip(targetTrackId, state.transport.currentTime, 4);
        }
      },
      dividerAfter: true,
    },
    {
      label: "Marker at Playhead",
      shortcut: "M",
      onClick: () => {
        const { addMarker, transport } = useDAWStore.getState();
        addMarker(transport.currentTime);
      },
    },
    {
      label: "Marker with name...",
      shortcut: "Shift+M",
      onClick: () => {
        const { addMarker, transport } = useDAWStore.getState();
        const name = prompt("Enter marker name:");
        if (name !== null) {
          addMarker(transport.currentTime, name);
        }
      },
    },
    {
      label: "Region from selection",
      shortcut: "Shift+R",
      onClick: () => {
        const { addRegion, timeSelection } = useDAWStore.getState();
        if (timeSelection) {
          addRegion(timeSelection.start, timeSelection.end);
        } else {
          alert("No time selection. Please select a time range first.");
        }
      },
      dividerAfter: true,
    },
    {
      label: "Track Spacer Below",
      onClick: () => {
        const state = useDAWStore.getState();
        const targetTrackId = state.selectedTrackIds[0] || state.tracks[state.tracks.length - 1]?.id;
        if (targetTrackId) {
          state.addSpacer(targetTrackId);
        }
      },
    },
  ];

  // Options menu - record mode, ripple editing, etc.
  const { recordMode, rippleMode, lockSettings, globalLocked, moveEnvelopesWithItems } = useDAWStore.getState();
  const optionsMenuItems: MenuItemProps[] = [
    {
      label: "Record Mode",
      submenu: [
        {
          label: "Normal",
          checked: recordMode === "normal",
          onClick: () => useDAWStore.getState().setRecordMode("normal"),
        },
        {
          label: "Overdub (Layer)",
          checked: recordMode === "overdub",
          onClick: () => useDAWStore.getState().setRecordMode("overdub"),
        },
        {
          label: "Replace",
          checked: recordMode === "replace",
          onClick: () => useDAWStore.getState().setRecordMode("replace"),
        },
      ],
    },
    {
      label: "Ripple Editing",
      submenu: [
        {
          label: "Off",
          checked: rippleMode === "off",
          onClick: () => useDAWStore.getState().setRippleMode("off"),
        },
        {
          label: "Per Track",
          checked: rippleMode === "per_track",
          onClick: () => useDAWStore.getState().setRippleMode("per_track"),
        },
        {
          label: "All Tracks",
          checked: rippleMode === "all_tracks",
          onClick: () => useDAWStore.getState().setRippleMode("all_tracks"),
        },
      ],
      dividerAfter: true,
    },
    {
      label: "Locking",
      submenu: [
        {
          label: "Global Lock",
          checked: globalLocked,
          onClick: () => useDAWStore.getState().toggleGlobalLock(),
        },
        {
          label: "Lock Items",
          checked: lockSettings.items,
          onClick: () => useDAWStore.getState().setLockSetting("items", !lockSettings.items),
        },
        {
          label: "Lock Envelopes",
          checked: lockSettings.envelopes,
          onClick: () => useDAWStore.getState().setLockSetting("envelopes", !lockSettings.envelopes),
        },
        {
          label: "Lock Time Selection",
          checked: lockSettings.timeSelection,
          onClick: () => useDAWStore.getState().setLockSetting("timeSelection", !lockSettings.timeSelection),
        },
      ],
    },
    {
      label: "Move Envelopes with Items",
      checked: moveEnvelopesWithItems,
      onClick: () => useDAWStore.getState().toggleMoveEnvelopesWithItems(),
      dividerAfter: true,
    },
    {
      label: "Theme",
      submenu: (() => {
        const currentTheme = useDAWStore.getState().theme;
        return [
          ...THEME_PRESETS.map((preset) => ({
            label: preset.label,
            checked: currentTheme === preset.name,
            onClick: () => useDAWStore.getState().setTheme(preset.name),
          })),
          {
            label: "Theme Editor...",
            onClick: () => useDAWStore.getState().toggleThemeEditor(),
            dividerAfter: false,
          },
        ];
      })(),
      dividerAfter: true,
    },
    {
      label: "Preferences...",
      shortcut: "Ctrl+,",
      onClick: () => useDAWStore.getState().togglePreferences(),
    },
  ];

  // Help menu
  const helpMenuItems: MenuItemProps[] = [
    {
      label: "Keyboard Shortcuts",
      shortcut: "F1",
      onClick: () => useDAWStore.getState().toggleKeyboardShortcuts(),
    },
    {
      label: "About Studio13",
      onClick: () => {
        alert(
          "Studio13 v3\n\n" +
          "A hybrid DAW with JUCE C++ backend and React/TypeScript frontend.\n\n" +
          "Built with:\n  JUCE 8.0 — Audio engine, VST3 hosting\n" +
          "  React — User interface\n  Konva — Timeline canvas\n  Zustand — State management\n\n" +
          "github.com/studio13"
        );
      },
      dividerAfter: true,
    },
    {
      label: "Command Palette",
      shortcut: "Ctrl+Shift+P",
      onClick: () => useDAWStore.getState().toggleCommandPalette(),
    },
  ];

  return (
    <div
      className="h-8 bg-daw-darker border-b border-daw-border flex items-center text-sm shrink-0 relative z-9999 select-none"
      onMouseDown={handleDragStart}
      onDoubleClick={handleDoubleClick}
    >
      {/* App icon + Menus (no-drag so clicks work normally) */}
      <div className="flex items-center shrink-0" data-no-drag>
        <img src="/icon.svg" alt="Studio13" className="w-4 h-4 mx-2" />
        <MenuDropdown label="File" items={fileMenuItems} />
        <EditMenu />
        <MenuDropdown label="View" items={viewMenuItems} />
        <MenuDropdown label="Insert" items={insertMenuItems} />
        <MenuDropdown label="Options" items={optionsMenuItems} />
        <MenuDropdown label="Help" items={helpMenuItems} />
      </div>

      {/* Draggable spacer — fills remaining width, acts as title bar drag area */}
      <div className="flex-1 min-w-0" />

      {/* Window controls */}
      <div className="flex items-center shrink-0 h-full" data-no-drag>
        <button
          onClick={handleMinimize}
          className="h-full px-3.5 flex items-center justify-center text-neutral-400 hover:bg-neutral-700/60 hover:text-white transition-colors"
          title="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={handleMaximize}
          className="h-full px-3.5 flex items-center justify-center text-neutral-400 hover:bg-neutral-700/60 hover:text-white transition-colors"
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          onClick={handleClose}
          className="h-full px-3.5 flex items-center justify-center text-neutral-400 hover:bg-red-600 hover:text-white transition-colors"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

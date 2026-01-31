import { EditMenu } from "./menus/EditMenu";
import { MenuDropdown, MenuItemProps } from "./menus/MenuDropdown";
import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";

/**
 * Main Menu Bar Component
 * Contains File, Edit, View, Insert, Track, Options, Actions, Help menus
 */
export function MenuBar() {
  const {
    toggleMixer,
    showMixer,
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
  } = useDAWStore();

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
      dividerAfter: true,
    },
    {
      label: "Quit",
      shortcut: "Ctrl+Q",
      onClick: () => {
        // In a real app, this would close the window
        console.log("Quit - not yet implemented");
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
      label: "Show Virtual MIDI Keyboard",
      shortcut: "Alt+B",
      onClick: toggleVirtualKeyboard,
      checked: showVirtualKeyboard,
    },
    {
      label: "Audio Settings...",
      onClick: openSettings,
    },
    {
      label: "Render...",
      shortcut: "Ctrl+Alt+R",
      onClick: openRenderModal,
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
    },
  ];

  // Help menu
  const helpMenuItems: MenuItemProps[] = [
    {
      label: "Keyboard Shortcuts",
      shortcut: "F1",
      onClick: () => {
        // TODO: Show shortcuts modal
        console.log("Keyboard shortcuts - not yet implemented");
      },
    },
    {
      label: "About Studio13",
      onClick: () => {
        // TODO: Show about modal
        console.log("About - not yet implemented");
      },
    },
  ];

  return (
    <div className="h-7 bg-daw-darker border-b border-daw-border flex items-center px-1 text-sm shrink-0">
      <MenuDropdown label="File" items={fileMenuItems} />
      <EditMenu />
      <MenuDropdown label="View" items={viewMenuItems} />
      <MenuDropdown label="Insert" items={insertMenuItems} />
      <MenuDropdown label="Help" items={helpMenuItems} />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { X } from "lucide-react";
import { nativeBridge } from "./services/NativeBridge";
import { useDAWStore } from "./store/useDAWStore";
import { Button } from "./components/ui";
import { Timeline } from "./components/Timeline";
import { MixerPanel } from "./components/MixerPanel";
import { MainToolbar } from "./components/MainToolbar";
import { TransportBar as BottomTransportBar } from "./components/TransportBar";
import { SettingsModal } from "./components/SettingsModal";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { RenderModal } from "./components/RenderModal";
import { VirtualPianoKeyboard } from "./components/VirtualPianoKeyboard";
import { PianoRoll } from "./components/PianoRoll";
import { UndoHistoryPanel } from "./components/UndoHistoryPanel";
import { CommandPalette } from "./components/CommandPalette";
import { RegionMarkerManager } from "./components/RegionMarkerManager";
import { ClipPropertiesPanel } from "./components/ClipPropertiesPanel";
import { BigClock } from "./components/BigClock";
import { KeyboardShortcutsModal } from "./components/KeyboardShortcutsModal";
import { PreferencesModal } from "./components/PreferencesModal";
import { MenuBar } from "./components/MenuBar";
import { MasterTrackHeader } from "./components/MasterTrackHeader";
import { RenderQueuePanel } from "./components/RenderQueuePanel";
import { DynamicSplitModal } from "./components/DynamicSplitModal";
import { RegionRenderMatrix } from "./components/RegionRenderMatrix";
import { RoutingMatrix } from "./components/RoutingMatrix";
import { MediaExplorer } from "./components/MediaExplorer";
import { CleanProjectModal } from "./components/CleanProjectModal";
import { BatchConverterModal } from "./components/BatchConverterModal";
import { CrossfadeEditor } from "./components/CrossfadeEditor";
import { ThemeEditor } from "./components/ThemeEditor";
import { VideoWindow } from "./components/VideoWindow";
import { ScriptEditor } from "./components/ScriptEditor";
import { ProjectTabBar } from "./components/ProjectTabBar";
import { ToolbarEditor, CustomToolbarStrip } from "./components/ToolbarEditor";
import { DDPExportModal } from "./components/DDPExportModal";
import { PluginBrowser } from "./components/PluginBrowser";
import { SortableTrackHeader } from "./components/SortableTrackHeader";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

function App() {
  // Use useShallow to prevent re-renders when unrelated state changes (like currentTime)
  const {
    tracks,
    addTrack,
    showMixer,
    showMasterTrackInTCP,
    toggleMixer,
    showSettings,
    showProjectSettings,
    showRenderModal,
    showVirtualKeyboard,
    openSettings,
    closeSettings,
    closeProjectSettings,
    closeRenderModal,
    batchUpdateMeterLevels,
    reorderTrack,
    setCurrentTime,
    showPianoRoll,
    pianoRollTrackId,
    pianoRollClipId,
    closePianoRoll,
    showUndoHistory,
    showCommandPalette,
    showRegionMarkerManager,
    showClipProperties,
    showBigClock,
    showKeyboardShortcuts,
    showPreferences,
    showRenderQueue,
    showDynamicSplit,
    showRegionRenderMatrix,
    showRoutingMatrix,
    showMediaExplorer,
    showCleanProject,
    showBatchConverter,
    showCrossfadeEditor,
    showThemeEditor,
    showScriptEditor,
    showToolbarEditor,
    showDDPExport,
    showPluginBrowser,
    pluginBrowserTrackId,
    tcpWidth,
    setTcpWidth,
  } = useDAWStore(
    useShallow((state) => ({
      tracks: state.tracks,
      addTrack: state.addTrack,
      showMixer: state.showMixer,
      showMasterTrackInTCP: state.showMasterTrackInTCP,
      toggleMixer: state.toggleMixer,
      showSettings: state.showSettings,
      showProjectSettings: state.showProjectSettings,
      showRenderModal: state.showRenderModal,
      showVirtualKeyboard: state.showVirtualKeyboard,
      openSettings: state.openSettings,
      closeSettings: state.closeSettings,
      closeProjectSettings: state.closeProjectSettings,
      closeRenderModal: state.closeRenderModal,
      batchUpdateMeterLevels: state.batchUpdateMeterLevels,
      reorderTrack: state.reorderTrack,
      setCurrentTime: state.setCurrentTime,
      showPianoRoll: state.showPianoRoll,
      pianoRollTrackId: state.pianoRollTrackId,
      pianoRollClipId: state.pianoRollClipId,
      closePianoRoll: state.closePianoRoll,
      showUndoHistory: state.showUndoHistory,
      showCommandPalette: state.showCommandPalette,
      showRegionMarkerManager: state.showRegionMarkerManager,
      showClipProperties: state.showClipProperties,
      showBigClock: state.showBigClock,
      showKeyboardShortcuts: state.showKeyboardShortcuts,
      showPreferences: state.showPreferences,
      showRenderQueue: state.showRenderQueue,
      showDynamicSplit: state.showDynamicSplit,
      showRegionRenderMatrix: state.showRegionRenderMatrix,
      showRoutingMatrix: state.showRoutingMatrix,
      showMediaExplorer: state.showMediaExplorer,
      showCleanProject: state.showCleanProject,
      showBatchConverter: state.showBatchConverter,
      showCrossfadeEditor: state.showCrossfadeEditor,
      showThemeEditor: state.showThemeEditor,
      showScriptEditor: state.showScriptEditor,
      showToolbarEditor: state.showToolbarEditor,
      showDDPExport: state.showDDPExport,
      showPluginBrowser: state.showPluginBrowser,
      pluginBrowserTrackId: state.pluginBrowserTrackId,
      tcpWidth: state.tcpWidth,
      setTcpWidth: state.setTcpWidth,
    }))
  );

  // Ref for workspace wheel handling
  const workspaceRef = useRef<HTMLDivElement>(null);

  // Project loading state (separate selector to avoid unnecessary re-renders)
  const isProjectLoading = useDAWStore((state) => state.isProjectLoading);
  const projectLoadingMessage = useDAWStore((state) => state.projectLoadingMessage);

  // Toast notification state
  const toastVisible = useDAWStore((state) => state.toastVisible);
  const toastMessage = useDAWStore((state) => state.toastMessage);
  const toastType = useDAWStore((state) => state.toastType);

  // Subscribe only to isPlaying to avoid re-rendering App on every time update
  const isPlaying = useDAWStore((state) => state.transport.isPlaying);

  // Playback Loop - updates time smoothly at 60fps
  // Memoization in Timeline prevents expensive recalculations
  useEffect(() => {
    if (!isPlaying) return;

    let lastTime = performance.now();
    let frameId: number;

    const loop = () => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const currentState = useDAWStore.getState();
      if (currentState.transport.isPlaying) {
        let newTime = currentState.transport.currentTime + dt;

        // Loop: wrap back to loopStart when reaching loopEnd
        const { loopEnabled, loopStart, loopEnd } = currentState.transport;
        if (loopEnabled && loopEnd > loopStart && newTime >= loopEnd) {
          newTime = loopStart + (newTime - loopEnd);
          // Sync backend position on loop wrap
          nativeBridge.setTransportPosition(newTime);
        }

        currentState.setCurrentTime(newTime);
      }

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, setCurrentTime]);

  // Sync frontend playhead from backend transport position (10Hz).
  // The RAF loop above provides smooth 60fps interpolation, but drifts over time.
  // The backend's 10Hz transportUpdate corrects that drift, keeping the visual
  // playhead within ~100ms of the true audio position at all times.
  useEffect(() => {
    const unsub = nativeBridge.onTransportUpdate((data) => {
      const state = useDAWStore.getState();
      if (!state.transport.isPlaying) return;

      const backendPos = data.position;
      const frontendPos = state.transport.currentTime;
      const drift = Math.abs(backendPos - frontendPos);

      // Only correct if drift exceeds 30ms — avoids jitter from minor timing differences
      if (drift > 0.03) {
        state.setCurrentTime(backendPos);
      }
    });

    return unsub;
  }, []);

  // Auto-backup timer
  useEffect(() => {
    const state = useDAWStore.getState();
    if (!state.autoBackupEnabled) return;

    const interval = setInterval(() => {
      const s = useDAWStore.getState();
      if (s.isModified && s.projectPath) {
        s.saveProject(false).then((ok) => {
          if (ok) console.log("[App] Auto-backup saved");
        });
      }
    }, state.autoBackupInterval);

    return () => clearInterval(interval);
  }, []);

  const syncedRef = useRef(false);

  // Sync frontend state to backend when tracks are loaded.
  // Uses the correct track ID so C++ trackMap and Zustand stay in sync.
  // Tracks are not persisted to localStorage so this only fires when the store
  // first becomes non-empty (e.g. loadProject restores tracks from a file).
  useEffect(() => {
    if (syncedRef.current) return;
    if (tracks.length === 0) return; // Wait for tracks

    syncedRef.current = true;

    const syncBackend = async () => {
      console.log("[App] Syncing", tracks.length, "track(s) to C++ backend");
      for (const track of tracks) {
        try {
          // Pass the explicit track ID so C++ trackMap uses the same UUID as Zustand.
          // Without the ID, C++ generates a fresh UUID → arm/record calls are silently ignored.
          await nativeBridge.addTrack(track.id);
          if (track.armed)   await nativeBridge.setTrackRecordArm(track.id, true);
          if (track.muted)   await nativeBridge.setTrackMute(track.id, true);
          if (track.soloed)  await nativeBridge.setTrackSolo(track.id, true);
        } catch (e) {
          console.error("[App] Failed to sync track to backend:", e);
        }
      }
    };

    setTimeout(syncBackend, 500);
  }, [tracks]); // Run when tracks available

  // Event-based metering — single batched store update for all tracks + master
  useEffect(() => {
    nativeBridge.onMeterUpdate((data) => {
      const trackLevels: Record<string, number> = data.trackLevels && typeof data.trackLevels === "object" && !Array.isArray(data.trackLevels)
        ? data.trackLevels
        : {};
      const masterLevel = typeof data.masterLevel === "number" ? data.masterLevel : 0;
      batchUpdateMeterLevels(trackLevels, masterLevel);
    });
  }, [batchUpdateMeterLevels]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyUp = (_e: KeyboardEvent) => {
      // Spacebar moved to handleKeyDown to prevent native scroll-down
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return;
      }

      // Spacebar: Toggle play/stop (must be in keydown to prevent native page scroll)
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        const state = useDAWStore.getState();
        if (state.transport.isRecording) {
          state.stop();
        } else if (state.transport.isPlaying) {
          state.stop();
        } else {
          state.play();
        }
        return;
      }

      // Ctrl+R: Record toggle
      if (e.key === "r" && e.ctrlKey) {
        e.preventDefault();
        const state = useDAWStore.getState();
        if (state.transport.isRecording) {
          state.stop();
        } else if (state.tracks.some(t => t.armed)) {
          state.record();
        }
      }

      // Delete: Delete selected tracks first, then clips
      if (e.key === "Delete") {
        const state = useDAWStore.getState();
        if (state.selectedTrackIds.length > 0) {
          // Delete selected tracks
          state.deleteSelectedTracks();
        } else if (state.selectedClipIds.length > 0) {
          state.selectedClipIds.forEach((id) => state.deleteClip(id));
        }
      }

      // Arrow Left/Right: Nudge selected clips (Ctrl = fine nudge)
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.shiftKey && !e.altKey) {
        const state = useDAWStore.getState();
        if (state.selectedClipIds.length > 0) {
          e.preventDefault();
          state.nudgeClips(e.key === "ArrowRight" ? "right" : "left", e.ctrlKey);
        }
      }

      // Ctrl+Shift+A: Select all clips
      if (e.key === "a" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        useDAWStore.getState().selectAllClips();
        return; // Don't fall through to Ctrl+A
      }

      // Ctrl+A: Select all tracks
      if (e.key === "a" && e.ctrlKey) {
        e.preventDefault();
        const state = useDAWStore.getState();
        state.selectAllTracks();
      }

      // Ctrl+C: Copy selected clips
      if (e.key === "c" && e.ctrlKey) {
        const state = useDAWStore.getState();
        if (state.selectedClipIds.length > 0) {
          e.preventDefault();
          state.copySelectedClips();
        }
      }

      // Ctrl+X: Cut selected clips
      if (e.key === "x" && e.ctrlKey) {
        const state = useDAWStore.getState();
        if (state.selectedClipIds.length > 0) {
          e.preventDefault();
          state.cutSelectedClips();
        }
      }

      // Ctrl+D: Duplicate selected clips
      if (e.key === "d" && e.ctrlKey) {
        const state = useDAWStore.getState();
        if (state.selectedClipIds.length > 0) {
          e.preventDefault();
          state.selectedClipIds.forEach((id) => state.duplicateClip(id));
        }
      }

      // Ctrl+Z: Undo
      if (e.key === "z" && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        useDAWStore.getState().undo();
      }

      // Ctrl+Shift+Z: Redo
      if (e.key === "z" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        useDAWStore.getState().redo();
      }

      // U: Toggle mute on selected clips
      if (e.key === "u" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const state = useDAWStore.getState();
        if (state.selectedClipIds.length > 0) {
          state.selectedClipIds.forEach((id) => state.toggleClipMute(id));
        }
      }

      // Ctrl+Shift+S: Save As
      if (e.key === "S" && e.ctrlKey && e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().saveProject(true);
        return;
      }

      // Ctrl+S: Save Project
      if (e.key === "s" && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().saveProject();
        return;
      }

      // S: Split clips at cursor
      if (e.key === "s" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().splitClipAtPlayhead();
      }

      // T: Tap Tempo
      if (e.key === "t" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().tapTempo();
      }

      // M: Add Marker at Playhead
      if (e.key === "m" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const { addMarker, transport } = useDAWStore.getState();
        addMarker(transport.currentTime);
      }

      // Shift+M: Add Marker with name
      if (e.key === "M" && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const { addMarker, transport } = useDAWStore.getState();
        const name = prompt("Enter marker name:");
        if (name !== null) {
          addMarker(transport.currentTime, name);
        }
      }

      // Shift+R: Create Region from selection
      if (e.key === "R" && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const { addRegion, timeSelection } = useDAWStore.getState();
        if (timeSelection) {
          addRegion(timeSelection.start, timeSelection.end);
        }
      }

      // L: Toggle Loop
      if (e.key === "l" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().toggleLoop();
      }

      // Ctrl+L: Set Loop to Selection
      if (e.key === "l" && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const { setLoopToSelection, timeSelection } = useDAWStore.getState();
        if (timeSelection) {
          setLoopToSelection();
        }
      }

      // Ctrl+Shift+P: Command Palette
      if (e.key === "P" && e.ctrlKey && e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().toggleCommandPalette();
      }

      // Ctrl+Alt+Z: Toggle Undo History Panel
      if (e.key === "z" && e.ctrlKey && e.altKey && !e.shiftKey) {
        e.preventDefault();
        useDAWStore.getState().toggleUndoHistory();
      }

      // Alt+Enter: Open Project Settings
      if (e.key === "Enter" && e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        useDAWStore.getState().openProjectSettings();
      }

      // Alt+B: Toggle Virtual MIDI Keyboard
      if (e.key === "b" && e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        useDAWStore.getState().toggleVirtualKeyboard();
      }

      // Ctrl+,: Open Preferences
      if (e.key === "," && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().togglePreferences();
      }

      // F1: Toggle Keyboard Shortcuts Modal
      if (e.key === "F1" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().toggleKeyboardShortcuts();
      }

      // F2: Toggle Clip Properties Panel
      if (e.key === "F2" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useDAWStore.getState().toggleClipProperties();
      }

      // Ctrl+O: Open Project
      if (e.key === "o" && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void useDAWStore.getState().loadProject();
        return;
      }

      // Ctrl+Shift+O: Open Project (Safe Mode)
      if (e.key === "O" && e.ctrlKey && e.shiftKey && !e.altKey) {
        e.preventDefault();
        void useDAWStore.getState().loadProject(undefined, { bypassFX: true });
      }

      // Ctrl+N: New Project
      if (e.key === "n" && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void useDAWStore.getState().newProject();
        return;
      }

      // Ctrl+Shift+1-3: Save Screensets
      if (e.ctrlKey && e.shiftKey && !e.altKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        useDAWStore.getState().saveScreenset(Number.parseInt(e.key, 10) - 1);
      }

      // Ctrl+1-3: Load Screensets (without Shift)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        useDAWStore.getState().loadScreenset(Number.parseInt(e.key, 10) - 1);
      }

      // Escape: Close Piano Roll (and other modals)
      if (e.key === "Escape") {
        const state = useDAWStore.getState();
        if (state.showPianoRoll) {
          e.preventDefault();
          state.closePianoRoll();
        }
      }

      // Insert: Import Media File
      if (e.key === "Insert" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        (async () => {
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
        })();
      }
    };

    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Handle audio files dropped from OS file explorer via HTML5 drag-and-drop.
  // WebView2 intercepts OLE drag-drop before JUCE can see it, so we handle it
  // entirely in JS: read file data → send to C++ to save to disk → import.
  useEffect(() => {
    const MEDIA_EXTENSIONS = new Set([
      // Audio
      ".wav", ".mp3", ".flac", ".ogg", ".aiff", ".aif", ".wma", ".m4a", ".aac",
      // Video (audio will be extracted via FFmpeg)
      ".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".flv", ".m4v",
    ]);
    const MAX_DROP_SIZE = 500 * 1024 * 1024; // 500MB limit for base64 transfer

    const handleDragOver = (e: DragEvent) => {
      // Must preventDefault on dragover to allow the drop event to fire
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      // Filter to supported media files
      const mediaFiles: File[] = [];
      for (const file of files) {
        const ext = "." + file.name.split(".").pop()?.toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) {
          if (file.size > MAX_DROP_SIZE) {
            console.warn(`[App] Skipping "${file.name}" — too large (${Math.round(file.size / 1024 / 1024)}MB, max ${MAX_DROP_SIZE / 1024 / 1024}MB)`);
            continue;
          }
          mediaFiles.push(file);
        }
      }

      if (mediaFiles.length === 0) return;
      console.log(`[App] ${mediaFiles.length} media file(s) dropped from OS`);

      for (const file of mediaFiles) {
        try {
          // Read file data and convert to base64 (chunked for performance)
          const arrayBuffer = await file.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          const CHUNK = 0x8000; // 32KB chunks
          const chunks: string[] = [];
          for (let i = 0; i < bytes.length; i += CHUNK) {
            chunks.push(String.fromCodePoint(...bytes.subarray(i, i + CHUNK)));
          }
          const base64 = btoa(chunks.join(""));

          // Save to disk via C++ backend
          const savedPath = await nativeBridge.saveDroppedFile(file.name, base64);
          if (!savedPath) {
            console.error(`[App] Failed to save dropped file: ${file.name}`);
            continue;
          }

          // Create a new track for this file
          const { tracks, transport, importMedia } = useDAWStore.getState();
          const result = await nativeBridge.addTrack();
          const trackId = typeof result === "string" ? result : `${Date.now()}`;
          const trackName = file.name.replace(/\.[^.]+$/, "");

          addTrack({
            id: trackId,
            name: trackName,
            color: `hsl(${(tracks.length * 60) % 360}, 60%, 50%)`,
          });

          // Import from the saved path
          await importMedia(savedPath, trackId, transport.currentTime);
          console.log(`[App] Imported dropped file: ${file.name} → track ${trackId}`);
        } catch (error) {
          console.error(`[App] Failed to import dropped file: ${file.name}`, error);
        }
      }
    };

    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);
    return () => {
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  }, [addTrack]);

  // Workspace wheel handler — only prevents browser default zoom (Ctrl+scroll).
  // Actual zoom logic is handled by Timeline's RAF-batched handler.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // Prevent browser zoom / native scroll — let Timeline handle the rest
        e.preventDefault();
      }
    };

    workspace.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => workspace.removeEventListener("wheel", handleWheel, { capture: true });
  }, []);

  const handleAddTrack = async () => {
    try {
      const result = await nativeBridge.addTrack();
      // If result is string (UUID) or boolean true (native mock)
      const id = typeof result === "string" ? result : `${Date.now()}`;

      addTrack({
        id,
        name: `Track ${tracks.length + 1}`,
        color: `hsl(${(tracks.length * 60) % 360}, 60%, 50%)`,
      });
    } catch (e) {
      console.error("Failed to add track:", e);
    }
  };

  // Drag and Drop Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement to start drag (prevents accidental drags on clicks)
      },
    }),
  );

  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const handleDragStart = (event: any) => {
    setActiveDragId(event.active.id.toString());
  };

  const handleDragEnd = (event: any) => {
    setActiveDragId(null);
    const { active, over } = event;

    if (active && over && active.id !== over.id) {
      const { selectedTrackIds, reorderMultipleTracks } = useDAWStore.getState();
      // If multiple tracks are selected and the dragged one is among them, move all together
      if (selectedTrackIds.length > 1 && selectedTrackIds.includes(active.id.toString())) {
        reorderMultipleTracks(selectedTrackIds, over.id.toString());
      } else {
        reorderTrack(active.id, over.id);
      }
    }
  };

  return (
    <div className="app-container">
      {/* Project Tab Bar (Phase 15C) */}
      <ProjectTabBar />
      {/* Menu Bar */}
      <MenuBar />
      {/* Main Toolbar with Mixer Toggle */}
      <MainToolbar
        onOpenSettings={openSettings}
        onToggleMixer={toggleMixer}
        showMixer={showMixer}
      />

      {/* Custom Toolbars (Phase 15D) */}
      <CustomToolbarStrip />

      {/* Media Explorer (left panel) + Main Workspace */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {showMediaExplorer && (
        <MediaExplorer
          isVisible={showMediaExplorer}
          onClose={() => useDAWStore.getState().toggleMediaExplorer()}
        />
      )}
      <div ref={workspaceRef} className="workspace flex-1">
        {/* Track Control Panel (Left Sidebar) */}
        <div className="track-control-panel" style={{ width: tcpWidth }} onClick={(e) => {
          // Click on empty space (not a track header) → deselect all
          if (e.target === e.currentTarget) {
            useDAWStore.getState().deselectAllTracks();
          }
        }} onWheel={(e) => {
          // Alt+scroll to resize track height (mirrors Timeline behavior)
          if (e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            const store = useDAWStore.getState();
            const curHeight = store.trackHeight;
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            store.setTrackHeight(curHeight * delta);
          }
        }}>
          <div className="tcp-header sticky top-0 z-100">
            <Button
              variant="primary"
              size="sm"
              onClick={handleAddTrack}
              className="add-track-btn"
            >
              + Add Track
            </Button>
          </div>

          <div className="tcp-tracks z-20" onClick={(e) => {
            if (e.target === e.currentTarget) {
              useDAWStore.getState().deselectAllTracks();
            }
          }}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={tracks.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {tracks.map((track) => {
                  const spacer = useDAWStore.getState().spacers.find(
                    (s) => s.afterTrackId === track.id
                  );
                  return (
                    <div key={track.id}>
                      <SortableTrackHeader track={track} />
                      {spacer && (
                        <div
                          className="bg-daw-darker border-b border-daw-border cursor-row-resize group relative"
                          style={{ height: spacer.height }}
                          onDoubleClick={() =>
                            useDAWStore.getState().removeSpacer(spacer.id)
                          }
                          onMouseDown={(e) => {
                            const startY = e.clientY;
                            const startHeight = spacer.height;
                            const onMove = (me: MouseEvent) => {
                              const delta = me.clientY - startY;
                              useDAWStore
                                .getState()
                                .setSpacerHeight(spacer.id, startHeight + delta);
                            };
                            const onUp = () => {
                              window.removeEventListener("mousemove", onMove);
                              window.removeEventListener("mouseup", onUp);
                            };
                            window.addEventListener("mousemove", onMove);
                            window.addEventListener("mouseup", onUp);
                          }}
                          title="Drag to resize, double-click to remove"
                        >
                          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-daw-border group-hover:bg-daw-accent transition-colors" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {activeDragId && (() => {
                  const { selectedTrackIds } = useDAWStore.getState();
                  const isMulti = selectedTrackIds.length > 1 && selectedTrackIds.includes(activeDragId);
                  const dragTracks = isMulti
                    ? tracks.filter((t) => selectedTrackIds.includes(t.id))
                    : tracks.filter((t) => t.id === activeDragId);
                  const trackHeight = useDAWStore.getState().trackHeight;
                  return (
                    <div className="opacity-80 shadow-xl rounded overflow-hidden" style={{ width: '100%' }}>
                      {dragTracks.map((t) => (
                        <div
                          key={t.id}
                          className="border-b border-neutral-900 bg-neutral-800 flex items-center px-2"
                          style={{ height: trackHeight }}
                        >
                          <div className="w-2 h-full shrink-0" style={{ background: t.color || '#666' }} />
                          <span className="ml-2 text-xs text-neutral-200 truncate">{t.name}</span>
                        </div>
                      ))}
                      {isMulti && (
                        <div className="bg-blue-600/80 text-white text-[10px] text-center py-0.5">
                          {dragTracks.length} tracks
                        </div>
                      )}
                    </div>
                  );
                })()}
              </DragOverlay>
            </DndContext>
          </div>

          {/* Master Track in TCP */}
          {showMasterTrackInTCP && <MasterTrackHeader />}
        </div>

        {/* Draggable resize handle between TCP and Timeline */}
        <div
          className="w-1.5 shrink-0 self-stretch sticky top-0 cursor-col-resize group/resize z-50"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = tcpWidth;
            document.body.style.cursor = "col-resize";
            const onMove = (me: MouseEvent) => {
              setTcpWidth(startWidth + (me.clientX - startX));
            };
            const onUp = () => {
              document.body.style.cursor = "";
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          title="Drag to resize track panel"
        >
          <div className="w-full h-full bg-neutral-900 group-hover/resize:bg-daw-accent/50 group-active/resize:bg-daw-accent transition-colors" />
        </div>

        {/* Timeline (Canvas-based) */}
        <Timeline tracks={tracks} />
      </div>
      </div>{/* Close Media Explorer + Workspace wrapper */}

      {/* Transport Bar (above Mixer like Reaper) */}
      <BottomTransportBar />

      {/* Virtual MIDI Keyboard */}
      {showVirtualKeyboard && <VirtualPianoKeyboard />}

      {/* Piano Roll Editor Modal */}
      {showPianoRoll && pianoRollTrackId && pianoRollClipId && (
        <div className="fixed inset-0 z-2000 flex items-center justify-center bg-black/60">
          <div className="relative w-[90vw] h-[80vh] bg-neutral-900 rounded-lg shadow-2xl border border-neutral-700 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 bg-neutral-800 border-b border-neutral-700">
              <h2 className="text-sm font-semibold text-white">Piano Roll Editor</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={closePianoRoll}
                title="Close (Esc)"
              >
                <X size={16} />
              </Button>
            </div>
            {/* Piano Roll Content */}
            <div className="flex-1 overflow-hidden">
              <PianoRoll trackId={pianoRollTrackId} clipId={pianoRollClipId} />
            </div>
          </div>
        </div>
      )}

      {/* Undo History Panel */}
      {showUndoHistory && (
        <div className="fixed right-2 top-20 z-1000">
          <UndoHistoryPanel />
        </div>
      )}

      {/* Big Clock */}
      {showBigClock && (
        <div className="fixed left-1/2 top-16 -translate-x-1/2 z-1000">
          <BigClock />
        </div>
      )}

      {/* Clip Properties Panel */}
      {showClipProperties && (
        <div className="fixed left-2 top-20 z-1000">
          <ClipPropertiesPanel />
        </div>
      )}

      {/* Region/Marker Manager */}
      {showRegionMarkerManager && (
        <div className="fixed right-2 top-20 z-1000 w-72 h-96 rounded border border-daw-border shadow-lg overflow-hidden">
          <RegionMarkerManager />
        </div>
      )}

      {/* Render Queue Panel */}
      {showRenderQueue && (
        <div className="fixed right-2 bottom-16 z-1000">
          <RenderQueuePanel />
        </div>
      )}

      {/* Preferences Modal */}
      <PreferencesModal
        isOpen={showPreferences}
        onClose={() => useDAWStore.getState().togglePreferences()}
      />

      {/* Keyboard Shortcuts Modal */}
      <KeyboardShortcutsModal
        isOpen={showKeyboardShortcuts}
        onClose={() => useDAWStore.getState().toggleKeyboardShortcuts()}
      />

      {/* Command Palette */}
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => useDAWStore.getState().toggleCommandPalette()}
      />

      {/* Dynamic Split Modal (Phase 9B) */}
      <DynamicSplitModal
        isOpen={showDynamicSplit}
        onClose={() => useDAWStore.getState().closeDynamicSplit()}
      />

      {/* Mixer Panel */}
      <MixerPanel isVisible={showMixer} onClose={toggleMixer} />
      

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={closeSettings} />

      {/* Project Settings Modal */}
      <ProjectSettingsModal
        isOpen={showProjectSettings}
        onClose={closeProjectSettings}
      />

      {/* Render Modal */}
      <RenderModal isOpen={showRenderModal} onClose={closeRenderModal} />

      {/* Routing Matrix (Phase 11B) */}
      <RoutingMatrix
        isOpen={showRoutingMatrix}
        onClose={() => useDAWStore.getState().toggleRoutingMatrix()}
      />

      {/* Region Render Matrix (Phase 10A) */}
      <RegionRenderMatrix
        isOpen={showRegionRenderMatrix}
        onClose={() => useDAWStore.getState().toggleRegionRenderMatrix()}
      />

      {/* Clean Project Directory (Phase 12B) */}
      <CleanProjectModal
        isOpen={showCleanProject}
        onClose={() => useDAWStore.getState().toggleCleanProject()}
      />

      {/* Batch File Converter (Phase 12E) */}
      <BatchConverterModal
        isOpen={showBatchConverter}
        onClose={() => useDAWStore.getState().toggleBatchConverter()}
      />

      {/* Crossfade Editor (Phase 13A) */}
      <CrossfadeEditor
        isOpen={showCrossfadeEditor}
        onClose={() => useDAWStore.getState().closeCrossfadeEditor()}
      />

      {/* Theme Editor (Phase 14A+B) */}
      <ThemeEditor
        isOpen={showThemeEditor}
        onClose={() => useDAWStore.getState().toggleThemeEditor()}
      />

      {/* Video Window (Phase 15A) */}
      <VideoWindow />

      {/* Script Editor (Phase 15B) */}
      {showScriptEditor && <ScriptEditor />}

      {/* Toolbar Editor (Phase 15D) */}
      <ToolbarEditor
        isOpen={showToolbarEditor}
        onClose={() => useDAWStore.getState().toggleToolbarEditor()}
      />

      {/* DDP Export (Phase 16C) */}
      <DDPExportModal
        isOpen={showDDPExport}
        onClose={() => useDAWStore.getState().toggleDDPExport()}
      />

      {/* Plugin Browser (from action registry — instrument track creation) */}
      {showPluginBrowser && pluginBrowserTrackId && (
        <PluginBrowser
          trackId={pluginBrowserTrackId}
          targetChain={
            tracks.find((t) => t.id === pluginBrowserTrackId)?.type === "instrument"
              ? "instrument"
              : "track"
          }
          onClose={() => useDAWStore.getState().closePluginBrowser()}
        />
      )}

      {/* Project Loading Overlay */}
      {isProjectLoading && (
        <div className="fixed inset-0 z-10000 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 border-3 border-daw-accent border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-neutral-300 font-medium">
              {projectLoadingMessage || "Loading project..."}
            </p>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastVisible && (
        <div className={`fixed bottom-20 left-1/2 -translate-x-1/2 z-10000 px-4 py-2 rounded-lg shadow-lg text-sm font-medium transition-all animate-in fade-in slide-in-from-bottom-2 duration-200 ${
          toastType === "success" ? "bg-green-600 text-white" :
          toastType === "error" ? "bg-red-600 text-white" :
          "bg-neutral-700 text-white"
        }`}>
          {toastMessage}
        </div>
      )}
    </div>
  );
}

export default App;

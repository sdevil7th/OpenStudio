import { useEffect, useRef } from "react";
import { useShallow } from "zustand/shallow";
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
import { MenuBar } from "./components/MenuBar";
import { SortableTrackHeader } from "./components/SortableTrackHeader";
import {
  DndContext,
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
    toggleMixer,
    showSettings,
    showProjectSettings,
    showRenderModal,
    showVirtualKeyboard,
    openSettings,
    closeSettings,
    closeProjectSettings,
    closeRenderModal,
    setTrackMeterLevel,
    setMasterLevel,
    reorderTrack,
    setCurrentTime,
    showPianoRoll,
    pianoRollTrackId,
    pianoRollClipId,
    closePianoRoll,
    trackHeight,
    setTrackHeight,
    pixelsPerSecond,
    setZoom,
  } = useDAWStore(
    useShallow((state) => ({
      tracks: state.tracks,
      addTrack: state.addTrack,
      showMixer: state.showMixer,
      toggleMixer: state.toggleMixer,
      showSettings: state.showSettings,
      showProjectSettings: state.showProjectSettings,
      showRenderModal: state.showRenderModal,
      showVirtualKeyboard: state.showVirtualKeyboard,
      openSettings: state.openSettings,
      closeSettings: state.closeSettings,
      closeProjectSettings: state.closeProjectSettings,
      closeRenderModal: state.closeRenderModal,
      setTrackMeterLevel: state.setTrackMeterLevel,
      setMasterLevel: state.setMasterLevel,
      reorderTrack: state.reorderTrack,
      setCurrentTime: state.setCurrentTime,
      showPianoRoll: state.showPianoRoll,
      pianoRollTrackId: state.pianoRollTrackId,
      pianoRollClipId: state.pianoRollClipId,
      closePianoRoll: state.closePianoRoll,
      trackHeight: state.trackHeight,
      setTrackHeight: state.setTrackHeight,
      pixelsPerSecond: state.pixelsPerSecond,
      setZoom: state.setZoom,
    }))
  );

  // Ref for workspace wheel handling
  const workspaceRef = useRef<HTMLDivElement>(null);

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
        currentState.setCurrentTime(currentState.transport.currentTime + dt);
      }

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, setCurrentTime]);

  const syncedRef = useRef(false);

  // Sync frontend state to backend when tracks are loaded
  useEffect(() => {
    if (syncedRef.current) return;
    if (tracks.length === 0) return; // Wait for tracks

    console.log(
      "[App] Frontend tracks detected:",
      tracks.length,
      "- Syncing to backend",
    );
    syncedRef.current = true;

    const syncBackend = async () => {
      console.log("[App] Syncing backend state with", tracks.length, "tracks");
      for (const _ of tracks) {
        try {
          await nativeBridge.addTrack();
          console.log("[App] Synced track to backend");
        } catch (e) {
          console.error("[App] Failed to sync track:", e);
        }
      }
    };

    setTimeout(syncBackend, 500);
  }, [tracks]); // Run when tracks available

  // Event-based metering (replaces polling)
  useEffect(() => {
    nativeBridge.onMeterUpdate((data) => {
      // Update track meter levels - data.trackLevels is now an object with trackId -> level
      if (data.trackLevels && typeof data.trackLevels === "object") {
        // Iterate over track IDs in the meter data
        Object.entries(data.trackLevels).forEach(([trackId, level]) => {
          setTrackMeterLevel(trackId, level as number);
        });
      }

      // Update master level
      if (typeof data.masterLevel === "number") {
        setMasterLevel(data.masterLevel);
      }
    });
  }, [setTrackMeterLevel, setMasterLevel]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      // Ignore if focused on input, textarea, or contenteditable
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return;
      }

      // Spacebar: Toggle play/stop
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
      }
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

      // Ctrl+R: Record toggle
      if (e.key === "r" && e.ctrlKey) {
        e.preventDefault();
        const state = useDAWStore.getState();
        if (state.transport.isRecording) {
          state.stop();
        } else {
          state.record();
        }
      }

      // Delete: Delete selected tracks first, then clips
      if (e.key === "Delete") {
        const state = useDAWStore.getState();
        if (state.selectedTrackIds.length > 0) {
          // Delete selected tracks
          state.deleteSelectedTracks();
        } else if (state.selectedClipId) {
          state.deleteClip(state.selectedClipId);
        }
      }

      // Ctrl+A: Select all tracks
      if (e.key === "a" && e.ctrlKey) {
        e.preventDefault();
        const state = useDAWStore.getState();
        state.selectAllTracks();
      }

      // Ctrl+C: Copy selected clip
      if (e.key === "c" && e.ctrlKey) {
        const state = useDAWStore.getState();
        if (state.selectedClipId) {
          e.preventDefault();
          state.copyClip(state.selectedClipId);
        }
      }

      // Ctrl+X: Cut selected clip
      if (e.key === "x" && e.ctrlKey) {
        const state = useDAWStore.getState();
        if (state.selectedClipId) {
          e.preventDefault();
          state.cutClip(state.selectedClipId);
        }
      }

      // Ctrl+D: Duplicate selected clip
      if (e.key === "d" && e.ctrlKey) {
        const state = useDAWStore.getState();
        if (state.selectedClipId) {
          e.preventDefault();
          state.duplicateClip(state.selectedClipId);
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

  // Workspace wheel handler for zoom (covers both TCP and Timeline)
  // Use capture phase to intercept before children handle the event
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const MIN_PIXELS_PER_SECOND = 10;
    const MAX_PIXELS_PER_SECOND = 200;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Horizontal Zoom (Time Scale)
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(
          MIN_PIXELS_PER_SECOND,
          Math.min(MAX_PIXELS_PER_SECOND, pixelsPerSecond * delta)
        );
        setZoom(newZoom);
      } else if (e.altKey) {
        // Vertical Zoom (Track Height)
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newHeight = Math.max(80, Math.min(500, trackHeight * delta));
        setTrackHeight(newHeight);
      }
      // Normal scroll: let native scroll handle it
    };

    // Use capture: true to intercept before children handle the event
    workspace.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => workspace.removeEventListener("wheel", handleWheel, { capture: true });
  }, [pixelsPerSecond, trackHeight, setZoom, setTrackHeight]);

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

  const handleDragEnd = (event: any) => {
    const { active, over } = event;

    if (active && over && active.id !== over.id) {
      reorderTrack(active.id, over.id);
    }
  };

  return (
    <div className="app-container">
      {/* Menu Bar */}
      <MenuBar />
      {/* Main Toolbar with Mixer Toggle */}
      <MainToolbar
        onOpenSettings={openSettings}
        onToggleMixer={toggleMixer}
        showMixer={showMixer}
      />

      {/* Main Workspace */}
      <div ref={workspaceRef} className="workspace">
        {/* Track Control Panel (Left Sidebar) */}
        <div className="track-control-panel">
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

          <div className="tcp-tracks z-20">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={tracks.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {tracks.map((track) => (
                  <SortableTrackHeader key={track.id} track={track} />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        </div>

        {/* Timeline (Canvas-based) */}
        <Timeline tracks={tracks} />
      </div>

      {/* Transport Bar (above Mixer like Reaper) */}
      <BottomTransportBar />

      {/* Virtual MIDI Keyboard */}
      {showVirtualKeyboard && <VirtualPianoKeyboard />}

      {/* Piano Roll Editor Modal */}
      {showPianoRoll && pianoRollTrackId && pianoRollClipId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
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
                ✕
              </Button>
            </div>
            {/* Piano Roll Content */}
            <div className="flex-1 overflow-hidden">
              <PianoRoll trackId={pianoRollTrackId} clipId={pianoRollClipId} />
            </div>
          </div>
        </div>
      )}

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
    </div>
  );
}

export default App;

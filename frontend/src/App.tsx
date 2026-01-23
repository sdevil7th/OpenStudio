import { useEffect, useRef } from "react";
import { nativeBridge } from "./services/NativeBridge";
import { useDAWStore } from "./store/useDAWStore";
import { Timeline } from "./components/Timeline";
import { MixerPanel } from "./components/MixerPanel";
import { MainToolbar } from "./components/MainToolbar";
import { TransportBar as BottomTransportBar } from "./components/TransportBar";
import { SettingsModal } from "./components/SettingsModal";
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
  const {
    tracks,
    addTrack,
    showMixer,
    toggleMixer,
    showSettings,
    openSettings,
    closeSettings,
    setTrackMeterLevel,
    setMasterLevel,
    reorderTrack,
    setCurrentTime,
    scrollX,
    setScroll,
  } = useDAWStore();

  // Subscribe to scrollY for bidirectional sync
  const scrollY = useDAWStore((state) => state.scrollY);

  // Ref for track header scroll sync
  const tcpTracksRef = useRef<HTMLDivElement>(null);

  // Sync track headers scroll when scrollY changes from Timeline
  useEffect(() => {
    if (tcpTracksRef.current) {
      // Avoid feedback loop by checking if already at correct position
      if (Math.abs(tcpTracksRef.current.scrollTop - scrollY) > 1) {
        tcpTracksRef.current.scrollTop = scrollY;
      }
    }
  }, [scrollY]);

  // Handler to sync vertical scroll
  const handleTcpScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const scrollTop = e.currentTarget.scrollTop;
    setScroll(scrollX, scrollTop);
  };

  // Subscribe only to isPlaying to avoid re-rendering App on every time update
  const isPlaying = useDAWStore((state) => state.transport.isPlaying);

  // Playback Loop
  useEffect(() => {
    if (!isPlaying) return;

    let lastTime = performance.now();
    let frameId: number;

    const loop = () => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      // Optimistic update of current time
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

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={closeSettings} />

      {/* Main Workspace */}
      <div className="workspace">
        {/* Track Control Panel (Left Sidebar) */}
        <div className="track-control-panel">
          <div className="tcp-header">
            <button className="add-track-btn" onClick={handleAddTrack}>
              + Add Track
            </button>
          </div>

          <div
            ref={tcpTracksRef}
            className="tcp-tracks z-20"
            onScroll={handleTcpScroll}
          >
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

      {/* Mixer Panel */}
      <MixerPanel isVisible={showMixer} onClose={toggleMixer} />
    </div>
  );
}

export default App;

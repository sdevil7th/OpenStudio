import React, { useCallback } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { nativeBridge } from "../services/NativeBridge";
import { Play, Square, Trash2, Plus, StopCircle } from "lucide-react";
import { Button } from "./ui";

export const ClipLauncherView = React.memo(function ClipLauncherView() {
  const {
    tracks,
    clipLauncher,
    triggerSlot,
    stopSlot,
    triggerScene,
    stopAllSlots,
    setSlotClip,
    clearSlot,
    setClipLauncherQuantize,
    toggleClipLauncher,
  } = useDAWStore(
    useShallow((s) => ({
      tracks: s.tracks,
      clipLauncher: s.clipLauncher,
      triggerSlot: s.triggerSlot,
      stopSlot: s.stopSlot,
      triggerScene: s.triggerScene,
      stopAllSlots: s.stopAllSlots,
      setSlotClip: s.setSlotClip,
      clearSlot: s.clearSlot,
      setClipLauncherQuantize: s.setClipLauncherQuantize,
      toggleClipLauncher: s.toggleClipLauncher,
    }))
  );

  const numTracks = Math.max(clipLauncher.numTracks, tracks.length);
  const numSlots = Math.max(clipLauncher.numSlots, 8);

  const handleAddClip = useCallback(
    async (trackIndex: number, slotIndex: number) => {
      const filePath = await nativeBridge.browseForFile(
        "Select Audio File",
        "*.wav;*.mp3;*.flac;*.aiff;*.ogg"
      );
      if (filePath) {
        const info = await nativeBridge.importMediaFile(filePath);
        const duration = info?.duration || 4;
        const name = filePath.split(/[/\\]/).pop() || "Clip";
        setSlotClip(trackIndex, slotIndex, filePath, name, duration);
      }
    },
    [setSlotClip]
  );

  return (
    <div className="flex flex-col h-full bg-daw-dark border-t border-neutral-700">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-daw-panel border-b border-neutral-700">
        <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
          Session / Clip Launcher
        </span>
        <div className="flex items-center gap-2">
          <select
            className="text-xs bg-neutral-800 text-neutral-300 border border-neutral-600 rounded px-1.5 py-0.5"
            value={clipLauncher.quantize}
            onChange={(e) => setClipLauncherQuantize(e.target.value)}
            aria-label="Launch quantize"
          >
            <option value="none">Free</option>
            <option value="1/4">1/4 Bar</option>
            <option value="1/2">1/2 Bar</option>
            <option value="1bar">1 Bar</option>
            <option value="2bar">2 Bar</option>
            <option value="4bar">4 Bar</option>
          </select>
          <Button
            size="xs"
            variant="danger"
            onClick={stopAllSlots}
            title="Stop all clips"
            aria-label="Stop all clips"
          >
            <StopCircle size={12} />
          </Button>
          <button
            className="text-neutral-400 hover:text-white text-xs px-1"
            onClick={toggleClipLauncher}
            aria-label="Close clip launcher"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <div className="min-w-fit">
          {/* Track headers row */}
          <div className="flex border-b border-neutral-700 sticky top-0 bg-daw-panel z-10">
            <div className="w-16 shrink-0 px-2 py-1 text-[10px] text-neutral-500 border-r border-neutral-700">
              Scene
            </div>
            {Array.from({ length: numTracks }, (_, ti) => {
              const track = tracks[ti];
              return (
                <div
                  key={ti}
                  className="w-28 shrink-0 px-2 py-1 text-[10px] text-neutral-400 truncate border-r border-neutral-700"
                  style={{ color: track?.color }}
                >
                  {track?.name || `Track ${ti + 1}`}
                </div>
              );
            })}
          </div>

          {/* Slot rows */}
          {Array.from({ length: numSlots }, (_, si) => (
            <div key={si} className="flex border-b border-neutral-800">
              {/* Scene launch button */}
              <div className="w-16 shrink-0 flex items-center justify-center border-r border-neutral-700">
                <button
                  className="text-[10px] text-neutral-500 hover:text-green-400 hover:bg-neutral-800 rounded px-1.5 py-0.5 transition-colors"
                  onClick={() => triggerScene(si)}
                  title={`Launch Scene ${si + 1}`}
                  aria-label={`Launch scene ${si + 1}`}
                >
                  &#9654; {si + 1}
                </button>
              </div>

              {/* Slot cells */}
              {Array.from({ length: numTracks }, (_, ti) => {
                const slot = clipLauncher.slots[ti]?.[si] || {};
                const hasClip = !!slot.filePath;
                const isPlaying = slot.isPlaying;
                const isQueued = slot.isQueued;

                return (
                  <div
                    key={ti}
                    className={`w-28 shrink-0 h-14 border-r border-neutral-700 flex flex-col items-center justify-center gap-0.5 group relative ${
                      isPlaying
                        ? "bg-green-900/30"
                        : isQueued
                          ? "bg-yellow-900/20"
                          : hasClip
                            ? "bg-neutral-800/50"
                            : "bg-transparent"
                    }`}
                  >
                    {hasClip ? (
                      <>
                        <span
                          className="text-[10px] text-neutral-300 truncate max-w-[100px] px-1"
                          title={slot.name}
                        >
                          {slot.name || "Clip"}
                        </span>
                        <div className="flex items-center gap-1">
                          {isPlaying ? (
                            <button
                              className="text-green-400 hover:text-red-400 transition-colors"
                              onClick={() => stopSlot(ti, si)}
                              title="Stop"
                              aria-label={`Stop slot ${ti + 1}-${si + 1}`}
                            >
                              <Square size={12} />
                            </button>
                          ) : (
                            <button
                              className="text-neutral-400 hover:text-green-400 transition-colors"
                              onClick={() => triggerSlot(ti, si)}
                              title="Play"
                              aria-label={`Play slot ${ti + 1}-${si + 1}`}
                            >
                              <Play size={12} />
                            </button>
                          )}
                          <button
                            className="text-neutral-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                            onClick={() => clearSlot(ti, si)}
                            title="Remove clip"
                            aria-label={`Clear slot ${ti + 1}-${si + 1}`}
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                        {isPlaying && (
                          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-green-400 animate-pulse" />
                        )}
                      </>
                    ) : (
                      <button
                        className="text-neutral-600 hover:text-neutral-400 opacity-0 group-hover:opacity-100 transition-all"
                        onClick={() => handleAddClip(ti, si)}
                        title="Add clip"
                        aria-label={`Add clip to slot ${ti + 1}-${si + 1}`}
                      >
                        <Plus size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

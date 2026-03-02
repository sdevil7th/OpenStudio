import { X, Lock, Unlock } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, Input, Slider } from "./ui";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(3);
  return `${m}:${s.padStart(6, "0")}`;
}

/**
 * ClipPropertiesPanel - Shows and edits properties of the selected clip
 * Opens with F2 or from View menu
 */
export function ClipPropertiesPanel() {
  const {
    selectedClipId, tracks, setClipVolume, setClipFades,
    toggleClipMute, toggleClipLock, toggleClipProperties,
  } = useDAWStore(useShallow((s) => ({
    selectedClipId: s.selectedClipId,
    tracks: s.tracks,
    setClipVolume: s.setClipVolume,
    setClipFades: s.setClipFades,
    toggleClipMute: s.toggleClipMute,
    toggleClipLock: s.toggleClipLock,
    toggleClipProperties: s.toggleClipProperties,
  })));

  // Find the selected clip
  let clip = null;
  let trackName = "";
  for (const track of tracks) {
    const found = track.clips.find((c) => c.id === selectedClipId);
    if (found) {
      clip = found;
      trackName = track.name;
      break;
    }
  }

  return (
    <div className="flex flex-col w-72 bg-daw-panel border border-daw-border rounded shadow-lg text-sm text-daw-text">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-daw-border">
        <h3 className="text-xs font-semibold uppercase text-daw-text-muted">
          Clip Properties
        </h3>
        <Button variant="ghost" size="icon-sm" onClick={toggleClipProperties}>
          <X size={14} />
        </Button>
      </div>

      {!clip ? (
        <div className="px-3 py-4 text-daw-text-muted text-xs text-center">
          No clip selected. Click a clip to view its properties.
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-3 py-2 overflow-y-auto">
          {/* Name */}
          <div>
            <label className="text-xs text-daw-text-muted">Name</label>
            <Input
              value={clip.name}
              onChange={(e) => {
                const newName = e.target.value;
                useDAWStore.setState((s) => ({
                  tracks: s.tracks.map((t) => ({
                    ...t,
                    clips: t.clips.map((c) =>
                      c.id === clip!.id ? { ...c, name: newName } : c,
                    ),
                  })),
                  isModified: true,
                }));
              }}
              className="mt-0.5"
            />
          </div>

          {/* File Path */}
          <div>
            <label className="text-xs text-daw-text-muted">File</label>
            <div className="text-xs mt-0.5 truncate opacity-70" title={clip.filePath}>
              {clip.filePath.split(/[/\\]/).pop()}
            </div>
          </div>

          {/* Track */}
          <div>
            <label className="text-xs text-daw-text-muted">Track</label>
            <div className="text-xs mt-0.5">{trackName}</div>
          </div>

          {/* Position */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-daw-text-muted">Start</label>
              <div className="text-xs mt-0.5 font-mono">{formatTime(clip.startTime)}</div>
            </div>
            <div>
              <label className="text-xs text-daw-text-muted">Duration</label>
              <div className="text-xs mt-0.5 font-mono">{formatTime(clip.duration)}</div>
            </div>
          </div>

          {/* Offset */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-daw-text-muted">Offset</label>
              <div className="text-xs mt-0.5 font-mono">{formatTime(clip.offset)}</div>
            </div>
            <div>
              <label className="text-xs text-daw-text-muted">Sample Rate</label>
              <div className="text-xs mt-0.5 font-mono">{clip.sampleRate || 44100} Hz</div>
            </div>
          </div>

          {/* Volume */}
          <div>
            <label className="text-xs text-daw-text-muted">
              Volume: {clip.volumeDB.toFixed(1)} dB
            </label>
            <Slider
              min={-60}
              max={12}
              step={0.1}
              value={clip.volumeDB}
              onChange={(v) => setClipVolume(clip!.id, v)}
              className="mt-1"
            />
          </div>

          {/* Fades */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-daw-text-muted">
                Fade In: {clip.fadeIn.toFixed(3)}s
              </label>
              <Slider
                min={0}
                max={Math.min(clip.duration / 2, 5)}
                step={0.001}
                value={clip.fadeIn}
                onChange={(v) => setClipFades(clip!.id, v, clip!.fadeOut)}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs text-daw-text-muted">
                Fade Out: {clip.fadeOut.toFixed(3)}s
              </label>
              <Slider
                min={0}
                max={Math.min(clip.duration / 2, 5)}
                step={0.001}
                value={clip.fadeOut}
                onChange={(v) => setClipFades(clip!.id, clip!.fadeIn, v)}
                className="mt-1"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 pt-1 border-t border-daw-border mt-1">
            <Button
              variant={clip.muted ? "danger" : "default"}
              size="sm"
              onClick={() => toggleClipMute(clip!.id)}
            >
              {clip.muted ? "Unmute" : "Mute"}
            </Button>
            <Button
              variant={clip.locked ? "primary" : "default"}
              size="sm"
              onClick={() => toggleClipLock(clip!.id)}
            >
              {clip.locked ? <Unlock size={12} /> : <Lock size={12} />}
              <span className="ml-1">{clip.locked ? "Unlock" : "Lock"}</span>
            </Button>
          </div>

          {/* Group ID */}
          {clip.groupId && (
            <div>
              <label className="text-xs text-daw-text-muted">Group</label>
              <div className="text-xs mt-0.5 font-mono opacity-60">
                {clip.groupId.slice(0, 8)}...
              </div>
            </div>
          )}

          {/* Source Properties Section */}
          {clip.filePath && (
            <div className="pt-1 border-t border-daw-border mt-1">
              <label className="text-xs text-daw-text-muted font-semibold uppercase">Source</label>
              <div className="mt-1 space-y-1">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-daw-text-muted">Format</label>
                    <div className="text-xs font-mono">{clip.filePath.split(".").pop()?.toUpperCase() || "—"}</div>
                  </div>
                  <div>
                    <label className="text-[10px] text-daw-text-muted">Sample Rate</label>
                    <div className="text-xs font-mono">{clip.sampleRate || 44100} Hz</div>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-daw-text-muted">Full Path</label>
                  <div className="text-[10px] mt-0.5 break-all opacity-60 max-h-12 overflow-y-auto">{clip.filePath}</div>
                </div>
              </div>
            </div>
          )}

          {/* Empty clip indicator */}
          {!clip.filePath && (
            <div className="pt-1 border-t border-daw-border mt-1">
              <div className="text-xs text-daw-text-muted italic text-center">Empty / Silent Clip</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

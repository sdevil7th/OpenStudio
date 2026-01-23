import classNames from "classnames";
import { useDAWStore } from "../store/useDAWStore";

interface MainToolbarProps {
  onOpenSettings: () => void;
  onToggleMixer?: () => void;
  showMixer?: boolean;
}

export function MainToolbar({
  onOpenSettings,
  onToggleMixer,
  showMixer,
}: MainToolbarProps) {
  const { transport, play, stop, toggleLoop, tracks } = useDAWStore();
  const { isPlaying, loopEnabled } = transport;
  const hasArmedTracks = tracks.some((t) => t.armed);

  const buttonClass =
    "w-8 h-8 flex items-center justify-center rounded transition-colors text-lg bg-neutral-800 text-neutral-400 border border-neutral-700 hover:text-white hover:border-neutral-500 disabled:opacity-50 disabled:cursor-not-allowed";
  const activeClass =
    "bg-neutral-700 text-white border-neutral-500 shadow-[0_0_5px_rgba(255,255,255,0.1)]";

  return (
    <div className="h-12 bg-neutral-900 border-b border-b-neutral-950 flex items-center px-4 gap-4 shrink-0">
      {/* Transport Section - Now Connected! */}
      <div className="flex items-center gap-1">
        <button
          className={classNames(buttonClass, { [activeClass]: hasArmedTracks })}
          title={
            hasArmedTracks ? "Tracks armed for recording" : "No tracks armed"
          }
        >
          <span className="icon">🎙️</span>
        </button>
        <button
          className={classNames(buttonClass, {
            "bg-purple-700 text-white border-purple-600 hover:bg-purple-600":
              loopEnabled,
          })}
          onClick={toggleLoop}
          title="Toggle Loop"
        >
          <span className="icon">🔁</span>
        </button>
        <button
          className={classNames(buttonClass, {
            "bg-red-700 text-white border-red-600 hover:bg-red-600 animation-pulse":
              hasArmedTracks && isPlaying,
          })}
          onClick={play}
          title={hasArmedTracks ? "Record" : "Arm tracks to record"}
        >
          <span className="icon">●</span>
        </button>
        <button
          className={classNames(buttonClass, {
            "bg-green-700 text-white border-green-600 hover:bg-green-600":
              isPlaying,
          })}
          onClick={play}
          title="Play"
        >
          <span className="icon">▶</span>
        </button>
        <button className={buttonClass} onClick={stop} title="Stop">
          <span className="icon">■</span>
        </button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* Edit Tools */}
      <div className="flex items-center gap-1">
        <button className={buttonClass} disabled title="Undo (TODO)">
          <span className="icon">↶</span>
        </button>
        <button className={buttonClass} disabled title="Redo (TODO)">
          <span className="icon">↷</span>
        </button>
        <button className={buttonClass} disabled title="Grid/Snap (TODO)">
          <span className="icon">▦</span>
        </button>
      </div>

      <div className="w-px h-6 bg-neutral-700"></div>

      {/* View Toggles - Mixer Now Works! */}
      <div className="flex items-center gap-1">
        <button
          className={classNames(buttonClass, {
            "bg-blue-700 text-white border-blue-600 hover:bg-blue-600":
              showMixer,
          })}
          onClick={onToggleMixer}
          title="Toggle Mixer"
        >
          <span className="icon">🎚️</span>
        </button>
        <button className={buttonClass} disabled title="FX Browser (TODO)">
          <span className="icon">🎛️</span>
        </button>
      </div>

      <div style={{ flex: 1 }}></div>

      {/* Settings */}
      <div className="flex items-center gap-1">
        <button
          className={buttonClass}
          onClick={onOpenSettings}
          title="Audio Settings"
        >
          <span className="icon">⚙️</span>
        </button>
      </div>
    </div>
  );
}

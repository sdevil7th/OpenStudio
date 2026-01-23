import { useState, useEffect } from "react";
import classNames from "classnames";
import { useDAWStore, Track } from "../store/useDAWStore";
import { FXChainPanel } from "./FXChainPanel";
import { MIDIDeviceSelector } from "./MIDIDeviceSelector";
import { ColorPicker } from "./ColorPicker";

interface TrackHeaderProps {
  track: Track;
}

export function TrackHeader({ track }: TrackHeaderProps) {
  const {
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackArmed,
    setTrackInput,
    updateTrack,
    audioDeviceSetup,
    refreshAudioDeviceSetup,
    trackHeight,
  } = useDAWStore();

  const [showFXChain, setShowFXChain] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [inputType, setInputType] = useState<"stereo" | "mono">(
    track.inputChannelCount === 1 ? "mono" : "stereo",
  );
  const [availableInputs, setAvailableInputs] = useState<
    Array<{ value: string; label: string }>
  >([]);

  // Generate input list from store's audioDeviceSetup
  useEffect(() => {
    const numInputChannels = audioDeviceSetup?.numInputChannels || 8;
    const channelNames = audioDeviceSetup?.inputChannelNames || [];
    const inputs = [];

    if (inputType === "stereo") {
      for (let i = 0; i < numInputChannels; i += 2) {
        if (i + 1 < numInputChannels) {
          const label =
            channelNames.length > 0
              ? `${channelNames[i] || "In " + (i + 1)} / ${channelNames[i + 1] || "In " + (i + 2)}`
              : `In ${i + 1}-${i + 2}`;
          inputs.push({ value: `${i}-2`, label });
        }
      }
    } else {
      for (let i = 0; i < numInputChannels; i++) {
        const label = channelNames[i] || `In ${i + 1}`;
        inputs.push({ value: `${i}-1`, label });
      }
    }
    setAvailableInputs(inputs);
  }, [audioDeviceSetup, inputType]);

  useEffect(() => {
    if (!audioDeviceSetup) {
      refreshAudioDeviceSetup();
    }
  }, [audioDeviceSetup, refreshAudioDeviceSetup]);

  const handleRecordArm = () => toggleTrackArmed(track.id);
  const handleMute = () => toggleTrackMute(track.id);
  const handleSolo = () => toggleTrackSolo(track.id);
  const handleOpenFX = () => {
    setShowFXChain(true);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const [startChannel, numChannels] = value.split("-").map(Number);
    setTrackInput(track.id, startChannel, numChannels);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateTrack(track.id, { name: e.target.value });
  };

  const currentInputValue = `${track.inputStartChannel}-${track.inputChannelCount}`;

  // Meter gradient based on level
  const getMeterColor = () => {
    if (track.meterLevel > 0.9) return "#f44336"; // Keeping hex for dynamic gradient or could allow standard colors if possible
    if (track.meterLevel > 0.7) return "#ffc107";
    return "#4caf50";
  };

  return (
    <>
      <div
        className="flex bg-neutral-800 border-b border-neutral-900 relative overflow-hidden box-border"
        style={{ height: trackHeight }}
      >
        {/* Track Color Bar - Clickable to change color */}
        <div
          onClick={() => setShowColorPicker(true)}
          className="w-2 shrink-0 cursor-pointer hover:w-3 transition-all relative group/color"
          style={{ background: track.color || "#666" }}
          title="Click to change track color"
        >
          {/* Hover indicator */}
          <div className="absolute inset-0 bg-white/20 opacity-0 group-hover/color:opacity-100 transition-opacity" />
        </div>
        {/* Color Picker Popup */}
        {showColorPicker && (
          <ColorPicker
            currentColor={track.color}
            onColorChange={(color) => {
              updateTrack(track.id, { color });
              setShowColorPicker(false);
            }}
            onClose={() => setShowColorPicker(false)}
          />
        )}

        {/* Main Content */}
        <div className="flex-1 flex flex-col py-1 px-2 gap-1">
          {/* Row 1: Record Arm + Name + M/S/FX */}
          <div className="flex items-center gap-2">
            {/* Record Arm Button */}
            <button
              onClick={handleRecordArm}
              className={classNames(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-all border-2",
                {
                  "bg-red-700 border-red-600 text-white shadow-[0_0_8px_rgba(229,57,53,0.5)]":
                    track.armed,
                  "bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-500":
                    !track.armed,
                },
              )}
              title="Record Arm"
            >
              ●
            </button>

            {/* Track Name */}
            <input
              type="text"
              value={track.name}
              onChange={handleNameChange}
              className="flex-1 min-w-0 bg-neutral-700 border-none rounded px-2 py-1 text-xs text-white 
                                       focus:outline-none focus:ring-1 focus:ring-neutral-500 truncate"
              placeholder="Track Name"
            />

            {/* M S FX Buttons */}
            <div className="flex gap-0.5 shrink-0">
              <button
                onClick={handleMute}
                className={classNames(
                  "w-6 h-6 text-[11px] font-bold rounded transition-all",
                  {
                    "bg-green-700 text-white": track.muted,
                    "bg-neutral-800 text-neutral-400 border border-neutral-700 hover:text-white":
                      !track.muted,
                  },
                )}
                title="Mute"
              >
                M
              </button>
              <button
                onClick={handleSolo}
                className={classNames(
                  "w-6 h-6 text-[11px] font-bold rounded transition-all",
                  {
                    "bg-yellow-500 text-black": track.soloed,
                    "bg-neutral-800 text-neutral-400 border border-neutral-700 hover:text-white":
                      !track.soloed,
                  },
                )}
                title="Solo"
              >
                S
              </button>
              <button
                onClick={handleOpenFX}
                className="w-6 h-6 text-[10px] font-bold rounded bg-neutral-800 text-neutral-400 
                                           border border-neutral-700 hover:text-green-500 hover:border-green-500 transition-all"
                title="FX Chain"
              >
                FX
              </button>
            </div>
          </div>

          {/* Row 2: Track Type + Input Selector */}
          <div className="flex items-center gap-2">
            {/* Track Type Selector */}
            <select
              value={track.type}
              onChange={async (e) => {
                const newType = e.target.value as
                  | "audio"
                  | "midi"
                  | "instrument";
                updateTrack(track.id, { type: newType });
                // Update backend
                const { nativeBridge } =
                  await import("../services/NativeBridge");
                await nativeBridge.setTrackType(track.id, newType);
              }}
              className="bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-[10px] text-neutral-400 
                                       focus:outline-none cursor-pointer w-[70px] shrink-0"
            >
              <option value="audio">Audio</option>
              <option value="midi">MIDI</option>
              <option value="instrument">Instrument</option>
            </select>

            {/* Audio Input Controls */}
            {track.type === "audio" && (
              <>
                {/* Input Type Toggle */}
                <select
                  value={inputType}
                  onChange={(e) => {
                    const type = e.target.value as "stereo" | "mono";
                    setInputType(type);
                    updateTrack(track.id, {
                      inputType: type,
                      inputChannelCount: type === "stereo" ? 2 : 1,
                    });
                  }}
                  className="bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-[10px] text-neutral-400 
                                               focus:outline-none cursor-pointer w-[54px] shrink-0"
                >
                  <option value="stereo">Stereo</option>
                  <option value="mono">Mono</option>
                </select>

                {/* Input Channel Selector */}
                <div className="min-w-0 relative group">
                  <select
                    value={currentInputValue}
                    onChange={handleInputChange}
                    className="w-24 bg-emerald-700 border border-emerald-600 rounded px-2 py-0.5 
                                                   text-[10px] text-white focus:outline-none cursor-pointer truncate appearance-none"
                    title="Input Routing"
                  >
                    {availableInputs.map((input) => (
                      <option key={input.value} value={input.value}>
                        {input.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {/* MIDI Input Controls */}
            {(track.type === "midi" || track.type === "instrument") && (
              <div className="flex-1 text-[10px] text-neutral-400">
                MIDI Track - See MIDI settings below
              </div>
            )}

            {/* TRIM indicator */}
            <div className="text-[9px] text-neutral-400 bg-neutral-800 px-1.5 py-0.5 rounded border border-neutral-700 shrink-0">
              ▲TRIM
            </div>
          </div>

          {/* Row 3: MIDI Device Selector (conditional) */}
          {(track.type === "midi" || track.type === "instrument") && (
            <div className="mt-1">
              <MIDIDeviceSelector trackId={track.id} />
            </div>
          )}
        </div>

        {/* Right Side: Vertical Meter */}
        {/* Ensure enough space for scrollbar explicitly */}
        <div
          className={classNames(
            "bg-neutral-900 flex flex-col-reverse border-l border-neutral-800 shrink-0 mr-1 transition-all duration-300",
            track.armed ? "w-8" : "w-4", // Wider when armed for better visibility
          )}
        >
          <div
            className={classNames(
              "w-full transition-all duration-75",
              track.armed && track.meterLevel > 0.01 && "animate-pulse", // Pulse when recording with signal
            )}
            style={{
              height: `${Math.min(100, track.meterLevel * 100)}%`,
              background: `linear-gradient(to top, ${getMeterColor()}, ${getMeterColor()})`,
            }}
          />
        </div>
      </div>

      {showFXChain && (
        <FXChainPanel
          trackId={track.id}
          trackName={track.name}
          chainType="track"
          onClose={() => setShowFXChain(false)}
        />
      )}
    </>
  );
}

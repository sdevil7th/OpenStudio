import { useState, useEffect } from "react";
import classNames from "classnames";
import { useDAWStore, Track } from "../store/useDAWStore";
import { FXChainPanel } from "./FXChainPanel";
import { MIDIDeviceSelector } from "./MIDIDeviceSelector";
import { ColorPicker } from "./ColorPicker";
import { PluginBrowser } from "./PluginBrowser";
import { Button, Input, Select } from "./ui";

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
  const [showInstrumentBrowser, setShowInstrumentBrowser] = useState(false);
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
          data-color-bar
          data-no-select
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
            <Button
              variant="danger"
              size="icon-md"
              shape="circle"
              active={track.armed}
              activeStyle="glow"
              onClick={handleRecordArm}
              title="Record Arm"
              className="shrink-0"
            >
              ●
            </Button>

            {/* Track Name */}
            <Input
              type="text"
              variant="inline"
              size="sm"
              value={track.name}
              onChange={handleNameChange}
              placeholder="Track Name"
              className="flex-1 min-w-0 truncate"
            />

            {/* M S FX Buttons */}
            <div className="flex gap-0.5 shrink-0">
              <Button
                variant="success"
                size="icon-sm"
                active={track.muted}
                onClick={handleMute}
                title="Mute"
              >
                M
              </Button>
              <Button
                variant="warning"
                size="icon-sm"
                active={track.soloed}
                onClick={handleSolo}
                title="Solo"
              >
                S
              </Button>
              <Button
                variant="default"
                size="icon-sm"
                onClick={handleOpenFX}
                title="FX Chain"
                className="hover:text-green-500 hover:border-green-500"
              >
                FX
              </Button>
            </div>
          </div>

          {/* Row 2: Track Type + Input Selector */}
          <div className="flex items-center gap-2">
            {/* Track Type Selector */}
            <Select
              variant="compact"
              size="xs"
              value={track.type}
              onChange={async (val) => {
                const newType = val as "audio" | "midi" | "instrument";
                updateTrack(track.id, { type: newType });
                // Update backend
                const { nativeBridge } =
                  await import("../services/NativeBridge");
                await nativeBridge.setTrackType(track.id, newType);
              }}
              options={[
                { value: "audio", label: "Audio" },
                { value: "midi", label: "MIDI" },
                { value: "instrument", label: "Instrument" },
              ]}
              className="w-[70px] shrink-0"
            />

            {/* Audio Input Controls */}
            {track.type === "audio" && (
              <>
                {/* Input Type Toggle */}
                <Select
                  variant="compact"
                  size="xs"
                  value={inputType}
                  onChange={(val) => {
                    const type = val as "stereo" | "mono";
                    setInputType(type);
                    updateTrack(track.id, {
                      inputType: type,
                      inputChannelCount: type === "stereo" ? 2 : 1,
                    });
                  }}
                  options={[
                    { value: "stereo", label: "Stereo" },
                    { value: "mono", label: "Mono" },
                  ]}
                  className="w-[54px] shrink-0"
                />

                {/* Input Channel Selector */}
                <div className="min-w-0 relative group">
                  <Select
                    variant="accent"
                    size="xs"
                    value={currentInputValue}
                    onChange={(val) => {
                      const value = val.toString();
                      const [startChannel, numChannels] = value.split("-").map(Number);
                      setTrackInput(track.id, startChannel, numChannels);
                    }}
                    options={availableInputs}
                    className="w-24 truncate appearance-none"
                  />
                </div>
              </>
            )}

            {/* MIDI Input Controls */}
            {track.type === "midi" && (
              <div className="flex-1 text-[10px] text-neutral-400">
                MIDI Track - Double-click timeline to create clip
              </div>
            )}
            {/* Instrument Track Controls */}
            {track.type === "instrument" && (
              <div className="flex items-center gap-1 flex-1">
                <Button
                  variant="default"
                  size="icon-sm"
                  onClick={() => setShowInstrumentBrowser(true)}
                  title="Load Instrument Plugin"
                  className="hover:text-purple-400 hover:border-purple-400 text-[9px] px-1.5"
                >
                  {track.instrumentPlugin ? "🎹" : "🎹+"}
                </Button>
                <span className="text-[10px] text-neutral-400 truncate max-w-[100px]" title={track.instrumentPlugin || "No instrument"}>
                  {track.instrumentPlugin ? track.instrumentPlugin.split(/[/\\]/).pop() : "No instrument"}
                </span>
              </div>
            )}

            {/* TRIM indicator */}
            <div className="text-[9px] text-neutral-400 bg-neutral-800 px-1.5 py-0.5 rounded border border-neutral-700 shrink-0">
              ▲TRIM
            </div>
          </div>

          {/* Row 3: MIDI Device Selector (conditional) - now compact inline */}
          {(track.type === "midi" || track.type === "instrument") && (
            <MIDIDeviceSelector trackId={track.id} />
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

      {showInstrumentBrowser && (
        <PluginBrowser
          trackId={track.id}
          targetChain="instrument"
          onClose={() => {
            setShowInstrumentBrowser(false);
          }}
        />
      )}
    </>
  );
}

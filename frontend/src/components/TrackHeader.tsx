import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import classNames from "classnames";
import { useDAWStore, Track, getTrackGroupInfo, TRACK_GROUP_COLORS } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { FXChainPanel } from "./FXChainPanel";
import { MIDIDeviceSelector } from "./MIDIDeviceSelector";
import { ColorPicker } from "./ColorPicker";
import { PluginBrowser } from "./PluginBrowser";
import { PianoIcon, TRACK_ICONS, TRACK_ICON_LABELS } from "./icons";
import { Power, StickyNote } from "lucide-react";
import { Button, Input, Select, Knob, Textarea } from "./ui";

interface TrackHeaderProps {
  track: Track;
  isSelected?: boolean;
}

export const TrackHeader = React.memo(function TrackHeader({ track, isSelected }: TrackHeaderProps) {
  // Isolated meter subscription — this component re-renders at 10Hz for the
  // mini activity bar, but that's cheap and doesn't affect Timeline/App.
  const meterLevel = useDAWStore((s) => s.meterLevels[track.id] ?? 0);

  const {
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackArmed,
    toggleTrackFXBypass,
    setTrackInput,
    updateTrack,
    setTrackVolume,
    setTrackPan,
    beginTrackVolumeEdit,
    commitTrackVolumeEdit,
    beginTrackPanEdit,
    commitTrackPanEdit,
    audioDeviceSetup,
    refreshAudioDeviceSetup,
    trackHeight,
    trackGroups,
    setTrackNotes,
  } = useDAWStore(
    useShallow((s) => ({
      toggleTrackMute: s.toggleTrackMute,
      toggleTrackSolo: s.toggleTrackSolo,
      toggleTrackArmed: s.toggleTrackArmed,
      toggleTrackFXBypass: s.toggleTrackFXBypass,
      setTrackInput: s.setTrackInput,
      updateTrack: s.updateTrack,
      setTrackVolume: s.setTrackVolume,
      setTrackPan: s.setTrackPan,
      beginTrackVolumeEdit: s.beginTrackVolumeEdit,
      commitTrackVolumeEdit: s.commitTrackVolumeEdit,
      beginTrackPanEdit: s.beginTrackPanEdit,
      commitTrackPanEdit: s.commitTrackPanEdit,
      audioDeviceSetup: s.audioDeviceSetup,
      refreshAudioDeviceSetup: s.refreshAudioDeviceSetup,
      trackHeight: s.trackHeight,
      trackGroups: s.trackGroups,
      setTrackNotes: s.setTrackNotes,
    })),
  );

  const groupInfo = getTrackGroupInfo(track.id, trackGroups);
  const groupColor = groupInfo ? TRACK_GROUP_COLORS[groupInfo.colorIndex] : null;

  const colorBarRef = useRef<HTMLDivElement>(null);
  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const [showFXChain, setShowFXChain] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showInstrumentBrowser, setShowInstrumentBrowser] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(track.notes || "");
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

  const hasFx = track.inputFxCount + track.trackFxCount > 0;
  let fxButtonClass = "hover:text-green-500 hover:border-green-500";
  if (hasFx && track.fxBypassed)
    fxButtonClass =
      "text-red-400! border-red-500! shadow-[0_0_6px_rgba(239,68,68,0.4)]";
  else if (hasFx)
    fxButtonClass =
      "text-green-400! border-green-500! shadow-[0_0_6px_rgba(34,197,94,0.4)]";

  let fxBypassClass = "hover:text-green-500 hover:border-green-500";
  if (hasFx && track.fxBypassed)
    fxBypassClass = "text-red-400! border-red-500!";
  else if (hasFx) fxBypassClass = "text-green-400! border-green-500!";
  const fxBypassTitle = hasFx
    ? track.fxBypassed
      ? "Enable FX"
      : "Bypass FX"
    : "No FX loaded";

  const handleRecordArm = () => toggleTrackArmed(track.id);
  const handleMute = () => toggleTrackMute(track.id);
  const handleSolo = () => toggleTrackSolo(track.id);

  const handleVolumeChange = (volumeDB: number) => {
    setTrackVolume(track.id, volumeDB);
  };
  const handlePanChange = (pan: number) => {
    setTrackPan(track.id, pan);
  };
  const formatVolume = (db: number) =>
    db <= -60 ? "-∞ dB" : `${db.toFixed(1)} dB`;
  const formatPan = (pan: number) => {
    if (Math.abs(pan) < 0.005) return "C";
    return pan > 0
      ? `R${Math.round(Math.abs(pan * 100))}`
      : `L${Math.round(Math.abs(pan * 100))}`;
  };
  const handleOpenFX = () => {
    setShowFXChain(true);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateTrack(track.id, { name: e.target.value });
  };

  const currentInputValue = `${track.inputStartChannel}-${track.inputChannelCount}`;

  // Meter gradient based on dB-normalized level (matches PeakMeter breakpoints)
  const getMeterColor = () => {
    const dbNorm = meterLevel > 0.001 ? Math.max(0, (20 * Math.log10(meterLevel) + 60) / 72) : 0;
    if (dbNorm > 0.92) return "#ef4444"; // Red — clipping
    if (dbNorm > 0.85) return "#facc15"; // Yellow — hot
    return "#16a34a"; // Green — normal
  };

  return (
    <>
      <div
        className={`flex border-b border-neutral-900 relative overflow-hidden box-border ${isSelected ? "bg-neutral-700" : "bg-neutral-800"}`}
        style={{
          height: trackHeight,
          ...(groupColor ? { backgroundColor: isSelected ? undefined : `${groupColor}10` } : {}),
        }}
      >
        {/* Link group bracket */}
        {groupColor && (
          <div
            className="w-1 shrink-0"
            style={{ backgroundColor: groupColor }}
            title="Linked group"
          />
        )}
        {/* Track Color Bar - Clickable to change color */}
        <div
          ref={colorBarRef}
          onClick={() => setShowColorPicker(true)}
          className="w-2 shrink-0 cursor-pointer hover:brightness-125 transition-all relative group/color"
          style={{ background: track.color || "#666" }}
          title="Click to change track color"
          data-color-bar
          data-no-select
          data-no-drag
        >
          {/* Hover indicator */}
          <div className="absolute inset-0 bg-white/20 opacity-0 group-hover/color:opacity-100 transition-opacity" />
        </div>
        {/* Color Picker Popup - rendered via portal to avoid overflow clipping */}
        {showColorPicker &&
          createPortal(
            <ColorPicker
              currentColor={track.color}
              anchorRef={colorBarRef}
              onColorChange={(color) => {
                updateTrack(track.id, { color });
                setShowColorPicker(false);
              }}
              onClose={() => setShowColorPicker(false)}
            />,
            document.body,
          )}

        {/* Main Content — single flex-wrap row, wraps when TCP is narrow */}
        <div className="flex-1 flex flex-wrap items-center py-1 px-1.5 gap-x-1.5 gap-y-0.5 content-center">
          {/* Record Arm Button */}
          <Button
            variant="danger"
            size="icon-sm"
            shape="circle"
            active={track.armed}
            activeStyle="glow"
            onClick={handleRecordArm}
            title="Record Arm (R)"
            aria-label={track.armed ? "Disarm track recording" : "Arm track for recording"}
            className="shrink-0"
          >
            R
          </Button>

          {/* Track Icon */}
          <button
            ref={iconBtnRef}
            onClick={() => setShowIconPicker(!showIconPicker)}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-600 text-neutral-400 hover:text-neutral-200 transition-colors"
            title={track.icon ? TRACK_ICON_LABELS[track.icon] || "Track icon" : "Set track icon"}
            data-no-drag
            data-no-select
          >
            {track.icon && TRACK_ICONS[track.icon]
              ? (() => { const Icon = TRACK_ICONS[track.icon!]; return <Icon size={12} />; })()
              : <span className="text-[9px] leading-none">&#9835;</span>}
          </button>
          {showIconPicker && iconBtnRef.current &&
            createPortal(
              <div
                className="fixed z-50"
                style={{
                  top: iconBtnRef.current.getBoundingClientRect().bottom + 2,
                  left: iconBtnRef.current.getBoundingClientRect().left,
                }}
              >
                <div className="bg-neutral-800 border border-neutral-600 rounded shadow-lg p-1.5 grid grid-cols-3 gap-1"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {/* Clear icon option */}
                  <button
                    className={`w-7 h-7 flex items-center justify-center rounded hover:bg-neutral-600 text-neutral-400 text-[9px] ${!track.icon ? "bg-neutral-600 ring-1 ring-blue-500" : ""}`}
                    onClick={() => { updateTrack(track.id, { icon: undefined }); setShowIconPicker(false); }}
                    title="No icon"
                  >
                    --
                  </button>
                  {Object.entries(TRACK_ICONS).map(([id, Icon]) => (
                    <button
                      key={id}
                      className={`w-7 h-7 flex items-center justify-center rounded hover:bg-neutral-600 text-neutral-300 ${track.icon === id ? "bg-neutral-600 ring-1 ring-blue-500" : ""}`}
                      onClick={() => { updateTrack(track.id, { icon: id }); setShowIconPicker(false); }}
                      title={TRACK_ICON_LABELS[id]}
                    >
                      <Icon size={14} />
                    </button>
                  ))}
                </div>
                {/* Backdrop to close */}
                <div className="fixed inset-0 -z-10" onClick={() => setShowIconPicker(false)} />
              </div>,
              document.body,
            )}

          {/* Track Name */}
          <Input
            type="text"
            variant="inline"
            size="sm"
            value={track.name}
            onChange={handleNameChange}
            placeholder="Track Name"
            className="min-w-[40px] flex-1 basis-16"
            inputClassName="w-full min-w-0"
          />

          {/* Volume & Pan Knobs */}
          <span
            className="flex items-center gap-1 shrink-0"
            data-no-drag
            data-no-select
          >
            <Knob
              variant="volume"
              size="sm"
              min={-60}
              max={12}
              value={track.volumeDB}
              defaultValue={0}
              onChange={handleVolumeChange}
              onBeginEdit={() => beginTrackVolumeEdit(track.id)}
              onCommitEdit={() => commitTrackVolumeEdit(track.id)}
              formatValue={formatVolume}
              label="Volume"
            />
            <Knob
              variant="pan"
              size="sm"
              min={-1}
              max={1}
              value={track.pan}
              defaultValue={0}
              onChange={handlePanChange}
              onBeginEdit={() => beginTrackPanEdit(track.id)}
              onCommitEdit={() => commitTrackPanEdit(track.id)}
              formatValue={formatPan}
              label="Pan"
              bipolarCenter={0}
            />
          </span>

          {/* M S FX A Buttons */}
          <span className="flex gap-px">
            <Button
              variant="success"
              size="icon-sm"
              shape="square"
              active={track.muted}
              onClick={handleMute}
              title="Mute (M)"
              aria-label={track.muted ? "Unmute track" : "Mute track"}
              className="rounded-l"
            >
              M
            </Button>
            <Button
              variant="warning"
              size="icon-sm"
              shape="square"
              active={track.soloed}
              onClick={handleSolo}
              title="Solo (S)"
              aria-label={track.soloed ? "Unsolo track" : "Solo track"}
            >
              S
            </Button>
          </span>
          <span className="flex">
            <Button
              variant="default"
              size="icon-sm"
              shape="square"
              onClick={handleOpenFX}
              title="FX Chain"
              className={fxButtonClass}
            >
              FX
            </Button>
            <Button
              variant="default"
              size="icon-xs"
              shape="square"
              onClick={() => {
                if (!hasFx) {
                  setShowFXChain(true);
                } else {
                  toggleTrackFXBypass(track.id);
                }
              }}
              title={fxBypassTitle}
              className={fxBypassClass}
            >
              <Power size={10} strokeWidth={2.5} />
            </Button>
          </span>
          <Button
            variant="default"
            size="icon-sm"
            shape="square"
            active={track.showAutomation}
            onClick={() =>
              useDAWStore.getState().toggleTrackAutomation(track.id)
            }
            title="Toggle Automation"
            className={`${track.showAutomation ? "text-green-400!" : ""} rounded-r`}
          >
            A
          </Button>
          {track.frozen && (
            <span
              className="text-[10px] text-blue-400 px-0.5"
              title="Track is frozen"
            >
              ❄
            </span>
          )}

          {/* Track Notes Button */}
          <button
            ref={notesBtnRef}
            onClick={() => {
              setNotesValue(track.notes || "");
              setShowNotes(!showNotes);
            }}
            className={`shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-600 transition-colors ${track.notes ? "text-yellow-400" : "text-neutral-500 hover:text-neutral-300"}`}
            title={track.notes ? `Notes: ${track.notes.slice(0, 50)}${track.notes.length > 50 ? "..." : ""}` : "Add track notes"}
            data-no-drag
            data-no-select
          >
            <StickyNote size={11} />
          </button>
          {showNotes && notesBtnRef.current &&
            createPortal(
              <div
                className="fixed z-50"
                style={{
                  top: notesBtnRef.current.getBoundingClientRect().bottom + 4,
                  left: notesBtnRef.current.getBoundingClientRect().left,
                }}
              >
                <div
                  className="bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-2 w-56"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="text-[10px] text-neutral-400 mb-1 font-medium">Track Notes</div>
                  <Textarea
                    size="sm"
                    value={notesValue}
                    onChange={(e) => setNotesValue(e.target.value)}
                    onBlur={() => {
                      if (notesValue !== (track.notes || "")) {
                        setTrackNotes(track.id, notesValue);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setShowNotes(false);
                      }
                    }}
                    placeholder="Add notes about this track..."
                    rows={3}
                    className="w-full"
                    autoFocus
                  />
                </div>
                {/* Backdrop to close */}
                <div className="fixed inset-0 -z-10" onClick={() => {
                  if (notesValue !== (track.notes || "")) {
                    setTrackNotes(track.id, notesValue);
                  }
                  setShowNotes(false);
                }} />
              </div>,
              document.body,
            )}

          {/* Track Type Selector */}
          <Select
            variant="compact"
            size="xs"
            value={track.type}
            onChange={async (val) => {
              const newType = val as "audio" | "midi" | "instrument";
              updateTrack(track.id, { type: newType });
              const { nativeBridge } = await import("../services/NativeBridge");
              await nativeBridge.setTrackType(track.id, newType);
            }}
            options={[
              { value: "audio", label: "Audio" },
              { value: "midi", label: "MIDI" },
              { value: "instrument", label: "Instrument" },
            ]}
            title={
              track.type === "audio"
                ? "Audio"
                : track.type === "midi"
                  ? "MIDI"
                  : "Instrument"
            }
            className="w-11 shrink-0"
          />

          {/* Audio Input Controls */}
          {track.type === "audio" && (
            <>
              <Select
                variant="compact"
                size="xs"
                value={inputType}
                onChange={(val) => {
                  const type = val as "stereo" | "mono";
                  const channelCount = type === "stereo" ? 2 : 1;
                  setInputType(type);
                  updateTrack(track.id, {
                    inputType: type,
                    inputChannelCount: channelCount,
                  });
                  setTrackInput(
                    track.id,
                    track.inputStartChannel,
                    channelCount,
                  );
                }}
                options={[
                  { value: "stereo", label: "Stereo" },
                  { value: "mono", label: "Mono" },
                ]}
                title={inputType === "stereo" ? "Stereo" : "Mono"}
                className="w-11 shrink-0"
              />
              <Select
                variant="accent"
                size="xs"
                value={currentInputValue}
                onChange={(val) => {
                  const value = val.toString();
                  const [startChannel, numChannels] = value
                    .split("-")
                    .map(Number);
                  setTrackInput(track.id, startChannel, numChannels);
                }}
                options={availableInputs}
                title={
                  availableInputs.find((i) => i.value === currentInputValue)
                    ?.label ?? currentInputValue
                }
                className="w-11 shrink-0"
              />
            </>
          )}

          {/* Instrument plugin button */}
          {track.type === "instrument" && (
            <Button
              variant="default"
              size="icon-sm"
              onClick={() => setShowInstrumentBrowser(true)}
              title={track.instrumentPlugin || "Load Instrument Plugin"}
              className="hover:text-purple-400 hover:border-purple-400 text-[9px] px-1.5 shrink-0"
            >
              <PianoIcon size={12} />
              {track.instrumentPlugin ? null : "+"}
            </Button>
          )}

          {/* MIDI Device Selector (conditional) */}
          {(track.type === "midi" || track.type === "instrument") && (
            <MIDIDeviceSelector trackId={track.id} />
          )}
        </div>

        {/* Right Side: Vertical Meter */}
        {/* Ensure enough space for scrollbar explicitly */}
        <div
          className={classNames(
            "w-2 pt-1 bg-neutral-900 flex flex-col-reverse border-l border-neutral-800 shrink-0 mr-1 transition-all duration-300",
          )}
        >
          <div
            className={classNames(
              "w-full transition-all duration-75",
              track.armed && meterLevel > 0.01 && "animate-pulse", // Pulse when recording with signal
            )}
            style={{
              height: `${Math.min(100, meterLevel > 0.001 ? Math.max(0, (20 * Math.log10(meterLevel) + 60) / 72) * 100 : 0)}%`,
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
});

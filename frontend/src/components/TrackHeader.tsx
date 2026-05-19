import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import classNames from "classnames";
import {
  useDAWStore,
  Track,
  getTrackGroupInfo,
  TRACK_GROUP_COLORS,
  getEffectiveTrackHeight,
  AUTOMATION_LANE_HEIGHT,
} from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { nativeBridge } from "../services/NativeBridge";
import { FXChainPanel } from "./FXChainPanel";
import { MIDIDeviceSelector } from "./MIDIDeviceSelector";
import { ColorPicker } from "./ColorPicker";
import { PluginBrowser } from "./PluginBrowser";
import { PianoIcon, TRACK_ICONS, TRACK_ICON_LABELS } from "./icons";
import { ChevronDown, FileAudio, Power, StickyNote, X } from "lucide-react";
import { Button, Input, Select, Knob, Textarea, Slider } from "./ui";
import {
  getAutomationParamDef,
  getAutomationColor,
  getAutomationShortLabel,
  getTrackAutomationParams,
  automationToBackend,
} from "../store/automationParams";
import { subscribeToInstrumentChanged } from "../utils/fxChain";
import { guardModalContextMenu } from "../utils/modalEventGuards";

interface TrackHeaderProps {
  track: Track;
  isSelected?: boolean;
}

interface SamplerDialogState {
  samplePath: string;
  rootNote: string;
  error: string | null;
}

export const TrackHeader = React.memo(function TrackHeader({
  track,
  isSelected,
}: TrackHeaderProps) {
  // Isolated meter subscription — this component re-renders at 10Hz for the
  // mini activity bar, but that's cheap and doesn't affect Timeline/App.
  const meterLevel = useDAWStore((s) => s.meterLevels[track.id] ?? 0);
  // Automation display values — updated at ~30fps during playback
  const autoValues = useDAWStore((s) => s.automatedParamValues[track.id]);

  const {
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackArmed,
    toggleTrackFXBypass,
    toggleTrackAutomationRead,
    toggleTrackAutomationWrite,
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
    removeInstrumentWithUndo,
    setTrackSamplerSampleWithUndo,
    clearTrackSamplerSampleWithUndo,
  } = useDAWStore(
    useShallow((s) => ({
      toggleTrackMute: s.toggleTrackMute,
      toggleTrackSolo: s.toggleTrackSolo,
      toggleTrackArmed: s.toggleTrackArmed,
      toggleTrackFXBypass: s.toggleTrackFXBypass,
      toggleTrackAutomationRead: s.toggleTrackAutomationRead,
      toggleTrackAutomationWrite: s.toggleTrackAutomationWrite,
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
      removeInstrumentWithUndo: s.removeInstrumentWithUndo,
      setTrackSamplerSampleWithUndo: s.setTrackSamplerSampleWithUndo,
      clearTrackSamplerSampleWithUndo: s.clearTrackSamplerSampleWithUndo,
    })),
  );

  const groupInfo = getTrackGroupInfo(track.id, trackGroups);
  const groupColor = groupInfo
    ? TRACK_GROUP_COLORS[groupInfo.colorIndex]
    : null;

  const colorBarRef = useRef<HTMLDivElement>(null);
  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const [showFXChain, setShowFXChain] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showInstrumentBrowser, setShowInstrumentBrowser] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showAutoMenu, setShowAutoMenu] = useState(false);
  const [samplerDialog, setSamplerDialog] = useState<SamplerDialogState | null>(
    null,
  );
  const autoBtnRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    return subscribeToInstrumentChanged((detail) => {
      if (detail.trackId !== track.id) {
        return;
      }

      setShowInstrumentBrowser(false);
    });
  }, [track.id]);

  const hasBypassableFx = track.inputFxCount + track.trackFxCount > 0;
  const hasFallbackInstrument =
    track.type === "instrument" && !track.instrumentPlugin;
  const hasFx =
    hasBypassableFx || Boolean(track.instrumentPlugin) || hasFallbackInstrument;
  const fxBypassTitle = hasFx
    ? hasBypassableFx
      ? track.fxBypassed
        ? "Enable FX"
        : "Bypass FX"
      : hasFallbackInstrument
        ? "Built-in fallback synth active"
        : "Instrument loaded"
    : "No FX loaded";

  const hasAutomationLane = track.automationLanes.length > 0;
  const hasAutomation =
    (track.showAutomation && track.automationLanes.some((l) => l.visible)) ||
    track.automationLanes.some((l) => l.points.length > 0);
  const automationReadActive =
    typeof track.automationReadEnabled === "boolean"
      ? track.automationReadEnabled
      : typeof track.automationEnabled === "boolean"
        ? track.automationEnabled
        : hasAutomationLane;
  const automationWriteActive = track.automationWriteEnabled === true;
  const canToggleAutomationRead = hasAutomationLane || automationWriteActive;

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

  const handleLoadSamplerSample = async () => {
    const samplePath = await nativeBridge.showOpenDialog(
      "Load Sampler Sample",
      "*.wav;*.aiff;*.aif;*.flac;*.ogg;*.mp3;*.sf2",
    );
    if (!samplePath) return;
    setSamplerDialog({
      samplePath,
      rootNote: String(track.samplerRootNote ?? 60),
      error: null,
    });
  };

  const submitSamplerDialog = async () => {
    if (!samplerDialog) return;
    const parsedRootNote = Number(samplerDialog.rootNote);
    if (!Number.isFinite(parsedRootNote)) {
      setSamplerDialog({
        ...samplerDialog,
        error: "Enter a MIDI note from 0 to 127.",
      });
      return;
    }

    const rootNote = Math.max(0, Math.min(127, Math.round(parsedRootNote)));
    const loaded = await setTrackSamplerSampleWithUndo(
      track.id,
      samplerDialog.samplePath,
      rootNote,
    );
    if (!loaded) {
      setSamplerDialog({
        ...samplerDialog,
        error: "Could not load sampler sample.",
      });
      return;
    }
    setSamplerDialog(null);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateTrack(track.id, { name: e.target.value });
  };

  const currentInputValue = `${track.inputStartChannel}-${track.inputChannelCount}`;

  // Meter gradient based on dB-normalized level (matches PeakMeter breakpoints)
  const getMeterColor = () => {
    const dbNorm =
      meterLevel > 0.001
        ? Math.max(0, (20 * Math.log10(meterLevel) + 60) / 72)
        : 0;
    if (dbNorm > 0.92) return "#ef4444"; // Red — clipping
    if (dbNorm > 0.85) return "#facc15"; // Yellow — hot
    return "#16a34a"; // Green — normal
  };

  return (
    <>
      <div
        className={`flex flex-col border-b border-neutral-900 relative overflow-hidden box-border ${isSelected ? "bg-neutral-700" : "bg-neutral-800"}`}
        style={{
          height: getEffectiveTrackHeight(track, trackHeight),
          ...(groupColor
            ? { backgroundColor: isSelected ? undefined : `${groupColor}10` }
            : {}),
        }}
      >
        {/* Main track controls area — fixed at trackHeight */}
        <div
          className="flex shrink-0 overflow-hidden"
          style={{ height: trackHeight }}
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
          <div className="flex-1 flex flex-wrap items-center py-1 px-2 gap-x-2 gap-y-1 content-center">
            {/* Record Arm Button */}
            <Button
              variant="danger"
              size="icon-sm"
              shape="circle"
              active={track.armed}
              activeStyle="glow"
              onClick={handleRecordArm}
              title="Record Arm (R)"
              aria-label={
                track.armed
                  ? "Disarm track recording"
                  : "Arm track for recording"
              }
              className="shrink-0"
            >
              R
            </Button>

            {/* Track Icon */}
            <button
              ref={iconBtnRef}
              onClick={() => setShowIconPicker(!showIconPicker)}
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-600 text-neutral-400 hover:text-neutral-200 transition-colors"
              title={
                track.icon
                  ? TRACK_ICON_LABELS[track.icon] || "Track icon"
                  : "Set track icon"
              }
              data-no-drag
              data-no-select
            >
              {track.icon && TRACK_ICONS[track.icon] ? (
                (() => {
                  const Icon = TRACK_ICONS[track.icon!];
                  return <Icon size={12} />;
                })()
              ) : (
                <span className="text-[9px] leading-none">&#9835;</span>
              )}
            </button>
            {showIconPicker &&
              iconBtnRef.current &&
              createPortal(
                <div
                  className="fixed z-50"
                  style={{
                    top: iconBtnRef.current.getBoundingClientRect().bottom + 2,
                    left: iconBtnRef.current.getBoundingClientRect().left,
                  }}
                >
                  <div
                    className="bg-neutral-800 border border-neutral-600 rounded shadow-lg p-1.5 grid grid-cols-3 gap-1"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {/* Clear icon option */}
                    <button
                      className={`w-7 h-7 flex items-center justify-center rounded hover:bg-neutral-600 text-neutral-400 text-[9px] ${!track.icon ? "bg-neutral-600 ring-1 ring-blue-500" : ""}`}
                      onClick={() => {
                        updateTrack(track.id, { icon: undefined });
                        setShowIconPicker(false);
                      }}
                      title="No icon"
                    >
                      --
                    </button>
                    {Object.entries(TRACK_ICONS).map(([id, Icon]) => (
                      <button
                        key={id}
                        className={`w-7 h-7 flex items-center justify-center rounded hover:bg-neutral-600 text-neutral-300 ${track.icon === id ? "bg-neutral-600 ring-1 ring-blue-500" : ""}`}
                        onClick={() => {
                          updateTrack(track.id, { icon: id });
                          setShowIconPicker(false);
                        }}
                        title={TRACK_ICON_LABELS[id]}
                      >
                        <Icon size={14} />
                      </button>
                    ))}
                  </div>
                  {/* Backdrop to close */}
                  <div
                    className="fixed inset-0 -z-10"
                    onClick={() => setShowIconPicker(false)}
                  />
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
                value={
                  autoValues?.volume !== undefined
                    ? automationToBackend("volume", autoValues.volume)
                    : track.volumeDB
                }
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
                value={
                  autoValues?.pan !== undefined
                    ? automationToBackend("pan", autoValues.pan)
                    : track.pan
                }
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
                variant="default"
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
            <span
              data-tcp-pair="fx"
              className="inline-flex shrink-0 items-center"
            >
              <Button
                variant="default"
                size="icon-sm"
                shape="square"
                onClick={handleOpenFX}
                title="FX Chain"
                className={classNames(
                  "rounded-l border-r-0",
                  hasBypassableFx && track.fxBypassed
                    ? "text-red-400! border-red-500! shadow-[0_0_6px_rgba(239,68,68,0.4)]"
                    : hasFx
                      ? "text-green-400! border-green-500! shadow-[0_0_6px_rgba(34,197,94,0.4)]"
                      : "hover:text-green-500 hover:border-green-500",
                )}
              >
                FX
              </Button>
              <Button
                variant="default"
                size="icon-xs"
                shape="square"
                onClick={() => {
                  if (!hasBypassableFx) {
                    setShowFXChain(true);
                  } else {
                    toggleTrackFXBypass(track.id);
                  }
                }}
                title={fxBypassTitle}
                className={classNames(
                  "rounded-r",
                  hasBypassableFx && track.fxBypassed
                    ? "text-red-400! border-red-500!"
                    : hasFx
                      ? "text-green-400! border-green-500!"
                      : "hover:text-green-500 hover:border-green-500",
                )}
              >
                <Power size={10} strokeWidth={2.5} />
              </Button>
            </span>
            <div
              ref={autoBtnRef}
              data-tcp-pair="automation"
              className="relative inline-flex h-6 shrink-0 items-center gap-0 overflow-hidden rounded bg-neutral-800 ring-1 ring-inset ring-neutral-700 hover:ring-neutral-600"
            >
              <Button
                variant="default"
                size="icon-sm"
                shape="square"
                onClick={() => toggleTrackAutomationRead(track.id)}
                disabled={!canToggleAutomationRead}
                title={
                  canToggleAutomationRead
                    ? automationReadActive
                      ? "Disable automation read"
                      : "Enable automation read"
                    : "Add an automation lane or enable write first"
                }
                aria-label={
                  canToggleAutomationRead
                    ? automationReadActive
                      ? "Disable automation read"
                      : "Enable automation read"
                    : "Automation read unavailable"
                }
                className={classNames(
                  "h-6! w-6! rounded-none border-0!",
                  !canToggleAutomationRead
                    ? automationReadActive
                      ? "bg-teal-600/20! text-teal-100! disabled:opacity-100!"
                      : "bg-transparent! text-neutral-600!"
                    : automationReadActive
                      ? "bg-teal-600/25! text-teal-100!"
                      : "bg-transparent! hover:text-teal-300 hover:bg-teal-500/10",
                )}
              >
                <span className="leading-none">R</span>
              </Button>
              <span className="inline-flex shrink-0 items-center">
                <Button
                  variant="default"
                  size="icon-sm"
                  shape="square"
                  onClick={() => toggleTrackAutomationWrite(track.id)}
                  title={
                    automationWriteActive
                      ? "Disable automation write"
                      : "Enable automation write"
                  }
                  aria-label={
                    automationWriteActive
                      ? "Disable automation write"
                      : "Enable automation write"
                  }
                  className={classNames(
                    "h-6! w-6! rounded-none border-y-0! border-r-0! border-l!",
                    automationWriteActive
                      ? "border-l-red-500! bg-red-700/40! text-red-100!"
                      : "border-l-neutral-700! bg-transparent! hover:border-l-red-500 hover:bg-red-500/10 hover:text-red-300",
                  )}
                >
                  <span className="leading-none">W</span>
                </Button>
                <Button
                  variant="default"
                  size="icon-xs"
                  shape="square"
                  onClick={() =>
                    useDAWStore.getState().openEnvelopeManager(track.id)
                  }
                  onContextMenu={(e: React.MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowAutoMenu(!showAutoMenu);
                  }}
                  title="Automation panel"
                  aria-label="Open automation panel"
                  className={classNames(
                    "h-6! w-4! rounded-none border-y-0! border-r-0! border-l!",
                    hasAutomation
                      ? "border-l-neutral-600! bg-transparent! text-neutral-300!"
                      : "border-l-neutral-700! bg-transparent! hover:border-l-teal-500 hover:bg-teal-500/10 hover:text-teal-300",
                  )}
                >
                  <ChevronDown size={10} strokeWidth={2.5} />
                </Button>
              </span>
              {showAutoMenu &&
                autoBtnRef.current &&
                createPortal(
                  <div
                    className="fixed z-50"
                    style={{
                      left:
                        autoBtnRef.current.getBoundingClientRect().right + 2,
                      top: autoBtnRef.current.getBoundingClientRect().top,
                    }}
                  >
                    <div
                      className="bg-neutral-800 border border-neutral-600 rounded shadow-lg py-1 text-[11px] min-w-[180px]"
                      onMouseLeave={() => setShowAutoMenu(false)}
                    >
                      <button
                        className={`w-full text-left px-3 py-1 text-neutral-300 flex items-center justify-between gap-2 ${
                          canToggleAutomationRead
                            ? "hover:bg-neutral-700"
                            : "opacity-50 cursor-not-allowed"
                        }`}
                        onClick={() => {
                          if (!canToggleAutomationRead) return;
                          toggleTrackAutomationRead(track.id);
                          setShowAutoMenu(false);
                        }}
                        disabled={!canToggleAutomationRead}
                      >
                        <span>
                          {automationReadActive
                            ? "Disable Read"
                            : "Enable Read"}
                        </span>
                        <span
                          className={
                            automationReadActive
                              ? "text-teal-300"
                              : "text-neutral-500"
                          }
                        >
                          R
                        </span>
                      </button>
                      <button
                        className="w-full text-left px-3 py-1 hover:bg-neutral-700 text-neutral-300 flex items-center justify-between gap-2"
                        onClick={() => {
                          toggleTrackAutomationWrite(track.id);
                          setShowAutoMenu(false);
                        }}
                      >
                        <span>
                          {automationWriteActive
                            ? "Disable Write"
                            : "Enable Write"}
                        </span>
                        <span
                          className={
                            automationWriteActive
                              ? "text-red-300"
                              : "text-neutral-500"
                          }
                        >
                          W
                        </span>
                      </button>
                      <button
                        className="w-full text-left px-3 py-1 hover:bg-neutral-700 text-neutral-300"
                        onClick={() => {
                          useDAWStore.getState().openEnvelopeManager(track.id);
                          setShowAutoMenu(false);
                        }}
                      >
                        Automation Panel
                      </button>
                      <div className="border-t border-neutral-700 my-1" />
                      {/* Show/hide individual params */}
                      {getTrackAutomationParams(track.type).map(
                        ({ id, label }) => {
                          const lane = track.automationLanes.find(
                            (l) => l.param === id,
                          );
                          return (
                            <button
                              key={id}
                              className="w-full text-left px-3 py-1 hover:bg-neutral-700 text-neutral-300 flex items-center gap-2"
                              onClick={() => {
                                const s = useDAWStore.getState();
                                if (lane) {
                                  s.toggleAutomationLaneVisibility(
                                    track.id,
                                    lane.id,
                                  );
                                } else {
                                  s.addAutomationLane(track.id, id);
                                }
                                if (!track.showAutomation)
                                  s.toggleTrackAutomation(track.id);
                                setShowAutoMenu(false);
                              }}
                            >
                              <span
                                className={`w-2 h-2 rounded-full ${lane?.visible ? "bg-green-400" : "bg-neutral-600"}`}
                              />
                              {label} Envelope
                            </button>
                          );
                        },
                      )}
                      <div className="border-t border-neutral-700 my-1" />
                      {/* Bulk operations */}
                      <button
                        className="w-full text-left px-3 py-1 hover:bg-neutral-700 text-neutral-300"
                        onClick={() => {
                          useDAWStore
                            .getState()
                            .showAllActiveEnvelopes(track.id);
                          setShowAutoMenu(false);
                        }}
                      >
                        Show All Active Envelopes
                      </button>
                      <button
                        className="w-full text-left px-3 py-1 hover:bg-neutral-700 text-neutral-300"
                        onClick={() => {
                          useDAWStore.getState().hideAllEnvelopes(track.id);
                          setShowAutoMenu(false);
                        }}
                      >
                        Hide All Envelopes
                      </button>
                    </div>
                  </div>,
                  document.body,
                )}
            </div>
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
              title={
                track.notes
                  ? `Notes: ${track.notes.slice(0, 50)}${track.notes.length > 50 ? "..." : ""}`
                  : "Add track notes"
              }
              data-no-drag
              data-no-select
            >
              <StickyNote size={11} />
            </button>
            {showNotes &&
              notesBtnRef.current &&
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
                    <div className="text-[10px] text-neutral-400 mb-1 font-medium">
                      Track Notes
                    </div>
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
                  <div
                    className="fixed inset-0 -z-10"
                    onClick={() => {
                      if (notesValue !== (track.notes || "")) {
                        setTrackNotes(track.id, notesValue);
                      }
                      setShowNotes(false);
                    }}
                  />
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
                const { nativeBridge } =
                  await import("../services/NativeBridge");
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
              className="w-[86px] shrink-0"
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
                  className="w-[64px] shrink-0"
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
                  className="w-[112px] shrink-0"
                />
              </>
            )}

            {/* Instrument plugin button */}
            {track.type === "instrument" && (
              <div className="flex items-center shrink-0">
                <Button
                  variant="default"
                  size="icon-sm"
                  onClick={() => setShowInstrumentBrowser(true)}
                  title={
                    track.instrumentPlugin ||
                    "Built-in fallback synth active. Load an instrument plugin."
                  }
                  className={classNames(
                    "hover:text-purple-400 hover:border-purple-400 text-[9px] px-1.5 shrink-0",
                    hasFallbackInstrument &&
                      "text-purple-300! border-purple-500/60!",
                  )}
                >
                  <PianoIcon size={12} />
                  {track.instrumentPlugin ? null : "+"}
                </Button>
                {track.instrumentPlugin && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      void removeInstrumentWithUndo(track.id);
                    }}
                    title="Remove Instrument"
                    className="hover:text-red-400 px-1 shrink-0"
                  >
                    <X size={11} />
                  </Button>
                )}
                <Button
                  variant="default"
                  size="icon-sm"
                  onClick={handleLoadSamplerSample}
                  title={
                    track.samplerSamplePath
                      ? `Sampler: ${track.samplerSamplePath}`
                      : "Load built-in sampler sample"
                  }
                  aria-label="Load built-in sampler sample"
                  className={classNames(
                    "hover:text-cyan-300 hover:border-cyan-400 px-1 shrink-0",
                    track.samplerSamplePath &&
                      "text-cyan-300! border-cyan-500/60!",
                  )}
                >
                  <FileAudio size={11} />
                </Button>
                {track.samplerSamplePath && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      void clearTrackSamplerSampleWithUndo(track.id);
                    }}
                    title="Clear sampler sample"
                    className="hover:text-red-400 px-1 shrink-0"
                  >
                    <X size={11} />
                  </Button>
                )}
              </div>
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
        {/* end main controls area */}

        {/* Automation Lane Sub-Headers — one per visible lane */}
        {track.showAutomation &&
          track.automationLanes
            .filter((l) => l.visible)
            .map((lane) => {
              const laneColor = getAutomationColor(lane.param);
              const laneLabel = getAutomationShortLabel(lane.param);
              const paramDef = getAutomationParamDef(lane.param);
              const fader = paramDef.inlineFader;
              return (
                <div
                  key={lane.id}
                  className="flex items-center gap-1 px-1 border-t border-neutral-700/50 shrink-0"
                  style={{ height: AUTOMATION_LANE_HEIGHT }}
                >
                  {/* Color indicator */}
                  <div
                    className="w-0.5 h-full shrink-0 rounded-sm"
                    style={{ backgroundColor: laneColor }}
                  />
                  {/* Param name */}
                  <span
                    className="text-[10px] text-neutral-400 w-7 truncate shrink-0"
                    title={lane.param}
                  >
                    {laneLabel}
                  </span>
                  {/* Inline fader / toggle / value display */}
                  {fader && fader.variant === "toggle" ? (
                    <button
                      className={`text-[8px] w-8 h-4 rounded shrink-0 cursor-pointer transition-colors ${
                        track.muted
                          ? "bg-neutral-500 text-white"
                          : "bg-neutral-700 text-neutral-400 hover:text-neutral-200"
                      }`}
                      onClick={() => toggleTrackMute(track.id)}
                      data-no-drag="true"
                      data-no-select="true"
                      title={track.muted ? "Unmute" : "Mute"}
                    >
                      {track.muted ? "ON" : "OFF"}
                    </button>
                  ) : fader && fader.trackProperty ? (
                    <div
                      className="shrink-0"
                      style={{ width: 64 }}
                      data-no-drag="true"
                      data-no-select="true"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (fader.trackProperty === "volumeDB")
                          beginTrackVolumeEdit(track.id);
                        else if (fader.trackProperty === "pan")
                          beginTrackPanEdit(track.id);
                        const commitOnce = () => {
                          if (fader.trackProperty === "volumeDB")
                            commitTrackVolumeEdit(track.id);
                          else if (fader.trackProperty === "pan")
                            commitTrackPanEdit(track.id);
                          document.removeEventListener("pointerup", commitOnce);
                        };
                        document.addEventListener("pointerup", commitOnce, {
                          once: true,
                        });
                      }}
                    >
                      <Slider
                        variant={fader.variant as "default" | "pan"}
                        min={fader.min}
                        max={fader.max}
                        step={fader.step}
                        value={
                          autoValues?.[lane.param] !== undefined
                            ? automationToBackend(
                                lane.param,
                                autoValues[lane.param],
                              )
                            : fader.trackProperty === "volumeDB"
                              ? track.volumeDB
                              : track.pan
                        }
                        onChange={(v) => {
                          if (fader.trackProperty === "volumeDB")
                            setTrackVolume(track.id, v);
                          else if (fader.trackProperty === "pan")
                            setTrackPan(track.id, v);
                        }}
                        defaultValue={fader.defaultValue}
                        orientation="horizontal"
                        width="64px"
                      />
                    </div>
                  ) : (
                    <span className="text-[8px] text-neutral-500 w-12 text-center truncate shrink-0">
                      {paramDef.formatNormalized(
                        autoValues?.[lane.param] ?? paramDef.defaultNormalized,
                      )}
                    </span>
                  )}
                  {/* Lane read toggle */}
                  <button
                    className={`text-[9px] w-5 h-4 rounded flex items-center justify-center shrink-0 ${
                      (lane.readEnabled ?? lane.mode !== "off")
                        ? "bg-teal-600/70 text-white border border-teal-400"
                        : "bg-neutral-700 text-neutral-500 hover:text-neutral-300 border border-neutral-600"
                    }`}
                    onClick={() =>
                      useDAWStore
                        .getState()
                        .toggleAutomationLaneRead(track.id, lane.id)
                    }
                    title={
                      (lane.readEnabled ?? lane.mode !== "off")
                        ? "Disable lane read"
                        : "Enable lane read"
                    }
                    data-no-select="true"
                    data-no-drag="true"
                  >
                    R
                  </button>
                  {/* Hide lane button */}
                  <button
                    className="text-[10px] text-neutral-500 hover:text-neutral-300 w-4 h-4 flex items-center justify-center shrink-0"
                    onClick={() =>
                      useDAWStore
                        .getState()
                        .toggleAutomationLaneVisibility(track.id, lane.id)
                    }
                    title="Hide this lane"
                    data-no-select="true"
                    data-no-drag="true"
                  >
                    &times;
                  </button>
                </div>
              );
            })}
      </div>
      {/* end outer container */}

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
          trackType={track.type}
          onClose={() => {
            setShowInstrumentBrowser(false);
          }}
        />
      )}

      {samplerDialog &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50"
            data-modal-root="true"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sampler-root-note-title"
            onContextMenu={guardModalContextMenu}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSamplerDialog(null);
            }}
          >
            <form
              className="w-[340px] rounded-md border border-white/15 bg-neutral-900 p-4 shadow-2xl"
              onMouseDown={(event) => event.stopPropagation()}
              onContextMenu={guardModalContextMenu}
              onSubmit={(event) => {
                event.preventDefault();
                void submitSamplerDialog();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSamplerDialog(null);
                }
              }}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div
                  id="sampler-root-note-title"
                  className="text-sm font-semibold text-white"
                >
                  Sampler Root Note
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSamplerDialog(null)}
                  aria-label="Close sampler root note dialog"
                >
                  <X size={14} />
                </Button>
              </div>
              <div
                className="mb-3 truncate text-xs text-neutral-400"
                title={samplerDialog.samplePath}
              >
                {samplerDialog.samplePath}
              </div>
              <Input
                id="sampler-root-note-input"
                type="number"
                min={0}
                max={127}
                step={1}
                autoFocus
                fullWidth
                label="Root MIDI note"
                value={samplerDialog.rootNote}
                onChange={(event) =>
                  setSamplerDialog({
                    ...samplerDialog,
                    rootNote: event.target.value,
                    error: null,
                  })
                }
                error={samplerDialog.error || undefined}
              />
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSamplerDialog(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm">
                  Load
                </Button>
              </div>
            </form>
          </div>,
          document.body,
        )}
    </>
  );
});

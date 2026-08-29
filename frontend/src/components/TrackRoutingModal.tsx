import { useState, useEffect, useCallback, useRef } from "react";
import classNames from "classnames";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Modal, Slider } from "./ui";
import { nativeBridge } from "../services/NativeBridge";

// ── Helpers ───────────────────────────────────────────────────────────

function linearToDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

function formatDb(db: number): string {
  if (!isFinite(db) || db <= -60) return "-inf";
  return (db >= 0 ? "+" : "") + db.toFixed(2);
}

function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.005) return "center";
  return pan < 0
    ? `${Math.round(Math.abs(pan * 100))}%L`
    : `${Math.round(pan * 100)}%R`;
}

const CHANNEL_OPTIONS = [
  { value: "1/2", label: "1/2", start: 0, count: 2 },
  { value: "3/4", label: "3/4", start: 2, count: 2 },
  { value: "5/6", label: "5/6", start: 4, count: 2 },
  { value: "7/8", label: "7/8", start: 6, count: 2 },
  { value: "1", label: "1 (Mono)", start: 0, count: 1 },
  { value: "2", label: "2 (Mono)", start: 1, count: 1 },
];

function channelPairLabel(start: number, count: number): string {
  if (count === 1) return `${start + 1} (Mono)`;
  return `${start + 1}/${start + 2}`;
}

// ── Send Item Component ───────────────────────────────────────────────

interface SendItemProps {
  sourceTrackId: string;
  sendIndex: number;
  send: {
    destTrackId: string;
    level: number;
    pan: number;
    enabled: boolean;
    preFader: boolean;
    phaseInvert: boolean;
  };
  destTrackName: string;
  onRemove: () => void;
}

interface SendLevelSliderProps {
  sourceTrackId: string;
  sendIndex: number;
  level: number;
  ariaLabel: string;
}

function SendLevelSlider({
  sourceTrackId,
  sendIndex,
  level,
  ariaLabel,
}: SendLevelSliderProps) {
  const {
    beginTrackSendLevelEdit,
    setTrackSendLevel,
    commitTrackSendLevelEdit,
  } = useDAWStore(
    useShallow((state) => ({
      beginTrackSendLevelEdit: state.beginTrackSendLevelEdit,
      setTrackSendLevel: state.setTrackSendLevel,
      commitTrackSendLevelEdit: state.commitTrackSendLevelEdit,
    })),
  );
  const beginEdit = useCallback(() => {
    beginTrackSendLevelEdit(sourceTrackId, sendIndex);
  }, [beginTrackSendLevelEdit, sendIndex, sourceTrackId]);
  const changeLevel = useCallback((percent: number) => {
    void setTrackSendLevel(sourceTrackId, sendIndex, percent / 100);
  }, [sendIndex, setTrackSendLevel, sourceTrackId]);
  const commitEdit = useCallback(() => {
    commitTrackSendLevelEdit(sourceTrackId, sendIndex);
  }, [commitTrackSendLevelEdit, sendIndex, sourceTrackId]);

  return (
    <div className="flex-1">
      <Slider
        min={0}
        max={100}
        step={1}
        value={Math.round(level * 100)}
        defaultValue={50}
        onBeginEdit={beginEdit}
        onChange={changeLevel}
        onCommitEdit={commitEdit}
        className="h-1.5 accent-cyan-500"
        aria-label={ariaLabel}
      />
    </div>
  );
}

interface SendPanSliderProps {
  sourceTrackId: string;
  sendIndex: number;
  pan: number;
  ariaLabel: string;
}

function SendPanSlider({
  sourceTrackId,
  sendIndex,
  pan,
  ariaLabel,
}: SendPanSliderProps) {
  const {
    beginTrackSendPanEdit,
    setTrackSendPan,
    commitTrackSendPanEdit,
  } = useDAWStore(
    useShallow((state) => ({
      beginTrackSendPanEdit: state.beginTrackSendPanEdit,
      setTrackSendPan: state.setTrackSendPan,
      commitTrackSendPanEdit: state.commitTrackSendPanEdit,
    })),
  );
  const beginEdit = useCallback(() => {
    beginTrackSendPanEdit(sourceTrackId, sendIndex);
  }, [beginTrackSendPanEdit, sendIndex, sourceTrackId]);
  const changePan = useCallback((percent: number) => {
    void setTrackSendPan(sourceTrackId, sendIndex, percent / 100);
  }, [sendIndex, setTrackSendPan, sourceTrackId]);
  const commitEdit = useCallback(() => {
    commitTrackSendPanEdit(sourceTrackId, sendIndex);
  }, [commitTrackSendPanEdit, sendIndex, sourceTrackId]);

  return (
    <div className="flex-1">
      <Slider
        min={-100}
        max={100}
        step={1}
        value={Math.round(pan * 100)}
        defaultValue={0}
        variant="pan"
        onBeginEdit={beginEdit}
        onChange={changePan}
        onCommitEdit={commitEdit}
        aria-label={ariaLabel}
      />
    </div>
  );
}

interface TrackContinuousControlProps {
  trackId: string;
  value: number;
}

function TrackPanSlider({ trackId, value }: TrackContinuousControlProps) {
  const { beginTrackPanEdit, setTrackPan, commitTrackPanEdit } = useDAWStore(
    useShallow((state) => ({
      beginTrackPanEdit: state.beginTrackPanEdit,
      setTrackPan: state.setTrackPan,
      commitTrackPanEdit: state.commitTrackPanEdit,
    })),
  );
  const beginEdit = useCallback(() => beginTrackPanEdit(trackId), [beginTrackPanEdit, trackId]);
  const changePan = useCallback((percent: number) => {
    void setTrackPan(trackId, percent / 100);
  }, [setTrackPan, trackId]);
  const commitEdit = useCallback(() => commitTrackPanEdit(trackId), [commitTrackPanEdit, trackId]);

  return (
    <div className="flex-1">
      <Slider
        min={-100}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        defaultValue={0}
        variant="pan"
        onBeginEdit={beginEdit}
        onChange={changePan}
        onCommitEdit={commitEdit}
        aria-label="Track pan"
      />
    </div>
  );
}

function TrackStereoWidthSlider({ trackId, value }: TrackContinuousControlProps) {
  const {
    beginTrackStereoWidthEdit,
    setTrackStereoWidth,
    commitTrackStereoWidthEdit,
  } = useDAWStore(
    useShallow((state) => ({
      beginTrackStereoWidthEdit: state.beginTrackStereoWidthEdit,
      setTrackStereoWidth: state.setTrackStereoWidth,
      commitTrackStereoWidthEdit: state.commitTrackStereoWidthEdit,
    })),
  );
  const beginEdit = useCallback(() => beginTrackStereoWidthEdit(trackId), [beginTrackStereoWidthEdit, trackId]);
  const changeWidth = useCallback((width: number) => {
    void setTrackStereoWidth(trackId, width);
  }, [setTrackStereoWidth, trackId]);
  const commitEdit = useCallback(
    () => commitTrackStereoWidthEdit(trackId),
    [commitTrackStereoWidthEdit, trackId],
  );

  return (
    <div className="flex-1">
      <Slider
        min={0}
        max={200}
        step={1}
        value={value}
        defaultValue={100}
        onBeginEdit={beginEdit}
        onChange={changeWidth}
        onCommitEdit={commitEdit}
        className="h-1.5 accent-cyan-500"
        aria-label="Track stereo width"
      />
    </div>
  );
}

function TrackVolumeDbField({ trackId, value }: TrackContinuousControlProps) {
  const { beginTrackVolumeEdit, setTrackVolume, commitTrackVolumeEdit } = useDAWStore(
    useShallow((state) => ({
      beginTrackVolumeEdit: state.beginTrackVolumeEdit,
      setTrackVolume: state.setTrackVolume,
      commitTrackVolumeEdit: state.commitTrackVolumeEdit,
    })),
  );
  const [draft, setDraft] = useState(() => formatDb(value));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setDraft(formatDb(value));
  }, [value]);
  useEffect(() => () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    useDAWStore.getState().commitTrackVolumeEdit(trackId);
  }, [trackId]);

  const beginEdit = useCallback(() => {
    if (editingRef.current) return;
    editingRef.current = true;
    beginTrackVolumeEdit(trackId);
  }, [beginTrackVolumeEdit, trackId]);
  const commitDraft = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) {
      const nextValue = Math.max(-60, Math.min(12, parsed));
      void setTrackVolume(trackId, nextValue);
      setDraft(formatDb(nextValue));
    } else {
      setDraft(formatDb(value));
    }
    commitTrackVolumeEdit(trackId);
  }, [commitTrackVolumeEdit, draft, setTrackVolume, trackId, value]);
  const cancelDraft = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setDraft(formatDb(value));
    commitTrackVolumeEdit(trackId);
  }, [commitTrackVolumeEdit, trackId, value]);

  return (
    <input
      type="text"
      className="bg-neutral-800 border border-neutral-600 rounded text-[10px] text-neutral-300 w-16 h-5 px-1 text-center font-mono"
      value={draft}
      onFocus={beginEdit}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitDraft();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelDraft();
          event.currentTarget.blur();
        }
      }}
      title="Track volume in dB"
      aria-label="Track volume in dB"
    />
  );
}

function SendItem({ sourceTrackId, sendIndex, send, destTrackName, onRemove }: SendItemProps) {
  const {
    setTrackSendEnabled,
    setTrackSendPreFader,
    setTrackSendPhaseInvert,
  } = useDAWStore(
    useShallow((s) => ({
      setTrackSendEnabled: s.setTrackSendEnabled,
      setTrackSendPreFader: s.setTrackSendPreFader,
      setTrackSendPhaseInvert: s.setTrackSendPhaseInvert,
    })),
  );

  const db = linearToDb(send.level);

  return (
    <div className="bg-daw-dark border border-neutral-700 rounded p-2 space-y-1.5">
      {/* Header: dest name + controls + delete */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-200 truncate flex-1">
          {destTrackName}
        </span>
        <div className="flex items-center gap-1">
          {/* dB display */}
          <span className="text-[10px] font-mono text-neutral-400 w-[42px] text-right">
            {formatDb(db)} dB
          </span>
          {/* Pan display */}
          <span className="text-[10px] font-mono text-neutral-400 w-[38px] text-center">
            {formatPan(send.pan)}
          </span>
          {/* Mute/Enable toggle */}
          <button
            onClick={() => setTrackSendEnabled(sourceTrackId, sendIndex, !send.enabled)}
            className={classNames(
              "w-5 h-5 rounded text-[9px] font-bold cursor-pointer transition-colors",
              send.enabled
                ? "bg-green-600/80 text-white"
                : "bg-neutral-700 text-neutral-500",
            )}
            title={send.enabled ? "Mute send" : "Unmute send"}
          >
            M
          </button>
          {/* Phase invert */}
          <button
            onClick={() => setTrackSendPhaseInvert(sourceTrackId, sendIndex, !send.phaseInvert)}
            className={classNames(
              "w-5 h-5 rounded text-[10px] font-bold cursor-pointer transition-colors",
              send.phaseInvert
                ? "bg-yellow-600/80 text-white"
                : "bg-neutral-700 text-neutral-500",
            )}
            title={send.phaseInvert ? "Disable phase invert" : "Enable phase invert"}
          >
            &Oslash;
          </button>
          {/* Pre/Post fader */}
          <select
            value={send.preFader ? "pre" : "post"}
            onChange={(e) => setTrackSendPreFader(sourceTrackId, sendIndex, e.target.value === "pre")}
            className="bg-neutral-800 border border-neutral-600 rounded text-[9px] text-neutral-300 h-5 px-0.5 cursor-pointer"
          >
            <option value="post">Post-Fader</option>
            <option value="pre">Pre-Fader</option>
          </select>
          {/* Delete */}
          <button
            onClick={onRemove}
            className="w-5 h-5 rounded bg-neutral-700 text-neutral-400 hover:bg-red-700 hover:text-white text-[10px] cursor-pointer transition-colors"
            title="Remove send"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Volume + Pan sliders */}
      <div className="flex items-center gap-2">
        <label className="text-[9px] text-neutral-500 w-6">Vol</label>
        <SendLevelSlider
          sourceTrackId={sourceTrackId}
          sendIndex={sendIndex}
          level={send.level}
          ariaLabel={`Send level to ${destTrackName}`}
        />
        <label className="text-[9px] text-neutral-500 w-6">Pan</label>
        <SendPanSlider
          sourceTrackId={sourceTrackId}
          sendIndex={sendIndex}
          pan={send.pan}
          ariaLabel={`Send pan to ${destTrackName}`}
        />
      </div>
    </div>
  );
}

// ── Receive Item Component (read-only view targeting source track's send) ──

interface ReceiveItemProps {
  sourceTrackId: string;
  sourceTrackName: string;
  sendIndex: number;
  send: {
    destTrackId: string;
    level: number;
    pan: number;
    enabled: boolean;
    preFader: boolean;
    phaseInvert: boolean;
  };
  onRemove: () => void;
}

function ReceiveItem({ sourceTrackId, sourceTrackName, sendIndex, send, onRemove }: ReceiveItemProps) {
  // Receives control the SOURCE track's send
  const {
    setTrackSendEnabled,
    setTrackSendPreFader,
    setTrackSendPhaseInvert,
  } = useDAWStore(
    useShallow((s) => ({
      setTrackSendEnabled: s.setTrackSendEnabled,
      setTrackSendPreFader: s.setTrackSendPreFader,
      setTrackSendPhaseInvert: s.setTrackSendPhaseInvert,
    })),
  );

  const db = linearToDb(send.level);

  return (
    <div className="bg-daw-dark border border-neutral-700 rounded p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-200 truncate flex-1">
          From: {sourceTrackName}
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-mono text-neutral-400 w-[42px] text-right">
            {formatDb(db)} dB
          </span>
          <span className="text-[10px] font-mono text-neutral-400 w-[38px] text-center">
            {formatPan(send.pan)}
          </span>
          <button
            onClick={() => setTrackSendEnabled(sourceTrackId, sendIndex, !send.enabled)}
            className={classNames(
              "w-5 h-5 rounded text-[9px] font-bold cursor-pointer transition-colors",
              send.enabled
                ? "bg-green-600/80 text-white"
                : "bg-neutral-700 text-neutral-500",
            )}
            title={send.enabled ? "Mute receive" : "Unmute receive"}
          >
            M
          </button>
          <button
            onClick={() => setTrackSendPhaseInvert(sourceTrackId, sendIndex, !send.phaseInvert)}
            className={classNames(
              "w-5 h-5 rounded text-[10px] font-bold cursor-pointer transition-colors",
              send.phaseInvert
                ? "bg-yellow-600/80 text-white"
                : "bg-neutral-700 text-neutral-500",
            )}
            title={send.phaseInvert ? "Disable phase invert" : "Enable phase invert"}
          >
            &Oslash;
          </button>
          <select
            value={send.preFader ? "pre" : "post"}
            onChange={(e) => setTrackSendPreFader(sourceTrackId, sendIndex, e.target.value === "pre")}
            className="bg-neutral-800 border border-neutral-600 rounded text-[9px] text-neutral-300 h-5 px-0.5 cursor-pointer"
          >
            <option value="post">Post-Fader</option>
            <option value="pre">Pre-Fader</option>
          </select>
          <button
            onClick={onRemove}
            className="w-5 h-5 rounded bg-neutral-700 text-neutral-400 hover:bg-red-700 hover:text-white text-[10px] cursor-pointer transition-colors"
            title="Remove receive (removes send from source)"
          >
            &times;
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-[9px] text-neutral-500 w-6">Vol</label>
        <SendLevelSlider
          sourceTrackId={sourceTrackId}
          sendIndex={sendIndex}
          level={send.level}
          ariaLabel={`Receive level from ${sourceTrackName}`}
        />
        <label className="text-[9px] text-neutral-500 w-6">Pan</label>
        <SendPanSlider
          sourceTrackId={sourceTrackId}
          sendIndex={sendIndex}
          pan={send.pan}
          ariaLabel={`Receive pan from ${sourceTrackName}`}
        />
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────

interface TrackRoutingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TrackRoutingModal({ isOpen, onClose }: TrackRoutingModalProps) {
  const {
    trackId,
    tracks,
    addTrackSend,
    removeTrackSend,
    setTrackPhaseInvert,
    setTrackMasterSendEnabled,
    setTrackOutputChannels,
    setTrackPlaybackOffset,
    setTrackChannelCount,
    setTrackMIDIOutput,
  } = useDAWStore(
    useShallow((s) => ({
      trackId: s.trackRoutingTrackId,
      tracks: s.tracks,
      addTrackSend: s.addTrackSend,
      removeTrackSend: s.removeTrackSend,
      setTrackPhaseInvert: s.setTrackPhaseInvert,
      setTrackMasterSendEnabled: s.setTrackMasterSendEnabled,
      setTrackOutputChannels: s.setTrackOutputChannels,
      setTrackPlaybackOffset: s.setTrackPlaybackOffset,
      setTrackChannelCount: s.setTrackChannelCount,
      setTrackMIDIOutput: s.setTrackMIDIOutput,
    })),
  );

  const track = tracks.find((t) => t.id === trackId);
  const [midiOutputDevices, setMidiOutputDevices] = useState<string[]>([]);
  const [offsetEnabled, setOffsetEnabled] = useState(false);
  const [offsetUnit, setOffsetUnit] = useState<"ms" | "samples">("ms");
  const [addSendDropdown, setAddSendDropdown] = useState(false);
  const [addReceiveDropdown, setAddReceiveDropdown] = useState(false);
  const addSendRef = useRef<HTMLDivElement>(null);
  const addReceiveRef = useRef<HTMLDivElement>(null);

  // Fetch MIDI output devices when modal opens
  useEffect(() => {
    if (!isOpen) return;
    nativeBridge.getMIDIOutputDevices().then(setMidiOutputDevices).catch(() => {});
  }, [isOpen]);

  // Sync offset enabled state from track
  useEffect(() => {
    if (track) {
      setOffsetEnabled(track.playbackOffsetMs !== 0);
    }
  }, [track?.id]);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!addSendDropdown && !addReceiveDropdown) return;
    const handler = (e: MouseEvent) => {
      if (addSendRef.current && !addSendRef.current.contains(e.target as Node)) {
        setAddSendDropdown(false);
      }
      if (addReceiveRef.current && !addReceiveRef.current.contains(e.target as Node)) {
        setAddReceiveDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [addSendDropdown, addReceiveDropdown]);

  // Compute receives: all tracks that have a send to this track
  const receives = tracks.flatMap((t) =>
    t.sends
      .map((s, i) => ({ sourceTrackId: t.id, sourceTrackName: t.name, sendIndex: i, send: s }))
      .filter((r) => r.send.destTrackId === trackId),
  );

  // Tracks available as send destinations (exclude self)
  const availableSendDests = tracks.filter(
    (t) => t.id !== trackId && !track?.sends.some((s) => s.destTrackId === t.id),
  );

  // Tracks available as receive sources (tracks that don't already send to us)
  const availableReceiveSources = tracks.filter(
    (t) => t.id !== trackId && !t.sends.some((s) => s.destTrackId === trackId),
  );

  const handleAddSend = useCallback(
    (destId: string) => {
      if (trackId) addTrackSend(trackId, destId);
      setAddSendDropdown(false);
    },
    [trackId, addTrackSend],
  );

  const handleAddReceive = useCallback(
    (sourceId: string) => {
      // Adding a receive = adding a send from sourceId -> this track
      if (trackId) addTrackSend(sourceId, trackId);
      setAddReceiveDropdown(false);
    },
    [trackId, addTrackSend],
  );

  if (!track || !trackId) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Routing — "${track.name}"`}
      className="!max-w-[560px]"
    >
      <div className="space-y-3 text-xs max-h-[70vh] overflow-y-auto px-1">
        {/* ═══════ MASTER SEND SECTION ═══════ */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={track.masterSendEnabled}
                onChange={(e) => setTrackMasterSendEnabled(trackId, e.target.checked)}
                className="accent-cyan-500 cursor-pointer"
              />
              <span className="text-neutral-300 font-medium">Master send</span>
            </label>
            <span className="text-neutral-500 text-[10px]">channels from/to</span>
            <select
              className="bg-neutral-800 border border-neutral-600 rounded text-[10px] text-neutral-300 h-5 px-0.5 cursor-pointer"
              value="all"
            >
              <option value="all">All</option>
            </select>
            <span className="text-neutral-500 text-[10px]">&rarr;</span>
            <select
              className="bg-neutral-800 border border-neutral-600 rounded text-[10px] text-neutral-300 h-5 px-0.5 cursor-pointer"
              value={channelPairLabel(track.outputStartChannel, track.outputChannelCount)}
              onChange={(e) => {
                const opt = CHANNEL_OPTIONS.find((o) => o.label === e.target.value);
                if (opt) setTrackOutputChannels(trackId, opt.start, opt.count);
              }}
            >
              {CHANNEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.label}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Volume + Track channels */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-neutral-500 text-[10px] w-7">Vol:</span>
              <TrackVolumeDbField trackId={trackId} value={track.volumeDB} />
              <span className="text-neutral-500 text-[10px]">dB</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-neutral-500 text-[10px]">Track channels:</span>
              <select
                className="bg-neutral-800 border border-neutral-600 rounded text-[10px] text-neutral-300 h-5 px-0.5 cursor-pointer"
                value={track.trackChannelCount}
                onChange={(e) => setTrackChannelCount(trackId, Number(e.target.value))}
              >
                {[1, 2, 4, 6, 8].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Pan slider */}
          <div className="flex items-center gap-2">
            <span className="text-neutral-500 text-[10px] w-7">Pan:</span>
            <TrackPanSlider trackId={trackId} value={track.pan} />
            <span className="text-[10px] font-mono text-neutral-400 w-12 text-right">
              {formatPan(track.pan)}
            </span>
          </div>

          {/* Width slider */}
          <div className="flex items-center gap-2">
            <span className="text-neutral-500 text-[10px] w-7">Width:</span>
            <TrackStereoWidthSlider trackId={trackId} value={track.stereoWidth} />
            <span className="text-[10px] font-mono text-neutral-400 w-12 text-right">
              {track.stereoWidth}%
            </span>
          </div>

          {/* Phase invert */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setTrackPhaseInvert(trackId, !track.phaseInverted)}
              className={classNames(
                "px-2 h-5 rounded text-[10px] font-bold cursor-pointer transition-colors",
                track.phaseInverted
                  ? "bg-yellow-600/80 text-white"
                  : "bg-neutral-700 text-neutral-500 hover:text-neutral-300",
              )}
              title="Phase invert (polarity flip)"
            >
              &Oslash; Phase
            </button>
          </div>

          {/* Playback offset */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={offsetEnabled}
                onChange={(e) => {
                  setOffsetEnabled(e.target.checked);
                  if (!e.target.checked) setTrackPlaybackOffset(trackId, 0);
                }}
                className="accent-cyan-500 cursor-pointer"
              />
              <span className="text-neutral-500 text-[10px]">Media playback offset:</span>
            </label>
            <input
              type="number"
              className="bg-neutral-800 border border-neutral-600 rounded text-[10px] text-neutral-300 w-16 h-5 px-1 text-center font-mono disabled:opacity-40"
              value={offsetUnit === "ms" ? track.playbackOffsetMs : Math.round(track.playbackOffsetMs * 44.1)}
              disabled={!offsetEnabled}
              onChange={(e) => {
                const val = parseFloat(e.target.value) || 0;
                const ms = offsetUnit === "ms" ? val : val / 44.1;
                setTrackPlaybackOffset(trackId, ms);
              }}
            />
            <label className="flex items-center gap-0.5 cursor-pointer">
              <input
                type="radio"
                name="offsetUnit"
                checked={offsetUnit === "ms"}
                onChange={() => setOffsetUnit("ms")}
                className="accent-cyan-500 cursor-pointer"
              />
              <span className="text-[10px] text-neutral-400">ms</span>
            </label>
            <label className="flex items-center gap-0.5 cursor-pointer">
              <input
                type="radio"
                name="offsetUnit"
                checked={offsetUnit === "samples"}
                onChange={() => setOffsetUnit("samples")}
                className="accent-cyan-500 cursor-pointer"
              />
              <span className="text-[10px] text-neutral-400">samples</span>
            </label>
          </div>
        </section>

        <hr className="border-neutral-700" />

        {/* ═══════ MIDI HARDWARE OUTPUT ═══════ */}
        <section className="space-y-1">
          <div className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wide">MIDI Hardware Output</div>
          <select
            className="w-full bg-neutral-800 border border-neutral-600 rounded text-[10px] text-neutral-300 h-6 px-1 cursor-pointer"
            value={track.midiOutputDevice || ""}
            onChange={(e) => setTrackMIDIOutput(trackId, e.target.value)}
          >
            <option value="">{"<no output>"}</option>
            {midiOutputDevices.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </section>

        <hr className="border-neutral-700" />

        {/* ═══════ SENDS ═══════ */}
        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wide">Sends</span>
            <div className="relative" ref={addSendRef}>
              <button
                onClick={() => setAddSendDropdown(!addSendDropdown)}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 cursor-pointer transition-colors"
                disabled={availableSendDests.length === 0}
              >
                + Add send
              </button>
              {addSendDropdown && availableSendDests.length > 0 && (
                <div className="absolute right-0 top-5 z-50 bg-neutral-800 border border-neutral-600 rounded shadow-lg py-0.5 min-w-[140px] max-h-40 overflow-y-auto">
                  {availableSendDests.map((t) => (
                    <div
                      key={t.id}
                      className="px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-700 cursor-pointer truncate"
                      onClick={() => handleAddSend(t.id)}
                    >
                      {t.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {track.sends.length === 0 && (
            <div className="text-[10px] text-neutral-600 italic py-1">No sends</div>
          )}

          {track.sends.map((send, i) => {
            const dest = tracks.find((t) => t.id === send.destTrackId);
            return (
              <SendItem
                key={`${send.destTrackId}-${i}`}
                sourceTrackId={trackId}
                sendIndex={i}
                send={send}
                destTrackName={dest?.name || "Unknown"}
                onRemove={() => removeTrackSend(trackId, i)}
              />
            );
          })}
        </section>

        <hr className="border-neutral-700" />

        {/* ═══════ RECEIVES ═══════ */}
        <section className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wide">Receives</span>
            <div className="relative" ref={addReceiveRef}>
              <button
                onClick={() => setAddReceiveDropdown(!addReceiveDropdown)}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 cursor-pointer transition-colors"
                disabled={availableReceiveSources.length === 0}
              >
                + Add receive
              </button>
              {addReceiveDropdown && availableReceiveSources.length > 0 && (
                <div className="absolute right-0 top-5 z-50 bg-neutral-800 border border-neutral-600 rounded shadow-lg py-0.5 min-w-[140px] max-h-40 overflow-y-auto">
                  {availableReceiveSources.map((t) => (
                    <div
                      key={t.id}
                      className="px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-700 cursor-pointer truncate"
                      onClick={() => handleAddReceive(t.id)}
                    >
                      {t.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {receives.length === 0 && (
            <div className="text-[10px] text-neutral-600 italic py-1">No receives</div>
          )}

          {receives.map((r) => (
            <ReceiveItem
              key={`${r.sourceTrackId}-${r.sendIndex}`}
              sourceTrackId={r.sourceTrackId}
              sourceTrackName={r.sourceTrackName}
              sendIndex={r.sendIndex}
              send={r.send}
              onRemove={() => removeTrackSend(r.sourceTrackId, r.sendIndex)}
            />
          ))}
        </section>

        <hr className="border-neutral-700" />

        {/* ═══════ AUDIO HARDWARE OUTPUTS ═══════ */}
        <section className="space-y-1.5">
          <div className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wide">Audio Hardware Outputs</div>
          <div className="bg-daw-dark border border-neutral-700 rounded p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-300">Output channels:</span>
              <select
                className="bg-neutral-800 border border-neutral-600 rounded text-[10px] text-neutral-300 h-5 px-0.5 cursor-pointer"
                value={channelPairLabel(track.outputStartChannel, track.outputChannelCount)}
                onChange={(e) => {
                  const opt = CHANNEL_OPTIONS.find((o) => o.label === e.target.value);
                  if (opt) setTrackOutputChannels(trackId, opt.start, opt.count);
                }}
              >
                {CHANNEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.label}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}

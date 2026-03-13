import { useState, useEffect, useCallback, useRef } from "react";
import classNames from "classnames";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Modal } from "./ui";
import { nativeBridge } from "../services/NativeBridge";

// ── Helpers ───────────────────────────────────────────────────────────

function linearToDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

function dbToLinear(db: number): number {
  return db <= -60 ? 0 : Math.pow(10, db / 20);
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

function SendItem({ sourceTrackId, sendIndex, send, destTrackName, onRemove }: SendItemProps) {
  const {
    setTrackSendLevel,
    setTrackSendPan,
    setTrackSendEnabled,
    setTrackSendPreFader,
    setTrackSendPhaseInvert,
  } = useDAWStore(
    useShallow((s) => ({
      setTrackSendLevel: s.setTrackSendLevel,
      setTrackSendPan: s.setTrackSendPan,
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
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(send.level * 100)}
          onChange={(e) => setTrackSendLevel(sourceTrackId, sendIndex, Number(e.target.value) / 100)}
          className="flex-1 h-1.5 accent-cyan-500 cursor-pointer"
        />
        <label className="text-[9px] text-neutral-500 w-6">Pan</label>
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={Math.round(send.pan * 100)}
          onChange={(e) => setTrackSendPan(sourceTrackId, sendIndex, Number(e.target.value) / 100)}
          className="flex-1 h-1.5 accent-cyan-500 cursor-pointer"
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
    setTrackSendLevel,
    setTrackSendPan,
    setTrackSendEnabled,
    setTrackSendPreFader,
    setTrackSendPhaseInvert,
  } = useDAWStore(
    useShallow((s) => ({
      setTrackSendLevel: s.setTrackSendLevel,
      setTrackSendPan: s.setTrackSendPan,
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
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(send.level * 100)}
          onChange={(e) => setTrackSendLevel(sourceTrackId, sendIndex, Number(e.target.value) / 100)}
          className="flex-1 h-1.5 accent-cyan-500 cursor-pointer"
        />
        <label className="text-[9px] text-neutral-500 w-6">Pan</label>
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={Math.round(send.pan * 100)}
          onChange={(e) => setTrackSendPan(sourceTrackId, sendIndex, Number(e.target.value) / 100)}
          className="flex-1 h-1.5 accent-cyan-500 cursor-pointer"
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
    setTrackStereoWidth,
    setTrackMasterSendEnabled,
    setTrackOutputChannels,
    setTrackPlaybackOffset,
    setTrackChannelCount,
    setTrackMIDIOutput,
    setTrackVolume,
    setTrackPan,
  } = useDAWStore(
    useShallow((s) => ({
      trackId: s.trackRoutingTrackId,
      tracks: s.tracks,
      addTrackSend: s.addTrackSend,
      removeTrackSend: s.removeTrackSend,
      setTrackPhaseInvert: s.setTrackPhaseInvert,
      setTrackStereoWidth: s.setTrackStereoWidth,
      setTrackMasterSendEnabled: s.setTrackMasterSendEnabled,
      setTrackOutputChannels: s.setTrackOutputChannels,
      setTrackPlaybackOffset: s.setTrackPlaybackOffset,
      setTrackChannelCount: s.setTrackChannelCount,
      setTrackMIDIOutput: s.setTrackMIDIOutput,
      setTrackVolume: s.setTrackVolume,
      setTrackPan: s.setTrackPan,
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

  const volumeDb = linearToDb(track.volume);

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
              <input
                type="text"
                className="bg-neutral-800 border border-neutral-600 rounded text-[10px] text-neutral-300 w-16 h-5 px-1 text-center font-mono"
                value={formatDb(volumeDb)}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) setTrackVolume(trackId, dbToLinear(val));
                }}
                title="Track volume in dB"
              />
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
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={Math.round(track.pan * 100)}
              onChange={(e) => setTrackPan(trackId, Number(e.target.value) / 100)}
              className="flex-1 h-1.5 accent-cyan-500 cursor-pointer"
            />
            <span className="text-[10px] font-mono text-neutral-400 w-12 text-right">
              {formatPan(track.pan)}
            </span>
          </div>

          {/* Width slider */}
          <div className="flex items-center gap-2">
            <span className="text-neutral-500 text-[10px] w-7">Width:</span>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={track.stereoWidth}
              onChange={(e) => setTrackStereoWidth(trackId, Number(e.target.value))}
              className="flex-1 h-1.5 accent-cyan-500 cursor-pointer"
            />
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

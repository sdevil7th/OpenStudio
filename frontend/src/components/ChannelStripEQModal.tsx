import { useState, useCallback, useEffect, useRef } from "react";
import classNames from "classnames";
import { Power } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Modal } from "./ui";
import { nativeBridge } from "../services/NativeBridge";

// ── EQ Band Definitions ─────────────────────────────────────────────

interface EQBandDef {
  label: string;
  freqRange: [number, number];
  hasGain: boolean;
  hasQ: boolean;
  defaultFreq: number;
  defaultGain: number;
  defaultQ: number;
}

const EQ_BANDS: EQBandDef[] = [
  { label: "HPF",  freqRange: [20, 20000], hasGain: false, hasQ: false, defaultFreq: 80,    defaultGain: 0, defaultQ: 0.707 },
  { label: "Lo",   freqRange: [20, 20000], hasGain: true,  hasQ: true,  defaultFreq: 200,   defaultGain: 0, defaultQ: 0.707 },
  { label: "M1",   freqRange: [20, 20000], hasGain: true,  hasQ: true,  defaultFreq: 1000,  defaultGain: 0, defaultQ: 1.0   },
  { label: "M2",   freqRange: [20, 20000], hasGain: true,  hasQ: true,  defaultFreq: 3000,  defaultGain: 0, defaultQ: 1.0   },
  { label: "Hi",   freqRange: [20, 20000], hasGain: true,  hasQ: true,  defaultFreq: 8000,  defaultGain: 0, defaultQ: 0.707 },
  { label: "LPF",  freqRange: [20, 20000], hasGain: false, hasQ: false, defaultFreq: 18000, defaultGain: 0, defaultQ: 0.707 },
];

interface EQBandState {
  freq: number;
  gain: number;
  q: number;
  enabled: boolean;
}

function linToLogFreq(lin: number, minHz: number, maxHz: number): number {
  return minHz * Math.pow(maxHz / minHz, lin);
}

function logFreqToLin(hz: number, minHz: number, maxHz: number): number {
  return Math.log(hz / minHz) / Math.log(maxHz / minHz);
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`;
}

// ── Component ────────────────────────────────────────────────────────

interface ChannelStripEQModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ChannelStripEQModal({ isOpen, onClose }: ChannelStripEQModalProps) {
  const { trackId, tracks } = useDAWStore(
    useShallow((s) => ({
      trackId: s.channelStripEQTrackId,
      tracks: s.tracks,
    })),
  );

  const track = tracks.find((t) => t.id === trackId);

  const [eqEnabled, setEqEnabled] = useState(false);
  const [eqBands, setEqBands] = useState<EQBandState[]>(() =>
    EQ_BANDS.map((b) => ({ freq: b.defaultFreq, gain: b.defaultGain, q: b.defaultQ, enabled: false })),
  );
  const [phaseInverted, setPhaseInverted] = useState(false);
  const [dcOffsetEnabled, setDcOffsetEnabled] = useState(false);
  const prevTrackIdRef = useRef<string | null>(null);

  // Fetch EQ params from backend when modal opens for a track
  useEffect(() => {
    if (!isOpen || !trackId || trackId === prevTrackIdRef.current) return;
    prevTrackIdRef.current = trackId;

    (async () => {
      const bands: EQBandState[] = [];
      for (let i = 0; i < 6; i++) {
        const base = i * 4;
        const freq = await nativeBridge.getChannelStripEQParam(trackId, base);
        const gain = await nativeBridge.getChannelStripEQParam(trackId, base + 1);
        const q = await nativeBridge.getChannelStripEQParam(trackId, base + 2);
        const enabled = await nativeBridge.getChannelStripEQParam(trackId, base + 3);
        bands.push({
          freq: freq > 0 ? freq : EQ_BANDS[i].defaultFreq,
          gain,
          q: q > 0 ? q : EQ_BANDS[i].defaultQ,
          enabled: enabled > 0.5,
        });
      }
      setEqBands(bands);
    })();
  }, [isOpen, trackId]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      prevTrackIdRef.current = null;
    }
  }, [isOpen]);

  const handleEqEnabledToggle = useCallback(() => {
    if (!trackId) return;
    const next = !eqEnabled;
    setEqEnabled(next);
    nativeBridge.setChannelStripEQEnabled(trackId, next);
  }, [eqEnabled, trackId]);

  const handleEqBandParam = useCallback(
    (bandIndex: number, offset: number, value: number) => {
      if (!trackId) return;
      const paramIndex = bandIndex * 4 + offset;
      nativeBridge.setChannelStripEQParam(trackId, paramIndex, value);
      setEqBands((prev) => {
        const next = [...prev];
        const band = { ...next[bandIndex] };
        if (offset === 0) band.freq = value;
        else if (offset === 1) band.gain = value;
        else if (offset === 2) band.q = value;
        else if (offset === 3) band.enabled = value > 0.5;
        next[bandIndex] = band;
        return next;
      });
    },
    [trackId],
  );

  const handlePhaseInvert = useCallback(() => {
    setPhaseInverted((p) => !p);
  }, []);

  const handleDcOffsetToggle = useCallback(() => {
    if (!trackId) return;
    const next = !dcOffsetEnabled;
    setDcOffsetEnabled(next);
    nativeBridge.setTrackDCOffset(trackId, next);
  }, [dcOffsetEnabled, trackId]);

  if (!isOpen || !track) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`EQ — ${track.name}`}
      size="lg"
    >
      <div className="space-y-4">
        {/* Top row: EQ enable + Phase + DC */}
        <div className="flex items-center justify-between">
          <button
            onClick={handleEqEnabledToggle}
            className={classNames(
              "h-7 px-4 rounded text-xs font-bold flex items-center justify-center cursor-pointer transition-colors border",
              eqEnabled
                ? "border-green-500 text-green-400 bg-neutral-800"
                : "border-neutral-600 text-neutral-500 bg-neutral-800 hover:border-green-500",
            )}
          >
            {eqEnabled ? "EQ ON" : "EQ OFF"}
          </button>

          <div className="flex items-center gap-3">
            <button
              onClick={handlePhaseInvert}
              title="Phase Invert"
              className={classNames(
                "h-7 px-3 rounded text-xs font-bold flex items-center gap-1 cursor-pointer transition-colors border",
                phaseInverted
                  ? "border-yellow-500 text-yellow-400 bg-neutral-800"
                  : "border-neutral-600 text-neutral-500 bg-neutral-800 hover:border-yellow-500 hover:text-yellow-500",
              )}
            >
              <span className="text-sm">Ø</span> Phase
            </button>

            <label
              className={classNames(
                "flex items-center gap-2 h-7 px-3 rounded text-xs cursor-pointer transition-colors border",
                dcOffsetEnabled
                  ? "border-blue-500 text-blue-400 bg-neutral-800"
                  : "border-neutral-600 text-neutral-500 bg-neutral-800 hover:border-blue-500",
              )}
              title="DC Offset Filter — removes inaudible sub-20 Hz constant voltage offset that wastes headroom"
            >
              <input
                type="checkbox"
                checked={dcOffsetEnabled}
                onChange={handleDcOffsetToggle}
                className="w-3 h-3 accent-blue-600 cursor-pointer"
              />
              DC Filter
            </label>
          </div>
        </div>

        {/* EQ Bands — horizontal grid */}
        <div className="grid grid-cols-6 gap-2">
          {EQ_BANDS.map((def, i) => {
            const band = eqBands[i];
            const linFreq = logFreqToLin(band.freq, def.freqRange[0], def.freqRange[1]);
            return (
              <div
                key={def.label}
                className={classNames(
                  "rounded-lg border p-2 space-y-2 transition-opacity",
                  band.enabled
                    ? "border-neutral-600 bg-neutral-900/80"
                    : "border-neutral-800 bg-neutral-900/40 opacity-50",
                )}
              >
                {/* Band header: label + enable */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-neutral-300">{def.label}</span>
                  <button
                    onClick={() => handleEqBandParam(i, 3, band.enabled ? 0 : 1)}
                    className={classNames(
                      "h-5 w-5 rounded flex items-center justify-center cursor-pointer transition-colors border",
                      band.enabled
                        ? "border-green-500 text-green-400 bg-neutral-800"
                        : "border-neutral-700 text-neutral-600 bg-neutral-800 hover:border-green-500",
                    )}
                    title={band.enabled ? `Disable ${def.label}` : `Enable ${def.label}`}
                  >
                    <Power size={10} strokeWidth={2.5} />
                  </button>
                </div>

                {/* Freq */}
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between text-[10px] text-neutral-500">
                    <span>Freq</span>
                    <span className="font-mono">{formatHz(band.freq)} Hz</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={linFreq}
                    onChange={(e) => {
                      const hz = linToLogFreq(Number(e.target.value), def.freqRange[0], def.freqRange[1]);
                      handleEqBandParam(i, 0, hz);
                    }}
                    className="w-full h-1.5 accent-daw-accent cursor-pointer"
                  />
                </div>

                {/* Gain */}
                {def.hasGain && (
                  <div className="space-y-0.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-neutral-500">Gain</span>
                      <span className={classNames(
                        "font-mono",
                        band.gain > 0 ? "text-yellow-400" : band.gain < 0 ? "text-blue-400" : "text-neutral-500",
                      )}>
                        {band.gain >= 0 ? "+" : ""}{band.gain.toFixed(1)} dB
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-18}
                      max={18}
                      step={0.1}
                      value={band.gain}
                      onChange={(e) => handleEqBandParam(i, 1, Number(e.target.value))}
                      className="w-full h-1.5 accent-daw-accent cursor-pointer"
                    />
                  </div>
                )}

                {/* Q */}
                {def.hasQ && (
                  <div className="space-y-0.5">
                    <div className="flex items-center justify-between text-[10px] text-neutral-500">
                      <span>Q</span>
                      <span className="font-mono">{band.q.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0.1}
                      max={10}
                      step={0.01}
                      value={band.q}
                      onChange={(e) => handleEqBandParam(i, 2, Number(e.target.value))}
                      className="w-full h-1.5 accent-daw-accent cursor-pointer"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

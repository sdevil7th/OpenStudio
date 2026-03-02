import { useState, useEffect, useRef, useCallback } from "react";
import { nativeBridge } from "../services/NativeBridge";

interface LoudnessMeterProps {
  width?: number;
  height?: number;
}

interface LoudnessData {
  momentary: number; // LUFS (short-term, ~400ms)
  shortTerm: number; // LUFS (~3s integration)
  integrated: number; // LUFS (entire program)
  range: number; // LU (loudness range)
  truePeak: number; // dBTP
}

/**
 * LoudnessMeter (Sprint 20.9)
 * Displays LUFS metering data from the backend AudioAnalyzer.
 * Shows momentary, short-term, integrated loudness, range, and true peak.
 */
export function LoudnessMeter({ width = 200, height = 120 }: LoudnessMeterProps) {
  const [data, setData] = useState<LoudnessData>({
    momentary: -Infinity,
    shortTerm: -Infinity,
    integrated: -Infinity,
    range: 0,
    truePeak: -Infinity,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchLoudness = useCallback(async () => {
    try {
      const result = await nativeBridge.getLoudnessData();
      if (result) {
        setData({
          momentary: result.momentary ?? -Infinity,
          shortTerm: result.shortTerm ?? -Infinity,
          integrated: result.integrated ?? -Infinity,
          range: result.range ?? 0,
          truePeak: result.truePeak ?? -Infinity,
        });
      }
    } catch {
      // Backend not available
    }
  }, []);

  useEffect(() => {
    intervalRef.current = setInterval(fetchLoudness, 200);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchLoudness]);

  const formatLUFS = (val: number) =>
    isFinite(val) ? val.toFixed(1) : "-inf";
  const formatdB = (val: number) =>
    isFinite(val) ? val.toFixed(1) : "-inf";

  // Color based on loudness level
  const getLevelColor = (lufs: number): string => {
    if (!isFinite(lufs)) return "#333";
    if (lufs > -8) return "#ef4444"; // Red - too loud
    if (lufs > -14) return "#eab308"; // Yellow - caution
    return "#22c55e"; // Green - OK
  };

  // Meter bar width (map -60..0 LUFS to 0..100%)
  const getMeterWidth = (lufs: number): number => {
    if (!isFinite(lufs)) return 0;
    return Math.max(0, Math.min(100, ((lufs + 60) / 60) * 100));
  };

  return (
    <div
      className="bg-daw-dark border border-daw-border rounded p-2 flex flex-col gap-1"
      style={{ width, minHeight: height }}
    >
      <div className="text-[10px] text-daw-text-muted font-semibold uppercase tracking-wide mb-1">
        Loudness (LUFS)
      </div>

      {/* Momentary */}
      <MeterRow
        label="M"
        value={formatLUFS(data.momentary)}
        barWidth={getMeterWidth(data.momentary)}
        barColor={getLevelColor(data.momentary)}
      />

      {/* Short-term */}
      <MeterRow
        label="S"
        value={formatLUFS(data.shortTerm)}
        barWidth={getMeterWidth(data.shortTerm)}
        barColor={getLevelColor(data.shortTerm)}
      />

      {/* Integrated */}
      <MeterRow
        label="I"
        value={formatLUFS(data.integrated)}
        barWidth={getMeterWidth(data.integrated)}
        barColor={getLevelColor(data.integrated)}
      />

      {/* Range */}
      <div className="flex items-center gap-1 mt-1">
        <span className="text-[10px] text-daw-text-muted w-4">LRA</span>
        <span className="text-[10px] text-daw-text tabular-nums">
          {data.range.toFixed(1)} LU
        </span>
      </div>

      {/* True Peak */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-daw-text-muted w-4">TP</span>
        <span
          className={`text-[10px] tabular-nums ${
            data.truePeak > -1 ? "text-red-400" : "text-daw-text"
          }`}
        >
          {formatdB(data.truePeak)} dBTP
        </span>
      </div>
    </div>
  );
}

function MeterRow({
  label,
  value,
  barWidth,
  barColor,
}: {
  label: string;
  value: string;
  barWidth: number;
  barColor: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-daw-text-muted w-3">{label}</span>
      <div className="flex-1 h-3 bg-daw-panel rounded overflow-hidden">
        <div
          className="h-full rounded transition-all duration-100"
          style={{
            width: `${barWidth}%`,
            backgroundColor: barColor,
          }}
        />
      </div>
      <span className="text-[10px] text-daw-text tabular-nums w-10 text-right">
        {value}
      </span>
    </div>
  );
}

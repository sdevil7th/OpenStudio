import { useState, useEffect, useRef, useCallback } from "react";
import { nativeBridge, PitchCorrectorData, PitchHistoryFrame } from "../services/NativeBridge";
import { FACTORY_PRESETS, PRESET_CATEGORIES, PitchCorrectorPreset } from "./pitchCorrectorPresets";

// Scale names matching C++ PitchMapper::Scale enum
const SCALE_NAMES = [
  "Chromatic", "Major", "Natural Minor", "Harmonic Minor", "Melodic Minor",
  "Pentatonic Major", "Pentatonic Minor", "Blues", "Dorian", "Mixolydian",
  "Lydian", "Phrygian", "Locrian", "Whole Tone", "Diminished", "Custom",
];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Scale intervals for each scale type (matches C++ exactly)
const SCALE_INTERVALS: boolean[][] = [
  [true, true, true, true, true, true, true, true, true, true, true, true],       // Chromatic
  [true, false, true, false, true, true, false, true, false, true, false, true],   // Major
  [true, false, true, true, false, true, false, true, true, false, true, false],   // Natural Minor
  [true, false, true, true, false, true, false, true, true, false, false, true],   // Harmonic Minor
  [true, false, true, true, false, true, false, true, false, true, false, true],   // Melodic Minor
  [true, false, true, false, true, false, false, true, false, true, false, false], // Pentatonic Major
  [true, false, false, true, false, true, false, true, false, false, true, false], // Pentatonic Minor
  [true, false, false, true, false, true, true, true, false, false, true, false],  // Blues
  [true, false, true, true, false, true, false, true, false, true, true, false],   // Dorian
  [true, false, true, false, true, true, false, true, false, true, true, false],   // Mixolydian
  [true, false, true, false, true, false, true, true, false, true, false, true],   // Lydian
  [true, true, false, true, false, true, false, true, true, false, true, false],   // Phrygian
  [true, true, false, true, false, true, true, false, true, false, true, false],   // Locrian
  [true, false, true, false, true, false, true, false, true, false, true, false],  // Whole Tone
  [true, false, true, true, false, true, true, false, true, true, false, true],    // Diminished
  [true, true, true, true, true, true, true, true, true, true, true, true],       // Custom
];

// Smooth lerp for animated range transitions
const RANGE_SMOOTH = 0.08;

interface PitchCorrectorPanelProps {
  trackId: string;
  fxIndex: number;
  onClose?: () => void;
  onOpenGraphicalEditor?: () => void;
}

function Knob({ label, value, min, max, step, unit, onChange, formatValue, tooltip }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
  tooltip?: string;
}) {
  const display = formatValue ? formatValue(value) : `${Math.round(value)}${unit || ""}`;
  return (
    <div className="flex flex-col items-center gap-1" title={tooltip || `${label}: ${display}`}>
      <label className="text-[9px] text-neutral-500 uppercase tracking-wider">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step || 1}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-16 h-1 accent-blue-500"
        style={{ writingMode: "horizontal-tb" }}
      />
      <span className="text-[10px] text-neutral-300 font-mono">{display}</span>
    </div>
  );
}

export function PitchCorrectorPanel({ trackId, fxIndex, onClose, onOpenGraphicalEditor }: PitchCorrectorPanelProps) {
  const [data, setData] = useState<PitchCorrectorData | null>(null);
  const [history, setHistory] = useState<PitchHistoryFrame[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Smooth animated pitch range (lerped each frame for fluid display)
  const smoothRangeRef = useRef({ min: 48, max: 72 });

  // Preset & A/B state
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [abSlot, setAbSlot] = useState<"A" | "B">("A");
  const [slotA, setSlotA] = useState<PitchCorrectorPreset["params"] | null>(null);
  const [slotB, setSlotB] = useState<PitchCorrectorPreset["params"] | null>(null);

  // Responsive canvas size
  const [canvasWidth, setCanvasWidth] = useState(500);

  // Observe container width for responsive layout
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setCanvasWidth(Math.max(200, Math.floor(w - 16))); // 16px for px-2 padding
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Poll pitch data at ~30fps
  useEffect(() => {
    const poll = async () => {
      const d = await nativeBridge.getPitchCorrectorData(trackId, fxIndex);
      if (d) setData(d);
      const h = await nativeBridge.getPitchHistory(trackId, fxIndex, 256);
      if (h) setHistory(h);
    };

    pollRef.current = setInterval(poll, 33);
    poll();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [trackId, fxIndex]);

  // Draw pitch display with high-DPI support and smooth range animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvasWidth;
      const cssH = 120;

      // High-DPI: set canvas buffer size to match device pixels
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      const w = cssW;
      const h = cssH;
      ctx.clearRect(0, 0, w, h);

      // Background
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, w, h);

      if (history.length === 0) {
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }

      // Find target pitch range
      let targetMin = 127, targetMax = 0;
      for (const f of history) {
        if (f.detected > 0) {
          targetMin = Math.min(targetMin, f.detected);
          targetMax = Math.max(targetMax, f.detected);
        }
        if (f.corrected > 0) {
          targetMin = Math.min(targetMin, f.corrected);
          targetMax = Math.max(targetMax, f.corrected);
        }
      }

      if (targetMin > targetMax) {
        targetMin = 48;
        targetMax = 72;
      }

      targetMin = Math.floor(targetMin) - 2;
      targetMax = Math.ceil(targetMax) + 2;

      // Smooth lerp the display range for fluid transitions
      const sr = smoothRangeRef.current;
      sr.min += (targetMin - sr.min) * RANGE_SMOOTH;
      sr.max += (targetMax - sr.max) * RANGE_SMOOTH;

      const minMidi = sr.min;
      const maxMidi = sr.max;
      const midiRange = maxMidi - minMidi;

      if (midiRange < 1) {
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }

      // Draw horizontal grid lines (semitones)
      for (let m = Math.ceil(minMidi); m <= Math.floor(maxMidi); m++) {
        const y = h - ((m - minMidi) / midiRange) * h;

        // Alternating semitone background bands
        const noteIdx = ((m % 12) + 12) % 12;
        const isWhiteKey = [0, 2, 4, 5, 7, 9, 11].includes(noteIdx);
        if (!isWhiteKey) {
          ctx.fillStyle = "rgba(255,255,255,0.015)";
          ctx.fillRect(0, y - (h / midiRange) * 0.5, w, h / midiRange);
        }

        ctx.strokeStyle = "#1a1a1a";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        // Note name labels
        ctx.fillStyle = isWhiteKey ? "#444" : "#333";
        ctx.font = "9px monospace";
        ctx.fillText(NOTE_NAMES[noteIdx] + (Math.floor(m / 12) - 1), 2, y - 2);
      }

      const step = w / history.length;

      // Draw detected pitch (orange) with line glow
      ctx.save();
      ctx.shadowColor = "#f59e0b";
      ctx.shadowBlur = 3;
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < history.length; i++) {
        const f = history[i];
        if (f.detected <= 0 || f.confidence < 0.3) {
          started = false;
          continue;
        }
        const x = i * step;
        const y = h - ((f.detected - minMidi) / midiRange) * h;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // Draw corrected pitch (green) with line glow
      ctx.save();
      ctx.shadowColor = "#22c55e";
      ctx.shadowBlur = 4;
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 2;
      ctx.beginPath();
      started = false;
      for (let i = 0; i < history.length; i++) {
        const f = history[i];
        if (f.corrected <= 0 || f.confidence < 0.3) {
          started = false;
          continue;
        }
        const x = i * step;
        const y = h - ((f.corrected - minMidi) / midiRange) * h;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // Current pitch indicator (right edge dot)
      const lastFrame = history[history.length - 1];
      if (lastFrame && lastFrame.corrected > 0 && lastFrame.confidence > 0.3) {
        const cy = h - ((lastFrame.corrected - minMidi) / midiRange) * h;
        ctx.beginPath();
        ctx.arc(w - 4, cy, 3, 0, Math.PI * 2);
        ctx.fillStyle = "#22c55e";
        ctx.fill();
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [history, canvasWidth]);

  const setParam = useCallback((param: string, value: number) => {
    nativeBridge.setPitchCorrectorParam(trackId, fxIndex, param, value);
  }, [trackId, fxIndex]);

  // Capture current params as a snapshot
  const captureCurrentParams = useCallback((): PitchCorrectorPreset["params"] | null => {
    if (!data) return null;
    return {
      key: data.key, scale: data.scale, retuneSpeed: data.retuneSpeed,
      correctionStrength: data.correctionStrength, humanize: data.humanize,
      formantCorrection: data.formantCorrection, formantShift: data.formantShift,
      mix: data.mix, transpose: data.transpose, noteEnables: [...data.noteEnables],
    };
  }, [data]);

  // Apply a preset's params to the backend
  const applyPresetParams = useCallback((params: PitchCorrectorPreset["params"]) => {
    if (params.key !== undefined) setParam("key", params.key);
    if (params.scale !== undefined) setParam("scale", params.scale);
    setParam("retuneSpeed", params.retuneSpeed);
    setParam("correctionStrength", params.correctionStrength);
    setParam("humanize", params.humanize);
    setParam("formantCorrection", params.formantCorrection ? 1 : 0);
    setParam("formantShift", params.formantShift);
    setParam("mix", params.mix);
    if (params.transpose !== undefined) setParam("transpose", params.transpose);
    if (params.noteEnables) {
      for (let i = 0; i < 12; i++) {
        setParam(`noteEnable_${i}`, params.noteEnables[i] ? 1 : 0);
      }
    }
  }, [setParam]);

  const loadPreset = useCallback((preset: PitchCorrectorPreset) => {
    const current = captureCurrentParams();
    if (abSlot === "A") setSlotA(current);
    else setSlotB(current);

    applyPresetParams(preset.params);
    setActivePreset(preset.name);
    setShowPresetMenu(false);
  }, [captureCurrentParams, abSlot, applyPresetParams]);

  // A/B toggle
  const toggleAB = useCallback(() => {
    const current = captureCurrentParams();
    if (abSlot === "A") {
      setSlotA(current);
      if (slotB) applyPresetParams(slotB);
      setAbSlot("B");
    } else {
      setSlotB(current);
      if (slotA) applyPresetParams(slotA);
      setAbSlot("A");
    }
  }, [captureCurrentParams, abSlot, slotA, slotB, applyPresetParams]);

  // Save user preset
  const saveUserPreset = useCallback(async () => {
    const params = captureCurrentParams();
    if (!params) return;
    const path = await nativeBridge.showSaveDialog("preset.ospreset", "Save Preset", "*.ospreset");
    if (!path) return;
    const preset: PitchCorrectorPreset = {
      name: path.split(/[/\\]/).pop()?.replace(/\.ospreset$/i, "") || "User Preset",
      category: "User",
      params,
    };
    await nativeBridge.saveProjectToFile(path, JSON.stringify(preset, null, 2));
  }, [captureCurrentParams]);

  // Load user preset
  const loadUserPreset = useCallback(async () => {
    const path = await nativeBridge.showOpenDialog("Load Preset", "*.ospreset;*.s13preset");
    if (!path) return;
    const json = await nativeBridge.loadProjectFromFile(path);
    if (!json) return;
    try {
      const preset = JSON.parse(json) as PitchCorrectorPreset;
      if (preset.params) {
        applyPresetParams(preset.params);
        setActivePreset(preset.name);
      }
    } catch { /* invalid preset file */ }
    setShowPresetMenu(false);
  }, [applyPresetParams]);

  const key = data?.key ?? 0;
  const scale = data?.scale ?? 0;
  const retuneSpeed = data?.retuneSpeed ?? 50;
  const humanize = data?.humanize ?? 0;
  const transpose = data?.transpose ?? 0;
  const correctionStrength = data?.correctionStrength ?? 1;
  const formantCorrection = data?.formantCorrection ?? false;
  const formantShift = data?.formantShift ?? 0;
  const mixVal = data?.mix ?? 1;
  const midiOutput = data?.midiOutput ?? false;
  const midiChannel = data?.midiChannel ?? 1;
  const noteEnables = data?.noteEnables ?? Array(12).fill(true);

  // Auto-populate note enables when scale changes
  const handleScaleChange = (newScale: number) => {
    setParam("scale", newScale);
    if (newScale < SCALE_INTERVALS.length && newScale !== 15) { // 15 = Custom
      const intervals = SCALE_INTERVALS[newScale];
      for (let i = 0; i < 12; i++) {
        const noteIdx = (i + key) % 12;
        setParam(`noteEnable_${noteIdx}`, intervals[i] ? 1 : 0);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className="bg-neutral-900 border border-neutral-700 rounded-lg overflow-hidden"
      style={{ width: "100%", minWidth: 360, maxWidth: 600 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-neutral-800 border-b border-neutral-700 flex-wrap gap-1">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <span className="text-[11px] font-semibold text-neutral-200">OpenStudio Pitch Correct</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Preset selector */}
          <div className="relative">
            <button
              className="px-2 py-0.5 text-[9px] bg-neutral-700 text-neutral-300 rounded hover:bg-neutral-600 max-w-24 truncate"
              onClick={() => setShowPresetMenu(!showPresetMenu)}
              title={activePreset ? `Current preset: ${activePreset}` : "Browse and load presets"}
            >
              {activePreset || "Presets"}
            </button>
            {showPresetMenu && (
              <div className="absolute top-full right-0 mt-1 z-50 bg-neutral-800 border border-neutral-600 rounded shadow-xl py-1 w-48 max-h-64 overflow-y-auto">
                {/* User preset save/load */}
                <div className="flex gap-1 px-2 py-1 border-b border-neutral-700">
                  <button
                    className="flex-1 text-[9px] text-neutral-400 hover:text-white bg-neutral-700 rounded px-1 py-0.5"
                    onClick={saveUserPreset}
                    title="Save current settings as an .ospreset file"
                  >Save...</button>
                  <button
                    className="flex-1 text-[9px] text-neutral-400 hover:text-white bg-neutral-700 rounded px-1 py-0.5"
                    onClick={loadUserPreset}
                    title="Load an .ospreset or legacy .s13preset file from disk"
                  >Load...</button>
                </div>
                {/* Factory presets by category */}
                {PRESET_CATEGORIES.map(cat => (
                  <div key={cat}>
                    <div className="text-[8px] text-neutral-500 uppercase tracking-wider px-2 pt-1.5">{cat}</div>
                    {FACTORY_PRESETS.filter(p => p.category === cat).map(p => (
                      <button
                        key={p.name}
                        className={`block w-full text-left text-[10px] px-2 py-0.5 hover:bg-neutral-700 ${
                          activePreset === p.name ? "text-blue-400" : "text-neutral-300"
                        }`}
                        onClick={() => loadPreset(p)}
                        title={`${p.name} — Speed: ${p.params.retuneSpeed}ms, Strength: ${Math.round(p.params.correctionStrength * 100)}%`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* A/B comparison */}
          <button
            className={`px-1.5 py-0.5 text-[9px] rounded font-bold border transition-colors ${
              abSlot === "A"
                ? "bg-blue-600/20 text-blue-400 border-blue-500/50"
                : "bg-orange-600/20 text-orange-400 border-orange-500/50"
            }`}
            onClick={toggleAB}
            title={`A/B comparison — currently on slot ${abSlot}. Click to switch.`}
          >
            {abSlot}
          </button>

          {onOpenGraphicalEditor && (
            <button
              className="px-2 py-0.5 text-[9px] bg-blue-700 text-white rounded hover:bg-blue-600"
              onClick={onOpenGraphicalEditor}
              title="Open graphical pitch editor for detailed note-by-note editing"
            >
              Graph
            </button>
          )}
          {/* Current note display */}
          <div className="bg-neutral-900 px-2 py-0.5 rounded border border-neutral-700" title="Currently detected note and cents deviation">
            <span className="text-[14px] font-bold font-mono text-green-400">
              {data?.noteName || "--"}
            </span>
            <span className="text-[9px] text-neutral-500 ml-1">
              {data && data.centsDeviation !== 0
                ? `${data.centsDeviation > 0 ? "+" : ""}${Math.round(data.centsDeviation)}c`
                : ""}
            </span>
          </div>
          {/* Confidence */}
          <div className="flex items-center gap-1" title={`Detection confidence: ${Math.round((data?.confidence ?? 0) * 100)}%`}>
            <div className="w-12 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-150"
                style={{
                  width: `${(data?.confidence ?? 0) * 100}%`,
                  backgroundColor: (data?.confidence ?? 0) > 0.7 ? "#22c55e" : (data?.confidence ?? 0) > 0.4 ? "#f59e0b" : "#ef4444",
                }}
              />
            </div>
            <span className="text-[8px] text-neutral-500">{Math.round((data?.confidence ?? 0) * 100)}%</span>
          </div>
          {onClose && (
            <button onClick={onClose} className="text-neutral-500 hover:text-white text-[12px] px-1" title="Close pitch corrector panel">✕</button>
          )}
        </div>
      </div>

      {/* Pitch Display Canvas */}
      <div className="px-2 pt-2">
        <canvas
          ref={canvasRef}
          className="w-full rounded border border-neutral-800"
          style={{ height: 120 }}
        />
        <div className="flex justify-between text-[8px] text-neutral-600 mt-0.5 px-1">
          <span>● Detected</span>
          <span style={{ color: "#f59e0b" }}>━ Detected</span>
          <span style={{ color: "#22c55e" }}>━ Corrected</span>
        </div>
      </div>

      {/* Key & Scale */}
      <div className="px-3 pt-3 flex gap-3 items-end flex-wrap">
        <div className="flex-1 min-w-[80px]">
          <label className="text-[9px] text-neutral-500 block mb-1 uppercase tracking-wider">Key</label>
          <select
            value={key}
            onChange={(e) => setParam("key", parseInt(e.target.value))}
            className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200"
            title="Root key for scale-based correction"
          >
            {NOTE_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-[120px]">
          <label className="text-[9px] text-neutral-500 block mb-1 uppercase tracking-wider">Scale</label>
          <select
            value={scale}
            onChange={(e) => handleScaleChange(parseInt(e.target.value))}
            className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200"
            title="Scale mode — determines which notes pitch is corrected to"
          >
            {SCALE_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
          </select>
        </div>
        <div className="min-w-[80px]">
          <label className="text-[9px] text-neutral-500 block mb-1 uppercase tracking-wider">Transpose</label>
          <select
            value={transpose}
            onChange={(e) => setParam("transpose", parseInt(e.target.value))}
            className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200"
            title="Transpose corrected output up or down in semitones"
          >
            {Array.from({ length: 49 }, (_, i) => i - 24).map(st => (
              <option key={st} value={st}>{st > 0 ? `+${st}` : st} st</option>
            ))}
          </select>
        </div>
      </div>

      {/* Note Enable Buttons */}
      <div className="px-3 pt-2">
        <label className="text-[9px] text-neutral-500 block mb-1 uppercase tracking-wider">Note Enables</label>
        <div className="flex gap-0.5">
          {NOTE_NAMES.map((name, i) => {
            const noteIdx = (i + key) % 12;
            const isEnabled = noteEnables[noteIdx];
            const isBlack = name.includes("#");
            return (
              <button
                key={i}
                className={`flex-1 py-1.5 rounded text-[9px] font-bold transition-colors border ${
                  isEnabled
                    ? isBlack
                      ? "bg-blue-600/30 text-blue-300 border-blue-500/50"
                      : "bg-blue-600/20 text-blue-300 border-blue-500/40"
                    : "bg-neutral-800 text-neutral-600 border-neutral-700"
                }`}
                onClick={() => setParam(`noteEnable_${noteIdx}`, isEnabled ? 0 : 1)}
                title={`${name}: ${isEnabled ? "Enabled" : "Disabled"} — click to toggle`}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Knobs Row */}
      <div className="px-3 pt-3 pb-2 flex justify-between flex-wrap gap-2">
        <Knob
          label="Retune Speed"
          value={retuneSpeed}
          min={0} max={400} step={1}
          unit="ms"
          onChange={(v) => setParam("retuneSpeed", v)}
          tooltip="How fast pitch snaps to the target note. 0ms = instant (hard tune), higher = more natural"
        />
        <Knob
          label="Strength"
          value={correctionStrength * 100}
          min={0} max={100} step={1}
          unit="%"
          onChange={(v) => setParam("correctionStrength", v / 100)}
          tooltip="How much correction is applied. 100% = full correction, 0% = no correction"
        />
        <Knob
          label="Humanize"
          value={humanize}
          min={0} max={100} step={1}
          unit="%"
          onChange={(v) => setParam("humanize", v)}
          tooltip="Adds natural pitch variation to avoid robotic sound"
        />
        <Knob
          label="Mix"
          value={mixVal * 100}
          min={0} max={100} step={1}
          unit="%"
          onChange={(v) => setParam("mix", v / 100)}
          tooltip="Dry/wet mix. 100% = fully corrected, 0% = original signal"
        />
        <div className="flex flex-col items-center gap-1" title={formantCorrection ? `Formant preservation ON, shift: ${formantShift.toFixed(1)} st` : "Formant preservation OFF — enable to prevent chipmunk effect on large pitch shifts"}>
          <label className="text-[9px] text-neutral-500 uppercase tracking-wider">Formant</label>
          <button
            className={`px-2 py-1 rounded text-[10px] border transition-colors ${
              formantCorrection
                ? "bg-green-600/20 text-green-400 border-green-500/50"
                : "bg-neutral-800 text-neutral-500 border-neutral-700"
            }`}
            onClick={() => setParam("formantCorrection", formantCorrection ? 0 : 1)}
          >
            {formantCorrection ? "ON" : "OFF"}
          </button>
          {formantCorrection && (
            <input
              type="range"
              min={-12} max={12} step={0.1}
              value={formantShift}
              onChange={(e) => setParam("formantShift", parseFloat(e.target.value))}
              className="w-14 h-1 accent-green-500"
              title={`Formant shift: ${formantShift.toFixed(1)} semitones`}
            />
          )}
        </div>
      </div>

      {/* MIDI Output */}
      <div className="px-3 pt-1 pb-2 flex items-center gap-3 border-t border-neutral-800">
        <span className="text-[9px] text-neutral-500 uppercase tracking-wider">MIDI Out</span>
        <button
          className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
            midiOutput
              ? "bg-purple-600/20 text-purple-400 border-purple-500/50"
              : "bg-neutral-800 text-neutral-500 border-neutral-700"
          }`}
          onClick={() => setParam("midiOutput", midiOutput ? 0 : 1)}
          title="Enable MIDI output — sends corrected pitch as MIDI notes with pitch bend"
        >
          {midiOutput ? "ON" : "OFF"}
        </button>
        {midiOutput && (
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-neutral-500">Ch</span>
            <select
              value={midiChannel}
              onChange={(e) => setParam("midiChannel", parseInt(e.target.value))}
              className="bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-[10px] text-neutral-200"
              title="MIDI output channel (1-16)"
            >
              {Array.from({ length: 16 }, (_, i) => i + 1).map(ch => (
                <option key={ch} value={ch}>{ch}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="px-3 py-1.5 border-t border-neutral-800 flex justify-between text-[8px] text-neutral-600 flex-wrap gap-1">
        <span>Detected: {data?.detectedPitch ? `${data.detectedPitch.toFixed(1)} Hz` : "--"}</span>
        <span>Corrected: {data?.correctedPitch ? `${data.correctedPitch.toFixed(1)} Hz` : "--"}</span>
        <span>Latency: ~46ms</span>
      </div>
    </div>
  );
}

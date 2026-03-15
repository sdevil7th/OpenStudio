/**
 * PitchEditorCanvas — Imperative Canvas 2D rendering for the pitch editor lower zone.
 *
 * Handles drawing the grid, notes, contour, playhead, selection, and hover effects.
 * Called from PitchEditorLowerZone via requestAnimationFrame.
 */

import type { PitchNoteData, PitchContourData, PolyNoteData, UnifiedNoteData } from "../services/NativeBridge";
import { polyToUnified, monoToUnified } from "../services/NativeBridge";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
export const PIANO_WIDTH = 30; // small piano reference strip on left edge of canvas

export interface PitchEditorViewport {
  scrollX: number;         // seconds (horizontal offset, same as dawScrollX / pps)
  scrollY: number;         // MIDI note (bottom of viewport)
  pixelsPerSecond: number; // from DAW store (synced with timeline)
  pixelsPerSemitone: number; // vertical zoom
  clipStartTime: number;   // clip offset in project timeline
  clipDuration: number;
}

export interface PitchEditorRenderState {
  notes: PitchNoteData[];
  contour: PitchContourData | null;
  selectedNoteIds: string[];
  hoveredNoteId: string | null;
  currentTime: number;       // transport position (seconds)
  isPlaying: boolean;
  bpm: number;
  timeSignature: [number, number];

  // Scale overlay
  scaleNotes: boolean[];     // 12 booleans
  scaleKey: number;          // 0-11

  // Polyphonic mode
  polyMode: boolean;
  polyNotes: PolyNoteData[];
  showPitchSalience: boolean;
  pitchSalience: number[][] | null; // downsampled [T][264]
  salienceDownsampleFactor: number;
  salienceHopSize: number;
  salienceSampleRate: number;
}

// Convert a MIDI note to Y position on canvas
function midiToY(midi: number, viewport: PitchEditorViewport, canvasHeight: number): number {
  const visibleSemitones = canvasHeight / viewport.pixelsPerSemitone;
  const topMidi = viewport.scrollY + visibleSemitones;
  return (topMidi - midi) * viewport.pixelsPerSemitone;
}

// Convert clip-relative time (seconds) to X position on canvas.
// Note/contour times are relative to clip start (0 = start of clip).
// viewport.scrollX is in project-seconds, so we add clipStartTime.
function timeToX(clipTime: number, viewport: PitchEditorViewport): number {
  const projectTime = viewport.clipStartTime + clipTime;
  return PIANO_WIDTH + (projectTime - viewport.scrollX) * viewport.pixelsPerSecond;
}

// Convert project-absolute time to X (for playhead, beat grid — already in project time)
function projectTimeToX(projectTime: number, viewport: PitchEditorViewport): number {
  return PIANO_WIDTH + (projectTime - viewport.scrollX) * viewport.pixelsPerSecond;
}

// Convert X position to clip-relative time
export function xToTime(x: number, viewport: PitchEditorViewport): number {
  const projectTime = (x - PIANO_WIDTH) / viewport.pixelsPerSecond + viewport.scrollX;
  return projectTime - viewport.clipStartTime;
}

// Convert Y position to MIDI note
export function yToMidi(y: number, viewport: PitchEditorViewport, canvasHeight: number): number {
  const visibleSemitones = canvasHeight / viewport.pixelsPerSemitone;
  const topMidi = viewport.scrollY + visibleSemitones;
  return topMidi - y / viewport.pixelsPerSemitone;
}

export type NoteHitZone = "body" | "left" | "right" | "top-center" | "bottom-left" | "bottom-right";

/** Hit-test a point against note rectangles. Returns note ID and zone. */
export function hitTestNote(
  x: number, y: number,
  notes: PitchNoteData[],
  viewport: PitchEditorViewport,
  canvasHeight: number
): { noteId: string; edge: NoteHitZone } | null {
  const EDGE_PX = 6;
  const HANDLE_SIZE = 8;
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    const nx = timeToX(n.startTime, viewport);
    const nx2 = timeToX(n.endTime, viewport);
    const ny = midiToY(n.correctedPitch + 0.5, viewport, canvasHeight);
    const nh = viewport.pixelsPerSemitone;
    if (x >= nx && x <= nx2 && y >= ny && y <= ny + nh) {
      const w = nx2 - nx;
      // Smart control handles (only if note is wide enough)
      if (w > 30 && nh > 8) {
        const midX = nx + w / 2;
        // Top-center handle: straighten/vibrato
        if (Math.abs(x - midX) < HANDLE_SIZE && y - ny < HANDLE_SIZE) {
          return { noteId: n.id, edge: "top-center" };
        }
        // Bottom-left handle: formant
        if (x - nx < HANDLE_SIZE * 1.5 && ny + nh - y < HANDLE_SIZE) {
          return { noteId: n.id, edge: "bottom-left" };
        }
        // Bottom-right handle: gain
        if (nx2 - x < HANDLE_SIZE * 1.5 && ny + nh - y < HANDLE_SIZE) {
          return { noteId: n.id, edge: "bottom-right" };
        }
      }
      // Edge resize
      if (x - nx < EDGE_PX) return { noteId: n.id, edge: "left" };
      if (nx2 - x < EDGE_PX) return { noteId: n.id, edge: "right" };
      return { noteId: n.id, edge: "body" };
    }
  }
  return null;
}

/** Main render function — draws everything on the canvas. */
export function renderPitchEditor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: PitchEditorViewport,
  state: PitchEditorRenderState
) {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);

  // Clear
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, width, height);

  const visibleSemitones = height / viewport.pixelsPerSemitone;
  const bottomMidi = viewport.scrollY;
  const topMidi = bottomMidi + visibleSemitones;
  const minMidi = Math.floor(bottomMidi);
  const maxMidi = Math.ceil(topMidi);

  // Check if a non-chromatic scale is active
  const hasScale = state.scaleNotes.some((v, i) => !v) || false;

  // --- 1. Piano keys + semitone bands ---
  for (let midi = minMidi; midi <= maxMidi; midi++) {
    const y = midiToY(midi + 0.5, viewport, height);
    const h = viewport.pixelsPerSemitone;
    const noteClass = ((midi % 12) + 12) % 12;
    const isBlack = BLACK_KEYS.has(noteClass);
    const inScale = state.scaleNotes[noteClass];
    const isTonic = noteClass === state.scaleKey;

    // Semitone band — dim out-of-scale notes
    if (hasScale && !inScale) {
      ctx.fillStyle = "#111111";
    } else if (hasScale && isTonic) {
      ctx.fillStyle = "#252525";
    } else {
      ctx.fillStyle = isBlack ? "#161616" : "#1e1e1e";
    }
    ctx.fillRect(PIANO_WIDTH, y, width - PIANO_WIDTH, h);

    // Grid line
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = noteClass === 0 ? 1 : 0.5; // C notes get thicker line
    ctx.beginPath();
    ctx.moveTo(PIANO_WIDTH, y + h);
    ctx.lineTo(width, y + h);
    ctx.stroke();

    // Piano key label
    if (y >= -h && y <= height + h) {
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, y, PIANO_WIDTH, h);
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(0, y, PIANO_WIDTH, h);

      if (isBlack) {
        ctx.fillStyle = hasScale && !inScale ? "#222" : "#333";
        ctx.fillRect(0, y, PIANO_WIDTH * 0.65, h);
      }

      // Label for C notes or every few semitones
      if (noteClass === 0 || viewport.pixelsPerSemitone > 14) {
        const octave = Math.floor(midi / 12) - 1;
        const name = NOTE_NAMES[noteClass] + octave;
        const keyBrightness = hasScale ? (inScale ? (isTonic ? "#bbb" : "#999") : "#555") : (isBlack ? "#888" : "#999");
        ctx.fillStyle = keyBrightness;
        ctx.font = "9px Inter, system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(name, PIANO_WIDTH - 3, y + h / 2);
      }
    }
  }

  // Piano key border
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PIANO_WIDTH, 0);
  ctx.lineTo(PIANO_WIDTH, height);
  ctx.stroke();

  // --- 2. Vertical grid lines (beats) ---
  if (state.bpm > 0) {
    const beatDuration = 60 / state.bpm;
    const beatsPerBar = state.timeSignature[0];
    const startTime = viewport.scrollX;
    const endTime = startTime + (width - PIANO_WIDTH) / viewport.pixelsPerSecond;
    const firstBeat = Math.floor(startTime / beatDuration);
    const lastBeat = Math.ceil(endTime / beatDuration);

    for (let b = firstBeat; b <= lastBeat; b++) {
      const t = b * beatDuration;
      const x = projectTimeToX(t, viewport);
      if (x < PIANO_WIDTH || x > width) continue;
      const isBar = b % beatsPerBar === 0;
      ctx.strokeStyle = isBar ? "#3a3a3a" : "#262626";
      ctx.lineWidth = isBar ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  // --- 2.5. Waveform RMS overlay (amplitude envelope behind notes) ---
  if (state.contour?.frames.rms && state.contour.frames.rms.length > 0) {
    const { times, rms, midi: rmsMidi, confidence: rmsConf } = state.contour.frames;
    const startTime = viewport.scrollX - viewport.clipStartTime;
    const endTime = startTime + (width - PIANO_WIDTH) / viewport.pixelsPerSecond;
    // Find the max RMS for normalization
    let maxRms = 0;
    for (const val of rms) {
      if (val > maxRms) maxRms = val;
    }
    if (maxRms > 0) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#60a5fa"; // blue tint
      // Draw RMS bars aligned to pitch position
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        if (t < startTime - 0.1 || t > endTime + 0.1) continue;
        if (rmsConf[i] < 0.1 || rmsMidi[i] <= 0) continue; // skip unvoiced/silent
        const x = timeToX(t, viewport);
        if (x < PIANO_WIDTH || x > width) continue;
        const normalizedRms = rms[i] / maxRms;
        const barHeight = normalizedRms * viewport.pixelsPerSemitone * 3; // scale to ~3 semitones max height
        const y = midiToY(rmsMidi[i], viewport, height);
        const nextT = i + 1 < times.length ? times[i + 1] : t + 0.01;
        const barWidth = Math.max(1, (nextT - t) * viewport.pixelsPerSecond);
        ctx.fillRect(x, y - barHeight / 2, barWidth, barHeight);
      }
      ctx.restore();
    }
  }

  // --- 3. Pitch contour (raw detected pitch) ---
  if (state.contour && state.contour.frames.times.length > 0) {
    const { times, midi: midiArr, confidence: confArr } = state.contour.frames;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(245, 158, 11, 0.35)"; // amber, semi-transparent
    ctx.lineWidth = 1.5;
    let started = false;
    for (let i = 0; i < times.length; i++) {
      const midiVal = midiArr[i];
      const conf = confArr[i];
      if (midiVal <= 0 || conf < 0.3) {
        started = false;
        continue;
      }
      const x = timeToX(times[i], viewport);
      const y = midiToY(midiVal, viewport, height);
      if (x < PIANO_WIDTH - 10 || x > width + 10) { started = false; continue; }
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // --- 3.5. Corrected pitch overlay (white line — shows where notes will actually play) ---
  if (!state.polyMode && state.notes.length > 0 && state.contour && state.contour.frames.times.length > 0) {
    const { times, midi: midiArr, confidence: confArr } = state.contour.frames;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
    ctx.lineWidth = 1.5;
    let corrStarted = false;
    for (let i = 0; i < times.length; i++) {
      const rawMidi = midiArr[i];
      const conf = confArr[i];
      if (rawMidi <= 0 || conf < 0.3) { corrStarted = false; continue; }
      const frameTime = times[i];
      // Find which note this frame falls within
      const note = state.notes.find(n => frameTime >= n.startTime && frameTime <= n.endTime);
      if (note === undefined) { corrStarted = false; continue; }
      // Shift the raw pitch by the correction applied to this note
      const correctedMidi = rawMidi + (note.correctedPitch - note.detectedPitch);
      const x = timeToX(frameTime, viewport);
      const y = midiToY(correctedMidi, viewport, height);
      if (x < PIANO_WIDTH - 10 || x > width + 10) { corrStarted = false; continue; }
      if (corrStarted) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); corrStarted = true; }
    }
    ctx.stroke();
  }

  // --- 3.6. Pitch salience heatmap (polyphonic mode) ---
  if (state.polyMode && state.showPitchSalience && state.pitchSalience && state.pitchSalience.length > 0) {
    const salience = state.pitchSalience;
    const dsFactor = state.salienceDownsampleFactor || 1;
    const hopSec = (state.salienceHopSize || 256) / (state.salienceSampleRate || 22050);
    const frameTimeSec = hopSec * dsFactor;
    const SALIENCE_BINS = salience[0]?.length || 264;
    // 264 bins = 88 notes * 3 (1/3 semitone), MIDI 21-108
    const MIDI_LOW = 21;
    const binsPerSemitone = 3;

    ctx.globalAlpha = 0.3;
    for (let f = 0; f < salience.length; f++) {
      const t = f * frameTimeSec;
      const x = timeToX(t, viewport);
      const xNext = timeToX(t + frameTimeSec, viewport);
      if (xNext < PIANO_WIDTH || x > width) continue;
      const fw = Math.max(1, xNext - x);

      for (let b = 0; b < SALIENCE_BINS; b++) {
        const val = salience[f][b];
        if (val < 20) continue; // skip low energy
        const midi = MIDI_LOW + b / binsPerSemitone;
        const y = midiToY(midi + 0.5 / binsPerSemitone, viewport, height);
        const bh = viewport.pixelsPerSemitone / binsPerSemitone;
        if (y + bh < 0 || y > height) continue;
        // Color: yellow-orange gradient based on intensity
        const intensity = val / 255;
        const r2 = Math.round(255 * intensity);
        const g = Math.round(180 * intensity);
        ctx.fillStyle = `rgb(${r2},${g},0)`;
        ctx.fillRect(x, y, fw, Math.max(1, bh));
      }
    }
    ctx.globalAlpha = 1;
  }

  // --- 4. Note blocks (monophonic or polyphonic) ---
  // 12 hue-based colors for pitch classes in poly mode (rainbow mapping)
  const POLY_NOTE_COLORS = [
    [220, 50, 50],   // C  — red
    [220, 100, 50],  // C# — red-orange
    [220, 160, 30],  // D  — orange
    [180, 180, 30],  // D# — yellow
    [80, 180, 50],   // E  — yellow-green
    [40, 180, 80],   // F  — green
    [30, 180, 160],  // F# — teal
    [40, 140, 200],  // G  — blue
    [60, 100, 220],  // G# — indigo
    [120, 70, 220],  // A  — purple
    [180, 50, 200],  // A# — magenta
    [220, 50, 150],  // B  — pink
  ];

  const notesToRender: UnifiedNoteData[] =
    state.polyMode
      ? state.polyNotes.map(polyToUnified)
      : state.notes.map(n => monoToUnified(n));

  for (const note of notesToRender) {
    const x1 = timeToX(note.startTime, viewport);
    const x2 = timeToX(note.endTime, viewport);
    if (x2 < PIANO_WIDTH || x1 > width) continue; // off-screen

    const y = midiToY(note.correctedPitch + 0.5, viewport, height);
    const h = viewport.pixelsPerSemitone;
    const w = x2 - x1;
    const isSelected = state.selectedNoteIds.includes(note.id);
    const isHovered = state.hoveredNoteId === note.id;
    const isShifted = Math.abs(note.correctedPitch - note.detectedPitch) > 0.1;
    const isUnvoiced = note.voiced === false;

    // Note fill — poly mode uses pitch-class rainbow colors with confidence-based opacity
    if (note.isPoly) {
      const pitchClass = ((Math.round(note.detectedPitch) % 12) + 12) % 12;
      const [cr, cg, cb] = POLY_NOTE_COLORS[pitchClass];
      const confAlpha = 0.3 + (note.confidence ?? 0.5) * 0.55; // 0.3–0.85 based on confidence
      if (isSelected) {
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${Math.min(1, confAlpha + 0.2)})`;
      } else if (isShifted) {
        // Slightly brighter when shifted
        ctx.fillStyle = `rgba(${Math.min(255, cr + 30)}, ${Math.min(255, cg + 30)}, ${Math.min(255, cb + 30)}, ${confAlpha})`;
      } else {
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${confAlpha})`;
      }
    } else {
      const alpha = 0.75;
      if (isUnvoiced) {
        ctx.fillStyle = `rgba(100, 100, 100, 0.4)`; // gray for unvoiced
      } else if (isSelected) {
        ctx.fillStyle = `rgba(59, 130, 246, ${alpha})`; // blue
      } else if (isShifted) {
        ctx.fillStyle = `rgba(245, 158, 11, ${alpha})`; // amber
      } else {
        ctx.fillStyle = `rgba(34, 197, 94, ${alpha})`; // green
      }
    }

    // Rounded rect
    const r = Math.min(3, h / 4, w / 4);
    ctx.beginPath();
    ctx.moveTo(x1 + r, y);
    ctx.lineTo(x2 - r, y);
    ctx.quadraticCurveTo(x2, y, x2, y + r);
    ctx.lineTo(x2, y + h - r);
    ctx.quadraticCurveTo(x2, y + h, x2 - r, y + h);
    ctx.lineTo(x1 + r, y + h);
    ctx.quadraticCurveTo(x1, y + h, x1, y + h - r);
    ctx.lineTo(x1, y + r);
    ctx.quadraticCurveTo(x1, y, x1 + r, y);
    ctx.closePath();
    ctx.fill();

    // Diagonal hatching for unvoiced notes (Melodyne-style)
    if (isUnvoiced && w > 4) {
      ctx.save();
      ctx.clip(); // clip to the rounded rect path
      ctx.strokeStyle = "rgba(150, 150, 150, 0.3)";
      ctx.lineWidth = 0.5;
      const spacing = 6;
      for (let hx = -h; hx < w + h; hx += spacing) {
        ctx.beginPath();
        ctx.moveTo(x1 + hx, y);
        ctx.lineTo(x1 + hx + h, y + h);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Border — poly notes always get a thin border for overlap visibility
    if (isSelected || isHovered) {
      ctx.strokeStyle = isSelected ? "#60a5fa" : "#888";
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.stroke();
    } else if (note.isPoly) {
      const pitchClass = ((Math.round(note.detectedPitch) % 12) + 12) % 12;
      const [br, bg, bb] = POLY_NOTE_COLORS[pitchClass];
      ctx.strokeStyle = `rgba(${br}, ${bg}, ${bb}, 0.6)`;
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }

    // Pitch curves inside note blob (clipped to blob bounds)
    if (w > 10 && !isUnvoiced) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, y, w, h);
      ctx.clip();

      // Draw original pitch contour from frame data (faint)
      if (state.contour && state.contour.frames.times.length > 0 && !state.polyMode) {
        const { times, midi: midiArr, confidence: confArr } = state.contour.frames;
        ctx.beginPath();
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1;
        let started = false;
        for (let fi = 0; fi < times.length; fi++) {
          const ft = times[fi];
          if (ft < note.startTime - 0.01 || ft > note.endTime + 0.01) continue;
          const rawMidi = midiArr[fi];
          if (rawMidi <= 0 || confArr[fi] < 0.3) { started = false; continue; }
          const px = timeToX(ft, viewport);
          const py = midiToY(rawMidi, viewport, height);
          if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
        }
        ctx.stroke();
      }

      // Draw corrected pitch contour (bold white — shows where audio will play)
      if (state.contour && state.contour.frames.times.length > 0 && !state.polyMode) {
        const { times, midi: midiArr, confidence: confArr } = state.contour.frames;
        ctx.beginPath();
        ctx.strokeStyle = isSelected ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1.5;
        let started = false;
        const pitchShift = note.correctedPitch - note.detectedPitch;
        for (let fi = 0; fi < times.length; fi++) {
          const ft = times[fi];
          if (ft < note.startTime - 0.01 || ft > note.endTime + 0.01) continue;
          const rawMidi = midiArr[fi];
          if (rawMidi <= 0 || confArr[fi] < 0.3) { started = false; continue; }
          const corrMidi = rawMidi + pitchShift;
          const px = timeToX(ft, viewport);
          const py = midiToY(corrMidi, viewport, height);
          if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
        }
        ctx.stroke();
      }

      // Fallback: draw drift curve if no contour data available
      if ((state.contour === null || state.polyMode) && note.pitchDrift && note.pitchDrift.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = isSelected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.2)";
        ctx.lineWidth = 1;
        for (let i = 0; i < note.pitchDrift.length; i++) {
          const t = note.startTime + (i / (note.pitchDrift.length - 1)) * (note.endTime - note.startTime);
          const px = timeToX(t, viewport);
          const drift = note.pitchDrift[i];
          const py = midiToY(note.correctedPitch + drift, viewport, height);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      ctx.restore();
    }

    // Note name label inside block (if wide enough)
    if (w > 30 && h > 10) {
      const noteClass = Math.round(note.correctedPitch) % 12;
      const octave = Math.floor(Math.round(note.correctedPitch) / 12) - 1;
      const label = NOTE_NAMES[noteClass < 0 ? noteClass + 12 : noteClass] + octave;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = `${Math.min(10, h - 2)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x1 + 4, y + h / 2);
    }

    // Smart control handles on hover (VariAudio-style)
    if (isHovered && w > 30 && h > 8 && !isUnvoiced) {
      const hs = 5; // handle size
      const handleColor = "rgba(255,255,255,0.6)";
      const midX = x1 + w / 2;

      // Top-center: straighten/vibrato (triangle up)
      ctx.fillStyle = handleColor;
      ctx.beginPath();
      ctx.moveTo(midX - hs, y + hs + 1);
      ctx.lineTo(midX, y + 1);
      ctx.lineTo(midX + hs, y + hs + 1);
      ctx.closePath();
      ctx.fill();

      // Bottom-left: formant (small diamond)
      ctx.beginPath();
      const blx = x1 + hs + 2;
      const bly = y + h - hs - 1;
      ctx.moveTo(blx, bly - hs / 2);
      ctx.lineTo(blx + hs / 2, bly);
      ctx.lineTo(blx, bly + hs / 2);
      ctx.lineTo(blx - hs / 2, bly);
      ctx.closePath();
      ctx.fill();

      // Bottom-right: gain (small square)
      const brx = x2 - hs - 4;
      const bry = y + h - hs - 2;
      ctx.fillRect(brx, bry, hs, hs);
    }
  }

  // --- 4.5. Transition curves between adjacent notes ---
  if (!state.polyMode) {
    const monoNotes = state.notes;
    for (let i = 0; i < monoNotes.length - 1; i++) {
      const n1 = monoNotes[i];
      const n2 = monoNotes[i + 1];
      const gap = n2.startTime - n1.endTime;
      if (gap > 0.1) continue; // too far apart
      const hasTransition = n1.transitionOut > 0 || n2.transitionIn > 0;
      if (!hasTransition) continue;

      const transMs = Math.max(n1.transitionOut, n2.transitionIn);
      const transSec = transMs / 1000;
      const x1 = timeToX(n1.endTime - transSec / 2, viewport);
      const x2 = timeToX(n2.startTime + transSec / 2, viewport);
      const y1 = midiToY(n1.correctedPitch, viewport, height);
      const y2 = midiToY(n2.correctedPitch, viewport, height);

      if (x2 < PIANO_WIDTH || x1 > width) continue;

      ctx.beginPath();
      ctx.strokeStyle = "rgba(245, 158, 11, 0.6)";
      ctx.lineWidth = 2;
      const midX = (x1 + x2) / 2;
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(midX, y1, midX, y2, x2, y2);
      ctx.stroke();
    }
  }

  // --- 5. Playhead (currentTime is in project time, not clip-relative) ---
  if (state.currentTime >= 0) {
    const px = projectTimeToX(state.currentTime, viewport);
    if (px >= PIANO_WIDTH && px <= width) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * Lightweight playhead-only render for the RAF loop during playback.
 * Blits a pre-rendered static canvas (grid, notes, contour) and draws
 * only the playhead line on top — avoids redrawing the entire canvas at 60fps.
 */
export function renderPlayheadOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  staticCanvas: HTMLCanvasElement | OffscreenCanvas,
  currentTime: number,
  viewport: PitchEditorViewport,
) {
  const dpr = globalThis.window?.devicePixelRatio || 1;
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.drawImage(staticCanvas as any, 0, 0);

  // Draw playhead
  if (currentTime >= 0) {
    ctx.save();
    ctx.scale(dpr, dpr);
    const px = projectTimeToX(currentTime, viewport);
    if (px >= PIANO_WIDTH && px <= width) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
    ctx.restore();
  }
}

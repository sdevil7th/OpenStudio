/**
 * PitchEditorCanvas — Imperative Canvas 2D rendering for the monophonic pitch editor.
 *
 * The editor is intentionally monophonic even for stereo vocal clips:
 * analysis happens on a mono sum, while correction still renders against the
 * full multichannel clip in the backend.
 */

import type { PitchNoteData, PitchContourData } from "../services/NativeBridge";
import { PITCH_EDITOR_FORMANT_EDITING_ENABLED, type PitchRenderCoverageRange } from "../store/pitchEditorStore";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
export const PIANO_WIDTH = 30;

export interface PitchEditorViewport {
  scrollX: number;
  scrollY: number;
  pixelsPerSecond: number;
  pixelsPerSemitone: number;
  clipStartTime: number;
  clipDuration: number;
}

export interface PitchEditorRenderState {
  notes: PitchNoteData[];
  contour: PitchContourData | null;
  selectedNoteIds: string[];
  hoveredNoteId: string | null;
  currentTime: number;
  isPlaying: boolean;
  bpm: number;
  timeSignature: [number, number];
  scaleNotes: boolean[];
  scaleKey: number;
  renderCoverage: PitchRenderCoverageRange[];
}

function midiToY(midi: number, viewport: PitchEditorViewport, canvasHeight: number): number {
  const visibleSemitones = canvasHeight / viewport.pixelsPerSemitone;
  const topMidi = viewport.scrollY + visibleSemitones;
  return (topMidi - midi) * viewport.pixelsPerSemitone;
}

function timeToX(clipTime: number, viewport: PitchEditorViewport): number {
  const projectTime = viewport.clipStartTime + clipTime;
  return PIANO_WIDTH + (projectTime - viewport.scrollX) * viewport.pixelsPerSecond;
}

function projectTimeToX(projectTime: number, viewport: PitchEditorViewport): number {
  return PIANO_WIDTH + (projectTime - viewport.scrollX) * viewport.pixelsPerSecond;
}

export function xToTime(x: number, viewport: PitchEditorViewport): number {
  const projectTime = (x - PIANO_WIDTH) / viewport.pixelsPerSecond + viewport.scrollX;
  return projectTime - viewport.clipStartTime;
}

export function yToMidi(y: number, viewport: PitchEditorViewport, canvasHeight: number): number {
  const visibleSemitones = canvasHeight / viewport.pixelsPerSemitone;
  const topMidi = viewport.scrollY + visibleSemitones;
  return topMidi - y / viewport.pixelsPerSemitone;
}

export type NoteHitZone = "body" | "left" | "right" | "top-center" | "bottom-left" | "bottom-right";

function getNoteEffectiveStart(note: PitchNoteData) {
  return note.effectiveStartTime ?? note.startTime;
}

function getNoteEffectiveEnd(note: PitchNoteData) {
  return note.effectiveEndTime ?? note.endTime;
}

function getEffectiveTransitionMs(note: PitchNoteData, edge: "in" | "out") {
  const explicitMs = edge === "in" ? note.transitionIn : note.transitionOut;
  return explicitMs > 0 ? explicitMs : 0;
}

export function hitTestNote(
  x: number,
  y: number,
  notes: PitchNoteData[],
  viewport: PitchEditorViewport,
  canvasHeight: number,
): { noteId: string; edge: NoteHitZone } | null {
  const edgePx = 6;
  const handleSize = 8;

  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i];
    const x1 = timeToX(note.startTime, viewport);
    const x2 = timeToX(note.endTime, viewport);
    const noteY = midiToY(note.correctedPitch + 0.5, viewport, canvasHeight);
    const noteH = viewport.pixelsPerSemitone;

    if (x < x1 || x > x2 || y < noteY || y > noteY + noteH) continue;

    const width = x2 - x1;
    if (width > 30 && noteH > 8) {
      const midX = x1 + width / 2;
      if (Math.abs(x - midX) < handleSize && y - noteY < handleSize) {
        return { noteId: note.id, edge: "top-center" };
      }
      if (PITCH_EDITOR_FORMANT_EDITING_ENABLED && x - x1 < handleSize * 1.5 && noteY + noteH - y < handleSize) {
        return { noteId: note.id, edge: "bottom-left" };
      }
      if (x2 - x < handleSize * 1.5 && noteY + noteH - y < handleSize) {
        return { noteId: note.id, edge: "bottom-right" };
      }
    }

    if (x - x1 < edgePx) return { noteId: note.id, edge: "left" };
    if (x2 - x < edgePx) return { noteId: note.id, edge: "right" };
    return { noteId: note.id, edge: "body" };
  }

  return null;
}

function drawPitchContour(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: PitchEditorViewport,
  contour: PitchContourData,
  strokeStyle: string,
  lineWidth: number,
) {
  const { times, midi, confidence } = contour.frames;
  ctx.beginPath();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;

  let started = false;
  for (let i = 0; i < times.length; i++) {
    if (midi[i] <= 0 || confidence[i] < 0.3) {
      started = false;
      continue;
    }

    const x = timeToX(times[i], viewport);
    const y = midiToY(midi[i], viewport, height);
    if (x < PIANO_WIDTH - 10 || x > width + 10) {
      started = false;
      continue;
    }

    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
}

export function renderPitchEditor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: PitchEditorViewport,
  state: PitchEditorRenderState,
) {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, width, height);

  const visibleSemitones = height / viewport.pixelsPerSemitone;
  const bottomMidi = viewport.scrollY;
  const topMidi = bottomMidi + visibleSemitones;
  const minMidi = Math.floor(bottomMidi);
  const maxMidi = Math.ceil(topMidi);
  const hasScale = state.scaleNotes.some((inScale) => !inScale);

  for (let midi = minMidi; midi <= maxMidi; midi++) {
    const y = midiToY(midi + 0.5, viewport, height);
    const h = viewport.pixelsPerSemitone;
    const noteClass = ((midi % 12) + 12) % 12;
    const isBlack = BLACK_KEYS.has(noteClass);
    const inScale = state.scaleNotes[noteClass];
    const isTonic = noteClass === state.scaleKey;

    if (hasScale && !inScale) ctx.fillStyle = "#111111";
    else if (hasScale && isTonic) ctx.fillStyle = "#252525";
    else ctx.fillStyle = isBlack ? "#161616" : "#1e1e1e";
    ctx.fillRect(PIANO_WIDTH, y, width - PIANO_WIDTH, h);

    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = noteClass === 0 ? 1 : 0.5;
    ctx.beginPath();
    ctx.moveTo(PIANO_WIDTH, y + h);
    ctx.lineTo(width, y + h);
    ctx.stroke();

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

      if (noteClass === 0 || viewport.pixelsPerSemitone > 14) {
        const octave = Math.floor(midi / 12) - 1;
        const label = NOTE_NAMES[noteClass] + octave;
        const brightness = hasScale ? (inScale ? (isTonic ? "#bbb" : "#999") : "#555") : (isBlack ? "#888" : "#999");
        ctx.fillStyle = brightness;
        ctx.font = "9px Inter, system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(label, PIANO_WIDTH - 3, y + h / 2);
      }
    }
  }

  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PIANO_WIDTH, 0);
  ctx.lineTo(PIANO_WIDTH, height);
  ctx.stroke();

  if (state.bpm > 0) {
    const beatDuration = 60 / state.bpm;
    const beatsPerBar = state.timeSignature[0];
    const startTime = viewport.scrollX;
    const endTime = startTime + (width - PIANO_WIDTH) / viewport.pixelsPerSecond;
    const firstBeat = Math.floor(startTime / beatDuration);
    const lastBeat = Math.ceil(endTime / beatDuration);

    for (let beat = firstBeat; beat <= lastBeat; beat++) {
      const x = projectTimeToX(beat * beatDuration, viewport);
      if (x < PIANO_WIDTH || x > width) continue;
      const isBar = beat % beatsPerBar === 0;
      ctx.strokeStyle = isBar ? "#3a3a3a" : "#262626";
      ctx.lineWidth = isBar ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  for (const range of state.renderCoverage) {
    if (range.state === "hq_ready") continue;
    const x1 = timeToX(range.startTime, viewport);
    const x2 = timeToX(range.endTime, viewport);
    if (x2 < PIANO_WIDTH || x1 > width) continue;

    ctx.fillStyle = range.state === "preview_ready"
      ? "rgba(56, 189, 248, 0.12)"
      : "rgba(245, 158, 11, 0.10)";
    ctx.fillRect(Math.max(PIANO_WIDTH, x1), 0, Math.max(0, Math.min(width, x2) - Math.max(PIANO_WIDTH, x1)), height);

    ctx.strokeStyle = range.state === "preview_ready"
      ? "rgba(56, 189, 248, 0.22)"
      : "rgba(245, 158, 11, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, height);
    ctx.moveTo(x2, 0);
    ctx.lineTo(x2, height);
    ctx.stroke();
  }

  if (state.contour?.frames.rms && state.contour.frames.rms.length > 0) {
    const { times, rms, midi, confidence } = state.contour.frames;
    let maxRms = 0;
    for (const value of rms) maxRms = Math.max(maxRms, value);

    if (maxRms > 0) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#60a5fa";

      for (let i = 0; i < times.length; i++) {
        if (confidence[i] < 0.1 || midi[i] <= 0) continue;
        const x = timeToX(times[i], viewport);
        if (x < PIANO_WIDTH || x > width) continue;

        const normalizedRms = rms[i] / maxRms;
        const barHeight = normalizedRms * viewport.pixelsPerSemitone * 3;
        const y = midiToY(midi[i], viewport, height);
        const nextTime = i + 1 < times.length ? times[i + 1] : times[i] + 0.01;
        const barWidth = Math.max(1, (nextTime - times[i]) * viewport.pixelsPerSecond);
        ctx.fillRect(x, y - barHeight / 2, barWidth, barHeight);
      }

      ctx.restore();
    }
  }

  if (state.contour && state.contour.frames.times.length > 0) {
    drawPitchContour(ctx, width, height, viewport, state.contour, "rgba(245, 158, 11, 0.35)", 1.5);
  }

  if (state.notes.length > 0 && state.contour && state.contour.frames.times.length > 0) {
    const { times, midi, confidence } = state.contour.frames;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
    ctx.lineWidth = 1.5;
    let started = false;

    for (let i = 0; i < times.length; i++) {
      if (midi[i] <= 0 || confidence[i] < 0.3) {
        started = false;
        continue;
      }

      const frameTime = times[i];
      const note = state.notes.find((candidate) => frameTime >= getNoteEffectiveStart(candidate) && frameTime <= getNoteEffectiveEnd(candidate));
      if (!note) {
        started = false;
        continue;
      }

      const correctedMidi = midi[i] + (note.correctedPitch - note.detectedPitch);
      const x = timeToX(frameTime, viewport);
      const y = midiToY(correctedMidi, viewport, height);
      if (x < PIANO_WIDTH - 10 || x > width + 10) {
        started = false;
        continue;
      }

      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }

  for (const note of state.notes) {
    const x1 = timeToX(note.startTime, viewport);
    const x2 = timeToX(note.endTime, viewport);
    if (x2 < PIANO_WIDTH || x1 > width) continue;

    const y = midiToY(note.correctedPitch + 0.5, viewport, height);
    const h = viewport.pixelsPerSemitone;
    const w = x2 - x1;
    const isSelected = state.selectedNoteIds.includes(note.id);
    const isHovered = state.hoveredNoteId === note.id;
    const isShifted = Math.abs(note.correctedPitch - note.detectedPitch) > 0.1;
    const isUnvoiced = note.voiced === false;
    const radius = Math.min(3, h / 4, w / 4);

    const alpha = 0.75;
    if (isUnvoiced) ctx.fillStyle = "rgba(100, 100, 100, 0.4)";
    else if (isSelected) ctx.fillStyle = `rgba(59, 130, 246, ${alpha})`;
    else if (isShifted) ctx.fillStyle = `rgba(245, 158, 11, ${alpha})`;
    else ctx.fillStyle = `rgba(34, 197, 94, ${alpha})`;

    ctx.beginPath();
    ctx.moveTo(x1 + radius, y);
    ctx.lineTo(x2 - radius, y);
    ctx.quadraticCurveTo(x2, y, x2, y + radius);
    ctx.lineTo(x2, y + h - radius);
    ctx.quadraticCurveTo(x2, y + h, x2 - radius, y + h);
    ctx.lineTo(x1 + radius, y + h);
    ctx.quadraticCurveTo(x1, y + h, x1, y + h - radius);
    ctx.lineTo(x1, y + radius);
    ctx.quadraticCurveTo(x1, y, x1 + radius, y);
    ctx.closePath();
    ctx.fill();

    if (isUnvoiced && w > 4) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = "rgba(150, 150, 150, 0.3)";
      ctx.lineWidth = 0.5;
      for (let hatchX = -h; hatchX < w + h; hatchX += 6) {
        ctx.beginPath();
        ctx.moveTo(x1 + hatchX, y);
        ctx.lineTo(x1 + hatchX + h, y + h);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (isSelected || isHovered) {
      ctx.strokeStyle = isSelected ? "#60a5fa" : "#888";
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.stroke();
    }

    if (w > 10 && !isUnvoiced) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, y, w, h);
      ctx.clip();

      if (state.contour && state.contour.frames.times.length > 0) {
        const { times, midi, confidence } = state.contour.frames;

        ctx.beginPath();
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1;
        let started = false;
        for (let i = 0; i < times.length; i++) {
          if (times[i] < note.startTime - 0.01 || times[i] > note.endTime + 0.01) continue;
          if (midi[i] <= 0 || confidence[i] < 0.3) {
            started = false;
            continue;
          }
          const px = timeToX(times[i], viewport);
          const py = midiToY(midi[i], viewport, height);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = isSelected ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1.5;
        started = false;
        const pitchShift = note.correctedPitch - note.detectedPitch;
        for (let i = 0; i < times.length; i++) {
          if (times[i] < note.startTime - 0.01 || times[i] > note.endTime + 0.01) continue;
          if (midi[i] <= 0 || confidence[i] < 0.3) {
            started = false;
            continue;
          }
          const px = timeToX(times[i], viewport);
          const py = midiToY(midi[i] + pitchShift, viewport, height);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      } else if (note.pitchDrift && note.pitchDrift.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = isSelected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.2)";
        ctx.lineWidth = 1;
        for (let i = 0; i < note.pitchDrift.length; i++) {
          const t = note.startTime + (i / (note.pitchDrift.length - 1)) * (note.endTime - note.startTime);
          const px = timeToX(t, viewport);
          const py = midiToY(note.correctedPitch + note.pitchDrift[i], viewport, height);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      ctx.restore();
    }

    const transitionStart = getNoteEffectiveStart(note);
    const transitionEnd = getNoteEffectiveEnd(note);
    if (!isUnvoiced && (transitionStart < note.startTime || transitionEnd > note.endTime)) {
      ctx.save();
      const inX = timeToX(transitionStart, viewport);
      const outX = timeToX(transitionEnd, viewport);
      if (transitionStart < note.startTime) {
        ctx.fillStyle = "rgba(245, 158, 11, 0.18)";
        ctx.fillRect(inX, y, Math.max(0, x1 - inX), h);
      }
      if (transitionEnd > note.endTime) {
        ctx.fillStyle = "rgba(245, 158, 11, 0.18)";
        ctx.fillRect(x2, y, Math.max(0, outX - x2), h);
      }
      ctx.restore();
    }

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

    if (isHovered && w > 30 && h > 8 && !isUnvoiced) {
      const handleSize = 5;
      const handleColor = "rgba(255,255,255,0.6)";
      const midX = x1 + w / 2;

      ctx.fillStyle = handleColor;
      ctx.beginPath();
      ctx.moveTo(midX - handleSize, y + handleSize + 1);
      ctx.lineTo(midX, y + 1);
      ctx.lineTo(midX + handleSize, y + handleSize + 1);
      ctx.closePath();
      ctx.fill();

      if (PITCH_EDITOR_FORMANT_EDITING_ENABLED) {
        const blx = x1 + handleSize + 2;
        const bly = y + h - handleSize - 1;
        ctx.beginPath();
        ctx.moveTo(blx, bly - handleSize / 2);
        ctx.lineTo(blx + handleSize / 2, bly);
        ctx.lineTo(blx, bly + handleSize / 2);
        ctx.lineTo(blx - handleSize / 2, bly);
        ctx.closePath();
        ctx.fill();
      }

      const brx = x2 - handleSize - 4;
      const bry = y + h - handleSize - 2;
      ctx.fillRect(brx, bry, handleSize, handleSize);
    }
  }

  for (let i = 0; i < state.notes.length - 1; i++) {
    const left = state.notes[i];
    const right = state.notes[i + 1];
    const gap = getNoteEffectiveStart(right) - getNoteEffectiveEnd(left);
    if (gap > 0.1) continue;
    if (!(getEffectiveTransitionMs(left, "out") > 0 || getEffectiveTransitionMs(right, "in") > 0)) continue;

    const x1 = timeToX(getNoteEffectiveEnd(left), viewport);
    const x2 = timeToX(getNoteEffectiveStart(right), viewport);
    const y1 = midiToY(left.correctedPitch, viewport, height);
    const y2 = midiToY(right.correctedPitch, viewport, height);
    if (x2 < PIANO_WIDTH || x1 > width) continue;

    ctx.beginPath();
    ctx.strokeStyle = "rgba(245, 158, 11, 0.6)";
    ctx.lineWidth = 2;
    const midX = (x1 + x2) / 2;
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(midX, y1, midX, y2, x2, y2);
    ctx.stroke();
  }

  if (state.currentTime >= 0) {
    const playheadX = projectTimeToX(state.currentTime, viewport);
    if (playheadX >= PIANO_WIDTH && playheadX <= width) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    }
  }

  ctx.restore();
}

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
  ctx.drawImage(staticCanvas as CanvasImageSource, 0, 0);

  if (currentTime >= 0) {
    ctx.save();
    ctx.scale(dpr, dpr);
    const playheadX = projectTimeToX(currentTime, viewport);
    if (playheadX >= PIANO_WIDTH && playheadX <= width) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();
    }
    ctx.restore();
  }
}

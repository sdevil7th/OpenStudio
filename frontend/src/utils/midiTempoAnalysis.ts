import type { ClipTempoAnalysis } from "../services/NativeBridge";
import type { MIDIClip } from "../store/useDAWStore";
import { getMIDIClipSourceLoopLength, getVisibleMIDIEventsForClip } from "./midiClipSerialization";

export interface MIDITempoAnalysisRange { startSeconds?: number; durationSeconds?: number }

function phaseEvidence(onsets: readonly number[], bpm: number): { score: number; phase: number } {
  const real = [0, 0, 0, 0], imaginary = [0, 0, 0, 0];
  for (const time of onsets) {
    const angle = time * bpm / 60 * Math.PI * 2;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    let c = cosine, s = sine;
    for (let harmonic = 0; harmonic < 4; harmonic++) {
      real[harmonic] += c; imaginary[harmonic] += s;
      const next = c * cosine - s * sine; s = s * cosine + c * sine; c = next;
    }
  }
  const weights = [0.55, 0.25, 0.12, 0.08];
  const noiseFloor = Math.min(0.45, Math.sqrt(Math.PI) / (2 * Math.sqrt(Math.max(1, onsets.length))));
  const score = weights.reduce((sum, weight, harmonic) => sum + weight * Math.max(0,
    (Math.hypot(real[harmonic], imaginary[harmonic]) / Math.max(1, onsets.length) - noiseFloor) / (1 - noiseFloor)), 0);
  return { score, phase: ((Math.atan2(imaginary[0], real[0]) / (Math.PI * 2)) % 1 + 1) % 1 * 60 / bpm };
}

function boundedOnsets(onsets: number[], maximum = 192): number[] {
  return onsets.length <= maximum ? onsets : Array.from({ length: maximum }, (_, index) => onsets[Math.floor(index * (onsets.length - 1) / (maximum - 1))]);
}

// Ellis' published log-tempo listener prior is deliberately independent of the
// project tempo. Raw phase evidence, aliases and segment agreement remain visible.
const listenerPreference = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
const samePulseFamily = (a: number, b: number) => [0.5, 2 / 3, 1, 1.5, 2, 3].some(ratio => Math.abs(a / b / ratio - 1) < 0.035);

export function analyzeMIDIClipTempo(clip: MIDIClip, range: MIDITempoAnalysisRange = {}): ClipTempoAnalysis {
  const startSeconds = Math.max(0, Math.min(clip.duration, Number.isFinite(range.startSeconds) ? range.startSeconds! : 0));
  const durationSeconds = Math.max(0, Math.min(clip.duration - startSeconds,
    Number.isFinite(range.durationSeconds) ? range.durationSeconds! : clip.duration));
  const metadata = clip.sourceTempoInfo;
  if (metadata && Number.isFinite(metadata.tempo) && metadata.tempo > 0) {
    let sourceTime = Math.max(0, (clip.sourceStart || 0) + (clip.loopOffset || 0) + (clip.offset || 0) + startSeconds);
    const loop = getMIDIClipSourceLoopLength(clip);
    if (clip.loopEnabled !== false && loop > 0) sourceTime %= loop;
    const markers = metadata.tempoMarkers.filter(marker => Number.isFinite(marker.time) && marker.time >= 0
      && Number.isFinite(marker.bpm) && marker.bpm > 0).sort((a, b) => a.time - b.time);
    let bpm = metadata.tempo, cursor = 0, beats = 0;
    for (const marker of markers) {
      if (marker.time > sourceTime) break;
      beats += (marker.time - cursor) * bpm / 60;
      cursor = marker.time;
      bpm = marker.bpm;
    }
    beats += (sourceTime - cursor) * bpm / 60;
    const beatOffsetSeconds = (startSeconds + Math.max(0, Math.ceil(beats - 1e-8) - beats) * 60 / bpm) % (60 / bpm);
    return { bpm, confidence: 1, beatOffsetSeconds, candidates: [{ bpm, confidence: 1 }], source: "midi-metadata",
      analysisStartSeconds: startSeconds, analysisDurationSeconds: durationSeconds,
      warning: markers.length ? "The MIDI file contains a tempo map. This result is the source tempo at the clip's visible start; applying it sets the project's base BPM only." : undefined };
  }
  const allOnsets = [...new Set(getVisibleMIDIEventsForClip(clip).filter(event => event.type === "noteOn" && (event.velocity ?? 0) > 0
    && event.timestamp >= startSeconds && event.timestamp <= startSeconds + durationSeconds)
    .map(event => Math.round((event.timestamp - startSeconds) * 10000) / 10000))].sort((a, b) => a - b);
  // Merge near-simultaneous chord attacks, without letting a dense chord count
  // as many independent beats. Bound work over the whole range, not its prefix.
  const distinct = allOnsets.filter((time, index) => index === 0 || time - allOnsets[index - 1] >= 0.015);
  const onsets = boundedOnsets(distinct, 512);
  if (onsets.length < 4) return { bpm: 0, confidence: 0, beatOffsetSeconds: 0, candidates: [], source: "midi-estimate",
    error: "At least four distinct note onsets are needed to estimate tempo. This clip has no retained source tempo metadata." };
  const last = onsets[onsets.length - 1], first = onsets[0], windowDuration = Math.min(20, Math.max(3, last - first));
  const windows = [...new Set([first, Math.max(first, (first + last - windowDuration) / 2), Math.max(first, last - windowDuration)])]
    .map(start => ({ start, points: boundedOnsets(distinct.filter(time => time >= start && time <= start + windowDuration)) }))
    .filter(window => window.points.length >= 4);
  const scoreAt = (bpm: number, refine = false) => {
    const localEvidence = windows.map(window => phaseEvidence(window.points, bpm).score);
    const local = localEvidence.reduce((sum, evidence) => sum + evidence, 0) / Math.max(1, windows.length);
    const evidence = refine ? local * 0.4 + phaseEvidence(onsets, bpm).score * 0.6 : local;
    return { bpm, evidence, score: evidence * listenerPreference(bpm), localEvidence };
  };
  const coarse = Array.from({ length: 761 }, (_, index) => scoreAt(20 + index * 0.5)).sort((a, b) => b.score - a.score);
  const seeds: typeof coarse = [];
  for (const candidate of coarse) {
    if (seeds.every(entry => Math.abs(entry.bpm - candidate.bpm) / candidate.bpm > 0.015)) seeds.push(candidate);
    if (seeds.length === 8) break;
  }
  const ranked = seeds.map(seed => {
    let best = scoreAt(seed.bpm, true);
    for (let step = -30; step <= 30; step++) {
      const bpm = seed.bpm + step * 0.01;
      if (bpm < 20 || bpm > 400) continue;
      const candidate = scoreAt(bpm, true); if (candidate.score > best.score) best = candidate;
    }
    return best;
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.evidence < Math.min(0.8, Math.max(0.12, 1.8 / Math.sqrt(onsets.length))))
    return { bpm: 0, confidence: 0, beatOffsetSeconds: 0, candidates: [], source: "midi-estimate",
      error: "No repeated beat grid stands out from irregular note spacing. Try a steadier range, tap the pulse, or count beats manually." };
  const segments = windows.map((window, windowIndex) => {
    let best = coarse[0];
    for (const candidate of coarse) {
      const evidence = candidate.localEvidence[windowIndex];
      const score = evidence * listenerPreference(candidate.bpm);
      if (score > best.score || best === coarse[0]) best = { ...candidate, evidence, score };
    }
    const folded = [0.5, 2 / 3, 1, 1.5, 2, 3].map(ratio => best.bpm * ratio)
      .sort((a, b) => Math.abs(a - ranked[0].bpm) - Math.abs(b - ranked[0].bpm))[0];
    return { startSeconds: startSeconds + window.start, durationSeconds: windowDuration,
      bpm: folded, confidence: Math.min(0.85, best.evidence) };
  });
  const spread = segments.length ? Math.max(...segments.map(segment => segment.bpm)) - Math.min(...segments.map(segment => segment.bpm)) : 0;
  const other = ranked.find(candidate => !samePulseFamily(candidate.bpm, best.bpm));
  const contrast = other ? Math.max(0, 1 - other.score / Math.max(best.score, 1e-8)) : 1;
  const stable = spread / best.bpm < 0.04;
  const confidence = Math.min(stable ? 0.65 : 0.35,
    0.8 * Math.min(1, best.evidence / 0.35) * (0.45 + 0.55 * contrast) * Math.min(1, onsets.length / 16));
  const candidates: ClipTempoAnalysis["candidates"] = [];
  for (const candidate of ranked) {
    if (candidates.some(entry => Math.abs(entry.bpm / candidate.bpm - 1) < 0.025)) continue;
    candidates.push({ bpm: Math.round(candidate.bpm * 100) / 100,
      confidence: Math.min(0.65, confidence * candidate.score / Math.max(best.score, 1e-8)) });
    if (candidates.length === 5) break;
  }
  for (const ratio of [0.5, 2 / 3, 1.5, 2]) {
    const bpm = Math.round(best.bpm * ratio * 100) / 100;
    if (bpm < 20 || bpm > 400) continue;
    const existing = candidates.find(candidate => Math.abs(candidate.bpm / bpm - 1) < 0.02);
    if (existing) existing.bpm = bpm;
    else candidates.push({ bpm, confidence: confidence * 0.7 });
  }
  return { bpm: Math.round(best.bpm * 100) / 100, confidence,
    beatOffsetSeconds: (startSeconds + phaseEvidence(onsets, best.bpm).phase) % (60 / best.bpm), candidates,
    source: "midi-estimate", analysisStartSeconds: startSeconds, analysisDurationSeconds: durationSeconds,
    tempoSpreadBpm: spread, segments,
    warning: `${stable ? "" : "Different sections suggest different tempos; a single BPM may not fit this range. "}Compared repeated beat grids across the selected notes. Half/double and triplet beat units remain ambiguous; audition the click or count beats. Confidence is evidence strength, not a calibrated probability. No source tempo metadata was retained.` };
}

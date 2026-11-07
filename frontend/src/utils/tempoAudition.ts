export interface TempoPreviewNote { startSeconds: number; durationSeconds: number; pitch: number; velocity: number }
export interface TempoAuditionOptions {
  bpm: number; phaseSeconds: number; rangeStartSeconds: number; durationSeconds: number;
  wavBase64?: string; notes?: TempoPreviewNote[]; pulseGrouping?: number;
  clickLevel?: number; onEnded?: () => void;
}

export function tempoClickTimes(bpm: number, phase: number, start: number, duration: number) {
  if (![bpm, phase, start, duration].every(Number.isFinite) || bpm < 20 || bpm > 400 || duration <= 0) return [];
  const period = 60 / bpm, first = Math.ceil((start - phase) / period - 1e-9);
  const result: Array<{ seconds: number; beat: number }> = [];
  for (let beat = first; result.length < 64; beat++) {
    const seconds = phase + beat * period - start;
    if (seconds >= duration - 1e-8) break;
    if (seconds >= -1e-8) result.push({ seconds: Math.max(0, seconds), beat });
  }
  return result;
}

export function tempoFromTapTimes(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const intervals = times.slice(1).map((value, index) => value - times[index]);
  if (intervals.some(value => !Number.isFinite(value) || value < 150 || value > 3000)) return null;
  intervals.sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const median = intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2;
  const bpm = 60000 / median;
  return bpm >= 20 && bpm <= 400 ? bpm : null;
}

export function tempoFromBeatIntervals(start: number, end: number, intervals: number): number | null {
  const bpm = 60 * intervals / (end - start);
  return [start, end, intervals, bpm].every(Number.isFinite) && start >= 0 && end > start && intervals >= 1
    && Number.isInteger(intervals) && bpm >= 20 && bpm <= 400 ? bpm : null;
}

/** An isolated, bounded browser output. It never seeks or starts DAW transport. */
export class TempoAuditionPlayer {
  private context: AudioContext | null = null;
  private generation = 0;
  private nodes = new Set<{ source: AudioScheduledSourceNode; gain: GainNode }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly createContext: () => AudioContext = () => new AudioContext()) {}

  async ready(): Promise<void> {
    if (!this.context || this.context.state === "closed") this.context = this.createContext();
    if (this.context.state === "suspended") await this.context.resume();
  }
  stop(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const { source, gain } of this.nodes) {
      try { source.stop(); } catch { /* Already-ended sources are harmless. */ }
      source.disconnect(); gain.disconnect();
    }
    this.nodes.clear();
  }
  dispose(): void {
    this.stop();
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") void context.close();
  }
  async play(options: TempoAuditionOptions): Promise<boolean> {
    this.stop();
    const generation = this.generation;
    await this.ready();
    const context = this.context!;
    const duration = Math.min(8, options.durationSeconds);
    const clicks = options.clickLevel === 0 ? [] : tempoClickTimes(options.bpm, options.phaseSeconds, options.rangeStartSeconds, duration);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(options.rangeStartSeconds) || options.rangeStartSeconds < 0
      || (options.clickLevel !== 0 && (!Number.isFinite(options.bpm) || options.bpm < 20 || options.bpm > 400 || !Number.isFinite(options.phaseSeconds))))
      throw new Error("Choose a valid tempo and preview range.");
    let audio: AudioBuffer | null = null;
    if (options.wavBase64) {
      if (options.wavBase64.length > 6_000_000) throw new Error("The preview payload exceeded its bounded size.");
      const binary = atob(options.wavBase64), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      audio = await context.decodeAudioData(bytes.buffer);
    }
    if (generation !== this.generation || context !== this.context) return false;
    const start = context.currentTime + 0.05;
    const attach = (source: AudioScheduledSourceNode, level: number) => {
      const gain = context.createGain(); gain.gain.value = level;
      source.connect(gain); gain.connect(context.destination);
      const node = { source, gain }; this.nodes.add(node);
      source.onended = () => { source.disconnect(); gain.disconnect(); this.nodes.delete(node); };
      return gain;
    };
    if (audio) {
      let peak = 0;
      for (let channel = 0; channel < audio.numberOfChannels; channel++) {
        const samples = audio.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
      }
      const source = context.createBufferSource(); source.buffer = audio;
      attach(source, Math.min(0.65, 0.7 / Math.max(1e-8, peak)));
      source.start(start, 0, Math.min(duration, audio.duration));
    }
    // MIDI guide tones identify note timing; they do not impersonate a track's
    // instrument or FX. Keep simultaneous work and release tails bounded.
    const voiceEnds: number[] = [];
    for (const note of (options.notes ?? []).filter(note => note.startSeconds < options.rangeStartSeconds + duration
      && note.startSeconds + note.durationSeconds > options.rangeStartSeconds).slice(0, 96)) {
      const offset = Math.max(0, note.startSeconds - options.rangeStartSeconds);
      const length = Math.max(0.02, Math.min(0.5, note.startSeconds + note.durationSeconds - options.rangeStartSeconds - offset, duration - offset));
      for (let i = voiceEnds.length - 1; i >= 0; i--) if (voiceEnds[i] <= offset) voiceEnds.splice(i, 1);
      if (voiceEnds.length >= 12) continue;
      voiceEnds.push(offset + length);
      const oscillator = context.createOscillator(); oscillator.type = "triangle";
      oscillator.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
      const gain = attach(oscillator, 0);
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(Math.max(0, Math.min(127, note.velocity)) / 127 * 0.045, start + offset + 0.008);
      gain.gain.linearRampToValueAtTime(0, start + offset + length);
      oscillator.start(start + offset); oscillator.stop(start + offset + length);
    }
    const click = context.createBuffer(1, Math.ceil(context.sampleRate * 0.025), context.sampleRate);
    const samples = click.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / context.sampleRate * 1400 * Math.PI * 2) * Math.exp(-i / context.sampleRate * 180);
    for (const tick of clicks) {
      const source = context.createBufferSource(); source.buffer = click;
      const group = Math.max(1, Math.round(options.pulseGrouping ?? 4));
      const accented = ((tick.beat % group) + group) % group === 0;
      attach(source, Math.max(0, Math.min(0.3, options.clickLevel ?? 0.2)) * (accented ? 1 : 0.65));
      source.playbackRate.value = accented ? 1.35 : 1;
      source.start(start + tick.seconds);
    }
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.stop(); options.onEnded?.();
    }, (duration + 0.08) * 1000);
    return true;
  }
}

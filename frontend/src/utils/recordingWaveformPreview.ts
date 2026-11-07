import type { WaveformPeak } from "../services/NativeBridge";

// The recorder publishes complete 256-sample bins. Keep both bridge work and
// retained UI data bounded even when a long take is viewed at minimum zoom.
export const RECORDING_PEAK_STRIDE = 256;
export const MAX_RECORDING_PREVIEW_PEAKS = 8192;
export const MAX_RECORDING_PEAK_BASE_ENTRIES = 262144;
export const RECORDING_PREVIEW_POLL_MS = 250;
export const RECORDING_GEOMETRY_INTERVAL_MS = 1000 / 15;
const WINDOW_ALIGNMENT = 128;
const WINDOW_PADDING = 128;

export interface RecordingPreviewClip {
  trackId: string;
  startTime: number;
}

export interface RecordingPreviewView {
  clips: readonly RecordingPreviewClip[];
  sampleRate: number;
  pixelsPerSecond: number;
  scrollX: number;
  width: number;
  currentTime: number;
}

export interface RecordingWaveformData {
  peaks: WaveformPeak[];
  startSample: number;
  samplesPerPixel: number;
  sampleRate: number;
  recordingStartTime: number;
}

export type RecordingWaveformCache = Map<string, RecordingWaveformData>;

export interface RecordingPreviewWindow {
  startSample: number;
  samplesPerPixel: number;
  numPixels: number;
}

export function planRecordingPreviewWindow(
  view: RecordingPreviewView,
  clip: RecordingPreviewClip,
): RecordingPreviewWindow | null {
  const { sampleRate, pixelsPerSecond, width, scrollX, currentTime } = view;
  if (![sampleRate, pixelsPerSecond, width, scrollX, currentTime, clip.startTime].every(Number.isFinite)
    || sampleRate <= 0 || pixelsPerSecond <= 0 || width <= 0) return null;

  const visibleStart = Math.max(0, scrollX / pixelsPerSecond - clip.startTime);
  const visibleEnd = Math.min(currentTime, (scrollX + width) / pixelsPerSecond) - clip.startTime;
  if (visibleEnd <= visibleStart) return null;

  let samplesPerPixel = 2 ** Math.ceil(Math.log2(Math.max(RECORDING_PEAK_STRIDE, sampleRate / pixelsPerSecond)));
  // Very wide windows still get complete coverage without growing the cache.
  while (Math.ceil(width / pixelsPerSecond * sampleRate / samplesPerPixel)
    + WINDOW_PADDING * 2 + WINDOW_ALIGNMENT > MAX_RECORDING_PREVIEW_PEAKS) samplesPerPixel *= 2;

  const firstBin = Math.floor(visibleStart * sampleRate / samplesPerPixel);
  const startBin = Math.max(0, Math.floor((firstBin - WINDOW_PADDING) / WINDOW_ALIGNMENT) * WINDOW_ALIGNMENT);
  const recordedBins = Math.floor(Math.max(0, currentTime - clip.startTime) * sampleRate / samplesPerPixel);
  const endBin = Math.min(recordedBins,
    Math.ceil(visibleEnd * sampleRate / samplesPerPixel) + WINDOW_PADDING,
    startBin + MAX_RECORDING_PREVIEW_PEAKS);
  if (endBin <= startBin) return null;
  return { startSample: startBin * samplesPerPixel, samplesPerPixel, numPixels: endBin - startBin };
}

export function recordingPeakX(
  data: RecordingWaveformData,
  index: number,
  pixelsPerSecond: number,
  scrollX: number,
): number {
  return (data.recordingStartTime + (data.startSample + index * data.samplesPerPixel) / data.sampleRate)
    * pixelsPerSecond - scrollX;
}

function sameView(a: RecordingPreviewView, b: RecordingPreviewView | null): boolean {
  // Transport time advances independently; it must not invalidate every request.
  return b !== null && a.sampleRate === b.sampleRate && a.pixelsPerSecond === b.pixelsPerSecond
    && a.scrollX === b.scrollX && a.width === b.width && a.clips.length === b.clips.length
    && a.clips.every((clip, index) => clip.trackId === b.clips[index].trackId && clip.startTime === b.clips[index].startTime);
}

function sameRecording(a: RecordingPreviewView, b: RecordingPreviewView | null): boolean {
  return b !== null && a.sampleRate === b.sampleRate && a.clips.length === b.clips.length
    && a.clips.every((clip, index) => clip.trackId === b.clips[index].trackId && clip.startTime === b.clips[index].startTime);
}

interface RecordingPreviewOptions {
  readView: () => RecordingPreviewView | null;
  isInteracting: () => boolean;
  now?: () => number;
  request: (trackId: string, samplesPerPixel: number, numPixels: number, startSample: number) => Promise<WaveformPeak[]>;
  publish: (cache: RecordingWaveformCache) => void;
  onError: (error: unknown) => void;
}

/** A single request lane survives viewport/effect changes until its await ends. */
export class RecordingPreviewScheduler {
  private inFlight = false;
  private generation = 0;
  private recordingGeneration = 0;
  private lastPollTime = -Infinity;
  private nextTrackId: string | undefined;
  private active = true;
  private cache: RecordingWaveformCache = new Map();

  constructor(private readonly options: RecordingPreviewOptions) {}

  setActive(active: boolean): void {
    this.active = active;
    this.generation++;
    this.recordingGeneration++;
  }

  invalidate(clear = false): void {
    this.generation++;
    if (clear) this.recordingGeneration++;
    if (clear && this.cache.size > 0) {
      this.cache = new Map();
      if (this.active) this.options.publish(this.cache);
    }
  }

  async poll(): Promise<void> {
    if (!this.active) return;
    const view = this.options.readView();
    if (!view) {
      this.invalidate(true);
      return;
    }
    const now = this.options.now?.() ?? performance.now();
    // A sustained gesture must not freeze the growing waveform. Retain the
    // normal polling budget even when obsolete viewport work completes early.
    if (this.inFlight || (this.options.isInteracting()
      && now - this.lastPollTime < RECORDING_PREVIEW_POLL_MS)) return;
    this.lastPollTime = now;
    this.inFlight = true;
    const generation = this.generation;
    const recordingGeneration = this.recordingGeneration;
    const isCurrent = () => this.active && generation === this.generation
      && sameView(view, this.options.readView());
    const isSameRecording = () => this.active && recordingGeneration === this.recordingGeneration
      && sameRecording(view, this.options.readView());

    try {
      const retained = new Map([...this.cache].filter(([trackId, data]) => view.clips.some(
        (clip) => clip.trackId === trackId && clip.startTime === data.recordingStartTime,
      )));
      if (retained.size !== this.cache.size) {
        this.cache = retained;
        this.options.publish(this.cache);
      }
      const nextIndex = Math.max(0, view.clips.findIndex(clip => clip.trackId === this.nextTrackId));
      const orderedClips = [...view.clips.slice(nextIndex), ...view.clips.slice(0, nextIndex)];
      for (const clip of orderedClips) {
        if (!isCurrent()) break;
        const window = planRecordingPreviewWindow(view, clip);
        if (!window) continue;
        const existing = this.cache.get(clip.trackId);
        const canReuse = existing && existing.samplesPerPixel === window.samplesPerPixel
          && existing.sampleRate === view.sampleRate && existing.recordingStartTime === clip.startTime
          && existing.startSample <= window.startSample
          && existing.startSample + existing.peaks.length * window.samplesPerPixel >= window.startSample;
        const firstRetained = canReuse ? (window.startSample - existing.startSample) / window.samplesPerPixel : 0;
        const peaks = canReuse ? existing.peaks.slice(firstRetained, firstRetained + window.numPixels) : [];
        const missing = window.numPixels - peaks.length;
        if (missing <= 0) continue;
        // +1 conservatively budgets the older native aggregation's boundary bin.
        const requestLimit = Math.max(1, Math.floor(MAX_RECORDING_PEAK_BASE_ENTRIES
          / (window.samplesPerPixel / RECORDING_PEAK_STRIDE + 1)));
        const numPixels = Math.min(missing, MAX_RECORDING_PREVIEW_PEAKS, requestLimit);
        const clipIndex = view.clips.indexOf(clip);
        this.nextTrackId = view.clips[(clipIndex + 1) % view.clips.length]?.trackId;
        const received = await this.options.request(clip.trackId, window.samplesPerPixel, numPixels,
          window.startSample + peaks.length * window.samplesPerPixel);
        // Samples retain absolute source coordinates across viewport changes.
        // Publish a completed valid window so continuous navigation cannot
        // starve previews, but retire the old batch before its next track.
        // Stop/new-take/unmount must still reject late data, even at equal times.
        if (!isSameRecording()) return;
        if (received.length === 0) continue;
        const data: RecordingWaveformData = {
          peaks: [...peaks, ...received.slice(0, numPixels)],
          startSample: window.startSample,
          samplesPerPixel: window.samplesPerPixel,
          sampleRate: view.sampleRate,
          recordingStartTime: clip.startTime,
        };
        this.cache = new Map(this.cache).set(clip.trackId, data);
        this.options.publish(this.cache);
      }
    } catch (error) {
      if (isSameRecording()) this.options.onError(error);
    } finally {
      this.inFlight = false;
      // Coalesce arbitrarily many changes into the current view after the old
      // request retires. During interaction the polling budget defers this to
      // the next regular tick instead of creating a retry loop.
      if (this.active && !isCurrent()) void this.poll();
    }
  }
}

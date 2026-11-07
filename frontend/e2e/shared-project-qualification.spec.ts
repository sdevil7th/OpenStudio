import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AudioClip, MIDIClip, Track, useDAWStore } from "../src/store/useDAWStore";
import type { commandManager } from "../src/store/commands";
import type { WaveformPeak } from "../src/services/NativeBridge";

const originalPath = process.env.OPENSTUDIO_QUALIFICATION_PROJECT;
const artifactRoot = path.resolve("../output/playwright/shared-project-qualification");
const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
interface PeakFile {
  source: string; sampleRate: number; channels: number; samples: number;
  levels: Array<{ stride: number; count: number; data: Buffer }>;
  sourceSize: number; sourceMtime: number;
}
interface Project { tracks: Track[]; tempo: number; timeSignature: { numerator: number; denominator: number }; projectRange: { start: number; end: number } }
interface PeakRequest { file: string; spp: number; start: number; count: number; rangeStart: number; rangeEnd: number }

/** Read-only sidecar service. It does not use a native engine or synthetic peaks. */
class SourcePeakService {
  files = new Map<string, PeakFile>();
  requests: PeakRequest[] = [];
  boundaryFallbacks = new Set<string>();
  waveInfo = new Map<string, { fd: number; data: number; bits: number; frame: number; format: number }>();
  constructor(sources: string[]) {
    for (const source of sources) {
      const sidecar = fs.readFileSync(`${source}.ospeaks`);
      const stat = fs.statSync(source);
      if (sidecar.readUInt32LE(0) !== 0x4f53504b || sidecar.readUInt32LE(4) !== 1) throw new Error(`Invalid peak cache: ${source}`);
      const file: PeakFile = { source, sampleRate: sidecar.readDoubleLE(24), channels: sidecar.readInt32LE(32),
        samples: Number(sidecar.readBigInt64LE(40)), sourceSize: Number(sidecar.readBigInt64LE(8)),
        sourceMtime: Number(sidecar.readBigInt64LE(16)), levels: [] };
      if (stat.size !== file.sourceSize || Math.abs(Math.trunc(stat.mtimeMs) - file.sourceMtime) > 1) throw new Error(`Stale peak cache: ${source}`);
      if (sidecar.readInt32LE(48) !== 4) throw new Error("Unexpected peak levels");
      let offset = 56;
      for (const stride of [64, 256, 1024, 4096]) {
        const count = sidecar.readInt32LE(offset + 4);
        if (sidecar.readInt32LE(offset) !== stride || count !== Math.ceil(file.samples / stride)) throw new Error("Invalid peak level footprint");
        const bytes = count * file.channels * 8;
        file.levels.push({ stride, count, data: sidecar.subarray(offset + 8, offset + 8 + bytes) });
        offset += bytes + 8;
      }
      if (offset !== sidecar.length) throw new Error("Unexpected peak file tail");
      this.files.set(source, file);
    }
  }

  rawBoundary(file: PeakFile, first: number, last: number): Array<{ min: number; max: number }> {
    let info = this.waveInfo.get(file.source);
    if (!info) {
      const fd = fs.openSync(file.source, "r");
      const header = Buffer.alloc(12);
      fs.readSync(fd, header, 0, 12, 0);
      if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
        fs.closeSync(fd);
        this.boundaryFallbacks.add(file.source);
        const level = file.levels[0];
        return Array.from({ length: file.channels }, (_, channel) => {
          let min = Infinity, max = -Infinity;
          for (let bucket = Math.floor(first / 64); bucket < Math.min(level.count, Math.ceil(last / 64)); bucket++) {
            const offset = (bucket * file.channels * 2 + channel * 2) * 4;
            min = Math.min(min, level.data.readFloatLE(offset)); max = Math.max(max, level.data.readFloatLE(offset + 4));
          }
          return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
        });
      }
      let offset = 12, format = 0, bits = 0, frame = 0, data = 0;
      while (offset + 8 <= file.sourceSize) {
        const chunk = Buffer.alloc(8); fs.readSync(fd, chunk, 0, 8, offset);
        const size = chunk.readUInt32LE(4), id = chunk.toString("ascii", 0, 4);
        if (id === "fmt ") {
          const fmt = Buffer.alloc(size); fs.readSync(fd, fmt, 0, size, offset + 8);
          format = fmt.readUInt16LE(0); bits = fmt.readUInt16LE(14); frame = fmt.readUInt16LE(12);
          if (format === 0xfffe && size >= 40) format = fmt.readUInt16LE(24);
        }
        if (id === "data") { data = offset + 8; break; }
        offset += 8 + size + (size % 2);
      }
      if (!data || !frame || ![1, 3].includes(format)) throw new Error(`Unsupported WAV boundary format: ${file.source}`);
      info = { fd, data, format, bits, frame }; this.waveInfo.set(file.source, info);
    }
    const bytes = Buffer.alloc((last - first) * info.frame);
    fs.readSync(info.fd, bytes, 0, bytes.length, info.data + first * info.frame);
    return Array.from({ length: file.channels }, (_, channel) => {
      let min = Infinity, max = -Infinity;
      for (let sample = 0; sample < last - first; sample++) {
        const offset = sample * info!.frame + channel * info!.bits / 8;
        const value = info!.format === 3 ? bytes.readFloatLE(offset)
          : info!.bits === 16 ? bytes.readInt16LE(offset) / 32768
          : info!.bits === 24 ? bytes.readIntLE(offset, 3) / 8388608
          : info!.bits === 32 ? bytes.readInt32LE(offset) / 2147483648 : (bytes.readUInt8(offset) - 128) / 128;
        min = Math.min(min, value); max = Math.max(max, value);
      }
      return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
    });
  }

  query(request: PeakRequest, log = true): WaveformPeak[] {
    if (log) this.requests.push(request);
    const file = this.files.get(request.file);
    if (!file) throw new Error(`Unlisted source requested: ${request.file}`);
    const { spp, start, count } = request;
    const rangeStart = Math.max(0, request.rangeStart), rangeEnd = request.rangeEnd < 0 ? file.samples : Math.min(file.samples, request.rangeEnd);
    if (start >= rangeEnd) return [];
    const eligible = file.levels.filter(candidate => candidate.stride <= spp);
    const level = eligible[eligible.length - 1] ?? file.levels[0];
    const edges = new Map<number, Array<{ min: number; max: number }>>();
    return Array.from({ length: Math.max(0, Math.min(count, Math.ceil((rangeEnd - start) / spp))) }, (_, pixel) => {
      const first = Math.max(start + pixel * spp, rangeStart), last = Math.min(start + (pixel + 1) * spp, rangeEnd);
      const channels = Array.from({ length: file.channels }, () => ({ min: Infinity, max: -Infinity }));
      for (let bucket = Math.floor(first / level.stride); first < last && bucket < Math.min(level.count, Math.ceil(last / level.stride)); bucket++) {
        const bucketFirst = bucket * level.stride, bucketLast = Math.min(file.samples, bucketFirst + level.stride);
        const retainedFirst = Math.max(bucketFirst, rangeStart), retainedLast = Math.min(bucketLast, rangeEnd);
        let edge: Array<{ min: number; max: number }> | undefined;
        if (retainedFirst !== bucketFirst || retainedLast !== bucketLast) {
          edge = edges.get(bucket);
          if (!edge) { edge = this.rawBoundary(file, retainedFirst, retainedLast); edges.set(bucket, edge); }
        }
        channels.forEach((channel, index) => {
          const offset = (bucket * file.channels * 2 + index * 2) * 4;
          channel.min = Math.min(channel.min, edge ? edge[index].min : level.data.readFloatLE(offset));
          channel.max = Math.max(channel.max, edge ? edge[index].max : level.data.readFloatLE(offset + 4));
        });
      }
      return { channels: channels.map(channel => ({ min: Number.isFinite(channel.min) ? channel.min : 0, max: Number.isFinite(channel.max) ? channel.max : 0 })) };
    });
  }
  close() { for (const { fd } of this.waveInfo.values()) fs.closeSync(fd); }
}

declare global {
  interface Window {
    __sharedProjectQA: { store: typeof useDAWStore; history: typeof commandManager; holdSync: boolean; releaseSync: (() => void) | null };
    __readSharedSourcePeaks: (request: PeakRequest) => Promise<WaveformPeak[]>;
    __writeNormalizedSharedProject: (value: Record<string, unknown>) => Promise<void>;
    __reportSharedProjectWarning: (value: Record<string, unknown>) => Promise<void>;
  }
}

async function paint(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

test("actual project source-backed waveform and MIDI geometry, trim and undo", async ({ page }, testInfo) => {
  test.skip(!originalPath, "Set OPENSTUDIO_QUALIFICATION_PROJECT to explicitly opt into a local project.");
  // Actual seven-minute source files and 42 geometry cases precede the live
  // profile. Keep their read/trace cost outside the profile's measured phases.
  test.setTimeout(process.env.OPENSTUDIO_PROFILE_RECORDING === "1" ? 420_000 : 240_000);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const original = fs.readFileSync(originalPath!);
  const beforeHash = sha256(original);
  const copyPath = path.join(artifactRoot, "input-copy.osproj");
  fs.writeFileSync(copyPath, original);
  const project = JSON.parse(original.toString("utf8").replace(/^\uFEFF/, "")) as Project;
  const sources = [...new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.filePath)))];
  const peaks = new SourcePeakService(sources);
  const report: Record<string, unknown> = { scope: "Actual saved project data rendered by real Timeline in an isolated headless browser; bridge mutations mocked, peak data read from real source sidecars and WAV boundary samples.",
    projectPath: originalPath, copyPath, originalSha256Before: beforeHash, copySha256: sha256(fs.readFileSync(copyPath)),
    tracks: project.tracks.length, audioClips: project.tracks.reduce((sum, track) => sum + track.clips.length, 0),
    midiClips: project.tracks.reduce((sum, track) => sum + track.midiClips.length, 0),
    sourceFiles: [...peaks.files.values()].map(file => ({ path: file.source, sampleRate: file.sampleRate, channels: file.channels, samples: file.samples, peakLevels: file.levels.map(level => ({ stride: level.stride, count: level.count })) })),
    audioQuality: "not_asserted", nativePlayback: "not_asserted", nativePeakService: "not_asserted", frameTimes: "diagnostic_only" };
  const checks: Record<string, unknown>[] = [];
  const pageErrors: string[] = [];
  const viteMessages: string[] = [];
  page.on("console", message => { if (message.text().includes("[vite]")) viteMessages.push(message.text()); });
  const reactWarnings: Record<string, unknown>[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    await page.exposeFunction("__readSharedSourcePeaks", (request: PeakRequest) => peaks.query(request));
    await page.exposeFunction("__writeNormalizedSharedProject", (value: Record<string, unknown>) => {
      const normalizedPath = path.resolve("../output/shared-project-qualification/frontend-normalized.json");
      fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
      fs.writeFileSync(normalizedPath, JSON.stringify(value, null, 2));
      report.normalizedFrontendStatePath = normalizedPath;
    });
    await page.exposeFunction("__reportSharedProjectWarning", (value: Record<string, unknown>) => {
      reactWarnings.push(value);
      fs.writeFileSync(path.join(artifactRoot, "react-warnings.json"), JSON.stringify(reactWarnings, null, 2));
    });
    await page.addInitScript(() => {
      const original = console.error.bind(console);
      console.error = (...args: unknown[]) => {
        if (args.some(value => String(value).includes("Maximum update depth"))) {
          const state = window.__sharedProjectQA?.store.getState();
          void window.__reportSharedProjectWarning({ message: args.map(String), stack: new Error("React update-depth warning capture").stack,
            phase: state?.projectLoadingMessage, loading: state?.isProjectLoading, loadedTracks: state?.tracks.length });
        }
        original(...args);
      };
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    // This fixture mounts the production Timeline itself below. Starting App as
    // a second, hidden root would duplicate native polling and timeline work,
    // invalidating the timing diagnostic and the single-in-flight assertions.
    await page.route(/\/src\/main\.tsx(?:\?.*)?$/, route => route.fulfill({
      contentType: "application/javascript",
      body: 'import "/src/index.css";',
    }));
    await page.goto("/");
    await expect(page.locator("#root")).toBeEmpty();
    const normalized = await page.evaluate(async ({ saved, copyPath, sourceProjectSha256 }) => {
      const componentUrl = "/src/components/Timeline.tsx";
      const { Timeline } = await import(/* @vite-ignore */ componentUrl) as typeof import("../src/components/Timeline");
      const source = await (await fetch(componentUrl)).text();
      const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
      if (!storeUrl) throw new Error("Timeline store import missing");
      const { useDAWStore: store } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
      const bridgeUrl = "/src/services/NativeBridge.ts";
      const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
      const commandUrl = "/src/store/commands/index.ts";
      const { commandManager: history } = await import(/* @vite-ignore */ commandUrl) as typeof import("../src/store/commands");
      const qa = window.__sharedProjectQA = { store, history, holdSync: false, releaseSync: null as (() => void) | null };
      const reactUrl = "/node_modules/.vite/deps/react.js", domUrl = "/node_modules/.vite/deps/react-dom_client.js";
      const reactModule = await import(/* @vite-ignore */ reactUrl) as typeof import("react") & { default?: typeof import("react") };
      const React = reactModule.default || reactModule;
      const rootModule = await import(/* @vite-ignore */ domUrl) as typeof import("react-dom/client") & { default?: typeof import("react-dom/client") };
      const { createRoot } = rootModule.default || rootModule;
      // Real project normalization; only the native boundary is mocked. No MIDI
      // input device or file writer is invoked by this browser qualification.
      nativeBridge.loadProjectFromFile = async () => JSON.stringify(saved);
      nativeBridge.openMIDIDevice = async () => true;
      nativeBridge.saveProjectToFile = async () => { throw new Error("Read-only qualification forbids saving"); };
      store.setState({ autoBackupEnabled: false, isModified: false });
      const loaded = await store.getState().loadProject(copyPath, { bypassFX: true, recoveryCopy: true });
      if (!loaded) throw new Error(`Actual frontend loadProject failed: ${store.getState().projectRestoreError}`);
      const midiUrl = "/src/utils/midiClipSerialization.ts";
      const { serializeMIDIClipsForBackend } = await import(/* @vite-ignore */ midiUrl) as typeof import("../src/utils/midiClipSerialization");
      const state = store.getState();
      const normalized = JSON.parse(JSON.stringify({ sourceProjectSha256,
        tracks: state.tracks,
        backendMIDIClipsByTrackId: Object.fromEntries(state.tracks.map(track => [track.id, serializeMIDIClipsForBackend(track.midiClips, track.midiEffects || [])])),
        tempo: state.transport.tempo, timeSignature: state.timeSignature,
        processingPrecision: state.processingPrecision, masterVolume: state.masterVolume,
        masterPan: state.masterPan, masterTrimVolumeDB: state.masterTrimVolumeDB,
        isMasterMuted: state.isMasterMuted, masterMono: state.masterMono,
        qualification: { loader: "useDAWStore.loadProject", bypassFX: true, recoveryCopy: true,
          nativeWrites: "mocked", midiDevices: "not_opened", saveFiles: "forbidden",
          isProjectLoading: state.isProjectLoading, projectRestoreError: state.projectRestoreError },
      }));
      await window.__writeNormalizedSharedProject(normalized);
      nativeBridge.getWaveformPeaks = (file, spp, start, count, rangeStart = 0, rangeEnd = -1) => window.__readSharedSourcePeaks({ file, spp, start, count, rangeStart, rangeEnd });
      history.clear();
      store.setState({ projectName: "READ-ONLY qualification copy", projectPath: null,
        showGettingStarted: false, inputProfileOnboardingSeen: true, autoBackupEnabled: false,
        showMixer: false, showPianoRoll: false, showPitchEditor: false, showClipLauncher: false,
        canUndo: false, canRedo: false, isModified: false, trackHeight: 100,
        timeSignature: saved.timeSignature, projectRange: saved.projectRange,
        pixelsPerSecond: 100, scrollX: 0, scrollY: 0, snapEnabled: false, selectedClipIds: [], selectedClipId: null,
        mouseBehaviorProfileId: "openstudio", mouseModifiers: {}, globalLocked: false,
        syncClipsWithBackend: async () => { if (qa.holdSync) await new Promise<void>(resolve => { qa.releaseSync = resolve; }); },
        transport: { ...store.getState().transport, tempo: saved.tempo, currentTime: 0, isPlaying: false, isRecording: false } });
      const host = document.createElement("div"); host.id = "shared-project-timeline"; host.className = "workspace";
      Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "1", display: "flex", background: "#121212" });
      document.body.append(host);
      const root = createRoot(host);
      const render = () => root.render(React.createElement(Timeline, { tracks: store.getState().tracks, showRuler: true }));
      store.subscribe((state, previous) => { if (state.tracks !== previous.tracks) render(); }); render();
      return normalized;
    }, { saved: project, copyPath, sourceProjectSha256: beforeHash.toLowerCase() });
    const normalizedPath = path.resolve("../output/shared-project-qualification/frontend-normalized.json");
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
    fs.writeFileSync(normalizedPath, JSON.stringify(normalized, null, 2));
    report.normalizedFrontendStatePath = normalizedPath;
    project.tracks = normalized.tracks;
    await expect(page.locator("#shared-project-timeline canvas").last()).toBeVisible();

    const geometry = async (trackIndex: number, clip: AudioClip) => page.evaluate(({ trackIndex, clip }) => {
      const { store } = window.__sharedProjectQA;
      const state = store.getState();
      const stage = window.Konva.stages.find(candidate => candidate.container().closest("#shared-project-timeline") && candidate.height() > 100)!;
      const x = clip.startTime * state.pixelsPerSecond - state.scrollX, width = clip.duration * state.pixelsPerSecond;
      const lines = stage.find("Line").filter((node): node is InstanceType<typeof window.Konva.Line> => node instanceof window.Konva.Line).filter(line => {
        if (line.opacity() !== 0.6 || !line.closed() || line.strokeWidth() !== 1) return false;
        const rect = line.getParent()?.findOne("Rect");
        return rect && Math.abs(rect.x() - x) < 0.001 && Math.abs(rect.width() - width) < 0.001
          && rect.y() >= trackIndex * 100 && rect.y() < (trackIndex + 1) * 100;
      }).map(line => ({ points: line.points(), box: line.getParent()!.findOne("Rect")!.getAttrs() }));
      return { zoom: state.pixelsPerSecond, scroll: state.scrollX, stageWidth: stage.width(), lines };
    }, { trackIndex, clip });

    if (process.env.OPENSTUDIO_PROFILE_ONLY !== "1") {
      // One completed source spans almost seven minutes, making source-origin
      // drift measurable at fractional zoom and late timeline positions.
      const trackIndex = 6, clip = project.tracks[trackIndex].clips[0];
      const file = peaks.files.get(clip.filePath)!;
      for (const zoom of [1, 7.25, 34.784, 100, 333.333, 997.9]) {
        for (const time of [0, 80.125, 300.375]) {
          await page.evaluate(({ zoom, time, trackIndex }) => window.__sharedProjectQA.store.setState({
            pixelsPerSecond: zoom, scrollX: time * zoom, scrollY: trackIndex * 100,
          }), { zoom, time, trackIndex });
          await paint(page);
          await expect.poll(async () => (await geometry(trackIndex, clip)).lines.length, { timeout: 15_000 }).toBeGreaterThan(0);
          await page.waitForTimeout(280); // Shared production zoom idle/refinement boundary.
          const view = await geometry(trackIndex, clip);
          const line = view.lines[0], points = line.points as number[];
          const topCount = points.length / 4;
          expect(points[0]).toBeGreaterThanOrEqual(-1);
          expect(points[0]).toBeLessThanOrEqual(1);
          const expectedRight = Math.min(view.stageWidth, (clip.startTime + clip.duration - time) * zoom);
          expect(points[(topCount - 1) * 2]).toBeGreaterThanOrEqual(expectedRight - 2);
          const spp = Math.max(64, 2 ** Math.round(Math.log2(file.sampleRate / zoom)));
          const aligned = Math.floor(((clip.offset ?? 0) + time - clip.startTime) * file.sampleRate / (4096 * spp)) * 4096 * spp;
          const sourceRangeStart = time === 0 && (clip.offset ?? 0) > 0 ? Math.round((clip.offset ?? 0) * file.sampleRate) : 0;
          const sourceRangeEnd = expectedRight < view.stageWidth ? Math.round(((clip.offset ?? 0) + clip.duration) * file.sampleRate) : -1;
          const expected = peaks.query({ file: clip.filePath, spp, start: Math.max(0, aligned), count: Math.ceil(view.stageWidth * file.sampleRate / zoom / spp) + 4098, rangeStart: sourceRangeStart, rangeEnd: sourceRangeEnd }, false);
          const box = line.box as { y: number; height: number };
          const waveHeight = Math.max(8, box.height - 10), channelHeight = waveHeight / file.channels;
          const center = box.y + 5 + channelHeight / 2, halfHeight = channelHeight / 2 - 2;
          let maxError = 0;
          for (const index of [0, Math.floor(topCount / 4), Math.floor(topCount / 2), Math.max(0, topCount - 2)]) {
            const px = points[index * 2];
            const sample = ((clip.offset ?? 0) + (px + time * zoom) / zoom - clip.startTime) * file.sampleRate;
            const bucket = Math.floor((sample - Math.max(0, aligned)) / spp);
            const endBucket = Math.ceil((sample + file.sampleRate / zoom - Math.max(0, aligned)) / spp);
            let max = expected[bucket]?.channels[0]?.max ?? 0;
            for (let bin = bucket + 1; bin < endBucket; bin++) max = Math.max(max, expected[bin]?.channels[0]?.max ?? max);
            const gain = 10 ** ((clip.volumeDB ?? 0) / 20) * (project.tracks[trackIndex].waveformZoom ?? 1);
            const y = center - Math.max(-1, Math.min(1, max * gain)) * halfHeight;
            maxError = Math.max(maxError, Math.abs(y - points[index * 2 + 1]));
          }
          expect(maxError, `real-source waveform projection at ${zoom}px/s, ${time}s`).toBeLessThan(0.001);
          checks.push({ check: "real_waveform_projection", zoom, viewportStartSeconds: time, drawnPoints: points.length / 2, firstX: points[0], rightX: points[(topCount - 1) * 2], maxErrorPixels: maxError, status: "pass" });
        }
      }

      await page.screenshot({ path: path.join(artifactRoot, "fractional-zoom-late-source.png") });

      for (const midiTrackIndex of [2, 30]) {
        for (const zoom of [7.25, 34.784, 333.333, 997.9]) {
          for (const time of [70.125, 190.375, 380.125]) {
            await page.evaluate(({ zoom, time, midiTrackIndex }) => window.__sharedProjectQA.store.setState({
              pixelsPerSecond: zoom, scrollX: time * zoom, scrollY: midiTrackIndex * 100,
            }), { zoom, time, midiTrackIndex });
            await paint(page);
            const midiGeometry = await page.evaluate(async ({ midiTrackIndex }) => {
              const state = window.__sharedProjectQA.store.getState();
              const track = state.tracks[midiTrackIndex];
              const stage = window.Konva.stages.find(candidate => candidate.container().closest("#shared-project-timeline") && candidate.height() > 100)!;
              const sourceUrl = "/src/utils/midiClipSerialization.ts";
              const { getVisibleMIDIEventsForClip } = await import(/* @vite-ignore */ sourceUrl) as typeof import("../src/utils/midiClipSerialization");
              let rectangles = 0, clipsChecked = 0, maxError = 0;
              for (const clip of track.midiClips) {
                const x = clip.startTime * state.pixelsPerSecond - state.scrollX, width = clip.duration * state.pixelsPerSecond;
                if (x + width < 0 || x > stage.width()) continue;
                const group = stage.find("Group").filter((node): node is InstanceType<typeof window.Konva.Group> => node instanceof window.Konva.Group).find(candidate => {
                  const background = candidate.getChildren().find(child => child.getClassName() === "Rect");
                  return background && Math.abs(background.x() - x) < 0.001 && Math.abs(background.width() - width) < 0.001
                    && background.y() >= midiTrackIndex * 100 && background.y() < (midiTrackIndex + 1) * 100;
                });
                if (!group) throw new Error(`Missing actual MIDI clip group: ${clip.id}`);
                const background = group.getChildren().find(child => child.getClassName() === "Rect")!;
                const bars: Array<{ note: number; start: number; end: number }> = [];
                const pending = new Map<string, Array<{ note: number; start: number; end: number }>>();
                for (const event of getVisibleMIDIEventsForClip(clip)) {
                  if (event.note === undefined) continue;
                  const key = `${event.channel ?? 1}:${event.note}`;
                  if (event.type === "noteOn" && (event.velocity ?? 1) > 0) {
                    const bar = { note: event.note, start: event.timestamp, end: clip.duration };
                    bars.push(bar); const stack = pending.get(key) ?? []; stack.push(bar); pending.set(key, stack);
                  } else if (event.type === "noteOff" || (event.type === "noteOn" && event.velocity === 0)) {
                    const bar = pending.get(key)?.shift(); if (bar) bar.end = Math.max(bar.start, event.timestamp);
                  }
                }
                const min = Math.min(...bars.map(bar => bar.note)), max = Math.max(...bars.map(bar => bar.note));
                const range = Math.max(1, max - min), previewHeight = Math.max(8, background.height() - 10);
                const visible = bars.filter(bar => bar.end >= Math.max(0, -x / state.pixelsPerSecond)
                  && bar.start <= Math.min(clip.duration, (stage.width() - x) / state.pixelsPerSecond));
                const expected = visible.map(bar => ({ x: x + bar.start * state.pixelsPerSecond,
                  y: background.y() + 5 + (max - bar.note) / range * (previewHeight - 4),
                  width: Math.max(width < 60 ? 1 : 2, (bar.end - bar.start) * state.pixelsPerSecond) }));
                const notes = group.getChildren().filter(child => child.getClassName() === "Rect" && child.height() <= 4.01
                  && [0.4, 0.45, 0.8, 0.9].includes(child.opacity()));
                if (visible.length && notes.length === 0) throw new Error(`No actual MIDI notes drawn: ${clip.id}`);
                if (notes.length > Math.max(64, Math.floor(Math.min(stage.width(), width) / 4))) throw new Error("MIDI node budget exceeded");
                for (const note of notes) {
                  const nearest = Math.min(...expected.map(bar => Math.max(Math.abs(bar.x - note.x()), Math.abs(bar.y - note.y()), Math.abs(bar.width - note.width()))));
                  maxError = Math.max(maxError, nearest);
                }
                rectangles += notes.length; clipsChecked++;
              }
              return { rectangles, clipsChecked, maxErrorPixels: maxError };
            }, { midiTrackIndex });
            expect(midiGeometry.maxErrorPixels).toBeLessThan(0.001);
            checks.push({ check: "actual_midi_thumbnail_geometry", trackIndex: midiTrackIndex, zoom, viewportStartSeconds: time, ...midiGeometry, status: "pass" });
          }
        }
      }

      // Exercise the actual recorded clip's edge with a deliberately pending
      // mocked bridge sync, then prove release and Undo semantics independently.
      const trimTrackIndex = 0, trimClip = project.tracks[0].clips[0];
      await page.evaluate(() => window.__sharedProjectQA.store.setState({ pixelsPerSecond: 20, scrollX: 50 * 20, scrollY: 0 }));
      await paint(page);
      await expect.poll(async () => (await geometry(trimTrackIndex, trimClip)).lines.length).toBeGreaterThan(0);
      const trimView = await geometry(trimTrackIndex, trimClip);
      const trimBox = trimView.lines[0].box as { x: number; y: number; width: number; height: number };
      const stageBox = await page.locator("#shared-project-timeline .konvajs-content").last().boundingBox();
      if (!stageBox) throw new Error("Actual timeline stage bounds unavailable");
      await page.evaluate(() => { window.__sharedProjectQA.history.clear(); window.__sharedProjectQA.holdSync = true; });
      const px = stageBox.x + trimBox.x + trimBox.width - 2, py = stageBox.y + trimBox.y + trimBox.height / 2;
      await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.move(px - 80, py, { steps: 6 }); await page.mouse.up();
      await expect.poll(() => page.evaluate(() => Boolean(window.__sharedProjectQA.releaseSync))).toBe(true);
      const releasedDuration = await page.evaluate(id => window.__sharedProjectQA.store.getState().tracks[0].clips.find(clip => clip.id === id)!.duration, trimClip.id);
      expect(releasedDuration).toBeCloseTo(trimClip.duration - 4, 7);
      await page.mouse.move(px - 180, py, { steps: 5 });
      expect(await page.evaluate(id => window.__sharedProjectQA.store.getState().tracks[0].clips.find(clip => clip.id === id)!.duration, trimClip.id)).toBe(releasedDuration);
      await page.evaluate(() => { const qa = window.__sharedProjectQA; qa.holdSync = false; qa.releaseSync?.(); });
      await paint(page);
      expect(await page.evaluate(() => window.__sharedProjectQA.history.getUndoStack().length)).toBe(1);
      await page.evaluate(() => window.__sharedProjectQA.store.getState().undo());
      expect(await page.evaluate(id => window.__sharedProjectQA.store.getState().tracks[0].clips.find(clip => clip.id === id), trimClip.id)).toEqual(trimClip);
      checks.push({ check: "actual_recording_trim_release_and_single_undo", clipId: trimClip.id, originalDuration: trimClip.duration, releasedDuration, status: "pass" });

      const midiAnalysis = await page.evaluate(async () => {
        const state = window.__sharedProjectQA.store.getState();
        const analysisUrl = "/src/utils/midiTempoAnalysis.ts", midiUrl = "/src/utils/midiClipSerialization.ts";
        const { analyzeMIDIClipTempo } = await import(/* @vite-ignore */ analysisUrl) as typeof import("../src/utils/midiTempoAnalysis");
        const { serializeMIDIClipsForBackend } = await import(/* @vite-ignore */ midiUrl) as typeof import("../src/utils/midiClipSerialization");
        const diagnostics = state.tracks.flatMap(track => track.midiClips.map(clip => ({ trackId: track.id, clipId: clip.id,
          clipName: clip.name, result: analyzeMIDIClipTempo(clip), classification: "diagnostic_only" })));
        const track = state.tracks[2], selected = track.midiClips.slice(0, 2);
        const absolute = (clips: MIDIClip[]) => serializeMIDIClipsForBackend(clips, track.midiEffects || []).flatMap(clip => clip.events.map(event => ({
          ...event, timestamp: Math.round((clip.startTime + event.timestamp) * 1e8) / 1e8,
        }))).sort((a, b) => a.timestamp - b.timestamp || (a.channel ?? 1) - (b.channel ?? 1) || (a.note ?? -1) - (b.note ?? -1) || a.type.localeCompare(b.type));
        const before = absolute(selected), original = JSON.parse(JSON.stringify(track.midiClips));
        window.__sharedProjectQA.history.clear();
        state.selectClip(selected[0].id);
        window.__sharedProjectQA.store.setState({ selectedClipIds: selected.map(clip => clip.id), selectedClipId: selected[0].id });
        const joined = window.__sharedProjectQA.store.getState().joinSelectedMIDIClips();
        const afterTrack = window.__sharedProjectQA.store.getState().tracks[2];
        const joinedClip = afterTrack.midiClips.find(clip => clip.id === selected[0].id)!;
        const after = absolute([joinedClip]);
        const undoSteps = window.__sharedProjectQA.history.getUndoStack().length;
        window.__sharedProjectQA.store.getState().undo();
        const restored = window.__sharedProjectQA.store.getState().tracks[2].midiClips;
        return { diagnostics, join: { applied: joined, beforeEvents: before.length, afterEvents: after.length,
          serializedAbsoluteParity: JSON.stringify(before) === JSON.stringify(after), undoSteps,
          undoRestoredOriginalClips: JSON.stringify(original) === JSON.stringify(restored) } };
      });
      report.midiTempoDiagnostics = midiAnalysis.diagnostics;
      report.midiJoin = midiAnalysis.join;
      expect(midiAnalysis.diagnostics.length).toBe(9);
      expect(midiAnalysis.join.applied).toBeTruthy();
      expect(midiAnalysis.join.serializedAbsoluteParity).toBe(true);
      expect(midiAnalysis.join.undoSteps).toBe(1);
      expect(midiAnalysis.join.undoRestoredOriginalClips).toBe(true);
      checks.push({ check: "actual_midi_join_serialized_absolute_parity_and_undo", ...midiAnalysis.join, status: "pass" });
    }
    if (process.env.OPENSTUDIO_PROFILE_RECORDING === "1") {
      let profiler = ["1", "wheel"].includes(process.env.OPENSTUDIO_PROFILE_CPU || "") ? await page.context().newCDPSession(page) : null;
      if (profiler) { await profiler.send("Profiler.enable"); if (process.env.OPENSTUDIO_PROFILE_CPU === "1") await profiler.send("Profiler.start"); }
      const source = project.tracks[6].clips[0].filePath;
      const sourceFile = peaks.files.get(source)!;
      const sampleRate = sourceFile.sampleRate;
      const sourcePeakLevels = sourceFile.levels.filter(level => level.stride >= 256)
        .map(level => ({ stride: level.stride, count: level.count, base64: level.data.toString("base64") }));
      const setup = await page.evaluate(async ({ sampleRate, sourcePeakLevels, sourceChannels, sourceSamples }) => {
        const bridgeUrl = "/src/services/NativeBridge.ts";
        const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
        const { store } = window.__sharedProjectQA;
        const state = store.getState();
        // Preload actual validated mipmaps before measuring. Sending every live
        // result through Playwright's exposedFunction adds CDP object-walking
        // cost that is unrelated to the production WebView/native bridge.
        const levels = sourcePeakLevels.map(level => ({ ...level,
          values: new Float32Array(Uint8Array.from(atob(level.base64), character => character.charCodeAt(0)).buffer) }));
        const audio = state.tracks[6], midi = state.tracks[2];
        // Reuse this song's retained events four times to represent a long take.
        const originalEvents = midi.midiClips.flatMap(clip => clip.events.map(event => ({ ...event, timestamp: event.timestamp + clip.startTime })));
        const history = Array.from({ length: 4 }, (_, index) => originalEvents.map(event => ({ ...event, timestamp: event.timestamp / 4 + index * 100 }))).flat()
          .sort((first, second) => first.timestamp - second.timestamp);
        const perf = { pending: 0, maximumPending: 0, peakRequests: 0, maximumPeakPayload: 0, midiRequests: 0,
          midiPending: 0, maximumMIDIPending: 0, maximumMIDIDeltaEvents: 0,
          transitions: [] as Record<string, unknown>[],
          phase: "idle", frames: [] as { phase: string; milliseconds: number; recording: boolean; midiRequests: number }[], tasks: [] as { phase: string; milliseconds: number }[],
          stop: false, previous: performance.now(), raf: 0 };
        Object.assign(window, { __sharedProjectPerformance: perf });
        store.subscribe((next, previous) => {
          if (next.recordingClips !== previous.recordingClips || next.transport.isRecording !== previous.transport.isRecording)
            perf.transitions.push({ phase: perf.phase, recording: next.transport.isRecording, clips: next.recordingClips.length,
              stack: new Error("Recording fixture transition").stack });
        });
        const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => perf.tasks.push({ phase: perf.phase, milliseconds: entry.duration })));
        observer.observe({ type: "longtask", buffered: false });
        nativeBridge.getRecordingPeaks = async (_track, spp, count, start = 0) => {
          perf.maximumPending = Math.max(perf.maximumPending, ++perf.pending); ++perf.peakRequests;
          try {
            await new Promise(resolve => setTimeout(resolve, 4));
            const sourceStart = start % Math.floor(400 * sampleRate);
            const eligible = levels.filter(level => level.stride <= spp);
            const level = eligible[eligible.length - 1] ?? levels[0];
            const value = Array.from({ length: Math.max(0, Math.min(count, Math.ceil((sourceSamples - sourceStart) / spp))) }, (_, pixel) => {
              const first = sourceStart + pixel * spp, last = Math.min(sourceSamples, first + spp);
              const channels = Array.from({ length: sourceChannels }, () => ({ min: Infinity, max: -Infinity }));
              for (let bin = Math.floor(first / level.stride); bin < Math.min(level.count, Math.ceil(last / level.stride)); bin++) {
                for (let channel = 0; channel < sourceChannels; channel++) {
                  const offset = (bin * sourceChannels + channel) * 2;
                  channels[channel].min = Math.min(channels[channel].min, level.values[offset]);
                  channels[channel].max = Math.max(channels[channel].max, level.values[offset + 1]);
                }
              }
              return { channels: channels.map(channel => ({ min: Number.isFinite(channel.min) ? channel.min : 0, max: Number.isFinite(channel.max) ? channel.max : 0 })) };
            });
            perf.maximumPeakPayload = Math.max(perf.maximumPeakPayload, value.length); return value;
          } finally { --perf.pending; }
        };
        nativeBridge.getActiveRecordingMIDIPreviews = async requests => {
          ++perf.midiRequests; perf.maximumMIDIPending = Math.max(perf.maximumMIDIPending, ++perf.midiPending);
          try {
            await new Promise(resolve => setTimeout(resolve, 4));
            const result = requests.map(request => ({ trackId: request.trackId, generation: 1, recordingStartTime: 0,
              totalEventCount: history.length, deltaEvents: request.knownEventCount ? [] : history, activeNotes: [] }));
            perf.maximumMIDIDeltaEvents = Math.max(perf.maximumMIDIDeltaEvents, ...result.map(value => value.deltaEvents.length));
            return result;
          } finally { --perf.midiPending; }
        };
        const device = state.audioDeviceSetup ?? { deviceType: "Qualification mock (no device opened)",
          inputDevice: "", outputDevice: "", sampleRate, bufferSize: 8,
          numInputChannels: sourceChannels, numOutputChannels: sourceChannels };
        store.setState({ scrollY: 100, scrollX: 300 * 7.25, pixelsPerSecond: 7.25, autoScrollDuringPlayback: false,
          recordingClips: [], recordingMIDIPreviews: {}, audioDeviceSetup: { ...device, sampleRate },
          projectRange: { start: 0, end: 1800 },
          transport: { ...state.transport, currentTime: 390, isRecording: false, isPlaying: false } });
        const tick = (now: number) => {
          if (perf.stop) { observer.disconnect(); return; }
          perf.frames.push({ phase: perf.phase, milliseconds: now - perf.previous,
            recording: store.getState().transport.isRecording, midiRequests: perf.midiRequests }); perf.previous = now;
          if (perf.phase !== "idle") {
            const current = store.getState();
            store.setState({ transport: { ...current.transport, currentTime: current.transport.currentTime + 1 / 60 } });
          }
          perf.raf = requestAnimationFrame(tick);
        };
        perf.raf = requestAnimationFrame(tick);
        return { audioTrackId: audio.id, midiTrackId: midi.id, retainedMIDIEvents: history.length };
      }, { sampleRate, sourcePeakLevels, sourceChannels: sourceFile.channels, sourceSamples: sourceFile.samples });
      await page.waitForTimeout(6000);
      await page.evaluate(({ audioTrackId, midiTrackId }) => {
        const perf = (window as unknown as { __sharedProjectPerformance: { phase: string } }).__sharedProjectPerformance;
        perf.phase = "recording-start";
        const { store } = window.__sharedProjectQA, state = store.getState();
        store.setState({ recordingClips: [{ trackId: audioTrackId, startTime: 0 }, { trackId: midiTrackId, startTime: 0 }],
          recordSession: { id: "project-profile", startTime: 0, trackIds: [audioTrackId, midiTrackId] },
          transport: { ...state.transport, isRecording: true, isPlaying: true } });
      }, setup);
      await page.waitForTimeout(3000);
      await page.evaluate(() => { (window as unknown as { __sharedProjectPerformance: { phase: string } }).__sharedProjectPerformance.phase = "recording-steady"; });
      await page.waitForTimeout(9000);
      const menuLatencies: number[] = [];
      const checkMenu = async () => {
        await page.evaluate(() => {
          const timing = { start: 0, visible: 0 };
          Object.assign(window, { __sharedProjectMenuTiming: timing });
          document.addEventListener("contextmenu", () => {
            timing.start = performance.now();
            const observer = new MutationObserver(() => {
              if (!document.querySelector('[data-context-menu="true"]')) return;
              observer.disconnect();
              requestAnimationFrame(() => { timing.visible = performance.now(); });
            });
            observer.observe(document.body, { childList: true, subtree: true });
          }, { once: true, capture: true });
        });
        await page.mouse.click(780, 450, { button: "right" });
        await expect(page.locator('[data-context-menu="true"]').first()).toBeVisible();
        await paint(page);
        const elapsed = await page.evaluate(() => {
          const timing = (window as unknown as { __sharedProjectMenuTiming: { start: number; visible: number } }).__sharedProjectMenuTiming;
          return timing.visible - timing.start;
        });
        expect(elapsed).toBeGreaterThan(0);
        menuLatencies.push(elapsed);
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-context-menu="true"]')).toHaveCount(0);
      };
      await checkMenu();
      if (profiler && process.env.OPENSTUDIO_PROFILE_CPU === "wheel") await profiler.send("Profiler.start");
      await page.mouse.move(780, 450);
      for (const modifier of [null, "Control", "Shift", "Alt"] as const) {
        await page.evaluate(modifier => {
          (window as unknown as { __sharedProjectPerformance: { phase: string } }).__sharedProjectPerformance.phase = `recording-wheel-${modifier ?? "plain"}`;
        }, modifier);
        if (modifier) await page.keyboard.down(modifier);
        for (let index = 0; index < 16; index++) { await page.mouse.wheel(0, index < 8 ? -24 : 24); await page.waitForTimeout(55); }
        if (modifier) await page.keyboard.up(modifier);
      }
      await page.waitForTimeout(1500);
      if (profiler && process.env.OPENSTUDIO_PROFILE_CPU === "wheel") {
        const { profile } = await profiler.send("Profiler.stop");
        fs.writeFileSync(path.join(artifactRoot, "recording-wheel-cpu-profile.json"), JSON.stringify(profile));
        await profiler.detach(); profiler = null;
      }
      await checkMenu();
      // Fixed zooms complement modifier gestures: cover both the minimum zoom
      // and nearly sample-level drawing while the same long take is growing.
      for (const zoom of [1, 34.784, 100, 333.333, 997.9]) {
        await page.evaluate(zoom => {
          (window as unknown as { __sharedProjectPerformance: { phase: string } }).__sharedProjectPerformance.phase = `recording-zoom-${zoom}-change`;
          window.__sharedProjectQA.store.setState({ pixelsPerSecond: zoom, scrollX: 380 * zoom, scrollY: 100, trackHeight: 100 });
        }, zoom);
        await page.waitForTimeout(1000);
        await page.evaluate(zoom => {
          (window as unknown as { __sharedProjectPerformance: { phase: string } }).__sharedProjectPerformance.phase = `recording-zoom-${zoom}-steady`;
        }, zoom);
        await page.waitForTimeout(2000);
      }
      await checkMenu();
      const measurement = await page.evaluate(() => {
        const perf = (window as unknown as { __sharedProjectPerformance: { stop: boolean; pending: number; maximumPending: number; peakRequests: number; maximumPeakPayload: number; midiRequests: number; maximumMIDIPending: number; maximumMIDIDeltaEvents: number; transitions: Record<string, unknown>[]; frames: { phase: string; milliseconds: number; recording: boolean; midiRequests: number }[]; tasks: { phase: string; milliseconds: number }[] } }).__sharedProjectPerformance;
        perf.stop = true;
        const state = window.__sharedProjectQA.store.getState();
        const stage = window.Konva.stages.find(candidate => candidate.container().closest("#shared-project-timeline") && candidate.height() > 100)!;
        const canvasBudget = { lineNodes: stage.find("Line").length, batchedMuteHatches: stage.find(".clip-mute-hatch").length,
          livePreviewGroups: stage.find(".recording-preview").length };
        window.__sharedProjectQA.store.setState({ recordingClips: [], recordSession: null, transport: { ...state.transport, isRecording: false, isPlaying: false } });
        return { canvasBudget, transitions: perf.transitions,
          finalView: { recordingClipCount: state.recordingClips.length, recordingPreviewTrackIds: Object.keys(state.recordingMIDIPreviews),
            trackHeight: state.trackHeight, scrollY: state.scrollY, stageHeight: stage.height() },
          maximumPending: perf.maximumPending, peakRequests: perf.peakRequests, maximumPeakPayload: perf.maximumPeakPayload, midiRequests: perf.midiRequests,
          maximumMIDIPending: perf.maximumMIDIPending, maximumMIDIDeltaEvents: perf.maximumMIDIDeltaEvents,
          phases: [...new Set(perf.frames.map(frame => frame.phase))].map(phase => {
            const samples = perf.frames.filter(frame => frame.phase === phase);
            const values = perf.frames.filter(frame => frame.phase === phase).map(frame => frame.milliseconds).slice(2).sort((a, b) => a - b);
            return { phase, frames: values.length, p95Milliseconds: values[Math.floor(values.length * .95)], p99Milliseconds: values[Math.floor(values.length * .99)], maximumMilliseconds: values[values.length - 1],
              recordingFrames: samples.filter(frame => frame.recording).length, samples: samples.length,
              midiRequestsDuringPhase: samples[samples.length - 1].midiRequests - samples[0].midiRequests,
              longTasks: perf.tasks.filter(task => task.phase === phase) };
          }) };
      });
      report.recordingPerformance = { ...setup, ...measurement, menuVisibleLatenciesMilliseconds: menuLatencies, status: "diagnostic_only", scope: "Production Timeline, actual normalized 31-track project and validated real peak mipmaps preloaded before timing; paced transport and4ms async live native boundary simulated in-page to exclude Playwright CDP serialization; headless Chromium timings, no second App root." };
      if (profiler) {
        const { profile } = await profiler.send("Profiler.stop");
        fs.writeFileSync(path.join(artifactRoot, "recording-cpu-profile.json"), JSON.stringify(profile));
        await profiler.detach();
      }
      fs.writeFileSync(path.join(artifactRoot, "recording-performance.json"), JSON.stringify(report.recordingPerformance, null, 2));
      expect(Math.max(...menuLatencies)).toBeLessThan(1000);
      expect(measurement.maximumPending).toBeLessThanOrEqual(1);
      expect(measurement.maximumMIDIPending).toBeLessThanOrEqual(1);
      expect(measurement.canvasBudget.batchedMuteHatches).toBeGreaterThan(0);
      expect(measurement.canvasBudget.lineNodes).toBeLessThan(2000);
      expect(measurement.canvasBudget.livePreviewGroups).toBe(2);
      expect(measurement.phases.filter(phase => phase.phase !== "idle").every(phase => phase.recordingFrames === phase.samples)).toBe(true);
      expect(measurement.phases.find(phase => phase.phase === "recording-steady")!.midiRequestsDuringPhase).toBeGreaterThan(0);
      expect(measurement.maximumPeakPayload).toBeLessThanOrEqual(8192);
      expect(measurement.peakRequests).toBeGreaterThan(0);
      expect(measurement.midiRequests).toBeGreaterThan(0);
      expect(measurement.phases.every(phase => phase.frames > (phase.phase.includes("-change") || phase.phase.includes("-wheel") ? 0 : 30))).toBe(true);
      checks.push({ check: "actual_project_recording_bounded_work", status: "pass", maximumPending: measurement.maximumPending, maximumPeakPayload: measurement.maximumPeakPayload });
    }
    report.checks = checks;
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    report.checks = checks;
    report.pageErrors = pageErrors;
    report.viteMessages = viteMessages;
    report.reactWarnings = reactWarnings;
    report.sourcePeakRequests = peaks.requests;
    report.lossyBoundaryFallbacks = [...peaks.boundaryFallbacks];
    report.originalSha256After = sha256(fs.readFileSync(originalPath!));
    report.originalUnchanged = report.originalSha256After === beforeHash;
    report.sourcesMetadataUnchanged = [...peaks.files.values()].every(file => {
      const stat = fs.statSync(file.source); return stat.size === file.sourceSize && Math.abs(Math.trunc(stat.mtimeMs) - file.sourceMtime) <= 1;
    });
    peaks.close();
    fs.writeFileSync(path.join(artifactRoot, process.env.OPENSTUDIO_PROFILE_ONLY === "1" ? "recording-profile-only-report.json" : "report.json"), JSON.stringify(report, null, 2));
    await testInfo.attach("source-backed-project-report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    expect(report.originalUnchanged).toBe(true);
    expect(report.sourcesMetadataUnchanged).toBe(true);
  }
});

test("actual project load scheduling diagnostic with mocked IPC macrotasks", async ({ page }, testInfo) => {
  test.skip(!originalPath, "Set OPENSTUDIO_QUALIFICATION_PROJECT to explicitly opt into a local project.");
  test.setTimeout(90_000);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const original = fs.readFileSync(originalPath!), beforeHash = sha256(original);
  const saved = JSON.parse(original.toString("utf8").replace(/^\uFEFF/, ""));
  const warnings: Record<string, unknown>[] = [];
  const results: Record<string, unknown>[] = [];
  await page.exposeFunction("__recordIpcWarning", (value: Record<string, unknown>) => warnings.push(value));
  await page.addInitScript(() => {
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      if (args.some(value => String(value).includes("Maximum update depth"))) {
        const state = window.__sharedProjectQA?.store.getState();
        const bridge = window as unknown as { __recordIpcWarning: (value: Record<string, unknown>) => Promise<void> };
        void bridge.__recordIpcWarning({ message: args.map(String), stack: new Error("IPC scheduling diagnostic warning").stack,
          phase: state?.projectLoadingMessage, loading: state?.isProjectLoading, tracks: state?.tracks.length });
      }
      original(...args);
    };
  });
  try {
    for (const mode of ["instant", "macrotask"] as const) {
      const warningsBefore = warnings.length;
      await page.goto("/");
      await page.getByText("Starting OpenStudio...", { exact: true }).waitFor({ state: "hidden" });
      const result = await page.evaluate(async ({ saved, mode }) => {
        const source = await (await fetch("/src/App.tsx")).text();
        const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
        if (!storeUrl) throw new Error("App store import missing");
        const { useDAWStore: store } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
        const commandUrl = "/src/store/commands/index.ts", bridgeUrl = "/src/services/NativeBridge.ts";
        const { commandManager: history } = await import(/* @vite-ignore */ commandUrl) as typeof import("../src/store/commands");
        const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
        window.__sharedProjectQA = { store, history, holdSync: false, releaseSync: null };
        const wrapped: string[] = [];
        if (mode === "macrotask") {
          for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(nativeBridge))) {
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nativeBridge), name);
            if (!/^(set|add|remove|replace|clear|reset|panic|open|close)/.test(name) || typeof descriptor?.value !== "function") continue;
            const original = descriptor.value as (...args: unknown[]) => unknown;
            Object.defineProperty(nativeBridge, name, { configurable: true, value: async (...args: unknown[]) => {
              await new Promise(resolve => setTimeout(resolve, 0));
              return Reflect.apply(original, nativeBridge, args);
            } });
            wrapped.push(name);
          }
        }
        nativeBridge.loadProjectFromFile = async () => {
          if (mode === "macrotask") await new Promise(resolve => setTimeout(resolve, 0));
          return JSON.stringify(saved);
        };
        nativeBridge.openMIDIDevice = async () => true;
        nativeBridge.getWaveformPeaks = async () => [];
        nativeBridge.saveProjectToFile = async () => { throw new Error("Read-only qualification forbids saving"); };
        store.setState({ autoBackupEnabled: false, inputProfileOnboardingSeen: true, showGettingStarted: false, isModified: false });
        const started = performance.now();
        const loaded = await store.getState().loadProject("qualification-memory-copy.osproj", { bypassFX: true, recoveryCopy: true });
        const completed = performance.now();
        const state = store.getState();
        return { mode, loaded, tracks: state.tracks.length, isProjectLoading: state.isProjectLoading,
          projectRestoreError: state.projectRestoreError, loadMilliseconds: completed - started,
          wrappedMethods: wrapped, scope: "Headless full App; native methods mocked, waveform service returns pending/empty, MIDI devices unopened; timing diagnostic_only" };
      }, { saved, mode });
      const warningsAfterLoad = warnings.length;
      await page.waitForTimeout(2200); // Observe two AudioDeviceStatus timer ticks after the load.
      results.push({ ...result, loadWarnings: warningsAfterLoad - warningsBefore,
        idleWarnings: warnings.length - warningsAfterLoad, warnings: warnings.slice(warningsBefore) });
      expect(result.loaded).toBe(true);
      expect(result.tracks).toBe(31);
      expect(result.projectRestoreError).toBe("");
      expect(warnings.slice(warningsBefore)).toEqual([]);
    }
  } finally {
    const report = { status: "diagnostic_only", sourceProjectSha256: beforeHash, results,
      originalUnchanged: sha256(fs.readFileSync(originalPath!)) === beforeHash };
    fs.writeFileSync(path.join(artifactRoot, "load-scheduling-diagnostic.json"), JSON.stringify(report, null, 2));
    await testInfo.attach("load-scheduling-diagnostic", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    expect(report.originalUnchanged).toBe(true);
  }
});


test("long muted clips keep hatch artwork bounded and anchored while zooming", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, route => route.fulfill({
    contentType: "application/javascript", body: 'import "/src/index.css";',
  }));
  await page.goto("/");
  await page.evaluate(async () => {
    const componentUrl = "/src/components/Timeline.tsx";
    const { Timeline } = await import(/* @vite-ignore */ componentUrl) as typeof import("../src/components/Timeline");
    const source = await (await fetch(componentUrl)).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("Timeline store module missing");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const commandUrl = "/src/store/commands/index.ts";
    const { commandManager: history } = await import(/* @vite-ignore */ commandUrl) as typeof import("../src/store/commands");
    window.__sharedProjectQA = { store, history, holdSync: false, releaseSync: null };
    const track = createDefaultTrack("muted-hatch-qa", "Long muted recording");
    track.clips = [{ id: "long-muted", name: "Long muted recording", filePath: "", color: "#00cc88",
      startTime: 0, duration: 1800, offset: 0, sampleRate: 48000, volumeDB: 0, fadeIn: 0, fadeOut: 0, muted: true }];
    const tracks = Array.from({ length: 60 }, (_, index) => createDefaultTrack(`viewport-${index}`, `Row ${index + 1}`));
    tracks[0] = track;
    tracks[40].clips = [{ ...track.clips[0], id: "deep-clip", name: "Scrolled drag", startTime: 700.2, duration: 0.8 }];
    store.setState({ tracks, trackHeight: 100, pixelsPerSecond: 1000, scrollX: 700125, scrollY: 0,
      selectedClipIds: [], selectedClipId: null, autoBackupEnabled: false,
      snapEnabled: false, mouseBehaviorProfileId: "openstudio", globalLocked: false, syncClipsWithBackend: async () => {},
      transport: { ...store.getState().transport, currentTime: 0, isPlaying: false, isRecording: false } });
    const reactUrl = "/node_modules/.vite/deps/react.js", domUrl = "/node_modules/.vite/deps/react-dom_client.js";
    const reactModule = await import(/* @vite-ignore */ reactUrl) as typeof import("react") & { default?: typeof import("react") };
    const React = reactModule.default || reactModule;
    const domModule = await import(/* @vite-ignore */ domUrl) as typeof import("react-dom/client") & { default?: typeof import("react-dom/client") };
    const { createRoot } = domModule.default || domModule;
    const host = document.createElement("div"); host.className = "workspace"; host.id = "shared-project-timeline";
    Object.assign(host.style, { position: "fixed", inset: "0", display: "flex" }); document.body.append(host);
    const root = createRoot(host);
    const render = () => root.render(React.createElement(Timeline, { tracks: store.getState().tracks, showRuler: true }));
    store.subscribe((next, previous) => { if (next.tracks !== previous.tracks) render(); }); render();
  });
  const checks = [];
  for (const zoom of [1, 34.784, 333.333, 1000]) {
    await page.evaluate(zoom => window.__sharedProjectQA.store.setState({ pixelsPerSecond: zoom, scrollX: 700.125 * zoom }), zoom);
    await paint(page);
    const artwork = await page.evaluate(() => {
      const state = window.__sharedProjectQA.store.getState();
      const stage = window.Konva.stages.find(candidate => candidate.height() > 100)!;
      const hatches = stage.find(".clip-mute-hatch");
      const origins: number[] = [];
      const shape = hatches[0] as unknown as { sceneFunc: () => (context: unknown, shape: unknown) => void };
      if (shape) shape.sceneFunc()({ beginPath() {}, moveTo(x: number) { origins.push(x); }, lineTo() {}, strokeShape() {} }, shape);
      return { zoom: state.pixelsPerSecond, clipX: -state.scrollX, width: stage.width(), height: stage.height(),
        hatches: hatches.length, lineNodes: stage.find("Line").length, origins };
    });
    expect(artwork.hatches).toBe(1);
    expect(artwork.height).toBeLessThanOrEqual(700);
    expect(artwork.lineNodes).toBeLessThan(1000);
    expect(artwork.origins.length).toBeGreaterThan(1);
    expect(artwork.origins.length).toBeLessThan(Math.ceil((artwork.width + 100) / 12) + 3);
    for (const origin of artwork.origins) {
      expect((origin - artwork.clipX) / 12).toBeCloseTo(Math.round((origin - artwork.clipX) / 12), 6);
      expect(origin).toBeGreaterThanOrEqual(-12);
      expect(origin).toBeLessThanOrEqual(artwork.width + 112);
    }
    checks.push(artwork);
  }
  // The canvas stays in the visible workspace while its layers project deep
  // world rows. Exercise a real pointer drag there, then one atomic Undo.
  await page.evaluate(() => {
    window.__sharedProjectQA.history.clear();
    document.querySelector<HTMLElement>("#shared-project-timeline")!.scrollTop = 4000;
  });
  await expect.poll(() => page.evaluate(() => window.__sharedProjectQA.store.getState().scrollY)).toBe(4000);
  await paint(page);
  const viewport = await page.locator(".timeline-canvas-viewport").boundingBox();
  if (!viewport) throw new Error("Sticky timeline viewport unavailable");
  expect(viewport.y).toBeGreaterThanOrEqual(0);
  const sourceX = viewport.x + 475, sourceY = viewport.y + 70;
  await page.mouse.move(sourceX, sourceY); await page.mouse.down();
  await page.mouse.move(sourceX + 40, sourceY + 100, { steps: 7 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__sharedProjectQA.store.getState().tracks[41].clips[0]?.id)).toBe("deep-clip");
  const moved = await page.evaluate(() => ({ clip: window.__sharedProjectQA.store.getState().tracks[41].clips[0],
    undo: window.__sharedProjectQA.history.getUndoStack().length }));
  expect(moved.clip.startTime).toBeCloseTo(700.24, 5);
  expect(moved.undo).toBe(1);
  await page.evaluate(() => window.__sharedProjectQA.store.getState().undo());
  expect(await page.evaluate(() => window.__sharedProjectQA.store.getState().tracks[40].clips[0]?.startTime)).toBe(700.2);
  expect(await page.evaluate(() => window.__sharedProjectQA.store.getState().tracks[41].clips.length)).toBe(0);
  await page.evaluate(() => {
    const { store, history } = window.__sharedProjectQA;
    store.setState({ tracks: store.getState().tracks.map((track, index) => index === 40 ? {
      ...track, clips: track.clips.map(clip => ({ ...clip, fadeIn: 0.1, fadeOut: 0.1 })),
    } : track), selectedClipIds: ["deep-clip"], selectedClipId: "deep-clip" });
    history.clear();
  });
  await paint(page);
  await page.mouse.move(viewport.x + 175, viewport.y + 9); await page.mouse.down();
  await page.mouse.move(viewport.x + 225, viewport.y + 9, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__sharedProjectQA.store.getState().tracks[40].clips[0].fadeIn)).toBeCloseTo(0.15, 4);
  expect(await page.evaluate(() => window.__sharedProjectQA.history.getUndoStack().length)).toBe(1);
  await page.evaluate(() => window.__sharedProjectQA.store.getState().undo());
  expect(await page.evaluate(() => window.__sharedProjectQA.store.getState().tracks[40].clips[0].fadeIn)).toBe(0.1);
  await page.mouse.move(viewport.x + 30, viewport.y + 20); await page.mouse.down();
  await page.mouse.move(viewport.x + 930, viewport.y + 100, { steps: 6 });
  const marquee = await page.evaluate(() => {
    const stage = window.Konva.stages.find(candidate => candidate.container().closest("#shared-project-timeline") && candidate.height() > 100)!;
    const node = stage.findOne(".timeline-marquee");
    return node ? { position: node.getAbsolutePosition(), attrs: node.getAttrs() } : null;
  });
  expect(marquee).not.toBeNull();
  expect(marquee!.position.x).toBeCloseTo(30, 1);
  expect(marquee!.position.y).toBeCloseTo(20, 1);
  expect(marquee!.attrs.width).toBeCloseTo(900, 1);
  expect(marquee!.attrs.height).toBeCloseTo(80, 1);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__sharedProjectQA.store.getState().selectedClipIds)).toContain("deep-clip");
  await testInfo.attach("bounded-muted-hatch-geometry", { body: JSON.stringify(checks), contentType: "application/json" });
});

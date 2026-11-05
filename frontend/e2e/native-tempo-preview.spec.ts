import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ClipTempoPreviewData } from "../src/services/NativeBridge";

const payloadPath = process.env.OPENSTUDIO_TEMPO_PREVIEW_DATA;

test("actual native preview decodes without PCM changes and mixes a bounded click on one offline clock", async ({ page }) => {
  test.skip(!payloadPath, "Opt in with OPENSTUDIO_TEMPO_PREVIEW_DATA pointing to a native qualification JSON artifact");
  const resolved = path.resolve(payloadPath!);
  const payload = JSON.parse(fs.readFileSync(resolved, "utf8")) as ClipTempoPreviewData;
  const wavePath = resolved.replace(/\.json$/i, ".wav");
  const wave = fs.readFileSync(wavePath);
  expect(payload.error).toBeUndefined();
  expect(payload.wavBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  expect(Buffer.from(payload.wavBase64!, "base64").equals(wave)).toBe(true);
  let format = 0, channels = 0, sampleRate = 0, dataOffset = 0, dataBytes = 0;
  for (let at = 12; at + 8 <= wave.length;) {
    const id = wave.toString("ascii", at, at + 4), count = wave.readUInt32LE(at + 4);
    if (id === "fmt ") { format = wave.readUInt16LE(at + 8); channels = wave.readUInt16LE(at + 10); sampleRate = wave.readUInt32LE(at + 12); }
    if (id === "data") { dataOffset = at + 8; dataBytes = count; break; }
    at += 8 + count + count % 2;
  }
  expect(format).toBe(3); expect(channels).toBe(payload.numChannels); expect(sampleRate).toBe(payload.sampleRate);
  const frames = dataBytes / 4 / channels;
  expect(frames).toBeGreaterThan(0); expect(frames / sampleRate).toBe(payload.durationSeconds);
  const expected = Array.from({ length: channels }, (_, channel) => Array.from({ length: frames }, (_, frame) => wave.readFloatLE(dataOffset + (frame * channels + channel) * 4)));
  await page.goto("/");
  const browser = await page.evaluate(async ({ payload, expected, sampleRate, frames, channels }) => {
    const binary = atob(payload.wavBase64!), bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
    const decoding = new OfflineAudioContext(channels, frames, sampleRate);
    const decoded = await decoding.decodeAudioData(bytes.buffer);
    let decodeError = 0, peak = 0, finite = true;
    for (let channel = 0; channel < channels; channel++) {
      const pcm = decoded.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) {
        decodeError = Math.max(decodeError, Math.abs(pcm[frame] - expected[channel][frame]));
        peak = Math.max(peak, Math.abs(pcm[frame])); finite &&= Number.isFinite(pcm[frame]);
      }
    }
    const moduleUrl = "/src/utils/tempoAudition.ts";
    const { TempoAuditionPlayer } = await import(/* @vite-ignore */ moduleUrl) as typeof import("../src/utils/tempoAudition");
    const render = async (clickLevel: number) => {
      const context = new OfflineAudioContext(channels, Math.ceil((payload.durationSeconds! + 0.2) * sampleRate), sampleRate);
      // This facade changes only lifecycle methods. All decoding, AudioNodes,
      // parameter automation, clocks and rendering are the browser's real API.
      const facade = new Proxy(context, { get(target, property) {
        if (property === "state") return "running";
        if (property === "resume" || property === "close") return () => Promise.resolve();
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const player = new TempoAuditionPlayer(() => facade as unknown as AudioContext);
      await player.play({ bpm: 137.23, phaseSeconds: 0.217, rangeStartSeconds: payload.rangeStartSeconds!,
        durationSeconds: payload.durationSeconds!, wavBase64: payload.wavBase64, clickLevel });
      const output = await context.startRendering(); player.dispose(); return output;
    };
    const source = await render(0), mixed = await render(0.2);
    const gain = Math.min(0.65, 0.7 / Math.max(1e-8, peak)), leadFrames = Math.round(0.05 * sampleRate);
    let sourceError = 0, preRollPeak = 0, outsideClickPeak = 0, differencePeak = 0;
    const period = 60 / 137.23, phase = 0.217, start = payload.rangeStartSeconds!, duration = payload.durationSeconds!;
    const clickTimes: number[] = [];
    for (let beat = Math.ceil((start - phase) / period); phase + beat * period < start + duration; beat++) clickTimes.push(0.05 + phase + beat * period - start);
    const clickEnergy = clickTimes.map(() => 0);
    for (let channel = 0; channel < channels; channel++) {
      const dry = source.getChannelData(channel), sum = mixed.getChannelData(channel);
      for (let frame = 0; frame < source.length; frame++) {
        const original = frame >= leadFrames && frame < leadFrames + frames ? expected[channel][frame - leadFrames] * gain : 0;
        sourceError = Math.max(sourceError, Math.abs(dry[frame] - original));
        if (frame < leadFrames) preRollPeak = Math.max(preRollPeak, Math.abs(sum[frame]));
        const difference = sum[frame] - dry[frame], seconds = frame / sampleRate;
        differencePeak = Math.max(differencePeak, Math.abs(difference));
        const tick = clickTimes.findIndex(time => seconds >= time - 2 / sampleRate && seconds < time + 0.026);
        if (tick >= 0) clickEnergy[tick] += difference * difference;
        else outsideClickPeak = Math.max(outsideClickPeak, Math.abs(difference));
      }
    }
    return { decoded: { channels: decoded.numberOfChannels, sampleRate: decoded.sampleRate, frames: decoded.length },
      finite, decodeError, sourceError, preRollPeak, outsideClickPeak, differencePeak, clickTimes, clickEnergy,
      output: "OfflineAudioContext only; no speaker output", subjectiveAudioQuality: "not_asserted" };
  }, { payload, expected, sampleRate, frames, channels });
  expect(browser.decoded).toEqual({ channels, sampleRate, frames });
  expect(browser.finite).toBe(true); expect(browser.decodeError).toBe(0);
  expect(browser.sourceError).toBeLessThan(1e-6); expect(browser.preRollPeak).toBe(0);
  expect(browser.outsideClickPeak).toBeLessThan(1e-7); expect(browser.differencePeak).toBeGreaterThan(0.01);
  expect(browser.clickEnergy.length).toBeGreaterThan(0); expect(browser.clickEnergy.every(energy => energy > 1e-6)).toBe(true);
  const output = path.resolve("../output/playwright/native-tempo-preview"); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ artifact: resolved,
    nativeWavSha256: crypto.createHash("sha256").update(wave).digest("hex"), bytes: wave.length,
    rangeStartSeconds: payload.rangeStartSeconds, sourceOffsetSeconds: payload.sourceOffsetSeconds, ...browser }, null, 2));
});

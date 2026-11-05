import { expect, test } from "@playwright/test";
import type { useDAWStore } from "../src/store/useDAWStore";

declare global { interface Window { __preparedRecordingQA: { store: typeof useDAWStore;
  release: ((success: boolean) => void) | null; starts: number } } }

test("record preparation keeps the playhead stopped and supports cancellation before native commit", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Starting OpenStudio...", { exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const source = await (await fetch("/src/App.tsx")).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("Store URL missing");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
    const qa = window.__preparedRecordingQA = { store, release: null as ((success: boolean) => void) | null, starts: 0 };
    nativeBridge.startPreparedRecording = async () => { qa.starts++; return new Promise<boolean>(resolve => { qa.release = resolve; }); };
    nativeBridge.addTrack = async id => id ?? "recording-ui-track";
    nativeBridge.setTransportPlaying = async () => true;
    nativeBridge.setTransportRecording = async () => true;
    nativeBridge.getLastCompletedClips = async () => [];
    nativeBridge.getLastCompletedMIDIClips = async () => [];
    const track = createDefaultTrack("recording-ui-track", "Input"); track.armed = true;
    store.setState({ tracks: [track], showGettingStarted: false, inputProfileOnboardingSeen: true, autoBackupEnabled: false,
      showMixer: false, syncClipsWithBackend: async () => {},
      transport: { ...store.getState().transport, currentTime: 17.25, isPlaying: false, isRecording: false, loopEnabled: false } });
  });
  const transport = page.getByRole("contentinfo", { name: "Transport controls" });
  await transport.getByRole("button", { name: "Record", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__preparedRecordingQA.starts)).toBe(1);
  await expect(transport.getByRole("status", { name: "Transport status: Preparing recording" })).toBeVisible();
  await expect(transport.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  await expect(transport.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cancel recording preparation" })).toHaveCount(2);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => {
    const state = window.__preparedRecordingQA.store.getState();
    return { currentTime: state.transport.currentTime, playing: state.transport.isPlaying,
      recording: state.transport.isRecording, clips: state.recordingClips.length };
  })).toEqual({ currentTime: 17.25, playing: false, recording: false, clips: 0 });
  await transport.getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => window.__preparedRecordingQA.release?.(true));
  await expect(transport.getByRole("status", { name: "Transport status: Stopped" })).toBeVisible();
  expect(await page.evaluate(() => window.__preparedRecordingQA.store.getState().transport.isRecording)).toBe(false);

  await transport.getByRole("button", { name: "Record", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__preparedRecordingQA.starts)).toBe(2);
  await page.evaluate(() => window.__preparedRecordingQA.release?.(true));
  await expect(transport.getByRole("status", { name: "Transport status: Recording" })).toBeVisible();
  expect(await page.evaluate(() => window.__preparedRecordingQA.store.getState().recordingClips)).toHaveLength(1);
  await transport.getByRole("button", { name: "Stop", exact: true }).click();
});

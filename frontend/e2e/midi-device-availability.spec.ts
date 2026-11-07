import { expect, test, type Page } from "@playwright/test";
import type { useDAWStore } from "../src/store/useDAWStore";

declare global { interface Window { __midiAvailabilityQA: {
  store: typeof useDAWStore;
  resolveInputs: ((devices: string[]) => void) | null;
  rejectInputs: (() => void) | null;
} } }

async function ready(page: Page, availableOutputs = ["Available output"]) {
  await page.goto("/");
  await page.getByText("Starting OpenStudio...", { exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(async (outputs) => {
    const source = await (await fetch("/src/App.tsx")).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("Store URL missing");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
    const qa = window.__midiAvailabilityQA = { store,
      resolveInputs: null as ((devices: string[]) => void) | null, rejectInputs: null as (() => void) | null };
    nativeBridge.getMIDIInputDevices = async () => await new Promise<string[]>((resolve, reject) => {
      qa.resolveInputs = resolve; qa.rejectInputs = () => reject(new Error("Device enumeration unavailable"));
    });
    nativeBridge.getMIDIOutputDevices = async () => outputs;
    nativeBridge.getOpenMIDIDevices = async () => [];
    const track = createDefaultTrack("missing-midi-route", "MIDI route", "#a855f7", "midi", []);
    track.midiInputDevice = "TD-17"; track.midiOutputDevice = "Saved synth";
    store.setState({ tracks: [track], selectedTrackId: track.id, selectedTrackIds: [track.id],
      showGettingStarted: false, inputProfileOnboardingSeen: true, showMixer: false, autoBackupEnabled: false,
      syncClipsWithBackend: async () => {} });
  }, availableOutputs);
}

const routes = (page: Page) => page.evaluate(() => {
  const track = window.__midiAvailabilityQA.store.getState().tracks[0];
  return { input: track.midiInputDevice, output: track.midiOutputDevice };
});

test("missing saved MIDI routes remain visibly selected through checking and successful enumeration", async ({ page }) => {
  await ready(page);
  const checkingInput = page.getByTitle("TD-17 (checking)", { exact: true });
  await expect(checkingInput).toHaveValue("TD-17");
  await expect(page.getByTitle("MIDI out: Saved synth (checking)", { exact: true })).toHaveValue("Saved synth");
  expect(await checkingInput.evaluate((node: HTMLSelectElement) => ({ label: node.selectedOptions[0].label,
    disabled: node.selectedOptions[0].disabled }))).toEqual({ label: "TD-17 (checking)", disabled: true });
  await expect.poll(() => page.evaluate(() => !!window.__midiAvailabilityQA.resolveInputs)).toBe(true);
  await page.evaluate(() => window.__midiAvailabilityQA.resolveInputs?.(["Available keyboard"]));
  const unavailable = page.getByTitle("TD-17 (unavailable)", { exact: true });
  await expect(unavailable).toHaveValue("TD-17");
  await expect(page.getByTitle("MIDI out: Saved synth (unavailable)", { exact: true })).toHaveValue("Saved synth");
  expect(await unavailable.evaluate((node: HTMLSelectElement) => ({ label: node.selectedOptions[0].label,
    disabled: node.selectedOptions[0].disabled }))).toEqual({ label: "TD-17 (unavailable)", disabled: true });
  expect(await routes(page)).toEqual({ input: "TD-17", output: "Saved synth" });
  await page.evaluate(() => window.__midiAvailabilityQA.store.setState(state => ({
    tracks: state.tracks.map(track => ({ ...track, midiInputDevice: "Available keyboard", midiOutputDevice: "Available output" })) })));
  await expect(page.getByTitle("Available keyboard", { exact: true })).toHaveValue("Available keyboard");
  await expect(page.getByTitle("MIDI out: Available output", { exact: true })).toHaveValue("Available output");
  expect(await page.getByTitle("Available keyboard", { exact: true }).evaluate((node: HTMLSelectElement) => node.selectedOptions[0].disabled)).toBe(false);
  await page.evaluate(() => window.__midiAvailabilityQA.store.setState(state => ({
    tracks: state.tracks.map(track => ({ ...track, midiInputDevice: "", midiOutputDevice: "" })) })));
  await expect(page.getByTitle("All MIDI inputs", { exact: true })).toHaveValue("");
  await expect(page.getByTitle("No MIDI output", { exact: true })).toHaveValue("");
});

test("available legacy saved device names retain their normal selectable labels", async ({ page }) => {
  await ready(page, ["Saved synth"]);
  await expect.poll(() => page.evaluate(() => !!window.__midiAvailabilityQA.resolveInputs)).toBe(true);
  await page.evaluate(() => window.__midiAvailabilityQA.resolveInputs?.(["TD-17"]));
  const input = page.getByTitle("TD-17", { exact: true });
  const output = page.getByTitle("MIDI out: Saved synth", { exact: true });
  await expect(input).toHaveValue("TD-17"); await expect(output).toHaveValue("Saved synth");
  expect(await input.evaluate((node: HTMLSelectElement) => ({ label: node.selectedOptions[0].label,
    disabled: node.selectedOptions[0].disabled }))).toEqual({ label: "TD-17", disabled: false });
  expect(await output.evaluate((node: HTMLSelectElement) => node.selectedOptions[0].disabled)).toBe(false);
  expect(await routes(page)).toEqual({ input: "TD-17", output: "Saved synth" });
});

test("failed enumeration labels saved MIDI routes unverified without remapping", async ({ page }) => {
  await ready(page);
  await expect.poll(() => page.evaluate(() => !!window.__midiAvailabilityQA.rejectInputs)).toBe(true);
  await page.evaluate(() => window.__midiAvailabilityQA.rejectInputs?.());
  const input = page.getByTitle("TD-17 (unverified)", { exact: true });
  await expect(input).toHaveValue("TD-17");
  await expect(page.getByTitle("MIDI out: Saved synth (unverified)", { exact: true })).toHaveValue("Saved synth");
  expect(await input.evaluate((node: HTMLSelectElement) => node.selectedOptions[0].label)).toBe("TD-17 (unverified)");
  expect(await routes(page)).toEqual({ input: "TD-17", output: "Saved synth" });
});

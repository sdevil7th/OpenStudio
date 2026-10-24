import { expect, test, type Page } from "@playwright/test";
import type { createDefaultTrack, useDAWStore } from "../src/store/useDAWStore";
import type { nativeBridge } from "../src/services/NativeBridge";
import type {} from "./support/interactionFixtureTypes";
import { primaryModifier } from "./support/platformInput";

interface PeakRequest {
  trackId: string;
  samplesPerPixel: number;
  numPixels: number;
  startSample: number;
  zoom: number;
  scrollX: number;
  completed: boolean;
}
interface RecordingZoomFixture {
  store: typeof useDAWStore;
  requests: PeakRequest[];
  hold: boolean;
  pending: number;
  maxPending: number;
  timeUpdates: number;
  anchorX: number | null;
  press: { zoom: number; scrollX: number; time: number } | null;
  publications: { zoom: number; scrollX: number }[];
  release: () => void;
  cleanup: () => void;
}
declare global {
  interface Window {
    __recordingZoomIntegration: RecordingZoomFixture;
    __recordingZoomModules: {
      store: typeof useDAWStore;
      createDefaultTrack: typeof createDefaultTrack;
      nativeBridge: typeof nativeBridge;
    };
  }
}

const SAMPLE_RATE = 44100;
const TRACK_COLORS = ["#4361ee", "#4cc9f0"];
const paint = (page: Page) => page.evaluate(() => new Promise<void>(resolve => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}));

async function ready(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({
      schemaVersion: 1, keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true,
    }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/?platform=windows&windowChrome=native");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden();
  await expect(page.getByRole("contentinfo", { name: "Transport controls" })).toBeVisible();
  // Use App's exact module URLs so the fixture shares its store/bridge. Load
  // them through a document-owned module script: dynamic import inside a CDP
  // evaluation can lose its pending Promise to Chromium garbage collection.
  const appResponse = await page.request.get("/src/App.tsx");
  expect(appResponse.ok()).toBe(true);
  const source = await appResponse.text();
  const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
  const bridgeUrl = source.match(/from "([^"]*NativeBridge\.ts[^"]*)"/)?.[1];
  if (!storeUrl || !bridgeUrl) throw new Error("App store/bridge imports were not found");
  await page.addScriptTag({ type: "module", content: `
    import { useDAWStore as store, createDefaultTrack } from ${JSON.stringify(storeUrl)};
    import { nativeBridge } from ${JSON.stringify(bridgeUrl)};
    window.__recordingZoomModules = { store, createDefaultTrack, nativeBridge };
  ` });
  await page.waitForFunction(() => Boolean(window.__recordingZoomModules));
  await page.evaluate(() => {
    const { store, createDefaultTrack, nativeBridge } = window.__recordingZoomModules;
    const originalPeaks = nativeBridge.getRecordingPeaks;
    let releasePending: (() => void) | undefined;
    let serial = Promise.resolve();
    const fixture: RecordingZoomFixture = {
      store, requests: [], hold: false, pending: 0, maxPending: 0, timeUpdates: 0,
      anchorX: null, press: null, publications: [], release: () => releasePending?.(), cleanup: () => {},
    };
    window.__recordingZoomIntegration = fixture;
    nativeBridge.getRecordingPeaks = (trackId, samplesPerPixel, numPixels, startSample = 0) => {
      const state = store.getState();
      const clipStart = state.recordingClips.find(clip => clip.trackId === trackId)?.startTime ?? 0;
      const availableSamples = Math.floor((state.transport.currentTime - clipStart) * 44100);
      const request: PeakRequest = {
        trackId, samplesPerPixel, numPixels, startSample, zoom: state.pixelsPerSecond,
        scrollX: state.scrollX, completed: false,
      };
      fixture.requests.push(request);
      fixture.maxPending = Math.max(fixture.maxPending, ++fixture.pending);
      // Model a serial native boundary. A response already in progress may
      // contain valid old samples even after the UI has stopped recording.
      const response = serial.then(async () => {
        if (fixture.hold) await new Promise<void>(resolve => {
          releasePending = () => { releasePending = undefined; resolve(); };
        });
        const count = Math.max(0, Math.min(numPixels, 8192,
          Math.floor((availableSamples - startSample) / samplesPerPixel)));
        const peaks = Array.from({ length: count }, (_, index) => {
          const amplitude = 0.25 + ((Math.floor(startSample / samplesPerPixel) + index) % 8) * 0.025;
          return { channels: [{ min: -amplitude, max: amplitude }] };
        });
        request.completed = true;
        fixture.pending -= 1;
        return peaks;
      });
      serial = response.then(() => undefined);
      return response;
    };
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transport.currentTime !== previous.transport.currentTime) fixture.timeUpdates += 1;
      if (fixture.anchorX !== null && (state.pixelsPerSecond !== previous.pixelsPerSecond || state.scrollX !== previous.scrollX))
        fixture.publications.push({ zoom: state.pixelsPerSecond, scrollX: state.scrollX });
    });
    // Observe the actual press-to-release interval, including queued follow work
    // before vertical intent locks. Driver delays outside it are unrelated.
    const observePress = (event: MouseEvent) => {
      const canvas = event.target;
      if (event.button !== 0 || !(canvas instanceof HTMLCanvasElement)
        || !canvas.closest(".workspace-sticky-ruler")) return;
      const state = store.getState();
      fixture.press = { zoom: state.pixelsPerSecond, scrollX: state.scrollX, time: state.transport.currentTime };
      fixture.anchorX = event.clientX - canvas.getBoundingClientRect().left;
      fixture.publications = [];
    };
    const finishObservation = () => { fixture.anchorX = null; };
    window.addEventListener("mousedown", observePress, true);
    // Production window handlers are already registered and flush the final
    // transform before these listeners end observation.
    window.addEventListener("mouseup", finishObservation);
    window.addEventListener("pointercancel", finishObservation);
    window.addEventListener("blur", finishObservation);
    fixture.cleanup = () => {
      window.removeEventListener("mousedown", observePress, true);
      window.removeEventListener("mouseup", finishObservation);
      window.removeEventListener("pointercancel", finishObservation);
      window.removeEventListener("blur", finishObservation);
      store.setState({ recordingClips: [], recordSession: null,
        transport: { ...store.getState().transport, isPlaying: false, isRecording: false } });
      fixture.hold = false;
      fixture.release();
      unsubscribe();
      nativeBridge.getRecordingPeaks = originalPeaks;
    };
    const first = createDefaultTrack("record-zoom-a", "Recording A", "#4361ee", "audio", []);
    const second = createDefaultTrack("record-zoom-b", "Recording B", "#4cc9f0", "audio", [first]);
    first.armed = second.armed = true;
    store.setState({
      tracks: [first, second], selectedTrackId: first.id, selectedTrackIds: [first.id],
      selectedClipIds: [], selectedClipId: null, showMixer: false, showGettingStarted: false,
      showPianoRoll: false, showPitchEditor: false, showPreferences: false, showSettings: false,
      inputProfileOnboardingSeen: true, keyboardShortcutProfileId: "openstudio", customShortcuts: {},
      pixelsPerSecond: 100, scrollX: 55000, scrollY: 0, snapEnabled: false, autoBackupEnabled: false,
      autoScrollDuringPlayback: true, playheadStopBehavior: "stop-in-place",
      mouseBehaviorProfileId: "openstudio", mouseModifiers: {}, timeSelection: null,
      projectRange: { start: 0, end: 600 },
      recordingClips: [{ trackId: first.id, startTime: 0 }, { trackId: second.id, startTime: 0 }],
      recordSession: { id: "recording-zoom-regression", startTime: 0, trackIds: [first.id, second.id] },
      transport: { ...store.getState().transport, currentTime: 556, isPlaying: true, isRecording: true, loopEnabled: false },
    });
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await expect.poll(() => geometry(page).then(value => value.lines.length)).toBe(2);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const state = window.__recordingZoomIntegration.store.getState();
    const stage = window.Konva.stages.find(candidate => candidate.height() > 50 && candidate.container().closest(".workspace"));
    const lines = stage?.find("Line").filter(node => node instanceof window.Konva.Line
      && node.closed() && node.opacity() === 0.8 && node.strokeWidth() === 0.5) ?? [];
    return {
      zoom: state.pixelsPerSecond, scrollX: state.scrollX, time: state.transport.currentTime,
      recording: state.transport.isRecording, range: state.projectRange,
      width: stage?.width() ?? 0,
      lines: lines.map(node => {
        const line = node as InstanceType<typeof window.Konva.Line>;
        const points = line.points();
        return { color: line.stroke(), firstX: points[0], secondX: points[2], pointCount: points.length };
      }),
    };
  });
}

async function holdNextRequest(page: Page) {
  await page.evaluate(() => { window.__recordingZoomIntegration.hold = true; });
  await expect.poll(() => page.evaluate(() => window.__recordingZoomIntegration.pending)).toBe(1);
  return page.evaluate(() => window.__recordingZoomIntegration.requests.length);
}

async function dragRuler(page: Page, dy: number, dx = 0) {
  const bounds = await page.locator(".workspace-sticky-ruler canvas").first().boundingBox();
  if (!bounds) throw new Error("Visible workspace ruler is missing");
  const x = Math.min(350, bounds.width / 2);
  await page.mouse.move(bounds.x + x, bounds.y + 18);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(bounds.x + x + dx * step / 6, bounds.y + 18 + dy * step / 6);
    await paint(page);
  }
  await page.mouse.up();
  await paint(page);
  const { before, publications } = await page.evaluate(() => {
    const fixture = window.__recordingZoomIntegration;
    if (!fixture.press) throw new Error("Ruler press was not observed");
    return { before: fixture.press, publications: fixture.publications };
  });
  return { before, after: await geometry(page), publications, anchorX: x };
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__recordingZoomIntegration?.cleanup());
});

test("long two-track recording keeps ruler zoom bounded, anchored and sample-aligned", async ({ page }, testInfo) => {
  await ready(page);
  const callsAtHold = await holdNextRequest(page);
  const baseline = await geometry(page);
  const baselineRequests = await page.evaluate(() => window.__recordingZoomIntegration.requests.filter(request => request.completed));
  // The large downward gesture also pushes the live playhead beyond the usual
  // follow threshold; auto-follow must leave the active zoom anchor alone.
  for (const dy of [-36, 110, -24]) {
    const drag = await dragRuler(page, dy);
    expect(dy > 0 ? drag.after.zoom > drag.before.zoom : drag.after.zoom < drag.before.zoom).toBe(true);
    expect(drag.after.range).toEqual(baseline.range);
    expect(drag.publications.length).toBeGreaterThan(0);
    for (const publication of drag.publications)
      expect((publication.scrollX + drag.anchorX) / publication.zoom)
        .toBeCloseTo((drag.before.scrollX + drag.anchorX) / drag.before.zoom, 6);
    // Cached samples may be hidden while refreshing, but must never retain
    // pixel geometry from a previous zoom when they remain visible.
    for (const line of drag.after.lines) {
      const trackId = line.color === TRACK_COLORS[0] ? "record-zoom-a" : "record-zoom-b";
      const previous = [...baselineRequests].reverse().find(request => request.trackId === trackId);
      expect(previous).toBeDefined();
      const expectedSpacing = previous!.samplesPerPixel / SAMPLE_RATE * drag.after.zoom;
      expect(line.secondX - line.firstX).toBeCloseTo(expectedSpacing, 5);
      const bin = (line.firstX + drag.after.scrollX) / expectedSpacing;
      expect(bin).toBeCloseTo(Math.round(bin), 4);
      expect(line.pointCount).toBeLessThan((drag.after.width + 256) * 8);
    }
  }
  const beforeScroll = await geometry(page);
  await page.locator(".timeline-container").hover();
  await page.mouse.wheel(280, 0);
  await paint(page);
  await expect.poll(() => geometry(page).then(value => value.scrollX)).toBeGreaterThan(beforeScroll.scrollX);
  await expect.poll(() => geometry(page).then(value => value.time)).toBeGreaterThan(baseline.time);
  const pending = await page.evaluate(() => ({
    count: window.__recordingZoomIntegration.requests.length,
    maximum: window.__recordingZoomIntegration.maxPending,
    updates: window.__recordingZoomIntegration.timeUpdates,
  }));
  expect(pending.count).toBe(callsAtHold);
  expect(pending.maximum).toBe(1);
  expect(pending.updates).toBeGreaterThan(0);
  await page.evaluate(() => { const fixture = window.__recordingZoomIntegration; fixture.hold = false; fixture.release(); });
  await expect.poll(() => page.evaluate(() => window.__recordingZoomIntegration.requests.length)).toBeGreaterThan(callsAtHold);
  const requests = await page.evaluate(() => window.__recordingZoomIntegration.requests);
  for (const request of requests) {
    expect(request.startSample).toBeGreaterThan(0);
    expect(request.numPixels).toBeLessThanOrEqual(8192);
    expect(request.numPixels * request.samplesPerPixel / SAMPLE_RATE * request.zoom).toBeLessThan(baseline.width * 4 + 512);
  }
  await testInfo.attach("recording-zoom-boundary", { body: JSON.stringify({
    scope: "Browser interaction with a controlled serial peak service; native timing/audio are not asserted.",
    seededSeconds: 556, pending, requests,
  }, null, 2), contentType: "application/json" });
});

test("Stop retires pending recording peaks without issuing the old next-track request", async ({ page }) => {
  await ready(page);
  const callsAtHold = await holdNextRequest(page);
  await dragRuler(page, 35);
  await page.getByRole("contentinfo", { name: "Transport controls" })
    .getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => geometry(page).then(value => value.recording)).toBe(false);
  await expect.poll(() => geometry(page).then(value => value.lines.length)).toBe(0);
  await page.evaluate(() => { const fixture = window.__recordingZoomIntegration; fixture.hold = false; fixture.release(); });
  await expect.poll(() => page.evaluate(() => window.__recordingZoomIntegration.pending)).toBe(0);
  await paint(page);
  expect(await page.evaluate(() => window.__recordingZoomIntegration.requests.length)).toBe(callsAtHold);
  expect((await geometry(page)).lines).toEqual([]);
});

test("horizontal ruler range selection remains usable while live peak service is pending", async ({ page }) => {
  await ready(page);
  const callsAtHold = await holdNextRequest(page);
  const drag = await dragRuler(page, 0, 90);
  expect(drag.after.zoom).toBe(drag.before.zoom);
  expect(drag.after.range.start).toBeCloseTo((drag.before.scrollX + drag.anchorX) / drag.before.zoom, 6);
  expect(drag.after.range.end).toBeCloseTo((drag.before.scrollX + drag.anchorX + 90) / drag.before.zoom, 6);
  expect(await page.evaluate(() => window.__recordingZoomIntegration.requests.length)).toBe(callsAtHold);
  await expect.poll(() => geometry(page).then(value => value.time)).toBeGreaterThan(drag.before.time);
});

test("recording respects the automatic-scroll preference", async ({ page }) => {
  await ready(page);
  const before = await geometry(page);
  await page.evaluate(() => window.__recordingZoomIntegration.store.setState({
    autoScrollDuringPlayback: false, scrollX: 1000,
  }));
  await expect.poll(() => geometry(page).then(value => value.time)).toBeGreaterThan(before.time);
  await paint(page);
  expect((await geometry(page)).scrollX).toBe(1000);
  await page.evaluate(() => window.__recordingZoomIntegration.store.setState({ autoScrollDuringPlayback: true }));
  await expect.poll(() => geometry(page).then(value => value.scrollX)).toBeGreaterThan(1000);
});

for (const [surface, selector] of [
  ["sticky ruler", ".workspace-sticky-ruler canvas"],
  ["timeline body", ".timeline-container canvas"],
] as const) {
  test(`${surface} preserves zoom then pan when wheel modifiers change before a frame`, async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__recordingZoomIntegration.store.setState({ autoScrollDuringPlayback: false }));
    await paint(page);
    const before = await geometry(page);
    const anchorX = 350;
    const panPixels = 96;
    const zoomModifier = await primaryModifier(page);
    // One synchronous browser task guarantees no animation frame can separate
    // these packets; real wheel handlers still resolve modifiers and route them.
    const prevented = await page.locator(selector).first().evaluate((element, { anchorX, panPixels, zoomModifier }) => {
      const bounds = element.getBoundingClientRect();
      const common = { bubbles: true, cancelable: true, deltaMode: 0,
        clientX: bounds.left + anchorX, clientY: bounds.top + 18 };
      const zoom = new WheelEvent("wheel", { ...common, deltaY: -80,
        ctrlKey: zoomModifier === "Control", metaKey: zoomModifier === "Meta" });
      const pan = new WheelEvent("wheel", { ...common, deltaX: panPixels });
      element.dispatchEvent(zoom);
      element.dispatchEvent(pan);
      return { zoom: zoom.defaultPrevented, pan: pan.defaultPrevented };
    }, { anchorX, panPixels, zoomModifier });
    await paint(page);
    const after = await geometry(page);
    expect(prevented).toEqual({ zoom: true, pan: true });
    expect(after.zoom).toBeGreaterThan(before.zoom);
    const anchoredScroll = (before.scrollX + anchorX) / before.zoom * after.zoom - anchorX;
    expect(after.scrollX).toBeCloseTo(anchoredScroll + panPixels, 6);
    expect(after.range).toEqual(before.range);
  });
}

for (const termination of ["vertical zoom", "mouseup", "pointercancel", "blur"] as const) {
  test(`pending ruler press protects its anchor and recovers after ${termination}`, async ({ page }) => {
    await ready(page);
    const callsAtHold = await holdNextRequest(page);
    const canvas = page.locator(".workspace-sticky-ruler canvas").first();
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Visible workspace ruler is missing");
    const anchorX = Math.min(350, bounds.width / 2);
    await page.mouse.move(bounds.x + anchorX, bounds.y + 18);
    // Queue real automatic follow in the same input task, before the ruler
    // claims the press. Its pending RAF must not overwrite the pressed anchor.
    await canvas.evaluate(element => element.addEventListener("mousedown", () => {
      const store = window.__recordingZoomIntegration.store;
      store.getState().setCurrentTime(store.getState().transport.currentTime + 15);
    }, { capture: true, once: true }));
    await page.mouse.down();
    const pressed = await geometry(page);
    const press = await page.evaluate(() => window.__recordingZoomIntegration.press!);
    expect(pressed.time * press.zoom - press.scrollX).toBeGreaterThan(pressed.width);
    await page.evaluate(() => {
      const fixture = window.__recordingZoomIntegration;
      fixture.hold = false;
      fixture.release();
    });
    await expect.poll(() => page.evaluate(() => window.__recordingZoomIntegration.pending)).toBe(0);
    // Wait for advancing transport, past the ordinary 200ms zoom idle period.
    await expect.poll(() => geometry(page).then(value => value.time)).toBeGreaterThan(pressed.time + 0.45);
    const pending = await geometry(page);
    expect(pending.zoom).toBe(press.zoom);
    expect(pending.scrollX).toBeCloseTo(press.scrollX, 6);
    expect(await page.evaluate(() => window.__recordingZoomIntegration.requests.length)).toBe(callsAtHold);

    if (termination === "vertical zoom") {
      await page.mouse.move(bounds.x + anchorX, bounds.y + 108);
      await paint(page);
      const zoomed = await geometry(page);
      expect(zoomed.zoom).toBeGreaterThan(press.zoom);
      expect((zoomed.scrollX + anchorX) / zoomed.zoom)
        .toBeCloseTo((press.scrollX + anchorX) / press.zoom, 6);
      const publications = await page.evaluate(() => window.__recordingZoomIntegration.publications);
      expect(publications.length).toBeGreaterThan(0);
      for (const publication of publications)
        expect((publication.scrollX + anchorX) / publication.zoom)
          .toBeCloseTo((press.scrollX + anchorX) / press.zoom, 6);
    } else if (termination !== "mouseup") {
      await page.evaluate(event => window.dispatchEvent(new Event(event)), termination);
    }
    await page.mouse.up();
    expect(await page.evaluate(() => window.__recordingZoomIntegration.store.getState().isTimelineRulerZooming)).toBe(false);
    const released = await geometry(page);
    // A click can seek inside the viewport; move transport past its right edge
    // to verify that follow and polling recover after every termination path.
    await page.evaluate(() => {
      const store = window.__recordingZoomIntegration.store;
      store.getState().setCurrentTime(590);
    });
    await expect.poll(() => geometry(page).then(value => value.scrollX)).toBeGreaterThan(released.scrollX);
    await expect.poll(() => page.evaluate(() => window.__recordingZoomIntegration.requests.length)).toBeGreaterThan(callsAtHold);
    expect((await geometry(page)).range).toEqual(pressed.range);
  });
}

for (const termination of ["mouseup", "pointercancel", "blur"] as const) {
  test(`held ruler zoom pauses follow and preview polling until ${termination}`, async ({ page }) => {
    await ready(page);
    const callsAtHold = await holdNextRequest(page);
    const bounds = await page.locator(".workspace-sticky-ruler canvas").first().boundingBox();
    if (!bounds) throw new Error("Visible workspace ruler is missing");
    const anchorX = Math.min(350, bounds.width / 2);
    const rangeBefore = (await geometry(page)).range;
    await page.mouse.move(bounds.x + anchorX, bounds.y + 18);
    await page.mouse.down();
    const before = await page.evaluate(() => window.__recordingZoomIntegration.press!);
    await page.mouse.move(bounds.x + anchorX, bounds.y + 118);
    await paint(page);
    const held = await geometry(page);
    expect(held.zoom).toBeGreaterThan(before.zoom);
    // Ensure follow would actually trigger if the held gesture were forgotten.
    expect(held.time * held.zoom - held.scrollX).toBeGreaterThan(held.width);
    await page.evaluate(() => {
      const fixture = window.__recordingZoomIntegration;
      fixture.hold = false;
      fixture.release();
    });
    await expect.poll(() => page.evaluate(() => window.__recordingZoomIntegration.pending)).toBe(0);
    await expect.poll(() => geometry(page).then(value => value.time)).toBeGreaterThan(held.time + 0.45);
    const paused = await geometry(page);
    expect(paused.zoom).toBe(held.zoom);
    expect(paused.scrollX).toBeCloseTo(held.scrollX, 6);
    expect((paused.scrollX + anchorX) / paused.zoom)
      .toBeCloseTo((before.scrollX + anchorX) / before.zoom, 6);
    expect(await page.evaluate(() => window.__recordingZoomIntegration.requests.length)).toBe(callsAtHold);

    if (termination === "mouseup") await page.mouse.up();
    else {
      await page.evaluate(event => window.dispatchEvent(new Event(event)), termination);
      await page.mouse.up();
    }
    await expect.poll(() => geometry(page).then(value => value.scrollX)).toBeGreaterThan(held.scrollX);
    await expect.poll(() => page.evaluate(() => window.__recordingZoomIntegration.requests.length)).toBeGreaterThan(callsAtHold);
    expect((await geometry(page)).range).toEqual(rangeBefore);
  });
}

import type { Page } from "@playwright/test";
import type { DAWState, useDAWStore } from "../../src/store/useDAWStore";
import type { BrowserRegressionReport } from "./interactionFixtureTypes";

type RulerSeedOverrides = Partial<Pick<DAWState, "scrollX" | "projectRange">>;
interface RulerPoint { x: number; y: number; relativeX: number }
interface RulerView {
  pps: number;
  scrollX: number;
  scrollY: number;
  trackHeight: number;
  range: DAWState["projectRange"];
  selection: DAWState["timeSelection"];
  time: number;
}
declare global {
  interface Window {
    __rulerGestureQA: { store: typeof useDAWStore };
  }
}

/** Exercise the ruler mounted by App rather than Timeline's optional fixture ruler. */
export async function runRulerChecks(page: Page): Promise<BrowserRegressionReport & { surface: string }> {
  const checks: string[] = [];
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  page.on('pageerror', onPageError);
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  const near = (actual: number, expected: number, message: string) => {
    assert(Math.abs(actual - expected) < 0.00001,
      `${message}: expected ${expected}, received ${actual}`);
  };
  const same = (actual: unknown, expected: unknown, message: string) => {
    assert(JSON.stringify(actual) === JSON.stringify(expected),
      `${message}: ${JSON.stringify({ actual, expected })}`);
  };
  const paint = () => page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  try {
    await page.addInitScript(() => {
      localStorage.setItem('openstudio_essentialControlsDismissed', 'true');
    });
    await page.goto('/?platform=windows&windowChrome=native');
    await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
    await page.evaluate(async () => {
      // Follow App's transformed Vite import so HMR cannot create a second store.
      const source = await (await fetch('/src/App.tsx')).text();
      const match = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/);
      if (!match) throw new Error('Cannot locate the real App store import');
      const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ match[1]) as typeof import("../../src/store/useDAWStore");
      const track = createDefaultTrack('ruler-browser-qa', 'Ruler browser QA', '#4379ee', 'audio', []);
      window.__rulerGestureQA = { store };
      store.setState({
        tracks: [track], selectedTrackId: track.id, selectedTrackIds: [track.id],
        selectedClipId: null, selectedClipIds: [], recordingClips: [], recordingMIDIPreviews: {},
        inputProfileOnboardingSeen: true, showGettingStarted: false, showContextualHelp: false,
        showMixer: false, showPianoRoll: false, showPitchEditor: false,
        keyboardShortcutProfileId: 'openstudio', mouseBehaviorProfileId: 'openstudio',
        customShortcuts: {}, mouseModifiers: {}, toolMode: 'select',
        globalLocked: false,
        lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
        transport: { ...store.getState().transport, isPlaying: false, isRecording: false, tempo: 120 },
      });
      (document.activeElement as HTMLElement | null)?.blur();
    });
    const canvas = page.locator('.workspace-sticky-ruler canvas');
    await canvas.waitFor({ state: 'visible' });
    await paint();
    assert(await canvas.count() === 1, 'App must mount exactly one visible workspace ruler');
    assert(await page.locator('.workspace-main-row .timeline-container').count() === 1,
      'Real App timeline must remain mounted beside its track controls');
    assert(await page.locator('.timeline-container .sticky canvas').count() === 0,
      'Regression must exercise the extracted App ruler rather than the hidden Timeline ruler');

    const seed = async (options: RulerSeedOverrides = {}) => {
      await page.mouse.up();
      await page.evaluate(options => {
        const { store } = window.__rulerGestureQA;
        store.setState({
          pixelsPerSecond: 100, scrollX: 500, scrollY: 0, trackHeight: 100,
          snapEnabled: false, gridSize: '1/16', timeSignature: { numerator: 4, denominator: 4 },
          projectRange: { start: 2, end: 12 }, timeSelection: { start: 3, end: 4 },
          transport: { ...store.getState().transport, isPlaying: false, isRecording: false, currentTime: 1.25 },
          ...options,
        });
        const workspace = document.querySelector('.workspace');
        if (workspace) workspace.scrollTop = 0;
      }, options);
      await paint();
    };
    const read = () => page.evaluate(() => {
      const state = window.__rulerGestureQA.store.getState();
      return {
        pps: state.pixelsPerSecond, scrollX: state.scrollX, scrollY: state.scrollY,
        trackHeight: state.trackHeight, range: state.projectRange,
        selection: state.timeSelection, time: state.transport.currentTime,
      };
    });
    const point = async (relativeX?: number, relativeY = 18): Promise<RulerPoint> => {
      const box = await canvas.boundingBox();
      assert(box && box.width > 400 && box.height >= 25, 'Real ruler must have usable visible geometry');
      const x = Math.round(box.x + (relativeX ?? Math.min(300, box.width * 0.4)));
      return { x, y: Math.round(box.y + relativeY), relativeX: x - box.x };
    };
    const begin = async (origin: RulerPoint) => {
      await page.mouse.move(origin.x, origin.y);
      await page.mouse.down();
    };
    const move = async (origin: RulerPoint, dx: number, dy: number) => {
      await page.mouse.move(origin.x + dx, origin.y + dy, { steps: 3 });
      await paint();
    };
    const preserveNonViewState = (after: RulerView, before: RulerView, label: string) => {
      same(after.range, before.range, `${label}: project range must stay unchanged`);
      same(after.selection, before.selection, `${label}: time selection must stay unchanged`);
      near(after.time, before.time, `${label}: playhead must stay unchanged`);
      near(after.trackHeight, before.trackHeight, `${label}: track height must stay unchanged`);
      near(after.scrollY, before.scrollY, `${label}: vertical scroll must stay unchanged`);
    };
    const anchored = (after: RulerView, before: RulerView, origin: RulerPoint, label: string) => {
      near((after.scrollX + origin.relativeX) / after.pps,
        (before.scrollX + origin.relativeX) / before.pps,
        `${label}: original time must stay under the pointer-down X position`);
    };

    for (const [label, dy] of [['downward', 45], ['upward', -18]] as const) {
      await seed();
      const before = await read();
      const origin = await point();
      await begin(origin);
      await move(origin, 0, dy);
      await page.mouse.up();
      await paint();
      const after = await read();
      assert(dy > 0 ? after.pps > before.pps : after.pps < before.pps,
        `${label} ruler drag must ${dy > 0 ? 'increase' : 'decrease'} time zoom`);
      anchored(after, before, origin, label);
      preserveNonViewState(after, before, label);
      await move(origin, 100, dy + 35);
      same(await read(), after, `${label}: mouseup must end the drag`);
      checks.push(`${label} zoom keeps its time anchor, range, selection, playhead and track height; mouseup stops it`);
    }

    await seed();
    let before = await read();
    let origin = await point();
    await begin(origin);
    await move(origin, 1, 12);
    await move(origin, 130, 40);
    await page.mouse.up();
    await paint();
    let after = await read();
    assert(after.pps > before.pps, 'Vertical-first diagonal drag must keep zoom intent');
    anchored(after, before, origin, 'vertical-first diagonal');
    preserveNonViewState(after, before, 'vertical-first diagonal');
    checks.push('vertical-first diagonal movement keeps zoom intent when horizontal movement becomes larger');

    await seed();
    before = await read();
    origin = await point();
    await begin(origin);
    await move(origin, 25, 1);
    await move(origin, 140, 100);
    await page.mouse.up();
    await paint();
    after = await read();
    near(after.pps, before.pps, 'Horizontal-first diagonal drag must keep the original zoom');
    near(after.scrollX, before.scrollX, 'Horizontal range selection must keep horizontal scroll');
    const rangeStart = (before.scrollX + origin.relativeX) / before.pps;
    near(after.range.start, rangeStart, 'Horizontal ruler drag must preserve existing project-range behavior');
    near(after.range.end, rangeStart + 1.4, 'Horizontal ruler range must follow pointer X after vertical drift');
    same(after.selection, before.selection, 'Horizontal project-range drag must retain the existing time selection');
    near(after.time, before.time, 'Horizontal project-range drag must not seek');
    checks.push('horizontal-first diagonal movement retains existing project-range selection without zoom or seek');

    for (const handle of ['start', 'end'] as const) {
      await seed({ scrollX: 0, projectRange: { start: 1, end: 3 } });
      before = await read();
      origin = await point(handle === 'start' ? 100 : 300, 3);
      await begin(origin);
      await move(origin, 40, 30);
      await page.mouse.up();
      await paint();
      after = await read();
      near(after.range[handle], (before.scrollX + origin.relativeX + 40) / before.pps,
        `${handle} range handle must still resize its endpoint`);
      near(after.range[handle === 'start' ? 'end' : 'start'],
        before.range[handle === 'start' ? 'end' : 'start'], `${handle} range handle must retain the opposite endpoint`);
      near(after.pps, before.pps, `${handle} range handle must not zoom`);
      same(after.selection, before.selection, `${handle} range handle must not alter time selection`);
      near(after.time, before.time, `${handle} range handle must not seek`);
      checks.push(`${handle} range handle retains its horizontal resize behavior`);
    }

    await seed();
    before = await read();
    origin = await point();
    await begin(origin);
    await move(origin, 2, 2);
    await page.mouse.up();
    await paint();
    after = await read();
    near(after.time, (before.scrollX + origin.relativeX) / before.pps,
      'Movement below the gesture threshold must still seek to pointer-down time');
    near(after.pps, before.pps, 'Click must not zoom');
    same(after.range, before.range, 'Click must not alter project range');
    same(after.selection, before.selection, 'Click must retain existing time selection');
    checks.push('sub-threshold movement stays a click and seeks without changing zoom or ranges');

    for (const event of ['blur', 'pointercancel']) {
      await seed();
      before = await read();
      origin = await point();
      await begin(origin);
      await move(origin, 0, 15);
      const atCancel = await read();
      assert(atCancel.pps > before.pps, `${event}: vertical zoom must begin before cancellation`);
      await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
      await move(origin, 100, 60);
      same(await read(), atCancel, `${event}: further movement must not continue zooming`);
      await page.mouse.up();
      await paint();
      same(await read(), atCancel, `${event}: releasing a cancelled drag must not seek or change ranges`);
      checks.push(`${event} ends an active zoom and prevents later movement or mouseup from editing state`);
    }

    assert(pageErrors.length === 0, `Browser runtime errors: ${pageErrors.join('; ')}`);
    return { status: 'pass', surface: 'real App .workspace-sticky-ruler', checks };
  } finally {
    page.off('pageerror', onPageError);
    await page.mouse.up().catch(() => undefined);
  }
}

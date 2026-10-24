import type { Page } from "@playwright/test";
import type { BrowserRegressionReport, TrackCopyQa } from "./interactionFixtureTypes";

declare global {
  interface Window {
    __trackCopyModules: {
      store: typeof import("../../src/store/useDAWStore").useDAWStore;
      createDefaultTrack: typeof import("../../src/store/useDAWStore").createDefaultTrack;
      commandManager: typeof import("../../src/store/commands").commandManager;
    };
  }
}

export async function runTrackSelectionCopy(page: Page): Promise<BrowserRegressionReport> {
  function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
  const checks: string[] = [];
  await page.goto('/?platform=windows&windowChrome=native');
  await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('contentinfo', { name: 'Transport controls' }).waitFor();
  // Keep the pending module imports owned by the document. A CDP evaluation's
  // dynamic-import Promise can be collected before Vite finishes the load.
  const response = await page.request.get('/src/App.tsx');
  if (!response.ok()) throw new Error("App source was not available");
  const source = await response.text();
  const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
  if (!storeUrl) throw new Error("App store import was not found");
  await page.addScriptTag({ type: 'module', content: `
    import { useDAWStore as store, createDefaultTrack } from ${JSON.stringify(storeUrl)};
    import { commandManager } from "/src/store/commands/index.ts";
    window.__trackCopyModules = { store, createDefaultTrack, commandManager };
  ` });
  await page.waitForFunction(() => Boolean(window.__trackCopyModules));
  await page.evaluate(() => {
    const { store, createDefaultTrack, commandManager } = window.__trackCopyModules;
    const qa: TrackCopyQa = window.__trackCopyQA = { store, commandManager, seed: () => undefined };
    qa.seed = () => {
      commandManager.clear();
      const a = createDefaultTrack('a', 'Copy Alpha', '#4379ee', 'audio', []);
      a.clips = [{ id: 'ac', name: 'Alpha audio', filePath: 'fixture.wav', startTime: 1, duration: 2, offset: 0, volumeDB: -3, color: a.color, fadeIn: 0, fadeOut: 0 }];
      const b = createDefaultTrack('b', 'Copy Beta', '#43ee99', 'midi', []);
      b.midiClips = [{ id: 'bc', name: 'Beta MIDI', startTime: 3, duration: 2, sourceLength: 2, events: [{ timestamp: 0.2, type: 'noteOn', note: 60, velocity: 80 }], ccEvents: [], color: b.color }];
      const c = createDefaultTrack('c', 'Destination', '#ee9943', 'audio', []);
      store.setState({ tracks: [a,b,c], selectedTrackId: 'b', selectedTrackIds: ['a','b'], selectedClipIds: [], selectedClipId: null, trackHeight: 100, showPianoRoll: false, showMixer: false, inputProfileOnboardingSeen: true, globalLocked: false, lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false }, canUndo: false, canRedo: false });
    };
    qa.seed();
  });
  const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const read = () => page.evaluate(() => ({ tracks: window.__trackCopyQA.store.getState().tracks, undo: window.__trackCopyQA.commandManager.getUndoStack().length }));
  await paint();
  const origin = await page.locator('[data-track-id="a"]').boundingBox();
  assert(origin, 'source header must exist');
  const before = await read();
  await page.keyboard.down('Control');
  await page.mouse.move(origin.x + 35, origin.y + 90);
  await page.mouse.down();
  await page.mouse.move(origin.x + 150, origin.y + 90, { steps: 5 });
  await paint();
  const preview = page.locator('[data-track-drag-copy="true"]');
  await preview.waitFor({ state: 'visible' });
  assert(await preview.evaluate(node => Number(getComputedStyle(node).opacity) === 0.5), 'track copy preview must have 50% opacity');
  const previewText = await preview.textContent();
  assert(previewText?.includes('Copy Alpha') && previewText.includes('Copy Beta'), 'preview must contain every selected header');
  const during = await read();
  assert(JSON.stringify(during.tracks) === JSON.stringify(before.tracks), 'track originals remain unchanged while copying');
  const duringBox = await page.locator('[data-track-id="a"]').boundingBox();
  assert(duringBox, 'source header remains visible during copying');
  assert(Math.abs(duringBox.x - origin.x) < 1 && Math.abs(duringBox.y - origin.y) < 1, 'source header stays stationary during copy drag');
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.waitForFunction(() => window.__trackCopyQA.store.getState().tracks.length === 5);
  const after = await read();
  assert(after.undo === 1, 'whole selected-track copy must be one Undo command');
  const copies = after.tracks.filter(track => !['a','b','c'].includes(track.id));
  assert(copies.length === 2 && copies[0].clips.length === 1 && copies[1].midiClips.length === 1, 'whole copied tracks retain audio/MIDI content');
  assert(copies[0].clips[0].id !== 'ac' && copies[1].midiClips[0].id !== 'bc', 'copied tracks have independent clip identities');
  await page.evaluate(() => window.__trackCopyQA.store.getState().undo());
  await page.waitForFunction(() => window.__trackCopyQA.store.getState().tracks.length === 3);
  assert(JSON.stringify((await read()).tracks) === JSON.stringify(before.tracks), 'one Undo restores originals exactly');
  await page.evaluate(() => window.__trackCopyQA.store.getState().redo());
  await page.waitForFunction(() => window.__trackCopyQA.store.getState().tracks.length === 5);
  assert(JSON.stringify((await read()).tracks) === JSON.stringify(after.tracks), 'Redo restores copied tracks with stable identities');
  checks.push('Ctrl horizontal header drag previews all selected tracks at 50%, keeps sources stationary, copies full content with atomic Undo/Redo');
  return { status: 'pass', checks };
}

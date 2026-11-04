import type { Page } from "@playwright/test";
import type { BrowserRegressionReport, TransportKeyQa } from "./interactionFixtureTypes";

declare global {
  interface Window {
    __transportKeyModules: {
      store: typeof import("../../src/store/useDAWStore").useDAWStore;
      createDefaultTrack: typeof import("../../src/store/useDAWStore").createDefaultTrack;
    };
  }
}

export async function runSingleKeyTransport(page: Page): Promise<BrowserRegressionReport> {
  function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
  await page.addInitScript(() => {
    window.__trustedTransportKeys = [];
    window.addEventListener('keydown', event => window.__trustedTransportKeys.push({ key: event.key, repeat: event.repeat, trusted: event.isTrusted }), true);
  });
  await page.goto('/?platform=windows&windowChrome=native');
  await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('contentinfo', { name: 'Transport controls' }).waitFor();
  // As in the ruler/track-copy fixtures, let the document own module loading:
  // Chromium can collect a CDP evaluation's pending dynamic-import Promise.
  const response = await page.request.get('/src/App.tsx');
  if (!response.ok()) throw new Error("App source was not available");
  const source = await response.text();
  const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
  if (!storeUrl) throw new Error("App store import was not found");
  await page.addScriptTag({ type: 'module', content: `
    import { useDAWStore as store, createDefaultTrack } from ${JSON.stringify(storeUrl)};
    window.__transportKeyModules = { store, createDefaultTrack };
  ` });
  await page.waitForFunction(() => Boolean(window.__transportKeyModules));
  await page.evaluate(() => {
    const { store, createDefaultTrack } = window.__transportKeyModules;
    const qa: TransportKeyQa = window.__transportKeyQA = { store, calls: [], keys: window.__trustedTransportKeys };
    const track = createDefaultTrack('record-key', 'Record key QA', '#4379ee', 'audio', []);
    track.armed = true;
    store.setState({
      tracks: [track], selectedTrackId: track.id, selectedTrackIds: [track.id],
      selectedClipIds: [], selectedClipId: null, keyboardShortcutProfileId: 'openstudio',
      customShortcuts: {}, inputProfileOnboardingSeen: true, showGettingStarted: false,
      showPianoRoll: false, showMixer: false, pixelsPerSecond: 100,
      transport: { ...store.getState().transport, currentTime: 14, isPlaying: false, isRecording: false },
      toggleRecord: async () => { qa.calls.push(store.getState().recordMode); },
    });
    const input = document.createElement('input');
    input.id = 'transport-key-typing';
    input.setAttribute('aria-label', 'Shortcut typing QA');
    Object.assign(input.style, { position: 'fixed', right: '10px', top: '10px', zIndex: '99999' });
    document.body.append(input);
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const read = () => page.evaluate(() => {
    const qa = window.__transportKeyQA;
    const state = qa.store.getState();
    return { calls: qa.calls, keys: qa.keys, time: state.transport.currentTime, scrollX: state.scrollX, pps: state.pixelsPerSecond };
  });
  await page.keyboard.down('r');
  await page.keyboard.down('r');
  await page.keyboard.up('r');
  assert((await read()).calls.length === 1, 'R invokes shared Record exactly once when held/repeated');
  await page.getByRole('textbox', { name: 'Shortcut typing QA', exact: true }).focus();
  await page.keyboard.press('r');
  assert((await read()).calls.length === 1, 'typing R must not invoke Record');
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const store = window.__transportKeyQA.store;
    store.setState({ scrollX: 800, transport: { ...store.getState().transport, currentTime: 14 } });
  });
  await page.keyboard.press('1');
  await page.waitForFunction(() => window.__transportKeyQA.store.getState().transport.currentTime === 0);
  const rewound = await read();
  assert(rewound.time === 0 && rewound.scrollX === 0, '1 seeks to absolute zero and shows the project start');
  await page.keyboard.press('Shift+Equal');
  const zoomedIn = await read();
  assert(zoomedIn.pps > 100, '+ zooms the timeline in');
  await page.keyboard.press('Minus');
  const zoomedOut = await read();
  assert(zoomedOut.pps < zoomedIn.pps, '- zooms the timeline out');
  assert(zoomedOut.keys.length >= 6 && zoomedOut.keys.every(event => event.trusted), 'all shortcut inputs must be trusted browser keyboard events');
  assert(zoomedOut.keys.some(event => event.key === 'r' && event.repeat), 'held R test must include a genuine repeat event');
  return { status: 'pass', checks: ['trusted R invokes Record once, ignores repeat and typing', 'trusted 1 seeks and scrolls to absolute project beginning', 'trusted +/- changes timeline zoom'], recordCalls: zoomedOut.calls, zoomIn: zoomedIn.pps, zoomOut: zoomedOut.pps };
}

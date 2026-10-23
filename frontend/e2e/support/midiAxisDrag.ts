import type { Page } from "@playwright/test";
import type Konva from "konva";
import type { BrowserRegressionReport, MidiAxisQa } from "./interactionFixtureTypes";

export async function runMidiAxisDrag(page: Page): Promise<BrowserRegressionReport> {
  function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
  const checks: string[] = [];
  await page.goto('/?platform=windows&windowChrome=native');
  await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const reactUrl = "/node_modules/.vite/deps/react.js";
    const react = await import(/* @vite-ignore */ reactUrl) as typeof import("react") & { default?: typeof import("react") };
    const React = react.default || react;
    const domUrl = "/node_modules/.vite/deps/react-dom_client.js";
    const dom = await import(/* @vite-ignore */ domUrl) as typeof import("react-dom/client") & { default?: typeof import("react-dom/client") };
    const { createRoot } = dom.default || dom;
    const url = "/src/components/PianoRoll.tsx";
    const { PianoRoll } = await import(/* @vite-ignore */ url) as typeof import("../../src/components/PianoRoll");
    const componentSource = await (await fetch('/src/components/PianoRoll.tsx')).text();
    const storeUrl = componentSource.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("Piano Roll store import was not found");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../../src/store/useDAWStore");
    const commandsUrl = "/src/store/commands/index.ts";
    const { commandManager } = await import(/* @vite-ignore */ commandsUrl) as typeof import("../../src/store/commands");
    const host = document.createElement('div');
    host.id = 'midi-axis-fixture';
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '99999', display: 'flex', background: '#121212' });
    document.body.append(host);
    const root = createRoot(host);
    const qa: MidiAxisQa = window.__midiAxisQA = { store, commandManager, createDefaultTrack, seed: () => undefined };
    qa.seed = () => {
      const track = createDefaultTrack('m', 'MIDI axis QA', '#4361ee', 'midi', []);
      track.midiClips = [{ id: 'notes', name: 'Note group', startTime: 0, duration: 8, sourceLength: 8, color: '#4361ee', events: [
        { timestamp: 0.5, type: 'noteOn', note: 60, velocity: 96 },
        { timestamp: 1.5, type: 'noteOff', note: 60, velocity: 0 },
        { timestamp: 2, type: 'noteOn', note: 64, velocity: 80 },
        { timestamp: 3, type: 'noteOff', note: 64, velocity: 0 },
      ], ccEvents: [], loopLength: 8 }];
      store.setState({ tracks: [track], selectedClipId: 'notes', selectedClipIds: ['notes'], selectedNoteIds: ['notes:0.500000:60', 'notes:2.000000:64'], selectedTrackId: 'm', selectedTrackIds: ['m'], showPianoRoll: true, pianoRollTrackId: 'm', pianoRollClipId: 'notes', pixelsPerSecond: 100, scrollX: 0, scrollY: 0, snapEnabled: true, mouseBehaviorProfileId: 'openstudio', mouseModifiers: {}, globalLocked: false, lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false }, midiEditorSessions: [], activeMidiEditorSessionId: null, dockedMidiEditorSessionId: null, syncMIDITrackToBackend: async () => {}, transport: { ...store.getState().transport, isPlaying: false, isRecording: false, tempo: 120, currentTime: 0 } });
      commandManager.clear();
      store.setState({ canUndo: false, canRedo: false, isModified: false });
      root.render(React.createElement(PianoRoll, { clipId: 'notes', trackId: 'm' }));
    };
    qa.seed();
  });
  const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const seed = async () => { await page.evaluate(() => window.__midiAxisQA.seed()); await paint(); };
  const read = () => page.evaluate(() => ({ events: window.__midiAxisQA.store.getState().tracks[0].midiClips[0].events, selection: window.__midiAxisQA.store.getState().selectedNoteIds, undo: window.__midiAxisQA.commandManager.getUndoStack().length }));
  const point = () => page.evaluate(() => {
    const stage = window.Konva.stages.find(stage => stage.container().closest('#midi-axis-fixture') && stage.container().closest('[data-qa="piano-roll-grid-stage"]'));
    if (!stage) throw new Error('MIDI stage was not found');
    const node = stage.find<Konva.Rect>('Rect').find(rect => rect.stroke() === '#ffffff' && rect.width() === 100 && rect.height() === 11);
    if (!node) throw new Error('selected note body not found');
    const origin = stage.container().getBoundingClientRect();
    return { x: origin.x + node.x() + 30, y: origin.y + node.y() + 6 };
  });
  for (const modifier of ['Control', 'Shift'] as const) {
    await seed();
    const before = await read();
    const start = await point();
    await page.keyboard.down(modifier);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y + 24, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up(modifier);
    await paint();
    const after = await read();
    const notes = after.events.filter(event => event.type === 'noteOn');
    assert(notes.length === 2 && after.undo === 1, `${modifier}: selected group must move in one Undo ${JSON.stringify(after)}`);
    if (modifier === 'Control') {
      assert(notes[0].note === 60 && notes[1].note === 64 && Math.abs(notes[0].timestamp - 1.3) < 1e-6 && Math.abs(notes[1].timestamp - 2.8) < 1e-6, `Ctrl drag keeps pitches while time changes unsnapped ${JSON.stringify(after)}`);
    } else {
      assert(notes[0].timestamp === 0.5 && notes[1].timestamp === 2 && notes[0].note === 58 && notes[1].note === 62, `Shift drag keeps time while pitches change ${JSON.stringify(after)}`);
    }
    assert(notes[0].velocity === 96 && notes[1].velocity === 80, `${modifier}: velocity must remain`);
    await page.evaluate(() => window.__midiAxisQA.store.getState().undo());
    assert(JSON.stringify((await read()).events) === JSON.stringify(before.events), `${modifier}: Undo restores exact source events`);
    await page.evaluate(() => window.__midiAxisQA.store.getState().redo());
    assert(JSON.stringify((await read()).events) === JSON.stringify(after.events), `${modifier}: Redo restores group`);
    checks.push(`${modifier}: axis-locked two-note group with preserved velocity and exact Undo/Redo`);
  }
  await seed();
  const start = await point();
  await page.keyboard.down('Shift');
  await page.mouse.click(start.x, start.y);
  await page.keyboard.up('Shift');
  await paint();
  const clicked = await read();
  assert(clicked.selection.length === 1 && clicked.undo === 0, `Shift-click must toggle clicked selection without edit ${JSON.stringify(clicked)}`);
  checks.push('Shift-click retains selection toggle without history');
  return { status: 'pass', checks };
}

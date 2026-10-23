import type { Page } from "@playwright/test";
import type Konva from "konva";
import type { AudioClip, MIDIClip, Track, DAWState, createDefaultTrack, useDAWStore } from "../../src/store/useDAWStore";
import type { commandManager } from "../../src/store/commands";
import type { BrowserRegressionReport } from "./interactionFixtureTypes";
import { primaryModifier } from "./platformInput";

interface SeedOptions {
  multi?: boolean; snap?: boolean; snapType?: DAWState["snapType"]; sameStart?: boolean; ruler?: boolean;
  hiddenBefore?: boolean; mixedDestinations?: boolean;
}
interface TimelineCopyQa {
  store: typeof useDAWStore;
  createDefaultTrack: typeof createDefaultTrack;
  commandManager: typeof commandManager;
  syncs: number;
  ruler: boolean;
  render: () => void;
  holdNextSync: boolean;
  releaseSync: (() => void) | null;
  backendTracks: Track[];
  removedTrackIds: string[];
}
declare global { interface Window { __clipPointerQA: TimelineCopyQa } }

export async function runTimelineCopyChecks(page: Page): Promise<BrowserRegressionReport> {
  const copyModifier = await primaryModifier(page);
  const checks: string[] = [];
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  page.on('pageerror', onPageError);
  try {
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  await page.goto('/?platform=windows&windowChrome=native');
  await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const reactUrl = '/node_modules/.vite/deps/react.js';
    const reactModule = await import(/* @vite-ignore */ reactUrl) as typeof import('react') & { default?: typeof import('react') };
    const React = reactModule.default || reactModule;
    const domUrl = '/node_modules/.vite/deps/react-dom_client.js';
    const rootModule = await import(/* @vite-ignore */ domUrl) as typeof import('react-dom/client') & { default?: typeof import('react-dom/client') };
    const { createRoot } = rootModule.default || rootModule;
    const componentUrl = '/src/components/Timeline.tsx';
    const { Timeline } = await import(/* @vite-ignore */ componentUrl) as typeof import('../../src/components/Timeline');
    const componentSource = await (await fetch('/src/components/Timeline.tsx')).text();
    const storeUrl = componentSource.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("Timeline store import was not found");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../../src/store/useDAWStore");
    const commandUrl = '/src/store/commands/index.ts';
    const { commandManager } = await import(/* @vite-ignore */ commandUrl) as typeof import('../../src/store/commands');
    const bridgeUrl = '/src/services/NativeBridge.ts';
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import('../../src/services/NativeBridge');
    const qa: TimelineCopyQa = window.__clipPointerQA = { store, createDefaultTrack, commandManager, syncs: 0,
      ruler: true, render: () => undefined, holdNextSync: false, releaseSync: null, backendTracks: [], removedTrackIds: [] };
    nativeBridge.getWaveformPeaks = async (_file, _spp, _start, count) => Array.from({ length: count }, (_, index) => ({ channels: [{ min: -0.4 - 0.25 * Math.sin(index * 0.1), max: 0.4 + 0.25 * Math.sin(index * 0.1) }] }));
    nativeBridge.addPlaybackClip = async () => true;
    nativeBridge.removeTrack = async id => { qa.removedTrackIds.push(id); return true; };
    const host = document.createElement('div');
    host.id = 'clip-pointer-fixture';
    host.className = 'workspace';
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '99999', display: 'flex', background: '#121212' });
    document.body.append(host);
    const root = createRoot(host);
    const render = () => root.render(React.createElement(Timeline, { tracks: store.getState().getVisibleTracks(), showRuler: qa.ruler }));
    qa.render = render;
    store.subscribe(render);
    render();
  });

  const seed = async (kind: 'audio' | 'midi' = 'audio', options: SeedOptions = {}) => {
    await page.evaluate(({ kind, options }) => {
      const qa = window.__clipPointerQA;
      const { store, commandManager, createDefaultTrack } = qa;
      commandManager.clear();
      qa.syncs = 0;
      qa.holdNextSync = false;
      qa.releaseSync = null;
      qa.removedTrackIds = [];
      const source = createDefaultTrack('source', 'Source', '#4361ee', kind, []);
      const target = createDefaultTrack('target', 'Target', '#4361ee', kind, []);
      const clip = {
        id: 'clip', name: kind === 'audio' ? 'Recording / imported audio' : 'MIDI',
        startTime: 3.23, duration: 2.03, offset: 0.5, sourceLength: 8,
        color: '#4361ee', volumeDB: 0, fadeIn: 0, fadeOut: 0,
        ...(kind === 'audio' ? { filePath: 'C:/clip-pointer-fixture.wav', sampleRate: 48000 }
          : { events: [], ccEvents: [], loopLength: 8 }),
      };
      if (kind === 'audio') source.clips = [clip as AudioClip];
      else source.midiClips = [clip as MIDIClip];
      if (options.multi) {
        const other = { ...clip, id: 'other', startTime: options.sameStart ? 3.23 : 1.17 };
        if (kind === 'audio') target.clips = [other as AudioClip]; else target.midiClips = [other as MIDIClip];
      }
      const tracks = [source, target];
      if (options.hiddenBefore) {
        const folder = { ...createDefaultTrack('folder', 'Collapsed folder', '#4361ee', 'audio', []), isFolder: true, folderCollapsed: true };
        const hidden = { ...createDefaultTrack('hidden', 'Hidden child', '#4361ee', 'audio', []), parentFolderId: folder.id };
        tracks.unshift(folder, hidden);
      }
      if (options.mixedDestinations) {
        target.type = 'midi';
        target.clips = [];
        target.midiClips = [{ id: 'other', name: 'MIDI', startTime: 1.17, duration: 2.03, offset: 0,
          sourceLength: 8, color: target.color, events: [], ccEvents: [] }];
        tracks.push(createDefaultTrack('midi-destination', 'MIDI destination', '#4361ee', 'midi', []),
          createDefaultTrack('audio-destination', 'Audio destination', '#4361ee', 'audio', []));
      }
      store.setState({
        tracks, selectedClipId: options.multi ? 'clip' : null,
        selectedClipIds: options.multi ? ['clip', 'other'] : [], selectedTrackIds: [],
        pixelsPerSecond: 100, scrollX: 0, scrollY: 0, trackHeight: 100,
        snapEnabled: options.snap !== false, snapType: options.snapType || 'grid', gridSize: '1/16',
        mouseBehaviorProfileId: 'openstudio', mouseModifiers: {}, toolMode: 'select',
        globalLocked: false, lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
        canUndo: false, canRedo: false, isModified: false, showPianoRoll: false, showPitchEditor: false,
        midiEditorSessions: [], activeMidiEditorSessionId: null, dockedMidiEditorSessionId: null,
        moveEnvelopesWithItems: true,
        transport: { ...store.getState().transport, isPlaying: false, isRecording: false, tempo: 120, currentTime: 0 },
        syncClipsWithBackend: async () => {
          qa.syncs++;
          const snapshot = structuredClone(store.getState().tracks);
          if (qa.holdNextSync) {
            qa.holdNextSync = false;
            await new Promise<void>(resolve => { qa.releaseSync = resolve; });
          }
          qa.backendTracks = snapshot;
        },
      });
      qa.ruler = options.ruler !== false;
      qa.render();
    }, { kind, options });
    // Allow React and Konva to finish painting the fixture before sending input.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const read = () => page.evaluate(() => {
    const qa = window.__clipPointerQA;
    const s = qa.store.getState();
    return { tracks: s.tracks, selected: s.selectedClipIds, dirty: s.isModified,
      undo: qa.commandManager.getUndoStack().length, syncs: qa.syncs, editorOpen: s.showPianoRoll };
  });
  const clipOf = (state: Awaited<ReturnType<typeof read>>, id = 'clip') => state.tracks.flatMap(t => [...t.clips, ...t.midiClips]).find(c => c.id === id);
  const point = async (relativeX = 70, trackIndex = 0, relativeY = 50) => {
    const stage = await page.locator('#clip-pointer-fixture .konvajs-content').last().boundingBox();
    assert(stage, 'main canvas must exist');
    return { x: stage.x + 323 + relativeX, y: stage.y + trackIndex * 100 + relativeY };
  };
  const gesture = async (start: { x: number; y: number }, dx = 0, dy = 0) => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    if (dx || dy) await page.mouse.move(start.x + dx, start.y + dy, { steps: 3 });
    await page.mouse.up();
  };
  const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const previewGeometry = () => page.evaluate(() => {
    const stage = window.Konva.stages.find(stage => stage.container().closest('#clip-pointer-fixture') && stage.height() > 50);
    if (!stage) throw new Error('Timeline stage was not found');
    return stage.find<Konva.Group>('Group').filter(node => node.opacity() === 0.5).map(node => ({
      listening: node.listening(), labels: node.find<Konva.Text>('Text').map(text => text.text()),
      rects: node.find<Konva.Rect>('Rect').map(rect => ({ x: rect.x(), y: rect.y(), width: rect.width(), height: rect.height() })),
      waveformLines: node.find<Konva.Line>('Line').filter(line => line.points().length > 10).length,
    }));
  });
  for (const kind of ['audio', 'midi'] as const) {
    await seed(kind, { multi: true, snap: false });
    if (kind === 'midi') await page.evaluate(() => {
      const q = window.__clipPointerQA;
      q.store.setState({ tracks: q.store.getState().tracks.map(track => ({ ...track, midiClips: track.midiClips.map(clip => ({ ...clip, events: [
        { timestamp: 0.2, type: 'noteOn', note: 60, velocity: 100 },
        { timestamp: 1.5, type: 'noteOff', note: 60, velocity: 0 },
      ] })) })) });
    });
    await paint();
    const before = await read();
    const origin = await point();
    await page.keyboard.down(copyModifier);
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    await page.mouse.move(origin.x + 140, origin.y, { steps: 5 });
    await paint();
    const during = await read();
    assert(JSON.stringify(during.tracks) === JSON.stringify(before.tracks), `${kind}: originals must remain stationary until drop`);
    const previews = await previewGeometry();
    assert(previews.length === 2 && previews.every(preview => !preview.listening), `${kind}: entire selection must have noninteractive 50% opacity previews ${JSON.stringify(previews)}`);
    assert(previews.every(preview => preview.labels.length > 0 && preview.rects.length > 0), `${kind}: previews must contain real clip labels/content`);
    if (kind === 'audio') assert(previews.every(preview => preview.waveformLines > 0), 'audio: every copy must show its waveform');
    else assert(previews.every(preview => preview.rects.some(rect => rect.height <= 4 && rect.width > 10)), 'MIDI: every copy must show its note thumbnail');
    const previewStarts = previews.map(preview => preview.rects[0].x).sort((a, b) => a - b);
    assert(Math.abs(previewStarts[1] - previewStarts[0] - 206) < 0.1, `${kind}: preview timing spacing must remain 206px ${previewStarts}`);
    await page.mouse.up();
    await page.keyboard.up(copyModifier);
    await paint();
    const after = await read();
    const originals = after.tracks.flatMap(track => [...track.clips, ...track.midiClips]).filter(clip => ['clip', 'other'].includes(clip.id));
    const copies = after.tracks.flatMap(track => [...track.clips, ...track.midiClips]).filter(clip => !['clip', 'other'].includes(clip.id));
    assert(copies.length === 2 && after.undo === 1, `${kind}: group copy must be one edit ${JSON.stringify(after)}`);
    assert(JSON.stringify(originals) === JSON.stringify(before.tracks.flatMap(track => [...track.clips, ...track.midiClips])), `${kind}: originals must remain unchanged after drop`);
    assert(copies.every(copy => Math.abs(copy.startTime - clipOf(before, copy.startTime > 4 ? 'clip' : 'other')!.startTime - 1.4) < 0.001), `${kind}: group copies must share one delta`);
    await page.evaluate(() => window.__clipPointerQA.store.getState().undo());
    assert(JSON.stringify((await read()).tracks) === JSON.stringify(before.tracks), `${kind}: one Undo restores all sources exactly`);
    await page.evaluate(() => window.__clipPointerQA.store.getState().redo());
    assert(JSON.stringify((await read()).tracks) === JSON.stringify(after.tracks), `${kind}: Redo restores stable copy identities`);
    checks.push(`${kind}: two 50% previews with labels/content, stationary originals, shared offset, single Undo/Redo`);

    for (const cancel of ['Escape', 'blur', 'pointercancel']) {
      await seed(kind, { multi: true, snap: false });
      const beforeCancel = await read();
      const start = await point();
      await page.keyboard.down(copyModifier);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 140, start.y, { steps: 4 });
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else await page.evaluate(event => window.dispatchEvent(new Event(event)), cancel);
      await page.mouse.up();
      await page.keyboard.up(copyModifier);
      await paint();
      const afterCancel = await read();
      assert(JSON.stringify(afterCancel.tracks) === JSON.stringify(beforeCancel.tracks) && afterCancel.undo === 0 && (await previewGeometry()).length === 0, `${kind}: ${cancel} must clear every preview without copies/history`);
      checks.push(`${kind}: ${cancel} cancels entire selection copy`);
    }
  }
  await seed('audio', { multi: true, snap: false, hiddenBefore: true });
  const beforeCollapsed = await read();
  const collapsedOrigin = await point(70, 1);
  await page.keyboard.down(copyModifier);
  await page.mouse.move(collapsedOrigin.x, collapsedOrigin.y);
  await page.mouse.down();
  await page.mouse.move(collapsedOrigin.x + 140, collapsedOrigin.y, { steps: 5 });
  await paint();
  const collapsedPreviews = await previewGeometry();
  assert(collapsedPreviews.length === 2, 'collapsed-folder rows must retain both clip-copy previews');
  await page.mouse.up();
  await page.keyboard.up(copyModifier);
  await paint();
  const afterCollapsed = await read();
  assert(afterCollapsed.tracks.find(track => track.id === 'hidden')?.clips.length === 0,
    'copy must not accidentally target a hidden row');
  assert(['source', 'target'].every(id => afterCollapsed.tracks.find(track => track.id === id)?.clips.length === 2),
    'copied clips must stay on their requested visible source rows');
  assert(afterCollapsed.undo === 1, 'collapsed-folder group copy must be one Undo step');
  await page.evaluate(() => window.__clipPointerQA.store.getState().undo());
  assert(JSON.stringify((await read()).tracks) === JSON.stringify(beforeCollapsed.tracks), 'collapsed-folder copy Undo restores exact tracks');
  checks.push('collapsed-folder clip copies preserve two previews, visible destinations and one Undo');

  await seed('audio', { multi: true, snap: false, mixedDestinations: true });
  const beforeMixed = await read();
  const mixedOrigin = await point();
  await page.keyboard.down(copyModifier);
  await page.mouse.move(mixedOrigin.x, mixedOrigin.y);
  await page.mouse.down();
  await page.mouse.move(mixedOrigin.x + 140, mixedOrigin.y + 100, { steps: 5 });
  await paint();
  const mixedPreviews = await previewGeometry();
  assert(mixedPreviews.length === 2 && mixedPreviews.every(preview => preview.rects[0].y >= 400),
    'mixed group must preview its real generated rows, not incompatible existing destinations');
  await page.mouse.up();
  await page.keyboard.up(copyModifier);
  await paint();
  const afterMixed = await read();
  assert(afterMixed.tracks.length === 6 && afterMixed.tracks[4].clips.length === 1 && afterMixed.tracks[5].midiClips.length === 1,
    'an incompatible destination must append the whole ordered mixed group');
  assert(afterMixed.undo === 1, 'generated tracks and their copies must be one Undo step');
  await page.evaluate(() => window.__clipPointerQA.store.getState().undo());
  assert(JSON.stringify((await read()).tracks) === JSON.stringify(beforeMixed.tracks), 'Undo removes generated rows and restores the original group');
  await page.evaluate(() => window.__clipPointerQA.store.getState().redo());
  assert(JSON.stringify((await read()).tracks) === JSON.stringify(afterMixed.tracks), 'Redo restores generated rows and stable copy identities');
  checks.push('mixed copy destinations share actual generated preview rows and exact Undo/Redo');

  // Keep the simple gesture path covered independently of selected-group state.
  await seed('audio', { snap: false, hiddenBefore: true });
  const single = await point(70, 1);
  await page.keyboard.down(copyModifier);
  await gesture(single, 80, 0);
  await page.keyboard.up(copyModifier);
  await paint();
  assert((await read()).tracks.find(track => track.id === 'source')?.clips.length === 2,
    'single copies also resolve the actual visible source ID after a collapsed folder');
  checks.push('single copy after a collapsed folder resolves its destination by ID');

  await seed('audio', { snap: false, hiddenBefore: true });
  await page.evaluate(() => {
    const q = window.__clipPointerQA;
    const state = q.store.getState();
    const hidden = state.tracks.find(track => track.id === 'hidden')!;
    const source = state.tracks.find(track => track.id === 'source')!;
    const secondHidden = { ...q.createDefaultTrack('second-hidden', 'Second hidden child', '#4361ee', 'audio', []), parentFolderId: 'folder' };
    const tracks = state.tracks.map(track => track.id === hidden.id
      ? { ...track, clips: [{ ...source.clips[0], id: 'hidden-clip' }] } : track);
    tracks.splice(2, 0, secondHidden);
    q.store.setState({ tracks, selectedClipId: 'clip', selectedClipIds: ['hidden-clip', 'clip'] });
  });
  await paint();
  const beforeHiddenSelection = await read();
  const hiddenSelectionOrigin = await point(70, 1);
  await page.keyboard.down(copyModifier);
  await page.mouse.move(hiddenSelectionOrigin.x, hiddenSelectionOrigin.y);
  await page.mouse.down();
  await page.mouse.move(hiddenSelectionOrigin.x + 80, hiddenSelectionOrigin.y, { steps: 5 });
  await paint();
  assert((await previewGeometry()).length === 2, 'selected hidden sources must render safely alongside the visible anchor');
  await page.mouse.up();
  await page.keyboard.up(copyModifier);
  await paint();
  const hiddenCopies = await read();
  assert(hiddenCopies.tracks.length === 8 && hiddenCopies.selected.length === 2 && hiddenCopies.undo === 1,
    'hidden sources remain in the copied group, with their row gap preserved');
  await page.evaluate(() => window.__clipPointerQA.store.getState().undo());
  assert(JSON.stringify((await read()).tracks) === JSON.stringify(beforeHiddenSelection.tracks), 'hidden-source copy Undo restores the entire original tree');
  checks.push('selected hidden sources keep safe preview metrics, row gaps and atomic Undo');

  await seed('audio', { multi: true, snap: false, mixedDestinations: true });
  const beforePending = await read();
  await page.evaluate(() => { window.__clipPointerQA.holdNextSync = true; });
  const pendingOrigin = await point();
  await page.keyboard.down(copyModifier);
  await gesture(pendingOrigin, 140, 100);
  await page.keyboard.up(copyModifier);
  await page.waitForFunction(() => window.__clipPointerQA.releaseSync !== null);
  const pendingIds = (await read()).tracks.slice(4).map(track => track.id);
  assert(pendingIds.length === 2, 'pending copy must have generated both destination rows');
  await page.evaluate(() => window.dispatchEvent(new Event('pointercancel')));
  await page.evaluate(() => {
    const q = window.__clipPointerQA;
    q.releaseSync?.(); q.releaseSync = null;
  });
  await page.waitForFunction(ids => {
    const q = window.__clipPointerQA;
    return q.backendTracks.length === 4 && ids.every(id => q.removedTrackIds.includes(id));
  }, pendingIds);
  const afterPending = await read();
  assert(afterPending.undo === 0 && JSON.stringify(afterPending.tracks) === JSON.stringify(beforePending.tracks),
    'cancelling a pending backend write must restore frontend tracks without history');
  assert(await page.evaluate(() => JSON.stringify(window.__clipPointerQA.backendTracks)) === JSON.stringify(beforePending.tracks),
    'pending backend content must be reconciled after cancellation, including generated-track removal');
  checks.push('cancellation during backend synchronization restores topology and content without Undo');
  assert(pageErrors.length === 0, `browser runtime errors: ${pageErrors.join('; ')}`);
  return { status: 'pass', checks };
  } finally {
    await page.evaluate(() => window.__clipPointerQA?.releaseSync?.());
    await page.mouse.up();
    await page.keyboard.up(copyModifier);
    page.off('pageerror', onPageError);
  }
}

// Real-browser regression. Start the frontend dev server, open it with
// playwright-cli, then run: playwright-cli run-code --filename tools/check-timeline-clip-pointer.js
// The fixture uses the real Timeline and store with mocked backend calls.
async (page) => {
  const checks = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.goto('http://127.0.0.1:5183/?platform=windows&windowChrome=native');
  await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const rootModule = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = rootModule.default || rootModule;
    const { Timeline } = await import('/src/components/Timeline.tsx');
    const { useDAWStore: store, createDefaultTrack } = await import('/src/store/useDAWStore.ts');
    const { commandManager } = await import('/src/store/commands/index.ts');
    const { nativeBridge } = await import('/src/services/NativeBridge.ts');
    const qa = window.__clipPointerQA = { store, createDefaultTrack, commandManager, syncs: 0, ruler: true };
    nativeBridge.getWaveformPeaks = async () => [];
    nativeBridge.addPlaybackClip = async () => true;
    const host = document.createElement('div');
    host.id = 'clip-pointer-fixture';
    host.className = 'workspace';
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '99999', display: 'flex', background: '#121212' });
    document.body.append(host);
    const root = createRoot(host);
    const render = () => root.render(React.createElement(Timeline, { tracks: store.getState().tracks, showRuler: qa.ruler }));
    qa.render = render;
    store.subscribe(render);
    render();
  });

  const seed = async (kind = 'audio', options = {}) => {
    await page.evaluate(({ kind, options }) => {
      const qa = window.__clipPointerQA;
      const { store, commandManager, createDefaultTrack } = qa;
      commandManager.clear();
      qa.syncs = 0;
      const source = createDefaultTrack('source', 'Source', '#4361ee', kind, []);
      const target = createDefaultTrack('target', 'Target', '#4361ee', kind, []);
      const clip = {
        id: 'clip', name: kind === 'audio' ? 'Recording / imported audio' : 'MIDI',
        startTime: 3.23, duration: 2.03, offset: 0.5, sourceLength: 8,
        color: '#4361ee', volumeDB: 0, fadeIn: 0, fadeOut: 0,
        ...(kind === 'audio' ? { filePath: 'C:/clip-pointer-fixture.wav', sampleRate: 48000 }
          : { events: [], ccEvents: [], loopLength: 8 }),
      };
      source[kind === 'audio' ? 'clips' : 'midiClips'] = [clip];
      if (options.multi) target[kind === 'audio' ? 'clips' : 'midiClips'] = [{ ...clip, id: 'other', startTime: options.sameStart ? 3.23 : 1.17 }];
      store.setState({
        tracks: [source, target], selectedClipId: options.multi ? 'clip' : null,
        selectedClipIds: options.multi ? ['clip', 'other'] : [], selectedTrackIds: [],
        pixelsPerSecond: 100, scrollX: 0, scrollY: 0, trackHeight: 100,
        snapEnabled: options.snap !== false, snapType: options.snapType || 'grid', gridSize: '1/16',
        mouseBehaviorProfileId: 'openstudio', mouseModifierOverrides: {}, toolMode: 'select',
        globalLocked: false, lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
        canUndo: false, canRedo: false, isModified: false, showPianoRoll: false, showPitchEditor: false,
        midiEditorSessions: [], activeMidiEditorSessionId: null, dockedMidiEditorSessionId: null,
        moveEnvelopesWithItems: true,
        transport: { ...store.getState().transport, isPlaying: false, isRecording: false, tempo: 120, currentTime: 0 },
        syncClipsWithBackend: async () => { qa.syncs++; },
      });
      qa.ruler = options.ruler !== false;
      qa.render();
    }, { kind, options });
    // Allow React and Konva to finish painting the fixture before sending input.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const read = () => page.evaluate(() => {
    const qa = window.__clipPointerQA;
    const s = qa.store.getState();
    return { tracks: s.tracks, selected: s.selectedClipIds, dirty: s.isModified,
      undo: qa.commandManager.getUndoStack().length, syncs: qa.syncs, editorOpen: s.showPianoRoll };
  });
  const clipOf = (state, id = 'clip') => state.tracks.flatMap(t => [...t.clips, ...t.midiClips]).find(c => c.id === id);
  const point = async (relativeX = 70, trackIndex = 0, relativeY = 50) => {
    const stage = await page.locator('#clip-pointer-fixture .konvajs-content').last().boundingBox();
    assert(stage, 'main canvas must exist');
    return { x: stage.x + 323 + relativeX, y: stage.y + trackIndex * 100 + relativeY };
  };
  const gesture = async (start, dx = 0, dy = 0) => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    if (dx || dy) await page.mouse.move(start.x + dx, start.y + dy, { steps: 3 });
    await page.mouse.up();
  };
  const verifyClick = async (kind, label, x, options = {}, jitter = false) => {
    await seed(kind, options);
    const before = await read();
    await gesture(await point(x), jitter ? 3 : 0, jitter ? 3 : 0);
    const after = await read();
    assert(JSON.stringify(after.tracks) === JSON.stringify(before.tracks), `${kind} ${label}: clip/track data changed`);
    assert(!after.dirty && after.undo === 0 && after.syncs === 0, `${kind} ${label}: click committed an edit`);
    assert(after.selected.includes('clip'), `${kind} ${label}: click must select`);
    checks.push(`${kind}: ${label}`);
  };

  for (const kind of ['audio', 'midi']) {
    await verifyClick(kind, 'off-grid click', 70);
    await verifyClick(kind, '3px diagonal jitter', 70, {}, true);
    await verifyClick(kind, 'left-edge click', 2);
    await verifyClick(kind, 'right-edge click', 201);
    await verifyClick(kind, 'multi-selection click', 70, { multi: true });
    await verifyClick(kind, 'snap-disabled jitter', 70, { snap: false }, true);
    await verifyClick(kind, 'canvas without ruler', 70, { ruler: false });
    for (const snapType of ['cursor', 'events_grid_cursor', 'grid_relative']) {
      await verifyClick(kind, `${snapType} click`, 70, { snapType });
    }
    await page.keyboard.down('Control');
    await verifyClick(kind, 'copy-modifier jitter creates no copy', 70, {}, true);
    await page.keyboard.up('Control');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await verifyClick(kind, 'slip-modifier jitter preserves source offset', 70, {}, true);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');

    await seed(kind);
    const doubleBefore = await read();
    const doublePoint = await point();
    await page.mouse.dblclick(doublePoint.x, doublePoint.y);
    const doubleAfter = await read();
    assert(JSON.stringify(doubleAfter.tracks) === JSON.stringify(doubleBefore.tracks)
      && doubleAfter.undo === 0 && !doubleAfter.dirty,
      `${kind}: double-click must preserve clip geometry and history`);
    if (kind === 'midi') assert(doubleAfter.editorOpen, 'MIDI double-click must still open its editor');
    checks.push(`${kind}: double-click preserves geometry${kind === 'midi' ? ' and opens editor' : ''}`);

    await seed(kind);
    const before = await read();
    await gesture(await point(), 32, 0);
    let after = await read();
    assert(Math.abs(clipOf(after).startTime - 3.5) < 1e-9, `${kind}: real drag must snap to 3.5s`);
    assert(after.undo === 1 && after.syncs === 1, `${kind}: drag must commit once`);
    await page.evaluate(() => window.__clipPointerQA.store.getState().undo());
    after = await read();
    assert(JSON.stringify(after.tracks) === JSON.stringify(before.tracks), `${kind}: undo must restore exact clip geometry`);
    await page.evaluate(() => window.__clipPointerQA.store.getState().redo());
    assert(Math.abs(clipOf(await read()).startTime - 3.5) < 1e-9, `${kind}: redo must restore drag`);
    checks.push(`${kind}: snapped drag, single commit, exact undo/redo`);

    await seed(kind, { snap: false });
    await gesture(await point(), 32, 0);
    assert(Math.abs(clipOf(await read()).startTime - 3.55) < 1e-9, `${kind}: snap-disabled drag must remain free`);
    checks.push(`${kind}: unsnapped drag`);

    await seed(kind);
    await page.keyboard.down('Alt');
    await gesture(await point(), 32, 0);
    await page.keyboard.up('Alt');
    assert(Math.abs(clipOf(await read()).startTime - 3.55) < 1e-9, `${kind}: Alt must bypass snap during a real drag`);
    checks.push(`${kind}: snap-bypass drag`);

    await seed(kind);
    await page.keyboard.down('Control');
    await gesture(await point(), 32, 0);
    await page.keyboard.up('Control');
    after = await read();
    const copies = after.tracks.flatMap(t => [...t.clips, ...t.midiClips]);
    assert(copies.length === 2 && clipOf(after).startTime === 3.23,
      `${kind}: copy drag must preserve original and create one copy`);
    assert(copies.find(c => c.id !== 'clip').startTime === 3.5 && after.undo === 1,
      `${kind}: copy drag must snap with one undo`);
    checks.push(`${kind}: actual copy drag`);

    await seed(kind);
    await gesture(await point(201), 32, 0);
    after = await read();
    assert(Math.abs(clipOf(after).duration - 2.395) < 1e-9 && after.undo === 1,
      `${kind}: right-edge drag must resize to snapped endpoint`);
    await page.evaluate(() => window.__clipPointerQA.store.getState().undo());
    assert(clipOf(await read()).duration === 2.03, `${kind}: resize undo must restore duration`);
    checks.push(`${kind}: snapped edge resize and undo`);

    await seed(kind, { multi: true });
    await gesture(await point(), 32, 0);
    after = await read();
    assert(Math.abs(clipOf(after).startTime - clipOf(after, 'other').startTime - 2.06) < 1e-9 && after.undo === 1,
      `${kind}: multi-drag must preserve relative timing in one undo`);
    checks.push(`${kind}: multi-selection drag`);

    await seed(kind);
    await gesture(await point(70, 0, 82), 0, 4);
    after = await read();
    assert(after.tracks[0].clips.length + after.tracks[0].midiClips.length === 1,
      `${kind}: ruler origin must not cause a 4px drag to change tracks`);
    checks.push(`${kind}: ruler coordinate origin`);

    await seed(kind);
    await gesture(await point(), 32, 100);
    after = await read();
    assert(after.tracks[1].clips.length + after.tracks[1].midiClips.length === 1,
      `${kind}: intentional cross-track drag must work`);
    assert(after.undo === 1, `${kind}: cross-track drag must have one undo`);
    checks.push(`${kind}: cross-track drag`);

    await seed(kind);
    const origin = await point();
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    await page.mouse.move(origin.x + 32, origin.y, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    after = await read();
    assert(clipOf(after).startTime === 3.23 && after.undo === 0 && !after.dirty,
      `${kind}: Escape must cancel without a later release snapping again`);
    checks.push(`${kind}: Escape cancellation`);

    // A single MIDI drag leaving the canvas starts native MIDI-file export.
    // Use a selection here to exercise the timeline's outside-release fallback.
    await seed(kind, { multi: kind === 'midi', sameStart: true });
    await gesture(await point(), -600, 0);
    after = await read();
    assert(clipOf(after).startTime === 0 && after.undo === 1, `${kind}: release outside canvas must commit once`);
    checks.push(`${kind}: release outside canvas`);

    for (const event of ['blur', 'pointercancel']) {
      await seed(kind);
      const start = await point();
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 32, start.y, { steps: 3 });
      await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
      await page.mouse.up();
      after = await read();
      assert(clipOf(after).startTime === 3.23 && !after.dirty && after.undo === 0,
        `${kind}: ${event} must restore the original and clear the gesture`);
      checks.push(`${kind}: ${event} cancellation`);
    }
  }
  assert(pageErrors.length === 0, `browser runtime errors: ${pageErrors.join('; ')}`);
  return { status: 'pass', checks };
}

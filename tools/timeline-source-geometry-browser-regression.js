async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
  const source = await (await page.request.get(new URL('/src/App.tsx', page.url()).href)).text();
  const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
  const bridgeUrl = source.match(/from "([^"]*NativeBridge\.ts[^"]*)"/)?.[1];
  if (!storeUrl || !bridgeUrl) throw new Error('Module URLs missing');
  await page.addScriptTag({ type: 'module', content: `
    import { useDAWStore as store, createDefaultTrack } from ${JSON.stringify(storeUrl)};
    import { nativeBridge } from ${JSON.stringify(bridgeUrl)};
    window.__issuesAudit = { store, createDefaultTrack, nativeBridge, requests: [] };
  ` });
  await page.waitForFunction(() => Boolean(window.__issuesAudit));
  await page.evaluate(() => {
    const qa = window.__issuesAudit;
    qa.nativeBridge.getWaveformPeaks = async (file, spp, start, count, rangeStart = 0, rangeEnd = -1) => {
      qa.requests.push({ spp, start, count, rangeStart, rangeEnd });
      return Array.from({ length: count }, () => ({ channels: [{ min: -0.5, max: 0.5 }] }));
    };
    const track = qa.createDefaultTrack('audit-long-source', '48 kHz long-source geometry', '#4361ee', 'audio', []);
    track.clips = [{ id: 'audit-long-clip', name: '409s source fixture', filePath: 'C:/audit/long48k.wav',
      startTime: 0, duration: 409.87, sourceLength: 409.87, offset: 0, sampleRate: 48000,
      color: '#4361ee', volumeDB: 0, fadeIn: 0, fadeOut: 0 }];
    qa.store.setState({ tracks: [track], selectedClipIds: [], selectedClipId: null, selectedTrackIds: [],
      pixelsPerSecond: 997.9, scrollX: 300000, scrollY: 0, trackHeight: 100,
      snapEnabled: false, toolMode: 'select', globalLocked: false,
      lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
      showMixer: false, showGettingStarted: false, inputProfileOnboardingSeen: true,
      showPianoRoll: false, showPitchEditor: false, showPreferences: false, showSettings: false,
      autoBackupEnabled: false, timeSelection: null, projectRange: { start: 0, end: 410 },
      transport: { ...qa.store.getState().transport, currentTime: 0, isPlaying: false, isRecording: false },
    });
  });
  await page.waitForFunction(() => window.__issuesAudit.requests.length > 0);
  await page.waitForTimeout(500);
  const longSource = await page.evaluate(() => {
    const qa = window.__issuesAudit;
    const stage = window.Konva.stages.find(s => s.height() > 50 && s.container().closest('.timeline-container'));
    const waves = stage?.find('Line').filter(n => n.closed() && n.opacity() === 0.6) || [];
    return { requests: qa.requests, stageWidth: stage?.width(), zoom: qa.store.getState().pixelsPerSecond,
      scrollX: qa.store.getState().scrollX,
      waveforms: waves.map(n => ({ firstX: n.points()[0], lastTopX: n.points()[n.points().length / 2 - 2], pointCount: n.points().length })) };
  });
  await page.screenshot({ path: 'output/playwright/long-source-waveform-corrected.png' });
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.waitForFunction(beforeWidth => {
    const stage = window.Konva.stages.find(s => s.height() > 50 && s.container().closest('.timeline-container'));
    const wave = stage?.find('Line').find(n => n.closed() && n.opacity() === 0.6);
    return stage?.width() > beforeWidth && wave && wave.points()[wave.points().length / 2 - 2] >= stage.width() - 2;
  }, longSource.stageWidth);
  const expandedViewport = await page.evaluate(() => {
    const qa = window.__issuesAudit;
    const stage = window.Konva.stages.find(s => s.height() > 50 && s.container().closest('.timeline-container'));
    const wave = stage?.find('Line').find(n => n.closed() && n.opacity() === 0.6);
    const state = qa.store.getState();
    return { requests: qa.requests, stageWidth: stage?.width(), zoom: state.pixelsPerSecond,
      scrollX: state.scrollX, firstX: wave?.points()[0], lastTopX: wave?.points()[wave.points().length / 2 - 2] };
  });
  // The old implementation enlarged and retransferred a source prefix. A
  // complete canonical tile can already cover the wider viewport, so qualify
  // fetched source coverage and reuse rather than requiring prefix growth.
  const stride = longSource.requests[0].spp;
  const windows = expandedViewport.requests.filter(request => request.spp === stride)
    .map(request => ({ first: request.start, end: request.start + request.count * stride }))
    .sort((first, second) => first.first - second.first);
  let coveredThrough = Math.floor(expandedViewport.scrollX / expandedViewport.zoom * 48000);
  const requiredThrough = Math.ceil((expandedViewport.scrollX + expandedViewport.stageWidth) / expandedViewport.zoom * 48000);
  for (const window of windows) {
    if (window.first > coveredThrough) break;
    if (window.end > coveredThrough) coveredThrough = window.end;
  }
  const requestKeys = expandedViewport.requests.map(request =>
    `${request.spp}:${request.start}:${request.rangeStart}:${request.rangeEnd}`);
  if (coveredThrough < requiredThrough || expandedViewport.firstX > 1
    || expandedViewport.lastTopX < expandedViewport.stageWidth - 2)
    throw new Error('Expanded viewport has unfetched or undrawn source: ' + JSON.stringify(expandedViewport));
  if (expandedViewport.requests.some(request => request.count !== 4096)
    || new Set(requestKeys).size !== requestKeys.length)
    throw new Error('Viewport resize retransferred a cached tile/prefix: ' + JSON.stringify(expandedViewport.requests));
  await page.setViewportSize({ width: 1280, height: 900 });
  // Exercise release while a native synchronization is pending.
  await page.evaluate(() => {
    const qa = window.__issuesAudit;
    const track = qa.store.getState().tracks[0];
    qa.store.setState({ tracks: [{ ...track, clips: [{ ...track.clips[0], startTime: 1, duration: 4 }] }],
      pixelsPerSecond: 100, scrollX: 0, scrollY: 0,
      syncClipsWithBackend: async () => {
        qa.syncPending = true;
        await new Promise(resolve => { qa.releaseSync = resolve; });
        qa.syncPending = false;
      } });
  });
  await page.waitForTimeout(300);
  const clipGeometry = await page.evaluate(() => {
    const stage = window.Konva.stages.find(s => s.height() > 50 && s.container().closest('.timeline-container'));
    const rect = stage.container().getBoundingClientRect();
    return { x: rect.x, y: rect.y, shapes: stage.find('Rect').map(n => ({ x: n.x(), y: n.y(), width: n.width(), height: n.height(), fill: n.fill() })) };
  });
  const clipRect = clipGeometry.shapes.find(s => s.x === 100 && s.width === 400 && s.height > 20);
  if (!clipRect) throw new Error('Clip rectangle unavailable: ' + JSON.stringify(clipGeometry));
  const startX = clipGeometry.x + 498;
  const y = clipGeometry.y + clipRect.y + clipRect.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX - 100, y, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => Boolean(window.__issuesAudit.syncPending));
  const releasedDuration = await page.evaluate(() => window.__issuesAudit.store.getState().tracks[0].clips[0].duration);
  await page.mouse.move(startX - 200, y, { steps: 5 });
  const movedAfterReleaseDuration = await page.evaluate(() => window.__issuesAudit.store.getState().tracks[0].clips[0].duration);
  await page.evaluate(() => window.__issuesAudit.releaseSync());
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const qa = window.__issuesAudit;
    const source = qa.store.getState().tracks[0];
    const target = qa.createDefaultTrack('audit-target', 'Existing target', '#4cc9f0', 'audio', []);
    qa.nativeBridge.addTrack = async id => id;
    qa.nativeBridge.removeTrack = async () => true;
    qa.store.setState({ tracks: [{ ...source, clips: [{ ...source.clips[0], duration: 2 }] }, target],
      selectedClipIds: [], selectedClipId: null, pixelsPerSecond: 100, scrollX: 0,
      syncClipsWithBackend: async () => {}, moveEnvelopesWithItems: false });
  });
  await page.waitForTimeout(100);
  const insertionGeometry = await page.evaluate(() => {
    const stage = window.Konva.stages.find(s => s.height() > 50 && s.container().closest('.timeline-container'));
    const rect = stage.container().getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
  await page.mouse.move(insertionGeometry.x + 200, insertionGeometry.y + 45);
  await page.mouse.down();
  await page.mouse.move(insertionGeometry.x + 200, insertionGeometry.y + 100, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__issuesAudit.store.getState().tracks.length === 3);
  const insertion = await page.evaluate(async () => {
    const state = window.__issuesAudit.store.getState();
    const middle = state.tracks[1];
    const result = { middleOwnsClip: middle.clips.some(clip => clip.id === 'audit-long-clip'),
      originalFirst: state.tracks[0].id === 'audit-long-source', originalLast: state.tracks[2].id === 'audit-target' };
    await state.undo();
    return { ...result, undoRestored: window.__issuesAudit.store.getState().tracks.length === 2
      && window.__issuesAudit.store.getState().tracks[0].clips.some(clip => clip.id === 'audit-long-clip') };
  });
  if (!Object.values(insertion).every(Boolean)) throw new Error('Insertion/undo mismatch: ' + JSON.stringify(insertion));
  await page.evaluate(() => {
    const qa = window.__issuesAudit;
    const source = qa.store.getState().tracks[0];
    const midi = qa.createDefaultTrack('mixed-midi-source', 'MIDI source', '#a78bfa', 'midi', []);
    midi.midiClips = [{ id: 'mixed-midi-clip', name: 'MIDI', startTime: 1, duration: 2, offset: 0, loopEnabled: false,
      events: [{ type: 'noteOn', note: 60, velocity: 90, timestamp: 0, channel: 1 }, { type: 'noteOff', note: 60, timestamp: 1, channel: 1 }] }];
    qa.store.setState({ tracks: [source, midi], selectedClipId: 'audit-long-clip', selectedClipIds: ['audit-long-clip', 'mixed-midi-clip'],
      pixelsPerSecond: 100, scrollX: 0, scrollY: 0, mouseModifiers: {}, mouseBehaviorProfileId: 'openstudio' });
  });
  await page.waitForTimeout(100);
  await page.mouse.move(insertionGeometry.x + 200, insertionGeometry.y + 45);
  await page.mouse.down();
  await page.mouse.move(insertionGeometry.x + 200, insertionGeometry.y + 100, { steps: 6 });
  const mixedPreview = await page.evaluate(() => {
    const stage = window.Konva.stages.find(s => s.height() > 50 && s.container().closest('.timeline-container'));
    return stage.find('Text').some(node => node.text() === '+ Create 2 Tracks');
  });
  if (!mixedPreview) throw new Error('Mixed divider drop did not advertise two new rows');
  await page.mouse.up();
  await page.waitForFunction(() => window.__issuesAudit.store.getState().tracks.length === 4);
  const mixedInsertion = await page.evaluate(async () => {
    const qa = window.__issuesAudit, state = qa.store.getState();
    const result = { audioRow: state.tracks[1].type === 'audio' && state.tracks[1].clips[0]?.id === 'audit-long-clip',
      midiRow: state.tracks[2].type === 'midi' && state.tracks[2].midiClips[0]?.id === 'mixed-midi-clip',
      rows: state.tracks.map(track => ({ id: track.id, type: track.type, audio: track.clips.map(clip => clip.id), midi: track.midiClips.map(clip => clip.id) })) };
    state.undo();
    return { ...result, undoRestored: qa.store.getState().tracks.length === 2
      && qa.store.getState().tracks[0].clips[0]?.id === 'audit-long-clip'
      && qa.store.getState().tracks[1].midiClips[0]?.id === 'mixed-midi-clip' };
  });
  if (!Object.values(mixedInsertion).every(Boolean)) throw new Error('Mixed insertion/undo mismatch: ' + JSON.stringify(mixedInsertion));
  const dropResults = [];
  for (const scale of [1, 1.5, 2]) {
    await page.evaluate(scale => {
      const qa = window.__issuesAudit;
      qa.imports = [];
      qa.nativeBridge.onExternalMediaDragEnter = callback => { qa.enter = callback; return () => {}; };
      qa.nativeBridge.onExternalMediaDrop = callback => { qa.drop = callback; return () => {}; };
      qa.nativeBridge.probeMediaFile = async () => ({ duration: 2, sampleRate: 48000, numChannels: 1 });
      qa.nativeBridge.requestWaveformPreview = async () => true;
      const tracks = ['drop-a', 'drop-b'].map(id => qa.createDefaultTrack(id, id, '#4361ee', 'audio', []));
      qa.store.setState({ tracks, pixelsPerSecond: 100, scrollX: 500, scrollY: 0,
        snapEnabled: false,
        importExternalMediaAtTimeline: async request => {
          qa.imports.push(request);
          const track = qa.createDefaultTrack('import-' + qa.imports.length, request.name, '#4361ee', 'audio', []);
          const next = [...qa.store.getState().tracks];
          next.splice(request.insertIndex, 0, track);
          qa.store.setState({ tracks: next });
          await new Promise(resolve => setTimeout(resolve, 20));
          return track.id;
        } });
      qa.dropScale = scale;
    }, scale);
    await page.waitForFunction(() => Boolean(window.__issuesAudit.drop));
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const qa = window.__issuesAudit;
      const rect = document.querySelector('.timeline-container').getBoundingClientRect();
      const scale = qa.dropScale;
      const event = { dragId: 'drop-' + scale, deviceScaleFactor: scale,
        clientX: (rect.left + 200) * scale, clientY: (rect.top + 100) * scale,
        nativeClientX: (rect.left + 200) * scale, nativeClientY: (rect.top + 100) * scale,
        files: [{ path: 'C:/audit/one.wav', name: 'one.wav' }, { path: 'C:/audit/two.wav', name: 'two.wav' }] };
      qa.enter(event);
      qa.drop(event);
    });
    await page.waitForFunction(() => window.__issuesAudit.imports.length === 2);
    const drop = await page.evaluate(() => ({ scale: window.__issuesAudit.dropScale,
      imports: window.__issuesAudit.imports.map(({ startTime, insertIndex }) => ({ startTime, insertIndex })),
      order: window.__issuesAudit.store.getState().tracks.map(track => track.id) }));
    if (JSON.stringify(drop.imports) !== JSON.stringify([{ startTime: 7, insertIndex: 1 }, { startTime: 7, insertIndex: 2 }])
      || drop.order.join(',') !== 'drop-a,import-1,import-2,drop-b') throw new Error('Drop placement mismatch: ' + JSON.stringify(drop));
    dropResults.push(drop);
  }
  const result = { fixture: 'browser geometry with mocked peaks/native sync; no audio audition', longSource,
    trimRelease: { releasedDuration, movedAfterReleaseDuration,
      changedWithoutButton: releasedDuration !== movedAfterReleaseDuration } };
  if (longSource.waveforms.length !== 1 || longSource.waveforms[0].firstX > 1)
    throw new Error('Source waveform does not cover the visible left edge: ' + JSON.stringify(longSource));
  if (releasedDuration !== movedAfterReleaseDuration)
    throw new Error('Trim mutated after mouse release: ' + JSON.stringify(result.trimRelease));
  return { status: 'pass', checks: ['fractional source projection', 'cached source tile reuse and expanded viewport coverage',
    'trim release while sync pending', 'between-track insertion and undo', 'native-event DPI drop coordinates and multi-file order'],
    evidence: { ...result, expandedViewport, sourceCoverage: { requiredThrough, coveredThrough }, insertion, mixedInsertion, dropResults } };
}

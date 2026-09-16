// Run with an isolated playwright-cli session against the local Vite server:
// playwright-cli --session field-fixes run-code --filename tools/field-test-browser-regression.js
// Browser integration fixtures only: no OS permission, real OAuth, or hardware claims.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const evidence = {};
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('http://127.0.0.1:5183/?platform=macos');
  await page.getByRole('button', { name: 'Save mixer snapshot', exact: true }).waitFor({ timeout: 15000 });
  const onboarding = page.getByRole('button', { name: 'Close profile setup and keep current selections' });
  if (await onboarding.count()) await onboarding.click();
  const essentials = page.getByRole('button', { name: 'Hide essential controls', exact: true });
  if (await essentials.count()) await essentials.click();
  await page.evaluate(async () => {
    const { useDAWStore, createDefaultTrack } = await import('/src/store/useDAWStore.ts');
    window.__fieldDAWStore = useDAWStore;
    const track = createDefaultTrack('field-midi', 'Field MIDI', '#4361ee', 'midi', []);
    track.midiClips = [{ id: 'field-clip', name: 'Field clip', startTime: 0, duration: 4, events: [], ccEvents: [], color: '#4361ee' }];
    useDAWStore.setState({ tracks: [track], mixerSnapshots: [], showMixer: true, lowerZoneHeight: 280,
      showPitchEditor: true, pitchEditorTrackId: track.id, pitchEditorClipId: 'field-clip', mouseBehaviorProfileId: 'logic_pro' });
    useDAWStore.getState().openMidiEditorForClip(track.id, 'field-clip');
  });
  evidence.geometry = [];
  for (const [width, height] of [[1440, 900], [1280, 720], [1024, 640], [800, 600]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    const panes = await page.locator('[data-layout-pane]').evaluateAll(elements => elements.map(e => ({
      name: e.getAttribute('data-layout-pane'), height: e.getBoundingClientRect().height, bottom: e.getBoundingClientRect().bottom,
    })));
    const timeline = panes.find(p => p.name === 'timeline');
    check(timeline && timeline.height >= 179 && timeline.bottom <= height, 'Timeline obscured');
    check(['mixer', 'midi', 'pitch'].every(name => panes.some(p => p.name === name && p.height >= 95)), 'An open panel disappeared');
    evidence.geometry.push({ width, height, panes });
  }
  await page.screenshot({ path: 'output/playwright/field-panels-800x600.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  const beforeZoom = await page.evaluate(async () => (await import('/src/store/useDAWStore.ts')).useDAWStore.getState().pixelsPerSecond);
  await page.locator('.timeline-container canvas').first().dispatchEvent('wheel', { ctrlKey: true, deltaY: -20, clientX: 450, clientY: 180, bubbles: true, cancelable: true });
  await page.waitForFunction(before => window.__fieldDAWStore.getState().pixelsPerSecond > before, beforeZoom, { timeout: 5000 });
  const afterZoom = await page.evaluate(async () => (await import('/src/store/useDAWStore.ts')).useDAWStore.getState().pixelsPerSecond);
  check(afterZoom > beforeZoom, 'Pinch did not reach the timeline zoom handler');
  evidence.pinch = { beforeZoom, afterZoom };

  let browserDialogs = 0;
  page.on('dialog', () => browserDialogs++);
  await page.getByRole('button', { name: 'Save mixer snapshot', exact: true }).click();
  await page.getByRole('dialog').last().getByRole('textbox').fill('Field snapshot');
  await page.getByRole('dialog').last().getByRole('textbox').press('Enter');
  await page.getByRole('button', { name: 'Recall mixer snapshot Field snapshot', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save mixer snapshot', exact: true }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Cancel', exact: true }).click();
  const snapshots = await page.evaluate(async () => (await import('/src/store/useDAWStore.ts')).useDAWStore.getState().mixerSnapshots.map(s => s.name));
  check(snapshots.length === 1 && snapshots[0] === 'Field snapshot' && browserDialogs === 0, 'Snapshot dialog regression');
  await page.evaluate(async () => { (await import('/src/store/actionRegistry.ts')).getRegisteredAction('help.about').execute(); });
  const about = page.getByRole('dialog').last();
  await about.getByRole('button', { name: 'Third-party notices', exact: true }).click();
  check((await about.getByRole('textbox', { name: 'About details' }).inputValue()).includes('JUCE'), 'Missing notices');
  await about.getByRole('button', { name: 'License', exact: true }).click();
  check((await about.getByRole('textbox', { name: 'About details' }).inputValue()).includes('GNU AFFERO'), 'Missing license');
  await page.screenshot({ path: 'output/playwright/field-about.png' });
  await about.getByRole('button', { name: 'Close', exact: true }).click();
  evidence.dialogs = { snapshots, browserDialogs, about: 'pass' };

  await page.evaluate(async () => {
    const { nativeBridge } = await import('/src/services/NativeBridge.ts');
    window.__fieldMonitor = { slots: [], opened: null };
    nativeBridge.getAvailablePlugins = async () => { throw new Error('Fixture: external plugin discovery unavailable'); };
    nativeBridge.getMonitoringFX = async () => window.__fieldMonitor.slots;
    nativeBridge.addMonitoringFX = name => new Promise(resolve => {
      window.__fieldMonitor.finishAdd = () => {
        window.__fieldMonitor.slots = [{ index: 0, name, type: 'builtin', pluginPath: name }];
        resolve(true);
      };
    });
    nativeBridge.openBuiltInPluginEditorWindow = async session => { window.__fieldMonitor.opened = JSON.parse(session); return true; };
  });
  const monitorAdd = page.getByRole('button', { name: 'Add monitoring effect plugin', exact: true });
  const monitorSearch = page.getByRole('textbox', { name: 'Search monitor effect plugins', exact: true });
  const closePicker = page.getByRole('button', { name: 'Close plugin picker', exact: true });
  const assertPickerClosed = async () => {
    await monitorSearch.waitFor({ state: 'detached', timeout: 5000 });
    check(await monitorAdd.getAttribute('aria-expanded') === 'false', 'Picker trigger remained expanded');
  };
  await monitorAdd.click();
  await monitorSearch.fill('no-matching-plugin');
  await monitorSearch.click();
  check(await monitorSearch.isVisible(), 'Clicking the search input dismissed its picker');
  const closeGeometry = await closePicker.evaluate(button => {
    const row = button.parentElement.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    return { width: rect.width, right: rect.right, rowRight: row.right };
  });
  check(closeGeometry.width >= 24 && closeGeometry.right <= closeGeometry.rowRight, 'Close button clipped by search field');
  await monitorSearch.press('Escape');
  await assertPickerClosed();
  check(await monitorAdd.evaluate(button => button === document.activeElement), 'Escape did not restore focus to the picker trigger');
  await monitorAdd.click();
  check(await monitorSearch.inputValue() === '', 'Dismissal left the previous search behind');
  await monitorAdd.click();
  await assertPickerClosed();
  await monitorAdd.click();
  await closePicker.click();
  await assertPickerClosed();
  await monitorAdd.click();
  const outside = page.getByRole('region', { name: 'Mixer', exact: true }).getByText('Mixer', { exact: true });
  await outside.evaluate(element => element.addEventListener('pointerdown', event => event.stopPropagation(), { once: true }));
  await outside.click();
  await assertPickerClosed();
  await monitorAdd.click();
  await page.getByRole('button', { name: 'Save mixer snapshot', exact: true }).focus();
  await assertPickerClosed();
  await monitorAdd.click();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await assertPickerClosed();
  evidence.monitorPickerDismissal = { outsideClickWithStoppedPropagation: 'pass', escape: 'pass', toggle: 'pass', closeButton: 'pass', focusOutside: 'pass', windowBlur: 'pass', closeGeometry };
  await monitorAdd.click();
  await page.screenshot({ path: 'output/playwright/monitor-picker.png' });
  const namOption = page.getByRole('button', { name: 'OpenStudio NAM Rack', exact: true });
  await namOption.click();
  await page.waitForFunction(() => Boolean(window.__fieldMonitor.finishAdd));
  check(await namOption.isDisabled(), 'Pending insertion allowed duplicate clicks');
  await outside.click();
  await assertPickerClosed();
  const focusAfterDismissal = page.getByRole('button', { name: 'Save mixer snapshot', exact: true });
  await focusAfterDismissal.focus();
  await page.evaluate(() => window.__fieldMonitor.finishAdd());
  const monitorEditor = page.getByRole('button', { name: 'Open editor for monitor effect OpenStudio NAM Rack', exact: true });
  await monitorEditor.waitFor();
  check(await focusAfterDismissal.evaluate(button => button === document.activeElement), 'Delayed insertion stole focus after picker dismissal');
  evidence.monitorPickerDismissal.pendingInsertion = 'pass';
  await monitorEditor.click();
  evidence.monitor = await page.evaluate(() => ({ slots: window.__fieldMonitor.slots, opened: window.__fieldMonitor.opened }));
  check(evidence.monitor.opened?.address.chain === 'monitor' && evidence.monitor.opened?.address.trackId === '', 'Monitor editor used a track or master address');

  const url = await page.evaluate(() => 'http://127.0.0.1:5183/?' + new URLSearchParams({
    window: 'pluginEditor', platform: 'macos', windowChrome: 'native', mockPlugin: 'nam', namLibraryFlow: 'amp', namSection: 'amp',
    sessionId: JSON.stringify({ address: { trackId: 'field-nam', chain: 'track', fxIndex: 0 }, title: 'OpenStudio NAM Rack', fallbackName: 'OpenStudio NAM Rack' }),
  }));
  await page.goto(url);
  await page.getByRole('searchbox').waitFor({ timeout: 15000 });
  await page.evaluate(async () => {
    const { nativeBridge } = await import('/src/services/NativeBridge.ts');
    const session = await import('/src/services/tone3000Session.ts');
    window.__fieldAuth = { connected: false, starts: 0 };
    nativeBridge.getTONE3000AuthStatus = async () => ({ success: true, authenticated: window.__fieldAuth.connected, expired: false,
      hasRefreshToken: window.__fieldAuth.connected, configuredClientId: true, clientId: 'publisher-id' });
    nativeBridge.startTONE3000AuthFlow = async () => { window.__fieldAuth.starts++; window.__fieldAuth.connected = true; return { success: true, status: 'connected' }; };
    await session.refreshTONE3000SessionStatus();
  });
  const connect = page.locator('.tone-library-panel').getByRole('button', { name: 'Connect TONE3000', exact: true });
  await connect.waitFor();
  await page.screenshot({ path: 'output/playwright/field-nam-connect.png' });
  await connect.click();
  await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
  evidence.auth = await page.evaluate(() => window.__fieldAuth);
  check(evidence.auth.starts === 1, 'Duplicate interactive login');
  const controls = await page.locator('.tone-library-panel').evaluate(panel => [...panel.children].filter(e => e.getBoundingClientRect().height > 0).map(e => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom })));
  for (let i = 1; i < controls.length; i++) check(controls[i].top >= controls[i - 1].bottom - 0.1, 'Library controls overlap');

  await page.evaluate(async () => {
    const { nativeBridge } = await import('/src/services/NativeBridge.ts');
    const base = await nativeBridge.searchTONE3000NAM({ query: '', page: 1, page_size: 12, sort: 'trending' });
    window.__fieldSearch = { calls: [], cancels: [], pending: [], base };
    nativeBridge.searchTONE3000NAM = options => new Promise(resolve => { window.__fieldSearch.calls.push(options); window.__fieldSearch.pending.push({ options, resolve }); });
    nativeBridge.cancelTONE3000Search = async (owner, id) => { window.__fieldSearch.cancels.push({ owner, id }); };
  });
  const search = page.getByRole('searchbox');
  await search.fill('field-alpha');
  await page.waitForFunction(() => window.__fieldSearch.calls.some(r => r.query === 'field-alpha'));
  await search.fill('field-beta');
  await page.waitForFunction(() => window.__fieldSearch.calls.some(r => r.query === 'field-beta'));
  const loading = page.getByRole('status', { name: 'Loading more tones', exact: true });
  await page.locator('.tone-feed-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
  await loading.waitFor({ state: 'visible' });
  const loaderGeometry = await loading.evaluate(element => {
    const list = element.closest('.tone-feed-list');
    const rect = element.getBoundingClientRect();
    const host = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll('.tone-feed-row')];
    return { inList: Boolean(list), height: rect.height, top: rect.top, lastRowBottom: rows.at(-1)?.getBoundingClientRect().bottom ?? rect.top, bottom: rect.bottom, listBottom: host.bottom,
      afterRows: [...list.children].indexOf(element) > [...list.children].findLastIndex(child => child.classList.contains('tone-feed-row')) };
  });
  check(loaderGeometry.inList && loaderGeometry.afterRows && loaderGeometry.height >= 47 && loaderGeometry.top >= loaderGeometry.lastRowBottom && loaderGeometry.bottom <= loaderGeometry.listBottom + 1, 'Loader must fill the bottom of the results list without overlapping rows');
  evidence.loading = loaderGeometry;
  await page.screenshot({ path: 'output/playwright/field-nam-loading-compact.png' });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.locator('.tone-feed-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
  await page.screenshot({ path: 'output/playwright/field-nam-loading.png' });
  const resolve = async (query, title) => page.evaluate(({ query, title }) => {
    const s = window.__fieldSearch;
    const tone = { ...s.base.tones[0], id: title === 'Field beta' ? 99002 : 99001, title, models: s.base.tones[0].models.map(m => ({ ...m, name: title })) };
    s.pending.find(p => p.options.query === query).resolve({ ...s.base, tones: [tone], total: 1, total_pages: 1, totalPages: 1, has_more: false, hasMore: false, next_page: null, nextPage: null });
  }, { query, title });
  await resolve('field-beta', 'Field beta');
  await page.getByRole('button', { name: 'Select Field beta', exact: true }).waitFor();
  await resolve('field-alpha', 'Field alpha');
  await page.waitForTimeout(150);
  check(!await page.getByRole('button', { name: 'Select Field alpha', exact: true }).count(), 'Stale result replaced latest');
  await search.fill('field-gamma');
  await page.waitForFunction(() => window.__fieldSearch.calls.filter(r => r.query === 'field-gamma').length === 1);
  await search.fill('field-omega');
  await search.fill('field-gamma');
  await page.waitForFunction(() => window.__fieldSearch.calls.filter(r => r.query === 'field-gamma').length === 2);
  await page.getByRole('combobox', { name: /^Sort / }).selectOption('newest');
  await page.waitForFunction(() => window.__fieldSearch.calls.some(r => r.query === 'field-gamma' && r.sort === 'newest'));
  evidence.search = await page.evaluate(() => ({ queries: window.__fieldSearch.calls.map(r => r.query), sorts: window.__fieldSearch.calls.map(r => r.sort), cancellations: window.__fieldSearch.cancels.length }));
  check(evidence.search.cancellations >= 2, 'Missing cancellation');
  await page.getByRole('button', { name: 'Back to Amp', exact: true }).click();
  evidence.returnDuringSearch = 'pass';
  return evidence;
}

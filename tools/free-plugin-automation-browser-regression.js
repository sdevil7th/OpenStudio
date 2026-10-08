// Disposable browser QA with schemas exported by the current native executable.
// Serve output/review/fx-automation on localhost:5191; DSP is checked separately
// by --free-plugin-regression-headless --case automation-registry.
async page => {
  const response = await page.request.get('http://127.0.0.1:5191/native-editor-schemas-current.json');
  const schemas = (await response.json()).checks[0].schemas;
  await page.reload();
  await page.getByRole('menubar', { name: 'Main menu' }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async schemas => {
    const { useDAWStore: s, createDefaultTrack } = await import('/src/store/useDAWStore.ts');
    const { nativeBridge: b } = await import('/src/services/NativeBridge.ts');
    const values = await import('/src/utils/builtInParamValue.ts');
    const { commandManager } = await import('/src/store/commands/index.ts');
    const { builtInAutomationParamId } = await import('/src/store/automationParams.ts');
    const { notifyFXChainChanged } = await import('/src/utils/fxChain.ts');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { BuiltInPluginPanel } = await import('/src/components/BuiltInPluginPanel.tsx');
    const q = window.freeAutomationQA = { s, b, schemas, values, commandManager, builtInAutomationParamId, notifyFXChainChanged, writes: [], gestures: [], root: null, schema: null, chain: 'track', index: 0 };
    const track = createDefaultTrack('auto-qa', 'Free automation QA', '#4488cc', 'audio');
    s.getState().markInputProfileOnboardingSeen();
    s.setState({ tracks: [{ ...track, fxCount: schemas.length, inputFxCount: schemas.length }], showGettingStarted: false, showMixer: false, metronomePracticeEnabled: true });
    b.getTrackFX = b.getTrackInputFX = async () => schemas.map((schema, index) => ({ index, name: schema.name, type: 'builtin', instanceId: 'auto-' + index }));
    b.getPluginParameters = async (_track, index) => schemas[index].parameters.filter(p => p.automatable).map((p, index) => ({ index, name: p.label, value: values.normalizeParamValue(p, p.value), text: String(p.value), builtIn: true, paramId: p.id }));
    b.setAutomationPoints = b.setAutomationMode = async () => true;
    b.beginTouchAutomation = b.endTouchAutomation = async () => true;
    b.getBuiltInPluginSchema = async () => structuredClone(q.schema);
    b.getBuiltInPluginMeters = async () => q.schema?.visualization ?? null;
    b.getBuiltInPluginState = async () => ({ parameters: Object.fromEntries(q.schema.parameters.map(p => [p.id, p.value])) });
    b.getPluginEditorReadiness = async () => 'ready';
    q.emit = (param, phase) => {
      const p = q.schema.parameters.find(p => p.id === param);
      const event = { trackId: 'auto-qa', param: p.automatable ? builtInAutomationParamId(q.chain === 'input', q.index, p.id) : '', phase, value: values.normalizeParamValue(p, p.value) };
      for (const handler of b.eventListeners.get('pluginParameterEdit') ?? []) handler(event);
    };
    b.builtInPluginGesture = async (_address, param, begin) => { q.gestures.push({ param, begin }); q.emit(param, begin ? 'begin' : 'end'); };
    b.setBuiltInPluginParam = async (_address, param, value) => {
      const p = q.schema.parameters.find(p => p.id === param); p.value = value;
      q.writes.push({ param, value }); q.emit(param, 'value'); return true;
    };
    q.mount = (schema, index, chain = 'track') => {
      q.root?.unmount(); document.querySelector('[data-qa-editor]')?.remove();
      q.schema = structuredClone({ ...schema, chain, fxIndex: index }); q.index = index; q.chain = chain; q.writes = []; q.gestures = [];
      const host = document.createElement('div'); host.dataset.qaEditor = 'true'; host.setAttribute('role', 'dialog');
      host.className = 'plugin-editor-window-app';
      host.style.cssText = 'position:fixed;inset:0;z-index:20000;background:#121212;display:flex;flex-direction:column;overflow:hidden'; document.body.append(host);
      q.root = createRoot(host);
      q.root.render(React.createElement(BuiltInPluginPanel, { address: { chain, trackId: 'auto-qa', fxIndex: index }, fallbackName: schema.name, initialSchema: q.schema, chrome: 'detached', onClose: () => {} }));
    };
    commandManager.clear();
  }, schemas);
  const results = [];
  const check = (name, value) => { if (!value) throw new Error(name); results.push(name); };
  await page.evaluate(() => window.freeAutomationQA.s.getState().openEnvelopeManager('auto-qa'));
  const envelopes = page.getByRole('dialog').filter({ hasText: 'Only automatable controls appear here.' });
  await envelopes.getByPlaceholder('Filter envelopes...').waitFor();
  const eligible = schemas.reduce((count, schema) => count + schema.parameters.filter(p => p.automatable).length, 0);
  await page.waitForFunction(expected => document.querySelectorAll('[data-automation-param^="builtin_"]').length === expected * 2, eligible);
  check('Every native eligible input/track parameter appears; excluded controls are absent', await envelopes.locator('[data-automation-param^="builtin_"]').count() === eligible * 2);
  // Exercise each real React checkbox handler. DOM click lets us cover the full
  // long list without treating scrolling distance as an automation invariant.
  await envelopes.evaluate(dialog => [...dialog.querySelectorAll('[data-automation-param^="builtin_"] button[aria-label^="Show envelope"]')].forEach(button => button.click()));
  check('Every parameter can create its correctly addressed envelope', await page.evaluate(expected => window.freeAutomationQA.s.getState().tracks[0].automationLanes.filter(l => l.param.startsWith('builtin_')).length === expected * 2, eligible));
  await envelopes.getByPlaceholder('Filter envelopes...').fill('Retune');
  check('Pitch Correct exposes retune speed in both chains', await envelopes.locator('[data-automation-param$="_retuneSpeed"]').count() === 2);
  await page.screenshot({ path: 'output/playwright/free-plugin-automation-envelopes.png' });
  await envelopes.getByRole('button', { name: 'Close modal', exact: true }).click();
  await envelopes.waitFor({ state: 'hidden' });
  for (const chain of ['track', 'input']) for (let index = 0; index < schemas.length; ++index) {
    const schema = schemas[index];
    // NAM uses its own native-window artwork host; its gesture integration is
    // checked in the real app rather than this generic suite-editor host.
    if (schema.pluginId === 'nam') continue;
    await page.evaluate(({ schema, index, chain }) => {
      const q = window.freeAutomationQA;
      q.s.getState().endAutomationWriteSession();
      q.s.setState({ tracks: q.s.getState().tracks.map(t => ({ ...t, automationLanes: [], showAutomation: false, automationWriteEnabled: true, automationReadEnabled: true })), transport: { ...q.s.getState().transport, isPlaying: true, currentTime: 2, loopEnabled: true, loopStart: 0, loopEnd: 1000 } });
      q.mount(schema, index, chain);
    }, { schema, index, chain });
    const editor = page.locator('[data-qa-editor]');
    await editor.getByRole('slider').first().waitFor();
    const controls = await editor.getByRole('slider').evaluateAll((elements, schema) => elements.map(el => {
      const owner = el.closest('[data-param], [data-param-id]');
      const id = owner?.getAttribute('data-param') ?? owner?.getAttribute('data-param-id');
      const p = schema.parameters.find(p => p.id === id);
      const rect = el.getBoundingClientRect();
      return p?.automatable && rect.width && rect.height && rect.top >= 0 && rect.bottom <= window.innerHeight ? { id, name: el.getAttribute('aria-label'), key: p.value >= p.max ? 'ArrowDown' : 'ArrowUp' } : null;
    }).filter(Boolean), schema);
    if (!controls.length) throw new Error(schema.name + ': no visible automatable slider');
    const control = controls[0];
    await page.evaluate(control => { window.freeAutomationQA.progress = { phase: 'keyboard', control }; }, control);
    const slider = editor.getByRole('slider', { name: control.name, exact: true }).first();
    await slider.focus(); await slider.press(control.key);
    await page.waitForFunction(({ index, id, chain }) => window.freeAutomationQA.s.getState().tracks[0].automationLanes.some(l => l.param === window.freeAutomationQA.builtInAutomationParamId(chain === 'input', index, id) && l.points.length), { index, id: control.id, chain });
    await page.waitForFunction(id => window.freeAutomationQA.writes.some(w => w.param === id) && window.freeAutomationQA.gestures.some(g => g.param === id && g.begin), control.id);
    check(chain + ' ' + schema.name + ': keyboard editor gesture records normalized automation', await page.evaluate(id => window.freeAutomationQA.writes.some(w => w.param === id) && window.freeAutomationQA.gestures.some(g => g.param === id && g.begin), control.id));
    const a = await slider.boundingBox();
    await page.evaluate(() => { window.freeAutomationQA.progress.phase = 'pointer'; });
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 16, { steps: 6 }); await page.mouse.up();
    await page.waitForFunction(id => window.freeAutomationQA.gestures.filter(g => g.param === id && !g.begin).length >= 2, control.id);
    check(chain + ' ' + schema.name + ': pointer gesture ends cleanly', true);
    await page.evaluate(() => { const q = window.freeAutomationQA; q.s.getState().endAutomationWriteSession(); q.s.setState({ transport: { ...q.s.getState().transport, isPlaying: false } }); });
    if (schema.pluginId === 'reverb') await page.screenshot({ path: 'output/playwright/free-plugin-reverb-automation-editor.png' });
  }
  // Shared controls must fit every dedicated editor, including the native
  // minimum client size. Inspect real geometry and keyboard focus, not CSS text.
  for (const width of [640, 820, 1040, 1440]) {
    await page.setViewportSize({ width, height: width === 640 ? 480 : 900 });
    for (const schema of schemas.filter(candidate => !['nam', 'pitch'].includes(candidate.pluginId))) {
      await page.evaluate(schema => {
        const q = window.freeAutomationQA;
        q.mount(schema, q.schemas.findIndex(candidate => candidate.pluginId === schema.pluginId));
      }, schema);
      const panel = page.locator('.builtin-plugin-panel');
      await panel.waitFor();
      await page.waitForFunction(() => document.querySelector('.builtin-plugin-panel')?.getAttribute('aria-busy') !== 'true');
      const geometry = await panel.evaluate(root => {
        const visibleControls = [...root.querySelectorAll('button, select, input, [role="slider"]')]
          .map(element => element.getBoundingClientRect())
          .filter(rect => rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight);
        return root.scrollWidth <= root.clientWidth + 1
          && visibleControls.every(rect => rect.left >= -1 && rect.right <= innerWidth + 1);
      });
      check(`${schema.name}: controls remain inside a ${width}px host`, geometry);
      const button = panel.locator('button.eq-button:visible:not(:disabled)').first();
      await button.focus();
      check(`${schema.name}: keyboard focus is visible at ${width}px`, await button.evaluate(element =>
        document.activeElement === element && parseFloat(getComputedStyle(element).outlineWidth) >= 2));
    }
  }
  await page.evaluate(() => { const q = window.freeAutomationQA; q.root.unmount(); document.querySelector('[data-qa-editor]').remove(); });
  return { status: 'pass', nativeEligibleParameters: eligible, envelopeAddresses: eligible * 2, checks: results.length, results, nativeBridge: 'fixture; actual production editors, envelope UI, capture and store' };
}

// playwright-cli run-code --filename tools/check-metronome-sounds.js
// Uses the actual modal, Zustand actions, components and styles; mocks native file I/O only.
async (page) => {
  await page.reload();
  await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const dependency = name => performance.getEntriesByType('resource').find(entry => entry.name.includes(`/deps/${name}.js?`)).name;
    const reactModule = await import(dependency('react'));
    const React = reactModule.default || reactModule;
    const rootModule = await import(dependency('react-dom_client'));
    const { createRoot } = rootModule.default || rootModule;
    const { MetronomeSettings } = await import('/src/components/MetronomeSettings.tsx');
    const { useDAWStore: store } = await import('/src/store/useDAWStore.ts');
    const { nativeBridge: bridge } = await import('/src/services/NativeBridge.ts');
    const qa = window.__metronomeSoundQA = { store, bridge, selected: ['', ''], info: [{error:''},{error:''}], file: '', reject: false, calls: [] };
    store.setState({ showGettingStarted: false, showGettingStartedGuide: false, metronomeClickPath: '', metronomeAccentPath: '', metronomePracticeEnabled: false });
    bridge.showOpenDialog = async () => qa.file;
    for (const [name, slot] of [['setMetronomeClickSound',0], ['setMetronomeAccentSound',1]]) {
      bridge[name] = async selection => {
        qa.calls.push([slot, selection]);
        if (qa.reject) { qa.info[slot] = { selection:qa.selected[slot], error:'This sample contains multiple hits. Trim it to one click before choosing it.' }; return false; }
        qa.selected[slot] = selection.startsWith('C:') ? 'C:/cache/prepared.wav' : selection;
        qa.info[slot] = { selection:qa.selected[slot], error:'', name:'my click.wav', peakMs:1, durationMs:100 };
        return true;
      };
    }
    bridge.getMetronomeSoundInfo = async accent => qa.info[accent ? 1 : 0];
    const host = document.createElement('div'); host.id = 'metronome-sound-fixture'; document.body.append(host);
    qa.root = createRoot(host);
    qa.render = open => qa.root.render(React.createElement(MetronomeSettings, { isOpen:open, onClose:() => qa.render(false) }));
    qa.render(true);
  });
  const dialog = page.getByRole('dialog').filter({ hasText:'Metronome Settings' });
  await dialog.waitFor();
  const checks = [];
  const verify = async (label, condition) => { if (!await condition()) throw new Error(label); checks.push(label); };
  const sounds = dialog.locator('details').filter({ hasText:'Click sounds' });
  await verify('click sounds collapsed by default', () => sounds.evaluate(el => !el.open));
  const summary = sounds.locator('summary');
  await summary.focus(); await page.keyboard.press('Enter');
  await verify('keyboard expands sound section', () => sounds.evaluate(el => el.open));
  const regular = dialog.getByLabel('Regular sound', { exact:true });
  const accent = dialog.getByLabel('Accent sound', { exact:true });
  await verify('four built-ins plus custom upload', () => regular.locator('option').count().then(count => count === 5));
  await regular.selectOption('builtin:woodblock');
  await verify('regular selection accepted independently', () => page.evaluate(() => window.__metronomeSoundQA.store.getState().metronomeClickPath === 'builtin:woodblock' && window.__metronomeSoundQA.store.getState().metronomeAccentPath === ''));
  await accent.selectOption('builtin:cowbell');
  await verify('accent selection accepted independently', () => page.evaluate(() => window.__metronomeSoundQA.store.getState().metronomeAccentPath === 'builtin:cowbell'));
  await regular.selectOption('builtin:mechanical'); await regular.selectOption('');
  await verify('original sound selectable again', () => regular.inputValue().then(value => value === ''));
  await page.evaluate(() => { window.__metronomeSoundQA.file = ''; });
  await dialog.getByRole('button', {name:'Choose regular sound', exact:true}).click();
  await verify('cancel chooser preserves selection', () => regular.inputValue().then(value => value === ''));
  await page.evaluate(() => { window.__metronomeSoundQA.file = 'C:/Downloads/my click.wav'; });
  await regular.selectOption('custom');
  await verify('accepted upload stores prepared copy', () => page.evaluate(() => window.__metronomeSoundQA.store.getState().metronomeClickPath === 'C:/cache/prepared.wav'));
  await verify('uploaded filename is visible', () => dialog.getByText('my click.wav', {exact:true}).isVisible());
  await page.evaluate(() => { window.__metronomeSoundQA.reject = true; });
  await dialog.getByRole('button', {name:'Choose regular sound',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'multiple hits'}).waitFor();
  await verify('rejected replacement keeps previous click', () => page.evaluate(() => window.__metronomeSoundQA.store.getState().metronomeClickPath === 'C:/cache/prepared.wav'));
  await verify('rejection gives actionable feedback', () => dialog.getByRole('alert').filter({hasText:'previous sound is kept'}).isVisible());
  await page.screenshot({path:'output/playwright/metronome-sounds-expanded.png'});
  for (const width of [390, 760, 1440]) {
    await page.setViewportSize({width,height:900});
    await verify(`modal fits width ${width}`, () => dialog.evaluate(el => {
      const rect=el.getBoundingClientRect(); return rect.left>=-1 && rect.right<=innerWidth+1 && el.scrollWidth<=el.clientWidth+1;
    }));
    await verify(`controls fit width ${width}`, () => regular.evaluate(el => {
      const dialog=el.closest('[role="dialog"]'); const r=el.getBoundingClientRect(), d=dialog.getBoundingClientRect(); return r.left>=d.left && r.right<=d.right;
    }));
    if(width===390) await page.screenshot({path:'output/playwright/metronome-sounds-mobile.png'});
  }
  await dialog.getByRole('button', {name:'Done',exact:true}).click();
  await page.evaluate(() => window.__metronomeSoundQA.render(true));
  await dialog.waitFor();
  await verify('reopening starts collapsed', () => sounds.evaluate(el => !el.open));
  await page.evaluate(() => { window.__metronomeSoundQA.root.unmount(); document.querySelector('#metronome-sound-fixture').remove(); });
  return {status:'pass',checks};
}

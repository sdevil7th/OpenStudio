import { expect, test } from '@playwright/test';

async function ready(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('openstudio.inputProfiles.v1', JSON.stringify({ schemaVersion: 1,
      keyboardProfileId: 'openstudio', mouseProfileId: 'openstudio', onboardingSeen: true }));
    localStorage.setItem('openstudio_essentialControlsDismissed', 'true');
  });
  await page.goto('/');
  await expect(page.getByText('Starting OpenStudio...', { exact: true })).toBeHidden({ timeout: 20000 });
  await page.getByRole('button', { name: 'Add new audio track', exact: true }).click();
}

for (const kind of ['settings', 'plugins']) {
  test(`${kind} traps focus, blocks background edits and closes with Escape`, async ({ page }) => {
    await ready(page);
    await page.evaluate(async kind => {
      const url = '/src/store/useDAWStore.ts';
      const { useDAWStore: store } = await import(/* @vite-ignore */ url);
      if (kind === 'settings') store.setState({ showSettings: true });
      else store.getState().openPluginBrowser(store.getState().tracks[0].id);
    }, kind);
    const root = page.locator('[data-modal-root]').last();
    await expect(root).toBeVisible();
    await expect.poll(() => root.evaluate(e => e.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press(i < 30 ? 'Tab' : 'Shift+Tab');
      expect(await root.evaluate(e => e.contains(document.activeElement))).toBe(true);
    }
    await expect(root).toHaveAttribute('role', 'dialog');
    await page.keyboard.press('ControlOrMeta+t');
    await page.keyboard.press('Escape');
    await expect(root).toBeHidden();
    expect(await page.evaluate(async () => {
      const url = '/src/store/useDAWStore.ts';
      return (await import(/* @vite-ignore */ url)).useDAWStore.getState().tracks.length;
    })).toBe(1);
    await page.getByRole('button', { name: 'Add new audio track', exact: true }).click();
  });
}

for (const width of [800, 1280]) {
  test(`essential controls stay reachable with 150% app fonts at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 800 ? 600 : 800 });
    await ready(page);
    await page.evaluate(async () => {
      const url = '/src/store/useDAWStore.ts';
      (await import(/* @vite-ignore */ url)).useDAWStore.getState().setUIFontScale(1.5);
    });
    await expect(page.locator('html')).toHaveCSS('font-size', '24px');
    for (const name of ['Audio Settings', 'AI Tools', 'Grid, Snap, and Quantize settings', 'Enable Metronome', 'Go to Start']) {
      const control = page.getByRole('button', { name, exact: true });
      const r = await control.boundingBox();
      expect(r, name).not.toBeNull();
      expect(r!.x, name).toBeGreaterThanOrEqual(0);
      expect(r!.x + r!.width, name).toBeLessThanOrEqual(width + 1);
      expect(await control.evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), name).toBe(true);
    }
    const name = page.getByRole('textbox', { name: 'Track name', exact: true });
    expect(await name.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })).toBe(true);
    await page.getByRole('button', { name: 'Audio Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Audio Settings', exact: true })).toBeVisible();
  });
}

for (const kind of ['settings', 'plugins']) {
  test(`${kind} preserves remapped close and focused text editing`, async ({ page }) => {
    await ready(page);
    await page.evaluate(async kind => {
      const url = '/src/store/useDAWStore.ts';
      const { useDAWStore: store } = await import(/* @vite-ignore */ url);
      store.setState({ customShortcuts: { 'modal.close': { common: ['F8'] } } });
      if (kind === 'settings') store.setState({ showSettings: true });
      else store.getState().openPluginBrowser(store.getState().tracks[0].id);
    }, kind);
    const dialog = page.getByRole('dialog').last();
    await expect(dialog).toBeVisible();
    if (kind === 'plugins') {
      const search = dialog.getByPlaceholder('Search plugins, makers, categories...');
      await search.fill('Compressor');
      await search.press('ControlOrMeta+a');
      await search.press('Backspace');
      await expect(search).toHaveValue('');
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('F8');
    await expect(dialog).toBeHidden();
  });
}

test('MIDI grid owns Delete and Undo without deleting tracks', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const url = '/src/store/useDAWStore.ts';
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ url);
    store.setState({ tracks: [createDefaultTrack('a', 'Audio'), createDefaultTrack('m', 'Piano', '#6292be', 'midi')], showMixer: false });
    const id = store.getState().addMIDIClip('m', 0, 4);
    store.getState().addMIDINote('m', id, .5, 60, 1, 96);
    store.getState().openPianoRoll('m', id);
  });
  const grid = page.locator('[data-qa="piano-roll-grid-stage"]');
  await grid.click({ position: { x: 280, y: 15 } });
  const state = () => page.evaluate(async () => {
    const url = '/src/store/useDAWStore.ts';
    const s = (await import(/* @vite-ignore */ url)).useDAWStore.getState();
    return { tracks: s.tracks.length, events: s.tracks.find((t: {id: string}) => t.id === 'm')?.midiClips[0]?.events.length };
  });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  expect(await state()).toEqual({ tracks: 2, events: 0 });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await state()).toEqual({ tracks: 2, events: 2 });
});

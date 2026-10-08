import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('openstudio.inputProfiles.v1', JSON.stringify({ schemaVersion: 1,
      keyboardProfileId: 'openstudio', mouseProfileId: 'openstudio', onboardingSeen: true }));
    localStorage.setItem('openstudio_essentialControlsDismissed', 'true');
  });
  await page.goto('/');
  await expect(page.getByText('Starting OpenStudio...', { exact: true })).toBeHidden({ timeout: 20000 });
  await page.evaluate(async () => {
    const { nativeBridge } = await import('/src/services/NativeBridge.ts');
    (window as any).__pickerCalls = [];
    nativeBridge.showOpenDialog = async (...args) => { (window as any).__pickerCalls.push(args); return ''; };
  });
});

for (const surface of ['action', 'menu', 'batch', 'video', 'ddp']) {
  test(`${surface} picker supplies its media filter to the native dialog`, async ({ page }) => {
    if (surface === 'action') {
      await page.evaluate(async () => {
        const { getRegisteredAction } = await import('/src/store/actionRegistry.ts');
        getRegisteredAction('insert.mediaFile')!.execute();
      });
    } else if (surface === 'menu') {
      await page.getByRole('menuitem', { name: 'Insert menu', exact: true }).click();
      await page.getByText('Media file...', { exact: true }).click();
    } else {
      await page.evaluate(async surface => {
        const { useDAWStore } = await import('/src/store/useDAWStore.ts');
        useDAWStore.setState({ [surface === 'batch' ? 'showBatchConverter' : surface === 'video' ? 'showVideoWindow' : 'showDDPExport']: true });
      }, surface);
      await page.getByRole('button', { name: surface === 'batch' ? 'Browse File' : surface === 'video' ? 'Open Video' : 'Browse...', exact: true }).click();
    }
    await expect.poll(() => page.evaluate(() => (window as any).__pickerCalls.length)).toBe(1);
    const [, filter] = await page.evaluate(() => (window as any).__pickerCalls[0]);
    expect(filter.split(';')).toContain(surface === 'video' ? '*.mp4' : '*.wav');
    expect(filter).not.toContain('*.osproj');
    if (surface === 'action' || surface === 'menu') expect(filter.split(';')).toContain('*.mp4');
  });
}

test('DDP requests a folder and cancellation does not start exporting', async ({ page }) => {
  await page.evaluate(async () => {
    const { nativeBridge } = await import('/src/services/NativeBridge.ts');
    const { useDAWStore } = await import('/src/store/useDAWStore.ts');
    (window as any).__folderCalls = []; (window as any).__exports = 0;
    nativeBridge.showOpenDialog = async () => '/tmp/source.wav';
    nativeBridge.browseForFolder = async title => { (window as any).__folderCalls.push(title); return ''; };
    nativeBridge.exportDDP = async () => { (window as any).__exports++; return true; };
    useDAWStore.setState({ showDDPExport: true, regions: [{ id: 'r', name: 'Track', startTime: 0, endTime: 4, color: '#fff' }] });
  });
  await page.getByRole('button', { name: 'Browse...', exact: true }).click();
  await page.getByRole('button', { name: 'Export DDP', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__folderCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__exports)).toBe(0);
});

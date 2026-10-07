// Run with playwright-cli run-code --filename in a disposable Vite App browser.
async page => {
  await page.reload();
  await page.getByRole('menubar', { name: 'Main menu' }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    const { useDAWStore: s, createDefaultTrack } = await import('/src/store/useDAWStore.ts');
    const { nativeBridge: b } = await import('/src/services/NativeBridge.ts');
    const { commandManager } = await import('/src/store/commands/index.ts');
    const make = () => ['NAM Rack', 'Reverb', 'Delay'].map((name, index) => ({ index, name: 'OpenStudio ' + name, type: 'builtin', instanceId: 'drag-fx-' + index }));
    const lane = { id: 'drag-envelope', param: 'builtin_track_0_ampGainDb', points: [{ id: 'p', time: 1, value: .5 }], visible: false, mode: 'read', readEnabled: true, armed: false };
    window.fxDragQA = { s, b, fx: make(), input: make(), calls: [], reject: false, results: [] };
    s.getState().markInputProfileOnboardingSeen();
    s.setState({ tracks: [{ ...createDefaultTrack('drag-one', 'Drag one', '#4488cc', 'audio'), fxCount: 3, automationLanes: [lane] }, createDefaultTrack('drag-two', 'Drag two', '#cc8844', 'audio')], showGettingStarted: false });
    b.getTrackFX = async () => window.fxDragQA.fx.map((fx, index) => ({ ...fx, index }));
    b.getTrackInputFX = async () => window.fxDragQA.input.map((fx, index) => ({ ...fx, index }));
    b.getAvailablePlugins = b.getAvailableJSFX = b.getAvailableBuiltInFX = async () => [];
    const reorder = (chain, from, to) => {
      const q = window.fxDragQA; q.calls.push({ chain, from, to });
      if (q.reject) return false;
      const slots = q[chain]; slots.splice(to, 0, ...slots.splice(from, 1)); return true;
    };
    b.reorderTrackFX = async (_id, from, to) => reorder('fx', from, to);
    b.reorderTrackInputFX = async (_id, from, to) => reorder('input', from, to);
    b.setAutomationPoints = b.setAutomationMode = async () => true;
    commandManager.clear();
  });
  const results = [];
  const check = (name, value) => { if (!value) throw new Error(name); results.push(name); };
  await page.locator('[data-track-id="drag-one"]').getByRole('button', { name: 'FX', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'FX chain for Drag one', exact: true });
  await dialog.locator('.fx-slot-item').nth(2).waitFor();
  const drag = async (from, to, outside = false) => {
    const a = await dialog.getByTitle('Drag to reorder', { exact: true }).nth(from).boundingBox();
    const z = outside ? { x: 10, y: 970, width: 0, height: 0 } : await dialog.locator('.fx-slot-item').nth(to).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 12 });
    check('Background headers stay stationary during FX drag', await page.evaluate(() => [...document.querySelectorAll('[data-track-id]')].every(el => !el.style.transform && el.style.opacity !== '0.5')));
    await page.mouse.up();
  };
  await drag(0, 2);
  await page.waitForFunction(() => window.fxDragQA.fx[2].instanceId === 'drag-fx-0');
  check('FX order changes without reordering tracks', await page.evaluate(() => window.fxDragQA.s.getState().tracks.map(t => t.id).join() === 'drag-one,drag-two'));
  check('Automation follows the reordered instance', await page.evaluate(() => window.fxDragQA.s.getState().tracks[0].automationLanes[0].param === 'builtin_track_2_ampGainDb'));
  await page.evaluate(() => window.fxDragQA.s.getState().undo());
  await page.waitForFunction(() => window.fxDragQA.fx[0].instanceId === 'drag-fx-0');
  check('Undo restores FX and envelope addresses', await page.evaluate(() => window.fxDragQA.s.getState().tracks[0].automationLanes[0].param === 'builtin_track_0_ampGainDb'));
  await page.evaluate(() => window.fxDragQA.s.getState().redo());
  await page.waitForFunction(() => window.fxDragQA.fx[2].instanceId === 'drag-fx-0');
  check('Redo restores the new order', true);
  await dialog.locator('.fx-slot-item').filter({ hasText: 'OpenStudio NAM Rack' }).last().waitFor();
  const beforeCancel = await page.evaluate(() => window.fxDragQA.calls.length);
  await drag(0, 2, true);
  check('Dropping outside the list does not reorder', await page.evaluate(before => window.fxDragQA.calls.length === before, beforeCancel));
  check('Cancelled dragging styling clears', await dialog.locator('.fx-slot-item.dragging').count() === 0);
  await page.evaluate(() => window.fxDragQA.reject = true);
  const beforeReject = await page.evaluate(() => window.fxDragQA.fx.map(fx => fx.instanceId).join());
  await drag(0, 2);
  check('Rejected native reorder preserves order and clears drag', await page.evaluate(before => window.fxDragQA.fx.map(fx => fx.instanceId).join() === before, beforeReject));
  await page.screenshot({ path: 'output/playwright/fx-chain-drag-fixed.png' });
  await dialog.getByRole('button', { name: 'Close FX chain panel', exact: true }).click();
  // Portaled colour-picker blank space must not activate its owning header.
  await page.locator('[data-track-id="drag-one"]').getByTitle('Click to change track color').click();
  const colorTitle = page.getByText('Track Color', { exact: true });
  const box = await colorTitle.boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + 20, box.y + 100, { steps: 10 });
  check('Colour popover drag cannot move a background track', await page.evaluate(() => [...document.querySelectorAll('[data-track-id]')].every(el => !el.style.transform)));
  await page.mouse.up(); await page.keyboard.press('Escape');
  return { status: 'pass', checks: results.length, results, bridge: 'fixture; real UI, store, undo and pointer gestures' };
}

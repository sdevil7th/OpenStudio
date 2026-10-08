// Run with playwright-cli run-code --filename in a disposable Vite App browser.
async page => {
  await page.reload();
  await page.getByRole('menubar', { name: 'Main menu' }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    const { useDAWStore: s, createDefaultTrack } = await import('/src/store/useDAWStore.ts');
    const { nativeBridge: b } = await import('/src/services/NativeBridge.ts');
    const { commandManager } = await import('/src/store/commands/index.ts');
    const { dispatchGlobalShortcut, matchesActionShortcut } = await import('/src/utils/globalShortcutDispatcher.ts');
    const { getShortcutPlatform } = await import('/src/utils/platform.ts');
    const make = () => ['NAM Rack', 'Reverb', 'Delay'].map((name, index) => ({ index, name: 'OpenStudio ' + name, type: 'builtin', instanceId: 'drag-fx-' + index }));
    const lane = { id: 'drag-envelope', param: 'builtin_track_0_ampGainDb', points: [{ id: 'p', time: 1, value: .5 }], visible: false, mode: 'read', readEnabled: true, armed: false };
    const master = make().map(fx => ({ ...fx, automationKey: fx.instanceId, pluginPath: fx.name, pluginFormat: 'BuiltIn', state: 'fixture', bypassed: false, forceFloat: false }));
    window.fxDragQA = { s, b, commandManager, fx: make(), input: make(), master, calls: [], extraCalls: [], historyCalls: [], reject: false, htmlDrags: 0, hold: false };
    const historyEvent = (key, shiftKey) => ({ key, shiftKey, ctrlKey: getShortcutPlatform() !== 'macos', metaKey: getShortcutPlatform() === 'macos', source: 'native' });
    window.fxDragQA.nativeHistoryKey = (key, shiftKey) => dispatchGlobalShortcut(historyEvent(key, shiftKey));
    window.fxDragQA.matchesHistoryKey = (key, shiftKey, action) => matchesActionShortcut(historyEvent(key, shiftKey), action);
    // Simulate a host that rejects native HTML5 drags. Pointer reordering must
    // never enter that path, as on Windows' file-only OLE media drop target.
    document.addEventListener('dragstart', event => { window.fxDragQA.htmlDrags++; event.preventDefault(); }, true);
    s.getState().markInputProfileOnboardingSeen();
    s.setState({ tracks: [{ ...createDefaultTrack('drag-one', 'Drag one', '#4488cc', 'audio'), fxCount: 3, automationLanes: [lane] }, createDefaultTrack('drag-two', 'Drag two', '#cc8844', 'audio')], showGettingStarted: false });
    b.getTrackFX = async () => window.fxDragQA.fx.map((fx, index) => ({ ...fx, index }));
    b.getTrackInputFX = async () => window.fxDragQA.input.map((fx, index) => ({ ...fx, index }));
    b.getMasterFX = async () => window.fxDragQA.master.map((fx, index) => ({ ...fx, index }));
    b.getFXStageState = async () => structuredClone(window.fxDragQA.master);
    b.setFXStageState = async (_chain, state) => { window.fxDragQA.master = structuredClone(state); return true; };
    b.getPluginParameters = async () => [];
    b.getAvailablePlugins = b.getAvailableJSFX = b.getAvailableBuiltInFX = async () => [];
    const reorder = async (chain, from, to) => {
      const q = window.fxDragQA; q.calls.push({ chain, from, to });
      if (q.reject) return false;
      if (q.hold) await new Promise(resolve => { q.release = resolve; });
      const slots = q[chain]; slots.splice(to, 0, ...slots.splice(from, 1)); return true;
    };
    b.reorderTrackFX = async (_id, from, to) => reorder('fx', from, to);
    b.reorderTrackInputFX = async (_id, from, to) => reorder('input', from, to);
    b.reorderMasterFX = async (from, to) => reorder('master', from, to);
    b.removeTrackFX = b.bypassTrackFX = async () => { window.fxDragQA.extraCalls.push('index mutation'); return false; };
    b.setAutomationPoints = b.setAutomationMode = async () => true;
    commandManager.clear();
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const reactDOM = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { FXChainPanel } = await import('/src/components/FXChainPanel.tsx');
    window.fxDragQA.open = chain => {
      const q = window.fxDragQA;
      q.host = document.createElement('div'); document.body.append(q.host);
      q.root = (reactDOM.default || reactDOM).createRoot(q.host);
      q.root.render(React.createElement(FXChainPanel, { trackId: chain === 'master' ? 'master' : 'drag-one', trackName: 'Drag ' + chain, chainType: chain,
        onClose: () => { q.root.unmount(); q.host.remove(); } }));
    };
  });
  const results = [];
  const check = (name, value) => { if (!value) throw new Error(name); results.push(name); };
  await page.locator('[data-track-id="drag-one"]').getByRole('button', { name: 'FX', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'FX chain for Drag one', exact: true });
  await dialog.locator('.fx-slot-item').nth(2).waitFor();
  const drag = async (from, to, outside = false) => {
    const handle = dialog.getByTitle('Drag to reorder', { exact: true }).nth(from);
    // Raw mouse actions do not wait for the panel's enter transform to settle.
    // Check actionability without clicking before reading gesture coordinates.
    await handle.click({ trial: true });
    const a = await handle.boundingBox();
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
  check('Reorder never enters native HTML drag/drop', await page.evaluate(() => window.fxDragQA.htmlDrags === 0));
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
  await page.waitForFunction(() => document.querySelector('.fx-chain-two-column-content')?.getAttribute('aria-busy') === 'false');
  check('Rejected native reorder preserves order and clears drag', await page.evaluate(before => window.fxDragQA.fx.map(fx => fx.instanceId).join() === before, beforeReject));
  check('Rejected native reorder does not change the displayed order', await dialog.locator('[data-fx-slot-index="0"] .fx-slot-name').innerText() === 'OpenStudio Reverb');
  await page.evaluate(() => window.fxDragQA.reject = false);
  await dialog.getByRole('button', { name: 'Reorder OpenStudio NAM Rack', exact: true }).focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => window.fxDragQA.fx[1].instanceId === 'drag-fx-0' && document.activeElement?.getAttribute('aria-label') === 'Reorder OpenStudio NAM Rack');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => window.fxDragQA.fx[0].instanceId === 'drag-fx-0' && document.activeElement?.getAttribute('aria-label') === 'Reorder OpenStudio NAM Rack');
  check('Arrow reordering preserves focus for repeated moves', true);
  // Keep native reorder pending and prove old numeric controls/shortcuts cannot
  // accidentally reach the instance that will move into the old slot.
  await page.evaluate(() => {
    const q = window.fxDragQA;
    // Leave both Undo and Redo available, with observable replay callbacks.
    for (const id of ['pending-undo', 'pending-redo']) q.commandManager.push({ type: id, description: id, timestamp: Date.now(),
      execute: () => q.historyCalls.push('redo ' + id), undo: () => q.historyCalls.push('undo ' + id) });
    q.commandManager.undo();
    q.s.setState({ canUndo: q.commandManager.canUndo(), canRedo: q.commandManager.canRedo() });
    q.hold = true;
  });
  await drag(0, 2);
  await page.waitForFunction(() => typeof window.fxDragQA.release === 'function');
  check('Pending history fixture has both Undo and Redo available', await page.evaluate(() => {
    const q = window.fxDragQA;
    return q.s.getState().canUndo && q.s.getState().canRedo && q.commandManager.canUndo() && q.commandManager.canRedo();
  }));
  check('Pending native reorder makes old slot controls inert', await dialog.locator('.fx-chain-two-column-content').evaluate(el => el.inert));
  await page.keyboard.press('Delete');
  check('Pending reorder blocks index-based FX shortcuts', await page.evaluate(() => window.fxDragQA.extraCalls.length === 0));
  const heldHistory = await page.evaluate(() => {
    const q = window.fxDragQA;
    return { revision: q.commandManager.getRevision(), calls: q.calls.length, historyCalls: q.historyCalls.length };
  });
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  // Native messages have no DOM-modal ownership metadata. They must be claimed
  // by the pending surface as well as the modal's browser-key safeguards.
  check('Pending surface claims native Undo and Redo messages', await page.evaluate(() => {
    const q = window.fxDragQA;
    return q.nativeHistoryKey('z', false) && q.nativeHistoryKey('z', true);
  }));
  check('Pending reorder blocks Undo and Redo without changing native calls or history', await page.evaluate(before => {
    const q = window.fxDragQA;
    return q.commandManager.getRevision() === before.revision && q.calls.length === before.calls && q.historyCalls.length === before.historyCalls;
  }, heldHistory));
  await page.evaluate(() => {
    const q = window.fxDragQA;
    q.previousShortcuts = q.s.getState().customShortcuts;
    q.s.setState({ customShortcuts: { ...q.previousShortcuts, 'edit.undo': { common: ['Ctrl+Shift+F8'] }, 'edit.redo': { common: ['Ctrl+Shift+F9'] } } });
  });
  await page.keyboard.press('ControlOrMeta+Shift+F8');
  await page.keyboard.press('ControlOrMeta+Shift+F9');
  check('Custom history bindings resolve and pending surface claims native messages', await page.evaluate(() => {
    const q = window.fxDragQA;
    return q.matchesHistoryKey('F8', true, 'edit.undo') && q.matchesHistoryKey('F9', true, 'edit.redo')
      && q.nativeHistoryKey('F8', true) && q.nativeHistoryKey('F9', true);
  }));
  check('Pending reorder honors custom Undo and Redo shortcut bindings', await page.evaluate(before => {
    const q = window.fxDragQA;
    return q.commandManager.getRevision() === before.revision && q.calls.length === before.calls && q.historyCalls.length === before.historyCalls;
  }, heldHistory));
  await page.evaluate(() => { window.fxDragQA.hold = false; window.fxDragQA.release(); });
  await page.waitForFunction(() => window.fxDragQA.fx[2].instanceId === 'drag-fx-0' && document.querySelector('.fx-chain-two-column-content')?.getAttribute('aria-busy') === 'false');
  await dialog.getByRole('button', { name: 'Reorder OpenStudio NAM Rack', exact: true }).focus();
  await page.evaluate(() => window.fxDragQA.nativeHistoryKey('F8', true));
  await page.waitForFunction(() => window.fxDragQA.fx[0].instanceId === 'drag-fx-0');
  check('Custom Undo binding replays history after pending reorder finishes', await page.evaluate(before => window.fxDragQA.calls.length === before.calls + 1, heldHistory));
  await page.evaluate(() => window.fxDragQA.nativeHistoryKey('F9', true));
  await page.waitForFunction(() => window.fxDragQA.fx[2].instanceId === 'drag-fx-0');
  check('Custom Redo binding replays history after pending reorder finishes', await page.evaluate(before => window.fxDragQA.calls.length === before.calls + 2, heldHistory));
  await page.evaluate(() => window.fxDragQA.s.setState({ customShortcuts: window.fxDragQA.previousShortcuts }));
  await page.screenshot({ path: 'output/playwright/fx-chain-drag-fixed.png' });
  await dialog.getByRole('button', { name: 'Close FX chain panel', exact: true }).click();
  // A captured pointer held at the list edge must reach offscreen slots.
  await page.evaluate(() => {
    const q = window.fxDragQA;
    q.fx = Array.from({ length: 24 }, (_, index) => ({ index, name: 'OpenStudio Long FX ' + index, type: 'builtin', instanceId: 'long-fx-' + index }));
    q.open('track');
  });
  dialog = page.getByRole('dialog', { name: 'FX chain for Drag track', exact: true });
  await dialog.locator('[data-fx-slot-index="23"]').waitFor({ state: 'attached' });
  await dialog.getByRole('button', { name: 'Reorder OpenStudio Long FX 0', exact: true }).scrollIntoViewIfNeeded();
  check('Long FX list scroll viewport stays inside its panel', await dialog.locator('.fx-slots-list').evaluate(list =>
    list.scrollHeight > list.clientHeight && list.getBoundingClientRect().bottom <= list.closest('.fx-chain-panel-two-column').getBoundingClientRect().bottom + 1));
  const longHandleButton = dialog.getByRole('button', { name: 'Reorder OpenStudio Long FX 0', exact: true });
  await longHandleButton.click({ trial: true });
  const longHandle = await longHandleButton.boundingBox();
  const listBounds = await dialog.locator('.fx-slots-list').boundingBox();
  await page.mouse.move(longHandle.x + longHandle.width / 2, longHandle.y + longHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(listBounds.x + listBounds.width / 2, listBounds.y + listBounds.height - 4, { steps: 8 });
  await page.waitForFunction(() => {
    const list = document.querySelector('.fx-slots-list');
    return list && list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
  });
  check('Pointer edge dragging scrolls to offscreen FX slots', true);
  const lastRow = await dialog.locator('[data-fx-slot-index="23"]').boundingBox();
  await page.mouse.move(lastRow.x + lastRow.width / 2, lastRow.y + lastRow.height / 2);
  await page.mouse.up();
  await page.waitForFunction(() => window.fxDragQA.fx[23].instanceId === 'long-fx-0'
    && document.querySelector('.fx-chain-two-column-content')?.getAttribute('aria-busy') === 'false'
    && document.activeElement?.getAttribute('aria-label') === 'Reorder OpenStudio Long FX 0');
  check('Offscreen pointer drop changes the backend chain order', true);
  const afterLongDropScroll = await dialog.locator('.fx-slots-list').evaluate(list => list.scrollTop);
  await page.waitForTimeout(100);
  check('Pointer release stops automatic edge scrolling', await dialog.locator('.fx-slots-list').evaluate((list, before) => list.scrollTop === before, afterLongDropScroll));
  await dialog.getByRole('button', { name: 'Close FX chain panel', exact: true }).click();
  // Portaled colour-picker blank space must not activate its owning header.
  await page.locator('[data-track-id="drag-one"]').getByTitle('Click to change track color').click();
  const colorTitle = page.getByText('Track Color', { exact: true });
  const box = await colorTitle.boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + 20, box.y + 100, { steps: 10 });
  check('Colour popover drag cannot move a background track', await page.evaluate(() => [...document.querySelectorAll('[data-track-id]')].every(el => !el.style.transform)));
  await page.mouse.up(); await page.keyboard.press('Escape');
  for (const chain of ['input', 'master']) {
    await page.evaluate(chain => window.fxDragQA.open(chain), chain);
    dialog = page.getByRole('dialog', { name: 'FX chain for Drag ' + chain, exact: true });
    await dialog.locator('[data-fx-slot-index="2"]').waitFor();
    await drag(0, 2);
    await page.waitForFunction(chain => window.fxDragQA[chain][2].instanceId === 'drag-fx-0', chain);
    check(chain + ' pointer drop calls its backend chain reorder', await page.evaluate(chain => window.fxDragQA.calls.some(call => call.chain === chain && call.from === 0 && call.to === 2), chain));
    await page.evaluate(() => window.fxDragQA.s.getState().undo());
    await page.waitForFunction(chain => window.fxDragQA[chain][0].instanceId === 'drag-fx-0', chain);
    check(chain + ' undo restores native fixture order', true);
    await page.evaluate(() => window.fxDragQA.s.getState().redo());
    await page.waitForFunction(chain => window.fxDragQA[chain][2].instanceId === 'drag-fx-0', chain);
    check(chain + ' redo reapplies native fixture order', true);
    await dialog.getByRole('button', { name: 'Close FX chain panel', exact: true }).click();
  }
  return { status: 'pass', checks: results.length, results, bridge: 'fixture; real UI, store, undo and pointer gestures' };
}

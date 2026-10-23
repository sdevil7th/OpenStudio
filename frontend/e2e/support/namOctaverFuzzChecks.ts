import type { Page } from "@playwright/test";
import type { BrowserRegressionReport } from "./interactionFixtureTypes";

/** Validate responsive pedal geometry and independent Octave/Fuzz state. */
export async function runNamOctaverFuzzChecks(page: Page): Promise<BrowserRegressionReport> {
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  page.on("pageerror", onPageError);
  try {
    const session = { address: { trackId: 'octaver-fuzz-ui-qa', chain: 'track', fxIndex: 0 }, title: 'OpenStudio NAM Rack', fallbackName: 'OpenStudio NAM Rack' } as const;
    const query = new URLSearchParams({ window: 'pluginEditor', platform: 'windows', windowChrome: 'native', mockPlugin: 'nam', sessionId: JSON.stringify(session), namView: 'rack', namFocus: 'gate', namSection: 'pre' });
    await page.goto(`/?${query}`);
    const host = page.locator('.nam-rack-design-port.nam-native-design-surface[data-design-section="pre"]');
    await host.waitFor({ state: 'visible', timeout: 20000 });
    const checks: string[] = [];
    for (const width of [1920, 1280, 900, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
        await Promise.all(Array.from(document.images).map(image => image.decode().catch(() => {})));
        await new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      });
      const metrics = await host.evaluate(root => {
        const module = root.querySelector<HTMLElement>('[data-module="octaver"]');
        if (!module) throw new Error('Octaver Fuzz module is missing');
        const box = module.getBoundingClientRect();
        const rect = (element: Element) => { const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom }; };
        const controls = Array.from(module.querySelectorAll<HTMLElement>('[data-param-id][role]')).filter(control => control.getBoundingClientRect().width > 0).map(control => ({ id: control.dataset.paramId, role: control.getAttribute('role'), name: control.getAttribute('aria-label'), ...rect(control) }));
        const staticItems = Array.from(module.querySelectorAll<HTMLElement>('.control-label, .foot-action-label, .module-title, .led')).map(element => ({ name: element.textContent || element.className, ...rect(element) }));
        const staticCollisions = staticItems.flatMap((item, index) => staticItems.slice(index + 1).flatMap(other => (
          Math.min(item.right, other.right) - Math.max(item.x, other.x) > 0.5
          && Math.min(item.bottom, other.bottom) - Math.max(item.y, other.y) > 0.5
            ? [`${item.name} / ${other.name}`] : []
        )));
        const faceplate = module.querySelector<HTMLImageElement>('.module-skin');
        if (!faceplate?.complete || !faceplate.naturalWidth) throw new Error('Octaver Fuzz faceplate did not load');
        return { module: rect(module), controls, staticItems, staticCollisions, overflowX: document.documentElement.scrollWidth > innerWidth + 1, host: rect(root), accessibleName: module.getAttribute('aria-label'), moduleWidth: box.width };
      });
      const ids = [...new Set(metrics.controls.map(control => control.id))];
      for (const id of ['octaverDownMix','octaverUpMix','octaverDirectMix','fuzzDrive','fuzzTone','fuzzLevelDb','fuzzCleanMix','fuzzVoice','octaverEnabled','fuzzEnabled']) assert(ids.includes(id), `${width}px missing interactive ${id} ${JSON.stringify(metrics)}`);
      assert(!metrics.overflowX, `${width}px document horizontal overflow`);
      assert(metrics.controls.every(control => control.name), `${width}px control missing accessible name`);
      assert(metrics.controls.every(control => control.x >= metrics.module.x - 1 && control.y >= metrics.module.y - 1 && control.right <= metrics.module.right + 1 && control.bottom <= metrics.module.bottom + 1), `${width}px control extends outside pedal ${JSON.stringify(metrics)}`);
      assert(metrics.accessibleName === 'OCTAVER FUZZ module', `${width}px painted pedal must retain its accessible name`);
      assert(metrics.staticCollisions.length === 0, `${width}px overlapping faceplate labels/title/LEDs ${metrics.staticCollisions}`);
      assert(metrics.staticItems.every(item => item.x >= metrics.module.x - 1 && item.y >= metrics.module.y - 1 && item.right <= metrics.module.right + 1 && item.bottom <= metrics.module.bottom + 1), `${width}px static faceplate content outside pedal`);
      checks.push(`${width}px: pedal controls/labels fit without collisions or overflow and have accessible names`);
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    const module = host.locator('[data-module="octaver"]');
    const octave = module.locator('[data-param-id="octaverEnabled"][role="button"]');
    const fuzz = module.locator('[data-param-id="fuzzEnabled"][role="button"]');
    const value = (id: string) => module.locator(`[data-param-id="${id}"][role]`).getAttribute('aria-valuenow');
    await fuzz.click();
    assert(await fuzz.getAttribute('aria-pressed') === 'true' && await octave.getAttribute('aria-pressed') === 'false', 'fuzz-only enable must leave octave bypassed');
    await octave.click();
    assert(await octave.getAttribute('aria-pressed') === 'true' && await fuzz.getAttribute('aria-pressed') === 'true', 'octave can enable independently of fuzz');
    await octave.click();
    assert(await fuzz.getAttribute('aria-pressed') === 'true', 'octave bypass must leave fuzz enabled');
    const voice = module.locator('[data-param-id="fuzzVoice"][role="spinbutton"]');
    await voice.focus();
    await page.keyboard.press('ArrowUp');
    assert(await value('fuzzVoice') === '1' && (await voice.getAttribute('aria-label'))?.includes('Sustain'), 'voice selector changes to Sustain');
    assert((await module.locator('.fuzz-voice-display').textContent() ?? '').toUpperCase() === 'SUSTAIN', 'voice faceplate display updates');
    for (const id of ['fuzzDrive', 'fuzzTone', 'fuzzLevelDb']) {
      const knob = module.locator(`[data-param-id="${id}"][role="slider"]`);
      const before = Number(await value(id));
      await knob.focus();
      await page.keyboard.press('ArrowUp');
      assert(Number(await value(id)) > before, `${id} keyboard adjustment must update live value`);
      const focus = await knob.evaluate(node => ({ width: getComputedStyle(node).outlineWidth, style: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow }));
      assert((Number.parseFloat(focus.width) > 0 && focus.style !== 'none') || focus.shadow !== 'none', `${id} keyboard focus must be visible`);
    }
    const bridgeState = (): Promise<Record<string, number>> => page.evaluate(async address => {
      const source = await (await fetch('/src/components/NAMRackPanel.tsx')).text();
      const bridgeUrl = source.match(/from "([^"]*NativeBridge\.ts[^"]*)"/)?.[1];
      if (!bridgeUrl) throw new Error('NAM editor bridge import was not found');
      const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../../src/services/NativeBridge");
      const state: unknown = await nativeBridge.getBuiltInPluginState(address);
      if (!state || typeof state !== 'object' || !('values' in state)
        || !state.values || typeof state.values !== 'object') {
        throw new Error('NAM bridge did not return parameter values');
      }
      const values: Record<string, number> = {};
      for (const [id, value] of Object.entries(state.values)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid NAM value: ${id}`);
        values[id] = value;
      }
      return values;
    }, session.address);
    const state = await bridgeState();
    assert(state.fuzzEnabled === 1 && state.octaverEnabled === 0 && state.fuzzVoice === 1 && state.fuzzDrive > 0.5 && state.fuzzTone > 0.5 && state.fuzzLevelDb > 0, `real bridge state must agree with fuzz-only controls ${JSON.stringify(state)}`);
    checks.push('independent fuzz/octave switches, voice display, all fuzz knobs, visible keyboard focus and bridge state');
    await page.locator('[data-qa="nam-premium-signal-chain"]').click();
    const node = page.locator('[data-qa="nam-compact-chain-node-octaver"]');
    await node.waitFor({ state: 'visible' });
    assert((await node.locator('strong').textContent()) === 'Octaver Fuzz', 'compact chain uses the Octaver Fuzz product name');
    assert(await node.getAttribute('data-active') === 'true' && (await node.textContent() ?? '').includes('Sustain Fuzz'), 'compact chain must show active fuzz-only stage and voice');
    const compactPower = node.locator('.nam-compact-chain-power');
    await compactPower.click();
    let powered = await bridgeState();
    assert(powered.octaverEnabled === 0 && powered.fuzzEnabled === 0, 'compact fuzz-only bypass must bypass both stage switches');
    await compactPower.click();
    powered = await bridgeState();
    assert(powered.octaverEnabled === 0 && powered.fuzzEnabled === 1, 'compact fuzz-only power cycle must restore fuzz alone');
    await page.getByRole('button', { name: 'Close signal chain', exact: true }).click();
    await octave.click();
    await page.locator('[data-qa="nam-premium-signal-chain"]').click();
    await compactPower.click();
    powered = await bridgeState();
    assert(powered.octaverEnabled === 0 && powered.fuzzEnabled === 0, 'compact combined bypass must bypass both stage switches');
    await compactPower.click();
    powered = await bridgeState();
    assert(powered.octaverEnabled === 1 && powered.fuzzEnabled === 1, 'compact combined power cycle must restore octave and fuzz');
    checks.push('compact power cycles preserve fuzz-only and combined octave/fuzz enable combinations');
    await page.getByRole('button', { name: 'Close signal chain', exact: true }).click();
    await octave.click();
    await page.locator('[data-qa="nam-premium-signal-chain"]').click();
    await node.locator('.nam-compact-chain-node-main').click();
    await module.locator('[data-param-id="fuzzCleanMix"][role="slider"]').waitFor({ state: 'visible' });
    assert(!await page.locator('[data-qa="nam-rack-mixer"]').isVisible(), 'compact navigation must reveal the complete pedal without an unnecessary advanced panel');
    assert(await fuzz.getAttribute('aria-pressed') === 'true' && await octave.getAttribute('aria-pressed') === 'false', 'compact navigation retains independent stage state');
    checks.push('compact chain reveals the complete pedal including Clean blend and retains fuzz-only state');
    assert(pageErrors.length === 0, `Browser runtime errors: ${pageErrors.join('; ')}`);
    return { status: 'pass', checks };
  } finally {
    page.off("pageerror", onPageError);
  }
}

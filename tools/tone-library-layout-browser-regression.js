// Run with playwright-cli run-code --filename in a disposable Vite browser.
// Uses the development NAM fixture; authentication, catalog, and audio are mocked.
async page => {
  const checks = [];
  const check = (name, passed) => {
    if (!passed) throw new Error(name);
    checks.push(name);
  };
  const params = new URLSearchParams({
    window: 'pluginEditor', platform: 'windows', windowChrome: 'native',
    mockPlugin: 'nam', namView: 'rack', namLibraryFlow: 'amp',
    sessionId: JSON.stringify({ address: { trackId: 'tone-layout-qa', chain: 'track', fxIndex: 0 }, title: 'OpenStudio NAM Rack', fallbackName: 'OpenStudio NAM Rack' }),
  });
  await page.goto(new URL('/?' + params, page.url()).href);
  await page.locator('.tone-library-panel').waitFor();
  await page.locator('.tone3000-account').waitFor();
  for (const [width, height] of [[1920, 1080], [1366, 768], [1280, 720], [1024, 640], [800, 600], [600, 600], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async () => {
      document.querySelector('.tone-library-panel').scrollTop = 0;
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const workspace = rect('.tone-source-v2-workspace');
      const list = rect('.tone-feed-list');
      const pager = rect('.tone-library-pager');
      const header = rect('.tone3000-library-header');
      const browse = rect('.tone3000-browse-button');
      const account = rect('.tone3000-account');
      return {
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        listInside: list.top >= workspace.top && list.bottom <= workspace.bottom + 1,
        listHeight: list.height,
        pagerInside: pager.bottom <= workspace.bottom + 1,
        headerInside: header.left >= 0 && header.right <= innerWidth + 1,
        accountInside: account.left >= header.left && account.right <= browse.left,
        buttonCompact: browse.width <= 130 && browse.height <= 36,
        removedHelper: !document.body.textContent.includes('Creator, license, instrument and character filters apply to loaded results.'),
      };
    });
    check(`${width}x${height}: no horizontal overflow`, !geometry.horizontalOverflow);
    check(`${width}x${height}: results and pagination fit`, geometry.listInside && geometry.pagerInside && geometry.listHeight >= 80);
    check(`${width}x${height}: compact branding and account fit`, geometry.headerInside && geometry.accountInside && geometry.buttonCompact);
    check(`${width}x${height}: helper text removed`, geometry.removedHelper);
    if (width > 1024) {
      const actionGeometry = await page.evaluate(() => {
        const stage = document.querySelector('.tone-selected-stage');
        stage.scrollTop = stage.scrollHeight;
        const actions = stage.querySelector('.tone-action-grid').getBoundingClientRect();
        const buttons = [...stage.querySelectorAll('.tone-action-grid button')].map(el => el.getBoundingClientRect());
        const status = stage.querySelector('.tone-audition-status').getBoundingClientRect();
        const bounds = stage.getBoundingClientRect();
        return { noOverlap: buttons.every(r => r.bottom <= actions.bottom + 1 && r.bottom <= status.top), reachable: actions.top >= bounds.top && status.bottom <= bounds.bottom + 1 };
      });
      check(`${width}x${height}: selected actions and route status fit without overlap`, actionGeometry.noOverlap && actionGeometry.reachable);
      await page.locator('.tone-selected-stage').evaluate(el => el.scrollTop = 0);
    }
    await page.screenshot({ path: `output/playwright/tone-library-${width}x${height}.png` });
  }
  const browse = page.getByRole('button', { name: 'Browse TONE3000', exact: true });
  check('Browse displays text followed by official T3K mark', await browse.evaluate(el => el.firstElementChild.textContent === 'Browse' && el.lastElementChild.classList.contains('t3k-mark')));
  await browse.focus();
  check('Browse has visible keyboard focus', await browse.evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== 'none'));
  await page.getByRole('button', { name: 'View 4 Captures', exact: true }).click();
  const details = page.locator('.tone-compact-selection');
  await details.locator('.nam-tone-capture-select').first().waitFor();
  check('Capture selection automatically opens compact details', await details.evaluate(el => el.open));
  const capture = details.getByRole('button', { name: 'Use Headbangers Ball 01 IR', exact: true });
  await capture.scrollIntoViewIfNeeded();
  check('Capture action stays reachable inside scrolling compact details', await capture.evaluate(el => {
    const r = el.getBoundingClientRect();
    const details = el.closest('.tone-compact-selection').getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.top >= details.top && r.bottom <= Math.min(details.bottom, innerHeight);
  }));
  const summary = details.locator(':scope > summary');
  await summary.scrollIntoViewIfNeeded();
  await summary.focus();
  await page.keyboard.press('Enter');
  check('Compact details can be collapsed with keyboard', await details.evaluate(el => !el.open));
  await page.getByRole('button', { name: 'View 4 Captures', exact: true }).click();
  await details.locator('.nam-tone-capture-select').first().waitFor();
  check('Selecting the same pack reopens its compact model selector', await details.evaluate(el => el.open));

  params.set('namQuery', 'headbangers');
  await page.goto(new URL('/?' + params, page.url()).href);
  await page.locator('.tone3000-account').waitFor();
  await page.evaluate(async () => {
    const { nativeBridge } = await import('/src/services/NativeBridge.ts');
    nativeBridge.getTONE3000ToneDetail = () => new Promise(resolve => {
      window.completeToneLayoutDetail = () => resolve({ success: false, statusCode: 500, error: 'Tone details unavailable' });
    });
  });
  await page.getByRole('button', { name: 'View 4 Captures', exact: true }).click();
  const pendingDetails = page.locator('.tone-compact-selection');
  await pendingDetails.getByText('Loading...', { exact: true }).waitFor();
  check('Loading a pack with no models yet opens compact details', await pendingDetails.evaluate(el => el.open));
  await pendingDetails.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  check('Pending compact details can still be collapsed', await pendingDetails.evaluate(el => !el.open));
  await page.evaluate(() => {
    window.completeToneLayoutDetail();
    delete window.completeToneLayoutDetail;
  });
  await pendingDetails.locator('.nam-tone-capture-error').waitFor();
  check('A zero-model loading failure reopens visible capture feedback', await pendingDetails.evaluate(el => el.open && el.querySelector('.nam-tone-capture-error').textContent.includes('No downloadable NAM captures')));
  return { status: 'pass', checks: checks.length, results: checks, scope: 'Real responsive UI with deterministic NAM fixtures; native account and audio quality not_asserted' };
}

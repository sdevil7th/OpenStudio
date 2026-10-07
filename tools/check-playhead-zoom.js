// Start the frontend dev server and open it with playwright-cli, then run:
// playwright-cli run-code --filename tools/check-playhead-zoom.js
// Uses the real Playhead, Zustand subscriptions, React, and Konva canvas.
async (page) => {
  await page.reload();
  await page.getByText('Starting OpenStudio...', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const dependency = name => performance.getEntriesByType('resource')
      .find(entry => entry.name.includes(`/deps/${name}.js?`)).name;
    const reactModule = await import(dependency('react'));
    const React = reactModule.default || reactModule;
    const rootModule = await import(dependency('react-dom_client'));
    const { createRoot } = rootModule.default || rootModule;
    const konvaModule = await import(dependency('react-konva'));
    const { Stage, Layer } = konvaModule.default || konvaModule;
    const { MemoizedPlayhead: Playhead } = await import('/src/components/Playhead.tsx');
    const { useDAWStore: store } = await import('/src/store/useDAWStore.ts');
    store.setState({ pixelsPerSecond: 50, scrollX: 0,
      transport: { ...store.getState().transport, currentTime: 10, isPlaying: false } });
    const qa = window.__playheadZoomQA = { store, width: 800, height: 240 };
    const host = document.createElement('div');
    host.id = 'playhead-zoom-fixture';
    Object.assign(host.style, { position: 'fixed', left: '0', top: '0', zIndex: '99999', background: '#121212' });
    document.body.append(host);
    const root = createRoot(host);
    const render = () => {
      const s = store.getState();
      const props = { pixelsPerSecond: s.pixelsPerSecond, scrollX: s.scrollX,
        viewportWidth: qa.width, stageHeight: qa.height };
      root.render(React.createElement(Stage, { width: qa.width, height: qa.height,
        ref: stage => { qa.stage = stage; } },
        React.createElement(Layer, null, React.createElement(Playhead, { ...props, type: 'main' })),
        React.createElement(Layer, null, React.createElement(Playhead, { ...props, type: 'ruler' }))));
    };
    qa.render = render;
    qa.unsubscribe = store.subscribe(render);
    qa.root = root;
    render();
  });
  const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const checks = [];
  const read = () => page.evaluate(() => {
    const q = window.__playheadZoomQA;
    const s = q.store.getState();
    const line = q.stage.findOne('Line');
    const ruler = q.stage.findOne('Rect');
    const expectedX = s.transport.currentTime * s.pixelsPerSecond - s.scrollX;
    const canvas = document.querySelector('#playhead-zoom-fixture canvas');
    const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(expectedX * canvas.width / q.width)));
    const pixel = Array.from(canvas.getContext('2d').getImageData(x, 60, 1, 1).data);
    return { expectedX, expectedVisible: expectedX >= 0 && expectedX <= q.width,
      lineVisible: line.visible(), lineX: line.points()[0], lineHeight: line.points()[3],
      rulerVisible: ruler.visible(), rulerX: ruler.x() + 6, pixel };
  });
  const verify = async label => {
    await paint();
    const s = await read();
    if (s.lineVisible !== s.expectedVisible || s.rulerVisible !== s.expectedVisible) {
      throw new Error(`${label}: incorrect visibility ${JSON.stringify(s)}`);
    }
    if (s.expectedVisible && (Math.abs(s.lineX - s.expectedX) > 1e-6
      || Math.abs(s.rulerX - s.expectedX) > 1e-6)) {
      throw new Error(`${label}: incorrect position ${JSON.stringify(s)}`);
    }
    if (s.expectedVisible && !(s.pixel[2] > s.pixel[1] && s.pixel[1] > s.pixel[0] && s.pixel[3] > 0)) {
      throw new Error(`${label}: visible playhead not painted on canvas ${JSON.stringify(s)}`);
    }
    checks.push(label);
    return s;
  };
  await paint();
  await verify('initial stopped playhead');
  // These two store writes are batched by React during pointer-anchored zoom.
  // The playhead stays at x=500; transport time does not change.
  await page.evaluate(() => {
    const s = window.__playheadZoomQA.store.getState();
    s.setZoom(1000);
    s.setScroll(9500, 0);
  });
  await verify('maximum zoom keeps stopped playhead at the same screen position');

  for (const zoom of [750, 250, 50, 25, 1, 1000, 50, 1000]) {
    await page.evaluate(zoom => {
      const s = window.__playheadZoomQA.store.getState();
      s.setZoom(zoom);
      s.setScroll(Math.max(0, s.transport.currentTime * zoom - 500), 0);
    }, zoom);
    await verify(`anchored zoom to ${zoom} pixels per second`);
  }
  await page.evaluate(() => {
    const q = window.__playheadZoomQA;
    // Zoom alone must update visibility, without needing a seek or scroll.
    q.store.getState().setZoom(1);
  });
  await verify('zoom-only update hides genuinely offscreen playhead');
  await page.evaluate(() => window.__playheadZoomQA.store.getState().setZoom(1000));
  await verify('zoom-only update restores visibility while stopped');

  for (const width of [400, 800]) {
    await page.evaluate(width => {
      const q = window.__playheadZoomQA;
      q.width = width;
      q.render();
    }, width);
    await verify(`resize viewport to ${width}px`);
  }
  await page.evaluate(() => {
    const q = window.__playheadZoomQA;
    q.height = 480;
    q.render();
  });
  const resized = await verify('resize playhead height');
  if (resized.lineHeight !== 480) throw new Error('playhead must span resized stage');

  for (const x of [0, 0.25, 250, 800, 801, -1, 500]) {
    await page.evaluate(x => {
      const q = window.__playheadZoomQA;
      const s = q.store.getState();
      q.store.setState({ transport: { ...s.transport, currentTime: (s.scrollX + x) / s.pixelsPerSecond } });
    }, x);
    await verify(`seek at maximum zoom to viewport x=${x}`);
  }
  for (let step = 1; step <= 10; step++) {
    await page.evaluate(step => {
      const q = window.__playheadZoomQA;
      const s = q.store.getState();
      const time = 10 + step * 0.016;
      q.store.setState({ transport: { ...s.transport, currentTime: time } });
      s.setScroll(time * s.pixelsPerSecond - 500, 0);
    }, step);
    await verify(`transport and follow-scroll update ${step}`);
  }
  await page.locator('#playhead-zoom-fixture').screenshot({ path: 'output/playwright/playhead-maximum-zoom.png' });
  await page.evaluate(() => {
    const q = window.__playheadZoomQA;
    q.unsubscribe();
    q.root.unmount();
    document.getElementById('playhead-zoom-fixture').remove();
  });
  return { status: 'pass', checks };
}

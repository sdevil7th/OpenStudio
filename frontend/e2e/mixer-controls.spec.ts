import { expect, test, type Locator, type Page } from '@playwright/test';

async function drag(page: Page, slider: Locator, from: number, to: number) {
  const box = await slider.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  await page.mouse.move(x, box!.y + box!.height * from);
  await page.mouse.down();
  await page.mouse.move(x, box!.y + box!.height * to, { steps: 8 });
  await page.mouse.up();
}

for (const size of [
  { width: 1024, height: 768, scale: 1 },
  { width: 1400, height: 900, scale: 1.5 },
  { width: 1920, height: 1080, scale: 2 },
]) {
  test.describe(`${size.width}x${size.height} at ${size.scale}x`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.scale });

    test('master and track faders move vertically, stay contained and undo once', async ({ page }, testInfo) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Use these profiles' }).click();
      await page.getByRole('button', { name: 'Add new audio track' }).click();
      const faders = page.getByRole('slider', { name: /Volume fader for/ });
      await expect(faders).toHaveCount(2);
      for (const slider of await faders.all()) {
        const geometry = await slider.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const parent = element.parentElement!.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height,
            contained: bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1
              && bounds.top >= parent.top - 1 && bounds.bottom <= parent.bottom + 1 };
        });
        expect(geometry.contained).toBe(true);
        expect(geometry.height).toBeGreaterThan(geometry.width * 3);
        await expect(slider).toHaveAttribute('aria-orientation', 'vertical');
        const initial = Number(await slider.inputValue());
        await drag(page, slider, 0.8, 0.25);
        const raised = Number(await slider.inputValue());
        expect(raised).toBeGreaterThan(-12);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(slider).toHaveValue(String(initial));
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(slider).toHaveValue(String(raised));

        // Moving sideways with the pointer held must not change the volume.
        const box = (await slider.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5);
        await page.mouse.down();
        const beforeSideways = Number(await slider.inputValue());
        await page.mouse.move(box.x + 100, box.y + box.height * 0.5, { steps: 8 });
        expect(Number(await slider.inputValue())).toBeCloseTo(beforeSideways, 1);
        await page.mouse.up();

        await slider.focus();
        await page.keyboard.press('Home');
        await expect(slider).toHaveValue('-60');
        await page.keyboard.press('End');
        await expect(slider).toHaveValue('12');
        await page.keyboard.press('ArrowDown');
        await expect(slider).toHaveValue('11.9');
        await slider.click({ modifiers: ['Control'] });
        await expect(slider).toHaveValue('0');
      }
      await testInfo.attach('mixer', { body: await page.screenshot(), contentType: 'image/png' });
    });
  });
}

test('pan stays horizontal, supports one-step undo and recenters on double click', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use these profiles' }).click();
  const pan = page.getByRole('slider', { name: /Pan for MASTER/ });
  const box = (await pan.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(Number(await pan.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(pan).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await pan.dblclick();
  await expect(pan).toHaveAttribute('aria-valuenow', '0');
});

test('disabled pan and fader reject pointer, reset, wheel and keyboard edits', async ({ page }) => {
  await page.goto('/control-e2e.html');
  for (const name of ['Disabled pan', 'Disabled fader']) {
    const control = page.getByRole('slider', { name, exact: true });
    const box = (await control.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.2);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await control.dispatchEvent('keydown', { key: 'Home' });
    await expect(page.getByLabel(`${name} value`)).toHaveText('25');
    await expect(page.getByLabel(`${name} transactions`)).toHaveText('0/0');
  }
});

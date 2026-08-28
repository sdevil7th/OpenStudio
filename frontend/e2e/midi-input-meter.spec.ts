import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/shortcut-e2e.html");
  await expect(page.getByRole("meter", { name: "Harness track meter" })).toBeVisible();
});

test("armed raw MIDI draws mirrored light input lanes and audio output takes precedence", async ({ page }) => {
  await page.evaluate(() => window.setHarnessMeterState({
    audioLevel: 0,
    midiInputLevel: 0.75,
    armed: true,
    trackType: "midi",
  }));

  const meter = page.getByRole("meter", { name: "Harness track meter" });
  await expect(meter).toHaveAttribute("data-meter-source", "midi_input");
  await page.waitForTimeout(120);

  const pixels = await meter.evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    const context = element.getContext("2d");
    if (!context) throw new Error("Meter canvas has no 2D context");
    const y = element.height - 8;
    return {
      left: Array.from(context.getImageData(2, y, 1, 1).data),
      right: Array.from(context.getImageData(13, y, 1, 1).data),
    };
  });
  expect(pixels.left).toEqual([103, 232, 249, 255]);
  expect(pixels.right).toEqual(pixels.left);

  await page.evaluate(() => window.setHarnessMeterState({
    audioLevel: 0.2,
    midiInputLevel: 1,
    armed: true,
    trackType: "instrument",
  }));
  await expect(meter).toHaveAttribute("data-meter-source", "audio");

  await page.evaluate(() => window.setHarnessMeterState({
    audioLevel: 0,
    midiInputLevel: 1,
    armed: false,
    trackType: "midi",
  }));
  await expect(meter).toHaveAttribute("data-meter-source", "idle");
});

import { expect, test } from "@playwright/test";

test("portal menu actions do not restore or drag the maximized window", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/?platform=windows&windowChrome=custom");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 15000 });
  await page.evaluate(async () => {
    const { nativeBridge } = await import("/src/services/NativeBridge.ts");
    const calls = { drags: 0, fileDialogs: 0 };
    (window as typeof window & { __menuDragCalls: typeof calls }).__menuDragCalls = calls;
    nativeBridge.startWindowDrag = async () => { calls.drags += 1; };
    nativeBridge.showOpenDialog = async () => { calls.fileDialogs += 1; return null; };
  });

  await page.getByRole("menuitem", { name: "Options menu" }).click();
  await page.getByRole("menuitem", { name: "Preferences..." }).click();
  await expect(page.getByRole("dialog", { name: /Preferences/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__menuDragCalls.drags)).toBe(0);

  await page.getByRole("dialog", { name: /Preferences/ }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insert menu" }).click();
  await page.getByRole("menuitem", { name: "Media file..." }).click();
  expect(await page.evaluate(() => (window as any).__menuDragCalls)).toEqual({ drags: 0, fileDialogs: 1 });

  await page.getByTestId("window-drag-region").click();
  expect(await page.evaluate(() => (window as any).__menuDragCalls.drags)).toBe(1);
});

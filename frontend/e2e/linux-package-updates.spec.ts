import { expect, test } from "@playwright/test";

test("native Linux update dialog offers the package download without AppImage actions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({ schemaVersion: 1, keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 15000 });
  await page.evaluate(async () => {
    const moduleUrl = "/src/store/appUpdateStore.ts";
    const { useAppUpdateStore } = await import(/* @vite-ignore */ moduleUrl);
    useAppUpdateStore.getState().acceptStatus({ status: "manual-update", updateSource: "linux-package", currentVersion: "0.1.04", message: "Download the matching .deb installer for your distribution.", releasePageUrl: "https://openstudio.org.in/download" });
    useAppUpdateStore.getState().setOpen(true);
  });
  const dialog = page.getByRole("dialog", { name: "OpenStudio updates" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Get Linux installer" })).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Install update|Download update/ })).toHaveCount(0);
  for (const width of [1280, 640]) {
    await page.setViewportSize({ width, height: 720 });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    for (const button of await dialog.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
  }
  await dialog.getByRole("button", { name: "Get Linux installer" }).focus();
  await expect(dialog.getByRole("button", { name: "Get Linux installer" })).toBeFocused();
  await page.screenshot({ path: "../output/playwright/linux-package-updates.png" });
});

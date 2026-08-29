import { expect, test } from "@playwright/test";

const PROFILE_SETTINGS_KEY = "openstudio.inputProfiles.v1";
const CUSTOM_KEYBOARD_PROFILES_KEY = "openstudio.keyboardProfiles.v2";
const MOUSE_MODIFIER_OVERRIDES_KEY = "openstudio.mouseModifierOverrides.v1";
const IS_MAC_HOST = process.platform === "darwin";
const PRIMARY_KEY = IS_MAC_HOST ? "Meta" : "Control";
const PRIMARY_LABEL = IS_MAC_HOST ? "Cmd" : "Ctrl";
const HOST_OVERRIDE_TARGET = IS_MAC_HOST ? "macos" : "windows";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(({ settingsKey, customProfilesKey, mouseOverridesKey }) => {
    localStorage.removeItem(settingsKey);
    localStorage.removeItem(customProfilesKey);
    localStorage.removeItem(mouseOverridesKey);
    localStorage.removeItem("openstudio_essentialControlsDismissed");
    localStorage.removeItem("s13_customShortcuts");
  }, {
    settingsKey: PROFILE_SETTINGS_KEY,
    customProfilesKey: CUSTOM_KEYBOARD_PROFILES_KEY,
    mouseOverridesKey: MOUSE_MODIFIER_OVERRIDES_KEY,
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Make OpenStudio feel familiar" })).toBeVisible();
});

test("first-run chooser remains usable in a compact viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 620 });
  const chooser = page.getByRole("region", { name: "Choose input profiles" });
  await expect(chooser).toBeVisible();
  const bounds = await chooser.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(620);

  await page.getByLabel("Keyboard profile").selectOption("reaper");
  await page.getByLabel("Mouse & scroll profile").selectOption("logic_pro");
  await expect(page.getByLabel("Keyboard profile")).toHaveValue("reaper");
  await expect(page.getByLabel("Mouse & scroll profile")).toHaveValue("logic_pro");
});

test("chooser exposes the additional platform-qualified DAW profiles", async ({ page }) => {
  const keyboard = page.getByLabel("Keyboard profile");
  const mouse = page.getByLabel("Mouse & scroll profile");
  for (const [value, label] of [
    ["cakewalk_sonar", IS_MAC_HOST ? "Cakewalk / Sonar (cross-platform emulation)" : "Cakewalk / Sonar"],
    ["garageband", IS_MAC_HOST ? "GarageBand" : "GarageBand (cross-platform emulation)"],
    ["digital_performer", "Digital Performer"],
    ["adobe_audition", "Adobe Audition"],
    ["mixcraft", IS_MAC_HOST ? "Mixcraft (cross-platform emulation)" : "Mixcraft"],
    ["waveform", "Waveform"],
    ["renoise", "Renoise"],
  ] as const) {
    await expect(keyboard.locator(`option[value="${value}"]`)).toHaveText(label);
    await expect(mouse.locator(`option[value="${value}"]`)).toHaveText(label);
  }

  await keyboard.selectOption("cakewalk_sonar");
  await mouse.selectOption("digital_performer");
  await expect(keyboard).toHaveValue("cakewalk_sonar");
  await expect(mouse).toHaveValue("digital_performer");
});

test("first-run profile choices persist independently across reload", async ({ page }) => {
  await page.getByLabel("Keyboard profile").selectOption("reaper");
  await page.getByLabel("Mouse & scroll profile").selectOption("logic_pro");
  await page.getByRole("button", { name: "Use these profiles" }).click();

  await expect(page.getByRole("region", { name: "Choose input profiles" })).toBeHidden();
  const persisted = await page.evaluate((settingsKey) => (
    JSON.parse(localStorage.getItem(settingsKey) ?? "{}")
  ), PROFILE_SETTINGS_KEY);
  expect(persisted).toMatchObject({
    schemaVersion: 1,
    keyboardProfileId: "reaper",
    mouseProfileId: "logic_pro",
    onboardingSeen: true,
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Make OpenStudio feel familiar" })).toHaveCount(0);
});

test("Review shortcuts carries selections into the full editor", async ({ page }) => {
  await page.getByLabel("Keyboard profile").selectOption("pro_tools");
  await page.getByLabel("Mouse & scroll profile").selectOption("cubase");
  await page.getByRole("button", { name: "Review shortcuts" }).click();

  const dialog = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Keyboard profile")).toHaveValue("pro_tools");
  await expect(dialog.getByLabel("Mouse & scroll profile")).toHaveValue("cubase");
  await expect(dialog.getByText(/Scoped bindings apply only in their named editors/)).toBeVisible();
  const recordRow = dialog.getByTitle("Record").locator("..");
  await expect(recordRow.getByText(`${PRIMARY_LABEL}+Space`, { exact: true })).toBeVisible();
  await expect(recordRow.getByText("F12", { exact: true })).toBeVisible();
});

test("shortcut rows expose actions, unassigned state, rebinding status, and all scopes", async ({ page }) => {
  await page.getByLabel("Keyboard profile").selectOption("pro_tools");
  await page.getByRole("button", { name: "Review shortcuts" }).click();

  const dialog = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  const search = dialog.getByLabel("Search keyboard shortcuts");
  await search.fill("Split Tool");
  const splitAction = dialog.getByRole("button", { name: "Split Tool", exact: true });
  await expect(splitAction).toBeVisible();
  const splitRow = splitAction.locator("..");
  await expect(splitRow.getByText("Unassigned", { exact: true })).toBeVisible();

  const rebind = splitRow.getByRole("button", { name: "Rebind Split Tool" });
  await rebind.focus();
  await expect(rebind).toBeFocused();
  await rebind.click();
  const captureStatus = dialog
    .getByRole("status")
    .filter({ hasText: "Press a key combination" });
  await expect(captureStatus).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(captureStatus).toHaveCount(0);

  await search.fill("Mute / Unmute Selected Tracks");
  const multiScopeRow = dialog
    .getByRole("button", { name: "Mute / Unmute Selected Tracks", exact: true })
    .locator("..");
  await expect(multiScopeRow.getByText("Track Control Panel, Mixer", { exact: true })).toBeVisible();
});

test("profile-specific selected-track commands advertise their Timeline scope", async ({ page }) => {
  await page.getByLabel("Keyboard profile").selectOption("garageband");
  await page.getByRole("button", { name: "Review shortcuts" }).click();

  const dialog = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await dialog.getByLabel("Search keyboard shortcuts").fill("Mute / Unmute Selected Tracks");
  const row = dialog
    .getByRole("button", { name: "Mute / Unmute Selected Tracks", exact: true })
    .locator("..");
  await expect(row.getByText("Track Control Panel, Mixer, Timeline", { exact: true })).toBeVisible();
  await expect(row.getByText("M", { exact: true })).toBeVisible();
});

test("selected mouse profile updates essential controls and help without reload", async ({ page }) => {
  await page.getByLabel("Mouse & scroll profile").selectOption("reaper");
  await page.getByRole("button", { name: "Use these profiles" }).click();

  const essentials = page.getByRole("complementary", { name: "Navigate the timeline quickly" });
  await expect(essentials).toContainText("REAPER mouse profile");
  await expect(essentials).toContainText("Scroll: zoom the timeline");
  await essentials.getByRole("button", { name: "Open Help" }).click();

  const help = page.getByRole("dialog", { name: "Help Reference" });
  await expect(help).toContainText("REAPER: Scroll zoom the timeline");
  await expect(help).toContainText("REAPER mouse");
  await expect(help.getByLabel("Search help topics")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
});

test("Preferences persists mouse profile and per-gesture override changes", async ({ page }) => {
  await page.getByRole("button", { name: "Use these profiles" }).click();
  await page.getByRole("menuitem", { name: "Options menu" }).click();
  await page.getByRole("menuitem", { name: /Preferences/ }).click();

  let dialog = page.getByRole("dialog", { name: "Preferences" });
  const generalTab = dialog.getByRole("tab", { name: "General" });
  await generalTab.focus();
  await generalTab.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Editing" })).toHaveAttribute("aria-selected", "true");

  await dialog.getByRole("tab", { name: "Mouse" }).click();
  await expect(dialog.getByRole("table", { name: /Mouse modifier actions/ })).toBeVisible();
  await expect(dialog.getByLabel("Clip Drag, Click action")).toBeVisible();
  await dialog.getByLabel("Mouse & scroll profile").selectOption("logic_pro");
  await dialog.getByLabel("Clip Drag, Click action").selectOption("copy");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.reload();
  await page.getByRole("menuitem", { name: "Options menu" }).click();
  await page.getByRole("menuitem", { name: /Preferences/ }).click();
  dialog = page.getByRole("dialog", { name: "Preferences" });
  await dialog.getByRole("tab", { name: "Mouse" }).click();
  await expect(dialog.getByLabel("Mouse & scroll profile")).toHaveValue("logic_pro");
  await expect(dialog.getByLabel("Clip Drag, Click action")).toHaveValue("copy");
  const persistedOverrides = await page.evaluate((storageKey) => (
    JSON.parse(localStorage.getItem(storageKey) ?? "{}")
  ), MOUSE_MODIFIER_OVERRIDES_KEY);
  expect(persistedOverrides).toMatchObject({
    schemaVersion: 1,
    overrides: { clip_drag: { none: "copy" } },
  });
});

test("selected profile updates shortcut hints outside the shortcut editor", async ({ page }) => {
  await page.getByLabel("Keyboard profile").selectOption("pro_tools");
  await page.getByRole("button", { name: "Use these profiles" }).click();

  await expect(page.getByTitle(`Toggle Mixer (${PRIMARY_LABEL}+=)`)).toBeVisible();
  await expect(page.getByTitle("Select Tool (Timeline: F7)")).toBeVisible();
});

test("profile commands respect active timeline context and disabled native collisions", async ({ page }) => {
  await page.getByLabel("Keyboard profile").selectOption("pro_tools");
  await page.getByRole("button", { name: "Use these profiles" }).click();

  const splitTool = page.getByRole("button", { name: "Split Tool" });
  const selectTool = page.getByRole("button", { name: "Select Tool" });
  await splitTool.click();
  await expect(splitTool).toHaveAttribute("aria-pressed", "true");

  await page.locator(".timeline-container").click({ position: { x: 300, y: 120 } });
  await page.keyboard.press("F6");
  await expect(splitTool).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("F7");
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");
});

test("real timeline wheel uses the selected REAPER modifier map", async ({ page }) => {
  await page.getByLabel("Mouse & scroll profile").selectOption("reaper");
  await page.getByRole("button", { name: "Use these profiles" }).click();
  await page.getByRole("button", { name: "Add new audio track" }).click();

  const trackHeader = page.locator('[data-track-id] [data-shortcut-context="track_control_panel"]').first();
  await expect(trackHeader).toBeVisible();
  const initialHeight = (await trackHeader.boundingBox())?.height ?? 0;
  expect(initialHeight).toBeGreaterThan(0);

  await page.locator(".timeline-container").dispatchEvent("wheel", {
    deltaY: -100,
    ctrlKey: !IS_MAC_HOST,
    metaKey: IS_MAC_HOST,
    bubbles: true,
    cancelable: true,
  });
  await expect.poll(async () => (await trackHeader.boundingBox())?.height ?? 0).toBeGreaterThan(initialHeight);
});

test("real mixer parameter controls own normal and fine wheel adjustment", async ({ page }) => {
  await page.getByRole("button", { name: "Use these profiles" }).click();
  const pan = page.getByRole("slider", { name: /Pan for/i }).first();
  await expect(pan).toBeVisible();
  const initial = Number(await pan.getAttribute("aria-valuenow"));

  await pan.dispatchEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
  await expect.poll(async () => Number(await pan.getAttribute("aria-valuenow"))).toBeGreaterThan(initial);
  const afterNormal = Number(await pan.getAttribute("aria-valuenow"));

  await pan.dispatchEvent("wheel", {
    deltaY: -100,
    shiftKey: true,
    cancelable: true,
    bubbles: true,
  });
  await expect.poll(async () => Number(await pan.getAttribute("aria-valuenow"))).toBeGreaterThan(afterNormal);
  const afterFine = Number(await pan.getAttribute("aria-valuenow"));
  expect(afterFine - afterNormal).toBeLessThan(afterNormal - initial);
});

test("named profiles keep multiple keys, platform unbinds, persistence, and export", async ({ page }) => {
  await page.getByRole("button", { name: "Review shortcuts" }).click();
  const dialog = page.getByRole("dialog", { name: "Keyboard Shortcuts" });

  const nameInput = dialog.getByLabel("Profile name", { exact: true });
  await nameInput.fill("Editing Keys");
  await dialog.getByRole("button", { name: "New", exact: true }).click();
  await expect(dialog.getByLabel("Keyboard profile").locator("option:checked"))
    .toHaveText("Custom - Editing Keys");

  await dialog.getByLabel("Search keyboard shortcuts").fill("Play / Pause");
  const playRow = dialog.getByRole("button", { name: "Play / Pause", exact: true }).locator("..");
  await playRow.getByRole("button", { name: "Rebind Play / Pause" }).click();
  await page.keyboard.press(`${PRIMARY_KEY}+Shift+F10`);
  await expect(playRow.getByText(`${PRIMARY_LABEL}+Shift+F10`, { exact: true })).toBeVisible();

  await playRow.getByRole("button", { name: "Rebind Play / Pause" }).click();
  await page.keyboard.press(`${PRIMARY_KEY}+Shift+F11`);
  await expect(playRow.getByText(`${PRIMARY_LABEL}+Shift+F11`, { exact: true })).toBeVisible();

  await dialog.getByLabel("Edit overrides for").selectOption(HOST_OVERRIDE_TARGET);
  await playRow.getByRole("button", { name: "Disable" }).click();
  await expect(playRow.getByText("Disabled here", { exact: true })).toBeVisible();
  await expect(playRow.getByText("Unassigned (custom)", { exact: true })).toBeVisible();

  const persisted = await page.evaluate((storageKey) => (
    JSON.parse(localStorage.getItem(storageKey) ?? "{}")
  ), CUSTOM_KEYBOARD_PROFILES_KEY);
  expect(persisted).toMatchObject({
    schemaVersion: 2,
    profiles: [{
      name: "Editing Keys",
      bindings: {
        "transport.play": {
          common: ["Ctrl+Shift+F10", "Ctrl+Shift+F11"],
          [HOST_OVERRIDE_TARGET]: [],
        },
      },
    }],
  });

  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Editing-Keys.json");

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await page.getByRole("menuitem", { name: "Help menu" }).click();
  await page.getByRole("menuitem", { name: "Keyboard Shortcuts" }).click();
  const reopened = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(reopened.getByLabel("Keyboard profile").locator("option:checked"))
    .toHaveText("Custom - Editing Keys");
});

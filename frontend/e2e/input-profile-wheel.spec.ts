import { expect, test, type Page } from "@playwright/test";

interface SyntheticWheelOptions {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
}

async function dispatchRawWheel(
  page: Page,
  targetId: string,
  options: SyntheticWheelOptions,
): Promise<{ dispatchReturned: boolean; defaultPrevented: boolean }> {
  return page.evaluate(
    ({ id, init }) => window.dispatchHarnessWheel(id, init),
    { id: targetId, init: options },
  );
}

async function dispatchResolvedWheel(
  page: Page,
  targetId: string,
  options: SyntheticWheelOptions,
): Promise<{
  dispatch: { dispatchReturned: boolean; defaultPrevented: boolean };
  resolved: Record<string, unknown>;
}> {
  return page.evaluate(({ id, init }) => {
    const dispatch = window.dispatchHarnessWheel(id, init);
    const raw = document.getElementById(id)?.dataset.lastWheelResult;
    if (!raw) throw new Error(`No wheel result for ${id}`);
    return { dispatch, resolved: JSON.parse(raw) as Record<string, unknown> };
  }, { id: targetId, init: options });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/shortcut-e2e.html");
  await expect(page.getByRole("heading", { name: "Shortcut and wheel test harness" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Timeline nested profiled range" })).toBeVisible();
});

test("nested profiled controls own plain, fine, and suppressed wheel gestures", async ({ page }) => {
  await page.getByLabel("Mouse profile").selectOption("cubase");
  const timelineValue = page.getByLabel("Timeline nested profiled range value");
  const pianoValue = page.getByLabel("Piano roll nested profiled range value");

  await dispatchRawWheel(page, "timeline-profiled-range", { deltaY: -100 });
  await expect(timelineValue).toHaveText("0.600");

  await dispatchRawWheel(page, "timeline-profiled-range", {
    deltaY: -100,
    shiftKey: true,
  });
  await expect(timelineValue).toHaveText("0.610");

  await dispatchRawWheel(page, "timeline-profiled-range", {
    deltaY: -100,
    altKey: true,
  });
  await expect(timelineValue).toHaveText("0.610");

  await dispatchRawWheel(page, "piano-profiled-range", { deltaY: -100 });
  await expect(pianoValue).toHaveText("0.600");
  await expect(page.getByLabel("Viewport wheel hit counts")).toHaveText(
    '{"timeline":0,"piano_roll":0}',
  );
});

test("high-resolution packets accumulate before one profiled edit burst", async ({ page }) => {
  await page.getByLabel("Mouse profile").selectOption("cubase");
  const value = page.getByLabel("Timeline nested profiled range value");
  const begins = page.getByLabel("Timeline nested profiled range begin count");
  const commits = page.getByLabel("Timeline nested profiled range commit count");

  for (let packet = 0; packet < 3; packet += 1) {
    await dispatchRawWheel(page, "timeline-profiled-range", { deltaY: -0.25 });
    await expect(value).toHaveText("0.500");
    await expect(begins).toHaveText("0");
  }

  await dispatchRawWheel(page, "timeline-profiled-range", { deltaY: -0.25 });
  await expect(value).toHaveText("0.501");
  await expect(begins).toHaveText("1");
  await expect.poll(async () => commits.textContent()).toBe("1");
  await expect(page.getByLabel("Viewport wheel hit counts")).toHaveText(
    '{"timeline":0,"piano_roll":0}',
  );
});

test("macOS physical Control and Command are both blocked by the raw browser guard", async ({ page }) => {
  await page.getByLabel("Wheel platform").selectOption("macos");

  const physicalControl = await dispatchResolvedWheel(page, "wheel-browser", {
    deltaY: 12,
    ctrlKey: true,
  });
  expect(physicalControl.resolved).toMatchObject({
    ruleId: "browser.native-scroll",
    eventDefaultPrevented: true,
  });
  expect(physicalControl.dispatch).toEqual({ dispatchReturned: false, defaultPrevented: true });

  const command = await dispatchResolvedWheel(page, "wheel-browser", {
    deltaY: 12,
    metaKey: true,
  });
  expect(command.resolved).toMatchObject({
    ruleId: "browser.suppress-browser-zoom",
    eventDefaultPrevented: true,
  });
  expect(command.dispatch).toEqual({ dispatchReturned: false, defaultPrevented: true });

  const both = await dispatchResolvedWheel(page, "wheel-browser", {
    deltaY: 12,
    ctrlKey: true,
    metaKey: true,
  });
  expect(both.resolved).toMatchObject({
    ruleId: "browser.suppress-browser-zoom",
    eventDefaultPrevented: true,
  });
  expect(both.dispatch).toEqual({ dispatchReturned: false, defaultPrevented: true });
});

test("exact DAW editor subtargets preserve their target and anchor", async ({ page }) => {
  await page.getByLabel("Mouse profile").selectOption("pro_tools");
  await page.getByLabel("Wheel platform").selectOption("macos");
  const piano = await dispatchResolvedWheel(page, "wheel-piano", {
    deltaY: -8,
    ctrlKey: true,
    altKey: true,
    clientX: 141,
    clientY: 73,
  });
  expect(piano.resolved).toMatchObject({
    profileId: "pro_tools",
    ruleId: "pro-tools.midi-note-height",
    operation: "zoom",
    target: "midi-note-height",
    anchor: {
      kind: "pointer",
      clientX: 141,
      clientY: 73,
      targetId: "wheel-piano",
    },
  });

  await page.getByLabel("Mouse profile").selectOption("audacity");
  await page.getByLabel("Wheel platform").selectOption("windows");
  const waveformScale = await dispatchResolvedWheel(page, "wheel-waveform-scale", {
    deltaY: 7,
    ctrlKey: true,
    clientX: 52,
    clientY: 118,
  });
  expect(waveformScale.resolved).toMatchObject({
    profileId: "audacity",
    ruleId: "audacity.waveform-scale-zoom",
    operation: "zoom",
    target: "waveform-scale",
    anchor: {
      kind: "hovered-track",
      clientX: 52,
      clientY: 118,
      targetId: "track-e2e",
    },
  });
});

test("browser-integrated detached snapshots validate before updating the live mouse profile", async ({ page }) => {
  const invalid = await page.evaluate(() => window.applyHarnessInputProfileSnapshot({
    keyboardShortcutProfileId: "reaper",
    mouseBehaviorProfileId: "not-a-profile",
    customKeyboardProfiles: [],
    activeCustomKeyboardProfileId: null,
    customShortcuts: {},
  }));
  expect(invalid).toEqual({
    applied: false,
    keyboardShortcutProfileId: "openstudio",
    mouseBehaviorProfileId: "openstudio",
  });

  const applied = await page.evaluate(() => window.applyHarnessInputProfileSnapshot({
    keyboardShortcutProfileId: "reaper",
    mouseBehaviorProfileId: "cubase",
    customKeyboardProfiles: [],
    activeCustomKeyboardProfileId: null,
    customShortcuts: {},
  }));
  expect(applied).toEqual({
    applied: true,
    keyboardShortcutProfileId: "reaper",
    mouseBehaviorProfileId: "cubase",
  });
  await expect(page.getByLabel("Mouse profile")).toHaveValue("cubase");
  await expect(page.getByLabel("Profile snapshot result")).toContainText('"applied":true');

  await dispatchRawWheel(page, "timeline-profiled-range", {
    deltaY: -100,
    altKey: true,
  });
  await expect(page.getByLabel("Timeline nested profiled range value")).toHaveText("0.500");
});

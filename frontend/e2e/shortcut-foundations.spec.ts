import { expect, test, type Page } from "@playwright/test";

const PRIMARY_KEY = process.platform === "darwin" ? "Meta" : "Control";

interface SyntheticKeyOptions {
  key: string;
  code?: string;
  location?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

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

async function dispatchKey(
  page: Page,
  targetId: string,
  options: SyntheticKeyOptions,
): Promise<{ dispatchReturned: boolean; defaultPrevented: boolean }> {
  return page.evaluate(
    ({ id, init }) => window.dispatchHarnessKey(id, init),
    { id: targetId, init: options },
  );
}

async function dispatchWheel(
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
});

test("text inputs retain editing shortcuts and ordinary typing", async ({ page }) => {
  const input = page.getByRole("textbox", { name: "Text input" });
  await input.focus();
  await page.keyboard.press(`${PRIMARY_KEY}+a`);

  await expect.poll(() => input.evaluate((node) => ({
    start: (node as HTMLInputElement).selectionStart,
    end: (node as HTMLInputElement).selectionEnd,
    length: (node as HTMLInputElement).value.length,
  }))).toEqual({ start: 0, end: 16, length: 16 });
  await expect(page.getByLabel("Last shortcut result")).toContainText('"handled":false');

  await page.keyboard.type("replacement");
  await expect(input).toHaveValue("replacement");
  await expect(page.getByLabel("Context hit counts")).toHaveText(
    '{"timeline":0,"piano_roll":0,"pitch_editor":0}',
  );
});

test("transport Space is reserved while sliders keep native arrow behavior", async ({ page }) => {
  const button = page.getByRole("button", { name: "Native button" });
  await button.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#button-click-count")).toHaveText("0");
  await expect(page.getByLabel("Last shortcut result")).toContainText('"owner":"registry"');
  await expect(page.getByLabel("Last shortcut result")).toContainText('"actionId":"transport.play"');

  const slider = page.getByRole("slider", { name: "Native range" });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("6");
  await expect(page.getByLabel("Context hit counts")).toHaveText(
    '{"timeline":0,"piano_roll":0,"pitch_editor":0}',
  );
});

test("the most recently focused editor context owns the same shortcut", async ({ page }) => {
  await page.getByLabel("Active shortcut binding").selectOption("X");

  const cases = [
    { label: "Timeline surface", context: "timeline", counts: { timeline: 1, piano_roll: 0, pitch_editor: 0 } },
    { label: "Piano roll surface", context: "piano_roll:e2e-piano", counts: { timeline: 1, piano_roll: 1, pitch_editor: 0 } },
    { label: "Pitch editor surface", context: "pitch_editor", counts: { timeline: 1, piano_roll: 1, pitch_editor: 1 } },
    { label: "Timeline surface", context: "timeline", counts: { timeline: 2, piano_roll: 1, pitch_editor: 1 } },
  ] as const;

  for (const entry of cases) {
    await page.getByRole("region", { name: entry.label }).focus();
    await expect(page.getByLabel("Active context")).toHaveText(entry.context);
    await page.keyboard.press("x");
    await expect(page.getByLabel("Context hit counts")).toHaveText(JSON.stringify(entry.counts));
  }
});

test("Windows Control bindings work through the shared dispatcher", async ({ page }) => {
  await page.getByLabel("Keyboard platform").selectOption("windows");
  await page.getByLabel("Active shortcut binding").selectOption("Ctrl+X");
  await page.getByRole("region", { name: "Timeline surface" }).focus();

  await page.keyboard.press("Control+x");

  await expect(page.getByLabel("Last shortcut result")).toContainText('"owner":"timeline"');
  await expect(page.getByLabel("Last shortcut result")).toContainText('"platform":"windows"');
  await expect(page.getByLabel("Context hit counts")).toContainText('"timeline":1');
});

test("simulated macOS Command, Option, and physical Control stay distinct", async ({ page }) => {
  await page.getByLabel("Keyboard platform").selectOption("macos");

  const cases = [
    {
      binding: "Command+X",
      event: { key: "x", code: "KeyX", metaKey: true },
    },
    {
      binding: "Option+Code:KeyX",
      event: { key: "≈", code: "KeyX", altKey: true },
    },
    {
      binding: "Control+X",
      event: { key: "x", code: "KeyX", ctrlKey: true },
    },
  ] as const;

  for (const entry of cases) {
    await page.getByLabel("Active shortcut binding").selectOption(entry.binding);
    const dispatched = await dispatchKey(page, "pitch-surface", entry.event);
    expect(dispatched).toEqual({ dispatchReturned: false, defaultPrevented: true });
  }

  await expect(page.getByLabel("Context hit counts")).toHaveText(
    '{"timeline":0,"piano_roll":0,"pitch_editor":3}',
  );
});

test("the host operating system emits its native primary and secondary modifiers", async ({ page }) => {
  const isMacHost = process.platform === "darwin";
  await page.getByLabel("Keyboard platform").selectOption(isMacHost ? "macos" : "windows");
  await page.getByRole("region", { name: "Timeline surface" }).focus();

  await page.getByLabel("Active shortcut binding").selectOption(
    isMacHost ? "Command+X" : "Ctrl+X",
  );
  await page.keyboard.press(isMacHost ? "Meta+x" : "Control+x");
  await expect(page.getByLabel("Context hit counts")).toContainText('"timeline":1');

  if (isMacHost) {
    await page.getByLabel("Active shortcut binding").selectOption("Option+Code:KeyX");
    await page.keyboard.press("Alt+x");
    await page.getByLabel("Active shortcut binding").selectOption("Control+X");
    await page.keyboard.press("Control+x");
    await expect(page.getByLabel("Context hit counts")).toContainText('"timeline":3');
  }
});

test("physical key-position and numpad bindings do not collapse to labels", async ({ page }) => {
  await page.getByLabel("Keyboard platform").selectOption("windows");
  await page.getByLabel("Active shortcut binding").selectOption("Control+Code:KeyZ");

  const physical = await dispatchKey(page, "piano-surface", {
    key: "y",
    code: "KeyZ",
    ctrlKey: true,
  });
  expect(physical.defaultPrevented).toBe(true);
  await expect(page.getByLabel("Context hit counts")).toContainText('"piano_roll":1');

  await page.getByLabel("Active shortcut binding").selectOption("Numpad1");
  const topRow = await dispatchKey(page, "piano-surface", {
    key: "1",
    code: "Digit1",
    location: 0,
  });
  expect(topRow.defaultPrevented).toBe(false);
  await expect(page.getByLabel("Context hit counts")).toContainText('"piano_roll":1');

  const numpad = await dispatchKey(page, "piano-surface", {
    key: "1",
    code: "Numpad1",
    location: 3,
  });
  expect(numpad).toEqual({ dispatchReturned: false, defaultPrevented: true });
  await expect(page.getByLabel("Context hit counts")).toContainText('"piano_roll":2');
});

test("timeline wheel precedence covers Windows modifier combinations", async ({ page }) => {
  await page.getByLabel("Wheel platform").selectOption("windows");
  const cases = [
    { init: { deltaY: 10 }, rule: "timeline.native-scroll", prevented: false },
    { init: { deltaY: 10, ctrlKey: true }, rule: "timeline.horizontal-zoom", prevented: true },
    { init: { deltaY: 10, ctrlKey: true, shiftKey: true }, rule: "timeline.waveform-amplitude", prevented: true },
    { init: { deltaY: 10, altKey: true }, rule: "timeline.track-height", prevented: true },
    { init: { deltaY: 10, shiftKey: true }, rule: "timeline.horizontal-scroll", prevented: true },
    { init: { deltaY: 10, ctrlKey: true, altKey: true }, rule: "timeline.horizontal-zoom", prevented: true },
    { init: { deltaY: 10, ctrlKey: true, altKey: true, shiftKey: true }, rule: "timeline.waveform-amplitude", prevented: true },
    { init: { deltaY: 10, metaKey: true }, rule: "timeline.native-scroll", prevented: false },
  ] as const;

  for (const entry of cases) {
    const { dispatch, resolved } = await dispatchWheel(page, "wheel-timeline", entry.init);
    expect(resolved.ruleId).toBe(entry.rule);
    expect(resolved.eventDefaultPrevented).toBe(entry.prevented);
    expect(dispatch.defaultPrevented).toBe(entry.prevented);
    expect(dispatch.dispatchReturned).toBe(!entry.prevented);
  }
});

test("timeline wheel precedence maps macOS Command, Option, and Control", async ({ page }) => {
  await page.getByLabel("Wheel platform").selectOption("macos");
  const cases = [
    { init: { deltaY: 6, metaKey: true }, rule: "timeline.horizontal-zoom", prevented: true },
    { init: { deltaY: 6, metaKey: true, shiftKey: true }, rule: "timeline.waveform-amplitude", prevented: true },
    { init: { deltaY: 6, altKey: true }, rule: "timeline.track-height", prevented: true },
    { init: { deltaY: 6, ctrlKey: true }, rule: "timeline.native-scroll", prevented: false },
    { init: { deltaY: 6, shiftKey: true }, rule: "timeline.horizontal-scroll", prevented: true },
    { init: { deltaY: 6, metaKey: true, altKey: true }, rule: "timeline.horizontal-zoom", prevented: true },
    { init: { deltaY: 6, metaKey: true, ctrlKey: true }, rule: "timeline.horizontal-zoom", prevented: true },
  ] as const;

  for (const entry of cases) {
    const { dispatch, resolved } = await dispatchWheel(page, "wheel-timeline", entry.init);
    expect(resolved.ruleId).toBe(entry.rule);
    expect(dispatch.defaultPrevented).toBe(entry.prevented);
  }
});

test("wheel deltas normalize line/page units and preserve native browser scrolling", async ({ page }) => {
  await page.getByLabel("Wheel platform").selectOption("windows");

  const lineZoom = await dispatchWheel(page, "wheel-timeline", {
    deltaY: 2,
    deltaMode: 1,
    ctrlKey: true,
    clientX: 123,
    clientY: 45,
  });
  expect(lineZoom.resolved.ruleId).toBe("timeline.horizontal-zoom");
  expect(lineZoom.resolved.amount).toBe(32);
  expect(lineZoom.resolved.anchor).toEqual({
    kind: "pointer",
    clientX: 123,
    clientY: 45,
    targetId: "wheel-timeline",
  });

  const pageScroll = await dispatchWheel(page, "wheel-piano", {
    deltaY: 1,
    deltaMode: 2,
  });
  expect(pageScroll.resolved.ruleId).toBe("piano-roll.dominant-axis-scroll");
  expect(pageScroll.resolved.amount).toBe(800);
  expect(pageScroll.resolved.delta).toMatchObject({ y: 800, mode: "page" });
  expect(pageScroll.dispatch.defaultPrevented).toBe(true);

  const nativeBrowser = await dispatchWheel(page, "wheel-browser", { deltaY: 25 });
  expect(nativeBrowser.resolved.ruleId).toBe("browser.native-scroll");
  expect(nativeBrowser.dispatch).toEqual({ dispatchReturned: true, defaultPrevented: false });

  const protectedBrowser = await dispatchWheel(page, "wheel-browser", {
    deltaY: 25,
    ctrlKey: true,
  });
  expect(protectedBrowser.resolved.ruleId).toBe("browser.suppress-browser-zoom");
  expect(protectedBrowser.dispatch).toEqual({ dispatchReturned: false, defaultPrevented: true });
});

test("parameter wheel owns normal and fine adjustment gestures", async ({ page }) => {
  const normal = await dispatchWheel(page, "wheel-parameter", { deltaY: -8 });
  expect(normal.resolved).toMatchObject({
    ruleId: "parameter.adjust",
    operation: "adjust",
    precision: "normal",
    eventDefaultPrevented: true,
  });

  const fine = await dispatchWheel(page, "wheel-parameter", {
    deltaY: -8,
    shiftKey: true,
  });
  expect(fine.resolved).toMatchObject({
    ruleId: "parameter.fine-adjust",
    operation: "adjust",
    precision: "fine",
    eventDefaultPrevented: true,
  });
  expect(fine.dispatch).toEqual({ dispatchReturned: false, defaultPrevented: true });
});

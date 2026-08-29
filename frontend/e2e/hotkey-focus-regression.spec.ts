import { expect, test, type Page } from "@playwright/test";

async function setShortcutState(
  page: Page,
  options: {
    customPlay?: string;
    playing?: boolean;
    recording?: boolean;
  },
) {
  await page.evaluate(async (next) => {
    const { useDAWStore } = await import("/src/store/useDAWStore.ts");
    const current = useDAWStore.getState();
    useDAWStore.setState({
      customShortcuts: next.customPlay === undefined
        ? {}
        : {
          "transport.play": {
            common: next.customPlay ? [next.customPlay] : [],
          },
        },
      transport: {
        ...current.transport,
        isPlaying: Boolean(next.playing || next.recording),
        isPaused: false,
        isRecording: Boolean(next.recording),
      },
      recordSession: next.recording
        ? { id: "e2e-focus-recording", startTime: 0, trackIds: [] }
        : null,
    });
  }, options);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/shortcut-e2e.html");
  await expect(page.getByRole("heading", { name: "Shortcut and wheel test harness" }))
    .toBeVisible();
  await page.getByLabel("Active shortcut binding").selectOption("");
});

test("window reactivation cannot leave a button owning transport Space", async ({ page, context }) => {
  const button = page.getByRole("button", { name: "Native button" });
  await button.focus();

  const otherPage = await context.newPage();
  await otherPage.goto("about:blank");
  await otherPage.bringToFront();
  await page.bringToFront();

  await expect.poll(() => page.evaluate(() => ({
    id: (document.activeElement as HTMLElement | null)?.id ?? "",
    focused: document.hasFocus(),
  }))).toEqual({ id: "native-button", focused: true });

  // Headless Chromium can report document focus one task before its keyboard
  // target settles after a page switch. Reasserting the foreground page keeps
  // this test about retained DOM focus instead of a CDP activation race.
  await page.bringToFront();
  await page.keyboard.press("Space");

  await expect(page.locator("#button-click-count")).toHaveText("0");
  await expect(page.getByLabel("Last shortcut result")).toContainText('"owner":"registry"');
  await expect(page.getByLabel("Last shortcut result")).toContainText('"actionId":"transport.play"');
  await otherPage.close();
});

test("focused slider yields active-profile Space to transport", async ({ page }) => {
  const slider = page.getByRole("slider", { name: "Native range" });
  await slider.focus();
  await page.keyboard.press("Space");

  await expect(slider).toHaveValue("5");
  await expect(page.getByLabel("Last shortcut result")).toContainText('"actionId":"transport.play"');
});

test("held Space is consumed but invokes transport exactly once", async ({ page }) => {
  await page.evaluate(async () => {
    const { useDAWStore } = await import("/src/store/useDAWStore.ts");
    const pageGlobal = window as Window & { __hotkeyPlayCalls: number };
    pageGlobal.__hotkeyPlayCalls = 0;
    useDAWStore.setState({
      play: async () => {
        pageGlobal.__hotkeyPlayCalls += 1;
      },
    });
  });
  await page.getByRole("button", { name: "Native button" }).focus();

  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");

  await expect.poll(() => page.evaluate(() => (
    window as Window & { __hotkeyPlayCalls: number }
  ).__hotkeyPlayCalls)).toBe(1);
  await expect(page.locator("#button-click-count")).toHaveText("0");
});

test("explicitly unbound Play returns Space to the focused button", async ({ page }) => {
  await setShortcutState(page, { customPlay: "" });
  const button = page.getByRole("button", { name: "Native button" });
  await button.focus();
  await page.keyboard.press("Space");

  await expect(page.locator("#button-click-count")).toHaveText("1");
  await expect(page.getByLabel("Last shortcut result")).toContainText('"owner":"native"');
});

test("remapped Play works from a focused button without reserving Space", async ({ page }) => {
  await setShortcutState(page, { customPlay: "P" });
  const button = page.getByRole("button", { name: "Native button" });
  await button.focus();

  await page.keyboard.press("p");
  await expect(page.locator("#button-click-count")).toHaveText("0");
  await expect(page.getByLabel("Last shortcut result")).toContainText('"actionId":"transport.play"');

  await page.keyboard.press("Space");
  await expect(page.locator("#button-click-count")).toHaveText("1");
  await expect(page.getByLabel("Last shortcut result")).toContainText('"owner":"native"');
});

test("editable Space types while stopped and stops active transport", async ({ page }) => {
  const input = page.getByRole("textbox", { name: "Text input" });
  await input.focus();
  await input.evaluate((element) => {
    const textInput = element as HTMLInputElement;
    textInput.setSelectionRange(textInput.value.length, textInput.value.length);
  });
  await page.keyboard.press("Space");
  await expect(input).toHaveValue("select this text ");
  await expect(page.getByLabel("Last shortcut result")).toContainText('"owner":"native"');

  await setShortcutState(page, { playing: true });
  await input.focus();
  await input.evaluate((element) => {
    const textInput = element as HTMLInputElement;
    textInput.setSelectionRange(textInput.value.length, textInput.value.length);
  });
  await page.keyboard.press("Space");

  await expect(input).toHaveValue("select this text ");
  await expect(page.getByLabel("Last shortcut result")).toContainText('"actionId":"transport.play"');
});

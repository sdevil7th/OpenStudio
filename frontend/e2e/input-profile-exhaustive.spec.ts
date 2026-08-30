import { expect, test, type Page } from "@playwright/test";

type ProfileId =
  | "openstudio"
  | "pro_tools"
  | "cubase"
  | "reaper"
  | "audacity"
  | "logic_pro"
  | "fl_studio"
  | "ableton_live"
  | "studio_one"
  | "bitwig_studio"
  | "reason"
  | "cakewalk_sonar"
  | "garageband"
  | "digital_performer"
  | "ardour"
  | "adobe_audition"
  | "mixcraft"
  | "waveform"
  | "renoise";

interface KeyInit {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface WheelInit {
  deltaY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface ProfileRuntimeCase {
  id: ProfileId;
  platform: "macos" | "windows";
  keyboard: {
    target: "application-surface" | "timeline-surface" | "piano-surface";
    actionId: string | null;
    event: KeyInit;
  };
  wheel: {
    target: string;
    ruleId: string | null;
    event: WheelInit;
  };
  pointer: {
    action: string;
    event: Omit<KeyInit, "key" | "code">;
  };
}

const cases: readonly ProfileRuntimeCase[] = [
  {
    id: "openstudio",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "m", code: "KeyM", ctrlKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "timeline.horizontal-zoom", event: { deltaY: -120, ctrlKey: true } },
    pointer: { action: "bypass_snap", event: { altKey: true } },
  },
  {
    id: "pro_tools",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "=", code: "Equal", ctrlKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "pro-tools.option-horizontal-zoom", event: { deltaY: -120, altKey: true } },
    pointer: { action: "copy", event: { altKey: true } },
  },
  {
    id: "cubase",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "F3", code: "F3" } },
    wheel: { target: "wheel-timeline", ruleId: "cubase.horizontal-zoom", event: { deltaY: -120, ctrlKey: true } },
    pointer: { action: "copy", event: { altKey: true } },
  },
  {
    id: "reaper",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "m", code: "KeyM", ctrlKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "reaper.horizontal-zoom", event: { deltaY: -120 } },
    pointer: { action: "copy", event: { ctrlKey: true } },
  },
  {
    id: "audacity",
    platform: "windows",
    keyboard: { target: "timeline-surface", actionId: "view.zoomIn", event: { key: "1", code: "Digit1", ctrlKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "audacity.horizontal-zoom", event: { deltaY: -120, ctrlKey: true } },
    pointer: { action: "none", event: { altKey: true } },
  },
  {
    id: "logic_pro",
    platform: "macos",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "x", code: "KeyX" } },
    wheel: { target: "wheel-timeline", ruleId: "logic-pro.control-option-horizontal-zoom", event: { deltaY: -120, ctrlKey: true, altKey: true } },
    pointer: { action: "copy", event: { altKey: true } },
  },
  {
    id: "fl_studio",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "F9", code: "F9" } },
    wheel: { target: "wheel-track", ruleId: "fl-studio.playlist-track-reorder", event: { deltaY: -120, shiftKey: true } },
    pointer: { action: "none", event: { altKey: true } },
  },
  {
    id: "ableton_live",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "m", code: "KeyM", ctrlKey: true, altKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "ableton-live.horizontal-zoom", event: { deltaY: -120, ctrlKey: true } },
    pointer: { action: "copy", event: { ctrlKey: true } },
  },
  {
    id: "studio_one",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "F3", code: "F3" } },
    wheel: { target: "wheel-timeline", ruleId: "studio-one.horizontal-zoom", event: { deltaY: -120, ctrlKey: true, shiftKey: true } },
    pointer: { action: "copy", event: { altKey: true } },
  },
  {
    id: "bitwig_studio",
    platform: "windows",
    keyboard: { target: "timeline-surface", actionId: "view.zoomIn", event: { key: "=", code: "Equal", ctrlKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "bitwig-studio.control-alt-horizontal-zoom", event: { deltaY: -120, ctrlKey: true, altKey: true } },
    pointer: { action: "none", event: { altKey: true } },
  },
  {
    id: "reason",
    platform: "windows",
    keyboard: { target: "timeline-surface", actionId: "view.zoomIn", event: { key: "h", code: "KeyH" } },
    wheel: { target: "wheel-timeline", ruleId: "reason.horizontal-zoom", event: { deltaY: -120, ctrlKey: true } },
    pointer: { action: "copy", event: { ctrlKey: true } },
  },
  {
    id: "cakewalk_sonar",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleMixer", event: { key: "2", code: "Digit2", altKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "cakewalk-sonar.alt-horizontal-zoom", event: { deltaY: -120, altKey: true } },
    pointer: { action: "none", event: { altKey: true } },
  },
  {
    id: "garageband",
    platform: "macos",
    keyboard: { target: "application-surface", actionId: "view.toggleMasterTrackTCP", event: { key: "m", code: "KeyM", metaKey: true, shiftKey: true } },
    wheel: { target: "wheel-timeline", ruleId: null, event: { deltaY: -120 } },
    pointer: { action: "none", event: { altKey: true } },
  },
  {
    id: "digital_performer",
    platform: "macos",
    // DP's official command system is user-assignable and does not publish a
    // stable default table for this profile. Strict mode must not leak the
    // OpenStudio Command+M mixer binding into it.
    keyboard: { target: "application-surface", actionId: null, event: { key: "m", code: "KeyM", metaKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "digital-performer.option-horizontal-zoom", event: { deltaY: -120, altKey: true } },
    pointer: { action: "none", event: { altKey: true } },
  },
  {
    id: "ardour",
    platform: "windows",
    keyboard: { target: "timeline-surface", actionId: "view.zoomToSelection", event: { key: "z", code: "KeyZ" } },
    wheel: { target: "wheel-timeline", ruleId: "ardour.horizontal-zoom", event: { deltaY: -120, ctrlKey: true } },
    pointer: { action: "none", event: { altKey: true } },
  },
  {
    id: "adobe_audition",
    platform: "windows",
    keyboard: { target: "timeline-surface", actionId: "view.zoomIn", event: { key: "=", code: "Equal" } },
    wheel: { target: "wheel-ruler", ruleId: "adobe-audition.ruler-horizontal-zoom", event: { deltaY: -120 } },
    pointer: { action: "copy", event: { altKey: true } },
  },
  {
    id: "mixcraft",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "view.toggleVirtualKeyboard", event: { key: "k", code: "KeyK", ctrlKey: true, altKey: true } },
    wheel: { target: "wheel-timeline", ruleId: "mixcraft.horizontal-zoom", event: { deltaY: -120 } },
    pointer: { action: "copy", event: { altKey: true } },
  },
  {
    id: "waveform",
    platform: "windows",
    keyboard: { target: "timeline-surface", actionId: "view.zoomToFit", event: { key: "F8", code: "F8" } },
    wheel: { target: "wheel-timeline", ruleId: "waveform.horizontal-zoom", event: { deltaY: -120 } },
    pointer: { action: "none", event: { altKey: true } },
  },
  {
    id: "renoise",
    platform: "windows",
    keyboard: { target: "application-surface", actionId: "transport.play", event: { key: " ", code: "Space" } },
    wheel: { target: "wheel-timeline", ruleId: null, event: { deltaY: -120 } },
    pointer: { action: "none", event: { altKey: true } },
  },
] as const;

async function readJsonOutput(page: Page, label: string): Promise<Record<string, unknown>> {
  const raw = await page.getByLabel(label).textContent();
  if (!raw) throw new Error(`No JSON in ${label}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

for (const entry of cases) {
  test(`${entry.id} dispatches its documented key policy, wheel, and pointer event`, async ({ page }) => {
    await page.goto("/shortcut-e2e.html");
    await expect(page.getByRole("heading", { name: "Shortcut and wheel test harness" })).toBeVisible();
    await page.getByLabel("Active shortcut binding").selectOption("");
    await page.getByLabel("Keyboard platform").selectOption(entry.platform);
    await page.getByLabel("Wheel platform").selectOption(entry.platform);
    await page.getByLabel("Harness keyboard profile").selectOption(entry.id);
    await page.getByLabel("Mouse profile").selectOption(entry.id);

    await page.evaluate(({ target, event }) => {
      window.dispatchHarnessKey(target, event);
    }, { target: entry.keyboard.target, event: entry.keyboard.event });
    if (entry.keyboard.actionId === null) {
      await expect.poll(async () => (
        (await readJsonOutput(page, "Last shortcut result")).handled
      )).toBe(false);
      expect(await readJsonOutput(page, "Last shortcut result")).toMatchObject({
        handled: false,
      });
    } else {
      await expect.poll(async () => (
        (await readJsonOutput(page, "Last shortcut result")).actionId
      )).toBe(entry.keyboard.actionId);
      expect(await readJsonOutput(page, "Last shortcut result")).toMatchObject({
        handled: true,
        owner: "registry",
        actionId: entry.keyboard.actionId,
        platform: entry.platform,
      });
    }

    const wheelDispatch = await page.evaluate(({ target, event }) => {
      const dispatch = window.dispatchHarnessWheel(target, event);
      const raw = document.getElementById(target)?.dataset.lastWheelResult;
      if (!raw) throw new Error(`No wheel result for ${target}`);
      return { dispatch, resolved: JSON.parse(raw) as Record<string, unknown> };
    }, { target: entry.wheel.target, event: entry.wheel.event });
    expect(wheelDispatch.resolved).toMatchObject({
      profileId: entry.id,
      ruleId: entry.wheel.ruleId,
      matched: entry.wheel.ruleId !== null,
      preventDefault: entry.wheel.ruleId !== null,
    });
    expect(wheelDispatch.dispatch.defaultPrevented).toBe(entry.wheel.ruleId !== null);

    const pointerDispatch = await page.evaluate((event) => {
      const dispatch = window.dispatchHarnessPointer("pointer-clip-drag", event);
      const raw = document.getElementById("pointer-clip-drag")?.dataset.lastPointerResult;
      if (!raw) throw new Error("No pointer result");
      return { dispatch, resolved: JSON.parse(raw) as Record<string, unknown> };
    }, entry.pointer.event);
    expect(pointerDispatch.resolved).toMatchObject({
      profileId: entry.id,
      context: "clip_drag",
      action: entry.pointer.action,
      source: "profile",
    });
    expect(pointerDispatch.dispatch.defaultPrevented).toBe(entry.pointer.action !== "none");
  });
}

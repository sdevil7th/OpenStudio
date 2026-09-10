import { afterEach, describe, expect, it, vi } from "vitest";
import { appDialogs, finishAppDialog, getAppDialog } from "../services/appDialogs";
import { advanceProjectEpoch } from "../utils/projectLifetime";
import { allocatePanelHeights, PANEL_MIN_HEIGHT, TIMELINE_MIN_HEIGHT } from "../utils/panelLayout";
import { resolveWheelGesture } from "../utils/wheelGestureResolver";
import { getMouseBehaviorProfile } from "../utils/mouseBehaviorProfiles";
import { installBrowserZoomWheelGuard } from "../utils/browserWheelGuard";

afterEach(() => { while (getAppDialog()) finishAppDialog(getAppDialog()!.id, null); });

describe("app-owned dialogs", () => {
  it("queues prompts, ignores stale replies, and distinguishes cancel from an empty value", async () => {
    const first = appDialogs.prompt("Snapshot name", "Mix 1");
    const firstId = getAppDialog()!.id;
    const second = appDialogs.confirm("Delete snapshot?");
    expect(getAppDialog()?.initialValue).toBe("Mix 1");
    finishAppDialog(firstId, "");
    await expect(first).resolves.toBe("");
    const secondId = getAppDialog()!.id;
    finishAppDialog(firstId, "old reply");
    expect(getAppDialog()?.id).toBe(secondId);
    finishAppDialog(secondId, null);
    await expect(second).resolves.toBe(false);
  });
  it("cancels mutations if another project opens while a question is pending", async () => {
    const pending = appDialogs.prompt("Rename clip");
    advanceProjectEpoch();
    finishAppDialog(getAppDialog()!.id, "Must not rename the new project");
    await expect(pending).resolves.toBeNull();
  });
});

describe("shared panel space", () => {
  it.each([480, 540, 620, 800, 1100])("keeps the timeline visible with all panels at %i px", available => {
    const sizes = allocatePanelHeights(available, { mixer: 340, pitch: 280, midi: 280 });
    expect(Object.keys(sizes)).toEqual(["mixer", "pitch", "midi"]);
    expect(Math.min(...Object.values(sizes))).toBeGreaterThanOrEqual(PANEL_MIN_HEIGHT);
    expect(Object.values(sizes).reduce((a, b) => a + b, 0) + TIMELINE_MIN_HEIGHT).toBeLessThanOrEqual(available + 0.001);
  });
  it("retains usable panels for scrolling when the window cannot fit all minima", () => {
    const sizes = allocatePanelHeights(240, { mixer: 340, pitch: 280 });
    expect(sizes).toEqual({ mixer: PANEL_MIN_HEIGHT, pitch: PANEL_MIN_HEIGHT });
  });
  it("preserves requested heights when there is room and ignores closed panels", () => {
    expect(allocatePanelHeights(1200, { mixer: 340, pitch: 280, midi: 0 })).toEqual({ mixer: 340, pitch: 280 });
  });
});

describe("pinch dispatch", () => {
  it.each(["timeline", "piano_roll", "pitch_editor"] as const)("zooms %s in the Logic profile", surface => {
    const profile = getMouseBehaviorProfile("logic_pro", "macos");
    expect(resolveWheelGesture({ deltaY: -20, ctrlKey: true, openStudioPinch: true },
      { surface, platform: "macos", subtarget: "content" }, profile.wheel)).toMatchObject({ operation: "zoom", preventDefault: true });
  });
  it("distinguishes physical Control-wheel from synthetic pinch and retains child propagation", () => {
    const listeners = new Map<string, EventListener>();
    const target = { addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener), removeEventListener: vi.fn() } as unknown as Document;
    const cleanup = installBrowserZoomWheelGuard(target);
    const event = () => ({ ctrlKey: true, deltaMode: 0, deltaX: 0, deltaY: -2, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    const pinch = event(); listeners.get("wheel")!(pinch as unknown as Event);
    expect(pinch).toMatchObject({ openStudioPinch: true });
    expect(pinch.stopPropagation).not.toHaveBeenCalled();
    listeners.get("keydown")!({ ctrlKey: true } as unknown as Event);
    const physical = event(); listeners.get("wheel")!(physical as unknown as Event);
    expect(physical).not.toHaveProperty("openStudioPinch");
    cleanup();
  });
});

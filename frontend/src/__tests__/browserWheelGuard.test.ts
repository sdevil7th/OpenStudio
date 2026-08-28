import { describe, expect, it, vi } from "vitest";
import {
  installBrowserZoomWheelGuard,
  resolveBrowserWheelGesture,
  shouldSuppressBrowserZoomWheel,
} from "../utils/browserWheelGuard";

describe("app-wide browser zoom wheel guard", () => {
  it.each([
    { platform: "Windows", event: { ctrlKey: true }, expected: true },
    { platform: "Windows physical Meta", event: { metaKey: true }, expected: true },
    { platform: "macOS Command", event: { metaKey: true }, expected: true },
    { platform: "macOS physical Control / pinch", event: { ctrlKey: true }, expected: true },
    { platform: "macOS both modifiers", event: { ctrlKey: true, metaKey: true }, expected: true },
    { platform: "ordinary scroll", event: {}, expected: false },
    { platform: "ordinary Shift scroll", event: { shiftKey: true }, expected: false },
  ])("returns $expected for $platform", ({ event, expected }) => {
    expect(shouldSuppressBrowserZoomWheel(event)).toBe(expected);
  });

  it("prevents browser zoom without stopping child DAW wheel propagation", () => {
    expect(resolveBrowserWheelGesture({ deltaY: 3, ctrlKey: true })).toMatchObject({
      operation: "suppress",
      preventDefault: true,
      stopPropagation: false,
    });
    expect(resolveBrowserWheelGesture({ deltaY: 3, metaKey: true })).toMatchObject({
      operation: "suppress",
      preventDefault: true,
      stopPropagation: false,
    });
  });

  it("preserves ordinary browser/list scrolling", () => {
    expect(resolveBrowserWheelGesture({ deltaY: 3 })).toMatchObject({
      operation: "native-scroll",
      preventDefault: false,
      stopPropagation: false,
    });
  });

  it("prevents at capture without consuming propagation to a child handler", () => {
    let listener: EventListener | null = null;
    const target = {
      addEventListener: vi.fn((_type: string, next: EventListener) => {
        listener = next;
      }),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const cleanup = installBrowserZoomWheelGuard(target);

    expect(listener).not.toBeNull();
    (listener as unknown as EventListener)({
      ctrlKey: true,
      deltaY: 1,
      preventDefault,
      stopPropagation,
    } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).not.toHaveBeenCalled();

    cleanup();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
  });
});

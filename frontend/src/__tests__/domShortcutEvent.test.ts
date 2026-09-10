import { describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import mixerWindowSource from "../MixerWindowApp.tsx?raw";
import midiWindowSource from "../MidiEditorWindowApp.tsx?raw";
import pluginWindowSource from "../PluginEditorWindowApp.tsx?raw";
import shortcutHarnessSource from "../e2e/shortcutHarness.ts?raw";
import {
  browserShortcutWindowIsActive,
  toGlobalShortcutPayload,
} from "../utils/domShortcutEvent";
import { canonicalizeShortcutEvent } from "../utils/platform";
import { shouldPreserveEditableShortcut } from "../utils/shortcutContext";

function targetMatching(selectorFragment: string): EventTarget {
  return {
    closest: (selectors: string) => selectors.includes(selectorFragment) ? {} : null,
  } as unknown as EventTarget;
}

function keyboardEvent(
  overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key: "z",
    code: "KeyZ",
    location: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    target: null,
    composedPath: () => [],
    getModifierState: vi.fn(() => false),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("DOM shortcut event adapter", () => {
  it("preserves every matching-critical browser field and event control", () => {
    const getModifierState = vi.fn((modifier: string) => modifier === "AltGraph");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const stopImmediatePropagation = vi.fn();
    const event = keyboardEvent({
      key: "@",
      code: "KeyQ",
      location: 3,
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: true,
      repeat: true,
      isComposing: true,
      target: targetMatching("input[type='text']"),
      getModifierState,
      preventDefault,
      stopPropagation,
      stopImmediatePropagation,
    });

    const payload = toGlobalShortcutPayload(event, { source: "test-browser" });

    expect(payload).toMatchObject({
      key: "@",
      code: "KeyQ",
      location: 3,
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: true,
      repeat: true,
      isComposing: true,
      source: "test-browser",
      targetIsEditable: true,
      targetIsNonTextControl: false,
    });
    expect(payload.getModifierState?.("AltGraph")).toBe(true);
    expect(getModifierState).toHaveBeenCalledWith("AltGraph");

    payload.preventDefault?.();
    payload.stopPropagation?.();
    payload.stopImmediatePropagation?.();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("keeps IME and AltGraph text entry out of application shortcut matching", () => {
    const editableTarget = targetMatching("[role='textbox']");
    const composing = toGlobalShortcutPayload(keyboardEvent({
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
      isComposing: true,
      target: editableTarget,
    }));
    const altGraph = toGlobalShortcutPayload(keyboardEvent({
      key: "@",
      code: "KeyQ",
      ctrlKey: true,
      altKey: true,
      target: editableTarget,
      getModifierState: (modifier: string) => modifier === "AltGraph",
    }));

    expect(shouldPreserveEditableShortcut(composing, true, "windows")).toBe(true);
    expect(canonicalizeShortcutEvent(composing, "windows")).toBeNull();
    expect(shouldPreserveEditableShortcut(altGraph, true, "windows")).toBe(true);
    expect(canonicalizeShortcutEvent(altGraph, "windows")).toBe("AltGraph+@");

    const legacyIME = toGlobalShortcutPayload(keyboardEvent({
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
      isComposing: false,
      keyCode: 229,
      target: editableTarget,
    }));
    expect(legacyIME.isComposing).toBe(true);
    expect(canonicalizeShortcutEvent(legacyIME, "windows")).toBeNull();
  });

  it("classifies controls inside a retargeted Shadow DOM event", () => {
    const shadowHost = targetMatching("[data-shadow-host]");
    const shadowInput = targetMatching("input[type='text']");
    const shadowButton = targetMatching("button");

    const editable = toGlobalShortcutPayload(keyboardEvent({
      target: shadowHost,
      composedPath: () => [shadowInput, shadowHost],
    }));
    const control = toGlobalShortcutPayload(keyboardEvent({
      target: shadowHost,
      composedPath: () => [shadowButton, shadowHost],
    }));

    expect(editable.targetIsEditable).toBe(true);
    expect(editable.targetIsNonTextControl).toBe(false);
    expect(control.targetIsEditable).toBe(false);
    expect(control.targetIsNonTextControl).toBe(true);
  });

  it("preserves numpad location and lets explicit target ownership override classification", () => {
    const payload = toGlobalShortcutPayload(keyboardEvent({
      key: "1",
      code: "",
      location: 3,
      ctrlKey: true,
      target: targetMatching("input[type='range']"),
    }), {
      targetIsEditable: true,
      targetIsNonTextControl: false,
    });

    expect(canonicalizeShortcutEvent(payload, "windows")).toBe("Ctrl+Numpad1");
    expect(payload.targetIsEditable).toBe(true);
    expect(payload.targetIsNonTextControl).toBe(false);
  });

  it("gates detached shortcuts on document focus, OS window focus, and visibility", () => {
    expect(browserShortcutWindowIsActive({
      documentFocused: true,
      windowFocused: true,
      visibilityState: "visible",
    })).toBe(true);

    for (const snapshot of [
      { documentFocused: false, windowFocused: true, visibilityState: "visible" },
      { documentFocused: true, windowFocused: false, visibilityState: "visible" },
      { documentFocused: true, windowFocused: true, visibilityState: "hidden" },
    ]) {
      expect(browserShortcutWindowIsActive(snapshot)).toBe(false);
    }
  });

  it("uses one adapter everywhere and keeps native accelerator authority in main", () => {
    for (const source of [
      appSource,
      mixerWindowSource,
      midiWindowSource,
      pluginWindowSource,
      shortcutHarnessSource,
    ]) {
      expect(source).toContain("toGlobalShortcutPayload(");
    }
    for (const source of [mixerWindowSource, midiWindowSource, pluginWindowSource]) {
      expect(source).toContain("browserShortcutWindowIsActive(");
      expect(source).toContain("document.hasFocus()");
      expect(source).toContain("document.visibilityState");
      expect(source).not.toContain("onNativeGlobalShortcut");
    }
    expect(appSource).toContain("onNativeGlobalShortcut");
  });
});

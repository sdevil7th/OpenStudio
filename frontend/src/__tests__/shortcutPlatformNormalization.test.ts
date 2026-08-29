import { describe, expect, it } from "vitest";
import {
  canonicalizeShortcutEvent,
  formatShortcutForPlatform,
  normalizeShortcutBinding,
  normalizeShortcutBindings,
  shortcutBindingEventSignature,
  shortcutEventCandidates,
  shortcutMatchesEvent,
} from "../utils/platform";

describe("cross-platform shortcut normalization", () => {
  it("keeps legacy bindings compatible while exposing physical modifiers", () => {
    expect(canonicalizeShortcutEvent(
      { key: "z", code: "KeyZ", metaKey: true },
      "macos",
    )).toBe("Ctrl+Z");
    expect(canonicalizeShortcutEvent(
      { key: "z", code: "KeyZ", metaKey: true },
      "macos",
      { modifierStyle: "physical" },
    )).toBe("Command+Z");
    expect(canonicalizeShortcutEvent(
      { key: "z", code: "KeyZ", ctrlKey: true },
      "macos",
    )).toBe("Alt+Z");
    expect(canonicalizeShortcutEvent(
      { key: "z", code: "KeyZ", ctrlKey: true },
      "macos",
      { modifierStyle: "physical" },
    )).toBe("Control+Z");
    expect(canonicalizeShortcutEvent(
      { key: "z", code: "KeyZ", altKey: true },
      "macos",
    )).toBe("Option+Z");

    expect(shortcutMatchesEvent(
      { key: "z", code: "KeyZ", metaKey: true },
      "Ctrl+Z",
      "macos",
    )).toBe(true);
    expect(shortcutMatchesEvent(
      { key: "z", code: "KeyZ", metaKey: true },
      "Command+Z",
      "macos",
    )).toBe(true);
    expect(shortcutMatchesEvent(
      { key: "z", code: "KeyZ", metaKey: true },
      "Control+Z",
      "macos",
    )).toBe(false);
  });

  it("does not alias the Windows key to Control", () => {
    const windowsKeyEvent = { key: "m", code: "KeyM", metaKey: true };
    expect(canonicalizeShortcutEvent(windowsKeyEvent, "windows")).toBe("Meta+M");
    expect(shortcutMatchesEvent(windowsKeyEvent, "Meta+M", "windows")).toBe(true);
    expect(shortcutMatchesEvent(windowsKeyEvent, "Ctrl+M", "windows")).toBe(false);
    expect(shortcutMatchesEvent(
      { key: "m", code: "KeyM", ctrlKey: true },
      "Meta+M",
      "windows",
    )).toBe(false);
  });

  it("requires exact modifier sets, including Option and mixed Mac chords", () => {
    const commandControlOption = {
      key: "r",
      code: "KeyR",
      ctrlKey: true,
      altKey: true,
      metaKey: true,
      shiftKey: true,
    };

    expect(canonicalizeShortcutEvent(commandControlOption, "macos")).toBe(
      "Ctrl+Alt+Option+Shift+R",
    );
    expect(shortcutMatchesEvent(
      commandControlOption,
      "Command+Control+Option+Shift+R",
      "macos",
    )).toBe(true);
    expect(shortcutMatchesEvent(
      commandControlOption,
      "Ctrl+Alt+Shift+R",
      "macos",
    )).toBe(false);
    expect(shortcutMatchesEvent(
      { key: "r", code: "KeyR", altKey: true },
      "Alt+R",
      "macos",
    )).toBe(false);
    expect(shortcutMatchesEvent(
      { key: "r", code: "KeyR", altKey: true },
      "Option+R",
      "macos",
    )).toBe(true);
  });

  it("supports printed-label and physical-position bindings on QWERTZ", () => {
    // The key labelled Z on a German QWERTZ layout reports KeyY.
    const labelledZ = { key: "z", code: "KeyY", ctrlKey: true };
    expect(shortcutMatchesEvent(labelledZ, "Ctrl+Z", "windows")).toBe(true);
    expect(shortcutMatchesEvent(
      labelledZ,
      "Control+Code:KeyY",
      "windows",
    )).toBe(true);
    expect(shortcutMatchesEvent(labelledZ, "Ctrl+Code:KeyZ", "windows")).toBe(false);
    expect(canonicalizeShortcutEvent(
      labelledZ,
      "windows",
      { keyMode: "physical", modifierStyle: "physical" },
    )).toBe("Control+Code:KeyY");

    // The US-QWERTY Z position reports KeyZ but produces Y on QWERTZ.
    const qwertyZPosition = { key: "y", code: "KeyZ", ctrlKey: true };
    expect(shortcutMatchesEvent(qwertyZPosition, "Ctrl+Z", "windows")).toBe(false);
    expect(shortcutMatchesEvent(
      qwertyZPosition,
      "Control+Code:KeyZ",
      "windows",
    )).toBe(true);
  });

  it("supports printed-label and physical-position bindings on AZERTY", () => {
    const labelledQ = { key: "q", code: "KeyA", metaKey: true };
    expect(shortcutMatchesEvent(labelledQ, "Command+Q", "macos")).toBe(true);
    expect(shortcutMatchesEvent(
      labelledQ,
      "Command+Code:KeyA",
      "macos",
    )).toBe(true);
    expect(shortcutMatchesEvent(
      labelledQ,
      "Command+Code:KeyQ",
      "macos",
    )).toBe(false);
  });

  it("distinguishes numpad keys from the top row", () => {
    const topRowOne = { key: "1", code: "Digit1", ctrlKey: true };
    const numpadOne = { key: "1", code: "Numpad1", ctrlKey: true, location: 3 };

    expect(canonicalizeShortcutEvent(topRowOne, "windows")).toBe("Ctrl+1");
    expect(canonicalizeShortcutEvent(numpadOne, "windows")).toBe("Ctrl+Numpad1");
    expect(shortcutMatchesEvent(topRowOne, "Ctrl+1", "windows")).toBe(true);
    expect(shortcutMatchesEvent(topRowOne, "Ctrl+Numpad1", "windows")).toBe(false);
    expect(shortcutMatchesEvent(numpadOne, "Ctrl+1", "windows")).toBe(false);
    expect(shortcutMatchesEvent(numpadOne, "Ctrl+Numpad1", "windows")).toBe(true);
    expect(shortcutMatchesEvent(
      numpadOne,
      "Control+Code:Numpad1",
      "windows",
    )).toBe(true);

    expect(canonicalizeShortcutEvent(
      { key: "+", code: "NumpadAdd", location: 3 },
      "windows",
    )).toBe("NumpadAdd");
    expect(canonicalizeShortcutEvent(
      { key: "2", location: 3 },
      "windows",
    )).toBe("Numpad2");
  });

  it("keeps AltGraph text entry from masquerading as Ctrl+Alt", () => {
    const altGraphEvent = {
      key: "@",
      code: "KeyQ",
      ctrlKey: true,
      altKey: true,
      getModifierState: (modifier: string) => modifier === "AltGraph",
    };
    expect(canonicalizeShortcutEvent(altGraphEvent, "windows")).toBe("AltGraph+@");
    expect(shortcutMatchesEvent(altGraphEvent, "Ctrl+Alt+@", "windows")).toBe(false);
    expect(shortcutMatchesEvent(altGraphEvent, "AltGraph+@", "windows")).toBe(true);
    expect(shortcutMatchesEvent(
      altGraphEvent,
      "AltGraph+Code:KeyQ",
      "windows",
    )).toBe(true);
  });

  it("rejects modifier-only, composing, dead, and unidentified input", () => {
    expect(canonicalizeShortcutEvent(
      { key: "Control", code: "ControlLeft", ctrlKey: true },
      "windows",
    )).toBeNull();
    expect(canonicalizeShortcutEvent(
      { key: "z", code: "KeyZ", ctrlKey: true, isComposing: true },
      "windows",
    )).toBeNull();
    expect(canonicalizeShortcutEvent({ key: "Dead", code: "Quote" }, "windows")).toBeNull();
    expect(shortcutMatchesEvent(
      { key: "Dead", code: "Quote" },
      "Code:Quote",
      "windows",
    )).toBe(false);
    expect(canonicalizeShortcutEvent({ key: "Unidentified" }, "windows")).toBeNull();
  });

  it("normalizes aliases, plus keys, and multiple bindings", () => {
    expect(normalizeShortcutBinding(" shift + cmd + code:keyz ")).toBe(
      "Command+Shift+Code:KeyZ",
    );
    expect(normalizeShortcutBinding("windows+control+numpadadd")).toBe(
      "Control+Meta+NumpadAdd",
    );
    expect(normalizeShortcutBinding("ctrl++")).toBe("Ctrl++");
    expect(normalizeShortcutBinding("ctrl+ctrl+z")).toBeNull();
    expect(normalizeShortcutBindings([
      "ctrl+z",
      "Ctrl+Z",
      null,
      "Command+Code:KeyZ",
      "",
    ])).toEqual(["Ctrl+Z", "Command+Code:KeyZ"]);
  });

  it("returns both legacy and explicit event candidates", () => {
    const candidates = shortcutEventCandidates(
      { key: "z", code: "KeyZ", metaKey: true },
      "macos",
    );
    expect(candidates).toContain("Ctrl+Z");
    expect(candidates).toContain("Command+Z");
    expect(candidates).toContain("Ctrl+Code:KeyZ");
    expect(candidates).toContain("Command+Code:KeyZ");
  });

  it("builds platform-physical signatures for truthful conflict checks", () => {
    expect(shortcutBindingEventSignature("Ctrl+Z", "macos")).toBe(
      shortcutBindingEventSignature("Command+Z", "macos"),
    );
    expect(shortcutBindingEventSignature("Alt+Z", "macos")).toBe(
      shortcutBindingEventSignature("Control+Z", "macos"),
    );
    expect(shortcutBindingEventSignature("Option+Z", "macos")).not.toBe(
      shortcutBindingEventSignature("Alt+Z", "macos"),
    );
    expect(shortcutBindingEventSignature("Option+Z", "windows")).toBeNull();
    expect(shortcutBindingEventSignature("Ctrl+Control+Z", "windows")).toBeNull();
    expect(shortcutBindingEventSignature("Control+Code:KeyB", "windows")).toBe(
      shortcutBindingEventSignature("Ctrl+B", "windows"),
    );
  });

  it("formats legacy and explicit bindings for each platform", () => {
    expect(formatShortcutForPlatform("Ctrl+Alt+Option+Z", "macos")).toBe(
      "Cmd+Ctrl+Option+Z",
    );
    expect(formatShortcutForPlatform("Control+Meta+M", "windows")).toBe(
      "Ctrl+Win+M",
    );
    expect(formatShortcutForPlatform("Command+Code:KeyZ", "macos")).toBe(
      "Cmd+Physical KeyZ",
    );
  });
});

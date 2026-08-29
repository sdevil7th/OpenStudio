import { describe, expect, it } from "vitest";
import pluginWindowManagerSource from "../../../Source/PluginWindowManager.cpp?raw";

describe("native plug-in shortcut forwarding", () => {
  it("preserves distinct editing, navigation, function, and numpad keys", () => {
    expect(pluginWindowManagerSource).toContain('backspaceKey) return "Backspace"');
    expect(pluginWindowManagerSource).toContain('pageUpKey) return "PageUp"');
    expect(pluginWindowManagerSource).toContain('homeKey) return "Home"');
    expect(pluginWindowManagerSource).toContain('F12Key) return "F12"');
    expect(pluginWindowManagerSource).toContain('numberPad0, "0", "Numpad0"');
    expect(pluginWindowManagerSource).toContain('numberPadAdd, "+", "NumpadAdd"');
  });

  it("does not report macOS Command as both Ctrl and Meta", () => {
    expect(pluginWindowManagerSource).toContain("#if JUCE_MAC");
    expect(pluginWindowManagerSource).toContain(
      'obj->setProperty("ctrlKey", modifiers.isCtrlDown());',
    );
    expect(pluginWindowManagerSource).toContain(
      'obj->setProperty("metaKey", modifiers.isCommandDown());',
    );
    expect(pluginWindowManagerSource).not.toContain(
      'obj->setProperty("ctrlKey", modifiers.isCtrlDown() || modifiers.isCommandDown());',
    );
  });
});

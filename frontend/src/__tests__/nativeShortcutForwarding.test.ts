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

  it("lets the native editor try history keys before claiming unmatched Undo/Redo", () => {
    const keyHandlerStart = pluginWindowManagerSource.indexOf(
      "bool PluginWindowManager::PluginWindow::keyPressed",
    );
    const keyHandlerEnd = pluginWindowManagerSource.indexOf(
      "void PluginWindowManager::PluginWindow::activeWindowStatusChanged",
      keyHandlerStart,
    );
    const keyHandler = pluginWindowManagerSource.slice(keyHandlerStart, keyHandlerEnd);

    const bubbledFromPlugin = keyHandler.indexOf("focused child editor before bubbling");
    const hostClaim = keyHandler.indexOf("isNativePluginHistoryShortcut(key)");
    const hostForward = keyHandler.indexOf("owner.handlePluginWindowKeyPress(key, owner.currentNativeKeyIsRepeat)");
    expect(bubbledFromPlugin).toBeGreaterThan(-1);
    expect(hostClaim).toBeGreaterThan(bubbledFromPlugin);
    expect(hostForward).toBeGreaterThan(hostClaim);
    expect(keyHandler).toContain('"host_claimed_plugin_history_key"');
    expect(keyHandler).toMatch(/isNativePluginHistoryShortcut\(key\)[\s\S]*?return true;/);
    expect(pluginWindowManagerSource).toMatch(
      /handlePluginWindowKeyPress\(const juce::KeyPress& key, bool isRepeat\) const[\s\S]*?isNativePluginHistoryShortcut\(key\)[\s\S]*?shortcutForwardCallback/,
    );
  });

  it("claims only exact platform Undo/Redo chords", () => {
    expect(pluginWindowManagerSource).toContain(
      "modifiers.isCommandDown() && ! modifiers.isCtrlDown()",
    );
    expect(pluginWindowManagerSource).toContain(
      "modifiers.isCtrlDown() && ! modifiers.isCommandDown()",
    );
    expect(pluginWindowManagerSource).toContain(
      "if (! hasPrimaryModifier || modifiers.isAltDown())",
    );
    expect(pluginWindowManagerSource).toContain("if (keyCode == 'Z')");
    expect(pluginWindowManagerSource).toContain(
      "return keyCode == 'Y' && ! modifiers.isShiftDown();",
    );
  });

  it("observes Win32 repeat without preempting native controls or text", () => {
    const hook = pluginWindowManagerSource.slice(
      pluginWindowManagerSource.indexOf("static LRESULT CALLBACK pluginWindowKeyboardHookProc"),
      pluginWindowManagerSource.indexOf("void PluginWindowManager::installKeyboardHook"),
    );
    expect(hook).toContain("inst->noteNativeKeyRepeat(isRepeat)");
    expect(hook).toContain("CallNextHookEx");
    expect(hook).not.toContain("handlePluginWindowKeyPress");
    expect(hook).not.toContain("return 1");
    expect(hook).not.toContain("VK_SPACE");
    expect(pluginWindowManagerSource).toContain('obj->setProperty("repeat", isRepeat);');
  });
});

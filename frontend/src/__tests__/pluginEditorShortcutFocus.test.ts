import { describe, expect, it, vi } from "vitest";
import pluginEditorSource from "../PluginEditorWindowApp.tsx?raw";
import builtInPanelSource from "../components/BuiltInPluginPanel.tsx?raw";
import { pluginEditorBrowserShortcutIsActive } from "../PluginEditorWindowApp";
import {
  builtInPluginShortcutFocusIsActive,
  dispatchBuiltInPluginHistoryShortcut,
  isBuiltInPluginParamShortcutTarget,
} from "../components/BuiltInPluginPanel";

describe("detached built-in plugin shortcut focus", () => {
  it("accepts browser shortcuts only from the visible OS-focused editor", () => {
    expect(pluginEditorBrowserShortcutIsActive({
      documentFocused: true,
      windowFocused: true,
      visibilityState: "visible",
    })).toBe(true);
    expect(pluginEditorBrowserShortcutIsActive({
      documentFocused: false,
      windowFocused: true,
      visibilityState: "visible",
    })).toBe(false);
    expect(pluginEditorBrowserShortcutIsActive({
      documentFocused: true,
      windowFocused: false,
      visibilityState: "visible",
    })).toBe(false);
    expect(pluginEditorBrowserShortcutIsActive({
      documentFocused: true,
      windowFocused: true,
      visibilityState: "hidden",
    })).toBe(false);
  });

  it("stops detached ownership on blur and permits it again only after editor refocus", () => {
    const focusSequence = [
      { documentFocused: true, windowFocused: true, visibilityState: "visible" },
      { documentFocused: false, windowFocused: false, visibilityState: "visible" },
      { documentFocused: true, windowFocused: true, visibilityState: "visible" },
    ];

    expect(focusSequence.map(pluginEditorBrowserShortcutIsActive)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("requires document focus for a detached panel but leaves main browser routing local", () => {
    expect(builtInPluginShortcutFocusIsActive("pluginEditor", true)).toBe(true);
    expect(builtInPluginShortcutFocusIsActive("pluginEditor", false)).toBe(false);
    expect(builtInPluginShortcutFocusIsActive("main", false)).toBe(true);
    expect(builtInPluginShortcutFocusIsActive("mixer", true)).toBe(false);
  });

  it("does not subscribe detached WebViews to untargeted native accelerators", () => {
    expect(pluginEditorSource).not.toContain("onNativeGlobalShortcut");
    expect(pluginEditorSource).toContain('window.addEventListener("focus", handleWindowFocus)');
    expect(pluginEditorSource).toContain('window.addEventListener("blur", handleWindowBlur)');
    expect(pluginEditorSource).toContain("document.hasFocus()");
    expect(pluginEditorSource).toContain("document.visibilityState");
  });

  it("registers plugin history ownership and claims empty Undo/Redo", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    const emptyHistory = { active: true, canUndo: false, canRedo: false, undo, redo };

    expect(dispatchBuiltInPluginHistoryShortcut(
      { key: "z", ctrlKey: true },
      emptyHistory,
    )).toBe("claimed_noop");
    expect(dispatchBuiltInPluginHistoryShortcut(
      { key: "z", ctrlKey: true, shiftKey: true },
      emptyHistory,
    )).toBe("claimed_noop");
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();

    expect(dispatchBuiltInPluginHistoryShortcut(
      { key: "z", ctrlKey: true },
      { ...emptyHistory, canUndo: true },
    )).toBe("handled");
    expect(undo).toHaveBeenCalledOnce();

    expect(dispatchBuiltInPluginHistoryShortcut(
      { key: "z", ctrlKey: true },
      { ...emptyHistory, active: false, canUndo: true },
    )).toBe("unmatched");
    expect(undo).toHaveBeenCalledOnce();

    expect(builtInPanelSource).toContain("pluginShortcutHandlerRef.current(event)");
    expect(builtInPanelSource).toContain("dispatchBuiltInPluginHistoryShortcut(event, {");
    expect(builtInPanelSource).toContain('windowRole === "pluginEditor"');
  });

  it("defines gesture boundaries for knobs, wheel, keys, toggles, and selects", () => {
    const parameterSelect = {
      closest: () => ({
        getAttribute: (name: string) => name === "data-param-id" ? "instrumentProfile" : null,
      }),
    } as unknown as EventTarget;
    const presetNameInput = {
      closest: () => null,
    } as unknown as EventTarget;

    expect(isBuiltInPluginParamShortcutTarget(parameterSelect)).toBe(true);
    expect(isBuiltInPluginParamShortcutTarget(presetNameInput)).toBe(false);
    expect(builtInPanelSource).toContain('candidate?.closest?.("[data-param], [data-param-id]")');
    expect(builtInPanelSource).toContain("onPointerDownCapture={(event) =>");
    expect(builtInPanelSource).toContain("onPointerUpCapture={finishPointerParamGesture}");
    expect(builtInPanelSource).toContain("onWheelCapture={(event) =>");
    expect(builtInPanelSource).toContain("onKeyDownCapture={(event) =>");
    expect(builtInPanelSource).toContain("onKeyUpCapture={(event) =>");
    expect(builtInPanelSource).toContain("scheduleParamCommit(0)");
    expect(builtInPanelSource).toContain("paramHistory.begin(paramId, currentParam.label, currentParam.value)");
    expect(pluginEditorSource).toContain("isPluginHistoryShortcut");
    expect(pluginEditorSource).toContain(
      "targetIsEditable: shortcutEvent.targetIsEditable && !isPluginHistoryShortcut",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeActiveScopedAction,
  getActionShortcutScopes,
  getRegisteredAction,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import {
  dispatchGlobalShortcut,
  matchesActionShortcut,
  resolveRegistryShortcutAction,
} from "../utils/globalShortcutDispatcher";
import {
  registerModalShortcutScope,
  registerTransientOverlayShortcutScope,
  routeModalShortcutEvent,
} from "../utils/modalShortcutScope";
import { getProfileActionBindings } from "../utils/shortcutProfiles";
import {
  activateShortcutContext,
  getActiveShortcutContext,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";
import { getShortcutPlatform } from "../utils/platform";

const cleanup: Array<() => void> = [];
const originalInputState = {
  keyboardShortcutProfileId: useDAWStore.getState().keyboardShortcutProfileId,
  customShortcuts: useDAWStore.getState().customShortcuts,
};

function hostPrimaryModifier(): { ctrlKey: true } | { metaKey: true } {
  return getShortcutPlatform() === "macos" ? { metaKey: true } : { ctrlKey: true };
}

class ShortcutTestTarget extends EventTarget {
  constructor(private readonly editable = false) {
    super();
  }

  closest(): object | null {
    return this.editable ? {} : null;
  }
}

function createShortcutEvent(
  key: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
): Event {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    code: { value: key },
    ctrlKey: { value: Boolean(modifiers.ctrlKey) },
    metaKey: { value: Boolean(modifiers.metaKey) },
    altKey: { value: Boolean(modifiers.altKey) },
    shiftKey: { value: Boolean(modifiers.shiftKey) },
  });
  return event;
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
  resetShortcutContextForTests();
  useDAWStore.setState(originalInputState);
  vi.restoreAllMocks();
});

describe("visible component command reachability", () => {
  it("registers each newly audited command in its owning surface", () => {
    const expected = new Map<string, string>([
      ["modal.close", "modal"],
      ["script.runCurrent", "modal"],
      ["script.saveCurrent", "modal"],
      ["script.clearConsole", "modal"],
      ["script.refreshFiles", "modal"],
      ["script.openFolder", "modal"],
      ["script.showEditorTab", "modal"],
      ["script.showFilesTab", "modal"],
      ["browser.close", "browser"],
      ["fx.close", "plugin"],
      ["mixer.close", "mixer"],
    ]);

    for (const [actionId, scope] of expected) {
      const action = getRegisteredAction(actionId);
      expect(action, actionId).toBeDefined();
      expect(getActionShortcutScopes(action!), actionId).toContain(scope);
    }
    expect(getRegisteredAction("modal.close")?.shortcut).toBe("Esc");
    expect(getRegisteredAction("script.runCurrent")?.shortcut).toBe("Ctrl+Enter");
    expect(getRegisteredAction("browser.close")?.shortcut).toBeUndefined();
    expect(getRegisteredAction("fx.close")?.shortcut).toBeUndefined();
    expect(getRegisteredAction("mixer.close")?.shortcut).toBeUndefined();
  });

  it("closes only the top nested modal and restores the exact previous owner", () => {
    activateShortcutContext({ kind: "timeline" });
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const unregisterOuter = registerModalShortcutScope(outerClose);
    cleanup.push(unregisterOuter);
    const unregisterInner = registerModalShortcutScope(innerClose);
    cleanup.push(unregisterInner);

    expect(getActiveShortcutContext()).toEqual({ kind: "modal" });
    expect(executeActiveScopedAction("modal.close")).toBe("handled");
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();

    cleanup.pop()?.();
    expect(getActiveShortcutContext()).toEqual({ kind: "modal" });
    expect(executeActiveScopedAction("modal.close")).toBe("handled");
    expect(outerClose).toHaveBeenCalledTimes(1);

    cleanup.pop()?.();
    expect(getActiveShortcutContext()).toEqual({ kind: "timeline" });
  });

  it("does not leak a blocked top-modal close command to the dialog underneath", () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    cleanup.push(registerModalShortcutScope(outerClose));
    cleanup.push(registerModalShortcutScope(innerClose, { canClose: () => false }));

    expect(executeActiveScopedAction("modal.close")).toBe("claimed_noop");
    expect(innerClose).not.toHaveBeenCalled();
    expect(outerClose).not.toHaveBeenCalled();
  });

  it("gives a nested transient overlay one close command and restores its underlay", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {} });
    const target = new ShortcutTestTarget();
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const unregisterOuter = registerTransientOverlayShortcutScope(outerClose, { eventTarget: target });
    cleanup.push(unregisterOuter);
    const unregisterInner = registerTransientOverlayShortcutScope(innerClose, { eventTarget: target });
    cleanup.push(unregisterInner);

    target.dispatchEvent(createShortcutEvent("Escape"));
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();

    cleanup.pop()?.();
    target.dispatchEvent(createShortcutEvent("Escape"));
    expect(outerClose).toHaveBeenCalledTimes(1);
  });

  it("honors transient close unbinding and an editable rebound command", () => {
    const close = vi.fn();
    const editableTarget = new ShortcutTestTarget(true);
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {
        "modal.close": { windows: [], macos: [] },
      },
    });
    cleanup.push(registerTransientOverlayShortcutScope(close, { eventTarget: editableTarget }));

    const unassignedEscape = createShortcutEvent("Escape");
    editableTarget.dispatchEvent(unassignedEscape);
    expect(close).not.toHaveBeenCalled();
    expect(unassignedEscape.defaultPrevented).toBe(false);

    cleanup.pop()?.();
    useDAWStore.setState({
      customShortcuts: {
        "modal.close": { windows: ["Control+F9"], macos: ["Command+F9"] },
      },
    });
    cleanup.push(registerTransientOverlayShortcutScope(close, { eventTarget: editableTarget }));
    editableTarget.dispatchEvent(createShortcutEvent("Escape"));
    expect(close).not.toHaveBeenCalled();

    const rebound = createShortcutEvent("F9", hostPrimaryModifier());
    editableTarget.dispatchEvent(rebound);
    expect(close).toHaveBeenCalledTimes(1);
    expect(rebound.defaultPrevented).toBe(true);
  });

  it("preserves a native editable chord even when assigned to transient close", () => {
    const close = vi.fn();
    const editableTarget = new ShortcutTestTarget(true);
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {
        "modal.close": { windows: ["Control+C"], macos: ["Command+C"] },
      },
    });
    cleanup.push(registerTransientOverlayShortcutScope(close, { eventTarget: editableTarget }));

    const copy = createShortcutEvent("c", hostPrimaryModifier());
    editableTarget.dispatchEvent(copy);
    expect(close).not.toHaveBeenCalled();
    expect(copy.defaultPrevented).toBe(false);
  });

  it("does not let a Script Editor binding consume keys in an unrelated modal", () => {
    cleanup.push(registerModalShortcutScope(vi.fn()));
    expect(getRegisteredAction("modal.close")?.canHandleShortcut?.()).toBe(true);
    expect(getRegisteredAction("script.runCurrent")?.canHandleShortcut?.()).toBe(false);

    const run = vi.fn(() => "handled" as const);
    cleanup.push(registerScopedActionExecutor(
      { kind: "modal" },
      run,
      ["script.runCurrent"],
    ));
    expect(getRegisteredAction("script.runCurrent")?.canHandleShortcut?.()).toBe(true);
    getRegisteredAction("script.runCurrent")?.execute();
    expect(run).toHaveBeenCalledWith("script.runCurrent");
  });

  it("does not consume a plug-in command unless the exact active owner advertises it", () => {
    const builtInOwner = vi.fn((actionId: string) => (
      actionId === "fx.close" ? "handled" as const : "unmatched" as const
    ));
    cleanup.push(registerScopedActionExecutor(
      { kind: "plugin", sessionId: "builtin-editor" },
      builtInOwner,
      ["fx.close"],
    ));
    activateShortcutContext({ kind: "plugin", sessionId: "builtin-editor" });
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {
        "fx.add": { windows: ["Control+F8"], macos: ["Command+F8"] },
      },
    });
    const event = { key: "F8", code: "F8", ctrlKey: true };

    expect(getRegisteredAction("fx.add")?.canHandleShortcut?.()).toBe(false);
    expect(resolveRegistryShortcutAction(event, "windows")).toBeNull();
    expect(dispatchGlobalShortcut({ ...event, source: "browser" }, "windows")).toBe(false);
    expect(builtInOwner).not.toHaveBeenCalled();

    const chainOwner = vi.fn(() => "handled" as const);
    cleanup.push(registerScopedActionExecutor(
      { kind: "plugin", sessionId: "builtin-editor" },
      chainOwner,
      ["fx.add"],
    ));
    expect(getRegisteredAction("fx.add")?.canHandleShortcut?.()).toBe(true);
    expect(dispatchGlobalShortcut({ ...event, source: "browser" }, "windows")).toBe(true);
    expect(chainOwner).toHaveBeenCalledWith("fx.add");
  });

  it("leaves editable Escape to the dialog and dispatches non-editable Escape once", () => {
    const close = vi.fn();
    cleanup.push(registerModalShortcutScope(close));

    expect(dispatchGlobalShortcut({
      key: "Escape",
      code: "Escape",
      source: "browser",
      targetIsEditable: true,
    }, "windows")).toBe(false);
    expect(close).not.toHaveBeenCalled();

    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();
    expect(dispatchGlobalShortcut({
      key: "Escape",
      code: "Escape",
      source: "browser",
      targetIsEditable: false,
      preventDefault,
      stopImmediatePropagation,
    }, "windows")).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("routes editable modal close locally without double-firing and honors close blocking", () => {
    const close = vi.fn();
    cleanup.push(registerModalShortcutScope(close));
    const editableTarget = {
      closest: vi.fn(() => ({})),
    } as unknown as EventTarget;
    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();

    const routed = routeModalShortcutEvent({
      key: "Escape",
      code: "Escape",
      target: editableTarget,
      preventDefault,
      stopImmediatePropagation,
    }, "windows");

    expect(routed).toEqual({
      matched: true,
      preservedEditableCommand: false,
      result: "handled",
      suppressedHeadlessEscape: true,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);

    cleanup.pop()?.();
    cleanup.push(registerModalShortcutScope(close, { canClose: () => false }));
    expect(routeModalShortcutEvent({
      key: "Escape",
      code: "Escape",
      target: editableTarget,
    }, "windows").result).toBe("claimed_noop");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("preserves an editable unmatched Escape and suppresses Headless UI raw close", () => {
    const close = vi.fn();
    cleanup.push(registerModalShortcutScope(close));
    useDAWStore.setState({
      customShortcuts: {
        "modal.close": {
          windows: [],
          macos: [],
        },
      },
    });
    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();
    const routed = routeModalShortcutEvent({
      key: "Escape",
      code: "Escape",
      target: { closest: () => ({}) } as unknown as EventTarget,
      preventDefault,
      stopImmediatePropagation,
    }, "windows");

    expect(routed).toEqual({
      matched: false,
      preservedEditableCommand: false,
      result: "unmatched",
      suppressedHeadlessEscape: true,
    });
    expect(close).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("uses a rebound modal close key and leaves raw Escape unassigned", () => {
    const close = vi.fn();
    cleanup.push(registerModalShortcutScope(close));
    useDAWStore.setState({
      customShortcuts: {
        "modal.close": {
          windows: ["Control+F9"],
          macos: ["Command+F9"],
        },
      },
    });
    const editableTarget = { closest: () => ({}) } as unknown as EventTarget;

    expect(routeModalShortcutEvent({
      key: "Escape",
      code: "Escape",
      target: editableTarget,
    }, "windows")).toMatchObject({ matched: false, result: "unmatched" });
    expect(close).not.toHaveBeenCalled();

    expect(routeModalShortcutEvent({
      key: "F9",
      code: "F9",
      ctrlKey: true,
      target: editableTarget,
    }, "windows")).toMatchObject({ matched: true, result: "handled" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("retains an explicitly documented Esc safety binding in every strict profile", () => {
    for (const profileId of ["digital_performer", "waveform", "renoise"] as const) {
      expect(getProfileActionBindings(profileId, "modal.close", "windows"), profileId)
        .toEqual(["Esc"]);
      expect(getProfileActionBindings(profileId, "modal.close", "macos"), profileId)
        .toEqual(["Esc"]);
    }
  });

  it("resolves the Script Editor run chord on Windows and macOS and honors custom bindings", () => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {},
    });
    expect(matchesActionShortcut({
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
    }, "script.runCurrent", "windows")).toBe(true);
    expect(matchesActionShortcut({
      key: "Enter",
      code: "Enter",
      metaKey: true,
    }, "script.runCurrent", "macos")).toBe(true);

    useDAWStore.setState({
      customShortcuts: {
        "script.runCurrent": {
          windows: ["Control+F9"],
          macos: ["Command+F9"],
        },
      },
    });
    expect(matchesActionShortcut({
      key: "F9",
      code: "F9",
      ctrlKey: true,
    }, "script.runCurrent", "windows")).toBe(true);
    expect(matchesActionShortcut({
      key: "F9",
      code: "F9",
      metaKey: true,
    }, "script.runCurrent", "macos")).toBe(true);
    expect(matchesActionShortcut({
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
    }, "script.runCurrent", "windows")).toBe(false);
  });

  it("routes close commands to the exact active browser and plug-in owner", () => {
    const browserUnderlay = vi.fn(() => "handled" as const);
    const browserTop = vi.fn(() => "handled" as const);
    cleanup.push(registerScopedActionExecutor(
      { kind: "browser" },
      browserUnderlay,
      ["browser.close"],
    ));
    cleanup.push(registerScopedActionExecutor(
      { kind: "browser" },
      browserTop,
      ["browser.close"],
    ));
    activateShortcutContext({ kind: "browser" });
    expect(executeActiveScopedAction("browser.close")).toBe("handled");
    expect(browserTop).toHaveBeenCalledWith("browser.close");
    expect(browserUnderlay).not.toHaveBeenCalled();

    const dockedFx = vi.fn(() => "handled" as const);
    const detachedFx = vi.fn(() => "handled" as const);
    cleanup.push(registerScopedActionExecutor(
      { kind: "plugin", sessionId: "docked" },
      dockedFx,
      ["fx.close"],
    ));
    cleanup.push(registerScopedActionExecutor(
      { kind: "plugin", sessionId: "detached" },
      detachedFx,
      ["fx.close"],
    ));
    activateShortcutContext({ kind: "plugin", sessionId: "detached" });
    expect(executeActiveScopedAction("fx.close")).toBe("handled");
    expect(detachedFx).toHaveBeenCalledWith("fx.close");
    expect(dockedFx).not.toHaveBeenCalled();
  });
});

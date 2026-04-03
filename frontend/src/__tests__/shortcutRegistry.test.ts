import { afterEach, describe, expect, it } from "vitest";
import {
  getActionShortcut,
  getEffectiveActionShortcut,
  getGlobalShortcutConflicts,
  getRegisteredAction,
} from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";

afterEach(() => {
  useDAWStore.setState({ customShortcuts: {} });
});

describe("shortcut registry", () => {
  it("wires the mixer shortcut through the registry", () => {
    const mixerAction = getRegisteredAction("view.toggleMixer");
    expect(mixerAction?.shortcut).toBe("Ctrl+M");
    expect(mixerAction?.shortcutScope ?? "global").toBe("global");
  });

  it("includes the displayed global menu shortcuts in the registry", () => {
    expect(getActionShortcut("file.saveAs")).toBe("Ctrl+Shift+S");
    expect(getActionShortcut("file.closeProject")).toBe("Ctrl+F4");
    expect(getActionShortcut("file.quit")).toBe("Ctrl+Q");
    expect(getActionShortcut("file.render")).toBe("Ctrl+Alt+R");
    expect(getActionShortcut("view.zoomIn")).toBe("Ctrl++");
    expect(getActionShortcut("view.zoomOut")).toBe("Ctrl+-");
    expect(getActionShortcut("view.zoomToFit")).toBe("Ctrl+0");
  });

  it("prefers custom global shortcuts when displaying effective bindings", () => {
    expect(getEffectiveActionShortcut("view.toggleMixer")).toBe("Ctrl+M");

    useDAWStore.setState((state) => ({
      customShortcuts: {
        ...state.customShortcuts,
        "view.toggleMixer": "Ctrl+Shift+M",
      },
    }));

    expect(getEffectiveActionShortcut("view.toggleMixer")).toBe("Ctrl+Shift+M");
  });

  it("has no duplicate global shortcut assignments", () => {
    expect(getGlobalShortcutConflicts()).toEqual([]);
  });
});

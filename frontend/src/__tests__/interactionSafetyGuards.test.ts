import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import mixerWindowSource from "../MixerWindowApp.tsx?raw";
import midiWindowSource from "../MidiEditorWindowApp.tsx?raw";
import contextMenuSource from "../components/ContextMenu.tsx?raw";
import modalSource from "../components/ui/Modal/Modal.tsx?raw";
import pianoRollSource from "../components/PianoRoll.tsx?raw";
import shortcutSource from "../utils/globalShortcutDispatcher.ts?raw";
import modalGuardSource from "../utils/modalEventGuards.ts?raw";

describe("interaction safety guards", () => {
  it("lets Space stop active transport from focused inputs without stealing idle text entry", () => {
    const editableBranchIndex = shortcutSource.indexOf("if (payload.targetIsEditable)");
    const customShortcutsIndex = shortcutSource.indexOf("const customShortcuts");

    expect(editableBranchIndex).toBeGreaterThan(-1);
    expect(customShortcutsIndex).toBeGreaterThan(-1);
    expect(editableBranchIndex).toBeLessThan(customShortcutsIndex);
    expect(shortcutSource).toContain(
      "isPlainSpacebar(payload) && (state.transport.isRecording || state.transport.isPlaying)",
    );
    expect(shortcutSource).toContain('publishDetachedCommand("transport.stop")');
    expect(shortcutSource).toContain("else state.stop()");
    expect(shortcutSource).toContain("return false;");
  });

  it("captures keyboard shortcuts before focused controls stop propagation", () => {
    for (const source of [appSource, mixerWindowSource, midiWindowSource]) {
      expect(source).toContain("target instanceof HTMLSelectElement");
      expect(source).toContain("stopPropagation: () => e.stopPropagation()");
      expect(source).toContain('window.addEventListener("keydown", handleKeyDown, true)');
      expect(source).toContain('window.removeEventListener("keydown", handleKeyDown, true)');
    }
  });

  it("blocks workspace context menus while modal layers are open", () => {
    expect(modalGuardSource).toContain("installModalContextMenuLeakGuard");
    expect(modalGuardSource).toContain('window.addEventListener("contextmenu", handleContextMenu, true)');
    expect(modalGuardSource).toContain("shouldSuppressWorkspaceContextMenu(event.target)");
    expect(modalSource).toContain('data-modal-root="true"');
    expect(modalSource).toContain("onContextMenu={guardModalContextMenu}");
    expect(contextMenuSource).toContain("shouldSuppressWorkspaceContextMenu(e.target)");
    expect(appSource).toContain("installModalContextMenuLeakGuard()");
    expect(mixerWindowSource).toContain("installModalContextMenuLeakGuard()");
    expect(midiWindowSource).toContain("installModalContextMenuLeakGuard()");
  });

  it("keeps piano roll resize and modal context-menu paths guarded", () => {
    expect(pianoRollSource).toContain("Math.max(1, containerRef.current.clientWidth)");
    expect(pianoRollSource).toContain("Math.max(1, containerRef.current.clientHeight)");
    expect(pianoRollSource).toContain("shouldSuppressWorkspaceContextMenu(event.evt.target)");
    expect(pianoRollSource).toContain('data-modal-root="true"');
    expect(pianoRollSource).toContain("onContextMenu={guardModalContextMenu}");
  });
});

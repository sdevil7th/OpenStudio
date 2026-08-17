import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import mixerWindowSource from "../MixerWindowApp.tsx?raw";
import midiWindowSource from "../MidiEditorWindowApp.tsx?raw";
import pluginWindowSource from "../PluginEditorWindowApp.tsx?raw";
import contextMenuSource from "../components/ContextMenu.tsx?raw";
import modalSource from "../components/ui/Modal/Modal.tsx?raw";
import pianoRollSource from "../components/PianoRoll.tsx?raw";
import timelineSource from "../components/Timeline.tsx?raw";
import shortcutSource from "../utils/globalShortcutDispatcher.ts?raw";
import modalGuardSource from "../utils/modalEventGuards.ts?raw";

describe("interaction safety guards", () => {
  it("lets Space stop active transport from focused inputs without stealing idle text entry", () => {
    const editableBranchIndex = shortcutSource.indexOf("if (payload.targetIsEditable)");

    expect(editableBranchIndex).toBeGreaterThan(-1);
    expect(shortcutSource).toContain(
      "isPlainSpacebar(payload) && (state.transport.isRecording || state.transport.isPlaying)",
    );
    expect(shortcutSource).toContain("shouldPreserveEditableShortcut(");
    expect(shortcutSource).toContain('publishDetachedCommand("transport.stop")');
    expect(shortcutSource).toContain("else state.stop()");
    expect(shortcutSource).toContain("return false;");
  });

  it("captures keyboard shortcuts before focused controls stop propagation", () => {
    for (const source of [appSource, mixerWindowSource, midiWindowSource]) {
      expect(source).toContain("isEditableShortcutTarget(e.target)");
      expect(source).toContain("stopPropagation: () => e.stopPropagation()");
      expect(source).toContain("stopImmediatePropagation: () => e.stopImmediatePropagation()");
      expect(source).toContain('window.addEventListener("keydown", handleKeyDown, true)');
      expect(source).toContain('window.removeEventListener("keydown", handleKeyDown, true)');
    }
  });

  it("routes shortcuts from plugin controls without stealing native control keys", () => {
    expect(pluginWindowSource).toContain("NON_TEXT_PLUGIN_CONTROL_SELECTOR");
    expect(pluginWindowSource).toContain("targetIsNonTextControl");
    expect(pluginWindowSource).toContain("isEditableShortcutTarget(e.target)");
    expect(shortcutSource).toContain("shouldPreserveNonTextControlShortcut(payload)");
  });

  it("activates the docked MIDI session from editor chrome interactions", () => {
    expect(appSource).toContain('data-shortcut-context={`piano_roll:${dockedMidiEditorSession.sessionId}`}');
    expect(appSource).toContain("onPointerDownCapture={() => activateShortcutContext({");
    expect(appSource).toContain("onContextMenuCapture={() => activateShortcutContext({");
    expect(appSource).toContain("onFocusCapture={() => activateShortcutContext({");
  });

  it("wires audio copy-drag and Ctrl-click through the shared gesture path", () => {
    expect(timelineSource).toContain(
      "const copyOnDrag = shouldStartTimelineCopyDrag(ctrl, dragType, Boolean(clip.locked));",
    );
    expect(timelineSource).toContain("if (!copyOnDrag && (!isAlreadyInMultiSelection || ctrl))");
    expect(timelineSource).toContain("selectClip(clip.id, { ctrl: true });");
    expect(timelineSource).toContain("previewStartTime: clip.startTime");
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

  it("isolates modal pointer drags without blocking text selection", () => {
    expect(modalGuardSource).toContain("guardModalPointerEvent");
    expect(modalGuardSource).toContain("event.stopPropagation();");
    expect(modalGuardSource).toContain("isEditableTextTarget");
    expect(modalGuardSource).toContain("document.addEventListener(\"mousemove\", stopModalPointerBubble, false)");
    expect(modalGuardSource).toContain("nativeBridge.startWindowDrag()");
    expect(modalSource).toContain("onMouseDown={guardModalPointerEvent}");
    expect(modalSource).toContain("onPointerDown={guardModalPointerEvent}");
    expect(modalSource).toContain("onMouseMove={guardModalPointerEvent}");
    expect(modalGuardSource).toContain("event.preventDefault();");
  });

  it("keeps context submenus open while crossing into the submenu", () => {
    expect(contextMenuSource).toContain("submenuCloseTimerRef");
    expect(contextMenuSource).toContain("scheduleSubmenuClose");
    expect(contextMenuSource).toContain("onMouseEnter={clearSubmenuCloseTimer}");
    expect(contextMenuSource).toContain("left-full top-0 -ml-px");
  });

  it("keeps piano roll resize and modal context-menu paths guarded", () => {
    expect(pianoRollSource).toContain("Math.max(1, containerRef.current.clientWidth)");
    expect(pianoRollSource).toContain("Math.max(1, containerRef.current.clientHeight)");
    expect(pianoRollSource).toContain("shouldSuppressWorkspaceContextMenu(event.evt.target)");
    expect(pianoRollSource).toContain('data-modal-root="true"');
    expect(pianoRollSource).toContain("onContextMenu={guardModalContextMenu}");
  });
});

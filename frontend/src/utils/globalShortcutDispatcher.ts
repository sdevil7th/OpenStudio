import { type NativeGlobalShortcutEvent } from "../services/NativeBridge";
import { getRegisteredActions, type ActionDef } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";

let _lastSpacebarMs = 0;

export interface GlobalShortcutPayload extends NativeGlobalShortcutEvent {
  targetIsEditable?: boolean;
  preventDefault?: () => void;
}

function toPressedShortcut(payload: GlobalShortcutPayload): string | null {
  const parts: string[] = [];
  if (payload.ctrlKey || payload.metaKey) parts.push("Ctrl");
  if (payload.shiftKey) parts.push("Shift");
  if (payload.altKey) parts.push("Alt");

  let key = payload.key ?? "";
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) {
    return null;
  }

  if (key === " ") key = "Space";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "Escape") key = "Esc";
  else if (key.length === 1) key = key.toUpperCase();

  parts.push(key);
  return parts.join("+");
}

function markHandled(payload: GlobalShortcutPayload): true {
  payload.preventDefault?.();
  return true;
}

function isGlobalShortcutAction(action: ActionDef): boolean {
  return (action.shortcutScope ?? "global") === "global";
}

function shortcutMatchesAction(action: ActionDef, pressed: string): boolean {
  if (action.shortcut === pressed) return true;
  return (action.shortcutAliases ?? []).includes(pressed);
}

function findMatchingGlobalAction(pressed: string): ActionDef | undefined {
  return getRegisteredActions().find((action) => (
    Boolean(action.shortcut)
    && isGlobalShortcutAction(action)
    && shortcutMatchesAction(action, pressed)
  ));
}

export function dispatchGlobalShortcut(payload: GlobalShortcutPayload): boolean {
  if (payload.targetIsEditable) {
    return false;
  }

  if (payload.repeat) {
    return false;
  }

  const pressed = toPressedShortcut(payload);
  if (pressed) {
    const customShortcuts = useDAWStore.getState().customShortcuts;
    for (const [actionId, shortcut] of Object.entries(customShortcuts)) {
      if (shortcut === pressed) {
        const action = getRegisteredActions().find((candidate) => candidate.id === actionId);
        if (action && isGlobalShortcutAction(action) && (!action.canHandleShortcut || action.canHandleShortcut())) {
          markHandled(payload);
          action.execute();
          return true;
        }
      }
    }
  }

  const state = useDAWStore.getState();
  const key = payload.key ?? "";

  if (key === " " || payload.code === "Space") {
    markHandled(payload);
    // Debounce: the Win32 keyboard hook can deliver duplicate events for a
    // single keypress. Without debounce, both arrive before the async play()
    // sets isPlaying=true, causing double-play instead of toggle.
    const now = Date.now();
    if (now - _lastSpacebarMs < 150) return true;
    _lastSpacebarMs = now;
    if (state.transport.isRecording || state.transport.isPlaying) state.stop();
    else state.play();
    return true;
  }

  if (pressed) {
    const action = findMatchingGlobalAction(pressed);
    if (action && (!action.canHandleShortcut || action.canHandleShortcut())) {
      markHandled(payload);
      action.execute();
      return true;
    }
  }

  if (key === "Escape" || key === "Esc") {
    if (state.showPianoRoll) {
      markHandled(payload);
      state.closePianoRoll();
      return true;
    }
  }

  return false;
}

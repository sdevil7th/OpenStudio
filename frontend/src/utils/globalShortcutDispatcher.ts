import { nativeBridge, type NativeGlobalShortcutEvent } from "../services/NativeBridge";
import {
  getRegisteredAction,
  getRegisteredActions,
  type ActionDef,
  type ActionShortcutScope,
} from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import {
  dispatchActiveShortcut,
  getActiveShortcutContext,
  shouldPreserveEditableShortcut,
  shouldPreserveNonTextControlShortcut,
  shortcutExactlyMatches,
  toPressedShortcut,
  type ShortcutEventLike,
} from "./shortcutContext";
import { windowRole, windowSessionId } from "./windowEnvironment";

let _lastSpacebarMs = 0;
let _lastRecordShortcutMs = 0;

const REPEATABLE_ACTION_IDS = new Set([
  "navigate.nextTransient",
  "navigate.prevTransient",
  "edit.nudgeLeft",
  "edit.nudgeRight",
  "edit.nudgeLeftFine",
  "edit.nudgeRightFine",
  "view.zoomIn",
  "view.zoomOut",
]);

export interface GlobalShortcutPayload extends NativeGlobalShortcutEvent {
  targetIsEditable?: boolean;
  targetIsNonTextControl?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  stopImmediatePropagation?: () => void;
}

function markHandled(payload: GlobalShortcutPayload): true {
  payload.preventDefault?.();
  if (payload.stopImmediatePropagation) payload.stopImmediatePropagation();
  else payload.stopPropagation?.();
  return true;
}

function isPlainSpacebar(payload: ShortcutEventLike): boolean {
  return (payload.key === " " || payload.code === "Space")
    && !payload.ctrlKey
    && !payload.metaKey
    && !payload.altKey
    && !payload.shiftKey;
}

function effectiveActionShortcuts(action: ActionDef): string[] {
  const customShortcuts = useDAWStore.getState().customShortcuts;
  if (Object.prototype.hasOwnProperty.call(customShortcuts, action.id)) {
    const custom = customShortcuts[action.id];
    return custom ? [custom] : [];
  }

  return [action.shortcut, ...(action.shortcutAliases ?? [])].filter(
    (shortcut): shortcut is string => typeof shortcut === "string" && !shortcut.includes("("),
  );
}

function actionMatchesPressed(action: ActionDef, pressed: string): boolean {
  return effectiveActionShortcuts(action).includes(pressed);
}

export function matchesActionShortcut(
  event: ShortcutEventLike,
  actionId: string,
): boolean {
  const action = getRegisteredAction(actionId);
  const pressed = toPressedShortcut(event);
  return Boolean(action && pressed && actionMatchesPressed(action, pressed));
}

function findMatchingAction(
  pressed: string,
  scope: ActionShortcutScope,
): ActionDef | undefined {
  return getRegisteredActions().find((action) => (
    (action.shortcutScope ?? "global") === scope
    && actionMatchesPressed(action, pressed)
  ));
}

function activeRegistryScope(): ActionShortcutScope | null {
  const context = getActiveShortcutContext();
  if (context.kind === "timeline") return "timeline";
  if (context.kind === "pitch_editor") return "pitch_editor";
  if (context.kind === "piano_roll") return "piano_roll";
  return null;
}

function publishDetachedCommand(command: string, payload: Record<string, unknown> = {}): void {
  void nativeBridge.publishAppCommand({
    command,
    sessionId: windowSessionId || useDAWStore.getState().activeMidiEditorSessionId || undefined,
    ...payload,
  });
}

function shouldDebounceRecordShortcut(): boolean {
  const now = Date.now();
  if (now - _lastRecordShortcutMs < 150) return true;
  _lastRecordShortcutMs = now;
  return false;
}

function executeMatchedAction(
  action: ActionDef,
  payload: GlobalShortcutPayload,
): true {
  markHandled(payload);
  if (payload.repeat && !REPEATABLE_ACTION_IDS.has(action.id)) return true;
  if (action.canHandleShortcut && !action.canHandleShortcut()) return true;
  if (action.id === "transport.record" && shouldDebounceRecordShortcut()) return true;
  action.execute();
  return true;
}

function dispatchApplicationShortcut(
  payload: GlobalShortcutPayload,
  pressed: string | null,
): boolean {
  const state = useDAWStore.getState();

  if (isPlainSpacebar(payload) && matchesActionShortcut(payload, "transport.play")) {
    markHandled(payload);
    if (payload.repeat) return true;
    const now = Date.now();
    if (now - _lastSpacebarMs < 150) return true;
    _lastSpacebarMs = now;
    if (windowRole !== "main") publishDetachedCommand("transport.toggle");
    else if (state.transport.isRecording || state.transport.isPlaying) state.stop();
    else state.play();
    return true;
  }

  if (!pressed) return false;

  const action = findMatchingAction(pressed, "global");
  if (windowRole !== "main" && action?.id === "transport.play") {
    markHandled(payload);
    if (!payload.repeat) publishDetachedCommand("transport.toggle");
    return true;
  }
  if (windowRole !== "main" && action?.id === "transport.record") {
    markHandled(payload);
    if (payload.repeat || shouldDebounceRecordShortcut()) return true;
    publishDetachedCommand("transport.record");
    return true;
  }
  return action ? executeMatchedAction(action, payload) : false;
}

export function dispatchGlobalShortcut(payload: GlobalShortcutPayload): boolean {
  const pressed = toPressedShortcut(payload);
  const state = useDAWStore.getState();
  const registeredApplicationAction = pressed
    ? findMatchingAction(pressed, "global")
    : undefined;

  if (payload.targetIsNonTextControl && shouldPreserveNonTextControlShortcut(payload)) {
    return false;
  }

  if (payload.targetIsEditable) {
    if (isPlainSpacebar(payload) && (state.transport.isRecording || state.transport.isPlaying)) {
      markHandled(payload);
      if (payload.repeat) return true;
      const now = Date.now();
      if (now - _lastSpacebarMs < 150) return true;
      _lastSpacebarMs = now;
      if (windowRole !== "main") publishDetachedCommand("transport.stop");
      else state.stop();
      return true;
    }

    if (shouldPreserveEditableShortcut(payload, Boolean(registeredApplicationAction))) return false;
    return dispatchApplicationShortcut(payload, pressed);
  }

  // Native plugin-window payloads have no trustworthy DOM edit owner.
  if (payload.source !== "pluginWindow") {
    const result = dispatchActiveShortcut(payload);
    if (result !== "unmatched") return markHandled(payload);

    const scope = activeRegistryScope();
    const scopedAction = pressed && scope ? findMatchingAction(pressed, scope) : undefined;
    if (scopedAction) return executeMatchedAction(scopedAction, payload);
  }

  return dispatchApplicationShortcut(payload, pressed);
}

export function isExactShortcut(
  payload: ShortcutEventLike,
  ...shortcuts: readonly string[]
): boolean {
  return shortcutExactlyMatches(payload, ...shortcuts);
}

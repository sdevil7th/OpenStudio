import type { GlobalShortcutPayload } from "./globalShortcutDispatcher";
import {
  isEditableShortcutTarget,
  isNonTextControlShortcutTarget,
} from "./shortcutContext";

export interface DOMShortcutPayloadOptions {
  source?: string;
  targetIsEditable?: boolean;
  targetIsNonTextControl?: boolean;
}

export interface BrowserShortcutFocusSnapshot {
  documentFocused: boolean;
  windowFocused: boolean;
  visibilityState: DocumentVisibilityState | string;
}

/**
 * Convert a browser KeyboardEvent without dropping matching-critical fields.
 *
 * AltGraph cannot be reconstructed from ctrlKey + altKey: layouts that use
 * AltGraph commonly report both flags. Keep the event-backed modifier query so
 * those text-entry chords never masquerade as application Ctrl+Alt shortcuts.
 */
export function toGlobalShortcutPayload(
  event: KeyboardEvent,
  options: DOMShortcutPayloadOptions = {},
): GlobalShortcutPayload {
  let composedPath: readonly EventTarget[] = [];
  try {
    composedPath = typeof event.composedPath === "function"
      ? event.composedPath()
      : [];
  } catch {
    // A synthetic/host event may expose a throwing composedPath. Its direct
    // target remains a safe fallback for ownership classification.
  }
  const modifierState = typeof event.getModifierState === "function"
    ? (modifier: string) => event.getModifierState(modifier)
    : undefined;

  return {
    key: event.key,
    code: event.code,
    location: event.location,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    // keyCode 229 is the legacy WebView/IME composition signal. Keeping it as
    // a fallback prevents a partially populated event from firing a command.
    isComposing: event.isComposing || event.keyCode === 229,
    getModifierState: modifierState,
    source: options.source ?? "browser",
    targetIsEditable: options.targetIsEditable
      ?? isEditableShortcutTarget(event.target, composedPath),
    targetIsNonTextControl: options.targetIsNonTextControl
      ?? isNonTextControlShortcutTarget(event.target, composedPath),
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    stopImmediatePropagation: () => event.stopImmediatePropagation(),
  };
}

/** Detached WebViews may own shortcuts only while visibly focused by the OS. */
export function browserShortcutWindowIsActive({
  documentFocused,
  windowFocused,
  visibilityState,
}: BrowserShortcutFocusSnapshot): boolean {
  return documentFocused && windowFocused && visibilityState === "visible";
}

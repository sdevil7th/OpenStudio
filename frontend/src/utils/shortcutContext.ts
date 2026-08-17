import { canonicalizeShortcutEvent, isMac } from "./platform";

export type ShortcutHandlerResult = "handled" | "claimed_noop" | "unmatched";

export type EditShortcutContext =
  | { kind: "application" }
  | { kind: "timeline" }
  | { kind: "pitch_editor" }
  | { kind: "piano_roll"; sessionId: string };

export interface ShortcutEventLike {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

export type ShortcutSurfaceHandler = (
  event: ShortcutEventLike,
) => ShortcutHandlerResult;

const APPLICATION_CONTEXT: EditShortcutContext = { kind: "application" };
let activeContext: EditShortcutContext = APPLICATION_CONTEXT;
const contextListeners = new Set<() => void>();
const handlers = new Map<
  string,
  { token: symbol; handler: ShortcutSurfaceHandler; fallback: EditShortcutContext }
>();

export function shortcutContextKey(context: EditShortcutContext): string {
  return context.kind === "piano_roll"
    ? `piano_roll:${context.sessionId}`
    : context.kind;
}

export function getActiveShortcutContext(): EditShortcutContext {
  return activeContext;
}

export function subscribeShortcutContext(listener: () => void): () => void {
  contextListeners.add(listener);
  return () => contextListeners.delete(listener);
}

export function activateShortcutContext(context: EditShortcutContext): void {
  if (shortcutContextKey(activeContext) === shortcutContextKey(context)) return;
  activeContext = context;
  for (const listener of contextListeners) listener();
}

export function registerShortcutSurface(
  context: EditShortcutContext,
  handler: ShortcutSurfaceHandler,
  fallback: EditShortcutContext = APPLICATION_CONTEXT,
): () => void {
  const key = shortcutContextKey(context);
  const token = Symbol(key);
  handlers.set(key, { token, handler, fallback });

  return () => {
    const registered = handlers.get(key);
    if (!registered || registered.token !== token) return;
    handlers.delete(key);
    if (shortcutContextKey(activeContext) === key) {
      activateShortcutContext(registered.fallback);
    }
  };
}

export function dispatchActiveShortcut(
  event: ShortcutEventLike,
): ShortcutHandlerResult {
  const registered = handlers.get(shortcutContextKey(activeContext));
  return registered?.handler(event) ?? "unmatched";
}

/** Canonical shortcut spelling used by actionRegistry (for example Ctrl+Shift+Z). */
export function toPressedShortcut(event: ShortcutEventLike): string | null {
  return canonicalizeShortcutEvent(event, isMac ? "macos" : "other");
}

export function shortcutExactlyMatches(
  event: ShortcutEventLike,
  ...shortcuts: readonly string[]
): boolean {
  const pressed = toPressedShortcut(event);
  return pressed !== null && shortcuts.includes(pressed);
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(
    "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox']",
  ));
}

/**
 * Native text/control editing gets priority over surface shortcuts. Modifier
 * chords without native editing meaning (for example Ctrl+S) may fall through
 * to application-global actions.
 */
export function shouldPreserveEditableShortcut(
  event: ShortcutEventLike,
  hasRegisteredApplicationShortcut = false,
): boolean {
  const key = event.key ?? "";
  const hasCommandModifier = Boolean(event.ctrlKey || event.metaKey || event.altKey);

  if (!hasCommandModifier) {
    return !/^F\d{1,2}$/i.test(key);
  }

  if (shortcutExactlyMatches(
    event,
    "Ctrl+A",
    "Ctrl+C",
    "Ctrl+X",
    "Ctrl+V",
    "Ctrl+Z",
    "Ctrl+Y",
    "Ctrl+Shift+Z",
  )) {
    return true;
  }

  if ([
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Backspace",
    "Delete",
  ].includes(key)) {
    return true;
  }

  if ([
    "Enter",
    "Escape",
    "Tab",
  ].includes(key)) {
    return !hasRegisteredApplicationShortcut;
  }

  return false;
}

/** Native interactions that should stay with a focused non-text control. */
export function shouldPreserveNonTextControlShortcut(event: ShortcutEventLike): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return [
    " ",
    "Enter",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ].includes(event.key ?? "");
}

export function resetShortcutContextForTests(): void {
  handlers.clear();
  activeContext = APPLICATION_CONTEXT;
  for (const listener of contextListeners) listener();
}

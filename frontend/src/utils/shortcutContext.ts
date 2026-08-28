import {
  canonicalizeShortcutEvent,
  getShortcutPlatform,
  shortcutMatchesEvent,
  type ShortcutCanonicalizationOptions,
  type ShortcutKeyEventLike,
  type ShortcutPlatform,
} from "./platform";

export type ShortcutHandlerResult = "handled" | "claimed_noop" | "unmatched";

type BasicShortcutContextKind =
  | "application"
  | "timeline"
  | "timeline_ruler"
  | "track_control_panel"
  | "mixer"
  | "pitch_editor"
  | "automation"
  | "browser"
  | "modal";

export type EditShortcutContext =
  | { kind: BasicShortcutContextKind }
  | { kind: "piano_roll"; sessionId: string }
  | { kind: "plugin"; sessionId?: string };

export interface ShortcutEventLike extends ShortcutKeyEventLike {}

export interface PressedShortcutOptions extends ShortcutCanonicalizationOptions {
  platform?: ShortcutPlatform;
}

export type ShortcutSurfaceHandler = (
  event: ShortcutEventLike,
) => ShortcutHandlerResult;

interface ShortcutSurfaceRegistration {
  token: symbol;
  handler: ShortcutSurfaceHandler;
  fallback: EditShortcutContext;
}

const APPLICATION_CONTEXT: EditShortcutContext = { kind: "application" };
let activeContext: EditShortcutContext = APPLICATION_CONTEXT;
const contextListeners = new Set<() => void>();
// A stack preserves an existing owner if a modal or replacement surface
// temporarily registers the same context key.
const handlers = new Map<string, ShortcutSurfaceRegistration[]>();

function currentPlatform(): ShortcutPlatform {
  return getShortcutPlatform();
}

export function shortcutContextKey(context: EditShortcutContext): string {
  return "sessionId" in context && context.sessionId
    ? `${context.kind}:${context.sessionId}`
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
  const registration = { token, handler, fallback };
  const stack = handlers.get(key) ?? [];
  stack.push(registration);
  handlers.set(key, stack);

  return () => {
    const registrations = handlers.get(key);
    if (!registrations) return;
    const index = registrations.findIndex((item) => item.token === token);
    if (index < 0) return;
    const wasTopRegistration = index === registrations.length - 1;
    registrations.splice(index, 1);

    if (registrations.length === 0) handlers.delete(key);
    if (
      wasTopRegistration
      && registrations.length === 0
      && shortcutContextKey(activeContext) === key
    ) {
      activateShortcutContext(registration.fallback);
    }
  };
}

export function dispatchActiveShortcut(
  event: ShortcutEventLike,
): ShortcutHandlerResult {
  const registrations = handlers.get(shortcutContextKey(activeContext));
  const activeRegistration = registrations?.[registrations.length - 1];
  return activeRegistration?.handler(event) ?? "unmatched";
}

/** Canonical shortcut spelling used by the current action registry. */
export function toPressedShortcut(
  event: ShortcutEventLike,
  options: PressedShortcutOptions = {},
): string | null {
  const { platform = currentPlatform(), ...canonicalizationOptions } = options;
  return canonicalizeShortcutEvent(event, platform, canonicalizationOptions);
}

export function shortcutExactlyMatchesForPlatform(
  event: ShortcutEventLike,
  platform: ShortcutPlatform,
  ...shortcuts: readonly string[]
): boolean {
  return shortcuts.some((shortcut) => shortcutMatchesEvent(event, shortcut, platform));
}

export function shortcutExactlyMatches(
  event: ShortcutEventLike,
  ...shortcuts: readonly string[]
): boolean {
  return shortcutExactlyMatchesForPlatform(event, currentPlatform(), ...shortcuts);
}

interface ClosestCapableTarget {
  closest: (selectors: string) => unknown;
}

function hasClosest(target: EventTarget | null): target is EventTarget & ClosestCapableTarget {
  return target !== null
    && typeof (target as Partial<ClosestCapableTarget>).closest === "function";
}

const EDITABLE_SHORTCUT_TARGET_SELECTOR = [
  "textarea",
  "select",
  "input:not([type])",
  "input[type='text']",
  "input[type='search']",
  "input[type='email']",
  "input[type='url']",
  "input[type='tel']",
  "input[type='password']",
  "input[type='number']",
  "input[type='date']",
  "input[type='datetime-local']",
  "input[type='month']",
  "input[type='time']",
  "input[type='week']",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
].join(", ");

const NON_TEXT_CONTROL_SHORTCUT_TARGET_SELECTOR = [
  "button",
  "summary",
  "a[href]",
  "input[type='button']",
  "input[type='checkbox']",
  "input[type='color']",
  "input[type='file']",
  "input[type='image']",
  "input[type='radio']",
  "input[type='range']",
  "input[type='reset']",
  "input[type='submit']",
  "[role='button']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
].join(", ");

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return hasClosest(target)
    && Boolean(target.closest(EDITABLE_SHORTCUT_TARGET_SELECTOR));
}

/**
 * Detect focused controls whose native Space/Enter/arrow behavior takes
 * precedence over DAW surface shortcuts. Kept separate from editable text so
 * plain letter commands may still reach the DAW while a button or slider owns
 * focus.
 */
export function isNonTextControlShortcutTarget(target: EventTarget | null): boolean {
  return hasClosest(target)
    && Boolean(target.closest(NON_TEXT_CONTROL_SHORTCUT_TARGET_SELECTOR));
}

function eventUsesAltGraph(event: ShortcutEventLike): boolean {
  if (event.key === "AltGraph") return true;
  try {
    return event.getModifierState?.("AltGraph") === true;
  } catch {
    return false;
  }
}

/**
 * Native text/control editing gets priority over surface shortcuts. Modifier
 * chords without native editing meaning (for example Ctrl+S) may fall through
 * to application-global actions.
 */
export function shouldPreserveEditableShortcut(
  event: ShortcutEventLike,
  hasRegisteredApplicationShortcut = false,
  platform: ShortcutPlatform = currentPlatform(),
): boolean {
  if (event.isComposing || eventUsesAltGraph(event)) return true;

  const key = event.key ?? "";
  const hasCommandModifier = Boolean(event.ctrlKey || event.metaKey || event.altKey);

  if (!hasCommandModifier) {
    return !/^F\d{1,2}$/i.test(key);
  }

  if (shortcutExactlyMatchesForPlatform(
    event,
    platform,
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

  // Cocoa text fields use physical Control chords for cursor/edit operations.
  if (
    platform === "macos"
    && event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && /^[ABDEFHKNPTUVWY]$/i.test(key)
  ) {
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

  if (["Enter", "Escape", "Tab"].includes(key)) {
    return !hasRegisteredApplicationShortcut;
  }

  // Option is frequently used to compose text on macOS. Only an exact known
  // application binding may take it away from the editor.
  if (platform === "macos" && event.altKey) {
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
    "Tab",
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

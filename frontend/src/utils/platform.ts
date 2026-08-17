/**
 * Platform detection and keyboard shortcut formatting utilities.
 *
 * Shortcut strings throughout the codebase use Windows-style canonical names:
 *   "Ctrl+Z", "Ctrl+Shift+Z", "Alt+Enter", "Ctrl+Alt+R"
 *
 * macOS modifier mapping:
 *   Windows Ctrl  → macOS Cmd  (metaKey)
 *   Windows Alt   → macOS Ctrl (ctrlKey)
 *   Shift stays Shift
 *
 * This file handles both matching (dispatcher) and display formatting.
 */

export const isMac: boolean =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
    /Mac/.test(navigator.userAgent));

export type ShortcutPlatform = "macos" | "other";

export interface ShortcutKeyEventLike {
  key?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * Convert a physical key event to the canonical shortcut spelling used by
 * actionRegistry. macOS Option is intentionally not aliased to canonical Alt:
 * canonical Alt means physical Control on macOS, and treating both keys as the
 * same modifier makes exact shortcut matching impossible.
 */
export function canonicalizeShortcutEvent(
  event: ShortcutKeyEventLike,
  platform: ShortcutPlatform,
): string | null {
  if (platform === "macos" && event.altKey) return null;

  const parts: string[] = [];
  if (platform === "macos") {
    if (event.metaKey) parts.push("Ctrl");
    if (event.ctrlKey) parts.push("Alt");
  } else {
    if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
  }
  if (event.shiftKey) parts.push("Shift");

  let key = event.key ?? "";
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (key === " ") key = "Space";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "Escape") key = "Esc";
  else if (key.length === 1) key = key.toUpperCase();

  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}

/**
 * Format a canonical shortcut string for display on the current platform.
 *
 * Examples on Windows:  "Ctrl+Z" → "Ctrl+Z",  "Alt+Enter" → "Alt+Enter"
 * Examples on macOS:    "Ctrl+Z" → "Cmd+Z",   "Alt+Enter" → "Ctrl+Enter",
 *                       "Ctrl+Alt+R" → "Cmd+Ctrl+R", "Ctrl+Shift+Z" → "Cmd+Shift+Z"
 */
export function formatShortcut(shortcut: string | undefined): string {
  if (!shortcut) return "";
  // Skip descriptive pseudo-shortcuts like "Space (while playing)"
  if (shortcut.includes("(")) return shortcut;

  if (!isMac) return shortcut;

  // Parse canonical parts: everything before the last segment is a modifier
  const segments = shortcut.split("+");
  const key = segments[segments.length - 1];
  const mods = segments.slice(0, -1);

  const mapped: string[] = [];
  for (const mod of mods) {
    if (mod === "Ctrl") mapped.push("Cmd");
    else if (mod === "Alt") mapped.push("Ctrl");
    else mapped.push(mod); // Shift stays Shift
  }
  mapped.push(key);
  return mapped.join("+");
}

/**
 * Given a raw KeyboardEvent, build the canonical shortcut string used in
 * actionRegistry ("Ctrl+Z", "Alt+Enter", etc.).
 *
 * On macOS:
 *   metaKey (Cmd)  → "Ctrl"
 *   ctrlKey (Ctrl) → "Alt"
 *   altKey (Option) is unsupported so it cannot alias physical Control
 *
 * On Windows/Linux:
 *   ctrlKey | metaKey → "Ctrl"
 *   altKey            → "Alt"
 */
export function keyEventToCanonicalShortcut(e: KeyboardEvent): string {
  return canonicalizeShortcutEvent(e, isMac ? "macos" : "other") ?? "";
}

/**
 * Returns true if the event represents the platform's primary modifier key.
 * On Mac = Cmd (metaKey). On Windows = Ctrl.
 * Use this instead of bare `e.ctrlKey` in keyboard handlers so they work on both platforms.
 */
export function isPrimaryModifier(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * Returns true if the event represents the platform's secondary modifier key.
 * On Mac = Ctrl (ctrlKey). On Windows = Alt.
 * This is the "Alt" modifier in canonical shortcut strings.
 */
export function isSecondaryModifier(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.ctrlKey : e.altKey;
}

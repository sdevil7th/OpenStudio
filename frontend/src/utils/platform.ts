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
 *   altKey (Option) → not mapped (ignored)
 *
 * On Windows/Linux:
 *   ctrlKey | metaKey → "Ctrl"
 *   altKey            → "Alt"
 */
export function keyEventToCanonicalShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];

  if (isMac) {
    if (e.metaKey) parts.push("Ctrl"); // Cmd → Ctrl
    if (e.ctrlKey) parts.push("Alt"); // Ctrl → Alt
  } else {
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
  }
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";
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

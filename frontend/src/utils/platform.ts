/**
 * Platform detection and keyboard shortcut normalization utilities.
 *
 * Existing shortcut strings use a legacy, portable vocabulary:
 *   Ctrl = the primary modifier (Control on Windows/Linux, Command on macOS)
 *   Alt  = the secondary modifier (Alt on Windows/Linux, Control on macOS)
 *
 * That vocabulary remains supported so existing projects and custom bindings do
 * not change meaning. New profiles may use explicit physical modifiers:
 *   Control, Command, Alt, Option, Meta, AltGraph, Shift
 *
 * Label bindings use the produced key (for example `Ctrl+Z`). Physical-position
 * bindings use `Code:` (for example `Command+Code:KeyZ`). Numpad keys are always
 * kept distinct from their top-row equivalents.
 */

export const isMac: boolean =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
    /Mac/.test(navigator.userAgent));

export type ShortcutPlatform = "macos" | "windows" | "linux" | "other";
export type ShortcutKeyMode = "label" | "physical";
export type ShortcutModifierStyle = "legacy" | "physical";

export interface ShortcutCanonicalizationOptions {
  /** Match the produced key label or the physical KeyboardEvent.code position. */
  keyMode?: ShortcutKeyMode;
  /** Emit the backwards-compatible modifier names or explicit physical names. */
  modifierStyle?: ShortcutModifierStyle;
}

export interface ShortcutKeyEventLike {
  key?: string;
  code?: string;
  location?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  getModifierState?: (keyArg: string) => boolean;
}

export type ShortcutBindingInput =
  | string
  | readonly (string | null | undefined)[]
  | null
  | undefined;

const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "OS",
  "Shift",
]);

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  alt: "Alt",
  altgraph: "AltGraph",
  cmd: "Command",
  command: "Command",
  control: "Control",
  ctrl: "Ctrl",
  meta: "Meta",
  option: "Option",
  opt: "Option",
  os: "Meta",
  shift: "Shift",
  super: "Meta",
  win: "Meta",
  windows: "Meta",
};

const MODIFIER_ORDER = [
  "Ctrl",
  "Control",
  "Command",
  "Alt",
  "Option",
  "Meta",
  "AltGraph",
  "Shift",
] as const;

const NAMED_KEY_ALIASES: Readonly<Record<string, string>> = {
  " ": "Space",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  del: "Delete",
  esc: "Esc",
  escape: "Esc",
  pgdn: "PageDown",
  pgup: "PageUp",
  return: "Enter",
  space: "Space",
  spacebar: "Space",
};

const CANONICAL_NAMED_KEYS: Readonly<Record<string, string>> = {
  backspace: "Backspace",
  capslock: "CapsLock",
  contextmenu: "ContextMenu",
  delete: "Delete",
  down: "Down",
  end: "End",
  enter: "Enter",
  home: "Home",
  insert: "Insert",
  left: "Left",
  numlock: "NumLock",
  pagedown: "PageDown",
  pageup: "PageUp",
  pause: "Pause",
  printscreen: "PrintScreen",
  right: "Right",
  scrolllock: "ScrollLock",
  tab: "Tab",
  up: "Up",
};

const NUMPAD_KEY_BY_CODE: Readonly<Record<string, string>> = {
  NumpadAdd: "NumpadAdd",
  NumpadComma: "NumpadComma",
  NumpadDecimal: "NumpadDecimal",
  NumpadDivide: "NumpadDivide",
  NumpadEnter: "NumpadEnter",
  NumpadEqual: "NumpadEqual",
  NumpadMultiply: "NumpadMultiply",
  NumpadSubtract: "NumpadSubtract",
};

export function getShortcutPlatform(): ShortcutPlatform {
  if (isMac) return "macos";
  if (typeof navigator === "undefined") return "other";
  const identity = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  if (/Win/i.test(identity)) return "windows";
  if (/Linux|X11/i.test(identity)) return "linux";
  return "other";
}

function isMacPlatform(platform: ShortcutPlatform): boolean {
  return platform === "macos";
}

function hasAltGraph(event: ShortcutKeyEventLike): boolean {
  if (event.key === "AltGraph") return true;
  try {
    return event.getModifierState?.("AltGraph") === true;
  } catch {
    return false;
  }
}

function isUnusableKeyEvent(event: ShortcutKeyEventLike): boolean {
  const key = event.key ?? "";
  return event.isComposing === true
    || MODIFIER_KEYS.has(key)
    || ["Dead", "Process", "Unidentified"].includes(key);
}

function canonicalNumpadKey(code: string | undefined): string | null {
  if (!code?.startsWith("Numpad")) return null;
  if (/^Numpad\d$/.test(code)) return code;
  return NUMPAD_KEY_BY_CODE[code] ?? code;
}

function canonicalNumpadKeyFromLocation(event: ShortcutKeyEventLike): string | null {
  // DOM_KEY_LOCATION_NUMPAD = 3. Native bridge events may omit location, so
  // code remains the preferred and unambiguous signal.
  if (event.location !== 3) return null;
  const key = event.key ?? "";
  if (/^\d$/.test(key)) return `Numpad${key}`;
  const byKey: Readonly<Record<string, string>> = {
    "+": "NumpadAdd",
    ",": "NumpadComma",
    ".": "NumpadDecimal",
    "/": "NumpadDivide",
    Enter: "NumpadEnter",
    "=": "NumpadEqual",
    "*": "NumpadMultiply",
    "-": "NumpadSubtract",
  };
  return byKey[key] ?? null;
}

function normalizeCode(code: string): string {
  const lower = code.toLowerCase();
  if (/^key[a-z]$/.test(lower)) return `Key${lower.slice(-1).toUpperCase()}`;
  if (/^digit\d$/.test(lower)) return `Digit${lower.slice(-1)}`;
  if (/^numpad\d$/.test(lower)) return `Numpad${lower.slice(-1)}`;

  const knownCodes: Readonly<Record<string, string>> = {
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    backquote: "Backquote",
    backslash: "Backslash",
    backspace: "Backspace",
    bracketleft: "BracketLeft",
    bracketright: "BracketRight",
    comma: "Comma",
    delete: "Delete",
    end: "End",
    enter: "Enter",
    equal: "Equal",
    escape: "Escape",
    home: "Home",
    insert: "Insert",
    intlbackslash: "IntlBackslash",
    intlro: "IntlRo",
    intlyen: "IntlYen",
    minus: "Minus",
    numpadadd: "NumpadAdd",
    numpadcomma: "NumpadComma",
    numpaddecimal: "NumpadDecimal",
    numpaddivide: "NumpadDivide",
    numpadenter: "NumpadEnter",
    numpadequal: "NumpadEqual",
    numpadmultiply: "NumpadMultiply",
    numpadsubtract: "NumpadSubtract",
    pagedown: "PageDown",
    pageup: "PageUp",
    period: "Period",
    quote: "Quote",
    semicolon: "Semicolon",
    slash: "Slash",
    space: "Space",
    tab: "Tab",
  };
  return knownCodes[lower]
    ?? canonicalNumpadKey(code)
    ?? (/^f\d{1,2}$/i.test(code) ? code.toUpperCase() : code);
}

function canonicalLabelKey(event: ShortcutKeyEventLike): string | null {
  const numpadKey = canonicalNumpadKey(event.code)
    ?? canonicalNumpadKeyFromLocation(event);
  if (numpadKey) return numpadKey;

  const rawKey = event.key ?? "";
  if (!rawKey || MODIFIER_KEYS.has(rawKey)) return null;
  if (["Dead", "Process", "Unidentified"].includes(rawKey)) return null;

  const alias = NAMED_KEY_ALIASES[rawKey.toLowerCase()]
    ?? NAMED_KEY_ALIASES[rawKey];
  if (alias) return alias;
  const named = CANONICAL_NAMED_KEYS[rawKey.toLowerCase()];
  if (named) return named;
  if (/^f\d{1,2}$/i.test(rawKey)) return rawKey.toUpperCase();
  if (rawKey.length === 1) return rawKey.toUpperCase();
  return rawKey;
}

function canonicalPhysicalKey(event: ShortcutKeyEventLike): string | null {
  const code = event.code ?? "";
  if (!code || MODIFIER_KEYS.has(event.key ?? "")) return null;
  if (/^(Alt|Control|Meta|Shift)(Left|Right)$/.test(code)) return null;
  return `Code:${normalizeCode(code)}`;
}

function canonicalKey(
  event: ShortcutKeyEventLike,
  keyMode: ShortcutKeyMode,
): string | null {
  return keyMode === "physical"
    ? canonicalPhysicalKey(event)
    : canonicalLabelKey(event);
}

function canonicalModifiers(
  event: ShortcutKeyEventLike,
  platform: ShortcutPlatform,
  style: ShortcutModifierStyle,
): string[] {
  if (hasAltGraph(event)) {
    return ["AltGraph", ...(event.shiftKey ? ["Shift"] : [])];
  }

  const parts: string[] = [];
  if (style === "legacy") {
    if (isMacPlatform(platform)) {
      if (event.metaKey) parts.push("Ctrl");
      if (event.ctrlKey) parts.push("Alt");
      if (event.altKey) parts.push("Option");
    } else {
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.metaKey) parts.push("Meta");
    }
  } else if (isMacPlatform(platform)) {
    if (event.ctrlKey) parts.push("Control");
    if (event.metaKey) parts.push("Command");
    if (event.altKey) parts.push("Option");
  } else {
    if (event.ctrlKey) parts.push("Control");
    if (event.altKey) parts.push("Alt");
    if (event.metaKey) parts.push("Meta");
  }
  if (event.shiftKey) parts.push("Shift");
  return parts;
}

/**
 * Convert a key event to a stable shortcut string.
 *
 * The default output deliberately uses the legacy modifier vocabulary and key
 * labels. Callers that persist DAW-profile bindings can request physical
 * modifiers and/or `Code:` key positions explicitly.
 */
export function canonicalizeShortcutEvent(
  event: ShortcutKeyEventLike,
  platform: ShortcutPlatform,
  options: ShortcutCanonicalizationOptions = {},
): string | null {
  if (isUnusableKeyEvent(event)) return null;
  const key = canonicalKey(event, options.keyMode ?? "label");
  if (!key) return null;
  const modifiers = canonicalModifiers(
    event,
    platform,
    options.modifierStyle ?? "legacy",
  );
  return [...modifiers, key].join("+");
}

interface ParsedShortcutBinding {
  modifiers: string[];
  key: string;
}

function parseShortcutBinding(shortcut: string): ParsedShortcutBinding | null {
  const trimmed = shortcut.trim();
  if (!trimmed || trimmed.includes("(")) return null;

  const segments = trimmed.split("+");
  const modifiers: string[] = [];
  let index = 0;
  while (index < segments.length) {
    const modifier = MODIFIER_ALIASES[segments[index].trim().toLowerCase()];
    if (!modifier) break;
    modifiers.push(modifier);
    index += 1;
  }

  if (index >= segments.length) return null;
  // Joining the remaining segments preserves the plus key: Ctrl++ => "+".
  const rawKey = segments.slice(index).join("+").trim();
  if (!rawKey) return null;

  const modifierSet = new Set(modifiers);
  if (modifierSet.size !== modifiers.length) return null;
  return { modifiers: [...modifierSet], key: rawKey };
}

function normalizeBindingKey(rawKey: string): string | null {
  if (/^code:/i.test(rawKey)) {
    const code = rawKey.slice(rawKey.indexOf(":") + 1).trim();
    return code ? `Code:${normalizeCode(code)}` : null;
  }
  if (/^key:/i.test(rawKey)) {
    const label = rawKey.slice(rawKey.indexOf(":") + 1);
    const normalized = canonicalLabelKey({ key: label });
    return normalized ? `Key:${normalized}` : null;
  }

  if (/^numpad/i.test(rawKey)) {
    return normalizeCode(rawKey);
  }
  return canonicalLabelKey({ key: rawKey });
}

/** Normalize aliases/casing and modifier order without changing semantics. */
export function normalizeShortcutBinding(shortcut: string): string | null {
  const parsed = parseShortcutBinding(shortcut);
  if (!parsed) return null;
  const key = normalizeBindingKey(parsed.key);
  if (!key) return null;

  const modifierSet = new Set(parsed.modifiers);
  const modifiers = MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier));
  return [...modifiers, key].join("+");
}

/**
 * Canonical physical event signature for collision checks on one platform.
 * Returns null when a binding cannot be produced on that platform (for
 * example, explicit Option on Windows or both names of the same physical key).
 */
export function shortcutBindingEventSignature(
  shortcut: string,
  platform: ShortcutPlatform,
): string | null {
  const normalized = normalizeShortcutBinding(shortcut);
  if (!normalized) return null;
  const parsed = parseShortcutBinding(normalized);
  if (!parsed) return null;

  const physicalModifiers: string[] = [];
  for (const modifier of parsed.modifiers) {
    let physical: string | null;
    if (platform === "macos") {
      if (modifier === "Ctrl" || modifier === "Command") physical = "Meta";
      else if (modifier === "Alt" || modifier === "Control") physical = "Control";
      else if (modifier === "Option") physical = "Alt";
      else if (modifier === "Shift" || modifier === "AltGraph") physical = modifier;
      else physical = null;
    } else {
      if (modifier === "Ctrl" || modifier === "Control") physical = "Control";
      else if (modifier === "Alt" || modifier === "Meta") physical = modifier;
      else if (modifier === "Shift" || modifier === "AltGraph") physical = modifier;
      else physical = null;
    }
    if (!physical || physicalModifiers.includes(physical)) return null;
    physicalModifiers.push(physical);
  }

  const order = ["Control", "Meta", "Alt", "AltGraph", "Shift"];
  physicalModifiers.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  const key = parsed.key.replace(/^Code:Key([A-Z])$/, "$1").replace(/^Key:([A-Z])$/, "$1");
  return [...physicalModifiers, key].join("+").toLowerCase();
}

/**
 * Normalize one or many bindings and remove duplicates. This accepts arrays so
 * the dispatcher is ready for multi-binding profile storage without requiring
 * an immediate Zustand schema migration.
 */
export function normalizeShortcutBindings(input: ShortcutBindingInput): string[] {
  const values = Array.isArray(input) ? input : [input];
  const normalized = values
    .filter((value): value is string => typeof value === "string")
    .map(normalizeShortcutBinding)
    .filter((value): value is string => value !== null);
  return [...new Set(normalized)];
}

function modifierAlternatives(
  event: ShortcutKeyEventLike,
  platform: ShortcutPlatform,
): string[][] {
  if (hasAltGraph(event)) {
    return [
      ["AltGraph"],
      ...(event.shiftKey ? [["Shift"]] : []),
    ];
  }

  const alternatives: string[][] = [];
  if (isMacPlatform(platform)) {
    if (event.ctrlKey) alternatives.push(["Alt", "Control"]);
    if (event.metaKey) alternatives.push(["Ctrl", "Command"]);
    if (event.altKey) alternatives.push(["Option"]);
  } else {
    if (event.ctrlKey) alternatives.push(["Ctrl", "Control"]);
    if (event.altKey) alternatives.push(["Alt"]);
    if (event.metaKey) alternatives.push(["Meta"]);
  }
  if (event.shiftKey) alternatives.push(["Shift"]);
  return alternatives;
}

function modifierCombinations(alternatives: readonly string[][]): string[][] {
  return alternatives.reduce<string[][]>(
    (combinations, names) => combinations.flatMap(
      (combination) => names.map((name) => [...combination, name]),
    ),
    [[]],
  );
}

/**
 * Return every valid spelling for an event. The aliases are alternatives, not
 * additional held modifiers: Command+Z can match either legacy Ctrl+Z or the
 * explicit Command+Z, but never Ctrl+Command+Z.
 */
export function shortcutEventCandidates(
  event: ShortcutKeyEventLike,
  platform: ShortcutPlatform,
): string[] {
  if (isUnusableKeyEvent(event)) return [];
  const labelKey = canonicalLabelKey(event);
  const physicalKey = canonicalPhysicalKey(event);
  const explicitLabelKey = labelKey ? `Key:${labelKey}` : null;
  const keys = [...new Set([labelKey, explicitLabelKey, physicalKey].filter(
    (key): key is string => key !== null,
  ))];
  if (keys.length === 0) return [];

  const candidates: string[] = [];
  for (const modifiers of modifierCombinations(modifierAlternatives(event, platform))) {
    for (const key of keys) {
      const normalized = normalizeShortcutBinding([...modifiers, key].join("+"));
      if (normalized) candidates.push(normalized);
    }
  }
  return [...new Set(candidates)];
}

/** Exact modifier/key matching for legacy, explicit, label, and physical bindings. */
export function shortcutMatchesEvent(
  event: ShortcutKeyEventLike,
  shortcut: string,
  platform: ShortcutPlatform,
): boolean {
  const binding = normalizeShortcutBinding(shortcut);
  return binding !== null && shortcutEventCandidates(event, platform).includes(binding);
}

function displayKey(key: string): string {
  if (key.startsWith("Code:")) return `Physical ${key.slice(5)}`;
  if (key.startsWith("Key:")) return key.slice(4);
  return key;
}

export function formatShortcutForPlatform(
  shortcut: string | undefined,
  platform: ShortcutPlatform,
): string {
  if (!shortcut || shortcut.includes("(")) return shortcut ?? "";
  const normalized = normalizeShortcutBinding(shortcut);
  if (!normalized) return shortcut;
  const parsed = parseShortcutBinding(normalized);
  if (!parsed) return shortcut;

  const mapped = parsed.modifiers.map((modifier) => {
    if (isMacPlatform(platform)) {
      if (modifier === "Ctrl" || modifier === "Command") return "Cmd";
      if (modifier === "Alt" || modifier === "Control") return "Ctrl";
      if (modifier === "Meta") return "Meta";
      return modifier;
    }
    if (modifier === "Control") return "Ctrl";
    if (modifier === "Meta") return "Win";
    if (modifier === "Command") return "Cmd";
    return modifier;
  });
  return [...mapped, displayKey(normalizeBindingKey(parsed.key) ?? parsed.key)].join("+");
}

/** Format a shortcut for the current host platform. */
export function formatShortcut(shortcut: string | undefined): string {
  return formatShortcutForPlatform(shortcut, getShortcutPlatform());
}

/** Build the legacy canonical string used by the existing action registry. */
export function keyEventToCanonicalShortcut(e: KeyboardEvent): string {
  return canonicalizeShortcutEvent(e, getShortcutPlatform()) ?? "";
}

/** Mac = Command; Windows/Linux = Control. */
export function isPrimaryModifier(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** Legacy secondary modifier: Mac = Control; Windows/Linux = Alt. */
export function isSecondaryModifier(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.ctrlKey : e.altKey;
}

export function isControlModifier(e: KeyboardEvent | MouseEvent): boolean {
  return e.ctrlKey;
}

export function isCommandModifier(e: KeyboardEvent | MouseEvent): boolean {
  return isMac && e.metaKey;
}

export function isAltOptionModifier(e: KeyboardEvent | MouseEvent): boolean {
  return e.altKey;
}

export function isMetaWindowsModifier(e: KeyboardEvent | MouseEvent): boolean {
  return !isMac && e.metaKey;
}

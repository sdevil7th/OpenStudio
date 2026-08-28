/**
 * Pure pointer-modifier resolution for editable DAW surfaces.
 *
 * Profiles use semantic modifiers rather than platform key labels:
 * - primary: Control on Windows/Linux, Command on macOS
 * - secondary: Meta/Windows on Windows/Linux, physical Control on macOS
 * - alt: Alt on Windows/Linux, Option on macOS
 *
 * Pointer gestures do not depend on a produced character or physical key code,
 * so the same profile remains valid on QWERTY, QWERTZ, AZERTY, and other
 * keyboard layouts.
 */

export const MOUSE_MODIFIER_CONTEXTS = [
  "clip_drag",
  "clip_resize",
  "timeline_click",
  "track_header",
  "automation_point",
  "fade_handle",
  "ruler_click",
] as const;

export type MouseModifierContext = typeof MOUSE_MODIFIER_CONTEXTS[number];
export type MouseModifierPlatform = "macos" | "windows" | "other";
export type MouseLogicalModifier = "primary" | "secondary" | "alt" | "shift";

export type MouseModifierCombination =
  | "none"
  | "primary"
  | "secondary"
  | "alt"
  | "shift"
  | "primary+secondary"
  | "primary+alt"
  | "primary+shift"
  | "secondary+alt"
  | "secondary+shift"
  | "alt+shift"
  | "primary+secondary+alt"
  | "primary+secondary+shift"
  | "primary+alt+shift"
  | "secondary+alt+shift"
  | "primary+secondary+alt+shift";

export const MOUSE_MODIFIER_ACTIONS = {
  clip_drag: [
    "move",
    "copy",
    "copy_preserve_time",
    "constrain",
    "bypass_snap",
    "slip",
    "select",
    "none",
  ],
  clip_resize: ["resize", "fine", "symmetric", "stretch", "none"],
  timeline_click: ["seek", "select_range", "extend_selection", "zoom", "razor", "none"],
  track_header: ["select", "toggle_select", "range_select", "solo", "mute", "none"],
  automation_point: [
    "move",
    "copy",
    "copy_constrain_axis",
    "fine",
    "fine_bypass_snap",
    "constrain_x",
    "constrain_x_bypass_snap",
    "constrain_y",
    "constrain_y_bypass_snap",
    "constrain_axis",
    "constrain_axis_bypass_snap",
    "bypass_snap",
    "delete",
    "none",
  ],
  fade_handle: ["adjust", "fine", "symmetric", "shape_cycle", "none"],
  ruler_click: ["seek", "loop_set", "time_select", "zoom_to", "none"],
} as const;

export type MouseModifierActionFor<C extends MouseModifierContext> =
  typeof MOUSE_MODIFIER_ACTIONS[C][number];

export type MouseModifierAction = {
  [C in MouseModifierContext]: MouseModifierActionFor<C>;
}[MouseModifierContext];

export function isTimelineClipCopyAction(
  action: unknown,
): action is MouseModifierActionFor<"clip_drag"> {
  return action === "copy" || action === "copy_preserve_time";
}

export interface PointerModifierEventLike {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  getModifierState?: (key: string) => boolean;
}

export interface NormalizedMouseModifiers {
  /** Control on Windows/Linux, Command on macOS. */
  primary: boolean;
  /** Meta on Windows/Linux, physical Control on macOS. */
  secondary: boolean;
  /** Alt on Windows/Linux, Option on macOS. */
  alt: boolean;
  shift: boolean;
  /** AltGraph is kept separate so it cannot masquerade as Ctrl+Alt. */
  altGraph: boolean;
  active: readonly MouseLogicalModifier[];
  combination: MouseModifierCombination;
  raw: {
    control: boolean;
    meta: boolean;
    altOrOption: boolean;
    shift: boolean;
  };
}

export type MouseModifierProfileMappings = {
  readonly [C in MouseModifierContext]: Readonly<
    Partial<Record<MouseModifierCombination, MouseModifierActionFor<C>>>
  >;
};

export interface MouseModifierProfile {
  id: string;
  name: string;
  mappings: MouseModifierProfileMappings;
  /** Exact combinations always win; this orders single-modifier fallbacks. */
  modifierPrecedence?: readonly MouseLogicalModifier[];
}

/**
 * Overrides intentionally accept unknown values because persisted/imported
 * user data is untrusted at runtime. Values are checked against the selected
 * context before an action can be returned.
 */
export type MouseModifierOverrideMap = Partial<{
  readonly [C in MouseModifierContext]: Readonly<Record<string, unknown>>;
}>;

export interface MouseModifierResolveOptions {
  platform: MouseModifierPlatform;
  profile?: MouseModifierProfile;
  overrides?: MouseModifierOverrideMap;
}

export type MouseModifierResolutionSource =
  | "override"
  | "profile"
  | "none"
  | "unsupported";

export type MouseModifierMatchKind = "exact" | "precedence" | "none";

export interface ResolvedMouseModifier {
  profileId: string;
  context: MouseModifierContext;
  platform: MouseModifierPlatform;
  action: MouseModifierAction;
  modifiers: NormalizedMouseModifiers;
  source: MouseModifierResolutionSource;
  matchKind: MouseModifierMatchKind;
  matchedCombination: MouseModifierCombination | null;
  /** True when a profile/override entry was found, including explicit `none`. */
  matched: boolean;
  isNoop: boolean;
}

export const DEFAULT_MOUSE_MODIFIER_PRECEDENCE = [
  "primary",
  "secondary",
  "alt",
  "shift",
] as const satisfies readonly MouseLogicalModifier[];

export const OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS = {
  clip_drag: {
    none: "move",
    primary: "copy",
    "primary+shift": "slip",
    shift: "constrain",
    alt: "bypass_snap",
  },
  clip_resize: {
    none: "resize",
    primary: "fine",
    shift: "symmetric",
    alt: "stretch",
  },
  timeline_click: {
    none: "seek",
    primary: "select_range",
    shift: "extend_selection",
    alt: "razor",
  },
  track_header: {
    none: "select",
    primary: "toggle_select",
    shift: "range_select",
    alt: "solo",
  },
  automation_point: {
    none: "move",
    primary: "fine",
    shift: "constrain_y",
    alt: "delete",
  },
  fade_handle: {
    none: "adjust",
    primary: "fine",
    shift: "symmetric",
    alt: "shape_cycle",
  },
  ruler_click: {
    none: "seek",
    primary: "loop_set",
    shift: "time_select",
    alt: "zoom_to",
  },
} as const satisfies MouseModifierProfileMappings;

export const OPENSTUDIO_MOUSE_MODIFIER_PROFILE: MouseModifierProfile = {
  id: "openstudio",
  name: "OpenStudio",
  mappings: OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS,
  modifierPrecedence: DEFAULT_MOUSE_MODIFIER_PRECEDENCE,
};

const LOGICAL_MODIFIER_ORDER = [
  "primary",
  "secondary",
  "alt",
  "shift",
] as const satisfies readonly MouseLogicalModifier[];

const MODIFIER_ALIASES: Readonly<Record<string, MouseLogicalModifier>> = {
  primary: "primary",
  ctrl: "primary",
  cmd: "primary",
  command: "primary",
  secondary: "secondary",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

function hasOwn(object: object, property: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function safelyReadModifierState(
  event: PointerModifierEventLike,
  modifier: string,
): boolean {
  try {
    return Boolean(event.getModifierState?.(modifier));
  } catch {
    return false;
  }
}

function combinationFromActive(
  active: readonly MouseLogicalModifier[],
): MouseModifierCombination {
  return active.length === 0
    ? "none"
    : active.join("+") as MouseModifierCombination;
}

export function normalizeMouseModifiers(
  event: PointerModifierEventLike,
  platform: MouseModifierPlatform,
): NormalizedMouseModifiers {
  const control = Boolean(event.ctrlKey);
  const meta = Boolean(event.metaKey);
  const altOrOption = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);
  const primary = platform === "macos" ? meta : control;
  const secondary = platform === "macos" ? control : meta;
  const modifierValues: Record<MouseLogicalModifier, boolean> = {
    primary,
    secondary,
    alt: altOrOption,
    shift,
  };
  const active = LOGICAL_MODIFIER_ORDER.filter((modifier) => modifierValues[modifier]);

  return {
    primary,
    secondary,
    alt: altOrOption,
    shift,
    altGraph: safelyReadModifierState(event, "AltGraph"),
    active,
    combination: combinationFromActive(active),
    raw: {
      control,
      meta,
      altOrOption,
      shift,
    },
  };
}

/**
 * Converts profile/user-map keys to their platform-independent form. Legacy
 * Preferences keys (`ctrl`, `shift`, and `alt`) are accepted. `secondary` is
 * deliberately explicit because raw Control/Meta labels are platform-specific.
 */
export function canonicalizeMouseModifierCombination(
  value: string,
): MouseModifierCombination | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "none") return "none";
  if (normalized.length === 0) return null;

  const tokens = normalized.split("+");
  const modifiers = new Set<MouseLogicalModifier>();
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token];
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }

  const active = LOGICAL_MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return combinationFromActive(active);
}

export function isMouseModifierContext(value: unknown): value is MouseModifierContext {
  return typeof value === "string"
    && (MOUSE_MODIFIER_CONTEXTS as readonly string[]).includes(value);
}

export function isMouseModifierActionForContext(
  context: MouseModifierContext,
  value: unknown,
): value is MouseModifierAction {
  return typeof value === "string"
    && (MOUSE_MODIFIER_ACTIONS[context] as readonly string[]).includes(value);
}

interface MappingHit {
  found: boolean;
  value?: unknown;
}

function findMappingValue(
  mapping: Readonly<Record<string, unknown>> | undefined,
  combination: MouseModifierCombination,
): MappingHit {
  if (!mapping) return { found: false };
  if (hasOwn(mapping, combination)) {
    return { found: true, value: mapping[combination] };
  }

  // Alias lookup is sorted so malformed/imported maps have deterministic
  // behavior even if multiple legacy keys canonicalize to the same binding.
  const alias = Object.keys(mapping)
    .sort()
    .find((key) => canonicalizeMouseModifierCombination(key) === combination);
  return alias === undefined
    ? { found: false }
    : { found: true, value: mapping[alias] };
}

function normalizedPrecedence(
  profile: MouseModifierProfile,
): readonly MouseLogicalModifier[] {
  const ordered: MouseLogicalModifier[] = [];
  const requested = profile.modifierPrecedence ?? DEFAULT_MOUSE_MODIFIER_PRECEDENCE;
  for (const modifier of [...requested, ...DEFAULT_MOUSE_MODIFIER_PRECEDENCE]) {
    if (LOGICAL_MODIFIER_ORDER.includes(modifier) && !ordered.includes(modifier)) {
      ordered.push(modifier);
    }
  }
  return ordered;
}

function buildResolutionCandidates(
  modifiers: NormalizedMouseModifiers,
  profile: MouseModifierProfile,
): readonly MouseModifierCombination[] {
  if (modifiers.combination === "none") return ["none"];

  const candidates: MouseModifierCombination[] = [modifiers.combination];
  for (const modifier of normalizedPrecedence(profile)) {
    if (modifiers[modifier] && !candidates.includes(modifier)) {
      candidates.push(modifier);
    }
  }
  return candidates;
}

function noActionResolution(
  context: MouseModifierContext,
  platform: MouseModifierPlatform,
  profile: MouseModifierProfile,
  modifiers: NormalizedMouseModifiers,
  source: "none" | "unsupported",
): ResolvedMouseModifier {
  return {
    profileId: profile.id,
    context,
    platform,
    action: "none",
    modifiers,
    source,
    matchKind: "none",
    matchedCombination: null,
    matched: false,
    isNoop: true,
  };
}

export function resolveMouseModifier(
  event: PointerModifierEventLike,
  context: MouseModifierContext,
  options: MouseModifierResolveOptions,
): ResolvedMouseModifier {
  const profile = options.profile ?? OPENSTUDIO_MOUSE_MODIFIER_PROFILE;
  const modifiers = normalizeMouseModifiers(event, options.platform);

  if (!isMouseModifierContext(context) || modifiers.altGraph) {
    return noActionResolution(context, options.platform, profile, modifiers, "unsupported");
  }

  const overrideMapping = options.overrides?.[context];
  const profileMapping = profile.mappings[context] as Readonly<Record<string, unknown>> | undefined;
  for (const candidate of buildResolutionCandidates(modifiers, profile)) {
    const overrideHit = findMappingValue(overrideMapping, candidate);
    const profileHit = findMappingValue(profileMapping, candidate);
    const hit = overrideHit.found ? overrideHit : profileHit;
    if (!hit.found) continue;

    const action = isMouseModifierActionForContext(context, hit.value)
      ? hit.value
      : "none";
    return {
      profileId: profile.id,
      context,
      platform: options.platform,
      action,
      modifiers,
      source: overrideHit.found ? "override" : "profile",
      matchKind: candidate === modifiers.combination ? "exact" : "precedence",
      matchedCombination: candidate,
      matched: true,
      isNoop: action === "none",
    };
  }

  return noActionResolution(context, options.platform, profile, modifiers, "none");
}

/** Convenience API for consumers that only need the semantic action. */
export function resolveMouseModifierAction<C extends MouseModifierContext>(
  event: PointerModifierEventLike,
  context: C,
  options: MouseModifierResolveOptions,
): MouseModifierActionFor<C> {
  return resolveMouseModifier(event, context, options).action as MouseModifierActionFor<C>;
}

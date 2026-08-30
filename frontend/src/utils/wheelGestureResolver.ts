/**
 * Pure wheel/trackpad gesture classification for DAW surfaces.
 *
 * Components are responsible for applying the resolved amount to their state.
 * Keeping event normalization and profile matching here makes the same gesture
 * deterministic across canvas, DOM, detached-editor, and native-window hosts.
 */

export type WheelSurface =
  | "timeline"
  | "tcp"
  | "piano_roll"
  | "pitch_editor"
  | "browser"
  | "parameter";

export type WheelSubtarget =
  | "content"
  | "ruler"
  | "track"
  | "clip"
  | "empty"
  | "grid"
  | "note"
  | "sidebar"
  | "keyboard"
  | "controller_lane"
  | "waveform_scale"
  | "spectrogram_scale"
  | "automation_lane"
  | "fade_handle"
  | "event_volume"
  | "list"
  | "tree"
  | "preview"
  | "control"
  | "graph"
  | "console_fader";

export type WheelPlatform = "macos" | "windows" | "other";
export type WheelInputDevice = "mouse" | "trackpad" | "unknown";
export type WheelDeltaMode = "pixel" | "line" | "page";
export type WheelAxis = "horizontal" | "vertical";
export type WheelAxisSelector = WheelAxis | "dominant";
export type WheelDeltaSource = "x" | "y" | "dominant" | "sum";
export type WheelAnchorKind =
  | "none"
  | "pointer"
  | "surface"
  | "hovered-track"
  | "hovered-control";

export type WheelOperation =
  | "native-scroll"
  | "scroll"
  | "zoom"
  | "resize"
  | "adjust"
  | "reorder"
  | "nudge"
  | "pan"
  | "suppress";

export type WheelTarget =
  | "native"
  | "viewport"
  | "timeline"
  | "track-height"
  | "waveform-amplitude"
  | "parameter"
  | "track-order"
  | "clip-position"
  | "note-property"
  | "note-position"
  | "midi-note-height"
  | "waveform-scale"
  | "spectrogram-scale"
  | "spectrogram-db-floor"
  | "lane-height"
  | "fade-value"
  | "event-volume";

export type WheelPrecision = "normal" | "fine";

export interface WheelEventLike {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
}

export interface WheelNormalizationOptions {
  /** CSS pixels represented by one DOM_DELTA_LINE unit. */
  lineHeightPx?: number;
  /** CSS pixels represented by one DOM_DELTA_PAGE unit. */
  pageHeightPx?: number;
  /** Per-axis safety cap after conversion. */
  maxAbsDeltaPx?: number;
}

export interface NormalizedWheelDelta {
  x: number;
  y: number;
  mode: WheelDeltaMode;
  sourceMode: number;
  isZero: boolean;
}

export interface NormalizedWheelModifiers {
  /** Command on macOS, Control on Windows/Linux. */
  primary: boolean;
  /** Physical Control on macOS, Windows/Meta on Windows/Linux. */
  secondary: boolean;
  /** Option on macOS, Alt on Windows/Linux. */
  alt: boolean;
  shift: boolean;
  raw: {
    control: boolean;
    commandOrMeta: boolean;
    altOrOption: boolean;
    shift: boolean;
  };
}

export type WheelDeviceInferenceBasis =
  | "explicit"
  | "line-or-page-mode"
  | "two-axis-pixel-delta"
  | "fractional-pixel-delta"
  | "large-integer-pixel-delta"
  | "insufficient-signal";

export interface WheelDeviceInference {
  device: WheelInputDevice;
  basis: WheelDeviceInferenceBasis;
}

export interface WheelModifierPredicate {
  primary?: boolean;
  secondary?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface WheelBehaviorRule {
  id: string;
  surface: WheelSurface;
  /** Omit to match every subtarget on the surface. */
  subtargets?: readonly WheelSubtarget[];
  /** Omitted fields are wildcards. Rules are evaluated in declaration order. */
  modifiers?: WheelModifierPredicate;
  /** Omit to match mouse, trackpad, and unknown input. */
  devices?: readonly WheelInputDevice[];
  operation: WheelOperation;
  target: WheelTarget;
  axis: WheelAxisSelector;
  deltaSource?: WheelDeltaSource;
  multiplier?: number;
  anchor?: WheelAnchorKind;
  precision?: WheelPrecision;
  preventDefault: boolean;
  stopPropagation: boolean;
}

export interface WheelBehaviorProfile {
  id: string;
  name: string;
  /** First matching rule wins, allowing callers to prepend local overrides. */
  rules: readonly WheelBehaviorRule[];
  normalization?: WheelNormalizationOptions;
}

export interface WheelGestureContext {
  surface: WheelSurface;
  subtarget?: WheelSubtarget;
  platform: WheelPlatform;
  /** Prefer an explicit device hint when the host can identify the source. */
  deviceHint?: WheelInputDevice;
  /** Optional stable ID for the hovered track/control selected by the consumer. */
  hoveredTargetId?: string;
  normalization?: WheelNormalizationOptions;
}

export interface ResolvedWheelAnchor {
  kind: WheelAnchorKind;
  clientX?: number;
  clientY?: number;
  targetId?: string;
}

export interface ResolvedWheelGesture {
  profileId: string;
  ruleId: string | null;
  matched: boolean;
  operation: WheelOperation;
  target: WheelTarget;
  axis: WheelAxis;
  /** Pixel-normalized, signed amount after the rule multiplier. */
  amount: number;
  delta: NormalizedWheelDelta;
  modifiers: NormalizedWheelModifiers;
  device: WheelDeviceInference;
  anchor: ResolvedWheelAnchor;
  precision: WheelPrecision;
  preventDefault: boolean;
  stopPropagation: boolean;
}

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export const DEFAULT_WHEEL_NORMALIZATION: Required<WheelNormalizationOptions> = {
  lineHeightPx: 16,
  pageHeightPx: 800,
  maxAbsDeltaPx: 2400,
};

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function clampMagnitude(value: number, maximum: number): number {
  return Math.max(-maximum, Math.min(maximum, value));
}

export function normalizeWheelDelta(
  event: WheelEventLike,
  options: WheelNormalizationOptions = {},
): NormalizedWheelDelta {
  const lineHeightPx = positiveOrDefault(
    options.lineHeightPx,
    DEFAULT_WHEEL_NORMALIZATION.lineHeightPx,
  );
  const pageHeightPx = positiveOrDefault(
    options.pageHeightPx,
    DEFAULT_WHEEL_NORMALIZATION.pageHeightPx,
  );
  const maxAbsDeltaPx = positiveOrDefault(
    options.maxAbsDeltaPx,
    DEFAULT_WHEEL_NORMALIZATION.maxAbsDeltaPx,
  );
  const sourceMode = Number.isFinite(event.deltaMode) ? event.deltaMode ?? DOM_DELTA_PIXEL : DOM_DELTA_PIXEL;
  const mode: WheelDeltaMode = sourceMode === DOM_DELTA_LINE
    ? "line"
    : sourceMode === DOM_DELTA_PAGE
      ? "page"
      : "pixel";
  const scale = mode === "line" ? lineHeightPx : mode === "page" ? pageHeightPx : 1;
  const x = clampMagnitude(finiteOrZero(event.deltaX) * scale, maxAbsDeltaPx);
  const y = clampMagnitude(finiteOrZero(event.deltaY) * scale, maxAbsDeltaPx);

  return {
    x,
    y,
    mode,
    sourceMode,
    isZero: x === 0 && y === 0,
  };
}

export function normalizeWheelModifiers(
  event: WheelEventLike,
  platform: WheelPlatform,
): NormalizedWheelModifiers {
  const control = Boolean(event.ctrlKey);
  const commandOrMeta = Boolean(event.metaKey);
  const altOrOption = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);

  return {
    primary: platform === "macos" ? commandOrMeta : control,
    secondary: platform === "macos" ? control : commandOrMeta,
    alt: altOrOption,
    shift,
    raw: { control, commandOrMeta, altOrOption, shift },
  };
}

export function inferWheelInputDevice(
  event: WheelEventLike,
  explicitHint?: WheelInputDevice,
): WheelDeviceInference {
  if (explicitHint !== undefined) {
    return { device: explicitHint, basis: "explicit" };
  }

  const sourceMode = Number.isFinite(event.deltaMode) ? event.deltaMode ?? DOM_DELTA_PIXEL : DOM_DELTA_PIXEL;
  if (sourceMode === DOM_DELTA_LINE || sourceMode === DOM_DELTA_PAGE) {
    return { device: "mouse", basis: "line-or-page-mode" };
  }

  const x = finiteOrZero(event.deltaX);
  const y = finiteOrZero(event.deltaY);
  if (x !== 0 && y !== 0) {
    return { device: "trackpad", basis: "two-axis-pixel-delta" };
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return { device: "trackpad", basis: "fractional-pixel-delta" };
  }

  const magnitude = Math.max(Math.abs(x), Math.abs(y));
  if (magnitude >= 50) {
    return { device: "mouse", basis: "large-integer-pixel-delta" };
  }
  return { device: "unknown", basis: "insufficient-signal" };
}

function matchesModifierPredicate(
  modifiers: NormalizedWheelModifiers,
  predicate: WheelModifierPredicate | undefined,
): boolean {
  if (!predicate) return true;
  return (predicate.primary === undefined || predicate.primary === modifiers.primary)
    && (predicate.secondary === undefined || predicate.secondary === modifiers.secondary)
    && (predicate.alt === undefined || predicate.alt === modifiers.alt)
    && (predicate.shift === undefined || predicate.shift === modifiers.shift);
}

function resolveAxis(selector: WheelAxisSelector, delta: NormalizedWheelDelta): WheelAxis {
  if (selector !== "dominant") return selector;
  // Deliberately prefer vertical on ties, matching existing editor behavior.
  return Math.abs(delta.x) > Math.abs(delta.y) ? "horizontal" : "vertical";
}

function resolveDeltaAmount(
  source: WheelDeltaSource,
  delta: NormalizedWheelDelta,
): number {
  if (source === "x") return delta.x;
  if (source === "y") return delta.y;
  if (source === "sum") return delta.x + delta.y;
  return Math.abs(delta.x) > Math.abs(delta.y) ? delta.x : delta.y;
}

function mergeNormalizationOptions(
  profileOptions: WheelNormalizationOptions | undefined,
  contextOptions: WheelNormalizationOptions | undefined,
): WheelNormalizationOptions {
  return {
    ...profileOptions,
    ...contextOptions,
  };
}

function buildAnchor(
  kind: WheelAnchorKind,
  event: WheelEventLike,
  context: WheelGestureContext,
): ResolvedWheelAnchor {
  if (kind === "none") return { kind };
  return {
    kind,
    clientX: Number.isFinite(event.clientX) ? event.clientX : undefined,
    clientY: Number.isFinite(event.clientY) ? event.clientY : undefined,
    targetId: context.hoveredTargetId,
  };
}

function getDefaultDeltaSource(axis: WheelAxisSelector): WheelDeltaSource {
  if (axis === "horizontal") return "x";
  if (axis === "vertical") return "y";
  return "dominant";
}

function matchesRule(
  rule: WheelBehaviorRule,
  context: WheelGestureContext,
  modifiers: NormalizedWheelModifiers,
  device: WheelInputDevice,
): boolean {
  if (rule.surface !== context.surface) return false;
  if (rule.subtargets && (!context.subtarget || !rule.subtargets.includes(context.subtarget))) {
    return false;
  }
  if (rule.devices && !rule.devices.includes(device)) return false;
  return matchesModifierPredicate(modifiers, rule.modifiers);
}

function nativeFallback(
  profile: WheelBehaviorProfile,
  event: WheelEventLike,
  context: WheelGestureContext,
  delta: NormalizedWheelDelta,
  modifiers: NormalizedWheelModifiers,
  device: WheelDeviceInference,
): ResolvedWheelGesture {
  const axis = resolveAxis("dominant", delta);
  return {
    profileId: profile.id,
    ruleId: null,
    matched: false,
    operation: "native-scroll",
    target: "native",
    axis,
    amount: axis === "horizontal" ? delta.x : delta.y,
    delta,
    modifiers,
    device,
    anchor: buildAnchor("none", event, context),
    precision: "normal",
    preventDefault: false,
    stopPropagation: false,
  };
}

export function resolveWheelGesture(
  event: WheelEventLike,
  context: WheelGestureContext,
  profile: WheelBehaviorProfile = OPENSTUDIO_WHEEL_PROFILE,
): ResolvedWheelGesture {
  const delta = normalizeWheelDelta(
    event,
    mergeNormalizationOptions(profile.normalization, context.normalization),
  );
  const modifiers = normalizeWheelModifiers(event, context.platform);
  const device = inferWheelInputDevice(event, context.deviceHint);
  const rule = profile.rules.find((candidate) => (
    matchesRule(candidate, context, modifiers, device.device)
  ));
  if (!rule) return nativeFallback(profile, event, context, delta, modifiers, device);

  const axis = resolveAxis(rule.axis, delta);
  const deltaSource = rule.deltaSource ?? getDefaultDeltaSource(rule.axis);
  const amount = resolveDeltaAmount(deltaSource, delta) * (rule.multiplier ?? 1);

  return {
    profileId: profile.id,
    ruleId: rule.id,
    matched: true,
    operation: rule.operation,
    target: rule.target,
    axis,
    amount,
    delta,
    modifiers,
    device,
    anchor: buildAnchor(rule.anchor ?? "none", event, context),
    precision: rule.precision ?? "normal",
    preventDefault: rule.preventDefault,
    stopPropagation: rule.stopPropagation,
  };
}

const OPENSTUDIO_WHEEL_RULES: readonly WheelBehaviorRule[] = [
  // Timeline precedence mirrors the existing handler: Primary+Shift, Primary,
  // Alt/Option, Shift, then native vertical scrolling.
  {
    id: "timeline.waveform-amplitude",
    surface: "timeline",
    modifiers: { primary: true, shift: true },
    operation: "zoom",
    target: "waveform-amplitude",
    axis: "vertical",
    deltaSource: "y",
    anchor: "hovered-track",
    preventDefault: true,
    stopPropagation: true,
  },
  {
    id: "timeline.horizontal-zoom",
    surface: "timeline",
    modifiers: { primary: true },
    operation: "zoom",
    target: "timeline",
    axis: "horizontal",
    deltaSource: "y",
    anchor: "pointer",
    preventDefault: true,
    stopPropagation: true,
  },
  {
    id: "timeline.track-height",
    surface: "timeline",
    modifiers: { alt: true },
    operation: "resize",
    target: "track-height",
    axis: "vertical",
    deltaSource: "y",
    anchor: "surface",
    preventDefault: true,
    stopPropagation: true,
  },
  {
    id: "timeline.horizontal-scroll",
    surface: "timeline",
    modifiers: { shift: true },
    operation: "scroll",
    target: "viewport",
    axis: "horizontal",
    deltaSource: "y",
    multiplier: 2,
    anchor: "surface",
    preventDefault: true,
    stopPropagation: false,
  },
  {
    id: "timeline.native-scroll",
    surface: "timeline",
    operation: "native-scroll",
    target: "native",
    axis: "vertical",
    deltaSource: "y",
    preventDefault: false,
    stopPropagation: false,
  },

  // The TCP owns every Alt/Option combination. Primary-modified scrolling has
  // no current edit action and is consumed so WebView/browser zoom cannot run.
  {
    id: "tcp.track-height",
    surface: "tcp",
    modifiers: { alt: true },
    operation: "resize",
    target: "track-height",
    axis: "vertical",
    deltaSource: "y",
    anchor: "surface",
    preventDefault: true,
    stopPropagation: true,
  },
  {
    id: "tcp.suppress-browser-zoom",
    surface: "tcp",
    modifiers: { primary: true },
    operation: "suppress",
    target: "native",
    axis: "vertical",
    deltaSource: "y",
    preventDefault: true,
    stopPropagation: false,
  },
  {
    id: "tcp.native-scroll",
    surface: "tcp",
    operation: "native-scroll",
    target: "native",
    axis: "vertical",
    deltaSource: "y",
    preventDefault: false,
    stopPropagation: false,
  },

  // The Piano Roll sidebar keeps native scrolling. The canvas prioritizes
  // Primary zoom, then Shift/deltaX horizontal intent, then vertical intent.
  {
    id: "piano-roll.sidebar-native-scroll",
    surface: "piano_roll",
    subtargets: ["sidebar"],
    operation: "native-scroll",
    target: "native",
    axis: "vertical",
    deltaSource: "y",
    preventDefault: false,
    stopPropagation: false,
  },
  {
    id: "piano-roll.horizontal-zoom",
    surface: "piano_roll",
    modifiers: { primary: true },
    operation: "zoom",
    target: "timeline",
    axis: "horizontal",
    deltaSource: "y",
    anchor: "pointer",
    preventDefault: true,
    stopPropagation: false,
  },
  {
    id: "piano-roll.shift-horizontal-scroll",
    surface: "piano_roll",
    modifiers: { shift: true },
    operation: "scroll",
    target: "viewport",
    axis: "horizontal",
    deltaSource: "sum",
    anchor: "surface",
    preventDefault: true,
    stopPropagation: false,
  },
  {
    id: "piano-roll.dominant-axis-scroll",
    surface: "piano_roll",
    operation: "scroll",
    target: "viewport",
    axis: "dominant",
    deltaSource: "dominant",
    anchor: "surface",
    preventDefault: true,
    stopPropagation: false,
  },

  {
    id: "pitch-editor.horizontal-zoom",
    surface: "pitch_editor",
    modifiers: { primary: true },
    operation: "zoom",
    target: "timeline",
    axis: "horizontal",
    deltaSource: "y",
    anchor: "pointer",
    preventDefault: true,
    stopPropagation: false,
  },
  {
    id: "pitch-editor.horizontal-scroll",
    surface: "pitch_editor",
    modifiers: { shift: true },
    operation: "scroll",
    target: "viewport",
    axis: "horizontal",
    deltaSource: "y",
    multiplier: 2,
    anchor: "surface",
    preventDefault: true,
    stopPropagation: false,
  },
  {
    id: "pitch-editor.vertical-pitch-scroll",
    surface: "pitch_editor",
    operation: "scroll",
    target: "viewport",
    axis: "vertical",
    deltaSource: "y",
    multiplier: -1,
    anchor: "surface",
    preventDefault: true,
    stopPropagation: false,
  },

  // In scrollable browsers/lists, protect the application from WebView page
  // zoom while retaining native scrolling for unmodified and Shift gestures.
  {
    id: "browser.suppress-browser-zoom",
    surface: "browser",
    modifiers: { primary: true },
    operation: "suppress",
    target: "native",
    axis: "vertical",
    deltaSource: "y",
    preventDefault: true,
    stopPropagation: false,
  },
  {
    id: "browser.native-horizontal-scroll",
    surface: "browser",
    modifiers: { shift: true },
    operation: "native-scroll",
    target: "native",
    axis: "horizontal",
    deltaSource: "sum",
    preventDefault: false,
    stopPropagation: false,
  },
  {
    id: "browser.native-scroll",
    surface: "browser",
    operation: "native-scroll",
    target: "native",
    axis: "dominant",
    deltaSource: "dominant",
    preventDefault: false,
    stopPropagation: false,
  },

  // Parameter controls always own their wheel gesture. Shift is the shared
  // fine-adjust modifier; components can apply their parameter-specific step.
  {
    id: "parameter.fine-adjust",
    surface: "parameter",
    modifiers: { shift: true },
    operation: "adjust",
    target: "parameter",
    axis: "vertical",
    deltaSource: "y",
    anchor: "hovered-control",
    precision: "fine",
    preventDefault: true,
    stopPropagation: true,
  },
  {
    id: "parameter.adjust",
    surface: "parameter",
    operation: "adjust",
    target: "parameter",
    axis: "vertical",
    deltaSource: "y",
    anchor: "hovered-control",
    precision: "normal",
    preventDefault: true,
    stopPropagation: true,
  },
];

export const OPENSTUDIO_WHEEL_PROFILE: WheelBehaviorProfile = {
  id: "openstudio",
  name: "OpenStudio",
  rules: OPENSTUDIO_WHEEL_RULES,
  normalization: DEFAULT_WHEEL_NORMALIZATION,
};

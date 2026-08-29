import {
  OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS,
  type MouseModifierCombination,
  type MouseModifierProfile,
  type MouseModifierProfileMappings,
} from "./mouseModifierResolver";
import type { ShortcutPlatform } from "./platform";
import {
  KEYBOARD_SHORTCUT_PROFILES,
  getKeyboardShortcutProfile,
  type KeyboardShortcutProfileId,
} from "./shortcutProfiles";
import {
  OPENSTUDIO_WHEEL_PROFILE,
  type WheelBehaviorProfile,
  type WheelBehaviorRule,
  type WheelModifierPredicate,
  type WheelSubtarget,
} from "./wheelGestureResolver";

export interface MouseBehaviorProfile {
  id: KeyboardShortcutProfileId;
  name: string;
  description: string;
  wheel: WheelBehaviorProfile;
  modifiers: MouseModifierProfile;
}

type ModifierOverrides = Partial<{
  [Context in keyof MouseModifierProfileMappings]: Partial<MouseModifierProfileMappings[Context]>;
}>;

const STRICT_MODIFIER_NOOPS = {
  primary: "none",
  secondary: "none",
  alt: "none",
  shift: "none",
  "primary+secondary": "none",
  "primary+alt": "none",
  "primary+shift": "none",
  "secondary+alt": "none",
  "secondary+shift": "none",
  "alt+shift": "none",
  "primary+secondary+alt": "none",
  "primary+secondary+shift": "none",
  "primary+alt+shift": "none",
  "secondary+alt+shift": "none",
  "primary+secondary+alt+shift": "none",
} as const satisfies Partial<Record<MouseModifierCombination, "none">>;

/**
 * Vendor profiles start with only the unmodified primitive for each surface.
 * Every modified combination is an explicit no-op so the resolver cannot
 * accidentally fall back to an undocumented OpenStudio single-modifier action.
 */
const SOURCE_SAFE_MOUSE_MODIFIER_MAPPINGS = {
  clip_drag: { none: "move", ...STRICT_MODIFIER_NOOPS },
  clip_resize: { none: "resize", ...STRICT_MODIFIER_NOOPS },
  timeline_click: { none: "seek", ...STRICT_MODIFIER_NOOPS },
  track_header: { none: "select", ...STRICT_MODIFIER_NOOPS },
  automation_point: { none: "move", ...STRICT_MODIFIER_NOOPS },
  fade_handle: { none: "adjust", ...STRICT_MODIFIER_NOOPS },
  ruler_click: { none: "seek", ...STRICT_MODIFIER_NOOPS },
} as const satisfies MouseModifierProfileMappings;

function createModifierProfile(
  id: KeyboardShortcutProfileId,
  name: string,
  overrides: ModifierOverrides = {},
): MouseModifierProfile {
  const base = id === "openstudio"
    ? OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS
    : SOURCE_SAFE_MOUSE_MODIFIER_MAPPINGS;
  return {
    id,
    name,
    mappings: {
      clip_drag: { ...base.clip_drag, ...overrides.clip_drag },
      clip_resize: { ...base.clip_resize, ...overrides.clip_resize },
      timeline_click: { ...base.timeline_click, ...overrides.timeline_click },
      track_header: { ...base.track_header, ...overrides.track_header },
      automation_point: { ...base.automation_point, ...overrides.automation_point },
      fade_handle: { ...base.fade_handle, ...overrides.fade_handle },
      ruler_click: { ...base.ruler_click, ...overrides.ruler_click },
    },
  };
}

type ExactWheelModifiers = Required<WheelModifierPredicate>;

const PLAIN_MODIFIERS: ExactWheelModifiers = {
  primary: false,
  secondary: false,
  alt: false,
  shift: false,
};

function exactModifiers(
  overrides: Partial<ExactWheelModifiers> = {},
): ExactWheelModifiers {
  return { ...PLAIN_MODIFIERS, ...overrides };
}

function verticalScrollRule(
  id: string,
  modifiers: ExactWheelModifiers,
  multiplier = 1,
): WheelBehaviorRule {
  return {
    id,
    surface: "timeline",
    modifiers,
    operation: "scroll",
    target: "viewport",
    axis: "vertical",
    deltaSource: "y",
    multiplier,
    anchor: "surface",
    preventDefault: true,
    stopPropagation: false,
  };
}

function horizontalScrollRule(
  id: string,
  modifiers: ExactWheelModifiers,
): WheelBehaviorRule {
  return {
    id,
    surface: "timeline",
    modifiers,
    operation: "scroll",
    target: "viewport",
    axis: "horizontal",
    deltaSource: "y",
    anchor: "surface",
    preventDefault: true,
    stopPropagation: false,
  };
}

function horizontalZoomRule(
  id: string,
  modifiers: ExactWheelModifiers,
  multiplier = 1,
): WheelBehaviorRule {
  return {
    id,
    surface: "timeline",
    modifiers,
    operation: "zoom",
    target: "timeline",
    axis: "horizontal",
    deltaSource: "y",
    multiplier,
    anchor: "pointer",
    preventDefault: true,
    stopPropagation: true,
  };
}

function trackHeightRule(
  id: string,
  modifiers: ExactWheelModifiers,
  anchor: "surface" | "hovered-track" = "surface",
  subtargets?: readonly WheelSubtarget[],
): WheelBehaviorRule {
  return {
    id,
    surface: "timeline",
    subtargets,
    modifiers,
    operation: "resize",
    target: "track-height",
    axis: "vertical",
    deltaSource: "y",
    anchor,
    preventDefault: true,
    stopPropagation: true,
  };
}

/**
 * Source-DAW timeline behavior only. Every predicate specifies all four
 * normalized modifiers so an undocumented extra key cannot fall through to a
 * broader rule. Unsupported context actions intentionally remain unmatched.
 */
function dawTimelineWheelRules(
  id: KeyboardShortcutProfileId,
  platform: ShortcutPlatform,
): readonly WheelBehaviorRule[] {
  const primary = exactModifiers({ primary: true });
  const primaryShift = exactModifiers({ primary: true, shift: true });
  const alt = exactModifiers({ alt: true });
  const altShift = exactModifiers({ alt: true, shift: true });
  const shift = exactModifiers({ shift: true });

  switch (id) {
    case "pro_tools": {
      // Secondary normalizes physical Control on macOS and Start/Windows Meta
      // on Windows, matching Avid's platform-specific acceleration modifier.
      const accelerated = exactModifiers({ secondary: true });
      return [
        verticalScrollRule("pro-tools.vertical-scroll", PLAIN_MODIFIERS),
        horizontalScrollRule("pro-tools.shift-horizontal-scroll", shift),
        horizontalZoomRule("pro-tools.option-horizontal-zoom", alt),
        {
          id: "pro-tools.option-shift-waveform-zoom",
          surface: "timeline",
          // A waveform zoom needs a real hovered track. In particular, do not
          // claim the detached ruler, where no truthful track anchor exists.
          subtargets: ["content", "track", "clip", "waveform_scale", "fade_handle", "event_volume"],
          modifiers: altShift,
          operation: "zoom",
          target: "waveform-amplitude",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-track",
          preventDefault: true,
          stopPropagation: true,
        },
        // Avid documents Command/Control as slower and Control/Start as faster.
        // The multipliers preserve that relative behavior without claiming a
        // source-DAW-specific numeric rate.
        verticalScrollRule("pro-tools.slow-vertical-scroll", primary, 0.5),
        verticalScrollRule("pro-tools.fast-vertical-scroll", accelerated, 2),
      ];
    }

    case "cubase":
      return [
        {
          id: "cubase.fade-handle-adjust",
          surface: "timeline",
          subtargets: ["fade_handle"],
          modifiers: PLAIN_MODIFIERS,
          operation: "adjust",
          target: "fade-value",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "cubase.event-volume-adjust",
          surface: "timeline",
          subtargets: ["event_volume"],
          modifiers: PLAIN_MODIFIERS,
          operation: "adjust",
          target: "event-volume",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        verticalScrollRule("cubase.vertical-scroll", PLAIN_MODIFIERS),
        horizontalScrollRule("cubase.shift-horizontal-scroll", shift),
        horizontalZoomRule("cubase.horizontal-zoom", primary),
        trackHeightRule("cubase.vertical-zoom", primaryShift),
      ];

    case "reaper":
      return [
        horizontalZoomRule("reaper.horizontal-zoom", PLAIN_MODIFIERS),
        trackHeightRule("reaper.vertical-zoom", primary),
        horizontalScrollRule("reaper.horizontal-scroll", alt),
        verticalScrollRule(
          "reaper.vertical-scroll",
          exactModifiers({ primary: true, alt: true }),
        ),
      ];

    case "audacity":
      return [
        {
          id: "audacity.spectrogram-lower-db-limit",
          surface: "timeline",
          subtargets: ["spectrogram_scale"],
          modifiers: primaryShift,
          operation: "adjust",
          target: "spectrogram-db-floor",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-track",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "audacity.waveform-scale-zoom",
          surface: "timeline",
          subtargets: ["waveform_scale"],
          modifiers: primary,
          operation: "zoom",
          target: "waveform-scale",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-track",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "audacity.spectrogram-scale-zoom",
          surface: "timeline",
          subtargets: ["spectrogram_scale"],
          modifiers: primary,
          operation: "zoom",
          target: "spectrogram-scale",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-track",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "audacity.waveform-scale-pan",
          surface: "timeline",
          subtargets: ["waveform_scale"],
          modifiers: shift,
          operation: "pan",
          target: "waveform-scale",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-track",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "audacity.spectrogram-scale-pan",
          surface: "timeline",
          subtargets: ["spectrogram_scale"],
          modifiers: shift,
          operation: "pan",
          target: "spectrogram-scale",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-track",
          preventDefault: true,
          stopPropagation: true,
        },
        verticalScrollRule("audacity.vertical-scroll", PLAIN_MODIFIERS),
        horizontalScrollRule("audacity.shift-horizontal-scroll", shift),
        horizontalZoomRule("audacity.horizontal-zoom", primary),
      ];

    case "logic_pro": {
      // Logic's documented modifier is physical Control+Option on macOS. Use
      // the portable Control+Alt equivalent when the profile runs on Windows.
      const logicZoom = platform === "macos"
        ? exactModifiers({ secondary: true, alt: true })
        : exactModifiers({ primary: true, alt: true });
      return [horizontalZoomRule("logic-pro.control-option-horizontal-zoom", logicZoom)];
    }

    case "fl_studio":
      return [
        {
          id: "fl-studio.clip-nudge",
          surface: "timeline",
          subtargets: ["clip"],
          modifiers: altShift,
          operation: "nudge",
          target: "clip-position",
          axis: "horizontal",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "fl-studio.playlist-track-reorder",
          surface: "timeline",
          subtargets: ["track"],
          modifiers: shift,
          operation: "reorder",
          target: "track-order",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-track",
          preventDefault: true,
          stopPropagation: true,
        },
      ];

    case "ableton_live":
      return [
        {
          id: "ableton-live.automation-lane-height",
          surface: "timeline",
          subtargets: ["automation_lane"],
          modifiers: alt,
          operation: "resize",
          target: "lane-height",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-track",
          preventDefault: true,
          stopPropagation: true,
        },
        verticalScrollRule("ableton-live.vertical-scroll", PLAIN_MODIFIERS),
        horizontalScrollRule("ableton-live.shift-horizontal-scroll", shift),
        horizontalZoomRule("ableton-live.horizontal-zoom", primary),
      ];

    case "studio_one":
      return [
        verticalScrollRule("studio-one.vertical-scroll", PLAIN_MODIFIERS),
        horizontalScrollRule("studio-one.shift-horizontal-scroll", shift),
        trackHeightRule("studio-one.vertical-zoom", primary),
        horizontalZoomRule("studio-one.horizontal-zoom", primaryShift),
      ];

    case "bitwig_studio":
      return [
        horizontalZoomRule(
          "bitwig-studio.control-alt-horizontal-zoom",
          exactModifiers({ primary: true, alt: true }),
        ),
      ];

    case "reason":
      return [
        verticalScrollRule("reason.vertical-scroll", PLAIN_MODIFIERS),
        horizontalScrollRule("reason.shift-horizontal-scroll", shift),
        horizontalZoomRule("reason.horizontal-zoom", primary),
        trackHeightRule("reason.vertical-sequencer-zoom", primaryShift),
      ];

    case "cakewalk_sonar":
      return [
        horizontalZoomRule("cakewalk-sonar.alt-horizontal-zoom", alt),
        horizontalZoomRule("cakewalk-sonar.alt-shift-fast-horizontal-zoom", altShift, 2),
        trackHeightRule(
          "cakewalk-sonar.control-alt-track-height",
          exactModifiers({ primary: true, alt: true }),
        ),
      ];

    case "garageband":
      // Apple's current GarageBand guide documents scrollbars and zoom
      // controls, but no modifier-wheel defaults.
      return [];

    case "digital_performer":
      return [
        horizontalZoomRule("digital-performer.option-horizontal-zoom", alt),
        trackHeightRule(
          "digital-performer.option-control-track-height",
          exactModifiers({ secondary: true, alt: true }),
        ),
      ];

    case "ardour":
      return [
        verticalScrollRule("ardour.vertical-scroll", PLAIN_MODIFIERS),
        horizontalScrollRule("ardour.shift-horizontal-scroll", shift),
        horizontalZoomRule("ardour.horizontal-zoom", primary),
      ];

    case "adobe_audition":
      return [{
        id: "adobe-audition.ruler-horizontal-zoom",
        surface: "timeline",
        subtargets: ["ruler"],
        modifiers: PLAIN_MODIFIERS,
        operation: "zoom",
        target: "timeline",
        axis: "horizontal",
        deltaSource: "y",
        anchor: "pointer",
        preventDefault: true,
        stopPropagation: true,
      }];

    case "mixcraft":
      return [
        horizontalZoomRule("mixcraft.horizontal-zoom", PLAIN_MODIFIERS),
        horizontalScrollRule("mixcraft.control-horizontal-scroll", primary),
        verticalScrollRule("mixcraft.shift-vertical-scroll", shift),
      ];

    case "waveform":
      return [
        horizontalZoomRule("waveform.horizontal-zoom", PLAIN_MODIFIERS),
        trackHeightRule("waveform.control-vertical-zoom", primary),
      ];

    case "renoise":
      return [];

    case "openstudio":
      return OPENSTUDIO_WHEEL_PROFILE.rules.filter((rule) => rule.surface === "timeline");
  }
}

function dawEditorWheelRules(
  id: KeyboardShortcutProfileId,
  platform: ShortcutPlatform,
): readonly WheelBehaviorRule[] {
  const alt = exactModifiers({ alt: true });
  const altShift = exactModifiers({ alt: true, shift: true });

  switch (id) {
    case "cubase":
      return [
        {
          id: "cubase.parameter-fine-adjust",
          surface: "parameter",
          subtargets: ["control", "graph"],
          modifiers: exactModifiers({ shift: true }),
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
          id: "cubase.parameter-adjust",
          surface: "parameter",
          subtargets: ["control", "graph"],
          modifiers: PLAIN_MODIFIERS,
          operation: "adjust",
          target: "parameter",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "cubase.parameter-unsupported-wheel",
          surface: "parameter",
          subtargets: ["control", "graph"],
          operation: "suppress",
          target: "parameter",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
      ];

    case "pro_tools":
      return [{
        id: "pro-tools.midi-note-height",
        surface: "piano_roll",
        subtargets: ["grid", "keyboard", "note"],
        modifiers: exactModifiers({ secondary: true, alt: true }),
        operation: "zoom",
        target: "midi-note-height",
        axis: "vertical",
        deltaSource: "y",
        anchor: "pointer",
        preventDefault: true,
        stopPropagation: true,
      }];

    case "fl_studio":
      return [
        {
          id: "fl-studio.piano-note-nudge",
          surface: "piano_roll",
          subtargets: ["note"],
          modifiers: altShift,
          operation: "nudge",
          target: "note-position",
          axis: "horizontal",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "fl-studio.piano-note-property",
          surface: "piano_roll",
          subtargets: ["note"],
          modifiers: alt,
          operation: "adjust",
          target: "note-property",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
      ];

    case "ableton_live":
      return [{
        id: "ableton-live.midi-note-height",
        surface: "piano_roll",
        subtargets: ["grid", "keyboard", "note"],
        modifiers: alt,
        operation: "zoom",
        target: "midi-note-height",
        axis: "vertical",
        deltaSource: "y",
        anchor: "pointer",
        preventDefault: true,
        stopPropagation: true,
      }];

    case "cakewalk_sonar":
      return [
        {
          id: "cakewalk-sonar.console-selected-faders",
          surface: "parameter",
          subtargets: ["console_fader"],
          modifiers: exactModifiers({ primary: true, shift: true }),
          operation: "suppress",
          target: "parameter",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "cakewalk-sonar.console-all-faders",
          surface: "parameter",
          subtargets: ["console_fader"],
          modifiers: exactModifiers({ primary: true }),
          operation: "suppress",
          target: "parameter",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "cakewalk-sonar.console-fader-fine",
          surface: "parameter",
          subtargets: ["console_fader"],
          modifiers: exactModifiers({ shift: true }),
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
          id: "cakewalk-sonar.console-fader",
          surface: "parameter",
          subtargets: ["console_fader"],
          modifiers: PLAIN_MODIFIERS,
          operation: "adjust",
          target: "parameter",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "cakewalk-sonar.console-unsupported-wheel",
          surface: "parameter",
          subtargets: ["console_fader"],
          operation: "suppress",
          target: "parameter",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
      ];

    case "ardour": {
      // Ardour documents physical Control on macOS and Control on Windows for
      // fine (10%-rate) adjustment over parameter controls.
      const fine = platform === "macos"
        ? exactModifiers({ secondary: true })
        : exactModifiers({ primary: true });
      return [
        {
          id: "ardour.parameter-fine-adjust",
          surface: "parameter",
          subtargets: ["control", "graph"],
          modifiers: fine,
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
          id: "ardour.parameter-adjust",
          surface: "parameter",
          subtargets: ["control", "graph"],
          modifiers: PLAIN_MODIFIERS,
          operation: "adjust",
          target: "parameter",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
        {
          id: "ardour.parameter-unsupported-wheel",
          surface: "parameter",
          subtargets: ["control", "graph"],
          operation: "suppress",
          target: "parameter",
          axis: "vertical",
          deltaSource: "y",
          anchor: "hovered-control",
          preventDefault: true,
          stopPropagation: true,
        },
      ];
    }

    default:
      return [];
  }
}

function createWheelProfile(
  id: KeyboardShortcutProfileId,
  name: string,
  platform: ShortcutPlatform,
): WheelBehaviorProfile {
  if (id === "openstudio") return OPENSTUDIO_WHEEL_PROFILE;

  const parameterSafetyRule: WheelBehaviorRule = {
    id: `${id}.parameter-safety-fallback`,
    surface: "parameter",
    operation: "suppress",
    target: "parameter",
    axis: "vertical",
    deltaSource: "y",
    anchor: "hovered-control",
    preventDefault: true,
    stopPropagation: true,
  };

  return {
    id,
    name,
    normalization: OPENSTUDIO_WHEEL_PROFILE.normalization,
    rules: [
      ...dawTimelineWheelRules(id, platform),
      ...dawEditorWheelRules(id, platform),
      // Vendor profiles do not silently inherit OpenStudio's TCP, Piano Roll,
      // Pitch Editor, or parameter-wheel mutations. A final parameter guard
      // prevents native range inputs from stepping on an unsupported gesture.
      parameterSafetyRule,
      // Browser zoom protection is application safety rather than a DAW claim;
      // retain its explicit native scrolling/suppression rules for every map.
      ...OPENSTUDIO_WHEEL_PROFILE.rules.filter((rule) => rule.surface === "browser"),
    ],
  };
}

function pointerOverrides(
  id: KeyboardShortcutProfileId,
  platform: ShortcutPlatform,
): ModifierOverrides {
  switch (id) {
    case "pro_tools":
      return {
        clip_drag: { alt: "copy" },
        automation_point: { shift: "constrain_y" },
      };
    case "cubase":
      return {
        clip_drag: { alt: "copy" },
        automation_point: {
          primary: "constrain_axis",
          "primary+secondary": "constrain_axis_bypass_snap",
          "primary+alt": "constrain_axis_bypass_snap",
          "primary+shift": "constrain_axis_bypass_snap",
          "primary+secondary+alt": "constrain_axis_bypass_snap",
          "primary+secondary+shift": "constrain_axis_bypass_snap",
          "primary+alt+shift": "constrain_axis_bypass_snap",
          "primary+secondary+alt+shift": "constrain_axis_bypass_snap",
        },
      };
    case "logic_pro":
      return { clip_drag: { alt: "copy" } };
    case "adobe_audition":
      return {
        clip_drag: { alt: "copy" },
        automation_point: { shift: "constrain_axis" },
      };
    case "studio_one":
      // Shift remains unavailable as a gesture starter because Studio One
      // evaluates it after pointer-down. Timeline's live-drag resolver applies
      // and removes the snap bypass as Shift changes during the move.
      return { clip_drag: { alt: "copy" } };
    case "ableton_live":
      {
        const bypassModifier = platform === "macos" ? "primary" : "alt";
        const bypassWithFine = platform === "macos" ? "primary+shift" : "alt+shift";
        return {
          clip_drag: { [platform === "macos" ? "alt" : "primary"]: "copy" },
          automation_point: {
            shift: "fine",
            [bypassModifier]: "bypass_snap",
            [bypassWithFine]: "fine_bypass_snap",
          },
        };
      }
    case "reason":
      {
        const copyModifier = platform === "macos" ? "alt" : "primary";
        const constrainedCopy = platform === "macos" ? "alt+shift" : "primary+shift";
        return {
          clip_drag: { [copyModifier]: "copy" },
          automation_point: {
            shift: "constrain_axis",
            [copyModifier]: "copy",
            [constrainedCopy]: "copy_constrain_axis",
          },
        };
      }
    case "reaper":
      return { clip_drag: { primary: "copy" } };
    case "mixcraft":
      return {
        clip_drag: {
          alt: "copy",
          "alt+shift": "copy_preserve_time",
        },
      };
    case "fl_studio":
      return {
        automation_point: {
          shift: "constrain_x",
          primary: "constrain_y",
          alt: "bypass_snap",
          "alt+shift": "constrain_x_bypass_snap",
          "primary+alt": "constrain_y_bypass_snap",
          // Both axes are locked by these exact combinations in FL Studio.
          "primary+shift": "none",
          "primary+alt+shift": "none",
        },
      };
    default:
      return {};
  }
}

export function getMouseBehaviorProfile(
  profileId: unknown,
  platform: ShortcutPlatform,
): MouseBehaviorProfile {
  const keyboardProfile = getKeyboardShortcutProfile(profileId);
  return {
    id: keyboardProfile.id,
    name: keyboardProfile.name,
    description: keyboardProfile.description,
    wheel: createWheelProfile(keyboardProfile.id, keyboardProfile.name, platform),
    modifiers: createModifierProfile(
      keyboardProfile.id,
      keyboardProfile.name,
      pointerOverrides(keyboardProfile.id, platform),
    ),
  };
}

export const MOUSE_BEHAVIOR_PROFILE_OPTIONS = KEYBOARD_SHORTCUT_PROFILES.map((profile) => ({
  value: profile.id,
  label: profile.name,
}));

export function toMouseBehaviorPlatform(
  platform: ShortcutPlatform,
): "macos" | "windows" | "other" {
  if (platform === "macos" || platform === "windows") return platform;
  return "other";
}

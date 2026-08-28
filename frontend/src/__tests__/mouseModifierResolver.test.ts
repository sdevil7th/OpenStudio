import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOUSE_MODIFIER_PRECEDENCE,
  MOUSE_MODIFIER_ACTIONS,
  MOUSE_MODIFIER_CONTEXTS,
  OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS,
  OPENSTUDIO_MOUSE_MODIFIER_PROFILE,
  canonicalizeMouseModifierCombination,
  isMouseModifierActionForContext,
  normalizeMouseModifiers,
  resolveMouseModifier,
  resolveMouseModifierAction,
  type MouseLogicalModifier,
  type MouseModifierCombination,
  type MouseModifierContext,
  type MouseModifierPlatform,
  type MouseModifierProfile,
  type PointerModifierEventLike,
} from "../utils/mouseModifierResolver";

const logicalModifierOrder = [
  "primary",
  "secondary",
  "alt",
  "shift",
] as const satisfies readonly MouseLogicalModifier[];

interface ContextDefaults {
  none: string;
  primary: string;
  alt: string;
  shift: string;
}

const contextDefaults: Record<MouseModifierContext, ContextDefaults> = {
  clip_drag: { none: "move", primary: "copy", alt: "bypass_snap", shift: "constrain" },
  clip_resize: { none: "resize", primary: "fine", alt: "stretch", shift: "symmetric" },
  timeline_click: { none: "seek", primary: "select_range", alt: "razor", shift: "extend_selection" },
  track_header: { none: "select", primary: "toggle_select", alt: "solo", shift: "range_select" },
  automation_point: { none: "move", primary: "fine", alt: "delete", shift: "constrain_y" },
  fade_handle: { none: "adjust", primary: "fine", alt: "shape_cycle", shift: "symmetric" },
  ruler_click: { none: "seek", primary: "loop_set", alt: "zoom_to", shift: "time_select" },
};

function eventForLogicalModifiers(
  platform: MouseModifierPlatform,
  active: ReadonlySet<MouseLogicalModifier>,
): PointerModifierEventLike {
  const primary = active.has("primary");
  const secondary = active.has("secondary");
  return {
    ctrlKey: platform === "macos" ? secondary : primary,
    metaKey: platform === "macos" ? primary : secondary,
    altKey: active.has("alt"),
    shiftKey: active.has("shift"),
  };
}

function expectedCombination(active: ReadonlySet<MouseLogicalModifier>): MouseModifierCombination {
  const ordered = logicalModifierOrder.filter((modifier) => active.has(modifier));
  return ordered.length === 0 ? "none" : ordered.join("+") as MouseModifierCombination;
}

function expectedDefaultAction(
  context: MouseModifierContext,
  active: ReadonlySet<MouseLogicalModifier>,
): string {
  const defaults = contextDefaults[context];
  if (active.size === 0) return defaults.none;
  if (context === "clip_drag" && active.size === 2 && active.has("primary") && active.has("shift")) {
    return "slip";
  }
  if (active.has("primary")) return defaults.primary;
  // OpenStudio intentionally leaves the secondary modifier unassigned. It is
  // skipped during precedence fallback rather than becoming a plain click.
  if (active.has("alt")) return defaults.alt;
  if (active.has("shift")) return defaults.shift;
  return "none";
}

const exhaustiveCases = (["windows", "macos"] as const).flatMap((platform) => (
  MOUSE_MODIFIER_CONTEXTS.flatMap((context) => (
    Array.from({ length: 16 }, (_, mask) => {
      const active = new Set<MouseLogicalModifier>(
        logicalModifierOrder.filter((_, index) => Boolean(mask & (1 << index))),
      );
      return {
        label: `${platform} ${context} ${expectedCombination(active)}`,
        platform,
        context,
        active,
        event: eventForLogicalModifiers(platform, active),
        expectedAction: expectedDefaultAction(context, active),
        expectedCombination: expectedCombination(active),
      };
    })
  ))
));

describe("mouse modifier normalization", () => {
  it.each([
    {
      label: "Windows Control/Meta",
      platform: "windows" as const,
      event: { ctrlKey: true, metaKey: true },
    },
    {
      label: "macOS Command/physical Control",
      platform: "macos" as const,
      event: { ctrlKey: true, metaKey: true },
    },
  ])("keeps primary and secondary independent for $label", ({ platform, event }) => {
    expect(normalizeMouseModifiers(event, platform)).toMatchObject({
      primary: true,
      secondary: true,
      alt: false,
      shift: false,
      combination: "primary+secondary",
    });
  });

  it("maps raw modifiers to their correct semantic role per platform", () => {
    expect(normalizeMouseModifiers({ ctrlKey: true }, "windows")).toMatchObject({
      primary: true,
      secondary: false,
      combination: "primary",
    });
    expect(normalizeMouseModifiers({ metaKey: true }, "windows")).toMatchObject({
      primary: false,
      secondary: true,
      combination: "secondary",
    });
    expect(normalizeMouseModifiers({ metaKey: true }, "macos")).toMatchObject({
      primary: true,
      secondary: false,
      combination: "primary",
    });
    expect(normalizeMouseModifiers({ ctrlKey: true }, "macos")).toMatchObject({
      primary: false,
      secondary: true,
      combination: "secondary",
    });
    expect(normalizeMouseModifiers({ altKey: true }, "macos")).toMatchObject({
      alt: true,
      combination: "alt",
    });
  });

  it.each((['windows', 'macos'] as const).flatMap((platform) => (
    Array.from({ length: 16 }, (_, mask) => {
      const active = new Set<MouseLogicalModifier>(
        logicalModifierOrder.filter((_, index) => Boolean(mask & (1 << index))),
      );
      return { platform, active, expected: expectedCombination(active) };
    })
  )))("canonicalizes every exact $platform modifier combination as $expected", ({
    platform,
    active,
    expected,
  }) => {
    const result = normalizeMouseModifiers(eventForLogicalModifiers(platform, active), platform);
    expect(result.combination).toBe(expected);
    expect(result.active).toEqual(logicalModifierOrder.filter((modifier) => active.has(modifier)));
  });

  it.each([
    ["ctrl", "primary"],
    ["Command", "primary"],
    ["cmd + option + SHIFT", "primary+alt+shift"],
    ["secondary+alt", "secondary+alt"],
    ["shift + primary + secondary + alt", "primary+secondary+alt+shift"],
    ["none", "none"],
  ] as const)("canonicalizes the mapping key %s", (input, expected) => {
    expect(canonicalizeMouseModifierCombination(input)).toBe(expected);
  });

  it.each(["", "meta", "control", "primary+primary", "none+shift", "ctrl+command", "banana"])(
    "rejects ambiguous or malformed mapping key %s",
    (input) => {
      expect(canonicalizeMouseModifierCombination(input)).toBeNull();
    },
  );
});

describe("OpenStudio mouse modifier profile", () => {
  it.each(exhaustiveCases)("resolves $label", ({
    platform,
    context,
    event,
    expectedAction,
    expectedCombination: combination,
  }) => {
    const result = resolveMouseModifier(event, context, { platform });
    expect(result.action).toBe(expectedAction);
    expect(result.modifiers.combination).toBe(combination);
    expect(result.profileId).toBe("openstudio");
    expect(result.context).toBe(context);
    expect(result.isNoop).toBe(expectedAction === "none");

    if (expectedAction === "none") {
      expect(result).toMatchObject({
        source: "none",
        matchKind: "none",
        matchedCombination: null,
        matched: false,
      });
    } else {
      const mappings = OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS[context] as Partial<
        Record<MouseModifierCombination, string>
      >;
      const exact = Object.prototype.hasOwnProperty.call(mappings, combination);
      expect(result).toMatchObject({
        source: "profile",
        matchKind: exact ? "exact" : "precedence",
        matched: true,
      });
    }
  });

  it("exposes the current Preferences contexts, actions, and defaults", () => {
    expect(MOUSE_MODIFIER_CONTEXTS).toEqual([
      "clip_drag",
      "clip_resize",
      "timeline_click",
      "track_header",
      "automation_point",
      "fade_handle",
      "ruler_click",
    ]);
    expect(DEFAULT_MOUSE_MODIFIER_PRECEDENCE).toEqual([
      "primary",
      "secondary",
      "alt",
      "shift",
    ]);

    for (const context of MOUSE_MODIFIER_CONTEXTS) {
      for (const action of Object.values(OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS[context])) {
        expect(isMouseModifierActionForContext(context, action)).toBe(true);
        expect(MOUSE_MODIFIER_ACTIONS[context]).toContain(action);
      }
    }
  });

  it("returns the semantic action directly through the convenience API", () => {
    expect(resolveMouseModifierAction(
      { ctrlKey: true },
      "clip_drag",
      { platform: "windows" },
    )).toBe("copy");
    expect(resolveMouseModifierAction(
      { metaKey: true },
      "clip_drag",
      { platform: "macos" },
    )).toBe("copy");
  });

  it.each(["windows", "macos"] as const)(
    "keeps OpenStudio slip and razor gestures semantic on %s",
    (platform) => {
      expect(resolveMouseModifierAction(
        eventForLogicalModifiers(platform, new Set(["primary", "shift"])),
        "clip_drag",
        { platform },
      )).toBe("slip");
      expect(resolveMouseModifierAction(
        eventForLogicalModifiers(platform, new Set(["alt"])),
        "timeline_click",
        { platform },
      )).toBe("razor");
    },
  );
});

describe("exact combinations and precedence", () => {
  const combinedProfile: MouseModifierProfile = {
    id: "combined",
    name: "Combined",
    mappings: {
      ...OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS,
      clip_drag: {
        ...OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS.clip_drag,
        secondary: "select",
        "primary+shift": "constrain",
      },
    },
  };

  it.each(["windows", "macos"] as const)(
    "lets an exact combined mapping win on %s",
    (platform) => {
      const active = new Set<MouseLogicalModifier>(["primary", "shift"]);
      expect(resolveMouseModifier(
        eventForLogicalModifiers(platform, active),
        "clip_drag",
        { platform, profile: combinedProfile },
      )).toMatchObject({
        action: "constrain",
        source: "profile",
        matchKind: "exact",
        matchedCombination: "primary+shift",
      });
    },
  );

  it.each(["windows", "macos"] as const)(
    "uses a mapped physical secondary modifier before Alt and Shift on %s",
    (platform) => {
      const active = new Set<MouseLogicalModifier>(["secondary", "alt", "shift"]);
      expect(resolveMouseModifier(
        eventForLogicalModifiers(platform, active),
        "clip_drag",
        { platform, profile: combinedProfile },
      )).toMatchObject({
        action: "select",
        matchKind: "precedence",
        matchedCombination: "secondary",
      });
    },
  );

  it("allows profiles to change single-modifier fallback order", () => {
    const shiftFirst: MouseModifierProfile = {
      ...combinedProfile,
      id: "shift-first",
      modifierPrecedence: ["shift", "alt", "primary", "secondary"],
      mappings: {
        ...combinedProfile.mappings,
        clip_drag: OPENSTUDIO_MOUSE_MODIFIER_MAPPINGS.clip_drag,
      },
    };
    expect(resolveMouseModifier(
      { ctrlKey: true, altKey: true, shiftKey: true },
      "clip_drag",
      { platform: "windows", profile: shiftFirst },
    )).toMatchObject({
      action: "constrain",
      matchKind: "precedence",
      matchedCombination: "shift",
    });
  });
});

describe("user override maps and safe no-op behavior", () => {
  it.each(["windows", "macos"] as const)(
    "accepts the legacy ctrl override as semantic primary on %s",
    (platform) => {
      const event = eventForLogicalModifiers(platform, new Set(["primary"]));
      expect(resolveMouseModifier(event, "clip_drag", {
        platform,
        overrides: { clip_drag: { ctrl: "select" } },
      })).toMatchObject({
        action: "select",
        source: "override",
        matchKind: "exact",
        matchedCombination: "primary",
      });
    },
  );

  it("uses an exact combined override before profile and fallback mappings", () => {
    expect(resolveMouseModifier(
      { ctrlKey: true, altKey: true, shiftKey: true },
      "clip_drag",
      {
        platform: "windows",
        overrides: {
          clip_drag: {
            primary: "select",
            "primary+alt+shift": "constrain",
          },
        },
      },
    )).toMatchObject({
      action: "constrain",
      source: "override",
      matchKind: "exact",
      matchedCombination: "primary+alt+shift",
    });
  });

  it("honors explicit none without falling through to a destructive action", () => {
    expect(resolveMouseModifier(
      { ctrlKey: true, shiftKey: true },
      "clip_drag",
      {
        platform: "windows",
        overrides: { clip_drag: { "primary+shift": "none" } },
      },
    )).toMatchObject({
      action: "none",
      source: "override",
      matchKind: "exact",
      matched: true,
      isNoop: true,
    });
  });

  it.each([
    ["action from another context", { clip_drag: { primary: "delete" } }],
    ["unknown action", { clip_drag: { primary: "launch_missiles" } }],
    ["non-string action", { clip_drag: { primary: 42 } }],
    ["undefined persisted value", { clip_drag: { primary: undefined } }],
  ] as const)("turns an invalid %s into a safe no-op", (_label, overrides) => {
    expect(resolveMouseModifier(
      { ctrlKey: true },
      "clip_drag",
      { platform: "windows", overrides },
    )).toMatchObject({
      action: "none",
      source: "override",
      matched: true,
      isNoop: true,
    });
  });

  it("does not turn an unmapped modified gesture into a plain click", () => {
    expect(resolveMouseModifier(
      { metaKey: true },
      "automation_point",
      { platform: "windows" },
    )).toMatchObject({
      action: "none",
      source: "none",
      matched: false,
    });
  });

  it("does not mutate the factory profile while resolving overrides", () => {
    const before = JSON.stringify(OPENSTUDIO_MOUSE_MODIFIER_PROFILE);
    resolveMouseModifier({ ctrlKey: true }, "timeline_click", {
      platform: "windows",
      overrides: { timeline_click: { primary: "zoom" } },
    });
    expect(JSON.stringify(OPENSTUDIO_MOUSE_MODIFIER_PROFILE)).toBe(before);
    expect(resolveMouseModifierAction(
      { ctrlKey: true },
      "timeline_click",
      { platform: "windows" },
    )).toBe("select_range");
  });

  it("rejects AltGraph instead of treating it as a Ctrl+Alt gesture", () => {
    expect(resolveMouseModifier(
      {
        ctrlKey: true,
        altKey: true,
        getModifierState: (modifier) => modifier === "AltGraph",
      },
      "clip_drag",
      { platform: "windows" },
    )).toMatchObject({
      action: "none",
      source: "unsupported",
      matchKind: "none",
      matched: false,
      modifiers: { altGraph: true },
    });
  });

  it("fails safely when an imported runtime context is unknown", () => {
    const invalidContext = "unknown_surface" as MouseModifierContext;
    expect(resolveMouseModifier(
      {},
      invalidContext,
      { platform: "windows" },
    )).toMatchObject({
      action: "none",
      source: "unsupported",
      matched: false,
    });
  });
});

describe("keyboard-layout independence", () => {
  it.each([
    { layout: "QWERTY", key: "z", code: "KeyZ" },
    { layout: "QWERTZ", key: "z", code: "KeyY" },
    { layout: "AZERTY", key: "q", code: "KeyA" },
    { layout: "Dvorak", key: ";", code: "KeyZ" },
  ])("resolves only pointer modifiers on $layout", (layoutEvent) => {
    const event = {
      ...layoutEvent,
      ctrlKey: true,
      shiftKey: true,
      button: 0,
    };
    expect(resolveMouseModifier(event, "ruler_click", { platform: "windows" }))
      .toMatchObject({
        action: "loop_set",
        matchKind: "precedence",
        matchedCombination: "primary",
      });
  });

  it("resolves identically when browser pointer metadata is missing", () => {
    expect(resolveMouseModifierAction(
      { ctrlKey: true },
      "track_header",
      { platform: "other" },
    )).toBe("toggle_select");
  });
});

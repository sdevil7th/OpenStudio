import { describe, expect, it } from "vitest";
import {
  DEFAULT_WHEEL_NORMALIZATION,
  OPENSTUDIO_WHEEL_PROFILE,
  inferWheelInputDevice,
  normalizeWheelDelta,
  normalizeWheelModifiers,
  resolveWheelGesture,
  type WheelBehaviorProfile,
  type WheelEventLike,
  type WheelSubtarget,
  type WheelSurface,
} from "../utils/wheelGestureResolver";

interface ModifierCase {
  label: string;
  primary: boolean;
  secondary: boolean;
  alt: boolean;
  shift: boolean;
  event: WheelEventLike;
}

const modifierCases: ModifierCase[] = Array.from({ length: 16 }, (_, mask) => {
  const primary = Boolean(mask & 1);
  const secondary = Boolean(mask & 2);
  const alt = Boolean(mask & 4);
  const shift = Boolean(mask & 8);
  const active = [
    primary ? "Primary" : "",
    secondary ? "Secondary" : "",
    alt ? "Alt" : "",
    shift ? "Shift" : "",
  ].filter(Boolean);
  return {
    label: active.join("+") || "plain",
    primary,
    secondary,
    alt,
    shift,
    event: {
      deltaX: 4,
      deltaY: 12,
      ctrlKey: primary,
      metaKey: secondary,
      altKey: alt,
      shiftKey: shift,
      clientX: 120,
      clientY: 240,
    },
  };
});

function resolveOpenStudio(
  event: WheelEventLike,
  surface: WheelSurface,
  subtarget?: WheelSubtarget,
) {
  return resolveWheelGesture(event, {
    surface,
    subtarget,
    platform: "windows",
    hoveredTargetId: "hovered-id",
  });
}

describe("wheel delta normalization", () => {
  it("preserves pixel deltas and sanitizes absent or non-finite values", () => {
    expect(normalizeWheelDelta({ deltaX: -2.5, deltaY: 7, deltaMode: 0 })).toEqual({
      x: -2.5,
      y: 7,
      mode: "pixel",
      sourceMode: 0,
      isZero: false,
    });
    expect(normalizeWheelDelta({ deltaX: Number.NaN, deltaY: Number.POSITIVE_INFINITY })).toEqual({
      x: 0,
      y: 0,
      mode: "pixel",
      sourceMode: 0,
      isZero: true,
    });
  });

  it("converts line and page deltas with configurable CSS-pixel units", () => {
    expect(normalizeWheelDelta(
      { deltaX: 2, deltaY: -3, deltaMode: 1 },
      { lineHeightPx: 20 },
    )).toMatchObject({ x: 40, y: -60, mode: "line", sourceMode: 1 });
    expect(normalizeWheelDelta(
      { deltaX: -0.5, deltaY: 1, deltaMode: 2 },
      { pageHeightPx: 640 },
    )).toMatchObject({ x: -320, y: 640, mode: "page", sourceMode: 2 });
  });

  it("uses safe defaults for invalid options and caps each converted axis", () => {
    expect(normalizeWheelDelta(
      { deltaX: -1_000, deltaY: 1_000, deltaMode: 1 },
      { lineHeightPx: -1, pageHeightPx: 0, maxAbsDeltaPx: 300 },
    )).toMatchObject({ x: -300, y: 300, mode: "line" });
    expect(DEFAULT_WHEEL_NORMALIZATION).toEqual({
      lineHeightPx: 16,
      pageHeightPx: 800,
      maxAbsDeltaPx: 2400,
    });
  });

  it("treats unknown delta modes as pixels without losing the diagnostic source mode", () => {
    expect(normalizeWheelDelta({ deltaX: 3, deltaY: 5, deltaMode: 99 })).toEqual({
      x: 3,
      y: 5,
      mode: "pixel",
      sourceMode: 99,
      isZero: false,
    });
  });

  it("lets the local context override profile normalization", () => {
    const profile: WheelBehaviorProfile = {
      ...OPENSTUDIO_WHEEL_PROFILE,
      id: "normalization-test",
      normalization: { lineHeightPx: 10, maxAbsDeltaPx: 1_000 },
    };
    const result = resolveWheelGesture(
      { deltaY: 3, deltaMode: 1 },
      {
        surface: "timeline",
        platform: "windows",
        normalization: { lineHeightPx: 25 },
      },
      profile,
    );
    expect(result.delta.y).toBe(75);
    expect(result.amount).toBe(75);
  });
});

describe("wheel modifier normalization", () => {
  it("keeps primary, secondary, Alt/Option, and Shift independent on Windows", () => {
    expect(normalizeWheelModifiers({
      ctrlKey: true,
      metaKey: true,
      altKey: true,
      shiftKey: true,
    }, "windows")).toEqual({
      primary: true,
      secondary: true,
      alt: true,
      shift: true,
      raw: {
        control: true,
        commandOrMeta: true,
        altOrOption: true,
        shift: true,
      },
    });
  });

  it("maps Command to primary and physical Control to secondary on macOS", () => {
    expect(normalizeWheelModifiers({ metaKey: true }, "macos")).toMatchObject({
      primary: true,
      secondary: false,
      alt: false,
    });
    expect(normalizeWheelModifiers({ ctrlKey: true }, "macos")).toMatchObject({
      primary: false,
      secondary: true,
      alt: false,
    });
    expect(normalizeWheelModifiers({ altKey: true }, "macos")).toMatchObject({
      primary: false,
      secondary: false,
      alt: true,
    });
  });

  it("uses Control as primary and Meta as secondary on other desktop platforms", () => {
    expect(normalizeWheelModifiers({ ctrlKey: true }, "other")).toMatchObject({
      primary: true,
      secondary: false,
    });
    expect(normalizeWheelModifiers({ metaKey: true }, "other")).toMatchObject({
      primary: false,
      secondary: true,
    });
  });
});

describe("wheel device hints", () => {
  it("always trusts an explicit host hint", () => {
    expect(inferWheelInputDevice({ deltaY: 120, deltaMode: 1 }, "trackpad")).toEqual({
      device: "trackpad",
      basis: "explicit",
    });
    expect(inferWheelInputDevice({ deltaY: 0.25 }, "unknown")).toEqual({
      device: "unknown",
      basis: "explicit",
    });
  });

  it.each([
    [{ deltaY: 3, deltaMode: 1 }, "mouse", "line-or-page-mode"],
    [{ deltaY: 1, deltaMode: 2 }, "mouse", "line-or-page-mode"],
    [{ deltaX: 3, deltaY: 4 }, "trackpad", "two-axis-pixel-delta"],
    [{ deltaY: 0.5 }, "trackpad", "fractional-pixel-delta"],
    [{ deltaY: 120 }, "mouse", "large-integer-pixel-delta"],
    [{ deltaY: 12 }, "unknown", "insufficient-signal"],
    [{ deltaX: 0, deltaY: 0 }, "unknown", "insufficient-signal"],
  ] as const)("classifies %o as %s from %s", (event, device, basis) => {
    expect(inferWheelInputDevice(event)).toEqual({ device, basis });
  });
});

describe("OpenStudio Timeline wheel matrix", () => {
  it.each(modifierCases)("resolves $label with documented precedence", (entry) => {
    const result = resolveOpenStudio(entry.event, "timeline", "content");
    if (entry.primary && entry.shift) {
      expect(result).toMatchObject({
        ruleId: "timeline.waveform-amplitude",
        operation: "zoom",
        target: "waveform-amplitude",
        axis: "vertical",
        amount: 12,
        preventDefault: true,
        stopPropagation: true,
      });
      expect(result.anchor).toEqual({
        kind: "hovered-track",
        clientX: 120,
        clientY: 240,
        targetId: "hovered-id",
      });
    } else if (entry.primary) {
      expect(result).toMatchObject({
        ruleId: "timeline.horizontal-zoom",
        operation: "zoom",
        target: "timeline",
        axis: "horizontal",
        amount: 12,
        preventDefault: true,
        stopPropagation: true,
      });
      expect(result.anchor.kind).toBe("pointer");
    } else if (entry.alt) {
      expect(result).toMatchObject({
        ruleId: "timeline.track-height",
        operation: "resize",
        target: "track-height",
        axis: "vertical",
        amount: 12,
      });
    } else if (entry.shift) {
      expect(result).toMatchObject({
        ruleId: "timeline.horizontal-scroll",
        operation: "scroll",
        target: "viewport",
        axis: "horizontal",
        amount: 24,
        preventDefault: true,
        stopPropagation: false,
      });
    } else {
      expect(result).toMatchObject({
        ruleId: "timeline.native-scroll",
        operation: "native-scroll",
        target: "native",
        axis: "vertical",
        amount: 12,
        preventDefault: false,
        stopPropagation: false,
      });
    }
  });

  it.each(["content", "ruler", "track"] as const)(
    "uses pointer-anchored zoom on the %s subtarget",
    (subtarget) => {
      const result = resolveOpenStudio({
        deltaY: -8,
        ctrlKey: true,
        clientX: 0,
        clientY: 31,
      }, "timeline", subtarget);
      expect(result.ruleId).toBe("timeline.horizontal-zoom");
      expect(result.anchor).toEqual({
        kind: "pointer",
        clientX: 0,
        clientY: 31,
        targetId: "hovered-id",
      });
    },
  );
});

describe("OpenStudio TCP wheel matrix", () => {
  it.each(modifierCases)("resolves $label without leaking browser zoom", (entry) => {
    const result = resolveOpenStudio(entry.event, "tcp", "track");
    if (entry.alt) {
      expect(result).toMatchObject({
        ruleId: "tcp.track-height",
        operation: "resize",
        target: "track-height",
        amount: 12,
        preventDefault: true,
        stopPropagation: true,
      });
    } else if (entry.primary) {
      expect(result).toMatchObject({
        ruleId: "tcp.suppress-browser-zoom",
        operation: "suppress",
        target: "native",
        preventDefault: true,
        stopPropagation: false,
      });
    } else {
      expect(result).toMatchObject({
        ruleId: "tcp.native-scroll",
        operation: "native-scroll",
        axis: "vertical",
        preventDefault: false,
      });
    }
  });

  it.each(["track", "empty"] as const)("supports the %s subtarget", (subtarget) => {
    expect(resolveOpenStudio({ deltaY: 9, altKey: true }, "tcp", subtarget).ruleId)
      .toBe("tcp.track-height");
  });
});

describe("OpenStudio Piano Roll wheel matrix", () => {
  it.each(modifierCases)("resolves $label in the note grid", (entry) => {
    const result = resolveOpenStudio(entry.event, "piano_roll", "grid");
    if (entry.primary) {
      expect(result).toMatchObject({
        ruleId: "piano-roll.horizontal-zoom",
        operation: "zoom",
        target: "timeline",
        axis: "horizontal",
        amount: 12,
        preventDefault: true,
      });
      expect(result.anchor.kind).toBe("pointer");
    } else if (entry.shift) {
      expect(result).toMatchObject({
        ruleId: "piano-roll.shift-horizontal-scroll",
        operation: "scroll",
        target: "viewport",
        axis: "horizontal",
        amount: 16,
      });
    } else {
      expect(result).toMatchObject({
        ruleId: "piano-roll.dominant-axis-scroll",
        operation: "scroll",
        target: "viewport",
        axis: "vertical",
        amount: 12,
      });
    }
  });

  it.each(modifierCases)("keeps $label native over the sidebar", (entry) => {
    expect(resolveOpenStudio(entry.event, "piano_roll", "sidebar")).toMatchObject({
      ruleId: "piano-roll.sidebar-native-scroll",
      operation: "native-scroll",
      target: "native",
      axis: "vertical",
      amount: 12,
      preventDefault: false,
      stopPropagation: false,
    });
  });

  it("uses native deltaX for horizontal trackpad intent and vertical on a tie", () => {
    expect(resolveOpenStudio({ deltaX: -18, deltaY: 4 }, "piano_roll", "grid"))
      .toMatchObject({ axis: "horizontal", amount: -18 });
    expect(resolveOpenStudio({ deltaX: 8, deltaY: -8 }, "piano_roll", "grid"))
      .toMatchObject({ axis: "vertical", amount: -8 });
  });

  it.each(["grid", "keyboard", "controller_lane"] as const)(
    "applies editor zoom in the %s subtarget",
    (subtarget) => {
      expect(resolveOpenStudio({ deltaY: 10, ctrlKey: true }, "piano_roll", subtarget).ruleId)
        .toBe("piano-roll.horizontal-zoom");
    },
  );
});

describe("OpenStudio Pitch Editor wheel matrix", () => {
  it.each(modifierCases)("resolves $label", (entry) => {
    const result = resolveOpenStudio(entry.event, "pitch_editor", "grid");
    if (entry.primary) {
      expect(result).toMatchObject({
        ruleId: "pitch-editor.horizontal-zoom",
        operation: "zoom",
        target: "timeline",
        axis: "horizontal",
        amount: 12,
      });
    } else if (entry.shift) {
      expect(result).toMatchObject({
        ruleId: "pitch-editor.horizontal-scroll",
        operation: "scroll",
        target: "viewport",
        axis: "horizontal",
        amount: 24,
      });
    } else {
      expect(result).toMatchObject({
        ruleId: "pitch-editor.vertical-pitch-scroll",
        operation: "scroll",
        target: "viewport",
        axis: "vertical",
        amount: -12,
      });
    }
    expect(result.preventDefault).toBe(true);
  });

  it.each(["grid", "keyboard"] as const)("resolves the %s subtarget", (subtarget) => {
    expect(resolveOpenStudio({ deltaY: 7 }, "pitch_editor", subtarget).ruleId)
      .toBe("pitch-editor.vertical-pitch-scroll");
  });
});

describe("OpenStudio Browser wheel matrix", () => {
  it.each(modifierCases)("resolves $label", (entry) => {
    const result = resolveOpenStudio(entry.event, "browser", "list");
    if (entry.primary) {
      expect(result).toMatchObject({
        ruleId: "browser.suppress-browser-zoom",
        operation: "suppress",
        target: "native",
        axis: "vertical",
        preventDefault: true,
      });
    } else if (entry.shift) {
      expect(result).toMatchObject({
        ruleId: "browser.native-horizontal-scroll",
        operation: "native-scroll",
        target: "native",
        axis: "horizontal",
        amount: 16,
        preventDefault: false,
      });
    } else {
      expect(result).toMatchObject({
        ruleId: "browser.native-scroll",
        operation: "native-scroll",
        target: "native",
        axis: "vertical",
        amount: 12,
        preventDefault: false,
      });
    }
  });

  it.each(["list", "tree", "preview"] as const)("supports the %s subtarget", (subtarget) => {
    expect(resolveOpenStudio({ deltaX: 15, deltaY: 3 }, "browser", subtarget))
      .toMatchObject({ ruleId: "browser.native-scroll", axis: "horizontal", amount: 15 });
  });
});

describe("OpenStudio Parameter wheel matrix", () => {
  it.each(modifierCases)("resolves $label as an owned adjustment", (entry) => {
    const result = resolveOpenStudio(entry.event, "parameter", "control");
    expect(result).toMatchObject({
      ruleId: entry.shift ? "parameter.fine-adjust" : "parameter.adjust",
      operation: "adjust",
      target: "parameter",
      axis: "vertical",
      amount: 12,
      precision: entry.shift ? "fine" : "normal",
      preventDefault: true,
      stopPropagation: true,
    });
    expect(result.anchor).toEqual({
      kind: "hovered-control",
      clientX: 120,
      clientY: 240,
      targetId: "hovered-id",
    });
  });

  it.each(["control", "graph"] as const)("supports the %s subtarget", (subtarget) => {
    expect(resolveOpenStudio({ deltaY: -5 }, "parameter", subtarget).ruleId)
      .toBe("parameter.adjust");
  });
});

describe("profile-driven wheel behavior", () => {
  it("allows a profile to prepend a different behavior without component changes", () => {
    const profile: WheelBehaviorProfile = {
      id: "custom-reaper-like",
      name: "Custom REAPER-like",
      rules: [
        {
          id: "custom.timeline.plain-zoom",
          surface: "timeline",
          modifiers: { primary: false, secondary: false, alt: false, shift: false },
          operation: "zoom",
          target: "timeline",
          axis: "horizontal",
          deltaSource: "y",
          anchor: "pointer",
          preventDefault: true,
          stopPropagation: true,
        },
        ...OPENSTUDIO_WHEEL_PROFILE.rules,
      ],
    };
    const result = resolveWheelGesture(
      { deltaY: -10, clientX: 42 },
      { surface: "timeline", subtarget: "content", platform: "windows" },
      profile,
    );
    expect(result).toMatchObject({
      profileId: "custom-reaper-like",
      ruleId: "custom.timeline.plain-zoom",
      operation: "zoom",
      target: "timeline",
      amount: -10,
      preventDefault: true,
    });
    expect(result.anchor).toMatchObject({ kind: "pointer", clientX: 42 });
  });

  it("can select rules by inferred or explicit input-device hint", () => {
    const profile: WheelBehaviorProfile = {
      id: "device-aware",
      name: "Device-aware",
      rules: [
        {
          id: "timeline.trackpad-pan",
          surface: "timeline",
          devices: ["trackpad"],
          operation: "scroll",
          target: "viewport",
          axis: "dominant",
          deltaSource: "dominant",
          preventDefault: true,
          stopPropagation: false,
        },
        {
          id: "timeline.mouse-zoom",
          surface: "timeline",
          devices: ["mouse"],
          operation: "zoom",
          target: "timeline",
          axis: "horizontal",
          deltaSource: "y",
          preventDefault: true,
          stopPropagation: true,
        },
      ],
    };

    expect(resolveWheelGesture(
      { deltaX: 2, deltaY: 3 },
      { surface: "timeline", platform: "windows" },
      profile,
    ).ruleId).toBe("timeline.trackpad-pan");
    expect(resolveWheelGesture(
      { deltaY: 1 },
      { surface: "timeline", platform: "windows", deviceHint: "mouse" },
      profile,
    ).ruleId).toBe("timeline.mouse-zoom");
  });

  it("falls back safely to native dominant-axis scrolling when no profile rule matches", () => {
    const profile: WheelBehaviorProfile = {
      id: "empty",
      name: "Empty",
      rules: [],
    };
    expect(resolveWheelGesture(
      { deltaX: -21, deltaY: 4, ctrlKey: true },
      { surface: "browser", platform: "windows" },
      profile,
    )).toMatchObject({
      profileId: "empty",
      ruleId: null,
      matched: false,
      operation: "native-scroll",
      target: "native",
      axis: "horizontal",
      amount: -21,
      preventDefault: false,
      stopPropagation: false,
    });
  });

  it("returns stable zero movement while still resolving ownership", () => {
    expect(resolveOpenStudio({ deltaX: 0, deltaY: 0, ctrlKey: true }, "timeline", "content"))
      .toMatchObject({
        ruleId: "timeline.horizontal-zoom",
        operation: "zoom",
        amount: 0,
        delta: { isZero: true },
        preventDefault: true,
      });
  });

  it("uses platform-correct primary modifiers while preserving the secondary key", () => {
    const macCommand = resolveWheelGesture(
      { deltaY: 9, metaKey: true },
      { surface: "timeline", platform: "macos" },
    );
    expect(macCommand).toMatchObject({
      ruleId: "timeline.horizontal-zoom",
      modifiers: { primary: true, secondary: false },
    });

    const macControl = resolveWheelGesture(
      { deltaY: 9, ctrlKey: true },
      { surface: "timeline", platform: "macos" },
    );
    expect(macControl).toMatchObject({
      ruleId: "timeline.native-scroll",
      modifiers: { primary: false, secondary: true },
    });
  });
});

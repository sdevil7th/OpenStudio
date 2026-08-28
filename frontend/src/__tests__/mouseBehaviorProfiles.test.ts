import { describe, expect, it } from "vitest";
import { resolveMouseModifierAction } from "../utils/mouseModifierResolver";
import { getMouseBehaviorProfile } from "../utils/mouseBehaviorProfiles";
import type { ShortcutPlatform } from "../utils/platform";
import type { KeyboardShortcutProfileId } from "../utils/shortcutProfiles";
import {
  resolveWheelGesture,
  type WheelEventLike,
} from "../utils/wheelGestureResolver";

const DAW_PROFILE_IDS = [
  "pro_tools",
  "cubase",
  "reaper",
  "audacity",
  "logic_pro",
  "fl_studio",
  "ableton_live",
  "studio_one",
  "bitwig_studio",
  "reason",
  "cakewalk_sonar",
  "garageband",
  "digital_performer",
  "ardour",
  "adobe_audition",
  "mixcraft",
  "waveform",
  "renoise",
] as const satisfies readonly KeyboardShortcutProfileId[];

const TEST_PLATFORMS = ["macos", "windows"] as const satisfies readonly ShortcutPlatform[];

type ModifierSignature = `${0 | 1}${0 | 1}${0 | 1}${0 | 1}`;

function rawModifierCombinations(): WheelEventLike[] {
  return Array.from({ length: 16 }, (_, bits) => ({
    ctrlKey: Boolean(bits & 1),
    metaKey: Boolean(bits & 2),
    altKey: Boolean(bits & 4),
    shiftKey: Boolean(bits & 8),
    deltaY: 120,
  }));
}

function normalizedSignature(
  event: WheelEventLike,
  platform: ShortcutPlatform,
): ModifierSignature {
  const primary = platform === "macos" ? event.metaKey : event.ctrlKey;
  const secondary = platform === "macos" ? event.ctrlKey : event.metaKey;
  return `${Number(Boolean(primary))}${Number(Boolean(secondary))}${Number(Boolean(event.altKey))}${Number(Boolean(event.shiftKey))}` as ModifierSignature;
}

type ExpectedRules = Partial<Record<ModifierSignature, string>>;

function expectedTimelineRules(
  id: typeof DAW_PROFILE_IDS[number],
  platform: ShortcutPlatform,
): ExpectedRules {
  switch (id) {
    case "pro_tools":
      return {
        "0000": "pro-tools.vertical-scroll",
        "0001": "pro-tools.shift-horizontal-scroll",
        "0010": "pro-tools.option-horizontal-zoom",
        "0011": "pro-tools.option-shift-waveform-zoom",
        "1000": "pro-tools.slow-vertical-scroll",
        "0100": "pro-tools.fast-vertical-scroll",
      };
    case "cubase":
      return {
        "0000": "cubase.vertical-scroll",
        "0001": "cubase.shift-horizontal-scroll",
        "1000": "cubase.horizontal-zoom",
        "1001": "cubase.vertical-zoom",
      };
    case "reaper":
      return {
        "0000": "reaper.horizontal-zoom",
        "1000": "reaper.vertical-zoom",
        "0010": "reaper.horizontal-scroll",
        "1010": "reaper.vertical-scroll",
      };
    case "audacity":
      return {
        "0000": "audacity.vertical-scroll",
        "0001": "audacity.shift-horizontal-scroll",
        "1000": "audacity.horizontal-zoom",
      };
    case "logic_pro":
      return platform === "macos"
        ? { "0110": "logic-pro.control-option-horizontal-zoom" }
        : { "1010": "logic-pro.control-option-horizontal-zoom" };
    case "fl_studio":
      return {};
    case "ableton_live":
      return {
        "0000": "ableton-live.vertical-scroll",
        "0001": "ableton-live.shift-horizontal-scroll",
        "1000": "ableton-live.horizontal-zoom",
      };
    case "studio_one":
      return {
        "0000": "studio-one.vertical-scroll",
        "0001": "studio-one.shift-horizontal-scroll",
        "1000": "studio-one.vertical-zoom",
        "1001": "studio-one.horizontal-zoom",
      };
    case "bitwig_studio":
      return { "1010": "bitwig-studio.control-alt-horizontal-zoom" };
    case "reason":
      return {
        "0000": "reason.vertical-scroll",
        "0001": "reason.shift-horizontal-scroll",
        "1000": "reason.horizontal-zoom",
        "1001": "reason.vertical-sequencer-zoom",
      };
    case "cakewalk_sonar":
      return {
        "0010": "cakewalk-sonar.alt-horizontal-zoom",
        "0011": "cakewalk-sonar.alt-shift-fast-horizontal-zoom",
        "1010": "cakewalk-sonar.control-alt-track-height",
      };
    case "garageband":
      return {};
    case "digital_performer":
      return {
        "0010": "digital-performer.option-horizontal-zoom",
        "0110": "digital-performer.option-control-track-height",
      };
    case "ardour":
      return {
        "0000": "ardour.vertical-scroll",
        "0001": "ardour.shift-horizontal-scroll",
        "1000": "ardour.horizontal-zoom",
      };
    case "adobe_audition":
      // Audition's implementable default is limited to the ruler/zoom bar.
      return {};
    case "mixcraft":
      return {
        "0000": "mixcraft.horizontal-zoom",
        "1000": "mixcraft.control-horizontal-scroll",
        "0001": "mixcraft.shift-vertical-scroll",
      };
    case "waveform":
      return {
        "0000": "waveform.horizontal-zoom",
        "1000": "waveform.control-vertical-zoom",
      };
    case "renoise":
      return {};
  }
}

describe("DAW mouse behavior profiles", () => {
  it("uses source-safe exact pointer mappings for every profile and platform", () => {
    const unmodifiedActions = {
      clip_drag: "move",
      clip_resize: "resize",
      timeline_click: "seek",
      track_header: "select",
      automation_point: "move",
      fade_handle: "adjust",
      ruler_click: "seek",
    } as const;

    for (const platform of TEST_PLATFORMS) {
      for (const id of DAW_PROFILE_IDS) {
        const profile = getMouseBehaviorProfile(id, platform);
        const clipOverrides: ExpectedRules = {};
        if (["pro_tools", "cubase", "logic_pro", "adobe_audition"].includes(id)) {
          clipOverrides["0010"] = "copy";
        } else if (id === "studio_one" || id === "mixcraft") {
          clipOverrides["0010"] = "copy";
          if (id === "mixcraft") clipOverrides["0011"] = "copy_preserve_time";
        } else if (id === "ableton_live" || id === "reason") {
          clipOverrides[platform === "macos" ? "0010" : "1000"] = "copy";
        } else if (id === "reaper") {
          clipOverrides["1000"] = "copy";
        }
        const automationOverrides: ExpectedRules = {};
        if (id === "pro_tools") {
          automationOverrides["0001"] = "constrain_y";
        } else if (id === "cubase") {
          automationOverrides["1000"] = "constrain_axis";
          for (const signature of [
            "1100",
            "1010",
            "1001",
            "1110",
            "1101",
            "1011",
            "1111",
          ] as const) {
            automationOverrides[signature] = "constrain_axis_bypass_snap";
          }
        } else if (id === "fl_studio") {
          automationOverrides["0001"] = "constrain_x";
          automationOverrides["1000"] = "constrain_y";
          automationOverrides["0010"] = "bypass_snap";
          automationOverrides["0011"] = "constrain_x_bypass_snap";
          automationOverrides["1010"] = "constrain_y_bypass_snap";
        } else if (id === "ableton_live") {
          automationOverrides["0001"] = "fine";
          automationOverrides[platform === "macos" ? "1000" : "0010"] = "bypass_snap";
          automationOverrides[platform === "macos" ? "1001" : "0011"] = "fine_bypass_snap";
        } else if (id === "reason") {
          automationOverrides["0001"] = "constrain_axis";
          automationOverrides[platform === "macos" ? "0010" : "1000"] = "copy";
          automationOverrides[platform === "macos" ? "0011" : "1001"] = "copy_constrain_axis";
        } else if (id === "adobe_audition") {
          automationOverrides["0001"] = "constrain_axis";
        }

        for (const [context, unmodified] of Object.entries(unmodifiedActions) as Array<
          [keyof typeof unmodifiedActions, typeof unmodifiedActions[keyof typeof unmodifiedActions]]
        >) {
          for (const event of rawModifierCombinations()) {
            const signature = normalizedSignature(event, platform);
            const expected = signature === "0000"
              ? unmodified
              : context === "clip_drag"
                ? clipOverrides[signature] ?? "none"
                : context === "automation_point"
                  ? automationOverrides[signature] ?? "none"
                : "none";
            expect(resolveMouseModifierAction(
              event,
              context,
              { platform, profile: profile.modifiers },
            ), `${id}/${platform}/${context}/${signature}`).toBe(expected);
          }
        }
      }
    }
  });

  for (const platform of TEST_PLATFORMS) {
    for (const id of DAW_PROFILE_IDS) {
      it(`matches only documented ${id} timeline modifiers on ${platform}`, () => {
        const profile = getMouseBehaviorProfile(id, platform);
        const expected = expectedTimelineRules(id, platform);

        for (const event of rawModifierCombinations()) {
          const signature = normalizedSignature(event, platform);
          const gesture = resolveWheelGesture(
            event,
            {
              surface: "timeline",
              subtarget: "content",
              platform,
              deviceHint: "mouse",
              hoveredTargetId: "track-1",
            },
            profile.wheel,
          );
          const expectedRuleId = expected[signature] ?? null;
          expect(gesture.ruleId, `${id}/${platform}/${signature}`).toBe(expectedRuleId);
          expect(gesture.matched, `${id}/${platform}/${signature}`).toBe(expectedRuleId !== null);
        }
      });
    }
  }

  it("uses exact four-flag predicates for every source-DAW timeline rule", () => {
    for (const platform of TEST_PLATFORMS) {
      for (const id of DAW_PROFILE_IDS) {
        const timelineRules = getMouseBehaviorProfile(id, platform).wheel.rules
          .filter((rule) => rule.surface === "timeline");
        for (const rule of timelineRules) {
          expect(rule.modifiers, `${id}/${platform}/${rule.id}`).toEqual({
            primary: expect.any(Boolean),
            secondary: expect.any(Boolean),
            alt: expect.any(Boolean),
            shift: expect.any(Boolean),
          });
        }
      }
    }
  });

  it("does not silently inherit OpenStudio editor/TCP wheel mutations in vendor profiles", () => {
    const openStudioOnlySurfaces = new Set(["tcp", "piano_roll", "pitch_editor", "parameter"]);
    for (const platform of TEST_PLATFORMS) {
      for (const id of DAW_PROFILE_IDS) {
        const rules = getMouseBehaviorProfile(id, platform).wheel.rules;
        expect(rules.some((rule) => (
          openStudioOnlySurfaces.has(rule.surface)
          && /^(tcp|piano-roll|pitch-editor|parameter)\./.test(rule.id)
        )), `${id}/${platform}`).toBe(false);
        expect(rules.some((rule) => rule.id === `${id}.parameter-safety-fallback`)).toBe(true);
        expect(rules.some((rule) => rule.id === "browser.suppress-browser-zoom")).toBe(true);
      }
    }
  });

  it.each(TEST_PLATFORMS)("suppresses unsourced parameter wheel changes on %s", (platform) => {
    for (const id of ["logic_pro", "garageband", "digital_performer", "waveform", "renoise"] as const) {
      expect(resolveWheelGesture(
        { deltaY: 120 },
        { surface: "parameter", subtarget: "control", platform },
        getMouseBehaviorProfile(id, platform).wheel,
      )).toMatchObject({
        ruleId: `${id}.parameter-safety-fallback`,
        operation: "suppress",
        preventDefault: true,
        stopPropagation: true,
      });
    }
  });

  it("implements Pro Tools zoom and relative scroll-speed semantics", () => {
    const profile = getMouseBehaviorProfile("pro_tools", "macos");
    const resolve = (event: WheelEventLike) => resolveWheelGesture(
      { ...event, deltaY: 120 },
      {
        surface: "timeline",
        subtarget: "track",
        platform: "macos",
        hoveredTargetId: "track-1",
      },
      profile.wheel,
    );

    const plain = resolve({});
    const slow = resolve({ metaKey: true });
    const fast = resolve({ ctrlKey: true });
    const optionZoom = resolve({ altKey: true });
    const waveformZoom = resolve({ altKey: true, shiftKey: true });

    expect(slow.amount).toBeLessThan(plain.amount);
    expect(fast.amount).toBeGreaterThan(plain.amount);
    expect(optionZoom).toMatchObject({ operation: "zoom", target: "timeline" });
    expect(waveformZoom).toMatchObject({
      operation: "zoom",
      target: "waveform-amplitude",
    });
    expect(resolveWheelGesture(
      { deltaY: 120, altKey: true, shiftKey: true },
      { surface: "timeline", subtarget: "ruler", platform: "macos" },
      profile.wheel,
    ).matched).toBe(false);
    expect(resolve({ ctrlKey: true, altKey: true }).matched).toBe(false);
  });

  it("limits FL Studio Playlist wheel commands to exact track and clip hit targets", () => {
    for (const platform of TEST_PLATFORMS) {
      const profile = getMouseBehaviorProfile("fl_studio", platform);
      for (const event of rawModifierCombinations()) {
        expect(resolveWheelGesture(
          event,
          { surface: "timeline", subtarget: "content", platform, deviceHint: "mouse" },
          profile.wheel,
        ).matched).toBe(false);
      }
      expect(resolveWheelGesture(
        { deltaY: -120, shiftKey: true },
        { surface: "timeline", subtarget: "track", platform, deviceHint: "mouse" },
        profile.wheel,
      )).toMatchObject({
        ruleId: "fl-studio.playlist-track-reorder",
        operation: "reorder",
        target: "track-order",
      });
      expect(resolveWheelGesture(
        { deltaY: 120, altKey: true, shiftKey: true },
        { surface: "timeline", subtarget: "clip", platform, deviceHint: "mouse" },
        profile.wheel,
      )).toMatchObject({
        ruleId: "fl-studio.clip-nudge",
        operation: "nudge",
        target: "clip-position",
      });
    }
  });

  it.each(TEST_PLATFORMS)("resolves exact MIDI editor wheel targets on %s", (platform) => {
    const proTools = getMouseBehaviorProfile("pro_tools", platform);
    const proToolsEvent = platform === "macos"
      ? { deltaY: -120, ctrlKey: true, altKey: true }
      : { deltaY: -120, metaKey: true, altKey: true };
    expect(resolveWheelGesture(
      proToolsEvent,
      { surface: "piano_roll", subtarget: "note", platform },
      proTools.wheel,
    )).toMatchObject({
      ruleId: "pro-tools.midi-note-height",
      operation: "zoom",
      target: "midi-note-height",
    });

    const flStudio = getMouseBehaviorProfile("fl_studio", platform);
    expect(resolveWheelGesture(
      { deltaY: -120, altKey: true },
      { surface: "piano_roll", subtarget: "note", platform },
      flStudio.wheel,
    )).toMatchObject({
      ruleId: "fl-studio.piano-note-property",
      operation: "adjust",
      target: "note-property",
    });
    expect(resolveWheelGesture(
      { deltaY: 120, altKey: true, shiftKey: true },
      { surface: "piano_roll", subtarget: "note", platform },
      flStudio.wheel,
    )).toMatchObject({
      ruleId: "fl-studio.piano-note-nudge",
      operation: "nudge",
      target: "note-position",
    });

    const ableton = getMouseBehaviorProfile("ableton_live", platform);
    for (const subtarget of ["grid", "keyboard", "note"] as const) {
      expect(resolveWheelGesture(
        { deltaY: -120, altKey: true },
        { surface: "piano_roll", subtarget, platform },
        ableton.wheel,
      )).toMatchObject({
        ruleId: "ableton-live.midi-note-height",
        operation: "zoom",
        target: "midi-note-height",
      });
    }
  });

  it.each(TEST_PLATFORMS)("resolves Audacity vertical-scale targets on %s", (platform) => {
    const profile = getMouseBehaviorProfile("audacity", platform);
    const cases = [
      {
        event: { deltaY: 120, shiftKey: true },
        subtarget: "waveform_scale" as const,
        ruleId: "audacity.waveform-scale-pan",
        operation: "pan",
        target: "waveform-scale",
      },
      {
        event: platform === "macos" ? { deltaY: -120, metaKey: true } : { deltaY: -120, ctrlKey: true },
        subtarget: "waveform_scale" as const,
        ruleId: "audacity.waveform-scale-zoom",
        operation: "zoom",
        target: "waveform-scale",
      },
      {
        event: platform === "macos" ? { deltaY: -120, metaKey: true } : { deltaY: -120, ctrlKey: true },
        subtarget: "spectrogram_scale" as const,
        ruleId: "audacity.spectrogram-scale-zoom",
        operation: "zoom",
        target: "spectrogram-scale",
      },
      {
        event: { deltaY: 120, shiftKey: true },
        subtarget: "spectrogram_scale" as const,
        ruleId: "audacity.spectrogram-scale-pan",
        operation: "pan",
        target: "spectrogram-scale",
      },
      {
        event: platform === "macos"
          ? { deltaY: 120, metaKey: true, shiftKey: true }
          : { deltaY: 120, ctrlKey: true, shiftKey: true },
        subtarget: "spectrogram_scale" as const,
        ruleId: "audacity.spectrogram-lower-db-limit",
        operation: "adjust",
        target: "spectrogram-db-floor",
      },
    ];
    for (const entry of cases) {
      expect(resolveWheelGesture(
        entry.event,
        { surface: "timeline", subtarget: entry.subtarget, platform, hoveredTargetId: "track-1" },
        profile.wheel,
      )).toMatchObject({
        ruleId: entry.ruleId,
        operation: entry.operation,
        target: entry.target,
        preventDefault: true,
      });
    }
  });

  it.each(TEST_PLATFORMS)("keeps Ableton automation-lane height and Cubase hit targets distinct on %s", (platform) => {
    const ableton = getMouseBehaviorProfile("ableton_live", platform);
    expect(resolveWheelGesture(
      { deltaY: -120, altKey: true },
      { surface: "timeline", subtarget: "automation_lane", platform, hoveredTargetId: "track-1" },
      ableton.wheel,
    )).toMatchObject({
      ruleId: "ableton-live.automation-lane-height",
      operation: "resize",
      target: "lane-height",
    });
    expect(ableton.wheel.rules.some((rule) => rule.id.includes("take-lane"))).toBe(false);
    expect(getMouseBehaviorProfile("ardour", platform).wheel.rules.some(
      (rule) => rule.id.includes("hovered-track-height"),
    )).toBe(false);

    const cubase = getMouseBehaviorProfile("cubase", platform);
    expect(resolveWheelGesture(
      { deltaY: -120 },
      { surface: "timeline", subtarget: "fade_handle", platform, hoveredTargetId: "clip-1:in" },
      cubase.wheel,
    )).toMatchObject({ ruleId: "cubase.fade-handle-adjust", target: "fade-value" });
    expect(resolveWheelGesture(
      { deltaY: 120 },
      { surface: "timeline", subtarget: "event_volume", platform, hoveredTargetId: "clip-1" },
      cubase.wheel,
    )).toMatchObject({ ruleId: "cubase.event-volume-adjust", target: "event-volume" });
  });

  it.each(TEST_PLATFORMS)("models Cakewalk console-fader scope safeguards on %s", (platform) => {
    const profile = getMouseBehaviorProfile("cakewalk_sonar", platform);
    const primaryEvent = platform === "macos"
      ? { deltaY: 120, metaKey: true }
      : { deltaY: 120, ctrlKey: true };
    const cases = [
      { event: { deltaY: 120 }, ruleId: "cakewalk-sonar.console-fader", operation: "adjust", precision: "normal" },
      { event: { deltaY: 120, shiftKey: true }, ruleId: "cakewalk-sonar.console-fader-fine", operation: "adjust", precision: "fine" },
      { event: primaryEvent, ruleId: "cakewalk-sonar.console-all-faders", operation: "suppress", precision: "normal" },
      {
        event: { ...primaryEvent, shiftKey: true },
        ruleId: "cakewalk-sonar.console-selected-faders",
        operation: "suppress",
        precision: "normal",
      },
    ];
    for (const entry of cases) {
      const { event, ...expected } = entry;
      expect(resolveWheelGesture(
        event,
        { surface: "parameter", subtarget: "console_fader", platform },
        profile.wheel,
      )).toMatchObject(expected);
    }
  });

  it.each(TEST_PLATFORMS)("limits Adobe Audition wheel zoom to the ruler on %s", (platform) => {
    const profile = getMouseBehaviorProfile("adobe_audition", platform);
    expect(resolveWheelGesture(
      { deltaY: -120 },
      { surface: "timeline", subtarget: "ruler", platform },
      profile.wheel,
    )).toMatchObject({
      ruleId: "adobe-audition.ruler-horizontal-zoom",
      operation: "zoom",
      target: "timeline",
    });
    expect(resolveWheelGesture(
      { deltaY: -120 },
      { surface: "timeline", subtarget: "content", platform },
      profile.wheel,
    ).matched).toBe(false);
  });

  it.each(TEST_PLATFORMS)("uses Ardour's exact normal and physical-Control fine parameter wheel on %s", (platform) => {
    const profile = getMouseBehaviorProfile("ardour", platform);
    const fineEvent = platform === "macos"
      ? { deltaY: 120, ctrlKey: true }
      : { deltaY: 120, ctrlKey: true };
    expect(resolveWheelGesture(
      { deltaY: 120 },
      { surface: "parameter", subtarget: "control", platform },
      profile.wheel,
    )).toMatchObject({ ruleId: "ardour.parameter-adjust", precision: "normal" });
    expect(resolveWheelGesture(
      fineEvent,
      { surface: "parameter", subtarget: "control", platform },
      profile.wheel,
    )).toMatchObject({ ruleId: "ardour.parameter-fine-adjust", precision: "fine" });
    if (platform === "macos") {
      expect(resolveWheelGesture(
        { deltaY: 120, metaKey: true },
        { surface: "parameter", subtarget: "control", platform },
        profile.wheel,
      )).toMatchObject({ ruleId: "ardour.parameter-unsupported-wheel", operation: "suppress" });
    }
  });

  it("distinguishes macOS physical Control from Command and Windows Meta", () => {
    const logicMac = getMouseBehaviorProfile("logic_pro", "macos");
    expect(resolveWheelGesture(
      { ctrlKey: true, altKey: true, deltaY: 120 },
      { surface: "timeline", platform: "macos" },
      logicMac.wheel,
    ).ruleId).toBe("logic-pro.control-option-horizontal-zoom");
    expect(resolveWheelGesture(
      { metaKey: true, altKey: true, deltaY: 120 },
      { surface: "timeline", platform: "macos" },
      logicMac.wheel,
    ).matched).toBe(false);

    const bitwigWindows = getMouseBehaviorProfile("bitwig_studio", "windows");
    expect(resolveWheelGesture(
      { ctrlKey: true, altKey: true, deltaY: 120 },
      { surface: "timeline", platform: "windows" },
      bitwigWindows.wheel,
    ).ruleId).toBe("bitwig-studio.control-alt-horizontal-zoom");
    expect(resolveWheelGesture(
      { metaKey: true, altKey: true, deltaY: 120 },
      { surface: "timeline", platform: "windows" },
      bitwigWindows.wheel,
    ).matched).toBe(false);
  });

  it("falls back safely to OpenStudio for unknown persisted IDs", () => {
    expect(getMouseBehaviorProfile("deleted", "windows").id).toBe("openstudio");
  });
});

import { describe, expect, it } from "vitest";
import { getActionShortcutScopes, getRegisteredActions } from "../store/actionRegistry";
import {
  normalizeShortcutBinding,
  shortcutBindingEventSignature,
  shortcutMatchesEvent,
} from "../utils/platform";
import {
  getKeyboardShortcutProfile,
  getKeyboardShortcutProfilePresentation,
  getProfileActionBindings,
  KEYBOARD_SHORTCUT_PROFILE_IDS,
  KEYBOARD_SHORTCUT_PROFILES,
} from "../utils/shortcutProfiles";

describe("keyboard shortcut profiles", () => {
  it("provides every required and additional DAW as a stable unique profile", () => {
    expect(new Set(KEYBOARD_SHORTCUT_PROFILE_IDS).size).toBe(KEYBOARD_SHORTCUT_PROFILE_IDS.length);
    expect(KEYBOARD_SHORTCUT_PROFILE_IDS).toEqual(expect.arrayContaining([
      "openstudio",
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
    ]));
  });

  it("marks source-DAW platform availability without disabling portable profile use", () => {
    expect(getKeyboardShortcutProfile("cakewalk_sonar").nativePlatforms).toEqual(["windows"]);
    expect(getKeyboardShortcutProfile("garageband").nativePlatforms).toEqual(["macos"]);
    expect(getKeyboardShortcutProfile("digital_performer").nativePlatforms).toEqual(["macos", "windows"]);
    expect(getKeyboardShortcutProfile("adobe_audition").nativePlatforms).toEqual(["macos", "windows"]);
    expect(getKeyboardShortcutProfile("mixcraft").nativePlatforms).toEqual(["windows"]);
    expect(getKeyboardShortcutProfile("waveform").nativePlatforms).toEqual(["macos", "windows", "linux"]);
    expect(getKeyboardShortcutProfile("renoise").nativePlatforms).toEqual(["macos", "windows", "linux"]);
  });

  it("extends selected-track commands into the Timeline only for profiles that document them", () => {
    const actions = getRegisteredActions();
    const mute = actions.find((action) => action.id === "track.toggleSelectedMute")!;
    const solo = actions.find((action) => action.id === "track.toggleSelectedSolo")!;
    const arm = actions.find((action) => action.id === "track.toggleSelectedArm")!;

    expect(getActionShortcutScopes(mute, "garageband")).toContain("timeline");
    expect(getActionShortcutScopes(solo, "garageband")).toContain("timeline");
    expect(getActionShortcutScopes(arm, "garageband")).toContain("timeline");
    expect(getActionShortcutScopes(arm, "cakewalk_sonar")).toContain("timeline");
    expect(getActionShortcutScopes(mute, "openstudio")).not.toContain("timeline");
  });

  it("references registered actions and parseable bindings", () => {
    const actionIds = new Set(getRegisteredActions().map((action) => action.id));
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const [actionId, scopes] of Object.entries(profile.scopeAdditions ?? {})) {
        expect(actionIds.has(actionId), `${profile.id} scope addition: ${actionId}`).toBe(true);
        expect(scopes.length, `${profile.id} scope addition: ${actionId}`).toBeGreaterThan(0);
        expect(new Set(scopes).size, `${profile.id} scope addition: ${actionId}`).toBe(scopes.length);
      }
      for (const actionId of Object.keys(profile.bindings)) {
        expect(actionIds.has(actionId), `${profile.id}: ${actionId}`).toBe(true);
        for (const platform of ["macos", "windows", "linux", "other"] as const) {
          const bindings = getProfileActionBindings(profile.id, actionId, platform) ?? [];
          for (const binding of bindings) {
            expect(normalizeShortcutBinding(binding), `${profile.id}/${platform}: ${binding}`).toBeTruthy();
          }
        }
      }
    }
  });

  it("maps Logic Option nudges to physical Alt on Windows without changing macOS Option", () => {
    expect(getProfileActionBindings("logic_pro", "edit.nudgeLeft", "macos")).toEqual(["Option+Left"]);
    expect(getProfileActionBindings("logic_pro", "edit.nudgeLeft", "windows")).toEqual(["Alt+Left"]);
  });

  it("ports Cakewalk's documented Alt track commands to Option on macOS", () => {
    expect(getProfileActionBindings("cakewalk_sonar", "track.toggleSelectedMute", "windows")).toEqual(["Alt+M"]);
    expect(getProfileActionBindings("cakewalk_sonar", "track.toggleSelectedMute", "macos")).toEqual(["Option+M"]);
    expect(getProfileActionBindings("cakewalk_sonar", "track.toggleSelectedSolo", "windows")).toEqual(["Alt+S"]);
    expect(getProfileActionBindings("cakewalk_sonar", "track.toggleSelectedArm", "macos")).toEqual(["Option+R"]);
  });

  it("maps documented Cakewalk and GarageBand commands only to registered actions", () => {
    expect(getProfileActionBindings("cakewalk_sonar", "transport.record", "windows")).toEqual(["R"]);
    expect(getProfileActionBindings("cakewalk_sonar", "transport.metronome", "windows")).toEqual(["Ctrl+F3"]);
    expect(getProfileActionBindings("cakewalk_sonar", "tools.smartTool", "windows")).toEqual(["F5"]);
    expect(getProfileActionBindings("cakewalk_sonar", "tools.selectTool", "windows")).toEqual(["F6"]);
    expect(getProfileActionBindings("cakewalk_sonar", "view.toggleSnap", "windows")).toEqual(["N"]);
    expect(getProfileActionBindings("cakewalk_sonar", "view.toggleMixer", "windows")).toEqual(["Alt+2"]);
    expect(getProfileActionBindings("cakewalk_sonar", "clip.openSelectedInPianoRoll", "macos")).toEqual(["Option+3"]);
    expect(getProfileActionBindings("cakewalk_sonar", "edit.nudgeLeft", "windows")).toEqual(["Numpad1"]);
    expect(getProfileActionBindings("cakewalk_sonar", "edit.nudgeRight", "windows")).toEqual(["Numpad3"]);
    expect(getProfileActionBindings("cakewalk_sonar", "edit.muteClips", "windows")).toEqual(["K"]);
    expect(getProfileActionBindings("cakewalk_sonar", "edit.toggleClipLock", "windows")).toEqual(["Ctrl+K"]);
    expect(getProfileActionBindings("cakewalk_sonar", "view.zoomToFit", "windows")).toEqual(["Ctrl+F"]);
    expect(getProfileActionBindings("cakewalk_sonar", "options.preferences", "windows")).toEqual(["P"]);

    expect(getProfileActionBindings("garageband", "transport.loop", "macos")).toEqual(["C"]);
    expect(getProfileActionBindings("garageband", "transport.metronome", "macos")).toEqual(["K"]);
    expect(getProfileActionBindings("garageband", "view.toggleSnap", "macos")).toEqual(["Ctrl+G"]);
    expect(getProfileActionBindings("garageband", "view.zoomOut", "macos")).toEqual(["Ctrl+Left"]);
    expect(getProfileActionBindings("garageband", "view.zoomIn", "windows")).toEqual(["Ctrl+Right"]);
    expect(getProfileActionBindings("garageband", "track.toggleSelectedArm", "macos")).toEqual(["Control+R"]);
    expect(getProfileActionBindings("garageband", "track.toggleSelectedMonitor", "windows")).toEqual(["Ctrl+I"]);
    expect(getProfileActionBindings("reason", "transport.metronome", "windows")).toEqual(["C"]);
  });

  it("keeps physical Option and Control commands distinct on macOS", () => {
    expect(getProfileActionBindings("cubase", "view.toggleVirtualKeyboard", "macos")).toEqual(["Option+K"]);
    expect(getProfileActionBindings("logic_pro", "edit.muteClips", "macos")).toEqual(["Control+M"]);
    expect(shortcutMatchesEvent(
      { key: "k", code: "KeyK", altKey: true },
      "Option+K",
      "macos",
    )).toBe(true);
    expect(shortcutMatchesEvent(
      { key: "m", code: "KeyM", ctrlKey: true },
      "Control+M",
      "macos",
    )).toBe(true);
  });

  it.each([
    ["pro_tools", "edit.groupClips", ["Ctrl+Option+G"], ["Ctrl+Alt+G"]],
    ["pro_tools", "edit.ungroupClips", ["Ctrl+Option+U"], ["Ctrl+Alt+U"]],
    ["cubase", "edit.splitAtCursor", ["Option+X"], ["Alt+X"]],
    ["cubase", "view.zoomToSelection", ["Option+S"], ["Alt+S"]],
    ["reaper", "edit.reverseClip", ["Option+R"], ["Alt+R"]],
    ["audacity", "transport.pause", ["P"], ["P"]],
    ["logic_pro", "edit.splitAtSelection", ["Option+Ctrl+T"], ["Alt+Ctrl+T"]],
    ["logic_pro", "edit.reverseClip", ["Control+Shift+R"], ["Ctrl+Shift+R"]],
    ["fl_studio", "midi.quantizeLast", ["Ctrl+Q"], ["Ctrl+Q"]],
    ["fl_studio", "view.toggleSnap", ["Backspace"], ["Backspace"]],
    ["ableton_live", "midi.tool.draw", ["B"], ["B"]],
    ["ableton_live", "insert.emptyMidiClip", ["Ctrl+Shift+M"], ["Ctrl+Shift+M"]],
    ["studio_one", "insert.multipleTracks", ["T"], ["T"]],
    ["studio_one", "edit.normalizeClips", ["Option+N"], ["Alt+N"]],
    ["bitwig_studio", "edit.splitAtCursor", ["Ctrl+E"], ["Ctrl+E"]],
    ["reason", "edit.splitAtCursor", ["Option+X"], ["Alt+X"]],
    ["cakewalk_sonar", "view.mediaExplorer", ["B"], ["B"]],
    ["garageband", "edit.splitAtCursor", ["Ctrl+T"], ["Ctrl+T"]],
    ["ardour", "tools.selectTool", ["G"], ["G"]],
    ["adobe_audition", "edit.nudgeLeft", ["Option+,"], ["Alt+,"]],
    ["mixcraft", "edit.splitAtCursor", ["Ctrl+T"], ["Ctrl+T"]],
    ["waveform", "view.zoomIn", ["Up"], ["Up"]],
    ["renoise", "transport.play", ["Space"], ["Space"]],
  ] as const)("maps %s %s on both desktop platforms", (profileId, actionId, macos, windows) => {
    expect(getProfileActionBindings(profileId, actionId, "macos")).toEqual(macos);
    expect(getProfileActionBindings(profileId, actionId, "windows")).toEqual(windows);
  });

  it("uses event-reachable main-row and numpad zoom bindings", () => {
    expect(shortcutMatchesEvent(
      { key: "=", code: "Equal", ctrlKey: true },
      "Ctrl+=",
      "windows",
    )).toBe(true);
    expect(shortcutMatchesEvent(
      { key: "+", code: "Equal", shiftKey: true },
      "Shift++",
      "windows",
    )).toBe(true);
    expect(shortcutMatchesEvent(
      { key: "+", code: "NumpadAdd", location: 3 },
      "NumpadAdd",
      "windows",
    )).toBe(true);
  });

  it("explicitly suppresses dangerous inherited bindings with no native equivalent", () => {
    expect(getProfileActionBindings("pro_tools", "tools.splitTool", "windows")).toEqual([]);
    expect(getProfileActionBindings("fl_studio", "transport.loop", "windows")).toEqual([]);
    expect(getProfileActionBindings("fl_studio", "file.new", "macos")).toEqual([]);
    expect(getProfileActionBindings("ableton_live", "tools.splitTool", "macos")).toEqual([]);
    expect(getProfileActionBindings("ableton_live", "insert.marker", "windows")).toEqual([]);
    expect(getProfileActionBindings("logic_pro", "tools.selectTool", "macos")).toEqual([]);
    expect(getProfileActionBindings("logic_pro", "tools.splitTool", "macos")).toEqual([]);
    expect(getProfileActionBindings("pro_tools", "track.toggleSelectedArm", "windows")).toEqual([]);
    expect(getProfileActionBindings("pro_tools", "midi.tool.range", "macos")).toEqual([]);
    expect(getProfileActionBindings("reaper", "track.toggleSelectedArm", "macos")).toEqual([]);
    expect(getProfileActionBindings("reaper", "midi.tool.range", "windows")).toEqual([]);
    expect(getProfileActionBindings("garageband", "edit.groupClips", "macos")).toEqual([]);
    expect(getProfileActionBindings("garageband", "edit.nudgeLeftFine", "macos")).toEqual([]);
    expect(getProfileActionBindings("garageband", "edit.nudgeRightFine", "windows")).toEqual([]);
    expect(getProfileActionBindings("cakewalk_sonar", "tools.splitTool", "windows")).toEqual([]);
    expect(getProfileActionBindings("cakewalk_sonar", "tools.muteTool", "windows")).toEqual([]);
    expect(getProfileActionBindings("cakewalk_sonar", "edit.nudgeLeftFine", "windows")).toEqual([]);
    expect(getProfileActionBindings("cakewalk_sonar", "edit.nudgeRightFine", "macos")).toEqual([]);
    expect(getProfileActionBindings("cakewalk_sonar", "edit.editPitch", "windows")).toEqual([]);
    for (const profileId of ["audacity", "logic_pro", "fl_studio", "bitwig_studio"] as const) {
      expect(getProfileActionBindings(profileId, "track.toggleSelectedArm", "windows"), profileId).toEqual([]);
      expect(getProfileActionBindings(profileId, "track.toggleSelectedArm", "macos"), profileId).toEqual([]);
      expect(getProfileActionBindings(profileId, "midi.tool.range", "windows"), profileId).toEqual([]);
    }
    expect(getProfileActionBindings("cakewalk_sonar", "midi.tool.range", "windows")).toEqual([]);
    expect(getProfileActionBindings("logic_pro", "edit.nudgeLeftFine", "macos")).toEqual([]);
    expect(getProfileActionBindings("fl_studio", "view.drumEditor", "windows")).toEqual([]);
    expect(getProfileActionBindings("cubase", "edit.muteClips", "macos")).toEqual([]);
    expect(getProfileActionBindings("studio_one", "edit.muteClips", "windows")).toEqual([]);
    expect(getProfileActionBindings("renoise", "transport.record", "windows")).toEqual([]);
  });

  it("uses strict fallback semantics for customizable or focus-dependent source maps", () => {
    for (const profileId of ["digital_performer", "waveform", "renoise"] as const) {
      expect(getKeyboardShortcutProfile(profileId).fallbackPolicy).toBe("strict");
      expect(getProfileActionBindings(profileId, "file.quit", "windows"), profileId).toEqual([]);
      expect(getProfileActionBindings(profileId, "midi.tool.draw", "macos"), profileId).toEqual([]);
      expect(getProfileActionBindings(profileId, "edit.delete", "windows"), profileId).toEqual([]);
    }

    expect(getProfileActionBindings("waveform", "transport.play", "windows")).toEqual(["Space"]);
    expect(getProfileActionBindings("waveform", "edit.splitAtCursor", "macos")).toEqual(["/"]);
    expect(getProfileActionBindings("renoise", "midi.toggleStepInput", "windows")).toEqual([]);
    expect(getProfileActionBindings("openstudio", "file.quit", "windows")).toBeUndefined();
  });

  it("exposes strict-policy and cross-platform-emulation labels to selectors, guides, and print", () => {
    for (const profileId of ["digital_performer", "waveform", "renoise"] as const) {
      const presentation = getKeyboardShortcutProfilePresentation(profileId, "windows");
      expect(presentation.policyLabel, profileId).toContain("Strict profile");
      expect(presentation.policyLabel, profileId).toContain("stay unassigned");
      expect(presentation.description, profileId).toContain(presentation.availabilityLabel);
    }

    const logicOnWindows = getKeyboardShortcutProfilePresentation("logic_pro", "windows");
    expect(logicOnWindows.isNativeSourcePlatform).toBe(false);
    expect(logicOnWindows.optionLabel).toBe("Logic Pro (cross-platform emulation)");
    expect(logicOnWindows.availabilityLabel).toContain("Cross-platform emulation on Windows");

    const mixcraftOnWindows = getKeyboardShortcutProfilePresentation("mixcraft", "windows");
    expect(mixcraftOnWindows.isNativeSourcePlatform).toBe(true);
    expect(mixcraftOnWindows.optionLabel).toBe("Mixcraft");
  });

  it.each([
    ["logic_pro", "insert.marker"],
    ["logic_pro", "navigate.nextTransient"],
    ["logic_pro", "view.loadScreenset1"],
    ["fl_studio", "view.toggleUndoHistory"],
    ["fl_studio", "file.closeProject"],
    ["fl_studio", "view.clipProperties"],
    ["fl_studio", "view.setLoopToSelection"],
    ["garageband", "view.toggleMixer"],
    ["garageband", "insert.quickAddInstrument"],
    ["garageband", "midi.panic"],
    ["garageband", "file.openSafeMode"],
    ["ardour", "help.contextualHelp"],
    ["ardour", "view.clipProperties"],
    ["ardour", "track.deleteSelected"],
    ["adobe_audition", "transport.record"],
    ["adobe_audition", "insert.regionFromSelection"],
    ["mixcraft", "file.quit"],
    ["mixcraft", "edit.duplicateClips"],
    ["mixcraft", "insert.markerNamed"],
  ] as const)("unbinds the native collision %s / %s", (profileId, actionId) => {
    expect(getProfileActionBindings(profileId, actionId, "macos")).toEqual([]);
    expect(getProfileActionBindings(profileId, actionId, "windows")).toEqual([]);
  });

  it("keeps only exact existing-action remaps for audited profiles", () => {
    expect(getProfileActionBindings("logic_pro", "track.toggleSelectedMute", "macos")).toEqual(["M"]);
    expect(getProfileActionBindings("logic_pro", "view.togglePianoRoll", "windows")).toEqual(["P"]);
    expect(getProfileActionBindings("logic_pro", "file.closeProject", "macos")).toEqual(["Command+Option+W"]);
    expect(getProfileActionBindings("fl_studio", "midi.tool.draw", "windows")).toEqual(["P"]);
    expect(getProfileActionBindings("fl_studio", "midi.tool.erase", "macos")).toEqual(["D"]);
    expect(getProfileActionBindings("fl_studio", "midi.duplicateSelection", "windows")).toEqual(["Ctrl+B"]);
    expect(getProfileActionBindings("fl_studio", "midi.glueSelectedNotes", "macos")).toEqual(["Ctrl+G"]);
    expect(getProfileActionBindings("fl_studio", "view.togglePianoRoll", "windows")).toEqual(["F7"]);
    expect(getProfileActionBindings("garageband", "track.deleteSelected", "macos")).toEqual(["Ctrl+Delete"]);
    expect(getProfileActionBindings("garageband", "midi.movePitchOctaveUp", "macos")).toEqual(["Option+Shift+Up"]);
    expect(getProfileActionBindings("garageband", "midi.deselectAll", "windows")).toEqual(["Shift+D"]);
    expect(getProfileActionBindings("ardour", "navigate.prevTransient", "windows")).toEqual(["Ctrl+Left"]);
    expect(getProfileActionBindings("ardour", "view.loadScreenset1", "macos")).toEqual(["F1"]);
    expect(getProfileActionBindings("mixcraft", "track.deleteSelected", "windows")).toEqual(["Ctrl+Shift+D"]);
    expect(getProfileActionBindings("mixcraft", "track.moveSelectedDown", "windows")).toEqual(["Ctrl+D"]);
    expect(getProfileActionBindings("mixcraft", "midi.selectNextNote", "macos")).toEqual(["Tab"]);
    expect(getProfileActionBindings("mixcraft", "options.preferences", "macos")).toEqual(["Ctrl+Alt+P"]);
    expect(getProfileActionBindings("adobe_audition", "view.verticalZoomIn", "macos")).toEqual(["Option+="]);
  });

  it("falls back safely for persisted unknown profile IDs", () => {
    expect(getKeyboardShortcutProfile("removed-profile").id).toBe("openstudio");
  });

  it("does not introduce same-scope effective shortcut collisions", () => {
    const actions = getRegisteredActions();
    const conditionsOverlap = (left?: string, right?: string) => {
      if (!left || left === "always" || !right || right === "always" || left === right) return true;
      return !new Set([
        "step_input_disabled|step_input_enabled",
        "step_input_enabled|step_input_disabled",
        "transport_running|transport_stopped",
        "transport_stopped|transport_running",
      ]).has(`${left}|${right}`);
    };

    for (const platform of ["macos", "windows"] as const) {
      for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
        const seen = new Map<string, { actionId: string; condition?: string }>();
        for (const action of actions) {
          const profileBindings = getProfileActionBindings(profile.id, action.id, platform);
          const bindings = profileBindings ?? [action.shortcut, ...(action.shortcutAliases ?? [])]
            .filter((binding): binding is string => typeof binding === "string" && !binding.includes("("));
          for (const scope of getActionShortcutScopes(action, profile.id)) {
            for (const binding of bindings) {
              const signature = shortcutBindingEventSignature(binding, platform);
              expect(signature, `${profile.id}/${platform}: unreachable ${binding}`).toBeTruthy();
              if (!signature) continue;
              const key = `${scope}:${signature}`;
              const previous = seen.get(key);
              if (previous && conditionsOverlap(previous.condition, action.shortcutWhen)) {
                throw new Error(`${profile.id}/${platform} ${key}: ${previous.actionId} conflicts with ${action.id}`);
              }
              seen.set(key, { actionId: action.id, condition: action.shortcutWhen });
            }
          }
        }
      }
    }
  });

  it("keeps profile-global R Record reachable from every surface", () => {
    const actions = getRegisteredActions();
    const recordProfiles = [
      "audacity",
      "logic_pro",
      "fl_studio",
      "bitwig_studio",
      "cakewalk_sonar",
      "garageband",
    ] as const;
    for (const platform of ["macos", "windows"] as const) {
      for (const profileId of recordProfiles) {
        const recordBindings = getProfileActionBindings(profileId, "transport.record", platform) ?? [];
        expect(recordBindings, `${profileId}/${platform}`).toContain("R");
        const shadows: string[] = [];
        for (const action of actions) {
          if (getActionShortcutScopes(action, profileId).includes("global")) continue;
          const localBindings = getProfileActionBindings(profileId, action.id, platform)
            ?? [action.shortcut, ...(action.shortcutAliases ?? [])]
              .filter((binding): binding is string => typeof binding === "string" && !binding.includes("("));
          for (const recordBinding of recordBindings) {
            const recordSignature = shortcutBindingEventSignature(recordBinding, platform);
            if (recordSignature && localBindings.some(
              (binding) => shortcutBindingEventSignature(binding, platform) === recordSignature,
            )) {
              shadows.push(action.id);
            }
          }
        }
        expect(shadows, `${profileId}/${platform}`).toEqual([]);
      }
    }
  });
});

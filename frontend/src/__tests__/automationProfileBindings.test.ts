import { describe, expect, it } from "vitest";
import { getActionShortcutScopes, getRegisteredAction } from "../store/actionRegistry";
import {
  KEYBOARD_SHORTCUT_PROFILES,
  getProfileActionBindings,
} from "../utils/shortcutProfiles";

describe("source-DAW automation shortcut profiles", () => {
  it.each(["logic_pro", "garageband", "ableton_live"] as const)(
    "maps %s A to the implemented arrangement automation view",
    (profileId) => {
      expect(getProfileActionBindings(
        profileId,
        "automation.toggleArrangementView",
        "macos",
      )).toEqual(["A"]);
    },
  );

  it("does not leak OpenStudio's arrangement A into other vendor profiles", () => {
    const verifiedArrangementProfiles = new Set(["logic_pro", "garageband", "ableton_live"]);
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      if (profile.id === "openstudio" || verifiedArrangementProfiles.has(profile.id)) continue;
      expect(
        getProfileActionBindings(profile.id, "automation.toggleArrangementView", "macos"),
        `${profile.id} must explicitly own or unbind arrangement automation`,
      ).toEqual([]);
    }
  });

  it("maps Ableton's point and envelope navigation without changing modifier meaning", () => {
    expect(getProfileActionBindings("ableton_live", "automation.point.selectNext", "macos"))
      .toEqual(["Tab", "Option+Right"]);
    expect(getProfileActionBindings("ableton_live", "automation.point.selectNext", "windows"))
      .toEqual(["Tab", "Alt+Right"]);
    expect(getProfileActionBindings("ableton_live", "automation.point.selectPrevious", "macos"))
      .toEqual(["Shift+Tab", "Option+Left"]);
    expect(getProfileActionBindings("ableton_live", "automation.point.deleteSelected", "windows"))
      .toEqual(["Delete"]);
    expect(getProfileActionBindings("ableton_live", "automation.point.addAtPlayhead", "macos"))
      .toEqual(["Enter"]);
    expect(getProfileActionBindings("ableton_live", "automation.lane.selectPrevious", "macos"))
      .toEqual(["Option+Up"]);
    expect(getProfileActionBindings("ableton_live", "automation.lane.selectNext", "windows"))
      .toEqual(["Alt+Down"]);
  });

  it("maps only exact implemented Studio One automation commands", () => {
    expect(getProfileActionBindings("studio_one", "track.toggleSelectedAutomation", "windows"))
      .toEqual(["A"]);
    expect(getProfileActionBindings("studio_one", "track.toggleSelectedAutomationRead", "windows"))
      .toEqual(["J"]);
    expect(getProfileActionBindings("studio_one", "automation.selectedTracks.mode.touch", "windows"))
      .toEqual(["K"]);
    expect(getProfileActionBindings("studio_one", "automation.toggleArrangementView", "windows"))
      .toEqual([]);
    expect(getActionShortcutScopes(
      getRegisteredAction("track.toggleSelectedAutomation")!,
      "studio_one",
    )).toContain("timeline");
  });

  it("maps Logic's selected-track and all-track mode commands without changing scope", () => {
    expect(getProfileActionBindings(
      "logic_pro",
      "automation.selectedTracks.toggleOffRead",
      "macos",
    )).toEqual(["Control+Command+O"]);
    expect(getProfileActionBindings(
      "logic_pro",
      "automation.selectedTracks.toggleLatchRead",
      "windows",
    )).toEqual(["Control+Meta+A"]);

    const allTrackModes = {
      off: "O",
      read: "R",
      touch: "T",
      latch: "L",
    } as const;
    for (const [mode, key] of Object.entries(allTrackModes)) {
      expect(getProfileActionBindings(
        "logic_pro",
        `automation.allTracks.mode.${mode}`,
        "macos",
      )).toEqual([`Control+Command+Shift+${key}`]);
      expect(getProfileActionBindings(
        "logic_pro",
        `automation.allTracks.mode.${mode}`,
        "windows",
      )).toEqual([`Control+Meta+Shift+${key}`]);
    }
  });

  it("maps Cakewalk's global write-off and read-toggle commands exactly", () => {
    expect(getProfileActionBindings(
      "cakewalk_sonar",
      "automation.allTracks.writeOff",
      "windows",
    )).toEqual(["F12"]);
    expect(getProfileActionBindings(
      "cakewalk_sonar",
      "automation.allTracks.toggleRead",
      "windows",
    )).toEqual(["Ctrl+F12"]);
    // Profiles remain portable even when their source DAW is platform-specific.
    expect(getProfileActionBindings(
      "cakewalk_sonar",
      "automation.allTracks.toggleRead",
      "macos",
    )).toEqual(["Ctrl+F12"]);
  });

  it("keeps every mapped automation identity backed by an executable registry action", () => {
    for (const actionId of [
      "automation.toggleArrangementView",
      "automation.point.selectNext",
      "automation.point.selectPrevious",
      "automation.point.deleteSelected",
      "automation.point.addAtPlayhead",
      "automation.lane.selectPrevious",
      "automation.lane.selectNext",
      "track.toggleSelectedAutomation",
      "track.toggleSelectedAutomationRead",
      "automation.selectedTracks.mode.touch",
      "automation.selectedTracks.toggleOffRead",
      "automation.selectedTracks.toggleLatchRead",
      "automation.allTracks.mode.off",
      "automation.allTracks.mode.read",
      "automation.allTracks.mode.touch",
      "automation.allTracks.mode.latch",
      "automation.allTracks.writeOff",
      "automation.allTracks.toggleRead",
    ]) {
      expect(getRegisteredAction(actionId), actionId).toBeDefined();
    }
  });
});

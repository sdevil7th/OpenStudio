import { afterEach, describe, expect, it } from "vitest";
import { useDAWStore } from "../store/useDAWStore";
import {
  getEffectiveShortcutLabel,
  getTimelineWheelHelp,
} from "../utils/inputProfileHelp";

afterEach(() => {
  useDAWStore.setState({
    customShortcuts: {},
    keyboardShortcutProfileId: "openstudio",
    mouseBehaviorProfileId: "openstudio",
  });
});

describe("input profile help", () => {
  it("describes the selected REAPER timeline rules instead of OpenStudio defaults", () => {
    expect(getTimelineWheelHelp("reaper", "windows").items).toEqual([
      { gesture: "Scroll", action: "zoom the timeline" },
      { gesture: "Ctrl+Scroll", action: "resize track height" },
      { gesture: "Alt+Scroll", action: "scroll horizontally" },
      { gesture: "Ctrl+Alt+Scroll", action: "scroll vertically" },
    ]);
  });

  it("distinguishes physical Control from Command for Logic on macOS", () => {
    expect(getTimelineWheelHelp("logic_pro", "macos").items).toEqual([
      { gesture: "Ctrl+Option+Scroll", action: "zoom the timeline" },
      { gesture: "Other wheel gestures", action: "use native scrolling" },
    ]);
    expect(getTimelineWheelHelp("logic_pro", "windows").items[0]).toEqual({
      gesture: "Ctrl+Alt+Scroll",
      action: "zoom the timeline",
    });
  });

  it("describes FL Studio wheel actions only at their exact Playlist hit targets", () => {
    expect(getTimelineWheelHelp("fl_studio", "windows").items).toEqual([
      {
        gesture: "Shift+Scroll over a track",
        action: "reorder the hovered track",
      },
      {
        gesture: "Alt+Shift+Scroll over a clip",
        action: "nudge the hovered clip",
      },
      {
        gesture: "Other wheel gestures",
        action: "use native scrolling",
      },
    ]);
  });

  it("does not invent GarageBand wheel behavior and keeps DP physical modifiers visible", () => {
    expect(getTimelineWheelHelp("garageband", "macos").items).toEqual([
      {
        gesture: "Wheel gestures",
        action: "use native scrolling when no supported item-specific action matches",
      },
    ]);
    expect(getTimelineWheelHelp("digital_performer", "macos").items).toEqual([
      { gesture: "Option+Scroll", action: "zoom the timeline" },
      { gesture: "Ctrl+Option+Scroll", action: "resize track height" },
      { gesture: "Other wheel gestures", action: "use native scrolling" },
    ]);
    expect(getTimelineWheelHelp("digital_performer", "windows").items[1]).toEqual({
      gesture: "Win+Alt+Scroll",
      action: "resize track height",
    });
  });

  it("describes Cakewalk's exact Clips-pane zoom combinations", () => {
    expect(getTimelineWheelHelp("cakewalk_sonar", "windows").items).toEqual([
      { gesture: "Alt+Scroll", action: "zoom the timeline" },
      { gesture: "Alt+Shift+Scroll", action: "zoom the timeline faster" },
      { gesture: "Ctrl+Alt+Scroll", action: "resize track height" },
      { gesture: "Other wheel gestures", action: "use native scrolling" },
    ]);
  });

  it("describes the new profiles without broadening their documented wheel scopes", () => {
    expect(getTimelineWheelHelp("adobe_audition", "windows").items).toEqual([
      { gesture: "Scroll over the ruler", action: "zoom the timeline" },
    ]);
    expect(getTimelineWheelHelp("mixcraft", "windows").items).toEqual([
      { gesture: "Scroll", action: "zoom the timeline" },
      { gesture: "Ctrl+Scroll", action: "scroll horizontally" },
      { gesture: "Shift+Scroll", action: "scroll vertically" },
    ]);
    expect(getTimelineWheelHelp("waveform", "macos").items).toEqual([
      { gesture: "Scroll", action: "zoom the timeline" },
      { gesture: "Cmd+Scroll", action: "resize track height" },
    ]);
    expect(getTimelineWheelHelp("renoise", "windows").items).toEqual([
      {
        gesture: "Wheel gestures",
        action: "use native scrolling when no supported item-specific action matches",
      },
    ]);
  });

  it("names exact lane, scale, fade, and event-volume targets without generic placeholders", () => {
    expect(getTimelineWheelHelp("ableton_live", "windows", 8).items).toContainEqual({
      gesture: "Alt+Scroll over an automation lane",
      action: "resize the hovered automation lane",
    });

    const audacityItems = getTimelineWheelHelp("audacity", "windows", 10).items;
    expect(audacityItems).toContainEqual({
      gesture: "Shift+Scroll over a waveform scale",
      action: "pan the waveform scale vertically",
    });
    expect(audacityItems).toContainEqual({
      gesture: "Ctrl+Shift+Scroll over a spectrogram scale",
      action: "adjust the spectrogram lower dB limit",
    });

    const cubaseItems = getTimelineWheelHelp("cubase", "windows", 10).items;
    expect(cubaseItems).toContainEqual({
      gesture: "Scroll over a fade handle",
      action: "adjust the hovered fade length",
    });
    expect(cubaseItems).toContainEqual({
      gesture: "Scroll over an event-volume handle",
      action: "adjust the hovered event volume",
    });
  });

  it("labels custom and profile-owned empty bindings as unassigned", () => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: { "transport.record": "" },
    });
    expect(getEffectiveShortcutLabel("transport.record", "Ctrl+R")).toBe("Unassigned");

    useDAWStore.setState({
      keyboardShortcutProfileId: "pro_tools",
      customShortcuts: {},
    });
    expect(getEffectiveShortcutLabel("tools.splitTool", "B")).toBe("Unassigned");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { useDAWStore } from "../store/useDAWStore";
import {
  findCustomKeyboardProfileConflicts,
  findShortcutAssignmentConflicts,
} from "../utils/shortcutAssignmentConflicts";

describe("shortcut assignment conflicts", () => {
  const original = {
    keyboardShortcutProfileId: useDAWStore.getState().keyboardShortcutProfileId,
    customShortcuts: useDAWStore.getState().customShortcuts,
  };

  afterEach(() => useDAWStore.setState(original));

  it("finds collisions in the same active profile and scope", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {} });
    const conflicts = findShortcutAssignmentConflicts("tools.selectTool", "B");
    expect(conflicts.some((conflict) => conflict.actionId === "tools.splitTool")).toBe(true);
  });

  it("allows the same key in independent editor scopes", () => {
    const conflicts = findShortcutAssignmentConflicts("pitch.tool.select", "V");
    expect(conflicts.some((conflict) => conflict.actionId === "tools.selectTool")).toBe(false);
  });

  it("reports concrete/global overlap and explains which resolver tier wins", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {} });

    expect(findShortcutAssignmentConflicts("tools.selectTool", "Ctrl+S"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          actionId: "file.save",
          sharedScopes: ["timeline"],
          precedence: "target_precedes",
        }),
      ]));
    expect(findShortcutAssignmentConflicts("file.save", "B"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          actionId: "tools.splitTool",
          sharedScopes: ["timeline"],
          precedence: "existing_precedes",
        }),
      ]));
  });

  it("reports contextual overlap without conflating unrelated concrete editors", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {} });

    expect(findShortcutAssignmentConflicts("tools.selectTool", "Ctrl+Z"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          actionId: "edit.undo",
          sharedScopes: ["timeline"],
          precedence: "target_precedes",
        }),
      ]));
    expect(findShortcutAssignmentConflicts("pitch.tool.select", "B")
      .some((conflict) => conflict.actionId === "tools.splitTool")).toBe(false);
  });

  it("includes active-profile scope additions in conflict reporting", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "garageband", customShortcuts: {} });
    expect(findShortcutAssignmentConflicts("tools.selectTool", "M"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          actionId: "track.toggleSelectedMute",
          sharedScopes: expect.arrayContaining(["timeline"]),
        }),
      ]));

    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {} });
    expect(findShortcutAssignmentConflicts("tools.selectTool", "M")
      .some((conflict) => conflict.actionId === "track.toggleSelectedMute")).toBe(false);
  });

  it("recognizes a label binding colliding with its common physical key", () => {
    useDAWStore.setState({ customShortcuts: { "tools.splitTool": "Code:KeyB" } });
    expect(findShortcutAssignmentConflicts("tools.selectTool", "B"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ actionId: "tools.splitTool" })]));
  });

  it("does not flag mutually-exclusive Piano Roll tool and step-input conditions", () => {
    expect(findShortcutAssignmentConflicts("midi.tool.draw", "C")
      .some((conflict) => conflict.actionId === "midi.stepInputC")).toBe(false);
  });

  it("checks explicit platform overrides using that platform's physical modifier map", () => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {
        "tools.splitTool": {
          macos: ["Command+Code:KeyB"],
          windows: ["Control+Code:KeyQ"],
        },
      },
    });

    expect(findShortcutAssignmentConflicts(
      "tools.selectTool",
      "Command+Code:KeyB",
      "macos",
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: "tools.splitTool", platforms: ["macos"] }),
    ]));
    expect(findShortcutAssignmentConflicts(
      "tools.selectTool",
      "Command+Code:KeyB",
      "windows",
    )).toEqual([]);
  });

  it("checks a common binding on every platform and deduplicates action conflicts", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {} });
    const conflicts = findShortcutAssignmentConflicts("tools.selectTool", "Code:KeyB", "common");
    const splitConflicts = conflicts.filter((conflict) => conflict.actionId === "tools.splitTool");
    expect(splitConflicts).toHaveLength(1);
    expect(splitConflicts[0].platforms).toEqual(["macos", "windows", "linux", "other"]);
  });

  it("does not validate a common key where the target already has a platform override", () => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {
        "tools.selectTool": { windows: ["F8"] },
      },
    });
    const conflict = findShortcutAssignmentConflicts("tools.selectTool", "B", "common")
      .find((candidate) => candidate.actionId === "tools.splitTool");
    expect(conflict?.platforms).toEqual(["macos", "linux"]);
  });

  it("validates imported overrides against their base profile before activation", () => {
    const conflicts = findCustomKeyboardProfileConflicts({
      baseProfileId: "openstudio",
      bindings: {
        "file.save": { common: ["B"] },
      },
    });

    expect(conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetActionId: "file.save",
        actionId: "tools.splitTool",
        sharedScopes: ["timeline"],
        precedence: "existing_precedes",
        platforms: ["macos", "windows", "linux", "other"],
      }),
    ]));
  });

  it("includes imported base-profile scope additions in collision checks", () => {
    const conflicts = findCustomKeyboardProfileConflicts({
      baseProfileId: "garageband",
      bindings: {
        "tools.selectTool": { common: ["M"] },
      },
    });

    expect(conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetActionId: "tools.selectTool",
        actionId: "track.toggleSelectedMute",
        sharedScopes: expect.arrayContaining(["timeline"]),
        precedence: "same_precedence",
      }),
    ]));
  });
});

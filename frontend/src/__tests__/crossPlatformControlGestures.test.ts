import { describe, expect, it } from "vitest";
import scriptEditorSource from "../components/ScriptEditor.tsx?raw";
import timelineSource from "../components/Timeline.tsx?raw";
import sliderSource from "../components/ui/Slider/Slider.tsx?raw";
import { matchesActionShortcut } from "../utils/globalShortcutDispatcher";
import { useDAWStore } from "../store/useDAWStore";

describe("cross-platform component gestures", () => {
  it("runs scripts with the platform primary modifier", () => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {},
    });
    expect(matchesActionShortcut(
      { key: "Enter", code: "Enter", ctrlKey: true },
      "script.runCurrent",
      "windows",
    )).toBe(true);
    expect(matchesActionShortcut(
      { key: "Enter", code: "Enter", metaKey: true },
      "script.runCurrent",
      "macos",
    )).toBe(true);
    expect(scriptEditorSource).toContain("matchesActionShortcut(e.nativeEvent, actionId)");
  });

  it("resets both native and custom sliders with Ctrl or Command", () => {
    expect(sliderSource.match(/e\.ctrlKey \|\| e\.metaKey/g)).toHaveLength(2);
  });

  it("lets both Ctrl and Command bypass snap for timeline split/context actions", () => {
    expect(timelineSource).not.toContain("ctrlBypass: Boolean(e.evt?.ctrlKey),");
    expect(timelineSource.match(/Boolean\(e\.evt\?\.ctrlKey \|\| e\.evt\?\.metaKey\)/g)?.length)
      .toBeGreaterThanOrEqual(5);
  });
});

import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import timelineSource from "../components/Timeline.tsx?raw";
import rulerSource from "../components/TimelineRuler.tsx?raw";

describe("workspace sticky header structure", () => {
  it("renders the workspace-level sticky header shells", () => {
    expect(appSource).toContain('className="workspace-sticky-header"');
    expect(appSource).toContain('className="workspace-sticky-tcp-header"');
    expect(appSource).toContain("<TimelineRuler />");
    expect(appSource).toContain('className="workspace-main-row"');
    expect(appSource).toContain("showRuler={false}");
  });

  it("anchors Timeline sizing and scroll sync to the workspace container", () => {
    expect(timelineSource).toContain('container.closest(".workspace")');
    expect(timelineSource).toContain("showRuler = true");
    expect(timelineSource).toContain("const rulerOffset = showRuler ? RULER_HEIGHT : 0;");
  });

  it("extracts the ruler into its own component", () => {
    expect(rulerSource).toContain("export function TimelineRuler()");
    expect(rulerSource).toContain("TIMELINE_RULER_HEIGHT = 30");
    expect(rulerSource).toContain('className="workspace-sticky-ruler"');
  });

  it("routes ruler wheel gestures through the selected DAW profile", () => {
    expect(rulerSource).toContain("getMouseBehaviorProfile(");
    expect(rulerSource).toContain('surface: "timeline"');
    expect(rulerSource).toContain('subtarget: "ruler"');
    expect(rulerSource).toContain('container.addEventListener("wheel", handleWheel, { passive: false })');
    expect(rulerSource).toContain("getTimelineHorizontalScrollMax(");
    expect(rulerSource).toContain("state.recordingClips.length > 0");
    expect(timelineSource).toContain('data-wheel-subtarget="ruler"');
  });
});

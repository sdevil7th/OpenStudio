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
});

import { describe, expect, it } from "vitest";
import designPortSource from "../components/NAMRackDesignPort.tsx?raw";
import rackKnobSource from "../components/NAMRackKnob.tsx?raw";
import rackPanelSource from "../components/NAMRackPanel.tsx?raw";

interface WheelSourceContract {
  name: string;
  source: string;
  handlerCount: number;
  parameterHandlerCount: number;
  subtarget: "control" | "graph";
}

const wheelSources: readonly WheelSourceContract[] = [
  // AssetControl, the vertical Fader, and HorizontalMiniFader are parameter
  // handlers. The fourth onWheel belongs only to the PRE-row scroller.
  { name: "design port", source: designPortSource, handlerCount: 4, parameterHandlerCount: 3, subtarget: "control" },
  { name: "rack knob", source: rackKnobSource, handlerCount: 1, parameterHandlerCount: 1, subtarget: "control" },
  { name: "rack panel", source: rackPanelSource, handlerCount: 1, parameterHandlerCount: 1, subtarget: "control" },
];

function occurrenceCount(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("NAM parameter wheel integration", () => {
  it.each(wheelSources)(
    "routes every $name wheel handler through the profiled resolver",
    ({ source, handlerCount, parameterHandlerCount, subtarget }) => {
      expect(occurrenceCount(source, /\bonWheel=/g)).toBe(handlerCount);
      expect(occurrenceCount(
        source,
        new RegExp(`resolveProfiledParameterWheel\\(event\\.nativeEvent, "${subtarget}"\\)`, "g"),
      )).toBe(parameterHandlerCount);
      expect(occurrenceCount(
        source,
        /getParameterWheelStepCount\(gesture/g,
      )).toBe(parameterHandlerCount);
      expect(occurrenceCount(
        source,
        /if \(gesture\.preventDefault\) event\.preventDefault\(\);/g,
      )).toBe(parameterHandlerCount);
      expect(occurrenceCount(
        source,
        /if \(gesture\.stopPropagation\) event\.stopPropagation\(\);/g,
      )).toBe(parameterHandlerCount);
      expect(occurrenceCount(
        source,
        /if \(gesture\.operation !== "adjust"\) return;/g,
      )).toBe(parameterHandlerCount);
    },
  );

  it("uses the resolved precision instead of raw Ctrl, Command, or Shift state", () => {
    for (const { source, parameterHandlerCount } of wheelSources) {
      let cursor = 0;
      for (let index = 0; index < parameterHandlerCount; index += 1) {
        const resolverStart = source.indexOf(
          "const gesture = resolveProfiledParameterWheel(event.nativeEvent",
          cursor,
        );
        expect(resolverStart).toBeGreaterThanOrEqual(0);
        const stepStart = source.indexOf("getParameterWheelStepCount(gesture", resolverStart);
        expect(stepStart).toBeGreaterThan(resolverStart);
        const resolutionEnd = source.indexOf(");", stepStart) + 2;
        expect(resolutionEnd).toBeGreaterThan(stepStart);
        const resolutionBlock = source.slice(resolverStart, resolutionEnd);
        expect(resolutionBlock).not.toMatch(
          /event\.(?:ctrlKey|metaKey|shiftKey|deltaY)/,
        );
        cursor = resolutionEnd;
      }
    }
  });

  it("keeps the extra PRE-row wheel handler dedicated to horizontal scrolling", () => {
    expect(occurrenceCount(designPortSource, /\bonWheel=/g)).toBe(4);
    expect(occurrenceCount(
      designPortSource,
      /resolveProfiledParameterWheel\(event\.nativeEvent, "control"\)/g,
    )).toBe(3);
    expect(designPortSource).toContain('className="nam-pre-stage-scroll"');
    expect(designPortSource).toContain('target.closest(".control-hit, .horizontal-mini-fader")');
    expect(designPortSource).toContain("event.currentTarget.scrollLeft += delta");
  });

});

import { describe, expect, it } from "vitest";
import timelineSource from "../components/Timeline.tsx?raw";

function sourceBetween(start: string, end: string): string {
  const startIndex = timelineSource.indexOf(start);
  const endIndex = timelineSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return timelineSource.slice(startIndex, endIndex);
}

describe("timeline clip context-menu integration", () => {
  it("rejects secondary mouse buttons before either clip tool can act", () => {
    const guard = "if ((e.evt?.button ?? 0) !== 0) return;";
    const splitCheck = 'if (toolModeRef.current === "split")';
    const audioMouseDown = sourceBetween(
      "const handleMouseDown = (e: KonvaEvent) => {",
      "const handleDragMoveModified = (e: KonvaEvent) => {",
    );
    const midiMouseDown = sourceBetween(
      "const handleMIDIClipMouseDown = (e: KonvaEvent) => {",
      "const handleMIDIClipClick = (e: KonvaEvent) => {",
    );

    for (const handler of [audioMouseDown, midiMouseDown]) {
      expect(handler).toContain(guard);
      expect(handler.indexOf(guard)).toBeLessThan(handler.indexOf(splitCheck));
    }
  });

  it("rejects synthesized secondary-button clicks before clip or stage actions", () => {
    const guard = "if ((e.evt?.button ?? 0) !== 0) return;";
    const audioClick = sourceBetween(
      "const handleClipClick = (e: KonvaEvent) => {",
      "const handleDragStart =",
    );
    const midiClick = sourceBetween(
      "const handleMIDIClipClick = (e: KonvaEvent) => {",
      "const handleMIDIClipDoubleClick =",
    );
    const mainStagePrelude = sourceBetween(
      "{/* Main Timeline Stage */}",
      "onContextMenu={(e: KonvaEvent) => {",
    );

    expect(audioClick.indexOf(guard)).toBeLessThan(audioClick.indexOf("shiftKey"));
    expect(midiClick.indexOf(guard)).toBeLessThan(midiClick.indexOf("selectClip"));
    expect(mainStagePrelude.match(/if \(\(e\.evt\?\.button \?\? 0\) !== 0\) return;/g)).toHaveLength(2);
  });

  it("links Shift-drag click suppression to the originating native event", () => {
    const audioClick = sourceBetween(
      "const handleClipClick = (e: KonvaEvent) => {",
      "const handleDragStart =",
    );
    const audioDragEnd = sourceBetween(
      "const handleDragEnd = async (e: KonvaEvent) => {",
      "// Mouse handlers for edge resize",
    );

    expect(audioClick).toContain("suppressShiftGainClickRef.current = null");
    expect(audioClick).toContain("suppressed.nativeEvent === e.evt");
    expect(audioDragEnd).toContain("nativeEvent: e.evt");
    expect(timelineSource).not.toContain("Date.now() - suppressed.at");
  });

  it("routes all clip context entry points through shared selection and snapped-time capture", () => {
    expect(timelineSource).toContain("shouldPreserveClipContextSelection(selection");
    expect(timelineSource).toContain("selectedClipIds: [options.clipId]");
    expect(timelineSource).toContain("selectedTrackId: null");
    expect(timelineSource).toContain("selectedTrackIds: []");
    expect(timelineSource.match(/openTimelineClipContextMenu\(\{/g)).toHaveLength(3);
    expect(timelineSource).toContain(
      "time: resolveTimelinePointerSplitTime(options.stageX, options.ctrlBypass)",
    );
    expect(timelineSource).toContain("if (isSnapActive(ctrlBypass))");
    expect(timelineSource).toContain("splitTime = snapTimelineTime(splitTime, splitTime)");
  });

  it("offers split here and split at the current playhead as submenu choices", () => {
    const menuSource = sourceBetween(
      "const buildClipContextMenuItems =",
      'className="timeline-container',
    );

    expect(menuSource).toContain('label: "Split"');
    expect(menuSource).toContain('label: "Here"');
    expect(menuSource).toContain('label: "At Playhead"');
    expect(menuSource).toContain('shortcut: "S"');
    expect(menuSource).toContain("st.splitMIDIClipAtPosition(menu.clipId, splitTime)");
    expect(menuSource).toContain("st.splitClipAtPosition(menu.clipId, splitTime)");
    expect(menuSource).toContain("useDAWStore.getState().splitClipAtPlayhead()");
    expect(menuSource).not.toContain('label: "Split at Cursor"');
  });
});

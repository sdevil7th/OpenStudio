import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDAWStore } from "../store/useDAWStore";

vi.mock("../store/useDAWStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/useDAWStore")>();
  const store = actual.useDAWStore;
  return { ...actual, useDAWStore: Object.assign(
    (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()),
    store,
  ) };
});
vi.mock("react-konva", () => {
  const container = ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children);
  return {
    Stage: container, Layer: container, Rect: () => null,
    Line: ({ points }: { points: number[] }) => React.createElement("i", { "data-x": points[0] }),
    Text: ({ text }: { text: string }) => React.createElement("span", null, text),
  };
});
vi.mock("../components/Playhead", () => ({ MemoizedPlayhead: () => null }));
import { TimelineRuler } from "../components/TimelineRuler";

const original = useDAWStore.getState();
afterEach(() => useDAWStore.setState(original));
function render(scrollX: number) {
  useDAWStore.setState({ pixelsPerSecond: 1000, scrollX, timeSignature: { numerator: 4, denominator: 4 }, transport: { ...original.transport, tempo: 120 } });
  return renderToStaticMarkup(<TimelineRuler />);
}
describe("zoomed timeline ruler", () => {
  it("keeps visible beats and subdivisions when the bar start is offscreen", () => {
    const html = render(700);
    expect(html).toContain(">1.3</span>");
    expect(html).toContain(">1.2.5</span>");
  });
  it("draws subdivisions of the first beat", () => {
    expect(render(0)).toContain(">1.1.2</span>");
  });
  it("keeps subdivisions when their beat starts offscreen", () => {
    expect(render(100)).toContain(">1.1.3</span>");
  });
});

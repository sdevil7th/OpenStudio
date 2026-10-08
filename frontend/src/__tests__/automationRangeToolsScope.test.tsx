import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationRangeTools } from "../components/AutomationRangeTools";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";

// SSR normally reads Zustand's initial snapshot; exercise the current dialog state.
vi.mock("../store/useDAWStore", async importOriginal => {
  const actual = await importOriginal<typeof import("../store/useDAWStore")>();
  return { ...actual, useDAWStore: Object.assign(
    (selector: (state: ReturnType<typeof actual.useDAWStore.getState>) => unknown) => selector(actual.useDAWStore.getState()),
    actual.useDAWStore,
  ) };
});

const initial = useDAWStore.getState();
afterEach(() => useDAWStore.setState(initial));

describe("envelope range tool scope", () => {
  it("only offers edits for the track displayed by the dialog", () => {
    const track = createDefaultTrack("track", "Track", "#fff", "audio");
    track.automationLanes = [{ id: "pan", param: "pan", label: "Track pan", points: [], mode: "read", armed: false, visible: true, readEnabled: true }];
    useDAWStore.setState({ tracks: [track], selectedAutomationTarget: { kind: "track", trackId: "track", laneId: "pan", pointId: null } });
    expect(renderToStaticMarkup(<AutomationRangeTools trackId="track" />)).toContain("Track pan");
    expect(renderToStaticMarkup(<AutomationRangeTools trackId="other" />)).toBe("");
    expect(renderToStaticMarkup(<AutomationRangeTools trackId="master" />)).toBe("");
  });

  it("keeps master range edits inside the master dialog", () => {
    useDAWStore.setState({ masterAutomationLanes: [{ id: "gain", param: "volume", label: "Master gain", points: [], mode: "read", armed: false, visible: true, readEnabled: true }],
      selectedAutomationTarget: { kind: "master", laneId: "gain", pointId: null } });
    expect(renderToStaticMarkup(<AutomationRangeTools trackId="master" />)).toContain("Master gain");
    expect(renderToStaticMarkup(<AutomationRangeTools trackId="track" />)).toBe("");
  });
});

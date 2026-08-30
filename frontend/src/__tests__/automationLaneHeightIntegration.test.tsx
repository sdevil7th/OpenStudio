import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackHeader } from "../components/TrackHeader";
import { commandManager } from "../store/commands";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();

beforeEach(() => {
  commandManager.clear();
});

afterEach(() => {
  commandManager.clear();
  useDAWStore.setState(initialState);
});

describe("automation lane height UI integration", () => {
  it("renders the hovered lane at the height stored by the wheel action", () => {
    const track = createDefaultTrack("track-1", "Track 1", "#3b82f6", "audio");
    track.showAutomation = true;
    track.automationLanes = [{
      id: "volume-lane",
      param: "volume",
      points: [],
      visible: true,
      mode: "read",
      armed: false,
      readEnabled: true,
    }];
    useDAWStore.setState({ tracks: [track] });

    const state = useDAWStore.getState();
    state.beginAutomationLaneHeightEdit("track-1", "volume-lane");
    state.setAutomationLaneHeight("track-1", "volume-lane", 96);
    state.commitAutomationLaneHeightEdit("track-1", "volume-lane");
    const updatedTrack = useDAWStore.getState().tracks[0];
    const html = renderToStaticMarkup(
      <TrackHeader track={updatedTrack} isSelected={false} />,
    );

    expect(html).toContain('data-automation-lane-id="volume-lane"');
    expect(html).toMatch(
      /data-automation-lane-id="volume-lane"[^>]*style="height:96px"/,
    );
  });
});

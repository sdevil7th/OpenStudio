import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelStrip } from "../components/ChannelStrip";
import channelStripSource from "../components/ChannelStrip.tsx?raw";
import masterTrackHeaderSource from "../components/MasterTrackHeader.tsx?raw";
import { type Track, useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();

const masterTrack: Track = {
  id: "master",
  name: "MASTER",
  color: "#0078d4",
  type: "audio",
  inputType: "stereo",
  volume: 1,
  volumeDB: 0,
  pan: 0,
  muted: false,
  soloed: false,
  armed: false,
  monitorEnabled: false,
  recordSafe: false,
  meterLevel: 0,
  peakLevel: 0,
  clipping: false,
  inputChannel: null,
  inputStartChannel: 0,
  inputChannelCount: 2,
  inputFxCount: 0,
  trackFxCount: 1,
  fxBypassed: false,
  automationLanes: [],
  showAutomation: false,
  automationEnabled: true,
  suspendedAutomationState: null,
  frozen: false,
  takes: [],
  activeTakeIndex: 0,
  sends: [],
  phaseInverted: false,
  stereoWidth: 100,
  masterSendEnabled: true,
  outputStartChannel: 0,
  outputChannelCount: 2,
  playbackOffsetMs: 0,
  trackChannelCount: 2,
  midiOutputDevice: "",
  clips: [],
  midiClips: [],
};

afterEach(() => {
  useDAWStore.setState(initialState);
});

describe("master channel strip controls", () => {
  it("renders mute and mono in the top row without a solo button", () => {
    useDAWStore.setState({
      masterVolume: 1,
      isMasterMuted: false,
      masterMono: false,
      masterFxCount: 1,
    });

    const html = renderToStaticMarkup(
      <ChannelStrip track={masterTrack} trackIndex={-1} isMaster />,
    );

    expect(html).toContain('aria-label="Mute master"');
    expect(html).toContain(">MONO<");
    expect(html).not.toContain('aria-label="Solo master"');
    expect(html).not.toContain(">S<");
  });

  it("wires the master strip and header to the shared master mute state", () => {
    expect(channelStripSource).toContain("active={isMasterMuted}");
    expect(channelStripSource).toContain("onClick={toggleMasterMute}");
    expect(channelStripSource).toContain(
      'aria-label={isMasterMuted ? "Unmute master" : "Mute master"}',
    );
    expect(masterTrackHeaderSource).toContain("active={isMasterMuted}");
    expect(masterTrackHeaderSource).toContain("onClick={toggleMasterMute}");
    expect(masterTrackHeaderSource).toContain(
      'title={isMasterMuted ? "Unmute Master" : "Mute Master"}',
    );
  });
});

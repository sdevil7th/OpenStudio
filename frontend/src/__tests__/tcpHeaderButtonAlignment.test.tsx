import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MasterTrackHeader } from "../components/MasterTrackHeader";
import { TrackHeader } from "../components/TrackHeader";
import {
  TCP_HEADER_ANCHORED_BUTTON_PAIR_CLASS,
  TCP_HEADER_BUTTON_PAIR_CLASS,
  TCP_HEADER_PRIMARY_BUTTON_CLASS,
  TCP_HEADER_TOGGLE_BUTTON_CLASS,
} from "../components/tcpHeaderButtonStyles";
import { type Track, useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();

function getButtonTag(html: string, title: string) {
  const escapedTitle = escapeForRegex(title);
  const match = html.match(new RegExp(`<button[^>]*title="${escapedTitle}"[^>]*>`));
  expect(match, `Expected button with title "${title}" to be present`).not.toBeNull();
  return match![0];
}

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const baseTrack: Track = {
  id: "track-1",
  name: "Track 1",
  color: "#3b82f6",
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
  automationLanes: [
    {
      id: "lane-1",
      param: "volume",
      points: [],
      visible: true,
      mode: "read",
      armed: false,
    },
  ],
  showAutomation: true,
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

describe("TCP header button alignment", () => {
  it("renders the master mono button as MONO", () => {
    useDAWStore.setState({
      masterVolume: 1,
      isMasterMuted: false,
      masterFxCount: 1,
      masterMono: false,
      masterAutomationLanes: [
        {
          id: "master-lane-1",
          param: "volume",
          points: [],
          visible: true,
          mode: "read",
          armed: false,
        },
      ],
      showMasterAutomation: true,
      masterAutomationEnabled: true,
    });

    const html = renderToStaticMarkup(<MasterTrackHeader />);

    expect(html).toContain(">MONO<");
    expect(html).toContain('title="Master Volume: 0.0 dB"');
  });

  it("keeps the master automation pair gray when no lanes are active", () => {
    useDAWStore.setState({
      masterVolume: 1,
      isMasterMuted: false,
      masterFxCount: 1,
      masterMono: false,
      masterAutomationLanes: [
        {
          id: "master-lane-1",
          param: "volume",
          points: [],
          visible: false,
          mode: "read",
          armed: false,
        },
      ],
      showMasterAutomation: false,
      masterAutomationEnabled: true,
    });

    const html = renderToStaticMarkup(<MasterTrackHeader />);

    expect(
      getButtonTag(html, "Master Automation (right-click to toggle lanes)"),
    ).toContain("hover:text-green-500 hover:border-green-500");
    expect(
      getButtonTag(html, "Master Automation (right-click to toggle lanes)"),
    ).not.toContain("text-green-400!");
    expect(getButtonTag(html, "No automation lanes")).toContain(
      "hover:text-green-500 hover:border-green-500",
    );
    expect(getButtonTag(html, "No automation lanes")).not.toContain(
      "text-green-400!",
    );
  });

  it("uses the shared FX and automation pair contract in both TCP headers", () => {
    useDAWStore.setState({
      masterVolume: 1,
      isMasterMuted: false,
      masterFxCount: 1,
      masterMono: false,
      masterAutomationLanes: [
        {
          id: "master-lane-1",
          param: "volume",
          points: [],
          visible: true,
          mode: "read",
          armed: false,
        },
      ],
      showMasterAutomation: true,
      masterAutomationEnabled: true,
    });

    const trackHtml = renderToStaticMarkup(
      <TrackHeader track={baseTrack} isSelected={false} />,
    );
    const masterHtml = renderToStaticMarkup(<MasterTrackHeader />);

    expect(trackHtml).toContain(
      `data-tcp-pair="fx" class="${TCP_HEADER_BUTTON_PAIR_CLASS}"`,
    );
    expect(trackHtml).toContain(
      `data-tcp-pair="automation" class="${TCP_HEADER_ANCHORED_BUTTON_PAIR_CLASS}"`,
    );
    expect(masterHtml).toMatch(
      new RegExp(
        `data-tcp-pair="fx" class="[^"]*${escapeForRegex(
          TCP_HEADER_BUTTON_PAIR_CLASS,
        )}[^"]*"`,
      ),
    );
    expect(masterHtml).toMatch(
      new RegExp(
        `data-tcp-pair="automation" class="[^"]*${escapeForRegex(
          TCP_HEADER_BUTTON_PAIR_CLASS,
        )}[^"]*"`,
      ),
    );

    expect(getButtonTag(trackHtml, "FX Chain")).toContain(
      `w-6 h-6 text-[10px]`,
    );
    expect(getButtonTag(trackHtml, "FX Chain")).toContain(
      TCP_HEADER_PRIMARY_BUTTON_CLASS,
    );
    expect(
      getButtonTag(trackHtml, "Envelope Manager (right-click for quick options)"),
    ).toContain(`w-6 h-6 text-[10px]`);
    expect(
      getButtonTag(trackHtml, "Envelope Manager (right-click for quick options)"),
    ).toContain(TCP_HEADER_PRIMARY_BUTTON_CLASS);
    expect(getButtonTag(trackHtml, "Suspend automation")).toContain(
      `w-4 h-6 text-[10px]`,
    );
    expect(getButtonTag(trackHtml, "Suspend automation")).toContain(
      TCP_HEADER_TOGGLE_BUTTON_CLASS,
    );
    expect(trackHtml).toMatch(
      new RegExp(
        `data-tcp-pair="fx" class="${escapeForRegex(
          TCP_HEADER_BUTTON_PAIR_CLASS,
        )}"[\\s\\S]*?${escapeForRegex(
          TCP_HEADER_PRIMARY_BUTTON_CLASS,
        )}[\\s\\S]*?${escapeForRegex(TCP_HEADER_TOGGLE_BUTTON_CLASS)}`,
      ),
    );

    expect(getButtonTag(masterHtml, "Master FX Chain")).toContain(
      `w-6 h-6 text-[10px]`,
    );
    expect(getButtonTag(masterHtml, "Master FX Chain")).toContain(
      TCP_HEADER_PRIMARY_BUTTON_CLASS,
    );
    expect(
      getButtonTag(masterHtml, "Master Automation (right-click to toggle lanes)"),
    ).toContain(`w-6 h-6 text-[10px]`);
    expect(
      getButtonTag(masterHtml, "Master Automation (right-click to toggle lanes)"),
    ).toContain(TCP_HEADER_PRIMARY_BUTTON_CLASS);
    expect(masterHtml).toMatch(
      new RegExp(
        `data-tcp-pair="automation" class="[^"]*${escapeForRegex(
          TCP_HEADER_BUTTON_PAIR_CLASS,
        )}[^"]*"[\\s\\S]*?${escapeForRegex(
          TCP_HEADER_PRIMARY_BUTTON_CLASS,
        )}[\\s\\S]*?w-4 h-6 text-\\[10px\\][\\s\\S]*?${escapeForRegex(
          TCP_HEADER_TOGGLE_BUTTON_CLASS,
        )}`,
      ),
    );
    expect(masterHtml).toMatch(
      new RegExp(
        `data-tcp-pair="fx" class="[^"]*${escapeForRegex(
          TCP_HEADER_BUTTON_PAIR_CLASS,
        )}[^"]*"[\\s\\S]*?${escapeForRegex(
          TCP_HEADER_PRIMARY_BUTTON_CLASS,
        )}[\\s\\S]*?w-4 h-6 text-\\[10px\\][\\s\\S]*?${escapeForRegex(
          TCP_HEADER_TOGGLE_BUTTON_CLASS,
        )}`,
      ),
    );
  });
});

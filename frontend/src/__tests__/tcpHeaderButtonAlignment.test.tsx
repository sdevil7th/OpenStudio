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
import { createDefaultTrack, type Track, useDAWStore } from "../store/useDAWStore";

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
      readEnabled: true,
    },
  ],
  showAutomation: true,
  automationReadEnabled: true,
  automationWriteEnabled: false,
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
  it("disables track automation read when no automation lanes exist", () => {
    const freshTrack = createDefaultTrack("track-fresh", "Fresh", "#14b8a6", "audio", []);

    const html = renderToStaticMarkup(
      <TrackHeader track={freshTrack} isSelected={false} />,
    );

    expect(getButtonTag(html, "Add an automation lane or enable write first")).toContain("disabled");
    expect(getButtonTag(html, "Add an automation lane or enable write first")).toContain("text-neutral-600!");
    expect(getButtonTag(html, "Enable automation write")).not.toContain("disabled");
  });

  it("keeps empty-track read clickable while write forces read on", () => {
    const freshTrack = {
      ...createDefaultTrack("track-fresh", "Fresh", "#14b8a6", "audio", []),
      automationReadEnabled: true,
      automationWriteEnabled: true,
      automationEnabled: true,
    };

    const html = renderToStaticMarkup(
      <TrackHeader track={freshTrack} isSelected={false} />,
    );

    expect(getButtonTag(html, "Disable automation read")).not.toContain("disabled");
    expect(getButtonTag(html, "Disable automation read")).toContain("bg-teal-600/25!");
    expect(getButtonTag(html, "Disable automation write")).not.toContain("disabled");
  });

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
          readEnabled: true,
        },
      ],
      showMasterAutomation: true,
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: true,
    });

    const html = renderToStaticMarkup(<MasterTrackHeader />);

    expect(html).toContain(">MONO<");
    expect(html).toContain('title="Master Volume: 0.0 dB"');
  });

  it("renders independent master automation read and write buttons", () => {
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
          readEnabled: true,
        },
      ],
      showMasterAutomation: false,
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: true,
    });

    const html = renderToStaticMarkup(<MasterTrackHeader />);

    expect(getButtonTag(html, "Add a master automation lane or enable write first")).toContain("disabled");
    expect(getButtonTag(html, "Add a master automation lane or enable write first")).toContain("text-neutral-600!");
    expect(getButtonTag(html, "Enable master automation write")).toContain(
      "hover:text-red-300 hover:border-red-500",
    );
    expect(getButtonTag(html, "Master automation panel")).toContain(
      "hover:text-teal-300 hover:border-teal-500",
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
          readEnabled: true,
        },
      ],
      showMasterAutomation: true,
      masterAutomationReadEnabled: true,
      masterAutomationWriteEnabled: false,
      masterAutomationEnabled: true,
    });

    const trackHtml = renderToStaticMarkup(
      <TrackHeader track={baseTrack} isSelected={false} />,
    );
    const masterHtml = renderToStaticMarkup(<MasterTrackHeader />);

    expect(trackHtml).toContain(
      `data-tcp-pair="fx" class="${TCP_HEADER_BUTTON_PAIR_CLASS}"`,
    );
    expect(trackHtml).toMatch(
      /data-tcp-pair="automation" class="[^"]*relative inline-flex[^"]*h-6[^"]*shrink-0[^"]*items-center[^"]*gap-0[^"]*overflow-hidden[^"]*ring-1[^"]*ring-inset[^"]*"/,
    );
    expect(trackHtml).toMatch(
      /data-tcp-pair="automation" class="[^"]*ring-neutral-700[^"]*"/,
    );
    expect(trackHtml).not.toMatch(
      /data-tcp-pair="automation" class="[^"]*ring-teal-500[^"]*"/,
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
          TCP_HEADER_ANCHORED_BUTTON_PAIR_CLASS,
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
      getButtonTag(trackHtml, "Disable automation read"),
    ).toContain(`w-6 h-6 text-[10px]`);
    expect(
      getButtonTag(trackHtml, "Disable automation read"),
    ).toContain("rounded");
    expect(getButtonTag(trackHtml, "Automation panel")).toContain(
      `w-4 h-6 text-[10px]`,
    );
    expect(getButtonTag(trackHtml, "Automation panel")).toContain(
      "rounded-none",
    );
    expect(getButtonTag(trackHtml, "Automation panel")).toContain(
      "border-y-0!",
    );
    expect(getButtonTag(trackHtml, "Automation panel")).toContain(
      "border-l!",
    );
    expect(getButtonTag(trackHtml, "Automation panel")).not.toContain(
      "bg-teal-500/10!",
    );
    expect(getButtonTag(trackHtml, "Enable automation write")).toContain(
      "rounded-none border-y-0! border-r-0! border-l!",
    );
    expect(getButtonTag(trackHtml, "Enable automation write")).toContain(
      `w-6 h-6 text-[10px]`,
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
      getButtonTag(masterHtml, "Add a master automation lane or enable write first"),
    ).toContain(`w-6 h-6 text-[10px]`);
    expect(
      getButtonTag(masterHtml, "Add a master automation lane or enable write first"),
    ).toContain("rounded");
    expect(masterHtml).toMatch(
      new RegExp(
        `data-tcp-pair="automation" class="[^"]*${escapeForRegex(
          TCP_HEADER_ANCHORED_BUTTON_PAIR_CLASS,
        )}[^"]*"[\\s\\S]*?rounded[\\s\\S]*?${escapeForRegex(
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

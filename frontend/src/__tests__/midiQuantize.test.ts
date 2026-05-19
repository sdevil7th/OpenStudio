import { afterEach, describe, expect, it } from "vitest";
import { type MIDIClip, type Track, useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();

function makeMidiTrack(midiClip: MIDIClip): Track {
  return {
    id: "track-midi",
    name: "MIDI",
    color: "#38bdf8",
    type: "midi",
    inputType: "midi",
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
    trackFxCount: 0,
    fxBypassed: false,
    automationLanes: [],
    showAutomation: false,
    automationReadEnabled: false,
    automationWriteEnabled: false,
    automationEnabled: false,
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
    midiClips: [midiClip],
  };
}

afterEach(() => {
  useDAWStore.setState(initialState);
});

describe("MIDI quantize", () => {
  it("aligns note starts to the visible project grid, not the clip-local origin", () => {
    const clip: MIDIClip = {
      id: "clip-midi",
      name: "Offset MIDI",
      startTime: 1.5,
      duration: 4,
      sourceLength: 4,
      events: [
        { type: "noteOn", timestamp: 0.6, note: 60, velocity: 100 },
        { type: "noteOff", timestamp: 0.8, note: 60, velocity: 0 },
      ],
      ccEvents: [],
      color: "#38bdf8",
    };

    useDAWStore.setState({
      tracks: [makeMidiTrack(clip)],
      selectedNoteIds: [],
      transport: {
        ...useDAWStore.getState().transport,
        tempo: 120,
      },
      timeSignature: { numerator: 4, denominator: 4 },
      quantizePresetId: "factory-1/1",
    });

    useDAWStore.getState().quantizeSelectedMIDINotes("track-midi", "clip-midi", 2, 1, {
      presetId: "factory-1/1",
      gridSize: "1/1",
      mode: "start",
    });

    const updatedClip = useDAWStore
      .getState()
      .tracks[0]
      .midiClips[0];
    const noteOn = updatedClip.events.find((event) => event.type === "noteOn");
    const noteOff = updatedClip.events.find((event) => event.type === "noteOff");

    expect(noteOn?.timestamp).toBeCloseTo(0.5, 6);
    expect(noteOff?.timestamp).toBeCloseTo(0.7, 6);
  });
});

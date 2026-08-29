import { afterEach, describe, expect, it } from "vitest";
import audioEngineSource from "../../../Source/AudioEngine.cpp?raw";
import mainComponentSource from "../../../Source/MainComponent.cpp?raw";
import trackProcessorSource from "../../../Source/TrackProcessor.cpp?raw";
import { getStereoMeterChannelLevels } from "../components/PeakMeter";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { resolveTrackMeterPresentation } from "../utils/trackMeterPresentation";

const initialState = useDAWStore.getState();

function normalizeSourceText(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

afterEach(() => {
  useDAWStore.setState(initialState, true);
});

describe("raw MIDI input metering", () => {
  it("uses MIDI only for armed MIDI-capable tracks with silent audio output", () => {
    expect(resolveTrackMeterPresentation(0, 0.8, true, "midi")).toEqual({
      source: "midi_input",
      normalizedLevel: 0.8,
    });
    expect(resolveTrackMeterPresentation(0, 0.8, true, "instrument").source)
      .toBe("midi_input");
    expect(resolveTrackMeterPresentation(0, 0.8, false, "midi").source)
      .toBe("idle");
    expect(resolveTrackMeterPresentation(0, 0.8, true, "audio").source)
      .toBe("idle");
  });

  it("gives real post-FX audio output precedence over simultaneous MIDI input", () => {
    const result = resolveTrackMeterPresentation(0.2, 1, true, "instrument");
    expect(result).toEqual({ source: "audio", normalizedLevel: 0.2 });
  });

  it("keeps the two MIDI activity lanes exactly mirrored", () => {
    expect(getStereoMeterChannelLevels(0.72, 0.72, "midi_input")).toEqual({
      leftLevel: 0.72,
      rightLevel: 0.72,
      leftRms: 0.72,
      rightRms: 0.72,
    });
    const audio = getStereoMeterChannelLevels(0.72, 0.5, "audio");
    expect(audio.leftLevel).not.toBe(audio.rightLevel);
  });

  it("stores MIDI activity separately from audio peaks and clipping", () => {
    const track = createDefaultTrack("midi-meter", "MIDI Meter", "#67e8f9", "midi");
    track.armed = true;
    useDAWStore.setState({
      tracks: [track],
      meterLevels: {},
      midiInputLevels: {},
      peakLevels: {},
      clippingStates: {},
    });

    useDAWStore.getState().batchUpdateMeterLevels(
      { [track.id]: 0 },
      0,
      { [track.id]: false },
      false,
      { [track.id]: 0.91 },
    );

    const state = useDAWStore.getState();
    expect(state.midiInputLevels[track.id]).toBe(0.91);
    expect(state.meterLevels[track.id]).toBe(0);
    expect(state.peakLevels[track.id]).toBe(0);
    expect(state.clippingStates[track.id]).toBe(false);
  });

  it("captures filtered armed input before monitoring and emits it in the batched meter event", () => {
    const normalizedAudioEngineSource = normalizeSourceText(audioEngineSource);
    const inputRouting = normalizedAudioEngineSource.slice(
      normalizedAudioEngineSource.indexOf("// Route MIDI to appropriate tracks"),
    );
    expect(inputRouting).toContain("if (track->getRecordArmed())\n            track->registerMIDIInputActivity(message);");
    expect(inputRouting.indexOf("track->registerMIDIInputActivity(message)")).toBeLessThan(
      inputRouting.indexOf("track->getInputMonitoring()"),
    );
    expect(trackProcessorSource).toContain("message.isNoteOn()");
    expect(trackProcessorSource).toContain("message.isController()");
    expect(trackProcessorSource).toContain("Note-off and transport/clock/active-sensing messages");
    expect(mainComponentSource).toContain('"midiInputLevels"');
    expect(mainComponentSource).toContain("audioEngine.getMIDIInputLevels()");
  });
});

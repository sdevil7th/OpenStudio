import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NAMRackDesignPort,
  type NAMRackDesignRuntimeStatus,
  type NAMRackDesignUtilityControls,
} from "../components/NAMRackDesignPort";
import type { BuiltInParamDescriptor } from "../services/NativeBridge";

const continuous = (
  id: string,
  label: string,
  value: number,
): BuiltInParamDescriptor => ({
  id,
  label,
  type: "continuous",
  value,
  min: 0,
  max: 1,
  defaultValue: value,
});

const headerParams: BuiltInParamDescriptor[] = [
  {
    id: "instrumentProfile",
    label: "Instrument Profile",
    type: "enum",
    value: 0,
    min: 0,
    max: 1,
    defaultValue: 0,
    enumOptions: [
      { value: 0, label: "Guitar" },
      { value: 1, label: "Bass" },
    ],
  },
  {
    id: "cabDoublerEnabled",
    label: "Doubler",
    type: "toggle",
    value: 0,
    min: 0,
    max: 1,
    defaultValue: 0,
  },
  continuous("cabDoublerMix", "Doubler Mix", 0.12),
  continuous("cabDoublerSpread", "Doubler Spread", 0.65),
];

const defaultUtilityControls: NAMRackDesignUtilityControls = {
  instrumentProfile: 0,
  effectiveInputMode: 0,
};

function renderHeaderUtility(
  utilityControls: NAMRackDesignUtilityControls = defaultUtilityControls,
  parameters: BuiltInParamDescriptor[] = headerParams,
  runtimeOverrides: Partial<NAMRackDesignRuntimeStatus> = {},
) {
  return renderToStaticMarkup(
    <NAMRackDesignPort
      sectionId="amp"
      rackSizePercent={140}
      parameters={parameters}
      rig={{
        presetName: "Clean Twin Style A2",
        presetEyebrow: "Loaded amp capture",
        presetDirty: false,
        pedalLabel: "No pedal capture",
        hasPedalCapture: false,
        ampLabel: "Clean Twin Style A2",
        cabLabel: "2x12 Blackface",
        cabStatus: "Cabinet IR loaded",
        hasAmpCapture: true,
        ampCaptureMissing: false,
        hasCabIR: true,
        cabMode: "loaded",
      }}
      runtime={{
        tempo: 120,
        timeSignatureLabel: "4/4",
        sampleRateLabel: "48 kHz",
        bufferLabel: "128 smp",
        latencyLabel: "8 ms",
        ...runtimeOverrides,
      }}
      tuner={{
        signalPresent: false,
        pitchLocked: false,
        noteLabel: "--",
        statusLabel: "Waiting",
        centsPct: 0,
        frequencyLabel: "-- Hz",
        inputLevelLabel: "-inf dB",
        confidenceLabel: "0%",
      }}
      utilityControls={utilityControls}
      oversamplingFactor={4}
      onOversamplingFactorChange={() => undefined}
      compareSlot="A"
      tunerOpen={false}
      onParamChange={() => undefined}
      onEnterSection={() => undefined}
      onOpenAdvancedStage={() => undefined}
      onOpenLibrary={() => undefined}
      onSaveTone={() => undefined}
      onRecallCompare={() => undefined}
      onOpenTuner={() => undefined}
      onOpenCalibration={() => undefined}
      onCycleSize={() => undefined}
      onMaxSize={() => undefined}
    />,
  );
}

describe("NAM Rack final header utility", () => {
  it("renders the rack-owned utility rail before the centred preset console", () => {
    const html = renderHeaderUtility();
    const utilityIndex = html.indexOf('data-qa="nam-header-utility"');
    const presetIndex = html.indexOf('class="preset-console ');
    const outputBayStart = html.indexOf('data-qa="nam-output-control-bay"');
    const switchStart = html.indexOf('data-qa="nam-instrument-profile"');
    const outputKnobStart = html.indexOf(
      'data-param-id="outputTrimDb"',
      outputBayStart,
    );

    expect(utilityIndex).toBeGreaterThan(-1);
    expect(presetIndex).toBeGreaterThan(utilityIndex);
    expect(outputBayStart).toBeGreaterThan(utilityIndex);
    expect(switchStart).toBeGreaterThan(outputBayStart);
    expect(outputKnobStart).toBeGreaterThan(switchStart);
    expect(html).toContain('aria-label="Doubler utility"');
    expect(html).toContain('data-qa="nam-instrument-profile"');
    expect(html).toContain('aria-label="Doubler"');
    expect(html).toContain('data-utility-rotary="mix"');
    expect(html).toContain('data-utility-rotary="spread"');
    expect(html).not.toContain('aria-label="NAM processing mode"');
    expect(html).not.toContain('aria-label="Processing and routed source"');
    expect(html).not.toContain('data-qa="nam-physical-source"');
    expect(html).not.toContain("Open Track Routing");
  });

  it("renders a compact switch-only instrument selector bound to instrumentProfile", () => {
    const html = renderHeaderUtility();
    const instrumentSwitchStart = html.indexOf('data-qa="nam-instrument-profile"');
    const instrumentSwitchEnd = html.indexOf("</button>", instrumentSwitchStart);
    const instrumentSwitchMarkup =
      instrumentSwitchStart > -1 && instrumentSwitchEnd > instrumentSwitchStart
        ? html.slice(instrumentSwitchStart, instrumentSwitchEnd)
        : "";

    expect(html).toContain('data-param-id="instrumentProfile"');
    expect(html).toContain(
      'aria-label="Guitar instrument profile. Changes component voicing and compatible library filtering without overwriting controls."',
    );
    expect(html).toContain(
      'title="Guitar instrument profile. Click to switch to Bass."',
    );
    expect(instrumentSwitchStart).toBeGreaterThan(-1);
    expect(html).toContain('class="premium-output-instrument-switch"');
    expect(html).toContain(
      'class="premium-output-instrument-switch-toggle-label" data-label="gtr">',
    );
    expect(html).toContain(
      'class="premium-output-instrument-switch-toggle-label" data-label="bass">',
    );
    expect(html).toContain(">G</span>");
    expect(html).toContain(">B</span>");
    expect(html).not.toContain('aria-label="Bass instrument profile. Changes component voicing and compatible library filtering without overwriting controls."');
    expect(html).not.toContain('class="instrument-heading-long"');
    expect(html).not.toContain('class="instrument-label-long"');
    expect(instrumentSwitchMarkup).not.toContain("aria-pressed=");
    expect(html).not.toContain('type="range"');
  });

  it("retains the effective route only as a Doubler audibility diagnostic", () => {
    const enabledParams = headerParams.map((param) =>
      param.id === "cabDoublerEnabled" ? { ...param, value: 1 } : param,
    );
    const html = renderHeaderUtility(
      {
        ...defaultUtilityControls,
        effectiveInputMode: 2,
      },
      enabledParams,
    );

    expect(html).toContain('data-paused="true"');
    expect(html).toContain("Paused");
    expect(html).toContain("paused while the DAW track route is stereo");
    expect(html).not.toContain("Processing is Stereo");
    expect(html).not.toContain("Track Routing");
  });

  it("preserves complete input, gate and output hardware hooks", () => {
    const html = renderHeaderUtility();

    expect(html).toContain('data-qa="nam-input-peak-meter"');
    expect(html).toContain('data-meter-id="input"');
    expect(html).toContain('data-meter-id="input" data-clip="false" data-channel-count="1" data-meter-mode="mono-peak"');
    expect(html).toContain('data-qa="nam-input-control-bay"');
    expect(html).toContain('data-param-id="inputTrimDb"');
    expect(html).toContain('data-param-id="gateThresholdDb"');
    expect(html).toContain('data-qa="nam-output-peak-meter"');
    expect(html).toContain('data-meter-id="output"');
    expect(html).toContain('data-meter-id="output" data-clip="false" data-channel-count="2" data-meter-mode="stereo-peak"');
    expect(html).toContain('data-qa="nam-output-control-bay"');
    expect(html).toContain('data-param-id="outputTrimDb"');
  });

  it("renders one input lane for mono, true L/R input lanes for stereo, and stereo output in both cases", () => {
    const monoHtml = renderHeaderUtility(
      defaultUtilityControls,
      headerParams,
      {
        inputLevelDb: -6,
        outputLevelDb: -3,
        inputLeftLevelDb: -6,
        inputRightLevelDb: -24,
        outputLeftLevelDb: -3,
        outputRightLevelDb: -15,
        inputChannelCount: 1,
      },
    );
    const monoInputStart = monoHtml.indexOf('data-qa="nam-input-peak-meter"');
    const monoInputEnd = monoHtml.indexOf("</div>", monoInputStart);
    const monoInputMarkup = monoHtml.slice(monoInputStart, monoInputEnd);
    const monoOutputStart = monoHtml.indexOf('data-qa="nam-output-peak-meter"');
    const monoOutputEnd = monoHtml.indexOf("</div>", monoOutputStart);
    const monoOutputMarkup = monoHtml.slice(monoOutputStart, monoOutputEnd);

    expect(monoInputMarkup).toContain('data-channel-count="1"');
    expect(monoInputMarkup).toContain('data-meter-channel="mono"');
    expect(monoInputMarkup).not.toContain('data-meter-channel="right"');
    expect(monoInputMarkup).toContain('aria-label="Pre-trim input level: mono peak -6.0 dBFS"');
    expect(monoOutputMarkup).toContain('data-channel-count="2"');
    expect(monoOutputMarkup).toContain('data-meter-channel="left"');
    expect(monoOutputMarkup).toContain('data-meter-channel="right"');
    expect(monoOutputMarkup).toContain('aria-label="Output level: left -3.0 dBFS, right -15.0 dBFS"');

    const stereoHtml = renderHeaderUtility(
      defaultUtilityControls,
      headerParams,
      {
        inputLevelDb: -6,
        outputLevelDb: -3,
        inputLeftLevelDb: -6,
        inputRightLevelDb: -24,
        outputLeftLevelDb: -3,
        outputRightLevelDb: -15,
        inputChannelCount: 2,
      },
    );
    const stereoInputStart = stereoHtml.indexOf('data-qa="nam-input-peak-meter"');
    const stereoInputEnd = stereoHtml.indexOf("</div>", stereoInputStart);
    const stereoInputMarkup = stereoHtml.slice(stereoInputStart, stereoInputEnd);

    expect(stereoInputMarkup).toContain('data-channel-count="2"');
    expect(stereoInputMarkup).toContain('data-meter-channel="left"');
    expect(stereoInputMarkup).toContain('data-meter-channel="right"');
    expect(stereoInputMarkup).toContain('aria-label="Pre-trim input level: left -6.0 dBFS, right -24.0 dBFS"');
  });

  it("renders all responsive header regions for browser geometry coverage", () => {
    const html = renderHeaderUtility();

    expect(html).toContain('data-qa="nam-input-control-bay"');
    expect(html).toContain('class="preset-area ');
    expect(html).toContain('class="preset-console ');
    expect(html).toContain('data-qa="nam-header-utility"');
    expect(html).toContain('data-qa="nam-output-control-bay"');
    expect(html).toContain('class="premium-oversampling-selector"');
    expect(html).toContain('data-qa="nam-oversampling-4x"');
  });
});

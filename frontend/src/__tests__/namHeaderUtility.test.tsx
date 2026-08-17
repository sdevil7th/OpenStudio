import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NAMRackDesignPort,
  type NAMRackDesignUtilityControls,
} from "../components/NAMRackDesignPort";
import designPortSource from "../components/NAMRackDesignPort.tsx?raw";
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
  it("renders exactly the two rack-owned utility cards before the centred preset console", () => {
    const html = renderHeaderUtility();
    const utilityIndex = html.indexOf('data-qa="nam-header-utility"');
    const presetIndex = html.indexOf('class="preset-console"');

    expect(utilityIndex).toBeGreaterThan(-1);
    expect(presetIndex).toBeGreaterThan(utilityIndex);
    expect(
      html.match(/aria-label="Instrument profile selection"/g) ?? [],
    ).toHaveLength(1);
    expect(html).toContain('data-qa="nam-instrument-profile"');
    expect(html).toContain('aria-label="Doubler"');
    expect(html).toContain('data-utility-rotary="mix"');
    expect(html).toContain('data-utility-rotary="spread"');
    expect(html).not.toContain('aria-label="NAM processing mode"');
    expect(html).not.toContain('aria-label="Processing and routed source"');
    expect(html).not.toContain('data-qa="nam-physical-source"');
    expect(html).not.toContain("Open Track Routing");
  });

  it("keeps Instrument semantic, readable and directly bound without duplicating the group", () => {
    const html = renderHeaderUtility();

    expect(html).toContain('data-param-id="instrumentProfile"');
    expect(html).toContain(
      'aria-label="Guitar instrument profile. Changes component voicing, library filtering, and starting points."',
    );
    expect(html).toContain(
      'aria-label="Bass instrument profile. Changes component voicing, library filtering, and starting points."',
    );
    expect(html).toContain(
      'class="instrument-label-long" aria-hidden="true">Guitar</span>',
    );
    expect(html).toContain("Component voicing, library &amp; starting points");
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

  it("removes all route/source presentation logic from the utility component", () => {
    const utilityStart = designPortSource.indexOf(
      "function PremiumHeaderUtility",
    );
    const utilityEnd = designPortSource.indexOf(
      "function BoundDistortionModeDisplay",
      utilityStart,
    );
    const utilityComponent = designPortSource.slice(utilityStart, utilityEnd);

    expect(utilityStart).toBeGreaterThan(-1);
    expect(utilityEnd).toBeGreaterThan(utilityStart);
    expect(utilityComponent).not.toContain('useBoundDesignParam("inputMode")');
    expect(utilityComponent).not.toContain("premium-processing-choice");
    expect(utilityComponent).not.toContain("premium-physical-source");
    expect(utilityComponent).not.toContain("onOpenTrackRouting");
    expect(utilityComponent).not.toContain("physicalSourceLabel");
  });

  it("preserves complete input, gate and output hardware hooks", () => {
    const html = renderHeaderUtility();

    expect(html).toContain('data-qa="nam-input-peak-meter"');
    expect(html).toContain('data-meter-id="input"');
    expect(html).toContain('data-qa="nam-input-control-bay"');
    expect(html).toContain('data-param-id="inputTrimDb"');
    expect(html).toContain('data-param-id="gateThresholdDb"');
    expect(html).toContain('data-qa="nam-output-peak-meter"');
    expect(html).toContain('data-meter-id="output"');
    expect(html).toContain('data-qa="nam-output-control-bay"');
    expect(html).toContain('data-param-id="outputTrimDb"');
  });

  it("uses one bounded content-weighted rail centred independently of the preset", () => {
    const finalStart = designPortSource.indexOf("/* Final header composition.");
    const finalContract = designPortSource.slice(finalStart);

    expect(finalStart).toBeGreaterThan(-1);
    expect(finalContract).toContain("left: 50%;\n  right: auto;");
    expect(finalContract).toContain("width: min(780px, calc(100% - 16px))");
    expect(finalContract).toContain(
      "grid-template-columns: minmax(280px, .82fr) minmax(360px, 1.18fr)",
    );
    expect(finalContract).toContain("transform: translateX(-50%)");
    expect(finalContract).toContain(
      ".premium-brand {\n  left: 50% !important;\n  right: auto !important;",
    );
    expect(finalContract).not.toContain("--premium-header-setup-width");
    expect(finalContract).not.toContain(
      "left: calc(100% + var(--premium-header-setup-gap))",
    );
    expect(designPortSource).not.toContain(
      "minmax(0, 1fr) minmax(0, 1.42fr) minmax(0, 1fr)",
    );
    expect(designPortSource).toContain("left: 50% !important");
    expect(designPortSource).toContain("width: clamp(900px, 54vw, 1040px)");
  });

  it("does not hide complete edge hardware in an earlier responsive rule and restore it later", () => {
    const compressionStart = designPortSource.indexOf(
      "/* Header utility compression",
    );
    const responsiveStart = designPortSource.indexOf(
      "/* Responsive header contract.",
      compressionStart,
    );
    const transitionCss = designPortSource.slice(
      compressionStart,
      responsiveStart,
    );

    expect(compressionStart).toBeGreaterThan(-1);
    expect(responsiveStart).toBeGreaterThan(compressionStart);
    expect(transitionCss).not.toMatch(
      /\.global-block\.right\s*\{[^}]*display:\s*none/,
    );
    expect(transitionCss).not.toMatch(
      /\.premium-level-meter\s*\{[^}]*display:\s*none/,
    );
    expect(transitionCss).not.toMatch(
      /\.mini-param:nth-of-type\(n\+2\)\s*\{[^}]*display:\s*none/,
    );
    expect(transitionCss).not.toContain("left: 144px");
  });

  it.each([920, 1024, 1264, 1280, 1366, 1536, 1919, 1920, 2560])(
    "keeps the content-weighted utility cards centred and readable at %ipx",
    (viewportWidth) => {
      const presetWidth =
        viewportWidth <= 1030
          ? viewportWidth - 24
          : viewportWidth >= 1680
            ? Math.min(1200, Math.max(1040, viewportWidth * 0.62))
            : 1040;
      const utilityWidth = Math.min(780, presetWidth - 16);
      const maximumGap = viewportWidth <= 1400 ? 12 : 14;
      const gap =
        viewportWidth <= 1030
          ? 7
          : Math.min(maximumGap, Math.max(8, viewportWidth * 0.01));
      const availableWidth = utilityWidth - gap;
      const instrumentWidth = (availableWidth * 0.82) / 2;
      const doublerWidth = (availableWidth * 1.18) / 2;
      const utilityLeft = (viewportWidth - utilityWidth) / 2;

      expect(utilityLeft + utilityWidth / 2).toBeCloseTo(viewportWidth / 2, 5);
      expect(instrumentWidth).toBeGreaterThanOrEqual(310);
      expect(doublerWidth).toBeGreaterThanOrEqual(450);
      expect(doublerWidth / instrumentWidth).toBeCloseTo(1.18 / 0.82, 5);
      expect(utilityLeft).toBeGreaterThanOrEqual(12);
      expect(utilityLeft + utilityWidth).toBeLessThanOrEqual(
        viewportWidth - 12,
      );
    },
  );

  it("keeps compact identity and complete edge bays in a separate top lane", () => {
    const responsiveStart = designPortSource.indexOf(
      "/* Responsive header contract.",
    );
    const responsiveContract = designPortSource.slice(responsiveStart);

    expect(responsiveContract).toContain(
      ".premium-brand {\n    left: 50% !important",
    );
    expect(responsiveContract).toContain("transform: translateX(-50%)");
    expect(responsiveContract).toContain(
      ".global-block.left {\n    left: 10px !important",
    );
    expect(responsiveContract).toContain(
      ".global-block.right {\n    right: 10px !important",
    );
    expect(responsiveContract).toContain("display: grid !important");
    expect(responsiveContract).toContain("width: 21px;\n    height: 50px");
  });

  it("uses full-height medium/wide hardware bays without the old negative offset", () => {
    const finalStart = designPortSource.indexOf("/* Final header composition.");
    const finalContract = designPortSource.slice(finalStart);
    const responsiveStart = designPortSource.indexOf(
      "/* Responsive header contract.",
    );
    const responsiveContract = designPortSource.slice(
      responsiveStart,
      finalStart,
    );

    expect(responsiveContract).toContain("height: 149px");
    expect(responsiveContract).toContain(
      "height: clamp(136px, calc(6.667vw + 50.67px), 144px)",
    );
    expect(responsiveContract).toContain(
      "height: clamp(144px, calc(2.143vw + 114px), 150px)",
    );
    expect(finalContract).toContain(
      ".global-block.left { left: -17px !important; }",
    );
    expect(finalContract).toContain(
      "pulled through the strip's 25px content inset",
    );
  });

  it("aligns CAL over the Output bay instead of an obsolete setup column", () => {
    const html = renderHeaderUtility();
    const brandStart = html.indexOf('class="premium-brand"');
    const brandEnd = html.indexOf("</div>", brandStart);
    const calibrationStart = html.indexOf('data-qa="nam-premium-calibration"');
    const finalStart = designPortSource.indexOf("/* Final header composition.");
    const finalContract = designPortSource.slice(finalStart);

    expect(calibrationStart).toBeGreaterThan(brandEnd);
    expect(finalContract).toContain("right: 10px !important");
    expect(finalContract).toContain("top: 14px !important");
    expect(finalContract).toContain("clamp(18px, calc(5vw - 46px), 24px)");
    expect(finalContract).toContain(
      "clamp(36px, calc(6.667vw - 49.33px), 44px)",
    );
    expect(finalContract).toContain("clamp(24px, calc(2.5vw - 11px), 31px)");
    expect(finalContract).toContain("clamp(44px, calc(4.286vw - 16px), 56px)");
    expect(finalContract).toContain("width: 134px");
    expect(finalContract).not.toContain("top: 168px !important");
  });

  it("keeps the preset title centred independently from its asymmetric actions", () => {
    expect(designPortSource).toContain(
      "--preset-action-rail-width: calc(var(--preset-next-width) + var(--preset-save-width) + var(--preset-compare-width))",
    );
    expect(designPortSource).toContain(
      "padding: 0 calc(var(--preset-action-rail-width) + 18px)",
    );
    expect(designPortSource).not.toContain("left: 136px");
    expect(designPortSource).not.toContain("right: 136px");
  });
});

// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  NAM_AMP_FACEPLATE_LAYOUT,
  NAM_COMPRESSOR_FACEPLATE_LAYOUT,
  NAM_EQ_BOOST_FACEPLATE_LAYOUT,
  NAM_PRECISION_DRIVE_FACEPLATE_LAYOUT,
  NAM_PRE_LOGICAL_SURFACE,
  NAM_PRE_SIGNAL_LAYOUT,
} from "../components/NAMRackDesignPort";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("NAM fixed-capture amp and separate EQ Boost / Drive faceplates", () => {
  it("fits every existing amp wrapper parameter on the approved single control deck", () => {
    const layout = NAM_AMP_FACEPLATE_LAYOUT;
    const moduleWidth = 720;
    const moduleHeight = 345;
    const centres = [
      layout.powerX,
      layout.inputX,
      layout.boostX,
      layout.voiceX,
      layout.bassX,
      layout.midX,
      layout.trebleX,
      layout.presenceX,
      layout.mixX,
      layout.outputX,
    ].map((x) => x * moduleWidth / 100);

    const expectedCentres = [75, 120, 173.333333, 225, 291.666667, 360, 428.333333, 496.666667, 565, 633.333333];
    centres.forEach((centre, index) => {
      expect(centre).toBeCloseTo(expectedCentres[index], 4);
    });
    expect(layout.controlY * moduleHeight / 100).toBeCloseTo(745 / 3, 5);
    expect(layout.labelY * moduleHeight / 100).toBeCloseTo(634 / 3, 5);
    expect(layout.knobSize * moduleWidth / 100).toBeCloseTo(36, 8);
    expect(layout.knobHitSize * moduleWidth / 100).toBeCloseTo(44, 8);
    expect(layout.toggleSize * moduleWidth / 100).toBeCloseTo(22, 8);
    expect(layout.toggleHitSize * moduleWidth / 100).toBeCloseTo(30, 8);
    expect(layout.ledY * moduleHeight / 100).toBeCloseTo(683 / 3, 5);
    expect(layout.ledSize * moduleWidth / 100).toBeCloseTo(12, 8);
    expect(centres[0] - 15).toBeGreaterThanOrEqual(40);
    expect(centres[centres.length - 1] + 22).toBeLessThanOrEqual(680);

    const source = readSource("../components/NAMRackDesignPort.tsx");
    const ampStage = source.slice(
      source.indexOf("function AmpStage("),
      source.indexOf("function CabSourceSelector("),
    );
    for (const paramId of [
      "ampEnabled",
      "ampBoost",
      "ampVoice",
      "ampGainDb",
      "ampMix",
      "ampOutputDb",
      "bassDb",
      "midDb",
      "trebleDb",
      "presenceDb",
    ]) {
      expect(ampStage).toContain(`\"${paramId}\"`);
    }
    expect(ampStage).toContain("amp-head-v5");
    expect(ampStage).toContain("CONTROLS.knobBlackPanel");
    expect(ampStage).toContain("CONTROLS.ledOnPanel");
    expect(ampStage).not.toContain("amp-gain-label-overlay");
    expect(ampStage).not.toContain("amp-row-divider");
    expect(ampStage).toContain('label: "BASS"');
    expect(ampStage).toContain('label: "MID"');
    expect(ampStage).toContain('label: "TREBLE"');
    expect(ampStage).toContain('label: "PRESENCE"');
    expect(ampStage).toContain('label: "GAIN"');
    expect(ampStage).not.toMatch(/label:\s*"(?:POST|MASTER)/);

    const namingSurfaces = [
      readSource("../services/NativeBridge.ts"),
      readSource("../components/NAMRackPanel.tsx"),
      readSource("../../../Source/AudioEngine.cpp"),
    ];
    for (const sourceSurface of namingSurfaces) {
      expect(sourceSurface).not.toMatch(/Post (?:Bass|Mid|Treble|Presence)/);
    }
    expect(namingSurfaces[0]).toContain('param("bassDb", "Bass"');
    expect(namingSurfaces[0]).toContain('param("midDb", "Mid"');
    expect(namingSurfaces[0]).toContain('param("trebleDb", "Treble"');
    expect(namingSurfaces[0]).toContain('param("presenceDb", "Presence"');
  });

  it("keeps EQ Boost and Precision Drive separate inside one scrollbar-free row", () => {
    const box = NAM_PRE_SIGNAL_LAYOUT.precisionDrive;
    const layout = NAM_PRECISION_DRIVE_FACEPLATE_LAYOUT;
    const xPx = (percentage: number) => percentage * box.w / 100;
    const yPx = (percentage: number) => percentage * box.h / 100;

    expect(box).toMatchObject({ w: 120, h: 232 });
    expect(NAM_PRE_SIGNAL_LAYOUT.eqBoost).toMatchObject({ w: 156, h: 232 });
    expect(NAM_PRE_SIGNAL_LAYOUT.eqBoost.x + NAM_PRE_SIGNAL_LAYOUT.eqBoost.w)
      .toBeLessThanOrEqual(box.x);
    expect(NAM_PRE_SIGNAL_LAYOUT.distortion.x + NAM_PRE_SIGNAL_LAYOUT.distortion.w)
      .toBe(NAM_PRE_LOGICAL_SURFACE.row.x + NAM_PRE_LOGICAL_SURFACE.row.w);
    expect(NAM_PRE_LOGICAL_SURFACE.scaleReference).toEqual(NAM_PRE_LOGICAL_SURFACE.row);
    expect(xPx(layout.gate.x)).toBeCloseTo(60, 8);
    expect(yPx(layout.gate.y)).toBeCloseTo(76.56, 8);
    expect(xPx(layout.gate.size)).toBeCloseTo(18, 8);
    expect(xPx(layout.gate.hitSize)).toBeCloseTo(20, 8);
    expect(NAM_EQ_BOOST_FACEPLATE_LAYOUT.bandYs).toHaveLength(8);
    expect(NAM_EQ_BOOST_FACEPLATE_LAYOUT.title.y).toBe(
      NAM_COMPRESSOR_FACEPLATE_LAYOUT.titleY,
    );
    expect(NAM_EQ_BOOST_FACEPLATE_LAYOUT.title.x).toBe(50);
    expect(NAM_EQ_BOOST_FACEPLATE_LAYOUT.led.x).toBe(50);
    expect(NAM_EQ_BOOST_FACEPLATE_LAYOUT.foot.x).toBe(50);
    expect(NAM_EQ_BOOST_FACEPLATE_LAYOUT.stateLabelY).toBe(82);

    // The wider fader consumes the former left-side void while preserving the
    // old painted right boundary. Frequency copy still terminates three
    // logical pixels before the rail, and the complete hit target remains
    // clear of the filter controls.
    const eqBoostWidth = NAM_PRE_SIGNAL_LAYOUT.eqBoost.w;
    const eqBoostXPx = (percentage: number) => percentage * eqBoostWidth / 100;
    const faderLeftPx = eqBoostXPx(NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderX)
      - eqBoostXPx(NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderWidth) / 2;
    const faderRightPx = eqBoostXPx(NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderX)
      + eqBoostXPx(NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderWidth) / 2;
    const faderWidthPx = faderRightPx - faderLeftPx;
    const trackLeftPx = faderLeftPx
      + faderWidthPx
        * NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderTrackInsetPercent / 100;
    const trackRightPx = faderRightPx
      - faderWidthPx
        * NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderTrackInsetPercent / 100;
    const capTravelLeftPx = faderLeftPx
      + faderWidthPx
        * NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderCapMinPercent / 100;
    const capTravelRightPx = capTravelLeftPx
      + faderWidthPx
        * NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderCapTravelPercent / 100;
    const labelRightPx = NAM_EQ_BOOST_FACEPLATE_LAYOUT.bandLabelX
      * eqBoostWidth / 100;
    const filterHitLeftPx = eqBoostXPx(NAM_EQ_BOOST_FACEPLATE_LAYOUT.hpf.x)
      - eqBoostXPx(NAM_EQ_BOOST_FACEPLATE_LAYOUT.filterHitSize) / 2;

    expect(eqBoostXPx(NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderX)).toBeCloseTo(64, 8);
    expect(faderWidthPx).toBeCloseTo(72, 8);
    expect(faderLeftPx).toBeCloseTo(28, 8);
    expect(faderRightPx).toBeCloseTo(100, 8);
    expect(trackLeftPx).toBeCloseTo(32.965517, 5);
    expect(trackRightPx).toBeCloseTo(95.034483, 5);
    expect(trackRightPx - trackLeftPx).toBeGreaterThan(50 * 1.2);
    expect(capTravelLeftPx).toBeCloseTo(39, 5);
    expect(capTravelRightPx).toBeCloseTo(89, 5);
    expect(capTravelRightPx - capTravelLeftPx).toBeGreaterThan(44 * 1.1);
    expect(trackLeftPx - labelRightPx).toBeCloseTo(2.965517, 5);
    expect(filterHitLeftPx - faderRightPx).toBeCloseTo(10, 8);
    expect(filterHitLeftPx - trackRightPx).toBeGreaterThan(14);
    const rotatedCapWidthPx = 15;
    expect(capTravelLeftPx - rotatedCapWidthPx / 2 - labelRightPx)
      .toBeCloseTo(1.5, 5);
    expect(filterHitLeftPx - (capTravelRightPx + rotatedCapWidthPx / 2))
      .toBeCloseTo(13.5, 5);

    const designCss = readSource("../components/NAMRackDesignPort.css");
    const bandLabelRule = designCss.match(
      /\.combined-pre-eq-band-label\s*\{(?<body>[\s\S]*?)\}/,
    )?.groups?.body;
    expect(bandLabelRule).toContain("transform: translate(-100%, -50%)");
    expect(bandLabelRule).toContain("text-align: right");
    const lastBandY = NAM_EQ_BOOST_FACEPLATE_LAYOUT.bandYs[
      NAM_EQ_BOOST_FACEPLATE_LAYOUT.bandYs.length - 1
    ] ?? 0;
    expect(
      (NAM_EQ_BOOST_FACEPLATE_LAYOUT.title.y - lastBandY) *
        NAM_PRE_SIGNAL_LAYOUT.eqBoost.h / 100 -
        NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderHeight *
          NAM_PRE_SIGNAL_LAYOUT.eqBoost.h / 200,
    ).toBeGreaterThanOrEqual(10);

    const source = readSource("../components/NAMRackDesignPort.tsx");
    const profileSource = readSource("../utils/namInstrumentProfile.ts");
    const eqStart = source.indexOf("box={NAM_PRE_SIGNAL_LAYOUT.eqBoost}");
    const driveStart = source.indexOf("box={NAM_PRE_SIGNAL_LAYOUT.precisionDrive}");
    const driveEnd = source.indexOf("box={NAM_PRE_SIGNAL_LAYOUT.distortion}");
    const eqStage = source.slice(eqStart, driveStart);
    const driveStage = source.slice(driveStart, driveEnd);
    expect(eqStage).toContain('name="eq-boost"');
    expect(eqStage).toContain('title="EQ BOOST"');
    expect(driveStage).toContain('name="precision-drive"');
    expect(driveStage).toContain('title="PRECISION DRIVE"');
    expect(driveStage).not.toContain("precisionDriveVoice");
    expect(driveStage).not.toContain("OD808");
    expect(driveStage).toContain('paramId="precisionDriveGate"');
    expect(driveStage).toContain('paramId="precisionDriveEnabled"');
    expect(driveStage.match(/paramId="precisionDriveEnabled"/g)).toHaveLength(2);
    expect(eqStage).toContain("paramId={band.paramId}");
    for (const paramId of [
      "preEq120Db",
      "preEq250Db",
      "preEq500Db",
      "preEq1kDb",
      "preEq2k5Db",
      "preEq5kDb",
      "preEq8kDb",
      "preEq12kDb",
    ]) {
      expect(profileSource).toContain(`"${paramId}"`);
    }
    for (const paramId of [
      "preEqEnabled",
      "preEqHPFHz",
      "preEqLPFHz",
    ]) {
      expect(eqStage).toContain(`paramId="${paramId}"`);
    }
  });

  it("keeps registry and scene anchors separated and retires the rejected voice selector", () => {
    const registry = readSource("../components/NAMRackNeuralSkinRegistry.ts");
    const driveScene = JSON.parse(
      readSource("../components/namScenes/pre-precision-drive.scene.json"),
    ) as { controls: Array<{ paramId?: string; kind: string }> };
    const eqScene = JSON.parse(
      readSource("../components/namScenes/pre-eq-boost.scene.json"),
    ) as { controls: Array<{
      paramId?: string;
      kind: string;
      x?: number;
      width?: number;
    }> };
    const ampScene = JSON.parse(
      readSource("../components/namScenes/amp-head.scene.json"),
    ) as { controls: Array<{ id?: string; paramId?: string; label?: string }> };

    expect(registry).not.toContain('paramId: "precisionDriveVoice"');
    expect(driveScene.controls.some(({ paramId }) => paramId?.startsWith("preEq"))).toBe(false);
    expect(eqScene.controls.some(({ paramId }) => paramId?.startsWith("precisionDrive"))).toBe(false);
    const eqFaders = eqScene.controls.filter(({ kind }) => kind === "fader");
    expect(eqFaders).toHaveLength(8);
    for (const fader of eqFaders) {
      expect(fader).toMatchObject({ x: 64, width: 72 });
    }
    expect(registry.match(
      /kind: "fader", orientation: "horizontal", x: 0\.410256, y: [\d.]+, width: 0\.461538/g,
    )).toHaveLength(8);
    for (const paramId of [
      "ampEnabled",
      "ampBoost",
      "ampVoice",
      "ampGainDb",
      "ampMix",
      "ampOutputDb",
      "bassDb",
      "midDb",
      "trebleDb",
      "presenceDb",
    ]) {
      expect(ampScene.controls.some((control) => control.paramId === paramId)).toBe(true);
    }
    expect(ampScene.controls.some((control) => control.label === "Master")).toBe(false);
    expect(ampScene.controls).toContainEqual(expect.objectContaining({
      paramId: "ampGainDb",
      label: "GAIN",
    }));
    expect(
      ampScene.controls.filter((control) => control.id?.endsWith("-led")),
    ).toEqual([
      expect.objectContaining({ id: "amp-power-led", paramId: "ampEnabled" }),
      expect.objectContaining({ id: "amp-boost-led", paramId: "ampBoost" }),
      expect.objectContaining({ id: "amp-voice-led", paramId: "ampVoice" }),
    ]);
  });
});

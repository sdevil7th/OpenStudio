import { describe, expect, it } from "vitest";

import {
  createAmpV4FaceplateManifest,
  faceplateControlHitRect,
  faceplateControlVisualRect,
  fitIntrinsicCanvas,
  NAM_AMP_V4_FACEPLATE,
  NAM_AMP_V4_GENERATION_SIZE,
  NAM_AMP_V4_REFERENCE_ALPHA,
  NAM_AMP_V4_REFERENCE_SIZE,
  NAM_EQ_V4_FACEPLATE,
  NAM_EQ_V4_FADER_CAP_CROP,
  NAM_EQ_V4_FADER_CENTERS,
  projectFaceplateManifest,
  rectContainsRect,
  scaleRectBetweenCanvases,
  validateFaceplateManifest,
  type FaceplateManifest,
  type IntrinsicRect,
} from "../components/namRackFaceplateGeometry";

const sorted = (values: Iterable<string>) => [...values].sort();

const AMP_PARAMS = [
  "ampEnabled",
  "ampGainDb",
  "ampBoost",
  "ampVoice",
  "bassDb",
  "midDb",
  "trebleDb",
  "presenceDb",
  "ampMix",
  "ampOutputDb",
] as const;

const EQ_PARAMS = [
  "eqEnabled",
  "eqHPFHz",
  "eq65Db",
  "eq125Db",
  "eq250Db",
  "eq500Db",
  "eq1kDb",
  "eq2kDb",
  "eq4kDb",
  "eq8kDb",
  "eq16kDb",
  "eqLPFHz",
  "eqLevelDb",
] as const;

const uniqueParamIds = (manifest: FaceplateManifest) =>
  sorted(new Set(manifest.controls.map(({ paramId }) => paramId)));

describe("NAM Rack intrinsic faceplate geometry", () => {
  it("keeps every visible and interactive footprint inside painted alpha", () => {
    for (const manifest of [NAM_AMP_V4_FACEPLATE, NAM_EQ_V4_FACEPLATE]) {
      expect(validateFaceplateManifest(manifest)).toEqual([]);
      for (const control of manifest.controls) {
        expect(
          rectContainsRect(
            manifest.visibleAlphaBounds,
            faceplateControlVisualRect(control),
          ),
          `${manifest.id}:${control.id}:visual`,
        ).toBe(true);
        expect(
          rectContainsRect(
            manifest.visibleAlphaBounds,
            faceplateControlHitRect(control),
          ),
          `${manifest.id}:${control.id}:hit`,
        ).toBe(true);
      }
    }
  });

  it("preserves all public Amp and Graphic EQ parameters", () => {
    expect(uniqueParamIds(NAM_AMP_V4_FACEPLATE)).toEqual(sorted(AMP_PARAMS));
    expect(uniqueParamIds(NAM_EQ_V4_FACEPLATE)).toEqual(sorted(EQ_PARAMS));
    expect(
      NAM_EQ_V4_FACEPLATE.controls.filter(({ paramId }) => paramId === "eqEnabled"),
    ).toHaveLength(2);
    for (const [toggleId, ledId, paramId] of [
      ["amp-power", "amp-power-led", "ampEnabled"],
      ["amp-tight", "amp-tight-led", "ampBoost"],
      ["amp-bright", "amp-bright-led", "ampVoice"],
    ] as const) {
      const toggle = NAM_AMP_V4_FACEPLATE.controls.find(({ id }) => id === toggleId);
      const led = NAM_AMP_V4_FACEPLATE.controls.find(({ id }) => id === ledId);
      expect(toggle).toMatchObject({ kind: "toggle", paramId });
      expect(led).toMatchObject({ kind: "led", paramId });
      if (toggle?.kind === "toggle" && led?.kind === "led") {
        expect(led.center.x).toBeCloseTo(toggle.center.x, 8);
        expect(led.center.y + led.visualDiameter / 2)
          .toBeLessThan(toggle.center.y - toggle.visualDiameter / 2);
      }
      expect(
        NAM_AMP_V4_FACEPLATE.controls.filter((control) => control.paramId === paramId),
      ).toHaveLength(2);
    }
  });

  it("maps the Amp template to the 1811 x 868 generation body without frozen old-asset pixels", () => {
    const generatedAlpha = scaleRectBetweenCanvases(
      NAM_AMP_V4_REFERENCE_ALPHA,
      NAM_AMP_V4_REFERENCE_SIZE,
      NAM_AMP_V4_GENERATION_SIZE,
    );
    const generationManifest = createAmpV4FaceplateManifest({
      assetSize: NAM_AMP_V4_GENERATION_SIZE,
      visibleAlphaBounds: generatedAlpha,
    });

    expect(generationManifest.assetSize).toEqual({ width: 1811, height: 868 });
    expect(validateFaceplateManifest(generationManifest)).toEqual([]);
    generationManifest.controls.forEach((control, index) => {
      const reference = NAM_AMP_V4_FACEPLATE.controls[index];
      expect(faceplateControlVisualRect(control).width).toBeCloseTo(
        faceplateControlVisualRect(reference).width * 1811 / 2160,
        6,
      );
      if (control.kind !== "fader" && reference.kind !== "fader") {
        expect(control.center.x / 1811).toBeCloseTo(reference.center.x / 2160, 3);
        expect(control.center.y / 868).toBeCloseTo(reference.center.y / 1035, 3);
      }
    });
  });

  it("defines evenly spaced baked EQ wells and a truly cropped cap", () => {
    const faders = NAM_EQ_V4_FACEPLATE.controls.filter(
      (control) => control.kind === "fader",
    );
    expect(faders).toHaveLength(9);
    expect(faders.map(({ centerX }) => centerX)).toEqual(NAM_EQ_V4_FADER_CENTERS);

    const gaps = NAM_EQ_V4_FADER_CENTERS.slice(1).map(
      (center, index) => center - NAM_EQ_V4_FADER_CENTERS[index],
    );
    gaps.forEach((gap) => expect(gap).toBeCloseTo(141.25, 8));
    faders.forEach((fader) => {
      expect(fader.bakedWell).toMatchObject({ y: 128, width: 30, height: 292 });
      expect(fader.capTravel).toEqual({ top: 144, bottom: 404 });
      expect(fader.capSize).toEqual({ width: 54, height: 28 });
      expect(fader.hitRect).toMatchObject({ y: 112, width: 112, height: 328 });
      expect(fader.bakedWell.height / 200).toBeGreaterThan(1.4);
      expect((fader.capTravel.bottom - fader.capTravel.top) / 168).toBeGreaterThan(1.5);
    });

    expect(NAM_EQ_V4_FADER_CAP_CROP.measuredAlphaBounds).toEqual({
      x: 50,
      y: 147,
      width: 411,
      height: 214,
    });
    expect(NAM_EQ_V4_FADER_CAP_CROP.paddedCrop).toEqual({
      x: 42,
      y: 139,
      width: 427,
      height: 230,
    });
    expect(
      rectContainsRect(
        NAM_EQ_V4_FADER_CAP_CROP.paddedCrop,
        NAM_EQ_V4_FADER_CAP_CROP.measuredAlphaBounds,
      ),
    ).toBe(true);
  });

  it("keeps the V6 lower-deck controls on their approved simplified geometry", () => {
    expect(NAM_EQ_V4_FACEPLATE.safeZones.mainControls).toEqual({
      x: 156,
      y: 110,
      width: 1848,
      height: 340,
    });
    expect(NAM_EQ_V4_FACEPLATE.safeZones.utilityControls).toEqual({
      x: 156,
      y: 460,
      width: 1848,
      height: 156,
    });
    expect(NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-hpf"))
      .toMatchObject({ center: { x: 290, y: 274 } });
    expect(NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-lpf"))
      .toMatchObject({ center: { x: 1870, y: 274 } });
    expect(NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-power"))
      .toMatchObject({ center: { x: 290, y: 525 } });
    expect(NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-led"))
      .toMatchObject({ center: { x: 400, y: 525 } });
    expect(NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-level"))
      .toMatchObject({
        center: { x: 1870, y: 525 },
        visualDiameter: 90,
        hitDiameter: 116,
      });
  });

  it("projects the same alpha-safe geometry at every supported host shape", () => {
    const viewports: IntrinsicRect[] = [
      { x: 0, y: 0, width: 768, height: 341 },
      { x: 0, y: 0, width: 960, height: 540 },
      { x: 0, y: 0, width: 1280, height: 720 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 17, y: 31, width: 2560, height: 1080 },
    ];

    for (const manifest of [NAM_AMP_V4_FACEPLATE, NAM_EQ_V4_FACEPLATE]) {
      for (const viewport of viewports) {
        const canvas = fitIntrinsicCanvas(viewport, manifest.assetSize);
        const projected = projectFaceplateManifest(manifest, canvas);
        expect(rectContainsRect(canvas, projected.visibleAlpha)).toBe(true);
        for (const visual of Object.values(projected.controlVisuals)) {
          expect(rectContainsRect(projected.visibleAlpha, visual)).toBe(true);
        }
        for (const hit of Object.values(projected.controlHits)) {
          expect(rectContainsRect(projected.visibleAlpha, hit)).toBe(true);
        }
      }
    }
  });
});

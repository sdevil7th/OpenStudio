// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this asset audit in Node.
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  NAM_EQ_V4_FACEPLATE,
  NAM_EQ_V4_VISIBLE_ALPHA,
} from "../components/namRackFaceplateGeometry";

type PixelBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const findPixelBounds = (
  data: Uint8Array,
  width: number,
  channels: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
  matches: (red: number, green: number, blue: number) => boolean,
): PixelBounds => {
  let left = xEnd;
  let right = -1;
  let top = yEnd;
  let bottom = -1;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const offset = (y * width + x) * channels;
      if (matches(data[offset], data[offset + 1], data[offset + 2])) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  expect(right).toBeGreaterThan(left);
  expect(bottom).toBeGreaterThan(top);
  return { left, right, top, bottom };
};

const countMatchingPixels = (
  data: Uint8Array,
  width: number,
  channels: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
  matches: (red: number, green: number, blue: number) => boolean,
) => {
  let count = 0;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const offset = (y * width + x) * channels;
      if (matches(data[offset], data[offset + 1], data[offset + 2])) {
        count += 1;
      }
    }
  }
  return count;
};

describe("NAM Graphic EQ V6 baked geometry", () => {
  it("matches the measured nonzero-alpha chassis frame", async () => {
    const asset = readFileSync(
      new URL("../assets/nam/design/bodies/graphic-eq-body-v6.webp", import.meta.url),
    );
    const { data, info } = await sharp(asset)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = info.width;
    let right = -1;
    let top = info.height;
    let bottom = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const alpha = data[(y * info.width + x) * info.channels + 3];
        if (alpha > 0) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }

    expect({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 })
      .toEqual(NAM_EQ_V4_VISIBLE_ALPHA);
  });

  it("leaves the reclaimed header field free of title and subtitle glyphs", async () => {
    const asset = readFileSync(
      new URL("../assets/nam/design/bodies/graphic-eq-body-v6.webp", import.meta.url),
    );
    const { data, info } = await sharp(asset)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const formerHeadingPixels = countMatchingPixels(
      data,
      info.width,
      info.channels,
      650,
      1510,
      120,
      166,
      (red, green, blue) => red > 175 && green > 173 && blue > 165
        && Math.max(red, green, blue) - Math.min(red, green, blue) < 28,
    );
    const formerSubtitlePixels = countMatchingPixels(
      data,
      info.width,
      info.channels,
      700,
      1460,
      166,
      194,
      (red, green, blue) => red > 115 && green > 75 && green < red
        && blue < green * 0.78,
    );

    expect(formerHeadingPixels).toBe(0);
    expect(formerSubtitlePixels).toBe(0);
  });

  it("keeps every frequency legend between the expanded wells and chassis seam", async () => {
    const asset = readFileSync(
      new URL("../assets/nam/design/bodies/graphic-eq-body-v6.webp", import.meta.url),
    );
    const { data, info } = await sharp(asset)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const neutralLegendPixel = (red: number, green: number, blue: number) =>
      red > 195 && green > 190 && blue > 180
      && Math.max(red, green, blue) - Math.min(red, green, blue) < 35;

    for (const center of [515, 656.25, 797.5, 938.75, 1080, 1221.25, 1362.5, 1503.75, 1645]) {
      const legend = findPixelBounds(
        data,
        info.width,
        info.channels,
        Math.floor(center - 35),
        Math.ceil(center + 35),
        423,
        450,
        neutralLegendPixel,
      );
      // The expanded well still ends at row 420 (its stroke at about 423), while
      // the original chassis seam begins at row 450. Keep each glyph visibly
      // clear of both instead of merely placing its baseline in the right region.
      expect(legend.top).toBeGreaterThanOrEqual(426);
      expect(legend.bottom).toBeLessThanOrEqual(443);
      expect(legend.right - legend.left).toBeGreaterThanOrEqual(11);
      expect(Math.abs((legend.left + legend.right) / 2 - center)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the simplified lower deck clear and gives LEVEL breathing room", async () => {
    const asset = readFileSync(
      new URL("../assets/nam/design/bodies/graphic-eq-body-v6.webp", import.meta.url),
    );
    const { data, info } = await sharp(asset)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const neutralLegendPixel = (red: number, green: number, blue: number) =>
      red > 155 && green > 150 && blue > 140
      && Math.max(red, green, blue) - Math.min(red, green, blue) < 35;
    const power = findPixelBounds(
      data, info.width, info.channels, 210, 350, 570, 620, neutralLegendPixel,
    );
    const level = findPixelBounds(
      data, info.width, info.channels, 1790, 1950, 570, 625, neutralLegendPixel,
    );
    const formerActivePixels = countMatchingPixels(
      data, info.width, info.channels, 365, 530, 570, 620, neutralLegendPixel,
    );
    const formerCenterLevelPixels = countMatchingPixels(
      data, info.width, info.channels, 1000, 1160, 570, 625, neutralLegendPixel,
    );
    const formerGoldDividerPixels = countMatchingPixels(
      data,
      info.width,
      info.channels,
      150,
      2010,
      486,
      499,
      (red, green, blue) => red > 115 && green > 70 && green < red
        && blue < green * 0.82,
    );
    const levelControl = NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-level");
    const statusLed = NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-led");
    const powerControl = NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-power");

    expect(Math.abs((power.left + power.right) / 2 - 290)).toBeLessThanOrEqual(1);
    expect(Math.abs((level.left + level.right) / 2 - 1870)).toBeLessThanOrEqual(1);
    expect(formerActivePixels).toBe(0);
    expect(formerCenterLevelPixels).toBe(0);
    expect(formerGoldDividerPixels).toBeLessThan(25);
    expect(levelControl).toMatchObject({
      kind: "knob",
      center: { x: 1870, y: 525 },
      visualDiameter: 90,
    });
    expect(statusLed).toMatchObject({
      kind: "led",
      center: { x: 400, y: 525 },
    });
    expect(powerControl).toMatchObject({
      kind: "toggle",
      center: { x: 290, y: 525 },
      visualDiameter: 66,
    });
    if (levelControl?.kind === "knob") {
      expect(level.top - (levelControl.center.y + levelControl.visualDiameter / 2))
        .toBeGreaterThanOrEqual(18);
    }
    if (powerControl?.kind === "toggle") {
      expect(power.top - (powerControl.center.y + powerControl.visualDiameter / 2))
        .toBeGreaterThanOrEqual(30);
    }
  });

  it("aligns +12, 0, and −12 to the expanded fader ladder", async () => {
    const asset = readFileSync(
      new URL("../assets/nam/design/bodies/graphic-eq-body-v6.webp", import.meta.url),
    );
    const { data, info } = await sharp(asset)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rangePixel = (red: number, green: number, blue: number) =>
      red > 80 && green > 78 && blue > 70
      && Math.max(red, green, blue) - Math.min(red, green, blue) < 30;
    const top = findPixelBounds(
      data, info.width, info.channels, 430, 475, 136, 165, rangePixel,
    );
    const center = findPixelBounds(
      data, info.width, info.channels, 440, 465, 255, 295, rangePixel,
    );
    const bottom = findPixelBounds(
      data, info.width, info.channels, 420, 480, 390, 430, rangePixel,
    );
    const verticalCenter = (bounds: PixelBounds) => (bounds.top + bounds.bottom) / 2;
    const measuredCenters = [top, center, bottom].map(verticalCenter);
    const firstFader = NAM_EQ_V4_FACEPLATE.controls.find((control) => control.kind === "fader");
    const hpf = NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-hpf");
    const lpf = NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-lpf");

    expect(firstFader?.kind).toBe("fader");
    if (firstFader?.kind === "fader") {
      const expectedCenters = [
        firstFader.capTravel.top,
        (firstFader.capTravel.top + firstFader.capTravel.bottom) / 2,
        firstFader.capTravel.bottom,
      ];
      expect(expectedCenters).toEqual([144, 274, 404]);
      measuredCenters.forEach((measured, index) => {
        expect(Math.abs(measured - expectedCenters[index])).toBeLessThanOrEqual(1);
      });
      expect(hpf).toMatchObject({ center: { y: expectedCenters[1] } });
      expect(lpf).toMatchObject({ center: { y: expectedCenters[1] } });
    }
    expect(bottom.bottom).toBeLessThan(418);
  });

  it("keeps both gold brackets clear of the filter knobs and expanded fader bank", async () => {
    const asset = readFileSync(
      new URL("../assets/nam/design/bodies/graphic-eq-body-v6.webp", import.meta.url),
    );
    const { data, info } = await sharp(asset)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const goldPixel = (red: number, green: number, blue: number) =>
      red > 115 && green > 70 && green < red && blue < green * 0.82;
    const leftBracket = findPixelBounds(
      data, info.width, info.channels, 200, 370, 115, 190, goldPixel,
    );
    const rightBracket = findPixelBounds(
      data, info.width, info.channels, 1790, 1950, 115, 190, goldPixel,
    );
    const hpf = NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-hpf");
    const lpf = NAM_EQ_V4_FACEPLATE.controls.find(({ id }) => id === "eq-lpf");
    const faders = NAM_EQ_V4_FACEPLATE.controls.filter((control) => control.kind === "fader");

    expect(hpf).toMatchObject({ center: { x: 290, y: 274 }, visualDiameter: 150 });
    expect(lpf).toMatchObject({ center: { x: 1870, y: 274 }, visualDiameter: 150 });
    if (hpf?.kind === "knob" && lpf?.kind === "knob") {
      expect(hpf.center.y - hpf.visualDiameter / 2 - leftBracket.bottom)
        .toBeGreaterThanOrEqual(20);
      expect(lpf.center.y - lpf.visualDiameter / 2 - rightBracket.bottom)
        .toBeGreaterThanOrEqual(20);
      expect(hpf.center.y - hpf.hitDiameter / 2 - leftBracket.bottom)
        .toBeGreaterThanOrEqual(5);
      expect(lpf.center.y - lpf.hitDiameter / 2 - rightBracket.bottom)
        .toBeGreaterThanOrEqual(5);
    }
    const firstWell = faders[0]?.kind === "fader" ? faders[0].bakedWell : undefined;
    const lastFader = faders[faders.length - 1];
    const lastWell = lastFader?.kind === "fader" ? lastFader.bakedWell : undefined;
    expect(firstWell).toBeDefined();
    expect(lastWell).toBeDefined();
    if (firstWell && lastWell) {
      expect(firstWell.x - leftBracket.right).toBeGreaterThanOrEqual(150);
      expect(rightBracket.left - (lastWell.x + lastWell.width)).toBeGreaterThanOrEqual(150);
    }
  });
});

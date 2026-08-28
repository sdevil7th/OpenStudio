// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this asset audit in Node.
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const readAsset = (name: string) => readFileSync(
  new URL(`../assets/nam/design/bodies/${name}`, import.meta.url),
);

describe("NAM Amp GAIN artwork integrity", () => {
  it("changes only the interior label patch and preserves the approved visible border", async () => {
    const [original, gainBody, originalOnBlack, gainBodyOnBlack, originalOnWhite, gainBodyOnWhite] = await Promise.all([
      sharp(readAsset("amp-head-body-v4.webp"))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(readAsset("amp-head-body-v5.webp"))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(readAsset("amp-head-body-v4.webp"))
        .flatten({ background: "#000000" })
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(readAsset("amp-head-body-v5.webp"))
        .flatten({ background: "#000000" })
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(readAsset("amp-head-body-v4.webp"))
        .flatten({ background: "#ffffff" })
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(readAsset("amp-head-body-v5.webp"))
        .flatten({ background: "#ffffff" })
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);

    expect(gainBody.info).toMatchObject({
      width: original.info.width,
      height: original.info.height,
      channels: 4,
    });

    const patch = { left: 300, top: 580, right: 425, bottom: 665 };
    let alphaDifferences = 0;
    let exteriorVisibleDifferencesOverOne = 0;
    let interiorColorDifferences = 0;
    for (let y = 0; y < original.info.height; y += 1) {
      for (let x = 0; x < original.info.width; x += 1) {
        const offset = (y * original.info.width + x) * 4;
        if (original.data[offset + 3] !== gainBody.data[offset + 3]) {
          alphaDifferences += 1;
        }
        const colorChanged = original.data[offset] !== gainBody.data[offset]
          || original.data[offset + 1] !== gainBody.data[offset + 1]
          || original.data[offset + 2] !== gainBody.data[offset + 2];
        const insidePatch = x >= patch.left && x < patch.right
          && y >= patch.top && y < patch.bottom;
        if (colorChanged && insidePatch) interiorColorDifferences += 1;
        if (!insidePatch) {
          const flattenedOffset = (y * original.info.width + x) * 3;
          const visibleDelta = Math.max(
            Math.abs(originalOnBlack.data[flattenedOffset] - gainBodyOnBlack.data[flattenedOffset]),
            Math.abs(originalOnBlack.data[flattenedOffset + 1] - gainBodyOnBlack.data[flattenedOffset + 1]),
            Math.abs(originalOnBlack.data[flattenedOffset + 2] - gainBodyOnBlack.data[flattenedOffset + 2]),
            Math.abs(originalOnWhite.data[flattenedOffset] - gainBodyOnWhite.data[flattenedOffset]),
            Math.abs(originalOnWhite.data[flattenedOffset + 1] - gainBodyOnWhite.data[flattenedOffset + 1]),
            Math.abs(originalOnWhite.data[flattenedOffset + 2] - gainBodyOnWhite.data[flattenedOffset + 2]),
          );
          if (visibleDelta > 1) exteriorVisibleDifferencesOverOne += 1;
        }
      }
    }

    expect(alphaDifferences).toBe(0);
    // WebP may normalize hidden RGB under fully transparent pixels. Verify the
    // actual composited edge on both dark and light stages instead: no exterior
    // pixel may drift by more than one 8-bit level, ruling out visible halos.
    expect(exteriorVisibleDifferencesOverOne).toBe(0);
    expect(interiorColorDifferences).toBeGreaterThan(500);
  });
});

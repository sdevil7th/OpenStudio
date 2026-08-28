#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "../frontend/node_modules/sharp/dist/index.mjs";

const workspace = process.cwd();
const sourceDir = path.join(
  workspace,
  "frontend",
  "src",
  "assets",
  "nam",
  "design",
  "sources",
);
const bodyDir = path.join(
  workspace,
  "frontend",
  "src",
  "assets",
  "nam",
  "design",
  "bodies",
);
const controlDir = path.join(
  workspace,
  "frontend",
  "src",
  "assets",
  "nam",
  "design",
  "controls",
);

await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(bodyDir, { recursive: true })]);

function rgbAt(data, width, channels, x, y) {
  const offset = (y * width + x) * channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

function isConnectedWhite(rgb) {
  const [red, green, blue] = rgb;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  // Image generation returned an almost-white matte with a broad neutral
  // anti-alias/shadow fringe. Flood only neutral pixels connected to the
  // canvas edge so bright metal details enclosed by the chassis survive.
  return minimum >= 104 && maximum - minimum <= 34;
}

async function removeConnectedWhiteBackground(inputPath) {
  const { data, info } = await sharp(inputPath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pixels = width * height;
  const outside = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let head = 0;
  let tail = 0;

  const enqueue = (index) => {
    if (outside[index]) return;
    const x = index % width;
    const y = Math.floor(index / width);
    if (!isConnectedWhite(rgbAt(data, width, channels, x, y))) return;
    outside[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }

  const rgba = Buffer.allocUnsafe(pixels * 4);
  for (let index = 0; index < pixels; index += 1) {
    const source = index * channels;
    const target = index * 4;
    const red = data[source];
    const green = data[source + 1];
    const blue = data[source + 2];
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    // ImageGen left a handful of disconnected neutral checker/matte islands
    // around the handle. They are outside the cabinet silhouette, so the edge
    // flood cannot reach them. Remove those bright neutral islands only in the
    // exterior strip and preserve faceplate metal highlights and printing.
    const exteriorTopMatte =
      Math.floor(index / width) < Math.round(height * 0.18) &&
      minimum >= 132 &&
      maximum - minimum <= 46;
    const residualWhiteMatte =
      (minimum >= 205 && maximum - minimum <= 28) || exteriorTopMatte;
    rgba[target] = red;
    rgba[target + 1] = green;
    rgba[target + 2] = blue;
    rgba[target + 3] = outside[index] || residualWhiteMatte ? 0 : 255;
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize(2160, 1035, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .webp({ quality: 94, alphaQuality: 100, smartSubsample: true })
    .toBuffer();
}

async function trimControl(sourceName, outputName, padding, resize) {
  const sourcePath = path.join(controlDir, sourceName);
  const outputPath = path.join(controlDir, outputName);
  const trimmed = await sharp(sourcePath)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  await sharp(trimmed)
    .resize(resize.width, resize.height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .webp({ quality: 94, alphaQuality: 100, smartSubsample: true })
    .toFile(outputPath);
}

async function decorateAmpBody(input, assetPath) {
  const tickCenters = [360, 875, 1080, 1285, 1490, 1695, 1900];
  const tickMarkup = tickCenters.map((centerX) => {
    const ticks = Array.from({ length: 11 }, (_, index) => {
      const angle = (-135 + index * 27) * Math.PI / 180;
      const innerRadius = index === 5 ? 75 : 77;
      const outerRadius = index === 5 ? 87 : 84;
      const x1 = centerX + Math.sin(angle) * innerRadius;
      const y1 = 745 - Math.cos(angle) * innerRadius;
      const x2 = centerX + Math.sin(angle) * outerRadius;
      const y2 = 745 - Math.cos(angle) * outerRadius;
      return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" />`;
    }).join("");
    return `<g class="knob-scale">${ticks}</g>`;
  }).join("");
  const labels = [
    [225, "POWER"],
    [360, "INPUT"],
    [520, "TIGHT"],
    [675, "BRIGHT"],
    [875, "BASS"],
    [1080, "MID"],
    [1285, "TREBLE"],
    [1490, "PRESENCE"],
    [1695, "MIX"],
    [1900, "OUTPUT"],
  ].map(([x, label]) => `<text x="${x}" y="634" class="label">${label}</text>`).join("");
  const overlay = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="2160" height="1035" viewBox="0 0 2160 1035">
      <defs>
        <style>
          .brand { fill: #e8e3da; font: 800 27px Arial, sans-serif; letter-spacing: 7px; text-anchor: middle; }
          .brand-sub { fill: #c79a4d; font: 750 16px Arial, sans-serif; letter-spacing: 5px; text-anchor: middle; }
          .legend { fill: #b59050; fill-opacity: .86; font: 700 16px Arial, sans-serif; letter-spacing: 5px; text-anchor: middle; }
          .label { fill: #e5dfd4; font: 750 21px Arial, sans-serif; letter-spacing: 3px; text-anchor: middle; }
          .knob-scale { fill: none; stroke: #9c927f; stroke-opacity: .78; stroke-width: 4; stroke-linecap: round; }
        </style>
      </defs>
      <text x="1080" y="232" class="brand">OPENSTUDIO</text>
      <text x="1080" y="259" class="brand-sub">NAM WRAPPER</text>
      <text x="1080" y="530" class="legend">FIXED NAM CAPTURE · WRAPPER CONTROLS</text>
      <line x1="750" y1="602" x2="750" y2="842" stroke="#c59a51" stroke-opacity=".24" stroke-width="3" />
      <line x1="1592" y1="602" x2="1592" y2="842" stroke="#c59a51" stroke-opacity=".24" stroke-width="3" />
      ${labels}
      ${tickMarkup}
    </svg>
  `);
  await sharp(input)
    .composite([{ input: overlay, left: 0, top: 0 }])
    .webp({ quality: 94, alphaQuality: 100, smartSubsample: true })
    .toFile(assetPath);
}

async function prepareGraphicEqBodyV6(outputPath) {
  const width = 2160;
  const height = 720;
  const centers = [515, 656.25, 797.5, 938.75, 1080, 1221.25, 1362.5, 1503.75, 1645];
  const labels = ["65", "125", "250", "500", "1K", "2K", "4K", "8K", "16K"];
  // The clean V6 chassis seam begins at y=450 and peaks at y=455. Removing the
  // redundant header lets its fader bank use the full upper deck while the
  // frequency legends still occupy the rail immediately above that seam.
  const frequencyLabelBaselineY = 442;
  const slotTopY = 128;
  const slotBottomY = 420;
  const innerSlotTopY = 132;
  const innerSlotBottomY = 416;
  const guideTopY = 142;
  const guideBottomY = 406;
  const tickStartY = 144;
  const tickStepY = 26;
  // The three strings have different raster bounds in Arial. These measured
  // baselines keep their visible WebP glyph centres on the cap/tick centres at
  // y=144, y=274, and y=404 instead of aligning only their SVG baselines.
  const rangeBaselines = [150.5, 280, 410];
  const bracketUpperY = 138;
  const bracketLowerY = 170;
  const levelLabelX = 1870;
  const railMarkup = centers.map((center, laneIndex) => {
    const ticks = Array.from({ length: 11 }, (_, tickIndex) => {
      const y = tickStartY + tickIndex * tickStepY;
      const isZero = tickIndex === 5;
      const length = isZero ? 39 : tickIndex % 5 === 0 ? 31 : 22;
      const color = isZero ? "#c99b4b" : "#747883";
      const opacity = isZero ? 0.9 : 0.62;
      return `<line x1="${center + 23}" y1="${y.toFixed(2)}" x2="${center + 23 + length}" y2="${y.toFixed(2)}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="3" stroke-linecap="round" />`;
    }).join("");
    return `
      <g id="eq-lane-${laneIndex}">
        <rect x="${center - 11}" y="${slotTopY}" width="22" height="${slotBottomY - slotTopY}" rx="11" fill="#05070a" stroke="#000" stroke-width="5" />
        <rect x="${center - 7}" y="${innerSlotTopY}" width="14" height="${innerSlotBottomY - innerSlotTopY}" rx="7" fill="url(#slotGradient)" stroke="#5a5e67" stroke-opacity=".36" stroke-width="2" />
        <line x1="${center - 2}" y1="${guideTopY}" x2="${center - 2}" y2="${guideBottomY}" stroke="#727680" stroke-opacity=".2" stroke-width="3" />
        ${ticks}
        <text x="${center}" y="${frequencyLabelBaselineY}" class="frequency">${labels[laneIndex]}</text>
      </g>`;
  }).join("");
  const overlay = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="slotGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#020306" />
          <stop offset=".42" stop-color="#10141b" />
          <stop offset=".58" stop-color="#05070b" />
          <stop offset="1" stop-color="#000104" />
        </linearGradient>
        <style>
          .frequency { fill: #d2d0ca; font: 750 22px Arial, sans-serif; letter-spacing: 1px; text-anchor: middle; }
          .control-label { fill: #d9d6cf; font: 750 22px Arial, sans-serif; letter-spacing: 4px; text-anchor: middle; }
          .range { fill: #777b84; font: 700 16px Arial, sans-serif; letter-spacing: 2px; text-anchor: middle; }
        </style>
      </defs>
      <path d="M238 ${bracketLowerY} L270 ${bracketUpperY} L342 ${bracketUpperY}" fill="none" stroke="#c89a4d" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M1818 ${bracketUpperY} L1890 ${bracketUpperY} L1922 ${bracketLowerY}" fill="none" stroke="#c89a4d" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
      <text x="451" y="${rangeBaselines[0]}" class="range">+12</text>
      <text x="451" y="${rangeBaselines[1]}" class="range">0</text>
      <text x="451" y="${rangeBaselines[2]}" class="range">−12</text>
      ${railMarkup}
      <text x="290" y="605" class="control-label">POWER</text>
      <text x="${levelLabelX}" y="605" class="control-label">LEVEL</text>
    </svg>
  `);

  await sharp(path.join(bodyDir, "graphic-eq-body-v3.webp"))
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .composite([{ input: overlay, left: 0, top: 0 }])
    .webp({ quality: 94, alphaQuality: 100, smartSubsample: true })
    .toFile(outputPath);
}

if (process.argv.includes("--eq-v6-only")) {
  await prepareGraphicEqBodyV6(path.join(bodyDir, "graphic-eq-body-v6.webp"));
  console.log("Prepared NAM Rack Graphic EQ V6 with the expanded unbranded fader deck.");
  process.exit(0);
}

const ampBodyBuffer = await removeConnectedWhiteBackground(
  path.join(sourceDir, "amp-head-body-v4-imagegen-source.png"),
);
await decorateAmpBody(
  ampBodyBuffer,
  path.join(bodyDir, "amp-head-body-v4.webp"),
);

await prepareGraphicEqBodyV6(path.join(bodyDir, "graphic-eq-body-v6.webp"));

await Promise.all([
  trimControl("knob-black-top.webp", "knob-black-panel-v4.webp", 8, { width: 384, height: 384 }),
  trimControl("knob-blue-steel-top.webp", "knob-blue-steel-panel-v4.webp", 8, { width: 384, height: 384 }),
  trimControl("toggle-chrome-top.webp", "toggle-chrome-panel-v4.webp", 8, { width: 320, height: 320 }),
  trimControl("slider-metal-top.webp", "slider-metal-cap-v4.webp", 10, { width: 540, height: 280 }),
  trimControl("led-amber-on-top.webp", "led-amber-on-panel-v4.webp", 8, { width: 320, height: 320 }),
  trimControl("led-amber-off-top.webp", "led-amber-off-panel-v4.webp", 8, { width: 320, height: 320 }),
]);

console.log("Prepared NAM Rack V4 amp body, Graphic EQ V6, and tightly bounded panel controls.");

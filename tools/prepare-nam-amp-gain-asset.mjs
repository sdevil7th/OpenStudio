#!/usr/bin/env node

import path from "node:path";
import sharp from "../frontend/node_modules/sharp/dist/index.mjs";

const workspace = process.cwd();
const bodyDir = path.join(
  workspace,
  "frontend",
  "src",
  "assets",
  "nam",
  "design",
  "bodies",
);
const sourcePath = path.join(bodyDir, "amp-head-body-v4.webp");
const outputPath = path.join(bodyDir, "amp-head-body-v5.webp");

// Preserve the approved V4 chassis and its original alpha edge byte-for-byte in
// composition.  Only the printed INPUT legend is replaced.  A clean strip from
// the same brushed-metal rail supplies the local texture; feathering keeps the
// repair invisible without touching the cabinet silhouette or handle.
const patchWidth = 108;
const patchHeight = 70;
const patchLeft = 308;
const patchTop = 590;
const donor = await sharp(sourcePath)
  .extract({ left: 400, top: patchTop, width: 80, height: patchHeight })
  .resize(patchWidth, patchHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
  .ensureAlpha()
  .png()
  .toBuffer();

const featherMask = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${patchWidth}" height="${patchHeight}">
    <defs>
      <filter id="soft-edge" x="-20%" y="-30%" width="140%" height="160%">
        <feGaussianBlur stdDeviation="2" />
      </filter>
    </defs>
    <rect x="3" y="3" width="${patchWidth - 6}" height="${patchHeight - 6}"
      rx="3" fill="#fff" filter="url(#soft-edge)" />
  </svg>
`);

const featheredPatch = await sharp(donor)
  .composite([{ input: featherMask, blend: "dest-in" }])
  .png()
  .toBuffer();

// Typography is deliberately rendered into the asset so it shares the same
// baseline and lighting as every neighbouring faceplate legend.  There is no
// runtime badge, cover, highlight, or extra background layer.
const gainLegend = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="2160" height="1035">
    <text x="360" y="638"
      fill="#e5dfd3"
      font-family="Arial, Helvetica, sans-serif"
      font-size="24"
      font-weight="700"
      letter-spacing="4"
      text-anchor="middle">GAIN</text>
  </svg>
`);

await sharp(sourcePath)
  .composite([
    { input: featheredPatch, left: patchLeft, top: patchTop },
    { input: gainLegend, left: 0, top: 0 },
  ])
  .webp({ lossless: true, alphaQuality: 100, effort: 6 })
  .toFile(outputPath);

console.log(`Prepared ${path.relative(workspace, outputPath)}`);

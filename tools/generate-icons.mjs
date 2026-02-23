/**
 * Generate PNG icons at all required sizes from icon.svg
 * Run: node tools/generate-icons.mjs
 */
import sharp from 'sharp';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const publicDir = resolve(root, 'frontend', 'public');
const iconSvg = resolve(publicDir, 'icon.svg');

// All sizes needed
const sizes = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'favicon-48x48.png', size: 48 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192 },
  { name: 'android-chrome-512x512.png', size: 512 },
  // For JUCE app icon (Windows)
  { name: 'icon-256x256.png', size: 256, dir: resolve(root, 'assets') },
  { name: 'icon-16x16.png', size: 16, dir: resolve(root, 'assets') },
];

const svgBuffer = readFileSync(iconSvg);

for (const { name, size, dir } of sizes) {
  const outDir = dir || publicDir;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const outPath = resolve(outDir, name);
  await sharp(svgBuffer, { density: Math.max(300, size * 2) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);

  console.log(`Generated: ${outPath}`);
}

console.log('All icons generated successfully!');

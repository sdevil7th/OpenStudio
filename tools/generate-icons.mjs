/**
 * Generate PNG icons at all required sizes from assets/branding/openstudio-logo-source.png
 * Run: node tools/generate-icons.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const sharp = require('sharp');
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const publicDir = resolve(root, 'frontend', 'public');
const source = resolve(root, 'assets/branding/openstudio-logo-source.png');

// All sizes needed
const sizes = [
  { name: 'icon.png', size: 512 },
  { name: 'icon-32x32.png', size: 32 },
  { name: 'icon-1024x1024.png', size: 1024, dir: resolve(root, 'assets') },
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

const sourceBuffer = readFileSync(source);

for (const { name, size, dir } of sizes) {
  const outDir = dir || publicDir;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const outPath = resolve(outDir, name);
  await sharp(sourceBuffer)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);

  console.log(`Generated: ${outPath}`);
}

console.log('All icons generated successfully!');

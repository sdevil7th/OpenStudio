import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const sharp = require("sharp");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "frontend", "src", "assets", "nam", "controls");

const KNOB_SIZE = 192;
const KNOB_FRAMES = 121;
const KNOB_ATLAS_COLUMNS = 11;
const FOOTSWITCH_SIZE = 256;
const LED_SIZE = 96;

function polar(cx, cy, radius, angleDeg) {
  const radians = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + Math.cos(radians) * radius,
    y: cy + Math.sin(radians) * radius,
  };
}

function lineTicks(cx, cy, inner, outer, count, colorA, colorB, width = 2) {
  return Array.from({ length: count }, (_, index) => {
    const angle = index * (360 / count);
    const a = polar(cx, cy, inner, angle);
    const b = polar(cx, cy, outer, angle);
    const color = index % 2 === 0 ? colorA : colorB;
    return `<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" />`;
  }).join("\n");
}

const knobThemes = {
  black: {
    rim0: "#babbb6",
    rim1: "#4f5251",
    rim2: "#111313",
    body0: "#6b6f6e",
    body1: "#222626",
    body2: "#030404",
    cap0: "#8e928d",
    cap1: "#232626",
    cap2: "#050606",
    groove: "#eee8da",
    grooveShadow: "#050505",
    tickA: "rgba(255,255,255,0.18)",
    tickB: "rgba(0,0,0,0.76)",
  },
  metal: {
    rim0: "#fff8e7",
    rim1: "#b5afa0",
    rim2: "#555851",
    body0: "#f2ead8",
    body1: "#9b9a91",
    body2: "#3a3b39",
    cap0: "#f8f1df",
    cap1: "#9c9a8e",
    cap2: "#454640",
    groove: "#1d1b17",
    grooveShadow: "#f8f2de",
    tickA: "rgba(255,255,255,0.46)",
    tickB: "rgba(20,19,18,0.38)",
  },
  cream: {
    rim0: "#fff2cf",
    rim1: "#c7ad75",
    rim2: "#403624",
    body0: "#ffe3a7",
    body1: "#b58b4a",
    body2: "#3d2c18",
    cap0: "#fff0c4",
    cap1: "#b68843",
    cap2: "#332212",
    groove: "#1f160d",
    grooveShadow: "#fff4d4",
    tickA: "rgba(255,255,255,0.34)",
    tickB: "rgba(46,31,15,0.58)",
  },
};

function knobSvg(themeName, angle) {
  const t = knobThemes[themeName];
  const cx = KNOB_SIZE / 2;
  const cy = KNOB_SIZE / 2;
  const majorTicks = lineTicks(cx, cy, 71, 86, 72, t.tickA, t.tickB, 2.7);
  const microTicks = lineTicks(cx, cy, 77, 84, 144, "rgba(255,255,255,0.08)", "rgba(0,0,0,0.42)", 1.2);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${KNOB_SIZE}" height="${KNOB_SIZE}" viewBox="0 0 ${KNOB_SIZE} ${KNOB_SIZE}">
  <defs>
    <filter id="softShadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="13" stdDeviation="8" flood-color="#000" flood-opacity="0.58"/>
      <feDropShadow dx="0" dy="2" stdDeviation="1.2" flood-color="#fff" flood-opacity="0.08"/>
    </filter>
    <filter id="surfaceNoise" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.92" numOctaves="3" seed="23" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.7 0 0 0 0 0.7 0 0 0 0 0.7 0 0 0 0.13 0" result="grain"/>
      <feBlend in="SourceGraphic" in2="grain" mode="overlay"/>
    </filter>
    <radialGradient id="rim" cx="33%" cy="20%" r="78%">
      <stop offset="0%" stop-color="${t.rim0}"/>
      <stop offset="23%" stop-color="${t.rim1}"/>
      <stop offset="58%" stop-color="${t.rim2}"/>
      <stop offset="100%" stop-color="#020202"/>
    </radialGradient>
    <radialGradient id="body" cx="35%" cy="24%" r="76%">
      <stop offset="0%" stop-color="${t.body0}"/>
      <stop offset="31%" stop-color="${t.body1}"/>
      <stop offset="78%" stop-color="${t.body2}"/>
      <stop offset="100%" stop-color="#010101"/>
    </radialGradient>
    <radialGradient id="cap" cx="38%" cy="27%" r="74%">
      <stop offset="0%" stop-color="${t.cap0}"/>
      <stop offset="37%" stop-color="${t.cap1}"/>
      <stop offset="78%" stop-color="${t.cap2}"/>
      <stop offset="100%" stop-color="#020202"/>
    </radialGradient>
    <linearGradient id="groove" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${t.grooveShadow}" stop-opacity="0.85"/>
      <stop offset="28%" stop-color="${t.groove}" stop-opacity="0.92"/>
      <stop offset="100%" stop-color="${t.groove}" stop-opacity="0.58"/>
    </linearGradient>
    <linearGradient id="sweep" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.38"/>
      <stop offset="48%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.42"/>
    </linearGradient>
  </defs>
  <g filter="url(#softShadow)">
    <ellipse cx="100" cy="111" rx="70" ry="50" fill="#000" opacity="0.18"/>
    <circle cx="${cx}" cy="${cy}" r="86" fill="url(#rim)"/>
    <circle cx="${cx}" cy="${cy}" r="80" fill="rgba(0,0,0,0.72)"/>
    <g opacity="0.96">
      ${microTicks}
      ${majorTicks}
    </g>
    <circle cx="${cx}" cy="${cy}" r="69" fill="url(#body)" filter="url(#surfaceNoise)"/>
    <circle cx="${cx}" cy="${cy}" r="57" fill="url(#cap)" stroke="rgba(255,255,255,0.18)" stroke-width="2.2"/>
    <circle cx="${cx}" cy="${cy}" r="42" fill="none" stroke="rgba(255,255,255,0.055)" stroke-width="2"/>
    <g transform="rotate(${angle.toFixed(3)} ${cx} ${cy})">
      <line x1="${cx}" y1="44" x2="${cx}" y2="82" stroke="rgba(0,0,0,0.72)" stroke-width="9.8" stroke-linecap="round"/>
      <line x1="${cx}" y1="47" x2="${cx}" y2="82" stroke="url(#groove)" stroke-width="4.4" stroke-linecap="round"/>
      <circle cx="${cx}" cy="47" r="3.1" fill="${t.grooveShadow}" opacity="0.88"/>
    </g>
    <ellipse cx="72" cy="57" rx="24" ry="11" fill="#fff" opacity="0.18" transform="rotate(-27 72 57)"/>
    <path d="M42 68 C65 29, 127 23, 154 70" fill="none" stroke="url(#sweep)" stroke-width="17" opacity="0.42" stroke-linecap="round"/>
    <path d="M39 122 C67 163, 126 164, 154 120" fill="none" stroke="#000" stroke-width="14" opacity="0.26" stroke-linecap="round"/>
  </g>
</svg>`;
}

async function renderSvgBuffer(svg, width, height) {
  return sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
}

async function writeKnobFilmstrip(themeName, fileName) {
  const frames = [];
  const rows = Math.ceil(KNOB_FRAMES / KNOB_ATLAS_COLUMNS);
  for (let index = 0; index < KNOB_FRAMES; index += 1) {
    const pct = index / (KNOB_FRAMES - 1);
    const angle = -135 + pct * 270;
    frames.push({
      input: await renderSvgBuffer(knobSvg(themeName, angle), KNOB_SIZE, KNOB_SIZE),
      left: (index % KNOB_ATLAS_COLUMNS) * KNOB_SIZE,
      top: Math.floor(index / KNOB_ATLAS_COLUMNS) * KNOB_SIZE,
    });
  }
  await sharp({
    create: {
      width: KNOB_SIZE * KNOB_ATLAS_COLUMNS,
      height: KNOB_SIZE * rows,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(frames)
    .webp({ quality: 94, alphaQuality: 98, effort: 6 })
    .toFile(path.join(outDir, fileName));
}

function footswitchSvg(state) {
  const pressed = state !== "off";
  const down = state === "pressed" ? 10 : pressed ? 6 : 0;
  const glow = state === "off" ? 0 : state === "pressed" ? 0.22 : 0.12;
  const marks = lineTicks(128, 128, 104, 118, 48, "rgba(255,255,255,0.28)", "rgba(0,0,0,0.42)", 2);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${FOOTSWITCH_SIZE}" height="${FOOTSWITCH_SIZE}" viewBox="0 0 ${FOOTSWITCH_SIZE} ${FOOTSWITCH_SIZE}">
  <defs>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="18" stdDeviation="12" flood-color="#000" flood-opacity="0.62"/>
      <feDropShadow dx="0" dy="2" stdDeviation="1" flood-color="#fff" flood-opacity="0.18"/>
    </filter>
    <filter id="noise" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.78" numOctaves="3" seed="41" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.6 0 0 0 0 0.6 0 0 0 0 0.6 0 0 0 0.12 0" result="grain"/>
      <feBlend in="SourceGraphic" in2="grain" mode="overlay"/>
    </filter>
    <radialGradient id="washer" cx="35%" cy="21%" r="82%">
      <stop offset="0%" stop-color="#fffbed"/>
      <stop offset="22%" stop-color="#d6d2c7"/>
      <stop offset="47%" stop-color="#8a8c87"/>
      <stop offset="70%" stop-color="#393d3d"/>
      <stop offset="88%" stop-color="#141717"/>
      <stop offset="100%" stop-color="#050606"/>
    </radialGradient>
    <radialGradient id="button" cx="38%" cy="23%" r="74%">
      <stop offset="0%" stop-color="#fffdf4"/>
      <stop offset="24%" stop-color="#d7d3c8"/>
      <stop offset="54%" stop-color="#8c8e88"/>
      <stop offset="78%" stop-color="#464946"/>
      <stop offset="100%" stop-color="#151716"/>
    </radialGradient>
    <linearGradient id="slash" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.56"/>
      <stop offset="42%" stop-color="#fff" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.28"/>
    </linearGradient>
  </defs>
  <g filter="url(#shadow)">
    <ellipse cx="134" cy="156" rx="91" ry="56" fill="#000" opacity="0.2"/>
    <circle cx="128" cy="128" r="112" fill="url(#washer)" filter="url(#noise)"/>
    <circle cx="128" cy="128" r="101" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="3"/>
    <circle cx="128" cy="128" r="91" fill="none" stroke="rgba(0,0,0,0.58)" stroke-width="7"/>
    <g opacity="0.65">${marks}</g>
    <circle cx="128" cy="${122 + down}" r="69" fill="url(#button)" stroke="rgba(255,255,255,0.42)" stroke-width="3.8" filter="url(#noise)"/>
    <circle cx="128" cy="${122 + down}" r="50" fill="none" stroke="rgba(255,255,255,0.21)" stroke-width="3"/>
    <ellipse cx="103" cy="${91 + down}" rx="25" ry="10" fill="#fff" opacity="0.42" transform="rotate(-24 103 ${91 + down})"/>
    <path d="M74 ${100 + down} C96 ${74 + down}, 146 ${69 + down}, 177 ${101 + down}" fill="none" stroke="url(#slash)" stroke-width="18" opacity="0.56" stroke-linecap="round"/>
    <ellipse cx="151" cy="${147 + down}" rx="28" ry="10" fill="#000" opacity="0.22" transform="rotate(-22 151 ${147 + down})"/>
    <circle cx="128" cy="${122 + down}" r="83" fill="none" stroke="#f7d478" stroke-opacity="${glow}" stroke-width="8"/>
  </g>
</svg>`;
}

function ledSvg(active) {
  const glass = active ? "#ffcf67" : "#2a3032";
  const core = active ? "#fff6b8" : "#111415";
  const glow = active ? 0.44 : 0;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${LED_SIZE}" height="${LED_SIZE}" viewBox="0 0 ${LED_SIZE} ${LED_SIZE}">
  <defs>
    <filter id="ledShadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="7" stdDeviation="5" flood-color="#000" flood-opacity="0.6"/>
      <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#ffcf67" flood-opacity="${glow}"/>
    </filter>
    <radialGradient id="bezel" cx="35%" cy="25%" r="76%">
      <stop offset="0%" stop-color="#f1ecdc"/>
      <stop offset="35%" stop-color="#757a78"/>
      <stop offset="70%" stop-color="#202425"/>
      <stop offset="100%" stop-color="#050606"/>
    </radialGradient>
    <radialGradient id="glass" cx="38%" cy="26%" r="72%">
      <stop offset="0%" stop-color="#fffdf4"/>
      <stop offset="22%" stop-color="${core}"/>
      <stop offset="62%" stop-color="${glass}"/>
      <stop offset="100%" stop-color="#050606"/>
    </radialGradient>
  </defs>
  <g filter="url(#ledShadow)">
    <circle cx="48" cy="48" r="39" fill="url(#bezel)"/>
    <circle cx="48" cy="48" r="27" fill="url(#glass)" stroke="rgba(255,255,255,0.32)" stroke-width="2.2"/>
    <ellipse cx="39" cy="34" rx="11" ry="6" fill="#fff" opacity="${active ? 0.62 : 0.18}" transform="rotate(-26 39 34)"/>
    <circle cx="48" cy="48" r="17" fill="${active ? "#ffb634" : "#121618"}" opacity="${active ? 0.38 : 0.42}"/>
  </g>
</svg>`;
}

async function writeSingle(svg, fileName, size) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .webp({ quality: 94, alphaQuality: 98, effort: 6 })
    .toFile(path.join(outDir, fileName));
}

await mkdir(outDir, { recursive: true });
await Promise.all([
  writeKnobFilmstrip("black", "knob-black-atlas.webp"),
  writeKnobFilmstrip("metal", "knob-metal-atlas.webp"),
  writeKnobFilmstrip("cream", "knob-cream-atlas.webp"),
  writeSingle(footswitchSvg("off"), "footswitch-chrome-off.webp", FOOTSWITCH_SIZE),
  writeSingle(footswitchSvg("on"), "footswitch-chrome-on.webp", FOOTSWITCH_SIZE),
  writeSingle(footswitchSvg("pressed"), "footswitch-chrome-pressed.webp", FOOTSWITCH_SIZE),
  writeSingle(ledSvg(false), "led-glass-off.webp", LED_SIZE),
  writeSingle(ledSvg(true), "led-glass-on.webp", LED_SIZE),
]);

console.log(`Generated NAM control assets in ${outDir}`);
console.log(`Knob atlas frames: ${KNOB_FRAMES}`);

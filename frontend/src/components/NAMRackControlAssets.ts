export const NAM_KNOB_FRAME_COUNT = 121;
export const NAM_KNOB_ATLAS_COLUMNS = 11;
export const NAM_KNOB_FRAME_SIZE = 192;

export type NAMControlAssetId =
  | "knobBlack"
  | "knobMetal"
  | "knobCream"
  | "footswitchChromeOff"
  | "footswitchChromeOn"
  | "footswitchChromePressed"
  | "ledGlassOff"
  | "ledGlassOn";

type NAMControlAssetBase = {
  id: NAMControlAssetId;
  href: string;
  width: number;
  height: number;
  anchor: {
    x: number;
    y: number;
  };
};

export type NAMKnobAtlasAsset = NAMControlAssetBase & {
  kind: "knobAtlas";
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  columns: number;
};

export type NAMStateImageAsset = NAMControlAssetBase & {
  kind: "stateImage";
  state: "off" | "on" | "pressed";
};

export type NAMControlAsset = NAMKnobAtlasAsset | NAMStateImageAsset;

const knobAtlas = (id: NAMControlAssetId, href: string): NAMKnobAtlasAsset => ({
  id,
  kind: "knobAtlas",
  href,
  width: NAM_KNOB_FRAME_SIZE * NAM_KNOB_ATLAS_COLUMNS,
  height: NAM_KNOB_FRAME_SIZE * Math.ceil(NAM_KNOB_FRAME_COUNT / NAM_KNOB_ATLAS_COLUMNS),
  frameWidth: NAM_KNOB_FRAME_SIZE,
  frameHeight: NAM_KNOB_FRAME_SIZE,
  frameCount: NAM_KNOB_FRAME_COUNT,
  columns: NAM_KNOB_ATLAS_COLUMNS,
  anchor: { x: 0.5, y: 0.5 },
});

const stateImage = (
  id: NAMControlAssetId,
  href: string,
  width: number,
  height: number,
  state: NAMStateImageAsset["state"],
): NAMStateImageAsset => ({
  id,
  kind: "stateImage",
  href,
  width,
  height,
  state,
  anchor: { x: 0.5, y: 0.5 },
});

export const NAM_CONTROL_ASSETS = {
  knobBlack: knobAtlas("knobBlack", new URL("../assets/nam/controls/knob-black-atlas.webp", import.meta.url).href),
  knobMetal: knobAtlas("knobMetal", new URL("../assets/nam/controls/knob-metal-atlas.webp", import.meta.url).href),
  knobCream: knobAtlas("knobCream", new URL("../assets/nam/controls/knob-cream-atlas.webp", import.meta.url).href),
  footswitchChromeOff: stateImage("footswitchChromeOff", new URL("../assets/nam/controls/footswitch-chrome-off.webp", import.meta.url).href, 256, 256, "off"),
  footswitchChromeOn: stateImage("footswitchChromeOn", new URL("../assets/nam/controls/footswitch-chrome-on.webp", import.meta.url).href, 256, 256, "on"),
  footswitchChromePressed: stateImage("footswitchChromePressed", new URL("../assets/nam/controls/footswitch-chrome-pressed.webp", import.meta.url).href, 256, 256, "pressed"),
  ledGlassOff: stateImage("ledGlassOff", new URL("../assets/nam/controls/led-glass-off.webp", import.meta.url).href, 96, 96, "off"),
  ledGlassOn: stateImage("ledGlassOn", new URL("../assets/nam/controls/led-glass-on.webp", import.meta.url).href, 96, 96, "on"),
} as const satisfies Record<NAMControlAssetId, NAMControlAsset>;

export const NAM_REQUIRED_CONTROL_ASSET_IDS: NAMControlAssetId[] = [
  "knobBlack",
  "knobMetal",
  "knobCream",
  "footswitchChromeOff",
  "footswitchChromeOn",
  "footswitchChromePressed",
  "ledGlassOff",
  "ledGlassOn",
];

export function requireNAMControlAsset<T extends NAMControlAssetId>(assetId: T): (typeof NAM_CONTROL_ASSETS)[T] {
  const asset = NAM_CONTROL_ASSETS[assetId];
  if (!asset?.href) {
    throw new Error(`Missing required NAM control asset: ${assetId}`);
  }
  return asset;
}

export function knobFrameIndex(pct: number, frameCount = NAM_KNOB_FRAME_COUNT) {
  const normalized = Number.isFinite(pct) ? Math.min(1, Math.max(0, pct)) : 0.5;
  return Math.round(normalized * (frameCount - 1));
}

export function knobAtlasFrame(asset: NAMKnobAtlasAsset, frameIndex: number) {
  const safeFrame = Math.min(asset.frameCount - 1, Math.max(0, frameIndex));
  return {
    index: safeFrame,
    column: safeFrame % asset.columns,
    row: Math.floor(safeFrame / asset.columns),
  };
}

export function knobAssetForVariant(variant?: string): NAMKnobAtlasAsset {
  if (variant === "metal" || variant === "white" || variant === "panel") return requireNAMControlAsset("knobMetal");
  if (variant === "warning") return requireNAMControlAsset("knobCream");
  return requireNAMControlAsset("knobBlack");
}

export function footswitchAssetForState(active: boolean, pressed = false): NAMStateImageAsset {
  if (pressed) return requireNAMControlAsset("footswitchChromePressed");
  return active ? requireNAMControlAsset("footswitchChromeOn") : requireNAMControlAsset("footswitchChromeOff");
}

export function ledAssetForState(active: boolean): NAMStateImageAsset {
  return active ? requireNAMControlAsset("ledGlassOn") : requireNAMControlAsset("ledGlassOff");
}

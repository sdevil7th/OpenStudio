/// <reference types="vite/client" />

export type NAMDesignBodyAssetId =
  | "amp-head-body"
  | "amp-head-body-wide"
  | "cabinet-body"
  | "expression-body"
  | "ir-shaper-panel-body"
  | "mic-panel-body"
  | "rack-unit-body"
  | "rack-unit-body-deep"
  | "stompbox-body-blue"
  | "stompbox-body-dark"
  | "stompbox-body-dark-wide"
  | "stompbox-body-navy"
  | "stompbox-body-olive"
  | "stompbox-body-red"
  | "stompbox-body-stone"
  | "wide-pedal-body-copper"
  | "wide-pedal-body-copper-deep"
  | "wide-pedal-body-dark"
  | "wide-pedal-body-dark-deep"
  | "wide-pedal-body-navy"
  | "wide-pedal-body-navy-deep";

export type NAMDesignControlAssetId =
  | "button-black-top"
  | "footswitch-chrome-off-top"
  | "footswitch-chrome-on-top"
  | "footswitch-chrome-pressed-top"
  | "knob-black-top"
  | "knob-cream-top"
  | "knob-metal-top"
  | "led-amber-off-top"
  | "led-amber-on-top"
  | "mic-dynamic-57"
  | "mic-ribbon-121"
  | "screw-phillips-top"
  | "slider-metal-top"
  | "toggle-chrome-top"
  | "washer-chrome-top";

type NAMDesignAssetBase<TId extends string> = {
  id: TId;
  href: string;
  fileName: string;
  width: number;
  height: number;
  aspectRatio: string;
};

export type NAMDesignBodyAsset = NAMDesignAssetBase<NAMDesignBodyAssetId> & {
  kind: "body";
};

export type NAMDesignControlAsset = NAMDesignAssetBase<NAMDesignControlAssetId> & {
  kind: "control";
};

export type NAMDesignAsset = NAMDesignBodyAsset | NAMDesignControlAsset;

// Keep the source PNG masters beside these runtime derivatives, but make the
// Vite dependency set explicit. A dynamic `new URL(...${fileName})` causes Vite
// to package every sibling (including the 40+ MB PNG masters).
const designBodyHrefs = import.meta.glob("../assets/nam/design/bodies/*.webp", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

const designControlHrefs = import.meta.glob("../assets/nam/design/controls/*.webp", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

const designAssetHref = (assets: Record<string, string>, directory: "bodies" | "controls", fileName: string) => {
  const key = `../assets/nam/design/${directory}/${fileName}`;
  const href = assets[key];
  if (!href) throw new Error(`Missing NAM design asset: ${key}`);
  return href;
};

const body = (id: NAMDesignBodyAssetId, fileName: string, width: number, height: number): NAMDesignBodyAsset => ({
  id,
  kind: "body",
  href: designAssetHref(designBodyHrefs, "bodies", fileName),
  fileName,
  width,
  height,
  aspectRatio: `${width} / ${height}`,
});

const control = (id: NAMDesignControlAssetId, fileName: string, width: number, height: number): NAMDesignControlAsset => ({
  id,
  kind: "control",
  href: designAssetHref(designControlHrefs, "controls", fileName),
  fileName,
  width,
  height,
  aspectRatio: `${width} / ${height}`,
});

export const NAM_DESIGN_BODY_ASSETS = {
  "amp-head-body": body("amp-head-body", "amp-head-body.webp", 1551, 598),
  "amp-head-body-wide": body("amp-head-body-wide", "amp-head-body-wide.webp", 2272, 598),
  "cabinet-body": body("cabinet-body", "cabinet-body.webp", 1328, 888),
  "expression-body": body("expression-body", "expression-body.webp", 582, 1485),
  "ir-shaper-panel-body": body("ir-shaper-panel-body", "ir-shaper-panel-body.webp", 1542, 710),
  "mic-panel-body": body("mic-panel-body", "mic-panel-body.webp", 1542, 710),
  "rack-unit-body": body("rack-unit-body", "rack-unit-body.webp", 2101, 434),
  "rack-unit-body-deep": body("rack-unit-body-deep", "rack-unit-body-deep.webp", 2101, 657),
  "stompbox-body-blue": body("stompbox-body-blue", "stompbox-body-blue.webp", 694, 1340),
  "stompbox-body-dark": body("stompbox-body-dark", "stompbox-body-dark.webp", 694, 1340),
  "stompbox-body-dark-wide": body("stompbox-body-dark-wide", "stompbox-body-dark-wide.webp", 900, 1340),
  "stompbox-body-navy": body("stompbox-body-navy", "stompbox-body-navy.webp", 694, 1340),
  "stompbox-body-olive": body("stompbox-body-olive", "stompbox-body-olive.webp", 694, 1340),
  "stompbox-body-red": body("stompbox-body-red", "stompbox-body-red.webp", 694, 1340),
  "stompbox-body-stone": body("stompbox-body-stone", "stompbox-body-stone.webp", 694, 1340),
  "wide-pedal-body-copper": body("wide-pedal-body-copper", "wide-pedal-body-copper.webp", 1355, 662),
  "wide-pedal-body-copper-deep": body("wide-pedal-body-copper-deep", "wide-pedal-body-copper-deep.webp", 1355, 968),
  "wide-pedal-body-dark": body("wide-pedal-body-dark", "wide-pedal-body-dark.webp", 1355, 662),
  "wide-pedal-body-dark-deep": body("wide-pedal-body-dark-deep", "wide-pedal-body-dark-deep.webp", 1355, 947),
  "wide-pedal-body-navy": body("wide-pedal-body-navy", "wide-pedal-body-navy.webp", 1355, 662),
  "wide-pedal-body-navy-deep": body("wide-pedal-body-navy-deep", "wide-pedal-body-navy-deep.webp", 1355, 1093),
} as const satisfies Record<NAMDesignBodyAssetId, NAMDesignBodyAsset>;

export const NAM_DESIGN_CONTROL_ASSETS = {
  "button-black-top": control("button-black-top", "button-black-top.webp", 512, 512),
  "footswitch-chrome-off-top": control("footswitch-chrome-off-top", "footswitch-chrome-off-top.webp", 512, 512),
  "footswitch-chrome-on-top": control("footswitch-chrome-on-top", "footswitch-chrome-on-top.webp", 512, 512),
  "footswitch-chrome-pressed-top": control("footswitch-chrome-pressed-top", "footswitch-chrome-pressed-top.webp", 512, 512),
  "knob-black-top": control("knob-black-top", "knob-black-top.webp", 512, 512),
  "knob-cream-top": control("knob-cream-top", "knob-cream-top.webp", 512, 512),
  "knob-metal-top": control("knob-metal-top", "knob-metal-top.webp", 512, 512),
  "led-amber-off-top": control("led-amber-off-top", "led-amber-off-top.webp", 512, 512),
  "led-amber-on-top": control("led-amber-on-top", "led-amber-on-top.webp", 512, 512),
  "mic-dynamic-57": control("mic-dynamic-57", "mic-dynamic-57.webp", 190, 700),
  "mic-ribbon-121": control("mic-ribbon-121", "mic-ribbon-121.webp", 190, 700),
  "screw-phillips-top": control("screw-phillips-top", "screw-phillips-top.webp", 512, 512),
  "slider-metal-top": control("slider-metal-top", "slider-metal-top.webp", 512, 512),
  "toggle-chrome-top": control("toggle-chrome-top", "toggle-chrome-top.webp", 512, 512),
  "washer-chrome-top": control("washer-chrome-top", "washer-chrome-top.webp", 512, 512),
} as const satisfies Record<NAMDesignControlAssetId, NAMDesignControlAsset>;

export const NAM_REQUIRED_DESIGN_BODY_ASSET_IDS = Object.keys(NAM_DESIGN_BODY_ASSETS) as NAMDesignBodyAssetId[];
export const NAM_REQUIRED_DESIGN_CONTROL_ASSET_IDS = Object.keys(NAM_DESIGN_CONTROL_ASSETS) as NAMDesignControlAssetId[];

export function getNAMDesignBodyAsset(assetId: NAMDesignBodyAssetId): NAMDesignBodyAsset {
  const asset = NAM_DESIGN_BODY_ASSETS[assetId];
  if (!asset?.href) throw new Error(`Missing NAM design body asset: ${assetId}`);
  return asset;
}

export function getNAMDesignControlAsset(assetId: NAMDesignControlAssetId): NAMDesignControlAsset {
  const asset = NAM_DESIGN_CONTROL_ASSETS[assetId];
  if (!asset?.href) throw new Error(`Missing NAM design control asset: ${assetId}`);
  return asset;
}

export function getNAMDesignAsset(assetId: NAMDesignBodyAssetId | NAMDesignControlAssetId): NAMDesignAsset {
  if (assetId in NAM_DESIGN_BODY_ASSETS) return getNAMDesignBodyAsset(assetId as NAMDesignBodyAssetId);
  return getNAMDesignControlAsset(assetId as NAMDesignControlAssetId);
}

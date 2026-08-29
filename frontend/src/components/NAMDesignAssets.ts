/// <reference types="vite/client" />

export type NAMDesignBodyAssetId =
  | "amp-head-body"
  | "amp-head-body-wide"
  | "amp-head-body-v5"
  | "cabinet-body"
  | "cab-room-integrated-body"
  | "graphic-eq-body-v6"
  | "ir-shaper-panel-body"
  | "mic-panel-body"
  | "stompbox-body-blue"
  | "stompbox-body-blue-wide"
  | "stompbox-body-dark"
  | "stompbox-body-dark-wide"
  | "stompbox-body-olive"
  | "stompbox-body-red"
  | "stompbox-body-red-wide"
  | "stompbox-body-stone"
  | "stompbox-body-white-wide"
  | "wide-pedal-body-copper"
  | "wide-pedal-body-copper-deep"
  | "wide-pedal-body-copper-tall"
  | "wide-pedal-body-dark"
  | "wide-pedal-body-dark-deep"
  | "wide-pedal-body-dark-tall"
  | "wide-pedal-body-navy"
  | "wide-pedal-body-navy-deep"
  | "wide-pedal-body-navy-tall";

export type NAMDesignControlAssetId =
  | "button-black-top"
  | "footswitch-chrome-off-top"
  | "footswitch-chrome-on-top"
  | "footswitch-chrome-pressed-top"
  | "knob-black-top"
  | "knob-black-panel-v4"
  | "knob-blue-steel-top"
  | "knob-blue-steel-panel-v4"
  | "knob-cream-top"
  | "knob-metal-top"
  | "led-amber-off-top"
  | "led-amber-off-panel-v4"
  | "led-amber-on-top"
  | "led-amber-on-panel-v4"
  | "mic-dynamic-57"
  | "mic-ribbon-121"
  | "screw-phillips-top"
  | "slider-metal-top"
  | "slider-metal-cap-v4"
  | "toggle-chrome-top"
  | "toggle-chrome-panel-v4"
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
const designBodyHrefs = import.meta.glob([
  "../assets/nam/design/bodies/*.webp",
  // Generator intermediates stay available to the asset-preparation tools,
  // but only the approved faceplates belong in the runtime bundle.
  "!../assets/nam/design/bodies/amp-head-body-v4.webp",
  "!../assets/nam/design/bodies/graphic-eq-body-v3.webp",
], {
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
  "amp-head-body-v5": body("amp-head-body-v5", "amp-head-body-v5.webp", 2160, 1035),
  "cabinet-body": body("cabinet-body", "cabinet-body.webp", 1328, 888),
  "cab-room-integrated-body": body("cab-room-integrated-body", "cab-room-integrated-body.webp", 1634, 962),
  "graphic-eq-body-v6": body("graphic-eq-body-v6", "graphic-eq-body-v6.webp", 2160, 720),
  "ir-shaper-panel-body": body("ir-shaper-panel-body", "ir-shaper-panel-body.webp", 1542, 710),
  "mic-panel-body": body("mic-panel-body", "mic-panel-body.webp", 1542, 710),
  "stompbox-body-blue": body("stompbox-body-blue", "stompbox-body-blue.webp", 694, 1340),
  "stompbox-body-blue-wide": body("stompbox-body-blue-wide", "stompbox-body-blue-wide.webp", 900, 1340),
  "stompbox-body-dark": body("stompbox-body-dark", "stompbox-body-dark.webp", 694, 1340),
  "stompbox-body-dark-wide": body("stompbox-body-dark-wide", "stompbox-body-dark-wide.webp", 900, 1340),
  "stompbox-body-olive": body("stompbox-body-olive", "stompbox-body-olive.webp", 694, 1340),
  "stompbox-body-red": body("stompbox-body-red", "stompbox-body-red.webp", 694, 1340),
  "stompbox-body-red-wide": body("stompbox-body-red-wide", "stompbox-body-red-wide.webp", 900, 1340),
  "stompbox-body-stone": body("stompbox-body-stone", "stompbox-body-stone.webp", 694, 1340),
  "stompbox-body-white-wide": body("stompbox-body-white-wide", "stompbox-body-white-wide.webp", 900, 1340),
  "wide-pedal-body-copper": body("wide-pedal-body-copper", "wide-pedal-body-copper.webp", 1355, 662),
  "wide-pedal-body-copper-deep": body("wide-pedal-body-copper-deep", "wide-pedal-body-copper-deep.webp", 1355, 968),
  "wide-pedal-body-copper-tall": body("wide-pedal-body-copper-tall", "wide-pedal-body-copper-tall.webp", 1355, 1078),
  "wide-pedal-body-dark": body("wide-pedal-body-dark", "wide-pedal-body-dark.webp", 1355, 662),
  "wide-pedal-body-dark-deep": body("wide-pedal-body-dark-deep", "wide-pedal-body-dark-deep.webp", 1355, 947),
  "wide-pedal-body-dark-tall": body("wide-pedal-body-dark-tall", "wide-pedal-body-dark-tall.webp", 1355, 1042),
  "wide-pedal-body-navy": body("wide-pedal-body-navy", "wide-pedal-body-navy.webp", 1355, 662),
  "wide-pedal-body-navy-deep": body("wide-pedal-body-navy-deep", "wide-pedal-body-navy-deep.webp", 1355, 1093),
  "wide-pedal-body-navy-tall": body("wide-pedal-body-navy-tall", "wide-pedal-body-navy-tall.webp", 1355, 1201),
} as const satisfies Record<NAMDesignBodyAssetId, NAMDesignBodyAsset>;

export const NAM_DESIGN_CONTROL_ASSETS = {
  "button-black-top": control("button-black-top", "button-black-top.webp", 512, 512),
  "footswitch-chrome-off-top": control("footswitch-chrome-off-top", "footswitch-chrome-off-top.webp", 512, 512),
  "footswitch-chrome-on-top": control("footswitch-chrome-on-top", "footswitch-chrome-on-top.webp", 512, 512),
  "footswitch-chrome-pressed-top": control("footswitch-chrome-pressed-top", "footswitch-chrome-pressed-top.webp", 512, 512),
  "knob-black-top": control("knob-black-top", "knob-black-top.webp", 512, 512),
  "knob-black-panel-v4": control("knob-black-panel-v4", "knob-black-panel-v4.webp", 384, 384),
  "knob-blue-steel-top": control("knob-blue-steel-top", "knob-blue-steel-top.webp", 512, 512),
  "knob-blue-steel-panel-v4": control("knob-blue-steel-panel-v4", "knob-blue-steel-panel-v4.webp", 384, 384),
  "knob-cream-top": control("knob-cream-top", "knob-cream-top.webp", 512, 512),
  "knob-metal-top": control("knob-metal-top", "knob-metal-top.webp", 512, 512),
  "led-amber-off-top": control("led-amber-off-top", "led-amber-off-top.webp", 512, 512),
  "led-amber-off-panel-v4": control("led-amber-off-panel-v4", "led-amber-off-panel-v4.webp", 320, 320),
  "led-amber-on-top": control("led-amber-on-top", "led-amber-on-top.webp", 512, 512),
  "led-amber-on-panel-v4": control("led-amber-on-panel-v4", "led-amber-on-panel-v4.webp", 320, 320),
  "mic-dynamic-57": control("mic-dynamic-57", "mic-dynamic-57.webp", 190, 700),
  "mic-ribbon-121": control("mic-ribbon-121", "mic-ribbon-121.webp", 190, 700),
  "screw-phillips-top": control("screw-phillips-top", "screw-phillips-top.webp", 512, 512),
  "slider-metal-top": control("slider-metal-top", "slider-metal-top.webp", 512, 512),
  "slider-metal-cap-v4": control("slider-metal-cap-v4", "slider-metal-cap-v4.webp", 540, 280),
  "toggle-chrome-top": control("toggle-chrome-top", "toggle-chrome-top.webp", 512, 512),
  "toggle-chrome-panel-v4": control("toggle-chrome-panel-v4", "toggle-chrome-panel-v4.webp", 320, 320),
  "washer-chrome-top": control("washer-chrome-top", "washer-chrome-top.webp", 512, 512),
} as const satisfies Record<NAMDesignControlAssetId, NAMDesignControlAsset>;

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

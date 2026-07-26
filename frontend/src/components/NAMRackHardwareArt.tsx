import { type CSSProperties, type ReactNode } from "react";
import type { RackModuleId } from "./NAMRackPedalHardware";

export type HardwareSceneAnchor = {
  x: number;
  y: number;
  size?: number;
};

export type HardwareSceneRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  imageScale?: number;
  imageOriginX?: number;
  imageOriginY?: number;
};

export const AMP_HARDWARE_SCENE = {
  width: 1672,
  height: 941,
  art: {
    head: { x: 77, y: 8, width: 1535, height: 557, imageScale: 1.035, imageOriginX: 50, imageOriginY: 51 },
    cab: { x: 32, y: 587, width: 1608, height: 335, imageScale: 1.18, imageOriginX: 50, imageOriginY: 48 },
  },
  nameplates: {
    amp: { x: 836, y: 235, width: 560, height: 72 },
    cab: { x: 836, y: 776, width: 560, height: 72 },
  },
  anchors: {
    power: { x: 359, y: 418, size: 132 },
    inputTrimDb: { x: 475, y: 403, size: 130 },
    bassDb: { x: 639, y: 403, size: 130 },
    midDb: { x: 803, y: 403, size: 130 },
    trebleDb: { x: 966, y: 403, size: 130 },
    presenceDb: { x: 1130, y: 403, size: 130 },
    ampMix: { x: 1294, y: 403, size: 130 },
    outputTrimDb: { x: 1455, y: 403, size: 130 },
  },
};

export const NAM_RACK_ART = {
  ampFront: new URL("../assets/nam/amp-cab-premium-front.webp", import.meta.url).href,
  ampFrontHead: new URL("../assets/nam/amp-cab-premium-front-head.webp", import.meta.url).href,
  ampFrontCab: new URL("../assets/nam/amp-cab-premium-front-cab.webp", import.meta.url).href,
  amp: new URL("../assets/nam/amp-cab-premium-v2.webp", import.meta.url).href,
  pedal: new URL("../assets/nam/pedal-premium-v2.webp", import.meta.url).href,
  cab: new URL("../assets/nam/cab-room-premium.webp", import.meta.url).href,
  ampHeadBlank: new URL("../assets/nam/amp-head-blank-skin.webp", import.meta.url).href,
  cabBlank: new URL("../assets/nam/cab-blank-skin.webp", import.meta.url).href,
  pedalBlank: new URL("../assets/nam/pedal-blank-skin.webp", import.meta.url).href,
  pedalPbrClean: new URL("../assets/nam/pedal-pbr-clean-skin.webp", import.meta.url).href,
  preCompressorPbr: new URL("../assets/nam/pre-compressor-pbr-skin.webp", import.meta.url).href,
  preTapeEchoPbr: new URL("../assets/nam/pre-tape-echo-pbr-skin.webp", import.meta.url).href,
  preDualOctaverPbr: new URL("../assets/nam/pre-dual-octaver-pbr-skin.webp", import.meta.url).href,
  prePrecisionDrivePbr: new URL("../assets/nam/pre-precision-drive-pbr-skin.webp", import.meta.url).href,
  preChaosPbr: new URL("../assets/nam/pre-chaos-pbr-skin.webp", import.meta.url).href,
  specialLaserExpressionPbr: new URL("../assets/nam/special-laser-expression-pbr-skin.webp", import.meta.url).href,
  modulatorExpressionPbr: new URL("../assets/nam/modulator-expression-pbr-skin.webp", import.meta.url).href,
  reverbBluePbr: new URL("../assets/nam/reverb-blue-pbr-skin.webp", import.meta.url).href,
  rackRoomBlank: new URL("../assets/nam/rack-room-blank-skin.webp", import.meta.url).href,
  rackPbrClean: new URL("../assets/nam/rack-pbr-clean-skin.webp", import.meta.url).href,
  ampFallback: new URL("../assets/nam/amp-head.svg", import.meta.url).href,
  pedalFallback: new URL("../assets/nam/pedal-module.svg", import.meta.url).href,
  cabFallback: new URL("../assets/nam/cab-ir.svg", import.meta.url).href,
};

function sceneX(x: number): string {
  return `${(x / AMP_HARDWARE_SCENE.width) * 100}%`;
}

function sceneY(y: number): string {
  return `${(y / AMP_HARDWARE_SCENE.height) * 100}%`;
}

function sceneWidth(width: number): string {
  return `${(width / AMP_HARDWARE_SCENE.width) * 100}%`;
}

function sceneHeight(height: number): string {
  return `${(height / AMP_HARDWARE_SCENE.height) * 100}%`;
}

export function hardwareAnchorStyle(anchor: HardwareSceneAnchor): CSSProperties {
  const style: Record<string, string> = {
    "--nam-scene-x": sceneX(anchor.x),
    "--nam-scene-y": sceneY(anchor.y),
  };
  if (anchor.size) {
    style["--nam-scene-size"] = sceneWidth(anchor.size);
  }
  return style as CSSProperties;
}

export function hardwareRegionStyle(region: HardwareSceneRegion): CSSProperties {
  const style: Record<string, string> = {
    "--nam-scene-x": sceneX(region.x),
    "--nam-scene-y": sceneY(region.y),
    "--nam-scene-w": sceneWidth(region.width),
    "--nam-scene-h": sceneHeight(region.height),
  };
  if (region.imageScale) style["--nam-scene-image-scale"] = String(region.imageScale);
  if (region.imageOriginX !== undefined) style["--nam-scene-origin-x"] = `${region.imageOriginX}%`;
  if (region.imageOriginY !== undefined) style["--nam-scene-origin-y"] = `${region.imageOriginY}%`;
  return style as CSSProperties;
}

export function moduleHardwareArt(moduleId: RackModuleId) {
  if (moduleId === "amp") return NAM_RACK_ART.ampHeadBlank;
  if (moduleId === "cab") return NAM_RACK_ART.cabBlank;
  return NAM_RACK_ART.pedalBlank;
}

export function AmpCabHardwareArt({ children }: { children: ReactNode }) {
  return (
    <div className="nam-amp-art-layer nam-hardware-scene-layer">
      <img
        className="nam-amp-surface-art nam-amp-surface-full"
        src={NAM_RACK_ART.ampFront}
        alt=""
        loading="eager"
        aria-hidden="true"
      />
      <div className="nam-rack-art-stack" aria-hidden="true">
        <div
          className="nam-rack-art-piece nam-rack-art-head"
          data-scene-region="head"
          style={hardwareRegionStyle(AMP_HARDWARE_SCENE.art.head)}
        >
          <img
            className="nam-amp-surface-art nam-amp-surface-premium-front nam-amp-surface-blank-head"
            src={NAM_RACK_ART.ampHeadBlank}
            alt=""
            loading="eager"
          />
        </div>
        <div
          className="nam-rack-art-piece nam-rack-art-cab"
          data-scene-region="cab"
          style={hardwareRegionStyle(AMP_HARDWARE_SCENE.art.cab)}
        >
          <img
            className="nam-amp-surface-art nam-amp-surface-premium-front nam-amp-surface-blank-cab"
            src={NAM_RACK_ART.cabBlank}
            alt=""
            loading="eager"
          />
        </div>
      </div>
      {children}
    </div>
  );
}

export function CabRoomHardwareArt() {
  return (
    <>
      <img className="nam-cab-room-backdrop" src={NAM_RACK_ART.rackRoomBlank} alt="" loading="lazy" aria-hidden="true" />
      <img className="nam-cab-room-art" src={NAM_RACK_ART.cabBlank} alt="" loading="lazy" aria-hidden="true" />
    </>
  );
}

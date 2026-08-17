import { useRef } from "react";
import type { CSSProperties, PointerEvent, WheelEvent } from "react";

import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import {
  denormalizeParamValue,
  formatParamValue,
  normalizeParam,
  offsetParamValue,
  quantizeParamValue,
} from "../utils/builtInParamValue";
import {
  getNAMDesignBodyAsset,
  getNAMDesignControlAsset,
  type NAMDesignBodyAssetId,
  type NAMDesignControlAssetId,
} from "./NAMDesignAssets";
import type { RackModuleId } from "./NAMRackPedalHardware";
import type { NAMRackDeviceSkin, NAMRackVisualMode, RackSectionId } from "./NAMRackNeuralSkinRegistry";

import ampHeadScene from "./namScenes/amp-head.scene.json";
import cabRoomScene from "./namScenes/cab-room.scene.json";
import eqRackScene from "./namScenes/eq-rack.scene.json";
import postModulatorScene from "./namScenes/post-modulator.scene.json";
import postReverbScene from "./namScenes/post-reverb.scene.json";
import postStereoDelayScene from "./namScenes/post-stereo-delay.scene.json";
import preChaosScene from "./namScenes/pre-chaos.scene.json";
import preCompressorScene from "./namScenes/pre-compressor.scene.json";
import preDualOctaverScene from "./namScenes/pre-dual-octaver.scene.json";
import prePrecisionDriveScene from "./namScenes/pre-precision-drive.scene.json";
import preTapeEchoScene from "./namScenes/pre-tape-echo.scene.json";

type SceneControlKind =
  | "knob"
  | "switch"
  | "button"
  | "display"
  | "footswitch"
  | "meter"
  | "label"
  | "fader"
  | "mic"
  | "treadle"
  | "led";

type SceneLabelPlacement = "above" | "below" | "inside" | "hidden";
type SceneValuePlacement = "above" | "below" | "inside" | "hidden";
type SceneControlVariant = "black" | "white" | "metal" | "compact" | "large" | "panel" | "warning";

export type NAMRackSceneControl = {
  id: string;
  paramId?: string;
  kind: SceneControlKind;
  x: number;
  y: number;
  width: number;
  height: number;
  diameter?: number;
  label?: string;
  resetValue?: number;
  rotationRange?: [number, number];
  zIndex?: number;
  labelPlacement?: SceneLabelPlacement;
  valuePlacement?: SceneValuePlacement;
  variant?: SceneControlVariant;
  printedLabel?: boolean;
};

export type NAMRackSceneManifest = {
  id: string;
  skinId: string;
  artboard: {
    width: number;
    height: number;
  };
  device: {
    kind: NAMRackDeviceSkin["material"];
    title: string;
    subtitle: string;
    color: string;
    accent: string;
    originality?: string;
    printedLabels?: boolean;
  };
  composition?: {
    targetDeviceCount?: number;
    layout?: string;
    requiredModules?: string[];
    printedLabels?: boolean;
  };
  controls: NAMRackSceneControl[];
  hitboxes: unknown[];
};

export type NAMRackSceneStageDevice = {
  skin: NAMRackDeviceSkin;
  moduleId?: RackModuleId;
  title: string;
  subtitle: string;
  display: string;
  active: boolean;
  accent: string;
  params: BuiltInParamDescriptor[];
  onAction?: () => void;
  onPowerToggle?: () => void;
};

const SCENES = [
  preCompressorScene,
  preTapeEchoScene,
  preDualOctaverScene,
  prePrecisionDriveScene,
  preChaosScene,
  ampHeadScene,
  cabRoomScene,
  eqRackScene,
  postModulatorScene,
  postStereoDelayScene,
  postReverbScene,
] as NAMRackSceneManifest[];

const SCENE_BY_SKIN = new Map(SCENES.map((scene) => [scene.skinId, scene]));

export function sceneForSkin(skinId: string): NAMRackSceneManifest | undefined {
  return SCENE_BY_SKIN.get(skinId);
}

export const NAM_RACK_SCENE_BODY_ASSETS: Partial<Record<string, readonly NAMDesignBodyAssetId[]>> = {
  "pre-compressor-design-a": ["stompbox-body-blue"],
  "pre-tape-echo-design-a": ["stompbox-body-olive"],
  "pre-dual-octaver-design-a": ["stompbox-body-dark"],
  "pre-precision-drive-design-a": ["stompbox-body-red"],
  "pre-chaos-design-a": ["stompbox-body-stone"],
  "amp-head-design-a": ["amp-head-body-wide"],
  "cab-room-design-a": ["cabinet-body", "mic-panel-body"],
  "eq-rack-design-a": ["rack-unit-body-deep"],
  "post-modulator-design-a": ["wide-pedal-body-copper"],
  "post-stereo-delay-design-a": ["rack-unit-body-deep"],
  "post-reverb-design-a": ["stompbox-body-navy"],
} as const;

export const NAM_RACK_SCENE_REQUIRED_CONTROL_ASSETS = [
  "button-black-top",
  "footswitch-chrome-off-top",
  "footswitch-chrome-on-top",
  "knob-black-top",
  "knob-metal-top",
  "led-amber-off-top",
  "led-amber-on-top",
  "mic-dynamic-57",
  "mic-ribbon-121",
  "screw-phillips-top",
  "slider-metal-top",
  "toggle-chrome-top",
  "washer-chrome-top",
] as const satisfies readonly NAMDesignControlAssetId[];

export function getNAMRackSceneDesignBodyAssetIds(skinId: string): NAMDesignBodyAssetId[] {
  return [...(NAM_RACK_SCENE_BODY_ASSETS[skinId] ?? [])];
}

export function getNAMRackSceneDesignControlAssetIds(skinId: string): NAMDesignControlAssetId[] {
  const scene = sceneForSkin(skinId);
  if (!scene || !NAM_RACK_SCENE_BODY_ASSETS[skinId]) return [];
  const ids = new Set<NAMDesignControlAssetId>();
  ids.add("screw-phillips-top");
  ids.add("washer-chrome-top");
  scene.controls.forEach((control) => {
    if (control.kind === "knob") ids.add(designKnobAssetId(scene));
    if (control.kind === "switch") ids.add("toggle-chrome-top");
    if (control.kind === "button") ids.add("button-black-top");
    if (control.kind === "footswitch") {
      ids.add("footswitch-chrome-off-top");
      ids.add("footswitch-chrome-on-top");
      ids.add("led-amber-off-top");
      ids.add("led-amber-on-top");
    }
    if (control.kind === "led") {
      ids.add("led-amber-off-top");
      ids.add("led-amber-on-top");
    }
    if (control.kind === "fader") ids.add("slider-metal-top");
    if (control.kind === "mic") ids.add(designMicAssetId(control));
  });
  return [...ids];
}

function designKnobAssetId(_scene: NAMRackSceneManifest): NAMDesignControlAssetId {
  return "knob-black-top";
}

function designLedAssetId(active: boolean): NAMDesignControlAssetId {
  return active ? "led-amber-on-top" : "led-amber-off-top";
}

function designFootswitchAssetId(active: boolean): NAMDesignControlAssetId {
  return active ? "footswitch-chrome-on-top" : "footswitch-chrome-off-top";
}

function designMicAssetId(control: NAMRackSceneControl): NAMDesignControlAssetId {
  const id = control.id.toLowerCase();
  return id.includes("right") || id.includes("mic-b") || id.includes("ribbon") || id.includes("121")
    ? "mic-ribbon-121"
    : "mic-dynamic-57";
}

function sceneBodyAssetId(scene: NAMRackSceneManifest): NAMDesignBodyAssetId | undefined {
  return NAM_RACK_SCENE_BODY_ASSETS[scene.skinId]?.[0];
}

function sceneDomIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function SceneDesignBodyImage({
  assetId,
  x,
  y,
  width,
  height,
  preserveAspectRatio = "none",
  className = "",
}: {
  assetId: NAMDesignBodyAssetId;
  x: number;
  y: number;
  width: number;
  height: number;
  preserveAspectRatio?: "none" | "xMidYMid slice" | "xMidYMid meet";
  className?: string;
}) {
  const asset = getNAMDesignBodyAsset(assetId);
  return (
    <image
      className={`nam-scene-design-asset nam-scene-design-body ${className}`.trim()}
      href={asset.href}
      x={x}
      y={y}
      width={width}
      height={height}
      preserveAspectRatio={preserveAspectRatio}
      data-rack-design-asset-kind={asset.kind}
      data-rack-design-asset-id={asset.id}
      data-rack-design-asset-file={asset.fileName}
      data-rack-design-natural-width={asset.width}
      data-rack-design-natural-height={asset.height}
      aria-hidden="true"
    />
  );
}

function SceneDesignControlImage({
  assetId,
  x,
  y,
  width,
  height,
  preserveAspectRatio = "none",
  className = "",
  transform,
  qa,
}: {
  assetId: NAMDesignControlAssetId;
  x: number;
  y: number;
  width: number;
  height: number;
  preserveAspectRatio?: "none" | "xMidYMid slice" | "xMidYMid meet";
  className?: string;
  transform?: string;
  qa?: Record<string, string>;
}) {
  const asset = getNAMDesignControlAsset(assetId);
  return (
    <image
      className={`nam-scene-design-asset nam-scene-design-control ${className}`.trim()}
      href={asset.href}
      x={x}
      y={y}
      width={width}
      height={height}
      preserveAspectRatio={preserveAspectRatio}
      transform={transform}
      data-rack-design-asset-kind={asset.kind}
      data-rack-design-asset-id={asset.id}
      data-rack-design-asset-file={asset.fileName}
      data-rack-design-natural-width={asset.width}
      data-rack-design-natural-height={asset.height}
      {...qa}
    />
  );
}

function clampPercent(value: number) {
  return Math.min(1, Math.max(0, value));
}

function controlRect(control: NAMRackSceneControl) {
  return {
    x: control.x - control.width / 2,
    y: control.y - control.height / 2,
    width: control.width,
    height: control.height,
  };
}

function controlActive(control: NAMRackSceneControl, param?: BuiltInParamDescriptor) {
  if (!param) return false;
  if (param.type === "enum") {
    if (typeof control.resetValue === "number") return Math.round(param.value) === Math.round(control.resetValue);
    return param.value > param.min;
  }
  return param.value >= (param.min + param.max) / 2;
}

function controlLooksBound(control: NAMRackSceneControl, param?: BuiltInParamDescriptor) {
  return Boolean(param || !control.paramId);
}

function sceneTitle(scene: NAMRackSceneManifest, device: NAMRackSceneStageDevice) {
  return scene.device.title || device.title;
}

function sceneSubtitle(scene: NAMRackSceneManifest, device: NAMRackSceneStageDevice) {
  return scene.device.subtitle || device.subtitle;
}

function nextToggleValue(control: NAMRackSceneControl, param: BuiltInParamDescriptor) {
  if (param.type === "enum") {
    if (typeof control.resetValue === "number") return control.resetValue;
    const current = Math.round(param.value);
    return current >= Math.round(param.max) ? param.min : current + 1;
  }
  return controlActive(control, param) ? param.min : param.max;
}

function displayText(control: NAMRackSceneControl, device: NAMRackSceneStageDevice, param?: BuiltInParamDescriptor) {
  if (param) return formatParamValue(param);
  if (control.label && control.kind !== "button") return control.label;
  if (control.kind === "display") return device.display;
  return control.label ?? "";
}

function hasPrintedLabels(scene: NAMRackSceneManifest, control: NAMRackSceneControl) {
  return Boolean(control.printedLabel || scene.device.printedLabels || scene.composition?.printedLabels);
}

function labelPlacement(scene: NAMRackSceneManifest, control: NAMRackSceneControl, fallback: SceneLabelPlacement = "below") {
  if (!control.label || hasPrintedLabels(scene, control)) return "hidden";
  return control.labelPlacement ?? fallback;
}

function valuePlacement(control: NAMRackSceneControl, fallback: SceneValuePlacement = "hidden") {
  return control.valuePlacement ?? fallback;
}

function controlLabelNode(
  scene: NAMRackSceneManifest,
  control: NAMRackSceneControl,
  x: number,
  y: number,
  fallback: SceneLabelPlacement = "below",
  className = "nam-scene-label",
) {
  const placement = labelPlacement(scene, control, fallback);
  if (!control.label || placement === "hidden") return null;
  return <text x={x} y={y} className={className} textAnchor="middle">{control.label}</text>;
}

function SceneScrew({ x, y, radius = 10 }: { x: number; y: number; radius?: number }) {
  const size = radius * 2.4;
  return (
    <g className="nam-scene-screw" aria-hidden="true">
      <SceneDesignControlImage
        assetId="screw-phillips-top"
        x={x - size / 2}
        y={y - size / 2}
        width={size}
        height={size}
        className="nam-scene-screw-design"
      />
    </g>
  );
}

function SceneStudioBadge({ x, y, width, label = "OPENSTUDIO" }: { x: number; y: number; width: number; label?: string }) {
  return (
    <g className="nam-scene-studio-badge" aria-hidden="true">
      <rect x={x - width / 2} y={y - 22} width={width} height="44" rx="8" fill="rgba(232,235,226,0.9)" stroke="rgba(13,15,16,0.48)" strokeWidth="3" />
      <text x={x} y={y + 7} className="nam-scene-badge-text" textAnchor="middle">{label}</text>
    </g>
  );
}

function ScenePanelLock({ x, y }: { x: number; y: number }) {
  return (
    <g className="nam-scene-panel-lock" aria-hidden="true">
      <rect x={x - 9} y={y - 2} width="18" height="15" rx="3" fill="#141920" />
      <path d={`M ${x - 5} ${y - 2} V ${y - 7} C ${x - 5} ${y - 13}, ${x + 5} ${y - 13}, ${x + 5} ${y - 7} V ${y - 2}`} fill="none" stroke="#141920" strokeWidth="4" strokeLinecap="round" />
      <circle cx={x} cy={y + 5} r="2" fill="#dfe5ee" opacity="0.76" />
    </g>
  );
}

function ScenePreStompBoxBody({ scene, active }: { scene: NAMRackSceneManifest; active: boolean }) {
  const { width, height } = scene.artboard;
  const designBody = sceneBodyAssetId(scene);
  const bodyX = width * 0.065;
  const bodyY = height * 0.055;
  const bodyW = width * 0.87;
  const bodyH = height * 0.86;
  const titleY = height * 0.69;
  const accent = scene.device.accent;
  const knobControls = scene.controls.filter((control) => control.kind === "knob");
  const displayControls = scene.controls.filter((control) => control.kind === "display");
  const footswitchControls = scene.controls.filter((control) => control.kind === "footswitch");

  return (
    <g className="nam-scene-body nam-scene-body-pre-stomp-target">
      <ellipse cx={width / 2} cy={height * 0.94} rx={width * 0.41} ry={height * 0.045} fill="rgba(5,7,10,0.38)" />
      <rect x={bodyX - 16} y={bodyY + 64} width="30" height="178" rx="12" fill="url(#sceneJackMetal)" />
      <rect x={bodyX + bodyW - 14} y={bodyY + 64} width="30" height="178" rx="12" fill="url(#sceneJackMetal)" />
      <rect x={bodyX - 4} y={bodyY + 20} width={bodyW + 8} height={bodyH - 2} rx="44" fill="#050607" opacity="0.34" />
      <rect x={bodyX} y={bodyY} width={bodyW} height={bodyH} rx="42" fill="#111214" opacity="0.52" />
      <rect
        x={bodyX + 8}
        y={bodyY + 4}
        width={bodyW - 16}
        height={bodyH - 24}
        rx="36"
        fill={scene.device.color}
        stroke="rgba(255,255,255,0.34)"
        strokeWidth="4"
      />
      <rect x={bodyX + 15} y={bodyY + 14} width={bodyW - 30} height="38" rx="18" fill="rgba(255,255,255,0.14)" />
      <rect x={bodyX + 16} y={bodyY + bodyH - 70} width={bodyW - 32} height="42" rx="19" fill="rgba(0,0,0,0.2)" />
      <rect
        x={bodyX + 34}
        y={bodyY + 34}
        width={bodyW - 68}
        height={bodyH - 108}
        rx="25"
        fill="url(#scenePrePedalFace)"
        opacity="0.62"
      />
      <rect
        x={bodyX + 34}
        y={bodyY + 34}
        width={bodyW - 68}
        height={bodyH - 108}
        rx="25"
        fill="url(#scenePedalGrain)"
        opacity="0.13"
      />
      <rect
        x={bodyX + 34}
        y={bodyY + 34}
        width={bodyW - 68}
        height={bodyH - 108}
        rx="25"
        fill="none"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="3"
      />
      <path d={`M ${bodyX + 48} ${bodyY + 62} H ${bodyX + bodyW - 48}`} stroke="rgba(255,255,255,0.26)" strokeWidth="4" strokeLinecap="round" opacity="0.74" />
      <path d={`M ${bodyX + 54} ${bodyY + bodyH - 104} H ${bodyX + bodyW - 54}`} stroke="rgba(0,0,0,0.34)" strokeWidth="6" strokeLinecap="round" opacity="0.66" />
      {knobControls.map((control) => {
        const radius = (control.diameter ?? Math.min(control.width, control.height)) / 2;
        const wellRadius = radius * 1.15;
        return (
          <g key={`${control.id}-well`} className="nam-scene-pre-control-well" aria-hidden="true">
            <circle cx={control.x} cy={control.y + radius * 0.06} r={wellRadius} fill="rgba(0,0,0,0.22)" />
            <circle cx={control.x} cy={control.y} r={wellRadius * 0.9} fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth="5" />
            <path
              d={`M ${control.x - wellRadius * 0.56} ${control.y - wellRadius * 0.64} Q ${control.x} ${control.y - wellRadius * 0.86} ${control.x + wellRadius * 0.56} ${control.y - wellRadius * 0.64}`}
              fill="none"
              stroke="rgba(255,255,255,0.14)"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </g>
        );
      })}
      {displayControls.map((control) => {
        const rect = controlRect(control);
        return (
          <g key={`${control.id}-pocket`} className="nam-scene-pre-display-pocket" aria-hidden="true">
            <rect x={rect.x - 10} y={rect.y + 8} width={rect.width + 20} height={rect.height + 8} rx="12" fill="rgba(0,0,0,0.28)" />
            <rect x={rect.x - 8} y={rect.y - 7} width={rect.width + 16} height={rect.height + 14} rx="13" fill="rgba(255,255,255,0.08)" />
          </g>
        );
      })}
      {footswitchControls.map((control) => {
        const radius = (control.diameter ?? Math.min(control.width, control.height)) / 2;
        return (
          <g key={`${control.id}-plate`} className="nam-scene-pre-footswitch-plate" aria-hidden="true">
            <ellipse cx={control.x} cy={control.y + radius * 0.2} rx={radius * 1.08} ry={radius * 0.7} fill="rgba(0,0,0,0.28)" />
            <circle cx={control.x} cy={control.y} r={radius * 1.15} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="6" />
          </g>
        );
      })}
      <rect x={width * 0.29} y={height * 0.075} width={width * 0.42} height="34" rx="10" fill="rgba(0,0,0,0.22)" />
      <text x={width / 2} y={height * 0.098} className="nam-scene-pre-family-text" textAnchor="middle">OPENSTUDIO PRE</text>
      <circle cx={width / 2} cy={height * 0.55} r="18" fill={active ? accent : "rgba(255,255,255,0.42)"} filter="url(#sceneLedGlow)" opacity={active ? 0.8 : 0.32} />
      <text x={width / 2} y={titleY} className="nam-scene-pre-title" textAnchor="middle">{scene.device.title}</text>
      <path
        d={`M ${width * 0.31} ${titleY + 34} H ${width * 0.44} Q ${width * 0.5} ${titleY + 13} ${width * 0.56} ${titleY + 34} H ${width * 0.69}`}
        fill="none"
        stroke="rgba(255,255,255,0.58)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <SceneScrew x={bodyX + 45} y={bodyY + 48} radius={12} />
      <SceneScrew x={bodyX + bodyW - 45} y={bodyY + 48} radius={12} />
      <SceneScrew x={bodyX + 45} y={bodyY + bodyH - 76} radius={12} />
      <SceneScrew x={bodyX + bodyW - 45} y={bodyY + bodyH - 76} radius={12} />
      {designBody && (
        <SceneDesignBodyImage
          assetId={designBody}
          x={width * 0.08}
          y={height * 0.02}
          width={width * 0.84}
          height={height * 0.9}
          className="nam-scene-generated-pre-body"
        />
      )}
      <text x={width / 2} y={height * 0.085} className="nam-scene-pre-family-text" textAnchor="middle">OPENSTUDIO PRE</text>
      <circle cx={width / 2} cy={height * 0.55} r="18" fill={active ? accent : "rgba(255,255,255,0.42)"} filter="url(#sceneLedGlow)" opacity={active ? 0.8 : 0.32} />
      <text x={width / 2} y={titleY} className="nam-scene-pre-title" textAnchor="middle">{scene.device.title}</text>
      <path
        d={`M ${width * 0.31} ${titleY + 34} H ${width * 0.44} Q ${width * 0.5} ${titleY + 13} ${width * 0.56} ${titleY + 34} H ${width * 0.69}`}
        fill="none"
        stroke="rgba(255,255,255,0.58)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </g>
  );
}

function SceneAmpHeadBody({ scene, active }: { scene: NAMRackSceneManifest; active: boolean }) {
  const { width } = scene.artboard;
  const designBody = sceneBodyAssetId(scene);
  return (
    <g className="nam-scene-body nam-scene-body-amp nam-scene-body-amp-target" data-original-amp={scene.device.originality}>
      <rect x="34" y="42" width={width - 68} height="460" rx="34" fill="#070909" filter="url(#sceneCabModuleShadow)" />
      <rect x="52" y="56" width={width - 104} height="424" rx="25" fill="url(#sceneAmpCase)" stroke="rgba(255,255,255,0.14)" strokeWidth="5" />
      <rect x="52" y="56" width={width - 104} height="424" rx="25" fill="url(#sceneAmpTolex)" opacity="0.38" />
      <rect x="62" y="66" width={width - 124} height="404" rx="20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
      <rect x="72" y="70" width={width - 144} height="16" rx="8" fill="rgba(255,255,255,0.12)" />
      <rect x="74" y="84" width={width - 148} height="20" rx="10" fill="rgba(0,0,0,0.34)" />
      <rect x="74" y="76" width={width - 148} height="246" rx="16" fill="#050606" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
      <rect x="96" y="94" width={width - 192} height="210" rx="9" fill="url(#sceneAmpGrille)" opacity="0.98" />
      <rect x="128" y="110" width={width - 256} height="178" rx="8" fill="url(#sceneGrilleGlow)" opacity="0.28" />
      <rect x="96" y="292" width={width - 192} height="10" rx="5" fill="rgba(255,255,255,0.09)" />
      <SceneStudioBadge x={width / 2} y={198} width={266} label="OPENSTUDIO NAM" />
      <rect x="72" y="340" width={width - 144} height="136" rx="14" fill="#08090a" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
      <rect x="72" y="340" width={width - 144} height="136" rx="14" fill="url(#sceneAmpTolex)" opacity="0.12" />
      <rect x="90" y="356" width={width - 180} height="2" rx="1" fill="rgba(255,255,255,0.07)" />
      <rect x="90" y="472" width={width - 180} height="3" rx="1.5" fill="rgba(0,0,0,0.34)" />
      <rect x="92" y="356" width="250" height="104" rx="10" fill="rgba(255,255,255,0.022)" stroke="rgba(255,255,255,0.065)" strokeWidth="2" />
      <text x="156" y="386" className="nam-scene-panel-text" textAnchor="middle">INPUT</text>
      <circle cx="158" cy="424" r="26" fill="#050506" stroke="rgba(236,236,226,0.55)" strokeWidth="5" />
      <rect x="382" y="356" width="840" height="104" rx="10" fill="rgba(255,255,255,0.018)" stroke="rgba(255,255,255,0.06)" strokeWidth="2" />
      <rect x="1260" y="356" width="184" height="104" rx="10" fill="rgba(255,255,255,0.026)" stroke="rgba(255,255,255,0.07)" strokeWidth="2" />
      <text x="1352" y="386" className="nam-scene-panel-text" textAnchor="middle">POWER</text>
      <rect x="92" y="492" width="108" height="22" rx="10" fill="#050607" />
      <rect x={width - 200} y="492" width="108" height="22" rx="10" fill="#050607" />
      <rect x="430" y="328" width="680" height="8" rx="4" fill="rgba(255,255,255,0.12)" opacity={active ? 0.42 : 0.2} />
      <SceneScrew x={76} y={72} />
      <SceneScrew x={width - 76} y={72} />
      <SceneScrew x={76} y={462} />
      <SceneScrew x={width - 76} y={462} />
      {designBody && (
        <SceneDesignBodyImage
          assetId={designBody}
          x={0}
          y={34}
          width={width}
          height={500}
          className="nam-scene-generated-amp-body"
        />
      )}
      <SceneStudioBadge x={width / 2} y={200} width={266} label="OPENSTUDIO NAM" />
      <text x="156" y="386" className="nam-scene-panel-text" textAnchor="middle">INPUT</text>
      <text x="1352" y="386" className="nam-scene-panel-text" textAnchor="middle">POWER</text>
      <rect x="430" y="328" width="680" height="8" rx="4" fill="rgba(255,255,255,0.12)" opacity={active ? 0.42 : 0.2} />
    </g>
  );
}

function SceneCabRoomBody({ scene }: { scene: NAMRackSceneManifest }) {
  return (
    <g className="nam-scene-body nam-scene-body-cab nam-scene-body-cab-target" data-device-kind={scene.device.kind}>
      <rect x="56" y="72" width="632" height="392" rx="16" fill="#070808" filter="url(#sceneCabModuleShadow)" />
      <rect x="68" y="84" width="608" height="368" rx="12" fill="#111111" stroke="rgba(255,255,255,0.13)" strokeWidth="4" />
      <rect x="88" y="102" width="568" height="330" rx="8" fill="#1b1b1a" stroke="rgba(0,0,0,0.74)" strokeWidth="5" />
      <rect x="104" y="118" width="536" height="298" rx="6" fill="url(#sceneCabGrille)" opacity="0.98" />
      <circle cx="278" cy="270" r="132" fill="url(#sceneSpeaker)" opacity="0.2" />
      <circle cx="488" cy="270" r="132" fill="url(#sceneSpeaker)" opacity="0.18" />
      <rect x="120" y="132" width="504" height="266" rx="4" fill="rgba(255,255,255,0.028)" />
      <SceneStudioBadge x={376} y={272} width={184} label="OPENSTUDIO" />
      <rect x="118" y="428" width="516" height="10" rx="5" fill="rgba(255,255,255,0.16)" />
      <rect x="716" y="72" width="744" height="392" rx="18" fill="#dce5f0" stroke="rgba(55,62,74,0.3)" strokeWidth="4" filter="url(#sceneCabModuleShadow)" />
      <rect x="730" y="84" width="716" height="370" rx="16" fill="rgba(255,255,255,0.34)" stroke="rgba(255,255,255,0.42)" strokeWidth="2" />
      <rect x="740" y="96" width="696" height="344" rx="12" fill="#eef3f9" stroke="rgba(40,47,58,0.18)" strokeWidth="3" />
      <rect x="758" y="114" width="274" height="306" rx="14" fill="#e8eef6" stroke="rgba(42,48,58,0.18)" strokeWidth="3" />
      <rect x="1062" y="114" width="274" height="306" rx="14" fill="#e8eef6" stroke="rgba(42,48,58,0.18)" strokeWidth="3" />
      <rect x="1358" y="114" width="72" height="306" rx="13" fill="#e4ebf4" stroke="rgba(42,48,58,0.18)" strokeWidth="3" />
      <rect x="778" y="194" width="96" height="204" rx="18" fill="rgba(22,27,33,0.08)" stroke="rgba(42,48,58,0.12)" strokeWidth="3" />
      <rect x="1090" y="194" width="96" height="204" rx="18" fill="rgba(22,27,33,0.08)" stroke="rgba(42,48,58,0.12)" strokeWidth="3" />
      <rect x="884" y="214" width="120" height="196" rx="14" fill="rgba(255,255,255,0.34)" stroke="rgba(42,48,58,0.1)" strokeWidth="2" />
      <rect x="1196" y="214" width="120" height="196" rx="14" fill="rgba(255,255,255,0.34)" stroke="rgba(42,48,58,0.1)" strokeWidth="2" />
      <line x1="1044" x2="1044" y1="126" y2="420" stroke="rgba(42,47,57,0.12)" strokeWidth="3" />
      <line x1="1356" x2="1356" y1="126" y2="420" stroke="rgba(42,47,57,0.12)" strokeWidth="3" />
      <text x="892" y="126" className="nam-scene-mic-card-title" textAnchor="middle">MIC A</text>
      <text x="804" y="154" className="nam-scene-mic-card-subtitle" textAnchor="middle">DYNAMIC 57</text>
      <text x="1206" y="126" className="nam-scene-mic-card-title" textAnchor="middle">MIC B</text>
      <text x="1118" y="154" className="nam-scene-mic-card-subtitle" textAnchor="middle">RIBBON 121</text>
      <text x="1403" y="126" className="nam-scene-mixer-strip-title" textAnchor="middle">MIX</text>
      <text x="1382" y="164" className="nam-scene-mic-card-subtitle" textAnchor="middle">A</text>
      <text x="1424" y="164" className="nam-scene-mic-card-subtitle" textAnchor="middle">B</text>
      {[1382, 1424].map((x) => (
        <g key={`cab-mix-ticks-${x}`}>
          {Array.from({ length: 7 }).map((_, index) => (
            <line key={index} x1={x - 18} x2={x - 10} y1={202 + index * 24} y2={202 + index * 24} stroke="rgba(42,48,58,0.34)" strokeWidth="2" strokeLinecap="round" />
          ))}
          {Array.from({ length: 7 }).map((_, index) => (
            <line key={index} x1={x + 10} x2={x + 18} y1={202 + index * 24} y2={202 + index * 24} stroke="rgba(42,48,58,0.34)" strokeWidth="2" strokeLinecap="round" />
          ))}
        </g>
      ))}
      <ScenePanelLock x={1000} y={234} />
      <ScenePanelLock x={1000} y={314} />
      <ScenePanelLock x={1000} y={388} />
      <ScenePanelLock x={1312} y={234} />
      <ScenePanelLock x={1312} y={314} />
      <ScenePanelLock x={1312} y={388} />
      <text x="946" y="248" className="nam-scene-mic-card-subtitle" textAnchor="middle">POSITION</text>
      <text x="946" y="328" className="nam-scene-mic-card-subtitle" textAnchor="middle">PHASE</text>
      <text x="1258" y="248" className="nam-scene-mic-card-subtitle" textAnchor="middle">DISTANCE</text>
      <text x="1258" y="328" className="nam-scene-mic-card-subtitle" textAnchor="middle">AXIS</text>
      <text x="1378" y="402" fill="rgba(31,36,46,0.66)" fontSize="11" fontWeight="900" letterSpacing="0.04em" textAnchor="end">BLOOM</text>
      <text x="1417" y="402" fill="rgba(31,36,46,0.66)" fontSize="11" fontWeight="900" letterSpacing="0.04em" textAnchor="start">PAN</text>
      <SceneScrew x={90} y={106} />
      <SceneScrew x={654} y={106} />
      <SceneScrew x={90} y={430} />
      <SceneScrew x={654} y={430} />
      <SceneScrew x={740} y={96} />
      <SceneScrew x={1436} y={96} />
      <SceneScrew x={740} y={440} />
      <SceneScrew x={1436} y={440} />
      <SceneDesignBodyImage
        assetId="cabinet-body"
        x={56}
        y={72}
        width={632}
        height={392}
        className="nam-scene-generated-cabinet-body"
      />
      <SceneDesignBodyImage
        assetId="mic-panel-body"
        x={716}
        y={72}
        width={744}
        height={392}
        className="nam-scene-generated-mic-panel-body"
      />
      <SceneStudioBadge x={376} y={272} width={184} label="OPENSTUDIO" />
      <text x="892" y="126" className="nam-scene-mic-card-title" textAnchor="middle">MIC A</text>
      <text x="804" y="154" className="nam-scene-mic-card-subtitle" textAnchor="middle">DYNAMIC 57</text>
      <text x="1206" y="126" className="nam-scene-mic-card-title" textAnchor="middle">MIC B</text>
      <text x="1118" y="154" className="nam-scene-mic-card-subtitle" textAnchor="middle">RIBBON 121</text>
      <text x="1403" y="126" className="nam-scene-mixer-strip-title" textAnchor="middle">MIX</text>
      <text x="1382" y="164" className="nam-scene-mic-card-subtitle" textAnchor="middle">A</text>
      <text x="1424" y="164" className="nam-scene-mic-card-subtitle" textAnchor="middle">B</text>
      <text x="946" y="248" className="nam-scene-mic-card-subtitle" textAnchor="middle">POSITION</text>
      <text x="946" y="328" className="nam-scene-mic-card-subtitle" textAnchor="middle">PHASE</text>
      <text x="1258" y="248" className="nam-scene-mic-card-subtitle" textAnchor="middle">DISTANCE</text>
      <text x="1258" y="328" className="nam-scene-mic-card-subtitle" textAnchor="middle">AXIS</text>
    </g>
  );
}

function SceneEqRackBody({ scene }: { scene: NAMRackSceneManifest }) {
  const { width, height } = scene.artboard;
  const gridX = 282;
  const gridY = 182;
  const gridW = 802;
  const gridH = 350;
  const bands = ["65", "125", "250", "500", "1K", "2K", "4K", "8K", "16K", "LEVEL"];

  return (
    <g className="nam-scene-body nam-scene-body-rack nam-scene-body-eq-target">
      <rect x="18" y="46" width={width - 36} height={height - 110} rx="22" fill="#0b0d0f" filter="url(#sceneCabModuleShadow)" />
      <rect x="30" y="54" width={width - 60} height={height - 128} rx="18" fill="#252a2e" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
      <rect x="42" y="68" width={width - 84} height={height - 156} rx="14" fill="url(#sceneRackNoise)" opacity="0.22" />
      <rect x="42" y="68" width={width - 84} height={height - 156} rx="14" fill="url(#sceneRackFaceShade)" opacity="0.52" />
      <rect x="42" y="68" width={width - 84} height={height - 156} rx="14" fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="3" />
      <rect x="70" y="102" width="122" height="432" rx="16" fill="#20252a" stroke="rgba(255,255,255,0.09)" strokeWidth="2" />
      <text x="131" y="146" className="nam-scene-eq-section-title" textAnchor="middle">IN</text>
      <text x="131" y="494" className="nam-scene-eq-section-label" textAnchor="middle">ACTIVE</text>
      <rect x={gridX - 60} y={gridY - 34} width={gridW + 120} height={gridH + 86} rx="16" fill="#323940" stroke="rgba(215,224,230,0.2)" strokeWidth="3" />
      <rect x={gridX - 4} y={gridY - 8} width={gridW + 8} height={gridH + 18} rx="8" fill="rgba(210,218,224,0.08)" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
      <text x={gridX + gridW / 2} y={gridY - 6} className="nam-scene-eq-title" textAnchor="middle">OPENSTUDIO GRAPHIC EQ</text>
      {[-12, 0, 12].map((scale) => {
        const y = gridY + gridH / 2 - (scale / 24) * gridH;
        return (
          <g key={scale}>
            <line x1={gridX} x2={gridX + gridW} y1={y} y2={y} stroke={scale === 0 ? "rgba(226,232,236,0.34)" : "rgba(226,232,236,0.14)"} strokeWidth={scale === 0 ? 3 : 2} />
            <text x={gridX + 14} y={y + 7} className="nam-scene-eq-scale" textAnchor="start">{scale > 0 ? `+${scale}` : scale}</text>
            <text x={gridX + gridW - 14} y={y + 7} className="nam-scene-eq-scale" textAnchor="end">{scale > 0 ? `+${scale}` : scale}</text>
          </g>
        );
      })}
      {Array.from({ length: 13 }).map((_, index) => {
        const y = gridY + index * (gridH / 12);
        return <line key={index} x1={gridX} x2={gridX + gridW} y1={y} y2={y} stroke="rgba(226,232,236,0.08)" strokeWidth="1.5" />;
      })}
      {bands.map((band, index) => {
        const x = gridX + index * (gridW / (bands.length - 1));
        return (
          <g key={band}>
            <line x1={x} x2={x} y1={gridY} y2={gridY + gridH} stroke="rgba(226,232,236,0.1)" strokeWidth="2" />
            <text x={x} y={gridY + gridH + 54} className="nam-scene-eq-band" textAnchor="middle">{band}</text>
          </g>
        );
      })}
      <SceneScrew x={54} y={82} radius={9} />
      <SceneScrew x={width - 54} y={82} radius={9} />
      <SceneScrew x={54} y={height - 132} radius={9} />
      <SceneScrew x={width - 54} y={height - 132} radius={9} />
      <SceneDesignBodyImage
        assetId="rack-unit-body-deep"
        x={0}
        y={28}
        width={width}
        height={height - 80}
        className="nam-scene-generated-eq-body"
      />
      <text x="131" y="146" className="nam-scene-eq-section-title" textAnchor="middle">IN</text>
      <text x={gridX + gridW / 2} y={gridY - 6} className="nam-scene-eq-title" textAnchor="middle">OPENSTUDIO GRAPHIC EQ</text>
      <text x="131" y="494" className="nam-scene-eq-section-label" textAnchor="middle">ACTIVE</text>
      {bands.map((band, index) => {
        const x = gridX + index * (gridW / (bands.length - 1));
        return <text key={`generated-eq-band-${band}`} x={x} y={gridY + gridH + 54} className="nam-scene-eq-band" textAnchor="middle">{band}</text>;
      })}
    </g>
  );
}

function SceneDelayRackBody({ scene, active }: { scene: NAMRackSceneManifest; active: boolean }) {
  const { width, height } = scene.artboard;
  const knobControls = scene.controls.filter((control) => control.kind === "knob");
  const footswitchControls = scene.controls.filter((control) => control.kind === "footswitch");
  return (
    <g className="nam-scene-body nam-scene-body-rack nam-scene-body-delay-target">
      <rect x="0" y="0" width={width} height={height} rx="34" fill="#030405" />
      <rect x="14" y="24" width={width - 28} height={height - 90} rx="34" fill="#050607" filter="url(#sceneCabModuleShadow)" />
      <rect x="24" y="34" width={width - 48} height={height - 116} rx="28" fill="#101214" stroke="rgba(255,255,255,0.16)" strokeWidth="4" />
      <rect x="38" y="48" width={width - 76} height={height - 144} rx="25" fill="rgba(255,255,255,0.055)" />
      <rect x="54" y="62" width={width - 108} height={height - 184} rx="22" fill="url(#sceneBrushedBlack)" stroke="rgba(255,255,255,0.2)" strokeWidth="4" />
      <rect x="58" y="66" width={width - 116} height={height - 192} rx="20" fill="url(#scenePostRackBrush)" opacity="0.36" />
      <rect x="66" y="76" width={width - 132} height="18" rx="9" fill="rgba(255,255,255,0.09)" />
      <rect x="66" y={height - 148} width={width - 132} height="18" rx="9" fill="rgba(0,0,0,0.34)" />
      {Array.from({ length: 22 }).map((_, index) => (
        <line
          key={index}
          x1="84"
          x2={width - 84}
          y1={86 + index * 21}
          y2={86 + index * 21}
          stroke={index % 5 === 0 ? "rgba(255,255,255,0.055)" : "rgba(255,255,255,0.028)"}
          strokeWidth="2"
          opacity="0.72"
        />
      ))}
      <rect x="58" y="70" width="54" height={height - 202} rx="12" fill="url(#sceneRackRail)" opacity="0.62" stroke="rgba(255,255,255,0.11)" strokeWidth="2" />
      <rect x={width - 112} y="70" width="54" height={height - 202} rx="12" fill="url(#sceneRackRail)" opacity="0.62" stroke="rgba(255,255,255,0.11)" strokeWidth="2" />
      <rect x="84" y="106" width="250" height="430" rx="18" fill="rgba(255,255,255,0.038)" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
      <rect x="96" y="120" width="226" height="402" rx="13" fill="rgba(0,0,0,0.22)" stroke="rgba(255,255,255,0.045)" strokeWidth="2" />
      <rect x={width - 334} y="106" width="250" height="430" rx="18" fill="rgba(255,255,255,0.038)" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
      <rect x={width - 322} y="120" width="226" height="402" rx="13" fill="rgba(0,0,0,0.22)" stroke="rgba(255,255,255,0.045)" strokeWidth="2" />
      <rect x="372" y="98" width="536" height="168" rx="21" fill="rgba(0,0,0,0.54)" stroke="rgba(255,255,255,0.14)" strokeWidth="3" />
      <rect x="394" y="118" width="492" height="128" rx="14" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.06)" strokeWidth="2" />
      <rect x="382" y="294" width="516" height="236" rx="18" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.11)" strokeWidth="3" />
      <rect x="404" y="318" width="472" height="188" rx="14" fill="rgba(0,0,0,0.18)" stroke="rgba(255,255,255,0.04)" strokeWidth="2" />
      {knobControls.map((control) => {
        const radius = (control.diameter ?? Math.min(control.width, control.height)) / 2;
        const wellRadius = radius * 1.08;
        return (
          <g key={`${control.id}-delay-well`} aria-hidden="true">
            <circle cx={control.x} cy={control.y + radius * 0.1} r={wellRadius} fill="rgba(0,0,0,0.25)" />
            <circle cx={control.x} cy={control.y} r={wellRadius * 0.9} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="4" />
          </g>
        );
      })}
      {footswitchControls.map((control) => {
        const radius = (control.diameter ?? Math.min(control.width, control.height)) / 2;
        return (
          <g key={`${control.id}-delay-plate`} aria-hidden="true">
            <circle cx={control.x} cy={control.y} r={radius * 1.2} fill="rgba(0,0,0,0.24)" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
          </g>
        );
      })}
      <rect x="74" y="42" width={width - 148} height="12" rx="6" fill="rgba(255,255,255,0.16)" />
      <text x={width / 2} y="91" className="nam-scene-delay-kicker" textAnchor="middle">OPENSTUDIO TIME</text>
      <text x={width / 2} y="594" className="nam-scene-delay-brand" textAnchor="middle">{scene.device.title.toUpperCase()}</text>
      <path
        d={`M ${width / 2 - 142} 618 H ${width / 2 - 44} M ${width / 2 + 44} 618 H ${width / 2 + 142}`}
        fill="none"
        stroke="rgba(232,236,240,0.48)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d={`M ${width / 2 - 18} 618 C ${width / 2 - 18} 610 ${width / 2 - 6} 610 ${width / 2 - 6} 618 C ${width / 2 - 6} 626 ${width / 2 - 18} 626 ${width / 2 - 18} 618 M ${width / 2 + 6} 618 C ${width / 2 + 6} 610 ${width / 2 + 18} 610 ${width / 2 + 18} 618 C ${width / 2 + 18} 626 ${width / 2 + 6} 626 ${width / 2 + 6} 618`}
        fill="none"
        stroke="rgba(232,236,240,0.52)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect x="466" y="544" width="348" height="10" rx="5" fill={scene.device.accent} opacity={active ? 0.55 : 0.18} />
      <rect x="92" y={height - 92} width="70" height="24" rx="10" fill="#050607" />
      <rect x={width - 162} y={height - 92} width="70" height="24" rx="10" fill="#050607" />
      <SceneScrew x={70} y={84} radius={9} />
      <SceneScrew x={width - 70} y={84} radius={9} />
      <SceneScrew x={70} y={height - 124} radius={9} />
      <SceneScrew x={width - 70} y={height - 124} radius={9} />
      <SceneDesignBodyImage
        assetId="rack-unit-body-deep"
        x={0}
        y={0}
        width={width}
        height={height - 48}
        className="nam-scene-generated-delay-body"
      />
      <text x={width / 2} y="91" className="nam-scene-delay-kicker" textAnchor="middle">OPENSTUDIO TIME</text>
      <text x={width / 2} y="594" className="nam-scene-delay-brand" textAnchor="middle">{scene.device.title.toUpperCase()}</text>
      <rect x="466" y="544" width="348" height="10" rx="5" fill={scene.device.accent} opacity={active ? 0.55 : 0.18} />
    </g>
  );
}

function SceneModulatorPedalBody({ scene, active }: { scene: NAMRackSceneManifest; active: boolean }) {
  const { width, height } = scene.artboard;
  const knobControls = scene.controls.filter((control) => control.kind === "knob");
  return (
    <g className="nam-scene-body nam-scene-body-modulator-target">
      <rect x="32" y="34" width={width - 64} height={height - 64} rx="30" fill="#1b110e" filter="url(#sceneCabModuleShadow)" />
      <rect x="44" y="28" width={width - 88} height={height - 76} rx="26" fill="url(#sceneCopperPedal)" stroke="rgba(255,244,230,0.24)" strokeWidth="4" />
      <rect x="54" y="40" width={width - 108} height="42" rx="20" fill="rgba(255,238,218,0.16)" />
      <rect x="56" y={height - 104} width={width - 112} height="42" rx="20" fill="rgba(0,0,0,0.18)" />
      <rect x="70" y="58" width={width - 140} height={height - 134} rx="20" fill="url(#scenePedalGrain)" opacity="0.2" />
      <rect x="70" y="58" width={width - 140} height={height - 134} rx="20" fill="url(#sceneCopperSpeckle)" opacity="0.28" />
      <rect x="72" y="60" width={width - 144} height={height - 138} rx="18" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
      <rect x="96" y="84" width="182" height="316" rx="18" fill="rgba(18,12,11,0.6)" stroke="rgba(255,244,230,0.15)" strokeWidth="3" />
      <rect x="108" y="96" width="158" height="292" rx="12" fill="rgba(0,0,0,0.16)" stroke="rgba(255,244,230,0.05)" strokeWidth="2" />
      {Array.from({ length: 7 }).map((_, index) => (
        <path key={index} d={`M ${126 + index * 20} 110 C ${142 + index * 18} 158, ${110 + index * 24} 210, ${150 + index * 16} 282`} fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="7" strokeLinecap="round" />
      ))}
      <rect x="310" y="74" width="304" height="104" rx="16" fill="rgba(0,0,0,0.28)" stroke="rgba(255,244,230,0.12)" strokeWidth="3" />
      <rect x="320" y="82" width="282" height="86" rx="12" fill="#090b0d" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
      <path d="M 350 128 C 384 94, 416 160, 458 126 S 536 103, 572 132" fill="none" stroke={scene.device.accent} strokeWidth="5" strokeLinecap="round" opacity={active ? 0.88 : 0.44} />
      <rect x="330" y="190" width="260" height="48" rx="10" fill="rgba(0,0,0,0.38)" stroke="rgba(255,255,255,0.09)" strokeWidth="2" />
      <text x="460" y="221" className="nam-scene-modulator-selector" textAnchor="middle">CHORUS / VIB / PHASER</text>
      {knobControls.map((control) => {
        const radius = (control.diameter ?? Math.min(control.width, control.height)) / 2;
        return (
          <g key={`${control.id}-mod-well`} aria-hidden="true">
            <circle cx={control.x} cy={control.y + radius * 0.1} r={radius * 1.22} fill="rgba(0,0,0,0.18)" />
            <circle cx={control.x} cy={control.y} r={radius * 1.05} fill="none" stroke="rgba(255,244,230,0.12)" strokeWidth="4" />
          </g>
        );
      })}
      <text x="460" y="526" className="nam-scene-modulator-title" textAnchor="middle">{scene.device.title.toUpperCase()}</text>
      <path d="M 250 552 H 390 Q 460 514 530 552 H 672" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="4" strokeLinecap="round" />
      <rect x={width - 148} y="92" width="22" height="312" rx="11" fill="rgba(255,246,232,0.28)" />
      <rect x="126" y={height - 86} width="148" height="9" rx="5" fill={scene.device.accent} opacity={active ? 0.58 : 0.2} />
      <SceneScrew x={78} y={72} radius={9} />
      <SceneScrew x={width - 78} y={72} radius={9} />
      <SceneScrew x={78} y={height - 84} radius={9} />
      <SceneScrew x={width - 78} y={height - 84} radius={9} />
      <SceneDesignBodyImage
        assetId="wide-pedal-body-copper"
        x={0}
        y={20}
        width={width}
        height={height - 72}
        className="nam-scene-generated-mod-body"
      />
      <text x="460" y="526" className="nam-scene-modulator-title" textAnchor="middle">{scene.device.title.toUpperCase()}</text>
      <rect x="126" y={height - 86} width="148" height="9" rx="5" fill={scene.device.accent} opacity={active ? 0.58 : 0.2} />
    </g>
  );
}

function SceneReverbPedalBody({ scene, active }: { scene: NAMRackSceneManifest; active: boolean }) {
  const { width, height } = scene.artboard;
  const knobControls = scene.controls.filter((control) => control.kind === "knob");
  const footswitchControls = scene.controls.filter((control) => control.kind === "footswitch");
  return (
    <g className="nam-scene-body nam-scene-body-reverb-target">
      <rect x="66" y="60" width={width - 132} height={height - 126} rx="36" fill="rgba(0,0,0,0.18)" />
      <rect x="76" y="70" width={width - 152} height={height - 146} rx="30" fill="rgba(255,255,255,0.035)" />
      <rect x="92" y="94" width={width - 184} height={height - 202} rx="22" fill="url(#sceneBluePedal)" opacity="0.18" />
      <rect x="92" y="94" width={width - 184} height={height - 202} rx="22" fill="url(#scenePedalGrain)" opacity="0.09" />
      {knobControls.map((control) => {
        const radius = (control.diameter ?? Math.min(control.width, control.height)) / 2;
        return (
          <g key={`${control.id}-reverb-well`} aria-hidden="true">
            <circle cx={control.x} cy={control.y + radius * 0.08} r={radius * 1.14} fill="rgba(0,0,0,0.17)" />
            <circle cx={control.x} cy={control.y} r={radius * 0.98} fill="none" stroke="rgba(231,244,255,0.1)" strokeWidth="4" />
          </g>
        );
      })}
      {footswitchControls.map((control) => {
        const radius = (control.diameter ?? Math.min(control.width, control.height)) / 2;
        return (
          <g key={`${control.id}-reverb-plate`} aria-hidden="true">
            <circle cx={control.x} cy={control.y} r={radius * 1.12} fill="rgba(0,0,0,0.18)" stroke="rgba(231,244,255,0.11)" strokeWidth="5" />
          </g>
        );
      })}
      <text x={width / 2} y="92" className="nam-scene-reverb-kicker" textAnchor="middle">OPENSTUDIO SPACE</text>
      <text x={width / 2} y="740" className="nam-scene-reverb-title" textAnchor="middle" opacity={active ? 1 : 0.72}>{scene.device.title.toUpperCase()}</text>
      <path
        d={`M ${width / 2 - 104} 778 H ${width / 2 - 30} L ${width / 2} 760 L ${width / 2 + 30} 778 H ${width / 2 + 104}`}
        fill="none"
        stroke="rgba(229,240,250,0.66)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="360" y="988" className="nam-scene-reverb-footswitch-label" textAnchor="middle">ENGAGE</text>
      <SceneScrew x={82} y={82} radius={9} />
      <SceneScrew x={width - 82} y={82} radius={9} />
      <SceneScrew x={82} y={height - 102} radius={9} />
      <SceneScrew x={width - 82} y={height - 102} radius={9} />
      <SceneDesignBodyImage
        assetId="stompbox-body-navy"
        x={58}
        y={34}
        width={width - 116}
        height={height - 62}
        className="nam-scene-generated-reverb-body"
      />
      <text x={width / 2} y="92" className="nam-scene-reverb-kicker" textAnchor="middle">OPENSTUDIO SPACE</text>
      <text x={width / 2} y="740" className="nam-scene-reverb-title" textAnchor="middle" opacity={active ? 1 : 0.72}>{scene.device.title.toUpperCase()}</text>
      <text x="360" y="988" className="nam-scene-reverb-footswitch-label" textAnchor="middle">ENGAGE</text>
    </g>
  );
}

function qaData(scene: NAMRackSceneManifest, control: NAMRackSceneControl) {
  return {
    "data-scene-control": "true",
    "data-anchor-id": control.id,
    "data-param": control.paramId ?? "",
    "data-kind": control.kind,
    "data-expected-x": String(control.x),
    "data-expected-y": String(control.y),
    "data-expected-width": String(control.width),
    "data-expected-height": String(control.height),
    "data-expected-diameter": String(control.diameter ?? Math.min(control.width, control.height)),
    "data-artboard-width": String(scene.artboard.width),
    "data-artboard-height": String(scene.artboard.height),
  };
}

function SceneDeviceBody({ scene, active }: { scene: NAMRackSceneManifest; active: boolean }) {
  const { width, height } = scene.artboard;
  const title = scene.device.title.toUpperCase();
  const subtitle = scene.device.subtitle.toUpperCase();
  const accent = scene.device.accent;
  const bodyColor = scene.device.color;

  if (scene.skinId === "amp-head-design-a") return <SceneAmpHeadBody scene={scene} active={active} />;
  if (scene.skinId === "cab-room-design-a") return <SceneCabRoomBody scene={scene} />;
  if (scene.skinId === "post-stereo-delay-design-a") return <SceneDelayRackBody scene={scene} active={active} />;
  if (scene.skinId === "post-modulator-design-a") return <SceneModulatorPedalBody scene={scene} active={active} />;
  if (scene.skinId === "eq-rack-design-a") return <SceneEqRackBody scene={scene} />;
  if (scene.composition?.layout === "pre-fx-stompbox-row") return <ScenePreStompBoxBody scene={scene} active={active} />;
  if (scene.skinId === "post-reverb-design-a") return <SceneReverbPedalBody scene={scene} active={active} />;

  if (scene.device.kind === "amp") {
    return (
      <g className="nam-scene-body nam-scene-body-amp" data-original-amp={scene.device.originality}>
        <rect x="42" y="60" width={width - 84} height={height - 95} rx="42" fill="#111416" />
        <rect x="74" y="84" width={width - 148} height="286" rx="18" fill="#070808" opacity="0.88" />
        <rect x="118" y="102" width={width - 236} height="118" fill="url(#sceneGrille)" opacity="0.88" />
        <rect x="120" y="218" width={width - 240} height="86" fill="#0f1518" opacity="0.92" />
        <rect x="180" y="240" width={width - 360} height="12" rx="6" fill={accent} opacity={active ? 0.58 : 0.2} />
        <rect x="250" y="267" width={width - 500} height="9" rx="5" fill={accent} opacity={active ? 0.36 : 0.14} />
        <rect x="220" y="36" width="360" height="48" rx="20" fill="#171a1b" />
        <rect x="705" y="38" width="190" height="36" rx="14" fill="#262929" opacity="0.8" />
        <rect x="74" y="370" width={width - 148} height="132" rx="12" fill="#232526" />
        <rect x="120" y="394" width={width - 240} height="84" rx="6" fill="#191b1c" />
        <text x="768" y="330" className="nam-scene-title nam-scene-title-amp" textAnchor="middle">{title}</text>
        <text x="768" y="350" className="nam-scene-subtitle" textAnchor="middle">{subtitle}</text>
      </g>
    );
  }

  if (scene.device.kind === "cab") {
    return (
      <g className="nam-scene-body nam-scene-body-cab">
        <rect x="120" y="92" width={width - 240} height="440" rx="28" fill="#101214" />
        <rect x="165" y="125" width={width - 330} height="365" rx="18" fill="#070809" opacity="0.9" />
        <circle cx="520" cy="310" r="178" fill="url(#sceneSpeaker)" />
        <circle cx="1015" cy="310" r="178" fill="url(#sceneSpeaker)" />
        <rect x="280" y="136" width="975" height="18" rx="9" fill={accent} opacity="0.26" />
        <text x="768" y="515" className="nam-scene-title nam-scene-title-cab" textAnchor="middle">{title}</text>
      </g>
    );
  }

  if (scene.device.kind === "rack") {
    return (
      <g className="nam-scene-body nam-scene-body-rack">
        <rect x="30" y="42" width={width - 60} height={height - 86} rx="28" fill="#1b1d1f" />
        <rect x="80" y="82" width={width - 160} height={height - 166} rx="14" fill={bodyColor} />
        <rect x="92" y="94" width={width - 184} height={height - 190} rx="10" fill="url(#sceneRackNoise)" opacity="0.46" />
        <rect x="80" y="82" width="28" height={height - 166} fill="#aeb5bd" opacity="0.58" />
        <rect x={width - 108} y="82" width="28" height={height - 166} fill="#aeb5bd" opacity="0.58" />
        <text x={width / 2} y={height - 105} className="nam-scene-title nam-scene-title-rack" textAnchor="middle">{title}</text>
        <text x={width / 2} y={height - 74} className="nam-scene-subtitle" textAnchor="middle">{subtitle}</text>
      </g>
    );
  }

  return (
    <g className="nam-scene-body nam-scene-body-pedal">
      <rect x="38" y="32" width={width - 76} height={height - 64} rx="26" fill="#090a0b" opacity="0.22" />
      <rect x="48" y="28" width={width - 96} height={height - 90} rx="24" fill={bodyColor} />
      <rect x="68" y="52" width={width - 136} height={height - 138} rx="16" fill="url(#scenePedalGrain)" opacity="0.32" />
      <rect x="68" y="52" width={width - 136} height={height - 138} rx="16" fill="none" stroke="rgba(255,255,255,0.26)" strokeWidth="2" />
      <circle cx="88" cy="82" r="11" fill="#d8d8d3" opacity="0.38" />
      <circle cx={width - 88} cy="82" r="11" fill="#d8d8d3" opacity="0.38" />
      <circle cx="88" cy={height - 118} r="11" fill="#d8d8d3" opacity="0.32" />
      <circle cx={width - 88} cy={height - 118} r="11" fill="#d8d8d3" opacity="0.32" />
      <text x={width / 2} y={height * 0.66} className="nam-scene-title nam-scene-title-pedal" textAnchor="middle">{title}</text>
      <path d={`M ${width * 0.28} ${height * 0.705} H ${width * 0.44} Q ${width * 0.5} ${height * 0.665} ${width * 0.56} ${height * 0.705} H ${width * 0.72}`} fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="3" />
      <text x={width / 2} y={height - 70} className="nam-scene-subtitle" textAnchor="middle">{subtitle}</text>
    </g>
  );
}

function SceneKnob({
  scene,
  control,
  param,
  onParamChange,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const pct = param ? normalizeParam(param) : 0.5;
  const diameter = control.diameter ?? Math.min(control.width, control.height);
  const radius = diameter / 2;
  const assetSize = diameter * 1.16;
  const assetX = control.x - assetSize / 2;
  const assetY = control.y - assetSize / 2;
  const [minAngle, maxAngle] = control.rotationRange ?? [-132, 132];
  const angle = minAngle + (maxAngle - minAngle) * pct;
  const assetId = designKnobAssetId(scene);
  const text = param ? formatParamValue(param) : "";
  const knobLabelPlacement = labelPlacement(scene, control, "below");
  const knobValuePlacement = valuePlacement(control, "hidden");

  return (
    <g
      className="nam-scene-control nam-scene-knob"
      data-bound={controlLooksBound(control, param)}
      data-renderer="generated-png-v1"
      data-control-asset={assetId}
      style={{ "--nam-scene-z": control.zIndex ?? 8 } as CSSProperties}
    >
      <SceneDesignControlImage
        assetId={assetId}
        x={assetX}
        y={assetY}
        width={assetSize}
        height={assetSize}
        className="nam-scene-control-visual nam-scene-knob-raster"
        transform={`rotate(${angle} ${control.x} ${control.y})`}
        qa={{ ...qaData(scene, control), "data-control-asset": assetId, "data-angle": angle.toFixed(2) }}
      />
      {knobLabelPlacement === "above" && <text x={control.x} y={control.y - radius - 18} className="nam-scene-label" textAnchor="middle">{control.label}</text>}
      {knobLabelPlacement === "inside" && <text x={control.x} y={control.y + 7} className="nam-scene-label nam-scene-label-inside" textAnchor="middle">{control.label}</text>}
      {knobLabelPlacement === "below" && <text x={control.x} y={control.y + radius + 30} className="nam-scene-label" textAnchor="middle">{control.label}</text>}
      {param && knobValuePlacement === "above" && <text x={control.x} y={control.y - radius - 38} className="nam-scene-value" textAnchor="middle">{text}</text>}
      {param && knobValuePlacement === "inside" && <text x={control.x} y={control.y + radius * 0.34} className="nam-scene-value" textAnchor="middle">{text}</text>}
      {param && knobValuePlacement === "below" && <text x={control.x} y={control.y + radius + 52} className="nam-scene-value" textAnchor="middle">{text}</text>}
      <ControlInteractionRect control={control} param={param} onParamChange={onParamChange} />
    </g>
  );
}

function SceneSwitch({
  scene,
  control,
  param,
  onParamChange,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const rect = controlRect(control);
  const active = controlActive(control, param);
  const leverAngle = active ? 18 : -18;
  const switchLabelPlacement = labelPlacement(scene, control, "above");
  return (
    <g
      className="nam-scene-control nam-scene-switch"
      data-bound={controlLooksBound(control, param)}
      data-renderer="generated-png-v1"
      data-control-asset="toggle-chrome-top"
      style={{ "--nam-scene-z": control.zIndex ?? 8 } as CSSProperties}
    >
      <SceneDesignControlImage
        assetId="toggle-chrome-top"
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        className="nam-scene-control-visual nam-scene-switch-raster"
        transform={`rotate(${leverAngle} ${control.x} ${control.y})`}
        qa={{ ...qaData(scene, control), "data-control-asset": "toggle-chrome-top" }}
      />
      {switchLabelPlacement === "above" && <text x={control.x} y={rect.y - 12} className="nam-scene-label" textAnchor="middle">{control.label}</text>}
      {switchLabelPlacement === "below" && <text x={control.x} y={rect.y + rect.height + 26} className="nam-scene-label" textAnchor="middle">{control.label}</text>}
      {switchLabelPlacement === "inside" && <text x={control.x} y={control.y + 6} className="nam-scene-label nam-scene-label-inside" textAnchor="middle">{control.label}</text>}
      <ControlInteractionRect control={control} param={param} onParamChange={onParamChange} toggleOnly />
    </g>
  );
}

function SceneButton({
  scene,
  control,
  param,
  onParamChange,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const rect = controlRect(control);
  const active = controlActive(control, param);
  return (
    <g
      className="nam-scene-control nam-scene-button"
      data-bound={controlLooksBound(control, param)}
      data-renderer="generated-png-v1"
      data-control-asset="button-black-top"
      style={{ "--nam-scene-z": control.zIndex ?? 9 } as CSSProperties}
    >
      <SceneDesignControlImage
        assetId="button-black-top"
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        className="nam-scene-control-visual nam-scene-button-raster"
        qa={{ ...qaData(scene, control), "data-control-asset": "button-black-top", "data-active": String(active) }}
      />
      {active && <rect x={rect.x + rect.width * 0.25} y={rect.y + rect.height * 0.25} width={rect.width * 0.5} height={rect.height * 0.5} rx="8" fill={scene.device.accent} opacity="0.24" />}
      <text x={control.x} y={control.y + 6} className="nam-scene-button-label" textAnchor="middle">{control.label ?? (param ? formatParamValue(param) : "")}</text>
      <ControlInteractionRect control={control} param={param} onParamChange={onParamChange} toggleOnly />
    </g>
  );
}

function SceneDisplay({
  scene,
  control,
  device,
  param,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  device: NAMRackSceneStageDevice;
  param?: BuiltInParamDescriptor;
}) {
  if (scene.skinId === "post-stereo-delay-design-a" && control.id === "delay-display") {
    return <SceneStereoDelayDisplay scene={scene} control={control} device={device} />;
  }
  if (scene.skinId === "post-modulator-design-a" && control.id === "mod-display") {
    return <SceneModulatorDisplay scene={scene} control={control} device={device} />;
  }
  if (scene.composition?.layout === "pre-fx-stompbox-row") {
    return <ScenePrePedalDisplay scene={scene} control={control} device={device} />;
  }

  const rect = controlRect(control);
  return (
    <g className="nam-scene-control nam-scene-display" data-bound="true" style={{ "--nam-scene-z": control.zIndex ?? 6 } as CSSProperties}>
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="10" fill="#070809" stroke="rgba(255,255,255,0.18)" strokeWidth="2" {...qaData(scene, control)} />
      <rect x={rect.x + 8} y={rect.y + 8} width={rect.width - 16} height={rect.height - 16} rx="7" fill="rgba(255,255,255,0.035)" />
      <text x={control.x} y={control.y + 7} className="nam-scene-display-text" textAnchor="middle">{displayText(control, device, param)}</text>
    </g>
  );
}

function ScenePrePedalDisplay({
  scene,
  control,
  device,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  device: NAMRackSceneStageDevice;
}) {
  const rect = controlRect(control);
  const text = displayText(control, device).toUpperCase();
  return (
    <g className="nam-scene-control nam-scene-display nam-scene-pre-display" data-bound="true" style={{ "--nam-scene-z": control.zIndex ?? 6 } as CSSProperties}>
      <rect x={rect.x + 2} y={rect.y + 7} width={rect.width - 4} height={rect.height - 2} rx="10" fill="rgba(0,0,0,0.4)" />
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="9" fill="#08090a" stroke="rgba(255,255,255,0.18)" strokeWidth="3" {...qaData(scene, control)} />
      <rect x={rect.x + 10} y={rect.y + 9} width={rect.width - 20} height={Math.max(8, rect.height * 0.24)} rx="5" fill="rgba(255,255,255,0.055)" />
      <text x={control.x} y={control.y + 7} className="nam-scene-display-text nam-scene-pre-plaque-text" textAnchor="middle">{text}</text>
    </g>
  );
}

function SceneStereoDelayDisplay({
  scene,
  control,
  device,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  device: NAMRackSceneStageDevice;
}) {
  const rect = controlRect(control);
  const parts = device.display.trim().split(/\s+/);
  const bpmText = parts[parts.length - 1] ?? "110.0";
  const timeText = parts.length > 1 ? parts.slice(0, -1).join(" ") : device.display;
  const centerX = control.x;
  const paneWidth = rect.width * 0.29;
  const paneHeight = rect.height * 0.62;
  const paneY = control.y - paneHeight / 2;
  const leftPaneX = rect.x + rect.width * 0.055;
  const rightPaneX = rect.x + rect.width - rect.width * 0.055 - paneWidth;

  return (
    <g className="nam-scene-control nam-scene-display nam-scene-delay-display" data-bound="true" style={{ "--nam-scene-z": control.zIndex ?? 6 } as CSSProperties}>
      <rect x={rect.x + 4} y={rect.y + 8} width={rect.width - 8} height={rect.height - 4} rx="14" fill="rgba(0,0,0,0.42)" />
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="14" fill="#050607" stroke="rgba(255,255,255,0.24)" strokeWidth="3" {...qaData(scene, control)} />
      <rect x={rect.x + 14} y={rect.y + 12} width={rect.width - 28} height={rect.height - 24} rx="10" fill="rgba(255,255,255,0.025)" />
      <rect x={leftPaneX} y={paneY} width={paneWidth} height={paneHeight} rx="8" fill="url(#sceneDelayGlass)" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
      <rect x={rightPaneX} y={paneY} width={paneWidth} height={paneHeight} rx="8" fill="url(#sceneDelayGlass)" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
      <rect x={leftPaneX + 8} y={paneY + 7} width={paneWidth - 16} height={paneHeight * 0.22} rx="5" fill="rgba(255,255,255,0.05)" />
      <rect x={rightPaneX + 8} y={paneY + 7} width={paneWidth - 16} height={paneHeight * 0.22} rx="5" fill="rgba(255,255,255,0.05)" />
      <text x={leftPaneX + paneWidth / 2} y={control.y + 13} className="nam-scene-display-text nam-scene-delay-digit" textAnchor="middle">{timeText}</text>
      <text x={rightPaneX + paneWidth / 2} y={control.y + 13} className="nam-scene-display-text nam-scene-delay-digit" textAnchor="middle">{bpmText}</text>
      <g className="nam-scene-delay-status">
        <text x={centerX - 40} y={control.y - 26} textAnchor="end">MS</text>
        <circle cx={centerX - 24} cy={control.y - 31} r="5" />
        <text x={centerX - 40} y={control.y + 5} textAnchor="end">BPM</text>
        <circle cx={centerX - 24} cy={control.y} r="5" data-on="true" />
        <text x={centerX - 40} y={control.y + 36} textAnchor="end">HOST</text>
        <circle cx={centerX - 24} cy={control.y + 31} r="5" />
        <text x={centerX + 40} y={control.y + 5}>TAP</text>
        <circle cx={centerX + 24} cy={control.y} r="5" data-on="true" />
      </g>
    </g>
  );
}

function SceneModulatorDisplay({
  scene,
  control,
  device,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  device: NAMRackSceneStageDevice;
}) {
  const rect = controlRect(control);
  return (
    <g className="nam-scene-control nam-scene-display nam-scene-mod-display" data-bound="true" style={{ "--nam-scene-z": control.zIndex ?? 6 } as CSSProperties}>
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="8" fill="#060708" stroke="rgba(255,255,255,0.18)" strokeWidth="2" {...qaData(scene, control)} />
      <path
        d={`M ${rect.x + 24} ${control.y} C ${rect.x + 56} ${rect.y + 18}, ${rect.x + 78} ${rect.y + 18}, ${rect.x + 110} ${control.y} S ${rect.x + 166} ${rect.y + rect.height - 18}, ${rect.x + rect.width - 24} ${control.y}`}
        fill="none"
        stroke={scene.device.accent}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <text x={control.x} y={rect.y - 16} className="nam-scene-label" textAnchor="middle">Wave</text>
      <text x={control.x} y={rect.y + rect.height + 24} className="nam-scene-value" textAnchor="middle">{displayText(control, device)}</text>
    </g>
  );
}

function SceneFootswitch({
  scene,
  control,
  param,
  active,
  onParamChange,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  param?: BuiltInParamDescriptor;
  active: boolean;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const diameter = control.diameter ?? Math.min(control.width, control.height) * 0.78;
  const radius = diameter / 2;
  const assetId = designFootswitchAssetId(active);
  const assetSize = diameter * 1.24;
  const assetX = control.x - assetSize / 2;
  const assetY = control.y - assetSize / 2;
  const footLabelPlacement = labelPlacement(scene, control, "below");
  const hasSeparatePreLed = scene.composition?.layout === "pre-fx-stompbox-row";
  return (
    <g
      className="nam-scene-control nam-scene-footswitch"
      data-bound={controlLooksBound(control, param)}
      data-renderer="generated-png-v1"
      data-control-asset={assetId}
      style={{ "--nam-scene-z": control.zIndex ?? 9 } as CSSProperties}
    >
      <SceneDesignControlImage
        assetId={assetId}
        x={assetX}
        y={assetY}
        width={assetSize}
        height={assetSize}
        className="nam-scene-control-visual nam-scene-footswitch-raster"
        qa={{ ...qaData(scene, control), "data-control-asset": assetId, "data-active": String(active) }}
      />
      {!hasSeparatePreLed && (
        <SceneLedImage
          scene={scene}
          control={control}
          active={active}
          cx={control.x}
          cy={control.y - radius - 55}
          diameter={44}
          className="nam-scene-footswitch-led"
        />
      )}
      {footLabelPlacement === "above" && <text x={control.x} y={control.y - radius - 18} className="nam-scene-label" textAnchor="middle">{control.label}</text>}
      {footLabelPlacement === "below" && <text x={control.x} y={control.y + radius + 38} className="nam-scene-label" textAnchor="middle">{control.label}</text>}
      {footLabelPlacement === "inside" && <text x={control.x} y={control.y + 7} className="nam-scene-label nam-scene-label-inside" textAnchor="middle">{control.label}</text>}
      <ControlInteractionRect control={control} param={param} onParamChange={onParamChange} toggleOnly />
    </g>
  );
}

function SceneLedImage({
  scene,
  control,
  active,
  cx,
  cy,
  diameter,
  className = "",
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  active: boolean;
  cx: number;
  cy: number;
  diameter: number;
  className?: string;
}) {
  const assetId = designLedAssetId(active);
  const assetSize = diameter * 1.25;
  return (
    <SceneDesignControlImage
      assetId={assetId}
      x={cx - assetSize / 2}
      y={cy - assetSize / 2}
      width={assetSize}
      height={assetSize}
      className={`nam-scene-control-raster nam-scene-led-raster ${className}`}
      qa={{ ...qaData(scene, control), "data-control-asset": assetId, "data-active": String(active) }}
    />
  );
}

function SceneFader({
  scene,
  control,
  param,
  onParamChange,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const rect = controlRect(control);
  const pct = param ? normalizeParam(param) : 0.5;
  const handleY = rect.y + rect.height - rect.height * pct;
  const faderValuePlacement = valuePlacement(control, scene.skinId === "eq-rack-design-a" ? "hidden" : "above");
  const faderLabelPlacement = labelPlacement(scene, control, "below");
  return (
    <g className="nam-scene-control nam-scene-fader" data-bound={controlLooksBound(control, param)} style={{ "--nam-scene-z": control.zIndex ?? 8 } as CSSProperties}>
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="8" fill="transparent" {...qaData(scene, control)} />
      <rect x={rect.x + rect.width * 0.36} y={rect.y} width={rect.width * 0.28} height={rect.height} rx="12" fill="#070809" stroke="rgba(255,255,255,0.28)" strokeWidth="2" />
      <line x1={control.x} x2={control.x} y1={rect.y + 18} y2={rect.y + rect.height - 18} stroke="rgba(255,255,255,0.18)" strokeWidth="3" />
      <SceneDesignControlImage
        assetId="slider-metal-top"
        x={rect.x + 5}
        y={handleY - 18}
        width={rect.width - 10}
        height={36}
        className="nam-scene-control-visual nam-scene-fader-cap-raster"
        qa={{ ...qaData(scene, control), "data-control-asset": "slider-metal-top" }}
      />
      {faderValuePlacement === "above" && <text x={control.x} y={rect.y - 16} className="nam-scene-value" textAnchor="middle">{param ? formatParamValue(param) : "0.0 dB"}</text>}
      {faderValuePlacement === "below" && <text x={control.x} y={rect.y + rect.height + 56} className="nam-scene-value" textAnchor="middle">{param ? formatParamValue(param) : "0.0 dB"}</text>}
      {faderLabelPlacement === "above" && <text x={control.x} y={rect.y - 34} className="nam-scene-label" textAnchor="middle">{control.label}</text>}
      {faderLabelPlacement === "below" && <text x={control.x} y={rect.y + rect.height + 34} className="nam-scene-label" textAnchor="middle">{control.label}</text>}
      {faderLabelPlacement === "inside" && <text x={control.x} y={control.y + 7} className="nam-scene-label nam-scene-label-inside" textAnchor="middle">{control.label}</text>}
      <ControlInteractionRect control={control} param={param} onParamChange={onParamChange} />
    </g>
  );
}

function SceneTreadle({ scene, control, param, onParamChange }: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const rect = controlRect(control);
  const pct = param ? normalizeParam(param) : 0.5;
  if (scene.skinId === "post-modulator-design-a" && control.id === "mod-treadle") {
    return (
      <g className="nam-scene-control nam-scene-treadle nam-scene-treadle-skin-hitbox" data-bound={controlLooksBound(control, param)} style={{ "--nam-scene-z": control.zIndex ?? 8 } as CSSProperties}>
        <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="18" fill="transparent" stroke="transparent" strokeWidth="2" {...qaData(scene, control)} />
        {controlLabelNode(scene, control, control.x, rect.y + rect.height + 28)}
        <ControlInteractionRect control={control} param={param} onParamChange={onParamChange} />
      </g>
    );
  }
  return (
    <g className="nam-scene-control nam-scene-treadle" data-bound={controlLooksBound(control, param)} style={{ "--nam-scene-z": control.zIndex ?? 8 } as CSSProperties}>
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="18" fill="#111213" stroke="rgba(255,255,255,0.18)" strokeWidth="2" {...qaData(scene, control)} />
      <path d={`M ${rect.x + 24} ${rect.y + 28} C ${control.x - 30} ${control.y - 84}, ${control.x + 30} ${control.y - 84}, ${rect.x + rect.width - 24} ${rect.y + 28}`} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="8" />
      <rect x={rect.x + rect.width * 0.12} y={rect.y + rect.height * (0.1 + (1 - pct) * 0.55)} width={rect.width * 0.76} height={rect.height * 0.3} rx="14" fill="url(#sceneTreadleRubber)" />
      <line x1={rect.x + 24} x2={rect.x + rect.width - 24} y1={rect.y + rect.height * 0.82} y2={rect.y + rect.height * 0.82} stroke={scene.device.accent} strokeWidth="5" strokeLinecap="round" opacity="0.74" />
      {controlLabelNode(scene, control, control.x, rect.y + rect.height + 32)}
      <ControlInteractionRect control={control} param={param} onParamChange={onParamChange} />
    </g>
  );
}

function SceneMic({ scene, control, param, onParamChange }: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const rect = controlRect(control);
  const micTop = rect.y + 36;
  const micBodyHeight = rect.height * 0.52;
  return (
    <g className="nam-scene-control nam-scene-mic" data-bound={controlLooksBound(control, param)} style={{ "--nam-scene-z": control.zIndex ?? 8 } as CSSProperties}>
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="12" fill="transparent" {...qaData(scene, control)} />
      <ellipse cx={control.x} cy={control.y + rect.height * 0.13} rx={rect.width * 0.46} ry={rect.height * 0.35} fill="rgba(3,4,5,0.76)" />
      <ellipse cx={control.x} cy={control.y + rect.height * 0.16} rx={rect.width * 0.34} ry={rect.height * 0.27} fill="url(#sceneCabCone)" stroke="rgba(255,255,255,0.16)" strokeWidth="3" />
      <line x1={control.x} y1={micTop + micBodyHeight - 18} x2={control.x} y2={rect.y + rect.height - 20} stroke="#181b1e" strokeWidth="9" strokeLinecap="round" />
      <rect x={control.x - 19} y={micTop} width="38" height={micBodyHeight} rx="15" fill="url(#sceneMicMetal)" filter="url(#sceneMicShadow)" />
      <rect x={control.x - 14} y={micTop + 16} width="28" height={micBodyHeight - 30} rx="9" fill="rgba(245,248,247,0.42)" />
      {Array.from({ length: 7 }).map((_, index) => (
        <line
          key={index}
          x1={control.x - 13}
          x2={control.x + 13}
          y1={micTop + 24 + index * 13}
          y2={micTop + 24 + index * 13}
          stroke="rgba(25,29,31,0.26)"
          strokeWidth="2"
        />
      ))}
      <path d={`M ${control.x - 28} ${micTop + micBodyHeight - 4} C ${control.x - 20} ${micTop + micBodyHeight + 18}, ${control.x + 20} ${micTop + micBodyHeight + 18}, ${control.x + 28} ${micTop + micBodyHeight - 4}`} fill="none" stroke="rgba(18,21,23,0.78)" strokeWidth="8" strokeLinecap="round" />
      <SceneDesignControlImage
        assetId={designMicAssetId(control)}
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        preserveAspectRatio="xMidYMid meet"
        className="nam-scene-control-visual nam-scene-mic-raster"
        qa={{ ...qaData(scene, control), "data-control-asset": designMicAssetId(control) }}
      />
      {controlLabelNode(scene, control, control.x, rect.y + rect.height + 28)}
      <ControlInteractionRect control={control} param={param} onParamChange={onParamChange} />
    </g>
  );
}

function SceneLabel({ scene, control }: { scene: NAMRackSceneManifest; control: NAMRackSceneControl }) {
  const rect = controlRect(control);
  return (
    <g className="nam-scene-control nam-scene-text-anchor" data-bound="true" style={{ "--nam-scene-z": control.zIndex ?? 6 } as CSSProperties}>
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="10" fill="rgba(238,244,255,0.16)" stroke="rgba(255,255,255,0.18)" strokeWidth="2" {...qaData(scene, control)} />
      <text x={control.x} y={control.y + 6} className="nam-scene-label nam-scene-label-large" textAnchor="middle">{control.label}</text>
    </g>
  );
}

function SceneMeter({ scene, control }: { scene: NAMRackSceneManifest; control: NAMRackSceneControl }) {
  const rect = controlRect(control);
  return (
    <g className="nam-scene-control nam-scene-meter" data-bound="true" style={{ "--nam-scene-z": control.zIndex ?? 6 } as CSSProperties}>
      <rect className="nam-scene-control-visual" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="8" fill="rgba(3,6,9,0.52)" stroke="rgba(255,255,255,0.18)" strokeWidth="2" {...qaData(scene, control)} />
      <path d={`M ${rect.x + 20} ${control.y} H ${rect.x + rect.width - 20}`} stroke={scene.device.accent} strokeWidth="5" opacity="0.72" />
      {controlLabelNode(scene, control, control.x, rect.y - 10, "above")}
    </g>
  );
}

function SceneLed({ scene, control, active }: { scene: NAMRackSceneManifest; control: NAMRackSceneControl; active: boolean }) {
  const diameter = control.diameter ?? Math.min(control.width, control.height);
  return (
    <g
      className="nam-scene-control nam-scene-led"
      data-bound="true"
      data-renderer="generated-png-v1"
      style={{ "--nam-scene-z": control.zIndex ?? 7 } as CSSProperties}
    >
      <SceneLedImage scene={scene} control={control} active={active} cx={control.x} cy={control.y} diameter={diameter} className="nam-scene-control-visual" />
    </g>
  );
}

function ControlInteractionRect({
  control,
  param,
  onParamChange,
  toggleOnly = false,
}: {
  control: NAMRackSceneControl;
  param?: BuiltInParamDescriptor;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
  toggleOnly?: boolean;
}) {
  const dragRef = useRef<{
    startY: number;
    startNormalized: number;
    pointerId: number;
  } | null>(null);
  const rect = controlRect(control);

  const setAbsoluteFromPointer = (event: PointerEvent<SVGRectElement>) => {
    if (!param || toggleOnly) return;
    const targetRect = event.currentTarget.getBoundingClientRect();
    const pct = clampPercent(1 - (event.clientY - targetRect.top) / Math.max(targetRect.height, 1));
    onParamChange(
      param,
      quantizeParamValue(param, denormalizeParamValue(param, pct)),
    );
  };

  return (
    <rect
      className="nam-scene-hitbox"
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      rx="8"
      fill="transparent"
      role={param ? (toggleOnly ? "switch" : "slider") : undefined}
      tabIndex={param ? 0 : undefined}
      aria-label={param ? (control.label ?? param.label) : undefined}
      aria-checked={param && toggleOnly ? param.value >= 0.5 : undefined}
      aria-valuemin={param && !toggleOnly ? param.min : undefined}
      aria-valuemax={param && !toggleOnly ? param.max : undefined}
      aria-valuenow={param && !toggleOnly ? param.value : undefined}
      aria-valuetext={param && !toggleOnly ? formatParamValue(param) : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (param && toggleOnly) onParamChange(param, nextToggleValue(control, param));
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (param && !toggleOnly) {
          onParamChange(
            param,
            quantizeParamValue(param, param.defaultValue ?? param.min),
          );
        }
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!param) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          startY: event.clientY,
          startNormalized: normalizeParam(param),
          pointerId: event.pointerId,
        };
        if (control.kind === "fader" || control.kind === "treadle" || control.kind === "mic") setAbsoluteFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (!param || toggleOnly || !dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (control.kind === "fader" || control.kind === "treadle" || control.kind === "mic") {
          setAbsoluteFromPointer(event);
          return;
        }
        const deltaNormalized =
          (dragRef.current.startY - event.clientY) / 250;
        onParamChange(
          param,
          quantizeParamValue(
            param,
            denormalizeParamValue(
              param,
              dragRef.current.startNormalized + deltaNormalized,
            ),
          ),
        );
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      }}
      onWheel={(event: WheelEvent<SVGRectElement>) => {
        if (!param || toggleOnly) return;
        event.stopPropagation();
        event.preventDefault();
        const direction = event.deltaY > 0 ? -1 : 1;
        const multiplier = event.shiftKey ? 8 : 2;
        onParamChange(
          param,
          quantizeParamValue(
            param,
            offsetParamValue(param, param.value, direction * multiplier),
          ),
        );
      }}
      onKeyDown={(event) => {
        if (!param) return;
        if (toggleOnly) {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            onParamChange(param, nextToggleValue(control, param));
          }
          return;
        }

        let nextValue: number | undefined;
        if (event.key === "ArrowUp" || event.key === "ArrowRight") {
          nextValue = offsetParamValue(param, param.value, 1);
        } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
          nextValue = offsetParamValue(param, param.value, -1);
        } else if (event.key === "PageUp") {
          nextValue = offsetParamValue(param, param.value, 8);
        } else if (event.key === "PageDown") {
          nextValue = offsetParamValue(param, param.value, -8);
        } else if (event.key === "Home") {
          nextValue = param.min;
        } else if (event.key === "End") {
          nextValue = param.max;
        }

        if (nextValue !== undefined) {
          event.preventDefault();
          onParamChange(param, quantizeParamValue(param, nextValue));
        }
      }}
    />
  );
}

function SceneControlRenderer({
  scene,
  control,
  device,
  paramsById,
  onParamChange,
}: {
  scene: NAMRackSceneManifest;
  control: NAMRackSceneControl;
  device: NAMRackSceneStageDevice;
  paramsById: Map<string, BuiltInParamDescriptor>;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const param = control.paramId ? paramsById.get(control.paramId) : undefined;

  if (control.kind === "knob") return <SceneKnob scene={scene} control={control} param={param} onParamChange={onParamChange} />;
  if (control.kind === "switch") return <SceneSwitch scene={scene} control={control} param={param} onParamChange={onParamChange} />;
  if (control.kind === "button") return <SceneButton scene={scene} control={control} param={param} onParamChange={onParamChange} />;
  if (control.kind === "display") return <SceneDisplay scene={scene} control={control} device={device} param={param} />;
  if (control.kind === "footswitch") return <SceneFootswitch scene={scene} control={control} param={param} active={device.active} onParamChange={onParamChange} />;
  if (control.kind === "fader") return <SceneFader scene={scene} control={control} param={param} onParamChange={onParamChange} />;
  if (control.kind === "treadle") return <SceneTreadle scene={scene} control={control} param={param} onParamChange={onParamChange} />;
  if (control.kind === "mic") return <SceneMic scene={scene} control={control} param={param} onParamChange={onParamChange} />;
  if (control.kind === "meter") return <SceneMeter scene={scene} control={control} />;
  if (control.kind === "led") return <SceneLed scene={scene} control={control} active={device.active} />;
  return <SceneLabel scene={scene} control={control} />;
}

export function NAMRackSceneDevice({
  sectionId,
  device,
  scene,
  activeModule,
  visualMode,
  onFocusDevice,
  onParamChange,
}: {
  sectionId: RackSectionId;
  device: NAMRackSceneStageDevice;
  scene: NAMRackSceneManifest;
  activeModule: RackModuleId;
  visualMode: NAMRackVisualMode;
  onFocusDevice: (sectionId: RackSectionId, moduleId?: RackModuleId) => void;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const paramsById = new Map(device.params.map((param) => [param.id, param]));
  const moduleId = device.moduleId ?? device.skin.moduleId ?? device.skin.id;
  const sortedControls = [...scene.controls].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  const isAmp = scene.device.kind === "amp";
  const sceneClipId = `nam-scene-clip-${sceneDomIdPart(scene.id)}-${sceneDomIdPart(String(moduleId))}`;
  const sceneViewportStyle = {
    "--nam-scene-aspect": `${scene.artboard.width} / ${scene.artboard.height}`,
  } as CSSProperties;

  return (
    <article
      className="nam-neural-device nam-scene-device"
      data-scene-graph="true"
      data-section={sectionId}
      data-skin={device.skin.id}
      data-module={moduleId}
      data-material={device.skin.material}
      data-active={device.active}
      data-focused={device.moduleId ? activeModule === device.moduleId : false}
      data-original-amp={isAmp ? scene.device.originality : undefined}
      style={sceneViewportStyle}
      onClick={() => onFocusDevice(sectionId, device.moduleId)}
    >
      <svg
        className="nam-scene-device-svg"
        viewBox={`0 0 ${scene.artboard.width} ${scene.artboard.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${sceneTitle(scene, device)} hardware controls`}
      >
        <defs>
          <clipPath id={sceneClipId} clipPathUnits="userSpaceOnUse">
            <rect x="0" y="0" width={scene.artboard.width} height={scene.artboard.height} />
          </clipPath>
          <linearGradient id="sceneButtonDark" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2a2c2e" />
            <stop offset="44%" stopColor="#111214" />
            <stop offset="100%" stopColor="#040506" />
          </linearGradient>
          <linearGradient id="sceneButtonActive" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#f48d83" />
            <stop offset="52%" stopColor="#d95f58" />
            <stop offset="100%" stopColor="#90352f" />
          </linearGradient>
          <radialGradient id="sceneSwitchPocket" cx="50%" cy="44%" r="74%">
            <stop offset="0%" stopColor="#282b2d" />
            <stop offset="58%" stopColor="#0b0c0d" />
            <stop offset="100%" stopColor="#020303" />
          </radialGradient>
          <radialGradient id="sceneSwitchWasher" cx="42%" cy="30%" r="74%">
            <stop offset="0%" stopColor="#f0ece2" />
            <stop offset="46%" stopColor="#7d7b74" />
            <stop offset="100%" stopColor="#171817" />
          </radialGradient>
          <linearGradient id="sceneSwitchLever" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#2d2e2e" />
            <stop offset="45%" stopColor="#f3efe4" />
            <stop offset="100%" stopColor="#5e5d58" />
          </linearGradient>
          <linearGradient id="sceneFaderCap" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ecebe3" />
            <stop offset="48%" stopColor="#777a78" />
            <stop offset="100%" stopColor="#1b1c1d" />
          </linearGradient>
          <linearGradient id="sceneTreadleRubber" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#323538" />
            <stop offset="52%" stopColor="#0c0d0e" />
            <stop offset="100%" stopColor="#232629" />
          </linearGradient>
          <radialGradient id="sceneScrew" cx="38%" cy="28%" r="78%">
            <stop offset="0%" stopColor="#f2eee2" />
            <stop offset="42%" stopColor="#8f8d86" />
            <stop offset="78%" stopColor="#333535" />
            <stop offset="100%" stopColor="#070808" />
          </radialGradient>
          <linearGradient id="sceneAmpCase" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#23282b" />
            <stop offset="42%" stopColor="#14181b" />
            <stop offset="100%" stopColor="#090b0d" />
          </linearGradient>
          <pattern id="sceneAmpTolex" width="18" height="18" patternUnits="userSpaceOnUse">
            <rect width="18" height="18" fill="rgba(255,255,255,0.035)" />
            <path d="M0 4 C5 1, 8 7, 14 3 M2 15 C7 11, 11 18, 18 12 M-2 10 C4 7, 9 13, 18 8" stroke="rgba(255,255,255,0.055)" strokeWidth="1.4" fill="none" />
            <path d="M1 1 L5 1 M11 6 L16 6 M7 14 L12 14" stroke="rgba(0,0,0,0.22)" strokeWidth="1" />
          </pattern>
          <radialGradient id="sceneGrilleGlow" cx="50%" cy="20%" r="88%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.24)" />
            <stop offset="52%" stopColor="rgba(255,255,255,0.02)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.52)" />
          </radialGradient>
          <linearGradient id="sceneBrushedBlack" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#272a2d" />
            <stop offset="34%" stopColor="#111316" />
            <stop offset="64%" stopColor="#222529" />
            <stop offset="100%" stopColor="#060708" />
          </linearGradient>
          <linearGradient id="sceneDelayGlass" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#111417" />
            <stop offset="44%" stopColor="#050608" />
            <stop offset="100%" stopColor="#16191c" />
          </linearGradient>
          <pattern id="scenePostRackBrush" width="44" height="12" patternUnits="userSpaceOnUse">
            <rect width="44" height="12" fill="rgba(255,255,255,0.016)" />
            <path d="M0 2 H44 M0 6 H44 M0 10 H44" stroke="rgba(255,255,255,0.045)" strokeWidth="1" />
            <path d="M3 4 H18 M25 8 H42" stroke="rgba(0,0,0,0.22)" strokeWidth="1" />
          </pattern>
          <pattern id="sceneCopperSpeckle" width="28" height="28" patternUnits="userSpaceOnUse">
            <rect width="28" height="28" fill="transparent" />
            <circle cx="5" cy="7" r="1.2" fill="rgba(255,239,220,0.12)" />
            <circle cx="19" cy="11" r="1" fill="rgba(255,239,220,0.09)" />
            <circle cx="12" cy="23" r="1.1" fill="rgba(0,0,0,0.12)" />
            <path d="M1 18 H12 M16 4 H27" stroke="rgba(255,239,220,0.045)" strokeWidth="1" />
          </pattern>
          <linearGradient id="sceneCopperPedal" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#d7a385" />
            <stop offset="38%" stopColor="#9a6753" />
            <stop offset="70%" stopColor="#6f453b" />
            <stop offset="100%" stopColor="#3a2522" />
          </linearGradient>
          <linearGradient id="sceneBluePedal" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#6f98c7" />
            <stop offset="42%" stopColor="#345d88" />
            <stop offset="74%" stopColor="#1e3658" />
            <stop offset="100%" stopColor="#111d32" />
          </linearGradient>
          <linearGradient id="sceneMicMetal" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#82878b" />
            <stop offset="44%" stopColor="#f5f2ea" />
            <stop offset="100%" stopColor="#687078" />
          </linearGradient>
          <linearGradient id="sceneJackMetal" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#1b1d1f" />
            <stop offset="30%" stopColor="#f0ebe0" />
            <stop offset="54%" stopColor="#77756e" />
            <stop offset="100%" stopColor="#151719" />
          </linearGradient>
          <linearGradient id="scenePrePedalFace" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.42)" />
            <stop offset="34%" stopColor="rgba(255,255,255,0.08)" />
            <stop offset="72%" stopColor="rgba(0,0,0,0.18)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.38)" />
          </linearGradient>
          <filter id="sceneMicShadow" x="-80%" y="-40%" width="260%" height="190%">
            <feDropShadow dx="0" dy="8" stdDeviation="5" floodColor="#000000" floodOpacity="0.55" />
          </filter>
          <filter id="sceneCabModuleShadow" x="-12%" y="-12%" width="124%" height="132%">
            <feDropShadow dx="0" dy="18" stdDeviation="12" floodColor="#122033" floodOpacity="0.3" />
          </filter>
          <linearGradient id="sceneRackRail" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#080909" />
            <stop offset="18%" stopColor="#72706b" />
            <stop offset="48%" stopColor="#1a1c1e" />
            <stop offset="78%" stopColor="#85837e" />
            <stop offset="100%" stopColor="#080909" />
          </linearGradient>
          <radialGradient id="sceneRackFaceShade" cx="50%" cy="8%" r="88%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
            <stop offset="42%" stopColor="rgba(0,0,0,0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.62)" />
          </radialGradient>
          <radialGradient id="sceneSpeaker" cx="50%" cy="54%" r="58%">
            <stop offset="0%" stopColor="#858585" />
            <stop offset="44%" stopColor="#202122" />
            <stop offset="100%" stopColor="#050606" />
          </radialGradient>
          <radialGradient id="sceneCabCone" cx="50%" cy="58%" r="62%">
            <stop offset="0%" stopColor="#bfc1bc" />
            <stop offset="46%" stopColor="#1d1f20" />
            <stop offset="100%" stopColor="#030404" />
          </radialGradient>
          <pattern id="sceneGrille" width="12" height="12" patternUnits="userSpaceOnUse">
            <rect width="12" height="12" fill="#222" />
            <path d="M0 2 H12 M0 8 H12" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
          </pattern>
          <pattern id="sceneAmpGrille" width="30" height="26" patternUnits="userSpaceOnUse">
            <rect width="30" height="26" fill="#060707" />
            <path
              d="M7.5 1 L15 5.5 L15 14.5 L7.5 19 L0 14.5 L0 5.5 Z M22.5 1 L30 5.5 L30 14.5 L22.5 19 L15 14.5 L15 5.5 Z M7.5 19 L15 23.5 L15 32.5 L7.5 37 L0 32.5 L0 23.5 Z M22.5 19 L30 23.5 L30 32.5 L22.5 37 L15 32.5 L15 23.5 Z"
              fill="none"
              stroke="rgba(210,218,222,0.18)"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
            <path
              d="M7.5 2.5 L13.5 6.2 L13.5 13.8 L7.5 17.5 L1.5 13.8 L1.5 6.2 Z M22.5 2.5 L28.5 6.2 L28.5 13.8 L22.5 17.5 L16.5 13.8 L16.5 6.2 Z"
              fill="rgba(255,255,255,0.018)"
              stroke="rgba(0,0,0,0.72)"
              strokeWidth="1"
            />
            <path d="M0 0 H30 M0 13 H30 M0 26 H30" stroke="rgba(255,255,255,0.03)" strokeWidth="0.8" />
          </pattern>
          <pattern id="sceneCabGrille" width="18" height="18" patternUnits="userSpaceOnUse">
            <rect width="18" height="18" fill="#121314" />
            <path d="M0 5 H18 M0 13 H18 M5 0 V18 M13 0 V18" stroke="rgba(255,255,255,0.055)" strokeWidth="2" />
          </pattern>
          <pattern id="scenePedalGrain" width="16" height="16" patternUnits="userSpaceOnUse">
            <rect width="16" height="16" fill="rgba(255,255,255,0.1)" />
            <path d="M1 1 L3 1 M10 4 L13 4 M5 12 L8 12" stroke="rgba(0,0,0,0.22)" strokeWidth="1" />
          </pattern>
          <pattern id="sceneRackNoise" width="10" height="10" patternUnits="userSpaceOnUse">
            <rect width="10" height="10" fill="rgba(255,255,255,0.06)" />
            <circle cx="3" cy="3" r="0.8" fill="rgba(0,0,0,0.25)" />
            <circle cx="8" cy="7" r="0.7" fill="rgba(255,255,255,0.14)" />
          </pattern>
          <filter id="sceneLedGlow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="9" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className="nam-scene-artboard" clipPath={`url(#${sceneClipId})`}>
          <SceneDeviceBody scene={scene} active={device.active} />
          {sortedControls.map((control) => (
            <SceneControlRenderer
              key={control.id}
              scene={scene}
              control={control}
              device={device}
              paramsById={paramsById}
              onParamChange={onParamChange}
            />
          ))}
          {visualMode === "debug-anchors" && (
            <g className="nam-scene-debug-layer">
              {scene.controls.map((control) => {
                const rect = controlRect(control);
                return (
                  <rect
                    key={control.id}
                    className="nam-scene-debug-rect"
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    rx="8"
                  />
                );
              })}
            </g>
          )}
          </g>
      </svg>
      <span className="nam-scene-screen-reader">{sceneSubtitle(scene, device)}</span>
    </article>
  );
}

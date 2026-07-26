import { type CSSProperties, type ReactNode } from "react";
import { Library } from "lucide-react";
import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import { footswitchAssetForState, ledAssetForState } from "./NAMRackControlAssets";

export type RackModuleId = "gate" | "pedal" | "amp" | "cab" | "eq" | "mod" | "delay" | "reverb";
export type PedalFaceplateModuleId = Exclude<RackModuleId, "amp" | "cab">;

export const PEDAL_FACEPLATE_MODULES: PedalFaceplateModuleId[] = ["gate", "pedal", "eq", "mod", "delay", "reverb"];

type PedalFaceplateLayout = "stompOneCenter" | "stompTwoTop" | "stompThreeTop" | "stompFourTop";

const PEDAL_FACEPLATE_LAYOUTS: Record<PedalFaceplateModuleId, PedalFaceplateLayout> = {
  gate: "stompTwoTop",
  pedal: "stompOneCenter",
  eq: "stompFourTop",
  mod: "stompThreeTop",
  delay: "stompThreeTop",
  reverb: "stompThreeTop",
};

const PEDAL_FACEPLATE_PARAM_LABELS: Record<string, string> = {
  gateThresholdDb: "Threshold",
  gateReleaseMs: "Release",
  pedalMix: "Mix",
  bassDb: "Bass",
  midDb: "Mid",
  trebleDb: "Treble",
  presenceDb: "Presence",
  chorusMix: "Mix",
  chorusRateHz: "Rate",
  chorusDepth: "Depth",
  delayMix: "Mix",
  delayTimeMs: "Time ms",
  delayFeedback: "Feedback",
  reverbMix: "Mix",
  reverbDecaySec: "Decay",
  reverbTone: "Tone",
};

function faceplateParam(param: BuiltInParamDescriptor) {
  return {
    ...param,
    label: PEDAL_FACEPLATE_PARAM_LABELS[param.id] ?? param.label,
  };
}

function faceplateControlSlot(layout: PedalFaceplateLayout, index: number) {
  if (layout === "stompOneCenter") return "center";
  if (layout === "stompTwoTop") return index === 0 ? "top-left" : "top-right";
  if (layout === "stompFourTop") {
    return ["top-left", "top-right", "bottom-left", "bottom-right"][index] ?? "bottom-right";
  }
  return ["top-left", "top-center", "top-right"][index] ?? "top-right";
}

function PedalFaceplateMeter({
  label,
  levelDb,
  formatDb,
  meterPercent,
}: {
  label: string;
  levelDb?: number;
  formatDb: (levelDb: number | undefined) => string;
  meterPercent: (levelDb: number | undefined) => number;
}) {
  const hasLevel = typeof levelDb === "number" && Number.isFinite(levelDb);
  const style = {
    "--nam-meter-pct": `${meterPercent(levelDb) * 100}%`,
  } as CSSProperties;

  return (
    <div className="nam-faceplate-meter" data-active={hasLevel && (levelDb ?? -90) > -60} style={style}>
      <span>{label}</span>
      <i aria-hidden="true"><b /></i>
      <strong>{hasLevel ? formatDb(levelDb) : "--"}</strong>
    </div>
  );
}

function pedalFaceplateMeta(moduleId: PedalFaceplateModuleId, pedalName: string, postCabOrderLabel: string) {
  switch (moduleId) {
    case "gate":
      return {
        eyebrow: "OpenStudio",
        title: "Gate / Input",
        display: "Input Conditioning",
        displaySub: "Threshold + Release",
        limitation: "Pre-capture utility stage",
      };
    case "pedal":
      return {
        eyebrow: "NAM Slot",
        title: "Pedal Capture",
        display: pedalName || "No Capture Loaded",
        displaySub: ".nam pedal model",
        limitation: "Loads .nam captures only",
      };
    case "eq":
      return {
        eyebrow: "OpenStudio",
        title: "Tone Stack EQ",
        display: "Wrapper EQ",
        displaySub: "Post capture tone",
        limitation: "Wrapper DSP, not NAM-file parameters",
      };
    case "mod":
      return {
        eyebrow: "OpenStudio",
        title: "Modulation",
        display: "Studio Chorus",
        displaySub: "Mix + Rate + Depth",
        limitation: "Wrapper DSP",
      };
    case "delay":
      return {
        eyebrow: "OpenStudio",
        title: "Delay",
        display: "Delay Stage",
        displaySub: "Mix + Time + Feedback",
        limitation: postCabOrderLabel || "Wrapper DSP",
      };
    case "reverb":
      return {
        eyebrow: "OpenStudio",
        title: "Reverb",
        display: "Space Stage",
        displaySub: "Mix + Decay + Tone",
        limitation: postCabOrderLabel || "Wrapper DSP",
      };
  }
}

export function PedalHardwareStage({
  moduleId,
  params,
  active,
  powerDisabled,
  powerTitle,
  onPowerToggle,
  hasPedalModel,
  pedalName,
  pedalModelPath,
  rawInputDb,
  postRackInputDb,
  postCabOrderLabel,
  onBrowsePedal,
  moduleHardwareArt,
  formatDb,
  meterPercent,
  renderKnob,
}: {
  moduleId: PedalFaceplateModuleId;
  params: BuiltInParamDescriptor[];
  active: boolean;
  powerDisabled?: boolean;
  powerTitle: string;
  onPowerToggle: () => void;
  hasPedalModel: boolean;
  pedalName: string;
  pedalModelPath?: string;
  rawInputDb?: number;
  postRackInputDb?: number;
  postCabOrderLabel: string;
  onBrowsePedal: () => void;
  moduleHardwareArt: (moduleId: RackModuleId) => string;
  formatDb: (levelDb: number | undefined) => string;
  meterPercent: (levelDb: number | undefined) => number;
  renderKnob: (param: BuiltInParamDescriptor) => ReactNode;
}) {
  const meta = pedalFaceplateMeta(moduleId, pedalName, postCabOrderLabel);
  const layout = PEDAL_FACEPLATE_LAYOUTS[moduleId];
  const shownParams = params.map((param) => faceplateParam(param));
  const hasControls = shownParams.length > 0;
  const footswitchAsset = footswitchAssetForState(active);
  const ledAsset = ledAssetForState(active);
  const footswitchStyle = {
    "--nam-control-footswitch-image": `url("${footswitchAsset.href}")`,
  } as CSSProperties;
  const ledStyle = {
    "--nam-control-led-image": `url("${ledAsset.href}")`,
  } as CSSProperties;

  return (
    <div className="nam-fx-hardware nam-stage-large nam-physical-pedal-stage" data-module={moduleId} data-active={active}>
      <div className="nam-fx-faceplate nam-physical-faceplate" data-module={moduleId}>
        <span className="nam-faceplate-cable nam-faceplate-cable-left" aria-hidden="true" />
        <span className="nam-faceplate-cable nam-faceplate-cable-right" aria-hidden="true" />
        <span className="nam-faceplate-jack nam-faceplate-jack-left" aria-hidden="true" />
        <span className="nam-faceplate-jack nam-faceplate-jack-right" aria-hidden="true" />
        <img
          className="nam-fx-faceplate-art"
          src={moduleHardwareArt(moduleId)}
          alt=""
          loading="lazy"
          aria-hidden="true"
        />
        <span className="nam-faceplate-screw nam-faceplate-screw-tl" aria-hidden="true" />
        <span className="nam-faceplate-screw nam-faceplate-screw-tr" aria-hidden="true" />
        <span className="nam-faceplate-screw nam-faceplate-screw-bl" aria-hidden="true" />
        <span className="nam-faceplate-screw nam-faceplate-screw-br" aria-hidden="true" />

        <div className="nam-fx-brand nam-faceplate-title">
          <span>{meta.eyebrow}</span>
          <strong>{meta.title}</strong>
          <small>{meta.limitation}</small>
        </div>

        <div
          className="nam-faceplate-display"
          data-empty={moduleId === "pedal" && !hasPedalModel}
          title={moduleId === "pedal" ? pedalModelPath : meta.display}
        >
          <span>{meta.displaySub}</span>
          <strong>{meta.display}</strong>
          {moduleId === "pedal" && !hasPedalModel && (
            <button type="button" className="nam-faceplate-display-browse" onClick={onBrowsePedal}>
              Browse / Load
            </button>
          )}
        </div>

        {moduleId === "gate" && (
          <div className="nam-faceplate-meter-stack">
            <PedalFaceplateMeter label="Input" levelDb={rawInputDb} formatDb={formatDb} meterPercent={meterPercent} />
            <PedalFaceplateMeter label="Post Gate" levelDb={postRackInputDb} formatDb={formatDb} meterPercent={meterPercent} />
          </div>
        )}

        {moduleId === "pedal" && hasPedalModel && (
          <button
            type="button"
            className="nam-faceplate-load"
            onClick={onBrowsePedal}
            title="Browse NAM pedal captures"
          >
            <Library size={13} />
            Browse
          </button>
        )}

        <div className="nam-faceplate-controls nam-fx-knob-deck" data-count={shownParams.length} data-layout={layout}>
          {hasControls ? shownParams.map((param, index) => (
            <div
              key={param.id}
              className="nam-faceplate-control-anchor nam-faceplate-control-slot"
              data-param={param.id}
              data-slot={faceplateControlSlot(layout, index)}
            >
              {renderKnob(param)}
            </div>
          )) : (
            <div className="nam-faceplate-no-controls">
              <strong>No editable controls</strong>
              <small>This module exposes no backend parameters.</small>
            </div>
          )}
        </div>

        <button
          type="button"
          className="nam-pedal-footswitch nam-faceplate-footswitch"
          data-active={active}
          disabled={powerDisabled}
          onClick={onPowerToggle}
          title={powerTitle}
          aria-pressed={active}
        >
          <span className="nam-pedal-led nam-raster-led-cap" data-control-asset={ledAsset.id} style={ledStyle} aria-hidden="true" />
          <span className="nam-pedal-footswitch-cap nam-raster-footswitch-cap" data-control-asset={footswitchAsset.id} style={footswitchStyle} aria-hidden="true" />
          <strong>{active ? "On" : "Off"}</strong>
        </button>
      </div>
    </div>
  );
}

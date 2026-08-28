import type { RackModuleId, RackSectionId } from "./NAMSignalChainTypes";
import { getNAMDesignBodyAsset } from "./NAMDesignAssets";

const LEGACY_SKIN_ASSETS = {
  cabBlank: new URL("../assets/nam/cab-blank-skin.webp", import.meta.url).href,
  preCompressorPbr: new URL("../assets/nam/pre-compressor-pbr-skin.webp", import.meta.url).href,
  preDualOctaverPbr: new URL("../assets/nam/pre-dual-octaver-pbr-skin.webp", import.meta.url).href,
  preChaosPbr: new URL("../assets/nam/pre-chaos-pbr-skin.webp", import.meta.url).href,
  modulatorExpressionPbr: new URL("../assets/nam/modulator-expression-pbr-skin.webp", import.meta.url).href,
  rackPbrClean: new URL("../assets/nam/rack-pbr-clean-skin.webp", import.meta.url).href,
  reverbBluePbr: new URL("../assets/nam/reverb-blue-pbr-skin.webp", import.meta.url).href,
} as const;

export type NAMRackVisualMode = "approved-parity-2d" | "cab-room-3d-proof" | "debug-anchors";

export type NAMRackControlKind = "knob" | "switch" | "button" | "display" | "footswitch" | "meter" | "label" | "fader" | "mic" | "treadle" | "led";

export type NAMRackControlAnchor = {
  id: string;
  paramId?: string;
  kind: NAMRackControlKind;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  valueLabel?: string;
  rotationMinDeg?: number;
  rotationMaxDeg?: number;
  resetValue?: number;
  displayFormat?: "db" | "hz" | "ms" | "percent" | "plain";
  orientation?: "horizontal" | "vertical";
};

const eqBoostBody = getNAMDesignBodyAsset("stompbox-body-white-wide");
const precisionDriveBody = getNAMDesignBodyAsset("stompbox-body-stone");
const ampHeadV5 = getNAMDesignBodyAsset("amp-head-body-v5");
const graphicEqV6 = getNAMDesignBodyAsset("graphic-eq-body-v6");

export type NAMRackDeviceSkin = {
  id: string;
  section: RackSectionId;
  moduleId?: RackModuleId;
  title: string;
  assetUrl: string;
  sourceSize: {
    width: number;
    height: number;
  };
  aspectRatio: string;
  material: "pedal" | "rack" | "amp" | "cab" | "modal" | "chrome";
  controls: NAMRackControlAnchor[];
};

export type NAMRackPresetTag = {
  category: string;
  character: string;
  style: string;
  favorite: boolean;
  source: "factory" | "user" | "tone3000" | "imported";
  modelArchitecture?: string;
};

export const NAM_RACK_DEVICE_SKINS: NAMRackDeviceSkin[] = [
  {
    id: "pre-compressor-design-a",
    section: "pre",
    title: "Compressor",
    assetUrl: LEGACY_SKIN_ASSETS.preCompressorPbr,
    sourceSize: { width: 720, height: 1040 },
    aspectRatio: "720 / 1040",
    material: "pedal",
    controls: [
      { id: "comp-comp", paramId: "compressorComp", kind: "knob", x: 0.18, y: 0.205, width: 0.17, height: 0.13, label: "Comp" },
      { id: "comp-attack", paramId: "compressorAttackMs", kind: "knob", x: 0.5, y: 0.205, width: 0.17, height: 0.13, label: "Attack", displayFormat: "ms" },
      { id: "comp-release", paramId: "compressorReleaseMs", kind: "knob", x: 0.82, y: 0.205, width: 0.17, height: 0.13, label: "Release", displayFormat: "ms" },
      { id: "comp-tone", paramId: "compressorToneDb", kind: "knob", x: 0.18, y: 0.425, width: 0.17, height: 0.13, label: "Tone", displayFormat: "db" },
      { id: "comp-mix", paramId: "compressorMix", kind: "knob", x: 0.5, y: 0.425, width: 0.17, height: 0.13, label: "Mix", displayFormat: "percent" },
      { id: "comp-volume", paramId: "compressorVolumeDb", kind: "knob", x: 0.82, y: 0.425, width: 0.17, height: 0.13, label: "Level", displayFormat: "db" },
      { id: "comp-hpf", paramId: "compressorSidechainHPF", kind: "switch", x: 0.22, y: 0.63, width: 0.13, height: 0.1, label: "HPF" },
      { id: "comp-meter", kind: "meter", x: 0.65, y: 0.632, width: 0.51, height: 0.09, label: "Gain reduction" },
      { id: "comp-intensity-readout", paramId: "compressorIntensity", kind: "display", x: 0.21, y: 0.755, width: 0.3, height: 0.08, label: "Intensity 8:1 / 16:1" },
      { id: "comp-intensity", paramId: "compressorIntensity", kind: "switch", x: 0.21, y: 0.86, width: 0.15, height: 0.1, label: "Intensity" },
      { id: "comp-led", paramId: "compressorEnabled", kind: "led", x: 0.78, y: 0.765, width: 0.052, height: 0.052 },
      { id: "comp-engage", paramId: "compressorEnabled", kind: "footswitch", x: 0.78, y: 0.9075, width: 0.16, height: 0.12 },
    ],
  },
  {
    id: "pre-dual-octaver-design-a",
    section: "pre",
    title: "Poly Octaver",
    assetUrl: LEGACY_SKIN_ASSETS.preDualOctaverPbr,
    sourceSize: { width: 720, height: 1040 },
    aspectRatio: "720 / 1040",
    material: "pedal",
    controls: [
      { id: "oct-down", paramId: "octaverDownMix", kind: "knob", x: 0.25, y: 0.2, width: 0.24, height: 0.17, label: "Oct -1" },
      { id: "oct-up", paramId: "octaverUpMix", kind: "knob", x: 0.75, y: 0.2, width: 0.24, height: 0.17, label: "Oct +1" },
      { id: "oct-direct", paramId: "octaverDirectMix", kind: "knob", x: 0.5, y: 0.43, width: 0.24, height: 0.17, label: "Direct" },
      { id: "oct-display", kind: "display", x: 0.5, y: 0.58, width: 0.46, height: 0.09 },
      { id: "oct-engage", paramId: "octaverEnabled", kind: "footswitch", x: 0.5, y: 0.84, width: 0.18, height: 0.12 },
    ],
  },
  {
    id: "pre-eq-boost-design-a",
    section: "pre",
    title: "EQ Boost",
    assetUrl: eqBoostBody.href,
    sourceSize: { width: eqBoostBody.width, height: eqBoostBody.height },
    aspectRatio: "156 / 232",
    material: "pedal",
    controls: [
      { id: "pre-eq-120", paramId: "preEq120Db", kind: "fader", orientation: "horizontal", x: 0.410256, y: 0.107759, width: 0.461538, height: 0.068966, label: "120" },
      { id: "pre-eq-250", paramId: "preEq250Db", kind: "fader", orientation: "horizontal", x: 0.410256, y: 0.181034, width: 0.461538, height: 0.068966, label: "250" },
      { id: "pre-eq-500", paramId: "preEq500Db", kind: "fader", orientation: "horizontal", x: 0.410256, y: 0.254310, width: 0.461538, height: 0.068966, label: "500" },
      { id: "pre-eq-1k", paramId: "preEq1kDb", kind: "fader", orientation: "horizontal", x: 0.410256, y: 0.327586, width: 0.461538, height: 0.068966, label: "1K" },
      { id: "pre-eq-2k5", paramId: "preEq2k5Db", kind: "fader", orientation: "horizontal", x: 0.410256, y: 0.400862, width: 0.461538, height: 0.068966, label: "2.5K" },
      { id: "pre-eq-5k", paramId: "preEq5kDb", kind: "fader", orientation: "horizontal", x: 0.410256, y: 0.474138, width: 0.461538, height: 0.068966, label: "5K" },
      { id: "pre-eq-8k", paramId: "preEq8kDb", kind: "fader", orientation: "horizontal", x: 0.410256, y: 0.547414, width: 0.461538, height: 0.068966, label: "8K" },
      { id: "pre-eq-12k", paramId: "preEq12kDb", kind: "fader", orientation: "horizontal", x: 0.410256, y: 0.620690, width: 0.461538, height: 0.068966, label: "12K" },
      { id: "pre-eq-hpf", paramId: "preEqHPFHz", kind: "knob", x: 0.794872, y: 0.237069, width: 0.179487, height: 0.120690, label: "HPF", displayFormat: "hz" },
      { id: "pre-eq-lpf", paramId: "preEqLPFHz", kind: "knob", x: 0.794872, y: 0.512931, width: 0.179487, height: 0.120690, label: "LPF", displayFormat: "hz" },
      { id: "pre-eq-led", paramId: "preEqEnabled", kind: "led", x: 0.5, y: 0.765, width: 0.076923, height: 0.051724 },
      { id: "pre-eq-engage", paramId: "preEqEnabled", kind: "footswitch", x: 0.5, y: 0.9075, width: 0.179487, height: 0.120690, label: "EQ Boost" },
    ],
  },
  {
    id: "pre-precision-drive-design-a",
    section: "pre",
    moduleId: "pedal",
    title: "Precision Drive",
    assetUrl: precisionDriveBody.href,
    sourceSize: { width: precisionDriveBody.width, height: precisionDriveBody.height },
    aspectRatio: "120 / 232",
    material: "pedal",
    controls: [
      { id: "pedal-drive", paramId: "precisionDriveDrive", kind: "knob", x: 0.30, y: 0.195, width: 0.29, height: 0.15, label: "Drive", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "pedal-volume", paramId: "precisionDriveVolumeDb", kind: "knob", x: 0.70, y: 0.195, width: 0.29, height: 0.15, label: "Level", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "pedal-gate", paramId: "precisionDriveGate", kind: "knob", x: 0.50, y: 0.33, width: 0.166667, height: 0.086207, label: "Gate", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "pedal-bright", paramId: "precisionDriveBright", kind: "knob", x: 0.30, y: 0.49, width: 0.29, height: 0.15, label: "Bright", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "pedal-attack", paramId: "precisionDriveAttack", kind: "knob", x: 0.70, y: 0.49, width: 0.29, height: 0.15, label: "Attack", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "pedal-led", paramId: "precisionDriveEnabled", kind: "led", x: 0.50, y: 0.732, width: 0.10, height: 0.052 },
      { id: "pedal-engage", paramId: "precisionDriveEnabled", kind: "footswitch", x: 0.50, y: 0.883, width: 0.233333, height: 0.121, label: "Drive" },
    ],
  },
  {
    id: "pre-chaos-design-a",
    section: "pre",
    title: "Distortion",
    assetUrl: LEGACY_SKIN_ASSETS.preChaosPbr,
    sourceSize: { width: 520, height: 1040 },
    aspectRatio: "520 / 1040",
    material: "pedal",
    controls: [
      { id: "chaos-mode", paramId: "chaosMode", kind: "button", x: 0.5, y: 0.11, width: 0.24, height: 0.08 },
      { id: "chaos-drive", paramId: "chaosDrive", kind: "knob", x: 0.2, y: 0.27, width: 0.2, height: 0.15, label: "Drive" },
      { id: "chaos-gate", paramId: "chaosGate", kind: "knob", x: 0.5, y: 0.27, width: 0.18, height: 0.14, label: "Gate" },
      { id: "chaos-tone", paramId: "chaosTone", kind: "knob", x: 0.8, y: 0.27, width: 0.2, height: 0.15, label: "Tone" },
      { id: "chaos-weight", paramId: "chaosWeight", kind: "knob", x: 0.2, y: 0.48, width: 0.2, height: 0.15, label: "Weight: Tight to Thick" },
      { id: "chaos-mix", paramId: "chaosMix", kind: "knob", x: 0.5, y: 0.48, width: 0.2, height: 0.15, label: "Mix" },
      { id: "chaos-level", paramId: "chaosLevelDb", kind: "knob", x: 0.8, y: 0.48, width: 0.2, height: 0.15, label: "Level" },
      { id: "chaos-engage", paramId: "chaosEnabled", kind: "footswitch", x: 0.5, y: 0.84, width: 0.2, height: 0.12 },
    ],
  },
  {
    id: "amp-head-design-a",
    section: "amp",
    moduleId: "amp",
    title: "NAM Amp Wrapper",
    assetUrl: ampHeadV5.href,
    sourceSize: { width: ampHeadV5.width, height: ampHeadV5.height },
    aspectRatio: "720 / 345",
    material: "amp",
    controls: [
      { id: "amp-model-display", kind: "display", x: 0.5, y: 0.367150, width: 0.268519, height: 0.154589, label: "NAM Capture" },
      { id: "amp-wrapper-legend", kind: "label", x: 0.5, y: 0.512077, width: 0.42, height: 0.05, label: "Capture Fixed - Wrapper Controls" },
      { id: "amp-power", paramId: "ampEnabled", kind: "switch", x: 0.104167, y: 0.719807, width: 0.030556, height: 0.063768, label: "Power" },
      { id: "amp-power-led", paramId: "ampEnabled", kind: "led", x: 0.104167, y: 0.659903, width: 0.016667, height: 0.034783 },
      { id: "amp-gain", paramId: "ampGainDb", kind: "knob", x: 0.166667, y: 0.719807, width: 0.05, height: 0.104348, label: "Gain", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-boost", paramId: "ampBoost", kind: "switch", x: 0.240741, y: 0.719807, width: 0.030556, height: 0.063768, label: "Tight" },
      { id: "amp-boost-led", paramId: "ampBoost", kind: "led", x: 0.240741, y: 0.659903, width: 0.016667, height: 0.034783 },
      { id: "amp-voice", paramId: "ampVoice", kind: "switch", x: 0.3125, y: 0.719807, width: 0.030556, height: 0.063768, label: "Bright" },
      { id: "amp-voice-led", paramId: "ampVoice", kind: "led", x: 0.3125, y: 0.659903, width: 0.016667, height: 0.034783 },
      { id: "amp-bass", paramId: "bassDb", kind: "knob", x: 0.405093, y: 0.719807, width: 0.05, height: 0.104348, label: "Bass", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-middle", paramId: "midDb", kind: "knob", x: 0.5, y: 0.719807, width: 0.05, height: 0.104348, label: "Mid", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-treble", paramId: "trebleDb", kind: "knob", x: 0.594907, y: 0.719807, width: 0.05, height: 0.104348, label: "Treble", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-presence", paramId: "presenceDb", kind: "knob", x: 0.689815, y: 0.719807, width: 0.05, height: 0.104348, label: "Presence", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-mix", paramId: "ampMix", kind: "knob", x: 0.784722, y: 0.719807, width: 0.05, height: 0.104348, label: "Mix", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "amp-output", paramId: "ampOutputDb", kind: "knob", x: 0.87963, y: 0.719807, width: 0.05, height: 0.104348, label: "Output", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
    ],
  },
  {
    id: "cab-room-design-a",
    section: "cab",
    moduleId: "cab",
    title: "Cabinet Room",
    assetUrl: LEGACY_SKIN_ASSETS.cabBlank,
    sourceSize: { width: 1535, height: 557 },
    aspectRatio: "1535 / 557",
    material: "cab",
    controls: [
      { id: "cab-left-select", kind: "label", x: 0.18, y: 0.18, width: 0.17, height: 0.09, label: "Condenser 184" },
      { id: "cab-right-select", kind: "label", x: 0.82, y: 0.18, width: 0.17, height: 0.09, label: "Ribbon 121" },
      { id: "cab-left-mic", paramId: "cabMicPosition", kind: "mic", x: 0.36, y: 0.39, width: 0.18, height: 0.34, label: "Position", valueLabel: "0.500" },
      { id: "cab-right-mic", paramId: "cabMicDistance", kind: "mic", x: 0.64, y: 0.39, width: 0.18, height: 0.34, label: "Distance", valueLabel: "0.000" },
      { id: "cab-level", paramId: "cabLevelDb", kind: "knob", x: 0.18, y: 0.72, width: 0.1, height: 0.18, label: "Mic Level", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "cab-hpf", paramId: "cabHPFHz", kind: "knob", x: 0.32, y: 0.72, width: 0.1, height: 0.18, label: "HPF", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "hz" },
      { id: "cab-blend", paramId: "cabMicBlend", kind: "knob", x: 0.50, y: 0.72, width: 0.1, height: 0.18, label: "Blend", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "cab-lpf", paramId: "cabLPFHz", kind: "knob", x: 0.68, y: 0.72, width: 0.1, height: 0.18, label: "LPF", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "hz" },
      { id: "cab-room", paramId: "cabRoomSend", kind: "knob", x: 0.18, y: 0.88, width: 0.085, height: 0.14, label: "Bloom", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "cab-pan", paramId: "cabPan", kind: "knob", x: 0.82, y: 0.88, width: 0.085, height: 0.14, label: "Pan", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "plain" },
      { id: "cab-phase", paramId: "cabPhaseInvert", kind: "switch", x: 0.82, y: 0.72, width: 0.09, height: 0.13, label: "Phase" },
      { id: "cab-ir-display", kind: "display", x: 0.5, y: 0.15, width: 0.32, height: 0.1 },
      { id: "cab-power", paramId: "cabEnabled", kind: "footswitch", x: 0.5, y: 0.82, width: 0.08, height: 0.12 },
    ],
  },
  {
    id: "eq-rack-design-a",
    section: "eq",
    moduleId: "eq",
    title: "Graphic EQ",
    assetUrl: graphicEqV6.href,
    sourceSize: { width: graphicEqV6.width, height: graphicEqV6.height },
    aspectRatio: "720 / 240",
    material: "rack",
    controls: [
      { id: "eq-power", paramId: "eqEnabled", kind: "switch", x: 0.134259, y: 0.729167, width: 0.030556, height: 0.091667, label: "Bypass" },
      { id: "eq-led", paramId: "eqEnabled", kind: "led", x: 0.185185, y: 0.729167, width: 0.016667, height: 0.05 },
      { id: "eq-65", paramId: "eq65Db", kind: "fader", x: 0.238426, y: 0.383333, width: 0.051852, height: 0.455556, label: "65 Hz" },
      { id: "eq-125", paramId: "eq125Db", kind: "fader", x: 0.303819, y: 0.383333, width: 0.051852, height: 0.455556, label: "125 Hz" },
      { id: "eq-250", paramId: "eq250Db", kind: "fader", x: 0.369213, y: 0.383333, width: 0.051852, height: 0.455556, label: "250 Hz" },
      { id: "eq-500", paramId: "eq500Db", kind: "fader", x: 0.434606, y: 0.383333, width: 0.051852, height: 0.455556, label: "500 Hz" },
      { id: "eq-1k", paramId: "eq1kDb", kind: "fader", x: 0.5, y: 0.383333, width: 0.051852, height: 0.455556, label: "1 kHz" },
      { id: "eq-2k", paramId: "eq2kDb", kind: "fader", x: 0.565394, y: 0.383333, width: 0.051852, height: 0.455556, label: "2 kHz" },
      { id: "eq-4k", paramId: "eq4kDb", kind: "fader", x: 0.630787, y: 0.383333, width: 0.051852, height: 0.455556, label: "4 kHz" },
      { id: "eq-8k", paramId: "eq8kDb", kind: "fader", x: 0.696181, y: 0.383333, width: 0.051852, height: 0.455556, label: "8 kHz" },
      { id: "eq-16k", paramId: "eq16kDb", kind: "fader", x: 0.761574, y: 0.383333, width: 0.051852, height: 0.455556, label: "16 kHz" },
      { id: "eq-hpf", paramId: "eqHPFHz", kind: "knob", x: 0.134259, y: 0.380556, width: 0.069444, height: 0.208333, label: "HPF", displayFormat: "hz" },
      { id: "eq-output-level", paramId: "eqLevelDb", kind: "knob", x: 0.865741, y: 0.729167, width: 0.041667, height: 0.125, label: "Level", displayFormat: "db" },
      { id: "eq-lpf", paramId: "eqLPFHz", kind: "knob", x: 0.865741, y: 0.380556, width: 0.069444, height: 0.208333, label: "LPF", displayFormat: "hz" },
    ],
  },
  {
    id: "post-modulator-design-a",
    section: "post",
    moduleId: "mod",
    title: "Modulator",
    assetUrl: LEGACY_SKIN_ASSETS.modulatorExpressionPbr,
    sourceSize: { width: 720, height: 1040 },
    aspectRatio: "720 / 1040",
    material: "pedal",
    controls: [
      { id: "mod-mode", paramId: "modulatorMode", kind: "switch", x: 0.75, y: 0.12, width: 0.18, height: 0.07, label: "Flanger" },
      { id: "mod-character", paramId: "chorusCharacter", kind: "switch", x: 0.57, y: 0.12, width: 0.16, height: 0.07, label: "Character" },
      { id: "mod-mix", paramId: "chorusMix", kind: "knob", x: 0.67, y: 0.25, width: 0.15, height: 0.12, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "mod-depth", paramId: "chorusDepth", kind: "knob", x: 0.84, y: 0.25, width: 0.15, height: 0.12, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "mod-rate", paramId: "chorusRateHz", kind: "knob", x: 0.67, y: 0.48, width: 0.15, height: 0.12, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "mod-feedback", paramId: "modulatorFeedback", kind: "knob", x: 0.84, y: 0.48, width: 0.15, height: 0.12, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "mod-pedal-mode", paramId: "modulatorPedalMode", kind: "switch", x: 0.75, y: 0.62, width: 0.22, height: 0.07, label: "Auto" },
      { id: "mod-auto-random", paramId: "modulatorAutoRandom", kind: "knob", x: 0.67, y: 0.76, width: 0.14, height: 0.11, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "mod-auto-speed", paramId: "modulatorAutoSpeed", kind: "knob", x: 0.84, y: 0.76, width: 0.14, height: 0.11, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "mod-expression-treadle", paramId: "modulatorPedalPosition", kind: "treadle", x: 0.37, y: 0.72, width: 0.38, height: 0.34, label: "Pedal" },
      { id: "mod-display", kind: "display", x: 0.75, y: 0.37, width: 0.30, height: 0.08 },
      { id: "mod-footswitch", paramId: "modulatorEnabled", kind: "footswitch", x: 0.74, y: 0.88, width: 0.16, height: 0.10 },
    ],
  },
  {
    id: "post-stereo-delay-design-a",
    section: "post",
    moduleId: "delay",
    title: "Stereo Delay",
    assetUrl: LEGACY_SKIN_ASSETS.rackPbrClean,
    sourceSize: { width: 1280, height: 720 },
    aspectRatio: "1280 / 720",
    material: "rack",
    controls: [
      { id: "delay-mix", paramId: "delayMix", kind: "knob", x: 0.1, y: 0.13, width: 0.13, height: 0.18, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "delay-feedback", paramId: "delayFeedback", kind: "knob", x: 0.78, y: 0.13, width: 0.13, height: 0.18, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "delay-time", paramId: "delayTimeMs", kind: "knob", x: 0.17, y: 0.62, width: 0.12, height: 0.16, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "delay-mod", paramId: "delayMod", kind: "knob", x: 0.42, y: 0.62, width: 0.12, height: 0.16, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "delay-ducker", paramId: "delayDucker", kind: "knob", x: 0.63, y: 0.62, width: 0.12, height: 0.16, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "delay-mode", paramId: "delayMode", kind: "button", x: 0.49, y: 0.18, width: 0.1, height: 0.12, label: "Mode" },
      { id: "delay-ping-pong", paramId: "delayPingPong", kind: "switch", x: 0.55, y: 0.42, width: 0.08, height: 0.08, label: "Ping" },
      { id: "delay-display", kind: "display", x: 0.5, y: 0.35, width: 0.62, height: 0.18 },
      { id: "delay-engage", paramId: "delayEnabled", kind: "footswitch", x: 0.1, y: 0.83, width: 0.1, height: 0.1 },
      { id: "delay-tap", paramId: "delayTempoSync", kind: "footswitch", x: 0.8, y: 0.83, width: 0.1, height: 0.1 },
    ],
  },
  {
    id: "post-reverb-design-a",
    section: "post",
    moduleId: "reverb",
    title: "Reverb",
    assetUrl: LEGACY_SKIN_ASSETS.reverbBluePbr,
    sourceSize: { width: 720, height: 1040 },
    aspectRatio: "720 / 1040",
    material: "pedal",
    controls: [
      { id: "reverb-voice-display", paramId: "reverbVoice", kind: "display", x: 0.07, y: 0.155, width: 0.55, height: 0.10, label: "Voice" },
      { id: "reverb-voice", paramId: "reverbVoice", kind: "knob", x: 0.76, y: 0.205, width: 0.109, height: 0.109, rotationMinDeg: -60, rotationMaxDeg: 60 },
      { id: "reverb-mix", paramId: "reverbMix", kind: "knob", x: 0.10, y: 0.16, width: 0.18, height: 0.15, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "reverb-pre-delay", paramId: "reverbPreDelayMs", kind: "knob", x: 0.41, y: 0.16, width: 0.18, height: 0.15, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "reverb-decay", paramId: "reverbDecaySec", kind: "knob", x: 0.72, y: 0.16, width: 0.18, height: 0.15, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "reverb-low-cut", paramId: "reverbLowCutHz", kind: "knob", x: 0.18, y: 0.43, width: 0.18, height: 0.16, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "reverb-tone", paramId: "reverbTone", kind: "knob", x: 0.40, y: 0.43, width: 0.2, height: 0.16, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "reverb-shimmer", paramId: "reverbShimmer", kind: "knob", x: 0.66, y: 0.43, width: 0.18, height: 0.16, rotationMinDeg: -135, rotationMaxDeg: 135 },
      { id: "reverb-engage", paramId: "reverbEnabled", kind: "footswitch", x: 0.57, y: 0.84, width: 0.18, height: 0.12, label: "Engage" },
      { id: "reverb-pad", paramId: "reverbPad", kind: "switch", x: 0.25, y: 0.84, width: 0.1, height: 0.1, label: "Pad" },
    ],
  },
];

export function deviceSkinForModule(moduleId: RackModuleId): NAMRackDeviceSkin | undefined {
  return NAM_RACK_DEVICE_SKINS.find((skin) => skin.moduleId === moduleId);
}

export function deviceSkinsForSection(sectionId: RackSectionId): NAMRackDeviceSkin[] {
  return NAM_RACK_DEVICE_SKINS.filter((skin) => skin.section === sectionId);
}

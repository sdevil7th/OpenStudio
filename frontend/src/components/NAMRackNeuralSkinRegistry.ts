import { NAM_RACK_ART } from "./NAMRackHardwareArt";
import type { RackModuleId } from "./NAMRackPedalHardware";

export type RackSectionId = "pre" | "amp" | "cab" | "eq" | "post" | "browser" | "tuner" | "settings";

export type NAMRackVisualMode = "approved-parity-2d" | "cab-room-3d-proof" | "debug-anchors";

export type NAMRackControlKind = "knob" | "switch" | "button" | "display" | "footswitch" | "meter" | "label" | "fader" | "mic" | "treadle";

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
};

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

export const NAM_RACK_SECTIONS: Array<{
  id: RackSectionId;
  label: string;
  targetModule: RackModuleId;
}> = [
  { id: "pre", label: "Pre FX", targetModule: "pedal" },
  { id: "amp", label: "Amp", targetModule: "amp" },
  { id: "cab", label: "Cab", targetModule: "cab" },
  { id: "eq", label: "EQ", targetModule: "eq" },
  { id: "post", label: "Post FX", targetModule: "delay" },
];

export function isRackSectionId(value: unknown): value is RackSectionId {
  return (
    value === "pre" ||
    value === "amp" ||
    value === "cab" ||
    value === "eq" ||
    value === "post" ||
    value === "browser" ||
    value === "tuner" ||
    value === "settings"
  );
}

export function rackSectionForModule(moduleId: RackModuleId): RackSectionId {
  if (moduleId === "gate" || moduleId === "pedal") return "pre";
  if (moduleId === "amp") return "amp";
  if (moduleId === "cab") return "cab";
  if (moduleId === "eq") return "eq";
  if (moduleId === "mod" || moduleId === "delay" || moduleId === "reverb") return "post";
  return "pre";
}

export const NAM_RACK_DEVICE_SKINS: NAMRackDeviceSkin[] = [
  {
    id: "pre-compressor-design-a",
    section: "pre",
    title: "Compressor",
    assetUrl: NAM_RACK_ART.preCompressorPbr,
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
      { id: "comp-engage", paramId: "compressorEnabled", kind: "footswitch", x: 0.5, y: 0.86, width: 0.16, height: 0.12 },
    ],
  },
  {
    id: "pre-tape-echo-design-a",
    section: "pre",
    title: "Booster",
    assetUrl: NAM_RACK_ART.preTapeEchoPbr,
    sourceSize: { width: 720, height: 1040 },
    aspectRatio: "720 / 1040",
    material: "pedal",
    controls: [
      { id: "tape-mix", paramId: "tapeEchoMix", kind: "knob", x: 0.22, y: 0.2, width: 0.22, height: 0.16, label: "Mix" },
      { id: "tape-feed", paramId: "tapeEchoFeedback", kind: "knob", x: 0.78, y: 0.2, width: 0.22, height: 0.16, label: "Feed" },
      { id: "tape-time", paramId: "tapeEchoTimeMs", kind: "knob", x: 0.22, y: 0.44, width: 0.22, height: 0.16, label: "Time" },
      { id: "tape-mod", paramId: "tapeEchoMod", kind: "knob", x: 0.5, y: 0.44, width: 0.22, height: 0.16, label: "Mod" },
      { id: "tape-tone", paramId: "tapeEchoTone", kind: "knob", x: 0.78, y: 0.44, width: 0.22, height: 0.16, label: "Tone" },
      { id: "tape-display", kind: "display", x: 0.5, y: 0.12, width: 0.36, height: 0.09 },
      { id: "tape-engage", paramId: "tapeEchoEnabled", kind: "footswitch", x: 0.5, y: 0.84, width: 0.18, height: 0.12 },
    ],
  },
  {
    id: "pre-dual-octaver-design-a",
    section: "pre",
    title: "Poly Octaver",
    assetUrl: NAM_RACK_ART.preDualOctaverPbr,
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
    id: "pre-precision-drive-design-a",
    section: "pre",
    moduleId: "pedal",
    title: "Precision Drive",
    assetUrl: NAM_RACK_ART.prePrecisionDrivePbr,
    sourceSize: { width: 720, height: 1040 },
    aspectRatio: "720 / 1040",
    material: "pedal",
    controls: [
      { id: "pedal-volume", paramId: "precisionDriveVolumeDb", kind: "knob", x: 0.24, y: 0.18, width: 0.22, height: 0.16, label: "Vol", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "pedal-bright", paramId: "precisionDriveBright", kind: "knob", x: 0.74, y: 0.18, width: 0.22, height: 0.16, label: "Bright", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "pedal-attack", paramId: "precisionDriveAttack", kind: "knob", x: 0.22, y: 0.39, width: 0.2, height: 0.15, label: "Attack", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "pedal-gate", paramId: "precisionDriveGate", kind: "knob", x: 0.50, y: 0.39, width: 0.14, height: 0.12, label: "Gate", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "pedal-mix", paramId: "precisionDriveDrive", kind: "knob", x: 0.78, y: 0.39, width: 0.2, height: 0.15, label: "Drive", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "pedal-model-display", kind: "display", x: 0.5, y: 0.58, width: 0.62, height: 0.1 },
      { id: "pedal-browse", kind: "button", x: 0.5, y: 0.66, width: 0.4, height: 0.06, label: "Browse" },
      { id: "pedal-engage", paramId: "precisionDriveEnabled", kind: "footswitch", x: 0.5, y: 0.84, width: 0.18, height: 0.12 },
    ],
  },
  {
    id: "pre-chaos-design-a",
    section: "pre",
    title: "Distortion",
    assetUrl: NAM_RACK_ART.preChaosPbr,
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
    title: "Amp Capture",
    assetUrl: NAM_RACK_ART.ampHeadBlank,
    sourceSize: { width: 1535, height: 557 },
    aspectRatio: "1535 / 557",
    material: "amp",
    controls: [
      { id: "amp-input-jack", kind: "label", x: 0.1, y: 0.72, width: 0.1, height: 0.13, label: "Input" },
      { id: "amp-boost", paramId: "ampBoost", kind: "switch", x: 0.18, y: 0.72, width: 0.042, height: 0.14, label: "Boost" },
      { id: "amp-voice", paramId: "ampVoice", kind: "switch", x: 0.24, y: 0.72, width: 0.042, height: 0.14, label: "Voice" },
      { id: "amp-gain", paramId: "ampGainDb", kind: "knob", x: 0.31, y: 0.72, width: 0.08, height: 0.16, label: "Gain", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-bass", paramId: "bassDb", kind: "knob", x: 0.4, y: 0.72, width: 0.08, height: 0.16, label: "Bass", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-middle", paramId: "midDb", kind: "knob", x: 0.49, y: 0.72, width: 0.08, height: 0.16, label: "Middle", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-treble", paramId: "trebleDb", kind: "knob", x: 0.58, y: 0.72, width: 0.08, height: 0.16, label: "Treble", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-presence", paramId: "presenceDb", kind: "knob", x: 0.67, y: 0.72, width: 0.08, height: 0.16, label: "Presence", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-master", paramId: "ampMix", kind: "knob", x: 0.76, y: 0.72, width: 0.08, height: 0.16, label: "Master", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "percent" },
      { id: "amp-output", paramId: "ampOutputDb", kind: "knob", x: 0.85, y: 0.72, width: 0.08, height: 0.16, label: "Output", rotationMinDeg: -135, rotationMaxDeg: 135, displayFormat: "db" },
      { id: "amp-model-display", kind: "display", x: 0.5, y: 0.36, width: 0.34, height: 0.1 },
      { id: "amp-power-label", kind: "label", x: 0.93, y: 0.64, width: 0.08, height: 0.08, label: "Power" },
      { id: "amp-power", paramId: "ampEnabled", kind: "footswitch", x: 0.93, y: 0.72, width: 0.06, height: 0.1 },
    ],
  },
  {
    id: "cab-room-design-a",
    section: "cab",
    moduleId: "cab",
    title: "Cabinet Room",
    assetUrl: NAM_RACK_ART.cabBlank,
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
    title: "Tone Stack EQ",
    assetUrl: NAM_RACK_ART.rackPbrClean,
    sourceSize: { width: 1280, height: 720 },
    aspectRatio: "1280 / 720",
    material: "rack",
    controls: [
      { id: "eq-input-trim", kind: "label", x: 0.12, y: 0.46, width: 0.11, height: 0.42, label: "Input Off" },
      { id: "eq-65", paramId: "eq65Db", kind: "fader", x: 0.18, y: 0.52, width: 0.044, height: 0.46, label: "65 Hz" },
      { id: "eq-125", paramId: "eq125Db", kind: "fader", x: 0.2511, y: 0.52, width: 0.044, height: 0.46, label: "125 Hz" },
      { id: "eq-250", paramId: "eq250Db", kind: "fader", x: 0.3222, y: 0.52, width: 0.044, height: 0.46, label: "250 Hz" },
      { id: "eq-500", paramId: "eq500Db", kind: "fader", x: 0.3933, y: 0.52, width: 0.044, height: 0.46, label: "500 Hz" },
      { id: "eq-1k", paramId: "eq1kDb", kind: "fader", x: 0.4644, y: 0.52, width: 0.044, height: 0.46, label: "1 kHz" },
      { id: "eq-2k", paramId: "eq2kDb", kind: "fader", x: 0.5356, y: 0.52, width: 0.044, height: 0.46, label: "2 kHz" },
      { id: "eq-4k", paramId: "eq4kDb", kind: "fader", x: 0.6067, y: 0.52, width: 0.044, height: 0.46, label: "4 kHz" },
      { id: "eq-8k", paramId: "eq8kDb", kind: "fader", x: 0.6778, y: 0.52, width: 0.044, height: 0.46, label: "8 kHz" },
      { id: "eq-16k", paramId: "eq16kDb", kind: "fader", x: 0.7489, y: 0.52, width: 0.044, height: 0.46, label: "16 kHz" },
      { id: "eq-output-level", paramId: "eqLevelDb", kind: "fader", x: 0.82, y: 0.52, width: 0.044, height: 0.46, label: "Level" },
      { id: "eq-display", kind: "display", x: 0.54, y: 0.16, width: 0.5, height: 0.1 },
      { id: "eq-power", paramId: "eqEnabled", kind: "footswitch", x: 0.08, y: 0.76, width: 0.07, height: 0.1 },
    ],
  },
  {
    id: "post-modulator-design-a",
    section: "post",
    moduleId: "mod",
    title: "Modulator",
    assetUrl: NAM_RACK_ART.modulatorExpressionPbr,
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
    assetUrl: NAM_RACK_ART.rackPbrClean,
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
    assetUrl: NAM_RACK_ART.reverbBluePbr,
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
      { id: "reverb-footswitch", paramId: "reverbEnabled", kind: "footswitch", x: 0.42, y: 0.84, width: 0.18, height: 0.12 },
    ],
  },
];

export function deviceSkinForModule(moduleId: RackModuleId): NAMRackDeviceSkin | undefined {
  return NAM_RACK_DEVICE_SKINS.find((skin) => skin.moduleId === moduleId);
}

export function deviceSkinsForSection(sectionId: RackSectionId): NAMRackDeviceSkin[] {
  return NAM_RACK_DEVICE_SKINS.filter((skin) => skin.section === sectionId);
}

import { type CSSProperties } from "react";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import {
  NAM_RACK_LASER_MODE_OPTIONS,
  type BuiltInParamDescriptor,
} from "../services/NativeBridge";
import { RackKnob } from "./NAMRackKnob";

export type RackMixerStripSpec = {
  id: string;
  label: string;
  caption: string;
  active: boolean;
  meterDb?: number;
  params: BuiltInParamDescriptor[];
  warning?: boolean;
  available?: boolean;
  unavailableReason?: string;
  disabledParamIds?: readonly string[];
  disabledParamReasons?: Readonly<Record<string, string>>;
  dependencyNote?: string;
};

export const NAM_RACK_ADVANCED_CONTROL_IDS = {
  input: ["inputTrimDb", "inputMode"],
  gate: ["gateThresholdDb", "gateReleaseMs"],
  compressor: ["compressorEnabled", "compressorDetail", "compressorMix", "compressorVolumeDb", "compressorComp"],
  "tape-echo": ["tapeEchoEnabled", "tapeEchoMix", "tapeEchoTimeMs", "tapeEchoFeedback", "tapeEchoMod", "tapeEchoTone"],
  octaver: ["octaverEnabled", "octaverDownMix", "octaverUpMix", "octaverDirectMix"],
  "precision-drive": ["precisionDriveEnabled", "precisionDriveVolumeDb", "precisionDriveBright", "precisionDriveAttack", "precisionDriveGate", "precisionDriveDrive"],
  chaos: ["chaosEnabled", "chaosDrive", "chaosTone", "chaosMix", "chaosLevelDb"],
  laser: ["laserEnabled", "laserMode", "laserMix", "laserSpeedHz", "laserSensitivity", "laserEnvelopeMode", "laserTrigger"],
  amp: ["ampEnabled", "ampGainDb", "ampBoost", "ampVoice", "ampMix", "ampOutputDb", "bassDb", "midDb", "trebleDb", "presenceDb"],
  cab: ["cabEnabled", "cabMicPosition", "cabMicDistance", "cabMicBlend", "cabRoomSend", "cabLevelDb", "cabPan", "cabHPFHz", "cabLPFHz", "cabPhaseInvert"],
  eq: ["eqEnabled"],
  mod: ["modulatorEnabled", "chorusMix", "chorusRateHz", "chorusDepth", "chorusCharacter", "modulatorMode", "modulatorFeedback", "modulatorAutoRandom", "modulatorAutoSpeed", "modulatorPedalMode", "modulatorPedalPosition"],
  delay: ["delayEnabled", "delayMix", "delayTimeMs", "delayFeedback", "delayMod", "delayDucker", "delayMode", "delayPingPong", "delayTempoSync"],
  reverb: ["reverbEnabled", "reverbMix", "reverbDecaySec", "reverbPreDelayMs", "reverbLowCutHz", "reverbTone", "reverbShimmer"],
  output: ["outputTrimDb"],
} as const;

export type NAMRackAdvancedStageId = keyof typeof NAM_RACK_ADVANCED_CONTROL_IDS;

export const NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS = NAM_RACK_LASER_MODE_OPTIONS;

/**
 * Keep the native numeric mode identity stable while presenting names that
 * describe the current DSP behavior.
 */
export function projectNAMRackParamForUI(param: BuiltInParamDescriptor): BuiltInParamDescriptor {
  if (param.id !== "laserMode") return param;
  const supportedValue = NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS.some(
    (option) => option.value === Math.round(param.value),
  )
    ? Math.round(param.value)
    : NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[0].value;
  const supportedDefault = NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS.some(
    (option) => option.value === Math.round(param.defaultValue),
  )
    ? Math.round(param.defaultValue)
    : NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[0].value;

  return {
    ...param,
    value: supportedValue,
    min: NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[0].value,
    max: NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS[NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS.length - 1].value,
    defaultValue: supportedDefault,
    enumOptions: NAM_RACK_SUPPORTED_LASER_MODE_OPTIONS.map((option) => ({ ...option })),
  };
}

const NAM_RACK_ADVANCED_FIXED_PRE_ORDER = [
  "input",
  "gate",
  "compressor",
  "tape-echo",
  "octaver",
  "precision-drive",
  "chaos",
  "laser",
  "amp",
  "cab",
] as const;

const NAM_RACK_ADVANCED_POST_IDS = ["eq", "mod", "delay", "reverb"] as const;
const NAM_RACK_ADVANCED_TAIL_ORDER = ["output"] as const;
const NAM_RACK_ADVANCED_STAGE_IDS = new Set<string>([
  ...NAM_RACK_ADVANCED_FIXED_PRE_ORDER,
  ...NAM_RACK_ADVANCED_POST_IDS,
  ...NAM_RACK_ADVANCED_TAIL_ORDER,
]);

export function namRackAdvancedStageForCompactModule(moduleId: string): NAMRackAdvancedStageId | null {
  if (moduleId === "amp-nam") return "amp";
  if (moduleId === "cab-ir") return "cab";
  return NAM_RACK_ADVANCED_STAGE_IDS.has(moduleId) ? moduleId as NAMRackAdvancedStageId : null;
}

/**
 * Mirrors S13NAMRack::processBlock and processPostFX. Keeping the ordering
 * policy here makes Advanced controls follow the audible route even after the
 * user reorders the four movable post-cab stages.
 */
export function orderNAMRackMixerStages(
  stages: RackMixerStripSpec[],
  postOrder: readonly string[],
) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const allowedPostIds = new Set<string>(NAM_RACK_ADVANCED_POST_IDS);
  const orderedPostIds: string[] = [];

  for (const id of postOrder) {
    if (allowedPostIds.has(id) && !orderedPostIds.includes(id)) orderedPostIds.push(id);
  }
  for (const id of NAM_RACK_ADVANCED_POST_IDS) {
    if (!orderedPostIds.includes(id)) orderedPostIds.push(id);
  }

  return [
    ...NAM_RACK_ADVANCED_FIXED_PRE_ORDER,
    ...orderedPostIds,
    ...NAM_RACK_ADVANCED_TAIL_ORDER,
  ]
    .map((id) => byId.get(id))
    .filter((stage): stage is RackMixerStripSpec => Boolean(stage));
}

type RackMixerHelpers = {
  formatDb: (levelDb: number | undefined) => string;
  meterPercent: (levelDb: number | undefined) => number;
};

function RackMixerStrip({
  stage,
  onParamChange,
  formatDb,
  meterPercent,
  focused,
}: {
  stage: RackMixerStripSpec;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
  focused?: boolean;
} & RackMixerHelpers) {
  const meterStyle = {
    "--nam-meter-pct": `${meterPercent(stage.meterDb) * 100}%`,
    "--nam-inspector-width": `${stage.params.length <= 1 ? 460 : stage.params.length === 2 ? 580 : stage.params.length <= 4 ? 720 : 860}px`,
  } as CSSProperties;

  return (
    <article
      className="nam-rack-mixer-strip"
      data-stage={stage.id}
      data-active={stage.active}
      data-warning={stage.warning || undefined}
      data-focused={focused || undefined}
      data-unavailable={stage.available === false || undefined}
      aria-disabled={stage.available === false || undefined}
      style={meterStyle}
    >
      <div className="nam-rack-mixer-strip-head">
        <span>{stage.label}</span>
        <strong>{stage.caption}</strong>
      </div>
      <div className="nam-rack-mixer-meter" aria-label={`${stage.label} level ${formatDb(stage.meterDb)}`}>
        <i aria-hidden="true" />
      </div>
      <div className="nam-rack-mixer-controls">
        {stage.available === false && (
          <small className="nam-rack-mixer-unavailable">
            {stage.unavailableReason ?? "This stage is unavailable."}
          </small>
        )}
        {stage.available !== false && stage.dependencyNote && (
          <small className="nam-rack-mixer-dependency-note">
            {stage.dependencyNote}
          </small>
        )}
        {stage.params.length > 0 ? (
          stage.params.map((param) => (
            <RackKnob
              key={param.id}
              param={param}
              onChange={onParamChange}
              disabled={stage.available === false || stage.disabledParamIds?.includes(param.id)}
              disabledReason={stage.disabledParamReasons?.[param.id]}
            />
          ))
        ) : (
          <small>{stage.active ? "Signal present" : "No direct mixer control"}</small>
        )}
      </div>
    </article>
  );
}

export function NAMRackMixerView({
  stages,
  postCabOrderLabel,
  ampActive,
  hasCabIR,
  onParamChange,
  formatDb,
  meterPercent,
  onClose,
  focusedStageId,
  onSelectStage,
}: {
  stages: RackMixerStripSpec[];
  postCabOrderLabel: string;
  ampActive: boolean;
  hasCabIR: boolean;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
  onClose?: () => void;
  focusedStageId?: NAMRackAdvancedStageId | null;
  onSelectStage: (stageId: NAMRackAdvancedStageId) => void;
} & RackMixerHelpers) {
  const selectedStage = (
    focusedStageId
      ? stages.find((stage) => stage.id === focusedStageId)
      : undefined
  ) ?? stages[0];

  return (
    <section
      className="nam-rack-mixer-view"
      data-qa="nam-rack-mixer"
      data-focused-stage={selectedStage?.id}
      data-single-stage="true"
    >
      <div className="nam-rack-mixer-header">
        <SlidersHorizontal size={15} />
        <div className="nam-rack-mixer-heading">
          <span>Device inspector</span>
          <strong>{selectedStage?.label ?? "No device selected"}</strong>
          <small>
            {selectedStage
              ? "Only the controls for this signal-chain stage are shown."
              : "There are no supported controls in this signal chain."}
          </small>
        </div>
        <label className="nam-rack-mixer-stage-picker">
          <span>Stage</span>
          <select
            aria-label="Inspector stage"
            value={selectedStage?.id ?? ""}
            disabled={stages.length === 0}
            onChange={(event) => onSelectStage(event.target.value as NAMRackAdvancedStageId)}
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.label}
              </option>
            ))}
          </select>
        </label>
        {onClose && (
          <button type="button" data-qa="nam-mixer-back" onClick={onClose}>
            <ArrowLeft size={14} aria-hidden="true" />
            Back to rack
          </button>
        )}
      </div>
      <div className="nam-rack-mixer-grid">
        {selectedStage ? (
          <RackMixerStrip
            key={selectedStage.id}
            stage={selectedStage}
            onParamChange={onParamChange}
            formatDb={formatDb}
            meterPercent={meterPercent}
            focused
          />
        ) : (
          <div className="nam-rack-mixer-empty">No supported stage controls are available.</div>
        )}
      </div>
      <div className="nam-rack-mixer-foot">
        <span>{postCabOrderLabel}</span>
        <strong>{ampActive ? "Amp active" : "Amp bypassed"}</strong>
        <strong>{hasCabIR ? "IR configured" : "No IR"}</strong>
      </div>
    </section>
  );
}

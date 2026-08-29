import "./NAMRackMixer.css";
import { type CSSProperties } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { type BuiltInParamDescriptor } from "../services/NativeBridge";
import { RackKnob } from "./NAMRackKnob";

export type RackMixerParamGroupSpec = {
  id: string;
  label: string;
  paramIds: readonly string[];
};

export type RackMixerStripSpec = {
  id: string;
  label: string;
  caption: string;
  active: boolean;
  meterDb?: number;
  params: BuiltInParamDescriptor[];
  paramGroups?: readonly RackMixerParamGroupSpec[];
  warning?: boolean;
  available?: boolean;
  unavailableReason?: string;
  disabledParamIds?: readonly string[];
  disabledParamReasons?: Readonly<Record<string, string>>;
  dependencyNote?: string;
};

export const NAM_RACK_REVERB_ADVANCED_CONTROL_GROUPS = [
  {
    id: "reverb",
    label: "Reverb",
    paramIds: [
      "reverbEnabled",
      "reverbVoice",
      "reverbMix",
      "reverbDecaySec",
      "reverbPreDelayMs",
      "reverbLowCutHz",
      "reverbTone",
      "reverbShimmer",
      "reverbPad",
    ],
  },
] as const satisfies readonly RackMixerParamGroupSpec[];

export const NAM_RACK_CABINET_SPACE_PARAM_IDS = [
  "cabRoomEnabled",
  "cabRoomAmount",
  "cabRoomWidth",
  "cabDoublerEnabled",
  "cabDoublerMix",
  "cabDoublerDelayMs",
  "cabDoublerSpread",
] as const;

export function isNAMRackCabinetSpaceParamId(paramId: string) {
  return (NAM_RACK_CABINET_SPACE_PARAM_IDS as readonly string[]).includes(paramId);
}

export const NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS = [
  {
    id: "cabinet-ir",
    label: "Cabinet & IR",
    paramIds: [
      "cabEnabled",
      "cabMicPosition",
      "cabMicDistance",
      "cabMicBlend",
      "cabRoomSend",
      "cabLevelDb",
      "cabPan",
      "cabHPFHz",
      "cabLPFHz",
      "cabPhaseInvert",
    ],
  },
  {
    id: "room",
    label: "Room",
    paramIds: ["cabRoomEnabled", "cabRoomAmount", "cabRoomWidth"],
  },
  {
    id: "doubler",
    label: "Doubler",
    paramIds: ["cabDoublerEnabled", "cabDoublerMix", "cabDoublerDelayMs", "cabDoublerSpread"],
  },
] as const satisfies readonly RackMixerParamGroupSpec[];

export const NAM_RACK_ADVANCED_CONTROL_IDS = {
  input: ["inputTrimDb"],
  gate: ["gateThresholdDb", "gateReleaseMs"],
  compressor: ["compressorEnabled", "compressorComp", "compressorAttackMs", "compressorReleaseMs", "compressorToneDb", "compressorIntensity", "compressorSidechainHPF", "compressorMix", "compressorVolumeDb"],
  octaver: ["octaverEnabled", "octaverDownMix", "octaverUpMix", "octaverDirectMix"],
  "pre-eq": ["preEqEnabled", "preEq120Db", "preEq250Db", "preEq500Db", "preEq1kDb", "preEq2k5Db", "preEq5kDb", "preEq8kDb", "preEq12kDb", "preEqHPFHz", "preEqLPFHz"],
  "precision-drive": [
    "precisionDriveEnabled", "precisionDriveDrive", "precisionDriveVolumeDb", "precisionDriveBright", "precisionDriveAttack", "precisionDriveGate",
  ],
  chaos: ["chaosEnabled", "chaosMode", "chaosDrive", "chaosWeight", "chaosTone", "chaosGate", "chaosMix", "chaosLevelDb"],
  "pedal-capture": ["pedalMix"],
  amp: ["ampEnabled", "ampGainDb", "ampBoost", "ampVoice", "ampMix", "ampOutputDb", "bassDb", "midDb", "trebleDb", "presenceDb"],
  cab: [...NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS[0].paramIds],
  room: ["cabRoomEnabled", "cabRoomAmount", "cabRoomWidth"],
  doubler: ["cabDoublerEnabled", "cabDoublerMix", "cabDoublerDelayMs", "cabDoublerSpread"],
  eq: [
    "eqEnabled",
    "eqHPFHz",
    "eq65Db",
    "eq125Db",
    "eq250Db",
    "eq500Db",
    "eq1kDb",
    "eq2kDb",
    "eq4kDb",
    "eq8kDb",
    "eq16kDb",
    "eqLPFHz",
    "eqLevelDb",
  ],
  mod: ["modulatorEnabled", "chorusMix", "chorusRateHz", "chorusDepth", "chorusCharacter", "modulatorMode", "modulatorFeedback", "modulatorAutoRandom", "modulatorAutoSpeed", "modulatorPedalMode", "modulatorPedalPosition"],
  delay: ["delayEnabled", "delayMix", "delayTimeMs", "delayFeedback", "delayMod", "delayDucker", "delayMode", "delayPingPong", "delayTempoSync"],
  reverb: NAM_RACK_REVERB_ADVANCED_CONTROL_GROUPS.flatMap((group) => [...group.paramIds]),
  output: ["outputTrimDb"],
} as const;

/* Parameters intentionally absent from the hardware faceplates. Keep this
   separate from the complete registry above because the latter also powers
   scene bindings and compact signal-chain summaries. */
export const NAM_RACK_ADVANCED_ONLY_CONTROL_IDS = {
  input: [],
  gate: ["gateReleaseMs"],
  compressor: [],
  octaver: [],
  "pre-eq": [],
  "precision-drive": [],
  chaos: [],
  // The active Design Port does not expose the Pedal NAM wet/dry control on
  // its faceplate. Keep it in Device Controls so the compact-chain Edit action
  // has a real destination and pedalMix remains user-editable.
  "pedal-capture": ["pedalMix"],
  amp: [],
  cab: [],
  room: [],
  doubler: [],
  eq: [],
  mod: ["modulatorAutoRandom", "modulatorAutoSpeed", "modulatorPedalPosition"],
  delay: ["delayPingPong"],
  reverb: [],
  output: [],
} as const satisfies Record<NAMRackAdvancedStageId, readonly string[]>;

export type NAMRackAdvancedStageId = keyof typeof NAM_RACK_ADVANCED_CONTROL_IDS;

const NAM_RACK_ADVANCED_FIXED_PRE_ORDER = [
  "input",
  "gate",
  "compressor",
  "octaver",
  "pre-eq",
  "precision-drive",
  "chaos",
  "pedal-capture",
  "amp",
  "cab",
  "room",
  "doubler",
] as const;

const NAM_RACK_ADVANCED_POST_IDS = ["eq", "mod", "delay", "reverb"] as const;
const NAM_RACK_ADVANCED_TAIL_ORDER = ["output"] as const;
const NAM_RACK_ADVANCED_STAGE_IDS = new Set<string>([
  ...NAM_RACK_ADVANCED_FIXED_PRE_ORDER,
  ...NAM_RACK_ADVANCED_POST_IDS,
  ...NAM_RACK_ADVANCED_TAIL_ORDER,
]);

export function namRackAdvancedStageForCompactModule(moduleId: string): NAMRackAdvancedStageId | null {
  const stageId = moduleId === "amp-nam"
    ? "amp"
    : moduleId === "cab-ir"
      ? "cab"
      : moduleId === "cabinet-space" || moduleId === "room"
        ? "room"
        : moduleId === "doubler"
          ? "doubler"
          : NAM_RACK_ADVANCED_STAGE_IDS.has(moduleId)
            ? moduleId as NAMRackAdvancedStageId
            : null;
  return stageId && NAM_RACK_ADVANCED_ONLY_CONTROL_IDS[stageId].length > 0 ? stageId : null;
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
  const paramsById = new Map(stage.params.map((param) => [param.id, param]));
  const groupedParamIds = new Set(stage.paramGroups?.flatMap((group) => [...group.paramIds]) ?? []);
  const groupedSections = (stage.paramGroups ?? [])
    .map((group) => ({
      ...group,
      params: group.paramIds
        .map((paramId) => paramsById.get(paramId))
        .filter((param): param is BuiltInParamDescriptor => Boolean(param)),
    }))
    .filter((group) => group.params.length > 0);
  const ungroupedParams = stage.params.filter((param) => !groupedParamIds.has(param.id));
  const renderParam = (param: BuiltInParamDescriptor) => (
    <RackKnob
      key={param.id}
      param={param}
      onChange={onParamChange}
      disabled={stage.available === false || stage.disabledParamIds?.includes(param.id)}
      disabledReason={stage.disabledParamReasons?.[param.id]}
    />
  );

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
        {stage.available !== false && (
          stage.params.length > 0 ? (
            groupedSections.length > 0 ? (
              <div className="nam-rack-mixer-control-groups">
                {groupedSections.map((group) => (
                  <section key={group.id} className="nam-rack-mixer-control-group" data-control-group={group.id}>
                    <strong>{group.label}</strong>
                    <div>{group.params.map(renderParam)}</div>
                  </section>
                ))}
                {ungroupedParams.length > 0 && (
                  <section className="nam-rack-mixer-control-group" data-control-group="additional">
                    <strong>Additional</strong>
                    <div>{ungroupedParams.map(renderParam)}</div>
                  </section>
                )}
              </div>
            ) : stage.params.map(renderParam)
          ) : (
            <small>All controls for this stage are available on its hardware faceplate.</small>
          )
        )}
      </div>
    </article>
  );
}

export function NAMRackMixerView({
  stages,
  onParamChange,
  formatDb,
  meterPercent,
  onClose,
  focusedStageId,
}: {
  stages: RackMixerStripSpec[];
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
  onClose?: () => void;
  focusedStageId?: NAMRackAdvancedStageId | null;
} & RackMixerHelpers) {
  const advancedStages = stages.filter((stage) => stage.params.length > 0);
  const selectedStage = (
    focusedStageId
      ? advancedStages.find((stage) => stage.id === focusedStageId)
      : undefined
  ) ?? advancedStages[0];

  if (!selectedStage) return null;

  return (
    <section
      className="nam-rack-mixer-view nam-rack-context-inspector"
      data-qa="nam-rack-mixer"
      data-focused-stage={selectedStage?.id}
      data-single-stage="true"
      data-compact={(selectedStage?.params.length ?? 0) <= 4 || undefined}
      data-control-count={selectedStage?.params.length ?? 0}
      role="dialog"
      aria-label={`${selectedStage.label} advanced controls`}
    >
      <div className="nam-rack-mixer-header">
        <SlidersHorizontal size={15} />
        <div className="nam-rack-mixer-heading">
          <span>Advanced</span>
          <strong>{selectedStage?.label ?? "No device selected"}</strong>
          <small>Controls not exposed on the hardware faceplate.</small>
        </div>
        {onClose && (
          <button type="button" data-qa="nam-mixer-back" onClick={onClose} aria-label="Close advanced controls">
            <X size={15} aria-hidden="true" />
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
    </section>
  );
}

import { type CSSProperties } from "react";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
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
    ],
  },
] as const satisfies readonly RackMixerParamGroupSpec[];

export const NAM_RACK_CABINET_SPACE_PARAM_IDS = [
  "cabRoomEnabled",
  "cabRoomAmount",
  "cabRoomWidth",
  "cabDoublerEnabled",
  "cabDoublerMix",
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
    paramIds: ["cabDoublerEnabled", "cabDoublerMix", "cabDoublerSpread"],
  },
] as const satisfies readonly RackMixerParamGroupSpec[];

export const NAM_RACK_ADVANCED_CONTROL_IDS = {
  input: ["inputTrimDb"],
  gate: ["gateThresholdDb", "gateReleaseMs"],
  compressor: [
    "compressorEnabled",
    "compressorComp",
    "compressorAttackMs",
    "compressorReleaseMs",
    "compressorToneDb",
    "compressorSidechainHPF",
    "compressorMix",
    "compressorVolumeDb",
  ],
  "tape-echo": ["tapeEchoEnabled", "tapeEchoMix", "tapeEchoTimeMs", "tapeEchoFeedback", "tapeEchoMod", "tapeEchoTone"],
  octaver: ["octaverEnabled", "octaverDownMix", "octaverUpMix", "octaverDirectMix"],
  "precision-drive": ["precisionDriveEnabled", "precisionDriveVolumeDb", "precisionDriveBright", "precisionDriveAttack", "precisionDriveGate", "precisionDriveDrive"],
  chaos: ["chaosEnabled", "chaosMode", "chaosDrive", "chaosWeight", "chaosTone", "chaosGate", "chaosMix", "chaosLevelDb"],
  "pedal-capture": ["pedalMix"],
  amp: ["ampEnabled", "ampGainDb", "ampBoost", "ampVoice", "ampMix", "ampOutputDb", "bassDb", "midDb", "trebleDb", "presenceDb"],
  cab: [...NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS[0].paramIds],
  room: ["cabRoomEnabled", "cabRoomAmount", "cabRoomWidth"],
  doubler: ["cabDoublerEnabled", "cabDoublerMix", "cabDoublerSpread"],
  eq: ["eqEnabled", "eqLevelDb"],
  mod: ["modulatorEnabled", "chorusMix", "chorusRateHz", "chorusDepth", "chorusCharacter", "modulatorMode", "modulatorFeedback", "modulatorAutoRandom", "modulatorAutoSpeed", "modulatorPedalMode", "modulatorPedalPosition"],
  delay: ["delayEnabled", "delayMix", "delayTimeMs", "delayFeedback", "delayMod", "delayDucker", "delayMode", "delayPingPong", "delayTempoSync"],
  reverb: NAM_RACK_REVERB_ADVANCED_CONTROL_GROUPS.flatMap((group) => [...group.paramIds]),
  output: ["outputTrimDb"],
} as const;

export type NAMRackAdvancedStageId = keyof typeof NAM_RACK_ADVANCED_CONTROL_IDS;

const NAM_RACK_ADVANCED_FIXED_PRE_ORDER = [
  "input",
  "gate",
  "compressor",
  "tape-echo",
  "octaver",
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
  if (moduleId === "amp-nam") return "amp";
  if (moduleId === "cab-ir") return "cab";
  if (moduleId === "cabinet-space" || moduleId === "room") return "room";
  if (moduleId === "doubler") return "doubler";
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
        {stage.params.length > 0 ? (
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

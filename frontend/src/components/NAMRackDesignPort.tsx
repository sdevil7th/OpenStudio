import {
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Cable,
  ChevronRight,
  Download,
  FolderOpen,
  Gauge,
  Heart,
  Library,
  Maximize2,
  Power,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-react";

import {
  getNAMDesignAsset,
  type NAMDesignAsset,
  type NAMDesignBodyAssetId,
  type NAMDesignControlAssetId,
} from "./NAMDesignAssets";
import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import {
  clampNumber,
  formatParamValue,
  normalizeParam,
  quantizeParamValue,
  stepForParam,
} from "../utils/builtInParamValue";
import type { RackModuleId } from "./NAMRackPedalHardware";
import type { RackSectionId } from "./NAMRackNeuralSkinRegistry";
import type { NAMRackCabMode } from "./NAMCabPresentation";
import type { NAMRackAdvancedStageId } from "./NAMRackMixer";
import { namMeterFraction } from "../utils/namMeterLevel";

type DesignBoardId =
  | "03-pre-fx-section"
  | "04-amp-section"
  | "05-cab-section"
  | "06-eq-section"
  | "07-post-fx-section";

export type NAMSourceFlowDesignMode = "amp" | "pedal" | "ir" | "fx";

export type NAMSourceFlowDesignBoardId =
  | "11-tone-library-amp-flow"
  | "12-tone-library-pedal-flow"
  | "13-ir-source-flow"
  | "14-fx-collection-flow";

export type NAMSourceFlowDesignActionId =
  | "return"
  | "query"
  | "search"
  | "retry"
  | "previous-page"
  | "next-page"
  | "load-more"
  | "tab"
  | "filter"
  | "sort"
  | "favorite"
  | "clear-filters"
  | "select-row"
  | "preview"
  | "load"
  | "save-preset"
  | "use-selection"
  | "revert"
  | "apply-preset"
  | "load-local-nam"
  | "load-local-ir"
  | "open-ir-sources"
  | "open-source";

export type NAMSourceFlowDesignResult = {
  id: string;
  name: string;
  creator: string;
  kind: string;
  arch: string;
  category: string;
  tags: string[];
  downloads: string;
  likes: string;
  stateLabel: string;
  state: "preview" | "installed" | "online" | "missing" | "external";
  action: string;
  actionId: NAMSourceFlowDesignActionId;
  active?: boolean;
  artUrl?: string;
  favorite?: boolean;
  source: "tone3000" | "local" | "openstudio" | "external";
};

export type NAMSourceFlowDesignConfig = {
  boardId: NAMSourceFlowDesignBoardId;
  mode: NAMSourceFlowDesignMode;
  originId: string;
  originLabel: string;
  sourceMode: string;
  sourceLabel: string;
  targetSlot: string;
  targetLabel: string;
  returnLabel: string;
  authState: "connected" | "local" | "offline" | "warning";
  authTitle: string;
  authDetail: string;
  statusAction?: { id: NAMSourceFlowDesignActionId; label: string };
  searchLabel: string;
  searchText: string;
  searchAction: string;
  query: string;
  tabs: string[];
  activeTab: number;
  filters: Array<{ id: string; label: string; active?: boolean; attr?: string }>;
  sortValue: string;
  sortOptions: Array<{ value: string; label: string }>;
  targets: Array<{ id: string; label: string; model: string; meta: string; active?: boolean; preview?: boolean }>;
  localTitle: string;
  localDetail: string;
  feedTitle: string;
  sortLabel: string;
  viewLabel: string;
  results: NAMSourceFlowDesignResult[];
  pagination?: {
    page: number;
    totalPages: number;
    totalResults: number;
    hasPrevious: boolean;
    hasMore: boolean;
    canLoadMore: boolean;
    mode: "live" | "cache";
  };
  detailEyebrow: string;
  selectedRowId?: string;
  selectedName: string;
  selectedMeta: string;
  selectedAvailable: boolean;
  selectedArtUrl?: string;
  selectedTags: string[];
  selectedStats: string[];
  detailMeta: string[];
  previewBody: string;
  controlAssetIds: string[];
  previewText: string;
  brand?: string;
  actions: Array<{ id: NAMSourceFlowDesignActionId; label: string; primary?: boolean; disabled?: boolean }>;
  statusTitle: string;
  route: string;
  statusDetail: string;
  resultCount: number;
  resultTotal?: number;
  busy: boolean;
  emptyTitle: string;
  emptyBody: string;
  emptyAction?: { id: NAMSourceFlowDesignActionId; label: string; primary?: boolean };
};

export type NAMSourceFlowDesignPortMessage = {
  type: "nam-source-flow-design-port";
  instanceId: string;
  action: NAMSourceFlowDesignActionId;
  value?: string;
  rowId?: string;
};

type DesignSectionId = Extract<RackSectionId, "pre" | "amp" | "cab" | "eq" | "post">;
type DesignBox = { x: number; y: number; w: number; h: number };
type NativeStyle = CSSProperties & Record<`--${string}`, string | number>;

const SECTION_TO_BOARD: Record<DesignSectionId, DesignBoardId> = {
  pre: "03-pre-fx-section",
  amp: "04-amp-section",
  cab: "05-cab-section",
  eq: "06-eq-section",
  post: "07-post-fx-section",
};

const SOURCE_FLOW_TO_BOARD: Record<NAMSourceFlowDesignMode, NAMSourceFlowDesignBoardId> = {
  amp: "11-tone-library-amp-flow",
  pedal: "12-tone-library-pedal-flow",
  ir: "13-ir-source-flow",
  fx: "14-fx-collection-flow",
};

const SECTION_TARGET_MODULE: Record<DesignSectionId, RackModuleId> = {
  pre: "pedal",
  amp: "amp",
  cab: "cab",
  eq: "eq",
  post: "delay",
};

const MODULE_NAME_TO_ID: Record<string, RackModuleId> = {
  gate: "gate",
  booster: "pedal",
  tone: "pedal",
  compressor: "pedal",
  overdrive: "pedal",
  "tape-echo": "pedal",
  octaver: "pedal",
  "precision-drive": "pedal",
  "amp-head": "amp",
  cabinet: "cab",
  "mic-panel": "cab",
  "eq-rack": "eq",
  modulator: "mod",
  delay: "delay",
  reverb: "reverb",
};

// Native plugin windows have more vertical room than the 768x341 HTML boards.
// Preserve the board x composition, but give the active hardware modules taller
// local boxes so bodies, knobs, and labels use that room together.
const LAYOUT = {
  pre: {
    gate: { x: 40, y: 42, w: 120, h: 232 },
    booster: { x: 173, y: 42, w: 120, h: 232 },
    tone: { x: 306, y: 42, w: 156, h: 232 },
    compressor: { x: 475, y: 42, w: 120, h: 232 },
    overdrive: { x: 608, y: 42, w: 120, h: 232 },
  },
  amp: {
    head: { x: 24, y: -2, w: 720, h: 345 },
  },
  cab: {
    cabinet: { x: 24, y: 74, w: 284, h: 190 },
    micPanel: { x: 328, y: 74, w: 416, h: 192 },
  },
  eq: {
    rack: { x: 24, y: 20, w: 720, h: 300 },
  },
  post: {
    modulator: { x: 25, y: 44, w: 220, h: 157 },
    delay: { x: 254, y: 32, w: 260, h: 182 },
    reverb: { x: 528, y: 34, w: 220, h: 177 },
  },
} as const;

const SECTION_GROUP_BOX: Record<DesignSectionId, DesignBox> = {
  pre: { x: 40, y: 3, w: 688, h: 271 },
  amp: { x: 24, y: -2, w: 720, h: 345 },
  cab: { x: 24, y: 74, w: 720, h: 192 },
  eq: { x: 24, y: 20, w: 720, h: 300 },
  post: { x: 25, y: -13, w: 723, h: 227 },
};

const LABEL_OFFSET = {
  above: -12.4,
  below: 11.2,
};

type DesignParamChangeHandler = (param: BuiltInParamDescriptor, value: number) => void;

type DesignParamContextValue = {
  paramsById: Map<string, BuiltInParamDescriptor>;
  localValues: Record<string, number>;
  setLocalValue: (paramId: string, value: number) => void;
  onParamChange?: DesignParamChangeHandler;
};

const DesignParamContext = createContext<DesignParamContextValue | null>(null);

function useBoundDesignParam(paramId?: string) {
  const context = useContext(DesignParamContext);
  const sourceParam = paramId ? context?.paramsById.get(paramId) : undefined;
  if (!sourceParam) return undefined;
  const localValue = context?.localValues[sourceParam.id];
  return typeof localValue === "number" && Number.isFinite(localValue)
    ? { ...sourceParam, value: localValue }
    : sourceParam;
}

function useDesignParamCommit(param: BuiltInParamDescriptor | undefined) {
  const context = useContext(DesignParamContext);
  return useCallback(
    (value: number) => {
      if (!param || !context?.onParamChange) return;
      const next = quantizeParamValue(param, value);
      context.setLocalValue(param.id, next);
      context.onParamChange(param, next);
    },
    [context, param],
  );
}

export type NAMRotaryDragState = {
  pointerId: number;
  centerX: number;
  centerY: number;
  startX: number;
  startY: number;
  startValue: number;
  startNormalized: number;
  lastAngle: number;
  accumulatedAngle: number;
  mode: "pending" | "angular" | "vertical";
};

export function namRotaryPointerAngle(clientX: number, clientY: number, centerX: number, centerY: number) {
  return Math.atan2(clientY - centerY, clientX - centerX) * 180 / Math.PI;
}

export function namRotaryAngleDelta(previousAngle: number, nextAngle: number) {
  let delta = nextAngle - previousAngle;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

export function namRotaryValueFromDrag(
  param: BuiltInParamDescriptor,
  drag: NAMRotaryDragState,
  clientX: number,
  clientY: number,
  fine = false,
) {
  const span = Math.max(param.max - param.min, 0.0001);
  const distanceFromCenter = Math.hypot(clientX - drag.centerX, clientY - drag.centerY);
  const mostlyVerticalDrag = Math.abs(clientX - drag.startX) < 10 && Math.abs(clientY - drag.startY) > 3;
  const angularDeadZone = 14;

  if (drag.mode === "vertical" || (drag.mode === "pending" && mostlyVerticalDrag)) {
    return {
      value: clampNumber(verticalRotaryValueFromDrag(param, drag, clientY, fine), param.min, param.max),
      lastAngle: drag.lastAngle,
      accumulatedAngle: drag.accumulatedAngle,
      mode: "vertical" as const,
    };
  }

  if (drag.mode === "angular" || distanceFromCenter >= angularDeadZone) {
    const nextAngle = namRotaryPointerAngle(clientX, clientY, drag.centerX, drag.centerY);
    const angleDelta = namRotaryAngleDelta(drag.lastAngle, nextAngle);
    const nextAccumulatedAngle = Math.abs(angleDelta) >= 0.25
      ? drag.accumulatedAngle + angleDelta
      : drag.accumulatedAngle;
    const fineScale = fine ? 0.35 : 1;
    const nextNormalized = drag.startNormalized + (nextAccumulatedAngle / 270) * fineScale;
    return {
      value: param.min + clampNumber(nextNormalized, 0, 1) * span,
      lastAngle: Math.abs(angleDelta) >= 0.25 ? nextAngle : drag.lastAngle,
      accumulatedAngle: nextAccumulatedAngle,
      mode: "angular" as const,
    };
  }

  return {
    value: clampNumber(verticalRotaryValueFromDrag(param, drag, clientY, fine), param.min, param.max),
    lastAngle: drag.lastAngle,
    accumulatedAngle: drag.accumulatedAngle,
    mode: "pending" as const,
  };
}

export function toggleNAMContinuousBypassValue(
  param: BuiltInParamDescriptor,
  rememberedValue: number,
  activeThreshold = 0.0001,
) {
  if (param.value > activeThreshold) {
    return {
      nextValue: param.min,
      rememberedValue: param.value,
    };
  }
  const defaultOnValue = param.defaultValue > activeThreshold ? param.defaultValue : param.max;
  const restoredValue = rememberedValue > activeThreshold ? rememberedValue : defaultOnValue;
  return {
    nextValue: clampNumber(restoredValue, param.min, param.max),
    rememberedValue: clampNumber(restoredValue, param.min, param.max),
  };
}

function verticalRotaryValueFromDrag(
  param: BuiltInParamDescriptor,
  drag: NAMRotaryDragState,
  clientY: number,
  fine = false,
) {
  const span = Math.max(param.max - param.min, 0.0001);
  const fineScale = fine ? 0.25 : 1;
  return drag.startValue + (drag.startY - clientY) * (span / 150) * fineScale;
}

const BODIES = {
  amp: "amp-head-body",
  cab: "cabinet-body",
  irShaper: "ir-shaper-panel-body",
  mic: "mic-panel-body",
  eq: "rack-unit-body-deep",
  blue: "stompbox-body-blue",
  dark: "stompbox-body-dark",
  darkWide: "stompbox-body-dark-wide",
  olive: "stompbox-body-olive",
  red: "stompbox-body-red",
  stone: "stompbox-body-stone",
  copperWide: "wide-pedal-body-copper-deep",
  darkWidePedal: "wide-pedal-body-dark-deep",
  blueWidePedal: "wide-pedal-body-navy-deep",
} as const satisfies Record<string, NAMDesignBodyAssetId>;

const CONTROLS = {
  button: "button-black-top",
  footOff: "footswitch-chrome-off-top",
  footOn: "footswitch-chrome-on-top",
  footPressed: "footswitch-chrome-pressed-top",
  knobBlack: "knob-black-top",
  knobCream: "knob-cream-top",
  knobMetal: "knob-metal-top",
  ledOff: "led-amber-off-top",
  ledOn: "led-amber-on-top",
  mic57: "mic-dynamic-57",
  mic121: "mic-ribbon-121",
  screw: "screw-phillips-top",
  slider: "slider-metal-top",
  toggle: "toggle-chrome-top",
  washer: "washer-chrome-top",
} as const satisfies Record<string, NAMDesignControlAssetId>;

const STUDIO_BACKDROP_URL = new URL("../assets/nam/rack-studio-backdrop-v2.webp", import.meta.url).href;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function pxBox(box: DesignBox): CSSProperties {
  return {
    left: `${box.x}px`,
    top: `${box.y}px`,
    width: `${box.w}px`,
    height: `${box.h}px`,
  };
}

function assetFrameStyle(box: DesignBox, body: NAMDesignBodyAssetId): CSSProperties {
  const asset = getNAMDesignAsset(body);
  const assetAspect = asset.width / Math.max(asset.height, 1);
  const boxAspect = box.w / Math.max(box.h, 1);
  if (boxAspect > assetAspect) {
    const widthPct = (box.h * assetAspect / Math.max(box.w, 1)) * 100;
    return {
      left: "50%",
      top: "50%",
      width: `${widthPct}%`,
      height: "100%",
      transform: "translate(-50%, -50%)",
    };
  }
  const heightPct = (box.w / assetAspect / Math.max(box.h, 1)) * 100;
  return {
    left: "50%",
    top: "50%",
    width: "100%",
    height: `${heightPct}%`,
    transform: "translate(-50%, -50%)",
  };
}

function percentStyle(vars: Record<string, string | number>): NativeStyle {
  return Object.fromEntries(Object.entries(vars).map(([key, value]) => [`--${key}`, value])) as NativeStyle;
}

function shellBoardForSection(sectionId: RackSectionId): DesignBoardId {
  if (sectionId === "pre" || sectionId === "amp" || sectionId === "cab" || sectionId === "eq" || sectionId === "post") {
    return SECTION_TO_BOARD[sectionId];
  }
  return "04-amp-section";
}

function designSectionFor(sectionId: RackSectionId): DesignSectionId {
  return sectionId === "pre" || sectionId === "amp" || sectionId === "cab" || sectionId === "eq" || sectionId === "post"
    ? sectionId
    : "amp";
}

export function sourceFlowDesignBoardForMode(mode: NAMSourceFlowDesignMode): NAMSourceFlowDesignBoardId {
  return SOURCE_FLOW_TO_BOARD[mode];
}

export function sourceFlowResourceTerms(mode: NAMSourceFlowDesignMode) {
  if (mode === "ir") return { label: "IR", title: "IR", library: "IR Library" } as const;
  if (mode === "fx") return { label: "effect preset", title: "Effect Preset", library: "Effect Preset Library" } as const;
  return { label: "capture", title: "Capture", library: "Capture Library" } as const;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 1280, height: 720 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return [ref, size] as const;
}

function computePremiumStagePlacement(
  viewport: { width: number; height: number },
  group: DesignBox,
  rackSizePercent: number,
) {
  const marginX = clamp(viewport.width * 0.035, 22, 46);
  const marginY = clamp(viewport.height * 0.035, 16, 34);
  const fitScale = Math.min(
    Math.max(0.1, (viewport.width - marginX * 2) / group.w),
    Math.max(0.1, (viewport.height - marginY * 2) / group.h),
  );
  // These are semantic stage-size presets rather than literal browser zoom.
  // Keep every preset usable without panning, but make each step visually
  // meaningful instead of presenting a 220% label for a six-percent change.
  const requestedScale = rackSizePercent >= 220
    ? 1.24
    : rackSizePercent >= 180
      ? 1.12
      : rackSizePercent >= 140
        ? 1
        : rackSizePercent >= 100
          ? 0.91
          : 0.82;
  const scale = Math.max(0.1, fitScale * requestedScale);

  return {
    left: (viewport.width - group.w * scale) / 2 - group.x * scale,
    top: (viewport.height - group.h * scale) / 2 - group.y * scale,
    scale,
  };
}

type NAMRackDesignRigSummary = {
  presetName: string;
  presetEyebrow: string;
  presetDirty: boolean;
  pedalLabel: string;
  hasPedalCapture: boolean;
  ampLabel: string;
  cabLabel: string;
  cabStatus: string;
  hasAmpCapture: boolean;
  ampCaptureMissing: boolean;
  hasCabIR: boolean;
  cabMode: NAMRackCabMode;
};

export type NAMRackDesignLibraryItem = {
  id: string;
  name: string;
  subtitle: string;
  active?: boolean;
};

export type NAMRackDesignCalibrationSummary = {
  label: string;
  status: string;
  open: boolean;
};

export type NAMRackDesignRuntimeStatus = {
  tempo: number;
  timeSignatureLabel: string;
  sampleRateLabel: string;
  bufferLabel: string;
  latencyLabel: string;
  cpuLabel?: string;
  cpuAlert?: boolean;
  dspLabel?: string;
  dspAlert?: boolean;
  diagnosticTone?: "idle" | "info" | "success" | "warning" | "error";
  diagnosticMessage?: string;
  inputLevelDb?: number;
  outputLevelDb?: number;
};

export type NAMRackDesignRecovery = {
  slot: "pedal" | "amp" | "cab";
  slotLabel: string;
  assetLabel: string;
  pathLabel: string;
  detail: string;
  busy?: boolean;
  bypassed?: boolean;
  additionalMissingCount?: number;
  onLocate: () => void;
  onReplace: () => void;
  onBypass: () => void;
};

type NAMRackDesignTunerSummary = {
  signalPresent: boolean;
  noteLabel: string;
  statusLabel: string;
  centsPct: number;
  frequencyLabel: string;
  inputLevelLabel: string;
  confidenceLabel: string;
};

function DesignAssetImage({
  assetId,
  className,
  style,
  alt = "",
  draggable = false,
}: {
  assetId: NAMDesignBodyAssetId | NAMDesignControlAssetId;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  draggable?: boolean;
}) {
  const asset: NAMDesignAsset = getNAMDesignAsset(assetId);
  return (
    <img
      className={className}
      src={asset.href}
      alt={alt}
      draggable={draggable}
      loading="eager"
      style={style}
      data-rack-design-asset-kind={asset.kind}
      data-rack-design-asset-id={asset.id}
      data-rack-design-asset-file={asset.fileName}
      data-rack-design-natural-width={asset.width}
      data-rack-design-natural-height={asset.height}
    />
  );
}

function Label({
  children,
  x,
  y,
  className = "",
}: {
  children: ReactNode;
  x: number;
  y: number;
  className?: string;
}) {
  return (
    <div className={`label ${className}`.trim()} style={{ left: `${x}%`, top: `${y}%` }}>
      {children}
    </div>
  );
}

function FootActionLabel({
  children,
  x,
  y,
  className = "",
  state,
}: {
  children: ReactNode;
  x: number;
  y: number;
  className?: string;
  state?: "on" | "off";
}) {
  return (
    <div
      className={`label foot-action-label ${className}`.trim()}
      data-foot-action={String(children)}
      data-state={state}
      style={{ left: `${x}%`, top: `${y}%` }}
    >
      {children}
    </div>
  );
}

type DesignControlInteraction = "knob" | "button";
type ControlFeedbackActivity = "hovered" | "focused" | "dragging";

function AssetControl({
  assetId,
  className,
  x,
  y,
  size,
  rot = 0,
  paramId,
  interaction = "knob",
  labelText,
  labelOffset = 8.2,
  labelClass = "",
  value = "",
  hitSize,
  allowInteraction = true,
  visuallyDisabled,
  disabledReason,
  onButtonClick,
  stateRotations,
}: {
  assetId: NAMDesignControlAssetId;
  className: string;
  x: number;
  y: number;
  size: number;
  rot?: number;
  paramId?: string;
  interaction?: DesignControlInteraction;
  labelText?: string;
  labelOffset?: number;
  labelClass?: string;
  value?: string;
  hitSize?: number;
  allowInteraction?: boolean;
  visuallyDisabled?: boolean;
  disabledReason?: string;
  onButtonClick?: (param: BuiltInParamDescriptor, commitValue: (value: number) => void) => void;
  stateRotations?: readonly number[];
}) {
  const param = useBoundDesignParam(paramId);
  const context = useContext(DesignParamContext);
  const commitParamValue = useDesignParamCommit(param);
  const hitRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<NAMRotaryDragState | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const pointerInitiatedFocusRef = useRef(false);
  const feedbackActivityRef = useRef<Record<ControlFeedbackActivity, boolean>>({
    hovered: false,
    focused: false,
    dragging: false,
  });
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const interactive = Boolean(allowInteraction && param && context?.onParamChange);
  const controlVisuallyDisabled = visuallyDisabled ?? !allowInteraction;
  const valueLabel = param ? formatParamValue(param) : value;
  const isEnum = param?.type === "enum";
  const isEnumButton = Boolean(param && isEnum && interaction === "button");
  const isToggleButton = Boolean(param && !isEnum && (interaction === "button" || param.type === "toggle"));
  const isButtonLike = Boolean(isEnumButton || isToggleButton);
  const isToggleArtwork = className.split(/\s+/).includes("toggle");
  const isSwitchControl = Boolean(param && !isEnum && isToggleArtwork && isButtonLike);
  const toggleActive = Boolean(param && param.value >= (param.min + param.max) / 2);
  const pct = param ? normalizeParam(param) : 0;
  const stateRotation = param && stateRotations?.length
    ? stateRotations[
        clamp(
          Math.round(param.value - param.min),
          0,
          stateRotations.length - 1,
        )
      ]
    : undefined;
  const visualRot = stateRotation !== undefined
    ? stateRotation
    : isToggleArtwork && param
    ? toggleActive ? 0 : 180
    : param && !isButtonLike
      ? -135 + pct * 270
      : rot;
  const title = param ? `${param.label}: ${valueLabel}` : valueLabel;
  const showsLiveFeedback = Boolean(interactive && !isButtonLike);
  const showsDisabledFeedback = Boolean(!allowInteraction && disabledReason);
  const showsControlFeedback = showsLiveFeedback || showsDisabledFeedback;
  const feedbackValue = showsDisabledFeedback ? disabledReason : valueLabel;
  const feedbackPlacement = y < 18 ? "below" : "above";
  const feedbackAlign = x <= 22 ? "start" : x >= 78 ? "end" : "center";

  const clearFeedbackTimer = useCallback(() => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
  }, []);

  const setFeedbackActivity = useCallback(
    (activity: ControlFeedbackActivity, active: boolean) => {
      feedbackActivityRef.current[activity] = active;
      clearFeedbackTimer();
      if (active) {
        if (activity === "hovered") {
          feedbackTimerRef.current = window.setTimeout(() => {
            feedbackTimerRef.current = null;
            if (feedbackActivityRef.current.hovered) setFeedbackVisible(true);
          }, 220);
        } else {
          setFeedbackVisible(true);
        }
        return;
      }
      if (Object.values(feedbackActivityRef.current).some(Boolean)) return;
      setFeedbackVisible(false);
    },
    [clearFeedbackTimer],
  );

  const showFeedbackNow = useCallback(() => {
    clearFeedbackTimer();
    setFeedbackVisible(true);
  }, [clearFeedbackTimer]);

  useEffect(() => () => clearFeedbackTimer(), [clearFeedbackTimer]);

  const stepParam = useCallback(
    (direction: number, multiplier = 1) => {
      if (!param) return;
      if (interaction === "button" || param.type === "toggle") {
        commitParamValue(param.value >= (param.min + param.max) / 2 ? param.min : param.max);
        return;
      }
      if (param.type === "enum") {
        const next = Math.round(param.value) + direction;
        commitParamValue(next > param.max ? param.min : next < param.min ? param.max : next);
        return;
      }
      commitParamValue(param.value + stepForParam(param) * direction * multiplier);
    },
    [commitParamValue, interaction, param],
  );

  const dragToValue = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || !param || drag.pointerId !== event.pointerId) return;
      const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 0.25 : 1;
      const next = namRotaryValueFromDrag(param, drag, event.clientX, event.clientY, fine < 1);
      dragRef.current = {
        ...drag,
        lastAngle: next.lastAngle,
        accumulatedAngle: next.accumulatedAngle,
        mode: next.mode,
      };
      commitParamValue(next.value);
    },
    [commitParamValue, param],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!interactive || !param || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      pointerInitiatedFocusRef.current = true;
      event.currentTarget.focus();
      if (isButtonLike) return;
      setFeedbackActivity("dragging", true);
      const rect = event.currentTarget.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      dragRef.current = {
        pointerId: event.pointerId,
        centerX,
        centerY,
        startX: event.clientX,
        startY: event.clientY,
        startValue: param.value,
        startNormalized: normalizeParam(param),
        lastAngle: namRotaryPointerAngle(event.clientX, event.clientY, centerX, centerY),
        accumulatedAngle: 0,
        mode: "pending",
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [interactive, isButtonLike, param, setFeedbackActivity],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!interactive) return;
      event.stopPropagation();
      dragToValue(event);
    },
    [dragToValue, interactive],
  );

  const finishPointerDrag = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (dragRef.current?.pointerId === event.pointerId) {
        dragToValue(event);
        dragRef.current = null;
        setFeedbackActivity("dragging", false);
      }
      pointerInitiatedFocusRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [dragToValue, setFeedbackActivity],
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!interactive || !param) return;
      event.preventDefault();
      event.stopPropagation();
      if (isButtonLike) {
        if (onButtonClick) onButtonClick(param, commitParamValue);
        else stepParam(1);
      }
    },
    [commitParamValue, interactive, isButtonLike, onButtonClick, param, stepParam],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (!interactive || !param || isButtonLike) return;
      event.preventDefault();
      event.stopPropagation();
      showFeedbackNow();
      const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 1 : 4;
      stepParam(event.deltaY > 0 ? -1 : 1, fine);
    },
    [interactive, isButtonLike, param, showFeedbackNow, stepParam],
  );

  const handleDoubleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!interactive || !param || isButtonLike) return;
      event.preventDefault();
      event.stopPropagation();
      showFeedbackNow();
      commitParamValue(param.defaultValue ?? 0);
    },
    [commitParamValue, interactive, isButtonLike, param, showFeedbackNow],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!interactive || !param) return;
      showFeedbackNow();
      const arrowMultiplier = event.shiftKey || event.ctrlKey || event.metaKey ? 1 : 4;
      if ((event.key === "Enter" || event.key === " ") && isButtonLike) {
        event.preventDefault();
        event.stopPropagation();
        if (onButtonClick) onButtonClick(param, commitParamValue);
        else stepParam(1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        stepParam(1, arrowMultiplier);
      } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        stepParam(-1, arrowMultiplier);
      } else if (event.key === "PageUp") {
        event.preventDefault();
        event.stopPropagation();
        stepParam(1, 8);
      } else if (event.key === "PageDown") {
        event.preventDefault();
        event.stopPropagation();
        stepParam(-1, 8);
      } else if (!isToggleButton && event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        commitParamValue(param.min);
      } else if (!isToggleButton && event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        commitParamValue(param.max);
      }
    },
    [commitParamValue, interactive, isButtonLike, isToggleButton, onButtonClick, param, showFeedbackNow, stepParam],
  );

  return (
    <>
      {(interactive || (allowInteraction && value) || showsDisabledFeedback) && (
        <span
          ref={hitRef}
          className={`control-hit ${interactive ? "interactive" : ""} ${showsDisabledFeedback ? "disabled-feedback" : ""}`.trim()}
          data-value={valueLabel}
          data-param-id={param?.id}
          data-param-value={param?.value}
          data-control-interaction={isButtonLike ? "button" : "knob"}
          title={isButtonLike && interactive ? title : undefined}
          style={percentStyle({ x: `${x}%`, y: `${y}%`, hit: `${hitSize ?? Math.max(size + 2, size * 1.25)}%` })}
          role={interactive ? (isSwitchControl ? "switch" : isEnum ? "spinbutton" : isToggleButton ? "button" : "slider") : showsDisabledFeedback ? "note" : undefined}
          tabIndex={interactive || showsDisabledFeedback ? 0 : undefined}
          aria-label={showsDisabledFeedback
            ? `${param?.label ?? labelText ?? "Control"} unavailable. ${disabledReason}`
            : param
              ? isSwitchControl ? `${param.label}: ${valueLabel}` : param.label
              : undefined}
          aria-disabled={showsDisabledFeedback || undefined}
          aria-checked={interactive && isSwitchControl && param ? toggleActive : undefined}
          aria-pressed={interactive && !isSwitchControl && isToggleButton && param ? toggleActive : undefined}
          aria-valuemin={interactive && !isSwitchControl && !isToggleButton ? param?.min : undefined}
          aria-valuemax={interactive && !isSwitchControl && !isToggleButton ? param?.max : undefined}
          aria-valuenow={interactive && !isSwitchControl && !isToggleButton ? param?.value : undefined}
          aria-valuetext={interactive && !isSwitchControl && !isToggleButton ? valueLabel : undefined}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerDrag}
          onPointerCancel={finishPointerDrag}
          onPointerEnter={() => {
            if (showsControlFeedback) setFeedbackActivity("hovered", true);
          }}
          onPointerLeave={() => {
            if (showsControlFeedback) setFeedbackActivity("hovered", false);
          }}
          onFocus={() => {
            if (showsControlFeedback && !pointerInitiatedFocusRef.current) {
              setFeedbackActivity("focused", true);
            }
          }}
          onBlur={() => {
            pointerInitiatedFocusRef.current = false;
            if (showsControlFeedback) setFeedbackActivity("focused", false);
          }}
          onClick={handleClick}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
        />
      )}
      {showsControlFeedback && (
        <span
          className="control-value-popover"
          data-visible={feedbackVisible}
          data-kind={showsDisabledFeedback ? "reason" : "value"}
          data-placement={feedbackPlacement}
          data-align={feedbackAlign}
          style={percentStyle({ x: `${x}%`, y: `${y}%` })}
          aria-hidden="true"
        >
          <small>{param?.label}</small>
          <strong>{feedbackValue}</strong>
        </span>
      )}
      <DesignAssetImage
        assetId={assetId}
        className={`asset-control ${className} ${controlVisuallyDisabled ? "control-disabled" : ""} ${isToggleArtwork ? toggleActive ? "control-on" : "control-off" : ""}`.trim()}
        style={percentStyle({ x: `${x}%`, y: `${y}%`, size: `${size}%`, rot: `${visualRot}deg` })}
      />
      {className.split(/\s+/).includes("knob") && (
        <span
          className="knob-position-indicator"
          aria-hidden="true"
          style={percentStyle({ x: `${x}%`, y: `${y}%`, size: `${size}%`, rot: `${visualRot}deg` })}
        />
      )}
      {labelText && <Label x={x} y={y + labelOffset} className={`control-label ${labelClass} ${controlVisuallyDisabled ? "control-disabled" : ""}`.trim()}>{labelText}</Label>}
    </>
  );
}

function Knob({
  kind,
  x,
  y,
  size,
  rot,
  paramId,
  labelText,
  labelOffset,
  labelClass,
  value,
  hitSize,
  allowInteraction = true,
  disabledReason,
}: {
  kind: "black" | "cream" | "metal";
  x: number;
  y: number;
  size: number;
  rot: number;
  paramId?: string;
  labelText?: string;
  labelOffset?: number;
  labelClass?: string;
  value?: string;
  hitSize?: number;
  allowInteraction?: boolean;
  disabledReason?: string;
}) {
  const assetId = kind === "metal" ? CONTROLS.knobMetal : kind === "cream" ? CONTROLS.knobCream : CONTROLS.knobBlack;
  return <AssetControl assetId={assetId} className={`knob ${kind}`} x={x} y={y} size={size} rot={rot} paramId={paramId} labelText={labelText} labelOffset={labelOffset} labelClass={labelClass} value={value} hitSize={hitSize} allowInteraction={allowInteraction} disabledReason={disabledReason} />;
}

function Foot({
  x,
  y,
  size,
  state = "off",
  paramId,
  labelText,
  value,
  hitSize,
  activeThreshold,
  preserveContinuousValue = false,
  allowInteraction = true,
  disabledReason,
  showStateLabel = false,
  stateLabelY,
}: {
  x: number;
  y: number;
  size: number;
  state?: "off" | "on" | "pressed";
  paramId?: string;
  labelText?: string;
  value?: string;
  hitSize?: number;
  activeThreshold?: number;
  preserveContinuousValue?: boolean;
  allowInteraction?: boolean;
  disabledReason?: string;
  showStateLabel?: boolean;
  stateLabelY?: number;
}) {
  const param = useBoundDesignParam(paramId);
  const threshold = activeThreshold ?? (param ? (param.min + param.max) / 2 : 0.5);
  const active = Boolean(param && param.value > threshold);
  const rememberedActiveValue = useRef(param && active ? param.value : 1);
  useEffect(() => {
    if (param && param.value > threshold) rememberedActiveValue.current = param.value;
  }, [param, threshold]);
  const resolvedState = param
    ? (active ? "on" : "off")
    : state;
  const assetId = resolvedState === "pressed" ? CONTROLS.footPressed : resolvedState === "on" ? CONTROLS.footOn : CONTROLS.footOff;
  return (
    <>
      <AssetControl
        assetId={assetId}
        className={`footswitch ${resolvedState}`}
        x={x}
        y={y}
        size={size}
        paramId={paramId}
        interaction="button"
        labelText={labelText}
        value={value}
        hitSize={hitSize}
        allowInteraction={allowInteraction}
        disabledReason={disabledReason}
        onButtonClick={preserveContinuousValue
          ? (boundParam, commitValue) => {
              const toggled = toggleNAMContinuousBypassValue(boundParam, rememberedActiveValue.current, threshold);
              rememberedActiveValue.current = toggled.rememberedValue;
              commitValue(toggled.nextValue);
            }
          : undefined}
      />
      {showStateLabel ? (
        <FootActionLabel
          x={x}
          y={stateLabelY ?? y - Math.max(8, size * 0.62)}
          className={`primary-foot-state ${allowInteraction ? "" : "control-disabled"}`}
          state={resolvedState === "on" || resolvedState === "pressed" ? "on" : "off"}
        >
          ON / OFF
        </FootActionLabel>
      ) : null}
    </>
  );
}

function Led({
  x,
  y,
  on,
  size,
  paramId,
  value,
  hitSize,
  interactive = false,
  activeThreshold,
}: {
  x: number;
  y: number;
  on: boolean;
  size: number;
  paramId?: string;
  value?: string;
  hitSize?: number;
  interactive?: boolean;
  activeThreshold?: number;
}) {
  const param = useBoundDesignParam(paramId);
  const active = param ? param.value > (activeThreshold ?? (param.min + param.max) / 2) : on;
  return <AssetControl assetId={active ? CONTROLS.ledOn : CONTROLS.ledOff} className={`led ${active ? "on" : "off"}`} x={x} y={y} size={size} paramId={paramId} interaction="button" value={value} hitSize={hitSize} allowInteraction={interactive} visuallyDisabled={false} />;
}

function Toggle({ x, y, size, paramId, labelText, labelOffset, labelClass, allowInteraction = true, disabledReason }: { x: number; y: number; size: number; paramId?: string; labelText?: string; labelOffset?: number; labelClass?: string; allowInteraction?: boolean; disabledReason?: string }) {
  return <AssetControl assetId={CONTROLS.toggle} className="toggle" x={x} y={y} size={size} paramId={paramId} interaction="button" labelText={labelText} labelOffset={labelOffset} labelClass={labelClass} allowInteraction={allowInteraction} disabledReason={disabledReason} />;
}

function ThreeWayToggle({
  x,
  y,
  size,
  labelY,
  paramId,
  labels,
}: {
  x: number;
  y: number;
  size: number;
  labelY: number;
  paramId: string;
  labels: readonly [string, string, string];
}) {
  const param = useBoundDesignParam(paramId);
  const current = clamp(
    Math.round((param?.value ?? 0) - (param?.min ?? 0)),
    0,
    2,
  );
  return (
    <>
      <div
        className="three-way-toggle-labels"
        style={{ left: `${x}%`, top: `${labelY}%` }}
        aria-hidden="true"
      >
        {labels.map((label, index) => (
          <span key={label} data-active={index === current}>{label}</span>
        ))}
      </div>
      <AssetControl
        assetId={CONTROLS.toggle}
        className="toggle three-way-toggle"
        x={x}
        y={y}
        size={size}
        paramId={paramId}
        interaction="button"
        hitSize={size * 1.45}
        stateRotations={[-38, 0, 38]}
        onButtonClick={(boundParam, commitValue) => {
          const next = Math.round(boundParam.value) + 1;
          commitValue(next > boundParam.max ? boundParam.min : next);
        }}
      />
    </>
  );
}

function Washer({ x, y, size, labelText, labelOffset, labelClass }: { x: number; y: number; size: number; labelText?: string; labelOffset?: number; labelClass?: string }) {
  return <AssetControl assetId={CONTROLS.washer} className="washer" x={x} y={y} size={size} labelText={labelText} labelOffset={labelOffset} labelClass={labelClass} />;
}

function Screw({ x, y, size = 3.8 }: { x: number; y: number; size?: number }) {
  return <AssetControl assetId={CONTROLS.screw} className="screw" x={x} y={y} size={size} />;
}

function Display({ children, x, y, w, h, className = "" }: { children: ReactNode; x: number; y: number; w: number; h: number; className?: string }) {
  return <div className={`module-display ${className}`.trim()} style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}>{children}</div>;
}

export function ButtonPlate({ children, x, y, w, h, hot = false, paramId }: { children?: ReactNode; x: number; y: number; w: number; h: number; hot?: boolean; paramId?: string }) {
  const param = useBoundDesignParam(paramId);
  const commitParamValue = useDesignParamCommit(param);
  const active = param ? param.value >= (param.min + param.max) / 2 : hot;
  const valueLabel = param ? formatParamValue(param) : "";
  const isEnum = param?.type === "enum";
  return (
    <button
      type="button"
      className={`asset-button ${active ? "hot" : ""}`.trim()}
      style={percentStyle({ x: `${x}%`, y: `${y}%`, w: `${w}%`, h: `${h}%` })}
      data-param-id={param?.id}
      data-param-value={param?.value}
      disabled={!param}
      onClick={(event) => {
        event.stopPropagation();
        if (!param) return;
        commitParamValue(param.value >= (param.min + param.max) / 2 ? param.min : param.max);
      }}
      title={param ? `${param.label}: ${valueLabel}` : undefined}
      aria-label={param ? (isEnum ? `${param.label}: ${valueLabel}` : param.label) : undefined}
      aria-pressed={param && !isEnum ? active : undefined}
    >
      <DesignAssetImage assetId={CONTROLS.button} />
      {children && <span>{children}</span>}
    </button>
  );
}

function Fader({ x, y, h, paramId, labelText, value = 52, className = "" }: { x: number; y: number; h: number; paramId?: string; labelText?: string; value?: number; className?: string }) {
  const param = useBoundDesignParam(paramId);
  const context = useContext(DesignParamContext);
  const commitParamValue = useDesignParamCommit(param);
  const interactive = Boolean(param && context?.onParamChange);
  const faderRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number } | null>(null);
  const pct = param ? normalizeParam(param) : undefined;
  const visualValue = pct === undefined ? value : (1 - pct) * 100;
  const valueLabel = param ? formatParamValue(param) : undefined;
  const pointerToValue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!param) return;
      const rect = faderRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
      const nextPct = clampNumber(1 - ((event.clientY - rect.top) / Math.max(rect.height, 1)), 0, 1);
      commitParamValue(param.min + nextPct * Math.max(param.max - param.min, 0.0001));
    },
    [commitParamValue, param],
  );
  const dragToValue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
      pointerToValue(event);
    },
    [pointerToValue],
  );
  return (
    <>
      <div
        className={`fader ${className} ${interactive ? "interactive" : ""}`.trim()}
        style={percentStyle({ x: `${x}%`, y: `${y}%`, h: `${h}%`, value: `${visualValue}%` })}
        data-param-id={param?.id}
        data-param-value={param?.value}
        role={interactive ? "slider" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={param?.label ?? labelText}
        aria-valuemin={param?.min}
        aria-valuemax={param?.max}
        aria-valuenow={param?.value}
        aria-valuetext={valueLabel}
        title={param ? `${param.label}: ${valueLabel}` : undefined}
        ref={faderRef}
        onPointerDown={(event) => {
          if (!interactive || !param || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          pointerToValue(event);
          dragRef.current = { pointerId: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!interactive) return;
          event.stopPropagation();
          dragToValue(event);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragToValue(event);
            dragRef.current = null;
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onWheel={(event) => {
          if (!interactive || !param) return;
          event.preventDefault();
          event.stopPropagation();
          const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 1 : 4;
          commitParamValue(param.value + stepForParam(param) * fine * (event.deltaY > 0 ? -1 : 1));
        }}
        onDoubleClick={(event) => {
          if (!interactive || !param) return;
          event.preventDefault();
          event.stopPropagation();
          commitParamValue(param.defaultValue ?? 0);
        }}
        onKeyDown={(event) => {
          if (!interactive || !param) return;
          const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 1 : 4;
          if (event.key === "ArrowUp" || event.key === "ArrowRight") {
            event.preventDefault();
            commitParamValue(param.value + stepForParam(param) * fine);
          } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
            event.preventDefault();
            commitParamValue(param.value - stepForParam(param) * fine);
          } else if (event.key === "PageUp") {
            event.preventDefault();
            commitParamValue(param.value + stepForParam(param) * 8);
          } else if (event.key === "PageDown") {
            event.preventDefault();
            commitParamValue(param.value - stepForParam(param) * 8);
          } else if (event.key === "Home") {
            event.preventDefault();
            commitParamValue(param.min);
          } else if (event.key === "End") {
            event.preventDefault();
            commitParamValue(param.max);
          }
        }}
      >
        <div className="fader-track" />
        <DesignAssetImage assetId={CONTROLS.slider} className="fader-cap" />
      </div>
      {labelText && <Label x={x} y={y + h / 2 + 8} className={`control-label dark ${className ? `${className}-label` : ""}`.trim()}>{labelText}</Label>}
    </>
  );
}

function Module({
  box,
  body,
  name,
  className = "",
  frameMode = "asset",
  bodyFit = "contain",
  title,
  titleY,
  controlsName,
  children,
}: {
  box: DesignBox;
  body: NAMDesignBodyAssetId;
  name: string;
  className?: string;
  frameMode?: "box" | "asset";
  bodyFit?: "contain" | "fill";
  title?: string;
  titleY?: number;
  controlsName?: string;
  children?: ReactNode;
}) {
  const accessibleName = controlsName ?? title ?? name;
  return (
    <div
      className={`module ${className}`.trim()}
      data-module={name}
      data-rack-module-target={MODULE_NAME_TO_ID[name]}
      role="group"
      aria-label={`${accessibleName} module`}
      style={pxBox(box)}
    >
      <div className="module-frame" style={frameMode === "asset" && bodyFit !== "fill" ? assetFrameStyle(box, body) : { inset: 0 }}>
        <DesignAssetImage assetId={body} className="module-skin" style={{ objectFit: bodyFit }} />
        {children}
        {title && <div className="module-title" style={titleY ? { top: `${titleY}%` } : undefined}>{title}</div>}
      </div>
    </div>
  );
}

function Stompbox({
  box,
  name,
  tone,
  body,
  bodyFit = "contain",
  title,
  titleY,
  children,
}: {
  box: DesignBox;
  name: string;
  tone?: keyof Pick<typeof BODIES, "blue" | "dark" | "olive" | "red" | "stone">;
  body?: NAMDesignBodyAssetId;
  bodyFit?: "contain" | "fill";
  title: string;
  titleY: number;
  children: ReactNode;
}) {
  return (
    <Module box={box} name={name} body={body ?? BODIES[tone ?? "dark"]} bodyFit={bodyFit} className="stompbox" title={title} titleY={titleY}>
      {children}
    </Module>
  );
}

function WidePedal({
  box,
  name,
  body,
  title,
  titleY,
  className = "",
  children,
}: {
  box: DesignBox;
  name: string;
  body: NAMDesignBodyAssetId;
  title: string;
  titleY: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Module box={box} name={name} body={body} className={`wide-pedal ${className}`.trim()} bodyFit="contain" title={title} titleY={titleY}>
      <Screw x={7} y={11} size={4} />
      <Screw x={93} y={11} size={4} />
      <Screw x={7} y={88} size={4} />
      <Screw x={93} y={88} size={4} />
      {children}
    </Module>
  );
}

function TopShell({
  active,
  libraryActive = false,
  previewText = "Previewing TONE3000: Emerald Twin A2 \u2192 Amp",
  presetName = "Clean Twin-style",
  presetEyebrow = "Current preset",
  presetDirty = false,
  compareSlot = "A",
  inputLevelDb = -90,
  outputLevelDb = -90,
  calibrationLabel = "No data",
  calibrationStatus = "unavailable",
  calibrationOpen = false,
  onEnterSection,
  onOpenLibrary,
  onPreviousPreset,
  onNextPreset,
  onSaveTone,
  onOpenPresetManager,
  onRecallCompare,
  onOpenCalibration,
}: {
  active: string;
  libraryActive?: boolean;
  previewText?: string;
  presetName?: string;
  presetEyebrow?: string;
  presetDirty?: boolean;
  compareSlot?: "A" | "B";
  inputLevelDb?: number;
  outputLevelDb?: number;
  calibrationLabel?: string;
  calibrationStatus?: string;
  calibrationOpen?: boolean;
  onEnterSection?: (sectionId: DesignSectionId) => void;
  onOpenLibrary?: () => void;
  onPreviousPreset?: () => void;
  onNextPreset?: () => void;
  onSaveTone?: () => void;
  onOpenPresetManager?: () => void;
  onRecallCompare?: (slot: "A" | "B") => void;
  onOpenCalibration?: () => void;
}) {
  const displayPresetName = presetName.replace(/^Current Capture\s*·\s*/i, "");
  const sections: Array<{ label: string; shortLabel: string; id: DesignSectionId; icon: ReactNode }> = [
    { label: "PEDALS", shortLabel: "PEDALS", id: "pre", icon: <PedalStageIcon /> },
    { label: "AMP", shortLabel: "AMP", id: "amp", icon: <AmpStageIcon /> },
    { label: "CAB", shortLabel: "CAB", id: "cab", icon: <CabStageIcon /> },
    { label: "EQ", shortLabel: "EQ", id: "eq", icon: <SlidersHorizontal aria-hidden="true" /> },
    { label: "POST FX", shortLabel: "POST", id: "post", icon: <Gauge aria-hidden="true" /> },
  ];
  return (
    <>
      <div className="global-strip">
        <div className="premium-brand" aria-label="OpenStudio NAM Rack">
          <span>OpenStudio</span>
          <strong>NAM RACK</strong>
          <em>Neural guitar suite</em>
          {onOpenCalibration && (
            <button
              type="button"
              className="premium-calibration-launch"
              data-qa="nam-premium-calibration"
              data-status={calibrationStatus}
              data-active={calibrationOpen}
              onClick={onOpenCalibration}
              title="Open NAM capture level calibration"
              aria-controls="nam-calibration-dialog"
              aria-expanded={calibrationOpen}
              aria-haspopup="dialog"
            >
              <Gauge aria-hidden="true" />
              <span>CAL</span>
              <strong>{calibrationLabel}</strong>
            </button>
          )}
        </div>
        <div className="global-block left">
          <CompactLevelMeter label="Pre-trim input level" levelDb={inputLevelDb} />
          <MiniParam name="INPUT TRIM" value="0.0 dB" kind="black" rot={32} paramId="inputTrimDb" />
          <MiniParam name="GATE" value="-78 dB" kind="black" rot={-14} paramId="gateThresholdDb" />
        </div>
        <div className="preset-area">
          <div className="preset-context"><i />{previewText}</div>
          <div className="preset-console">
            <button type="button" className="preset-arrow" onClick={onPreviousPreset} disabled={!onPreviousPreset} title="Previous preset" aria-label="Previous preset">
              <ArrowLeft aria-hidden="true" />
            </button>
            {onOpenPresetManager ? (
              <button
                type="button"
                className="preset-title"
                data-qa="nam-preset-title-trigger"
                onClick={onOpenPresetManager}
                title="Open preset library"
                aria-label={`Open preset library. Current preset: ${displayPresetName}`}
                aria-controls="nam-preset-manager-dialog"
                aria-haspopup="dialog"
              >
                <small>{presetEyebrow}</small>
                <b>{displayPresetName}{presetDirty ? " · edited" : ""}</b>
              </button>
            ) : (
              <div className="preset-title" title={presetName}>
                <small>{presetEyebrow}</small>
                <b>{displayPresetName}{presetDirty ? " · edited" : ""}</b>
              </div>
            )}
            <button type="button" className="preset-arrow" onClick={onNextPreset} disabled={!onNextPreset} title="Next preset" aria-label="Next preset">
              <ArrowRight aria-hidden="true" />
            </button>
            <button type="button" className="preset-save" onClick={onSaveTone} disabled={!onSaveTone} title="Save Preset" aria-label="Save Preset">
              <Save aria-hidden="true" />
              <span>Save Preset</span>
            </button>
            <div className="premium-compare" role="group" aria-label="Compare slots">
              {(["A", "B"] as const).map((slot) => (
                <button
                  key={slot}
                  type="button"
                  data-active={compareSlot === slot}
                  aria-pressed={compareSlot === slot}
                  onClick={() => onRecallCompare?.(slot)}
                  disabled={!onRecallCompare}
                  title={`Compare slot ${slot}`}
                >
                  {slot}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="tone-library-mark"
            data-active={libraryActive}
            data-rack-action="tone-library"
            onClick={onOpenLibrary}
            disabled={!onOpenLibrary}
            title="Open Capture Library"
            aria-label="Open Capture Library"
          >
            <Library aria-hidden="true" />
            {libraryActive ? "Library open" : "Browse captures"}
          </button>
        </div>
        <div className="global-block right">
          <MiniParam name="OUTPUT" value="-1.3 dB" kind="black" rot={35} paramId="outputTrimDb" />
          <CompactLevelMeter label="Output level" levelDb={outputLevelDb} />
        </div>
      </div>
      <div className="top-nav" aria-label="Signal chain sections">
        {sections.map((section, index) => (
          <span className="nav-flow-step" key={section.id}>
            <button
              type="button"
              className="nav-item"
              data-active={section.label === active}
              aria-current={section.label === active ? "page" : undefined}
              data-rack-section-target={section.id}
              onClick={() => onEnterSection?.(section.id)}
              disabled={!onEnterSection}
            >
              <span className="premium-nav-icon">{section.icon}</span>
              <b>{section.shortLabel}</b>
              <i aria-hidden="true" />
            </button>
            {index < sections.length - 1 && <ChevronRight className="nav-flow-chevron" aria-hidden="true" />}
          </span>
        ))}
      </div>
    </>
  );
}

function PedalStageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7.2 3.5h9.6l1.3 17H5.9l1.3-17Z" />
      <circle cx="10" cy="7.2" r="1.15" />
      <circle cx="14" cy="7.2" r="1.15" />
      <path d="M9 11.2h6M12 15.2v2.4" />
      <circle cx="12" cy="15.2" r="1.25" />
    </svg>
  );
}

function AmpStageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7.5 6V4.2h9V6M3 7h18v12H3z" />
      <path d="M5 9h14v5H5zM5.5 16.5h.01M9 16.5h.01M12.5 16.5h.01M16 16.5h.01M19 16.5h.01" />
    </svg>
  );
}

function CabStageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <rect x="6.5" y="5.5" width="11" height="13" rx=".8" />
      <path d="m7.5 7 9 9M11 6.5l6 6M7 11l6 6M7.5 18.5h9" opacity=".68" />
    </svg>
  );
}

function CompactLevelMeter({ label, levelDb }: { label: string; levelDb: number }) {
  const safeDb = Number.isFinite(levelDb) ? clamp(levelDb, -90, 6) : -90;
  const levelRatio = namMeterFraction(safeDb);
  return (
    <div
      className="premium-level-meter"
      data-clip={safeDb >= 0}
      data-meter-mode="linked-peak"
      style={{
        "--premium-meter-ratio": levelRatio,
        "--premium-meter-pct": `${levelRatio * 100}%`,
        "--premium-meter-inset": `${(1 - levelRatio) * 100}%`,
      } as NativeStyle}
      title={`${label}: linked peak ${safeDb.toFixed(1)} dBFS`}
      aria-label={`${label}: linked peak ${safeDb.toFixed(1)} dBFS`}
    >
      <span />
      <i />
      <strong>{safeDb <= -71.9 ? "-∞" : safeDb.toFixed(1)}</strong>
    </div>
  );
}

function MiniParam({ name, value, kind, rot, paramId }: { name: string; value: string; kind: "black" | "metal"; rot: number; paramId?: string }) {
  const param = useBoundDesignParam(paramId);
  const context = useContext(DesignParamContext);
  const readOnly = Boolean(param && !context?.onParamChange);
  return (
    <div
      className="mini-param"
      data-param-id={paramId}
      data-read-only={readOnly || undefined}
      aria-disabled={readOnly || undefined}
      title={readOnly ? `${param?.label ?? name} is read-only while the library is open. Return to the rack to edit it.` : undefined}
    >
      <Label x={50} y={7} className="dark center global-label">{name}</Label>
      <Knob kind={kind} x={50} y={47} size={54} rot={rot} paramId={paramId} />
      <strong>{param ? formatParamValue(param) : value}</strong>
    </div>
  );
}

function BoundParamValue({ paramId, fallback }: { paramId: string; fallback: string }) {
  const param = useBoundDesignParam(paramId);
  return <>{param ? formatParamValue(param) : fallback}</>;
}

function BoundParamChoice({ paramId, offLabel, onLabel }: { paramId: string; offLabel: string; onLabel: string }) {
  const param = useBoundDesignParam(paramId);
  if (!param) return <>{offLabel}</>;
  return <>{param.value >= (param.min + param.max) / 2 ? onLabel : offLabel}</>;
}

const DELAY_SYNC_LABELS = ["1/1", "1/2", "1/4", "1/8", "1/16", "1/4T", "1/8T", "1/4D", "1/8D"] as const;

export function delaySyncDisplay(modulation: number, pingPong: boolean) {
  const leftIndex = Math.trunc(clamp(2 + clamp(modulation, 0, 1) * 2, 0, DELAY_SYNC_LABELS.length - 1));
  const rightIndex = Math.trunc(clamp((pingPong ? 3 : 2) + clamp(modulation, 0, 1) * 2, 0, DELAY_SYNC_LABELS.length - 1));
  const left = DELAY_SYNC_LABELS[leftIndex];
  const right = DELAY_SYNC_LABELS[rightIndex];
  return left === right ? left : `${left} / ${right}`;
}

function BoundDelayTimeDisplay() {
  const time = useBoundDesignParam("delayTimeMs");
  const sync = useBoundDesignParam("delayTempoSync");
  const modulation = useBoundDesignParam("delayMod");
  const pingPong = useBoundDesignParam("delayPingPong");
  if ((sync?.value ?? 0) < 0.5)
    return <>{time ? formatParamValue(time) : "360 ms"}</>;
  return <>{delaySyncDisplay(modulation?.value ?? 0, (pingPong?.value ?? 0) >= 0.5)}</>;
}

function BoundDelayModeDisplay() {
  const mode = useBoundDesignParam("delayMode");
  const option = mode?.enumOptions?.find((entry) => entry.value === Math.round(mode.value));
  return <>{option?.label ?? ["Digital", "Tape", "Analog"][Math.round(mode?.value ?? 0)] ?? "Digital"}</>;
}

function Footer({
  rackSizePercent,
  tempo = 120,
  timeSignatureLabel = "4/4",
  sampleRateLabel = "--",
  bufferLabel = "--",
  latencyLabel = "--",
  cpuLabel = "--",
  cpuAlert = false,
  dspLabel = "--",
  dspAlert = false,
  tunerOpen = false,
  signalChainOpen = false,
  onOpenTuner,
  onOpenPedalboard,
  onOpenSettings,
  onOpenAdvanced,
  onCycleSize,
  onMaxSize,
}: {
  rackSizePercent: number;
  tempo?: number;
  timeSignatureLabel?: string;
  sampleRateLabel?: string;
  bufferLabel?: string;
  latencyLabel?: string;
  cpuLabel?: string;
  cpuAlert?: boolean;
  dspLabel?: string;
  dspAlert?: boolean;
  tunerOpen?: boolean;
  signalChainOpen?: boolean;
  onOpenTuner?: () => void;
  onOpenPedalboard?: () => void;
  onOpenSettings?: () => void;
  onOpenAdvanced?: () => void;
  onCycleSize?: () => void;
  onMaxSize?: () => void;
}) {
  const rackSizeLabel = rackSizePercent >= 220
    ? "Max"
    : rackSizePercent >= 180
      ? "Large"
      : rackSizePercent >= 140
        ? "Fit"
        : rackSizePercent >= 100
          ? "Small"
          : "Compact";
  return (
    <div className="footer">
      <b><Zap aria-hidden="true" /> NAM RACK</b>
      {onOpenTuner ? (
        <button type="button" data-qa="nam-premium-tuner" data-active={tunerOpen} aria-pressed={Boolean(tunerOpen)} onClick={onOpenTuner}>
          <Gauge aria-hidden="true" /> Tuner
        </button>
      ) : <span className="footer-control-spacer" aria-hidden="true" />}
      {onOpenPedalboard ? (
        <button type="button" data-qa="nam-premium-signal-chain" data-active={signalChainOpen} aria-pressed={signalChainOpen} onClick={onOpenPedalboard} title="Open the signal chain overview and supported ordering">
          <Cable aria-hidden="true" /> Signal chain
        </button>
      ) : <span className="footer-control-spacer" aria-hidden="true" />}
      {onOpenSettings ? (
        <button type="button" data-qa="nam-premium-settings" onClick={onOpenSettings} title="Open OpenStudio app audio and device settings">
          <Settings aria-hidden="true" /> App Audio
        </button>
      ) : <span className="footer-control-spacer" aria-hidden="true" />}
      {onOpenAdvanced ? (
        <button type="button" data-qa="nam-premium-advanced" onClick={onOpenAdvanced} title="Open focused controls for the current device">
          <SlidersHorizontal aria-hidden="true" /> Device controls
        </button>
      ) : <span className="footer-control-spacer" aria-hidden="true" />}
      <i />
      <span className="footer-tempo" data-qa="nam-premium-tempo">Tempo <strong>{Number.isFinite(tempo) ? tempo.toFixed(1) : "--"} BPM</strong></span>
      <span>{timeSignatureLabel}</span>
      <i />
      <span className="footer-runtime">
        {sampleRateLabel !== "--" && <strong>{sampleRateLabel}</strong>}
        {bufferLabel !== "--" && <strong>{bufferLabel}</strong>}
        {latencyLabel !== "--" && <strong>{latencyLabel}</strong>}
        {cpuLabel !== "--" && <strong data-alert={cpuAlert}>CPU {cpuLabel}</strong>}
        {dspLabel !== "--" && <strong data-alert={dspAlert}>DSP {dspLabel}</strong>}
      </span>
      <em>
        {onCycleSize && (
          <button type="button" onClick={onCycleSize} title="Cycle rack display size">
            Size <strong>{rackSizeLabel}</strong>
          </button>
        )}
        {onMaxSize && (
          <button type="button" onClick={onMaxSize} title="Maximum rack display size">
            <Maximize2 aria-hidden="true" />
          </button>
        )}
      </em>
    </div>
  );
}

const PRE_SIGNAL_LAYOUT = {
  compressor: { x: 40, y: 42, w: 120, h: 232 },
  tapeEcho: { x: 173, y: 42, w: 156, h: 232 },
  octaver: { x: 342, y: 42, w: 120, h: 232 },
  precisionDrive: { x: 475, y: 42, w: 120, h: 232 },
  distortion: { x: 608, y: 42, w: 120, h: 232 },
} as const satisfies Record<string, DesignBox>;

function AmpCaptureSelector({
  ampLabel,
  hasCapture,
  includesCab,
  missing,
  onBrowse,
  onBrowseLocal,
  recovery,
}: {
  ampLabel: string;
  hasCapture: boolean;
  includesCab: boolean;
  missing?: boolean;
  onBrowse?: () => void;
  onBrowseLocal?: () => void;
  recovery?: NAMRackDesignRecovery;
}) {
  const libraryActionLabel = hasCapture || missing ? "Replace" : "Library";
  const displayLabel = hasCapture || missing ? ampLabel : "No amp capture loaded";
  const stateLabel = missing
    ? "File missing"
    : hasCapture
      ? includesCab ? "Full-rig · cab embedded" : "Amp capture"
      : "Empty capture slot";
  return (
    <div
      className="amp-capture-nameplate"
      data-qa="nam-amp-capture-nameplate"
      data-state={missing ? "missing" : hasCapture ? "loaded" : "empty"}
      data-includes-cab={includesCab}
      role="group"
      aria-label={`${stateLabel}. Current: ${displayLabel}`}
    >
      <span className="amp-capture-state"><i aria-hidden="true" />{stateLabel}</span>
      <strong className="amp-capture-model" title={displayLabel}>{displayLabel}</strong>
      <span className="amp-capture-actions" aria-label="Amp capture source actions">
        {recovery ? (
          <>
            <button
              type="button"
              data-qa="nam-amp-recovery-locate"
              onClick={(event) => {
                event.stopPropagation();
                recovery.onLocate();
              }}
              disabled={recovery.busy}
              title={`Locate the missing ${recovery.assetLabel}`}
            >
              <FolderOpen aria-hidden="true" />
              {recovery.busy ? "Locating" : "Locate"}
            </button>
            <button
              type="button"
              data-qa="nam-amp-capture-selector"
              data-rack-action="browse-amp-capture"
              onClick={(event) => {
                event.stopPropagation();
                recovery.onReplace();
              }}
              disabled={recovery.busy}
              title={`Choose another ${recovery.assetLabel}`}
            >
              <Library aria-hidden="true" />
              Replace
            </button>
            <button
              type="button"
              data-qa="nam-amp-recovery-bypass"
              onClick={(event) => {
                event.stopPropagation();
                recovery.onBypass();
              }}
              disabled={recovery.busy || recovery.bypassed}
              title={`Safely bypass the missing ${recovery.slotLabel} slot`}
            >
              <Power aria-hidden="true" />
              {recovery.bypassed ? "Bypassed" : "Bypass"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-qa="nam-amp-capture-selector"
              data-rack-action="browse-amp-capture"
              onClick={(event) => {
                event.stopPropagation();
                onBrowse?.();
              }}
              disabled={!onBrowse}
              aria-label={`${libraryActionLabel} Amp NAM capture. Current: ${displayLabel}`}
              title={`${libraryActionLabel} Amp NAM capture`}
            >
              <Library aria-hidden="true" />
              {libraryActionLabel}
            </button>
            {onBrowseLocal ? (
              <button
                type="button"
                data-qa="nam-amp-local-capture-selector"
                data-rack-action="browse-local-amp-capture"
                onClick={(event) => {
                  event.stopPropagation();
                  onBrowseLocal();
                }}
                title="Choose a local .nam capture"
                aria-label={`Choose a local .nam capture. Current: ${displayLabel}`}
              >
                <FolderOpen aria-hidden="true" />
                Local
              </button>
            ) : null}
          </>
        )}
      </span>
    </div>
  );
}

function PreFxStage() {
  return (
    <>
      <Stompbox box={PRE_SIGNAL_LAYOUT.compressor} name="compressor" tone="blue" title="COMPRESSOR" titleY={66.8}>
        <Knob kind="black" x={30} y={22.5} size={22.5} rot={-24} paramId="compressorComp" labelText="COMP" labelOffset={LABEL_OFFSET.above} />
        <Knob kind="black" x={70} y={22.5} size={22.5} rot={24} paramId="compressorDetail" labelText="DETAIL" labelOffset={LABEL_OFFSET.above} />
        <Knob kind="black" x={30} y={43.5} size={21.5} rot={-8} paramId="compressorMix" labelText="MIX" labelOffset={LABEL_OFFSET.below} />
        <Knob kind="black" x={70} y={43.5} size={21.5} rot={18} paramId="compressorVolumeDb" labelText="LEVEL" labelOffset={LABEL_OFFSET.below} />
        <Led x={50} y={73.2} on size={8.8} paramId="compressorEnabled" />
        <Foot x={50} y={88.3} size={20.8} paramId="compressorEnabled" hitSize={23} showStateLabel stateLabelY={79.4} value="Compressor on / off" />
      </Stompbox>
      <Stompbox box={PRE_SIGNAL_LAYOUT.tapeEcho} name="tape-echo" body={BODIES.darkWide} title="TAPE ECHO" titleY={68.5}>
        <Display x={23} y={11.5} w={54} h={8.8} className="tone-display"><BoundParamValue paramId="tapeEchoTimeMs" fallback="360 ms" /></Display>
        <Knob kind="black" x={23} y={31.5} size={19.5} rot={-30} paramId="tapeEchoTimeMs" labelText="TIME" labelOffset={11.8} />
        <Knob kind="black" x={50} y={31.5} size={19.5} rot={0} paramId="tapeEchoFeedback" labelText="FDBK" labelOffset={11.8} />
        <Knob kind="black" x={77} y={31.5} size={19.5} rot={30} paramId="tapeEchoMix" labelText="MIX" labelOffset={11.8} />
        <Knob kind="black" x={34} y={52.5} size={18} rot={-12} paramId="tapeEchoMod" labelText="MOD" labelOffset={10.2} />
        <Knob kind="black" x={66} y={52.5} size={18} rot={16} paramId="tapeEchoTone" labelText="TONE" labelOffset={10.2} />
        <Led x={50} y={74.3} on size={7.8} paramId="tapeEchoEnabled" />
        <Foot x={50} y={88.5} size={16} paramId="tapeEchoEnabled" hitSize={19} showStateLabel stateLabelY={79.8} value="Tape Echo on / off" />
      </Stompbox>
      <Stompbox box={PRE_SIGNAL_LAYOUT.octaver} name="octaver" tone="olive" title="MONO OCTAVER" titleY={67.5}>
        <Knob kind="black" x={28} y={26} size={23} rot={-30} paramId="octaverDownMix" labelText="DOWN" labelOffset={LABEL_OFFSET.above} />
        <Knob kind="black" x={72} y={26} size={23} rot={30} paramId="octaverUpMix" labelText="UP" labelOffset={LABEL_OFFSET.above} />
        <Knob kind="black" x={50} y={45.5} size={22} rot={0} paramId="octaverDirectMix" labelText="DIRECT" labelOffset={11.5} />
        <Led x={50} y={74} on size={8.8} paramId="octaverEnabled" />
        <Foot x={50} y={88.3} size={20.8} paramId="octaverEnabled" hitSize={23} showStateLabel stateLabelY={79.5} value="Mono Octaver on / off" />
      </Stompbox>
      <Stompbox box={PRE_SIGNAL_LAYOUT.precisionDrive} name="precision-drive" tone="stone" title="PRECISION DRIVE" titleY={66.8}>
        <Knob kind="black" x={30} y={22.5} size={22.5} rot={-22} paramId="precisionDriveDrive" labelText="DRIVE" labelOffset={LABEL_OFFSET.above} />
        <Knob kind="black" x={70} y={22.5} size={22.5} rot={22} paramId="precisionDriveVolumeDb" labelText="LEVEL" labelOffset={LABEL_OFFSET.above} />
        <Knob kind="black" x={30} y={43.5} size={21.5} rot={-10} paramId="precisionDriveBright" labelText="BRIGHT" labelOffset={LABEL_OFFSET.below} />
        <Knob kind="black" x={70} y={43.5} size={21.5} rot={16} paramId="precisionDriveAttack" labelText="ATTACK" labelOffset={LABEL_OFFSET.below} />
        <Led x={50} y={73.2} on size={8.8} paramId="precisionDriveEnabled" />
        <Foot x={50} y={88.3} size={20.8} paramId="precisionDriveEnabled" hitSize={23} showStateLabel stateLabelY={79.4} value="Precision Drive on / off" />
      </Stompbox>
      <Stompbox box={PRE_SIGNAL_LAYOUT.distortion} name="distortion" tone="red" title="DISTORTION" titleY={65.8}>
        <Knob kind="black" x={30} y={22.5} size={22.5} rot={22} paramId="chaosDrive" labelText="DRIVE" labelOffset={LABEL_OFFSET.above} />
        <Knob kind="black" x={70} y={22.5} size={22.5} rot={4} paramId="chaosTone" labelText="TONE" labelOffset={LABEL_OFFSET.above} />
        <Knob kind="black" x={30} y={43.5} size={21.5} rot={18} paramId="chaosMix" labelText="MIX" labelOffset={LABEL_OFFSET.below} />
        <Knob kind="black" x={70} y={43.5} size={21.5} rot={0} paramId="chaosLevelDb" labelText="LEVEL" labelOffset={LABEL_OFFSET.below} />
        <Led x={50} y={74.2} on size={8.8} paramId="chaosEnabled" />
        <Foot x={50} y={88.5} size={20.8} paramId="chaosEnabled" hitSize={23} showStateLabel stateLabelY={80.1} value="Distortion on / off" />
      </Stompbox>
    </>
  );
}

function AmpStage({
  onBrowseAmpCapture,
  onBrowseLocalAmpCapture,
  ampLabel,
  hasAmpCapture,
  ampIncludesCab,
  ampCaptureMissing,
  recovery,
}: {
  onBrowseAmpCapture?: () => void;
  onBrowseLocalAmpCapture?: () => void;
  ampLabel: string;
  hasAmpCapture: boolean;
  ampIncludesCab: boolean;
  ampCaptureMissing: boolean;
  recovery?: NAMRackDesignRecovery;
}) {
  const names = ["GAIN", "BASS", "MID", "TREBLE", "PRESENCE", "LEVEL"];
  const paramIds = ["ampGainDb", "bassDb", "midDb", "trebleDb", "presenceDb", "ampOutputDb"];
  const railY = 71.5;
  const labelBaseline = 79.2;
  const labelOffsetPx = labelBaseline - railY;
  return (
    <Module box={LAYOUT.amp.head} name="amp-head" body={BODIES.amp} className={`amp-head ${hasAmpCapture ? "" : "amp-capture-unavailable"}`} bodyFit="fill" controlsName="Amp">
      <div className="amp-brand">OpenStudio <small>NAM WRAPPER</small></div>
      <AmpCaptureSelector ampLabel={ampLabel} hasCapture={hasAmpCapture} includesCab={ampIncludesCab} missing={ampCaptureMissing} onBrowse={onBrowseAmpCapture} onBrowseLocal={onBrowseLocalAmpCapture} recovery={recovery} />
      <div
        className="amp-control-rail"
        data-disabled={!hasAmpCapture}
        aria-disabled={!hasAmpCapture}
        role="group"
        aria-label={!hasAmpCapture ? "Amp controls unavailable. Load an Amp NAM capture." : "Amp controls"}
      >
        <Toggle x={8.8} y={railY} size={4.8} paramId="ampEnabled" labelText="POWER" labelOffset={labelOffsetPx} labelClass="amp-label amp-rail-label" allowInteraction={hasAmpCapture} disabledReason={!hasAmpCapture ? "Load an Amp capture." : undefined} />
        <Led x={13.4} y={railY} on={false} paramId={hasAmpCapture ? "ampEnabled" : undefined} size={4.1} value="Amp power engaged" hitSize={5.2} />
        <Washer x={19.2} y={railY} size={5.1} labelText="INPUT" labelOffset={labelOffsetPx} labelClass="amp-label amp-rail-label" />
        {names.map((name, index) => {
          const x = 30.4 + index * 11.9;
          return (
            <span key={name} className="amp-control-cluster">
              <Knob kind="black" x={x} y={railY} size={7.7} rot={index * 18 - 38} paramId={paramIds[index]} labelText={name} labelOffset={labelOffsetPx} labelClass="amp-label amp-rail-label" allowInteraction={hasAmpCapture} disabledReason={!hasAmpCapture ? "Load an Amp capture." : undefined} />
            </span>
          );
        })}
      </div>
    </Module>
  );
}

function CabSourceSelector({
  cabLabel,
  cabMode,
  onBrowseCabIR,
  onBrowseLocalCabIR,
  onBrowseAmpOnlyCapture,
}: {
  cabLabel: string;
  cabMode: NAMRackCabMode;
  onBrowseCabIR?: () => void;
  onBrowseLocalCabIR?: () => void;
  onBrowseAmpOnlyCapture?: () => void;
}) {
  const embedded = cabMode === "embedded";
  const eyebrow = embedded
    ? "FULL-RIG CAPTURE"
    : cabMode === "loaded"
      ? "ACTIVE CABINET IR"
      : cabMode === "required"
        ? "CABINET IR REQUIRED"
        : "CABINET SLOT";
  const sourceLabel = embedded
    ? "CABINET INCLUDED"
    : cabMode === "loaded"
      ? cabLabel
      : cabMode === "required"
        ? "AMP CAPTURE NEEDS AN IR"
        : "NO CABINET IR";
  const actionLabel = embedded
    ? "AMP-ONLY"
    : cabMode === "empty"
      ? "BROWSE AMPS"
      : cabMode === "loaded"
        ? "REPLACE"
        : "CHOOSE IR";
  const action = embedded || cabMode === "empty" ? onBrowseAmpOnlyCapture : onBrowseCabIR;
  return (
    <div
      className="cab-source-selector"
      data-qa="nam-cab-source-selector"
      data-cab-mode={cabMode}
      role="group"
      aria-label={`Cabinet source. ${sourceLabel}`}
    >
      <span className="cab-source-copy">
        <small>IR SHAPER&nbsp;&nbsp;&middot;&nbsp;&nbsp;{eyebrow}</small>
        <strong title={sourceLabel}>{sourceLabel}</strong>
      </span>
      <span className="cab-source-actions">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            action?.();
          }}
          disabled={!action}
          aria-label={`${actionLabel}. Current: ${cabLabel}`}
          title={embedded ? "Choose an amp-only Capture before using an external IR" : actionLabel}
        >
          {embedded || cabMode === "empty" ? <Library aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
          {actionLabel}
        </button>
        {!embedded && onBrowseLocalCabIR ? (
          <button
            type="button"
            className="cab-source-local"
            onClick={(event) => {
              event.stopPropagation();
              onBrowseLocalCabIR();
            }}
            title="Load a local cabinet impulse response"
            aria-label="Load a local cabinet impulse response"
          >
            LOCAL
          </button>
        ) : null}
      </span>
    </div>
  );
}

function CabStage({
  cabLabel,
  cabMode,
  onBrowseCabIR,
  onBrowseLocalCabIR,
  onBrowseAmpOnlyCapture,
}: {
  cabLabel: string;
  cabMode: NAMRackCabMode;
  onBrowseCabIR?: () => void;
  onBrowseLocalCabIR?: () => void;
  onBrowseAmpOnlyCapture?: () => void;
}) {
  const controlsLocked = cabMode !== "loaded";
  const controlsLockedReason = cabMode === "embedded"
    ? "Choose an amp-only capture."
    : cabMode === "required"
      ? "Load a cabinet IR."
      : "Load an amp capture.";
  const designParamContext = useContext(DesignParamContext);
  const cabParamContext = controlsLocked && designParamContext
    ? { ...designParamContext, onParamChange: undefined }
    : designParamContext;
  return (
    <>
      <Module box={LAYOUT.cab.cabinet} name="cabinet" body={BODIES.cab} className={`cabinet cab-mode-${cabMode}`} bodyFit="contain" controlsName="Cab / IR" />
      <DesignParamContext.Provider value={cabParamContext}>
      <Module box={LAYOUT.cab.micPanel} name="mic-panel" body={BODIES.irShaper} className={`ir-shaper-panel cab-mode-${cabMode}${controlsLocked ? " cab-controls-locked" : ""}`} bodyFit="contain" controlsName="Cab / IR">
        <Screw x={2.2} y={6.5} size={2.4} />
        <Screw x={97.8} y={6.5} size={2.4} />
        <Screw x={2.2} y={94.3} size={2.4} />
        <Screw x={97.8} y={94.3} size={2.4} />
        <CabSourceSelector
          cabLabel={cabLabel}
          cabMode={cabMode}
          onBrowseCabIR={onBrowseCabIR}
          onBrowseLocalCabIR={onBrowseLocalCabIR}
          onBrowseAmpOnlyCapture={onBrowseAmpOnlyCapture}
        />
        <div className="cab-control-deck" data-locked={controlsLocked ? "true" : "false"}>
          <Knob kind="black" x={10.5} y={47} size={8.8} rot={-22} paramId="cabMicPosition" labelText="EDGE" labelOffset={-15} labelClass="ir-primary-label" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Knob kind="black" x={23.7} y={47} size={8.8} rot={-8} paramId="cabMicDistance" labelText="DAMP" labelOffset={-15} labelClass="ir-primary-label" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Knob kind="black" x={36.8} y={47} size={8.8} rot={12} paramId="cabMicBlend" labelText="BLEND" labelOffset={-15} labelClass="ir-primary-label" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Knob kind="black" x={50} y={47} size={8.8} rot={10} paramId="cabRoomSend" labelText="BLOOM" labelOffset={-15} labelClass="ir-primary-label" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Knob kind="black" x={63.2} y={47} size={8.8} rot={-26} paramId="cabHPFHz" labelText="HPF" labelOffset={-15} labelClass="ir-primary-label" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Knob kind="black" x={76.3} y={47} size={8.8} rot={18} paramId="cabLPFHz" labelText="LPF" labelOffset={-15} labelClass="ir-primary-label" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Knob kind="black" x={89.5} y={47} size={8.8} rot={24} paramId="cabLevelDb" labelText="LEVEL" labelOffset={-15} labelClass="ir-primary-label" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />

          <Toggle x={10.6} y={70.8} size={4.8} paramId="cabEnabled" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Led x={16.2} y={70.8} on size={3.6} paramId="cabEnabled" value="Cabinet stage enabled" />
          <Label x={13.4} y={85.4} className="ir-utility-label">CAB</Label>

          <Knob kind="black" x={50} y={70.3} size={6.2} rot={0} paramId="cabPan" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Label x={50} y={85.4} className="ir-utility-label">PAN</Label>

          <Toggle x={83.8} y={70.8} size={4.8} paramId="cabPhaseInvert" allowInteraction={!controlsLocked} disabledReason={controlsLockedReason} />
          <Led x={89.4} y={70.8} on size={3.6} paramId="cabPhaseInvert" value="Cabinet polarity inverted" />
          <Label x={86.6} y={85.4} className="ir-utility-label">PHASE</Label>
        </div>
      </Module>
      </DesignParamContext.Provider>
    </>
  );
}

function EqStage() {
  const bands = ["65", "125", "250", "500", "1K", "2K", "4K", "8K", "16K"];
  const values = [51, 58, 47, 52, 58, 48, 53, 59, 45];
  const bandParamIds = ["eq65Db", "eq125Db", "eq250Db", "eq500Db", "eq1kDb", "eq2kDb", "eq4kDb", "eq8kDb", "eq16kDb"] as const;
  const powerStackX = 5.5;
  return (
    <Module box={LAYOUT.eq.rack} name="eq-rack" body={BODIES.eq} bodyFit="fill" className="rack-unit eq-rack" controlsName="Graphic EQ">
      <Label x={50} y={8.5} className="rack-big eq-rack-title">POST-CAB GRAPHIC EQ</Label>
      <div className="eq-scale-grid" />
      <Label x={17.2} y={25} className="eq-scale">+12</Label>
      <Label x={17.2} y={52} className="eq-scale">0</Label>
      <Label x={17.2} y={78} className="eq-scale">-12</Label>
      <Label x={84.2} y={25} className="eq-scale">+12</Label>
      <Label x={84.2} y={52} className="eq-scale">0</Label>
      <Label x={84.2} y={78} className="eq-scale">-12</Label>
      <Label x={powerStackX} y={49} className="rack-big">EQ ON</Label>
      <Led x={powerStackX} y={58.5} on size={4.3} paramId="eqEnabled" />
      <Toggle x={powerStackX} y={73.2} size={4.3} paramId="eqEnabled" labelText="BYPASS" labelOffset={9.2} labelClass="rack-small" />
      {bands.map((band, index) => {
        const x = 22.5 + index * 7.35;
        return (
          <span key={band} className="eq-band">
            <Label x={x} y={20.8} className="eq-band-value"><BoundParamValue paramId={bandParamIds[index]} fallback="0.0 dB" /></Label>
            <Fader x={x} y={52} h={46} paramId={bandParamIds[index]} value={values[index]} className="eq-fader" />
            <Label x={x} y={80.5} className="eq-frequency">{band}</Label>
          </span>
        );
      })}
    </Module>
  );
}

function PostFxStage() {
  const modulatorPedalMode = useBoundDesignParam("modulatorPedalMode");
  const delayTempoSync = useBoundDesignParam("delayTempoSync");
  const modulatorAuto = (modulatorPedalMode?.value ?? 1) >= 0.5;
  const delaySynced = (delayTempoSync?.value ?? 0) >= 0.5;
  return (
    <>
      <WidePedal box={LAYOUT.post.modulator} name="modulator" body={BODIES.copperWide} className={modulatorAuto ? "modulator-auto" : ""} title="MODULATOR" titleY={7}>
        <Display x={7} y={14} w={28} h={9.5}><BoundParamChoice paramId="modulatorMode" offLabel="CHORUS" onLabel="FLANGER" /></Display>
        <Toggle x={40} y={19} size={7.5} paramId="modulatorMode" />
        <Label x={49} y={19} className="mod-switch-label">MODE</Label>
        <Toggle x={68} y={19} size={7.5} paramId="modulatorPedalMode" />
        <Label x={81} y={19} className="mod-switch-label mod-switch-state">
          <BoundParamChoice paramId="modulatorPedalMode" offLabel="PEDAL" onLabel="AUTO" />
        </Label>
        <Knob kind="black" x={20} y={32.8} size={11.2} rot={-25} paramId="chorusRateHz" labelText="RATE" labelOffset={10.8} labelClass="post-label" value="Rate: 1.25 Hz" />
        <Knob kind="black" x={50} y={32.5} size={11.5} rot={10} paramId="modulatorPedalPosition" labelText="POSITION" labelOffset={10.8} labelClass="post-label" value="Position: 50%" allowInteraction={!modulatorAuto} disabledReason={modulatorAuto ? "Select PEDAL mode." : undefined} />
        <Knob kind="black" x={80} y={32.8} size={11.2} rot={26} paramId="chorusDepth" labelText="DEPTH" labelOffset={10.8} labelClass="post-label" value="Depth: 41%" />
        <Knob kind="black" x={20} y={54.4} size={10.8} rot={-5} paramId="modulatorFeedback" labelText="FEEDBACK" labelOffset={10.2} labelClass="post-label" value="Feedback: 10%" />
        <Knob kind="black" x={80} y={54.4} size={10.8} rot={30} paramId="chorusMix" labelText="MIX" labelOffset={10.2} labelClass="post-label" value="Mix: 30%" />
        <Led x={40} y={72.8} on size={6} paramId="modulatorEnabled" value="Modulator on" hitSize={8.2} />
        <Foot x={40} y={88.4} size={11.35} state="on" paramId="modulatorEnabled" value="Modulator on / off" hitSize={14.5} showStateLabel stateLabelY={79.5} />
        <ThreeWayToggle x={75} y={87.4} size={9.2} labelY={79.3} paramId="chorusCharacter" labels={["CLEAN", "ENS", "BBD"]} />
      </WidePedal>
      <WidePedal box={LAYOUT.post.delay} name="delay" body={BODIES.darkWidePedal} className={`delay-rack${delaySynced ? " delay-synced" : ""}`} title="STEREO DELAY" titleY={7}>
        <Display x={27} y={13.5} w={46} h={9} className="delay-display">
          <span><BoundDelayTimeDisplay /><i aria-hidden="true">&nbsp;&middot;&nbsp;</i><BoundDelayModeDisplay /></span>
        </Display>
        <Knob kind="black" x={18} y={32.5} size={12.5} rot={-15} paramId="delayTimeMs" labelText={delaySynced ? "SYNCED" : "TIME"} labelOffset={9.8} labelClass="post-label" value="Time: 360 ms" allowInteraction={!delaySynced} disabledReason={delaySynced ? "Turn SYNC off to set milliseconds." : undefined} />
        <Knob kind="black" x={50} y={32.5} size={12.5} rot={12} paramId="delayFeedback" labelText="FEEDBACK" labelOffset={9.8} labelClass="post-label" value="Feedback: 28%" />
        <Knob kind="black" x={82} y={32.5} size={12.5} rot={24} paramId="delayMix" labelText="MIX" labelOffset={9.8} labelClass="post-label" value="Mix: 25%" />
        <Knob kind="black" x={20} y={53.5} size={11.8} rot={-25} paramId="delayMod" labelText={delaySynced ? "DIV / MOD" : "MOD"} labelOffset={8.7} labelClass="post-label" value="Modulation: 18%" />
        <Knob kind="black" x={50} y={53.5} size={11.8} rot={5} paramId="delayMode" labelText="MODE" labelOffset={8.7} labelClass="post-label" value="Delay mode" />
        <Knob kind="black" x={80} y={53.5} size={11.8} rot={24} paramId="delayDucker" labelText="DUCKER" labelOffset={8.7} labelClass="post-label" value="Ducker: 12%" />
        <Led x={34} y={72} on size={6} paramId="delayTempoSync" value="Delay sync" hitSize={8.2} />
        <Led x={66} y={72} on size={6} paramId="delayEnabled" value="Delay on" hitSize={8.2} />
        <Foot x={34} y={88.4} size={9.6} state="on" paramId="delayTempoSync" value="Tempo sync" hitSize={12.3} />
        <Foot x={66} y={88.4} size={9.6} state="on" paramId="delayEnabled" value="Delay on / off" hitSize={12.3} showStateLabel stateLabelY={79.2} />
        <FootActionLabel x={34} y={79.2}>SYNC</FootActionLabel>
      </WidePedal>
      <WidePedal box={LAYOUT.post.reverb} name="reverb" body={BODIES.blueWidePedal} className="reverb-wide" title="REVERB" titleY={7}>
        <Knob kind="black" x={24} y={30} size={14} rot={-24} paramId="reverbPreDelayMs" labelText="PRE DELAY" labelOffset={10.8} labelClass="post-label" value="Pre delay: 35 ms" />
        <Knob kind="black" x={50} y={30} size={14} rot={8} paramId="reverbDecaySec" labelText="DECAY" labelOffset={10.8} labelClass="post-label" value="Decay: 2.4 s" />
        <Knob kind="black" x={76} y={30} size={14} rot={30} paramId="reverbMix" labelText="MIX" labelOffset={10.8} labelClass="post-label" value="Mix: 53%" />
        <Knob kind="black" x={24} y={51.5} size={12} rot={-22} paramId="reverbLowCutHz" labelText="LOW CUT" labelOffset={9.6} labelClass="post-label" value="Low cut: 120 Hz" />
        <Knob kind="black" x={50} y={51.5} size={12} rot={-10} paramId="reverbTone" labelText="TONE" labelOffset={9.6} labelClass="post-label" value="Reverb tone" />
        <Knob kind="black" x={76} y={51.5} size={12} rot={-135} paramId="reverbShimmer" labelText="SHIMMER" labelOffset={9.6} labelClass="post-label" value="Shimmer: 0%" />
        <Led x={50} y={72} on size={6.2} paramId="reverbEnabled" value="Reverb on" hitSize={8.2} />
        <Foot x={50} y={88.4} size={11.35} state="on" paramId="reverbEnabled" value="Reverb on / off" hitSize={14.5} showStateLabel stateLabelY={79.2} />
      </WidePedal>
    </>
  );
}

function SectionStage({
  sectionId,
  onBrowseAmpCapture,
  onBrowseLocalAmpCapture,
  onBrowseAmpOnlyCapture,
  onBrowseCabIR,
  onBrowseLocalCabIR,
  rig,
  recovery,
}: {
  sectionId: DesignSectionId;
  onBrowseAmpCapture?: () => void;
  onBrowseLocalAmpCapture?: () => void;
  onBrowseAmpOnlyCapture?: () => void;
  onBrowseCabIR?: () => void;
  onBrowseLocalCabIR?: () => void;
  rig: NAMRackDesignRigSummary;
  recovery?: NAMRackDesignRecovery;
}) {
  if (sectionId === "pre") return <PreFxStage />;
  if (sectionId === "cab") return <CabStage cabLabel={rig.cabLabel} cabMode={rig.cabMode} onBrowseCabIR={onBrowseCabIR} onBrowseLocalCabIR={onBrowseLocalCabIR} onBrowseAmpOnlyCapture={onBrowseAmpOnlyCapture} />;
  if (sectionId === "eq") return <EqStage />;
  if (sectionId === "post") return <PostFxStage />;
  return <AmpStage onBrowseAmpCapture={onBrowseAmpCapture} onBrowseLocalAmpCapture={onBrowseLocalAmpCapture} ampLabel={rig.ampLabel} hasAmpCapture={rig.hasAmpCapture} ampIncludesCab={rig.cabMode === "embedded"} ampCaptureMissing={rig.ampCaptureMissing} recovery={recovery} />;
}

function SourceChip({
  children,
  active,
  attr,
  value,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  attr?: string;
  value?: string;
  onClick?: () => void;
}) {
  const extraAttrs = attr === 'data-supported-pedal="true"' ? { "data-supported-pedal": "true" } : {};
  return (
    <button type="button" data-active={Boolean(active)} aria-pressed={active === undefined ? undefined : active} data-source-flow-value={value} {...extraAttrs} onClick={onClick}>
      {children}
    </button>
  );
}

function ToneResultRow({
  item,
  onSelect,
  onAction,
  onFavorite,
}: {
  item: NAMSourceFlowDesignResult;
  onSelect: () => void;
  onAction: () => void;
  onFavorite: () => void;
}) {
  const rowMeta = `${item.creator} \u00b7 ${item.kind} \u00b7 ${item.arch}`;
  return (
    <article
      className="tone-feed-row"
      data-active={Boolean(item.active)}
      data-state={item.state}
      data-source={item.source}
      data-kind={item.kind}
      data-category={item.category}
      data-source-flow-row-id={item.id}
      onClick={onSelect}
    >
      <button
        type="button"
        className="tone-row-select-target"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        aria-label={`Select ${item.name}`}
      />
      <div className="tone-row-art" aria-hidden="true">
        {item.artUrl ? <img src={item.artUrl} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}
      </div>
      <div className="tone-row-main">
        <strong title={item.name}>{item.name}</strong>
        <span title={rowMeta}>{rowMeta}</span>
        <div className="tone-row-tags">{item.tags.slice(0, 2).map((tag) => <i key={tag}>{tag}</i>)}</div>
        {item.source === "tone3000" && (
          <div className="tone-row-stats">
            <span title={`${item.downloads} downloads`} aria-label={`${item.downloads} downloads`}>
              <Download aria-hidden="true" />
              {item.downloads}
            </span>
            <span title={`${item.likes} favorites`} aria-label={`${item.likes} favorites`}>
              <Heart aria-hidden="true" />
              {item.likes}
            </span>
          </div>
        )}
      </div>
      <div className="tone-row-side">
        {item.source !== "openstudio" ? <button
          type="button"
          className="tone-row-favorite"
          data-active={Boolean(item.favorite)}
          aria-pressed={Boolean(item.favorite)}
          aria-label={item.favorite ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`}
          title={item.favorite ? "Remove favorite" : "Add favorite"}
          onClick={(event) => { event.stopPropagation(); onFavorite(); }}
        >{item.favorite ? "★" : "☆"}</button> : <span className="tone-row-favorite-spacer" />}
        <em>{item.stateLabel}</em>
        <button className="tone-row-action" type="button" onClick={(event) => { event.stopPropagation(); onAction(); }}>{item.action}</button>
      </div>
    </article>
  );
}

function SourceFlowSurface({
  config,
  onAction,
}: {
  config: NAMSourceFlowDesignConfig;
  onAction: (message: NAMSourceFlowDesignPortMessage) => void;
}) {
  const emit = (action: NAMSourceFlowDesignActionId, value = "", rowId = "") => {
    onAction({ type: "nam-source-flow-design-port", instanceId: "native-source-flow", action, value, rowId });
  };
  const architectureFilters = config.filters.filter((filter) => filter.id.startsWith("arch-"));
  const typeFilters = config.filters.filter((filter) => !filter.id.startsWith("arch-"));
  const selectedTypeFilter = typeFilters.find((filter) => filter.active)?.id ?? "";
  const sourceResourceTerms = sourceFlowResourceTerms(config.mode);
  const sourceResourceLabel = sourceResourceTerms.label;
  const sourceResourceTitle = sourceResourceTerms.title;
  const sourceLibraryLabel = sourceResourceTerms.library;
  const resultTotal = config.pagination?.totalResults ?? config.resultTotal ?? config.resultCount;
  const resultSummary = resultTotal > config.resultCount
    ? `${config.resultCount.toLocaleString()} shown \u00b7 ${resultTotal.toLocaleString()} matches`
    : `${resultTotal.toLocaleString()} ${resultTotal === 1 ? "match" : "matches"}`;
  return (
    <div className="tone-rack-flow tone-source-flow tone-source-v2" data-origin={config.originId} data-source-mode={config.sourceMode} data-target-slot={config.targetSlot} data-library-mode="source-flow">
      <section className="tone-source-header" aria-label={`${config.sourceLabel} entry and return`}>
        <button
          type="button"
          className="tone-return-button"
          data-return-target={config.originId}
          data-source-flow-action="return"
          onClick={() => emit("return")}
          disabled={config.busy}
          aria-busy={config.busy || undefined}
        ><ArrowLeft />{config.returnLabel}</button>
        <div className="tone-breadcrumb" aria-label={`${sourceLibraryLabel} breadcrumb`}>
          <span>{config.originLabel} / {sourceLibraryLabel}</span>
          <b>{config.sourceLabel}</b>
        </div>
        <div className="tone-connection-state" data-auth={config.authState}>
          <i />
          <span>{config.authTitle}</span>
          {config.statusAction ? (
            <button type="button" onClick={() => emit(config.statusAction!.id)}>{config.statusAction.label}</button>
          ) : null}
        </div>
      </section>
      <div className="tone-source-v2-workspace">
      <main className="tone-selected-stage" aria-label={config.selectedAvailable ? `Selected ${sourceResourceLabel}` : `${sourceResourceTitle} selection`}>
        <div
          className="tone-selected-visual"
          data-has-art={Boolean(config.selectedArtUrl)}
          data-source-mode={config.mode}
          data-target-slot={config.targetSlot}
        >
          {config.selectedArtUrl ? <img src={config.selectedArtUrl} alt="" /> : null}
          <div className="tone-selected-visual-shade" />
          <div className="tone-selected-identity">
            <span>{config.selectedAvailable ? config.detailEyebrow : `Choose ${sourceResourceLabel}`}</span>
            <h1>{config.selectedAvailable ? config.selectedName : config.emptyTitle}</h1>
            <p>{config.selectedAvailable ? config.selectedMeta : config.emptyBody}</p>
            <div className="tone-selected-chips">
              {config.selectedTags.slice(0, 5).map((tag) => <i key={tag}>{tag}</i>)}
            </div>
          </div>
        </div>
        {config.selectedAvailable ? <div className="tone-selected-info">
          <div className="tone-selected-meta">
            {config.detailMeta.slice(0, 5).map((line) => <span key={line}>{line}</span>)}
          </div>
          <div className="tone-selected-stats">
            {config.selectedStats.map((stat) => <span key={stat}>{stat}</span>)}
          </div>
        </div> : null}
        {config.selectedAvailable ? <div
          className="tone-action-grid"
          aria-label={`Preview and use ${sourceResourceLabel} actions`}
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, config.actions.length)}, minmax(0, 1fr))`,
            maxWidth: `${config.actions.length * 118 + Math.max(0, config.actions.length - 1) * 8}px`,
          }}
        >
          {config.actions.map((action) => (
            <button key={`${action.id}-${action.label}`} type="button" disabled={action.disabled} data-primary={Boolean(action.primary)} data-source-flow-action={action.id} onClick={() => emit(action.id, "", config.selectedRowId || "")}>
              {action.label}
            </button>
          ))}
        </div> : <div className="tone-action-grid tone-action-grid-empty" aria-hidden="true" />}
        {config.selectedAvailable ? <div className="tone-audition-status" aria-label="Preview routing status">
          <span>{config.statusTitle}</span><b title={config.route}>{config.route}</b><em>{config.statusDetail}</em>
        </div> : null}
      </main>
      <aside className="tone-browser-feed tone-library-panel" aria-label={`${config.sourceLabel} browse feed`}>
        <div className="tone-library-heading">
          <div><span>{sourceLibraryLabel}</span><strong title={config.feedTitle}>{config.feedTitle}</strong></div>
          <em>{resultSummary}</em>
        </div>
        <div className="tone-search-panel">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={config.query}
            placeholder={config.searchLabel}
            aria-label={config.searchLabel}
            onChange={(event) => emit("query", event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") emit("search"); }}
          />
          <button type="button" aria-label={config.searchAction} title={config.searchAction} data-source-flow-action="search" onClick={() => emit("search")}><ArrowRight /></button>
        </div>
        <div className="tone-tab-row" aria-label="Browse tabs">
          {config.tabs.map((tab, index) => <SourceChip key={tab} value={tab} active={index === config.activeTab} onClick={() => emit("tab", tab)}>{tab}</SourceChip>)}
        </div>
        <div className="tone-filter-row" aria-label="Source filters and sorting">
          {typeFilters.length > 0 ? (
            <select aria-label={`${sourceResourceTitle} type`} value={selectedTypeFilter} onChange={(event) => event.currentTarget.value && emit("filter", event.currentTarget.value)}>
              {!selectedTypeFilter ? <option value="">All types</option> : null}
              {typeFilters.map((filter) => <option key={filter.id} value={filter.id}>{filter.label}</option>)}
            </select>
          ) : null}
          {architectureFilters.length > 0 ? <div className="tone-arch-filter">{architectureFilters.map((filter) => <SourceChip key={filter.id} value={filter.id} active={filter.active} onClick={() => emit("filter", filter.id)}>{filter.label}</SourceChip>)}</div> : null}
          <select aria-label={`Sort ${sourceLibraryLabel}`} value={config.sortValue} onChange={(event) => emit("sort", event.currentTarget.value)}>
            {config.sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        {config.selectedAvailable ? <div className="tone-compact-selection" aria-label={`Selected ${sourceResourceLabel} actions`}>
          <div className="tone-compact-selection-copy">
            <span>Selected</span>
            <strong title={config.selectedName}>{config.selectedName}</strong>
          </div>
          <div
            className="tone-action-grid tone-compact-actions"
            style={{ gridTemplateColumns: `repeat(${Math.max(1, config.actions.length)}, minmax(0, 1fr))` }}
          >
            {config.actions.map((action) => (
              <button key={`compact-${action.id}-${action.label}`} type="button" disabled={action.disabled} data-primary={Boolean(action.primary)} data-source-flow-action={action.id} onClick={() => emit(action.id, "", config.selectedRowId || "")}>
                {action.label}
              </button>
            ))}
          </div>
        </div> : null}
        <div className="tone-feed-list" data-busy={config.busy}>
          {config.busy && config.results.length === 0 ? Array.from({ length: 5 }, (_, index) => <div className="tone-feed-skeleton" key={index} />) : null}
          {!config.busy && config.results.length === 0 ? (
            <div className="tone-feed-empty">
              <strong>{config.emptyTitle}</strong>
              <p>{config.emptyBody}</p>
              {config.emptyAction ? (
                <button type="button" data-primary={Boolean(config.emptyAction.primary)} onClick={() => emit(config.emptyAction!.id)}>{config.emptyAction.label}</button>
              ) : null}
              <button type="button" onClick={() => emit("clear-filters")}>Clear filters</button>
            </div>
          ) : config.results.map((item) => (
            <ToneResultRow
              key={item.id}
              item={item}
              onSelect={() => emit("select-row", "", item.id)}
              onAction={() => emit(item.actionId, "", item.id)}
              onFavorite={() => emit("favorite", "", item.id)}
            />
          ))}
        </div>
        {config.pagination && config.pagination.totalPages > 1 ? (
          <div className="tone-library-pager" data-mode={config.pagination.mode} aria-label="Tone library pages">
            <button type="button" disabled={config.busy || !config.pagination.hasPrevious} onClick={() => emit("previous-page")} aria-label="Previous tone page"><ArrowLeft aria-hidden="true" /></button>
            <span>Page {config.pagination.page} / {config.pagination.totalPages}</span>
            <button type="button" disabled={config.busy || !config.pagination.hasMore} onClick={() => emit("next-page")} aria-label="Next tone page"><ArrowRight aria-hidden="true" /></button>
            {config.pagination.mode === "live" ? (
              <button type="button" className="tone-library-load-more" disabled={config.busy || !config.pagination.canLoadMore} onClick={() => emit("load-more")}>Load more</button>
            ) : null}
          </div>
        ) : null}
      </aside>
      </div>
    </div>
  );
}

function PremiumTunerStage({ tuner, onClose }: { tuner: NAMRackDesignTunerSummary; onClose: () => void }) {
  const cents = Math.round(tuner.centsPct - 50);
  return (
    <section
      className="premium-tuner-stage"
      data-signal={tuner.signalPresent}
      style={{ "--premium-tuner-pct": `${clamp(tuner.centsPct, 0, 100)}%` } as NativeStyle}
      aria-label="Guitar tuner display"
    >
      <button type="button" className="premium-tuner-stage-close" aria-label="Close tuner" onClick={onClose}><X aria-hidden="true" /><span>Close</span></button>
      <div className="premium-tuner-stage-copy">
        <span>Chromatic tuner</span>
        <strong>{tuner.noteLabel}</strong>
        <b>{tuner.statusLabel}</b>
        <em>{`${cents > 0 ? "+" : ""}${cents} cents`}</em>
      </div>
      <div className="premium-tuner-scale" aria-label={`Tuning position ${tuner.centsPct.toFixed(0)} percent`}>
        <div className="premium-tuner-scale-ticks" aria-hidden="true">
          {Array.from({ length: 21 }).map((_, index) => <i key={index} data-major={index % 5 === 0} />)}
        </div>
        <span className="premium-tuner-needle" aria-hidden="true" />
        <div className="premium-tuner-scale-labels"><span>-50</span><span>0</span><span>+50</span></div>
      </div>
      <div className="premium-tuner-stage-readouts">
        <article><span>Pitch</span><strong>{tuner.frequencyLabel}</strong></article>
        <article><span>Input</span><strong>{tuner.inputLevelLabel}</strong></article>
        <article><span>Tracking</span><strong>{tuner.confidenceLabel}</strong></article>
        <article><span>Reference</span><strong>440 Hz</strong></article>
      </div>
    </section>
  );
}

function AssetRecoveryDock({ recovery }: { recovery: NAMRackDesignRecovery }) {
  const extraCount = Math.max(0, recovery.additionalMissingCount ?? 0);
  return (
    <section
      className="premium-asset-recovery"
      data-slot={recovery.slot}
      data-bypassed={Boolean(recovery.bypassed)}
      role="status"
      aria-live="polite"
      aria-label={`${recovery.slotLabel} asset recovery`}
    >
      <span className="premium-asset-recovery-icon" aria-hidden="true"><AlertTriangle /></span>
      <span className="premium-asset-recovery-copy">
        <small>{recovery.slotLabel} file unavailable{extraCount > 0 ? ` · ${extraCount} more missing` : ""}</small>
        <strong title={recovery.pathLabel}>{recovery.pathLabel}</strong>
        <em>{recovery.detail}</em>
      </span>
      <span className="premium-asset-recovery-actions" aria-label={`${recovery.slotLabel} recovery actions`}>
        <button type="button" onClick={recovery.onLocate} disabled={recovery.busy} title={`Locate the missing ${recovery.assetLabel}`}>
          <FolderOpen aria-hidden="true" />
          {recovery.busy ? "Locating" : "Locate"}
        </button>
        <button type="button" onClick={recovery.onReplace} disabled={recovery.busy} title={`Choose another ${recovery.assetLabel}`}>
          <Library aria-hidden="true" />
          Replace
        </button>
        <button type="button" onClick={recovery.onBypass} disabled={recovery.busy || recovery.bypassed} title={`Safely bypass the missing ${recovery.slotLabel} slot`}>
          <Power aria-hidden="true" />
          {recovery.bypassed ? "Bypassed" : "Bypass"}
        </button>
      </span>
    </section>
  );
}

function PremiumRigDrawer({
  sectionId,
  rig,
  tunerOpen,
  libraryItems = [],
  onOpenAdvancedStage,
  onSelectLibraryItem,
  onOpenLibrary,
  onBrowseAmpOnlyCapture,
}: {
  sectionId: DesignSectionId;
  rig: NAMRackDesignRigSummary;
  tunerOpen: boolean;
  libraryItems?: NAMRackDesignLibraryItem[];
  onOpenAdvancedStage: (stageId: NAMRackAdvancedStageId) => void;
  onSelectLibraryItem?: (itemId: string) => void;
  onOpenLibrary: (sectionId: DesignSectionId) => void;
  onBrowseAmpOnlyCapture?: () => void;
}) {
  if (tunerOpen) return null;

  const sectionItems: Array<{
    id: string;
    eyebrow: string;
    label: string;
    detail: string;
    asset: NAMDesignBodyAssetId;
    active?: boolean;
    actionLabel: string;
    onClick: () => void;
  }> = sectionId === "cab"
    ? [
      {
        id: "cab-source",
        eyebrow: rig.cabMode === "embedded" ? "Full-rig Capture" : rig.cabMode === "loaded" ? "Active IR" : "Cab source needed",
        label: rig.cabLabel,
        detail: rig.cabStatus,
        asset: BODIES.cab,
        active: rig.cabMode === "embedded" || rig.cabMode === "loaded",
        actionLabel: "Open Cab / IR controls",
        onClick: () => onOpenAdvancedStage("cab"),
      },
      {
        id: "cab-filter",
        eyebrow: "Native cabinet stage",
        label: rig.cabMode === "embedded" ? "External IR shaper bypassed" : "IR shaper & filters",
        detail: rig.cabMode === "embedded" ? "Load an amp-only Capture to enable it" : "Edge / damp / blend / low bloom / HPF / LPF",
        asset: BODIES.mic,
        actionLabel: "Open Cab / IR controls",
        onClick: () => onOpenAdvancedStage("cab"),
      },
    ]
    : sectionId === "eq" || sectionId === "post"
      ? [
        { id: "eq", eyebrow: "Post-cab", label: "Graphic EQ", detail: "Nine supported bands", asset: BODIES.eq, active: sectionId === "eq", actionLabel: "Open Graphic EQ controls", onClick: () => onOpenAdvancedStage("eq") },
        { id: "mod", eyebrow: "OpenStudio effect", label: "Modulator", detail: "Chorus / flanger", asset: BODIES.copperWide, active: sectionId === "post", actionLabel: "Open Modulator controls", onClick: () => onOpenAdvancedStage("mod") },
        { id: "delay", eyebrow: "OpenStudio effect", label: "Stereo Delay", detail: "Tempo sync · feedback · ducking", asset: BODIES.darkWidePedal, actionLabel: "Open Stereo Delay controls", onClick: () => onOpenAdvancedStage("delay") },
        { id: "reverb", eyebrow: "OpenStudio effect", label: "Reverb", detail: "Pre-delay / decay / tone", asset: BODIES.blueWidePedal, actionLabel: "Open Reverb controls", onClick: () => onOpenAdvancedStage("reverb") },
      ]
      : [
        {
          id: sectionId === "pre" ? "drive-pedals" : "amp-capture",
          eyebrow: sectionId === "pre" ? "Native pre effects" : "Amp capture",
          label: sectionId === "pre" ? "Precision + Distortion" : rig.ampLabel,
          detail: sectionId === "pre"
            ? "Two independent pre-amp drive circuits"
            : (rig.hasAmpCapture ? "Active NAM Capture" : "Browse Captures or choose Local .nam"),
          asset: sectionId === "pre" ? BODIES.red : BODIES.amp,
          active: sectionId === "amp" && rig.hasAmpCapture,
          actionLabel: sectionId === "pre" ? "Open drive controls" : "Open Amp controls",
          onClick: () => onOpenAdvancedStage(sectionId === "pre" ? "precision-drive" : "amp"),
        },
        ...(sectionId === "amp" && !rig.hasAmpCapture
          ? [{
            id: "templates-locked",
            eyebrow: "Next step",
            label: "Templates locked",
            detail: "Load an amp or full-rig .nam first",
            asset: BODIES.darkWide,
            active: false,
            actionLabel: "Open Amp Capture Library",
            onClick: () => onOpenLibrary("amp"),
          }]
          : libraryItems.slice(0, 3).map((item, index) => ({
            id: item.id,
            eyebrow: "Template for current capture",
            label: item.name,
            detail: item.subtitle,
            asset: ([BODIES.darkWide, BODIES.blue, BODIES.stone] as NAMDesignBodyAssetId[])[index % 3],
            active: item.active,
            actionLabel: `Apply ${item.name} template`,
            onClick: () => onSelectLibraryItem?.(item.id),
          }))),
      ];
  const libraryTarget = sectionId === "cab" && (rig.cabMode === "embedded" || rig.cabMode === "empty")
    ? "amp"
    : sectionId === "eq" ? "post" : sectionId;
  const libraryTitle = sectionId === "cab"
    ? rig.cabMode === "embedded" || rig.cabMode === "empty" ? "Capture Library" : "IR Library"
    : sectionId === "eq" || sectionId === "post" ? "Effects & Presets" : "Capture Library";
  const libraryEyebrow = sectionId === "cab"
    ? rig.cabMode === "embedded" ? "Full-rig cabinet" : "Cabinet source"
    : sectionId === "eq" || sectionId === "post" ? "Supported OpenStudio effects" : "Captures & templates";
  const librarySearchLabel = sectionId === "cab"
    ? rig.cabMode === "embedded"
      ? "Browse amp-only captures..."
      : rig.cabMode === "empty"
        ? "Browse amp captures..."
        : rig.cabMode === "loaded" ? "Replace cabinet IR..." : "Choose cabinet IR..."
    : sectionId === "eq" || sectionId === "post" ? "Browse effect presets..." : "Browse NAM captures / Local .nam...";
  const libraryActionLabel = sectionId === "cab"
    ? rig.cabMode === "embedded"
      ? "Browse Amp-Only Captures"
      : rig.cabMode === "empty"
        ? "Browse Amp Captures"
        : rig.cabMode === "loaded" ? "Replace IR" : "Choose IR"
    : libraryTarget === "post" ? "Open Effect Preset Library" : "Open Capture Library";
  const openResolvedLibrary = () => {
    if (sectionId === "cab" && rig.cabMode === "embedded" && onBrowseAmpOnlyCapture) {
      onBrowseAmpOnlyCapture();
      return;
    }
    onOpenLibrary(libraryTarget);
  };

  return (
    <aside className="premium-rig-drawer" data-cab-mode={sectionId === "cab" ? rig.cabMode : undefined} aria-label={`${libraryTitle} and current rack`}>
      <div className="premium-drawer-heading">
        <div><span>{libraryEyebrow}</span><strong>{libraryTitle}</strong></div>
        <i aria-hidden="true" />
      </div>
      <button type="button" className="premium-library-search" onClick={openResolvedLibrary}>
        <Search aria-hidden="true" />
        <span>{librarySearchLabel}</span>
      </button>
      <div className="premium-library-filter">
        <span>{sectionId === "amp" && !rig.hasAmpCapture ? "Capture required" : sectionId === "amp" || sectionId === "pre" ? "Capture + templates" : "Loaded and supported"}</span>
        <strong>{sectionId === "amp" && !rig.hasAmpCapture ? "Setup" : `${sectionItems.length} items`}</strong>
      </div>
      <div className="premium-rig-list">
        {sectionItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="premium-rig-card"
              data-active={Boolean(item.active)}
              aria-pressed={Boolean(item.active)}
              aria-label={item.actionLabel}
              title={item.actionLabel}
              onClick={item.onClick}
            >
              <span className="premium-rig-thumb"><DesignAssetImage assetId={item.asset} /></span>
              <span className="premium-rig-copy">
                <small>{item.eyebrow}</small>
                <strong title={item.label}>{item.label}</strong>
                <em title={item.detail}>{item.detail}</em>
              </span>
              <i aria-hidden="true" />
            </button>
        ))}
      </div>
      <button type="button" className="premium-library-cta" onClick={openResolvedLibrary}>
        <Library aria-hidden="true" />
        {libraryActionLabel}
      </button>
      <p>{sectionId === "amp" || sectionId === "pre"
        ? "Templates for Current Capture adjust supported effect settings while keeping the loaded Capture and IR identities. Local .nam is available in the Capture Library."
        : sectionId === "cab" && rig.cabMode === "embedded"
          ? "The retained external IR stays bypassed and returns automatically when an amp-only Capture is loaded."
          : "Only configured IRs and OpenStudio-owned effects are shown here."}</p>
    </aside>
  );
}

function NativeDesignStyles() {
  return <style>{`${NATIVE_DESIGN_CSS}\n${NATIVE_PREMIUM_DARK_CSS}`}</style>;
}

export function NAMRackDesignPort({
  sectionId,
  rackSizePercent,
  parameters,
  rig,
  runtime,
  recovery,
  tuner,
  calibration,
  libraryItems,
  compareSlot,
  tunerOpen,
  signalChainOpen = false,
  onParamChange,
  onEnterSection,
  onOpenAdvancedStage,
  onBrowseAmpCapture,
  onBrowseLocalAmpCapture,
  onBrowseAmpOnlyCapture,
  onBrowseCabIR,
  onBrowseLocalCabIR,
  onOpenLibrary,
  onPreviousPreset,
  onNextPreset,
  onSaveTone,
  onOpenPresetManager,
  onRecallCompare,
  onOpenCalibration,
  onSelectLibraryItem,
  onOpenTuner,
  onOpenSignalChain,
  onOpenPedalboard,
  onOpenSettings,
  onOpenAdvanced,
  onCycleSize,
  onMaxSize,
}: {
  sectionId: RackSectionId;
  rackSizePercent: number;
  parameters?: BuiltInParamDescriptor[];
  rig: NAMRackDesignRigSummary;
  runtime: NAMRackDesignRuntimeStatus;
  recovery?: NAMRackDesignRecovery;
  tuner: NAMRackDesignTunerSummary;
  calibration?: NAMRackDesignCalibrationSummary;
  libraryItems?: NAMRackDesignLibraryItem[];
  compareSlot: "A" | "B";
  tunerOpen: boolean;
  signalChainOpen?: boolean;
  onParamChange?: DesignParamChangeHandler;
  onEnterSection: (sectionId: RackSectionId, targetModule: RackModuleId) => void;
  onOpenAdvancedStage: (stageId: NAMRackAdvancedStageId) => void;
  onBrowseAmpCapture?: () => void;
  onBrowseLocalAmpCapture?: () => void;
  onBrowseAmpOnlyCapture?: () => void;
  onBrowseCabIR?: () => void;
  onBrowseLocalCabIR?: () => void;
  onOpenLibrary: (sectionId: RackSectionId) => void;
  onPreviousPreset?: () => void;
  onNextPreset?: () => void;
  onSaveTone: () => void;
  onOpenPresetManager?: () => void;
  onRecallCompare: (slot: "A" | "B") => void;
  onOpenCalibration?: () => void;
  onSelectLibraryItem?: (itemId: string) => void;
  onOpenTuner: () => void;
  onOpenSignalChain?: () => void;
  /** @deprecated Use onOpenSignalChain. Retained while the parent shell migrates. */
  onOpenPedalboard?: () => void;
  onOpenSettings?: () => void;
  onOpenAdvanced?: () => void;
  onCycleSize: () => void;
  onMaxSize: () => void;
}) {
  const [hostRef] = useElementSize<HTMLElement>();
  const [stageRef, stageSize] = useElementSize<HTMLDivElement>();
  const [localValues, setLocalValues] = useState<Record<string, number>>({});
  const designSection = designSectionFor(sectionId);
  const boardId = shellBoardForSection(sectionId);
  const inlineAmpRecovery = Boolean(
    designSection === "amp"
      && recovery?.slot === "amp"
      && (recovery.additionalMissingCount ?? 0) === 0,
  );
  const recoveryInset = recovery && !inlineAmpRecovery && !tunerOpen ? 70 : 0;
  const placement = useMemo(() => {
    const availableStage = recoveryInset > 0
      ? { width: stageSize.width, height: Math.max(120, stageSize.height - recoveryInset) }
      : stageSize;
    const next = computePremiumStagePlacement(availableStage, SECTION_GROUP_BOX[designSection], rackSizePercent);
    return recoveryInset > 0 ? { ...next, top: next.top + recoveryInset } : next;
  }, [designSection, rackSizePercent, recoveryInset, stageSize]);
  const activeLabel = designSection === "pre" ? "PEDALS" : designSection === "post" ? "POST FX" : designSection.toUpperCase();
  const effectsDisabled =
    (designSection === "pre" || designSection === "eq" || designSection === "post")
    && !rig.hasAmpCapture;
  const ampRequiredCopy = designSection === "eq"
    ? "to use the graphic EQ"
    : designSection === "post"
      ? "to use post effects"
      : "to use these pedals";
  const paramsById = useMemo(
    () => new Map((parameters ?? []).map((param) => [param.id, param])),
    [parameters],
  );
  const setLocalValue = useCallback((paramId: string, value: number) => {
    setLocalValues((current) => ({ ...current, [paramId]: value }));
  }, []);
  useEffect(() => {
    setLocalValues((current) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [paramId, value] of Object.entries(current)) {
        const sourceParam = paramsById.get(paramId);
        if (!sourceParam) {
          changed = true;
          continue;
        }
        if (Math.abs(sourceParam.value - value) <= Math.max(stepForParam(sourceParam), 0.0001) * 0.5) {
          changed = true;
          continue;
        }
        next[paramId] = value;
      }
      return changed ? next : current;
    });
  }, [paramsById]);
  useEffect(() => {
    if (Object.keys(localValues).length === 0) return undefined;
    const timeout = window.setTimeout(() => setLocalValues({}), 1500);
    return () => window.clearTimeout(timeout);
  }, [localValues]);
  const paramContext = useMemo<DesignParamContextValue>(
    () => ({
      paramsById,
      localValues,
      setLocalValue,
      onParamChange: effectsDisabled ? undefined : onParamChange,
    }),
    [effectsDisabled, localValues, onParamChange, paramsById, setLocalValue],
  );
  return (
    <DesignParamContext.Provider value={paramContext}>
      <section ref={hostRef} className="nam-rack-design-port nam-native-design-surface" data-design-board={boardId} data-design-section={designSection}>
        <NativeDesignStyles />
        <div
          className="screen-shell nam-native-shell premium-nam-shell"
          data-section={designSection}
          data-tuner-open={tunerOpen}
        >
          <div className="nam-top-artboard">
            <TopShell
              active={activeLabel}
              presetName={rig.hasAmpCapture || rig.ampCaptureMissing ? rig.presetName : "Start a New Rig"}
              presetEyebrow={rig.ampCaptureMissing ? "Amp Capture Missing" : rig.hasAmpCapture ? rig.presetEyebrow : "No Amp Capture Loaded"}
              presetDirty={(rig.hasAmpCapture || rig.ampCaptureMissing) && rig.presetDirty}
              compareSlot={compareSlot}
              inputLevelDb={runtime.inputLevelDb}
              outputLevelDb={runtime.outputLevelDb}
              calibrationLabel={calibration?.label}
              calibrationStatus={calibration?.status}
              calibrationOpen={calibration?.open}
              previewText={`${rig.ampLabel || "No Amp Capture"} \u2192 ${rig.cabLabel || "No IR loaded"}`}
              onEnterSection={(nextSection) => onEnterSection(nextSection, SECTION_TARGET_MODULE[nextSection])}
              onOpenLibrary={() => onOpenLibrary(designSection)}
              onPreviousPreset={onPreviousPreset}
              onNextPreset={onNextPreset}
              onSaveTone={onSaveTone}
              onOpenPresetManager={onOpenPresetManager}
              onRecallCompare={onRecallCompare}
              onOpenCalibration={onOpenCalibration}
            />
          </div>
          <div className="hardware-stage" data-tuner-open={tunerOpen}>
            <div
              ref={stageRef}
              className="premium-stage-canvas"
              data-recovery={recovery && !tunerOpen ? recovery.slot : undefined}
              style={{ "--nam-studio-backdrop": `url(${STUDIO_BACKDROP_URL})` } as NativeStyle}
            >
              {recovery && !inlineAmpRecovery && !tunerOpen ? <AssetRecoveryDock recovery={recovery} /> : null}
              {effectsDisabled && !tunerOpen ? (
                <button
                  type="button"
                  className="nam-amp-required-callout"
                  onClick={onBrowseAmpCapture}
                  disabled={!onBrowseAmpCapture}
                  aria-label={`Load an amp capture ${ampRequiredCopy}`}
                >
                  <Library aria-hidden="true" />
                  <span>
                    <strong>Load an amp capture</strong>
                    <small>{ampRequiredCopy}</small>
                  </span>
                </button>
              ) : null}
              {tunerOpen ? (
                <PremiumTunerStage tuner={tuner} onClose={onOpenTuner} />
              ) : (
                <div
                  className="nam-rack-artboard"
                  data-design-board={boardId}
                  data-effects-disabled={effectsDisabled}
                  aria-disabled={effectsDisabled || undefined}
                  style={{ transform: `translate(${placement.left}px, ${placement.top}px) scale(${placement.scale})` }}
                >
                  <SectionStage
                    sectionId={designSection}
                    onBrowseAmpCapture={onBrowseAmpCapture}
                    onBrowseLocalAmpCapture={onBrowseLocalAmpCapture}
                    onBrowseAmpOnlyCapture={onBrowseAmpOnlyCapture}
                    onBrowseCabIR={onBrowseCabIR}
                    onBrowseLocalCabIR={onBrowseLocalCabIR}
                    rig={rig}
                    recovery={inlineAmpRecovery ? recovery : undefined}
                  />
                </div>
              )}
              {!recovery && !tunerOpen && runtime.diagnosticMessage && runtime.diagnosticTone && runtime.diagnosticTone !== "idle" && runtime.diagnosticTone !== "success" && (
                <div className="premium-stage-status" data-tone={runtime.diagnosticTone ?? "idle"} title={runtime.diagnosticMessage}>
                  <i aria-hidden="true" />
                  <span>{runtime.diagnosticMessage}</span>
                </div>
              )}
            </div>
            <PremiumRigDrawer
              sectionId={designSection}
              rig={rig}
              tunerOpen={tunerOpen}
              libraryItems={libraryItems}
              onOpenAdvancedStage={onOpenAdvancedStage}
              onSelectLibraryItem={onSelectLibraryItem}
              onOpenLibrary={onOpenLibrary}
              onBrowseAmpOnlyCapture={onBrowseAmpOnlyCapture}
            />
          </div>
          <Footer
            rackSizePercent={rackSizePercent}
            tempo={runtime.tempo}
            timeSignatureLabel={runtime.timeSignatureLabel}
            sampleRateLabel={runtime.sampleRateLabel}
            bufferLabel={runtime.bufferLabel}
            latencyLabel={runtime.latencyLabel}
            cpuLabel={runtime.cpuLabel}
            cpuAlert={runtime.cpuAlert}
            dspLabel={runtime.dspLabel}
            dspAlert={runtime.dspAlert}
            tunerOpen={tunerOpen}
              signalChainOpen={signalChainOpen}
              onOpenTuner={onOpenTuner}
              onOpenPedalboard={onOpenSignalChain ?? onOpenPedalboard}
              onOpenSettings={onOpenSettings}
              onOpenAdvanced={onOpenAdvanced}
              onCycleSize={onCycleSize}
            onMaxSize={onMaxSize}
          />
        </div>
      </section>
    </DesignParamContext.Provider>
  );
}

export function NAMRackSourceFlowDesignPort({
  config,
  rackSizePercent = 140,
  parameters,
  runtime,
  presetName = "NAM Rack Preset",
  presetEyebrow,
  presetDirty = false,
  compareSlot = "A",
  calibration,
  tunerOpen = false,
  signalChainOpen = false,
  onEnterSection,
  onCloseLibrary,
  onPreviousPreset,
  onNextPreset,
  onSavePreset,
  onOpenPresetManager,
  onRecallCompare,
  onOpenCalibration,
  onOpenTuner,
  onOpenSignalChain,
  onOpenSettings,
  onOpenAdvanced,
  onCycleSize,
  onMaxSize,
  onAction,
}: {
  config: NAMSourceFlowDesignConfig;
  rackSizePercent?: number;
  parameters?: BuiltInParamDescriptor[];
  runtime?: Partial<NAMRackDesignRuntimeStatus>;
  presetName?: string;
  presetEyebrow?: string;
  presetDirty?: boolean;
  compareSlot?: "A" | "B";
  calibration?: NAMRackDesignCalibrationSummary;
  tunerOpen?: boolean;
  signalChainOpen?: boolean;
  onEnterSection?: (sectionId: DesignSectionId) => void;
  onCloseLibrary?: () => void;
  onPreviousPreset?: () => void;
  onNextPreset?: () => void;
  onSavePreset?: () => void;
  onOpenPresetManager?: () => void;
  onRecallCompare?: (slot: "A" | "B") => void;
  onOpenCalibration?: () => void;
  onOpenTuner?: () => void;
  onOpenSignalChain?: () => void;
  onOpenSettings?: () => void;
  onOpenAdvanced?: () => void;
  onCycleSize?: () => void;
  onMaxSize?: () => void;
  onAction: (message: NAMSourceFlowDesignPortMessage) => void;
}) {
  const [hostRef] = useElementSize<HTMLElement>();
  const readOnlyParamContext = useMemo<DesignParamContextValue>(() => ({
    paramsById: new Map((parameters ?? []).map((param) => [param.id, param])),
    localValues: {},
    setLocalValue: () => undefined,
  }), [parameters]);
  return (
    <DesignParamContext.Provider value={readOnlyParamContext}>
      <section
        ref={hostRef}
        className="nam-rack-design-port nam-rack-source-flow-design-port nam-native-design-surface"
        data-design-board={config.boardId}
        data-source-flow-mode={config.mode}
        style={{ "--nam-studio-backdrop": `url(${STUDIO_BACKDROP_URL})` } as NativeStyle}
      >
        <NativeDesignStyles />
        <div
          className="screen-shell nam-native-shell premium-nam-shell premium-source-shell"
          data-section={config.originId}
          data-source-flow-mode={config.mode}
        >
          <div className="nam-top-artboard">
            <TopShell
              active={config.originLabel}
              libraryActive
              previewText={config.previewText}
              presetName={presetName}
              presetEyebrow={presetEyebrow ?? (presetName === "Start a New Rig" ? "No Amp Capture Loaded" : "Current preset")}
              presetDirty={presetDirty}
              compareSlot={compareSlot}
              inputLevelDb={runtime?.inputLevelDb}
              outputLevelDb={runtime?.outputLevelDb}
              calibrationLabel={calibration?.label}
              calibrationStatus={calibration?.status}
              calibrationOpen={calibration?.open}
              onEnterSection={onEnterSection}
              onOpenLibrary={onCloseLibrary}
              onPreviousPreset={onPreviousPreset}
              onNextPreset={onNextPreset}
              onSaveTone={onSavePreset}
              onOpenPresetManager={onOpenPresetManager}
              onRecallCompare={onRecallCompare}
              onOpenCalibration={onOpenCalibration}
            />
          </div>
          <div className="source-flow-workspace" data-design-board={config.boardId}>
            <SourceFlowSurface config={config} onAction={onAction} />
          </div>
          <Footer
            rackSizePercent={rackSizePercent}
            tempo={runtime?.tempo}
            timeSignatureLabel={runtime?.timeSignatureLabel}
            sampleRateLabel={runtime?.sampleRateLabel}
            bufferLabel={runtime?.bufferLabel}
            latencyLabel={runtime?.latencyLabel}
            cpuLabel={runtime?.cpuLabel}
            cpuAlert={runtime?.cpuAlert}
            dspLabel={runtime?.dspLabel}
            dspAlert={runtime?.dspAlert}
            tunerOpen={tunerOpen}
            signalChainOpen={signalChainOpen}
            onOpenTuner={onOpenTuner}
            onOpenPedalboard={onOpenSignalChain}
            onOpenSettings={onOpenSettings}
            onOpenAdvanced={onOpenAdvanced}
            onCycleSize={onCycleSize}
            onMaxSize={onMaxSize}
          />
        </div>
      </section>
    </DesignParamContext.Provider>
  );
}

const NATIVE_DESIGN_CSS = `
.nam-native-design-surface {
  --ink: #101722;
  --stage-top: #eef4fd;
  --stage-mid: #dce7f3;
  --stage-low: #b6c3d2;
  position: absolute;
  inset: 0;
  z-index: 20;
  display: block;
  overflow: hidden;
  font-family: Inter, "Segoe UI", Arial, sans-serif;
  background:
    linear-gradient(180deg, rgba(255,255,255,.48), transparent 31%),
    linear-gradient(180deg, var(--stage-top) 0%, var(--stage-mid) 47%, var(--stage-low) 100%);
}
.nam-native-design-surface * { box-sizing: border-box; }
.nam-native-design-surface button {
  font-family: inherit !important;
  letter-spacing: 0 !important;
  text-transform: none;
}
.nam-native-shell {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--ink);
  background:
    linear-gradient(180deg, rgba(255,255,255,.48), transparent 31%),
    linear-gradient(180deg, var(--stage-top) 0%, var(--stage-mid) 47%, var(--stage-low) 100%);
}
.nam-native-shell::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: var(--native-top-height, clamp(180px, 29vh, 318px));
  z-index: 1;
  height: 1px;
  background: rgba(79,91,111,.18);
}
.nam-top-artboard,
.nam-rack-artboard {
  position: absolute;
  left: 0;
  top: 0;
  width: 768px;
  height: 341px;
  transform-origin: left top;
  container-type: inline-size;
}
.nam-top-artboard {
  z-index: 30;
  height: 341px;
  overflow: visible;
  pointer-events: none;
}
.nam-top-artboard button,
.nam-top-artboard [role="button"] {
  pointer-events: auto;
}
.hardware-stage {
  position: absolute;
  inset: 0 0 var(--native-footer-height, 56px) 0;
  z-index: 10;
  overflow: hidden;
  pointer-events: none;
}
.source-flow-workspace {
  position: absolute;
  left: 0;
  right: 0;
  top: var(--native-top-height, clamp(180px, 29vh, 318px));
  bottom: var(--native-footer-height, 56px);
  z-index: 14;
  overflow: hidden;
  container-type: inline-size;
  pointer-events: none;
}
.source-flow-workspace .tone-rack-flow {
  pointer-events: auto;
}
.nam-rack-artboard {
  z-index: 12;
  pointer-events: none;
}
.rack-title {
  position: absolute;
  left: 3.8%;
  top: 4.8%;
  z-index: 30;
  color: #111827;
  font-size: max(18px, 2.05cqw);
  font-weight: 950;
  line-height: 1;
  letter-spacing: 0;
  white-space: nowrap;
}
.top-nav {
  position: absolute;
  left: 35.5%;
  top: 3.5%;
  z-index: 30;
  width: 31%;
  height: 9.8%;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1.2%;
}
.nav-item {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 0;
  padding: 0;
  border: 0;
  color: rgba(18,27,41,.42);
  background: transparent;
  font-size: max(4px, .38cqw) !important;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: 0;
  line-height: 1 !important;
  cursor: pointer;
}
.nav-item b {
  max-width: 100%;
  overflow: visible;
  line-height: .96;
  text-align: center;
  white-space: normal;
}
.nav-item[data-active="true"] { color: #0f1723; }
.nav-glyph {
  position: relative;
  width: max(12px, 1.32cqw);
  height: max(12px, 1.32cqw);
  color: currentColor;
}
.nav-glyph::before,
.nav-glyph::after {
  content: "";
  position: absolute;
  inset: 18%;
  border: 2px solid currentColor;
}
.nav-glyph.pre::before {
  clip-path: polygon(44% 0,72% 0,54% 42%,78% 42%,31% 100%,43% 56%,22% 56%);
  background: currentColor;
  border: 0;
}
.nav-glyph.pre::after { display: none; }
.nav-glyph.amp::before { border-left: 0; border-right: 0; transform: skewX(-12deg); }
.nav-glyph.amp::after { inset: 42% 4% 38%; border-left: 0; border-right: 0; }
.nav-glyph.cab::before { border-radius: 50%; }
.nav-glyph.cab::after { inset: 58% 32% 6%; border-top: 0; border-radius: 0 0 10px 10px; }
.nav-glyph.eq::before { inset: 12% 45%; }
.nav-glyph.eq::after { inset: 26% 20%; border-left: 0; border-right: 0; }
.nav-glyph.post::before { border-radius: 999px; transform: rotate(90deg); }
.nav-glyph.post::after { inset: 10% 50% 10% 30%; border-left: 0; border-right: 0; }
.nav-item i {
  width: 3px;
  height: 3px;
  border-radius: 99px;
  background: currentColor;
}
.global-strip {
  position: absolute;
  left: 0;
  right: 0;
  top: 13.4%;
  height: 16.2%;
  z-index: 30;
  border-bottom: 1px solid rgba(75,88,110,.15);
}
.global-block {
  position: absolute;
  top: 2%;
  display: flex;
  gap: max(7px, 1cqw);
}
.global-block.left { left: 4.6%; }
.global-block.right { right: 4.2%; }
.mini-param {
  position: relative;
  width: max(46px, 5.35cqw);
  height: max(46px, 5.55cqw);
  display: grid;
  justify-items: center;
  align-content: end;
}
.mini-param > .asset-control { top: 46% !important; }
.mini-param strong {
  color: #101722;
  font-size: max(7px, .58cqw);
  font-weight: 950;
  white-space: nowrap;
}
.preset-area {
  position: absolute;
  left: 50%;
  top: 2%;
  width: 43%;
  transform: translateX(-50%);
}
.actions {
  margin-bottom: 3px;
  text-align: center;
  color: #27334a;
  font-size: max(6px, .52cqw);
  font-weight: 900;
}
.preset {
  height: max(20px, 2.7cqw);
  display: grid;
  grid-template-columns: 24px 1fr 20px max(64px, 7cqw);
  align-items: center;
  border: 1px solid rgba(100,114,138,.24);
  border-radius: 5px;
  background: rgba(248,251,255,.76);
  color: #0d1420;
  font-size: max(8px, .7cqw);
  font-weight: 900;
}
.preset span,
.tone-library-mark {
  display: grid;
  place-items: center;
}
.tone-library-mark {
  height: 70%;
  margin-right: 3px;
  border: 1px solid rgba(15,23,35,.36);
  border-radius: 3px;
  color: #101722;
  background: rgba(255,255,255,.36);
  font-size: max(6px, .48cqw) !important;
  font-weight: 950;
  cursor: pointer;
}
.tone-library-mark[data-active="true"] {
  border-color: rgba(245,158,11,.7);
  color: #3f2500;
  background: rgba(255,236,189,.9);
}
.tone-preview-pill {
  margin-top: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #142033;
  font-size: max(6px, .5cqw);
  font-weight: 900;
  white-space: nowrap;
}
.tone-preview-pill i {
  width: max(6px, .55cqw);
  height: max(6px, .55cqw);
  border-radius: 99px;
  background: #f59e0b;
}
.footer {
  position: absolute;
  left: 1.35%;
  right: 1.35%;
  bottom: 0;
  height: var(--native-footer-height, 56px);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: clamp(9px, 1.1vw, 22px);
  padding: 0 clamp(12px, 1.2vw, 28px);
  color: white;
  background: #020407;
  font-size: clamp(10px, .62vw, 16px);
  font-weight: 850;
}
.footer b { font-size: clamp(15px, .9vw, 22px); }
.footer i { width: 1px; height: 45%; background: rgba(255,255,255,.32); }
.footer em { margin-left: auto; display: flex; gap: 6px; font-style: normal; }
.footer em span {
  border: 1px solid rgba(255,255,255,.2);
  border-radius: 2px;
  padding: 1px 4px;
}
.module {
  position: absolute;
  z-index: 10;
  pointer-events: auto;
}
.module-frame {
  position: absolute;
  overflow: visible;
}
.stompbox .module-frame,
.wide-pedal .module-frame {
  overflow: hidden;
}
.module-skin {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  pointer-events: none;
  user-select: none;
}
.module-title {
  position: absolute;
  left: 50%;
  top: 66%;
  z-index: 6;
  max-width: 84%;
  transform: translate(-50%, -50%);
  color: rgba(248,252,255,.9);
  font-size: max(9px, .7cqw);
  font-weight: 950;
  letter-spacing: 0;
  text-align: center;
  text-transform: uppercase;
  white-space: nowrap;
}
.label {
  position: absolute;
  z-index: 8;
  transform: translate(-50%, -50%);
  color: rgba(246,250,255,.85);
  font-size: max(7px, .52cqw);
  font-weight: 900;
  letter-spacing: 0;
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
}
.label.dark { color: #273247; }
.label.center { transform: translateX(-50%); }
.kicker { color: rgba(255,255,255,.66); font-size: max(6px, .4cqw); }
.tiny { font-size: max(6px, .42cqw); opacity: .95; }
.control-label { font-size: max(7px, .5cqw); }
.panel-title { font-size: max(8px, .64cqw); }
.micro-label { font-size: max(7px, .5cqw); }
.mic-panel .label {
  color: #172033;
  font-size: max(7px, .52cqw);
  font-weight: 950;
}
.amp-label {
  color: rgba(235,239,244,.82);
  font-size: max(6px, .34cqw);
}
.rack-small {
  color: rgba(235,239,244,.86);
  font-size: max(6px, .4cqw);
}
.rack-big {
  color: rgba(235,239,244,.88);
  font-size: max(8px, .7cqw);
}
.asset-control {
  position: absolute;
  left: var(--x);
  top: var(--y);
  z-index: 7;
  width: var(--size);
  height: auto;
  transform: translate(-50%, -50%) rotate(var(--rot, 0deg));
  transform-origin: center;
  pointer-events: none;
  user-select: none;
}
.asset-control.toggle {
  /* A real photographed toggle has two discrete orientations. Snap between
     them without tweening through a knob-like rotation. */
  transition: filter 130ms ease;
}
.asset-control.three-way-toggle {
  transition:
    transform 105ms cubic-bezier(.22, .82, .32, 1),
    filter 130ms ease;
}
.asset-control.control-disabled,
.control-label.control-disabled {
  filter: grayscale(.82) saturate(.24);
  opacity: .32;
}
.control-hit {
  position: absolute;
  left: var(--x);
  top: var(--y);
  z-index: 40;
  width: var(--hit);
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  pointer-events: auto;
}
.control-hit.interactive {
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.control-hit.interactive:active { cursor: grabbing; }
.wide-pedal .post-label {
  color: rgba(248,252,255,.92);
  font-size: max(6px, .42cqw);
  font-weight: 950;
}
.stompbox .control-label,
.stompbox .value-label {
  font-size: max(5px, .34cqw);
}
.stompbox .kicker {
  font-size: max(4px, .33cqw);
}
.stompbox .module-title {
  font-size: max(7px, .48cqw);
}
.wide-pedal .module-title {
  font-size: max(8px, .58cqw);
}
.delay-rack .module-title {
  font-size: max(5px, .42cqw);
}
.delay-rack .post-label,
.delay-rack .foot-action-label {
  font-size: max(4px, .36cqw);
}
.foot-action-label {
  z-index: 12;
  color: rgba(248,252,255,.9);
  font-size: max(6px, .44cqw);
  font-weight: 950;
}
.asset-button {
  position: absolute;
  left: var(--x);
  top: var(--y);
  z-index: 7;
  width: var(--w);
  height: var(--h);
  transform: translate(-50%, -50%);
}
.asset-button img { width: 100%; height: 100%; object-fit: contain; }
.asset-button span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #f5656c;
  overflow: hidden;
  font-size: max(5px, .42cqw);
  font-weight: 950;
  line-height: 1;
  text-transform: uppercase;
}
.module-display {
  position: absolute;
  z-index: 5;
  display: grid;
  place-items: center;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 2px;
  color: #ff6268;
  background: #030506;
  font-size: max(8px, .52cqw);
  font-weight: 950;
  text-transform: uppercase;
  white-space: nowrap;
}
.amp-brand {
  position: absolute;
  left: 50%;
  top: 25.8%;
  z-index: 5;
  transform: translate(-50%, -50%);
  color: rgba(230,234,238,.62);
  font-size: max(7px, .58cqw);
  font-weight: 950;
  text-transform: uppercase;
}
.amp-badge {
  position: absolute;
  left: 50%;
  top: 34%;
  z-index: 5;
  transform: translate(-50%, -50%);
  max-width: 34%;
  padding: 3px 11px;
  border: 1px solid rgba(240,240,225,.36);
  border-radius: 3px;
  color: #d8dcd5;
  background: rgba(14,17,18,.82);
  font-size: max(10px, .82cqw);
  font-weight: 950;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cab-badge {
  position: absolute;
  left: 50%;
  top: 50.8%;
  z-index: 5;
  transform: translate(-50%, -50%);
  width: auto;
  min-width: 31%;
  height: 7%;
  padding: 0 3.6%;
  display: grid;
  place-items: center;
  color: #cfd3cc;
  background: rgba(20,22,22,.9);
  border: 1px solid rgba(245,245,232,.35);
  border-radius: 2px;
  font-size: max(5px, .48cqw);
  font-weight: 950;
  line-height: 1;
  white-space: nowrap;
}
.mic-panel .panel-title { font-size: max(6px, .48cqw); }
.mic-panel .micro-label,
.mic-panel .control-label,
.mic-panel .value-label {
  font-size: max(5px, .42cqw);
}
.mic-panel .asset-button span {
  font-size: max(4px, .34cqw);
}
.mic-panel .mix-fader-label {
  font-size: max(5px, .4cqw);
}
.mic-asset {
  position: absolute;
  left: var(--x);
  top: var(--y);
  z-index: 7;
  height: var(--h);
  width: auto;
  transform: translate(-50%, -50%);
}
.fader {
  position: absolute;
  left: var(--x);
  top: var(--y);
  z-index: 6;
  width: 4.4%;
  height: var(--h);
  transform: translate(-50%, -50%);
}
.fader-track {
  position: absolute;
  left: 48%;
  top: 0;
  width: 15%;
  height: 100%;
  border-radius: 999px;
  background: #050709;
  border: 1px solid rgba(255,255,255,.12);
}
.fader-cap {
  position: absolute;
  left: 50%;
  top: var(--value);
  width: 146%;
  transform: translate(-50%, -50%);
}
.mix-fader { width: 4.05%; }
.eq-scale-grid {
  position: absolute;
  left: 19%;
  top: 20%;
  z-index: 4;
  width: 68.2%;
  height: 61%;
  background:
    repeating-linear-gradient(0deg, rgba(255,255,255,.11) 0 1px, transparent 1px 9.5%),
    repeating-linear-gradient(90deg, rgba(255,255,255,.05) 0 1px, transparent 1px 6.7%);
}
.eq-rack .fader { width: 1.95%; }
.eq-rack .fader-cap { width: 145%; }
.eq-rack .eq-scale,
.eq-rack .eq-band-value,
.eq-rack .eq-frequency {
  color: rgba(242,247,253,.9);
  font-size: max(8px, .6cqw);
  font-weight: 950;
}
.eq-rack .eq-frequency { font-size: max(8px, .58cqw); }
.eq-rack .label.dark { color: rgba(242,247,253,.86); }
.tone-rack-flow {
  position: absolute;
  inset: 0;
  z-index: 22;
  color: #111827;
  pointer-events: auto;
}
.tone-source-flow {
  left: 8.8%;
  right: 8.8%;
  top: 32.1%;
  bottom: 8.7%;
  display: grid;
  grid-template-columns: minmax(0,.88fr) minmax(0,1.55fr) minmax(0,1.03fr);
  grid-template-rows: 15% minmax(0,1fr) 12.5%;
  gap: max(5px,.58cqw);
  padding: max(5px,.6cqw);
  border: 1px solid rgba(72,86,108,.25);
  border-radius: 5px;
  background: rgba(229,239,250,.78);
}
.source-flow-workspace .tone-source-flow {
  left: clamp(44px, 7.2cqw, 190px);
  right: clamp(44px, 7.2cqw, 190px);
  top: clamp(28px, 7vh, 104px);
  bottom: clamp(18px, 4.8vh, 76px);
  grid-template-columns: minmax(210px, .92fr) minmax(360px, 1.54fr) minmax(260px, 1.05fr);
  grid-template-rows: clamp(72px, 12vh, 118px) minmax(0, 1fr) clamp(52px, 8vh, 82px);
  gap: clamp(8px, .7cqw, 18px);
  padding: clamp(8px, .75cqw, 18px);
  border-radius: 8px;
}
.source-flow-workspace .tone-source-flow .tone-target-rail,
.source-flow-workspace .tone-source-flow .tone-browser-feed,
.source-flow-workspace .tone-source-flow .tone-detail-panel,
.source-flow-workspace .tone-source-flow .tone-audition-status {
  padding: clamp(8px, .62cqw, 16px);
  gap: clamp(5px, .45cqw, 12px);
}
.source-flow-workspace .tone-source-flow button {
  min-height: clamp(24px, 1.4cqw, 38px) !important;
  font-size: clamp(10px, .56cqw, 15px) !important;
}
.source-flow-workspace .tone-breadcrumb b,
.source-flow-workspace .tone-detail-heading b {
  font-size: clamp(17px, .98cqw, 28px);
}
.source-flow-workspace .tone-feed-head b,
.source-flow-workspace .tone-rail-heading b {
  font-size: clamp(14px, .78cqw, 22px);
}
.source-flow-workspace .tone-row-main strong {
  font-size: clamp(12px, .68cqw, 18px);
}
.source-flow-workspace .tone-feed-row {
  min-height: clamp(48px, 3.4cqw, 74px);
  gap: clamp(6px, .48cqw, 12px);
}
.source-flow-workspace .tone-action-grid {
  grid-auto-rows: clamp(28px, 1.6cqw, 42px);
  gap: clamp(6px, .46cqw, 12px) !important;
}
.source-flow-workspace .tone-hardware-preview {
  min-height: clamp(140px, 13.2cqw, 260px);
}
.tone-source-header {
  grid-column: 1/-1;
  display: grid;
  grid-template-columns: auto minmax(0,1fr) auto;
  align-items: center;
  gap: max(6px,.68cqw);
  min-width: 0;
  padding: max(4px,.46cqw) max(6px,.68cqw);
  border: 1px solid rgba(61,76,99,.18);
  border-radius: 4px;
  background: rgba(244,249,255,.74);
}
.tone-source-flow .tone-target-rail { grid-column: 1; grid-row: 2; }
.tone-source-flow .tone-browser-feed { grid-column: 2; grid-row: 2; }
.tone-source-flow .tone-detail-panel { grid-column: 3; grid-row: 2; }
.tone-source-flow .tone-audition-status { grid-column: 1/-1; grid-row: 3; }
.tone-return-button,
.tone-source-flow button {
  min-height: max(11px,.86cqw) !important;
  border: 1px solid rgba(31,42,58,.22);
  border-radius: 3px;
  padding: 0 max(3px,.36cqw);
  color: #111827;
  background: rgba(255,255,255,.52);
  font-size: max(5px,.43cqw) !important;
  font-weight: 950;
  white-space: nowrap;
  cursor: pointer;
}
.tone-return-button {
  border-color: rgba(245,158,11,.6);
  color: #3f2500;
  background: rgba(255,236,189,.88);
}
.tone-breadcrumb { min-width: 0; display: grid; gap: 1px; }
.tone-breadcrumb span,
.tone-breadcrumb em {
  overflow: hidden;
  color: rgba(20,31,48,.64);
  font-size: max(5px,.41cqw);
  font-style: normal;
  font-weight: 900;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.tone-breadcrumb b {
  overflow: hidden;
  color: #111827;
  font-size: max(9px,.72cqw);
  font-weight: 950;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-connection-state {
  display: grid;
  grid-template-columns: auto auto;
  grid-template-rows: auto auto;
  column-gap: 4px;
  align-items: center;
  color: rgba(20,31,48,.72);
}
.tone-connection-state i {
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: #22c55e;
  grid-row: 1 / span 2;
}
.tone-connection-state[data-auth="local"] i { background: #3b82f6; }
.tone-connection-state[data-auth="offline"] i { background: #ef4444; }
.tone-connection-state b,
.tone-connection-state span { font-size: max(5px,.42cqw); font-weight: 900; white-space: nowrap; }
.tone-source-flow .tone-target-rail,
.tone-source-flow .tone-browser-feed,
.tone-source-flow .tone-detail-panel,
.tone-source-flow .tone-audition-status {
  display: grid;
  min-width: 0;
  min-height: 0;
  gap: max(3px,.34cqw);
  padding: max(5px,.5cqw);
  border: 1px solid rgba(61,76,99,.18);
  border-radius: 4px;
  background: rgba(244,249,255,.72);
  overflow: hidden;
}
.tone-rail-heading,
.tone-feed-head,
.tone-detail-heading {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.tone-rail-heading span,
.tone-feed-head span,
.tone-detail-heading span {
  color: rgba(20,31,48,.62);
  font-size: max(5px,.42cqw);
  font-weight: 900;
  text-transform: uppercase;
}
.tone-rail-heading b,
.tone-feed-head b,
.tone-detail-heading b {
  overflow: hidden;
  color: #111827;
  font-size: max(8px,.64cqw);
  font-weight: 950;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-feed-head em,
.tone-detail-heading em {
  overflow: hidden;
  color: rgba(20,31,48,.62);
  font-size: max(5px,.4cqw);
  font-style: normal;
  font-weight: 850;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-target-list,
.tone-chain-list,
.tone-feed-list {
  display: grid;
  gap: max(3px,.32cqw);
  min-height: 0;
  overflow: hidden;
}
.tone-target-card,
.tone-chain-node,
.tone-local-path,
.tone-feed-row {
  min-width: 0;
  border: 1px solid rgba(31,42,58,.14);
  border-radius: 4px;
  background: rgba(243,249,255,.72);
}
.tone-target-card {
  display: grid;
  gap: 1px;
  padding: max(4px,.38cqw);
}
.tone-target-card[data-active="true"] {
  border-color: rgba(245,158,11,.72);
  background: rgba(255,239,197,.92);
}
.tone-target-card span,
.tone-target-card em,
.tone-chain-node span {
  overflow: hidden;
  color: rgba(23,32,51,.68);
  font-size: max(4px,.34cqw);
  font-style: normal;
  font-weight: 850;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-target-card b,
.tone-chain-node b {
  overflow: hidden;
  color: #172033;
  font-size: max(5px,.43cqw);
  font-weight: 950;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.tone-chain-node {
  position: relative;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 1px;
  min-height: max(15px,1.42cqw);
  text-align: center;
}
.tone-chain-node[data-target="true"] {
  border-color: rgba(245,158,11,.72);
  background: rgba(255,239,197,.92);
}
.tone-local-path {
  display: grid;
  gap: 1px;
  padding: max(4px,.42cqw);
  text-align: left;
  font-size: max(5px,.43cqw) !important;
  line-height: 1.1 !important;
}
.tone-local-path b,
.tone-local-path span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tone-local-path b { font-size: max(5px,.43cqw); font-weight: 950; }
.tone-local-path span { font-size: max(4px,.34cqw); font-weight: 850; color: rgba(23,32,51,.68); }
.tone-browser-feed { grid-template-rows: auto auto auto auto minmax(0,1fr); }
.tone-search-panel {
  display: grid;
  grid-template-columns: minmax(0,1fr) auto;
  gap: max(4px,.42cqw);
  align-items: center;
}
.tone-search-panel label {
  min-width: 0;
  display: grid;
  gap: 1px;
  padding: max(4px,.42cqw);
  border: 1px solid rgba(31,42,58,.14);
  border-radius: 4px;
  background: rgba(255,255,255,.5);
}
.tone-search-panel label span,
.tone-search-panel label b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-search-panel label span { color: rgba(20,31,48,.62); font-size: max(4px,.34cqw); font-weight: 900; text-transform: uppercase; }
.tone-search-panel label b { color: #111827; font-size: max(6px,.52cqw); font-weight: 950; }
.tone-search-panel button,
.tone-tab-row button,
.tone-filter-row button,
.tone-feed-row button,
.tone-action-grid button {
  font-size: max(5px,.43cqw) !important;
  line-height: 1.1 !important;
}
.tone-tab-row,
.tone-filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: max(3px,.28cqw);
  min-width: 0;
}
.tone-tab-row button[data-active="true"],
.tone-filter-row button[data-active="true"] {
  border-color: rgba(245,158,11,.58);
  color: #3f2500;
  background: rgba(255,236,189,.84);
}
.tone-feed-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0,1.34fr) minmax(0,1fr) auto auto auto;
  align-items: center;
  gap: max(3px,.32cqw);
  min-height: max(23px,2.08cqw);
  padding: max(4px,.38cqw);
}
.tone-row-select-target {
  position: absolute;
  inset: 0;
  z-index: 20;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: inherit;
  background: transparent;
  pointer-events: none;
}
.tone-row-select-target:focus-visible {
  outline: 2px solid rgba(245,158,11,.88);
  outline-offset: -3px;
}
.tone-feed-row[data-active="true"] {
  border-color: rgba(245,158,11,.58);
  background: rgba(255,246,224,.8);
}
.tone-feed-row[data-source="openstudio"] { border-color: rgba(59,130,246,.22); }
.tone-feed-row[data-source="external"] { border-style: dashed; }
.tone-feed-row[data-category="space-ir"],
.tone-feed-row[data-category="external-space-ir"] { background: rgba(232,240,249,.72); }
.tone-row-main,
.tone-row-tags,
.tone-row-stats {
  min-width: 0;
  display: flex;
  gap: 3px;
  align-items: center;
  overflow: hidden;
}
.tone-row-main { display: grid; gap: 1px; }
.tone-row-main strong,
.tone-row-main span,
.tone-row-tags i,
.tone-row-stats span,
.tone-feed-row em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-row-main strong { color: #111827; font-size: max(6px,.52cqw); font-weight: 950; }
.tone-row-main span,
.tone-row-stats span,
.tone-feed-row em { color: rgba(20,31,48,.65); font-size: max(5px,.34cqw); font-style: normal; font-weight: 850; }
.tone-row-tags i {
  padding: 1px 3px;
  border-radius: 3px;
  color: #283449;
  background: rgba(31,42,58,.08);
  font-size: max(4px,.32cqw);
  font-style: normal;
  font-weight: 850;
}
.tone-detail-panel {
  grid-template-rows: auto minmax(38px,.74fr) auto auto;
}
.tone-hardware-preview {
  position: relative;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border: 1px solid rgba(31,42,58,.12);
  border-radius: 4px;
  background: rgba(203,218,235,.56);
}
.tone-hardware-preview > img:first-child {
  position: absolute;
  left: 8%;
  top: 13%;
  width: 84%;
  height: 76%;
  object-fit: contain;
}
.tone-hardware-preview[data-preview-kind="pedal"] > img:first-child {
  left: 50%;
  top: 51%;
  width: 34%;
  height: 88%;
  transform: translate(-50%, -50%);
}
.tone-hardware-preview[data-preview-kind="delay"] > img:first-child,
.tone-hardware-preview[data-preview-kind="mod"] > img:first-child,
.tone-hardware-preview[data-preview-kind="reverb"] > img:first-child {
  left: 6%;
  top: 20%;
  width: 88%;
  height: 64%;
}
.tone-preview-control {
  position: absolute;
  height: auto;
  transform: translate(-50%, -50%);
  object-fit: contain;
  pointer-events: none;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.42));
}
.tone-hardware-badge {
  position: absolute;
  left: 50%;
  bottom: 10%;
  z-index: 4;
  display: grid;
  min-width: 44%;
  transform: translateX(-50%);
  padding: 3px 6px;
  border: 1px solid rgba(240,240,225,.36);
  border-radius: 3px;
  color: #d8dcd5;
  background: rgba(14,17,18,.82);
  text-align: center;
}
.tone-hardware-badge span,
.tone-hardware-badge b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-hardware-badge span { font-size: max(4px,.32cqw); font-weight: 850; text-transform: uppercase; }
.tone-hardware-badge b { font-size: max(5px,.42cqw); font-weight: 950; }
.tone-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 1px max(4px,.34cqw);
  max-height: max(24px,1.9cqw);
  min-height: 0;
  overflow: hidden;
}
.tone-detail-meta span {
  flex: 1 1 42%;
  min-width: 0;
  overflow: hidden;
  color: rgba(20,31,48,.72);
  font-size: max(5px,.4cqw);
  font-weight: 850;
  line-height: 1.06;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-detail-heading em {
  line-height: 1.1;
  white-space: normal;
}
.tone-action-grid {
  display: grid;
  grid-template-columns: repeat(3,minmax(0,1fr));
  grid-auto-rows: max(11px,.82cqw);
  align-content: start;
  gap: max(3px,.32cqw);
  min-height: max(25px,1.96cqw);
  overflow: visible;
}
.nam-source-flow-host .nam-native-design-surface .tone-action-grid,
.nam-native-design-surface .tone-source-flow .tone-action-grid {
  grid-template-columns: repeat(3,minmax(0,1fr));
  gap: max(3px,.32cqw) !important;
}
.tone-action-grid button {
  min-height: max(11px,.82cqw) !important;
  min-width: 0;
  padding: 0 3px;
}
.tone-action-grid button[data-primary="true"] {
  border-color: rgba(245,158,11,.58);
  color: #3f2500;
  background: rgba(255,236,189,.84);
}
.tone-audition-status {
  grid-template-columns: auto minmax(0,1.1fr) minmax(0,1.25fr);
  align-items: center;
}
.tone-audition-status span,
.tone-audition-status b,
.tone-audition-status em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tone-audition-status span { color: rgba(20,31,48,.62); font-size: max(5px,.42cqw); font-weight: 900; text-transform: uppercase; }
.tone-audition-status b { color: #111827; font-size: max(6px,.5cqw); font-weight: 950; }
.tone-audition-status em { color: rgba(20,31,48,.62); font-size: max(5px,.38cqw); font-style: normal; font-weight: 850; }
@container (max-width: 1180px) {
  .tone-source-flow {
    left: 8.8%;
    right: 8.8%;
    grid-template-columns: minmax(0,.86fr) minmax(0,1.45fr) minmax(0,.94fr);
    gap: 4px;
    padding: 5px;
  }
  .tone-source-flow .tone-feed-row {
    grid-template-columns: minmax(0,1.2fr) minmax(0,.84fr) auto auto;
    min-height: 21px;
  }
  .tone-source-flow .tone-row-stats { display: none; }
  .tone-source-flow .tone-row-tags i:nth-child(n + 3),
  .tone-detail-meta span:nth-child(n + 3) { display: none; }
  .tone-source-flow .tone-audition-status { grid-template-columns: auto minmax(0,1fr); }
  .tone-source-flow .tone-audition-status em { display: none; }
}
`;

const NATIVE_PREMIUM_DARK_CSS = `
/* Premium NAM Rack: the active runtime shell. Kept as a final, tightly scoped
   layer so the legacy design boards remain available to the source-flow view. */
.nam-rack-design-port.nam-native-design-surface {
  --premium-bg: #080a0e;
  --premium-panel: #101319;
  --premium-panel-raised: #171b22;
  --premium-line: rgba(255,255,255,.095);
  --premium-line-strong: rgba(255,255,255,.16);
  --premium-text: #f2f3f5;
  --premium-muted: #8d949f;
  --premium-dim: #5d6470;
  --premium-accent: #e0a149;
  --premium-accent-hot: #ffc36c;
  --premium-green: #55d28b;
  position: absolute;
  inset: 0;
  min-width: 0;
  min-height: 0;
  color: var(--premium-text);
  background: var(--premium-bg);
}
.nam-rack-design-port .premium-nam-shell {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template: 116px 54px minmax(0, 1fr) 44px / minmax(0, 1fr);
  overflow: hidden;
  color: var(--premium-text);
  background:
    radial-gradient(circle at 44% -20%, rgba(209,145,62,.13), transparent 38%),
    #080a0e;
}
.nam-rack-design-port .premium-nam-shell::before {
  display: none;
}
.nam-rack-design-port .nam-top-artboard {
  position: static !important;
  display: contents !important;
  width: auto !important;
  height: auto !important;
  transform: none !important;
  pointer-events: auto;
  container-type: normal;
}
.nam-rack-design-port .global-strip {
  position: relative !important;
  inset: auto !important;
  grid-row: 1;
  z-index: 30;
  width: auto !important;
  height: auto !important;
  display: grid;
  grid-template-columns: 174px minmax(286px, .9fr) minmax(390px, 1.42fr) minmax(132px, .42fr);
  align-items: stretch;
  gap: clamp(10px, 1vw, 20px);
  padding: 14px clamp(18px, 1.55vw, 30px) 12px;
  border: 0;
  border-bottom: 1px solid var(--premium-line);
  background:
    linear-gradient(180deg, rgba(255,255,255,.026), transparent 48%),
    rgba(10,12,16,.985);
  box-shadow: 0 16px 40px rgba(0,0,0,.26);
}
.nam-rack-design-port .premium-brand {
  min-width: 0;
  display: grid;
  align-content: center;
  justify-items: start;
  border-right: 1px solid var(--premium-line);
}
.nam-rack-design-port .premium-brand > span {
  color: var(--premium-muted);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.nam-rack-design-port .premium-brand > strong {
  margin-top: 3px;
  color: #fff;
  font-size: clamp(19px, 1.45vw, 25px);
  font-weight: 840;
  letter-spacing: -.035em;
  line-height: 1;
}
.nam-rack-design-port .premium-brand > strong::after {
  content: none;
}
.nam-rack-design-port .premium-brand > em {
  margin-top: 8px;
  color: var(--premium-dim);
  font-size: 9px;
  font-style: normal;
  font-weight: 650;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.nam-rack-design-port .global-block {
  position: static !important;
  inset: auto !important;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(6px, .65vw, 13px);
}
.nam-rack-design-port .global-block.left { grid-column: 2; }
.nam-rack-design-port .global-block.right {
  grid-column: 4;
  justify-content: flex-end;
}
.nam-rack-design-port .mini-param {
  width: clamp(58px, 4.8vw, 76px);
  height: 86px;
  display: grid;
  grid-template-rows: 13px 53px 18px;
  place-items: center;
  align-content: center;
}
.nam-rack-design-port .mini-param > .asset-control {
  top: 43px !important;
  width: 50px !important;
  height: 50px !important;
  filter: drop-shadow(0 7px 7px rgba(0,0,0,.42));
}
.nam-rack-design-port .mini-param > .knob-position-indicator {
  top: 43px !important;
  width: 50px !important;
}
.nam-rack-design-port .mini-param .global-label {
  position: static !important;
  transform: none !important;
  color: #8f96a0 !important;
  font-size: 9px !important;
  font-weight: 760;
  letter-spacing: .075em !important;
}
.nam-rack-design-port .mini-param strong {
  color: #e8eaed;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  font-weight: 720;
}
.nam-rack-design-port .premium-level-meter {
  position: relative;
  width: 22px;
  height: 72px;
  flex: 0 0 22px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 4px;
  background: #06080b;
  box-shadow: inset 0 0 0 2px rgba(0,0,0,.28);
}
.nam-rack-design-port .premium-level-meter > span {
  position: absolute;
  inset: 4px;
  border-radius: 2px;
  background:
    repeating-linear-gradient(180deg, rgba(0,0,0,.82) 0 2px, transparent 2px 5px),
    linear-gradient(180deg, #20262d, #11161b);
  opacity: .9;
}
.nam-rack-design-port .premium-level-meter > i {
  position: absolute;
  top: 4px;
  left: 4px;
  right: 4px;
  bottom: 4px;
  height: auto;
  border-radius: 2px;
  background:
    repeating-linear-gradient(180deg, rgba(0,0,0,.72) 0 2px, transparent 2px 5px),
    linear-gradient(180deg, #ef6760 0 11%, #e2ad50 11% 30%, #52c783 30% 100%);
  box-shadow: 0 0 8px rgba(82,199,131,.18);
  clip-path: inset(var(--premium-meter-inset, 100%) 0 0 0);
  transition: clip-path 100ms linear;
  will-change: clip-path;
}
.nam-rack-design-port .premium-level-meter[data-clip="true"] {
  border-color: rgba(239,103,96,.72);
  box-shadow: inset 0 0 0 2px rgba(0,0,0,.28), 0 0 9px rgba(239,103,96,.28);
}
.nam-rack-design-port .premium-level-meter > strong {
  position: absolute;
  left: 50%;
  bottom: -1px;
  z-index: 2;
  min-width: 20px;
  transform: translateX(-50%);
  color: rgba(255,255,255,.72);
  background: rgba(3,4,6,.78);
  font-size: 7px;
  font-weight: 750;
  line-height: 11px;
  text-align: center;
}
.nam-rack-design-port .preset-area {
  position: static !important;
  grid-column: 3;
  width: auto !important;
  min-width: 0;
  transform: none !important;
  display: grid;
  align-content: center;
  gap: 7px;
}
.nam-rack-design-port .preset-actions {
  display: grid;
  grid-template-columns: 28px 28px minmax(0, 1fr) 28px auto;
  align-items: center;
  gap: 5px;
}
.nam-rack-design-port .preset-actions > button,
.nam-rack-design-port .premium-compare button {
  width: 28px;
  height: 25px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--premium-line);
  border-radius: 4px;
  color: #9ca3ad;
  background: #15181e;
  cursor: pointer;
}
.nam-rack-design-port .preset-actions > button:hover,
.nam-rack-design-port .premium-compare button:hover {
  color: #fff;
  border-color: var(--premium-line-strong);
  background: #1c2028;
}
.nam-rack-design-port .preset-actions svg { width: 13px; height: 13px; }
.nam-rack-design-port .preset-context {
  min-width: 0;
  overflow: hidden;
  color: #717985;
  font-size: 10px;
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .preset-context i {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--premium-green);
  box-shadow: 0 0 8px rgba(85,210,139,.55);
}
.nam-rack-design-port .premium-compare {
  display: flex;
  gap: 3px;
  padding-left: 3px;
}
.nam-rack-design-port .premium-compare button {
  width: 25px;
  color: #747b85;
  font-size: 10px;
  font-weight: 820;
}
.nam-rack-design-port .premium-compare button[data-active="true"] {
  color: #17100a;
  border-color: #e3a651;
  background: linear-gradient(180deg, #f1b962, #c98132);
  box-shadow: 0 0 13px rgba(224,161,73,.2);
}
.nam-rack-design-port .preset {
  height: 42px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 18px auto;
  gap: 4px;
  padding: 0 6px 0 8px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 6px;
  color: #f5f6f7;
  background: linear-gradient(180deg, #1b1f26, #12151a);
  box-shadow: inset 0 1px rgba(255,255,255,.035), 0 8px 18px rgba(0,0,0,.2);
}
.nam-rack-design-port .preset > b {
  overflow: hidden;
  font-size: 13px;
  font-weight: 720;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .preset-dirty {
  color: var(--premium-accent-hot);
  opacity: 0;
}
.nam-rack-design-port .preset-dirty[data-active="true"] { opacity: 1; }
.nam-rack-design-port .tone-library-mark {
  width: auto;
  min-width: 112px;
  height: 30px;
  display: flex;
  gap: 7px;
  padding: 0 11px;
  margin: 0;
  border-color: rgba(224,161,73,.32);
  border-radius: 4px;
  color: #f1c384;
  background: rgba(224,161,73,.075);
  font-size: 10px !important;
  font-weight: 720;
}
.nam-rack-design-port .tone-library-mark:hover {
  border-color: rgba(224,161,73,.7);
  color: #fff0d9;
  background: rgba(224,161,73,.14);
}
.nam-rack-design-port .tone-library-mark svg { width: 13px; height: 13px; }
.nam-rack-design-port .top-nav {
  position: relative !important;
  inset: auto !important;
  grid-row: 2;
  z-index: 28;
  width: auto !important;
  height: auto !important;
  display: grid;
  grid-template-columns: repeat(5, minmax(86px, 126px));
  justify-content: center;
  gap: clamp(6px, 1.2vw, 24px);
  padding: 0 20px;
  border-bottom: 1px solid var(--premium-line);
  background: rgba(13,15,20,.98);
}
.nam-rack-design-port .nav-item {
  position: relative;
  display: grid;
  grid-template-columns: 18px auto 4px;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: 0 9px;
  border: 0;
  color: #666e79;
  background: transparent;
  font-size: 10px !important;
  font-weight: 740;
  cursor: pointer;
}
.nam-rack-design-port .nav-item::after {
  content: "";
  position: absolute;
  left: 13%;
  right: 13%;
  bottom: -1px;
  height: 2px;
  transform: scaleX(0);
  background: var(--premium-accent);
  box-shadow: 0 -2px 10px rgba(224,161,73,.45);
  transition: transform 140ms ease;
}
.nam-rack-design-port .nav-item:hover { color: #b5bac2; }
.nam-rack-design-port .nav-item[data-active="true"] { color: #f3f4f5; }
.nam-rack-design-port .nav-item[data-active="true"]::after { transform: scaleX(1); }
.nam-rack-design-port .premium-nav-icon,
.nam-rack-design-port .premium-nav-icon svg {
  width: 15px;
  height: 15px;
}
.nam-rack-design-port .nav-item > i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #343a43;
}
.nam-rack-design-port .nav-item[data-active="true"] > i {
  background: var(--premium-accent-hot);
  box-shadow: 0 0 7px rgba(255,195,108,.7);
}
.nam-rack-design-port .hardware-stage {
  position: relative !important;
  inset: auto !important;
  grid-row: 3;
  z-index: 10;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(270px, 20.5vw, 320px);
  overflow: hidden;
  pointer-events: auto;
  background: #080a0d;
}
.nam-rack-design-port .premium-stage-canvas {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
  background:
    radial-gradient(ellipse at 51% 37%, rgba(225,159,74,.21), transparent 31%),
    radial-gradient(ellipse at 50% 54%, rgba(255,255,255,.045), transparent 52%),
    linear-gradient(90deg, rgba(0,0,0,.25), transparent 13% 87%, rgba(0,0,0,.35)),
    repeating-linear-gradient(135deg, rgba(255,255,255,.012) 0 1px, transparent 1px 6px),
    #0a0c10;
}
.nam-rack-design-port .premium-stage-canvas::before {
  content: "";
  position: absolute;
  inset: 5.5% 4.2%;
  border: 1px solid rgba(255,255,255,.045);
  border-radius: 10px;
  box-shadow: inset 0 0 90px rgba(0,0,0,.35), 0 26px 80px rgba(0,0,0,.35);
  pointer-events: none;
}
.nam-rack-design-port .premium-stage-canvas::after {
  content: "";
  position: absolute;
  left: 10%;
  right: 10%;
  bottom: 7%;
  z-index: 1;
  height: 17%;
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(0,0,0,.82), transparent 68%);
  filter: blur(13px);
  pointer-events: none;
}
.nam-rack-design-port .premium-stage-status {
  position: absolute;
  left: clamp(18px, 2.3vw, 36px);
  bottom: clamp(15px, 2vh, 24px);
  z-index: 18;
  max-width: min(68%, 720px);
  height: 30px;
  display: grid;
  grid-template-columns: 7px minmax(0,1fr);
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 999px;
  color: #7e8691;
  background: rgba(8,10,14,.82);
  box-shadow: 0 8px 22px rgba(0,0,0,.26);
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.nam-rack-design-port .premium-stage-status > i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #59616c;
}
.nam-rack-design-port .premium-stage-status > span {
  overflow: hidden;
  font-size: 10px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .premium-stage-status[data-tone="info"] > i { background: #5a9fe8; box-shadow: 0 0 8px rgba(90,159,232,.55); }
.nam-rack-design-port .premium-stage-status[data-tone="success"] > i { background: var(--premium-green); box-shadow: 0 0 8px rgba(85,210,139,.55); }
.nam-rack-design-port .premium-stage-status[data-tone="warning"] {
  color: #dfbb83;
  border-color: rgba(224,161,73,.24);
}
.nam-rack-design-port .premium-stage-status[data-tone="warning"] > i { background: var(--premium-accent-hot); box-shadow: 0 0 8px rgba(255,195,108,.6); }
.nam-rack-design-port .premium-stage-status[data-tone="error"] {
  color: #eca49b;
  border-color: rgba(239,101,86,.3);
}
.nam-rack-design-port .premium-stage-status[data-tone="error"] > i { background: #ef6556; box-shadow: 0 0 8px rgba(239,101,86,.6); }
}
.nam-rack-design-port .nam-rack-artboard {
  position: absolute !important;
  left: 0;
  top: 0;
  z-index: 12;
  width: 768px;
  height: 341px;
  transform-origin: left top;
  pointer-events: none;
  container-type: inline-size;
}
.nam-rack-design-port .module {
  filter: drop-shadow(0 26px 22px rgba(0,0,0,.5));
  transition: filter 140ms ease, transform 140ms ease;
}
.nam-rack-design-port .module-skin {
  filter: saturate(.9) contrast(1.04) brightness(.87);
}
.nam-rack-design-port .asset-control {
  filter: drop-shadow(0 4px 4px rgba(0,0,0,.4));
}
.nam-rack-design-port .asset-control.knob {
  /* The source knob artwork's visible gear ring is centered at 47.5586% Y
     inside its transparent square. Anchor and rotate around that physical
     center so the knob cannot orbit by a pixel or two while turning. */
  transform-origin: 50% 47.5586%;
  transform: translate(-50%, -47.5586%) rotate(var(--rot, 0deg));
}
.nam-rack-design-port .knob-position-indicator {
  display: none;
}
.nam-rack-design-port .knob-position-indicator::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 11%;
  width: max(1px, 4%);
  height: 18%;
  transform: translateX(-50%);
  border-radius: 999px;
  background: rgba(245,238,220,.88);
  box-shadow: 0 1px 2px rgba(0,0,0,.72);
}
.nam-rack-design-port .control-label,
.nam-rack-design-port .value-label,
.nam-rack-design-port .module-title,
.nam-rack-design-port .label {
  text-shadow: 0 1px 1px rgba(0,0,0,.52);
}
.nam-rack-design-port .asset-button span,
.nam-rack-design-port .foot-action-label,
.nam-rack-design-port .delay-rack .foot-action-label {
  font-size: max(8px, .55cqw) !important;
  letter-spacing: .01em;
}
.nam-rack-design-port .stompbox .control-label,
.nam-rack-design-port .stompbox .value-label,
.nam-rack-design-port .wide-pedal .control-label,
.nam-rack-design-port .wide-pedal .value-label {
  font-size: max(8px, .62cqw) !important;
  font-weight: 780 !important;
  letter-spacing: .03em !important;
}
.nam-rack-design-port .stompbox .module-title,
.nam-rack-design-port .wide-pedal .module-title {
  font-size: max(9px, .76cqw) !important;
  font-weight: 860 !important;
  letter-spacing: .04em !important;
}
.nam-rack-design-port .module[data-module="precision-drive"] .module-title {
  width: 96%;
  max-width: 96%;
  font-size: max(8px, .68cqw) !important;
  letter-spacing: .015em !important;
}
.nam-rack-design-port .stompbox .kicker {
  font-size: max(7px, .5cqw) !important;
  opacity: .58;
}
.nam-rack-design-port .pedal-model-display,
.nam-rack-design-port .tone-display,
.nam-rack-design-port .delay-display,
.nam-rack-design-port .cab-model-display {
  overflow: hidden;
  padding: 0 4%;
  color: #ffd78e !important;
  font-size: max(7px, .62cqw) !important;
  text-overflow: ellipsis;
  text-shadow: 0 0 7px rgba(255,184,74,.3);
  white-space: nowrap;
}
.nam-rack-design-port .delay-display i {
  color: rgba(255, 215, 142, .52);
  font-style: normal;
}
.nam-rack-design-port .pedal-capture-selector {
  z-index: 56;
  grid-template-columns: minmax(0,1fr);
  grid-template-rows: 1fr 1fr;
  gap: 0;
  align-items: center;
  padding: 0 5px;
  border-color: rgba(255,211,139,.34);
  color: #f0c879 !important;
  cursor: pointer;
  pointer-events: auto;
}
.nam-rack-design-port .pedal-capture-selector:hover:not(:disabled),
.nam-rack-design-port .pedal-capture-selector:focus-visible {
  border-color: rgba(255,208,126,.8);
  outline: 1px solid rgba(255,208,126,.7);
  outline-offset: 2px;
  background: #0c0b08;
}
.nam-rack-design-port .pedal-capture-selector:disabled { cursor: default; opacity: .72; }
.nam-rack-design-port .pedal-capture-selector > span {
  min-width: 0;
  overflow: hidden;
  font-size: max(6.5px, .5cqw);
  line-height: 1;
  text-overflow: ellipsis;
}
.nam-rack-design-port .pedal-capture-selector > strong {
  color: #fff1cf;
  font-size: max(6px, .43cqw);
  font-weight: 820;
  letter-spacing: .08em;
  line-height: 1;
  text-transform: uppercase;
}
.nam-rack-design-port .cab-source-selector {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
  z-index: 76;
  left: 4.5%;
  top: 4.5%;
  width: 91%;
  max-width: none;
  min-width: 0;
  height: 15%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  padding: 2px 3px 2px 7px;
  transform: none;
  border-color: rgba(228,188,126,.25);
  border-radius: 3px;
  background: linear-gradient(180deg, rgba(12,14,16,.96), rgba(5,7,8,.98));
  box-shadow: inset 0 1px rgba(255,255,255,.04), 0 2px 7px rgba(0,0,0,.45);
  pointer-events: auto;
}
.nam-rack-design-port .cab-source-copy {
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 1px;
  overflow: hidden;
  text-align: left;
}
.nam-rack-design-port .cab-source-copy > small {
  color: rgba(210,172,112,.72);
  font-size: max(6px, .34cqw);
  font-weight: 720;
  letter-spacing: .08em;
  line-height: 1;
  white-space: nowrap;
}
.nam-rack-design-port .cab-source-copy > strong {
  max-width: 100%;
  overflow: hidden;
  color: #e9e2d4;
  font-size: max(7.5px, .5cqw);
  font-weight: 680;
  letter-spacing: .025em;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .cab-source-actions {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: calc(100% - 2px);
}
.nam-rack-design-port .cab-source-actions > button {
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 0 6px;
  border: 1px solid rgba(229,166,77,.25);
  border-radius: 2px;
  color: #e7b86e;
  background: rgba(224,161,73,.07);
  font-size: max(6px, .36cqw);
  font-weight: 780;
  letter-spacing: .055em;
  white-space: nowrap;
  cursor: pointer;
}
.nam-rack-design-port .cab-source-actions > button svg {
  width: 8px;
  height: 8px;
}
.nam-rack-design-port .cab-source-actions > button:hover:not(:disabled),
.nam-rack-design-port .cab-source-actions > button:focus-visible {
  border-color: rgba(255,208,126,.72);
  color: #ffd48f;
  background: rgba(224,161,73,.14);
  outline: 1px solid rgba(255,208,126,.45);
  outline-offset: 1px;
}
.nam-rack-design-port .cab-source-actions > button:disabled {
  cursor: default;
  opacity: .42;
}
.nam-rack-design-port .cab-source-actions > .cab-source-local {
  padding-inline: 4px;
  color: #9aa0a8;
  border-color: rgba(255,255,255,.08);
  background: rgba(255,255,255,.025);
}
.nam-rack-design-port .cab-controls-locked .cab-control-deck .knob-position-indicator { opacity: .24; }
.nam-rack-design-port .cab-controls-locked .cab-control-deck .asset-control.led {
  filter: grayscale(.9) saturate(.18);
  opacity: .28;
}
.nam-rack-design-port .cabinet.cab-mode-empty .module-frame { filter: brightness(.38) saturate(.45); }
.nam-rack-design-port .cabinet.cab-mode-required .module-frame { filter: brightness(.55) saturate(.62); }
.nam-rack-design-port .cabinet.cab-mode-embedded .module-frame { filter: brightness(.82) saturate(.78); }
.nam-rack-design-port .ir-shaper-panel.cab-controls-locked .module-skin {
  filter: brightness(.68) contrast(1.08) saturate(.42) drop-shadow(0 18px 15px rgba(0,0,0,.55));
}
.nam-rack-design-port .amp-brand {
  color: rgba(255,255,255,.84) !important;
  font-size: max(17px, 1.65cqw) !important;
  letter-spacing: -.035em !important;
  text-shadow: 0 2px 3px rgba(0,0,0,.65) !important;
}
.nam-rack-design-port .amp-badge {
  max-width: 56%;
  overflow: hidden;
  color: #f2d5a7 !important;
  font-size: max(11px, 1.02cqw) !important;
  text-overflow: ellipsis;
  text-shadow: 0 2px 3px rgba(0,0,0,.7);
  white-space: nowrap;
}
.nam-rack-design-port .amp-tone-note {
  color: rgba(245,224,190,.66) !important;
  font-size: max(8px, .6cqw) !important;
  letter-spacing: .02em;
}
.nam-rack-design-port .amp-rail-label {
  color: rgba(251,237,213,.82) !important;
  font-size: max(8px, .58cqw) !important;
}
.nam-rack-design-port .amp-control-rail {
  position: absolute;
  inset: 0;
  z-index: 6;
  transition: filter 140ms ease, opacity 140ms ease;
}
.nam-rack-design-port .amp-control-rail[data-disabled="true"] {
  filter: none;
  opacity: 1;
}
.nam-rack-design-port .amp-control-rail[data-disabled="true"] .asset-control.led,
.nam-rack-design-port .amp-control-rail[data-disabled="true"] .asset-control.washer,
.nam-rack-design-port .amp-control-rail[data-disabled="true"] .control-label:not(.control-disabled) {
  filter: grayscale(.82) saturate(.24);
  opacity: .32;
}
.nam-rack-design-port .pedal-nam-control-group {
  position: absolute;
  inset: 0;
  z-index: 6;
  transition: filter 140ms ease, opacity 140ms ease;
}
.nam-rack-design-port .pedal-nam-control-group[data-disabled="true"] {
  filter: none;
  opacity: 1;
}
.nam-rack-design-port .pedal-nam-control-group[data-disabled="true"] .asset-control.led {
  filter: grayscale(.82) saturate(.24);
  opacity: .32;
}
.nam-rack-design-port .amp-tone-caption {
  position: absolute;
  left: 50%;
  top: 67%;
  z-index: 5;
  transform: translateX(-50%);
  color: rgba(226,220,208,.5) !important;
  font-size: 7.5px !important;
  letter-spacing: .14em;
  white-space: nowrap;
}
.nam-rack-design-port .cab-badge,
.nam-rack-design-port .cab-status-badge {
  max-width: 78%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .cab-badge {
  color: rgba(255,241,219,.9) !important;
  font-size: max(10px, .82cqw) !important;
}
.nam-rack-design-port .cab-status-badge {
  color: rgba(255,255,255,.52) !important;
  font-size: max(8px, .58cqw) !important;
}
.nam-rack-design-port .mic-panel .panel-title,
.nam-rack-design-port .mic-panel .control-label,
.nam-rack-design-port .mic-panel .rack-small {
  font-size: max(8px, .58cqw) !important;
}
.nam-rack-design-port .eq-rack-title {
  color: #e7eaee !important;
  font-size: max(9px, .74cqw) !important;
}
.nam-rack-design-port .eq-frequency,
.nam-rack-design-port .eq-scale,
.nam-rack-design-port .eq-band-value,
.nam-rack-design-port .rack-small,
.nam-rack-design-port .rack-big {
  font-size: max(8px, .58cqw) !important;
}
.nam-rack-design-port .eq-rack .fader { width: 2.6%; }
.nam-rack-design-port .premium-rig-drawer {
  position: relative;
  z-index: 25;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto auto auto minmax(0, 1fr);
  gap: 12px;
  padding: 22px 18px 17px;
  overflow: hidden;
  border-left: 1px solid var(--premium-line);
  background:
    linear-gradient(180deg, rgba(255,255,255,.024), transparent 34%),
    #0e1116;
  box-shadow: -22px 0 50px rgba(0,0,0,.3);
}
.nam-rack-design-port .premium-drawer-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}
.nam-rack-design-port .premium-drawer-heading > div {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.nam-rack-design-port .premium-drawer-heading span {
  color: var(--premium-muted);
  font-size: 10px;
  font-weight: 760;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.nam-rack-design-port .premium-drawer-heading strong {
  color: #f5f6f7;
  font-size: 18px;
  font-weight: 770;
  letter-spacing: -.025em;
}
.nam-rack-design-port .premium-drawer-heading > i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--premium-green);
  box-shadow: 0 0 10px rgba(85,210,139,.55);
}
.nam-rack-design-port .premium-drawer-heading button {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--premium-line-strong);
  border-radius: 4px;
  color: #c9cdd3;
  background: #181c22;
  font-size: 10px;
  cursor: pointer;
}
.nam-rack-design-port .premium-library-search {
  min-width: 0;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 11px;
  border: 1px solid var(--premium-line);
  border-radius: 5px;
  color: #858d98;
  background: #080a0e;
  font-size: 10px;
  text-align: left;
  cursor: pointer;
}
.nam-rack-design-port .premium-library-search:hover {
  color: #daddE1;
  border-color: rgba(224,161,73,.38);
}
.nam-rack-design-port .premium-library-search svg { width: 13px; height: 13px; }
.nam-rack-design-port .premium-rig-list {
  min-height: 0;
  display: grid;
  align-content: start;
  gap: 8px;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: #323844 transparent;
}
.nam-rack-design-port .premium-rig-card {
  position: relative;
  min-width: 0;
  min-height: 70px;
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) 5px;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 8px 8px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 6px;
  color: #b6bbc2;
  background: rgba(255,255,255,.018);
  text-align: left;
  cursor: pointer;
}
.nam-rack-design-port .premium-rig-card:hover {
  border-color: rgba(255,255,255,.14);
  background: rgba(255,255,255,.035);
}
.nam-rack-design-port .premium-rig-card[data-active="true"] {
  border-color: rgba(224,161,73,.48);
  background: linear-gradient(90deg, rgba(224,161,73,.1), rgba(255,255,255,.023));
  box-shadow: inset 2px 0 var(--premium-accent);
}
.nam-rack-design-port .premium-rig-thumb {
  position: relative;
  width: 58px;
  height: 46px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.06);
  border-radius: 4px;
  background: #090b0e;
}
.nam-rack-design-port .premium-rig-thumb img {
  width: 90%;
  height: 90%;
  object-fit: contain;
  filter: brightness(.74) saturate(.82);
}
.nam-rack-design-port .premium-rig-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.nam-rack-design-port .premium-rig-copy small {
  color: #6e7682;
  font-size: 9px;
  font-weight: 730;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.nam-rack-design-port .premium-rig-copy strong {
  overflow: hidden;
  color: #eceef0;
  font-size: 12px;
  font-weight: 730;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .premium-rig-copy em {
  overflow: hidden;
  color: #777f8a;
  font-size: 10px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .premium-rig-drawer[data-cab-mode="embedded"] .premium-rig-copy strong,
.nam-rack-design-port .premium-rig-drawer[data-cab-mode="embedded"] .premium-rig-copy em {
  display: -webkit-box;
  line-height: 1.18;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.nam-rack-design-port .premium-rig-card > i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #353c46;
}
.nam-rack-design-port .premium-rig-card[data-active="true"] > i {
  background: var(--premium-accent-hot);
  box-shadow: 0 0 8px rgba(255,195,108,.68);
}
.nam-rack-design-port .premium-library-cta {
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid rgba(224,161,73,.55);
  border-radius: 5px;
  color: #24170b;
  background: linear-gradient(180deg, #edb25b, #c98231);
  box-shadow: inset 0 1px rgba(255,255,255,.22), 0 8px 18px rgba(0,0,0,.2);
  font-size: 10px;
  font-weight: 790;
  cursor: pointer;
}
.nam-rack-design-port .premium-library-cta:hover { filter: brightness(1.07); }
.nam-rack-design-port .premium-library-cta svg { width: 14px; height: 14px; }
.nam-rack-design-port .premium-rig-drawer > p {
  margin: 0;
  color: #5f6671;
  font-size: 9px;
  line-height: 1.45;
}
.nam-rack-design-port .premium-tuner-drawer {
  grid-template-rows: auto minmax(230px, 1fr) auto auto;
}
.nam-rack-design-port .premium-tuner-display {
  min-height: 184px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 4px;
  border: 1px solid var(--premium-line);
  border-radius: 8px;
  color: #505762;
  background:
    radial-gradient(circle, rgba(224,161,73,.1), transparent 60%),
    #090b0f;
}
.nam-rack-design-port .premium-tuner-drawer[data-signal="true"] .premium-tuner-display {
  color: var(--premium-accent-hot);
}
.nam-rack-design-port .premium-tuner-display svg { width: 22px; height: 22px; }
.nam-rack-design-port .premium-tuner-display strong {
  color: currentColor;
  font-size: clamp(58px, 5.2vw, 86px);
  font-weight: 700;
  letter-spacing: -.06em;
  line-height: 1;
  text-shadow: 0 0 28px rgba(224,161,73,.2);
}
.nam-rack-design-port .premium-tuner-display span {
  color: #737b86;
  font-size: 10px;
  font-weight: 760;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.nam-rack-design-port .premium-tuner-display em {
  margin-top: 4px;
  color: #d6d9dd;
  font-size: 15px;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  font-weight: 760;
}
.nam-rack-design-port .premium-tuner-cents {
  position: relative;
  height: 36px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  align-items: end;
  border-top: 1px solid var(--premium-line);
}
.nam-rack-design-port .premium-tuner-cents::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 8px;
  height: 2px;
  background: #252a32;
}
.nam-rack-design-port .premium-tuner-cents > i {
  position: absolute;
  left: var(--premium-tuner-pct);
  top: 3px;
  width: 2px;
  height: 13px;
  transform: translateX(-1px);
  background: var(--premium-accent-hot);
  box-shadow: 0 0 8px rgba(255,195,108,.7);
}
.nam-rack-design-port .premium-tuner-cents > span {
  color: #5d6570;
  font-size: 9px;
  text-align: center;
}
.nam-rack-design-port .premium-tuner-readouts {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.nam-rack-design-port .premium-tuner-readouts article {
  min-width: 0;
  display: grid;
  gap: 3px;
  padding: 9px 6px;
  border: 1px solid var(--premium-line);
  border-radius: 4px;
  background: rgba(255,255,255,.015);
  text-align: center;
}
.nam-rack-design-port .premium-tuner-readouts span { color: #6e7682; font-size: 9px; }
.nam-rack-design-port .premium-tuner-readouts strong { overflow: hidden; color: #d9dce0; font-size: 11px; text-overflow: ellipsis; }
.nam-rack-design-port .footer {
  position: relative !important;
  inset: auto !important;
  grid-row: 4;
  z-index: 40;
  width: auto;
  height: auto !important;
  display: grid;
  grid-template-columns: auto auto auto 1px auto 1px auto auto 1px minmax(0,1fr) auto;
  align-items: center;
  gap: clamp(8px, .8vw, 16px);
  padding: 0 clamp(15px, 1.45vw, 28px);
  border-top: 1px solid rgba(255,255,255,.08);
  color: #858c96;
  background: #07090c;
  font-size: 10px;
  font-weight: 680;
}
.nam-rack-design-port .footer > b {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #d9dce0;
  font-size: 10px;
  font-weight: 780;
}
.nam-rack-design-port .footer > b svg { width: 12px; height: 12px; color: var(--premium-accent); }
.nam-rack-design-port .footer > i {
  width: 1px;
  height: 15px;
  background: rgba(255,255,255,.1);
}
.nam-rack-design-port .footer button {
  min-height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: #8d949e;
  background: transparent;
  font-size: 9px;
  font-weight: 720;
  cursor: pointer;
}
.nam-rack-design-port .footer button:hover,
.nam-rack-design-port .footer button[data-active="true"] {
  color: #f1d1a0;
  border-color: rgba(224,161,73,.22);
  background: rgba(224,161,73,.07);
}
.nam-rack-design-port .footer button:disabled { cursor: default; opacity: .45; }
.nam-rack-design-port .footer button svg { width: 12px; height: 12px; }
.nam-rack-design-port .footer-control-spacer { min-width: 1px; }
.nam-rack-design-port .footer-midi {
  display: flex;
  align-items: center;
  gap: 6px;
}
.nam-rack-design-port .footer-midi > i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #3e4650;
}
.nam-rack-design-port .footer strong { color: #d6d9dd; font-size: inherit; }
.nam-rack-design-port .footer-runtime {
  min-width: 0;
  display: flex;
  gap: 13px;
}
.nam-rack-design-port .footer-runtime strong[data-alert="true"] { color: #ef8d7f; }
.nam-rack-design-port .footer > em {
  margin: 0;
  display: flex;
  justify-content: flex-end;
  gap: 3px;
  font-style: normal;
}
.nam-rack-source-flow-design-port .source-flow-workspace {
  position: relative !important;
  inset: auto !important;
  grid-row: 3;
  z-index: 14;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
  pointer-events: auto;
  background:
    radial-gradient(circle at 50% 0, rgba(224,161,73,.075), transparent 38%),
    repeating-linear-gradient(135deg, rgba(255,255,255,.01) 0 1px, transparent 1px 6px),
    #090b0f;
}
.nam-rack-source-flow-design-port .source-flow-workspace .tone-source-flow {
  position: absolute;
  inset: clamp(14px, 2.2vh, 24px) clamp(15px, 1.6vw, 28px) clamp(12px, 1.8vh, 20px);
  grid-template-columns: minmax(220px, .88fr) minmax(390px, 1.5fr) minmax(280px, 1.05fr);
  grid-template-rows: clamp(66px, 10vh, 88px) minmax(0,1fr) clamp(46px, 6.6vh, 62px);
  gap: clamp(8px, .72cqw, 13px);
  padding: clamp(8px, .72cqw, 13px);
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 9px;
  color: var(--premium-text);
  background: rgba(13,16,21,.94);
  box-shadow: 0 26px 70px rgba(0,0,0,.38), inset 0 1px rgba(255,255,255,.025);
}
.nam-rack-source-flow-design-port .tone-source-header,
.nam-rack-source-flow-design-port .tone-target-rail,
.nam-rack-source-flow-design-port .tone-browser-feed,
.nam-rack-source-flow-design-port .tone-detail-panel,
.nam-rack-source-flow-design-port .tone-audition-status {
  border-color: rgba(255,255,255,.085) !important;
  border-radius: 6px !important;
  background: #11151b !important;
}
.nam-rack-source-flow-design-port .tone-source-header {
  padding: 9px 11px;
  background: linear-gradient(180deg, #181c23, #12151a) !important;
}
.nam-rack-source-flow-design-port .tone-return-button,
.nam-rack-source-flow-design-port .tone-source-flow button {
  border-color: rgba(255,255,255,.12);
  color: #b9bec6;
  background: #191d24;
  font-weight: 720;
}
.nam-rack-source-flow-design-port .tone-return-button {
  border-color: rgba(224,161,73,.45);
  color: #f3c684;
  background: rgba(224,161,73,.08);
}
.nam-rack-source-flow-design-port .tone-source-flow button:hover {
  color: #fff;
  border-color: rgba(224,161,73,.48);
  background: rgba(224,161,73,.1);
}
.nam-rack-source-flow-design-port .tone-breadcrumb span,
.nam-rack-source-flow-design-port .tone-breadcrumb em,
.nam-rack-source-flow-design-port .tone-rail-heading span,
.nam-rack-source-flow-design-port .tone-feed-head span,
.nam-rack-source-flow-design-port .tone-detail-heading span,
.nam-rack-source-flow-design-port .tone-feed-head em,
.nam-rack-source-flow-design-port .tone-detail-heading em { color: #737b87; }
.nam-rack-source-flow-design-port .tone-breadcrumb b,
.nam-rack-source-flow-design-port .tone-rail-heading b,
.nam-rack-source-flow-design-port .tone-feed-head b,
.nam-rack-source-flow-design-port .tone-detail-heading b { color: #f1f2f4; }
.nam-rack-source-flow-design-port .tone-connection-state { color: #a1a7b0; }
.nam-rack-source-flow-design-port .tone-target-card,
.nam-rack-source-flow-design-port .tone-chain-node,
.nam-rack-source-flow-design-port .tone-local-path,
.nam-rack-source-flow-design-port .tone-feed-row,
.nam-rack-source-flow-design-port .tone-search-panel label {
  border-color: rgba(255,255,255,.075);
  color: #c9cdd3;
  background: #0c0f13;
}
.nam-rack-source-flow-design-port .tone-target-card[data-active="true"],
.nam-rack-source-flow-design-port .tone-chain-node[data-target="true"],
.nam-rack-source-flow-design-port .tone-feed-row[data-active="true"] {
  border-color: rgba(224,161,73,.56);
  background: linear-gradient(90deg, rgba(224,161,73,.11), rgba(255,255,255,.02));
  box-shadow: inset 2px 0 var(--premium-accent);
}
.nam-rack-source-flow-design-port .tone-target-card b,
.nam-rack-source-flow-design-port .tone-chain-node b,
.nam-rack-source-flow-design-port .tone-search-panel label b,
.nam-rack-source-flow-design-port .tone-row-main strong,
.nam-rack-source-flow-design-port .tone-audition-status b { color: #eceef0; }
.nam-rack-source-flow-design-port .tone-target-card span,
.nam-rack-source-flow-design-port .tone-target-card em,
.nam-rack-source-flow-design-port .tone-chain-node span,
.nam-rack-source-flow-design-port .tone-local-path span,
.nam-rack-source-flow-design-port .tone-search-panel label span,
.nam-rack-source-flow-design-port .tone-row-main span,
.nam-rack-source-flow-design-port .tone-row-stats span,
.nam-rack-source-flow-design-port .tone-feed-row em,
.nam-rack-source-flow-design-port .tone-detail-meta span,
.nam-rack-source-flow-design-port .tone-audition-status span,
.nam-rack-source-flow-design-port .tone-audition-status em { color: #767e89; }
.nam-rack-source-flow-design-port .tone-row-tags i {
  color: #a9afb8;
  background: rgba(255,255,255,.06);
}
.nam-rack-source-flow-design-port .tone-tab-row button[data-active="true"],
.nam-rack-source-flow-design-port .tone-filter-row button[data-active="true"],
.nam-rack-source-flow-design-port .tone-action-grid button[data-primary="true"] {
  border-color: #d7963e;
  color: #211408;
  background: linear-gradient(180deg, #efb45e, #c77f30);
}
.nam-rack-source-flow-design-port .tone-feed-row[data-source="openstudio"] { border-color: rgba(90,138,202,.32); }
.nam-rack-source-flow-design-port .tone-feed-row[data-category="space-ir"],
.nam-rack-source-flow-design-port .tone-feed-row[data-category="external-space-ir"] { background: rgba(42,55,73,.46); }
.nam-rack-source-flow-design-port .tone-hardware-preview {
  border-color: rgba(255,255,255,.08);
  background: radial-gradient(circle at 50% 45%, rgba(224,161,73,.1), transparent 48%), #090b0f;
}
.nam-rack-source-flow-design-port .tone-hardware-preview > img:first-child {
  filter: brightness(.82) saturate(.88) drop-shadow(0 16px 13px rgba(0,0,0,.48));
}
.nam-rack-source-flow-design-port .tone-hardware-preview .mic-panel {
  filter: brightness(.88) saturate(.82) contrast(1.06);
}
.nam-rack-source-flow-design-port .tone-hardware-badge { display: none; }
.nam-rack-source-flow-design-port .tone-feed-list {
  grid-auto-rows: minmax(56px, 72px);
  align-content: start;
}
.nam-rack-source-flow-design-port .tone-audition-status {
  background: linear-gradient(90deg, rgba(224,161,73,.07), #101319 45%) !important;
}
.nam-rack-source-flow-design-port .tone-breadcrumb span,
.nam-rack-source-flow-design-port .tone-breadcrumb em,
.nam-rack-source-flow-design-port .tone-connection-state b,
.nam-rack-source-flow-design-port .tone-connection-state span,
.nam-rack-source-flow-design-port .tone-rail-heading span,
.nam-rack-source-flow-design-port .tone-feed-head span,
.nam-rack-source-flow-design-port .tone-detail-heading span {
  font-size: 9px !important;
  letter-spacing: .055em;
}
.nam-rack-source-flow-design-port .tone-breadcrumb b { font-size: 16px !important; }
.nam-rack-source-flow-design-port .tone-rail-heading b,
.nam-rack-source-flow-design-port .tone-feed-head b { font-size: 14px !important; }
.nam-rack-source-flow-design-port .tone-detail-heading b { font-size: 18px !important; }
.nam-rack-source-flow-design-port .tone-feed-head em,
.nam-rack-source-flow-design-port .tone-detail-heading em,
.nam-rack-source-flow-design-port .tone-target-card span,
.nam-rack-source-flow-design-port .tone-target-card em,
.nam-rack-source-flow-design-port .tone-chain-node span,
.nam-rack-source-flow-design-port .tone-local-path span,
.nam-rack-source-flow-design-port .tone-search-panel label span,
.nam-rack-source-flow-design-port .tone-row-main span,
.nam-rack-source-flow-design-port .tone-row-stats span,
.nam-rack-source-flow-design-port .tone-feed-row em,
.nam-rack-source-flow-design-port .tone-detail-meta span,
.nam-rack-source-flow-design-port .tone-audition-status span,
.nam-rack-source-flow-design-port .tone-audition-status em { font-size: 9px !important; }
.nam-rack-source-flow-design-port .tone-target-card b,
.nam-rack-source-flow-design-port .tone-chain-node b,
.nam-rack-source-flow-design-port .tone-local-path b { font-size: 10px !important; }
.nam-rack-source-flow-design-port .tone-search-panel label b { font-size: 11px !important; }
.nam-rack-source-flow-design-port .tone-row-main strong { font-size: 13px !important; }
.nam-rack-source-flow-design-port .tone-row-tags i { font-size: 8px !important; }
.nam-rack-source-flow-design-port .tone-audition-status b { font-size: 10px !important; }
.nam-rack-source-flow-design-port .preset-actions > button:disabled {
  visibility: hidden;
}
.nam-rack-source-flow-design-port .preset-actions button:disabled,
.nam-rack-source-flow-design-port .premium-compare button:disabled,
.nam-rack-source-flow-design-port .nav-item:disabled {
  cursor: default;
  opacity: .4;
}
.nam-rack-source-flow-design-port .tone-library-mark:disabled { cursor: default; opacity: .8; }
@media (max-width: 1240px) {
  .nam-rack-design-port .premium-nam-shell { grid-template-rows: 106px 50px minmax(0,1fr) 42px; }
  .nam-rack-design-port .global-strip {
    grid-template-columns: 142px minmax(256px,.82fr) minmax(325px,1.35fr) minmax(116px,.35fr);
    gap: 8px;
    padding: 10px 16px;
  }
  .nam-rack-design-port .premium-brand > em { display: none; }
  .nam-rack-design-port .mini-param { width: 57px; height: 82px; }
  .nam-rack-design-port .mini-param > .asset-control { width: 45px !important; height: 45px !important; }
  .nam-rack-design-port .mini-param > .knob-position-indicator { width: 45px !important; }
  .nam-rack-design-port .premium-level-meter { height: 66px; }
  .nam-rack-design-port .hardware-stage { grid-template-columns: minmax(0,1fr) 270px; }
  .nam-rack-design-port .premium-rig-drawer { padding: 17px 14px 13px; gap: 9px; }
  .nam-rack-design-port .premium-rig-card { min-height: 62px; }
  .nam-rack-source-flow-design-port .source-flow-workspace .tone-source-flow {
    grid-template-columns: minmax(190px,.82fr) minmax(330px,1.42fr) minmax(240px,1fr);
  }
}
@media (max-width: 1030px) {
  .nam-rack-design-port .global-strip { grid-template-columns: 126px minmax(224px,.88fr) minmax(300px,1.35fr) 88px; }
  .nam-rack-design-port .global-block.left .mini-param { width: 48px; }
  .nam-rack-design-port .global-block.right .mini-param { width: 54px; }
  .nam-rack-design-port .hardware-stage { grid-template-columns: minmax(0,1fr); }
  .nam-rack-design-port .premium-rig-drawer:not(.premium-tuner-drawer) { display: none; }
  .nam-rack-design-port .hardware-stage:has(.premium-tuner-drawer) { grid-template-columns: minmax(0,1fr) 270px; }
  .nam-rack-design-port .premium-tuner-drawer { display: grid; }
  .nam-rack-design-port .footer-runtime strong:nth-child(2),
  .nam-rack-design-port .footer-runtime strong:nth-child(3) { display: none; }
  .nam-rack-source-flow-design-port .source-flow-workspace .tone-source-flow {
    inset: 12px;
    grid-template-columns: minmax(0,1.45fr) minmax(260px,.9fr);
  }
  .nam-rack-source-flow-design-port .tone-target-rail { display: none !important; }
  .nam-rack-source-flow-design-port .tone-browser-feed { grid-column: 1; }
  .nam-rack-source-flow-design-port .tone-detail-panel { grid-column: 2; display: grid !important; }
}
@media (max-width: 780px) {
  .nam-rack-design-port .premium-nam-shell { grid-template-rows: 94px 46px minmax(0,1fr) 40px; }
  .nam-rack-design-port .global-strip { grid-template-columns: 102px minmax(150px,.72fr) minmax(235px,1.3fr); padding: 8px 10px; }
  .nam-rack-design-port .global-block.right { display: none; }
  .nam-rack-design-port .global-block.left .premium-level-meter,
  .nam-rack-design-port .global-block.left .mini-param:nth-of-type(n+2) { display: none; }
  .nam-rack-design-port .premium-brand > span { font-size: 8px; }
  .nam-rack-design-port .premium-brand > strong { font-size: 17px; }
  .nam-rack-design-port .preset-actions { grid-template-columns: 24px 24px minmax(0,1fr) 24px auto; }
  .nam-rack-design-port .preset-actions > button { width: 24px; height: 23px; }
  .nam-rack-design-port .premium-compare button { width: 21px; height: 23px; }
  .nam-rack-design-port .tone-library-mark { min-width: 82px; padding: 0 7px; font-size: 8px !important; }
  .nam-rack-design-port .top-nav { grid-template-columns: repeat(5,minmax(52px,84px)); gap: 3px; }
  .nam-rack-design-port .nav-item { gap: 4px; padding: 0 4px; font-size: 8px !important; }
  .nam-rack-design-port .premium-nav-icon,
  .nam-rack-design-port .premium-nav-icon svg { width: 12px; height: 12px; }
  .nam-rack-design-port .footer { grid-template-columns: auto auto auto 1px auto auto minmax(0,1fr) auto; gap: 6px; padding: 0 9px; }
  .nam-rack-design-port .footer > i:nth-of-type(n+2),
  .nam-rack-design-port .footer-midi,
  .nam-rack-design-port .footer-runtime { display: none; }
  .nam-rack-source-flow-design-port .source-flow-workspace .tone-source-flow { grid-template-columns: minmax(0,1fr); }
  .nam-rack-source-flow-design-port .tone-target-rail { display: none !important; }
  .nam-rack-source-flow-design-port .tone-browser-feed { grid-column: 1; }
  .nam-rack-source-flow-design-port .tone-detail-panel { display: none !important; }
}

/* Premium composition v3: the concept-aligned runtime surface. */
.nam-rack-design-port .premium-nam-shell {
  inset: 4px;
  grid-template: clamp(186px, 21.5vh, 208px) clamp(66px, 7.8vh, 76px) minmax(0, 1fr) clamp(58px, 6.4vh, 62px) / minmax(0, 1fr);
  border: 1px solid rgba(187, 197, 210, .23);
  border-radius: 12px;
  background:
    radial-gradient(circle at 49% -28%, rgba(226, 155, 67, .1), transparent 40%),
    linear-gradient(180deg, #0b0e12, #06080b);
  box-shadow: inset 0 1px rgba(255,255,255,.055), inset 0 0 0 2px rgba(0,0,0,.5), 0 18px 70px rgba(0,0,0,.72);
  font-family: Inter, "Segoe UI Variable", "Segoe UI", Arial, sans-serif;
}
.nam-rack-design-port .global-strip {
  grid-template-columns: minmax(328px, 350px) minmax(520px, 780px) minmax(150px, 174px);
  justify-content: space-between;
  gap: 20px;
  padding: 18px clamp(24px, 1.8vw, 30px) 16px;
  border-bottom-color: rgba(255,255,255,.12);
  background:
    linear-gradient(180deg, rgba(255,255,255,.032), transparent 46%),
    linear-gradient(90deg, rgba(255,255,255,.012), transparent 14% 86%, rgba(255,255,255,.012)),
    #090c10;
  box-shadow: inset 0 -1px rgba(0,0,0,.8), 0 18px 46px rgba(0,0,0,.34);
}
.nam-rack-design-port .premium-brand {
  position: absolute;
  left: clamp(26px, 1.9vw, 32px);
  top: 20px;
  z-index: 2;
  display: grid;
  align-content: start;
  padding: 0;
  border: 0;
}
.nam-rack-design-port .premium-brand > span {
  color: #858b94;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: .13em;
}
.nam-rack-design-port .premium-brand > strong {
  margin-top: 2px;
  color: #d9dce0;
  font-size: clamp(20px, 1.55vw, 24px);
  font-weight: 720;
  letter-spacing: -.02em;
}
.nam-rack-design-port .premium-brand > em {
  display: none;
}
.nam-rack-design-port .premium-calibration-launch {
  position: absolute;
  left: 168px;
  top: 1px;
  min-width: 0;
  height: 22px;
  display: grid;
  grid-template-columns: 12px auto 1fr;
  align-items: center;
  gap: 5px;
  margin-top: 0;
  padding: 0;
  border: 0;
  color: #6f7680;
  background: transparent;
  font-size: 8px;
  font-weight: 650;
  cursor: pointer;
}
.nam-rack-design-port .premium-calibration-launch:hover,
.nam-rack-design-port .premium-calibration-launch[data-active="true"] {
  color: #ffe1b1;
  background: transparent;
}
.nam-rack-design-port .premium-calibration-launch svg { width: 11px; height: 11px; color: #b47b34; }
.nam-rack-design-port .premium-calibration-launch > span { letter-spacing: .1em; }
.nam-rack-design-port .premium-calibration-launch > strong { overflow: hidden; color: #9ca2aa; font-size: 8px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.nam-rack-design-port .global-block {
  align-self: end;
  justify-content: flex-start;
  gap: clamp(15px, 1.35vw, 23px);
  padding-top: 54px;
}
.nam-rack-design-port .global-block.left { grid-column: 1; }
.nam-rack-design-port .global-block.right { grid-column: 3; justify-content: flex-end; }
.nam-rack-design-port .mini-param {
  width: clamp(70px, 5vw, 80px);
  height: 112px;
  grid-template-rows: 17px 68px 22px;
}
.nam-rack-design-port .mini-param > .asset-control {
  top: 53px !important;
  width: 64px !important;
  height: 64px !important;
  filter: drop-shadow(0 9px 10px rgba(0,0,0,.55));
}
.nam-rack-design-port .mini-param > .knob-position-indicator {
  top: 53px !important;
  width: 64px !important;
}
.nam-rack-design-port .mini-param[data-param-id="inputTrimDb"] > .asset-control,
.nam-rack-design-port .mini-param[data-param-id="outputTrimDb"] > .asset-control {
  filter: sepia(.17) saturate(1.16) drop-shadow(0 9px 10px rgba(0,0,0,.55)) drop-shadow(0 0 7px rgba(224,161,73,.12));
}
.nam-rack-design-port .mini-param[data-param-id="inputTrimDb"] > .knob-position-indicator::after,
.nam-rack-design-port .mini-param[data-param-id="outputTrimDb"] > .knob-position-indicator::after { background: #efbd73; }
.nam-rack-design-port .mini-param .global-label {
  color: #b6bac0 !important;
  font-size: 10px !important;
  font-weight: 650;
  letter-spacing: .07em !important;
}
.nam-rack-design-port .mini-param strong {
  grid-row: 3;
  color: #d4d7db;
  font-size: 11px;
  font-weight: 620;
}
.nam-rack-design-port .mini-param[data-read-only="true"] {
  opacity: .5;
  cursor: not-allowed;
}
.nam-rack-design-port .mini-param[data-read-only="true"] > .asset-control {
  filter: grayscale(.72) saturate(.45) drop-shadow(0 5px 7px rgba(0,0,0,.42));
}
.nam-rack-design-port [data-module="tape-echo"] .control-label {
  font-size: 7px !important;
  letter-spacing: 0 !important;
}
.nam-rack-design-port .premium-level-meter {
  width: 31px;
  height: 108px;
  flex-basis: 31px;
  border-radius: 4px;
}
.nam-rack-design-port .premium-level-meter > span { inset: 5px; }
.nam-rack-design-port .premium-level-meter > i {
  top: 5px;
  right: 5px;
  bottom: 5px;
  left: 5px;
  height: auto;
  clip-path: inset(var(--premium-meter-inset, 100%) 0 0 0);
}
.nam-rack-design-port .premium-level-meter > strong { min-width: 28px; font-size: 9px; line-height: 15px; }
.nam-rack-design-port .preset-area {
  position: relative !important;
  left: auto !important;
  top: auto !important;
  inset: auto !important;
  grid-column: 2;
  grid-template-columns: minmax(0,1fr);
  grid-template-rows: minmax(0, 1fr);
  align-self: end;
  align-content: end;
  gap: 0;
  padding: 0 0 21px;
}
.nam-rack-design-port .preset-context {
  display: none;
}
.nam-rack-design-port .preset-console {
  grid-column: 1 / -1;
  min-width: 0;
  height: 76px;
  display: grid;
  grid-template-columns: 50px minmax(220px,1fr) 50px 58px 78px;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 5px;
  background: linear-gradient(180deg, #15181d, #0a0d10);
  box-shadow: inset 0 1px rgba(255,255,255,.035), inset 0 -1px rgba(0,0,0,.8), 0 12px 32px rgba(0,0,0,.34);
}
.nam-rack-design-port .preset-console > button,
.nam-rack-design-port .preset-console .premium-compare {
  border: 0;
  border-left: 1px solid rgba(255,255,255,.09);
  border-radius: 0;
  color: #aeb4bd;
  background: transparent;
}
.nam-rack-design-port .preset-console > button:first-child { border-left: 0; border-right: 1px solid rgba(255,255,255,.09); }
.nam-rack-design-port .preset-console > button:hover { color: #fff; background: rgba(255,255,255,.045); }
.nam-rack-design-port .preset-console > button svg { width: 20px; height: 20px; }
.nam-rack-design-port .preset-console > button.preset-arrow {
  display: grid;
  place-items: center;
  padding: 0;
  line-height: 0;
}
.nam-rack-design-port .preset-console > button.preset-arrow svg {
  display: block;
  margin: auto;
}
.nam-rack-design-port .preset-title {
  min-width: 0;
  display: grid;
  place-content: center;
  gap: 5px;
  padding: 0 18px;
  text-align: center;
}
.nam-rack-design-port .preset-console > button.preset-title {
  width: 100%;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.nam-rack-design-port .preset-console > button.preset-title:hover {
  background: linear-gradient(180deg, rgba(224,161,73,.045), rgba(255,255,255,.018));
}
.nam-rack-design-port .preset-console > button.preset-title:focus-visible {
  outline: 1px solid rgba(224,161,73,.72);
  outline-offset: -3px;
}
.nam-rack-design-port .preset-title small {
  display: block;
  overflow: hidden;
  color: #777f89;
  font-size: 8px;
  font-weight: 620;
  letter-spacing: .09em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.nam-rack-design-port .preset-title b {
  overflow: hidden;
  color: #e4e6e8;
  font-size: clamp(20px, 1.55vw, 24px);
  font-weight: 600;
  letter-spacing: -.015em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .preset-console .preset-save {
  display: grid;
  place-content: center;
  gap: 3px;
  color: #9ea4ad;
  font-size: 8px;
  font-weight: 650;
  text-transform: uppercase;
}
.nam-rack-design-port .preset-console .preset-save svg { margin: auto; }
.nam-rack-design-port .preset-console .premium-compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr;
  gap: 4px;
  align-items: center;
  padding: 10px 7px;
}
.nam-rack-design-port .preset-console .premium-compare button {
  width: 100%;
  height: 34px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 3px;
  background: #12151a;
  font-size: 11px;
  font-weight: 680;
}
.nam-rack-design-port .preset-console .premium-compare button + button { border-top: 1px solid rgba(255,255,255,.1); }
.nam-rack-design-port .preset-console .premium-compare button[data-active="true"] {
  color: #f3c47d;
  border-color: rgba(224,161,73,.65);
  background: rgba(224,161,73,.1);
  box-shadow: inset 0 0 0 1px rgba(224,161,73,.06), 0 0 10px rgba(224,161,73,.08);
}
.nam-rack-design-port .tone-library-mark {
  grid-column: 2;
  grid-row: 2;
  align-self: end;
  min-width: 126px;
  height: 28px;
  margin: 0 8px 8px 0;
  border-color: rgba(224,161,73,.3);
  font-size: 9px !important;
  z-index: 2;
  display: none !important;
}
.nam-rack-design-port .top-nav {
  grid-template-columns: repeat(5, minmax(122px, 164px));
  gap: clamp(12px, 1.45vw, 26px);
  padding: 0 30px;
  background: linear-gradient(180deg, #101318, #090c0f);
  box-shadow: inset 0 1px rgba(255,255,255,.018), 0 10px 28px rgba(0,0,0,.28);
}
.nam-rack-design-port .nav-flow-step {
  position: relative;
  min-width: 0;
  display: grid;
}
.nam-rack-design-port .nav-flow-chevron {
  position: absolute;
  right: calc(-1 * clamp(9px, .95vw, 18px));
  top: 50%;
  width: 17px;
  height: 17px;
  transform: translate(50%, -50%);
  color: #3c424a;
}
.nam-rack-design-port .nav-item {
  grid-template-columns: 30px auto;
  gap: 12px;
  padding: 0 13px;
  color: #8a919b;
  font-size: 13px !important;
  font-weight: 650;
  letter-spacing: .035em !important;
}
.nam-rack-design-port .premium-nav-icon,
.nam-rack-design-port .premium-nav-icon svg { width: 27px; height: 27px; }
.nam-rack-design-port .nav-item > i { display: none; }
.nam-rack-design-port .nav-item::after { left: 10%; right: 10%; height: 2px; }
.nam-rack-design-port .nav-item[data-active="true"] { color: #e5aa54; }
.nam-rack-design-port .nav-item[data-active="true"] .premium-nav-icon { color: #e5aa54; filter: drop-shadow(0 0 8px rgba(224,161,73,.2)); }
.nam-rack-design-port .premium-nam-shell[data-tuner-open="true"] .nav-item[data-active="true"] {
  color: #8a919a;
}
.nam-rack-design-port .premium-nam-shell[data-tuner-open="true"] .nav-item[data-active="true"]::after {
  opacity: .32;
  transform: scaleX(.34);
}
.nam-rack-design-port .premium-nam-shell[data-tuner-open="true"] .nav-item[data-active="true"] > i {
  opacity: .45;
  box-shadow: none;
}
.nam-rack-design-port .hardware-stage {
  grid-template-columns: minmax(0, 1fr) clamp(278px, 19.6vw, 310px);
  background: #07090b;
}
.nam-rack-design-port .hardware-stage[data-tuner-open="true"] { grid-template-columns: minmax(0,1fr); }
.nam-rack-design-port .premium-stage-canvas {
  background:
    radial-gradient(ellipse at 50% 47%, rgba(240,174,91,.12), transparent 41%),
    linear-gradient(90deg, rgba(0,0,0,.5), transparent 17% 83%, rgba(0,0,0,.52)),
    var(--nam-studio-backdrop) center / cover no-repeat;
}
.nam-rack-design-port .premium-stage-canvas::before {
  inset: 0;
  border: 0;
  border-radius: 0;
  background:
    radial-gradient(ellipse at 50% 38%, transparent 28%, rgba(0,0,0,.19) 73%, rgba(0,0,0,.52) 100%),
    linear-gradient(180deg, rgba(2,3,4,.12), transparent 22% 70%, rgba(2,2,3,.24));
  box-shadow: inset 0 22px 62px rgba(0,0,0,.26), inset 0 -24px 48px rgba(0,0,0,.22);
}
.nam-rack-design-port .premium-stage-canvas::after {
  left: 8%;
  right: 8%;
  bottom: 3.5%;
  height: 18%;
  background: radial-gradient(ellipse, rgba(0,0,0,.78), transparent 68%);
  filter: blur(15px);
}
.nam-rack-design-port .nam-rack-artboard { height: 341px; }
.nam-rack-design-port .module { filter: drop-shadow(0 25px 22px rgba(0,0,0,.67)); }
.nam-rack-design-port .module-skin { filter: saturate(.98) contrast(1.025) brightness(1.025); }
.nam-rack-design-port .control-label,
.nam-rack-design-port .value-label,
.nam-rack-design-port .module-title,
.nam-rack-design-port .label { text-shadow: 0 1px 1px rgba(0,0,0,.34); }
.nam-rack-design-port .stompbox .control-label,
.nam-rack-design-port .stompbox .value-label {
  font-size: 9.25px !important;
  color: rgba(237,235,229,.84) !important;
  font-weight: 620 !important;
  letter-spacing: .018em !important;
}
.nam-rack-design-port .wide-pedal .control-label,
.nam-rack-design-port .wide-pedal .value-label {
  font-size: 9.5px !important;
  color: rgba(237,235,229,.82) !important;
  font-weight: 610 !important;
  letter-spacing: .012em !important;
}
.nam-rack-design-port .stompbox .module-title {
  font-size: 10.5px !important;
  color: rgba(244,242,235,.9) !important;
  font-weight: 680 !important;
  letter-spacing: .025em !important;
}
.nam-rack-design-port .wide-pedal .module-title {
  font-size: 11.5px !important;
  color: rgba(244,242,235,.88) !important;
  font-weight: 680 !important;
  letter-spacing: .025em !important;
}
.nam-rack-design-port .module[data-module="precision-drive"] .module-title {
  font-size: 9.5px !important;
}
.nam-rack-design-port .stompbox .kicker {
  font-size: 7.5px !important;
}
.nam-rack-design-port .asset-button span,
.nam-rack-design-port .foot-action-label,
.nam-rack-design-port .delay-rack .foot-action-label {
  font-size: 8.5px !important;
  color: rgba(226,224,218,.84) !important;
  font-weight: 590 !important;
}
.nam-rack-design-port .asset-button.hot span { color: #e6ad5b !important; }
.nam-rack-design-port .module-display {
  color: #e6ad5b;
  font-weight: 650;
}
.nam-rack-design-port .mic-panel .panel-title,
.nam-rack-design-port .mic-panel .control-label,
.nam-rack-design-port .mic-panel .rack-small,
.nam-rack-design-port .eq-rack .eq-scale,
.nam-rack-design-port .eq-rack .eq-band-value,
.nam-rack-design-port .eq-rack .eq-frequency,
.nam-rack-design-port .eq-rack .rack-big,
.nam-rack-design-port .eq-rack .rack-small {
  font-size: max(9px, .61cqw) !important;
  font-weight: 580 !important;
  letter-spacing: .015em !important;
  text-shadow: 0 1px 1px rgba(0,0,0,.45) !important;
}
.nam-rack-design-port .eq-rack .fader { width: 3.05%; }
.nam-rack-design-port .eq-rack .fader-cap { width: 170%; }
.nam-rack-design-port .eq-rack-title { font-size: max(10px, .75cqw) !important; font-weight: 680 !important; }
.nam-rack-design-port .mic-panel .module-skin {
  filter: brightness(.3) contrast(1.22) saturate(.45) sepia(.22) drop-shadow(0 20px 16px rgba(0,0,0,.5));
}
.nam-rack-design-port .mic-panel .module-frame::before {
  content: "";
  position: absolute;
  inset: 2.4% 1.7%;
  z-index: 2;
  pointer-events: none;
  border: 1px solid rgba(248,218,171,.14);
  border-radius: 4.5%;
  background:
    linear-gradient(128deg, rgba(255,255,255,.065), transparent 22%, rgba(0,0,0,.11) 58%, rgba(224,161,73,.045)),
    repeating-linear-gradient(90deg, rgba(255,255,255,.012) 0 1px, transparent 1px 4px);
  box-shadow:
    inset 0 1px rgba(255,255,255,.08),
    inset 0 -20px 34px rgba(0,0,0,.2),
    0 7px 14px rgba(0,0,0,.32);
}
.nam-rack-design-port .mic-panel .label,
.nam-rack-design-port .mic-panel .panel-title,
.nam-rack-design-port .mic-panel .control-label,
.nam-rack-design-port .mic-panel .rack-small { color: rgba(241,235,222,.88) !important; text-shadow: 0 1px 2px #000; }
.nam-rack-design-port .ir-shaper-panel .module-skin {
  filter: brightness(.9) contrast(1.08) saturate(.72) drop-shadow(0 18px 15px rgba(0,0,0,.55));
}
.nam-rack-design-port .ir-shaper-panel.cab-mode-empty.cab-controls-locked .module-skin {
  filter: brightness(.68) contrast(1.08) saturate(.42) drop-shadow(0 18px 15px rgba(0,0,0,.55));
}
.nam-rack-design-port .ir-shaper-panel.cab-mode-required.cab-controls-locked .module-skin {
  filter: brightness(.75) contrast(1.08) saturate(.48) drop-shadow(0 18px 15px rgba(0,0,0,.55));
}
.nam-rack-design-port .ir-shaper-panel.cab-mode-embedded.cab-controls-locked .module-skin {
  filter: brightness(.81) contrast(1.08) saturate(.55) drop-shadow(0 18px 15px rgba(0,0,0,.55));
}
.nam-rack-design-port .ir-shaper-panel .cab-control-deck {
  position: absolute;
  inset: 0;
  z-index: 6;
}
.nam-rack-design-port .ir-shaper-panel .control-label,
.nam-rack-design-port .ir-shaper-panel .ir-utility-label {
  color: rgba(237,232,222,.86) !important;
  font-size: max(8px, .55cqw) !important;
  font-weight: 620 !important;
  letter-spacing: .055em !important;
  text-shadow: 0 1px 2px rgba(0,0,0,.9) !important;
}
.nam-rack-design-port .ir-shaper-panel .ir-utility-label {
  color: rgba(218,183,126,.84) !important;
  font-size: max(7px, .48cqw) !important;
  letter-spacing: .09em !important;
}
.nam-rack-design-port .ir-shaper-panel .cab-control-deck[data-locked="true"] .ir-utility-label {
  filter: grayscale(.75);
  opacity: .36;
}
.nam-rack-design-port .amp-brand {
  top: 25.5%;
  color: rgba(220,222,224,.74) !important;
  font-size: max(10px, .88cqw) !important;
  font-weight: 650 !important;
  letter-spacing: .09em !important;
  text-shadow: 0 1px 2px rgba(0,0,0,.7) !important;
}
.nam-rack-design-port .amp-capture-nameplate {
  position: absolute;
  left: 50%;
  top: 37.5%;
  z-index: 76;
  width: 34%;
  height: 16.5%;
  min-height: 52px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 1px;
  padding: 5px 20px 4px;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(209,199,181,.56);
  border-radius: 3px;
  color: #ddd9d1;
  background:
    radial-gradient(circle at 8px 8px, #a9a49a 0 1px, #242424 1.4px 2.4px, transparent 2.8px),
    radial-gradient(circle at calc(100% - 8px) 8px, #a9a49a 0 1px, #242424 1.4px 2.4px, transparent 2.8px),
    radial-gradient(circle at 8px calc(100% - 8px), #8f8a82 0 1px, #202020 1.4px 2.4px, transparent 2.8px),
    radial-gradient(circle at calc(100% - 8px) calc(100% - 8px), #8f8a82 0 1px, #202020 1.4px 2.4px, transparent 2.8px),
    repeating-linear-gradient(90deg, rgba(255,255,255,.018) 0 1px, transparent 1px 4px),
    linear-gradient(180deg, #202326, #0b0d0f 54%, #17191b);
  box-shadow:
    0 3px 8px rgba(0,0,0,.72),
    inset 0 1px rgba(255,255,255,.18),
    inset 0 -1px rgba(0,0,0,.9),
    0 0 0 2px rgba(0,0,0,.38);
  pointer-events: auto;
}
.nam-rack-design-port .amp-capture-nameplate:focus-within {
  border-color: rgba(228,169,83,.82);
  box-shadow:
    0 3px 8px rgba(0,0,0,.72),
    inset 0 0 0 1px rgba(232,173,90,.48),
    0 0 0 2px rgba(0,0,0,.45);
}
.nam-rack-design-port .amp-capture-state {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #8e918f;
  font-size: 8px;
  font-weight: 760;
  letter-spacing: .12em;
  line-height: 1;
  text-transform: uppercase;
}
.nam-rack-design-port .amp-capture-state i {
  width: 4px;
  height: 4px;
  flex: 0 0 4px;
  border-radius: 50%;
  background: #5fd698;
  box-shadow: 0 0 5px rgba(95,214,152,.58);
}
.nam-rack-design-port .amp-capture-nameplate[data-state="empty"] .amp-capture-state i {
  background: #d29a4c;
  box-shadow: 0 0 5px rgba(210,154,76,.48);
}
.nam-rack-design-port .amp-capture-nameplate[data-state="missing"] .amp-capture-state {
  color: #dc9a8d;
}
.nam-rack-design-port .amp-capture-nameplate[data-state="missing"] .amp-capture-state i {
  background: #e7604e;
  box-shadow: 0 0 6px rgba(231,96,78,.62);
}
.nam-rack-design-port .amp-capture-model {
  min-width: 0;
  overflow: hidden;
  color: #e8e4dc;
  font-size: 12px;
  font-weight: 680;
  letter-spacing: .015em;
  line-height: 1.05;
  text-align: center;
  text-overflow: ellipsis;
  text-shadow: 0 1px 1px #000;
  white-space: nowrap;
}
.nam-rack-design-port .amp-capture-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.nam-rack-design-port .amp-capture-actions button {
  min-width: 54px;
  height: 19px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 7px;
  border: 1px solid rgba(210,203,190,.2);
  border-radius: 2px;
  color: #aaa69d;
  background: linear-gradient(180deg, #24272a, #111315);
  box-shadow: inset 0 1px rgba(255,255,255,.08), 0 1px 2px rgba(0,0,0,.7);
  font-size: 8px;
  font-weight: 760;
  letter-spacing: .08em;
  line-height: 1;
  text-transform: uppercase;
}
.nam-rack-design-port .amp-capture-actions button svg {
  width: 9px;
  height: 9px;
}
.nam-rack-design-port .amp-capture-actions button:hover:not(:disabled) {
  color: #f0c27b;
  border-color: rgba(224,161,73,.52);
  background: linear-gradient(180deg, #2c2923, #15130f);
}
.nam-rack-design-port .amp-capture-actions button:focus-visible {
  outline: 1px solid rgba(236,178,93,.9);
  outline-offset: -2px;
}
.nam-rack-design-port .amp-capture-actions button:disabled {
  cursor: default;
  opacity: .42;
}
.nam-rack-design-port .amp-rail-label {
  color: rgba(220,217,209,.86) !important;
  font-size: max(9px, .62cqw) !important;
  font-weight: 580 !important;
  letter-spacing: .025em !important;
  text-shadow: 0 1px 1px rgba(0,0,0,.72) !important;
}
.nam-rack-design-port .premium-rig-drawer {
  grid-template-rows: auto auto auto minmax(0,1fr) auto auto;
  gap: 10px;
  padding: 18px 14px 13px;
  border-left-color: rgba(255,255,255,.11);
  background:
    linear-gradient(180deg, rgba(224,161,73,.025), transparent 24%),
    linear-gradient(90deg, #101317, #090c0f);
  box-shadow: -18px 0 48px rgba(0,0,0,.32), inset 1px 0 rgba(255,255,255,.02);
}
.nam-rack-design-port .premium-drawer-heading span { color: #777e87; font-size: 8px; font-weight: 650; letter-spacing: .1em; }
.nam-rack-design-port .premium-drawer-heading strong { color: #dca04c; font-size: 15px; font-weight: 680; letter-spacing: .02em; }
.nam-rack-design-port .premium-library-search { height: 36px; border-radius: 3px; font-size: 10px; }
.nam-rack-design-port .premium-library-search svg { width: 15px; height: 15px; }
.nam-rack-design-port .premium-library-filter {
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 3px;
  color: #9298a1;
  background: rgba(255,255,255,.018);
  font-size: 9px;
  font-weight: 620;
}
.nam-rack-design-port .premium-library-filter strong {
  min-width: 23px;
  padding: 3px 6px;
  border-radius: 999px;
  color: #d6d9dd;
  background: rgba(255,255,255,.06);
  text-align: center;
}
.nam-rack-design-port .premium-rig-list {
  gap: 0;
  border-top: 1px solid rgba(255,255,255,.075);
  border-bottom: 1px solid rgba(255,255,255,.075);
}
.nam-rack-design-port .premium-rig-card {
  min-height: 74px;
  grid-template-columns: 72px minmax(0,1fr) 5px;
  gap: 10px;
  padding: 9px 7px;
  border: 0;
  border-bottom: 1px solid rgba(255,255,255,.07);
  border-radius: 0;
  background: transparent;
}
.nam-rack-design-port .premium-rig-card:last-child { border-bottom: 0; }
.nam-rack-design-port .premium-rig-card:hover { background: rgba(255,255,255,.025); }
.nam-rack-design-port .premium-rig-card[data-active="true"] {
  border-color: rgba(224,161,73,.38);
  background: linear-gradient(90deg, rgba(224,161,73,.09), rgba(255,255,255,.012));
  box-shadow: inset 3px 0 #d99a45, inset 0 0 0 1px rgba(224,161,73,.28);
}
.nam-rack-design-port .premium-rig-thumb { width: 72px; height: 48px; border: 0; background: #07090b; }
.nam-rack-design-port .premium-rig-thumb img { width: 96%; height: 96%; filter: brightness(1.04) saturate(.96); }
.nam-rack-design-port .premium-rig-copy small { color: #747b84; font-size: 8px; font-weight: 650; }
.nam-rack-design-port .premium-rig-copy strong { color: #dfe1e4; font-size: 12px; font-weight: 650; }
.nam-rack-design-port .premium-rig-copy em {
  display: -webkit-box;
  overflow: hidden;
  color: #747b84;
  font-size: 9px;
  font-weight: 450;
  line-height: 1.25;
  text-overflow: clip;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.nam-rack-design-port .premium-library-cta {
  height: 38px;
  border-color: rgba(224,161,73,.48);
  color: #efb55f;
  background: linear-gradient(180deg, rgba(224,161,73,.11), rgba(224,161,73,.055));
  box-shadow: inset 0 1px rgba(255,255,255,.025), 0 8px 20px rgba(0,0,0,.13);
  font-size: 10px;
  font-weight: 650;
}
.nam-rack-design-port .premium-rig-drawer > p { display: none; }
.nam-rack-design-port .footer {
  display: flex;
  gap: clamp(8px, .85vw, 14px);
  padding: 0 clamp(18px, 1.7vw, 28px);
  background: linear-gradient(180deg, #0a0c0f, #05070a);
  font-size: 10px;
  font-weight: 560;
}
.nam-rack-design-port .footer > b { display: none; }
.nam-rack-design-port .footer button { min-height: 29px; padding: 0 8px; font-size: 9px; font-weight: 600; }
.nam-rack-design-port .footer button svg { width: 14px; height: 14px; }
.nam-rack-design-port .footer-runtime { margin-left: auto; gap: 15px; color: #858b94; }
.nam-rack-design-port .footer-runtime strong { color: #aeb3ba; font-weight: 600; }
.nam-rack-design-port .footer-runtime strong:nth-child(n+3) { display: none; }
.nam-rack-design-port .footer > em { flex: none; margin-left: 4px; }

.nam-rack-design-port .premium-tuner-stage {
  position: absolute;
  inset: clamp(28px, 4vh, 52px) clamp(42px, 5vw, 84px);
  z-index: 13;
  display: grid;
  grid-template-rows: minmax(0,1fr) 96px auto;
  align-items: center;
  gap: clamp(15px, 2.2vh, 25px);
  padding: clamp(24px, 3.2vh, 42px) clamp(34px, 4vw, 66px);
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 12px;
  background: radial-gradient(circle at 50% 43%, rgba(224,161,73,.14), transparent 42%), rgba(8,10,13,.9);
  box-shadow: 0 30px 80px rgba(0,0,0,.5), inset 0 1px rgba(255,255,255,.035);
}
.nam-rack-design-port .premium-tuner-stage-close {
  position: absolute;
  top: 18px;
  right: 18px;
  z-index: 3;
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 13px;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 5px;
  color: #aeb4bd;
  background: rgba(20,24,29,.92);
  font-size: 10px;
  font-weight: 700;
}
.nam-rack-design-port .premium-tuner-stage-close svg { width: 16px; height: 16px; }
.nam-rack-design-port .premium-tuner-stage-close:hover { color: #fff; border-color: rgba(224,161,73,.45); }
.nam-rack-design-port .premium-tuner-stage-copy { display: grid; place-items: center; align-content: center; }
.nam-rack-design-port .premium-tuner-stage-copy > span { color: #777f8a; font-size: 11px; font-weight: 760; letter-spacing: .14em; text-transform: uppercase; }
.nam-rack-design-port .premium-tuner-stage-copy > strong { color: #4e5660; font-size: clamp(88px, 11vw, 154px); font-weight: 690; letter-spacing: -.07em; line-height: .92; text-shadow: 0 0 42px rgba(224,161,73,.12); }
.nam-rack-design-port .premium-tuner-stage[data-signal="true"] .premium-tuner-stage-copy > strong { color: #ffc36c; text-shadow: 0 0 48px rgba(224,161,73,.26); }
.nam-rack-design-port .premium-tuner-stage-copy > b { margin-top: 8px; color: #a5abb3; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; }
.nam-rack-design-port .premium-tuner-stage-copy > em { margin-top: 7px; color: #f0f1f2; font-size: 19px; font-style: normal; font-weight: 740; }
.nam-rack-design-port .premium-tuner-scale { position: relative; height: 96px; }
.nam-rack-design-port .premium-tuner-scale::before { content: ""; position: absolute; left: 0; right: 0; top: 43px; height: 2px; background: #303640; }
.nam-rack-design-port .premium-tuner-scale-ticks { position: absolute; inset: 18px 0 30px; display: grid; grid-template-columns: repeat(21, 1fr); align-items: end; }
.nam-rack-design-port .premium-tuner-scale-ticks i { width: 1px; height: 16px; justify-self: center; background: #414852; }
.nam-rack-design-port .premium-tuner-scale-ticks i[data-major="true"] { height: 27px; background: #69717c; }
.nam-rack-design-port .premium-tuner-needle { position: absolute; left: var(--premium-tuner-pct); top: 8px; width: 3px; height: 55px; transform: translateX(-50%); border-radius: 2px; background: #ffc36c; box-shadow: 0 0 16px rgba(255,195,108,.8); transition: left 90ms linear; }
.nam-rack-design-port .premium-tuner-scale-labels { position: absolute; left: 0; right: 0; bottom: 0; display: grid; grid-template-columns: repeat(3,1fr); color: #747c87; font-size: 10px; }
.nam-rack-design-port .premium-tuner-scale-labels span:nth-child(2) { text-align: center; }
.nam-rack-design-port .premium-tuner-scale-labels span:last-child { text-align: right; }
.nam-rack-design-port .premium-tuner-stage-readouts { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; }
.nam-rack-design-port .premium-tuner-stage-readouts article { display: grid; gap: 5px; padding: 11px; border: 1px solid rgba(255,255,255,.08); border-radius: 5px; background: rgba(255,255,255,.018); text-align: center; }
.nam-rack-design-port .premium-tuner-stage-readouts span { color: #717985; font-size: 10px; }
.nam-rack-design-port .premium-tuner-stage-readouts strong { color: #e9ebee; font-size: 13px; }
.nam-rack-design-port .premium-tuner-drawer { grid-template-rows: auto minmax(0,1fr) auto auto; }
.nam-rack-design-port .premium-tuner-side-status { display: grid; place-items: center; align-content: center; gap: 9px; min-height: 0; padding: 22px 16px; border: 1px solid rgba(255,255,255,.08); border-radius: 7px; background: rgba(0,0,0,.23); text-align: center; }
.nam-rack-design-port .premium-tuner-side-status svg { width: 27px; height: 27px; color: var(--premium-accent); }
.nam-rack-design-port .premium-tuner-side-status span { color: #858d98; font-size: 11px; }
.nam-rack-design-port .premium-tuner-side-status strong { color: #eef0f2; font-size: 17px; }
.nam-rack-design-port .premium-tuner-side-status p { max-width: 210px; margin: 8px 0 0; color: #676f7a; font-size: 11px; line-height: 1.55; }
.nam-rack-design-port .premium-tuner-reference { height: 38px; display: flex; align-items: center; justify-content: space-between; padding: 0 11px; border-top: 1px solid rgba(255,255,255,.08); color: #737b86; font-size: 10px; }
.nam-rack-design-port .premium-tuner-reference strong { color: #d9dce0; font-size: 11px; }

@media (max-width: 1400px) {
  .nam-rack-design-port .premium-nam-shell { grid-template-rows: 174px 60px minmax(0,1fr) 48px; }
  .nam-rack-design-port .global-strip { grid-template-columns: minmax(286px,310px) minmax(430px,720px) minmax(112px,132px); gap: 13px; padding: 14px 20px 13px; }
  .nam-rack-design-port .premium-brand { left: 22px; top: 14px; }
  .nam-rack-design-port .premium-brand > strong { font-size: 21px; }
  .nam-rack-design-port .premium-calibration-launch { left: 153px; }
  .nam-rack-design-port .global-block { gap: 12px; padding-top: 47px; }
  .nam-rack-design-port .mini-param { width: 63px; height: 102px; grid-template-rows: 15px 62px 20px; }
  .nam-rack-design-port .mini-param > .asset-control { top: 48px !important; width: 53px !important; height: 53px !important; }
  .nam-rack-design-port .mini-param > .knob-position-indicator { top: 48px !important; width: 53px !important; }
  .nam-rack-design-port .premium-level-meter { width: 27px; height: 96px; flex-basis: 27px; }
  .nam-rack-design-port .preset-area { padding-bottom: 14px; }
  .nam-rack-design-port .preset-console { height: 70px; grid-template-columns: 42px minmax(180px,1fr) 42px 50px 68px; }
  .nam-rack-design-port .preset-title b { font-size: 19px; }
  .nam-rack-design-port .top-nav { grid-template-columns: repeat(5,minmax(100px,150px)); gap: 10px; padding-inline: 20px; }
  .nam-rack-design-port .nav-item { grid-template-columns: 25px auto; gap: 9px; font-size: 12px !important; }
  .nam-rack-design-port .premium-nav-icon,
  .nam-rack-design-port .premium-nav-icon svg { width: 23px; height: 23px; }
  .nam-rack-design-port .hardware-stage { grid-template-columns: minmax(0,1fr) 276px; }
  .nam-rack-design-port .premium-rig-drawer { padding: 14px 12px 11px; gap: 7px; }
  .nam-rack-design-port .premium-rig-card { min-height: 66px; grid-template-columns: 58px minmax(0,1fr) 4px; padding-block: 7px; }
  .nam-rack-design-port .premium-rig-thumb { width: 58px; height: 43px; }
  .nam-rack-design-port .footer { padding-inline: 18px; }
}
@media (max-width: 1240px) {
  .nam-rack-design-port .premium-nam-shell { grid-template-rows: 156px 54px minmax(0,1fr) 46px; }
  .nam-rack-design-port .global-strip { grid-template-columns: minmax(244px,268px) minmax(370px,1fr) 80px; gap: 9px; padding: 12px 15px 10px; }
  .nam-rack-design-port .premium-brand { left: 17px; top: 11px; }
  .nam-rack-design-port .premium-brand > strong { font-size: 20px; }
  .nam-rack-design-port .premium-calibration-launch { left: 145px; }
  .nam-rack-design-port .global-block { gap: 7px; padding-top: 42px; }
  .nam-rack-design-port .mini-param { width: 56px; height: 92px; grid-template-rows: 14px 55px 19px; }
  .nam-rack-design-port .mini-param > .asset-control { top: 43px !important; width: 47px !important; height: 47px !important; }
  .nam-rack-design-port .mini-param > .knob-position-indicator { top: 43px !important; width: 47px !important; }
  .nam-rack-design-port .premium-level-meter { width: 24px; height: 86px; flex-basis: 24px; }
  .nam-rack-design-port .preset-area { padding-bottom: 10px; }
  .nam-rack-design-port .preset-console { height: 66px; grid-template-columns: 36px minmax(160px,1fr) 36px 44px 58px; }
  .nam-rack-design-port .preset-title b { font-size: 17px; }
  .nam-rack-design-port .premium-compare { padding-inline: 5px !important; }
  .nam-rack-design-port .hardware-stage { grid-template-columns: minmax(0,1fr) 252px; }
}
@media (max-width: 1030px) {
  .nam-rack-design-port .premium-nam-shell { grid-template-rows: 144px 52px minmax(0,1fr) 46px; }
  .nam-rack-design-port .global-strip { grid-template-columns: 220px minmax(310px,1fr) 84px; gap: 7px; padding: 10px 12px 9px; }
  .nam-rack-design-port .premium-brand > span { font-size: 9px; }
  .nam-rack-design-port .premium-brand > strong { font-size: 18px; }
  .nam-rack-design-port .premium-calibration-launch { left: 132px; top: 0; }
  .nam-rack-design-port .global-block { padding-top: 37px; }
  .nam-rack-design-port .global-block.left { gap: 5px; }
  .nam-rack-design-port .global-block.left .premium-level-meter { display: block; }
  .nam-rack-design-port .global-block.left .mini-param { width: 55px; }
  .nam-rack-design-port .global-block.right .mini-param { width: 50px; }
  .nam-rack-design-port .global-block.right .premium-level-meter { display: block; }
  .nam-rack-design-port .mini-param { height: 86px; grid-template-rows: 13px 51px 18px; }
  .nam-rack-design-port .mini-param > .asset-control { top: 39px !important; width: 44px !important; height: 44px !important; }
  .nam-rack-design-port .mini-param > .knob-position-indicator { top: 39px !important; width: 44px !important; }
  .nam-rack-design-port .mini-param .global-label { font-size: 9px !important; }
  .nam-rack-design-port .mini-param strong { font-size: 10px; }
  .nam-rack-design-port .preset-area {
    grid-template-columns: minmax(0,1fr) 42px;
    gap: 6px;
    padding-bottom: 8px;
  }
  .nam-rack-design-port .preset-console {
    grid-column: 1;
    grid-row: 1;
    height: 61px;
    grid-template-columns: 32px minmax(135px,1fr) 32px 42px 50px;
  }
  .nam-rack-design-port .preset-title { padding: 0 8px; }
  .nam-rack-design-port .preset-title b { font-size: 16px; }
  .nam-rack-design-port .tone-library-mark {
    grid-column: 2;
    grid-row: 1;
    align-self: stretch;
    justify-self: stretch;
    min-width: 42px;
    width: 42px;
    height: 61px;
    display: inline-flex !important;
    justify-content: center;
    margin: 0;
    padding: 0;
    overflow: hidden;
    color: transparent;
    font-size: 0 !important;
  }
  .nam-rack-design-port .tone-library-mark svg {
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    color: #dca257;
  }
  .nam-rack-design-port .top-nav { grid-template-columns: repeat(5,minmax(78px,120px)); gap: 6px; padding: 0 14px; }
  .nam-rack-design-port .nav-item { grid-template-columns: 20px auto 5px; gap: 7px; font-size: 11px !important; }
  .nam-rack-design-port .premium-nav-icon,
  .nam-rack-design-port .premium-nav-icon svg { width: 18px; height: 18px; }
  .nam-rack-design-port .hardware-stage,
  .nam-rack-design-port .hardware-stage:has(.premium-tuner-drawer) { grid-template-columns: minmax(0,1fr); }
  .nam-rack-design-port .premium-rig-drawer,
  .nam-rack-design-port .premium-tuner-drawer { display: none !important; }
  .nam-rack-design-port .premium-tuner-stage { inset: 24px 42px; }
}
@media (max-width: 780px) {
  .nam-rack-design-port .premium-nam-shell { grid-template-rows: 126px 48px minmax(0,1fr) 48px; }
  .nam-rack-design-port .global-strip { grid-template-columns: 96px minmax(150px,.8fr) minmax(235px,1.45fr) 58px; padding: 9px; }
  .nam-rack-design-port .premium-calibration-launch { display: none; }
  .nam-rack-design-port .global-block.left .premium-level-meter { display: block; }
  .nam-rack-design-port .global-block.left .mini-param:nth-of-type(n+3) { display: none; }
  .nam-rack-design-port .global-block.right { display: flex; }
  .nam-rack-design-port .global-block.right .premium-level-meter { display: none; }
  .nam-rack-design-port .preset-context { display: none; }
  .nam-rack-design-port .preset-area { grid-template-rows: 1fr; }
  .nam-rack-design-port .preset-console { grid-row: 1; }
  .nam-rack-design-port .tone-library-mark { display: none !important; }
  .nam-rack-design-port .preset-console { grid-template-columns: 30px minmax(110px,1fr) 30px 38px 40px; }
  .nam-rack-design-port .preset-console .preset-save span { display: none; }
  .nam-rack-design-port .top-nav { grid-template-columns: repeat(5,minmax(52px,1fr)); }
  .nam-rack-design-port .nav-item { grid-template-columns: 16px auto; gap: 4px; font-size: 9px !important; }
  .nam-rack-design-port .nav-item > i,
  .nam-rack-design-port .nav-flow-chevron { display: none; }
  .nam-rack-design-port .premium-nav-icon,
  .nam-rack-design-port .premium-nav-icon svg { width: 15px; height: 15px; }
  .nam-rack-design-port .premium-tuner-stage { inset: 18px; padding: 22px; grid-template-rows: minmax(0,1fr) 72px auto; }
  .nam-rack-design-port .premium-tuner-stage-readouts { grid-template-columns: repeat(2,1fr); }
}

/* Tone Library v2: selected hardware is the focal point; browsing is a real,
   compact tool rail. Every visible control below is wired to NAMExplorer. */
.nam-rack-source-flow-design-port .source-flow-workspace {
  background:
    radial-gradient(ellipse at 38% 26%, rgba(225,153,66,.13), transparent 34%),
    linear-gradient(90deg, rgba(0,0,0,.42), transparent 16% 84%, rgba(0,0,0,.48)),
    var(--nam-studio-backdrop) center / cover no-repeat !important;
}
.nam-rack-source-flow-design-port .preset-console > button:disabled {
  visibility: visible;
}
.nam-rack-source-flow-design-port .source-flow-workspace .tone-source-v2 {
  inset: clamp(11px, 1.5vh, 18px) clamp(12px, 1.2vw, 20px) clamp(10px, 1.4vh, 16px);
  display: grid;
  grid-template: 58px minmax(0,1fr) / minmax(0,1fr);
  gap: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 10px;
  color: #e8eaed;
  background: rgba(9,11,14,.9);
  box-shadow: 0 26px 70px rgba(0,0,0,.48), inset 0 1px rgba(255,255,255,.03);
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-source-header {
  grid-column: 1;
  grid-row: 1;
  display: grid;
  grid-template-columns: auto minmax(0,1fr) auto;
  gap: 15px;
  padding: 0 16px;
  border: 0 !important;
  border-bottom: 1px solid rgba(255,255,255,.08) !important;
  border-radius: 0 !important;
  background: linear-gradient(180deg, rgba(26,30,36,.98), rgba(15,18,23,.98)) !important;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-return-button {
  min-height: 36px !important;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-radius: 5px;
  font-size: 11px !important;
  letter-spacing: .02em;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-return-button svg { width: 15px; height: 15px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-breadcrumb { display: flex; align-items: baseline; gap: 10px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-breadcrumb span {
  flex: 0 1 auto;
  color: #747c87;
  font-size: 10px !important;
  letter-spacing: .09em;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-breadcrumb b {
  overflow: hidden;
  color: #f2f3f4;
  font-size: 17px !important;
  font-weight: 730;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-connection-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #a3a9b1;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-connection-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6d737c;
  box-shadow: 0 0 0 3px rgba(109,115,124,.12);
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-connection-state[data-auth="connected"] i { background: #75c58a; box-shadow: 0 0 0 3px rgba(117,197,138,.13); }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-connection-state[data-auth="offline"] i { background: #c46f65; box-shadow: 0 0 0 3px rgba(196,111,101,.13); }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-connection-state[data-auth="warning"] { color: #dca45a; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-connection-state[data-auth="warning"] i { background: #dca45a; box-shadow: 0 0 0 3px rgba(220,164,90,.14); }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-connection-state span { color: inherit; font-size: 11px !important; font-weight: 680; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-connection-state button {
  min-height: 27px !important;
  padding: 0 9px;
  border-color: currentColor;
  border-radius: 4px;
  color: inherit;
  background: rgba(255,255,255,.035);
  font-size: 9px !important;
  font-weight: 760;
}
.nam-rack-source-flow-design-port .tone-source-v2-workspace {
  grid-column: 1;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0,1fr) clamp(330px, 25vw, 382px);
  overflow: hidden;
}
.nam-rack-source-flow-design-port .tone-selected-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(210px,1fr) auto auto auto;
  gap: 10px;
  padding: clamp(17px, 2vw, 28px);
  overflow: hidden;
  background:
    radial-gradient(ellipse at 50% 38%, rgba(229,156,71,.14), transparent 40%),
    linear-gradient(180deg, rgba(8,10,13,.18), rgba(7,8,10,.86));
}
.nam-rack-source-flow-design-port .tone-selected-stage::after {
  content: "";
  position: absolute;
  left: 8%;
  right: 8%;
  top: 50%;
  height: 24%;
  z-index: 0;
  border-radius: 50%;
  background: rgba(0,0,0,.68);
  filter: blur(28px);
  pointer-events: none;
}
.nam-rack-source-flow-design-port .tone-selected-visual {
  position: relative;
  z-index: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px;
  background: radial-gradient(circle at 50% 45%, rgba(225,157,74,.13), transparent 48%), #090b0e;
  box-shadow: 0 22px 50px rgba(0,0,0,.38), inset 0 1px rgba(255,255,255,.025);
}
.nam-rack-source-flow-design-port .tone-selected-visual > img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  filter: brightness(.9) saturate(.92) contrast(1.04);
  transform: scale(1.015);
}
.nam-rack-source-flow-design-port .tone-selected-visual-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(5,7,9,.87) 0, rgba(5,7,9,.5) 38%, rgba(5,7,9,.05) 72%), linear-gradient(0deg, rgba(5,7,9,.82), transparent 58%);
}
.nam-rack-source-flow-design-port .tone-selected-identity {
  position: absolute;
  left: clamp(20px, 2.5vw, 38px);
  right: clamp(20px, 3vw, 48px);
  bottom: clamp(18px, 2.4vh, 30px);
  z-index: 2;
  display: grid;
  gap: 6px;
}
.nam-rack-source-flow-design-port .tone-selected-identity > span {
  color: #d89a48;
  font-size: 10px !important;
  font-weight: 780;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.nam-rack-source-flow-design-port .tone-selected-identity h1 {
  max-width: 820px;
  margin: 0;
  overflow: hidden;
  color: #fafafa;
  font-size: clamp(24px, 2.35vw, 38px);
  font-weight: 740;
  letter-spacing: -.035em;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 3px 14px rgba(0,0,0,.62);
}
.nam-rack-source-flow-design-port .tone-selected-identity p {
  max-width: 780px;
  margin: 0;
  overflow: hidden;
  color: #b9bec5;
  font-size: 13px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-source-flow-design-port .tone-selected-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.nam-rack-source-flow-design-port .tone-selected-chips i {
  padding: 4px 8px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 999px;
  color: #d8dadd;
  background: rgba(9,11,14,.66);
  font-size: 10px;
  font-style: normal;
  font-weight: 660;
}
.nam-rack-source-flow-design-port .tone-selected-info {
  position: relative;
  z-index: 2;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 28px;
}
.nam-rack-source-flow-design-port .tone-selected-meta,
.nam-rack-source-flow-design-port .tone-selected-stats { min-width: 0; display: flex; flex-wrap: wrap; gap: 7px 14px; }
.nam-rack-source-flow-design-port .tone-selected-meta span,
.nam-rack-source-flow-design-port .tone-selected-stats span { color: #858c96; font-size: 10px; white-space: nowrap; }
.nam-rack-source-flow-design-port .tone-selected-stats { flex: none; }
.nam-rack-source-flow-design-port .tone-action-grid {
  position: relative;
  z-index: 2;
  width: 100%;
  display: grid;
  gap: 8px !important;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-action-grid button {
  min-width: 118px;
  min-height: 40px !important;
  padding: 0 16px;
  border-radius: 5px;
  color: #c7cbd1;
  background: linear-gradient(180deg, #1b1f26, #111419);
  font-size: 11px !important;
  font-weight: 730;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-action-grid button[data-primary="true"] {
  border-color: #dea04d;
  color: #211407;
  background: linear-gradient(180deg, #f2b960, #c98231);
  box-shadow: 0 7px 18px rgba(205,132,48,.18), inset 0 1px rgba(255,255,255,.24);
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-action-grid button:disabled {
  cursor: default;
  opacity: .38;
  box-shadow: none;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-audition-status {
  position: relative;
  z-index: 2;
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0,1fr);
  gap: 2px 10px;
  padding: 8px 11px;
  border: 1px solid rgba(255,255,255,.075) !important;
  border-radius: 5px !important;
  background: rgba(14,17,21,.82) !important;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-audition-status span { color: #d79a49; font-size: 9px !important; font-weight: 760; letter-spacing: .08em; text-transform: uppercase; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-audition-status b { overflow: hidden; color: #d9dce0; font-size: 10px !important; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-audition-status em { grid-column: 2; overflow: hidden; color: #747c86; font-size: 9px !important; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-library-panel {
  position: relative;
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto 40px 35px 34px minmax(0,1fr) auto;
  gap: 9px;
  padding: 17px 14px 14px;
  overflow: hidden;
  border: 0 !important;
  border-left: 1px solid rgba(255,255,255,.08) !important;
  border-radius: 0 !important;
  background: linear-gradient(90deg, #11151a, #0c0f13) !important;
  box-shadow: -20px 0 54px rgba(0,0,0,.28);
}
.nam-rack-source-flow-design-port .tone-compact-selection { display: none; }
.nam-rack-source-flow-design-port .tone-library-heading { min-width: 0; display: flex; justify-content: space-between; gap: 12px; }
.nam-rack-source-flow-design-port .tone-library-heading > div { min-width: 0; display: grid; gap: 3px; }
.nam-rack-source-flow-design-port .tone-library-heading span { color: #d99b49; font-size: 9px; font-weight: 780; letter-spacing: .13em; text-transform: uppercase; }
.nam-rack-source-flow-design-port .tone-library-heading strong { overflow: hidden; color: #f0f1f2; font-size: 16px; font-weight: 710; text-overflow: ellipsis; white-space: nowrap; }
.nam-rack-source-flow-design-port .tone-library-heading em { flex: none; padding-top: 3px; color: #707883; font-size: 10px; font-style: normal; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-search-panel {
  min-width: 0;
  display: grid;
  grid-template-columns: 17px minmax(0,1fr) 33px;
  align-items: center;
  gap: 7px;
  padding: 0 4px 0 11px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 5px;
  background: #090c10;
}
.nam-rack-source-flow-design-port .tone-search-panel > svg { width: 15px; height: 15px; color: #656d77; }
.nam-rack-source-flow-design-port .tone-search-panel input {
  min-width: 0;
  height: 36px;
  border: 0;
  outline: 0;
  color: #e4e6e9;
  background: transparent;
  font: inherit;
  font-size: 11px;
}
.nam-rack-source-flow-design-port .tone-search-panel input::placeholder { color: #646c76; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-search-panel button {
  min-width: 31px;
  min-height: 31px !important;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
}
.nam-rack-source-flow-design-port .tone-search-panel button svg { width: 15px; height: 15px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-tab-row { min-width: 0; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-tab-row button {
  min-width: 0;
  min-height: 33px !important;
  padding: 0 5px;
  border-color: transparent;
  border-radius: 4px;
  color: #767e89;
  background: transparent;
  font-size: 10px !important;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-tab-row button[data-active="true"] {
  border-color: rgba(224,161,73,.26);
  color: #edb564;
  background: rgba(224,161,73,.075);
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-filter-row {
  min-width: 0;
  display: flex;
  gap: 6px;
}
.nam-rack-source-flow-design-port .tone-filter-row select {
  min-width: 0;
  height: 32px;
  flex: 1 1 0;
  padding: 0 24px 0 8px;
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 4px;
  outline: 0;
  color: #aeb4bc;
  background: #11151a;
  font-size: 9px;
}
.nam-rack-source-flow-design-port .tone-arch-filter { flex: none; display: flex; gap: 3px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-arch-filter button {
  min-width: 31px;
  min-height: 32px !important;
  padding: 0 5px;
  font-size: 9px !important;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-list {
  min-height: 0;
  display: grid;
  grid-auto-rows: minmax(76px, auto);
  align-content: start;
  gap: 7px;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 3px;
  padding-bottom: 18px;
  -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%);
  scrollbar-color: #343a43 transparent;
  scrollbar-width: thin;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-list::-webkit-scrollbar { width: 5px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-list::-webkit-scrollbar-thumb { border-radius: 999px; background: #343a43; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-list::-webkit-scrollbar-track { background: transparent; }
.nam-rack-source-flow-design-port .tone-library-pager {
  position: relative;
  z-index: 6;
  min-width: 0;
  display: grid;
  grid-template-columns: 30px minmax(72px,1fr) 30px auto;
  align-items: center;
  gap: 5px;
  padding-top: 7px;
  border-top: 1px solid rgba(255,255,255,.075);
}
.nam-rack-source-flow-design-port .tone-library-pager span {
  overflow: hidden;
  color: #858d97;
  font-size: 9px;
  font-weight: 650;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-library-pager button {
  min-width: 30px;
  min-height: 28px !important;
  display: grid;
  place-items: center;
  padding: 0 7px;
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 4px;
  color: #aeb4bc;
  background: #11151a;
  font-size: 9px !important;
}
.nam-rack-source-flow-design-port .tone-library-pager button:disabled { opacity: .35; cursor: default; }
.nam-rack-source-flow-design-port .tone-library-pager button:not(:disabled):hover {
  border-color: rgba(224,161,73,.45);
  color: #efb766;
  background: #171b21;
}
.nam-rack-source-flow-design-port .tone-library-pager button svg { width: 13px; height: 13px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-library-pager .tone-library-load-more {
  min-width: 70px;
  color: #e4b063;
  border-color: rgba(224,161,73,.28);
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-library-panel::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 24px;
  z-index: 4;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, rgba(10,13,17,.96));
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-row {
  min-width: 0;
  min-height: 76px;
  display: grid;
  grid-template-columns: 82px minmax(0,1fr) 70px;
  gap: 10px;
  align-items: center;
  padding: 7px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.075);
  border-radius: 5px;
  color: #d7dade;
  background: rgba(9,12,16,.92);
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-row:hover { border-color: rgba(224,161,73,.32); background: #12161b; transform: translateY(-1px); }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-row[data-active="true"] { border-color: rgba(224,161,73,.68); background: linear-gradient(90deg, rgba(224,161,73,.12), rgba(255,255,255,.018)); box-shadow: inset 3px 0 #dfa04d; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-select-target,
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-select-target:hover {
  border: 0 !important;
  background: transparent !important;
}
.nam-rack-source-flow-design-port .tone-row-art {
  width: 82px;
  height: 55px;
  overflow: hidden;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: #06080a;
}
.nam-rack-source-flow-design-port .tone-row-art img { width: 100%; height: 100%; display: block; object-fit: cover; filter: brightness(.83) saturate(.86); }
.nam-rack-source-flow-design-port .tone-row-art > span { color: #9e722f; font-size: 18px; font-weight: 800; }
.nam-rack-source-flow-design-port .tone-row-main { min-width: 0; display: grid; gap: 4px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-main strong { overflow: hidden; color: #eef0f2; font-size: 12px !important; font-weight: 690; text-overflow: ellipsis; white-space: nowrap; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-main > span { overflow: hidden; color: #747c87; font-size: 9px !important; text-overflow: ellipsis; white-space: nowrap; }
.nam-rack-source-flow-design-port .tone-row-tags { min-width: 0; display: flex; gap: 4px; overflow: hidden; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-tags i { overflow: hidden; padding: 2px 5px; border-radius: 999px; color: #949ba5; background: rgba(255,255,255,.05); font-size: 8px !important; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-stats {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: visible;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-stats span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #858d98;
  font-size: 8px !important;
  font-variant-numeric: tabular-nums;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-stats svg {
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  color: #c68b3e;
}
.nam-rack-source-flow-design-port .tone-row-side { min-width: 0; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-favorite,
.nam-rack-source-flow-design-port .tone-row-favorite-spacer {
  width: 24px;
  min-width: 24px;
  min-height: 24px !important;
  display: grid;
  place-items: center;
  justify-self: end;
  padding: 0;
  border: 0;
  color: #747c87;
  background: transparent;
  font-size: 17px !important;
}
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-favorite[data-active="true"] { color: #edb058; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-side > em { overflow: hidden; color: #717984; font-size: 8px !important; font-style: normal; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-row-action {
  grid-column: 1 / -1;
  min-width: 0;
  min-height: 27px !important;
  padding: 0 6px;
  border-radius: 4px;
  color: #d5d8dc;
  background: #191e24;
  font-size: 8px !important;
}
.nam-rack-source-flow-design-port .tone-feed-empty { min-height: 210px; display: grid; place-items: center; align-content: center; gap: 9px; padding: 24px; border: 1px dashed rgba(255,255,255,.09); border-radius: 6px; text-align: center; }
.nam-rack-source-flow-design-port .tone-feed-empty strong { color: #e6e8ea; font-size: 14px; }
.nam-rack-source-flow-design-port .tone-feed-empty p { max-width: 270px; margin: 0; color: #747c86; font-size: 11px; line-height: 1.5; }
.nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-empty button { min-height: 34px !important; padding: 0 12px; font-size: 10px !important; }
.nam-rack-source-flow-design-port .tone-feed-skeleton { height: 76px; border-radius: 5px; background: linear-gradient(100deg, #11151a 10%, #1b2027 30%, #11151a 50%); background-size: 220% 100%; animation: tone-library-shimmer 1.3s linear infinite; }
@keyframes tone-library-shimmer { to { background-position-x: -220%; } }

@media (max-width: 1120px) {
  .nam-rack-source-flow-design-port .nav-item:disabled { color: #737c87; opacity: .68; }
  .nam-rack-source-flow-design-port .tone-source-v2-workspace { grid-template-columns: minmax(0,1fr) 305px; }
  .nam-rack-source-flow-design-port .tone-source-v2 .tone-library-panel { padding-left: 11px; padding-right: 11px; }
  .nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-row { grid-template-columns: 66px minmax(0,1fr) 62px; gap: 8px; }
  .nam-rack-source-flow-design-port .tone-row-art { width: 66px; height: 49px; }
  .nam-rack-source-flow-design-port .tone-selected-stats { display: none; }
  .nam-rack-source-flow-design-port .tone-row-side > em { display: none; }
  .nam-rack-source-flow-design-port .tone-action-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .nam-rack-source-flow-design-port .tone-source-v2 .tone-action-grid button { min-width: 0; padding-inline: 8px; }
  .nam-rack-source-flow-design-port .tone-feed-empty {
    min-height: 146px;
    gap: 6px;
    padding: 13px 11px;
  }
  .nam-rack-source-flow-design-port .tone-source-v2 .tone-feed-empty button { min-height: 30px !important; }
  .nam-rack-source-flow-design-port .tone-feed-list:has(.tone-feed-empty) {
    padding-bottom: 0;
    -webkit-mask-image: none;
    mask-image: none;
  }
  .nam-rack-source-flow-design-port .tone-library-panel:has(.tone-feed-empty)::after { display: none; }
}
@media (max-width: 960px) {
  .nam-rack-source-flow-design-port .tone-source-v2-workspace { grid-template-columns: minmax(0,1fr); }
  .nam-rack-source-flow-design-port .tone-selected-stage { display: none; }
  .nam-rack-source-flow-design-port .tone-source-v2 .tone-library-panel {
    grid-column: 1;
    grid-template-rows: auto 40px 35px 34px auto minmax(0,1fr) auto;
    border-left: 0 !important;
  }
  .nam-rack-source-flow-design-port .tone-compact-selection {
    min-width: 0;
    min-height: 44px;
    display: grid;
    grid-template-columns: minmax(116px,1fr) minmax(0,70vw);
    align-items: center;
    gap: 9px;
    padding: 5px 7px;
    border: 1px solid rgba(224,161,73,.2);
    border-radius: 5px;
    background: linear-gradient(90deg, rgba(224,161,73,.075), rgba(255,255,255,.018));
  }
  .nam-rack-source-flow-design-port .tone-compact-selection-copy { min-width: 0; display: grid; gap: 2px; }
  .nam-rack-source-flow-design-port .tone-compact-selection-copy span { color: #b47c37; font-size: 7px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .nam-rack-source-flow-design-port .tone-compact-selection-copy strong { overflow: hidden; color: #e8e9eb; font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .nam-rack-source-flow-design-port .tone-compact-selection .tone-action-grid { width: min(620px,70vw); max-width: none !important; gap: 5px !important; }
  .nam-rack-source-flow-design-port .tone-source-v2 .tone-compact-selection .tone-action-grid button { min-width: 0; min-height: 32px !important; padding: 0 6px; font-size: 8px !important; white-space: nowrap; }
  .nam-rack-source-flow-design-port .tone-source-v2 .tone-breadcrumb span { display: none; }
}

.nam-rack-design-port .premium-asset-recovery {
  position: absolute;
  left: clamp(14px, 2vw, 28px);
  right: clamp(14px, 2vw, 28px);
  top: clamp(12px, 1.8vh, 20px);
  z-index: 92;
  min-height: 64px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  padding: 10px 10px 10px 12px;
  overflow: hidden;
  border: 1px solid rgba(239,101,86,.38);
  border-radius: 7px;
  color: #eadfdb;
  background:
    linear-gradient(90deg, rgba(107,35,29,.23), transparent 38%),
    rgba(9,11,14,.94);
  box-shadow: 0 16px 38px rgba(0,0,0,.44), inset 3px 0 #d96858;
  backdrop-filter: blur(12px);
}
.nam-rack-design-port .premium-asset-recovery[data-bypassed="true"] {
  border-color: rgba(224,161,73,.32);
  background:
    linear-gradient(90deg, rgba(118,75,28,.2), transparent 38%),
    rgba(9,11,14,.94);
  box-shadow: 0 16px 38px rgba(0,0,0,.44), inset 3px 0 #dca04f;
}
.nam-rack-design-port .premium-asset-recovery-icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(239,101,86,.26);
  border-radius: 50%;
  color: #ef8a7d;
  background: rgba(239,101,86,.09);
}
.nam-rack-design-port .premium-asset-recovery-icon svg { width: 15px; height: 15px; }
.nam-rack-design-port .premium-asset-recovery-copy {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
}
.nam-rack-design-port .premium-asset-recovery-copy small {
  grid-column: 1 / -1;
  color: #df8378;
  font-size: 10px;
  font-weight: 780;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.nam-rack-design-port .premium-asset-recovery-copy strong {
  min-width: 0;
  overflow: hidden;
  color: #f0e9e6;
  font-size: 13px;
  font-weight: 690;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .premium-asset-recovery-copy em {
  overflow: hidden;
  color: #888f99;
  font-size: 10.5px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .premium-asset-recovery-actions {
  display: flex;
  align-items: center;
  gap: 5px;
}
.nam-rack-design-port .premium-asset-recovery-actions button {
  min-width: 74px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 4px;
  color: #cbd0d6;
  background: #171b20;
  font-size: 10.5px;
  font-weight: 700;
  cursor: pointer;
}
.nam-rack-design-port .premium-asset-recovery-actions button:first-child {
  border-color: rgba(224,161,73,.44);
  color: #f3c17a;
  background: rgba(224,161,73,.1);
}
.nam-rack-design-port .premium-asset-recovery-actions button:hover:not(:disabled),
.nam-rack-design-port .premium-asset-recovery-actions button:focus-visible {
  border-color: rgba(255,208,126,.7);
  outline: 1px solid rgba(255,208,126,.45);
  outline-offset: 1px;
  color: #fff2d9;
}
.nam-rack-design-port .premium-asset-recovery-actions button:disabled { cursor: default; opacity: .46; }
.nam-rack-design-port .premium-asset-recovery-actions svg { width: 12px; height: 12px; }

/* Hardware interaction feedback and faceplate hierarchy. These rules live last
   in the design sheet so the physical states are not washed out by older skin
   filters higher in the cascade. */
.nam-rack-design-port .control-hit {
  border-radius: 999px;
  outline: none;
}
.nam-rack-design-port .control-hit.interactive:focus-visible {
  outline: 2px solid rgba(244, 183, 91, .96);
  outline-offset: -2px;
  box-shadow:
    0 0 0 2px rgba(6, 8, 10, .82),
    0 0 0 5px rgba(224, 161, 73, .22),
    0 0 14px rgba(224, 161, 73, .24);
}
.nam-rack-design-port .control-hit.disabled-feedback {
  cursor: help;
}
.nam-rack-design-port .control-hit.disabled-feedback:focus-visible {
  outline: 1px solid rgba(210, 169, 105, .8);
  outline-offset: -1px;
  box-shadow: 0 0 0 3px rgba(224, 161, 73, .14);
}
.nam-rack-design-port .control-value-popover {
  position: absolute;
  left: var(--x);
  top: var(--y);
  z-index: 90;
  min-width: 70px;
  max-width: 112px;
  display: grid;
  gap: 2px;
  padding: 5px 8px 6px;
  border: 1px solid rgba(239, 186, 104, .48);
  border-radius: 4px;
  opacity: 0;
  color: #f2f0ea;
  background:
    linear-gradient(180deg, rgba(35, 37, 39, .98), rgba(9, 11, 13, .98));
  box-shadow:
    inset 0 1px rgba(255,255,255,.07),
    0 8px 18px rgba(0,0,0,.52);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-align: center;
  pointer-events: none;
  visibility: hidden;
  transform: translate(-50%, calc(-100% - 9px)) scale(.96);
  transform-origin: 50% 100%;
  transition: opacity 90ms ease, transform 110ms ease, visibility 0s linear 110ms;
}
.nam-rack-design-port .control-value-popover[data-visible="true"] {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, calc(-100% - 9px)) scale(1);
  transition-delay: 0s;
}
.nam-rack-design-port .control-value-popover[data-placement="below"] {
  transform: translate(-50%, 9px) scale(.96);
  transform-origin: 50% 0;
}
.nam-rack-design-port .control-value-popover[data-placement="below"][data-visible="true"] {
  transform: translate(-50%, 9px) scale(1);
}
.nam-rack-design-port .control-value-popover[data-align="start"] {
  transform: translate(-14%, calc(-100% - 9px)) scale(.96);
  transform-origin: 14% 100%;
}
.nam-rack-design-port .control-value-popover[data-align="start"][data-visible="true"] {
  transform: translate(-14%, calc(-100% - 9px)) scale(1);
}
.nam-rack-design-port .control-value-popover[data-align="end"] {
  transform: translate(-86%, calc(-100% - 9px)) scale(.96);
  transform-origin: 86% 100%;
}
.nam-rack-design-port .control-value-popover[data-align="end"][data-visible="true"] {
  transform: translate(-86%, calc(-100% - 9px)) scale(1);
}
.nam-rack-design-port .control-value-popover[data-placement="below"][data-align="start"] {
  transform: translate(-14%, 9px) scale(.96);
  transform-origin: 14% 0;
}
.nam-rack-design-port .control-value-popover[data-placement="below"][data-align="start"][data-visible="true"] {
  transform: translate(-14%, 9px) scale(1);
}
.nam-rack-design-port .control-value-popover[data-placement="below"][data-align="end"] {
  transform: translate(-86%, 9px) scale(.96);
  transform-origin: 86% 0;
}
.nam-rack-design-port .control-value-popover[data-placement="below"][data-align="end"][data-visible="true"] {
  transform: translate(-86%, 9px) scale(1);
}
.nam-rack-design-port .control-value-popover small {
  overflow: hidden;
  color: #9da2a7;
  font-size: 7px;
  font-weight: 690;
  letter-spacing: .08em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.nam-rack-design-port .control-value-popover strong {
  overflow: hidden;
  color: #f4c77f;
  font-size: 10px;
  font-weight: 740;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nam-rack-design-port .control-value-popover[data-kind="reason"] {
  min-width: 98px;
  max-width: 118px;
  padding: 4px 6px 5px;
}
.nam-rack-design-port .control-value-popover[data-kind="reason"] small {
  display: none;
}
.nam-rack-design-port .control-value-popover[data-kind="reason"] strong {
  color: #d7c19d;
  font-size: 7.4px;
  line-height: 1.25;
  text-wrap: balance;
  white-space: normal;
}
.nam-rack-design-port .asset-control.led {
  opacity: 1;
  transition: opacity 130ms ease, filter 130ms ease;
}
.nam-rack-design-port .asset-control.led.off {
  opacity: .62;
  filter:
    grayscale(.72)
    saturate(.3)
    brightness(.5)
    contrast(1.12)
    drop-shadow(0 2px 2px rgba(0,0,0,.5));
}
.nam-rack-design-port .asset-control.led.on {
  opacity: 1;
  filter:
    saturate(1.12)
    brightness(1.14)
    contrast(1.05)
    drop-shadow(0 0 3px rgba(255,181,72,.88))
    drop-shadow(0 0 8px rgba(232,151,43,.48));
}
.nam-rack-design-port .primary-foot-state {
  min-width: 32px;
  padding: 1px 4px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 999px;
  color: #777d84 !important;
  background: rgba(4,6,7,.54);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-shadow: 0 1px 1px #000 !important;
}
.nam-rack-design-port .foot-action-label,
.nam-rack-design-port .delay-rack .foot-action-label {
  font-size: 7px !important;
  font-weight: 620 !important;
  letter-spacing: .045em;
}
.nam-rack-design-port .primary-foot-state {
  font-size: 6.25px !important;
  letter-spacing: .035em;
}
.nam-rack-design-port .module[data-module="modulator"] .mod-switch-label {
  color: rgba(226, 224, 218, .78);
  font-size: 7px !important;
  font-weight: 620 !important;
  letter-spacing: .035em;
  text-shadow: 0 1px 1px rgba(0, 0, 0, .45);
}
.nam-rack-design-port .module[data-module="modulator"] .mod-switch-state {
  color: #e6ad5b;
}
.nam-rack-design-port .three-way-toggle-labels {
  position: absolute;
  z-index: 17;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  width: 28%;
  transform: translate(-50%, -50%);
  color: rgba(232,225,213,.54);
  font-size: 5.5px;
  font-weight: 680;
  letter-spacing: .025em;
  line-height: 1;
  text-align: center;
  text-shadow: 0 1px 1px rgba(0,0,0,.72);
  pointer-events: none;
}
.nam-rack-design-port .three-way-toggle-labels span[data-active="true"] {
  color: #efbd72;
  text-shadow:
    0 1px 1px rgba(0,0,0,.78),
    0 0 5px rgba(224,161,73,.34);
}
.nam-rack-design-port .nam-rack-artboard[data-effects-disabled="true"] .module {
  filter: grayscale(.82) saturate(.24) brightness(.64);
  opacity: .52;
  transition: filter 150ms ease, opacity 150ms ease;
}
.nam-rack-design-port .nam-rack-artboard[data-effects-disabled="true"] .module .control-hit {
  pointer-events: none;
}
.nam-rack-design-port .nam-amp-required-callout {
  position: absolute;
  left: 50%;
  top: clamp(18px, 5.2vh, 44px);
  z-index: 26;
  min-width: min(340px, calc(100% - 48px));
  min-height: 56px;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 9px 18px;
  border: 1px solid rgba(224, 161, 73, .72);
  border-radius: 10px;
  color: #ecd7b6;
  background:
    linear-gradient(180deg, rgba(24, 25, 25, .97), rgba(10, 12, 14, .97));
  box-shadow:
    0 15px 42px rgba(0, 0, 0, .58),
    inset 0 1px rgba(255, 255, 255, .055);
  backdrop-filter: blur(10px);
  transform: translateX(-50%);
  cursor: pointer;
}
.nam-rack-design-port .nam-amp-required-callout:hover {
  border-color: rgba(244, 184, 92, .94);
  color: #f4dfbe;
  background:
    linear-gradient(180deg, rgba(35, 31, 24, .98), rgba(13, 14, 15, .98));
}
.nam-rack-design-port .nam-amp-required-callout:focus-visible {
  outline: 2px solid rgba(245, 185, 92, .94);
  outline-offset: 3px;
}
.nam-rack-design-port .nam-amp-required-callout:disabled {
  cursor: default;
}
.nam-rack-design-port .nam-amp-required-callout > svg {
  width: 25px;
  height: 25px;
  color: #e0a149;
  filter: drop-shadow(0 0 8px rgba(224, 161, 73, .18));
}
.nam-rack-design-port .nam-amp-required-callout > span {
  min-width: 0;
  display: grid;
  gap: 2px;
  text-align: left;
}
.nam-rack-design-port .nam-amp-required-callout strong {
  font-size: 15px;
  font-weight: 720;
  letter-spacing: .012em;
  line-height: 1.1;
}
.nam-rack-design-port .nam-amp-required-callout small {
  color: rgba(217, 202, 179, .66);
  font-size: 10px;
  font-weight: 610;
  letter-spacing: .045em;
  line-height: 1.2;
  text-transform: uppercase;
}
.nam-rack-design-port .pedal-nam-control-group[data-disabled="true"] .control-disabled {
  opacity: .34;
}
.nam-rack-design-port .primary-foot-state[data-state="on"] {
  border-color: rgba(224,161,73,.38);
  color: #efbd72 !important;
  background: rgba(94,58,14,.34);
}
.nam-rack-design-port .amp-brand small {
  display: inline-block;
  margin-left: 8px;
  color: rgba(205, 170, 118, .78);
  font-size: .72em;
  font-weight: 620;
  letter-spacing: .12em;
}
.nam-rack-design-port .amp-capture-nameplate[data-includes-cab="true"] .amp-capture-state {
  color: #c7b287;
  letter-spacing: .08em;
}
.nam-rack-design-port .amp-capture-nameplate[data-includes-cab="true"] .amp-capture-state i {
  background: #e3a955;
  box-shadow: 0 0 7px rgba(227,169,85,.66);
}

@media (max-width: 1120px) {
  .nam-rack-design-port .premium-asset-recovery { grid-template-columns: 30px minmax(0, 1fr) auto; gap: 8px; }
  .nam-rack-design-port .premium-asset-recovery-copy em { display: none; }
  .nam-rack-design-port .premium-asset-recovery-actions button { min-width: 62px; padding-inline: 7px; }
}
@media (max-width: 960px) {
  .nam-rack-design-port .premium-asset-recovery { right: 14px; }
}

/* The hardware surface is designed down to a 700px host height. Below that,
   preserve readable controls and make the complete rack reachable instead of
   continuously shrinking the gear, source results, or tuner into unusability. */
@media (max-height: 699px) {
  .nam-rack-design-port {
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior-x: none;
    overscroll-behavior-y: contain;
    scrollbar-gutter: stable;
    scrollbar-color: #343a43 #080a0d;
    scrollbar-width: thin;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
  }
  .nam-rack-design-port::-webkit-scrollbar { width: 7px; }
  .nam-rack-design-port::-webkit-scrollbar-thumb { border-radius: 999px; background: #343a43; }
  .nam-rack-design-port::-webkit-scrollbar-track { background: #080a0d; }
  .nam-rack-design-port .premium-nam-shell {
    position: relative;
    inset: auto;
    width: calc(100% - 8px);
    height: 692px;
    min-height: 692px;
    margin: 4px;
  }
  .nam-rack-design-port .hardware-stage,
  .nam-rack-design-port .premium-stage-canvas {
    min-height: 0;
  }
}
`;

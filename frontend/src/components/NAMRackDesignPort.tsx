import "./NAMRackDesignPort.css";
import "./NAMRackStage.css";
import "./NAMRackHardware.css";
import "./NAMRackDesignPortSourceFlow.css";
import "./NAMRackFooter.css";
import "./NAMRackHeader.css";
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
  denormalizeParamValue,
  formatParamValue,
  normalizeParam,
  offsetParamValue,
  quantizeParamValue,
  stepForParam,
} from "../utils/builtInParamValue";
import type { NAMRackOversamplingFactor, RackModuleId, RackSectionId } from "./NAMSignalChainTypes";
import type { NAMRackCabMode } from "./NAMCabPresentation";
import type { NAMRackAdvancedStageId } from "./NAMRackMixer";
import { namMeterFraction } from "../utils/namMeterLevel";
import { observeTONE3000AppendSentinel } from "../utils/tone3000InfiniteAppend";
import { NAMRackControlTooltip } from "./NAMRackControlTooltip";
import {
  NAMToneCapturePicker,
  type NAMToneCapturePickerItem,
} from "./NAMToneCapturePicker";
import {
  getParameterWheelStepCount,
  resolveProfiledParameterWheel,
} from "../utils/parameterWheel";
import {
  NAM_AMP_V4_FACEPLATE,
  NAM_EQ_V4_FACEPLATE,
  type FaceplateCircleControl,
  type FaceplateFaderControl,
  type FaceplateManifest,
} from "./namRackFaceplateGeometry";
import { namPreEqBandsForProfile } from "../utils/namInstrumentProfile";

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
  | "load-more"
  | "auto-load-more"
  | "scroll"
  | "tab"
  | "filter"
  | "sort"
  | "favorite"
  | "clear-filters"
  | "select-row"
  | "select-capture"
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
  filters: Array<{
    id: string;
    label: string;
    active?: boolean;
    attr?: string;
  }>;
  sortValue: string;
  sortOptions: Array<{ value: string; label: string }>;
  targets: Array<{
    id: string;
    label: string;
    model: string;
    meta: string;
    active?: boolean;
    preview?: boolean;
  }>;
  localTitle: string;
  localDetail: string;
  feedTitle: string;
  sortLabel: string;
  viewLabel: string;
  results: NAMSourceFlowDesignResult[];
  pagination?: {
    requestKey: string;
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
  captures?: {
    title: string;
    items: NAMToneCapturePickerItem[];
    selectedId?: string;
    busy?: boolean;
    error?: string;
  };
  previewBody: string;
  controlAssetIds: string[];
  previewText: string;
  brand?: string;
  actions: Array<{
    id: NAMSourceFlowDesignActionId;
    label: string;
    primary?: boolean;
    disabled?: boolean;
  }>;
  statusTitle: string;
  route: string;
  statusDetail: string;
  resultCount: number;
  resultTotal?: number;
  busy: boolean;
  sessionKey?: string;
  initialScrollTop?: number;
  emptyTitle: string;
  emptyBody: string;
  emptyAction?: {
    id: NAMSourceFlowDesignActionId;
    label: string;
    primary?: boolean;
  };
};

export type NAMSourceFlowDesignPortMessage = {
  type: "nam-source-flow-design-port";
  instanceId: string;
  action: NAMSourceFlowDesignActionId;
  value?: string;
  rowId?: string;
};

type DesignSectionId = Extract<
  RackSectionId,
  "pre" | "amp" | "cab" | "eq" | "post"
>;
type DesignBox = { x: number; y: number; w: number; h: number };
type NativeStyle = CSSProperties & Record<`--${string}`, string | number>;

function revealControlInNearestStageScroller(control: HTMLElement) {
  const scroller = control.closest<HTMLElement>(".nam-pre-stage-scroll");
  if (!scroller) {
    control.scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }

  const controlRect = control.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const revealMargin = 8;
  if (
    controlRect.left >= scrollerRect.left + revealMargin
    && controlRect.right <= scrollerRect.right - revealMargin
  ) return;

  // Centre the whole pedal, not just the focused hit region. Small incremental
  // adjustments can be pulled back to the previous anchor by mandatory snap.
  const module = control.closest<HTMLElement>("[data-module]");
  const revealRect = module?.getBoundingClientRect() ?? controlRect;
  const centredScrollLeft = scroller.scrollLeft
    + revealRect.left
    + revealRect.width / 2
    - scrollerRect.left
    - scrollerRect.width / 2;
  scroller.scrollLeft = clampNumber(
    centredScrollLeft,
    0,
    Math.max(0, scroller.scrollWidth - scroller.clientWidth),
  );
}

const SECTION_TO_BOARD: Record<DesignSectionId, DesignBoardId> = {
  pre: "03-pre-fx-section",
  amp: "04-amp-section",
  cab: "05-cab-section",
  eq: "06-eq-section",
  post: "07-post-fx-section",
};

const SOURCE_FLOW_TO_BOARD: Record<
  NAMSourceFlowDesignMode,
  NAMSourceFlowDesignBoardId
> = {
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

// Shared physical hardware is specified in artboard pixels, never ad-hoc
// percentages. Pedal contracts also expose the equivalent local percentages
// for geometry calculations, while AssetControl uses these fixed values as the
// final rendering authority on every device faceplate (Pre, Amp, Cab, EQ,
// Post, and header utility controls).
export const NAM_PEDAL_HARDWARE_STANDARD_PX = {
  knob: 28,
  footswitch: 25,
  toggle: 24,
  led: 12,
} as const;

// Precision Drive follows the reference pedal's smaller centre Gate rotary.
// Keep it outside the shared pedal-hardware contract: the four main controls
// remain standard 28 px knobs while this one deliberate exception stays 18 px.
export const NAM_PRECISION_DRIVE_GATE_KNOB_PX = 18;

// The approved two-tier Graphic EQ uses full studio-panel rotaries for HPF,
// Level, and LPF. Keep this named exception separate from pedal hardware.
export const NAM_GRAPHIC_EQ_FILTER_KNOB_PX = 50;

export type NAMPedalHardwareKind = keyof typeof NAM_PEDAL_HARDWARE_STANDARD_PX;

// These rotaries are deliberately not pedal hardware. The Cab IR Shaper uses
// balanced console controls, Cabinet Space uses large studio-console "hero"
// controls, and the amp tone rail needs enough visual weight on a wide host.
// Keeping the exceptions named and finite stops an ordinary pedal knob from
// drifting away from the shared 28 px contract.
export const NAM_PANEL_ROTARY_VARIANT_PX = {
  cabPanel: 42,
  roomHero: 68,
  eqPanel: 44,
} as const;

export type NAMPanelRotaryVariant = keyof typeof NAM_PANEL_ROTARY_VARIANT_PX;

export function namPedalHardwareSizePercent(
  moduleWidth: number,
  kind: NAMPedalHardwareKind,
) {
  return (NAM_PEDAL_HARDWARE_STANDARD_PX[kind] / moduleWidth) * 100;
}

export const NAM_PRE_SIGNAL_LAYOUT = {
  // Five independent pedals occupy the same 748 px row that previously held
  // Tape Echo. EQ Boost is immediately before Precision Drive in the signal
  // path, while the wider 918 px artboard keeps the complete row centred.
  compressor: { x: 85, y: 42, w: 156, h: 232 },
  octaver: { x: 251, y: 42, w: 120, h: 232 },
  eqBoost: { x: 381, y: 42, w: 156, h: 232 },
  precisionDrive: { x: 547, y: 42, w: 120, h: 232 },
  distortion: { x: 677, y: 42, w: 156, h: 232 },
} as const satisfies Record<string, DesignBox>;

export const NAM_PRE_LOGICAL_SURFACE = {
  width: 918,
  height: 341,
  row: { x: 85, y: 3, w: 748, h: 271 },
  // Fit and overflow must be computed from the same row. The former mismatched
  // 748/898 widths manufactured a scrollbar even when every pedal was visible.
  scaleReference: { x: 85, y: 3, w: 748, h: 271 },
} as const;

export const NAM_PRE_FX_HARDWARE_LAYOUT = {
  compressor: {
    knobSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.compressor.w,
      "knob",
    ),
    footSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.compressor.w,
      "footswitch",
    ),
    toggleSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.compressor.w,
      "toggle",
    ),
    ledSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.compressor.w,
      "led",
    ),
  },
  octaver: {
    knobSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.octaver.w,
      "knob",
    ),
    footSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.octaver.w,
      "footswitch",
    ),
    toggleSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.octaver.w,
      "toggle",
    ),
    ledSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.octaver.w,
      "led",
    ),
  },
  eqBoost: {
    knobSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.eqBoost.w,
      "knob",
    ),
    footSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.eqBoost.w,
      "footswitch",
    ),
    toggleSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.eqBoost.w,
      "toggle",
    ),
    ledSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.eqBoost.w,
      "led",
    ),
  },
  precisionDrive: {
    knobSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.precisionDrive.w,
      "knob",
    ),
    footSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.precisionDrive.w,
      "footswitch",
    ),
    toggleSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.precisionDrive.w,
      "toggle",
    ),
    ledSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.precisionDrive.w,
      "led",
    ),
  },
  distortion: {
    knobSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.distortion.w,
      "knob",
    ),
    footSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.distortion.w,
      "footswitch",
    ),
    toggleSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.distortion.w,
      "toggle",
    ),
    ledSize: namPedalHardwareSizePercent(
      NAM_PRE_SIGNAL_LAYOUT.distortion.w,
      "led",
    ),
  },
} as const;

// Mode selectors are a distinct, compact hardware type: both PRE pedals use
// the same blue three-detent rotary, while ordinary parameter knobs retain the
// global 28 px contract.
export const NAM_THREE_POSITION_SELECTOR_PX = 20;

// Post FX uses three sibling faceplates with the same vertical rhythm.  These
// boxes intentionally describe the taller artwork variants: keeping the
// geometry in one exported contract prevents a replacement body from silently
// letterboxing back to the old, cramped title/bottom clearances.
export const NAM_POST_FX_FACEPLATE_LAYOUT = {
  group: { x: 25, y: 24, w: 723, h: 200 },
  modules: {
    modulator: { box: { x: 25, y: 40, w: 220, h: 175 }, titleY: 9.8 },
    delay: { box: { x: 254, y: 24, w: 260, h: 200 }, titleY: 9.8 },
    reverb: { box: { x: 528, y: 29, w: 220, h: 195 }, titleY: 9.8 },
  },
  modulator: {
    // The header is deliberately mirrored from both enclosure borders:
    // [mode screen][mode toggle] ... [pedal toggle][pedal/auto screen].
    // Displays use top-left coordinates while asset controls use centres.
    modeDisplay: { x: 7, y: 16, w: 28, h: 9.5 },
    modeToggleX: 41,
    pedalToggleX: 59,
    pedalModeDisplay: { x: 65, y: 16, w: 28, h: 9.5 },
    headerCenterY: 20.75,
    headerToggleSize: namPedalHardwareSizePercent(220, "toggle"),
    topRowY: 33.714286,
    topKnobSize: namPedalHardwareSizePercent(220, "knob"),
    topLabelOffset: 10.914286,
    lowerRowY: 56.342857,
    lowerKnobSize: namPedalHardwareSizePercent(220, "knob"),
    lowerLabelOffset: 10.914286,
    primaryX: 36,
    secondaryX: 74,
    // Every Post footswitch shares the global 25 design-pixel diameter and
    // one global hardware baseline. Percentages differ because
    // the photographed enclosures have different widths and top offsets.
    ledY: 73.028571,
    ledSize: namPedalHardwareSizePercent(220, "led"),
    stateLabelY: 79.371429,
    footY: 89.4,
    footSize: namPedalHardwareSizePercent(220, "footswitch"),
    footerToggleSize: namPedalHardwareSizePercent(220, "toggle"),
    characterDisplay: { x: 61, y: 72.2, w: 26, h: 8.5 },
  },
  delay: {
    headerDisplayY: 16,
    headerDisplayH: 9,
    topRowY: 37.5,
    topKnobSize: namPedalHardwareSizePercent(260, "knob"),
    topLabelOffset: 9.55,
    lowerRowY: 57.4,
    lowerKnobSize: namPedalHardwareSizePercent(260, "knob"),
    lowerLabelOffset: 9.55,
    secondaryX: 34,
    primaryX: 66,
    ledY: 71.9,
    ledSize: namPedalHardwareSizePercent(260, "led"),
    secondaryLedSize: namPedalHardwareSizePercent(260, "led"),
    stateLabelY: 77.45,
    footY: 86.225,
    // ON/OFF and SYNC use the exact same global pedal hardware diameter.
    footSize: namPedalHardwareSizePercent(260, "footswitch"),
    secondaryFootSize: namPedalHardwareSizePercent(260, "footswitch"),
  },
  reverb: {
    voiceDisplay: { x: 11, y: 15.5, w: 55, h: 10 },
    voiceSelector: {
      x: 76,
      y: 15.5 + 10 - ((NAM_PEDAL_HARDWARE_STANDARD_PX.toggle / 195) * 100) / 2,
      size: (NAM_PEDAL_HARDWARE_STANDARD_PX.toggle / 220) * 100,
    },
    topRowY: 35.897436,
    topKnobSize: namPedalHardwareSizePercent(220, "knob"),
    topLabelOffset: 9.794872,
    lowerRowY: 56.307692,
    lowerKnobSize: namPedalHardwareSizePercent(220, "knob"),
    lowerLabelOffset: 9.794872,
    secondaryX: 34,
    primaryX: 66,
    ledY: 71.179487,
    ledSize: namPedalHardwareSizePercent(220, "led"),
    secondaryLedSize: namPedalHardwareSizePercent(220, "led"),
    stateLabelY: 76.871795,
    footY: 85.871795,
    footSize: namPedalHardwareSizePercent(220, "footswitch"),
    padToggleSize: namPedalHardwareSizePercent(220, "toggle"),
  },
} as const;

function faceplateControlById<TControl extends FaceplateCircleControl | FaceplateFaderControl>(
  manifest: FaceplateManifest,
  id: string,
  kind: TControl["kind"],
) {
  const control = manifest.controls.find(
    (candidate) => candidate.id === id && candidate.kind === kind,
  );
  if (!control) throw new Error(`Missing ${manifest.id} control: ${id}`);
  return control as TControl;
}

const ampV4Circle = (id: string) =>
  faceplateControlById<FaceplateCircleControl>(
    NAM_AMP_V4_FACEPLATE,
    id,
    id === "amp-power" || id === "amp-tight" || id === "amp-bright"
      ? "toggle"
      : "knob",
  );
const ampV4Led = (id: string) =>
  faceplateControlById<FaceplateCircleControl>(
    NAM_AMP_V4_FACEPLATE,
    id,
    "led",
  );
const eqV4Circle = (id: string, kind: FaceplateCircleControl["kind"]) =>
  faceplateControlById<FaceplateCircleControl>(NAM_EQ_V4_FACEPLATE, id, kind);
const eqV4Faders = NAM_EQ_V4_FACEPLATE.controls.filter(
  (control): control is FaceplateFaderControl => control.kind === "fader",
);
const intrinsicPercent = (value: number, extent: number) => value / extent * 100;

// V4 post-cab EQ: the body owns the recessed wells, tick ladders, frequency
// legends, and utility printing. Runtime DOM owns only moving caps and real
// hardware. Source-pixel manifests are the single positioning authority.
export const NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT = {
  power: {
    toggle: {
      x: intrinsicPercent(eqV4Circle("eq-power", "toggle").center.x, 2160),
      y: intrinsicPercent(eqV4Circle("eq-power", "toggle").center.y, 720),
      size: intrinsicPercent(eqV4Circle("eq-power", "toggle").visualDiameter, 2160),
      hitSize: intrinsicPercent(eqV4Circle("eq-power", "toggle").hitDiameter, 2160),
    },
    led: {
      x: intrinsicPercent(eqV4Circle("eq-led", "led").center.x, 2160),
      y: intrinsicPercent(eqV4Circle("eq-led", "led").center.y, 720),
      size: intrinsicPercent(eqV4Circle("eq-led", "led").visualDiameter, 2160),
      hitSize: intrinsicPercent(eqV4Circle("eq-led", "led").hitDiameter, 2160),
    },
  },
  laneXs: eqV4Faders.map((fader) => intrinsicPercent(fader.centerX, 2160)),
  fader: {
    y: intrinsicPercent(
      eqV4Faders[0].hitRect.y + eqV4Faders[0].hitRect.height / 2,
      720,
    ),
    travelTop: intrinsicPercent(eqV4Faders[0].capTravel.top, 720),
    travelBottom: intrinsicPercent(eqV4Faders[0].capTravel.bottom, 720),
    hitWidthPx: eqV4Faders[0].hitRect.width / 3,
    hitHeightPx: eqV4Faders[0].hitRect.height / 3,
    trackTopPx:
      (eqV4Faders[0].capTravel.top - eqV4Faders[0].hitRect.y) / 3,
    trackWidthPx: eqV4Faders[0].bakedWell.width / 3,
    trackHeightPx:
      (eqV4Faders[0].capTravel.bottom - eqV4Faders[0].capTravel.top) / 3,
    capSizePx: eqV4Faders[0].capSize.width / 3,
  },
  utility: {
    hpfX: intrinsicPercent(eqV4Circle("eq-hpf", "knob").center.x, 2160),
    hpfY: intrinsicPercent(eqV4Circle("eq-hpf", "knob").center.y, 720),
    hpfSize: intrinsicPercent(eqV4Circle("eq-hpf", "knob").visualDiameter, 2160),
    hpfHitSize: intrinsicPercent(eqV4Circle("eq-hpf", "knob").hitDiameter, 2160),
    levelX: intrinsicPercent(eqV4Circle("eq-level", "knob").center.x, 2160),
    levelY: intrinsicPercent(eqV4Circle("eq-level", "knob").center.y, 720),
    levelSize: intrinsicPercent(eqV4Circle("eq-level", "knob").visualDiameter, 2160),
    levelHitSize: intrinsicPercent(eqV4Circle("eq-level", "knob").hitDiameter, 2160),
    lpfX: intrinsicPercent(eqV4Circle("eq-lpf", "knob").center.x, 2160),
    lpfY: intrinsicPercent(eqV4Circle("eq-lpf", "knob").center.y, 720),
    lpfSize: intrinsicPercent(eqV4Circle("eq-lpf", "knob").visualDiameter, 2160),
    lpfHitSize: intrinsicPercent(eqV4Circle("eq-lpf", "knob").hitDiameter, 2160),
  },
} as const;

export const NAM_CAB_ROOM_CONSOLE_LAYOUT = {
  // The approved Cab view is a single console.  Keeping the decorative speaker
  // beside it made the actual control surface much smaller and wider than the
  // reference, especially on compact hosts.
  group: { x: 54, y: -30, w: 660, h: 402 },
  console: { x: 54, y: -30, w: 660, h: 402 },
  topKnobXs: [9.8, 22.9, 36, 49.1, 62.2, 75.3, 88.4],
  topKnobY: 35.4,
  utilityY: 51.5,
  roomBayTop: 60.5,
} as const;

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
    micPanel: NAM_CAB_ROOM_CONSOLE_LAYOUT.console,
  },
  eq: {
    rack: { x: 24, y: 50, w: 720, h: 240 },
  },
  post: {
    modulator: NAM_POST_FX_FACEPLATE_LAYOUT.modules.modulator.box,
    delay: NAM_POST_FX_FACEPLATE_LAYOUT.modules.delay.box,
    reverb: NAM_POST_FX_FACEPLATE_LAYOUT.modules.reverb.box,
  },
} as const;

const SECTION_GROUP_BOX: Record<DesignSectionId, DesignBox> = {
  pre: NAM_PRE_LOGICAL_SURFACE.row,
  amp: { x: 24, y: -2, w: 720, h: 345 },
  cab: NAM_CAB_ROOM_CONSOLE_LAYOUT.group,
  eq: { x: 24, y: 50, w: 720, h: 240 },
  post: NAM_POST_FX_FACEPLATE_LAYOUT.group,
};

const LABEL_OFFSET = {
  above: -12.4,
  below: 11.2,
};

const eqBoostX = (pixels: number) =>
  (pixels / NAM_PRE_SIGNAL_LAYOUT.eqBoost.w) * 100;
const prePedalY = (pixels: number) =>
  (pixels / NAM_PRE_SIGNAL_LAYOUT.eqBoost.h) * 100;

export const NAM_EQ_BOOST_FACEPLATE_LAYOUT = {
  title: { x: 50, y: 70 },
  // Frequency captions use this as their right edge.  The first version
  // centred a left-aligned 21 px text box at x=27.5, which left most of that
  // box as dead space between the glyphs and the rail.  The wider 72 px fader
  // keeps its former right boundary while extending the rail and cap travel
  // into that unused left field.  Captions remain three design pixels before
  // the visible track at every responsive scale.
  bandLabelX: eqBoostX(30),
  faderX: eqBoostX(64),
  faderWidth: eqBoostX(72),
  faderHeight: prePedalY(16),
  faderTrackInsetPercent: 6.896552,
  // The cap is 15 px wide after its 90-degree artwork rotation. Keeping its
  // centre between x=39 and x=89 prevents the minimum position from touching
  // the right-aligned caption while still increasing useful travel by 13.6%.
  faderCapMinPercent: 15.277778,
  faderCapTravelPercent: 69.444444,
  bandYs: [25, 42, 59, 76, 93, 110, 127, 144].map(prePedalY),
  hpf: { x: eqBoostX(124), y: prePedalY(55), iconY: prePedalY(35) },
  lpf: { x: eqBoostX(124), y: prePedalY(119), iconY: prePedalY(99) },
  filterSize: eqBoostX(20),
  filterHitSize: eqBoostX(28),
  led: {
    x: 50,
    y: 76.5,
    size: NAM_PRE_FX_HARDWARE_LAYOUT.eqBoost.ledSize,
  },
  stateLabelY: 82,
  foot: {
    x: 50,
    y: 90.75,
    size: NAM_PRE_FX_HARDWARE_LAYOUT.eqBoost.footSize,
    hitSize: eqBoostX(28),
  },
} as const;

// Standalone Precision Drive restores the original four-control faceplate and
// keeps the reference pedal's smaller Gate control between the two rows.
export const NAM_PRECISION_DRIVE_FACEPLATE_LAYOUT = {
  columns: [30, 70],
  topY: 19.5,
  lowerY: 49,
  knobSize: NAM_PRE_FX_HARDWARE_LAYOUT.precisionDrive.knobSize,
  knobHitSize: (28 / NAM_PRE_SIGNAL_LAYOUT.precisionDrive.w) * 100,
  gate: {
    x: 50,
    y: 33,
    size: (NAM_PRECISION_DRIVE_GATE_KNOB_PX / NAM_PRE_SIGNAL_LAYOUT.precisionDrive.w) * 100,
    hitSize: (20 / NAM_PRE_SIGNAL_LAYOUT.precisionDrive.w) * 100,
  },
  gateLabelY: 27.5,
  titleY: 66.8,
  led: {
    x: 50,
    y: 73.2,
    size: NAM_PRE_FX_HARDWARE_LAYOUT.precisionDrive.ledSize,
  },
  foot: {
    x: 50,
    y: 88.3,
    size: NAM_PRE_FX_HARDWARE_LAYOUT.precisionDrive.footSize,
    hitSize: 23,
  },
} as const;

export const NAM_AMP_FACEPLATE_LAYOUT = {
  controlY: intrinsicPercent(ampV4Circle("amp-input").center.y, 1035),
  labelY: intrinsicPercent(634, 1035),
  knobSize: intrinsicPercent(ampV4Circle("amp-input").visualDiameter, 2160),
  knobHitSize: intrinsicPercent(ampV4Circle("amp-input").hitDiameter, 2160),
  toggleSize: intrinsicPercent(ampV4Circle("amp-power").visualDiameter, 2160),
  toggleHitSize: intrinsicPercent(ampV4Circle("amp-power").hitDiameter, 2160),
  ledY: intrinsicPercent(ampV4Led("amp-power-led").center.y, 1035),
  ledSize: intrinsicPercent(ampV4Led("amp-power-led").visualDiameter, 2160),
  ledHitSize: intrinsicPercent(ampV4Led("amp-power-led").hitDiameter, 2160),
  powerX: intrinsicPercent(ampV4Circle("amp-power").center.x, 2160),
  inputX: intrinsicPercent(ampV4Circle("amp-input").center.x, 2160),
  boostX: intrinsicPercent(ampV4Circle("amp-tight").center.x, 2160),
  voiceX: intrinsicPercent(ampV4Circle("amp-bright").center.x, 2160),
  bassX: intrinsicPercent(ampV4Circle("amp-bass").center.x, 2160),
  midX: intrinsicPercent(ampV4Circle("amp-mid").center.x, 2160),
  trebleX: intrinsicPercent(ampV4Circle("amp-treble").center.x, 2160),
  presenceX: intrinsicPercent(ampV4Circle("amp-presence").center.x, 2160),
  mixX: intrinsicPercent(ampV4Circle("amp-mix").center.x, 2160),
  outputX: intrinsicPercent(ampV4Circle("amp-output").center.x, 2160),
  captureContent: {
    x: intrinsicPercent(NAM_AMP_V4_FACEPLATE.safeZones.captureContent.x, 2160),
    y: intrinsicPercent(NAM_AMP_V4_FACEPLATE.safeZones.captureContent.y, 1035),
    width: intrinsicPercent(NAM_AMP_V4_FACEPLATE.safeZones.captureContent.width, 2160),
    height: intrinsicPercent(NAM_AMP_V4_FACEPLATE.safeZones.captureContent.height, 1035),
  },
} as const;

// Use a dedicated hardware header, two control rows, then an isolated
// title/footer zone. Displays use a top/
// left anchor while hardware controls use their centre. The selector's visible
// lower edge shares the display baseline rather than merely sharing its top.
export const NAM_DISTORTION_FACEPLATE_LAYOUT = {
  columns: [22, 50, 78],
  modeDisplay: { x: 7, y: 10.5, w: 55, h: 10 },
  modeSelector: {
    x: 72,
    y: 16.189655,
    size:
      (NAM_THREE_POSITION_SELECTOR_PX / NAM_PRE_SIGNAL_LAYOUT.distortion.w) *
      100,
  },
  topY: 32.5,
  lowerY: 52.5,
  topKnobSize: NAM_PRE_FX_HARDWARE_LAYOUT.distortion.knobSize,
  gateKnobSize: NAM_PRE_FX_HARDWARE_LAYOUT.distortion.knobSize,
  lowerKnobSize: NAM_PRE_FX_HARDWARE_LAYOUT.distortion.knobSize,
  topLabelOffset: 11,
  lowerLabelOffset: 10.5,
  titleY: 70,
  led: { x: 50, y: 76.5, size: NAM_PRE_FX_HARDWARE_LAYOUT.distortion.ledSize },
  stateLabelY: 82,
  foot: {
    x: 50,
    y: 90.75,
    size: NAM_PRE_FX_HARDWARE_LAYOUT.distortion.footSize,
    hitSize: 18.5,
  },
} as const;

export const NAM_COMPRESSOR_FACEPLATE_LAYOUT = {
  // Match Distortion's wide, scan-friendly hierarchy: telemetry and selector
  // first, then two clean three-control rows, then an isolated footer.
  columns: [22, 50, 78],
  meter: { x: 7, y: 10.5, w: 55, h: 10 },
  // The selector and display share a lower baseline. The compact state plate
  // remains inside the enclosure's 6% painted safety rim.
  hpfSelector: {
    x: 72,
    y: 16.189655,
    size:
      (NAM_THREE_POSITION_SELECTOR_PX / NAM_PRE_SIGNAL_LAYOUT.compressor.w) *
      100,
  },
  hpfReadout: { x: 82, y: 9.2, w: 11, h: 10.8 },
  topY: 32.5,
  lowerY: 52.5,
  knobSize: NAM_PRE_FX_HARDWARE_LAYOUT.compressor.knobSize,
  topLabelOffset: 11,
  lowerLabelOffset: 10.5,
  titleY: 70,
  // Keep only the former black value row after removing the redundant
  // INTENSITY caption; stretching it into the caption's old space would turn
  // a slim hardware display into an oversized square plate.
  intensityReadout: { x: 6, y: 77.6, w: 30, h: 5.4 },
  intensityToggle: {
    x: 21,
    y: 90.75,
    size: NAM_PRE_FX_HARDWARE_LAYOUT.compressor.toggleSize,
  },
  // Keep the chrome power cluster comfortably inside the photographed rim.
  // The slight inward move preserves the left/right footer balance while
  // leaving visible painted padding to the right of the footswitch hit area.
  powerX: 78,
  led: { x: 78, y: 76.5, size: NAM_PRE_FX_HARDWARE_LAYOUT.compressor.ledSize },
  stateLabelY: 82,
  foot: {
    x: 78,
    y: 90.75,
    size: NAM_PRE_FX_HARDWARE_LAYOUT.compressor.footSize,
    hitSize: 18.5,
  },
} as const;

export const NAM_THREE_POSITION_SELECTOR_ROTATIONS = [-52, 0, 52] as const;
export const NAM_THREE_POSITION_SELECTOR_DETENT_RADIUS_PERCENT = 45.3;
export const NAM_REVERB_VOICE_SELECTOR_ROTATIONS = [-60, -20, 20, 60] as const;
export const NAM_REVERB_VOICE_SELECTOR_PX =
  NAM_PEDAL_HARDWARE_STANDARD_PX.toggle;
export const NAM_REVERB_VOICE_LABELS = [
  "STUDIO",
  "PLATE",
  "HALL",
  "ROOM",
] as const;
export const NAM_REVERB_VOICE_CONTROL_LABELS = [
  {
    preDelay: "PRE DLY",
    decay: "DECAY",
    mix: "MIX",
    lowCut: "LOW CUT",
    tone: "TONE",
    texture: "AIR",
  },
  {
    preDelay: "PRE DLY",
    decay: "DECAY",
    mix: "MIX",
    lowCut: "LOW CUT",
    tone: "DAMP",
    texture: "SHIMMER",
  },
  {
    preDelay: "PRE DLY",
    decay: "DECAY",
    mix: "MIX",
    lowCut: "LOW CUT",
    tone: "DAMP",
    texture: "MOTION",
  },
  {
    preDelay: "PRE DLY",
    decay: "SIZE",
    mix: "MIX",
    lowCut: "LOW CUT",
    tone: "TONE",
    texture: "EARLY",
  },
] as const;

export function namThreePositionSelectorDetentPlacement(rotation: number) {
  const radians = (rotation * Math.PI) / 180;
  return {
    x:
      50 +
      NAM_THREE_POSITION_SELECTOR_DETENT_RADIUS_PERCENT * Math.sin(radians),
    y:
      50 -
      NAM_THREE_POSITION_SELECTOR_DETENT_RADIUS_PERCENT * Math.cos(radians),
    rotation,
  };
}

export function namReverbVoiceSelectorDetentPlacement(rotation: number) {
  const radians = (rotation * Math.PI) / 180;
  return {
    x:
      50 +
      NAM_THREE_POSITION_SELECTOR_DETENT_RADIUS_PERCENT * Math.sin(radians),
    y:
      50 -
      NAM_THREE_POSITION_SELECTOR_DETENT_RADIUS_PERCENT * Math.cos(radians),
    rotation,
  };
}

export function reverbVoiceDisplayLabel(value: number, min = 0) {
  const index = clamp(
    Math.round((Number.isFinite(value) ? value : min) - min),
    0,
    NAM_REVERB_VOICE_LABELS.length - 1,
  );
  return NAM_REVERB_VOICE_LABELS[index];
}

export function reverbVoiceControlLabels(value: number, min = 0) {
  const index = clamp(
    Math.round((Number.isFinite(value) ? value : min) - min),
    0,
    NAM_REVERB_VOICE_CONTROL_LABELS.length - 1,
  );
  return NAM_REVERB_VOICE_CONTROL_LABELS[index];
}

const COMPRESSOR_HPF_DISPLAY_LABELS = ["OFF", "80", "240"] as const;

export function compressorHpfDisplayLabel(value: number, min = 0) {
  const index = clamp(
    Math.round((Number.isFinite(value) ? value : min) - min),
    0,
    COMPRESSOR_HPF_DISPLAY_LABELS.length - 1,
  );
  return COMPRESSOR_HPF_DISPLAY_LABELS[index];
}

export function compressorIntensityDisplayLabel(value: number) {
  return Number.isFinite(value) && value >= 0.5 ? "16:1" : "8:1";
}

type DesignParamChangeHandler = (
  param: BuiltInParamDescriptor,
  value: number,
) => void;

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

export function namRotaryPointerAngle(
  clientX: number,
  clientY: number,
  centerX: number,
  centerY: number,
) {
  return (Math.atan2(clientY - centerY, clientX - centerX) * 180) / Math.PI;
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
  const distanceFromCenter = Math.hypot(
    clientX - drag.centerX,
    clientY - drag.centerY,
  );
  const mostlyVerticalDrag =
    Math.abs(clientX - drag.startX) < 10 && Math.abs(clientY - drag.startY) > 3;
  const angularDeadZone = 14;

  if (
    drag.mode === "vertical" ||
    (drag.mode === "pending" && mostlyVerticalDrag)
  ) {
    return {
      value: clampNumber(
        verticalRotaryValueFromDrag(param, drag, clientY, fine),
        param.min,
        param.max,
      ),
      lastAngle: drag.lastAngle,
      accumulatedAngle: drag.accumulatedAngle,
      mode: "vertical" as const,
    };
  }

  if (drag.mode === "angular" || distanceFromCenter >= angularDeadZone) {
    const nextAngle = namRotaryPointerAngle(
      clientX,
      clientY,
      drag.centerX,
      drag.centerY,
    );
    const angleDelta = namRotaryAngleDelta(drag.lastAngle, nextAngle);
    const nextAccumulatedAngle =
      Math.abs(angleDelta) >= 0.25
        ? drag.accumulatedAngle + angleDelta
        : drag.accumulatedAngle;
    const fineScale = fine ? 0.35 : 1;
    const nextNormalized =
      drag.startNormalized + (nextAccumulatedAngle / 270) * fineScale;
    return {
      value: denormalizeParamValue(param, nextNormalized),
      lastAngle: Math.abs(angleDelta) >= 0.25 ? nextAngle : drag.lastAngle,
      accumulatedAngle: nextAccumulatedAngle,
      mode: "angular" as const,
    };
  }

  return {
    value: clampNumber(
      verticalRotaryValueFromDrag(param, drag, clientY, fine),
      param.min,
      param.max,
    ),
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
  const defaultOnValue =
    param.defaultValue > activeThreshold ? param.defaultValue : param.max;
  const restoredValue =
    rememberedValue > activeThreshold ? rememberedValue : defaultOnValue;
  return {
    nextValue: clampNumber(restoredValue, param.min, param.max),
    rememberedValue: clampNumber(restoredValue, param.min, param.max),
  };
}

export function cycleNAMDesignEnumValue(
  param: BuiltInParamDescriptor,
  direction = 1,
) {
  const optionValues = (param.enumOptions ?? [])
    .map((option) => option.value)
    .filter((value) => Number.isFinite(value));
  const values =
    optionValues.length > 0
      ? optionValues
      : Array.from(
          { length: Math.max(1, Math.round(param.max - param.min) + 1) },
          (_, index) => param.min + index,
        );
  const currentIndex = values.findIndex((value) => value === param.value);
  const startIndex = currentIndex >= 0 ? currentIndex : 0;
  const offset = direction >= 0 ? 1 : -1;
  return values[(startIndex + offset + values.length) % values.length];
}

export function snapNAMDesignEnumValue(
  param: BuiltInParamDescriptor,
  candidate: number,
) {
  const optionValues = (param.enumOptions ?? [])
    .map((option) => option.value)
    .filter((value) => Number.isFinite(value));
  const values =
    optionValues.length > 0
      ? optionValues
      : Array.from(
          { length: Math.max(1, Math.round(param.max - param.min) + 1) },
          (_, index) => param.min + index,
        );
  const safeCandidate = Number.isFinite(candidate) ? candidate : param.value;
  return values.reduce(
    (nearest, value) =>
      Math.abs(value - safeCandidate) < Math.abs(nearest - safeCandidate)
        ? value
        : nearest,
    values[0] ?? param.min,
  );
}

const DISTORTION_MODE_DISPLAY_LABELS = ["HEAVY", "XTREME", "CRUNCH"] as const;

export function distortionModeDisplayLabel(value: number, min = 0) {
  const index = clamp(
    Math.round((Number.isFinite(value) ? value : min) - min),
    0,
    DISTORTION_MODE_DISPLAY_LABELS.length - 1,
  );
  return DISTORTION_MODE_DISPLAY_LABELS[index];
}

function verticalRotaryValueFromDrag(
  param: BuiltInParamDescriptor,
  drag: NAMRotaryDragState,
  clientY: number,
  fine = false,
) {
  const fineScale = fine ? 0.25 : 1;
  return denormalizeParamValue(
    param,
    drag.startNormalized + ((drag.startY - clientY) / 150) * fineScale,
  );
}

const BODIES = {
  amp: "amp-head-body-v5",
  cab: "cabinet-body",
  cabRoomIntegrated: "cab-room-integrated-body",
  irShaper: "ir-shaper-panel-body",
  mic: "mic-panel-body",
  eq: "graphic-eq-body-v6",
  blue: "stompbox-body-blue",
  blueWide: "stompbox-body-blue-wide",
  whiteWide: "stompbox-body-white-wide",
  dark: "stompbox-body-dark",
  darkWide: "stompbox-body-dark-wide",
  olive: "stompbox-body-olive",
  red: "stompbox-body-red",
  redWide: "stompbox-body-red-wide",
  stone: "stompbox-body-stone",
  copperWide: "wide-pedal-body-copper-deep",
  copperTall: "wide-pedal-body-copper-tall",
  darkWidePedal: "wide-pedal-body-dark-deep",
  darkTallPedal: "wide-pedal-body-dark-tall",
  blueWidePedal: "wide-pedal-body-navy-deep",
  blueTallPedal: "wide-pedal-body-navy-tall",
} as const satisfies Record<string, NAMDesignBodyAssetId>;

const CONTROLS = {
  button: "button-black-top",
  footOff: "footswitch-chrome-off-top",
  footOn: "footswitch-chrome-on-top",
  footPressed: "footswitch-chrome-pressed-top",
  knobBlack: "knob-black-top",
  knobBlackPanel: "knob-black-panel-v4",
  knobBlueSteel: "knob-blue-steel-top",
  knobBlueSteelPanel: "knob-blue-steel-panel-v4",
  knobCream: "knob-cream-top",
  knobMetal: "knob-metal-top",
  ledOff: "led-amber-off-top",
  ledOffPanel: "led-amber-off-panel-v4",
  ledOn: "led-amber-on-top",
  ledOnPanel: "led-amber-on-panel-v4",
  mic57: "mic-dynamic-57",
  mic121: "mic-ribbon-121",
  slider: "slider-metal-top",
  sliderPanel: "slider-metal-cap-v4",
  toggle: "toggle-chrome-top",
  togglePanel: "toggle-chrome-panel-v4",
  washer: "washer-chrome-top",
} as const satisfies Record<string, NAMDesignControlAssetId>;

const STUDIO_BACKDROP_URL = new URL(
  "../assets/nam/rack-studio-backdrop-v2.webp",
  import.meta.url,
).href;

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

function assetFrameStyle(
  box: DesignBox,
  body: NAMDesignBodyAssetId,
): CSSProperties {
  const asset = getNAMDesignAsset(body);
  const assetAspect = asset.width / Math.max(asset.height, 1);
  const boxAspect = box.w / Math.max(box.h, 1);
  if (boxAspect > assetAspect) {
    const widthPct = ((box.h * assetAspect) / Math.max(box.w, 1)) * 100;
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
  return Object.fromEntries(
    Object.entries(vars).map(([key, value]) => [`--${key}`, value]),
  ) as NativeStyle;
}

function shellBoardForSection(sectionId: RackSectionId): DesignBoardId {
  if (
    sectionId === "pre" ||
    sectionId === "amp" ||
    sectionId === "cab" ||
    sectionId === "eq" ||
    sectionId === "post"
  ) {
    return SECTION_TO_BOARD[sectionId];
  }
  return "04-amp-section";
}

function designSectionFor(sectionId: RackSectionId): DesignSectionId {
  return sectionId === "pre" ||
    sectionId === "amp" ||
    sectionId === "cab" ||
    sectionId === "eq" ||
    sectionId === "post"
    ? sectionId
    : "amp";
}

export function sourceFlowDesignBoardForMode(
  mode: NAMSourceFlowDesignMode,
): NAMSourceFlowDesignBoardId {
  return SOURCE_FLOW_TO_BOARD[mode];
}

export function sourceFlowResourceTerms(mode: NAMSourceFlowDesignMode) {
  if (mode === "ir")
    return { label: "IR", title: "IR", library: "IR Library" } as const;
  if (mode === "fx")
    return {
      label: "effect preset",
      title: "Effect Preset",
      library: "Effect Preset Library",
    } as const;
  return {
    label: "capture",
    title: "Capture",
    library: "Capture Library",
  } as const;
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

export function computePremiumStagePlacement(
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
  // Max fills the usable canvas, including its safety margins; every smaller
  // preset is a distinct fraction of that fitted size. Multipliers above one
  // used to push the outer pedals underneath the adjacent library drawer on
  // wide/high-DPI hosts even though the stage itself correctly clipped them.
  const requestedScale =
    rackSizePercent >= 220
      ? 1
      : rackSizePercent >= 180
        ? 0.94
        : rackSizePercent >= 140
          ? 0.88
          : rackSizePercent >= 100
            ? 0.82
            : 0.76;
  const scale = Math.max(0.1, fitScale * requestedScale);

  return {
    left: (viewport.width - group.w * scale) / 2 - group.x * scale,
    top: (viewport.height - group.h * scale) / 2 - group.y * scale,
    scale,
  };
}

export function computePremiumPreStagePlacement(
  viewport: { width: number; height: number },
  rackSizePercent: number,
) {
  const scaleReferencePlacement = computePremiumStagePlacement(
    viewport,
    NAM_PRE_LOGICAL_SURFACE.scaleReference,
    rackSizePercent,
  );
  const marginX = clamp(viewport.width * 0.035, 22, 46);
  const rowWidth = NAM_PRE_LOGICAL_SURFACE.row.w * scaleReferencePlacement.scale;
  const fitsWithoutScroll = rowWidth + marginX * 2 <= viewport.width;
  const left = fitsWithoutScroll
    ? (viewport.width - rowWidth) / 2
      - NAM_PRE_LOGICAL_SURFACE.row.x * scaleReferencePlacement.scale
    : marginX;
  const contentWidth = fitsWithoutScroll
    ? viewport.width
    : Math.ceil(
        left
          + NAM_PRE_LOGICAL_SURFACE.width * scaleReferencePlacement.scale
          + marginX,
      );

  return {
    ...scaleReferencePlacement,
    left,
    contentWidth,
    contentHeight: viewport.height,
    fitsWithoutScroll,
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
  cabRoomInputSourceAvailable?: boolean;
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
  inputLeftLevelDb?: number;
  inputRightLevelDb?: number;
  outputLeftLevelDb?: number;
  outputRightLevelDb?: number;
  inputChannelCount?: number;
};

export type NAMRackDesignUtilityControls = {
  instrumentProfile: 0 | 1;
  effectiveInputMode: number;
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
  pitchLocked: boolean;
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
  qa,
}: {
  assetId: NAMDesignBodyAssetId | NAMDesignControlAssetId;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  draggable?: boolean;
  qa?: Record<`data-${string}`, string | number | undefined>;
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
      {...qa}
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
    <div
      className={`label ${className}`.trim()}
      style={{ left: `${x}%`, top: `${y}%` }}
    >
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
  semanticLabel,
  labelOffset = 8.2,
  labelClass = "",
  value = "",
  hitSize,
  allowInteraction = true,
  visuallyDisabled,
  disabledReason,
  onButtonClick,
  enableButtonDrag = false,
  stateRotations,
  hardwareKind,
  panelRotaryVariant,
  exactSizeVariant,
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
  semanticLabel?: string;
  labelOffset?: number;
  labelClass?: string;
  value?: string;
  hitSize?: number;
  allowInteraction?: boolean;
  visuallyDisabled?: boolean;
  disabledReason?: string;
  onButtonClick?: (
    param: BuiltInParamDescriptor,
    commitValue: (value: number) => void,
  ) => void;
  enableButtonDrag?: boolean;
  stateRotations?: readonly number[];
  hardwareKind?: NAMPedalHardwareKind;
  panelRotaryVariant?: NAMPanelRotaryVariant;
  exactSizeVariant?:
    | "eq-filter"
    | "mini-toggle"
    | "panel-toggle"
    | "panel-knob"
    | "panel-led";
}) {
  const param = useBoundDesignParam(paramId);
  const context = useContext(DesignParamContext);
  const commitParamValue = useDesignParamCommit(param);
  const hitRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<NAMRotaryDragState | null>(null);
  const buttonDragMovedRef = useRef(false);
  const suppressNextButtonClickRef = useRef(false);
  const feedbackTimerRef = useRef<number | null>(null);
  const pointerInitiatedFocusRef = useRef(false);
  const feedbackActivityRef = useRef<Record<ControlFeedbackActivity, boolean>>({
    hovered: false,
    focused: false,
    dragging: false,
  });
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const interactive = Boolean(
    allowInteraction && param && context?.onParamChange,
  );
  const controlVisuallyDisabled = visuallyDisabled ?? !allowInteraction;
  const valueLabel = param ? formatParamValue(param) : value;
  const isEnum = param?.type === "enum";
  const isEnumButton = Boolean(param && isEnum && interaction === "button");
  const isToggleButton = Boolean(
    param && !isEnum && (interaction === "button" || param.type === "toggle"),
  );
  const isButtonLike = Boolean(isEnumButton || isToggleButton);
  const controlClasses = className.split(/\s+/);
  const isToggleArtwork = controlClasses.includes("toggle");
  const isSwitchControl = Boolean(
    param && !isEnum && isToggleArtwork && isButtonLike,
  );
  const toggleActive = Boolean(
    param && param.value >= (param.min + param.max) / 2,
  );
  const pct = param ? normalizeParam(param) : 0;
  const stateRotationIndex =
    param && stateRotations?.length
      ? clamp(Math.round(param.value - param.min), 0, stateRotations.length - 1)
      : undefined;
  const stateRotation =
    stateRotationIndex !== undefined && stateRotations
      ? stateRotations[stateRotationIndex]
      : undefined;
  const visualRot =
    stateRotation !== undefined
      ? stateRotation
      : isToggleArtwork && param
        ? toggleActive
          ? 0
          : 180
        : param && !isButtonLike
          ? -135 + pct * 270
          : rot;
  const visualSize = exactSizeVariant
    ? `${size}%`
    : panelRotaryVariant
      ? `${NAM_PANEL_ROTARY_VARIANT_PX[panelRotaryVariant]}px`
      : hardwareKind
        ? `${NAM_PEDAL_HARDWARE_STANDARD_PX[hardwareKind]}px`
        : `${size}%`;
  const resolvedControlLabel =
    semanticLabel ?? param?.label ?? labelText ?? "Control";
  const title = param ? `${resolvedControlLabel}: ${valueLabel}` : valueLabel;
  const showsLiveFeedback = Boolean(
    interactive && (!isButtonLike || enableButtonDrag),
  );
  const showsDisabledFeedback = Boolean(!allowInteraction && disabledReason);
  const showsControlFeedback = showsLiveFeedback || showsDisabledFeedback;
  const feedbackValue = showsDisabledFeedback ? disabledReason : valueLabel;

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
      if (param.type === "enum") {
        commitParamValue(cycleNAMDesignEnumValue(param, direction));
        return;
      }
      if (interaction === "button" || param.type === "toggle") {
        commitParamValue(
          param.value >= (param.min + param.max) / 2 ? param.min : param.max,
        );
        return;
      }
      commitParamValue(
        offsetParamValue(param, param.value, direction * multiplier),
      );
    },
    [commitParamValue, interaction, param],
  );

  const dragToValue = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || !param || drag.pointerId !== event.pointerId) return;
      const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 0.25 : 1;
      const next = namRotaryValueFromDrag(
        param,
        drag,
        event.clientX,
        event.clientY,
        fine < 1,
      );
      const nextValue =
        enableButtonDrag && param.type === "enum"
          ? snapNAMDesignEnumValue(param, next.value)
          : next.value;
      if (enableButtonDrag) {
        const pointerTravel = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (
          pointerTravel >= 4 ||
          Math.abs(nextValue - drag.startValue) > 0.000001
        ) {
          buttonDragMovedRef.current = true;
        }
      }
      dragRef.current = {
        ...drag,
        lastAngle: next.lastAngle,
        accumulatedAngle: next.accumulatedAngle,
        mode: next.mode,
      };
      commitParamValue(nextValue);
    },
    [commitParamValue, enableButtonDrag, param],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!interactive || !param || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      pointerInitiatedFocusRef.current = true;
      event.currentTarget.focus();
      if (isButtonLike && !enableButtonDrag) return;
      buttonDragMovedRef.current = false;
      suppressNextButtonClickRef.current = false;
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
        lastAngle: namRotaryPointerAngle(
          event.clientX,
          event.clientY,
          centerX,
          centerY,
        ),
        accumulatedAngle: 0,
        mode: "pending",
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [enableButtonDrag, interactive, isButtonLike, param, setFeedbackActivity],
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
        suppressNextButtonClickRef.current = Boolean(
          enableButtonDrag &&
          buttonDragMovedRef.current &&
          event.type === "pointerup",
        );
        buttonDragMovedRef.current = false;
        setFeedbackActivity("dragging", false);
      }
      pointerInitiatedFocusRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [dragToValue, enableButtonDrag, setFeedbackActivity],
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!interactive || !param) return;
      event.preventDefault();
      event.stopPropagation();
      if (suppressNextButtonClickRef.current) {
        suppressNextButtonClickRef.current = false;
        return;
      }
      if (isButtonLike) {
        if (onButtonClick) onButtonClick(param, commitParamValue);
        else stepParam(1);
      }
    },
    [
      commitParamValue,
      interactive,
      isButtonLike,
      onButtonClick,
      param,
      stepParam,
    ],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (!interactive || !param || (isButtonLike && !enableButtonDrag)) return;
      const gesture = resolveProfiledParameterWheel(event.nativeEvent, "control");
      if (gesture.preventDefault) event.preventDefault();
      if (gesture.stopPropagation) event.stopPropagation();
      if (gesture.operation !== "adjust") return;
      const stepCount = getParameterWheelStepCount(gesture);
      if (stepCount === 0) return;
      showFeedbackNow();
      stepParam(Math.sign(stepCount), Math.abs(stepCount));
    },
    [
      enableButtonDrag,
      interactive,
      isButtonLike,
      param,
      showFeedbackNow,
      stepParam,
    ],
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
      const arrowMultiplier =
        event.shiftKey || event.ctrlKey || event.metaKey ? 1 : 4;
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
    [
      commitParamValue,
      interactive,
      isButtonLike,
      isToggleButton,
      onButtonClick,
      param,
      showFeedbackNow,
      stepParam,
    ],
  );

  return (
    <>
      {(interactive ||
        (allowInteraction && value) ||
        showsDisabledFeedback) && (
        <span
          ref={hitRef}
          className={`control-hit ${interactive ? "interactive" : ""} ${pointerInitiatedFocusRef.current ? "pointer-focused" : ""} ${showsDisabledFeedback ? "disabled-feedback" : ""}`.trim()}
          data-value={valueLabel}
          data-param-id={param?.id}
          data-param-value={param?.value}
          data-control-interaction={
            enableButtonDrag && isButtonLike
              ? "hybrid"
              : isButtonLike
                ? "button"
                : "knob"
          }
          title={isButtonLike && interactive ? title : undefined}
          style={percentStyle({
            x: `${x}%`,
            y: `${y}%`,
            hit: `${hitSize ?? Math.max(size + 2, size * 1.25)}%`,
          })}
          role={
            interactive
              ? isSwitchControl
                ? "switch"
                : isEnum
                  ? "spinbutton"
                  : isToggleButton
                    ? "button"
                    : "slider"
              : showsDisabledFeedback
                ? "note"
                : undefined
          }
          tabIndex={interactive || showsDisabledFeedback ? 0 : undefined}
          aria-label={
            showsDisabledFeedback
              ? `${resolvedControlLabel} unavailable. ${disabledReason}`
              : param
                ? isSwitchControl || isEnumButton
                  ? `${resolvedControlLabel}: ${valueLabel}`
                  : resolvedControlLabel
                : undefined
          }
          aria-disabled={showsDisabledFeedback || undefined}
          aria-checked={
            interactive && isSwitchControl && param ? toggleActive : undefined
          }
          aria-pressed={
            interactive && !isSwitchControl && isToggleButton && param
              ? toggleActive
              : undefined
          }
          aria-valuemin={
            interactive && !isSwitchControl && !isToggleButton
              ? param?.min
              : undefined
          }
          aria-valuemax={
            interactive && !isSwitchControl && !isToggleButton
              ? param?.max
              : undefined
          }
          aria-valuenow={
            interactive && !isSwitchControl && !isToggleButton
              ? param?.value
              : undefined
          }
          aria-valuetext={
            interactive && !isSwitchControl && !isToggleButton
              ? valueLabel
              : undefined
          }
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
          onFocus={(event) => {
            if (!pointerInitiatedFocusRef.current) {
              revealControlInNearestStageScroller(event.currentTarget);
              if (showsControlFeedback) {
                setFeedbackActivity("focused", true);
              }
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
      {showsControlFeedback ? (
        <NAMRackControlTooltip
          anchor={hitRef.current}
          open={feedbackVisible}
          label={semanticLabel ?? param?.label}
          value={feedbackValue}
          kind={showsDisabledFeedback ? "reason" : "value"}
        />
      ) : null}
      <DesignAssetImage
        assetId={assetId}
        className={`asset-control ${className} ${controlVisuallyDisabled ? "control-disabled" : ""} ${isToggleArtwork ? (toggleActive ? "control-on" : "control-off") : ""} ${stateRotationIndex !== undefined ? `control-state-${stateRotationIndex}` : ""}`.trim()}
        style={percentStyle({
          x: `${x}%`,
          y: `${y}%`,
          size: visualSize,
          rot: `${visualRot}deg`,
        })}
        qa={{
          "data-param-id": paramId,
          ...(exactSizeVariant
            ? {
                "data-nam-exact-size-variant": exactSizeVariant,
                "data-nam-exact-size-percent": size,
              }
            : panelRotaryVariant
              ? {
                  "data-nam-panel-rotary-variant": panelRotaryVariant,
                  "data-nam-panel-rotary-px":
                    NAM_PANEL_ROTARY_VARIANT_PX[panelRotaryVariant],
                }
              : hardwareKind
                ? {
                    "data-nam-hardware-kind": hardwareKind,
                    "data-nam-hardware-standard-px":
                      NAM_PEDAL_HARDWARE_STANDARD_PX[hardwareKind],
                  }
                : {}),
        }}
      />
      {controlClasses.includes("knob") &&
        !controlClasses.includes("enum-position-rotary") && (
          <span
            className="knob-position-indicator"
            aria-hidden="true"
            style={percentStyle({
              x: `${x}%`,
              y: `${y}%`,
              size: visualSize,
              rot: `${visualRot}deg`,
            })}
          />
        )}
      {labelText && (
        <Label
          x={x}
          y={y + labelOffset}
          className={`control-label ${labelClass} ${controlVisuallyDisabled ? "control-disabled" : ""}`.trim()}
        >
          {labelText}
        </Label>
      )}
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
  semanticLabel,
  labelOffset,
  labelClass,
  value,
  hitSize,
  allowInteraction = true,
  disabledReason,
  panelRotaryVariant,
  assetIdOverride,
  exactSizeVariant,
}: {
  kind: "black" | "blue-steel" | "cream" | "metal";
  x: number;
  y: number;
  size: number;
  rot: number;
  paramId?: string;
  labelText?: string;
  semanticLabel?: string;
  labelOffset?: number;
  labelClass?: string;
  value?: string;
  hitSize?: number;
  allowInteraction?: boolean;
  disabledReason?: string;
  panelRotaryVariant?: NAMPanelRotaryVariant;
  assetIdOverride?: NAMDesignControlAssetId;
  exactSizeVariant?: "eq-filter" | "panel-knob";
}) {
  const assetId = assetIdOverride ?? (
    kind === "metal"
      ? CONTROLS.knobMetal
      : kind === "cream"
        ? CONTROLS.knobCream
        : kind === "blue-steel"
          ? CONTROLS.knobBlueSteel
          : CONTROLS.knobBlack
  );
  return (
    <AssetControl
      assetId={assetId}
      className={`knob ${kind}`}
      x={x}
      y={y}
      size={size}
      rot={rot}
      paramId={paramId}
      labelText={labelText}
      semanticLabel={semanticLabel}
      labelOffset={labelOffset}
      labelClass={labelClass}
      value={value}
      hitSize={hitSize}
      allowInteraction={allowInteraction}
      disabledReason={disabledReason}
      hardwareKind="knob"
      panelRotaryVariant={panelRotaryVariant}
      exactSizeVariant={exactSizeVariant}
    />
  );
}

function EqFilterKnob({
  x,
  y,
  size,
  hitSize,
  rot,
  paramId,
  semanticLabel,
  assetId = CONTROLS.knobBlueSteel,
}: {
  x: number;
  y: number;
  size: number;
  hitSize: number;
  rot: number;
  paramId: "eqHPFHz" | "eqLevelDb" | "eqLPFHz";
  semanticLabel: string;
  assetId?: NAMDesignControlAssetId;
}) {
  const side =
    paramId === "eqHPFHz" ? "hpf" : paramId === "eqLPFHz" ? "lpf" : "level";
  return (
    <AssetControl
      assetId={assetId}
      className={`knob blue-steel eq-filter-knob eq-filter-knob-${side}`}
      x={x}
      y={y}
      size={size}
      hitSize={hitSize}
      rot={rot}
      paramId={paramId}
      semanticLabel={semanticLabel}
      panelRotaryVariant={
        assetId === CONTROLS.knobBlueSteelPanel ? undefined : "eqPanel"
      }
      exactSizeVariant={
        assetId === CONTROLS.knobBlueSteelPanel ? "panel-knob" : undefined
      }
    />
  );
}

function PreEqFilterKnob({
  x,
  y,
  size,
  hitSize,
  rot,
  paramId,
  semanticLabel,
}: {
  x: number;
  y: number;
  size: number;
  hitSize: number;
  rot: number;
  paramId: "preEqHPFHz" | "preEqLPFHz";
  semanticLabel: string;
}) {
  const side = paramId === "preEqHPFHz" ? "hpf" : "lpf";
  return (
    <AssetControl
      assetId={CONTROLS.knobBlack}
      className={`knob black combined-pre-eq-filter-knob combined-pre-eq-filter-knob-${side}`}
      x={x}
      y={y}
      size={size}
      hitSize={hitSize}
      rot={rot}
      paramId={paramId}
      semanticLabel={semanticLabel}
      hardwareKind="knob"
      exactSizeVariant="eq-filter"
    />
  );
}

function CompactKnob({
  kind,
  x,
  y,
  size,
  rot,
  paramId,
  labelText,
  semanticLabel,
  labelOffset,
  labelClass,
  hitSize,
}: {
  kind: "black" | "blue-steel" | "cream" | "metal";
  x: number;
  y: number;
  size: number;
  rot: number;
  paramId: string;
  labelText: string;
  semanticLabel?: string;
  labelOffset?: number;
  labelClass?: string;
  hitSize: number;
}) {
  const assetId =
    kind === "metal"
      ? CONTROLS.knobMetal
      : kind === "cream"
        ? CONTROLS.knobCream
        : kind === "blue-steel"
          ? CONTROLS.knobBlueSteel
          : CONTROLS.knobBlack;
  return (
    <AssetControl
      assetId={assetId}
      className={`knob compact-knob ${kind}`}
      x={x}
      y={y}
      size={size}
      rot={rot}
      paramId={paramId}
      labelText={labelText}
      semanticLabel={semanticLabel}
      labelOffset={labelOffset}
      labelClass={labelClass}
      hitSize={hitSize}
    />
  );
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
  const threshold =
    activeThreshold ?? (param ? (param.min + param.max) / 2 : 0.5);
  const active = Boolean(param && param.value > threshold);
  const rememberedActiveValue = useRef(param && active ? param.value : 1);
  useEffect(() => {
    if (param && param.value > threshold)
      rememberedActiveValue.current = param.value;
  }, [param, threshold]);
  const resolvedState = param ? (active ? "on" : "off") : state;
  const assetId =
    resolvedState === "pressed"
      ? CONTROLS.footPressed
      : resolvedState === "on"
        ? CONTROLS.footOn
        : CONTROLS.footOff;
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
        hardwareKind="footswitch"
        onButtonClick={
          preserveContinuousValue
            ? (boundParam, commitValue) => {
                const toggled = toggleNAMContinuousBypassValue(
                  boundParam,
                  rememberedActiveValue.current,
                  threshold,
                );
                rememberedActiveValue.current = toggled.rememberedValue;
                commitValue(toggled.nextValue);
              }
            : undefined
        }
      />
      {showStateLabel ? (
        <FootActionLabel
          x={x}
          y={stateLabelY ?? y - Math.max(8, size * 0.62)}
          className={`primary-foot-state ${allowInteraction ? "" : "control-disabled"}`}
          state={
            resolvedState === "on" || resolvedState === "pressed" ? "on" : "off"
          }
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
  onAssetId = CONTROLS.ledOn,
  offAssetId = CONTROLS.ledOff,
  exactSizeVariant,
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
  onAssetId?: NAMDesignControlAssetId;
  offAssetId?: NAMDesignControlAssetId;
  exactSizeVariant?: "panel-led";
}) {
  const param = useBoundDesignParam(paramId);
  const active = param
    ? param.value > (activeThreshold ?? (param.min + param.max) / 2)
    : on;
  return (
    <AssetControl
      assetId={active ? onAssetId : offAssetId}
      className={`led ${active ? "on" : "off"}`}
      x={x}
      y={y}
      size={size}
      paramId={paramId}
      interaction="button"
      value={value}
      hitSize={hitSize}
      allowInteraction={interactive}
      visuallyDisabled={false}
      hardwareKind="led"
      exactSizeVariant={exactSizeVariant}
    />
  );
}

function Toggle({
  x,
  y,
  size,
  paramId,
  labelText,
  labelOffset,
  labelClass,
  compact = false,
  panelSized = false,
  hitSize,
  allowInteraction = true,
  disabledReason,
  assetId = CONTROLS.toggle,
}: {
  x: number;
  y: number;
  size: number;
  paramId?: string;
  labelText?: string;
  labelOffset?: number;
  labelClass?: string;
  compact?: boolean;
  panelSized?: boolean;
  hitSize?: number;
  allowInteraction?: boolean;
  disabledReason?: string;
  assetId?: NAMDesignControlAssetId;
}) {
  return (
    <AssetControl
      assetId={assetId}
      className={`toggle${compact ? " compact-toggle" : ""}`}
      x={x}
      y={y}
      size={size}
      paramId={paramId}
      interaction="button"
      labelText={labelText}
      labelOffset={labelOffset}
      labelClass={labelClass}
      hitSize={hitSize}
      allowInteraction={allowInteraction}
      disabledReason={disabledReason}
      hardwareKind="toggle"
      exactSizeVariant={
        compact ? "mini-toggle" : panelSized ? "panel-toggle" : undefined
      }
    />
  );
}

function ThreePositionRotarySelector({
  x,
  y,
  size,
  paramId,
}: {
  x: number;
  y: number;
  size: number;
  paramId: string;
}) {
  const param = useBoundDesignParam(paramId);
  const stateIndex = param
    ? clamp(
        Math.round(param.value - param.min),
        0,
        NAM_THREE_POSITION_SELECTOR_ROTATIONS.length - 1,
      )
    : 0;
  return (
    <>
      <span
        className="three-position-selector-detents"
        style={{
          left: `${x}%`,
          top: `${y}%`,
          width: `${size * 1.28}%`,
        }}
        data-nam-three-position-selector-px={NAM_THREE_POSITION_SELECTOR_PX}
        data-selector-state={stateIndex}
        aria-hidden="true"
      >
        {NAM_THREE_POSITION_SELECTOR_ROTATIONS.map((rotation, index) => {
          const detent = namThreePositionSelectorDetentPlacement(rotation);
          return (
            <i
              key={rotation}
              data-active={index === stateIndex}
              style={{
                left: `${detent.x}%`,
                top: `${detent.y}%`,
                transform: `translate(-50%, -50%) rotate(${detent.rotation}deg)`,
              }}
            />
          );
        })}
      </span>
      <AssetControl
        assetId={CONTROLS.knobBlueSteel}
        className="knob blue-steel three-position-rotary enum-position-rotary"
        x={x}
        y={y}
        size={size}
        paramId={paramId}
        interaction="button"
        hitSize={size * 1.28}
        enableButtonDrag
        stateRotations={NAM_THREE_POSITION_SELECTOR_ROTATIONS}
        onButtonClick={(param, commitValue) => {
          commitValue(cycleNAMDesignEnumValue(param));
        }}
      />
    </>
  );
}

function FourPositionRotarySelector({
  x,
  y,
  size,
  paramId,
}: {
  x: number;
  y: number;
  size: number;
  paramId: string;
}) {
  const param = useBoundDesignParam(paramId);
  const stateIndex = param
    ? clamp(
        Math.round(param.value - param.min),
        0,
        NAM_REVERB_VOICE_SELECTOR_ROTATIONS.length - 1,
      )
    : 0;
  return (
    <>
      <span
        className="four-position-selector-detents"
        style={{ left: `${x}%`, top: `${y}%`, width: `${size * 1.42}%` }}
        data-nam-four-position-selector-px={NAM_REVERB_VOICE_SELECTOR_PX}
        data-selector-state={stateIndex}
        aria-hidden="true"
      >
        {NAM_REVERB_VOICE_SELECTOR_ROTATIONS.map((rotation, index) => {
          const detent = namReverbVoiceSelectorDetentPlacement(rotation);
          return (
            <i
              key={rotation}
              data-active={index === stateIndex}
              style={{
                left: `${detent.x}%`,
                top: `${detent.y}%`,
                transform: `translate(-50%, -50%) rotate(${detent.rotation}deg)`,
              }}
            />
          );
        })}
      </span>
      <AssetControl
        assetId={CONTROLS.knobBlueSteel}
        className="knob blue-steel enum-position-rotary four-position-rotary"
        x={x}
        y={y}
        size={size}
        paramId={paramId}
        interaction="button"
        hitSize={size * 1.5}
        enableButtonDrag
        stateRotations={NAM_REVERB_VOICE_SELECTOR_ROTATIONS}
        hardwareKind="toggle"
        onButtonClick={(boundParam, commitValue) => {
          commitValue(cycleNAMDesignEnumValue(boundParam));
        }}
      />
    </>
  );
}

function ReverbVoiceDisplay({ paramId }: { paramId: string }) {
  const param = useBoundDesignParam(paramId);
  return (
    <span aria-hidden="true">
      {reverbVoiceDisplayLabel(param?.value ?? 0, param?.min ?? 0)}
    </span>
  );
}

function CompressorHPFReadout({
  x,
  y,
  w,
  h,
  paramId,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  paramId: string;
}) {
  const param = useBoundDesignParam(paramId);
  const valueLabel = compressorHpfDisplayLabel(
    param?.value ?? 0,
    param?.min ?? 0,
  );
  return (
    <div
      className="compressor-hpf-readout"
      style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}
      data-param-id={paramId}
      data-param-value={param?.value ?? 0}
      aria-label={`HPF ${param ? formatParamValue(param) : valueLabel}`}
    >
      <span>HPF</span>
      <strong>{valueLabel}</strong>
    </div>
  );
}

function CompressorIntensityReadout({
  x,
  y,
  w,
  h,
  paramId,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  paramId: string;
}) {
  const param = useBoundDesignParam(paramId);
  const valueLabel = compressorIntensityDisplayLabel(param?.value ?? 0);
  return (
    <div
      className="compressor-hpf-readout compressor-intensity-readout"
      style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}
      data-param-id={paramId}
      data-param-value={param?.value ?? 0}
      aria-label={`Compressor ratio ${valueLabel}`}
    >
      <strong>{valueLabel}</strong>
    </div>
  );
}

function Display({
  children,
  x,
  y,
  w,
  h,
  className = "",
}: {
  children: ReactNode;
  x: number;
  y: number;
  w: number;
  h: number;
  className?: string;
}) {
  return (
    <div
      className={`module-display ${className}`.trim()}
      style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}
    >
      {children}
    </div>
  );
}

function CompressorGainReductionMeter({
  x,
  y,
  w,
  h,
  gainReductionDb,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  gainReductionDb: number;
}) {
  const safeDb = clamp(
    Number.isFinite(gainReductionDb) ? gainReductionDb : 0,
    -36,
    0,
  );
  const reduction = Math.abs(safeDb);
  const thresholds = [1, 3, 6, 10, 15, 20] as const;
  return (
    <div
      className="compressor-gr-meter"
      style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}
      data-gain-reduction-db={safeDb.toFixed(1)}
      title={`Gain reduction: ${reduction.toFixed(1)} dB`}
      role="meter"
      aria-label="Compressor gain reduction"
      aria-valuemin={0}
      aria-valuemax={36}
      aria-valuenow={Number(reduction.toFixed(1))}
    >
      <span className="compressor-gr-label">GR</span>
      <span className="compressor-gr-segments" aria-hidden="true">
        {thresholds.map((threshold) => (
          <i key={threshold} data-active={reduction >= threshold} />
        ))}
      </span>
      <strong>{reduction.toFixed(1)}</strong>
    </div>
  );
}

export function ButtonPlate({
  children,
  x,
  y,
  w,
  h,
  hot = false,
  paramId,
  className = "",
}: {
  children?: ReactNode;
  x: number;
  y: number;
  w: number;
  h: number;
  hot?: boolean;
  paramId?: string;
  className?: string;
}) {
  const param = useBoundDesignParam(paramId);
  const commitParamValue = useDesignParamCommit(param);
  const active = param ? param.value >= (param.min + param.max) / 2 : hot;
  const valueLabel = param ? formatParamValue(param) : "";
  const isEnum = param?.type === "enum";
  return (
    <button
      type="button"
      className={`asset-button ${className} ${active ? "hot" : ""}`.trim()}
      style={percentStyle({ x: `${x}%`, y: `${y}%`, w: `${w}%`, h: `${h}%` })}
      data-param-id={param?.id}
      data-param-value={param?.value}
      disabled={!param}
      onClick={(event) => {
        event.stopPropagation();
        if (!param) return;
        commitParamValue(
          isEnum
            ? cycleNAMDesignEnumValue(param)
            : param.value >= (param.min + param.max) / 2
              ? param.min
              : param.max,
        );
      }}
      title={param ? `${param.label}: ${valueLabel}` : undefined}
      aria-label={
        param
          ? isEnum
            ? `${param.label}: ${valueLabel}`
            : param.label
          : undefined
      }
      aria-pressed={param && !isEnum ? active : undefined}
    >
      <DesignAssetImage assetId={CONTROLS.button} />
      {children && <span>{children}</span>}
    </button>
  );
}

function Fader({
  x,
  y,
  h,
  paramId,
  labelText,
  value = 52,
  className = "",
  physicalGeometry,
  showValueTooltip = false,
  capAssetId = CONTROLS.slider,
}: {
  x: number;
  y: number;
  h: number;
  paramId?: string;
  labelText?: string;
  value?: number;
  className?: string;
  physicalGeometry?: {
    hitWidthPx: number;
    hitHeightPx: number;
    trackTopPx?: number;
    trackWidthPx: number;
    trackHeightPx: number;
    capSizePx: number;
  };
  showValueTooltip?: boolean;
  capAssetId?: NAMDesignControlAssetId;
}) {
  const param = useBoundDesignParam(paramId);
  const context = useContext(DesignParamContext);
  const commitParamValue = useDesignParamCommit(param);
  const interactive = Boolean(param && context?.onParamChange);
  const faderRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number } | null>(null);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const pct = param ? normalizeParam(param) : undefined;
  const visualValue = pct === undefined ? value : (1 - pct) * 100;
  const valueLabel = param ? formatParamValue(param) : undefined;
  const pointerToValue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!param) return;
      const rect =
        (physicalGeometry
          ? trackRef.current?.getBoundingClientRect()
          : faderRef.current?.getBoundingClientRect()) ??
        event.currentTarget.getBoundingClientRect();
      const nextPct = clampNumber(
        1 - (event.clientY - rect.top) / Math.max(rect.height, 1),
        0,
        1,
      );
      commitParamValue(denormalizeParamValue(param, nextPct));
    },
    [commitParamValue, param, physicalGeometry],
  );
  const dragToValue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId)
        return;
      pointerToValue(event);
    },
    [pointerToValue],
  );
  return (
    <>
      <div
        className={`fader ${className} ${physicalGeometry ? "physical-fader" : ""} ${interactive ? "interactive" : ""}`.trim()}
        style={percentStyle({
          x: `${x}%`,
          y: `${y}%`,
          h: physicalGeometry ? `${physicalGeometry.hitHeightPx}px` : `${h}%`,
          value: `${visualValue}%`,
          ...(physicalGeometry
            ? {
                "fader-hit-width": `${physicalGeometry.hitWidthPx}px`,
                "fader-track-top": `${physicalGeometry.trackTopPx ?? 0}px`,
                "fader-track-width": `${physicalGeometry.trackWidthPx}px`,
                "fader-track-height": `${physicalGeometry.trackHeightPx}px`,
                "fader-cap-size": `${physicalGeometry.capSizePx}px`,
              }
            : {}),
        })}
        data-param-id={param?.id}
        data-param-value={param?.value}
        role={interactive ? "slider" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={param?.label ?? labelText}
        aria-valuemin={param?.min}
        aria-valuemax={param?.max}
        aria-valuenow={param?.value}
        aria-valuetext={valueLabel}
        title={
          param && !showValueTooltip ? `${param.label}: ${valueLabel}` : undefined
        }
        ref={faderRef}
        onPointerDown={(event) => {
          if (!interactive || !param || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          pointerToValue(event);
          dragRef.current = { pointerId: event.pointerId };
          if (showValueTooltip) setFeedbackVisible(true);
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
        onPointerEnter={() => {
          if (showValueTooltip && interactive) setFeedbackVisible(true);
        }}
        onPointerLeave={() => {
          if (showValueTooltip && !dragRef.current) setFeedbackVisible(false);
        }}
        onFocus={() => {
          if (showValueTooltip && interactive) setFeedbackVisible(true);
        }}
        onBlur={() => {
          if (showValueTooltip) setFeedbackVisible(false);
        }}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId)
            dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onWheel={(event) => {
          if (!interactive || !param) return;
          const gesture = resolveProfiledParameterWheel(event.nativeEvent, "control");
          if (gesture.preventDefault) event.preventDefault();
          if (gesture.stopPropagation) event.stopPropagation();
          if (gesture.operation !== "adjust") return;
          const stepCount = getParameterWheelStepCount(gesture);
          if (stepCount === 0) return;
          commitParamValue(
            offsetParamValue(
              param,
              param.value,
              stepCount,
            ),
          );
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
            commitParamValue(offsetParamValue(param, param.value, fine));
          } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
            event.preventDefault();
            commitParamValue(offsetParamValue(param, param.value, -fine));
          } else if (event.key === "PageUp") {
            event.preventDefault();
            commitParamValue(offsetParamValue(param, param.value, 8));
          } else if (event.key === "PageDown") {
            event.preventDefault();
            commitParamValue(offsetParamValue(param, param.value, -8));
          } else if (event.key === "Home") {
            event.preventDefault();
            commitParamValue(param.min);
          } else if (event.key === "End") {
            event.preventDefault();
            commitParamValue(param.max);
          }
        }}
      >
        <div className="fader-track" ref={trackRef}>
          {physicalGeometry ? (
            <DesignAssetImage assetId={capAssetId} className="fader-cap" />
          ) : null}
        </div>
        {!physicalGeometry ? (
          <DesignAssetImage assetId={capAssetId} className="fader-cap" />
        ) : null}
      </div>
      {labelText && (
        <Label
          x={x}
          y={y + h / 2 + 8}
          className={`control-label dark ${className ? `${className}-label` : ""}`.trim()}
        >
          {labelText}
        </Label>
      )}
      {showValueTooltip && param ? (
        <NAMRackControlTooltip
          anchor={faderRef.current}
          open={feedbackVisible}
          label={param.label}
          value={valueLabel}
          kind="value"
        />
      ) : null}
    </>
  );
}

function HorizontalMiniFader({
  x,
  y,
  w,
  h,
  paramId,
  semanticLabel,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  paramId: string;
  semanticLabel: string;
}) {
  const param = useBoundDesignParam(paramId);
  const context = useContext(DesignParamContext);
  const commitParamValue = useDesignParamCommit(param);
  const hitRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number } | null>(null);
  const activityRef = useRef({ hovered: false, focused: false, dragging: false });
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const interactive = Boolean(param && context?.onParamChange);
  const pct = param ? normalizeParam(param) : 0.5;
  const valueLabel = param ? formatParamValue(param) : "0.0 dB";

  const updateFeedback = useCallback(
    (activity: keyof typeof activityRef.current, active: boolean) => {
      activityRef.current[activity] = active;
      setFeedbackVisible(Object.values(activityRef.current).some(Boolean));
    },
    [],
  );
  const pointerToValue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!param) return;
      const rect =
        hitRef.current?.getBoundingClientRect() ??
        event.currentTarget.getBoundingClientRect();
      const nextPct = clampNumber(
        (event.clientX - rect.left) / Math.max(rect.width, 1),
        0,
        1,
      );
      commitParamValue(denormalizeParamValue(param, nextPct));
    },
    [commitParamValue, param],
  );

  return (
    <>
      <div
        ref={hitRef}
        className={`horizontal-mini-fader ${interactive ? "interactive" : ""}`.trim()}
        style={
          {
            left: `${x - w / 2}%`,
            top: `${y - h / 2}%`,
            width: `${w}%`,
            height: `${h}%`,
            "--horizontal-fader-track-inset": `${NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderTrackInsetPercent}%`,
            "--horizontal-fader-value": `${NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderCapMinPercent + pct * NAM_EQ_BOOST_FACEPLATE_LAYOUT.faderCapTravelPercent}%`,
          } as NativeStyle
        }
        data-param-id={param?.id ?? paramId}
        data-param-value={param?.value}
        role={interactive ? "slider" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={param?.label ?? semanticLabel}
        aria-valuemin={param?.min}
        aria-valuemax={param?.max}
        aria-valuenow={param?.value}
        aria-valuetext={valueLabel}
        title={param ? `${semanticLabel}: ${valueLabel}` : semanticLabel}
        onPointerEnter={() => updateFeedback("hovered", true)}
        onPointerLeave={() => updateFeedback("hovered", false)}
        onFocus={(event) => {
          updateFeedback("focused", true);
          revealControlInNearestStageScroller(event.currentTarget);
        }}
        onBlur={() => updateFeedback("focused", false)}
        onPointerDown={(event) => {
          if (!interactive || !param || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          pointerToValue(event);
          dragRef.current = { pointerId: event.pointerId };
          updateFeedback("dragging", true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          event.stopPropagation();
          pointerToValue(event);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            pointerToValue(event);
            dragRef.current = null;
            updateFeedback("dragging", false);
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            updateFeedback("dragging", false);
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onWheel={(event) => {
          if (!interactive || !param) return;
          const gesture = resolveProfiledParameterWheel(event.nativeEvent, "control");
          if (gesture.preventDefault) event.preventDefault();
          if (gesture.stopPropagation) event.stopPropagation();
          if (gesture.operation !== "adjust") return;
          const steps = getParameterWheelStepCount(gesture);
          if (steps !== 0)
            commitParamValue(offsetParamValue(param, param.value, steps));
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
          if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            commitParamValue(offsetParamValue(param, param.value, fine));
          } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            commitParamValue(offsetParamValue(param, param.value, -fine));
          } else if (event.key === "Home") {
            event.preventDefault();
            commitParamValue(param.min);
          } else if (event.key === "End") {
            event.preventDefault();
            commitParamValue(param.max);
          }
        }}
      >
        <span className="horizontal-mini-fader-track" aria-hidden="true" />
        <DesignAssetImage
          assetId={CONTROLS.slider}
          className="horizontal-mini-fader-cap"
        />
      </div>
      <NAMRackControlTooltip
        anchor={hitRef.current}
        open={feedbackVisible && interactive}
        label={semanticLabel}
        value={valueLabel}
        kind="value"
      />
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
      <div
        className="module-frame"
        style={
          frameMode === "asset" && bodyFit !== "fill"
            ? assetFrameStyle(box, body)
            : { inset: 0 }
        }
      >
        <DesignAssetImage
          assetId={body}
          className="module-skin"
          style={{ objectFit: bodyFit }}
        />
        {children}
        {title && (
          <div
            className="module-title"
            style={titleY ? { top: `${titleY}%` } : undefined}
          >
            {title}
          </div>
        )}
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
  className = "",
  children,
}: {
  box: DesignBox;
  name: string;
  tone?: keyof Pick<typeof BODIES, "blue" | "dark" | "olive" | "red" | "stone">;
  body?: NAMDesignBodyAssetId;
  bodyFit?: "contain" | "fill";
  title: string;
  titleY: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Module
      box={box}
      name={name}
      body={body ?? BODIES[tone ?? "dark"]}
      bodyFit={bodyFit}
      className={`stompbox ${className}`.trim()}
      title={title}
      titleY={titleY}
    >
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
    <Module
      box={box}
      name={name}
      body={body}
      className={`wide-pedal ${className}`.trim()}
      bodyFit="contain"
      title={title}
      titleY={titleY}
    >
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
  inputLeftLevelDb,
  inputRightLevelDb,
  outputLeftLevelDb,
  outputRightLevelDb,
  inputChannelCount = 1,
  oversamplingFactor = 4,
  oversamplingBusy = false,
  onOversamplingFactorChange,
  onEnterSection,
  onOpenLibrary,
  onPreviousPreset,
  onNextPreset,
  previousPresetLabel,
  nextPresetLabel,
  onSaveTone,
  onOpenPresetManager,
  onRecallCompare,
  utilityControls,
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
  inputLeftLevelDb?: number;
  inputRightLevelDb?: number;
  outputLeftLevelDb?: number;
  outputRightLevelDb?: number;
  inputChannelCount?: number;
  oversamplingFactor?: NAMRackOversamplingFactor;
  oversamplingBusy?: boolean;
  onOversamplingFactorChange?: (factor: NAMRackOversamplingFactor) => void;
  onEnterSection?: (sectionId: DesignSectionId) => void;
  onOpenLibrary?: () => void;
  onPreviousPreset?: () => void;
  onNextPreset?: () => void;
  previousPresetLabel?: string;
  nextPresetLabel?: string;
  onSaveTone?: () => void;
  onOpenPresetManager?: () => void;
  onRecallCompare?: (slot: "A" | "B") => void;
  utilityControls?: NAMRackDesignUtilityControls;
}) {
  const displayPresetName = presetName.replace(/^Current Capture\s*·\s*/i, "");
  const sections: Array<{
    label: string;
    shortLabel: string;
    id: DesignSectionId;
    icon: ReactNode;
  }> = [
    {
      label: "PEDALS",
      shortLabel: "PEDALS",
      id: "pre",
      icon: <PedalStageIcon />,
    },
    { label: "AMP", shortLabel: "AMP", id: "amp", icon: <AmpStageIcon /> },
    { label: "CAB", shortLabel: "CAB", id: "cab", icon: <CabStageIcon /> },
    {
      label: "EQ",
      shortLabel: "EQ",
      id: "eq",
      icon: <SlidersHorizontal aria-hidden="true" />,
    },
    {
      label: "POST FX",
      shortLabel: "POST",
      id: "post",
      icon: <Gauge aria-hidden="true" />,
    },
  ];
  return (
    <>
      <div
        className="nam-header-row flex min-w-0 items-center"
        data-qa="nam-header-row"
      >
        <div
          className="global-block left flex min-w-max shrink-0 items-center justify-start"
          data-qa="nam-input-control-bay"
        >
          <CompactLevelMeter
            meterId="input"
            label="Pre-trim input level"
            levelDb={inputLevelDb}
            channelLevelsDb={[inputLeftLevelDb, inputRightLevelDb]}
            channelCount={inputChannelCount >= 2 ? 2 : 1}
          />
          <MiniParam
            name="INPUT"
            value="0.0 dB"
            kind="black"
            rot={32}
            paramId="inputTrimDb"
          />
          <MiniParam
            name="GATE"
            value="-78 dB"
            kind="black"
            rot={-14}
            paramId="gateThresholdDb"
          />
        </div>
        <div className="preset-area flex min-w-0 flex-1 items-center">
          {utilityControls ? (
            <PremiumHeaderUtility controls={utilityControls} />
          ) : null}
          <div className="preset-context">
            <i />
            {previewText}
          </div>
          <div className="preset-console order-1 min-w-0 flex-1">
            <button
              type="button"
              className="preset-arrow"
              data-qa="nam-preset-previous"
              onClick={onPreviousPreset}
              disabled={!onPreviousPreset}
              title={previousPresetLabel ?? "Previous preset unavailable"}
              aria-label={previousPresetLabel ?? "Previous preset unavailable"}
            >
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
                <b>
                  {displayPresetName}
                  {presetDirty ? " · edited" : ""}
                </b>
              </button>
            ) : (
              <div className="preset-title" title={presetName}>
                <small>{presetEyebrow}</small>
                <b>
                  {displayPresetName}
                  {presetDirty ? " · edited" : ""}
                </b>
              </div>
            )}
            <button
              type="button"
              className="preset-arrow"
              data-qa="nam-preset-next"
              onClick={onNextPreset}
              disabled={!onNextPreset}
              title={nextPresetLabel ?? "Next preset unavailable"}
              aria-label={nextPresetLabel ?? "Next preset unavailable"}
            >
              <ArrowRight aria-hidden="true" />
            </button>
            <button
              type="button"
              className="preset-save"
              onClick={onSaveTone}
              disabled={!onSaveTone}
              title="Save Preset"
              aria-label="Save Preset"
            >
              <Save aria-hidden="true" />
              <span>Save Preset</span>
            </button>
            <div
              className="premium-compare"
              role="group"
              aria-label="Compare slots"
            >
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
        <div
          className="global-block right flex min-w-max shrink-0 items-center justify-end"
          data-qa="nam-output-control-bay"
        >
          {utilityControls ? <PremiumInstrumentProfileSwitch /> : null}
          <MiniParam
            name="OUTPUT"
            value="-1.3 dB"
            kind="black"
            rot={35}
            paramId="outputTrimDb"
          />
          {onOversamplingFactorChange ? (
            <PremiumOversamplingSelector
              factor={oversamplingFactor}
              busy={oversamplingBusy}
              onFactorChange={onOversamplingFactorChange}
            />
          ) : null}
          <CompactLevelMeter
            meterId="output"
            label="Output level"
            levelDb={outputLevelDb}
            channelLevelsDb={[outputLeftLevelDb, outputRightLevelDb]}
            channelCount={2}
          />
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
            {index < sections.length - 1 && (
              <ChevronRight className="nav-flow-chevron" aria-hidden="true" />
            )}
          </span>
        ))}
      </div>
    </>
  );
}

function PremiumOversamplingSelector({
  factor,
  busy,
  onFactorChange,
}: {
  factor: NAMRackOversamplingFactor;
  busy: boolean;
  onFactorChange: (factor: NAMRackOversamplingFactor) => void;
}) {
  return (
    <div
      className="premium-oversampling-selector"
      data-busy={busy || undefined}
      role="radiogroup"
      aria-label="Drive oversampling for all NAM Rack instances"
      aria-busy={busy}
      title={`Drive oversampling: Precision Drive and Distortion. This application-wide setting applies to every NAM Rack instance. Higher values reduce drive-stage aliasing and increase CPU use. Current setting: ${factor}x.`}
    >
      <strong aria-hidden="true">OS</strong>
      <div className="premium-oversampling-track">
        {([8, 4, 2] as const).map((option) => (
          <button
            key={option}
            type="button"
            data-qa={`nam-oversampling-${option}x`}
            data-active={factor === option}
            role="radio"
            aria-checked={factor === option}
            aria-label={`${option}x oversampling`}
            disabled={busy}
            title={`Use ${option}x internal oversampling${option === 4 ? " (recommended)" : ""}`}
            onClick={() => onFactorChange(option)}
          >
            <i aria-hidden="true" />
            <span>{option}x</span>
          </button>
        ))}
      </div>
      <span className="premium-oversampling-stage-label" aria-hidden="true">
        DRIVE
      </span>
    </div>
  );
}

function PedalStageIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
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
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.5 6V4.2h9V6M3 7h18v12H3z" />
      <path d="M5 9h14v5H5zM5.5 16.5h.01M9 16.5h.01M12.5 16.5h.01M16 16.5h.01M19 16.5h.01" />
    </svg>
  );
}

function CabStageIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <rect x="6.5" y="5.5" width="11" height="13" rx=".8" />
      <path d="m7.5 7 9 9M11 6.5l6 6M7 11l6 6M7.5 18.5h9" opacity=".68" />
    </svg>
  );
}

function CompactLevelMeter({
  meterId,
  label,
  levelDb,
  channelLevelsDb,
  channelCount,
}: {
  meterId: "input" | "output";
  label: string;
  levelDb: number;
  channelLevelsDb: readonly [number | undefined, number | undefined];
  channelCount: 1 | 2;
}) {
  const safeLinkedDb = Number.isFinite(levelDb) ? clamp(levelDb, -90, 6) : -90;
  const safeChannelLevels = channelLevelsDb
    .slice(0, channelCount)
    .map((channelLevelDb) =>
      Number.isFinite(channelLevelDb)
        ? clamp(channelLevelDb as number, -90, 6)
        : safeLinkedDb,
    );
  // The numeric readout follows exactly the lanes being shown. In particular,
  // a configured mono input must not display an unrelated hidden bus-channel
  // peak from the legacy linked maximum.
  const displayDb = Math.max(...safeChannelLevels);
  const levelRatio = namMeterFraction(displayDb);
  const meterChannels = channelCount === 1
    ? (["mono"] as const)
    : (["left", "right"] as const);
  const levelDescription = channelCount === 1
    ? `mono peak ${safeChannelLevels[0].toFixed(1)} dBFS`
    : `left ${safeChannelLevels[0].toFixed(1)} dBFS, right ${safeChannelLevels[1].toFixed(1)} dBFS`;
  return (
    <div
      className="premium-level-meter"
      data-qa={`nam-${meterId}-peak-meter`}
      data-meter-id={meterId}
      data-clip={safeChannelLevels.some((channelLevelDb) => channelLevelDb >= 0)}
      data-channel-count={channelCount}
      data-meter-mode={channelCount === 1 ? "mono-peak" : "stereo-peak"}
      style={
        {
          "--premium-meter-ratio": levelRatio,
          "--premium-meter-pct": `${levelRatio * 100}%`,
          "--premium-meter-inset": `${(1 - levelRatio) * 100}%`,
        } as NativeStyle
      }
      title={`${label}: ${levelDescription}`}
      aria-label={`${label}: ${levelDescription}`}
    >
      <span />
      {meterChannels.map((channel, index) => {
        const channelDb = safeChannelLevels[index];
        const channelRatio = namMeterFraction(channelDb);
        return (
          <i
            key={channel}
            data-meter-channel={channel}
            data-clip={channelDb >= 0}
            aria-hidden="true"
            style={
              {
                "--premium-meter-ratio": channelRatio,
                "--premium-meter-pct": `${channelRatio * 100}%`,
                "--premium-meter-inset": `${(1 - channelRatio) * 100}%`,
              } as NativeStyle
            }
          />
        );
      })}
      <strong>{displayDb <= -71.9 ? "\u2212\u221e" : displayDb.toFixed(1)}</strong>
    </div>
  );
}

function MiniParam({
  name,
  value,
  kind,
  rot,
  paramId,
}: {
  name: string;
  value: string;
  kind: "black" | "metal";
  rot: number;
  paramId?: string;
}) {
  const param = useBoundDesignParam(paramId);
  const context = useContext(DesignParamContext);
  const readOnly = Boolean(param && !context?.onParamChange);
  return (
    <div
      className="mini-param"
      data-param-id={paramId}
      data-read-only={readOnly || undefined}
      aria-disabled={readOnly || undefined}
      title={
        readOnly
          ? `${param?.label ?? name} is read-only while the library is open. Return to the rack to edit it.`
          : undefined
      }
    >
      <Label x={50} y={7} className="dark center global-label">
        {name}
      </Label>
      <Knob kind={kind} x={50} y={47} size={54} rot={rot} paramId={paramId} />
      <strong>{param ? formatParamValue(param) : value}</strong>
    </div>
  );
}

function BoundCabRoomPercent({
  paramId,
  fallback,
}: {
  paramId: string;
  fallback: string;
}) {
  const param = useBoundDesignParam(paramId);
  return (
    <>{param ? `${Math.round(normalizeParam(param) * 100)}%` : fallback}</>
  );
}

function BoundCabFilterValue({
  paramId,
  fallback,
}: {
  paramId: "cabHPFHz" | "cabLPFHz";
  fallback: string;
}) {
  const param = useBoundDesignParam(paramId);
  if (!param) return <>{fallback}</>;
  const hz = Math.max(0, param.value);
  return (
    <>
      {paramId === "cabLPFHz" && hz >= 1000
        ? `${(hz / 1000).toFixed(1)} kHz`
        : `${Math.round(hz)}Hz`}
    </>
  );
}

function CabRoomPowerSwitch() {
  const param = useBoundDesignParam("cabRoomEnabled");
  const commit = useDesignParamCommit(param);
  const active = Boolean(param && param.value >= (param.min + param.max) / 2);

  return (
    <button
      type="button"
      className="cab-room-power-switch"
      data-param-id="cabRoomEnabled"
      data-active={active}
      aria-label={active ? "Disable Room ambience" : "Enable Room ambience"}
      aria-pressed={active}
      disabled={!param}
      onClick={() => commit(active ? 0 : 1)}
    >
      <i aria-hidden="true" />
      <span
        className="cab-room-status-led"
        data-active={active}
        aria-hidden="true"
      />
    </button>
  );
}

function PremiumInstrumentProfileSwitch() {
  const instrumentProfileParam = useBoundDesignParam("instrumentProfile");
  const commitInstrumentProfile = useDesignParamCommit(instrumentProfileParam);
  const isBassProfile = (instrumentProfileParam?.value ?? 0) >= 0.5;
  const activeProfile = isBassProfile ? "Bass" : "Guitar";
  const inactiveProfile = isBassProfile ? "Guitar" : "Bass";

  return (
    <button
      type="button"
      className="premium-output-instrument-switch"
      data-qa="nam-instrument-profile"
      data-param-id="instrumentProfile"
      data-state={isBassProfile ? "bass" : "guitar"}
      aria-label={`${activeProfile} instrument profile. Changes component voicing and compatible library filtering without overwriting controls.`}
      disabled={!instrumentProfileParam}
      title={`${activeProfile} instrument profile. Click to switch to ${inactiveProfile}.`}
      onClick={() => {
        if (!instrumentProfileParam) {
          return;
        }

        commitInstrumentProfile(isBassProfile ? 0 : 1);
      }}
    >
      <span className="premium-output-instrument-switch-title global-label">
        Inst
      </span>
      <span
        className="premium-output-instrument-switch-toggle"
        aria-hidden="true"
      >
        <span className="premium-output-instrument-switch-toggle-labels">
          <span
            className="premium-output-instrument-switch-toggle-label"
            data-label="gtr"
          >
            G
          </span>
          <span
            className="premium-output-instrument-switch-toggle-label"
            data-label="bass"
          >
            B
          </span>
        </span>
        <span className="premium-output-instrument-switch-toggle-thumb" />
      </span>
      <strong className="premium-output-instrument-switch-value">
        {activeProfile}
      </strong>
    </button>
  );
}

function PremiumHeaderUtility({
  controls,
}: {
  controls: NAMRackDesignUtilityControls;
}) {
  const doublerEnabledParam = useBoundDesignParam("cabDoublerEnabled");
  const doublerMixParam = useBoundDesignParam("cabDoublerMix");
  const doublerDelayParam = useBoundDesignParam("cabDoublerDelayMs");
  const doublerSpreadParam = useBoundDesignParam("cabDoublerSpread");
  const commitDoublerEnabled = useDesignParamCommit(doublerEnabledParam);
  const doublerActive = Boolean(
    doublerEnabledParam &&
    doublerEnabledParam.value >=
      (doublerEnabledParam.min + doublerEnabledParam.max) / 2,
  );
  const doublerPaused = controls.effectiveInputMode === 2 && doublerActive;
  const doublerMixLabel = doublerMixParam
    ? `${Math.round(normalizeParam(doublerMixParam) * 100)}%`
    : "--";
  const doublerDelayLabel = doublerDelayParam
    ? formatParamValue(doublerDelayParam)
    : "4.5 ms";
  const doublerSpreadLabel = doublerSpreadParam
    ? `${Math.round(normalizeParam(doublerSpreadParam) * 100)}%`
    : "--";
  const pausedReason =
    "Doubler is paused while the DAW track route is stereo. Its Mix, Delay, and Spread are preserved.";

  return (
    <div
      className="premium-routing-utility order-2 shrink-0"
      data-qa="nam-header-utility"
      aria-label="Doubler utility"
    >
      <section
        className="premium-doubler-utility"
        data-active={doublerActive}
        data-audible={doublerActive && !doublerPaused}
        data-paused={doublerPaused}
        aria-label="Doubler"
      >
        <div className="premium-doubler-power-group">
          <span className="premium-utility-heading">Doubler</span>
          <button
            type="button"
            className="premium-doubler-power"
            data-active={doublerActive}
            aria-pressed={doublerActive}
            disabled={!doublerEnabledParam}
            title={
              doublerPaused
                ? "Doubler is enabled but paused while the DAW track route is stereo. Its Mix, Delay, and Spread are preserved."
                : doublerActive
                  ? "Bypass Doubler"
                  : "Enable Doubler"
            }
            onClick={() =>
              doublerEnabledParam && commitDoublerEnabled(doublerActive ? 0 : 1)
            }
          >
            <Power aria-hidden="true" />
            <strong>
              {doublerPaused ? "Paused" : doublerActive ? "On" : "Off"}
            </strong>
          </button>
        </div>
        <div className="premium-utility-rotary" data-utility-rotary="mix">
          <span>Mix</span>
          <div className="premium-utility-knob-well">
            <Knob
              kind="black"
              x={50}
              y={50}
              size={92}
              rot={-102}
              paramId="cabDoublerMix"
              hitSize={96}
              allowInteraction={!doublerPaused}
              disabledReason={doublerPaused ? pausedReason : undefined}
            />
          </div>
          <strong>{doublerMixLabel}</strong>
        </div>
        <div className="premium-utility-rotary" data-utility-rotary="delay">
          <span>Delay</span>
          <div className="premium-utility-knob-well">
            <Knob
              kind="black"
              x={50}
              y={50}
              size={92}
              rot={-54}
              paramId="cabDoublerDelayMs"
              hitSize={96}
              allowInteraction={!doublerPaused}
              disabledReason={doublerPaused ? pausedReason : undefined}
            />
          </div>
          <strong>{doublerDelayLabel}</strong>
        </div>
        <div
          className="premium-utility-rotary premium-utility-rotary-spread"
          data-utility-rotary="spread"
        >
          <div className="premium-utility-knob-well">
            <Knob
              kind="black"
              x={50}
              y={50}
              size={92}
              rot={42}
              paramId="cabDoublerSpread"
              hitSize={96}
              allowInteraction={!doublerPaused}
              disabledReason={doublerPaused ? pausedReason : undefined}
            />
          </div>
          <strong>{doublerSpreadLabel}</strong>
          <span>Spread</span>
        </div>
      </section>
    </div>
  );
}

function BoundDistortionModeDisplay() {
  const param = useBoundDesignParam("chaosMode");
  return <>{distortionModeDisplayLabel(param?.value ?? 0, param?.min ?? 0)}</>;
}

function BoundParamChoice({
  paramId,
  offLabel,
  onLabel,
}: {
  paramId: string;
  offLabel: string;
  onLabel: string;
}) {
  const param = useBoundDesignParam(paramId);
  if (!param) return <>{offLabel}</>;
  return <>{param.value >= (param.min + param.max) / 2 ? onLabel : offLabel}</>;
}

const DELAY_SYNC_LABELS = ["1/4", "1/8", "1/16"] as const;
export const NAM_DELAY_MODE_DISPLAY_LABELS = [
  "Digital",
  "Tape",
  "Analog",
  "Multi",
  "Dual",
] as const;

export function delayModeDisplayLabel(value: unknown) {
  const numeric = Number(value);
  const index = Number.isFinite(numeric)
    ? clamp(Math.round(numeric), 0, NAM_DELAY_MODE_DISPLAY_LABELS.length - 1)
    : 1;
  return NAM_DELAY_MODE_DISPLAY_LABELS[index];
}

export function delaySyncDisplay(modulation: number, pingPong: boolean) {
  // The visible Mod control resolves to three deterministic tempo divisions.
  // Keep the 1.0 endpoint in the final 1/16 detent instead of overflowing
  // into the next entry of the native delay note table.
  const step = Math.min(2, Math.floor(clamp(modulation, 0, 1) * 2));
  const left = DELAY_SYNC_LABELS[step];
  const right = DELAY_SYNC_LABELS[pingPong ? Math.min(2, step + 1) : step];
  return left === right ? left : `${left} / ${right}`;
}

function BoundDelayTimeDisplay() {
  const time = useBoundDesignParam("delayTimeMs");
  const sync = useBoundDesignParam("delayTempoSync");
  const modulation = useBoundDesignParam("delayMod");
  const pingPong = useBoundDesignParam("delayPingPong");
  if ((sync?.value ?? 0) < 0.5)
    return <>{time ? formatParamValue(time) : "360 ms"}</>;
  return (
    <>
      {delaySyncDisplay(modulation?.value ?? 0, (pingPong?.value ?? 0) >= 0.5)}
    </>
  );
}

function BoundDelayModeDisplay() {
  const mode = useBoundDesignParam("delayMode");
  const option = mode?.enumOptions?.find(
    (entry) => entry.value === Math.round(mode.value),
  );
  return <>{option?.label ?? delayModeDisplayLabel(mode?.value)}</>;
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
  calibrationLabel = "No data",
  calibrationStatus = "unavailable",
  calibrationOpen = false,
  onOpenTuner,
  onOpenPedalboard,
  onOpenSettings,
  onOpenAdvanced,
  onCycleSize,
  onMaxSize,
  onOpenCalibration,
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
  calibrationLabel?: string;
  calibrationStatus?: string;
  calibrationOpen?: boolean;
  onOpenTuner?: () => void;
  onOpenPedalboard?: () => void;
  onOpenSettings?: () => void;
  onOpenAdvanced?: () => void;
  onCycleSize?: () => void;
  onMaxSize?: () => void;
  onOpenCalibration?: () => void;
}) {
  const rackSizeLabel =
    rackSizePercent >= 220
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
      <b>
        <Zap aria-hidden="true" /> NAM RACK
      </b>
      {onOpenTuner ? (
        <button
          type="button"
          data-qa="nam-premium-tuner"
          data-active={tunerOpen}
          aria-pressed={Boolean(tunerOpen)}
          onClick={onOpenTuner}
        >
          <Gauge aria-hidden="true" /> Tuner
        </button>
      ) : (
        <span className="footer-control-spacer" aria-hidden="true" />
      )}
      {onOpenPedalboard ? (
        <button
          type="button"
          data-qa="nam-premium-signal-chain"
          data-active={signalChainOpen}
          aria-pressed={signalChainOpen}
          onClick={onOpenPedalboard}
          title="Open the signal chain overview and supported ordering"
        >
          <Cable aria-hidden="true" /> Signal chain
        </button>
      ) : (
        <span className="footer-control-spacer" aria-hidden="true" />
      )}
      {onOpenSettings ? (
        <button
          type="button"
          data-qa="nam-premium-settings"
          onClick={onOpenSettings}
          title="Open OpenStudio app audio and device settings"
        >
          <Settings aria-hidden="true" /> App Audio
        </button>
      ) : (
        <span className="footer-control-spacer" aria-hidden="true" />
      )}
      {onOpenAdvanced ? (
        <button
          type="button"
          data-qa="nam-premium-advanced"
          onClick={onOpenAdvanced}
          title="Open focused controls for the current device"
        >
          <SlidersHorizontal aria-hidden="true" /> Device controls
        </button>
      ) : (
        <span className="footer-control-spacer" aria-hidden="true" />
      )}
      <i />
      <span className="footer-tempo" data-qa="nam-premium-tempo">
        Tempo{" "}
        <strong>{Number.isFinite(tempo) ? tempo.toFixed(1) : "--"} BPM</strong>
      </span>
      <span>{timeSignatureLabel}</span>
      <i />
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
      <i />
      <span className="footer-runtime">
        {sampleRateLabel !== "--" && <strong>{sampleRateLabel}</strong>}
        {bufferLabel !== "--" && <strong>{bufferLabel}</strong>}
        {latencyLabel !== "--" && <strong>{latencyLabel}</strong>}
        {cpuLabel !== "--" && (
          <strong data-alert={cpuAlert}>CPU {cpuLabel}</strong>
        )}
        {dspLabel !== "--" && (
          <strong data-alert={dspAlert}>DSP {dspLabel}</strong>
        )}
      </span>
      <em>
        {onCycleSize && (
          <button
            type="button"
            onClick={onCycleSize}
            title="Cycle rack display size"
          >
            Size <strong>{rackSizeLabel}</strong>
          </button>
        )}
        {onMaxSize && (
          <button
            type="button"
            onClick={onMaxSize}
            title="Maximum rack display size"
          >
            <Maximize2 aria-hidden="true" />
          </button>
        )}
      </em>
    </div>
  );
}

function AmpCaptureSelector({
  ampLabel,
  hasCapture,
  includesCab,
  missing,
  onBrowse,
  onBrowseLocal,
  onClear,
  recovery,
  faceplateStyle,
}: {
  ampLabel: string;
  hasCapture: boolean;
  includesCab: boolean;
  missing?: boolean;
  onBrowse?: () => void;
  onBrowseLocal?: () => void;
  onClear?: () => void;
  recovery?: NAMRackDesignRecovery;
  faceplateStyle?: CSSProperties;
}) {
  const libraryActionLabel = hasCapture || missing ? "Replace" : "Library";
  const displayLabel =
    hasCapture || missing ? ampLabel : "No amp capture loaded";
  const stateLabel = missing
    ? "File missing"
    : hasCapture
      ? includesCab
        ? "Full-rig \u00b7 cab embedded"
        : "Amp capture"
      : "Empty capture slot";
  return (
    <div
      className="amp-capture-nameplate"
      style={faceplateStyle}
      data-qa="nam-amp-capture-nameplate"
      data-state={missing ? "missing" : hasCapture ? "loaded" : "empty"}
      data-includes-cab={includesCab}
      role="group"
      aria-label={`${stateLabel}. Current: ${displayLabel}`}
    >
      <span className="amp-capture-brand">
        OpenStudio <small>NAM WRAPPER</small>
      </span>
      <span className="amp-capture-state">
        <i aria-hidden="true" />
        {stateLabel}
      </span>
      <strong className="amp-capture-model" title={displayLabel}>
        {displayLabel}
      </strong>
      <span
        className="amp-capture-actions"
        aria-label="Amp capture source actions"
      >
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
            {hasCapture && onClear ? (
              <button
                type="button"
                data-qa="nam-amp-capture-unload"
                data-rack-action="unload-amp-capture"
                onClick={(event) => {
                  event.stopPropagation();
                  onClear();
                }}
                title="Unload the current Amp NAM capture"
                aria-label={`Unload Amp NAM capture. Current: ${displayLabel}`}
              >
                <X aria-hidden="true" />
                Unload
              </button>
            ) : null}
          </>
        )}
      </span>
    </div>
  );
}

function PreFxStage({
  compressorGainReductionDb = 0,
}: {
  compressorGainReductionDb?: number;
}) {
  const octaverParam = useBoundDesignParam("octaverEnabled");
  const instrumentProfile = useBoundDesignParam("instrumentProfile");
  const octaverLabel = octaverParam?.label ?? "Octaver";
  const octaverHardwareTitle =
    octaverLabel === "Stereo Poly Octaver" ? "POLY OCTAVER" : "OCTAVER";
  const eqBoostLayout = NAM_EQ_BOOST_FACEPLATE_LAYOUT;
  const driveLayout = NAM_PRECISION_DRIVE_FACEPLATE_LAYOUT;
  const preEqBands = namPreEqBandsForProfile(instrumentProfile?.value);
  return (
    <>
      <Stompbox
        box={NAM_PRE_SIGNAL_LAYOUT.compressor}
        name="compressor"
        body={BODIES.blueWide}
        bodyFit="fill"
        title="COMPRESSOR"
        titleY={NAM_COMPRESSOR_FACEPLATE_LAYOUT.titleY}
      >
        <Knob
          kind="black"
          x={NAM_COMPRESSOR_FACEPLATE_LAYOUT.columns[0]}
          y={NAM_COMPRESSOR_FACEPLATE_LAYOUT.topY}
          size={NAM_COMPRESSOR_FACEPLATE_LAYOUT.knobSize}
          rot={-24}
          paramId="compressorComp"
          labelText="COMP"
          labelOffset={NAM_COMPRESSOR_FACEPLATE_LAYOUT.topLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_COMPRESSOR_FACEPLATE_LAYOUT.columns[1]}
          y={NAM_COMPRESSOR_FACEPLATE_LAYOUT.topY}
          size={NAM_COMPRESSOR_FACEPLATE_LAYOUT.knobSize}
          rot={0}
          paramId="compressorAttackMs"
          labelText="ATTACK"
          labelOffset={NAM_COMPRESSOR_FACEPLATE_LAYOUT.topLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_COMPRESSOR_FACEPLATE_LAYOUT.columns[2]}
          y={NAM_COMPRESSOR_FACEPLATE_LAYOUT.topY}
          size={NAM_COMPRESSOR_FACEPLATE_LAYOUT.knobSize}
          rot={24}
          paramId="compressorReleaseMs"
          labelText="RELEASE"
          labelOffset={NAM_COMPRESSOR_FACEPLATE_LAYOUT.topLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_COMPRESSOR_FACEPLATE_LAYOUT.columns[0]}
          y={NAM_COMPRESSOR_FACEPLATE_LAYOUT.lowerY}
          size={NAM_COMPRESSOR_FACEPLATE_LAYOUT.knobSize}
          rot={-18}
          paramId="compressorToneDb"
          labelText="TONE"
          labelOffset={NAM_COMPRESSOR_FACEPLATE_LAYOUT.lowerLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_COMPRESSOR_FACEPLATE_LAYOUT.columns[1]}
          y={NAM_COMPRESSOR_FACEPLATE_LAYOUT.lowerY}
          size={NAM_COMPRESSOR_FACEPLATE_LAYOUT.knobSize}
          rot={4}
          paramId="compressorMix"
          labelText="MIX"
          labelOffset={NAM_COMPRESSOR_FACEPLATE_LAYOUT.lowerLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_COMPRESSOR_FACEPLATE_LAYOUT.columns[2]}
          y={NAM_COMPRESSOR_FACEPLATE_LAYOUT.lowerY}
          size={NAM_COMPRESSOR_FACEPLATE_LAYOUT.knobSize}
          rot={18}
          paramId="compressorVolumeDb"
          labelText="LEVEL"
          labelOffset={NAM_COMPRESSOR_FACEPLATE_LAYOUT.lowerLabelOffset}
        />
        <ThreePositionRotarySelector
          {...NAM_COMPRESSOR_FACEPLATE_LAYOUT.hpfSelector}
          paramId="compressorSidechainHPF"
        />
        <CompressorHPFReadout
          {...NAM_COMPRESSOR_FACEPLATE_LAYOUT.hpfReadout}
          paramId="compressorSidechainHPF"
        />
        <CompressorGainReductionMeter
          {...NAM_COMPRESSOR_FACEPLATE_LAYOUT.meter}
          gainReductionDb={compressorGainReductionDb}
        />
        <CompressorIntensityReadout
          {...NAM_COMPRESSOR_FACEPLATE_LAYOUT.intensityReadout}
          paramId="compressorIntensity"
        />
        <Toggle
          {...NAM_COMPRESSOR_FACEPLATE_LAYOUT.intensityToggle}
          paramId="compressorIntensity"
        />
        <Led
          {...NAM_COMPRESSOR_FACEPLATE_LAYOUT.led}
          on
          paramId="compressorEnabled"
        />
        <Foot
          {...NAM_COMPRESSOR_FACEPLATE_LAYOUT.foot}
          paramId="compressorEnabled"
          showStateLabel
          stateLabelY={NAM_COMPRESSOR_FACEPLATE_LAYOUT.stateLabelY}
          value="Compressor on / off"
        />
      </Stompbox>
      <Stompbox
        box={NAM_PRE_SIGNAL_LAYOUT.octaver}
        name="octaver"
        tone="olive"
        title={octaverHardwareTitle}
        titleY={67.5}
      >
        <Knob
          kind="black"
          x={28}
          y={26}
          size={NAM_PRE_FX_HARDWARE_LAYOUT.octaver.knobSize}
          rot={-30}
          paramId="octaverDownMix"
          labelText="DOWN"
          labelOffset={LABEL_OFFSET.above}
        />
        <Knob
          kind="black"
          x={72}
          y={26}
          size={NAM_PRE_FX_HARDWARE_LAYOUT.octaver.knobSize}
          rot={30}
          paramId="octaverUpMix"
          labelText="UP"
          labelOffset={LABEL_OFFSET.above}
        />
        <Knob
          kind="black"
          x={50}
          y={45.5}
          size={NAM_PRE_FX_HARDWARE_LAYOUT.octaver.knobSize}
          rot={0}
          paramId="octaverDirectMix"
          labelText="DIRECT"
          labelOffset={11.5}
        />
        <Led
          x={50}
          y={74}
          on
          size={NAM_PRE_FX_HARDWARE_LAYOUT.octaver.ledSize}
          paramId="octaverEnabled"
        />
        <Foot
          x={50}
          y={88.3}
          size={NAM_PRE_FX_HARDWARE_LAYOUT.octaver.footSize}
          paramId="octaverEnabled"
          hitSize={23}
          showStateLabel
          stateLabelY={79.5}
          value={`${octaverLabel} on / off`}
        />
      </Stompbox>
      <Stompbox
        box={NAM_PRE_SIGNAL_LAYOUT.eqBoost}
        name="eq-boost"
        body={BODIES.whiteWide}
        bodyFit="fill"
        className="eq-boost"
        title="EQ BOOST"
        titleY={eqBoostLayout.title.y}
      >
        {preEqBands.map((band, index) => (
          <span key={band.paramId} className="combined-pre-eq-band">
            <Label
              x={eqBoostLayout.bandLabelX}
              y={eqBoostLayout.bandYs[index]}
              className="combined-pre-eq-band-label combined-pre-eq-dark-label"
            >
              {band.faceplateLabel}
            </Label>
            <HorizontalMiniFader
              x={eqBoostLayout.faderX}
              y={eqBoostLayout.bandYs[index]}
              w={eqBoostLayout.faderWidth}
              h={eqBoostLayout.faderHeight}
              paramId={band.paramId}
              semanticLabel={`${band.accessibleLabel} EQ Boost`}
            />
          </span>
        ))}
        <span
          className="combined-pre-eq-filter-icon combined-pre-eq-filter-icon-hpf"
          style={{
            left: `${eqBoostLayout.hpf.x}%`,
            top: `${eqBoostLayout.hpf.iconY}%`,
          }}
          aria-hidden="true"
        />
        <PreEqFilterKnob
          x={eqBoostLayout.hpf.x}
          y={eqBoostLayout.hpf.y}
          size={eqBoostLayout.filterSize}
          hitSize={eqBoostLayout.filterHitSize}
          rot={-32}
          paramId="preEqHPFHz"
          semanticLabel="EQ Boost high-pass filter"
        />
        <span
          className="combined-pre-eq-filter-icon combined-pre-eq-filter-icon-lpf"
          style={{
            left: `${eqBoostLayout.lpf.x}%`,
            top: `${eqBoostLayout.lpf.iconY}%`,
          }}
          aria-hidden="true"
        />
        <PreEqFilterKnob
          x={eqBoostLayout.lpf.x}
          y={eqBoostLayout.lpf.y}
          size={eqBoostLayout.filterSize}
          hitSize={eqBoostLayout.filterHitSize}
          rot={32}
          paramId="preEqLPFHz"
          semanticLabel="EQ Boost low-pass filter"
        />
        <Led
          {...eqBoostLayout.led}
          on
          paramId="preEqEnabled"
        />
        <Foot
          {...eqBoostLayout.foot}
          paramId="preEqEnabled"
          showStateLabel
          stateLabelY={eqBoostLayout.stateLabelY}
          value="EQ Boost on / off"
        />
      </Stompbox>
      <Stompbox
        box={NAM_PRE_SIGNAL_LAYOUT.precisionDrive}
        name="precision-drive"
        tone="stone"
        title="PRECISION DRIVE"
        titleY={driveLayout.titleY}
      >
        <Knob
          kind="black"
          x={driveLayout.columns[0]}
          y={driveLayout.topY}
          size={driveLayout.knobSize}
          hitSize={driveLayout.knobHitSize}
          rot={-22}
          paramId="precisionDriveDrive"
          labelText="DRIVE"
          labelOffset={LABEL_OFFSET.above}
        />
        <Knob
          kind="black"
          x={driveLayout.columns[1]}
          y={driveLayout.topY}
          size={driveLayout.knobSize}
          hitSize={driveLayout.knobHitSize}
          rot={22}
          paramId="precisionDriveVolumeDb"
          labelText="LEVEL"
          labelOffset={LABEL_OFFSET.above}
        />
        <CompactKnob
          kind="black"
          x={driveLayout.gate.x}
          y={driveLayout.gate.y}
          size={driveLayout.gate.size}
          hitSize={driveLayout.gate.hitSize}
          rot={-12}
          paramId="precisionDriveGate"
          semanticLabel="Drive Gate"
          labelText=""
        />
        <Label
          x={driveLayout.gate.x}
          y={driveLayout.gateLabelY}
          className="combined-drive-gate-label"
        >
          GATE
        </Label>
        <Knob
          kind="black"
          x={driveLayout.columns[0]}
          y={driveLayout.lowerY}
          size={driveLayout.knobSize}
          hitSize={driveLayout.knobHitSize}
          rot={-10}
          paramId="precisionDriveBright"
          labelText="BRIGHT"
          labelOffset={LABEL_OFFSET.below}
        />
        <Knob
          kind="black"
          x={driveLayout.columns[1]}
          y={driveLayout.lowerY}
          size={driveLayout.knobSize}
          hitSize={driveLayout.knobHitSize}
          rot={16}
          paramId="precisionDriveAttack"
          labelText="ATTACK"
          labelOffset={LABEL_OFFSET.below}
        />
        <Led
          {...driveLayout.led}
          on
          paramId="precisionDriveEnabled"
        />
        <Foot
          {...driveLayout.foot}
          paramId="precisionDriveEnabled"
          showStateLabel
          stateLabelY={79.4}
          value="Precision Drive on / off"
        />
      </Stompbox>
      <Stompbox
        box={NAM_PRE_SIGNAL_LAYOUT.distortion}
        name="distortion"
        body={BODIES.redWide}
        bodyFit="fill"
        title="DISTORTION"
        titleY={NAM_DISTORTION_FACEPLATE_LAYOUT.titleY}
      >
        <Knob
          kind="black"
          x={NAM_DISTORTION_FACEPLATE_LAYOUT.columns[0]}
          y={NAM_DISTORTION_FACEPLATE_LAYOUT.topY}
          size={NAM_DISTORTION_FACEPLATE_LAYOUT.topKnobSize}
          rot={22}
          paramId="chaosDrive"
          labelText="DRIVE"
          labelOffset={NAM_DISTORTION_FACEPLATE_LAYOUT.topLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_DISTORTION_FACEPLATE_LAYOUT.columns[1]}
          y={NAM_DISTORTION_FACEPLATE_LAYOUT.topY}
          size={NAM_DISTORTION_FACEPLATE_LAYOUT.gateKnobSize}
          rot={-8}
          paramId="chaosGate"
          labelText="GATE"
          labelOffset={NAM_DISTORTION_FACEPLATE_LAYOUT.topLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_DISTORTION_FACEPLATE_LAYOUT.columns[2]}
          y={NAM_DISTORTION_FACEPLATE_LAYOUT.topY}
          size={NAM_DISTORTION_FACEPLATE_LAYOUT.topKnobSize}
          rot={4}
          paramId="chaosTone"
          labelText="TONE"
          labelOffset={NAM_DISTORTION_FACEPLATE_LAYOUT.topLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_DISTORTION_FACEPLATE_LAYOUT.columns[0]}
          y={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerY}
          size={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerKnobSize}
          rot={-12}
          paramId="chaosWeight"
          labelText="WGHT"
          labelOffset={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_DISTORTION_FACEPLATE_LAYOUT.columns[1]}
          y={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerY}
          size={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerKnobSize}
          rot={18}
          paramId="chaosMix"
          labelText="MIX"
          labelOffset={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerLabelOffset}
        />
        <Knob
          kind="black"
          x={NAM_DISTORTION_FACEPLATE_LAYOUT.columns[2]}
          y={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerY}
          size={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerKnobSize}
          rot={0}
          paramId="chaosLevelDb"
          labelText="LVL"
          labelOffset={NAM_DISTORTION_FACEPLATE_LAYOUT.lowerLabelOffset}
        />
        <Display
          {...NAM_DISTORTION_FACEPLATE_LAYOUT.modeDisplay}
          className="distortion-mode-display"
        >
          <BoundDistortionModeDisplay />
        </Display>
        <ThreePositionRotarySelector
          {...NAM_DISTORTION_FACEPLATE_LAYOUT.modeSelector}
          paramId="chaosMode"
        />
        <Led
          {...NAM_DISTORTION_FACEPLATE_LAYOUT.led}
          on
          paramId="chaosEnabled"
        />
        <Foot
          {...NAM_DISTORTION_FACEPLATE_LAYOUT.foot}
          paramId="chaosEnabled"
          showStateLabel
          stateLabelY={NAM_DISTORTION_FACEPLATE_LAYOUT.stateLabelY}
          value="Distortion on / off"
        />
      </Stompbox>
    </>
  );
}

function AmpStage({
  onBrowseAmpCapture,
  onBrowseLocalAmpCapture,
  onClearAmpCapture,
  ampLabel,
  hasAmpCapture,
  ampIncludesCab,
  ampCaptureMissing,
  recovery,
}: {
  onBrowseAmpCapture?: () => void;
  onBrowseLocalAmpCapture?: () => void;
  onClearAmpCapture?: () => void;
  ampLabel: string;
  hasAmpCapture: boolean;
  ampIncludesCab: boolean;
  ampCaptureMissing: boolean;
  recovery?: NAMRackDesignRecovery;
}) {
  const layout = NAM_AMP_FACEPLATE_LAYOUT;
  const controls = [
    { kind: "toggle", paramId: "ampEnabled", label: "POWER", x: layout.powerX },
    { kind: "knob", paramId: "ampGainDb", label: "GAIN", semantic: "Capture Gain", x: layout.inputX, rot: -10 },
    { kind: "toggle", paramId: "ampBoost", label: "TIGHT", x: layout.boostX },
    { kind: "toggle", paramId: "ampVoice", label: "BRIGHT", x: layout.voiceX },
    { kind: "knob", paramId: "bassDb", label: "BASS", semantic: "Bass", x: layout.bassX, rot: -25 },
    { kind: "knob", paramId: "midDb", label: "MID", semantic: "Mid", x: layout.midX, rot: 6 },
    { kind: "knob", paramId: "trebleDb", label: "TREBLE", semantic: "Treble", x: layout.trebleX, rot: 23 },
    { kind: "knob", paramId: "presenceDb", label: "PRESENCE", semantic: "Presence", x: layout.presenceX, rot: 36 },
    { kind: "knob", paramId: "ampMix", label: "MIX", semantic: "Capture Mix", x: layout.mixX, rot: 13 },
    { kind: "knob", paramId: "ampOutputDb", label: "OUTPUT", semantic: "Output Level", x: layout.outputX, rot: 31 },
  ] as const;
  const disabledReason = !hasAmpCapture ? "Load an Amp capture." : undefined;
  return (
    <Module
      box={LAYOUT.amp.head}
      name="amp-head"
      body={BODIES.amp}
      className={`amp-head amp-head-v4 amp-head-v5 ${hasAmpCapture ? "" : "amp-capture-unavailable"}`}
      bodyFit="fill"
      controlsName="Amp"
    >
      <AmpCaptureSelector
        ampLabel={ampLabel}
        hasCapture={hasAmpCapture}
        includesCab={ampIncludesCab}
        missing={ampCaptureMissing}
        onBrowse={onBrowseAmpCapture}
        onBrowseLocal={onBrowseLocalAmpCapture}
        onClear={onClearAmpCapture}
        recovery={recovery}
        faceplateStyle={{
          left: `${layout.captureContent.x + layout.captureContent.width / 2}%`,
          top: `${layout.captureContent.y + layout.captureContent.height / 2}%`,
          width: `${layout.captureContent.width}%`,
          height: `${layout.captureContent.height}%`,
        }}
      />
      <div
        className="amp-control-rail"
        data-disabled={!hasAmpCapture}
        aria-disabled={!hasAmpCapture}
        role="group"
        aria-label={
          !hasAmpCapture
            ? "Amp controls unavailable. Load an Amp NAM capture."
            : "Amp controls"
        }
      >
        {controls.map((control) =>
          control.kind === "toggle" ? (
            <Toggle
              key={control.paramId}
              x={control.x}
              y={layout.controlY}
              size={layout.toggleSize}
              hitSize={layout.toggleHitSize}
              paramId={control.paramId}
              panelSized
              assetId={CONTROLS.togglePanel}
              allowInteraction={hasAmpCapture}
              disabledReason={disabledReason}
            />
          ) : (
            <Knob
              key={control.paramId}
              kind="black"
              x={control.x}
              y={layout.controlY}
              size={layout.knobSize}
              hitSize={layout.knobHitSize}
              rot={control.rot}
              paramId={control.paramId}
              semanticLabel={control.semantic}
              allowInteraction={hasAmpCapture}
              disabledReason={disabledReason}
              assetIdOverride={CONTROLS.knobBlackPanel}
              exactSizeVariant="panel-knob"
            />
          ),
        )}
        {[
          { paramId: "ampEnabled", x: layout.powerX },
          { paramId: "ampBoost", x: layout.boostX },
          { paramId: "ampVoice", x: layout.voiceX },
        ].map((statusLed) => (
          <Led
            key={`${statusLed.paramId}-status-led`}
            x={statusLed.x}
            y={layout.ledY}
            size={layout.ledSize}
            hitSize={layout.ledHitSize}
            on
            paramId={statusLed.paramId}
            onAssetId={CONTROLS.ledOnPanel}
            offAssetId={CONTROLS.ledOffPanel}
            exactSizeVariant="panel-led"
          />
        ))}
      </div>
    </Module>
  );
}

function CabSourceSelector({
  cabLabel,
  cabMode,
  hasRetainedExternalIR,
  onBrowseCabIR,
  onBrowseLocalCabIR,
  onBrowseAmpOnlyCapture,
}: {
  cabLabel: string;
  cabMode: NAMRackCabMode;
  hasRetainedExternalIR: boolean;
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
    ? hasRetainedExternalIR
      ? "CAB INCLUDED / IR BYPASSED"
      : "CABINET INCLUDED"
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
  const action =
    embedded || cabMode === "empty" ? onBrowseAmpOnlyCapture : onBrowseCabIR;
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
          title={
            embedded
              ? "Choose an amp-only Capture before using an external IR"
              : actionLabel
          }
        >
          {embedded || cabMode === "empty" ? (
            <Library aria-hidden="true" />
          ) : (
            <FolderOpen aria-hidden="true" />
          )}
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
  hasCabIR,
  cabRoomInputSourceAvailable,
  onBrowseCabIR,
  onBrowseLocalCabIR,
  onBrowseAmpOnlyCapture,
}: {
  cabLabel: string;
  cabMode: NAMRackCabMode;
  hasCabIR: boolean;
  cabRoomInputSourceAvailable: boolean;
  onBrowseCabIR?: () => void;
  onBrowseLocalCabIR?: () => void;
  onBrowseAmpOnlyCapture?: () => void;
}) {
  const controlsLocked = cabMode !== "loaded";
  const controlsLockedReason =
    cabMode === "embedded"
      ? "Choose an amp-only capture."
      : cabMode === "required"
        ? "Load a cabinet IR."
        : "Load an amp capture.";
  const designParamContext = useContext(DesignParamContext);
  const roomEnabledParam = useBoundDesignParam("cabRoomEnabled");
  const roomEnabled = Boolean(
    roomEnabledParam
      && roomEnabledParam.value >= (roomEnabledParam.min + roomEnabledParam.max) / 2,
  );
  const roomWaitingForCabSource = roomEnabled && !cabRoomInputSourceAvailable;
  const cabParamContext =
    controlsLocked && designParamContext
      ? { ...designParamContext, onParamChange: undefined }
      : designParamContext;
  return (
    <Module
      box={LAYOUT.cab.micPanel}
      name="mic-panel"
      body={BODIES.cabRoomIntegrated}
      className={`ir-shaper-panel cab-room-console cab-mode-${cabMode}${controlsLocked ? " cab-controls-locked" : ""}`}
      bodyFit="fill"
      controlsName="Cab / IR and Room"
    >
      <CabSourceSelector
        cabLabel={cabLabel}
        cabMode={cabMode}
        hasRetainedExternalIR={hasCabIR && cabMode === "embedded"}
        onBrowseCabIR={onBrowseCabIR}
        onBrowseLocalCabIR={onBrowseLocalCabIR}
        onBrowseAmpOnlyCapture={onBrowseAmpOnlyCapture}
      />
      <div
        className="cab-control-deck"
        data-locked={controlsLocked ? "true" : "false"}
      >
        <DesignParamContext.Provider value={cabParamContext}>
          <div className="cab-ir-primary-controls">
            <Knob
              kind="black"
              x={9.8}
              y={35.4}
              size={10}
              rot={-22}
              paramId="cabMicPosition"
              labelText="EDGE"
              labelOffset={-11.7}
              labelClass="ir-primary-label"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
              panelRotaryVariant="cabPanel"
            />
            <Knob
              kind="black"
              x={22.9}
              y={35.4}
              size={10}
              rot={-8}
              paramId="cabMicDistance"
              labelText="DAMP"
              labelOffset={-11.7}
              labelClass="ir-primary-label"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
              panelRotaryVariant="cabPanel"
            />
            <Knob
              kind="black"
              x={36}
              y={35.4}
              size={10}
              rot={12}
              paramId="cabMicBlend"
              labelText="BLEND"
              labelOffset={-11.7}
              labelClass="ir-primary-label"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
              panelRotaryVariant="cabPanel"
            />
            <Knob
              kind="black"
              x={49.1}
              y={35.4}
              size={10}
              rot={10}
              paramId="cabRoomSend"
              labelText="LOW BLOOM"
              labelOffset={-11.7}
              labelClass="ir-primary-label"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
              panelRotaryVariant="cabPanel"
            />
            <Knob
              kind="black"
              x={62.2}
              y={35.4}
              size={10}
              rot={-26}
              paramId="cabHPFHz"
              labelText="HPF"
              labelOffset={-11.7}
              labelClass="ir-primary-label"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
              panelRotaryVariant="cabPanel"
            />
            <Knob
              kind="black"
              x={75.3}
              y={35.4}
              size={10}
              rot={18}
              paramId="cabLPFHz"
              labelText="LPF"
              labelOffset={-11.7}
              labelClass="ir-primary-label"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
              panelRotaryVariant="cabPanel"
            />
            <Knob
              kind="black"
              x={88.4}
              y={35.4}
              size={10}
              rot={24}
              paramId="cabLevelDb"
              labelText="LEVEL"
              labelOffset={-11.7}
              labelClass="ir-primary-label"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
              panelRotaryVariant="cabPanel"
            />

            <Toggle
              x={9.8}
              y={51.5}
              size={4.1}
              paramId="cabEnabled"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
            />
            <Led
              x={15.5}
              y={51.5}
              on
              size={3.1}
              paramId="cabEnabled"
              value="Cabinet stage enabled"
            />
            <Knob
              kind="black"
              x={49.1}
              y={51.5}
              size={5.8}
              rot={0}
              paramId="cabPan"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
            />
            <Label x={62.2} y={51.5} className="ir-filter-value">
              <BoundCabFilterValue paramId="cabHPFHz" fallback="80Hz" />
            </Label>
            <Label x={75.3} y={51.5} className="ir-filter-value">
              <BoundCabFilterValue paramId="cabLPFHz" fallback="8.0 kHz" />
            </Label>
            <Toggle
              x={88.4}
              y={51.5}
              size={4.1}
              paramId="cabPhaseInvert"
              allowInteraction={!controlsLocked}
              disabledReason={controlsLockedReason}
            />
          </div>
        </DesignParamContext.Provider>

        <div className="cab-room-bay" data-qa="nam-cab-room-bay">
          <div className="cab-room-power-zone">
            <span className="cab-room-title">ROOM</span>
            <div className="cab-room-switch-row">
              <CabRoomPowerSwitch />
            </div>
            <span className="cab-room-state-labels">
              <i>ON</i>
              <i>OFF</i>
            </span>
          </div>
          <div className="cab-room-control cab-room-amount">
            <strong>AMOUNT</strong>
            <Knob
              kind="blue-steel"
              x={50}
              y={52}
              size={53}
              rot={-42}
              paramId="cabRoomAmount"
              hitSize={62}
              panelRotaryVariant="roomHero"
            />
            <span className="cab-room-value">
              <BoundCabRoomPercent paramId="cabRoomAmount" fallback="22%" />
            </span>
          </div>
          <div className="cab-room-control cab-room-width">
            <strong>WIDTH</strong>
            <Knob
              kind="blue-steel"
              x={50}
              y={52}
              size={53}
              rot={42}
              paramId="cabRoomWidth"
              hitSize={62}
              panelRotaryVariant="roomHero"
            />
            <span className="cab-room-value">
              <BoundCabRoomPercent paramId="cabRoomWidth" fallback="65%" />
            </span>
          </div>
          <div
            className="cab-room-purpose"
            data-status={roomWaitingForCabSource ? "no-source" : "ready"}
          >
            {roomWaitingForCabSource ? "No cab source" : "POST-CAB AMBIENCE"}
          </div>
        </div>
      </div>
    </Module>
  );
}

function EqStage() {
  const lanes = [
    { label: "65", paramId: "eq65Db", fallback: 51 },
    { label: "125", paramId: "eq125Db", fallback: 58 },
    { label: "250", paramId: "eq250Db", fallback: 47 },
    { label: "500", paramId: "eq500Db", fallback: 52 },
    { label: "1K", paramId: "eq1kDb", fallback: 58 },
    { label: "2K", paramId: "eq2kDb", fallback: 48 },
    { label: "4K", paramId: "eq4kDb", fallback: 53 },
    { label: "8K", paramId: "eq8kDb", fallback: 59 },
    { label: "16K", paramId: "eq16kDb", fallback: 45 },
  ] as const;
  const layout = NAM_GRAPHIC_EQ_FACEPLATE_LAYOUT;
  return (
    <Module
      box={LAYOUT.eq.rack}
      name="eq-rack"
      body={BODIES.eq}
      bodyFit="fill"
      className="rack-unit eq-rack eq-rack-v4"
      controlsName="Graphic EQ"
    >
      <Toggle
        {...layout.power.toggle}
        paramId="eqEnabled"
        panelSized
        assetId={CONTROLS.togglePanel}
      />
      <Led
        {...layout.power.led}
        on
        paramId="eqEnabled"
        hitSize={layout.power.led.hitSize}
        onAssetId={CONTROLS.ledOnPanel}
        offAssetId={CONTROLS.ledOffPanel}
        exactSizeVariant="panel-led"
      />
      <EqFilterKnob
        x={layout.utility.hpfX}
        y={layout.utility.hpfY}
        size={layout.utility.hpfSize}
        hitSize={layout.utility.hpfHitSize}
        rot={-135}
        paramId="eqHPFHz"
        semanticLabel="High-pass filter"
        assetId={CONTROLS.knobBlueSteelPanel}
      />
      <EqFilterKnob
        x={layout.utility.levelX}
        y={layout.utility.levelY}
        size={layout.utility.levelSize}
        hitSize={layout.utility.levelHitSize}
        rot={0}
        paramId="eqLevelDb"
        semanticLabel="Output level"
        assetId={CONTROLS.knobBlueSteelPanel}
      />
      <EqFilterKnob
        x={layout.utility.lpfX}
        y={layout.utility.lpfY}
        size={layout.utility.lpfSize}
        hitSize={layout.utility.lpfHitSize}
        rot={135}
        paramId="eqLPFHz"
        semanticLabel="Low-pass filter"
        assetId={CONTROLS.knobBlueSteelPanel}
      />
      {lanes.map((lane, index) => {
        const x = layout.laneXs[index];
        return (
          <span
            key={lane.paramId}
            className="eq-band"
          >
            <Fader
              x={x}
              y={layout.fader.y}
              h={layout.fader.travelBottom - layout.fader.travelTop}
              paramId={lane.paramId}
              value={lane.fallback}
              className="eq-fader eq-v4-fader"
              physicalGeometry={layout.fader}
              showValueTooltip
              capAssetId={CONTROLS.sliderPanel}
            />
          </span>
        );
      })}
    </Module>
  );
}

function PostFxStage() {
  const modulatorPedalMode = useBoundDesignParam("modulatorPedalMode");
  const delayTempoSync = useBoundDesignParam("delayTempoSync");
  const reverbVoice = useBoundDesignParam("reverbVoice");
  const modulatorAuto = (modulatorPedalMode?.value ?? 1) >= 0.5;
  const delaySynced = (delayTempoSync?.value ?? 0) >= 0.5;
  const reverbLabels = reverbVoiceControlLabels(
    reverbVoice?.value ?? 0,
    reverbVoice?.min ?? 0,
  );
  const postLayout = NAM_POST_FX_FACEPLATE_LAYOUT;
  return (
    <>
      <WidePedal
        box={LAYOUT.post.modulator}
        name="modulator"
        body={BODIES.copperTall}
        className={modulatorAuto ? "modulator-auto" : ""}
        title="MODULATOR"
        titleY={postLayout.modules.modulator.titleY}
      >
        <Display
          {...postLayout.modulator.modeDisplay}
          className="mod-header-display mod-mode-display"
        >
          <BoundParamChoice
            paramId="modulatorMode"
            offLabel="CHORUS"
            onLabel="FLANGER"
          />
        </Display>
        <Toggle
          x={postLayout.modulator.modeToggleX}
          y={postLayout.modulator.headerCenterY}
          size={postLayout.modulator.headerToggleSize}
          paramId="modulatorMode"
        />
        <Toggle
          x={postLayout.modulator.pedalToggleX}
          y={postLayout.modulator.headerCenterY}
          size={postLayout.modulator.headerToggleSize}
          paramId="modulatorPedalMode"
        />
        <Display
          {...postLayout.modulator.pedalModeDisplay}
          className="mod-header-display mod-pedal-mode-display"
        >
          <BoundParamChoice
            paramId="modulatorPedalMode"
            offLabel="PEDAL"
            onLabel="AUTO"
          />
        </Display>
        <Knob
          kind="black"
          x={20}
          y={postLayout.modulator.topRowY}
          size={postLayout.modulator.topKnobSize}
          rot={-25}
          paramId="chorusRateHz"
          labelText="RATE"
          labelOffset={postLayout.modulator.topLabelOffset}
          labelClass="post-label"
          value="Rate: 1.25 Hz"
        />
        <Knob
          kind="black"
          x={50}
          y={postLayout.modulator.topRowY}
          size={postLayout.modulator.topKnobSize}
          rot={10}
          paramId="modulatorPedalPosition"
          labelText="POSITION"
          labelOffset={postLayout.modulator.topLabelOffset}
          labelClass="post-label"
          value="Position: 50%"
          allowInteraction={!modulatorAuto}
          disabledReason={modulatorAuto ? "Select PEDAL mode." : undefined}
        />
        <Knob
          kind="black"
          x={80}
          y={postLayout.modulator.topRowY}
          size={postLayout.modulator.topKnobSize}
          rot={26}
          paramId="chorusDepth"
          labelText="DEPTH"
          labelOffset={postLayout.modulator.topLabelOffset}
          labelClass="post-label"
          value="Depth: 41%"
        />
        <Knob
          kind="black"
          x={20}
          y={postLayout.modulator.lowerRowY}
          size={postLayout.modulator.lowerKnobSize}
          rot={-5}
          paramId="modulatorFeedback"
          labelText="FEEDBACK"
          labelOffset={postLayout.modulator.lowerLabelOffset}
          labelClass="post-label"
          value="Feedback: 10%"
        />
        <Knob
          kind="black"
          x={80}
          y={postLayout.modulator.lowerRowY}
          size={postLayout.modulator.lowerKnobSize}
          rot={30}
          paramId="chorusMix"
          labelText="MIX"
          labelOffset={postLayout.modulator.lowerLabelOffset}
          labelClass="post-label"
          value="Mix: 30%"
        />
        <Led
          x={postLayout.modulator.primaryX}
          y={postLayout.modulator.ledY}
          on
          size={postLayout.modulator.ledSize}
          paramId="modulatorEnabled"
          value="Modulator on"
          hitSize={8.2}
        />
        <Foot
          x={postLayout.modulator.primaryX}
          y={postLayout.modulator.footY}
          size={postLayout.modulator.footSize}
          state="on"
          paramId="modulatorEnabled"
          value="Modulator on / off"
          hitSize={14.5}
          showStateLabel
          stateLabelY={postLayout.modulator.stateLabelY}
        />
        <Display
          {...postLayout.modulator.characterDisplay}
          className="mod-character-display"
        >
          <BoundParamChoice
            paramId="chorusCharacter"
            offLabel="CLEAN"
            onLabel="ENS"
          />
        </Display>
        <Toggle
          x={postLayout.modulator.secondaryX}
          y={postLayout.modulator.footY}
          size={postLayout.modulator.footerToggleSize}
          paramId="chorusCharacter"
        />
      </WidePedal>
      <WidePedal
        box={LAYOUT.post.delay}
        name="delay"
        body={BODIES.darkTallPedal}
        className={`delay-rack${delaySynced ? " delay-synced" : ""}`}
        title="STEREO DELAY"
        titleY={postLayout.modules.delay.titleY}
      >
        <Display
          x={27}
          y={postLayout.delay.headerDisplayY}
          w={46}
          h={postLayout.delay.headerDisplayH}
          className="delay-display"
        >
          <span>
            <BoundDelayTimeDisplay />
            <i aria-hidden="true">&nbsp;&middot;&nbsp;</i>
            <BoundDelayModeDisplay />
          </span>
        </Display>
        <Knob
          kind="black"
          x={18}
          y={postLayout.delay.topRowY}
          size={postLayout.delay.topKnobSize}
          rot={-15}
          paramId="delayTimeMs"
          labelText={delaySynced ? "SYNCED" : "TIME"}
          labelOffset={postLayout.delay.topLabelOffset}
          labelClass="post-label"
          value="Time: 360 ms"
          allowInteraction={!delaySynced}
          disabledReason={
            delaySynced ? "Turn SYNC off to set milliseconds." : undefined
          }
        />
        <Knob
          kind="black"
          x={50}
          y={postLayout.delay.topRowY}
          size={postLayout.delay.topKnobSize}
          rot={12}
          paramId="delayFeedback"
          labelText="FEEDBACK"
          labelOffset={postLayout.delay.topLabelOffset}
          labelClass="post-label"
          value="Feedback: 28%"
        />
        <Knob
          kind="black"
          x={82}
          y={postLayout.delay.topRowY}
          size={postLayout.delay.topKnobSize}
          rot={24}
          paramId="delayMix"
          labelText="MIX"
          labelOffset={postLayout.delay.topLabelOffset}
          labelClass="post-label"
          value="Mix: 25%"
        />
        <Knob
          kind="black"
          x={20}
          y={postLayout.delay.lowerRowY}
          size={postLayout.delay.lowerKnobSize}
          rot={-25}
          paramId="delayMod"
          labelText={delaySynced ? "DIV / MOD" : "MOD"}
          labelOffset={postLayout.delay.lowerLabelOffset}
          labelClass="post-label"
          value="Modulation: 18%"
        />
        <Knob
          kind="black"
          x={50}
          y={postLayout.delay.lowerRowY}
          size={postLayout.delay.lowerKnobSize}
          rot={5}
          paramId="delayMode"
          labelText="MODE"
          semanticLabel="Delay Voice"
          labelOffset={postLayout.delay.lowerLabelOffset}
          labelClass="post-label"
          value="Delay voice"
        />
        <Knob
          kind="black"
          x={80}
          y={postLayout.delay.lowerRowY}
          size={postLayout.delay.lowerKnobSize}
          rot={24}
          paramId="delayDucker"
          labelText="DUCKER"
          labelOffset={postLayout.delay.lowerLabelOffset}
          labelClass="post-label"
          value="Ducker: 12%"
        />
        <Led
          x={postLayout.delay.secondaryX}
          y={postLayout.delay.ledY}
          on
          size={postLayout.delay.secondaryLedSize}
          paramId="delayTempoSync"
          value="Delay sync"
          hitSize={8.2}
        />
        <Led
          x={postLayout.delay.primaryX}
          y={postLayout.delay.ledY}
          on
          size={postLayout.delay.ledSize}
          paramId="delayEnabled"
          value="Delay on"
          hitSize={8.2}
        />
        <Foot
          x={postLayout.delay.secondaryX}
          y={postLayout.delay.footY}
          size={postLayout.delay.secondaryFootSize}
          state="on"
          paramId="delayTempoSync"
          value="Tempo sync"
          hitSize={12.3}
        />
        <Foot
          x={postLayout.delay.primaryX}
          y={postLayout.delay.footY}
          size={postLayout.delay.footSize}
          state="on"
          paramId="delayEnabled"
          value="Delay on / off"
          hitSize={14.5}
          showStateLabel
          stateLabelY={postLayout.delay.stateLabelY}
        />
        <FootActionLabel
          x={postLayout.delay.secondaryX}
          y={postLayout.delay.stateLabelY}
        >
          SYNC
        </FootActionLabel>
      </WidePedal>
      <WidePedal
        box={LAYOUT.post.reverb}
        name="reverb"
        body={BODIES.blueTallPedal}
        className="reverb-wide"
        title="REVERB"
        titleY={postLayout.modules.reverb.titleY}
      >
        <Display
          {...postLayout.reverb.voiceDisplay}
          className="reverb-voice-display"
        >
          <ReverbVoiceDisplay paramId="reverbVoice" />
        </Display>
        <FourPositionRotarySelector
          {...postLayout.reverb.voiceSelector}
          paramId="reverbVoice"
        />
        <Knob
          kind="black"
          x={24}
          y={postLayout.reverb.topRowY}
          size={postLayout.reverb.topKnobSize}
          rot={-24}
          paramId="reverbPreDelayMs"
          labelText={reverbLabels.preDelay}
          semanticLabel="Pre Delay"
          labelOffset={postLayout.reverb.topLabelOffset}
          labelClass="post-label"
          value="Pre delay: 35 ms"
        />
        <Knob
          kind="black"
          x={50}
          y={postLayout.reverb.topRowY}
          size={postLayout.reverb.topKnobSize}
          rot={8}
          paramId="reverbDecaySec"
          labelText={reverbLabels.decay}
          semanticLabel={reverbLabels.decay === "SIZE" ? "Room Size" : "Decay"}
          labelOffset={postLayout.reverb.topLabelOffset}
          labelClass="post-label"
          value={reverbLabels.decay === "SIZE" ? "Room size" : "Decay: 2.4 s"}
        />
        <Knob
          kind="black"
          x={76}
          y={postLayout.reverb.topRowY}
          size={postLayout.reverb.topKnobSize}
          rot={30}
          paramId="reverbMix"
          labelText={reverbLabels.mix}
          semanticLabel="Mix"
          labelOffset={postLayout.reverb.topLabelOffset}
          labelClass="post-label"
          value="Mix: 53%"
        />
        <Knob
          kind="black"
          x={24}
          y={postLayout.reverb.lowerRowY}
          size={postLayout.reverb.lowerKnobSize}
          rot={-22}
          paramId="reverbLowCutHz"
          labelText={reverbLabels.lowCut}
          semanticLabel="Low Cut"
          labelOffset={postLayout.reverb.lowerLabelOffset}
          labelClass="post-label"
          value="Low cut: 120 Hz"
        />
        <Knob
          kind="black"
          x={50}
          y={postLayout.reverb.lowerRowY}
          size={postLayout.reverb.lowerKnobSize}
          rot={-10}
          paramId="reverbTone"
          labelText={reverbLabels.tone}
          semanticLabel={reverbLabels.tone === "DAMP" ? "Damping" : "Tone"}
          labelOffset={postLayout.reverb.lowerLabelOffset}
          labelClass="post-label"
          value={reverbLabels.tone === "DAMP" ? "Damping" : "Reverb tone"}
        />
        <Knob
          kind="black"
          x={76}
          y={postLayout.reverb.lowerRowY}
          size={postLayout.reverb.lowerKnobSize}
          rot={-135}
          paramId="reverbShimmer"
          labelText={reverbLabels.texture}
          semanticLabel={
            reverbLabels.texture === "AIR"
              ? "Air"
              : reverbLabels.texture === "MOTION"
                ? "Motion"
                : reverbLabels.texture === "EARLY"
                  ? "Early Reflections"
                  : "Shimmer"
          }
          labelOffset={postLayout.reverb.lowerLabelOffset}
          labelClass="post-label"
          value={`${reverbLabels.texture}: 0%`}
        />
        <Led
          x={postLayout.reverb.secondaryX}
          y={postLayout.reverb.ledY}
          on
          size={postLayout.reverb.secondaryLedSize}
          paramId="reverbPad"
          value="Reverb Pad"
          hitSize={8.2}
        />
        <Led
          x={postLayout.reverb.primaryX}
          y={postLayout.reverb.ledY}
          on
          size={postLayout.reverb.ledSize}
          paramId="reverbEnabled"
          value="Reverb on"
          hitSize={8.2}
        />
        <Toggle
          x={postLayout.reverb.secondaryX}
          y={postLayout.reverb.footY}
          size={postLayout.reverb.padToggleSize}
          paramId="reverbPad"
        />
        <Foot
          x={postLayout.reverb.primaryX}
          y={postLayout.reverb.footY}
          size={postLayout.reverb.footSize}
          state="on"
          paramId="reverbEnabled"
          value="Reverb on / off"
          hitSize={14.5}
          showStateLabel
          stateLabelY={postLayout.reverb.stateLabelY}
        />
        <Label
          x={postLayout.reverb.secondaryX}
          y={postLayout.reverb.stateLabelY}
          className="post-label"
        >
          PAD
        </Label>
      </WidePedal>
    </>
  );
}

function SectionStage({
  sectionId,
  compressorGainReductionDb,
  onBrowseAmpCapture,
  onBrowseLocalAmpCapture,
  onClearAmpCapture,
  onBrowseAmpOnlyCapture,
  onBrowseCabIR,
  onBrowseLocalCabIR,
  rig,
  recovery,
}: {
  sectionId: DesignSectionId;
  compressorGainReductionDb?: number;
  onBrowseAmpCapture?: () => void;
  onBrowseLocalAmpCapture?: () => void;
  onClearAmpCapture?: () => void;
  onBrowseAmpOnlyCapture?: () => void;
  onBrowseCabIR?: () => void;
  onBrowseLocalCabIR?: () => void;
  rig: NAMRackDesignRigSummary;
  recovery?: NAMRackDesignRecovery;
}) {
  if (sectionId === "pre")
    return <PreFxStage compressorGainReductionDb={compressorGainReductionDb} />;
  if (sectionId === "cab")
    return (
      <CabStage
        cabLabel={rig.cabLabel}
        cabMode={rig.cabMode}
        hasCabIR={rig.hasCabIR}
        cabRoomInputSourceAvailable={rig.cabRoomInputSourceAvailable ?? true}
        onBrowseCabIR={onBrowseCabIR}
        onBrowseLocalCabIR={onBrowseLocalCabIR}
        onBrowseAmpOnlyCapture={onBrowseAmpOnlyCapture}
      />
    );
  if (sectionId === "eq") return <EqStage />;
  if (sectionId === "post") return <PostFxStage />;
  return (
    <AmpStage
      onBrowseAmpCapture={onBrowseAmpCapture}
      onBrowseLocalAmpCapture={onBrowseLocalAmpCapture}
      onClearAmpCapture={onClearAmpCapture}
      ampLabel={rig.ampLabel}
      hasAmpCapture={rig.hasAmpCapture}
      ampIncludesCab={rig.cabMode === "embedded"}
      ampCaptureMissing={rig.ampCaptureMissing}
      recovery={recovery}
    />
  );
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
  const extraAttrs =
    attr === 'data-supported-pedal="true"'
      ? { "data-supported-pedal": "true" }
      : {};
  return (
    <button
      type="button"
      data-active={Boolean(active)}
      aria-pressed={active === undefined ? undefined : active}
      data-source-flow-value={value}
      {...extraAttrs}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ToneResultRow({
  item,
  onSelect,
  onAction,
  onFavorite,
  disabled = false,
}: {
  item: NAMSourceFlowDesignResult;
  onSelect: () => void;
  onAction: () => void;
  onFavorite: () => void;
  disabled?: boolean;
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
        {item.artUrl ? (
          <img src={item.artUrl} alt="" />
        ) : (
          <span>{item.kind.slice(0, 1)}</span>
        )}
      </div>
      <div className="tone-row-main">
        <strong title={item.name}>{item.name}</strong>
        <span title={rowMeta}>{rowMeta}</span>
        <div className="tone-row-tags">
          {item.tags.slice(0, 2).map((tag) => (
            <i key={tag}>{tag}</i>
          ))}
        </div>
        {item.source === "tone3000" && (
          <div className="tone-row-stats">
            <span
              title={`${item.downloads} downloads`}
              aria-label={`${item.downloads} downloads`}
            >
              <Download aria-hidden="true" />
              {item.downloads}
            </span>
            <span
              title={`${item.likes} favorites`}
              aria-label={`${item.likes} favorites`}
            >
              <Heart aria-hidden="true" />
              {item.likes}
            </span>
          </div>
        )}
      </div>
      <div className="tone-row-side">
        {item.source !== "openstudio" ? (
          <button
            type="button"
            className="tone-row-favorite"
            data-active={Boolean(item.favorite)}
            aria-pressed={Boolean(item.favorite)}
            aria-label={
              item.favorite
                ? `Remove ${item.name} from favorites`
                : `Add ${item.name} to favorites`
            }
            title={item.favorite ? "Remove favorite" : "Add favorite"}
            onClick={(event) => {
              event.stopPropagation();
              onFavorite();
            }}
            disabled={disabled}
          >
            {item.favorite ? "★" : "☆"}
          </button>
        ) : (
          <span className="tone-row-favorite-spacer" />
        )}
        <em>{item.stateLabel}</em>
        <button
          className="tone-row-action"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onAction();
          }}
          disabled={disabled}
        >
          {item.action}
        </button>
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
  const emit = (
    action: NAMSourceFlowDesignActionId,
    value = "",
    rowId = "",
  ) => {
    onAction({
      type: "nam-source-flow-design-port",
      instanceId: "native-source-flow",
      action,
      value,
      rowId,
    });
  };
  const feedListRef = useRef<HTMLDivElement | null>(null);
  const appendSentinelRef = useRef<HTMLDivElement | null>(null);
  const architectureFilters = config.filters.filter((filter) =>
    filter.id.startsWith("arch-"),
  );
  const typeFilters = config.filters.filter(
    (filter) => !filter.id.startsWith("arch-"),
  );
  const selectedTypeFilter =
    typeFilters.find((filter) => filter.active)?.id ?? "";
  const sourceResourceTerms = sourceFlowResourceTerms(config.mode);
  const sourceResourceLabel = sourceResourceTerms.label;
  const sourceResourceTitle = sourceResourceTerms.title;
  const sourceLibraryLabel = sourceResourceTerms.library;
  const resultTotal =
    config.pagination?.totalResults ?? config.resultTotal ?? config.resultCount;
  const resultSummary =
    resultTotal > config.resultCount
      ? `${config.resultCount.toLocaleString()} shown \u00b7 ${resultTotal.toLocaleString()} matches`
      : `${resultTotal.toLocaleString()} ${resultTotal === 1 ? "match" : "matches"}`;
  useEffect(() => {
    if (feedListRef.current)
      feedListRef.current.scrollTop = Math.max(0, config.initialScrollTop ?? 0);
  }, [config.sessionKey]);
  useEffect(() => {
    if (
      !config.pagination ||
      config.pagination.mode !== "live" ||
      !config.pagination.canLoadMore ||
      config.busy
    )
      return;
    return observeTONE3000AppendSentinel(
      appendSentinelRef.current,
      feedListRef.current,
      () => emit("auto-load-more"),
    );
  }, [
    config.busy,
    config.pagination?.canLoadMore,
    config.pagination?.mode,
    config.pagination?.page,
    config.pagination?.requestKey,
  ]);
  return (
    <div
      className="tone-rack-flow tone-source-flow tone-source-v2"
      data-origin={config.originId}
      data-source-mode={config.sourceMode}
      data-target-slot={config.targetSlot}
      data-library-mode="source-flow"
    >
      <section
        className="tone-source-header"
        aria-label={`${config.sourceLabel} entry and return`}
      >
        <button
          type="button"
          className="tone-return-button"
          data-return-target={config.originId}
          data-source-flow-action="return"
          onClick={() => emit("return")}
          disabled={config.busy}
          aria-busy={config.busy || undefined}
        >
          <ArrowLeft />
          {config.returnLabel}
        </button>
        <div
          className="tone-breadcrumb"
          aria-label={`${sourceLibraryLabel} breadcrumb`}
        >
          <span>
            {config.originLabel} / {sourceLibraryLabel}
          </span>
          <b>{config.sourceLabel}</b>
        </div>
        <div className="tone-connection-state" data-auth={config.authState}>
          <i />
          <span>{config.authTitle}</span>
          {config.statusAction ? (
            <button type="button" onClick={() => emit(config.statusAction!.id)}>
              {config.statusAction.label}
            </button>
          ) : null}
        </div>
      </section>
      <div className="tone-source-v2-workspace">
        <main
          className="tone-selected-stage"
          data-has-captures={Boolean(config.captures) || undefined}
          aria-label={
            config.selectedAvailable
              ? `Selected ${sourceResourceLabel}`
              : `${sourceResourceTitle} selection`
          }
        >
          <div
            className="tone-selected-visual"
            data-has-art={Boolean(config.selectedArtUrl)}
            data-source-mode={config.mode}
            data-target-slot={config.targetSlot}
          >
            {config.selectedArtUrl ? (
              <img src={config.selectedArtUrl} alt="" />
            ) : null}
            <div className="tone-selected-visual-shade" />
            <div className="tone-selected-identity">
              <span>
                {config.selectedAvailable
                  ? config.detailEyebrow
                  : `Choose ${sourceResourceLabel}`}
              </span>
              <h1>
                {config.selectedAvailable
                  ? config.selectedName
                  : config.emptyTitle}
              </h1>
              <p>
                {config.selectedAvailable
                  ? config.selectedMeta
                  : config.emptyBody}
              </p>
              <div className="tone-selected-chips">
                {config.selectedTags.slice(0, 5).map((tag) => (
                  <i key={tag}>{tag}</i>
                ))}
              </div>
            </div>
          </div>
          {config.selectedAvailable ? (
            <div className="tone-selected-info">
              <div className="tone-selected-meta">
                {config.detailMeta.slice(0, 5).map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </div>
              <div className="tone-selected-stats">
                {config.selectedStats.map((stat) => (
                  <span key={stat}>{stat}</span>
                ))}
              </div>
            </div>
          ) : null}
          {config.selectedAvailable && config.captures ? (
            <NAMToneCapturePicker
              title={config.captures.title}
              items={config.captures.items}
              selectedId={config.captures.selectedId}
              busy={config.captures.busy}
              error={config.captures.error}
              showUse
              onSelect={(rowId) => emit("select-capture", "", rowId)}
              onAudition={(rowId) => emit("preview", "", rowId)}
              onUse={(rowId) => emit("use-selection", "", rowId)}
            />
          ) : null}
          {config.selectedAvailable ? (
            <div
              className="tone-action-grid"
              aria-label={`Preview and use ${sourceResourceLabel} actions`}
              style={{
                gridTemplateColumns: `repeat(${Math.max(1, config.actions.length)}, minmax(0, 1fr))`,
                maxWidth: `${config.actions.length * 118 + Math.max(0, config.actions.length - 1) * 8}px`,
              }}
            >
              {config.actions.map((action) => (
                <button
                  key={`${action.id}-${action.label}`}
                  type="button"
                  disabled={action.disabled}
                  data-primary={Boolean(action.primary)}
                  data-source-flow-action={action.id}
                  onClick={() =>
                    emit(action.id, "", config.selectedRowId || "")
                  }
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : (
            <div
              className="tone-action-grid tone-action-grid-empty"
              aria-hidden="true"
            />
          )}
          {config.selectedAvailable ? (
            <div
              className="tone-audition-status"
              aria-label="Preview routing status"
            >
              <span>{config.statusTitle}</span>
              <b title={config.route}>{config.route}</b>
              <em>{config.statusDetail}</em>
            </div>
          ) : null}
        </main>
        <aside
          className="tone-browser-feed tone-library-panel"
          aria-label={`${config.sourceLabel} browse feed`}
        >
          <div className="tone-library-heading">
            <div>
              <span>{sourceLibraryLabel}</span>
              <strong title={config.feedTitle}>{config.feedTitle}</strong>
            </div>
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
              onKeyDown={(event) => {
                if (event.key === "Enter") emit("search");
              }}
            />
            <button
              type="button"
              aria-label={config.searchAction}
              title={config.searchAction}
              data-source-flow-action="search"
              onClick={() => emit("search")}
            >
              <ArrowRight />
            </button>
          </div>
          <div className="tone-tab-row" aria-label="Browse tabs">
            {config.tabs.map((tab, index) => (
              <SourceChip
                key={tab}
                value={tab}
                active={index === config.activeTab}
                onClick={() => emit("tab", tab)}
              >
                {tab}
              </SourceChip>
            ))}
          </div>
          <div
            className="tone-filter-row"
            aria-label="Source filters and sorting"
          >
            {typeFilters.length > 0 ? (
              <select
                aria-label={`${sourceResourceTitle} type`}
                value={selectedTypeFilter}
                onChange={(event) =>
                  event.currentTarget.value &&
                  emit("filter", event.currentTarget.value)
                }
              >
                {!selectedTypeFilter ? (
                  <option value="">All types</option>
                ) : null}
                {typeFilters.map((filter) => (
                  <option key={filter.id} value={filter.id}>
                    {filter.label}
                  </option>
                ))}
              </select>
            ) : null}
            {architectureFilters.length > 0 ? (
              <div className="tone-arch-filter">
                {architectureFilters.map((filter) => (
                  <SourceChip
                    key={filter.id}
                    value={filter.id}
                    active={filter.active}
                    onClick={() => emit("filter", filter.id)}
                  >
                    {filter.label}
                  </SourceChip>
                ))}
              </div>
            ) : null}
            <select
              aria-label={`Sort ${sourceLibraryLabel}`}
              value={config.sortValue}
              onChange={(event) => emit("sort", event.currentTarget.value)}
            >
              {config.sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {config.selectedAvailable ? (
            <div
              className="tone-compact-selection"
              aria-label={`Selected ${sourceResourceLabel} actions`}
            >
              <div className="tone-compact-selection-copy">
                <span>Selected</span>
                <strong title={config.selectedName}>
                  {config.selectedName}
                </strong>
              </div>
              <div
                className="tone-action-grid tone-compact-actions"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(1, config.actions.length)}, minmax(0, 1fr))`,
                }}
              >
                {config.actions.map((action) => (
                  <button
                    key={`compact-${action.id}-${action.label}`}
                    type="button"
                    disabled={action.disabled}
                    data-primary={Boolean(action.primary)}
                    data-source-flow-action={action.id}
                    onClick={() =>
                      emit(action.id, "", config.selectedRowId || "")
                    }
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {config.selectedAvailable && config.captures ? (
            <div className="tone-compact-capture-picker">
              <NAMToneCapturePicker
                title={config.captures.title}
                items={config.captures.items}
                selectedId={config.captures.selectedId}
                busy={config.captures.busy}
                error={config.captures.error}
                showUse
                compact
                onSelect={(rowId) => emit("select-capture", "", rowId)}
                onAudition={(rowId) => emit("preview", "", rowId)}
                onUse={(rowId) => emit("use-selection", "", rowId)}
              />
            </div>
          ) : null}
          <div
            className="tone-feed-list"
            data-busy={config.busy}
            ref={feedListRef}
            onScroll={(event) =>
              emit("scroll", String(event.currentTarget.scrollTop))
            }
          >
            {config.busy && config.results.length === 0
              ? Array.from({ length: 5 }, (_, index) => (
                  <div className="tone-feed-skeleton" key={index} />
                ))
              : null}
            {!config.busy && config.results.length === 0 ? (
              <div className="tone-feed-empty">
                <strong>{config.emptyTitle}</strong>
                <p>{config.emptyBody}</p>
                {config.emptyAction ? (
                  <button
                    type="button"
                    data-primary={Boolean(config.emptyAction.primary)}
                    onClick={() => emit(config.emptyAction!.id)}
                  >
                    {config.emptyAction.label}
                  </button>
                ) : null}
                <button type="button" onClick={() => emit("clear-filters")}>
                  Clear filters
                </button>
              </div>
            ) : (
              config.results.map((item) => (
                <ToneResultRow
                  key={item.id}
                  item={item}
                  onSelect={() => emit("select-row", "", item.id)}
                  onAction={() => emit(item.actionId, "", item.id)}
                  onFavorite={() => emit("favorite", "", item.id)}
                  disabled={config.busy}
                />
              ))
            )}
            {config.pagination?.mode === "live" ? (
              <div
                ref={appendSentinelRef}
                className="tone-library-append-sentinel"
                data-qa="tone3000-append-sentinel"
                aria-hidden="true"
              />
            ) : null}
          </div>
          {config.pagination && config.pagination.totalPages > 1 ? (
            <div
              className="tone-library-pager"
              data-mode={config.pagination.mode}
              aria-label="Tone library pages"
            >
              <span>
                {config.resultCount.toLocaleString()} shown of{" "}
                {config.pagination.totalResults.toLocaleString()}
              </span>
              <button
                type="button"
                className="tone-library-load-more"
                disabled={config.busy || !config.pagination.canLoadMore}
                onClick={() => emit("load-more")}
                aria-label="Load more online tones"
              >
                {config.busy
                  ? "Loading"
                  : config.pagination.canLoadMore
                    ? "Load more"
                    : "All loaded"}
              </button>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function PremiumTunerStage({
  tuner,
  onClose,
}: {
  tuner: NAMRackDesignTunerSummary;
  onClose: () => void;
}) {
  const cents = Math.round(tuner.centsPct - 50);
  const liveTrackingStatus = tuner.statusLabel.startsWith("Holding")
    ? "holding pitch"
    : tuner.pitchLocked
      ? "pitch tracking"
      : tuner.signalPresent
        ? "acquiring pitch"
        : "no pitch lock";
  return (
    <section
      className="premium-tuner-stage"
      data-signal={tuner.signalPresent}
      style={
        {
          "--premium-tuner-pct": `${clamp(tuner.centsPct, 0, 100)}%`,
        } as NativeStyle
      }
      aria-label="Chromatic guitar and bass tuner"
    >
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {tuner.pitchLocked
          ? `${tuner.noteLabel}, ${liveTrackingStatus}`
          : liveTrackingStatus}
      </span>
      <button
        type="button"
        className="premium-tuner-stage-close"
        aria-label="Close tuner"
        onClick={onClose}
      >
        <X aria-hidden="true" />
        <span>Close</span>
      </button>
      <div className="premium-tuner-stage-copy">
        <span>Chromatic tuner</span>
        <strong>{tuner.noteLabel}</strong>
        <b>{tuner.statusLabel}</b>
        <em>{`${cents > 0 ? "+" : ""}${cents} cents`}</em>
      </div>
      <div
        className="premium-tuner-scale"
        aria-label={`Tuning position ${tuner.centsPct.toFixed(0)} percent`}
      >
        <div className="premium-tuner-scale-ticks" aria-hidden="true">
          {Array.from({ length: 21 }).map((_, index) => (
            <i key={index} data-major={index % 5 === 0} />
          ))}
        </div>
        <span className="premium-tuner-needle" aria-hidden="true" />
        <div className="premium-tuner-scale-labels">
          <span>-50</span>
          <span>0</span>
          <span>+50</span>
        </div>
      </div>
      <div className="premium-tuner-stage-readouts">
        <article>
          <span>Pitch</span>
          <strong>{tuner.frequencyLabel}</strong>
        </article>
        <article>
          <span>Input</span>
          <strong>{tuner.inputLevelLabel}</strong>
        </article>
        <article>
          <span>Tracking</span>
          <strong>{tuner.confidenceLabel}</strong>
        </article>
        <article>
          <span>Reference</span>
          <strong>440 Hz</strong>
        </article>
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
      <span className="premium-asset-recovery-icon" aria-hidden="true">
        <AlertTriangle />
      </span>
      <span className="premium-asset-recovery-copy">
        <small>
          {recovery.slotLabel} file unavailable
          {extraCount > 0 ? ` · ${extraCount} more missing` : ""}
        </small>
        <strong title={recovery.pathLabel}>{recovery.pathLabel}</strong>
        <em>{recovery.detail}</em>
      </span>
      <span
        className="premium-asset-recovery-actions"
        aria-label={`${recovery.slotLabel} recovery actions`}
      >
        <button
          type="button"
          onClick={recovery.onLocate}
          disabled={recovery.busy}
          title={`Locate the missing ${recovery.assetLabel}`}
        >
          <FolderOpen aria-hidden="true" />
          {recovery.busy ? "Locating" : "Locate"}
        </button>
        <button
          type="button"
          onClick={recovery.onReplace}
          disabled={recovery.busy}
          title={`Choose another ${recovery.assetLabel}`}
        >
          <Library aria-hidden="true" />
          Replace
        </button>
        <button
          type="button"
          onClick={recovery.onBypass}
          disabled={recovery.busy || recovery.bypassed}
          title={`Safely bypass the missing ${recovery.slotLabel} slot`}
        >
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
  const [visibleLibraryItemCount, setVisibleLibraryItemCount] = useState(12);
  useEffect(() => {
    setVisibleLibraryItemCount(12);
  }, [sectionId, libraryItems.length]);

  if (tunerOpen) return null;

  const installedAmpItems = libraryItems.filter((item) => item.id.startsWith("installed:"));
  const installedCabIRItems = libraryItems.filter((item) => item.id.startsWith("installed-ir:"));
  const showCabSourceItem = installedCabIRItems.length === 0
    || (rig.cabMode === "loaded" && !installedCabIRItems.some((item) => item.active));

  const sectionItems: Array<{
    id: string;
    eyebrow: string;
    label: string;
    detail: string;
    asset: NAMDesignBodyAssetId;
    active?: boolean;
    actionLabel: string;
    onClick: () => void;
  }> =
    sectionId === "cab"
      ? [
          ...(showCabSourceItem ? [{
            id: "cab-source",
            eyebrow:
              rig.cabMode === "embedded"
                ? "Full-rig Capture"
                : rig.cabMode === "loaded"
                  ? "Active IR"
                  : "Cab source needed",
            label: rig.cabLabel,
            detail: rig.cabStatus,
            asset: BODIES.cab,
            active: rig.cabMode === "embedded" || rig.cabMode === "loaded",
            actionLabel:
              rig.cabMode === "empty"
                ? "Browse Amp Captures"
                : "Choose Cabinet IR",
            onClick: () =>
              rig.cabMode === "empty"
                ? onOpenLibrary("amp")
                : onOpenLibrary("cab"),
          }] : []),
          ...installedCabIRItems.map((item) => ({
            id: item.id,
            eyebrow: item.active ? "Active cabinet IR" : "Installed cabinet IR",
            label: item.name,
            detail: item.subtitle,
            asset: BODIES.cab,
            active: item.active,
            actionLabel: `Load ${item.name}`,
            onClick: () => onSelectLibraryItem?.(item.id),
          })),
        ]
      : sectionId === "eq"
        ? [
            {
              id: "eq",
              eyebrow: "Post-cab equalizer",
              label: "Graphic EQ",
              detail: "Nine bands and output level",
              asset: BODIES.eq,
              active: true,
              actionLabel: "Open Graphic EQ controls",
              onClick: () => onOpenAdvancedStage("eq"),
            },
          ]
      : sectionId === "post"
        ? [
            {
              id: "mod",
              eyebrow: "OpenStudio effect",
              label: "Modulator",
              detail: "Chorus / flanger",
              asset: BODIES.copperWide,
              active: true,
              actionLabel: "Open Modulator controls",
              onClick: () => onOpenAdvancedStage("mod"),
            },
            {
              id: "delay",
              eyebrow: "OpenStudio effect",
              label: "Stereo Delay",
              detail: "Tempo sync · feedback · ducking",
              asset: BODIES.darkWidePedal,
              actionLabel: "Open Stereo Delay controls",
              onClick: () => onOpenAdvancedStage("delay"),
            },
            {
              id: "reverb",
              eyebrow: "OpenStudio effect",
              label: "Reverb",
              detail: "Pre-delay / decay / tone",
              asset: BODIES.blueWidePedal,
              actionLabel: "Open Reverb controls",
              onClick: () => onOpenAdvancedStage("reverb"),
            },
          ]
        : [
            ...((sectionId === "amp" && installedAmpItems.length > 0) ? [] : [{
              id: sectionId === "pre" ? "drive-pedals" : "amp-capture",
              eyebrow:
                sectionId === "pre" ? "Native pre effects" : "Amp capture",
              label:
                sectionId === "pre" ? "Precision + Distortion" : rig.ampLabel,
              detail:
                sectionId === "pre"
                  ? "Two independent pre-amp drive circuits"
                  : rig.hasAmpCapture
                    ? "Active NAM Capture"
                    : "Browse Captures or choose Local .nam",
              asset: sectionId === "pre" ? BODIES.red : BODIES.amp,
              active: sectionId === "amp" && rig.hasAmpCapture,
              actionLabel:
                sectionId === "pre"
                  ? "View drive pedals"
                  : rig.hasAmpCapture
                    ? "Open Amp controls"
                    : "Open Amp Capture Library",
              onClick: () =>
                sectionId === "pre"
                  ? onOpenAdvancedStage("precision-drive")
                  : onOpenLibrary("amp"),
            }]),
            ...(sectionId === "amp"
              ? installedAmpItems
              : libraryItems.filter((item) => !item.id.startsWith("installed:")).slice(0, 3)
            ).map((item, index) => ({
                  id: item.id,
                  eyebrow: item.id.startsWith("installed:")
                    ? item.active ? "Active amp capture" : "Installed amp capture"
                    : "Template for current capture",
                  label: item.name,
                  detail: item.subtitle,
                  asset: item.id.startsWith("installed:")
                    ? BODIES.amp
                    : (
                        [
                          BODIES.darkWide,
                          BODIES.blue,
                          BODIES.stone,
                        ] as NAMDesignBodyAssetId[]
                      )[index % 3],
                  active: item.active,
                  actionLabel: item.id.startsWith("installed:")
                    ? `Load ${item.name}`
                    : `Apply ${item.name} template`,
                  onClick: () => onSelectLibraryItem?.(item.id),
                })),
          ];
  const progressiveLibrary = sectionId === "amp" || sectionId === "cab";
  const visibleSectionItems = progressiveLibrary
    ? sectionItems.slice(0, visibleLibraryItemCount)
    : sectionItems;
  const hasMoreLibraryItems = progressiveLibrary && visibleSectionItems.length < sectionItems.length;
  const cabinetIRItemCount = installedCabIRItems.length || sectionItems.length;
  const libraryTarget =
    sectionId === "cab" &&
    (rig.cabMode === "embedded" || rig.cabMode === "empty")
      ? "amp"
      : sectionId === "eq"
        ? "post"
        : sectionId;
  const libraryTitle =
    sectionId === "cab"
      ? "Cabinet & IRs"
      : sectionId === "eq"
        ? "EQ Presets"
        : sectionId === "post"
          ? "Post Effects"
          : sectionId === "pre"
            ? "Pedals & Presets"
            : "My Amps";
  const libraryEyebrow =
    sectionId === "cab"
      ? rig.cabMode === "embedded"
        ? "Full-rig cabinet"
        : "Cabinet source"
      : sectionId === "eq"
        ? "Post-cab equalizer"
        : sectionId === "post"
          ? "Current post chain"
          : sectionId === "pre"
            ? "Pre-amp effects"
            : "Installed Amp captures";
  const librarySearchLabel =
    sectionId === "cab"
      ? rig.cabMode === "embedded"
        ? "Browse amp-only captures..."
        : rig.cabMode === "empty"
          ? "Browse amp captures..."
          : rig.cabMode === "loaded"
            ? "Replace cabinet IR..."
            : "Choose cabinet IR..."
      : sectionId === "eq"
        ? "Browse EQ presets..."
        : sectionId === "post"
          ? "Browse post-effect presets..."
          : sectionId === "pre"
            ? "Browse pedal presets..."
            : "Browse captures or choose Local .nam...";
  const libraryActionLabel =
    sectionId === "cab"
      ? rig.cabMode === "embedded"
        ? "Browse Amp-Only Captures"
        : rig.cabMode === "empty"
          ? "Browse Amp Captures"
          : rig.cabMode === "loaded"
            ? "Replace IR"
            : "Choose IR"
      : libraryTarget === "post"
        ? "Open Effect Preset Library"
        : "Open Capture Library";
  const openResolvedLibrary = () => {
    if (
      sectionId === "cab" &&
      rig.cabMode === "embedded" &&
      onBrowseAmpOnlyCapture
    ) {
      onBrowseAmpOnlyCapture();
      return;
    }
    onOpenLibrary(libraryTarget);
  };

  return (
    <aside
      className="premium-rig-drawer"
      data-cab-mode={sectionId === "cab" ? rig.cabMode : undefined}
      aria-label={`${libraryTitle} and current rack`}
    >
      <div className="premium-drawer-heading">
        <div>
          <span>{libraryEyebrow}</span>
          <strong>{libraryTitle}</strong>
        </div>
        <i aria-hidden="true" />
      </div>
      <button
        type="button"
        className="premium-library-search"
        onClick={openResolvedLibrary}
      >
        <Search aria-hidden="true" />
        <span>{librarySearchLabel}</span>
      </button>
      <div className="premium-library-filter">
        <span>
          {sectionId === "amp"
            ? "Installed captures"
            : sectionId === "cab"
              ? "Installed cabinet IRs"
            : sectionId === "pre"
              ? "Capture + templates"
              : "Loaded and supported"}
        </span>
        <strong>
          {sectionId === "amp"
            ? `${installedAmpItems.length || sectionItems.length} amps`
            : sectionId === "cab"
              ? `${cabinetIRItemCount} ${cabinetIRItemCount === 1 ? "IR" : "IRs"}`
            : `${sectionItems.length} items`}
        </strong>
      </div>
      <div
        className="premium-rig-list"
        data-progressive={progressiveLibrary || undefined}
        onScroll={(event) => {
          if (!hasMoreLibraryItems) return;
          const list = event.currentTarget;
          if (list.scrollTop + list.clientHeight >= list.scrollHeight - 96) {
            setVisibleLibraryItemCount((count) => Math.min(count + 12, sectionItems.length));
          }
        }}
      >
        {visibleSectionItems.map((item) => (
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
            <span className="premium-rig-thumb">
              <DesignAssetImage assetId={item.asset} />
            </span>
            <span className="premium-rig-copy">
              <small>{item.eyebrow}</small>
              <strong title={item.label}>{item.label}</strong>
              <em title={item.detail}>{item.detail}</em>
            </span>
            <i aria-hidden="true" />
          </button>
        ))}
        {hasMoreLibraryItems && (
          <div className="premium-rig-more" aria-live="polite">
            Scroll for {sectionItems.length - visibleSectionItems.length} more
          </div>
        )}
      </div>
      <button
        type="button"
        className="premium-library-cta"
        onClick={openResolvedLibrary}
      >
        <Library aria-hidden="true" />
        {libraryActionLabel}
      </button>
    </aside>
  );
}

export function NAMRackDesignPort({
  sectionId,
  rackSizePercent,
  parameters,
  compressorGainReductionDb,
  rig,
  runtime,
  recovery,
  tuner,
  calibration,
  utilityControls,
  oversamplingFactor = 4,
  oversamplingBusy = false,
  onOversamplingFactorChange,
  libraryItems,
  compareSlot,
  tunerOpen,
  signalChainOpen = false,
  onParamChange,
  onEnterSection,
  onOpenAdvancedStage,
  onBrowseAmpCapture,
  onBrowseLocalAmpCapture,
  onClearAmpCapture,
  onBrowseAmpOnlyCapture,
  onBrowseCabIR,
  onBrowseLocalCabIR,
  onOpenLibrary,
  onPreviousPreset,
  onNextPreset,
  previousPresetLabel,
  nextPresetLabel,
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
  compressorGainReductionDb?: number;
  rig: NAMRackDesignRigSummary;
  runtime: NAMRackDesignRuntimeStatus;
  recovery?: NAMRackDesignRecovery;
  tuner: NAMRackDesignTunerSummary;
  calibration?: NAMRackDesignCalibrationSummary;
  utilityControls?: NAMRackDesignUtilityControls;
  oversamplingFactor?: NAMRackOversamplingFactor;
  oversamplingBusy?: boolean;
  onOversamplingFactorChange?: (factor: NAMRackOversamplingFactor) => void;
  libraryItems?: NAMRackDesignLibraryItem[];
  compareSlot: "A" | "B";
  tunerOpen: boolean;
  signalChainOpen?: boolean;
  onParamChange?: DesignParamChangeHandler;
  onEnterSection: (
    sectionId: RackSectionId,
    targetModule: RackModuleId,
  ) => void;
  onOpenAdvancedStage: (stageId: NAMRackAdvancedStageId) => void;
  onBrowseAmpCapture?: () => void;
  onBrowseLocalAmpCapture?: () => void;
  onClearAmpCapture?: () => void;
  onBrowseAmpOnlyCapture?: () => void;
  onBrowseCabIR?: () => void;
  onBrowseLocalCabIR?: () => void;
  onOpenLibrary: (sectionId: RackSectionId) => void;
  onPreviousPreset?: () => void;
  onNextPreset?: () => void;
  previousPresetLabel?: string;
  nextPresetLabel?: string;
  onSaveTone: () => void;
  onOpenPresetManager?: () => void;
  onRecallCompare?: (slot: "A" | "B") => void;
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
    designSection === "amp" &&
    recovery?.slot === "amp" &&
    (recovery.additionalMissingCount ?? 0) === 0,
  );
  const recoveryInset = recovery && !inlineAmpRecovery && !tunerOpen ? 70 : 0;
  const placement = useMemo(() => {
    const availableStage =
      recoveryInset > 0
        ? {
            width: stageSize.width,
            height: Math.max(120, stageSize.height - recoveryInset),
          }
        : stageSize;
    const next = designSection === "pre"
      ? computePremiumPreStagePlacement(availableStage, rackSizePercent)
      : computePremiumStagePlacement(
          availableStage,
          SECTION_GROUP_BOX[designSection],
          rackSizePercent,
        );
    return recoveryInset > 0
      ? { ...next, top: next.top + recoveryInset }
      : next;
  }, [designSection, rackSizePercent, recoveryInset, stageSize]);
  const prePlacement = designSection === "pre"
    ? placement as ReturnType<typeof computePremiumPreStagePlacement>
    : undefined;
  const activeLabel =
    designSection === "pre"
      ? "PEDALS"
      : designSection === "post"
        ? "POST FX"
        : designSection.toUpperCase();
  const effectsDisabled =
    (designSection === "pre" ||
      designSection === "eq" ||
      designSection === "post") &&
    !rig.hasAmpCapture;
  const ampRequiredCopy =
    designSection === "eq"
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
        if (
          Math.abs(sourceParam.value - value) <=
          Math.max(stepForParam(sourceParam), 0.0001) * 0.5
        ) {
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
  const rackSectionStage = (
    <SectionStage
      sectionId={designSection}
      compressorGainReductionDb={compressorGainReductionDb}
      onBrowseAmpCapture={onBrowseAmpCapture}
      onBrowseLocalAmpCapture={onBrowseLocalAmpCapture}
      onClearAmpCapture={onClearAmpCapture}
      onBrowseAmpOnlyCapture={onBrowseAmpOnlyCapture}
      onBrowseCabIR={onBrowseCabIR}
      onBrowseLocalCabIR={onBrowseLocalCabIR}
      rig={rig}
      recovery={inlineAmpRecovery ? recovery : undefined}
    />
  );
  const rackArtboard = (
    <div
      className="nam-rack-artboard"
      data-design-board={boardId}
      data-effects-disabled={effectsDisabled}
      aria-disabled={effectsDisabled || undefined}
      style={{
        width:
          designSection === "pre"
            ? `${NAM_PRE_LOGICAL_SURFACE.width}px`
            : undefined,
        height:
          designSection === "pre"
            ? `${NAM_PRE_LOGICAL_SURFACE.height}px`
            : undefined,
        transform: `translate(${placement.left}px, ${placement.top}px) scale(${placement.scale})`,
      }}
    >
      {rackSectionStage}
    </div>
  );
  return (
    <DesignParamContext.Provider value={paramContext}>
      <section
        ref={hostRef}
        className="nam-rack-design-port nam-native-design-surface"
        data-design-board={boardId}
        data-design-section={designSection}
      >
        <div
          className="screen-shell nam-native-shell premium-nam-shell"
          data-section={designSection}
          data-tuner-open={tunerOpen}
        >
          <div className="nam-top-artboard">
            <TopShell
              active={activeLabel}
              presetName={
                rig.hasAmpCapture || rig.ampCaptureMissing
                  ? rig.presetName
                  : "Start a New Rig"
              }
              presetEyebrow={
                rig.ampCaptureMissing
                  ? "Amp Capture Missing"
                  : rig.hasAmpCapture
                    ? rig.presetEyebrow
                    : "No Amp Capture Loaded"
              }
              presetDirty={
                (rig.hasAmpCapture || rig.ampCaptureMissing) && rig.presetDirty
              }
              compareSlot={compareSlot}
              inputLevelDb={runtime.inputLevelDb}
              outputLevelDb={runtime.outputLevelDb}
              inputLeftLevelDb={runtime.inputLeftLevelDb}
              inputRightLevelDb={runtime.inputRightLevelDb}
              outputLeftLevelDb={runtime.outputLeftLevelDb}
              outputRightLevelDb={runtime.outputRightLevelDb}
              inputChannelCount={runtime.inputChannelCount}
              previewText={`${rig.ampLabel || "No Amp Capture"} \u2192 ${rig.cabLabel || "No IR loaded"}`}
              onEnterSection={(nextSection) =>
                onEnterSection(nextSection, SECTION_TARGET_MODULE[nextSection])
              }
              onOpenLibrary={() => onOpenLibrary(designSection)}
              onPreviousPreset={onPreviousPreset}
              onNextPreset={onNextPreset}
              previousPresetLabel={previousPresetLabel}
              nextPresetLabel={nextPresetLabel}
              onSaveTone={onSaveTone}
              onOpenPresetManager={onOpenPresetManager}
              onRecallCompare={onRecallCompare}
              utilityControls={utilityControls}
              oversamplingFactor={oversamplingFactor}
              oversamplingBusy={oversamplingBusy}
              onOversamplingFactorChange={onOversamplingFactorChange}
            />
          </div>
          <div className="hardware-stage" data-tuner-open={tunerOpen}>
            <div
              ref={stageRef}
              className="premium-stage-canvas"
              data-design-section={designSection}
              data-recovery={recovery && !tunerOpen ? recovery.slot : undefined}
              style={
                {
                  "--nam-studio-backdrop": `url(${STUDIO_BACKDROP_URL})`,
                } as NativeStyle
              }
            >
              {recovery && !inlineAmpRecovery && !tunerOpen ? (
                <AssetRecoveryDock recovery={recovery} />
              ) : null}
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
              ) : prePlacement ? (
                <div
                  className="nam-pre-stage-scroll"
                  data-qa="nam-pre-stage-scroll"
                  data-scroll-required={!prePlacement.fitsWithoutScroll}
                  role="region"
                  aria-label="Pre effects pedal row"
                  onWheel={(event) => {
                    if (prePlacement.fitsWithoutScroll) return;
                    const target = event.target as HTMLElement;
                    if (target.closest(".control-hit, .horizontal-mini-fader"))
                      return;
                    const delta =
                      Math.abs(event.deltaX) > Math.abs(event.deltaY)
                        ? event.deltaX
                        : event.shiftKey
                          ? event.deltaY
                          : 0;
                    if (Math.abs(delta) < 0.01) return;
                    event.preventDefault();
                    event.currentTarget.scrollLeft += delta;
                  }}
                >
                  <div
                    className="nam-pre-stage-scroll-content"
                    style={{
                      width: prePlacement.fitsWithoutScroll
                        ? "100%"
                        : `${prePlacement.contentWidth}px`,
                      height: `${Math.max(stageSize.height, prePlacement.contentHeight)}px`,
                    }}
                  >
                    {Object.entries(NAM_PRE_SIGNAL_LAYOUT).map(([name, box]) => (
                      <span
                        key={`pre-snap-${name}`}
                        className="nam-pre-stage-snap-anchor"
                        data-snap-module={name}
                        style={{
                          left: `${prePlacement.left + (box.x + box.w / 2) * prePlacement.scale}px`,
                        }}
                        aria-hidden="true"
                      />
                    ))}
                    {rackArtboard}
                  </div>
                </div>
              ) : (
                rackArtboard
              )}
              {!recovery &&
                !tunerOpen &&
                runtime.diagnosticMessage &&
                runtime.diagnosticTone &&
                runtime.diagnosticTone !== "idle" &&
                runtime.diagnosticTone !== "success" && (
                  <div
                    className="premium-stage-status"
                    data-tone={runtime.diagnosticTone ?? "idle"}
                    title={runtime.diagnosticMessage}
                  >
                    <i aria-hidden="true" />
                    <span>{runtime.diagnosticMessage}</span>
                  </div>
                )}
            </div>
            {(designSection === "amp" ||
              (designSection === "cab" && rig.cabMode !== "embedded")) && (
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
            )}
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
            calibrationLabel={calibration?.label}
            calibrationStatus={calibration?.status}
            calibrationOpen={calibration?.open}
            onOpenTuner={onOpenTuner}
            onOpenPedalboard={onOpenSignalChain ?? onOpenPedalboard}
            onOpenSettings={onOpenSettings}
            onOpenAdvanced={onOpenAdvanced}
            onCycleSize={onCycleSize}
            onMaxSize={onMaxSize}
            onOpenCalibration={onOpenCalibration}
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
  previousPresetLabel,
  nextPresetLabel,
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
  previousPresetLabel?: string;
  nextPresetLabel?: string;
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
  const readOnlyParamContext = useMemo<DesignParamContextValue>(
    () => ({
      paramsById: new Map((parameters ?? []).map((param) => [param.id, param])),
      localValues: {},
      setLocalValue: () => undefined,
    }),
    [parameters],
  );
  return (
    <DesignParamContext.Provider value={readOnlyParamContext}>
      <section
        ref={hostRef}
        className="nam-rack-design-port nam-rack-source-flow-design-port nam-native-design-surface"
        data-design-board={config.boardId}
        data-source-flow-mode={config.mode}
        style={
          {
            "--nam-studio-backdrop": `url(${STUDIO_BACKDROP_URL})`,
          } as NativeStyle
        }
      >
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
              presetEyebrow={
                presetEyebrow ??
                (presetName === "Start a New Rig"
                  ? "No Amp Capture Loaded"
                  : "Current preset")
              }
              presetDirty={presetDirty}
              compareSlot={compareSlot}
              inputLevelDb={runtime?.inputLevelDb}
              outputLevelDb={runtime?.outputLevelDb}
              inputLeftLevelDb={runtime?.inputLeftLevelDb}
              inputRightLevelDb={runtime?.inputRightLevelDb}
              outputLeftLevelDb={runtime?.outputLeftLevelDb}
              outputRightLevelDb={runtime?.outputRightLevelDb}
              inputChannelCount={runtime?.inputChannelCount}
              onEnterSection={onEnterSection}
              onOpenLibrary={onCloseLibrary}
              onPreviousPreset={onPreviousPreset}
              onNextPreset={onNextPreset}
              previousPresetLabel={previousPresetLabel}
              nextPresetLabel={nextPresetLabel}
              onSaveTone={onSavePreset}
              onOpenPresetManager={onOpenPresetManager}
              onRecallCompare={onRecallCompare}
            />
          </div>
          <div
            className="source-flow-workspace"
            data-design-board={config.boardId}
          >
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
            calibrationLabel={calibration?.label}
            calibrationStatus={calibration?.status}
            calibrationOpen={calibration?.open}
            onOpenTuner={onOpenTuner}
            onOpenPedalboard={onOpenSignalChain}
            onOpenSettings={onOpenSettings}
            onOpenAdvanced={onOpenAdvanced}
            onCycleSize={onCycleSize}
            onMaxSize={onMaxSize}
            onOpenCalibration={onOpenCalibration}
          />
        </div>
      </section>
    </DesignParamContext.Provider>
  );
}

/**
 * Intrinsic-pixel geometry for the next NAM Amp and Graphic EQ faceplates.
 *
 * This file is deliberately independent from NAMRackDesignPort.tsx.  It lets a
 * generated bitmap be measured and approved before the live controls are moved.
 * Coordinates are source-image pixels, not percentages of the surrounding
 * stage.  The visible alpha bounds are part of the contract because a control
 * can be inside the bitmap canvas while still hanging outside the painted
 * enclosure.
 */

export type IntrinsicSize = Readonly<{
  width: number;
  height: number;
}>;

export type IntrinsicPoint = Readonly<{
  x: number;
  y: number;
}>;

export type IntrinsicRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type NormalizedRect = IntrinsicRect;

export type FaceplateCircleControlKind = "knob" | "toggle" | "led";

export type FaceplateCircleControl = Readonly<{
  id: string;
  paramId: string;
  kind: FaceplateCircleControlKind;
  center: IntrinsicPoint;
  visualDiameter: number;
  hitDiameter: number;
  visualSafeZone: string;
  interactionSafeZone: string;
}>;

export type FaceplateFaderControl = Readonly<{
  id: string;
  paramId: string;
  kind: "fader";
  centerX: number;
  /** Static recess, scale marks, and zero line are rendered into the body. */
  bakedWell: IntrinsicRect;
  /** Endpoints are cap-centre coordinates, not the ends of the baked slot. */
  capTravel: Readonly<{ top: number; bottom: number }>;
  capSize: IntrinsicSize;
  hitRect: IntrinsicRect;
  visualSafeZone: string;
  interactionSafeZone: string;
}>;

export type FaceplateControl = FaceplateCircleControl | FaceplateFaderControl;

export type FaceplateManifest = Readonly<{
  id: string;
  assetSize: IntrinsicSize;
  /** Tight non-transparent bitmap bounds, measured after final export. */
  visibleAlphaBounds: IntrinsicRect;
  safeZones: Readonly<Record<string, IntrinsicRect>>;
  controls: readonly FaceplateControl[];
}>;

export type GeometryAuditIssue = Readonly<{
  code:
    | "alpha-outside-canvas"
    | "safe-zone-outside-alpha"
    | "unknown-safe-zone"
    | "visual-outside-safe-zone"
    | "hit-outside-safe-zone"
    | "duplicate-control-id";
  subject: string;
  message: string;
}>;

const EPSILON = 1e-6;

export function rectFromCenter(
  center: IntrinsicPoint,
  size: IntrinsicSize,
): IntrinsicRect {
  return {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

export function rectContainsRect(
  outer: IntrinsicRect,
  inner: IntrinsicRect,
  tolerance = EPSILON,
) {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

export function unionRects(a: IntrinsicRect, b: IntrinsicRect): IntrinsicRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function resolveNormalizedRect(
  normalized: NormalizedRect,
  parent: IntrinsicRect,
): IntrinsicRect {
  return {
    x: parent.x + normalized.x * parent.width,
    y: parent.y + normalized.y * parent.height,
    width: normalized.width * parent.width,
    height: normalized.height * parent.height,
  };
}

export function scaleRectBetweenCanvases(
  rect: IntrinsicRect,
  from: IntrinsicSize,
  to: IntrinsicSize,
): IntrinsicRect {
  return {
    x: rect.x * to.width / from.width,
    y: rect.y * to.height / from.height,
    width: rect.width * to.width / from.width,
    height: rect.height * to.height / from.height,
  };
}

export function faceplateControlVisualRect(
  control: FaceplateControl,
): IntrinsicRect {
  if (control.kind !== "fader") {
    return rectFromCenter(control.center, {
      width: control.visualDiameter,
      height: control.visualDiameter,
    });
  }

  const capEnvelope = {
    x: control.centerX - control.capSize.width / 2,
    y: control.capTravel.top - control.capSize.height / 2,
    width: control.capSize.width,
    height:
      control.capTravel.bottom - control.capTravel.top + control.capSize.height,
  };
  return unionRects(control.bakedWell, capEnvelope);
}

export function faceplateControlHitRect(
  control: FaceplateControl,
): IntrinsicRect {
  return control.kind === "fader"
    ? control.hitRect
    : rectFromCenter(control.center, {
        width: control.hitDiameter,
        height: control.hitDiameter,
      });
}

export function faderCapRectAt(
  control: FaceplateFaderControl,
  normalizedValue: number,
): IntrinsicRect {
  const value = Math.min(1, Math.max(0, normalizedValue));
  const centerY =
    control.capTravel.bottom +
    (control.capTravel.top - control.capTravel.bottom) * value;
  return rectFromCenter(
    { x: control.centerX, y: centerY },
    control.capSize,
  );
}

const canvasRect = (size: IntrinsicSize): IntrinsicRect => ({
  x: 0,
  y: 0,
  width: size.width,
  height: size.height,
});

export function validateFaceplateManifest(
  manifest: FaceplateManifest,
): GeometryAuditIssue[] {
  const issues: GeometryAuditIssue[] = [];
  const canvas = canvasRect(manifest.assetSize);

  if (!rectContainsRect(canvas, manifest.visibleAlphaBounds)) {
    issues.push({
      code: "alpha-outside-canvas",
      subject: manifest.id,
      message: "Visible alpha bounds extend outside the source-image canvas.",
    });
  }

  for (const [zoneId, zone] of Object.entries(manifest.safeZones)) {
    if (!rectContainsRect(manifest.visibleAlphaBounds, zone)) {
      issues.push({
        code: "safe-zone-outside-alpha",
        subject: zoneId,
        message: `Safe zone ${zoneId} extends outside visible alpha.`,
      });
    }
  }

  const seenControlIds = new Set<string>();
  for (const control of manifest.controls) {
    if (seenControlIds.has(control.id)) {
      issues.push({
        code: "duplicate-control-id",
        subject: control.id,
        message: `Control id ${control.id} is not unique.`,
      });
    }
    seenControlIds.add(control.id);

    const visualZone = manifest.safeZones[control.visualSafeZone];
    const interactionZone = manifest.safeZones[control.interactionSafeZone];
    if (!visualZone) {
      issues.push({
        code: "unknown-safe-zone",
        subject: control.id,
        message: `Unknown visual safe zone ${control.visualSafeZone}.`,
      });
    } else if (!rectContainsRect(visualZone, faceplateControlVisualRect(control))) {
      issues.push({
        code: "visual-outside-safe-zone",
        subject: control.id,
        message: `Visible hardware for ${control.id} escapes ${control.visualSafeZone}.`,
      });
    }

    if (!interactionZone) {
      issues.push({
        code: "unknown-safe-zone",
        subject: control.id,
        message: `Unknown interaction safe zone ${control.interactionSafeZone}.`,
      });
    } else if (!rectContainsRect(interactionZone, faceplateControlHitRect(control))) {
      issues.push({
        code: "hit-outside-safe-zone",
        subject: control.id,
        message: `Hit target for ${control.id} escapes ${control.interactionSafeZone}.`,
      });
    }
  }

  return issues;
}

export const NAM_AMP_V4_REFERENCE_SIZE = {
  width: 2160,
  height: 1035,
} as const;

export const NAM_AMP_V4_GENERATION_SIZE = {
  width: 1811,
  height: 868,
} as const;

/**
 * Expected V4 alpha frame on the 2160 x 1035 delivery canvas.  Replace this
 * with the measured export bounds if ImageGen changes transparent padding.
 */
export const NAM_AMP_V4_REFERENCE_ALPHA = {
  x: 46,
  y: 48,
  width: 2065,
  height: 937,
} as const;

export const NAM_AMP_V4_ZONE_RATIOS = {
  captureWindow: {
    x: 726 / 2065,
    y: 237 / 937,
    width: 602 / 2065,
    height: 192 / 937,
  },
  captureContent: {
    x: 744 / 2065,
    y: 252 / 937,
    width: 580 / 2065,
    height: 160 / 937,
  },
  controlFascia: {
    x: 80 / 2065,
    y: 520 / 937,
    width: 1908 / 2065,
    height: 320 / 937,
  },
  labelRail: {
    x: 104 / 2065,
    y: 558 / 937,
    width: 1860 / 2065,
    height: 50 / 937,
  },
  hardwareRail: {
    x: 104 / 2065,
    y: 607 / 937,
    width: 1860 / 2065,
    height: 195 / 937,
  },
} as const satisfies Record<string, NormalizedRect>;

export type AmpV4ZoneRatios = typeof NAM_AMP_V4_ZONE_RATIOS;

export type AmpFaceplateBuildOptions = Readonly<{
  assetSize?: IntrinsicSize;
  visibleAlphaBounds?: IntrinsicRect;
  /** Ratios are relative to visibleAlphaBounds, not the transparent canvas. */
  zoneRatios?: Partial<Record<keyof AmpV4ZoneRatios, NormalizedRect>>;
}>;

const AMP_CONTROL_ANCHORS = [
  { id: "amp-power", paramId: "ampEnabled", kind: "toggle", x: 99 / 1908 },
  { id: "amp-input", paramId: "ampGainDb", kind: "knob", x: 234 / 1908 },
  { id: "amp-tight", paramId: "ampBoost", kind: "toggle", x: 394 / 1908 },
  { id: "amp-bright", paramId: "ampVoice", kind: "toggle", x: 549 / 1908 },
  { id: "amp-bass", paramId: "bassDb", kind: "knob", x: 749 / 1908 },
  { id: "amp-mid", paramId: "midDb", kind: "knob", x: 954 / 1908 },
  { id: "amp-treble", paramId: "trebleDb", kind: "knob", x: 1159 / 1908 },
  { id: "amp-presence", paramId: "presenceDb", kind: "knob", x: 1364 / 1908 },
  { id: "amp-mix", paramId: "ampMix", kind: "knob", x: 1569 / 1908 },
  { id: "amp-output", paramId: "ampOutputDb", kind: "knob", x: 1774 / 1908 },
] as const;

const AMP_LED_ANCHORS = [
  { id: "amp-power-led", paramId: "ampEnabled", x: 99 / 1908 },
  { id: "amp-tight-led", paramId: "ampBoost", x: 394 / 1908 },
  { id: "amp-bright-led", paramId: "ampVoice", x: 549 / 1908 },
] as const;

export function createAmpV4FaceplateManifest(
  options: AmpFaceplateBuildOptions = {},
): FaceplateManifest {
  const assetSize = options.assetSize ?? NAM_AMP_V4_REFERENCE_SIZE;
  const visibleAlphaBounds =
    options.visibleAlphaBounds ??
    scaleRectBetweenCanvases(
      NAM_AMP_V4_REFERENCE_ALPHA,
      NAM_AMP_V4_REFERENCE_SIZE,
      assetSize,
    );
  const zoneRatios = {
    ...NAM_AMP_V4_ZONE_RATIOS,
    ...options.zoneRatios,
  };
  const safeZones = {
    visibleHardware: visibleAlphaBounds,
    captureWindow: resolveNormalizedRect(zoneRatios.captureWindow, visibleAlphaBounds),
    captureContent: resolveNormalizedRect(zoneRatios.captureContent, visibleAlphaBounds),
    controlFascia: resolveNormalizedRect(zoneRatios.controlFascia, visibleAlphaBounds),
    labelRail: resolveNormalizedRect(zoneRatios.labelRail, visibleAlphaBounds),
    hardwareRail: resolveNormalizedRect(zoneRatios.hardwareRail, visibleAlphaBounds),
  } as const;
  const fascia = safeZones.controlFascia;
  const hardwareY = fascia.y + fascia.height * (177 / 320);
  const ledY = fascia.y + fascia.height * (115 / 320);
  const sourceScale = assetSize.width / NAM_AMP_V4_REFERENCE_SIZE.width;

  const controls: FaceplateCircleControl[] = AMP_CONTROL_ANCHORS.map((anchor) => {
    const knob = anchor.kind === "knob";
    return {
      id: anchor.id,
      paramId: anchor.paramId,
      kind: anchor.kind,
      center: {
        x: fascia.x + fascia.width * anchor.x,
        y: hardwareY,
      },
      visualDiameter: (knob ? 108 : 66) * sourceScale,
      hitDiameter: (knob ? 132 : 90) * sourceScale,
      visualSafeZone: "controlFascia",
      interactionSafeZone: "controlFascia",
    };
  });
  controls.push(
    ...AMP_LED_ANCHORS.map((anchor) => ({
      id: anchor.id,
      paramId: anchor.paramId,
      kind: "led" as const,
      center: {
        x: fascia.x + fascia.width * anchor.x,
        y: ledY,
      },
      visualDiameter: 36 * sourceScale,
      hitDiameter: 52 * sourceScale,
      visualSafeZone: "controlFascia",
      interactionSafeZone: "controlFascia",
    })),
  );

  return {
    id: "nam-amp-faceplate-v4",
    assetSize,
    visibleAlphaBounds,
    safeZones,
    controls,
  };
}

export const NAM_AMP_V4_FACEPLATE = createAmpV4FaceplateManifest();

export const NAM_EQ_V4_ASSET_SIZE = {
  width: 2160,
  height: 720,
} as const;

export const NAM_EQ_V4_VISIBLE_ALPHA = {
  x: 77,
  y: 83,
  width: 2003,
  height: 570,
} as const;

export const NAM_EQ_V4_FADER_CENTERS = [
  515,
  656.25,
  797.5,
  938.75,
  1080,
  1221.25,
  1362.5,
  1503.75,
  1645,
] as const;

export const NAM_EQ_V4_FADER_CAP_CROP = {
  sourceFileName: "slider-metal-top.webp",
  sourceSize: { width: 512, height: 512 },
  measuredAlphaBounds: { x: 50, y: 147, width: 411, height: 214 },
  paddedCrop: { x: 42, y: 139, width: 427, height: 230 },
  proposedFileName: "slider-metal-cap-tight.webp",
  renderSize: { width: 54, height: 28 },
} as const;

const EQ_BANDS = [
  ["eq-65", "eq65Db"],
  ["eq-125", "eq125Db"],
  ["eq-250", "eq250Db"],
  ["eq-500", "eq500Db"],
  ["eq-1k", "eq1kDb"],
  ["eq-2k", "eq2kDb"],
  ["eq-4k", "eq4kDb"],
  ["eq-8k", "eq8kDb"],
  ["eq-16k", "eq16kDb"],
] as const;

const eqCircleControl = (
  id: string,
  paramId: string,
  kind: FaceplateCircleControlKind,
  center: IntrinsicPoint,
  visualDiameter: number,
  hitDiameter: number,
  safeZone: string,
): FaceplateCircleControl => ({
  id,
  paramId,
  kind,
  center,
  visualDiameter,
  hitDiameter,
  visualSafeZone: safeZone,
  interactionSafeZone: safeZone,
});

const eqFaders: FaceplateFaderControl[] = EQ_BANDS.map(
  ([id, paramId], index) => ({
    id,
    paramId,
    kind: "fader",
    centerX: NAM_EQ_V4_FADER_CENTERS[index],
    bakedWell: {
      x: NAM_EQ_V4_FADER_CENTERS[index] - 15,
      y: 128,
      width: 30,
      height: 292,
    },
    capTravel: { top: 144, bottom: 404 },
    capSize: NAM_EQ_V4_FADER_CAP_CROP.renderSize,
    hitRect: {
      x: NAM_EQ_V4_FADER_CENTERS[index] - 56,
      y: 112,
      width: 112,
      height: 328,
    },
    visualSafeZone: "mainControls",
    interactionSafeZone: "mainControls",
  }),
);

export const NAM_EQ_V4_FACEPLATE: FaceplateManifest = {
  id: "nam-graphic-eq-faceplate-v4",
  assetSize: NAM_EQ_V4_ASSET_SIZE,
  visibleAlphaBounds: NAM_EQ_V4_VISIBLE_ALPHA,
  safeZones: {
    visibleHardware: NAM_EQ_V4_VISIBLE_ALPHA,
    printableFace: { x: 116, y: 124, width: 1928, height: 496 },
    mainControls: { x: 156, y: 110, width: 1848, height: 340 },
    utilityControls: { x: 156, y: 460, width: 1848, height: 156 },
  },
  controls: [
    eqCircleControl("eq-hpf", "eqHPFHz", "knob", { x: 290, y: 274 }, 150, 180, "mainControls"),
    ...eqFaders,
    eqCircleControl("eq-lpf", "eqLPFHz", "knob", { x: 1870, y: 274 }, 150, 180, "mainControls"),
    eqCircleControl("eq-power", "eqEnabled", "toggle", { x: 290, y: 525 }, 66, 90, "utilityControls"),
    eqCircleControl("eq-level", "eqLevelDb", "knob", { x: 1870, y: 525 }, 90, 116, "utilityControls"),
    eqCircleControl("eq-led", "eqEnabled", "led", { x: 400, y: 525 }, 36, 52, "utilityControls"),
  ],
};

export type RenderedFaceplateProjection = Readonly<{
  canvas: IntrinsicRect;
  visibleAlpha: IntrinsicRect;
  safeZones: Readonly<Record<string, IntrinsicRect>>;
  controlVisuals: Readonly<Record<string, IntrinsicRect>>;
  controlHits: Readonly<Record<string, IntrinsicRect>>;
}>;

export function fitIntrinsicCanvas(
  container: IntrinsicRect,
  assetSize: IntrinsicSize,
): IntrinsicRect {
  const scale = Math.min(
    container.width / assetSize.width,
    container.height / assetSize.height,
  );
  const width = assetSize.width * scale;
  const height = assetSize.height * scale;
  return {
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    width,
    height,
  };
}

export function projectIntrinsicRect(
  rect: IntrinsicRect,
  assetSize: IntrinsicSize,
  renderedCanvas: IntrinsicRect,
): IntrinsicRect {
  return {
    x: renderedCanvas.x + rect.x * renderedCanvas.width / assetSize.width,
    y: renderedCanvas.y + rect.y * renderedCanvas.height / assetSize.height,
    width: rect.width * renderedCanvas.width / assetSize.width,
    height: rect.height * renderedCanvas.height / assetSize.height,
  };
}

export function projectFaceplateManifest(
  manifest: FaceplateManifest,
  renderedCanvas: IntrinsicRect,
): RenderedFaceplateProjection {
  const project = (rect: IntrinsicRect) =>
    projectIntrinsicRect(rect, manifest.assetSize, renderedCanvas);
  return {
    canvas: renderedCanvas,
    visibleAlpha: project(manifest.visibleAlphaBounds),
    safeZones: Object.fromEntries(
      Object.entries(manifest.safeZones).map(([id, rect]) => [id, project(rect)]),
    ),
    controlVisuals: Object.fromEntries(
      manifest.controls.map((control) => [
        control.id,
        project(faceplateControlVisualRect(control)),
      ]),
    ),
    controlHits: Object.fromEntries(
      manifest.controls.map((control) => [
        control.id,
        project(faceplateControlHitRect(control)),
      ]),
    ),
  };
}

export type RenderedGeometryDelta = Readonly<{
  subject: string;
  centerDelta: number;
  widthDelta: number;
  heightDelta: number;
}>;

/**
 * Playwright/DOM QA helper.  Callers pass getBoundingClientRect() values for
 * the alpha-debug overlay or hardware nodes.  Faders should supply their full
 * travel-envelope debug node, not the current cap position.
 */
export function compareRenderedGeometry(
  expected: Readonly<Record<string, IntrinsicRect>>,
  measured: Readonly<Record<string, IntrinsicRect>>,
): RenderedGeometryDelta[] {
  return Object.entries(expected).flatMap(([subject, target]) => {
    const actual = measured[subject];
    if (!actual) {
      return [{
        subject,
        centerDelta: Number.POSITIVE_INFINITY,
        widthDelta: Number.POSITIVE_INFINITY,
        heightDelta: Number.POSITIVE_INFINITY,
      }];
    }
    const expectedCenter = {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    };
    const actualCenter = {
      x: actual.x + actual.width / 2,
      y: actual.y + actual.height / 2,
    };
    return [{
      subject,
      centerDelta: Math.hypot(
        actualCenter.x - expectedCenter.x,
        actualCenter.y - expectedCenter.y,
      ),
      widthDelta: Math.abs(actual.width - target.width),
      heightDelta: Math.abs(actual.height - target.height),
    }];
  });
}

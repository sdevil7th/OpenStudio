export type MeterScaleMode = "extended" | "dbfs";
export type MeterColorScheme = "default" | "centerContrast";

export const METER_DB_FLOOR = -60;
export const METER_EXTENDED_TOP_DB = 12;
export const METER_DBFS_TOP_DB = 0;
export const METER_CLIP_THRESHOLD_DB = 0;
export const METER_WARNING_START_DB = -6;
export const METER_DBFS_RED_START_DB = -1;
export const METER_NOISE_FLOOR_LINEAR = 0.001;
export const METER_SEGMENT_HEIGHT = 2;
export const METER_SEGMENT_GAP = 1;
export const METER_RULER_FONT_PX = 7;
export const CENTER_DBFS_LABEL_FONT_PX = 8;
export const CHANNEL_STRIP_DB_LABEL_FONT_CLASS = "text-[7px]";
export const CHANNEL_STRIP_DB_LABEL_WIDTH_CLASS = "w-3";
export const MASTER_METER_CLUSTER_WIDTH_PX = 34;
export const MASTER_EXTENDED_METER_WIDTH_PX = 34;
export const MASTER_DBFS_OVERLAY_WIDTH_PX = 22;

export const METER_COLORS = {
  background: "#0a0a0a",
  unlit: "#171717",
  safe: "#22c55e",
  warning: "#facc15",
  hot: "#f97316",
  danger: "#ef4444",
  clip: "#dc2626",
  thresholdLine: "rgba(255, 248, 220, 0.85)",
  rulerOverlay: "rgba(0, 0, 0, 1)",
  peakSafe: "#ffffff",
  peakWarning: "#f97316",
  peakDanger: "#ef4444",
} as const;

export const CENTER_METER_COLORS = {
  safe: "#9ae6b4",
  warning: "#fef08a",
  hot: "#fde68a",
  danger: "#ef4444",
  peakSafe: "#ecfccb",
  peakWarning: "#fde68a",
  peakDanger: "#ef4444",
} as const;

export const MASTER_DBFS_RULING_MARKS = [0, -6, -12, -24, -48, -60] as const;

export function getMeterTopDb(scaleMode: MeterScaleMode): number {
  return scaleMode === "dbfs" ? METER_DBFS_TOP_DB : METER_EXTENDED_TOP_DB;
}

export function normalizeDbToMeter(db: number, scaleMode: MeterScaleMode): number {
  const topDb = getMeterTopDb(scaleMode);
  const clampedDb = Math.max(METER_DB_FLOOR, Math.min(topDb, db));
  return (clampedDb - METER_DB_FLOOR) / (topDb - METER_DB_FLOOR);
}

export function normalizedMeterToDb(normalized: number, scaleMode: MeterScaleMode): number {
  const clamped = Math.max(0, Math.min(1, normalized));
  const topDb = getMeterTopDb(scaleMode);
  return METER_DB_FLOOR + clamped * (topDb - METER_DB_FLOOR);
}

export function linearLevelToDb(level: number): number {
  return level > 0 ? 20 * Math.log10(level) : -Infinity;
}

export function normalizeLevelToMeter(level: number, scaleMode: MeterScaleMode): number {
  if (level < METER_NOISE_FLOOR_LINEAR) return 0;
  const db = linearLevelToDb(level);
  if (!Number.isFinite(db)) return 0;
  return normalizeDbToMeter(db, scaleMode);
}

export function getThresholdNormalized(scaleMode: MeterScaleMode): number {
  return normalizeDbToMeter(METER_CLIP_THRESHOLD_DB, scaleMode);
}

export function getRedStartDb(scaleMode: MeterScaleMode): number {
  return scaleMode === "dbfs" ? METER_DBFS_RED_START_DB : METER_CLIP_THRESHOLD_DB;
}

export function getMeterSegmentColor(
  segmentDb: number,
  scaleMode: MeterScaleMode,
  colorScheme: MeterColorScheme = "default",
): string {
  const palette = colorScheme === "centerContrast" ? CENTER_METER_COLORS : METER_COLORS;
  if (segmentDb >= getRedStartDb(scaleMode)) return palette.danger;
  if (segmentDb >= METER_WARNING_START_DB) return palette.warning;
  return palette.safe;
}

export function getPeakIndicatorColor(
  peakDb: number,
  scaleMode: MeterScaleMode,
  colorScheme: MeterColorScheme = "default",
): string {
  const palette = colorScheme === "centerContrast" ? CENTER_METER_COLORS : METER_COLORS;
  if (peakDb >= getRedStartDb(scaleMode)) return palette.peakDanger;
  if (peakDb >= METER_WARNING_START_DB) return palette.peakWarning;
  return palette.peakSafe;
}

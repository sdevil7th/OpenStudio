export const NAM_METER_FLOOR_DB = -60;
export const NAM_METER_CEILING_DB = 6;

export type NAMMeterSide = "input" | "output";
export type NAMMeterChannel = "left" | "right";

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const clampNAMMeterDb = (levelDb: number) =>
  Math.min(NAM_METER_CEILING_DB, Math.max(NAM_METER_FLOOR_DB, levelDb));

/**
 * Maps the native dBFS linked-peak value to the visible meter range. Native
 * silence is -90 dBFS; the hardware display intentionally floors at -60 dBFS
 * while retaining 6 dB of above-full-scale headroom.
 */
export const namMeterFraction = (levelDb: unknown) => {
  const finiteLevelDb = finiteNumber(levelDb);
  if (finiteLevelDb === undefined) return 0;

  return (
    (clampNAMMeterDb(finiteLevelDb) - NAM_METER_FLOOR_DB)
    / (NAM_METER_CEILING_DB - NAM_METER_FLOOR_DB)
  );
};

/**
 * Live diagnostics win over the one-time schema snapshot. This linked maximum
 * remains part of the contract for mixed-version clients and numeric readouts;
 * the current hardware display resolves independent channel values below.
 */
export const resolveNAMLinkedMeterDb = (
  side: NAMMeterSide,
  diagnostics: Record<string, unknown> | null | undefined,
  schemaLevelDb: unknown,
) => {
  const prefix = side === "input" ? "Input" : "Output";
  return (
    finiteNumber(diagnostics?.[`${side}LevelDb`])
    ?? finiteNumber(diagnostics?.[`last${prefix}PeakDb`])
    ?? finiteNumber(schemaLevelDb)
  );
};

/**
 * Resolves one true channel peak. A legacy native build may only publish its
 * linked maximum, so that value is the final live fallback until both halves
 * of the app have updated. A current schema channel value still wins over a
 * stale linked schema snapshot before live diagnostics begin polling.
 */
export const resolveNAMChannelMeterDb = (
  side: NAMMeterSide,
  channel: NAMMeterChannel,
  diagnostics: Record<string, unknown> | null | undefined,
  schemaChannelLevelDb: unknown,
  linkedFallbackDb: unknown,
) => {
  const prefix = side === "input" ? "Input" : "Output";
  const channelName = channel === "left" ? "Left" : "Right";
  return (
    finiteNumber(diagnostics?.[`${side}${channelName}LevelDb`])
    ?? finiteNumber(diagnostics?.[`${side}LevelDb`])
    ?? finiteNumber(diagnostics?.[`last${prefix}PeakDb`])
    ?? finiteNumber(schemaChannelLevelDb)
    ?? finiteNumber(linkedFallbackDb)
  );
};

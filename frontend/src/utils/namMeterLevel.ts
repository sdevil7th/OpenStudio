export const NAM_METER_FLOOR_DB = -60;
export const NAM_METER_CEILING_DB = 6;

export type NAMMeterSide = "input" | "output";

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
 * Live diagnostics win over the one-time schema snapshot. The native values
 * are linked peaks (maximum across the processor buffer's active channels), so
 * one truthful meter works for both mono and stereo without fabricating L/R.
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

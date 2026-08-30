export const DEFAULT_AUDIO_BUFFER_SIZE = 512;

const normalizeBufferSize = (value: unknown): number | null => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return Math.round(numericValue);
};

/**
 * Keeps every valid size reported by the active driver available. The current
 * size is also included when a driver omits it from its capability list.
 */
export const resolveAudioBufferSizeOptions = (
  reportedBufferSizes: readonly unknown[] | null | undefined,
  currentBufferSize?: unknown,
): number[] => {
  const options = (reportedBufferSizes ?? [])
    .map(normalizeBufferSize)
    .filter((size): size is number => size !== null)
    .filter((size, index, sizes) => sizes.indexOf(size) === index);
  const current = normalizeBufferSize(currentBufferSize);

  if (current !== null && !options.includes(current)) {
    options.push(current);
  }

  if (options.length === 0) {
    options.push(current ?? DEFAULT_AUDIO_BUFFER_SIZE);
  }

  return options.sort((left, right) => left - right);
};

/**
 * Preserves any positive size chosen by the user or returned by the driver.
 * A fallback is used only for missing/invalid configuration data.
 */
export const resolveAudioBufferSizeRequest = (
  requestedBufferSize: unknown,
  reportedBufferSizes?: readonly unknown[] | null,
): number => {
  const requested = normalizeBufferSize(requestedBufferSize);
  if (requested !== null) {
    return requested;
  }

  return resolveAudioBufferSizeOptions(reportedBufferSizes)[0];
};

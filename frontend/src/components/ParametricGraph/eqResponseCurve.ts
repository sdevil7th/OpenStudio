/**
 * Biquad magnitude response calculation — exact TypeScript port of
 * the biquad_coeff function from effects/eq_advanced.jsfx.
 *
 * Computes |H(e^jw)| in dB for a single biquad filter at a given frequency.
 */

// Filter type enum (matches JSFX slider enum order)
export const FilterType = {
  LowShelf: 0,
  Peak: 1,
  HighShelf: 2,
  LowPass: 3,
  HighPass: 4,
  Notch: 5,
} as const;

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Compute normalized biquad coefficients for a given filter type.
 * Mirrors the JSFX biquad_coeff function exactly.
 */
export function computeBiquadCoeffs(
  type: number,
  fc: number,
  gainDB: number,
  q: number,
  sampleRate: number,
): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const A = Math.pow(10, gainDB / 40);

  let b0: number, b1: number, b2: number;
  let a0: number, a1: number, a2: number;

  if (type === FilterType.LowShelf) {
    const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / 0.707 - 1) + 2);
    const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 - (A - 1) * cosw + sqrtA2alpha);
    b1 = 2 * A * (A - 1 - (A + 1) * cosw);
    b2 = A * (A + 1 - (A - 1) * cosw - sqrtA2alpha);
    a0 = A + 1 + (A - 1) * cosw + sqrtA2alpha;
    a1 = -2 * (A - 1 + (A + 1) * cosw);
    a2 = A + 1 + (A - 1) * cosw - sqrtA2alpha;
  } else if (type === FilterType.Peak) {
    const alpha = sinw / (2 * q);
    b0 = 1 + alpha * A;
    b1 = -2 * cosw;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw;
    a2 = 1 - alpha / A;
  } else if (type === FilterType.HighShelf) {
    const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / 0.707 - 1) + 2);
    const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 + (A - 1) * cosw + sqrtA2alpha);
    b1 = -2 * A * (A - 1 + (A + 1) * cosw);
    b2 = A * (A + 1 + (A - 1) * cosw - sqrtA2alpha);
    a0 = A + 1 - (A - 1) * cosw + sqrtA2alpha;
    a1 = 2 * (A - 1 - (A + 1) * cosw);
    a2 = A + 1 - (A - 1) * cosw - sqrtA2alpha;
  } else if (type === FilterType.LowPass) {
    const alpha = sinw / (2 * q);
    b0 = (1 - cosw) / 2;
    b1 = 1 - cosw;
    b2 = (1 - cosw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  } else if (type === FilterType.HighPass) {
    const alpha = sinw / (2 * q);
    b0 = (1 + cosw) / 2;
    b1 = -(1 + cosw);
    b2 = (1 + cosw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  } else {
    // Notch
    const alpha = sinw / (2 * q);
    b0 = 1;
    b1 = -2 * cosw;
    b2 = 1;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * Evaluate the magnitude response |H(e^jw)| of a biquad filter at a given frequency.
 * Returns the result in dB.
 */
export function biquadMagnitudeDB(coeffs: BiquadCoeffs, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cosw = Math.cos(w);
  const cos2w = Math.cos(2 * w);
  const sinw = Math.sin(w);
  const sin2w = Math.sin(2 * w);

  // H(e^jw) = (b0 + b1*e^-jw + b2*e^-j2w) / (1 + a1*e^-jw + a2*e^-j2w)
  const numReal = coeffs.b0 + coeffs.b1 * cosw + coeffs.b2 * cos2w;
  const numImag = -(coeffs.b1 * sinw + coeffs.b2 * sin2w);
  const denReal = 1 + coeffs.a1 * cosw + coeffs.a2 * cos2w;
  const denImag = -(coeffs.a1 * sinw + coeffs.a2 * sin2w);

  const numMagSq = numReal * numReal + numImag * numImag;
  const denMagSq = denReal * denReal + denImag * denImag;

  if (denMagSq === 0) return 0;
  return 10 * Math.log10(numMagSq / denMagSq);
}

export interface EQBand {
  enabled: boolean;
  type: number;
  freq: number;
  gainDB: number;
  q: number;
}

/**
 * Generate ~numPoints log-spaced frequency points from minFreq to maxFreq,
 * computing the combined magnitude response of all enabled bands.
 */
export function computeEQResponse(
  bands: EQBand[],
  sampleRate: number,
  minFreq: number = 20,
  maxFreq: number = 20000,
  numPoints: number = 200,
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);

  // Pre-compute coefficients for all enabled bands
  const enabledCoeffs: BiquadCoeffs[] = [];
  for (const band of bands) {
    if (band.enabled) {
      enabledCoeffs.push(computeBiquadCoeffs(band.type, band.freq, band.gainDB, band.q, sampleRate));
    }
  }

  for (let i = 0; i <= numPoints; i++) {
    const logFreq = logMin + (i / numPoints) * (logMax - logMin);
    const freq = Math.pow(10, logFreq);
    let totalDB = 0;

    for (const coeffs of enabledCoeffs) {
      totalDB += biquadMagnitudeDB(coeffs, freq, sampleRate);
    }

    points.push({ x: freq, y: totalDB });
  }

  return points;
}

/**
 * Compute the magnitude response of a single band (for per-node curve display).
 */
export function computeSingleBandResponse(
  band: EQBand,
  sampleRate: number,
  minFreq: number = 20,
  maxFreq: number = 20000,
  numPoints: number = 200,
): { x: number; y: number }[] {
  if (!band.enabled) return [];

  const coeffs = computeBiquadCoeffs(band.type, band.freq, band.gainDB, band.q, sampleRate);
  const points: { x: number; y: number }[] = [];
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);

  for (let i = 0; i <= numPoints; i++) {
    const logFreq = logMin + (i / numPoints) * (logMax - logMin);
    const freq = Math.pow(10, logFreq);
    points.push({ x: freq, y: biquadMagnitudeDB(coeffs, freq, sampleRate) });
  }

  return points;
}

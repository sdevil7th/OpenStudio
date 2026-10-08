export const sketchPoints = 129;
export const sketchFrequency = (index: number, rate: number) => 80 * Math.pow(Math.min(16000, rate * .4) / 80, index / (sketchPoints - 1));
export function paintSketch(values: number[], from: { index: number; gain: number }, to: { index: number; gain: number }, minimum = -12, maximum = 12) {
  const result = [...values];
  const low = Math.max(0, Math.min(from.index, to.index)), high = Math.min(result.length - 1, Math.max(from.index, to.index));
  for (let i = low; i <= high; ++i) {
    const fraction = from.index === to.index ? 1 : (i - from.index) / (to.index - from.index);
    result[i] = Math.max(minimum, Math.min(maximum, from.gain + fraction * (to.gain - from.gain)));
  }
  return result;
}

export function eqFrequencyWindow(zoom: number, center: number, minimum = 20, maximum = 20000) {
  const factor = [1, 2, 4, 8].includes(zoom) ? zoom : 1;
  const half = Math.log(maximum / minimum) / factor / 2;
  const middle = Math.max(Math.log(minimum) + half, Math.min(Math.log(maximum) - half, Math.log(Number.isFinite(center) && center > 0 ? center : Math.sqrt(minimum * maximum))));
  return factor === 1 ? { min: minimum, max: maximum, center: Math.sqrt(minimum * maximum) }
    : { min: Math.exp(middle - half), max: Math.exp(middle + half), center: Math.exp(middle) };
}
export function eqFrequencyTicks(min: number, max: number, width: number) {
  const values = [10, 12.5, 16, 20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000, 25000, 30000];
  let last = -Infinity;
  return values.filter(hz => { const x = Math.log(hz / min) / Math.log(max / min) * width; if (hz < min || hz > max || x - last < 45) return false; last = x; return true; });
}

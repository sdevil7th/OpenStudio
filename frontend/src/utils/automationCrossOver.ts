import { envelopeValue } from "./automationEnvelopeEdits";

/** Earliest intersection with the original piecewise-linear curve, including its knots. */
export function automationCrossOverTime(points: readonly {time: number; value: number}[], start: number, end: number,
  startValue: number, endValue: number, discrete = false): number | undefined {
  const original = (time: number) => {
    if (!points.length) return .5;
    if (!discrete) return envelopeValue(points, time);
    return [...points].reverse().find(point => point.time <= time)?.value ?? points[0].value;
  };
  if (discrete || end <= start) return Math.abs(endValue - original(end)) <= .000001 ? end : undefined;
  const cuts = [start, ...points.filter(point => point.time > start && point.time < end).map(point => point.time), end];
  const difference = (time: number) => startValue + (endValue - startValue) * ((time - start) / (end - start)) - original(time);
  let previousTime = start, previous = difference(start);
  for (const time of cuts.slice(1)) {
    const current = difference(time);
    if (Math.abs(previous) <= .000001) return previousTime;
    if (Math.abs(current) <= .000001) return time;
    if (previous * current < 0) return previousTime + (time - previousTime) * Math.abs(previous) / (Math.abs(previous) + Math.abs(current));
    previousTime = time; previous = current;
  }
  return undefined;
}

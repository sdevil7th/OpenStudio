export interface EnvelopePoint { id?: string; time: number; value: number }
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function envelopeValue(points: readonly EnvelopePoint[], time: number, discrete = false) {
  if (!points.length) throw new Error("The envelope has no points");
  if (discrete) {
    for (let index = points.length - 1; index >= 0; --index) if (points[index].time <= time) return points[index].value;
    return points[0].value;
  }
  if (time <= points[0].time) return points[0].value;
  for (let index = 1; index < points.length; ++index) if (time <= points[index].time) {
    const a = points[index - 1], b = points[index];
    return b.time === a.time ? b.value : a.value + (b.value - a.value) * (time - a.time) / (b.time - a.time);
  }
  return points[points.length - 1].value;
}
export function editEnvelopeRange(points: readonly EnvelopePoint[], start: number, end: number,
  action: "trim" | "fill", amount: number, defaultNormalized = .5, discrete = false): EnvelopePoint[] {
  if (!Number.isFinite(amount) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
    throw new Error("Select a valid time range");
  if (!points.length && action === "trim") throw new Error("Trim requires an existing envelope");
  const valueAt = (time: number) => points.length ? envelopeValue(points, time, discrete) : clamp(defaultNormalized);
  const source: EnvelopePoint[] = [{ time: start, value: valueAt(start) },
    ...points.filter(point => point.time > start && point.time < end), { time: end, value: valueAt(end) }];
  const edited: EnvelopePoint[] = action === "fill"
    ? [{ time: start, value: clamp(amount) }, { time: end, value: clamp(amount) }]
    : source.flatMap((point, index) => {
      const extra: EnvelopePoint[] = [];
      if (index > 0) {
        const previous = source[index - 1], a = previous.value + amount, b = point.value + amount;
        if (a !== b) for (const boundary of [0, 1]) {
          const ratio = (boundary - a) / (b - a);
          if (ratio > 0 && ratio < 1) extra.push({ time: previous.time + ratio * (point.time - previous.time), value: boundary });
        }
        extra.sort((a, b) => a.time - b.time);
      }
      return [...extra, { time: point.time, value: clamp(point.value + amount) }];
    });
  // Preserve the curve outside the selection, including its boundary values.
  const epsilon = 0.000001;
  const guards: EnvelopePoint[] = [
    ...(start > 0 ? [{ time: Math.max(0, start - epsilon), value: valueAt(Math.max(0, start - epsilon)) }] : []),
    { time: end + epsilon, value: valueAt(end + epsilon) },
  ];
  return [...points.filter(point => point.time < start - epsilon || point.time > end + epsilon), ...guards, ...edited]
    .sort((a, b) => a.time - b.time);
}

// Vertical-error thinning in normalized parameter space. Preserve endpoints,
// equal-time edges and every retained segment's maximum original-point error.
export function thinEnvelope(points: readonly EnvelopePoint[], tolerance: number): EnvelopePoint[] {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > .05) throw new Error("Use a tolerance from 0 to 5%");
  if (points.length < 3 || tolerance === 0) return points.map(point => ({ ...point }));
  const keep = new Set([0, points.length - 1]);
  const pending = [[0, points.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!;
    const a = points[first], b = points[last];
    let largest = -1, split = -1;
    for (let index = first + 1; index < last; ++index) {
      const point = points[index];
      const error = b.time === a.time || point.time === points[index - 1].time || point.time === points[index + 1].time ? Infinity
        : Math.abs(point.value - (a.value + (b.value - a.value) * (point.time - a.time) / (b.time - a.time)));
      if (error > largest) { largest = error; split = index; }
    }
    if (split >= 0 && largest > tolerance) { keep.add(split); pending.push([first, split], [split, last]); }
  }
  return points.filter((_point, index) => keep.has(index)).map(point => ({ ...point }));
}

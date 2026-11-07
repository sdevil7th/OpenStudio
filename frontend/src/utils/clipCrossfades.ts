import type { AudioClip } from "../store/useDAWStore";
import { fadeCurve } from "./fadeUtils";

export interface ClipGainPoint { time: number; gain: number }
export interface CrossfadeSettings {
  fadeInShape?: number;
  fadeOutShape?: number;
  /** Maximum handoff length. Each window is bounded by available overlap. */
  transitionLength?: number;
}
export interface ClipCrossfadeLayer {
  id: string;
  memberClipIds: string[];
  points: ClipGainPoint[];
  /** Visible item origin within this layer; trims retain hidden handoff data. */
  offset?: number;
  settings: CrossfadeSettings;
}
export interface CrossfadeTransition {
  fromClipId: string;
  toClipId: string;
  startTime: number;
  endTime: number;
  fadeInShape: number;
  fadeOutShape: number;
}
export interface ClipCrossfadePlan {
  id: string;
  layers: Map<string, ClipCrossfadeLayer>;
  transitions: CrossfadeTransition[];
  maximumTransitionLength: number;
}

const EPSILON = 1e-8;
const APPROXIMATION_ERROR = 0.0001;
const composedEnvelopes = new WeakMap<AudioClip, ClipGainPoint[]>();
const endOf = (clip: AudioClip) => clip.startTime + clip.duration;
const shape = (value: number | undefined) => Math.max(0, Math.min(4, Math.round(value ?? 0)));

export function crossfadeGroupId(clips: readonly Pick<AudioClip, "id">[]): string {
  return `crossfade:${clips.map(clip => clip.id).sort().join("|")}`;
}

/** Resolve owners from retained layers, including legacy/split IDs. Selection is not identity. */
export function resolveCrossfadeSelection(all: readonly AudioClip[], selectedIds: readonly string[]) {
  const ids = new Set(selectedIds), groupIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const clip of all) {
      if (!ids.has(clip.id) && !clip.crossfadeLayers?.some(layer => groupIds.has(layer.id))) continue;
      if (!ids.has(clip.id)) { ids.add(clip.id); changed = true; }
      for (const layer of clip.crossfadeLayers ?? []) {
        if (!groupIds.has(layer.id)) { groupIds.add(layer.id); changed = true; }
      }
    }
  }
  return { clips: all.filter(clip => ids.has(clip.id)), groupIds,
    expanded: ids.size > new Set(selectedIds).size };
}

/** Update references without changing any gain coefficients or layer offsets. */
export function reconcileCrossfadeMembers<T extends Pick<AudioClip, "id" | "crossfadeLayers">>(clips: readonly T[]): T[] {
  const owners = new Map<string, string[]>();
  for (const clip of clips) for (const layer of clip.crossfadeLayers ?? []) {
    const members = owners.get(layer.id) ?? [];
    if (!members.includes(clip.id)) members.push(clip.id);
    owners.set(layer.id, members);
  }
  return clips.map(clip => !clip.crossfadeLayers?.length || clip.crossfadeLayers.every(layer => {
    const members = owners.get(layer.id)!;
    return members.length === layer.memberClipIds.length && members.every(id => layer.memberClipIds.includes(id));
  }) ? clip : { ...clip,
    crossfadeLayers: clip.crossfadeLayers.map(layer => ({ ...layer, memberClipIds: [...owners.get(layer.id)!] })) });
}

export function reconcileCrossfadeTracks<T extends { clips: AudioClip[] }>(tracks: T[]): T[] {
  const clips = tracks.flatMap(track => track.clips);
  const repaired = reconcileCrossfadeMembers(clips);
  const byId = new Map(repaired.map(clip => [clip.id, clip]));
  return tracks.map(track => track.clips.every(clip => byId.get(clip.id) === clip) ? track
    : { ...track, clips: track.clips.map(clip => byId.get(clip.id)!) });
}

/** Only call on newly created copies. A partial group retains its curve but owns a new identity. */
export function forkCopiedCrossfades<T extends Pick<AudioClip, "id" | "crossfadeLayers" | "takes">>(copies: readonly T[]): T[] {
  const groups = new Map<string, string>();
  return reconcileCrossfadeMembers(copies.map(clip => ({ ...clip,
    ...(clip.takes ? { takes: forkCopiedCrossfades(clip.takes) } : {}),
    crossfadeLayers: cloneCrossfadeLayers(clip.crossfadeLayers)?.map(layer => {
      if (!groups.has(layer.id)) groups.set(layer.id, `crossfade:${crypto.randomUUID()}`);
      return { ...layer, id: groups.get(layer.id)! };
    }) })));
}

/** Same piecewise-linear law used by native playback and offline rendering. */
export function interpolateClipGain(points: readonly ClipGainPoint[] | undefined, time: number): number {
  if (!points?.length) return 1;
  if (time <= points[0].time) return points[0].gain;
  if (time >= points[points.length - 1].time) return points[points.length - 1].gain;
  let low = 0, high = points.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].time <= time) low = middle;
    else high = middle;
  }
  const left = points[low], right = points[high];
  const phase = (time - left.time) / Math.max(EPSILON, right.time - left.time);
  return left.gain + (right.gain - left.gain) * phase;
}

function sampleGain(gainAt: (time: number) => number, knots: readonly number[]): ClipGainPoint[] {
  const times = [...new Set(knots)].sort((a, b) => a - b);
  if (!times.length) return [];
  const points: ClipGainPoint[] = [{ time: times[0], gain: gainAt(times[0]) }];
  const segment = (left: ClipGainPoint, right: ClipGainPoint, depth: number) => {
    let error = 0;
    for (const phase of [0.25, 0.5, 0.75]) {
      error = Math.max(error, Math.abs(gainAt(left.time + (right.time - left.time) * phase)
        - (left.gain + (right.gain - left.gain) * phase)));
    }
    const time = (left.time + right.time) / 2;
    if (error > APPROXIMATION_ERROR && depth < 28 && time > left.time && time < right.time) {
      const middle = { time, gain: gainAt(time) };
      segment(left, middle, depth + 1);
      segment(middle, right, depth + 1);
    } else points.push(right);
  };
  for (let index = 1; index < times.length; index++) {
    segment(points[points.length - 1], { time: times[index], gain: gainAt(times[index]) }, 0);
  }
  // Constant plateaus need only their endpoints. Retain every curved segment.
  return points.filter((point, index) => index === 0 || index === points.length - 1
    || Math.abs(point.gain - points[index - 1].gain) > 1e-12
    || Math.abs(point.gain - points[index + 1].gain) > 1e-12);
}

/** Plan one ownership timeline, avoiding redundant fades in triple/nested overlaps. */
export function planClipCrossfades(
  input: readonly AudioClip[], options: CrossfadeSettings = {}, defaultContainedLength = 0.05,
  groupId = crossfadeGroupId(input),
): ClipCrossfadePlan | null {
  if (input.length < 2 || input.some(clip => !Number.isFinite(clip.startTime) || !Number.isFinite(clip.duration)
    || clip.duration <= EPSILON) || [options.fadeInShape, options.fadeOutShape, options.transitionLength]
    .some(value => value !== undefined && !Number.isFinite(value))
    || (options.transitionLength !== undefined && options.transitionLength <= 0)) return null;
  // Stable sorting retains the arrangement's item-stack order for equal spans.
  const clips = [...input].sort((a, b) => a.startTime - b.startTime || endOf(b) - endOf(a));
  const clipById = new Map(clips.map(clip => [clip.id, clip]));
  if (clipById.size !== clips.length) return null;
  const coincident = new Map<string, AudioClip[]>();
  for (const clip of clips) {
    const key = `${clip.startTime}:${endOf(clip)}`, members = coincident.get(key) ?? [];
    members.push(clip); coincident.set(key, members);
  }
  const edges = clips.flatMap(clip => [clip.startTime, endOf(clip)]);
  for (const members of coincident.values()) {
    for (let index = 1; index < members.length; index++) edges.push(members[0].startTime + members[0].duration * index / members.length);
  }
  const boundaries = [...new Set(edges)].sort((a, b) => a - b);
  const ownerAt = (time: number): string | null => {
    const active = clips.filter(clip => clip.startTime <= time && endOf(clip) > time)
      .sort((a, b) => b.startTime - a.startTime || endOf(a) - endOf(b));
    if (!active.length) return null;
    const first = active[0];
    const tied = coincident.get(`${first.startTime}:${endOf(first)}`)!;
    return tied[Math.min(tied.length - 1, Math.floor((time - first.startTime) / first.duration * tied.length))].id;
  };
  const spans: Array<{ start: number; end: number; owner: string | null }> = [];
  for (let index = 1; index < boundaries.length; index++) {
    const start = boundaries[index - 1], end = boundaries[index], owner = ownerAt((start + end) / 2);
    const previous = spans[spans.length - 1];
    if (previous?.owner === owner) previous.end = end;
    else spans.push({ start, end, owner });
  }
  const changes = spans.slice(1).flatMap((span, index) => {
    const from = spans[index].owner, to = span.owner;
    if (!from || !to || from === to) return [];
    const first = clipById.get(from)!, second = clipById.get(to)!;
    const overlapStart = Math.max(first.startTime, second.startTime), overlapEnd = Math.min(endOf(first), endOf(second));
    if (overlapEnd - overlapStart <= EPSILON) return [];
    return [{ from, to, boundary: span.start, first, second, overlapStart, overlapEnd }];
  });
  if (!changes.length) return null;
  let maximumTransitionLength = Infinity;
  const transitions = changes.map((change, index): CrossfadeTransition => {
    const { first, second, boundary, overlapStart, overlapEnd } = change;
    const left = Math.max(overlapStart, index ? (changes[index - 1].boundary + boundary) / 2 : overlapStart);
    const right = Math.min(overlapEnd, index + 1 < changes.length ? (boundary + changes[index + 1].boundary) / 2 : overlapEnd);
    const atEntry = Math.abs(second.startTime - boundary) <= EPSILON;
    const atExit = Math.abs(endOf(first) - boundary) <= EPSILON;
    const available = Math.max(EPSILON, atEntry ? right - boundary : atExit ? boundary - left
      : 2 * Math.min(boundary - left, right - boundary));
    maximumTransitionLength = Math.min(maximumTransitionLength, available);
    const sameBounds = Math.abs(first.startTime - second.startTime) <= EPSILON && Math.abs(endOf(first) - endOf(second)) <= EPSILON;
    const contained = !sameBounds && ((first.startTime <= second.startTime && endOf(first) >= endOf(second))
      || (second.startTime <= first.startTime && endOf(second) >= endOf(first)));
    const requested = options.transitionLength ?? (contained ? defaultContainedLength : available);
    const length = Math.max(EPSILON, Math.min(available, requested));
    const startTime = atEntry ? boundary : atExit ? boundary - length : boundary - length / 2;
    return { fromClipId: change.from, toClipId: change.to, startTime, endTime: startTime + length,
      fadeInShape: shape(options.fadeInShape), fadeOutShape: shape(options.fadeOutShape) };
  });
  const id = groupId, memberClipIds = clips.map(clip => clip.id);
  const gainAt = (clip: AudioClip, time: number) => {
    const absolute = clip.startTime + time;
    const transition = transitions.find(item => absolute >= item.startTime - EPSILON && absolute <= item.endTime + EPSILON);
    if (transition) {
      const phase = (absolute - transition.startTime) / (transition.endTime - transition.startTime);
      if (transition.fromClipId === clip.id) return fadeCurve(1 - phase, transition.fadeOutShape);
      if (transition.toClipId === clip.id) return fadeCurve(phase, transition.fadeInShape);
      return 0;
    }
    const sampleTime = absolute === endOf(clip) ? absolute - EPSILON : absolute;
    return spans.find(span => sampleTime >= span.start && sampleTime < span.end)?.owner === clip.id ? 1 : 0;
  };
  const layers = new Map<string, ClipCrossfadeLayer>();
  for (const clip of clips) {
    const localKnots = [...boundaries, ...transitions.flatMap(item => [item.startTime, item.endTime])]
      .map(time => time - clip.startTime).filter(time => time > 0 && time < clip.duration);
    const points = sampleGain(time => gainAt(clip, time), [0, clip.duration, ...localKnots]);
    layers.set(clip.id, { id, memberClipIds: [...memberClipIds], points, offset: 0,
      settings: { fadeInShape: shape(options.fadeInShape), fadeOutShape: shape(options.fadeOutShape),
        ...(options.transitionLength === undefined ? {} : { transitionLength: options.transitionLength }) } });
  }
  return { id, layers, transitions, maximumTransitionLength };
}

export function crossfadeGainAtTime(clip: Pick<AudioClip, "crossfadeLayers">, time: number): number {
  return (clip.crossfadeLayers ?? []).reduce((gain, layer) => gain * interpolateClipGain(layer.points, time + (layer.offset ?? 0)), 1);
}

/** Compose independent crossfades with the manual envelope without overwriting it. */
export function getClipPlaybackGainEnvelope(clip: AudioClip): ClipGainPoint[] {
  if (!clip.crossfadeLayers?.length) return clip.gainEnvelope ?? [];
  const cached = composedEnvelopes.get(clip);
  if (cached) return cached;
  const knots = [0, clip.duration, ...(clip.gainEnvelope ?? []).map(point => point.time),
    ...clip.crossfadeLayers.flatMap(layer => layer.points.map(point => point.time - (layer.offset ?? 0)))]
    .filter(time => time >= 0 && time <= clip.duration);
  const points = sampleGain(time => Math.max(0, Math.min(2,
    interpolateClipGain(clip.gainEnvelope, time) * crossfadeGainAtTime(clip, time))), knots);
  composedEnvelopes.set(clip, points);
  return points;
}

export function cloneCrossfadeLayers(layers: AudioClip["crossfadeLayers"]): AudioClip["crossfadeLayers"] {
  return layers?.map(layer => ({ ...layer, memberClipIds: [...layer.memberClipIds], settings: { ...layer.settings },
    points: layer.points.map(point => ({ ...point })) }));
}

export function windowCrossfadeLayers(layers: AudioClip["crossfadeLayers"], offset: number, _duration: number): AudioClip["crossfadeLayers"] {
  return layers?.map(layer => ({ ...layer, memberClipIds: [...layer.memberClipIds], settings: { ...layer.settings },
    offset: (layer.offset ?? 0) + offset, points: layer.points.map(point => ({ ...point })) }));
}

export function scaleCrossfadeLayers(layers: AudioClip["crossfadeLayers"], scale: number): AudioClip["crossfadeLayers"] {
  return layers?.map(layer => ({ ...layer, memberClipIds: [...layer.memberClipIds], settings: { ...layer.settings,
    transitionLength: layer.settings.transitionLength === undefined ? undefined : layer.settings.transitionLength * scale },
    offset: (layer.offset ?? 0) * scale,
    points: layer.points.map(point => ({ ...point, time: point.time * scale })) }));
}

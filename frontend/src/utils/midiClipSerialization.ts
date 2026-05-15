import { nativeBridge } from "../services/NativeBridge";
import type { MIDIClip, MIDICCEvent, MIDIEvent, MIDITrackEffect } from "../store/useDAWStore";
import { parseMIDINotePairs, sortMIDIEvents } from "./midiNotes";

function clipOffset(clip: MIDIClip): number {
  return Math.max(0, clip.offset || 0);
}

function visibleWindow(clip: MIDIClip) {
  const sourceStart = Math.max(0, Number(clip.sourceStart) || 0);
  const loopOffset = Math.max(0, Number(clip.loopOffset) || 0);
  const offset = sourceStart + loopOffset + clipOffset(clip);
  return {
    offset,
    end: offset + Math.max(0, clip.duration || 0),
  };
}

function sourceLoopLength(clip: MIDIClip): number | null {
  if (clip.loopEnabled === false) return null;
  const loopLength = getMIDIClipSourceLoopLength(clip);
  return loopLength > 0 && loopLength < Math.max(0, clip.duration || 0) - 0.000001
    ? loopLength
    : null;
}

export function getMIDIClipSourceLoopLength(clip: MIDIClip): number {
  const sourceLength = Number(clip.sourceLength);
  if (Number.isFinite(sourceLength) && sourceLength > 0) return sourceLength;

  const explicit = Number(clip.loopLength);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const duration = Math.max(0, clip.duration || 0);
  let contentEnd = 0;
  for (const pair of parseMIDINotePairs(clip.events || [], clip.id)) {
    contentEnd = Math.max(contentEnd, pair.startTime + pair.duration);
  }
  for (const event of clip.events || []) {
    if (event.timestamp !== undefined) contentEnd = Math.max(contentEnd, event.timestamp);
  }
  for (const event of clip.ccEvents || []) {
    if (event.time !== undefined) contentEnd = Math.max(contentEnd, event.time);
  }

  if (contentEnd > 0 && duration > contentEnd + 0.000001) {
    return contentEnd;
  }

  return Math.max(0.01, duration || contentEnd || 4);
}

export function normalizeMIDIClipLoopLength(clip: MIDIClip): MIDIClip {
  const sourceLength = Number(clip.sourceLength);
  const explicit = Number(clip.loopLength);
  if (Number.isFinite(sourceLength) && sourceLength > 0 && Number.isFinite(explicit) && explicit > 0) {
    return clip;
  }
  const length = getMIDIClipSourceLoopLength(clip);
  return {
    ...clip,
    sourceLength: Number.isFinite(sourceLength) && sourceLength > 0 ? sourceLength : length,
    loopLength: Number.isFinite(explicit) && explicit > 0 ? explicit : length,
  };
}

function loopRangeStart(visibleStart: number, sourceEnd: number, loopLength: number) {
  if (loopLength <= 0) return 0;
  return Math.floor((visibleStart - sourceEnd) / loopLength);
}

function loopRangeEnd(visibleEnd: number, sourceStart: number, loopLength: number) {
  if (loopLength <= 0) return 0;
  return Math.ceil((visibleEnd - sourceStart) / loopLength);
}

function loopPointRangeStart(visibleStart: number, sourceTime: number, loopLength: number) {
  if (loopLength <= 0) return 0;
  const firstLoop = Math.ceil((visibleStart - sourceTime) / loopLength);
  return sourceTime >= loopLength - 0.000001 && firstLoop < 0 ? 0 : firstLoop;
}

function clampMIDINote(note: number) {
  return Math.max(0, Math.min(127, Math.round(note)));
}

function clampMIDIVelocity(velocity: number) {
  return Math.max(1, Math.min(127, Math.round(velocity)));
}

function clampMIDIReleaseVelocity(velocity: number) {
  return Math.max(0, Math.min(127, Math.round(velocity)));
}

function clampMIDIChannel(channel?: number) {
  const parsed = Number(channel);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(16, Math.round(parsed))) : 1;
}

function cloneMIDIEvent(event: MIDIEvent): MIDIEvent {
  return { ...event };
}

function normalizeProbability(event: Pick<MIDIEvent, "probability" | "chance"> | { probability?: number; chance?: number }) {
  const raw = event.probability ?? event.chance;
  if (raw === undefined || raw === null) return 1;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric));
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableUnitRandom(seed: string): number {
  return stableHash(seed) / 0xffffffff;
}

function shouldRenderEvent(event: Pick<MIDIEvent, "probability" | "chance" | "playCount"> | { probability?: number; chance?: number; playCount?: number }, seed: string, loopIndex: number) {
  const playCount = Number(event.playCount);
  if (Number.isFinite(playCount) && playCount > 0 && loopIndex >= Math.round(playCount)) return false;
  const probability = normalizeProbability(event);
  if (probability >= 1) return true;
  if (probability <= 0) return false;
  return stableUnitRandom(seed) <= probability;
}

function applyVelocityVariance(velocity: number, event: MIDIEvent, seed: string) {
  const amount = Math.max(0, Math.abs(Number(event.velocityVariance) || 0));
  if (amount <= 0) return clampMIDIVelocity(velocity);
  const delta = Math.round((stableUnitRandom(seed) * 2 - 1) * amount);
  return clampMIDIVelocity(velocity + delta);
}

function serializedEventPriority(event: { type: string }) {
  if (event.type === "noteOn") return 0;
  if (event.type === "noteOff") return 2;
  return 1;
}

function applyPitchEffect(events: MIDIEvent[], semitones: number): MIDIEvent[] {
  const shift = Math.round(Number(semitones) || 0);
  if (shift === 0) return events.map(cloneMIDIEvent);
  return events.map((event) => {
    if (
      (event.type === "noteOn" || event.type === "noteOff" || event.type === "polyPressure")
      && event.note !== undefined
    ) {
      return { ...event, note: clampMIDINote(event.note + shift) };
    }
    return cloneMIDIEvent(event);
  });
}

function applyVelocityEffect(events: MIDIEvent[], scale = 1, offset = 0): MIDIEvent[] {
  const velocityScale = Number.isFinite(scale) ? scale : 1;
  const velocityOffset = Number.isFinite(offset) ? offset : 0;
  if (Math.abs(velocityScale - 1) < 0.000001 && Math.abs(velocityOffset) < 0.000001) {
    return events.map(cloneMIDIEvent);
  }
  return events.map((event) => {
    if (event.type === "noteOn" && event.velocity !== undefined) {
      return { ...event, velocity: clampMIDIVelocity(event.velocity * velocityScale + velocityOffset) };
    }
    return cloneMIDIEvent(event);
  });
}

function applyTimeGrooveEffect(events: MIDIEvent[], effect: MIDITrackEffect): MIDIEvent[] {
  const offsetSeconds = ((effect.offsetMs ?? 0) / 1000) || 0;
  const gridSeconds = Math.max(0.001, effect.gridSeconds ?? 0.25);
  const swing = Math.max(-1, Math.min(1, effect.swing ?? 0));
  if (Math.abs(offsetSeconds) < 0.000001 && Math.abs(swing) < 0.000001) {
    return events.map(cloneMIDIEvent);
  }
  return sortMIDIEvents(events.map((event) => {
    const originalTime = Number(event.timestamp) || 0;
    const gridIndex = Math.round(originalTime / gridSeconds);
    const swingOffset = Math.abs(gridIndex % 2) === 1 ? gridSeconds * swing * 0.5 : 0;
    return {
      ...event,
      timestamp: Math.max(0, originalTime + offsetSeconds + swingOffset),
    };
  }));
}

function arpPatternNotes(group: ReturnType<typeof parseMIDINotePairs>, effect: MIDITrackEffect) {
  const octaves = Math.max(1, Math.min(4, Math.round(effect.octaves ?? 1)));
  const mode = effect.mode ?? "up";
  const ordered = [...group].sort((a, b) => {
    if (mode === "asPlayed") return a.onIndex - b.onIndex;
    return mode === "down" ? b.noteNumber - a.noteNumber : a.noteNumber - b.noteNumber;
  });
  const expanded = ordered.flatMap((pair) =>
    Array.from({ length: octaves }, (_, octave) => ({
      ...pair,
      noteNumber: clampMIDINote(pair.noteNumber + octave * 12),
    })),
  );
  if (mode !== "upDown" || expanded.length <= 2) return expanded;
  return [...expanded, ...expanded.slice(1, -1).reverse()];
}

function applyArpeggiatorEffect(events: MIDIEvent[], effect: MIDITrackEffect): MIDIEvent[] {
  const rateSeconds = Math.max(0.01, effect.rateSeconds ?? 0.125);
  const gate = Math.max(0.05, Math.min(1, effect.gate ?? 0.85));
  const pairs = parseMIDINotePairs(events, "midi-fx");
  if (pairs.length === 0) return events.map(cloneMIDIEvent);

  const consumed = new Set<number>();
  const groups = new Map<string, typeof pairs>();
  for (const pair of pairs) {
    consumed.add(pair.onIndex);
    consumed.add(pair.offIndex);
    const key = pair.startTime.toFixed(6);
    const group = groups.get(key) ?? [];
    group.push(pair);
    groups.set(key, group);
  }

  const generated: MIDIEvent[] = [];
  for (const group of groups.values()) {
    const groupStart = Math.min(...group.map((pair) => pair.startTime));
    const groupEnd = Math.max(...group.map((pair) => pair.startTime + pair.duration));
    const pattern = arpPatternNotes(group, effect);
    if (pattern.length === 0 || groupEnd <= groupStart) continue;
    let stepIndex = 0;
    for (let time = groupStart; time < groupEnd - 0.000001; time += rateSeconds) {
      const source = pattern[stepIndex % pattern.length];
      const noteEnd = Math.min(groupEnd, time + rateSeconds * gate);
      if (noteEnd <= time) continue;
      generated.push(
        {
          ...source.noteOn,
          type: "noteOn",
          timestamp: time,
          note: source.noteNumber,
          velocity: source.velocity,
        },
        {
          ...source.noteOff,
          type: "noteOff",
          timestamp: noteEnd,
          note: source.noteNumber,
          velocity: 0,
        },
      );
      stepIndex += 1;
    }
  }

  const retained = events
    .filter((_, index) => !consumed.has(index))
    .map(cloneMIDIEvent);
  return sortMIDIEvents([...retained, ...generated]);
}

export function applyMIDITrackEffects(events: MIDIEvent[], effects: MIDITrackEffect[] = []): MIDIEvent[] {
  return effects
    .filter((effect) => effect.enabled !== false)
    .reduce((current, effect) => {
      if (effect.type === "pitch") return applyPitchEffect(current, effect.semitones ?? 0);
      if (effect.type === "velocity") return applyVelocityEffect(current, effect.scale ?? 1, effect.offset ?? 0);
      if (effect.type === "time") return applyTimeGrooveEffect(current, effect);
      if (effect.type === "arpeggiator") return applyArpeggiatorEffect(current, effect);
      return current.map(cloneMIDIEvent);
    }, events.map(cloneMIDIEvent));
}

export function getVisibleMIDIEventsForClip(clip: MIDIClip): MIDIEvent[] {
  const { offset, end } = visibleWindow(clip);
  const duration = Math.max(0, clip.duration || 0);
  const loopLength = sourceLoopLength(clip);
  const events: MIDIEvent[] = [];
  const consumed = new Set<number>();

  for (const pair of parseMIDINotePairs(clip.events || [], clip.id)) {
    consumed.add(pair.onIndex);
    consumed.add(pair.offIndex);
    const pairStart = pair.startTime;
    const pairEnd = pair.startTime + pair.duration;
    if (pair.muted) continue;

    const firstLoop = loopLength ? loopRangeStart(offset, pairEnd, loopLength) : 0;
    const lastLoop = loopLength ? loopRangeEnd(end, pairStart, loopLength) : 0;

    for (let loopIndex = firstLoop; loopIndex <= lastLoop; loopIndex += 1) {
      const loopOffset = loopLength ? loopIndex * loopLength : 0;
      const renderedStart = pairStart + loopOffset;
      const renderedEnd = pairEnd + loopOffset;
      if (renderedEnd <= offset || renderedStart >= end) continue;
      const visibleLoopIndex = loopLength ? Math.max(0, loopIndex) : 0;
      const seed = `${clip.id}:note:${pair.startTime}:${pair.noteNumber}:${pair.channel ?? ""}:${visibleLoopIndex}`;
      if (!shouldRenderEvent(pair.noteOn, seed, visibleLoopIndex)) continue;

      const start = Math.max(0, renderedStart - offset);
      const noteEnd = Math.min(duration, renderedEnd - offset);
      if (noteEnd <= start) continue;
      const velocity = applyVelocityVariance(pair.velocity, pair.noteOn, seed);
      const releaseVelocity = clampMIDIReleaseVelocity(
        pair.releaseVelocity ?? pair.noteOff.releaseVelocity ?? pair.noteOff.velocity ?? 0,
      );

      const noteOffEvent: MIDIEvent = {
          ...pair.noteOff,
          timestamp: noteEnd,
          type: "noteOff",
          note: pair.noteNumber,
          channel: pair.channel,
          velocity: releaseVelocity,
          muted: pair.muted,
        };
      if (pair.releaseVelocity !== undefined || pair.noteOff.releaseVelocity !== undefined) {
        noteOffEvent.releaseVelocity = releaseVelocity;
      }

      events.push(
        {
          ...pair.noteOn,
          timestamp: start,
          type: "noteOn",
          note: pair.noteNumber,
          channel: pair.channel,
          velocity,
          muted: pair.muted,
        },
        noteOffEvent,
      );
    }
  }

  for (let index = 0; index < (clip.events || []).length; index += 1) {
    const event = clip.events[index];
    if (consumed.has(index) || event.muted) continue;
    const eventTime = Number(event.timestamp);
    if (!Number.isFinite(eventTime)) continue;

    const firstLoop = loopLength ? loopPointRangeStart(offset, eventTime, loopLength) : 0;
    const lastLoop = loopLength ? loopRangeEnd(end, eventTime, loopLength) : 0;
    for (let loopIndex = firstLoop; loopIndex <= lastLoop; loopIndex += 1) {
      const renderedTime = eventTime + (loopLength ? loopIndex * loopLength : 0);
      if (renderedTime < offset || renderedTime >= end) continue;
      const visibleLoopIndex = loopLength ? Math.max(0, loopIndex) : 0;
      const seed = `${clip.id}:${event.type}:${eventTime}:${event.note ?? ""}:${event.controller ?? ""}:${visibleLoopIndex}`;
      if (!shouldRenderEvent(event, seed, visibleLoopIndex)) continue;
      events.push({ ...event, timestamp: Math.max(0, renderedTime - offset) });
    }
  }

  return sortMIDIEvents(events);
}

function getVisibleMIDICCEventsForClip(clip: MIDIClip): MIDICCEvent[] {
  const { offset, end } = visibleWindow(clip);
  const loopLength = sourceLoopLength(clip);
  const events: MIDICCEvent[] = [];

  for (const event of clip.ccEvents || []) {
    const eventTime = Number(event.time);
    if (!Number.isFinite(eventTime)) continue;

    const firstLoop = loopLength ? loopPointRangeStart(offset, eventTime, loopLength) : 0;
    const lastLoop = loopLength ? loopRangeEnd(end, eventTime, loopLength) : 0;
    for (let loopIndex = firstLoop; loopIndex <= lastLoop; loopIndex += 1) {
      const renderedTime = eventTime + (loopLength ? loopIndex * loopLength : 0);
      if (renderedTime < offset || renderedTime >= end) continue;
      const visibleLoopIndex = loopLength ? Math.max(0, loopIndex) : 0;
      const seed = `${clip.id}:cc:${event.cc}:${eventTime}:${visibleLoopIndex}`;
      if (!shouldRenderEvent(event, seed, visibleLoopIndex)) continue;
      events.push({
        ...event,
        time: Math.max(0, renderedTime - offset),
      });
    }
  }

  return events.sort((a, b) => a.time - b.time);
}

export function serializeMIDIClipsForBackend(clips: MIDIClip[], midiEffects: MIDITrackEffect[] = []) {
  return clips.filter((clip) => !clip.muted).map((clip) => {
    const visibleEvents: MIDIEvent[] = [
      ...getVisibleMIDIEventsForClip(clip).filter((event) => !event.muted),
      ...getVisibleMIDICCEventsForClip(clip).map((event) => ({
        type: "cc" as const,
        timestamp: event.time,
        controller: event.cc,
        value: event.value,
        channel: event.channel,
      })),
    ];
    const processedEvents = applyMIDITrackEffects(
      sortMIDIEvents(visibleEvents),
      midiEffects,
    );
    return {
      id: clip.id,
      startTime: clip.startTime,
      duration: clip.duration,
      events: processedEvents.map((event) => {
        const serialized: {
          type: MIDIEvent["type"];
          timestamp: number;
          note?: number;
          velocity?: number;
          releaseVelocity?: number;
          controller?: number;
          value?: number;
          channel: number;
          probability?: number;
          chance?: number;
          playCount?: number;
          velocityVariance?: number;
          centOffset?: number;
        } = {
          type: event.type,
          timestamp: event.timestamp,
          note: event.note,
          velocity: event.type === "noteOff"
            ? clampMIDIReleaseVelocity(event.releaseVelocity ?? event.velocity ?? 0)
            : event.velocity,
          controller: event.controller,
          value: event.type === "pitchBend"
            ? (event.value ?? event.pitchBend ?? 8192)
            : event.value,
          channel: clampMIDIChannel(event.channel),
        };

        if (event.type === "noteOff" && event.releaseVelocity !== undefined) {
          serialized.releaseVelocity = clampMIDIReleaseVelocity(event.releaseVelocity);
        }
        if (event.probability !== undefined) serialized.probability = event.probability;
        if (event.chance !== undefined) serialized.chance = event.chance;
        if (event.playCount !== undefined) serialized.playCount = event.playCount;
        if (event.velocityVariance !== undefined) serialized.velocityVariance = event.velocityVariance;
        if (event.centOffset !== undefined) serialized.centOffset = event.centOffset;
        return serialized;
      }).sort((a, b) => a.timestamp - b.timestamp || serializedEventPriority(a) - serializedEventPriority(b)),
    };
  });
}

export async function syncTrackMIDIClipsToBackend(trackId: string, clips: MIDIClip[], midiEffects: MIDITrackEffect[] = []) {
  return nativeBridge.setTrackMIDIClips(trackId, serializeMIDIClipsForBackend(clips, midiEffects));
}

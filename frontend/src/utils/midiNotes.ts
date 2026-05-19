import type { MIDIEvent } from "../store/useDAWStore";

export const MIDI_NOTE_MIN_DURATION = 0.01;

export interface MIDINotePair {
  id: string;
  onIndex: number;
  offIndex: number;
  noteOn: MIDIEvent;
  noteOff: MIDIEvent;
  noteNumber: number;
  channel?: number;
  velocity: number;
  releaseVelocity?: number;
  startTime: number;
  duration: number;
  pitchBend?: number;
  pressure?: number;
  slide?: number;
  probability?: number;
  chance?: number;
  playCount?: number;
  velocityVariance?: number;
  centOffset?: number;
  muted?: boolean;
}

export interface MIDINoteClipboardItem {
  noteNumber: number;
  channel?: number;
  startTime: number;
  duration: number;
  velocity: number;
  releaseVelocity?: number;
  pitchBend?: number;
  pressure?: number;
  slide?: number;
  probability?: number;
  chance?: number;
  playCount?: number;
  velocityVariance?: number;
  centOffset?: number;
  muted?: boolean;
}

export type NoteMetadataLaneType = "noteOffVelocity" | "chance" | "velocityVariance";

export type NoteMetadataEditablePair = Pick<
  MIDINotePair,
  "noteOff" | "noteNumber" | "releaseVelocity" | "channel" | "startTime" | "duration" | "probability" | "chance" | "velocityVariance"
>;

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function cloneMIDIEvents(events: MIDIEvent[] = []): MIDIEvent[] {
  return events.map((event) => ({ ...event }));
}

export function sortMIDIEvents(events: MIDIEvent[]): MIDIEvent[] {
  return cloneMIDIEvents(events).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.type === b.type) return 0;
    return a.type === "noteOff" ? 1 : -1;
  });
}

export function clampMIDINote(note: number): number {
  return Math.max(0, Math.min(127, Math.round(note)));
}

export function clampMIDIVelocity(velocity: number): number {
  return Math.max(1, Math.min(127, Math.round(velocity)));
}

export function noteIdFor(clipId: string, timestamp: number, note: number): string {
  return `${clipId}:${timestamp.toFixed(6)}:${note}`;
}

export function parseNoteIdentity(noteId: string): { timestamp: number; note: number } | null {
  const parts = String(noteId).split(":");
  const note = Number.parseInt(parts[parts.length - 1], 10);
  const timestamp = Number.parseFloat(parts[parts.length - 2]);
  return Number.isFinite(timestamp) && Number.isFinite(note)
    ? { timestamp, note }
    : null;
}

export function noteIdentityMatches(
  noteId: string,
  timestamp: number,
  note: number,
): boolean {
  const parsed = parseNoteIdentity(noteId);
  return !!parsed && Math.abs(parsed.timestamp - timestamp) < 0.001 && parsed.note === note;
}

export function noteMetadataLaneName(type: NoteMetadataLaneType): string {
  if (type === "noteOffVelocity") return "note-off velocity";
  if (type === "chance") return "chance";
  return "velocity variance";
}

export function noteMetadataLaneMax(type: NoteMetadataLaneType): number {
  return type === "chance" ? 100 : 127;
}

export function noteMetadataValueForPair(
  pair: NoteMetadataEditablePair,
  type: NoteMetadataLaneType,
): number {
  if (type === "noteOffVelocity") {
    return clampNumber(Math.round(pair.releaseVelocity ?? pair.noteOff.releaseVelocity ?? pair.noteOff.velocity ?? 0), 0, 127);
  }
  if (type === "chance") {
    const raw = pair.probability ?? pair.chance ?? 1;
    return clampNumber(Math.round((raw > 1 ? raw / 100 : raw) * 100), 0, 100);
  }
  return clampNumber(Math.round(pair.velocityVariance ?? 0), 0, 127);
}

export function applyNoteMetadataValueToEvents(
  events: MIDIEvent[],
  pair: NoteMetadataEditablePair,
  type: NoteMetadataLaneType,
  value: number,
): MIDIEvent[] {
  const noteChannel = pair.channel ?? 1;
  const noteOffTime = pair.startTime + pair.duration;
  return events.map((event) => {
    const sameNote = event.note === pair.noteNumber && (event.channel ?? 1) === noteChannel;
    if (!sameNote) return event;

    if (
      type === "noteOffVelocity"
      && event.type === "noteOff"
      && Math.abs(event.timestamp - noteOffTime) < 0.000001
    ) {
      const releaseVelocity = clampNumber(Math.round(value), 0, 127);
      return { ...event, velocity: releaseVelocity, releaseVelocity };
    }

    if (
      type === "chance"
      && event.type === "noteOn"
      && Math.abs(event.timestamp - pair.startTime) < 0.000001
    ) {
      const nextEvent: MIDIEvent = { ...event, probability: clampNumber(value / 100, 0, 1) };
      delete nextEvent.chance;
      return nextEvent;
    }

    if (
      type === "velocityVariance"
      && event.type === "noteOn"
      && Math.abs(event.timestamp - pair.startTime) < 0.000001
    ) {
      return { ...event, velocityVariance: clampNumber(Math.round(value), 0, 127) };
    }

    return event;
  });
}

export function parseMIDINotePairs(events: MIDIEvent[] = [], clipId = ""): MIDINotePair[] {
  const pairs: MIDINotePair[] = [];
  const usedNoteOffs = new Set<number>();

  for (let onIndex = 0; onIndex < events.length; onIndex += 1) {
    const noteOn = events[onIndex];
    if (noteOn.type !== "noteOn" || noteOn.note === undefined) continue;

    let offIndex = -1;
    for (let index = 0; index < events.length; index += 1) {
      const candidate = events[index];
      if (
        usedNoteOffs.has(index) ||
        candidate.type !== "noteOff" ||
        candidate.note !== noteOn.note ||
        (candidate.channel ?? noteOn.channel ?? 1) !== (noteOn.channel ?? candidate.channel ?? 1) ||
        candidate.timestamp <= noteOn.timestamp
      ) {
        continue;
      }

      if (offIndex === -1 || candidate.timestamp < events[offIndex].timestamp) {
        offIndex = index;
      }
    }

    if (offIndex === -1) continue;
    usedNoteOffs.add(offIndex);

    const noteOff = events[offIndex];
    pairs.push({
      id: noteIdFor(clipId, noteOn.timestamp, noteOn.note),
      onIndex,
      offIndex,
      noteOn,
      noteOff,
      noteNumber: noteOn.note,
      channel: noteOn.channel ?? noteOff.channel,
      velocity: noteOn.velocity || 80,
      releaseVelocity: noteOff.releaseVelocity ?? ((noteOff.velocity ?? 0) > 0 ? noteOff.velocity : undefined),
      startTime: noteOn.timestamp,
      duration: Math.max(MIDI_NOTE_MIN_DURATION, noteOff.timestamp - noteOn.timestamp),
      pitchBend: noteOn.pitchBend,
      pressure: noteOn.pressure,
      slide: noteOn.slide,
      probability: noteOn.probability,
      chance: noteOn.chance,
      playCount: noteOn.playCount,
      velocityVariance: noteOn.velocityVariance,
      centOffset: noteOn.centOffset,
      muted: Boolean(noteOn.muted || noteOff.muted),
    });
  }

  return pairs;
}

export function rebuildMIDIEventsForNotes(
  events: MIDIEvent[],
  clipId: string,
  noteIds: string[],
  transform: (pair: MIDINotePair) => Partial<MIDINotePair> | null,
): { events: MIDIEvent[]; nextIds: string[]; auditionPair?: MIDINotePair } {
  const consumed = new Set<number>();
  const additions: MIDIEvent[] = [];
  const nextIds: string[] = [];
  let auditionPair: MIDINotePair | undefined;

  for (const pair of parseMIDINotePairs(events, clipId)) {
    const selected = noteIds.some((id) =>
      id === pair.id || noteIdentityMatches(id, pair.startTime, pair.noteNumber),
    );
    if (!selected) continue;

    consumed.add(pair.onIndex);
    consumed.add(pair.offIndex);

    const transformed = transform(pair);
    if (!transformed) continue;

    const nextStart = Math.max(0, transformed.startTime ?? pair.startTime);
    const nextDuration = Math.max(
      MIDI_NOTE_MIN_DURATION,
      transformed.duration ?? pair.duration,
    );
    const nextNote = clampMIDINote(transformed.noteNumber ?? pair.noteNumber);
    const nextVelocity = clampMIDIVelocity(transformed.velocity ?? pair.velocity);
    const nextReleaseVelocity = clampNumber(
      Math.round(transformed.releaseVelocity ?? pair.releaseVelocity ?? pair.noteOff.velocity ?? 0),
      0,
      127,
    );
    const nextMuted = transformed.muted ?? pair.muted;
    const nextChannel = transformed.channel ?? pair.channel;

    const noteOff: MIDIEvent = {
      ...pair.noteOff,
      timestamp: nextStart + nextDuration,
      type: "noteOff",
      note: nextNote,
      channel: nextChannel,
      velocity: nextReleaseVelocity,
      muted: nextMuted,
    };
    if (
      transformed.releaseVelocity !== undefined
      || pair.releaseVelocity !== undefined
      || pair.noteOff.releaseVelocity !== undefined
    ) {
      noteOff.releaseVelocity = nextReleaseVelocity;
    }

    const noteOn: MIDIEvent = {
      ...pair.noteOn,
      timestamp: nextStart,
      type: "noteOn",
      note: nextNote,
      channel: nextChannel,
      velocity: nextVelocity,
      pitchBend: transformed.pitchBend ?? pair.pitchBend,
      pressure: transformed.pressure ?? pair.pressure,
      slide: transformed.slide ?? pair.slide,
      probability: transformed.probability ?? pair.probability,
      chance: transformed.chance ?? pair.chance,
      playCount: transformed.playCount ?? pair.playCount,
      velocityVariance: transformed.velocityVariance ?? pair.velocityVariance,
      centOffset: transformed.centOffset ?? pair.centOffset,
      muted: nextMuted,
    };

    additions.push(noteOn, noteOff);
    const nextId = noteIdFor(clipId, nextStart, nextNote);
    nextIds.push(nextId);
    auditionPair ||= {
      ...pair,
      ...transformed,
      id: nextId,
      onIndex: -1,
      offIndex: -1,
      noteOn,
      noteOff,
      noteNumber: nextNote,
      channel: nextChannel,
      velocity: nextVelocity,
      releaseVelocity: nextReleaseVelocity,
      startTime: nextStart,
      duration: nextDuration,
      muted: nextMuted,
    };
  }

  return {
    events: sortMIDIEvents([...events.filter((_, index) => !consumed.has(index)), ...additions]),
    nextIds,
    auditionPair,
  };
}

export function clipboardItemsFromPairs(pairs: MIDINotePair[]): MIDINoteClipboardItem[] {
  if (pairs.length === 0) return [];
  const earliest = Math.min(...pairs.map((pair) => pair.startTime));
  return pairs.map((pair) => ({
    noteNumber: pair.noteNumber,
    channel: pair.channel,
    startTime: pair.startTime - earliest,
    duration: pair.duration,
    velocity: pair.velocity,
    releaseVelocity: pair.releaseVelocity,
    pitchBend: pair.pitchBend,
    pressure: pair.pressure,
    slide: pair.slide,
    probability: pair.probability,
    chance: pair.chance,
    playCount: pair.playCount,
    velocityVariance: pair.velocityVariance,
    centOffset: pair.centOffset,
    muted: pair.muted,
  }));
}

export function eventsFromClipboardItems(
  clipId: string,
  items: MIDINoteClipboardItem[],
  pasteTime: number,
  clipDuration: number,
): { events: MIDIEvent[]; ids: string[] } {
  const events: MIDIEvent[] = [];
  const ids: string[] = [];

  for (const item of items) {
    const start = Math.max(0, Math.min(clipDuration - MIDI_NOTE_MIN_DURATION, pasteTime + item.startTime));
    const duration = Math.max(
      MIDI_NOTE_MIN_DURATION,
      Math.min(item.duration, Math.max(MIDI_NOTE_MIN_DURATION, clipDuration - start)),
    );
    const note = clampMIDINote(item.noteNumber);
    const velocity = clampMIDIVelocity(item.velocity);
    const noteOff: MIDIEvent = {
      timestamp: start + duration,
      type: "noteOff",
      note,
      channel: item.channel,
      velocity: item.releaseVelocity ?? 0,
      muted: item.muted,
    };
    if (item.releaseVelocity !== undefined) noteOff.releaseVelocity = item.releaseVelocity;

    events.push(
      {
        timestamp: start,
        type: "noteOn",
        note,
        channel: item.channel,
        velocity,
        pitchBend: item.pitchBend,
        pressure: item.pressure,
        slide: item.slide,
        probability: item.probability,
        chance: item.chance,
        playCount: item.playCount,
        velocityVariance: item.velocityVariance,
        centOffset: item.centOffset,
        muted: item.muted,
      },
      noteOff,
    );
    ids.push(noteIdFor(clipId, start, note));
  }

  return { events: sortMIDIEvents(events), ids };
}

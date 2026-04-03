import type {
  MIDIEvent,
  RecordingMIDIPreviewActiveNote,
} from "../store/useDAWStore";

export interface MIDIThumbnailBar {
  note: number;
  start: number;
  end: number;
}

function getPendingStack(
  pendingStarts: Map<number, number[]>,
  note: number,
): number[] {
  const existing = pendingStarts.get(note);
  if (existing) {
    return existing;
  }

  const created: number[] = [];
  pendingStarts.set(note, created);
  return created;
}

export function buildMIDIThumbnailBars(
  events: MIDIEvent[],
  duration: number,
  activeNotes: RecordingMIDIPreviewActiveNote[] = [],
): MIDIThumbnailBar[] {
  const bars: MIDIThumbnailBar[] = [];
  const pendingStarts = new Map<number, number[]>();

  for (const event of events) {
    if (event.note === undefined) continue;

    if (event.type === "noteOn") {
      getPendingStack(pendingStarts, event.note).push(event.timestamp);
      continue;
    }

    if (event.type !== "noteOff") continue;

    const pending = pendingStarts.get(event.note);
    if (!pending || pending.length === 0) continue;

    const start = pending.shift() ?? event.timestamp;
    bars.push({
      note: event.note,
      start,
      end: Math.max(start, event.timestamp),
    });

    if (pending.length === 0) {
      pendingStarts.delete(event.note);
    }
  }

  if (activeNotes.length > 0) {
    for (const activeNote of activeNotes) {
      bars.push({
        note: activeNote.note,
        start: activeNote.startTimestamp,
        end: Math.max(activeNote.startTimestamp, duration),
      });
    }
  } else {
    for (const [note, starts] of pendingStarts.entries()) {
      for (const start of starts) {
        bars.push({
          note,
          start,
          end: Math.max(start, duration),
        });
      }
    }
  }

  bars.sort((a, b) => a.start - b.start || a.note - b.note || a.end - b.end);
  return bars;
}

export function sampleMIDIThumbnailBars(
  bars: MIDIThumbnailBar[],
  width: number,
): MIDIThumbnailBar[] {
  if (bars.length <= 1) {
    return bars;
  }

  const renderBudget = Math.max(64, Math.floor(width / 4));
  if (bars.length <= renderBudget) {
    return bars;
  }

  const sampled: MIDIThumbnailBar[] = [];
  let previousIndex = -1;
  for (let sampleIndex = 0; sampleIndex < renderBudget; sampleIndex++) {
    const barIndex = Math.floor(
      (sampleIndex * (bars.length - 1)) / Math.max(1, renderBudget - 1),
    );
    if (barIndex === previousIndex) continue;
    sampled.push(bars[barIndex]);
    previousIndex = barIndex;
  }

  return sampled;
}

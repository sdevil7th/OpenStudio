import type {
  MIDIEvent,
  RecordingMIDIPreviewActiveNote,
} from "../store/useDAWStore";

export interface MIDIThumbnailBar {
  note: number;
  start: number;
  end: number;
}

/** Incremental onset-ordered index. Repaints only visit visible note blocks. */
export class MIDIThumbnailIndex {
  private events: MIDIEvent[] = [];
  private bars: MIDIThumbnailBar[] = [];
  private pending = new Map<number, MIDIThumbnailBar[]>();
  private blockEnds: number[] = [];
  private barIndices = new Map<MIDIThumbnailBar, number>();
  private minimum = 127;
  private maximum = 0;
  private static readonly blockSize = 128;

  update(events: MIDIEvent[]): void {
    if (events === this.events) return;
    const appended = events.length > this.events.length
      && (this.events.length === 0 || (events[0] === this.events[0]
        && events[this.events.length - 1] === this.events[this.events.length - 1]));
    let start = this.events.length;
    if (!appended) {
      start = 0;
      this.bars = [];
      this.pending.clear();
      this.blockEnds = [];
      this.barIndices.clear();
      this.minimum = 127;
      this.maximum = 0;
    }
    for (let i = start; i < events.length; i++) {
      const event = events[i];
      if (event.note === undefined) continue;
      const noteKey = Math.max(1, event.channel ?? 1) * 128 + event.note;
      if (event.type === "noteOn" && (event.velocity ?? 1) > 0) {
        const bar = { note: event.note, start: event.timestamp, end: Infinity };
        this.barIndices.set(bar, this.bars.length);
        this.bars.push(bar);
        const pending = this.pending.get(noteKey) ?? [];
        pending.push(bar);
        this.pending.set(noteKey, pending);
        this.blockEnds[Math.floor((this.bars.length - 1) / MIDIThumbnailIndex.blockSize)] = Infinity;
        this.minimum = Math.min(this.minimum, event.note);
        this.maximum = Math.max(this.maximum, event.note);
      } else if (event.type === "noteOff" || (event.type === "noteOn" && event.velocity === 0)) {
        const pending = this.pending.get(noteKey);
        const bar = pending?.shift();
        if (!bar) continue;
        bar.end = Math.max(bar.start, event.timestamp);
        if (pending?.length === 0) this.pending.delete(noteKey);
        const block = Math.floor(this.barIndices.get(bar)! / MIDIThumbnailIndex.blockSize);
        let end = -Infinity;
        for (let j = block * MIDIThumbnailIndex.blockSize;
          j < Math.min(this.bars.length, (block + 1) * MIDIThumbnailIndex.blockSize); j++) {
          end = Math.max(end, this.bars[j].end);
        }
        this.blockEnds[block] = end;
      }
    }
    this.events = events;
  }

  get pitchRange(): { min: number; max: number } {
    return this.bars.length ? { min: this.minimum, max: this.maximum } : { min: 60, max: 60 };
  }

  visible(start: number, end: number, duration: number): MIDIThumbnailBar[] {
    const result: MIDIThumbnailBar[] = [];
    for (let block = 0; block < this.blockEnds.length; block++) {
      const first = block * MIDIThumbnailIndex.blockSize;
      if (this.bars[first].start > end) break;
      if (this.blockEnds[block] < start) continue;
      for (let i = first; i < Math.min(this.bars.length, first + MIDIThumbnailIndex.blockSize); i++) {
        const bar = this.bars[i];
        if (bar.start > end) break;
        const noteEnd = Math.min(duration, bar.end);
        if (noteEnd < start) continue;
        result.push({ ...bar, end: noteEnd });
      }
    }
    return result;
  }

  /** Same sampling as visible() followed by sampleMIDIThumbnailBars(), without
   * allocating every visible historical bar. Whole visible blocks are counted
   * at once; only boundary/held-note blocks need individual visibility checks. */
  sampleVisible(start: number, end: number, duration: number, width: number): MIDIThumbnailBar[] {
    const ranges: Array<{ first: number; last: number; count: number; all: boolean }> = [];
    let count = 0;
    for (let block = 0; block < this.blockEnds.length; block++) {
      const first = block * MIDIThumbnailIndex.blockSize;
      if (this.bars[first].start > end) break;
      if (this.blockEnds[block] < start) continue;
      let last = Math.min(this.bars.length, first + MIDIThumbnailIndex.blockSize);
      while (last > first && this.bars[last - 1].start > end) last--;
      const all = this.bars[first].start >= start && duration >= start;
      let visibleCount = all ? last - first : 0;
      if (!all) for (let i = first; i < last; i++) if (!(Math.min(duration, this.bars[i].end) < start)) visibleCount++;
      if (visibleCount) { ranges.push({ first, last, count: visibleCount, all }); count += visibleCount; }
    }
    const budget = Math.max(64, Math.floor(width / 4));
    if (!count || (count > 1 && Number.isNaN(budget))) return [];
    const selectedCount = count <= 1 || count <= budget ? count : budget;
    const result: MIDIThumbnailBar[] = [];
    let ordinal = 0, selection = 0;
    const target = () => selectedCount === count ? selection : Math.floor(selection * (count - 1) / (selectedCount - 1));
    const append = (bar: MIDIThumbnailBar) => { result.push({ ...bar, end: Math.min(duration, bar.end) }); selection++; };
    for (const range of ranges) {
      if (selection >= selectedCount) break;
      if (range.all) {
        while (selection < selectedCount && target() < ordinal + range.count) append(this.bars[range.first + target() - ordinal]);
        ordinal += range.count;
      } else {
        for (let i = range.first; i < range.last && selection < selectedCount; i++) {
          const bar = this.bars[i];
          if (Math.min(duration, bar.end) < start) continue;
          if (ordinal === target()) append(bar);
          ordinal++;
        }
      }
    }
    return result;
  }
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

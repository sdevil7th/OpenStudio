interface Request { priority: number; run: () => Promise<void>; relevant: () => boolean }

/** Bounds bridge pressure; visible requests can promote queued lookahead work. */
export class WaveformRequestQueue {
  private pending = new Map<string, Request>();
  private active = new Set<string>();
  private scheduled = false;
  constructor(private readonly concurrency = 4, private readonly maximumQueued = 128) {}

  enqueue(key: string, priority: number, run: () => Promise<void>, relevant: () => boolean): void {
    const previous = this.pending.get(key);
    this.pending.set(key, { priority: Math.min(priority, previous?.priority ?? priority), run, relevant });
    // Drop obsolete requests first, then speculative work. A future viewport
    // render can request an evicted visible tile again without a stuck guard.
    for (const [id, task] of this.pending) if (!task.relevant()) this.pending.delete(id);
    while (this.pending.size > this.maximumQueued) {
      const worst = [...this.pending].sort((a, b) => b[1].priority - a[1].priority)[0];
      this.pending.delete(worst[0]);
    }
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; this.pump(); });
    }
  }
  clear(): void { this.pending.clear(); }
  get activeCount(): number { return this.active.size; }
  get queuedCount(): number { return this.pending.size; }
  private pump(): void {
    while (this.active.size < this.concurrency) {
      const next = [...this.pending].filter(([key]) => !this.active.has(key)).sort((a, b) => a[1].priority - b[1].priority)[0];
      if (!next) return;
      const [key, task] = next;
      this.pending.delete(key);
      if (!task.relevant()) continue;
      this.active.add(key);
      void Promise.resolve().then(task.run).catch(error => console.error("Waveform request failed", error)).finally(() => {
        this.active.delete(key); this.pump();
      });
    }
  }
}

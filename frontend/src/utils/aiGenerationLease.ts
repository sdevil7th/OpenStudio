/** Reject late replies after cancellation, closure, or a newer generation. */
export class AIGenerationLease {
  private generation = 0;
  private requestId = "";
  begin(): number { this.requestId = ""; return ++this.generation; }
  invalidate(): void { ++this.generation; this.requestId = ""; }
  bind(generation: number, requestId?: string): void {
    if (this.accepts(generation)) this.requestId = requestId ?? "";
  }
  accepts(generation: number, requestId?: string): boolean {
    return generation === this.generation
      && (!this.requestId || !requestId || requestId === this.requestId);
  }
}

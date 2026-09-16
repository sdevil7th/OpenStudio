export type BuiltInPluginParamHistoryChange = {
  paramId: string;
  label: string;
  before: number;
  after: number;
};

export type BuiltInPluginParamHistoryEntry = {
  instanceId: string;
  changes: BuiltInPluginParamHistoryChange[];
};

export type BuiltInPluginHistoryDirection = "before" | "after";

export type BuiltInPluginHistoryReplay = (
  entry: BuiltInPluginParamHistoryEntry,
  direction: BuiltInPluginHistoryDirection,
) => Promise<boolean>;

type ActiveParamEdit = BuiltInPluginParamHistoryEntry;

export type BuiltInPluginHistoryResult = "applied" | "empty" | "failed";

/**
 * Async, processor-instance-scoped history for built-in plugin parameters.
 *
 * A single UI gesture may update several parameters (for example the NAM bass
 * profile plus its paired defaults), so the active entry is a small atomic
 * change set rather than a single scalar. Native writes are asynchronous;
 * serializing operations keeps quick Undo/Redo presses ordered behind pending
 * bridge writes without leaking into the synchronous project CommandManager.
 */
export class BuiltInPluginParamHistory {
  private readonly instanceId: string;
  private readonly maxEntries: number;
  private activeEdit: ActiveParamEdit | null = null;
  private undoStack: BuiltInPluginParamHistoryEntry[] = [];
  private redoStack: BuiltInPluginParamHistoryEntry[] = [];
  private operationQueue: Promise<unknown> = Promise.resolve();
  private queuedOperationCount = 0;

  constructor(instanceId: string, maxEntries = 100) {
    this.instanceId = instanceId;
    this.maxEntries = Math.max(1, Math.trunc(maxEntries));
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getActiveParamId(): string | null {
    return this.activeEdit?.changes[0]?.paramId ?? null;
  }

  hasActiveParam(paramId: string): boolean {
    return Boolean(this.activeEdit?.changes.some((change) => change.paramId === paramId));
  }

  hasPendingWork(): boolean {
    return this.activeEdit !== null || this.queuedOperationCount > 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0 || this.activeEdit !== null || this.queuedOperationCount > 0;
  }

  canRedo(): boolean {
    // Redo pressed immediately after Undo queues behind its async native replay.
    return this.redoStack.length > 0 || this.queuedOperationCount > 0;
  }

  getUndoEntries(): readonly BuiltInPluginParamHistoryEntry[] {
    return this.undoStack.map((entry) => this.cloneEntry(entry));
  }

  getRedoEntries(): readonly BuiltInPluginParamHistoryEntry[] {
    return this.redoStack.map((entry) => this.cloneEntry(entry));
  }

  begin(paramId: string, label: string, before: number): boolean {
    if (!paramId || !Number.isFinite(before)) return false;
    const existing = this.activeEdit?.changes.find((change) => change.paramId === paramId);
    if (existing) return true;

    const change = { paramId, label, before, after: before };
    if (this.activeEdit) this.activeEdit.changes.push(change);
    else this.activeEdit = { instanceId: this.instanceId, changes: [change] };
    return true;
  }

  update(paramId: string, after: number): boolean {
    if (!Number.isFinite(after)) return false;
    const change = this.activeEdit?.changes.find((candidate) => candidate.paramId === paramId);
    if (!change) return false;
    change.after = after;
    return true;
  }

  cancelActive(): void {
    this.activeEdit = null;
  }

  commit(flush: () => Promise<boolean>): Promise<boolean> {
    const edit = this.takeActiveEdit();
    if (!edit) return Promise.resolve(false);
    return this.enqueue(async () => this.commitCapturedEdit(edit, flush));
  }

  undo(
    flush: () => Promise<boolean>,
    replay: BuiltInPluginHistoryReplay,
  ): Promise<BuiltInPluginHistoryResult> {
    const activeEdit = this.takeActiveEdit();
    return this.enqueue(async () => {
      if (activeEdit && !(await this.commitCapturedEdit(activeEdit, flush))) {
        return "failed";
      }

      const entry = this.undoStack.pop();
      if (!entry) return "empty";
      if (!(await replay(entry, "before"))) {
        this.undoStack.push(entry);
        return "failed";
      }

      this.redoStack.push(entry);
      return "applied";
    });
  }

  redo(
    flush: () => Promise<boolean>,
    replay: BuiltInPluginHistoryReplay,
  ): Promise<BuiltInPluginHistoryResult> {
    const activeEdit = this.takeActiveEdit();
    return this.enqueue(async () => {
      if (activeEdit && !(await this.commitCapturedEdit(activeEdit, flush))) {
        return "failed";
      }

      const entry = this.redoStack.pop();
      if (!entry) return "empty";
      if (!(await replay(entry, "after"))) {
        this.redoStack.push(entry);
        return "failed";
      }

      this.undoStack.push(entry);
      return "applied";
    });
  }

  clear(): void {
    this.activeEdit = null;
    this.undoStack = [];
    this.redoStack = [];
  }

  private takeActiveEdit(): ActiveParamEdit | null {
    const edit = this.activeEdit;
    this.activeEdit = null;
    if (!edit) return null;
    const changes = edit.changes
      .filter((change) => !Object.is(change.before, change.after))
      .map((change) => ({ ...change }));
    return changes.length > 0 ? { instanceId: edit.instanceId, changes } : null;
  }

  private async commitCapturedEdit(
    edit: ActiveParamEdit,
    flush: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!(await flush())) return false;
    this.undoStack.push(this.cloneEntry(edit));
    if (this.undoStack.length > this.maxEntries) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }

  private cloneEntry(entry: BuiltInPluginParamHistoryEntry): BuiltInPluginParamHistoryEntry {
    return {
      instanceId: entry.instanceId,
      changes: entry.changes.map((change) => ({ ...change })),
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.queuedOperationCount += 1;
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.finally(() => {
      this.queuedOperationCount = Math.max(0, this.queuedOperationCount - 1);
    });
    return run;
  }
}

/**
 * Command Pattern for Undo/Redo System
 *
 * Each action that modifies state should be wrapped in a Command object.
 * Commands can execute (do) and undo their changes.
 */

export interface Command {
  /** Unique identifier for the command type */
  type: string;

  /** Human-readable description for history panel */
  description: string;

  /** Timestamp when command was executed */
  timestamp: number;

  /** Execute the command (do) */
  execute: () => void;

  /** Undo the command */
  undo: () => void;
}

/**
 * Serializable snapshot of a Command (metadata only, no callbacks).
 * Used for persisting undo history display across project save/load.
 */
export interface SerializedCommand {
  type: string;
  description: string;
  timestamp: number;
}

/**
 * Serializable snapshot of the undo/redo history.
 */
export interface SerializedUndoHistory {
  version: 1;
  undoStack: SerializedCommand[];
  redoStack: SerializedCommand[];
}

export interface CommandBatchMetadata {
  type: string;
  description: string;
  timestamp?: number;
  /** Restore ephemeral selection/focus after replaying the child commands. */
  afterExecute?: () => void;
  /** Restore ephemeral selection/focus after undoing the child commands. */
  afterUndo?: () => void;
}

/**
 * CommandManager handles the undo/redo stacks and execution
 */
export class CommandManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxHistory: number;
  private onChangeCallback?: () => void;
  private activeBatch: Command[] | null = null;
  private revision = 0;

  constructor(maxHistory: number = 50) {
    this.maxHistory = maxHistory;
  }

  /**
   * Execute a command and add it to the undo stack
   */
  execute(command: Command): void {
    command.execute();
    this.push(command);
  }

  /**
   * Add a command to the undo stack without executing it.
   * Use when the action has already been performed and you only need undo tracking.
   */
  push(command: Command): void {
    if (this.activeBatch) {
      this.activeBatch.push(command);
      return;
    }
    this.undoStack.push(command);

    // Clear redo stack when new command is executed
    this.redoStack = [];

    // Limit undo stack size
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }

    this.notifyChange();
  }

  /**
   * Coalesce synchronous commands produced by one user gesture into one undo
   * entry. This intentionally rejects Promise-returning work: resource-backed
   * async mutations need their own snapshot/rollback contract.
   */
  runBatch(metadata: CommandBatchMetadata, operation: () => void): boolean {
    if (this.activeBatch) {
      operation();
      return false;
    }

    const commands: Command[] = [];
    this.activeBatch = commands;
    try {
      const result = operation() as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        throw new Error("CommandManager.runBatch only supports synchronous operations");
      }
    } catch (error) {
      this.activeBatch = null;
      for (const command of [...commands].reverse()) command.undo();
      throw error;
    }
    this.activeBatch = null;

    if (commands.length === 0) return false;
    metadata.afterExecute?.();
    this.push({
      type: metadata.type,
      description: metadata.description,
      timestamp: metadata.timestamp ?? Date.now(),
      execute: () => {
        for (const command of commands) command.execute();
        metadata.afterExecute?.();
      },
      undo: () => {
        for (const command of [...commands].reverse()) command.undo();
        metadata.afterUndo?.();
      },
    });
    return true;
  }

  /**
   * Undo the last command
   */
  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;

    command.undo();
    this.redoStack.push(command);
    this.notifyChange();
    return true;
  }

  /**
   * Redo the last undone command
   */
  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;

    command.execute();
    this.undoStack.push(command);
    this.notifyChange();
    return true;
  }

  /**
   * Check if undo is available
   */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Check if redo is available
   */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Get the undo stack for history display
   */
  getUndoStack(): Command[] {
    return [...this.undoStack];
  }

  /**
   * Get the redo stack for history display
   */
  getRedoStack(): Command[] {
    return [...this.redoStack];
  }

  /**
   * Monotonic history boundary for cross-window gesture synchronization.
   * Continuous previews leave this unchanged; commit/undo/redo/clear advance
   * it, allowing another WebView to distinguish two quick edits of one target.
   */
  getRevision(): number {
    return this.revision;
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.activeBatch = null;
    this.notifyChange();
  }

  /**
   * Serialize the undo/redo history for project persistence.
   *
   * Since Command.execute and Command.undo are closures over Zustand state,
   * they cannot be serialized. We persist only the metadata (type, description,
   * timestamp). After deserialization the entries are "display-only" — the user
   * can see what happened but cannot actually undo/redo pre-save commands.
   */
  serialize(): SerializedUndoHistory {
    const toMeta = (cmd: Command): SerializedCommand => ({
      type: cmd.type,
      description: cmd.description,
      timestamp: cmd.timestamp,
    });

    return {
      version: 1,
      undoStack: this.undoStack.map(toMeta),
      redoStack: this.redoStack.map(toMeta),
    };
  }

  /**
   * Restore undo/redo history from a previously serialized snapshot.
   *
   * Because execute/undo callbacks cannot be restored, the deserialized
   * commands use no-op functions. `canUndo()` / `canRedo()` will return true
   * so the UI reflects history, but calling `undo()` / `redo()` on these
   * restored entries will be a no-op (safe, just does nothing).
   *
   * As soon as the user performs a new action, the redo stack is cleared and
   * new fully-functional commands replace the stale ones over time.
   */
  deserialize(data: SerializedUndoHistory | undefined | null): void {
    if (!data || data.version !== 1) {
      return; // Unknown or missing format — keep current state
    }

    const noop = () => {};

    const toCommand = (meta: SerializedCommand): Command => ({
      type: meta.type,
      description: meta.description,
      timestamp: meta.timestamp,
      execute: noop,
      undo: noop,
    });

    this.undoStack = (data.undoStack || []).map(toCommand);
    this.redoStack = (data.redoStack || []).map(toCommand);
    this.notifyChange();
  }

  /**
   * Set callback for when stacks change
   */
  onChange(callback: () => void): void {
    this.onChangeCallback = callback;
  }

  private notifyChange(): void {
    this.revision += 1;
    this.onChangeCallback?.();
  }
}

// Singleton instance
export const commandManager = new CommandManager(50);

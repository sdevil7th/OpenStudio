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

/**
 * CommandManager handles the undo/redo stacks and execution
 */
export class CommandManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxHistory: number;
  private onChangeCallback?: () => void;

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
   * Clear all history
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
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
    this.onChangeCallback?.();
  }
}

// Singleton instance
export const commandManager = new CommandManager(50);

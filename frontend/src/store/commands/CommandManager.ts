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

import { useState, useEffect } from "react";
import { commandManager, Command } from "../store/commands";
import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";

/**
 * UndoHistoryPanel - Visual display of undo/redo history
 * Shows the command stack with ability to jump to specific points
 */
export function UndoHistoryPanel() {
  const [undoStack, setUndoStack] = useState<Command[]>([]);
  const [redoStack, setRedoStack] = useState<Command[]>([]);
  const { canUndo, canRedo, undo, redo } = useDAWStore();

  // Subscribe to command manager changes
  useEffect(() => {
    const updateStacks = () => {
      setUndoStack(commandManager.getUndoStack());
      setRedoStack(commandManager.getRedoStack());
    };

    // Initial load
    updateStacks();

    // Subscribe to changes
    commandManager.onChange(updateStacks);

    return () => {
      commandManager.onChange(() => {});
    };
  }, []);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="bg-daw-panel border border-daw-border rounded-lg p-3 w-64 max-h-80 overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-daw-text uppercase tracking-wide">
          History
        </h3>
        <div className="flex gap-1">
          <Button
            variant="default"
            size="xs"
            onClick={undo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
          >
            ↩
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={redo}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
          >
            ↪
          </Button>
        </div>
      </div>

      {/* Current State Marker */}
      <div className="border-l-2 border-daw-accent pl-2 mb-1">
        <div className="text-xs text-daw-accent font-medium">
          ▶ Current State
        </div>
      </div>

      {/* Undo Stack (reverse order - most recent first) */}
      {undoStack.length === 0 && redoStack.length === 0 && (
        <div className="text-xs text-daw-text-muted italic py-2">
          No actions to undo
        </div>
      )}

      {[...undoStack].reverse().map((cmd, index) => (
        <div
          key={`undo-${index}`}
          className="border-l-2 border-daw-border-light pl-2 py-1 hover:bg-daw-selection 
                     cursor-pointer group"
          onClick={() => {
            // Undo multiple steps to get to this point
            const stepsToUndo = index + 1;
            for (let i = 0; i < stepsToUndo; i++) {
              undo();
            }
          }}
          title={`Click to undo to this point (${index + 1} step${index > 0 ? "s" : ""})`}
        >
          <div className="text-xs text-daw-text group-hover:text-white">
            {cmd.description}
          </div>
          <div className="text-[10px] text-daw-text-dim">
            {formatTime(cmd.timestamp)}
          </div>
        </div>
      ))}

      {/* Redo Stack (future actions - in order) */}
      {redoStack.length > 0 && (
        <>
          <div className="border-t border-daw-border my-2" />
          <div className="text-[10px] text-daw-text-muted uppercase mb-1">
            Redo Available
          </div>
          {[...redoStack].reverse().map((cmd, index) => (
            <div
              key={`redo-${index}`}
              className="border-l-2 border-daw-text-dim pl-2 py-1 opacity-50 hover:opacity-100 
                         cursor-pointer group"
              onClick={() => {
                // Redo multiple steps to get to this point
                const stepsToRedo = redoStack.length - index;
                for (let i = 0; i < stepsToRedo; i++) {
                  redo();
                }
              }}
              title={`Click to redo to this point`}
            >
              <div className="text-xs text-daw-text-muted group-hover:text-white">
                {cmd.description}
              </div>
              <div className="text-[10px] text-daw-text-dim">
                {formatTime(cmd.timestamp)}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

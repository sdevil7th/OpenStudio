import { useState } from "react";
import { Plus, Trash2, GripVertical } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { getRegisteredActions } from "../store/actionRegistry";
import { Modal, Button, Select } from "./ui";

interface ToolbarEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ToolbarEditor({ isOpen, onClose }: ToolbarEditorProps) {
  const customToolbars = useDAWStore((s) => s.customToolbars);
  const [selectedToolbarId, setSelectedToolbarId] = useState<string | null>(
    customToolbars[0]?.id || null,
  );
  const [newActionId, setNewActionId] = useState("");

  const allActions = getRegisteredActions();
  const actionOptions = allActions.map((a) => ({
    value: a.id,
    label: `${a.category}: ${a.name}`,
  }));

  const selectedToolbar = customToolbars.find((t) => t.id === selectedToolbarId);

  const handleAddToolbar = () => {
    const name = prompt("Toolbar name:", "My Toolbar");
    if (name) {
      useDAWStore.getState().addCustomToolbar(name);
    }
  };

  const handleAddButton = () => {
    if (!selectedToolbarId || !newActionId) return;
    const action = allActions.find((a) => a.id === newActionId);
    if (action) {
      useDAWStore.getState().addToolbarButton(
        selectedToolbarId,
        action.id,
        "",
        action.name,
      );
      setNewActionId("");
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Toolbar Editor">
      <div className="w-[520px] flex flex-col gap-4">
        {/* Toolbar list */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-neutral-400 uppercase tracking-wider">
              Toolbars
            </label>
            <Button variant="default" size="sm" onClick={handleAddToolbar}>
              <Plus size={10} className="mr-1" /> New Toolbar
            </Button>
          </div>
          <div className="flex gap-1 flex-wrap">
            {customToolbars.length === 0 ? (
              <span className="text-[10px] text-neutral-600">No custom toolbars. Create one to get started.</span>
            ) : (
              customToolbars.map((tb) => (
                <button
                  key={tb.id}
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    selectedToolbarId === tb.id
                      ? "border-blue-500 bg-blue-500/20 text-blue-300"
                      : "border-neutral-700 bg-neutral-800 text-neutral-400 hover:border-neutral-600"
                  }`}
                  onClick={() => setSelectedToolbarId(tb.id)}
                >
                  {tb.name}
                  {tb.visible ? "" : " (hidden)"}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Selected toolbar editor */}
        {selectedToolbar && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-neutral-300">
                Buttons in "{selectedToolbar.name}"
              </span>
              <div className="flex gap-1">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => useDAWStore.getState().toggleToolbarVisibility(selectedToolbarId!)}
                >
                  {selectedToolbar.visible ? "Hide" : "Show"}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    useDAWStore.getState().removeCustomToolbar(selectedToolbarId!);
                    setSelectedToolbarId(null);
                  }}
                >
                  <Trash2 size={10} />
                </Button>
              </div>
            </div>

            {/* Button list */}
            <div className="bg-neutral-800 rounded border border-neutral-700 p-2 mb-2 max-h-[200px] overflow-y-auto">
              {selectedToolbar.buttons.length === 0 ? (
                <span className="text-[9px] text-neutral-600">No buttons yet. Add an action below.</span>
              ) : (
                selectedToolbar.buttons.map((btn, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 py-1 px-1 hover:bg-neutral-700 rounded group"
                  >
                    <GripVertical size={10} className="text-neutral-600 shrink-0" />
                    <span className="text-[10px] text-neutral-300 flex-1 truncate">
                      {btn.label}
                    </span>
                    <span className="text-[8px] text-neutral-600 font-mono">
                      {btn.actionId}
                    </span>
                    <button
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-neutral-500 hover:text-red-400"
                      onClick={() =>
                        useDAWStore.getState().removeToolbarButton(selectedToolbarId!, i)
                      }
                    >
                      <Trash2 size={9} />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Add button */}
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <Select
                  label=""
                  size="sm"
                  fullWidth
                  value={newActionId}
                  onChange={(val) => setNewActionId(String(val))}
                  options={[{ value: "", label: "Select an action..." }, ...actionOptions]}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={handleAddButton}
                disabled={!newActionId}
              >
                <Plus size={10} /> Add
              </Button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end pt-2 border-t border-neutral-700">
          <Button variant="default" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * CustomToolbarStrip — renders the user's custom toolbars in the main UI.
 * Placed below MainToolbar in App.tsx.
 */
export function CustomToolbarStrip() {
  const customToolbars = useDAWStore((s) => s.customToolbars);
  const visibleToolbars = customToolbars.filter((t) => t.visible && t.buttons.length > 0);

  if (visibleToolbars.length === 0) return null;

  const allActions = getRegisteredActions();

  return (
    <div className="bg-neutral-850 border-b border-neutral-700 px-2 py-0.5 flex items-center gap-3 shrink-0">
      {visibleToolbars.map((toolbar) => (
        <div key={toolbar.id} className="flex items-center gap-0.5">
          <span className="text-[8px] text-neutral-600 mr-1 uppercase">{toolbar.name}</span>
          {toolbar.buttons.map((btn, i) => {
            const action = allActions.find((a) => a.id === btn.actionId);
            return (
              <button
                key={i}
                className="px-2 py-0.5 text-[9px] text-neutral-400 hover:text-white hover:bg-neutral-700 rounded transition-colors"
                onClick={() => action?.execute()}
                title={`${btn.label}${action?.shortcut ? ` (${action.shortcut})` : ""}`}
              >
                {btn.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

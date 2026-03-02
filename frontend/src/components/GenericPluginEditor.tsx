import { useState, useEffect, useCallback } from "react";
import { nativeBridge } from "../services/NativeBridge";
import {
  Button,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
  Slider,
} from "./ui";

interface PluginParam {
  index: number;
  name: string;
  value: number;
  label: string; // e.g., "50%" or "12.5 Hz"
}

interface GenericPluginEditorProps {
  isOpen: boolean;
  onClose: () => void;
  trackId: string;
  fxIndex: number;
  pluginName: string;
  chainType: "input" | "track" | "master";
}

/**
 * GenericPluginEditor (Sprint 19.15)
 * Fallback slider UI for plugins without a native editor.
 * Fetches plugin parameters via bridge and provides sliders.
 */
export function GenericPluginEditor({
  isOpen,
  onClose,
  trackId,
  fxIndex,
  pluginName,
  chainType,
}: GenericPluginEditorProps) {
  const [params, setParams] = useState<PluginParam[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

  const fetchParams = useCallback(async () => {
    setLoading(true);
    try {
      const result = await nativeBridge.getPluginParameters(
        trackId,
        fxIndex,
        chainType === "input",
      );
      if (Array.isArray(result)) {
        setParams(
          result.map((p: any, i: number) => ({
            index: p.index ?? i,
            name: p.name ?? `Param ${i}`,
            value: p.value ?? 0,
            label: p.label ?? `${Math.round((p.value ?? 0) * 100)}%`,
          })),
        );
      }
    } catch (e) {
      console.error("[GenericPluginEditor] Failed to fetch params:", e);
    } finally {
      setLoading(false);
    }
  }, [trackId, fxIndex, chainType]);

  useEffect(() => {
    if (isOpen) fetchParams();
  }, [isOpen, fetchParams]);

  const handleParamChange = async (paramIndex: number, newValue: number) => {
    // Update local state immediately
    setParams((prev) =>
      prev.map((p) =>
        p.index === paramIndex
          ? { ...p, value: newValue, label: `${Math.round(newValue * 100)}%` }
          : p,
      ),
    );

    // Send to backend
    try {
      await nativeBridge.setPluginParameter(
        trackId,
        fxIndex,
        chainType === "input",
        paramIndex,
        newValue,
      );
    } catch {
      // Silently fail
    }
  };

  const filteredParams = params.filter(
    (p) =>
      !searchTerm ||
      p.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <ModalHeader title={`${pluginName} - Parameters`} onClose={onClose} />
      <ModalContent>
        <div className="flex flex-col gap-2">
          {/* Search */}
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search parameters..."
            className="w-full px-2 py-1 text-xs bg-daw-dark border border-daw-border rounded text-daw-text"
          />

          {/* Parameters */}
          <div className="max-h-[400px] overflow-y-auto">
            {loading ? (
              <p className="text-xs text-daw-text-muted py-4 text-center">
                Loading parameters...
              </p>
            ) : filteredParams.length === 0 ? (
              <p className="text-xs text-daw-text-muted py-4 text-center">
                No parameters found.
              </p>
            ) : (
              filteredParams.map((param) => (
                <div
                  key={param.index}
                  className="flex items-center gap-2 py-1 px-1 hover:bg-daw-panel rounded"
                >
                  <span className="text-xs text-daw-text w-32 truncate flex-shrink-0">
                    {param.name}
                  </span>
                  <Slider
                    value={param.value * 100}
                    min={0}
                    max={100}
                    onChange={(v) =>
                      handleParamChange(param.index, v / 100)
                    }
                  />
                  <span className="text-xs text-daw-text-muted w-16 text-right flex-shrink-0">
                    {param.label}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="default" size="sm" onClick={fetchParams}>
          Refresh
        </Button>
        <Button variant="primary" size="sm" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

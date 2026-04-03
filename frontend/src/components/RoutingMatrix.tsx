import { useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import {
  Button,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
  Slider,
} from "./ui";

interface RoutingMatrixProps {
  isOpen: boolean;
  onClose: () => void;
}

// Track type color mapping
const TYPE_COLORS: Record<string, string> = {
  audio: "#3b82f6",
  midi: "#8b5cf6",
  instrument: "#ec4899",
  bus: "#f59e0b",
  master: "#ef4444",
};

/**
 * Routing Matrix (Sprint 19.22 Enhanced)
 * Grid showing send routing between tracks with click-to-route,
 * color-coded flow, and send level adjustment.
 */
export function RoutingMatrix({ isOpen, onClose }: RoutingMatrixProps) {
  const { tracks } = useDAWStore(
    useShallow((s) => ({ tracks: s.tracks })),
  );

  const [editingSend, setEditingSend] = useState<{
    sourceId: string;
    destId: string;
    index: number;
    level: number;
  } | null>(null);

  const findSend = (sourceId: string, destId: string) => {
    const track = tracks.find((t) => t.id === sourceId);
    if (!track) return { exists: false, index: -1, level: 0, preFader: false };
    const idx = track.sends.findIndex((s) => s.destTrackId === destId);
    if (idx < 0) return { exists: false, index: -1, level: 0, preFader: false };
    return {
      exists: true,
      index: idx,
      level: track.sends[idx].level,
      preFader: track.sends[idx].preFader || false,
    };
  };

  const toggleSend = async (sourceId: string, destId: string) => {
    const info = findSend(sourceId, destId);
    const store = useDAWStore.getState();
    if (info.exists) {
      await store.removeTrackSend(sourceId, info.index);
      if (editingSend?.sourceId === sourceId && editingSend?.destId === destId) {
        setEditingSend(null);
      }
    } else {
      await store.addTrackSend(sourceId, destId);
    }
  };

  const handleCellClick = (sourceId: string, destId: string) => {
    const info = findSend(sourceId, destId);
    if (info.exists) {
      // If already editing this send, close the editor
      if (editingSend?.sourceId === sourceId && editingSend?.destId === destId) {
        setEditingSend(null);
      } else {
        setEditingSend({
          sourceId,
          destId,
          index: info.index,
          level: info.level,
        });
      }
    } else {
      void toggleSend(sourceId, destId);
    }
  };

  const handleRightClick = (e: React.MouseEvent, sourceId: string, destId: string) => {
    e.preventDefault();
    const info = findSend(sourceId, destId);
    if (info.exists) {
      void toggleSend(sourceId, destId);
    }
  };

  const handleLevelChange = (level: number) => {
    if (!editingSend) return;
    const store = useDAWStore.getState();
    void store.setTrackSendLevel(editingSend.sourceId, editingSend.index, level / 100);
    setEditingSend((prev) => prev ? { ...prev, level: level / 100 } : null);
  };

  const getLevelColor = (level: number, type: string) => {
    const baseColor = TYPE_COLORS[type] || "#22c55e";
    const opacity = Math.round(level * 200 + 55);
    // Parse hex to rgb and apply opacity
    const r = parseInt(baseColor.slice(1, 3), 16);
    const g = parseInt(baseColor.slice(3, 5), 16);
    const b = parseInt(baseColor.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${(opacity / 255).toFixed(2)})`;
  };

  const getTrackTypeColor = (type: string) => TYPE_COLORS[type] || "#6b7280";

  // Count active sends for summary
  const totalSends = tracks.reduce(
    (acc, t) => acc + t.sends.length,
    0,
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalHeader title="Routing Matrix" onClose={onClose} />
      <ModalContent>
        {tracks.length === 0 ? (
          <p className="text-sm text-daw-text-muted py-4">
            No tracks in project.
          </p>
        ) : (
          <>
            {/* Legend */}
            <div className="flex gap-3 mb-2 text-[10px] text-daw-text-muted">
              {Object.entries(TYPE_COLORS).map(([type, color]) => (
                <span key={type} className="flex items-center gap-1">
                  <span
                    className="w-2 h-2 rounded-full inline-block"
                    style={{ backgroundColor: color }}
                  />
                  {type}
                </span>
              ))}
              <span className="ml-auto">
                {totalSends} active send{totalSends !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="overflow-auto max-h-96">
              <table className="text-xs border-collapse">
                <thead>
                  <tr>
                    <th className="p-1 text-daw-text-muted text-left sticky left-0 bg-daw-panel z-10 min-w-[100px]">
                      Source / Dest
                    </th>
                    {tracks.map((t) => (
                      <th
                        key={t.id}
                        className="p-1 text-center text-daw-text-muted min-w-[60px] max-w-[80px]"
                      >
                        <div className="truncate" title={t.name}>
                          <span
                            className="inline-block w-2 h-2 rounded-full mr-0.5"
                            style={{
                              backgroundColor:
                                t.color || getTrackTypeColor(t.type),
                            }}
                          />
                          {t.name}
                        </div>
                      </th>
                    ))}
                    <th className="p-1 text-center text-daw-text-muted min-w-[60px]">
                      Master
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((source) => (
                    <tr key={source.id} className="hover:bg-daw-surface/30">
                      <td className="p-1 text-daw-text sticky left-0 bg-daw-panel z-10 border-r border-daw-border/50 truncate max-w-[100px]">
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-1"
                          style={{
                            backgroundColor:
                              source.color ||
                              getTrackTypeColor(source.type),
                          }}
                        />
                        {source.name}
                      </td>
                      {tracks.map((dest) => {
                        const isSelf = source.id === dest.id;
                        const info = findSend(source.id, dest.id);
                        const isEditing =
                          editingSend?.sourceId === source.id &&
                          editingSend?.destId === dest.id;
                        return (
                          <td
                            key={dest.id}
                            className={`p-0.5 text-center border border-daw-border/20 cursor-pointer transition-colors ${
                              isSelf
                                ? "bg-daw-darker/50"
                                : isEditing
                                  ? "ring-1 ring-daw-accent"
                                  : info.exists
                                    ? "hover:opacity-80"
                                    : "hover:bg-daw-surface/50"
                            }`}
                            onClick={() =>
                              !isSelf &&
                              handleCellClick(source.id, dest.id)
                            }
                            onContextMenu={(e) =>
                              !isSelf &&
                              handleRightClick(e, source.id, dest.id)
                            }
                            title={
                              isSelf
                                ? "Cannot route to self"
                                : info.exists
                                  ? `Send: ${Math.round(info.level * 100)}% ${info.preFader ? "(pre)" : "(post)"} — Click to edit, right-click to remove`
                                  : "Click to add send"
                            }
                          >
                            {isSelf ? (
                              <span className="text-daw-text-dim">
                                -
                              </span>
                            ) : info.exists ? (
                              <div
                                className="w-5 h-5 rounded mx-auto flex items-center justify-center text-[8px] text-white font-bold"
                                style={{
                                  backgroundColor: getLevelColor(
                                    info.level,
                                    source.type,
                                  ),
                                }}
                              >
                                {Math.round(info.level * 100)}
                              </div>
                            ) : (
                              <div className="w-5 h-5 rounded mx-auto border border-daw-border/30" />
                            )}
                          </td>
                        );
                      })}
                      {/* Master column */}
                      <td className="p-0.5 text-center border border-daw-border/20">
                        <div
                          className="w-5 h-5 rounded mx-auto"
                          style={{
                            backgroundColor: getLevelColor(
                              1.0,
                              source.type,
                            ),
                          }}
                          title="Routes to master"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Send level editor */}
            {editingSend && (
              <div className="mt-3 p-2 bg-daw-panel rounded border border-daw-border flex items-center gap-3">
                <span className="text-xs text-daw-text">
                  {tracks.find((t) => t.id === editingSend.sourceId)?.name} →{" "}
                  {tracks.find((t) => t.id === editingSend.destId)?.name}
                </span>
                <span className="text-[10px] text-daw-text-muted">Level:</span>
                <Slider
                  value={editingSend.level * 100}
                  min={0}
                  max={100}
                  onChange={handleLevelChange}
                />
                <span className="text-xs text-daw-text tabular-nums w-10">
                  {Math.round(editingSend.level * 100)}%
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    void toggleSend(editingSend.sourceId, editingSend.destId);
                  }}
                >
                  Remove
                </Button>
              </div>
            )}
          </>
        )}

        <div className="mt-3 text-[10px] text-daw-text-dim">
          Click to add/edit sends. Right-click to remove. Color intensity
          shows send level.
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="default" size="md" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

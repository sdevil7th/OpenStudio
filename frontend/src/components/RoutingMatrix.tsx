import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import {
  Button,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
} from "./ui";

interface RoutingMatrixProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Routing Matrix — grid showing send routing between tracks.
 * Rows = source tracks, Columns = destination tracks.
 * Click a cell to toggle a send. Existing sends show level indicator.
 */
export function RoutingMatrix({ isOpen, onClose }: RoutingMatrixProps) {
  const { tracks } = useDAWStore(
    useShallow((s) => ({ tracks: s.tracks }))
  );

  const findSend = (sourceId: string, destId: string) => {
    const track = tracks.find((t) => t.id === sourceId);
    if (!track) return { exists: false, index: -1, level: 0 };
    const idx = track.sends.findIndex((s) => s.destTrackId === destId);
    if (idx < 0) return { exists: false, index: -1, level: 0 };
    return { exists: true, index: idx, level: track.sends[idx].level };
  };

  const toggleSend = async (sourceId: string, destId: string) => {
    const info = findSend(sourceId, destId);
    const store = useDAWStore.getState();
    if (info.exists) {
      await store.removeTrackSend(sourceId, info.index);
    } else {
      await store.addTrackSend(sourceId, destId);
    }
  };

  const getLevelColor = (level: number) => {
    const intensity = Math.round(level * 200 + 55);
    return `rgb(0, ${intensity}, ${Math.round(intensity * 0.8)})`;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalHeader title="Routing Matrix" onClose={onClose} />
      <ModalContent>
        {tracks.length === 0 ? (
          <p className="text-sm text-daw-text-muted py-4">No tracks in project.</p>
        ) : (
          <div className="overflow-auto max-h-96">
            <table className="text-xs border-collapse">
              <thead>
                <tr>
                  <th className="p-1 text-daw-text-muted text-left sticky left-0 bg-daw-panel z-10 min-w-[100px]">
                    Source ↓ / Dest →
                  </th>
                  {tracks.map((t) => (
                    <th key={t.id} className="p-1 text-center text-daw-text-muted min-w-[60px] max-w-[80px]">
                      <div className="truncate" title={t.name}>
                        <span className="inline-block w-2 h-2 rounded-full mr-0.5" style={{ backgroundColor: t.color }} />
                        {t.name}
                      </div>
                    </th>
                  ))}
                  <th className="p-1 text-center text-daw-text-muted min-w-[60px]">Master</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((source) => (
                  <tr key={source.id} className="hover:bg-daw-surface/30">
                    <td className="p-1 text-daw-text sticky left-0 bg-daw-panel z-10 border-r border-daw-border/50 truncate max-w-[100px]">
                      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: source.color }} />
                      {source.name}
                    </td>
                    {tracks.map((dest) => {
                      const isSelf = source.id === dest.id;
                      const info = findSend(source.id, dest.id);
                      return (
                        <td
                          key={dest.id}
                          className={`p-0.5 text-center border border-daw-border/20 cursor-pointer transition-colors ${
                            isSelf ? "bg-daw-darker/50" : info.exists ? "hover:opacity-80" : "hover:bg-daw-surface/50"
                          }`}
                          onClick={() => !isSelf && toggleSend(source.id, dest.id)}
                          title={isSelf ? "Cannot route to self" : info.exists ? `Send: ${Math.round(info.level * 100)}%` : "Click to add send"}
                        >
                          {isSelf ? (
                            <span className="text-daw-text-dim">—</span>
                          ) : info.exists ? (
                            <div
                              className="w-5 h-5 rounded mx-auto"
                              style={{ backgroundColor: getLevelColor(info.level) }}
                            />
                          ) : (
                            <div className="w-5 h-5 rounded mx-auto border border-daw-border/30" />
                          )}
                        </td>
                      );
                    })}
                    {/* Master column - all tracks route to master by default */}
                    <td className="p-0.5 text-center border border-daw-border/20">
                      <div className="w-5 h-5 rounded mx-auto bg-daw-accent/60" title="Routes to master" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 text-[10px] text-daw-text-dim">
          Click cells to add/remove sends between tracks. Green intensity shows send level.
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="default" size="md" onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  );
}

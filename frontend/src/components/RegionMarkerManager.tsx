import { MapPin, Square, Trash2, Edit2 } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2);
  return `${m}:${s.padStart(5, "0")}`;
}

/**
 * RegionMarkerManager - Lists all markers and regions for navigation and editing
 */
export function RegionMarkerManager() {
  const markers = useDAWStore((s) => s.markers);
  const regions = useDAWStore((s) => s.regions);
  const seekTo = useDAWStore((s) => s.seekTo);
  const removeMarker = useDAWStore((s) => s.removeMarker);
  const removeRegion = useDAWStore((s) => s.removeRegion);
  const updateMarker = useDAWStore((s) => s.updateMarker);
  const updateRegion = useDAWStore((s) => s.updateRegion);
  const setTimeSelection = useDAWStore((s) => s.setTimeSelection);

  const sortedMarkers = [...markers].sort((a, b) => a.time - b.time);
  const sortedRegions = [...regions].sort((a, b) => a.startTime - b.startTime);

  const handleRenameMarker = (id: string, currentName: string) => {
    const name = prompt("Rename marker:", currentName);
    if (name !== null) updateMarker(id, { name });
  };

  const handleRenameRegion = (id: string, currentName: string) => {
    const name = prompt("Rename region:", currentName);
    if (name !== null) updateRegion(id, { name });
  };

  return (
    <div className="flex flex-col h-full bg-daw-panel text-daw-text text-sm">
      {/* Markers Section */}
      <div className="px-3 py-2 border-b border-daw-border">
        <h3 className="text-xs font-semibold uppercase text-daw-text-muted flex items-center gap-1">
          <MapPin size={12} /> Markers ({sortedMarkers.length})
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {sortedMarkers.length === 0 ? (
          <div className="px-3 py-2 text-daw-text-muted text-xs">No markers. Press M to add one.</div>
        ) : (
          sortedMarkers.map((marker) => (
            <div
              key={marker.id}
              className="flex items-center gap-2 px-3 py-1 hover:bg-daw-selection cursor-pointer group"
              onClick={() => seekTo(marker.time)}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: marker.color }}
              />
              <span className="flex-1 truncate">{marker.name}</span>
              <span className="text-xs text-daw-text-muted">{formatTime(marker.time)}</span>
              <span onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => handleRenameMarker(marker.id, marker.name)}
                  title="Rename"
                >
                  <Edit2 size={10} />
                </Button>
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="opacity-0 group-hover:opacity-100 text-red-400"
                  onClick={() => removeMarker(marker.id)}
                  title="Delete"
                >
                  <Trash2 size={10} />
                </Button>
              </span>
            </div>
          ))
        )}
      </div>

      {/* Regions Section */}
      <div className="px-3 py-2 border-t border-b border-daw-border">
        <h3 className="text-xs font-semibold uppercase text-daw-text-muted flex items-center gap-1">
          <Square size={12} /> Regions ({sortedRegions.length})
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {sortedRegions.length === 0 ? (
          <div className="px-3 py-2 text-daw-text-muted text-xs">No regions. Select a range and press Shift+R.</div>
        ) : (
          sortedRegions.map((region) => (
            <div
              key={region.id}
              className="flex items-center gap-2 px-3 py-1 hover:bg-daw-selection cursor-pointer group"
              onClick={() => {
                seekTo(region.startTime);
                setTimeSelection(region.startTime, region.endTime);
              }}
            >
              <span
                className="w-2 h-2 rounded shrink-0"
                style={{ backgroundColor: region.color }}
              />
              <span className="flex-1 truncate">{region.name}</span>
              <span className="text-xs text-daw-text-muted">
                {formatTime(region.startTime)} — {formatTime(region.endTime)}
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => handleRenameRegion(region.id, region.name)}
                  title="Rename"
                >
                  <Edit2 size={10} />
                </Button>
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="opacity-0 group-hover:opacity-100 text-red-400"
                  onClick={() => removeRegion(region.id)}
                  title="Delete"
                >
                  <Trash2 size={10} />
                </Button>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

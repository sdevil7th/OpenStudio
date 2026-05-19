import { Activity, Plus, Trash2 } from "lucide-react";
import type { PianoRollVisibleLane } from "../store/useDAWStore";

interface PianoRollControllerLaneSectionProps {
  readonly visibleLanes: readonly PianoRollVisibleLane[];
  readonly activeLaneId?: string;
  readonly selectedCC: number;
  readonly onResetLanes: () => void;
  readonly onSelectLane: (lane: PianoRollVisibleLane) => void;
  readonly onLaneHeightChange: (lane: PianoRollVisibleLane, height: number) => void;
  readonly onLaneInterpolationChange: (lane: PianoRollVisibleLane, interpolation: PianoRollVisibleLane["interpolation"]) => void;
  readonly onRemoveLane: (laneId: string) => void;
  readonly onAddLane: (kind: PianoRollVisibleLane["kind"], cc?: number) => void;
}

function laneHeightMin(lane: PianoRollVisibleLane): number {
  return lane.kind === "velocity" ? 40 : 48;
}

function laneHeightMax(lane: PianoRollVisibleLane): number {
  return lane.kind === "velocity" ? 140 : 180;
}

export function PianoRollControllerLaneSection({
  visibleLanes,
  activeLaneId,
  selectedCC,
  onResetLanes,
  onSelectLane,
  onLaneHeightChange,
  onLaneInterpolationChange,
  onRemoveLane,
  onAddLane,
}: PianoRollControllerLaneSectionProps) {
  return (
    <section className="piano-roll-inspector-section">
      <div className="piano-roll-section-title">
        <span className="piano-roll-panel-title">
          <Activity size={13} strokeWidth={2} />
          Controller Lanes
        </span>
        <button type="button" className="piano-roll-mini-icon" onClick={onResetLanes} title="Reset lanes">
          <Trash2 size={12} />
        </button>
      </div>
      <div className="piano-roll-lane-stack">
        {visibleLanes.map((lane) => (
          <div
            key={lane.id}
            role="button"
            tabIndex={0}
            className="piano-roll-lane-row"
            data-active={activeLaneId === lane.id}
            onClick={() => onSelectLane(lane)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectLane(lane);
              }
            }}
          >
            <span>{lane.label}</span>
            <input
              type="range"
              min={laneHeightMin(lane)}
              max={laneHeightMax(lane)}
              value={lane.height}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onLaneHeightChange(lane, Number(event.target.value))}
              title="Lane height"
            />
            <select
              value={lane.interpolation ?? (lane.kind === "velocity" ? "step" : "linear")}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onLaneInterpolationChange(lane, event.target.value as PianoRollVisibleLane["interpolation"])}
              title="Lane interpolation"
            >
              <option value="step">Step</option>
              <option value="linear">Ramp</option>
              <option value="curve">Curve</option>
              <option value="parabola">Parabola</option>
            </select>
            {lane.kind !== "velocity" && (
              <span
                role="button"
                tabIndex={0}
                className="piano-roll-lane-remove"
                title="Hide lane without deleting MIDI data"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveLane(lane.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onRemoveLane(lane.id);
                  }
                }}
              >
                x
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="piano-roll-lane-add-grid">
        <button type="button" onClick={() => onAddLane("noteOffVelocity")}><Plus size={12} /> Off</button>
        <button type="button" onClick={() => onAddLane("chance")}><Plus size={12} /> Chance</button>
        <button type="button" onClick={() => onAddLane("velocityVariance")}><Plus size={12} /> Var</button>
        <button type="button" onClick={() => onAddLane("cc7", selectedCC >= 0 ? selectedCC : 1)}><Plus size={12} /> CC7</button>
        <button type="button" onClick={() => onAddLane("cc14", selectedCC >= 0 && selectedCC <= 31 ? selectedCC : 1)}><Plus size={12} /> CC14</button>
        <button type="button" onClick={() => onAddLane("pitchBend")}><Plus size={12} /> Bend</button>
        <button type="button" onClick={() => onAddLane("channelPressure")}><Plus size={12} /> Pressure</button>
        <button type="button" onClick={() => onAddLane("polyPressure")}><Plus size={12} /> Poly</button>
        <button type="button" onClick={() => onAddLane("programBank")}><Plus size={12} /> Program</button>
      </div>
    </section>
  );
}

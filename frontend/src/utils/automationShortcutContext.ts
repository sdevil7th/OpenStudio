import {
  useDAWStore,
  type AutomationLaneSelectionTarget,
} from "../store/useDAWStore";
import { activateShortcutContext } from "./shortcutContext";

/**
 * Gives a concrete track/master lane ownership of automation shortcuts.
 * Invalid or stale targets never activate a context that would consume keys.
 */
export function activateAutomationLaneShortcutContext(
  target: AutomationLaneSelectionTarget,
) {
  useDAWStore.getState().setSelectedAutomationLane(target);
  const selected = useDAWStore.getState().selectedAutomationTarget;
  const matches = selected?.pointId === null
    && selected.kind === target.kind
    && selected.laneId === target.laneId
    && (
      target.kind === "master"
      || (selected.kind === "track" && selected.trackId === target.trackId)
    );
  if (!matches) return false;
  activateShortcutContext({ kind: "automation" });
  return true;
}

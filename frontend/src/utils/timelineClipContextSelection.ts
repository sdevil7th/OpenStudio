export interface TimelineClipContextSelectionState {
  selectedClipIds: readonly string[];
  selectedTrackIds: readonly string[];
}

/**
 * A context click keeps the active multi-selection when its clip is already
 * selected, or when there is no clip selection and the clip belongs to a
 * selected track. Every other clip is outside the active edit scope and
 * should become the sole selected clip before its menu opens.
 */
export function shouldPreserveClipContextSelection(
  state: TimelineClipContextSelectionState,
  clipId: string,
  trackId: string,
): boolean {
  if (state.selectedClipIds.includes(clipId)) return true;
  return state.selectedClipIds.length === 0
    && state.selectedTrackIds.includes(trackId);
}

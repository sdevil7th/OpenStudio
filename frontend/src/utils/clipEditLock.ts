export interface ClipEditLockState {
  globalLocked?: boolean;
  lockSettings?: { items?: boolean };
}

export interface LockableTimelineItem {
  locked?: boolean;
}

export interface TimelineClipLockTrack {
  clips: Array<LockableTimelineItem & { id: string }>;
  midiClips: Array<LockableTimelineItem & { id: string }>;
}

export interface TimelineClipGestureLockState extends ClipEditLockState {
  tracks: TimelineClipLockTrack[];
}

/** Store-level authority shared by keyboard, wheel, menu, and pointer edits. */
export function isClipEditLocked(
  state: ClipEditLockState,
  clip?: LockableTimelineItem | null,
): boolean {
  return Boolean(state.globalLocked || state.lockSettings?.items || clip?.locked);
}

/**
 * Current-state authority for pointer gestures that may span several selected
 * clips. Missing clips are treated as locked so a stale drag can never mutate
 * a replacement project or a clip that was deleted while the pointer was down.
 */
export function isTimelineClipGestureLocked(
  state: TimelineClipGestureLockState,
  clipIds: readonly string[],
): boolean {
  if (isClipEditLocked(state)) return true;

  const remaining = new Set(clipIds.filter(Boolean));
  if (remaining.size === 0) return true;

  for (const track of state.tracks) {
    for (const clip of [...track.clips, ...track.midiClips]) {
      if (!remaining.has(clip.id)) continue;
      if (isClipEditLocked(state, clip)) return true;
      remaining.delete(clip.id);
    }
  }

  return remaining.size > 0;
}

/** Execute a pointer preview/commit only while every target is currently editable. */
export function runTimelineClipGestureMutation(
  state: TimelineClipGestureLockState,
  clipIds: readonly string[],
  mutate: () => void,
  onBlocked?: () => void,
): boolean {
  if (isTimelineClipGestureLocked(state, clipIds)) {
    onBlocked?.();
    return false;
  }
  mutate();
  return true;
}

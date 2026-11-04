import { nativeBridge } from "../../services/NativeBridge";
import type { AudioClip } from "../useDAWStore";

const AUDIO_PLAYBACK_LOG_PREFIX = "[audio.playback]";

export type SyncedPlaybackClip = {
  trackId: string;
  filePath: string;
  startTime: number;
  duration: number;
  offset: number;
  volumeDB: number;
  fadeIn: number;
  fadeOut: number;
  fadeInCurve: number;
  fadeOutCurve: number;
  clipId: string;
  pitchCorrectionSourceFilePath?: string;
  pitchCorrectionSourceOffset?: number;
};

// Diff-based sync cache: retains the identity needed to remove one logical clip.
export const clipSyncCache = { clips: new Map<string, SyncedPlaybackClip>(), envelopes: new Map<string, string>() };
let _clipSyncTail: Promise<void> = Promise.resolve();
let _clipSyncEpoch = 0;
let _clipSyncRequestedRevision = 0;
let _clipSyncCompletedRevision = 0;

export function makeClipKey(
  trackId: string, clipId: string, filePath: string, startTime: number, duration: number,
  offset: number, volumeDB: number, fadeIn: number, fadeOut: number, fadeInCurve: number, fadeOutCurve: number
): string {
  return `${trackId}|${clipId}|${filePath}|${startTime}|${duration}|${offset}|${volumeDB}|${fadeIn}|${fadeOut}|${fadeInCurve}|${fadeOutCurve}`;
}

export function resetSyncCache(): Promise<void> {
  _clipSyncEpoch += 1;
  _clipSyncRequestedRevision = 0;
  _clipSyncCompletedRevision = 0;

  // Reset is a queue barrier: direct backend mutations must await it so no
  // older sync can publish clips after a project or recording reset.
  const resetPromise = _clipSyncTail.then(() => {
    clipSyncCache.clips = new Map<string, SyncedPlaybackClip>();
    clipSyncCache.envelopes = new Map<string, string>();
  });
  _clipSyncTail = resetPromise.catch(() => {});
  return resetPromise;
}

/** Mandatory source CAS shares the clip queue, without revision coalescing. */
export interface ClipSourceReplacement {
  trackId: string;
  previousClip: AudioClip;
  nextClip: AudioClip;
  stillValid: () => boolean;
  onReplaced: () => void;
  getCurrent: () => AudioClip | undefined;
  resync: () => Promise<void>;
}
export async function replaceSyncedClipSource({ trackId, previousClip, nextClip, stillValid,
  onReplaced, getCurrent, resync }: ClipSourceReplacement): Promise<boolean> {
  let applied = false;
  let reconcile = false;
  const epoch = _clipSyncEpoch;
  const operation = _clipSyncTail.then(async () => {
    if (epoch !== _clipSyncEpoch || !stillValid()) return;
    const current = getCurrent();
    if (!current || current.filePath !== previousClip.filePath) return;
    const cached = [...clipSyncCache.clips.entries()].find(([, clip]) => clip.trackId === trackId && clip.clipId === previousClip.id);
    if (current.muted) {
      // A muted document clip need not exist in the playback graph. If an earlier
      // publication is still active, remove it before committing the source edit.
      if (cached) {
        requireClipBridgeSuccess(await nativeBridge.removePlaybackClipById(trackId, previousClip.id), "remove muted source");
        clipSyncCache.clips.delete(cached[0]);
        clipSyncCache.envelopes.delete(`${trackId}::${previousClip.id}`);
      }
      if (epoch !== _clipSyncEpoch) return;
      if (!stillValid()) { reconcile = true; return; }
      onReplaced();
      reconcile = !getCurrent()?.muted;
      applied = true;
      return;
    }
    if (!await nativeBridge.replacePlaybackClipSource(trackId, previousClip.id, previousClip.filePath, nextClip.filePath,
      nextClip.pitchCorrectionSourceFilePath ?? nextClip.filePath,
      nextClip.pitchCorrectionSourceOffset ?? nextClip.offset)) return;
    if (epoch !== _clipSyncEpoch) return;
    // The cache must describe the native result even if a concurrent edit makes
    // this transaction stale; the following reconciliation can then undo it.
    for (const [key, clip] of clipSyncCache.clips) {
      if (clip.trackId !== trackId || clip.clipId !== previousClip.id) continue;
      const next = { ...clip, filePath: nextClip.filePath,
        pitchCorrectionSourceFilePath: nextClip.pitchCorrectionSourceFilePath,
        pitchCorrectionSourceOffset: nextClip.pitchCorrectionSourceOffset };
      clipSyncCache.clips.delete(key);
      clipSyncCache.clips.set(makeClipKey(trackId, next.clipId, next.filePath, next.startTime, next.duration,
        next.offset, next.volumeDB, next.fadeIn, next.fadeOut, next.fadeInCurve, next.fadeOutCurve), next);
      break;
    }
    if (!stillValid()) { reconcile = true; return; }
    onReplaced();
    reconcile = Boolean(getCurrent()?.muted);
    applied = true;
  });
  _clipSyncTail = operation.catch(() => {});
  await operation;
  // Enqueue only after releasing the queue; awaiting it inside would deadlock.
  if (reconcile && epoch === _clipSyncEpoch) await resync();
  return applied;
}

export function enqueueClipBackendSync(syncTask: () => Promise<void>): Promise<void> {
  const requestEpoch = _clipSyncEpoch;
  const requestRevision = ++_clipSyncRequestedRevision;
  const syncPromise = _clipSyncTail.then(async () => {
    // Several edits can request a sync before the queued work begins. The task
    // reads Zustand only after it owns the queue, so one pass can publish the
    // newest state and superseded tasks behind it can become no-ops.
    if (requestEpoch !== _clipSyncEpoch || _clipSyncCompletedRevision >= requestRevision) return;
    const revisionBeingApplied = _clipSyncRequestedRevision;
    try {
      await syncTask();
    } catch (firstError) {
      if (requestEpoch !== _clipSyncEpoch) throw firstError;

      // A failed call may have partially mutated native state. Invalidate the
      // cache and make one bounded full-rebuild attempt unless a newer queued
      // request is already responsible for recovery.
      clipSyncCache.clips = new Map<string, SyncedPlaybackClip>();
      if (_clipSyncRequestedRevision > revisionBeingApplied) throw firstError;
      console.warn(`${AUDIO_PLAYBACK_LOG_PREFIX} sync failed; retrying one full rebuild`, firstError);
      try {
        await syncTask();
      } catch (retryError) {
        if (requestEpoch === _clipSyncEpoch) {
          clipSyncCache.clips = new Map<string, SyncedPlaybackClip>();
        }
        throw retryError;
      }
    }

    if (requestEpoch === _clipSyncEpoch) {
      _clipSyncCompletedRevision = revisionBeingApplied;
    }
  });

  // Keep the queue usable after a rejected bridge call while preserving the
  // rejection for the caller that requested this particular sync.
  _clipSyncTail = syncPromise.catch(() => {});
  return syncPromise;
}

export function requireClipBridgeSuccess(result: boolean, operation: string) {
  if (result !== true) {
    throw new Error(`${AUDIO_PLAYBACK_LOG_PREFIX} ${operation} returned false`);
  }
}

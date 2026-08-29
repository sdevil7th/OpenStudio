export interface NAMPreviewMonitorAdapter {
  read(trackId: string): boolean | undefined;
  setTransient(trackId: string, enabled: boolean): Promise<boolean>;
}

type PreviewMonitorLease = {
  trackId: string;
  priorEnabled: boolean;
  userRevision: number;
  ownsEnable: boolean;
};

const userMonitorRevisions = new Map<string, number>();

export function markTrackMonitorUserMutation(trackId: string): void {
  const normalizedTrackId = trackId.trim();
  if (!normalizedTrackId) return;
  userMonitorRevisions.set(
    normalizedTrackId,
    (userMonitorRevisions.get(normalizedTrackId) ?? 0) + 1,
  );
}

export function getTrackMonitorUserRevision(trackId: string): number {
  return userMonitorRevisions.get(trackId.trim()) ?? 0;
}

/**
 * Owns the temporary monitor change made by a NAM audition. The lease restores
 * only a value it changed itself, and relinquishes ownership as soon as a user
 * monitor action occurs. This keeps audition setup out of project undo/dirty
 * state without overriding an explicit user decision made during the preview.
 */
export function createNAMPreviewMonitorLease(adapter: NAMPreviewMonitorAdapter) {
  let lease: PreviewMonitorLease | null = null;

  const clear = () => {
    lease = null;
  };

  return {
    async ensureEnabled(trackId: string): Promise<boolean> {
      const normalizedTrackId = trackId.trim();
      if (!normalizedTrackId) return false;
      if (lease?.trackId === normalizedTrackId) {
        return adapter.read(normalizedTrackId) === true;
      }
      if (lease) return false;

      const priorEnabled = adapter.read(normalizedTrackId);
      if (priorEnabled === undefined) return false;
      const userRevision = getTrackMonitorUserRevision(normalizedTrackId);
      lease = {
        trackId: normalizedTrackId,
        priorEnabled,
        userRevision,
        ownsEnable: false,
      };
      if (priorEnabled) return true;

      let applied = false;
      try {
        applied = await adapter.setTransient(normalizedTrackId, true);
      } catch (error) {
        clear();
        throw error;
      }
      if (!applied) {
        clear();
        return false;
      }

      // A user monitor command that raced the native request owns the final
      // state. Keep the audition audible, but never restore over that command.
      if (getTrackMonitorUserRevision(normalizedTrackId) === userRevision) {
        lease.ownsEnable = true;
      }
      return adapter.read(normalizedTrackId) === true;
    },

    async release(): Promise<boolean> {
      const current = lease;
      if (!current) return true;

      if (
        !current.ownsEnable
        || current.priorEnabled
        || getTrackMonitorUserRevision(current.trackId) !== current.userRevision
        || adapter.read(current.trackId) !== true
      ) {
        clear();
        return true;
      }
      const restored = await adapter.setTransient(current.trackId, false);
      if (restored) clear();
      return restored;
    },

    ownsTemporaryEnable(): boolean {
      return Boolean(
        lease?.ownsEnable
        && getTrackMonitorUserRevision(lease.trackId) === lease.userRevision,
      );
    },
  };
}

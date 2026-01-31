/**
 * Clip-related commands for undo/redo
 */
import { Command } from "./CommandManager";
import { AudioClip, Track } from "../useDAWStore";

// Type for the store getter/setter we'll use
type StoreApi = {
  getState: () => { tracks: Track[] };
  setState: (partial: Partial<{ tracks: Track[] }>) => void;
};

/**
 * Command for adding a clip to a track
 */
export class AddClipCommand implements Command {
  type = "ADD_CLIP";
  description: string;
  timestamp: number;

  private trackId: string;
  private clip: AudioClip;
  private store: StoreApi;

  constructor(trackId: string, clip: AudioClip, store: StoreApi) {
    this.trackId = trackId;
    this.clip = clip;
    this.store = store;
    this.description = `Add clip "${clip.name}"`;
    this.timestamp = Date.now();
  }

  execute(): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) =>
        t.id === this.trackId ? { ...t, clips: [...t.clips, this.clip] } : t,
      ),
    });
  }

  undo(): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) =>
        t.id === this.trackId
          ? { ...t, clips: t.clips.filter((c) => c.id !== this.clip.id) }
          : t,
      ),
    });
  }
}

/**
 * Command for removing a clip from a track
 */
export class RemoveClipCommand implements Command {
  type = "REMOVE_CLIP";
  description: string;
  timestamp: number;

  private trackId: string;
  private clip: AudioClip;
  private clipIndex: number;
  private store: StoreApi;

  constructor(
    trackId: string,
    clip: AudioClip,
    clipIndex: number,
    store: StoreApi,
  ) {
    this.trackId = trackId;
    this.clip = clip;
    this.clipIndex = clipIndex;
    this.store = store;
    this.description = `Remove clip "${clip.name}"`;
    this.timestamp = Date.now();
  }

  execute(): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) =>
        t.id === this.trackId
          ? { ...t, clips: t.clips.filter((c) => c.id !== this.clip.id) }
          : t,
      ),
    });
  }

  undo(): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) => {
        if (t.id !== this.trackId) return t;
        const newClips = [...t.clips];
        newClips.splice(this.clipIndex, 0, this.clip);
        return { ...t, clips: newClips };
      }),
    });
  }
}

/**
 * Command for moving a clip (position change within same track)
 */
export class MoveClipCommand implements Command {
  type = "MOVE_CLIP";
  description: string;
  timestamp: number;

  private trackId: string;
  private clipId: string;
  private oldStartTime: number;
  private newStartTime: number;
  private store: StoreApi;

  constructor(
    trackId: string,
    clipId: string,
    oldStartTime: number,
    newStartTime: number,
    store: StoreApi,
  ) {
    this.trackId = trackId;
    this.clipId = clipId;
    this.oldStartTime = oldStartTime;
    this.newStartTime = newStartTime;
    this.store = store;
    this.description = `Move clip`;
    this.timestamp = Date.now();
  }

  execute(): void {
    this.updateClipStartTime(this.newStartTime);
  }

  undo(): void {
    this.updateClipStartTime(this.oldStartTime);
  }

  private updateClipStartTime(startTime: number): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) =>
        t.id === this.trackId
          ? {
              ...t,
              clips: t.clips.map((c) =>
                c.id === this.clipId ? { ...c, startTime } : c,
              ),
            }
          : t,
      ),
    });
  }
}

/**
 * Command for moving a clip to a different track
 */
export class MoveClipToTrackCommand implements Command {
  type = "MOVE_CLIP_TO_TRACK";
  description: string;
  timestamp: number;

  private clip: AudioClip;
  private sourceTrackId: string;
  private targetTrackId: string;
  private oldStartTime: number;
  private newStartTime: number;
  private oldColor: string;
  private newColor: string;
  private store: StoreApi;

  constructor(
    clip: AudioClip,
    sourceTrackId: string,
    targetTrackId: string,
    newStartTime: number,
    newColor: string,
    store: StoreApi,
  ) {
    this.clip = clip;
    this.sourceTrackId = sourceTrackId;
    this.targetTrackId = targetTrackId;
    this.oldStartTime = clip.startTime;
    this.newStartTime = newStartTime;
    this.oldColor = clip.color;
    this.newColor = newColor;
    this.store = store;
    this.description = `Move clip to different track`;
    this.timestamp = Date.now();
  }

  execute(): void {
    const { tracks } = this.store.getState();
    const movedClip = {
      ...this.clip,
      startTime: this.newStartTime,
      color: this.newColor,
    };

    this.store.setState({
      tracks: tracks.map((t) => {
        if (t.id === this.sourceTrackId) {
          return { ...t, clips: t.clips.filter((c) => c.id !== this.clip.id) };
        }
        if (t.id === this.targetTrackId) {
          return { ...t, clips: [...t.clips, movedClip] };
        }
        return t;
      }),
    });
  }

  undo(): void {
    const { tracks } = this.store.getState();
    const restoredClip = {
      ...this.clip,
      startTime: this.oldStartTime,
      color: this.oldColor,
    };

    this.store.setState({
      tracks: tracks.map((t) => {
        if (t.id === this.targetTrackId) {
          return { ...t, clips: t.clips.filter((c) => c.id !== this.clip.id) };
        }
        if (t.id === this.sourceTrackId) {
          return { ...t, clips: [...t.clips, restoredClip] };
        }
        return t;
      }),
    });
  }
}

/**
 * Command for resizing a clip
 */
export class ResizeClipCommand implements Command {
  type = "RESIZE_CLIP";
  description: string;
  timestamp: number;

  private trackId: string;
  private clipId: string;
  private oldValues: {
    startTime: number;
    duration: number;
    sourceOffset: number;
  };
  private newValues: {
    startTime: number;
    duration: number;
    sourceOffset: number;
  };
  private store: StoreApi;

  constructor(
    trackId: string,
    clipId: string,
    oldValues: { startTime: number; duration: number; sourceOffset: number },
    newValues: { startTime: number; duration: number; sourceOffset: number },
    store: StoreApi,
  ) {
    this.trackId = trackId;
    this.clipId = clipId;
    this.oldValues = oldValues;
    this.newValues = newValues;
    this.store = store;
    this.description = `Resize clip`;
    this.timestamp = Date.now();
  }

  execute(): void {
    this.updateClip(this.newValues);
  }

  undo(): void {
    this.updateClip(this.oldValues);
  }

  private updateClip(values: {
    startTime: number;
    duration: number;
    sourceOffset: number;
  }): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) =>
        t.id === this.trackId
          ? {
              ...t,
              clips: t.clips.map((c) =>
                c.id === this.clipId ? { ...c, ...values } : c,
              ),
            }
          : t,
      ),
    });
  }
}

/**
 * Command for updating clip fades
 */
export class SetClipFadesCommand implements Command {
  type = "SET_CLIP_FADES";
  description: string;
  timestamp: number;

  private trackId: string;
  private clipId: string;
  private oldFadeIn: number;
  private oldFadeOut: number;
  private newFadeIn: number;
  private newFadeOut: number;
  private store: StoreApi;

  constructor(
    trackId: string,
    clipId: string,
    oldFadeIn: number,
    oldFadeOut: number,
    newFadeIn: number,
    newFadeOut: number,
    store: StoreApi,
  ) {
    this.trackId = trackId;
    this.clipId = clipId;
    this.oldFadeIn = oldFadeIn;
    this.oldFadeOut = oldFadeOut;
    this.newFadeIn = newFadeIn;
    this.newFadeOut = newFadeOut;
    this.store = store;
    this.description = `Adjust clip fades`;
    this.timestamp = Date.now();
  }

  execute(): void {
    this.updateFades(this.newFadeIn, this.newFadeOut);
  }

  undo(): void {
    this.updateFades(this.oldFadeIn, this.oldFadeOut);
  }

  private updateFades(fadeIn: number, fadeOut: number): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) =>
        t.id === this.trackId
          ? {
              ...t,
              clips: t.clips.map((c) =>
                c.id === this.clipId ? { ...c, fadeIn, fadeOut } : c,
              ),
            }
          : t,
      ),
    });
  }
}

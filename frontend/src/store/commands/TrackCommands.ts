/**
 * Track-related commands for undo/redo
 */
import { Command } from "./CommandManager";
import { Track } from "../useDAWStore";

// Type for the store getter/setter we'll use
type StoreApi = {
  getState: () => { tracks: Track[] };
  setState: (partial: Partial<{ tracks: Track[] }>) => void;
};

/**
 * Command for adding a track
 */
export class AddTrackCommand implements Command {
  type = "ADD_TRACK";
  description: string;
  timestamp: number;

  private track: Track;
  private store: StoreApi;

  constructor(track: Track, store: StoreApi) {
    this.track = track;
    this.store = store;
    this.description = `Add track "${track.name}"`;
    this.timestamp = Date.now();
  }

  execute(): void {
    const { tracks } = this.store.getState();
    this.store.setState({ tracks: [...tracks, this.track] });
  }

  undo(): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.filter((t) => t.id !== this.track.id),
    });
  }
}

/**
 * Command for removing a track
 */
export class RemoveTrackCommand implements Command {
  type = "REMOVE_TRACK";
  description: string;
  timestamp: number;

  private track: Track;
  private trackIndex: number;
  private store: StoreApi;

  constructor(track: Track, trackIndex: number, store: StoreApi) {
    this.track = track;
    this.trackIndex = trackIndex;
    this.store = store;
    this.description = `Remove track "${track.name}"`;
    this.timestamp = Date.now();
  }

  execute(): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.filter((t) => t.id !== this.track.id),
    });
  }

  undo(): void {
    const { tracks } = this.store.getState();
    const newTracks = [...tracks];
    // Insert at original position
    newTracks.splice(this.trackIndex, 0, this.track);
    this.store.setState({ tracks: newTracks });
  }
}

/**
 * Command for updating track properties
 */
export class UpdateTrackCommand implements Command {
  type = "UPDATE_TRACK";
  description: string;
  timestamp: number;

  private trackId: string;
  private oldValues: Partial<Track>;
  private newValues: Partial<Track>;
  private store: StoreApi;

  constructor(
    trackId: string,
    oldValues: Partial<Track>,
    newValues: Partial<Track>,
    store: StoreApi,
  ) {
    this.trackId = trackId;
    this.oldValues = oldValues;
    this.newValues = newValues;
    this.store = store;
    this.description = `Update track properties`;
    this.timestamp = Date.now();
  }

  execute(): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) =>
        t.id === this.trackId ? { ...t, ...this.newValues } : t,
      ),
    });
  }

  undo(): void {
    const { tracks } = this.store.getState();
    this.store.setState({
      tracks: tracks.map((t) =>
        t.id === this.trackId ? { ...t, ...this.oldValues } : t,
      ),
    });
  }
}

/**
 * Command for reordering tracks
 */
export class ReorderTrackCommand implements Command {
  type = "REORDER_TRACK";
  description: string;
  timestamp: number;

  private fromIndex: number;
  private toIndex: number;
  private store: StoreApi;

  constructor(fromIndex: number, toIndex: number, store: StoreApi) {
    this.fromIndex = fromIndex;
    this.toIndex = toIndex;
    this.store = store;
    this.description = `Reorder tracks`;
    this.timestamp = Date.now();
  }

  execute(): void {
    const { tracks } = this.store.getState();
    const newTracks = [...tracks];
    const [removed] = newTracks.splice(this.fromIndex, 1);
    newTracks.splice(this.toIndex, 0, removed);
    this.store.setState({ tracks: newTracks });
  }

  undo(): void {
    const { tracks } = this.store.getState();
    const newTracks = [...tracks];
    const [removed] = newTracks.splice(this.toIndex, 1);
    newTracks.splice(this.fromIndex, 0, removed);
    this.store.setState({ tracks: newTracks });
  }
}

// Validate before newProject() retires the current document. Deliberately reject
// broken identities/graphs instead of silently dropping a user's tracks/clips.
type RecordValue = Record<string, unknown>;
export interface GraphTrack {
  id: string;
  isFolder?: boolean;
  parentFolderId?: string;
  sends?: Array<{ destTrackId: string }>;
}

export function graphProblem(tracks: readonly GraphTrack[]): string | null {
  const index = new Map(tracks.map(track => [track.id, track]));
  if (index.size !== tracks.length) return "Duplicate track IDs";
  const cyclic = (edges: Map<string, string[]>) => {
    const incoming = new Map(tracks.map(track => [track.id, 0]));
    for (const destinations of edges.values()) for (const destination of destinations)
      incoming.set(destination, (incoming.get(destination) ?? 0) + 1);
    const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
    for (let cursor = 0; cursor < queue.length; ++cursor) for (const target of edges.get(queue[cursor]) ?? []) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) queue.push(target);
    }
    return queue.length !== tracks.length;
  };
  const folders = new Map<string, string[]>(), sends = new Map<string, string[]>();
  for (const track of tracks) {
    if (track.parentFolderId) {
      if (!index.get(track.parentFolderId)?.isFolder) return "A folder parent is missing or is not a folder";
      folders.set(track.id, [track.parentFolderId]);
    }
    const targets = (track.sends ?? []).map(send => send.destTrackId);
    if (targets.some(target => !index.has(target))) return "A send destination is missing";
    if (new Set(targets).size !== targets.length) return "Duplicate sends to the same destination";
    sends.set(track.id, targets);
  }
  if (cyclic(folders)) return "Folder relationships contain a cycle";
  if (cyclic(sends)) return "Track sends contain a feedback cycle";
  return null;
}

function object(value: unknown, location: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as RecordValue;
}
function list(owner: RecordValue, key: string, maximum: number): unknown[] {
  if (owner[key] == null) return [];
  if (!Array.isArray(owner[key]) || owner[key].length > maximum) throw new Error(`Invalid or oversized ${key}`);
  return owner[key];
}
function id(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f]/.test(value)
    || ["__proto__", "prototype", "constructor"].includes(value)) throw new Error(`Invalid ${location} ID`);
  return value;
}
function optionalText(owner: RecordValue, key: string, maximum = 32768) {
  if (owner[key] != null && (typeof owner[key] !== "string" || owner[key].length > maximum))
    throw new Error(`Invalid ${key}`);
}
function bounded(owner: RecordValue, key: string, fallback: number, minimum: number, maximum: number) {
  const value = owner[key];
  owner[key] = typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
function timing(owner: RecordValue, key: string, fallback = 0) {
  if (owner[key] == null) owner[key] = fallback;
  if (typeof owner[key] !== "number" || !Number.isFinite(owner[key]) || owner[key] < 0 || owner[key] > 1e9)
    throw new Error(`Invalid clip ${key}`);
}
function inspectEnvelope(root: unknown) {
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > 64) throw new Error("Project structure exceeds the safety limit");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Project contains a non-finite number");
    if (value && typeof value === "object") {
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (++nodes > 2_000_000) throw new Error("Project structure exceeds the safety limit");
        const child = (value as RecordValue)[key];
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Project contains an unsafe property name");
        if (typeof child === "number" && !Number.isFinite(child)) throw new Error("Project contains a non-finite number");
        if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

export function parseValidatedProject(json: string): RecordValue & { tracks: RecordValue[] } {
  if (json.length > 256 * 1024 * 1024) throw new Error("Project exceeds the 256 MiB limit");
  const data = object(JSON.parse(json), "Project");
  inspectEnvelope(data);
  if (!Array.isArray(data.tracks)) throw new Error("Project tracks must be an array");
  const tracks = list(data, "tracks", 4096).map(track => object(track, "Track"));
  const clipIds = new Set<string>();
  let totalClips = 0;
  const validateClips = (items: unknown[], unique: boolean) => items.map(value => {
    const clip = object(value, "Clip");
    const clipId = id(clip.id, "clip");
    if (++totalClips > 100_000 || (unique && clipIds.has(clipId))) throw new Error("Too many clips or duplicate clip IDs");
    if (unique) clipIds.add(clipId);
    timing(clip, "startTime"); timing(clip, "duration"); timing(clip, "offset");
    optionalText(clip, "filePath"); optionalText(clip, "name");
    if (clip.sampleRate != null) bounded(clip, "sampleRate", 44100, 8000, 384000);
    if (clip.playbackRate != null) bounded(clip, "playbackRate", 1, 0.01, 100);
    for (const key of ["notes", "events", "ccEvents", "pitchBendEvents"]) {
      for (const event of list(clip, key, 1_000_000)) object(event, `MIDI ${key}`);
    }
    return clip;
  });
  const pluginFields = (owner: RecordValue) => {
    for (const key of ["inputFXPaths", "trackFXPaths", "masterFXPaths"])
      for (const path of list(owner, key, 256)) if (typeof path !== "string" || path.length > 32768)
        throw new Error(`Invalid ${key}`);
    for (const key of ["inputFXStates", "trackFXStates", "masterFXStates"])
      for (const state of list(owner, key, 256)) if (state != null && (typeof state !== "string" || state.length > 89_478_496))
        throw new Error(`Invalid or oversized ${key}`);
    optionalText(owner, "instrumentState", 89_478_496);
    optionalText(owner, "instrumentPlugin");
  };
  for (const track of tracks) {
    id(track.id, "track");
    optionalText(track, "name"); optionalText(track, "color", 256);
    if (track.type == null) track.type = "audio";
    if (!["audio", "midi", "instrument", "bus", "ai"].includes(String(track.type))) throw new Error("Unknown track type");
    if (track.parentFolderId != null && track.parentFolderId !== "") id(track.parentFolderId, "folder");
    track.clips = validateClips(list(track, "clips", 100_000), true);
    track.midiClips = validateClips(list(track, "midiClips", 100_000), true);
    track.takes = list(track, "takes", 1024).map(lane => {
      if (!Array.isArray(lane)) throw new Error("Invalid take lane");
      return validateClips(lane, false);
    });
    for (const key of ["automationLanes", "midiEffects"]) for (const item of list(track, key, 4096)) object(item, key);
    const sends = list(track, "sends", 4096).map(send => object(send, "Send"));
    for (const send of sends) {
      id(send.destTrackId, "send destination");
      bounded(send, "level", 0.5, 0, 4); bounded(send, "pan", 0, -1, 1);
    }
    track.sends = sends;
    bounded(track, "volume", 1, 0, 16); bounded(track, "volumeDB", 0, -150, 24);
    bounded(track, "pan", 0, -1, 1);
    bounded(track, "inputChannelCount", 2, 1, 64); bounded(track, "inputStartChannel", 0, 0, 1023);
    bounded(track, "trackChannelCount", 2, 1, 64);
    pluginFields(track);
  }
  const problem = graphProblem(tracks as unknown as GraphTrack[]);
  if (problem) throw new Error(problem);
  bounded(data, "tempo", 120, 20, 999); bounded(data, "masterVolume", 1, 0, 16); bounded(data, "masterPan", 0, -1, 1);
  if (data.timeSignature != null) {
    const signature = object(data.timeSignature, "Time signature");
    bounded(signature, "numerator", 4, 1, 32);
    if (![1, 2, 4, 8, 16, 32, 64].includes(Number(signature.denominator))) signature.denominator = 4;
  }
  for (const key of ["markers", "regions", "tempoMarkers", "masterAutomationLanes", "mixerSnapshots", "trackGroups", "quantizePresets", "midiLearnMappings"])
    for (const item of list(data, key, 100_000)) object(item, key);
  if (data.undoHistory != null) {
    const history = object(data.undoHistory, "Undo history");
    for (const key of ["undoStack", "redoStack"]) for (const entry of list(history, key, 10000)) {
      const command = object(entry, "Undo entry"); optionalText(command, "type"); optionalText(command, "description");
    }
  }
  pluginFields(data);
  return { ...data, tracks };
}

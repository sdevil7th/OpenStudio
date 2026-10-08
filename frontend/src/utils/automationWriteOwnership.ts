// Runtime ownership is never serialized. Preview Punch writes only its chosen
// parameters; it must not arm every lane on the track.
export const automationPunchedParameters = new Set<string>();
export const automationWriteKey = (trackId: string, param: string) => `${trackId}::${param}`;
export const automationPunchOwnsTrack = (trackId: string) => [...automationPunchedParameters].some(key => key.startsWith(`${trackId}::`));

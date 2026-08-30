export function namRackTelemetryIntervalMs(tunerOpen: boolean): number {
  return tunerOpen ? 100 : 200;
}

export function shouldRefreshNAMRackDiagnostics(tunerOpen: boolean, tick: number): boolean {
  return !tunerOpen || tick % 2 === 0;
}

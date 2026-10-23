import type Konva from "konva";
import type { commandManager } from "../../src/store/commands";
import type { createDefaultTrack, useDAWStore } from "../../src/store/useDAWStore";

export interface BrowserRegressionReport {
  status: "pass";
  checks: string[];
  recordCalls?: string[];
  zoomIn?: number;
  zoomOut?: number;
}

export interface TrustedTransportKey { key: string; repeat: boolean; trusted: boolean }
export interface TransportKeyQa {
  store: typeof useDAWStore;
  calls: string[];
  keys: TrustedTransportKey[];
}
export interface TrackCopyQa {
  store: typeof useDAWStore;
  commandManager: typeof commandManager;
  seed: () => void;
}
export interface MidiAxisQa extends TrackCopyQa {
  createDefaultTrack: typeof createDefaultTrack;
}

declare global {
  interface Window {
    Konva: typeof Konva;
    __trustedTransportKeys: TrustedTransportKey[];
    __transportKeyQA: TransportKeyQa;
    __trackCopyQA: TrackCopyQa;
    __midiAxisQA: MidiAxisQa;
  }
}

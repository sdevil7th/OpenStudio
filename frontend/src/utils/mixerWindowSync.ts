import { nativeBridge, type MixerUISnapshotEnvelope } from "../services/NativeBridge";
import {
  useDAWStore,
  type AutomationLane,
  type MixerSnapshot,
  type Track,
} from "../store/useDAWStore";

type MixerTrackState = Omit<Track, "meterLevel" | "peakLevel" | "clipping" | "clips" | "midiClips">;

type MixerPanelPosition = {
  dock: "floating" | "left" | "right" | "bottom" | "tab";
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  tabGroup?: string;
};

export interface MixerUISnapshot {
  tracks: MixerTrackState[];
  selectedTrackIds: string[];
  lastSelectedTrackId: string | null;
  trackGroups: Array<{ id: string; name: string; leadTrackId: string; memberTrackIds: string[]; linkedParams: string[] }>;
  masterVolume: number;
  masterPan: number;
  masterFxCount: number;
  isMasterMuted: boolean;
  masterMono: boolean;
  masterAutomationLanes: AutomationLane[];
  showMasterAutomation: boolean;
  masterAutomationEnabled: boolean;
  mixerSnapshots: MixerSnapshot[];
  showMixer: boolean;
  detachedPanels: string[];
  panelPositions: {
    mixer: MixerPanelPosition;
  };
}

const windowId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `mixer-window-${Date.now()}-${Math.random().toString(16).slice(2)}`;

let remoteApplyDepth = 0;
let currentRevision = 0;
let lastPublishedSignature = "";

function serialiseTrack(track: Track): MixerTrackState {
  const { meterLevel, peakLevel, clipping, clips, midiClips, ...rest } = track;
  void meterLevel;
  void peakLevel;
  void clipping;
  void clips;
  void midiClips;
  return rest;
}

function getSnapshotSignature(snapshot: MixerUISnapshot): string {
  return JSON.stringify(snapshot);
}

function normaliseEnvelope(
  value: any,
): MixerUISnapshotEnvelope<MixerUISnapshot> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if ("payload" in value && "originWindowId" in value) {
    return value as MixerUISnapshotEnvelope<MixerUISnapshot>;
  }

  return {
    originWindowId: "",
    revision: 0,
    payload: value as MixerUISnapshot,
  };
}

export function extractMixerUISnapshot(state = useDAWStore.getState()): MixerUISnapshot {
  const mixerPosition = state.panelPositions.mixer ?? {
    dock: "bottom",
    x: 0,
    y: 0,
    width: 1280,
    height: 540,
    visible: false,
  };

  return {
    tracks: state.tracks.map(serialiseTrack),
    selectedTrackIds: state.selectedTrackIds,
    lastSelectedTrackId: state.lastSelectedTrackId,
    trackGroups: state.trackGroups,
    masterVolume: state.masterVolume,
    masterPan: state.masterPan,
    masterFxCount: state.masterFxCount,
    isMasterMuted: state.isMasterMuted,
    masterMono: state.masterMono,
    masterAutomationLanes: state.masterAutomationLanes,
    showMasterAutomation: state.showMasterAutomation,
    masterAutomationEnabled: state.masterAutomationEnabled,
    mixerSnapshots: state.mixerSnapshots,
    showMixer: state.showMixer,
    detachedPanels: state.detachedPanels,
    panelPositions: {
      mixer: {
        dock: mixerPosition.dock,
        x: mixerPosition.x,
        y: mixerPosition.y,
        width: mixerPosition.width,
        height: mixerPosition.height,
        visible: mixerPosition.visible,
        tabGroup: mixerPosition.tabGroup,
      },
    },
  };
}

export function applyMixerUISnapshot(snapshot: MixerUISnapshot): void {
  useDAWStore.setState((state) => {
    const existingTracks = new Map(state.tracks.map((track) => [track.id, track]));

    const tracks = snapshot.tracks.map((remoteTrack) => {
      const currentTrack = existingTracks.get(remoteTrack.id);
      return {
        ...(currentTrack ?? {
          meterLevel: 0,
          peakLevel: 0,
          clipping: false,
          clips: [],
          midiClips: [],
        }),
        ...remoteTrack,
        meterLevel: currentTrack?.meterLevel ?? 0,
        peakLevel: currentTrack?.peakLevel ?? 0,
        clipping: currentTrack?.clipping ?? false,
        clips: currentTrack?.clips ?? [],
        midiClips: currentTrack?.midiClips ?? [],
      } as Track;
    });

    return {
      tracks,
      selectedTrackIds: snapshot.selectedTrackIds,
      selectedTrackId: snapshot.selectedTrackIds[0] ?? null,
      lastSelectedTrackId:
        snapshot.lastSelectedTrackId ??
        snapshot.selectedTrackIds[snapshot.selectedTrackIds.length - 1] ??
        null,
      trackGroups: snapshot.trackGroups,
      masterVolume: snapshot.masterVolume,
      masterPan: snapshot.masterPan,
      masterFxCount: snapshot.masterFxCount,
      isMasterMuted: snapshot.isMasterMuted,
      masterMono: snapshot.masterMono,
      masterAutomationLanes: snapshot.masterAutomationLanes,
      showMasterAutomation: snapshot.showMasterAutomation,
      masterAutomationEnabled: snapshot.masterAutomationEnabled,
      mixerSnapshots: snapshot.mixerSnapshots,
      showMixer: snapshot.showMixer,
      detachedPanels: snapshot.detachedPanels,
      panelPositions: {
        ...state.panelPositions,
        mixer: {
          ...state.panelPositions.mixer,
          ...snapshot.panelPositions.mixer,
        },
      },
    };
  });
}

export async function publishCurrentMixerUISnapshot(): Promise<void> {
  const payload = extractMixerUISnapshot();
  lastPublishedSignature = getSnapshotSignature(payload);
  currentRevision += 1;
  await nativeBridge.publishMixerUISnapshot({
    originWindowId: windowId,
    revision: currentRevision,
    payload,
  });
}

export async function hydrateMixerUISnapshotFromNative(): Promise<boolean> {
  const rawSnapshot = await nativeBridge.getMixerUISnapshot<
    MixerUISnapshotEnvelope<MixerUISnapshot> | MixerUISnapshot | null
  >();
  const envelope = normaliseEnvelope(rawSnapshot);
  if (!envelope) {
    return false;
  }

  currentRevision = Math.max(currentRevision, envelope.revision ?? 0);
  lastPublishedSignature = getSnapshotSignature(envelope.payload);
  remoteApplyDepth += 1;
  try {
    applyMixerUISnapshot(envelope.payload);
  } finally {
    remoteApplyDepth -= 1;
  }
  return true;
}

export function startMixerUISync(): () => void {
  void publishCurrentMixerUISnapshot();

  const unsubscribeStore = useDAWStore.subscribe(
    (state) => extractMixerUISnapshot(state),
    (snapshot) => {
      if (remoteApplyDepth > 0) {
        return;
      }

      const signature = getSnapshotSignature(snapshot);
      if (signature === lastPublishedSignature) {
        return;
      }

      lastPublishedSignature = signature;
      currentRevision += 1;
      void nativeBridge.publishMixerUISnapshot({
        originWindowId: windowId,
        revision: currentRevision,
        payload: snapshot,
      });
    },
  );

  const unsubscribeRemote = nativeBridge.subscribe("mixerUISync", (value) => {
    const envelope = normaliseEnvelope(value);
    if (!envelope || envelope.originWindowId === windowId) {
      return;
    }

    currentRevision = Math.max(currentRevision, envelope.revision ?? 0);
    lastPublishedSignature = getSnapshotSignature(envelope.payload);
    remoteApplyDepth += 1;
    try {
      applyMixerUISnapshot(envelope.payload);
    } finally {
      queueMicrotask(() => {
        remoteApplyDepth = Math.max(0, remoteApplyDepth - 1);
      });
    }
  });

  return () => {
    unsubscribeStore();
    unsubscribeRemote();
  };
}

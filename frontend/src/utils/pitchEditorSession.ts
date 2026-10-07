import { create } from "zustand";
import { nativeBridge } from "../services/NativeBridge";
import { cancelPitchEditorGesture, getCommittedPitchNotes, restoreCommittedPitchNotes, pitchSourceRevision, isCurrentPitchEditorClipEditable, usePitchEditorStore, type PitchEditorState } from "../store/pitchEditorStore";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { getProjectEpoch } from "./projectLifetime";
import { windowRole } from "./windowEnvironment";
import { PitchCommandGate, samePitchIdentity, validPitchAction, type PitchSessionIdentity, type PitchSessionCommand } from "./pitchSessionProtocol";

type DAW = ReturnType<typeof useDAWStore.getState>;
type PitchData = { [K in keyof PitchEditorState as PitchEditorState[K] extends (...args: never[]) => unknown ? never : K]: PitchEditorState[K] };
export interface PitchSnapshot extends PitchSessionIdentity {
  revision: number;
  ackSequence: number;
  pitch: Partial<PitchData>;
  daw?: Pick<DAW, "tracks" | "pitchEditorTrackId" | "pitchEditorClipId" | "timeSignature" | "tcpWidth">;
  error?: string;
  projectPath?: string | null;
  committedNotes?: PitchData["notes"];
}
export const usePitchWindowState = create<{ detached: boolean; opening: boolean; error: string; recovery?: PitchSnapshot }> (() => ({ detached: false, opening: false, error: "" }));
let publishNow: (() => Promise<void>) | undefined;

export async function detachPitchEditor() {
  if (!usePitchEditorStore.getState().clipId || !publishNow) return;
  cancelPitchEditorGesture();
  usePitchWindowState.setState({ opening: true, error: "" });
  await publishNow();
  if (!await nativeBridge.pitchEditorSession("open"))
    usePitchWindowState.setState({ opening: false, error: "The native pitch window could not open." });
}
export async function dockPitchEditor() {
  cancelPitchEditorGesture();
  usePitchWindowState.setState({ detached: false, opening: false });
  await nativeBridge.pitchEditorSession("close", "dock");
}

export function recoverPitchCheckpoint(): boolean {
  const recovery = usePitchWindowState.getState().recovery;
  const state = usePitchEditorStore.getState();
  const daw = useDAWStore.getState();
  if (!recovery?.committedNotes || !state.contour || daw.transport.isRecording
    || !daw.projectPath || recovery.projectPath !== daw.projectPath
    || recovery.sessionId !== `${state.trackId}:${state.clipId}`
    || recovery.sourceRevision !== identity(0).sourceRevision) {
    usePitchWindowState.setState({ error: "Open the matching saved project and source clip, and finish analysis before recovering pitch edits." });
    return false;
  }
  if (!restoreCommittedPitchNotes(recovery.committedNotes)) return false;
  usePitchWindowState.setState({ recovery: undefined, error: "" });
  void nativeBridge.pitchEditorSession("discardRecovery");
  return true;
}

function dataOnly(state: PitchEditorState): PitchData {
  return Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== "function")) as PitchData;
}
function identity(generation: number): PitchSessionIdentity {
  const s = usePitchEditorStore.getState();
  return { projectEpoch: getProjectEpoch(), generation, sessionId: `${s.trackId ?? ""}:${s.clipId ?? ""}`,
    sourceRevision: s.sourceRevision };
}

/** Only this main-window controller may invoke analysis, preview or edit actions. */
export function startPitchEditorSessionController(): () => void {
  if (windowRole !== "main") return () => {};
  let generation = 1;
  let current = identity(generation);
  let gate: PitchCommandGate | undefined;
  let revision = 0;
  let last: Partial<PitchData> = {};
  let lastTrack: DAW["tracks"][number] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHeartbeat = Date.now();
  let stopped = false;
  let publishing: Promise<void> | undefined;
  let queuedSnapshot: PitchSnapshot | undefined;
  let lastCommitted: PitchData["notes"] | undefined;
  const drainPublications = (): Promise<void> => {
    if (publishing) return publishing;
    publishing = (async () => {
      while (queuedSnapshot && !stopped) {
        const snapshot = queuedSnapshot; queuedSnapshot = undefined;
        await nativeBridge.pitchEditorSession("publish", snapshot);
      }
    })().catch(() => {
      usePitchWindowState.setState({ error: "Pitch window synchronization failed. Dock and reopen the editor." });
    }).finally(() => { publishing = undefined; if (queuedSnapshot && !stopped) void drainPublications(); });
    return publishing;
  };
  const publish = (full = false, error = ""): Promise<void> => {
    if (stopped) return Promise.resolve();
    const next = identity(generation);
    if (!samePitchIdentity(next, current)) {
      cancelPitchEditorGesture();
      generation++;
      current = identity(generation);
      gate = undefined;
      last = {};
      full = true;
    }
    const pitch = dataOnly(usePitchEditorStore.getState());
    const delta = Object.fromEntries(Object.entries(pitch).filter(([key, value]) => full || last[key as keyof PitchData] !== value));
    const daw = useDAWStore.getState();
    const track = daw.tracks.find(t => t.id === pitch.trackId);
    const dawChanged = full || track !== lastTrack;
    lastTrack = track;
    last = pitch;
    const snapshot: PitchSnapshot = { ...current, projectPath: daw.projectPath, revision: ++revision, ackSequence: gate?.sequence ?? 0, pitch: delta, error,
      ...(dawChanged ? { daw: { tracks: track ? [track] : [], pitchEditorTrackId: pitch.trackId, pitchEditorClipId: pitch.clipId,
        timeSignature: daw.timeSignature, tcpWidth: daw.tcpWidth } } : {}) };
    const committed = getCommittedPitchNotes();
    if (full || committed !== lastCommitted) { snapshot.committedNotes = committed; lastCommitted = committed; }
    queuedSnapshot = { ...queuedSnapshot, ...snapshot, pitch: { ...queuedSnapshot?.pitch, ...snapshot.pitch } };
    return drainPublications();
  };
  publishNow = () => { lastHeartbeat = Date.now(); return publish(true); };
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void publish(); }, 50); };
  const offPitch = usePitchEditorStore.subscribe(schedule);
  const offDAW = useDAWStore.subscribe((state, previous) => {
    if (state.tracks !== previous.tracks || state.showPitchEditor !== previous.showPitchEditor) schedule();
    if (state.tracks !== previous.tracks) {
      const pitch = usePitchEditorStore.getState();
      if (pitch.clipId) {
        const clip = state.tracks.find(t => t.id === pitch.trackId)?.clips.find(c => c.id === pitch.clipId);
        if (!clip || pitchSourceRevision(clip) !== pitch.sourceRevision) {
          usePitchEditorStore.getState().close();
          void dockPitchEditor();
        }
      }
    }
    if (!state.showPitchEditor && previous.showPitchEditor && (usePitchWindowState.getState().detached || usePitchWindowState.getState().opening)) void dockPitchEditor();
  });
  // This event is emitted only by the explicit native lifecycle harness.
  const offHarness = nativeBridge.subscribe("pitchEditorHarness", (payload: { filePath: string }) => {
    if (!payload?.filePath) return;
    const id = "window-lifecycle-pitch";
    const track = { ...createDefaultTrack(id, "Pitch lifecycle fixture"), clips: [{
      id: "window-lifecycle-pitch-clip", name: "Synthetic pitch fixture", filePath: payload.filePath,
      startTime: 0, duration: 3, offset: 0, volumeDB: 0, fadeIn: 0, fadeOut: 0, color: "#6789ab", locked: false,
    }] };
    useDAWStore.setState({ tracks: [...useDAWStore.getState().tracks.filter(t => t.id !== id), track] });
    useDAWStore.getState().openPitchEditor(id, track.clips[0].id, 0);
    schedule();
  });
  const offOwnerPing = nativeBridge.subscribe("pitchOwnerPing", () => {
    void nativeBridge.pitchEditorSession("ownerHeartbeat");
  });
  const offClosed = nativeBridge.subscribe("pitchEditorClosed", (event: { reason?: string }) => {
    gate = undefined;
    generation++;
    current = identity(generation);
    cancelPitchEditorGesture();
    usePitchWindowState.setState({ detached: false, opening: false });
    if (event?.reason === "close") useDAWStore.getState().closePitchEditor();
    void publish(true);
  });
  const offCommands = nativeBridge.subscribe("pitchEditorCommand", (message: PitchSessionCommand & { operation: string }) => {
    if (!message || !samePitchIdentity(identity(generation), message)) { void publish(true, "Session changed; synchronized the current target."); return; }
    if (message.operation === "heartbeat") { lastHeartbeat = Date.now(); return; }
    if (message.operation === "ready") {
      gate = new PitchCommandGate(current, message.viewId);
      lastHeartbeat = Date.now();
      cancelPitchEditorGesture();
      usePitchWindowState.setState({ detached: true, opening: false, error: "" });
      void nativeBridge.pitchEditorSession("acceptReady", message.viewId);
      void publish(true);
      return;
    }
    if (!gate) { void publish(true, "Editor must finish synchronizing before editing."); return; }
    const result = gate.accept(message);
    if (result !== "accept") {
      if (result !== "duplicate") {
        cancelPitchEditorGesture(); generation++; current = identity(generation); gate = undefined;
      }
      void publish(true, result === "duplicate" ? "" : "Edit was not accepted; synchronized the current state.");
      return;
    }
    lastHeartbeat = Date.now();
    if (message.action === "dock") { void dockPitchEditor(); return; }
    if (message.action === "cancelEdit") { cancelPitchEditorGesture(); schedule(); return; }
    if (message.action === "setViewportInitialized") { usePitchEditorStore.setState({ viewportInitialized: true }); return; }
    const state = usePitchEditorStore.getState();
    // The store also validates lock/freeze state for each mutation; missing or
    // replaced sources invalidate the entire session before any command runs.
    const track = useDAWStore.getState().tracks.find(t => t.id === state.trackId);
    const clip = track?.clips.find(c => c.id === state.clipId);
    if (!clip || pitchSourceRevision(clip) !== state.sourceRevision) {
      cancelPitchEditorGesture();
      void publish(true, "The source clip changed. Reopen the pitch editor.");
      return;
    }
    if (!isCurrentPitchEditorClipEditable() && !/^(set|select|deselect|toggle|analyze|undo|redo)/.test(message.action)) {
      cancelPitchEditorGesture(); schedule(); return;
    }
    const action = state[message.action as keyof PitchEditorState];
    if (typeof action === "function") {
      try { void Promise.resolve((action as (...args: unknown[]) => unknown)(...message.args)).catch(() => publish(true, "Pitch command failed.")); }
      catch { void publish(true, "Pitch command failed."); }
    }
    schedule();
  });
  void nativeBridge.pitchEditorSession<{ recovery?: PitchSnapshot }>("get").then(reply => {
    if (reply && reply.recovery?.committedNotes && !stopped) usePitchWindowState.setState({ recovery: reply.recovery });
  }).catch(() => {});
  const watchdog = setInterval(() => {
    void nativeBridge.pitchEditorSession("ownerHeartbeat");
    if (!samePitchIdentity(identity(generation), current)) schedule();
    const windowState = usePitchWindowState.getState();
    if ((windowState.detached || windowState.opening) && Date.now() - lastHeartbeat > 12000) {
      void dockPitchEditor();
      usePitchWindowState.setState({ error: "The pitch window stopped responding. Your accepted edits are retained here." });
    }
  }, 1000);
  void publish(true);
  return () => {
    stopped = true; publishNow = undefined;
    if (timer) clearTimeout(timer);
    clearInterval(watchdog); offPitch(); offDAW(); offHarness(); offOwnerPing(); offClosed(); offCommands();
    cancelPitchEditorGesture();
  };
}

/** Replace every store action before mounting the remote editor. No second engine owner. */
export async function connectPitchEditorView(onHydrated: () => void, onError: (message: string) => void): Promise<() => void> {
  let snapshot: PitchSnapshot | undefined;
  let viewId = "";
  let sequence = 0;
  let sending: Promise<void> | undefined;
  const queuedCommands: Array<Omit<PitchSessionCommand, "sequence">> = [];
  let readyGeneration = -1;
  let active = true;
  const originals = usePitchEditorStore.getState();
  const drainCommands = (): Promise<void> => {
    if (sending) return sending;
    sending = (async () => {
      while (queuedCommands.length && active) {
        const command = queuedCommands.shift()!;
        if (!snapshot || !samePitchIdentity(command, snapshot)) continue;
        if (!await nativeBridge.pitchEditorSession("command", { ...command, sequence: ++sequence }))
          throw new Error("Pitch session is unavailable. Dock and reopen the editor.");
      }
    })().catch(error => { queuedCommands.length = 0; onError(String(error)); })
      .finally(() => { sending = undefined; if (queuedCommands.length && active) void drainCommands(); });
    return sending;
  };
  const send = (action: string, args: unknown[] = []) => {
    if (!snapshot || !validPitchAction(action, args) || !active) return Promise.resolve();
    const command = { ...identityFrom(snapshot), action, args, viewId, requestId: crypto.randomUUID() };
    const last = queuedCommands[queuedCommands.length - 1];
    if (last && action === "updateNote" && last.action === action && last.args[0] === args[0]
      && samePitchIdentity(last, command)) {
      // Coalesce only unsent previews. Begin/commit/cancel remain ordered and
      // a commit always follows the latest value of every preceding preview.
      last.args = [args[0], { ...last.args[1] as object, ...args[1] as object }];
    } else queuedCommands.push(command);
    return drainCommands();
  };
  const proxies = Object.fromEntries(Object.entries(originals).filter(([, v]) => typeof v === "function").map(([action]) => [action, (...args: unknown[]) => {
    if (["setZoomX", "setScrollX", "setZoomY", "setScrollY"].includes(action))
      (originals[action as keyof PitchEditorState] as (...a: unknown[]) => unknown)(...args);
    return send(action, args);
  }]));
  usePitchEditorStore.setState(proxies);
  useDAWStore.setState({ closePitchEditor: () => { void send("dock"); } });
  const apply = (incoming: PitchSnapshot) => {
    if (!active || !incoming || !incoming.pitch || !Number.isSafeInteger(incoming.revision)) return;
    if (snapshot && incoming.revision <= snapshot.revision) return;
    const changedSession = !snapshot || !samePitchIdentity(incoming, snapshot);
    if (changedSession) { sequence = 0; queuedCommands.length = 0; }
    snapshot = incoming;
    usePitchEditorStore.setState(incoming.pitch);
    if (incoming.daw) useDAWStore.setState({ ...incoming.daw, showPitchEditor: true });
    if (incoming.error) onError(incoming.error);
    if (changedSession || readyGeneration !== incoming.generation) {
      readyGeneration = incoming.generation;
      onHydrated();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (active && snapshot && document.querySelector("canvas")?.getBoundingClientRect().width)
          void nativeBridge.pitchEditorSession("ready", { ...identityFrom(snapshot), viewId });
      }));
    }
  };
  const off = nativeBridge.subscribe("pitchEditorSnapshot", apply);
  const initial = await nativeBridge.pitchEditorSession<{ snapshot: PitchSnapshot; viewId: string }>("get");
  if (!initial || !initial.snapshot?.pitch) { off(); throw new Error("The main pitch session is unavailable."); }
  viewId = initial.viewId;
  apply(initial.snapshot);
  const offHarnessEdit = nativeBridge.subscribe("pitchEditorHarnessEdit", (action: string) => {
    if (action === "relative+4") { void send("selectAll"); void send("moveSelectedPitch", [4]); }
    if (action === "undo") void send("undo");
  });
  const heartbeat = setInterval(() => { if (snapshot) void nativeBridge.pitchEditorSession("heartbeat", identityFrom(snapshot)); }, 2000);
  const cancel = () => { void send("cancelEdit"); };
  window.addEventListener("blur", cancel);
  const dock = () => { void send("dock"); };
  window.addEventListener("openstudio:dock-pitch", dock);
  return () => { cancel(); active = false; clearInterval(heartbeat); off(); offHarnessEdit(); window.removeEventListener("blur", cancel); window.removeEventListener("openstudio:dock-pitch", dock); };
}
function identityFrom(snapshot: PitchSnapshot): PitchSessionIdentity {
  return { projectEpoch: snapshot.projectEpoch, sessionId: snapshot.sessionId, generation: snapshot.generation, sourceRevision: snapshot.sourceRevision };
}

export function initializePitchViewport() {
  if (windowRole === "pitchEditor") return; // Authoritative initial geometry travels with the snapshot.
  usePitchEditorStore.setState({ viewportInitialized: true });
}

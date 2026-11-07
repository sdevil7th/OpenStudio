import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { usePitchEditorStore } from "../store/pitchEditorStore";
import { connectPitchEditorView, type PitchSnapshot } from "../utils/pitchEditorSession";

const daw = useDAWStore.getState();
const pitch = usePitchEditorStore.getState();
const snapshot = (revision: number, generation = 1): PitchSnapshot => ({
  projectEpoch: 1, generation, sessionId: "track:clip", sourceRevision: "source", revision,
  ackSequence: 0, pitch: {},
});
let stop: (() => void) | undefined;
let deliver: (value: PitchSnapshot) => void;
let rendered: Array<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  rendered = [];
  vi.spyOn(nativeBridge, "subscribe").mockImplementation((name, callback) => {
    if (name === "pitchEditorSnapshot") deliver = callback;
    return () => {};
  });
  vi.spyOn(nativeBridge, "pitchEditorSession").mockImplementation(async operation =>
    operation === "get" ? { snapshot: snapshot(1), viewId: "view" } : true as never);
});
afterEach(() => {
  stop?.(); stop = undefined;
  usePitchEditorStore.setState(pitch);
  useDAWStore.setState(daw);
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const readyCalls = () => vi.mocked(nativeBridge.pitchEditorSession).mock.calls.filter(([operation]) => operation === "ready");
const hydrate = (ready: () => void) => { rendered.push(ready); };

describe("detached pitch canvas readiness", () => {
  it("waits for the rendered canvas and acknowledges each generation once", async () => {
    stop = await connectPitchEditorView(hydrate, vi.fn());
    await vi.advanceTimersByTimeAsync(5000);
    expect(readyCalls()).toHaveLength(0);
    rendered[0](); rendered[0]();
    expect(readyCalls()).toHaveLength(1);
    expect(readyCalls()[0][1]).toMatchObject({ generation: 1, viewId: "view" });
  });
  it("rejects an old render callback after the session generation changes", async () => {
    stop = await connectPitchEditorView(hydrate, vi.fn());
    deliver(snapshot(2, 2));
    rendered[0]();
    expect(readyCalls()).toHaveLength(0);
    rendered[1]();
    expect(readyCalls()[0][1]).toMatchObject({ generation: 2 });
  });
  it("does not acknowledge a view after disconnect", async () => {
    stop = await connectPitchEditorView(hydrate, vi.fn());
    stop(); stop = undefined;
    rendered[0]();
    expect(readyCalls()).toHaveLength(0);
  });
  it("acknowledges a replacement project even if its generation number repeats", async () => {
    stop = await connectPitchEditorView(hydrate, vi.fn());
    rendered[0]();
    deliver({ ...snapshot(2), projectEpoch: 2 });
    rendered[0]();
    expect(readyCalls()).toHaveLength(1);
    rendered[1]();
    expect(readyCalls()).toHaveLength(2);
    expect(readyCalls()[1][1]).toMatchObject({ projectEpoch: 2, generation: 1 });
  });
  it("handles a snapshot rendering before the initial native view ID arrives", async () => {
    let reply!: (value: unknown) => void;
    vi.mocked(nativeBridge.pitchEditorSession).mockImplementation(operation =>
      (operation === "get" ? new Promise(resolve => { reply = resolve; }) : Promise.resolve(true)) as never);
    const connection = connectPitchEditorView(hydrate, vi.fn());
    deliver(snapshot(2));
    rendered[0]();
    expect(readyCalls()).toHaveLength(0);
    reply({ snapshot: snapshot(1), viewId: "view" });
    stop = await connection;
    expect(readyCalls()).toHaveLength(1);
    expect(readyCalls()[0][1]).toMatchObject({ viewId: "view", generation: 1 });
  });
});

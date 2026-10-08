import source from "../../../Source/MainComponent.cpp?raw";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = source.match(/\.withUserScript\(R"\(([\s\S]*?)\)"\)/)?.[1];
if (!script) throw new Error("Native bridge user script is missing");
const deferredNames = [...source.matchAll(/withNativeFunction \("([^"]+)", deferNativeMutation\("\1", /g)]
  .map(match => match[1]);

interface Completion { promiseId: number; result: unknown }
interface Invocation { name: string; resultId: number; params: unknown[] }
function bridge() {
  const listeners = new Map<number, (event: Completion) => void>();
  const invokes: Invocation[] = [];
  let listenerId = 0;
  const backend = {
    getNativeFunction: undefined as ((name: string) => (...args: unknown[]) => Promise<unknown>) | undefined,
    addEventListener: (_name: string, handler: (event: Completion) => void) => {
      const id = ++listenerId; listeners.set(id, handler); return id;
    },
    removeEventListener: (id: number) => listeners.delete(id),
    emitEvent: (_name: string, invocation: Invocation) => invokes.push(invocation),
  };
  const window = { __JUCE__: { backend, initialisationData: {
    __juce__functions: [], __openStudioDeferredMutationFunctions: [deferredNames],
  } } };
  new Function("window", "console", script!)(window, { log: () => undefined });
  return {
    invoke: (name: string) => backend.getNativeFunction!(name)(), listeners,
    complete: (index: number, value: unknown) => {
      for (const listener of [...listeners.values()]) listener({ promiseId: invokes[index].resultId, result: value });
    },
  };
}

afterEach(() => vi.useRealTimers());
describe("native bridge deadlines during offline transactions", () => {
  it.each(deferredNames)("keeps %s pending until native completion after a long export", async name => {
    vi.useFakeTimers();
    const native = bridge();
    const result = native.invoke(name);
    await vi.advanceTimersByTimeAsync(120000);
    expect(native.listeners.size).toBe(1);
    native.complete(0, true);
    await expect(result).resolves.toBe(true);
    expect(native.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps Freeze pending until its duration-dependent worker finishes", async () => {
    vi.useFakeTimers();
    const native = bridge(), result = native.invoke("freezeTrack");
    await vi.advanceTimersByTimeAsync(120000);
    native.complete(0, { success: true });
    await expect(result).resolves.toEqual({ success: true });
    expect(native.listeners.size).toBe(0);
  });
  it("retains the ordinary read deadline and removes its listener", async () => {
    vi.useFakeTimers();
    const native = bridge();
    const result = native.invoke("getTransportPosition");
    const rejection = expect(result).rejects.toThrow("Native function call timeout: getTransportPosition");
    await vi.advanceTimersByTimeAsync(15000);
    await rejection;
    expect(native.listeners.size).toBe(0);
  });
  it("routes simultaneous completions to the correct queued call", async () => {
    vi.useFakeTimers();
    const native = bridge();
    const first = native.invoke("addMasterBuiltInFX"), second = native.invoke("getFXStageState");
    await vi.advanceTimersByTimeAsync(120000);
    native.complete(1, ["restored"]); native.complete(0, true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toEqual(["restored"]);
    expect(native.listeners.size).toBe(0);
  });
});

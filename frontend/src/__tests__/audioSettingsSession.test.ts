import { describe, expect, it, vi } from "vitest";
import { AudioSettingsSession, audioDeviceAcceptanceNotice } from "../utils/audioSettingsSession";
import type { AudioDeviceDraft, AudioDeviceSetupResponse } from "../services/NativeBridge";

const setup = (outputDevice = "Interface", sampleRate = 44100, bufferSize = 64): AudioDeviceSetupResponse => ({
  current: { audioDeviceType: "Windows Audio", inputDevice: "Microphone", outputDevice, sampleRate, bufferSize },
  outputs: ["Interface", "Speakers"], inputs: ["Microphone"],
  sampleRates: outputDevice === "Speakers" ? [48000] : [44100, 48000],
  bufferSizes: outputDevice === "Speakers" ? [480, 960] : [64, 128],
});
const asioSetup = (bufferSize = 8): AudioDeviceSetupResponse => ({
  ...setup("Audient", 48000, bufferSize),
  current: { audioDeviceType: "ASIO", inputDevice: "Audient", outputDevice: "Audient", sampleRate: 48000, bufferSize },
  bufferSizes: [8, 16, 32],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("audio settings pending configuration", () => {
  it("reports accepted scalar changes while leaving automatic or identical requests quiet", () => {
    expect(audioDeviceAcceptanceNotice(asioSetup(16).current, asioSetup(8).current)).toBe("Requested 16 samples; the driver accepted 8 samples.");
    expect(audioDeviceAcceptanceNotice(setup("Interface", 44100, 128).current, setup("Interface", 48000, 64).current)).toBe("Requested 128 samples; the driver accepted 64 samples. Requested 44100 Hz; the driver accepted 48000 Hz.");
    expect(audioDeviceAcceptanceNotice(setup().current, setup().current)).toBeNull();
    expect(audioDeviceAcceptanceNotice(setup("Interface", 0, 0).current, setup().current)).toBeNull();
  });
  it("updates dependent options and selections without applying, preserving the active setup", async () => {
    const query = vi.fn(async () => ({ ...setup("Speakers", 48000, 480), adjustments: ["Sample rate adjusted to 48000."] }));
    const session = new AudioSettingsSession(query);
    await session.load(async () => setup());
    await session.select({ outputDevice: "Speakers" });
    expect(query).toHaveBeenCalledWith({ ...setup().current, outputDevice: "Speakers", sampleRate: 0, bufferSize: 0 });
    expect(session.getSnapshot().setup?.current).toMatchObject({ inputDevice: "Microphone", sampleRate: 48000, bufferSize: 480 });
    expect(session.getSnapshot().setup?.bufferSizes).toEqual([480, 960]);
    expect(session.getSnapshot().applied?.current.outputDevice).toBe("Interface");
    expect(session.getSnapshot().setup?.adjustments).toHaveLength(1);
  });

  it("keeps the newest selection when requests resolve out of order", async () => {
    const first = deferred<AudioDeviceSetupResponse>();
    const second = deferred<AudioDeviceSetupResponse>();
    const query = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const session = new AudioSettingsSession(query);
    await session.load(async () => setup());
    const a = session.select({ outputDevice: "Speakers" });
    const b = session.select({ outputDevice: "Interface", sampleRate: 48000 });
    second.resolve(setup("Interface", 48000, 128));
    await b;
    first.resolve(setup("Speakers", 48000, 480));
    await a;
    expect(session.getSnapshot().setup?.current).toMatchObject({ outputDevice: "Interface", sampleRate: 48000, bufferSize: 128 });
    expect(session.getSnapshot().resolving).toBe(false);
  });

  it("does not publish a late error after Cancel and reopening", async () => {
    const pending = deferred<AudioDeviceSetupResponse>();
    const session = new AudioSettingsSession(() => pending.promise);
    await session.load(async () => setup());
    const request = session.select({ outputDevice: "Speakers" });
    session.invalidate();
    await session.load(async () => setup("Interface", 48000, 128));
    pending.reject(new Error("Old driver unavailable"));
    await request;
    expect(session.getSnapshot().error).toBeNull();
    expect(session.getSnapshot().setup?.current.bufferSize).toBe(128);
  });

  it("publishes actual values after Apply while staying in the same session", async () => {
    const session = new AudioSettingsSession(async () => setup("Speakers", 48000, 480));
    await session.load(async () => setup());
    await session.select({ outputDevice: "Speakers" });
    session.acceptApplied(setup("Speakers", 48000, 960));
    expect(session.getSnapshot().applied).toEqual(session.getSnapshot().setup);
    expect(session.getSnapshot().setup?.current.bufferSize).toBe(960);
  });

  it("retains a failed draft and native error while showing the recovered applied device", async () => {
    const session = new AudioSettingsSession(async () => setup("Speakers", 48000, 480));
    await session.load(async () => setup());
    await session.select({ outputDevice: "Speakers" });
    session.acceptApplied(setup(), true);
    session.setError("The device is in use.");
    expect(session.getSnapshot().applied?.current.outputDevice).toBe("Interface");
    expect(session.getSnapshot().setup?.current.outputDevice).toBe("Speakers");
    expect(session.getSnapshot().error).toBe("The device is in use.");
  });

  it("exposes an incompatible pair as an error rather than retaining stale capabilities", async () => {
    const session = new AudioSettingsSession(async () => ({ ...setup("Speakers"), sampleRates: [], bufferSizes: [], error: "No common sample rates", capabilityStatus: "unavailable" }));
    await session.load(async () => setup());
    await session.select({ outputDevice: "Speakers" });
    expect(session.getSnapshot().error).toBe("No common sample rates");
    expect(session.getSnapshot().setup?.bufferSizes).toEqual([]);
  });

  it("retains a supported pending ASIO buffer without changing the applied device", async () => {
    const active = asioSetup();
    const query = vi.fn(async (draft: AudioDeviceDraft) => ({ ...active, current: { ...active.current, ...draft } }));
    const session = new AudioSettingsSession(query);
    await session.load(async () => active);
    await session.select({ bufferSize: 16 });
    expect(query).toHaveBeenCalledWith({ ...active.current, bufferSize: 16 });
    expect(session.getSnapshot().setup?.current.bufferSize).toBe(16);
    expect(session.getSnapshot().applied?.current.bufferSize).toBe(8);
    expect(session.getSnapshot().error).toBeNull();
  });

  it("keeps the ASIO draft on discovery failure and retries it with unavailable capabilities intact", async () => {
    const active = asioSetup();
    const query = vi.fn()
      .mockResolvedValueOnce({ ...active, bufferSizes: [], sampleRates: [], capabilityStatus: "unavailable", error: "Driver could not report its settings." })
      .mockResolvedValueOnce({ ...active, current: { ...active.current, bufferSize: 16 } })
      .mockResolvedValueOnce({ ...active, current: { ...active.current, bufferSize: 32 } });
    const session = new AudioSettingsSession(query);
    await session.load(async () => active);
    await session.select({ bufferSize: 16 });
    expect(session.getSnapshot()).toMatchObject({
      error: "Driver could not report its settings.", resolving: false,
      setup: { current: { bufferSize: 16 }, bufferSizes: [], sampleRates: [], capabilityStatus: "unavailable" },
      applied: { current: { bufferSize: 8 } },
    });
    await session.select({});
    expect(query).toHaveBeenNthCalledWith(2, { ...active.current, bufferSize: 16 });
    expect(session.getSnapshot().setup?.current.bufferSize).toBe(16);
    expect(session.getSnapshot().error).toBeNull();
    await session.select({ bufferSize: 32 });
    expect(session.getSnapshot().setup?.current.bufferSize).toBe(32);
    expect(session.getSnapshot().applied?.current.bufferSize).toBe(8);
  });

  it("does not let a late failed buffer query replace a newer successful choice", async () => {
    const first = deferred<AudioDeviceSetupResponse>();
    const second = deferred<AudioDeviceSetupResponse>();
    const active = asioSetup();
    const query = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const session = new AudioSettingsSession(query);
    await session.load(async () => active);
    const pending16 = session.select({ bufferSize: 16 });
    const pending32 = session.select({ bufferSize: 32 });
    second.resolve({ ...active, current: { ...active.current, bufferSize: 32 } });
    await pending32;
    first.resolve({ ...active, bufferSizes: [], error: "Old inspection failed." });
    await pending16;
    expect(session.getSnapshot().setup?.current.bufferSize).toBe(32);
    expect(session.getSnapshot().error).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge, type MIDILearnMappingInfo } from "../services/NativeBridge";

const mapping: MIDILearnMappingInfo = { ccNumber: 14, trackId: "guitar", chainType: "track", pluginIndex: 1, paramIndex: 7 };
function nativeMappings(actual: MIDILearnMappingInfo[], success = true) {
  vi.stubGlobal("window", { __JUCE__: { backend: {
    addTrack: vi.fn(), addEventListener: vi.fn(),
    setMIDILearnMappings: vi.fn().mockResolvedValue(success), getMIDILearnMappings: vi.fn().mockResolvedValue(actual),
  } } });
  const Bridge = nativeBridge.constructor as new () => typeof nativeBridge;
  return new Bridge();
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("native MIDI Learn publication verification", () => {
  it("accepts all controls after native readback, regardless of order", async () => {
    const second = { ...mapping, ccNumber: 15, chainType: "input" as const };
    expect(await nativeMappings([second, mapping]).setMIDILearnMappings([mapping, second])).toBe(true);
  });
  it("accepts built-in stable IDs with native sentinel indices", async () => {
    const builtIn = { ...mapping, builtIn: true, paramId: "gain" };
    expect(await nativeMappings([{ ...builtIn, paramIndex: -1 }]).setMIDILearnMappings([builtIn])).toBe(true);
  });
  it.each([[], [{ ...mapping, paramIndex: 3 }], [{ ...mapping, pluginIndex: 3 }], [{ ...mapping, trackId: "other" }]].map(actual => ({ actual })))("rejects dropped or retargeted assignments ($actual)", async ({ actual }) => {
    expect(await nativeMappings(actual).setMIDILearnMappings([mapping])).toBe(false);
  });
  it("rejects a native publication failure even if the old mapping matches", async () => {
    expect(await nativeMappings([mapping], false).setMIDILearnMappings([mapping])).toBe(false);
  });
  it("verifies a complete clear", async () => {
    expect(await nativeMappings([]).setMIDILearnMappings([])).toBe(true);
    expect(await nativeMappings([mapping]).setMIDILearnMappings([])).toBe(false);
  });
});

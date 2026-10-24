import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FACTORY_PRESETS, parsePitchCorrectorPreset, type PitchCorrectorPreset } from "../components/pitchCorrectorPresets";
import { applyPitchCorrectorPreset, capturePitchCorrectorPreset, savePitchCorrectorPreset } from "../services/pitchCorrectorPresets";
import { nativeBridge, type BuiltInPluginAddress, type BuiltInPluginSchema } from "../services/NativeBridge";

const address: BuiltInPluginAddress = { trackId: "vocal", chain: "track", fxIndex: 2 };
const params: PitchCorrectorPreset["params"] = {
  key: 2, scale: 15, signalPath: 1, retuneSpeed: 120, correctionStrength: 0.8,
  humanize: 20, formantCorrection: true, formantShift: -2, mix: 0.75, transpose: -12,
  noteEnables: Array.from({ length: 12 }, (_, index) => index === 0),
  midiOutput: true, midiChannel: 7, bypass: false, sensitivity: 0.2,
  minFreqParam: 90, maxFreqParam: 1500, detectionSource: 2, humanizeMode: 1,
};
const nativeValues: Record<string, number> = {
  key: 2, scale: 15, signalPath: 1, retuneSpeed: 120, correctionStrength: 0.8,
  humanize: 20, formantCorrection: 1, formantShift: -2, mix: 0.75, transpose: -12,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`noteEnable_${index}`, index === 0 ? 1 : 0])),
  midiOutputEnabled: 1, midiOutputChannel: 7, bypass: 0, sensitivity: 0.2,
  minFreqParam: 90, maxFreqParam: 1500, detectionSource: 2, humanizeMode: 1,
};
const schema = (values = nativeValues): BuiltInPluginSchema => ({
  schemaVersion: 1, pluginId: "pitch", name: "OpenStudio Pitch Correct", category: "Pitch",
  chain: "track", fxIndex: 4, instanceId: "pitch-instance",
  parameters: Object.entries(values).map(([id, value]) => ({
    id, value, label: id, type: "continuous", min: 0, max: 4000, defaultValue: 0,
  })),
});
const document = (overrides: Record<string, unknown> = {}) => ({ name: "D custom", category: "User", params: { ...params, ...overrides } });

beforeEach(() => {
  vi.spyOn(nativeBridge, "getBuiltInPluginSchema").mockResolvedValue(schema());
  vi.spyOn(nativeBridge, "setBuiltInPluginState").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "saveJsonDocumentToFile").mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Pitch Correct preset compatibility", () => {
  it("imports old user presets in Legacy without rotating their key-relative mask", () => {
    const legacy = parsePitchCorrectorPreset(document({ signalPath: undefined }));
    expect(legacy.params.signalPath).toBe(0);
    expect(legacy.params.key).toBe(2);
    expect(legacy.params.noteEnables).toEqual(params.noteEnables);
    expect(legacy.params.noteEnables).not.toBe(params.noteEnables);
  });

  it("preserves every supported control in a new file round trip", () => {
    expect(parsePitchCorrectorPreset(JSON.parse(JSON.stringify(document())))).toEqual(document());
  });

  it.each([
    { signalPath: 2 }, { signalPath: "1" }, { signalPath: 0.5 }, { retuneSpeed: Infinity },
    { correctionStrength: -1 }, { noteEnables: [true] }, { noteEnables: Array(12).fill(1) },
    { key: 12 }, { midiOutput: 1 }, { midiChannel: 17 }, { sensitivity: 0.01 },
    { detectionSource: 3 }, { humanizeMode: 2 }, { formantCorrection: "false" },
  ])("rejects malformed state before a native mutation: %j", async invalid => {
    expect(() => parsePitchCorrectorPreset(document(invalid))).toThrow();
    expect(nativeBridge.setBuiltInPluginState).not.toHaveBeenCalled();
  });

  it("accepts the native float representation at a decimal control boundary", () => {
    expect(parsePitchCorrectorPreset(document({ sensitivity: Math.fround(0.02) })).params.sensitivity).toBe(0.02);
  });

  it("retains a fractional native MIDI channel value for the processor's own rounding", async () => {
    vi.mocked(nativeBridge.getBuiltInPluginSchema).mockResolvedValueOnce(schema({ ...nativeValues, midiOutputChannel: 7.25 }));
    const snapshot = await capturePitchCorrectorPreset(address);
    await applyPitchCorrectorPreset(snapshot.address, snapshot.params);
    expect(nativeBridge.setBuiltInPluginState).toHaveBeenCalledWith(snapshot.address, { values: { ...nativeValues, midiOutputChannel: 7.25 } });
  });

  it("keeps absent older advanced controls out of the restore patch", async () => {
    const legacy = { ...FACTORY_PRESETS[0].params };
    await applyPitchCorrectorPreset(address, legacy);
    const patch = vi.mocked(nativeBridge.setBuiltInPluginState).mock.calls[0][1] as { values: Record<string, number> };
    expect(patch.values.signalPath).toBe(0);
    for (const id of ["key", "noteEnable_0", "detectionSource", "humanizeMode", "midiOutputEnabled", "bypass"])
      expect(patch.values).not.toHaveProperty(id);
  });

  it("keeps factory tonal templates usable in either current processing mode", async () => {
    for (const signalPath of [0, 1] as const) {
      for (const preset of FACTORY_PRESETS) {
        await applyPitchCorrectorPreset(address, { signalPath, ...preset.params });
        const patch = vi.mocked(nativeBridge.setBuiltInPluginState).mock.lastCall?.[1] as { values: Record<string, number> };
        expect(patch.values.signalPath).toBe(signalPath);
        expect(patch.values).not.toHaveProperty("noteEnable_0");
      }
    }
  });
});

describe("Pitch Correct native snapshot transactions", () => {
  it("captures the fresh native schema and retains its instance and all controls", async () => {
    const snapshot = await capturePitchCorrectorPreset(address);
    expect(snapshot).toEqual({ address: { ...address, fxIndex: 4, instanceId: "pitch-instance" }, params });
    await applyPitchCorrectorPreset(snapshot.address, snapshot.params);
    expect(nativeBridge.setBuiltInPluginState).toHaveBeenCalledExactlyOnceWith(snapshot.address, { values: nativeValues });
  });

  it("restores cross-editor A/B processing mode and mask together in both directions", async () => {
    const classicWrite = vi.spyOn(nativeBridge, "setPitchCorrectorParam");
    vi.mocked(nativeBridge.getBuiltInPluginSchema).mockResolvedValueOnce(schema({ ...nativeValues, signalPath: 0, detectionSource: 0 }));
    const a = await capturePitchCorrectorPreset(address);
    // The suite editor selects Corrected and changes advanced controls before B is captured.
    const b = await capturePitchCorrectorPreset(a.address);
    await applyPitchCorrectorPreset(b.address, a.params);
    await applyPitchCorrectorPreset(a.address, b.params);
    const patches = vi.mocked(nativeBridge.setBuiltInPluginState).mock.calls.map(([, state]) => state as { values: Record<string, number> });
    expect(patches).toHaveLength(2);
    expect(patches[0].values).toEqual({ ...nativeValues, signalPath: 0, detectionSource: 0 });
    expect(patches[1].values).toEqual(nativeValues);
    // Same key/mask now retains its original D (Legacy) or C (Corrected) meaning.
    expect(patches.map(patch => patch.values.signalPath === 0 ? patch.values.key : 0)).toEqual([2, 0]);
    expect(classicWrite).not.toHaveBeenCalled();
  });

  it("rejects a different/replaced plugin or incomplete native mask before restore", async () => {
    vi.mocked(nativeBridge.getBuiltInPluginSchema).mockResolvedValueOnce({ ...schema(), name: "OpenStudio Reverb" });
    await expect(capturePitchCorrectorPreset(address)).rejects.toThrow("removed or replaced");
    await expect(capturePitchCorrectorPreset({ ...address, instanceId: "removed-instance" })).rejects.toThrow("removed or replaced");
    const missingNote = { ...nativeValues };
    delete missingNote.noteEnable_11;
    vi.mocked(nativeBridge.getBuiltInPluginSchema).mockResolvedValueOnce(schema(missingNote));
    await expect(capturePitchCorrectorPreset(address)).rejects.toThrow("noteEnable_11");
    expect(nativeBridge.setBuiltInPluginState).not.toHaveBeenCalled();
  });

  it("reports rejected or failed native restores without falling back to unsafe scalar calls", async () => {
    const classicWrite = vi.spyOn(nativeBridge, "setPitchCorrectorParam");
    vi.mocked(nativeBridge.setBuiltInPluginState).mockResolvedValueOnce(false);
    await expect(applyPitchCorrectorPreset(address, params)).rejects.toThrow("could not restore");
    vi.mocked(nativeBridge.setBuiltInPluginState).mockRejectedValueOnce(new Error("instance removed"));
    await expect(applyPitchCorrectorPreset(address, params)).rejects.toThrow("instance removed");
    expect(classicWrite).not.toHaveBeenCalled();
  });

  it("saves a portable JSON preset with its processing mode without using project save", async () => {
    const projectSave = vi.spyOn(nativeBridge, "saveProjectToFile");
    await savePitchCorrectorPreset("C:\\Presets\\D custom.ospreset", params);
    const [path, json] = vi.mocked(nativeBridge.saveJsonDocumentToFile).mock.calls[0];
    expect(path).toBe("C:\\Presets\\D custom.ospreset");
    expect(parsePitchCorrectorPreset(JSON.parse(json))).toEqual(document());
    expect(projectSave).not.toHaveBeenCalled();
  });

  it("surfaces false and thrown preset-save failures", async () => {
    vi.mocked(nativeBridge.saveJsonDocumentToFile).mockResolvedValueOnce(false);
    await expect(savePitchCorrectorPreset("preset.ospreset", params)).rejects.toThrow("could not be saved");
    vi.mocked(nativeBridge.saveJsonDocumentToFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(savePitchCorrectorPreset("preset.ospreset", params)).rejects.toThrow("disk full");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { restoreMetronomeProjectSounds } from "../utils/metronomeProjectSounds";
import { parseValidatedProject } from "../utils/projectValidation";
import { METRONOME_SOUND_OPTIONS, isCustomMetronomeSound, metronomeSoundLabel } from "../utils/metronomeSounds";

vi.mock("../services/NativeBridge", () => ({ nativeBridge: {
  resetMetronomeSounds: vi.fn(), setMetronomeClickSound: vi.fn(), setMetronomeAccentSound: vi.fn(), getMetronomeSoundInfo: vi.fn(),
} }));

describe("metronome sound project recall", () => {
  beforeEach(() => {
    vi.mocked(nativeBridge.resetMetronomeSounds).mockReset().mockResolvedValue(true);
    vi.mocked(nativeBridge.setMetronomeClickSound).mockReset().mockResolvedValue(true);
    vi.mocked(nativeBridge.setMetronomeAccentSound).mockReset().mockResolvedValue(true);
    vi.mocked(nativeBridge.getMetronomeSoundInfo).mockReset().mockResolvedValue({ error: "" });
  });
  it("old projects use original sounds and clear the previous project's uploads", async () => {
    const project = parseValidatedProject(JSON.stringify({ tracks: [] }));
    expect(await restoreMetronomeProjectSounds(project)).toEqual({ metronomeClickPath: "", metronomeAccentPath: "", warnings: [] });
    expect(nativeBridge.resetMetronomeSounds).toHaveBeenCalledOnce();
    expect(nativeBridge.setMetronomeClickSound).not.toHaveBeenCalled();
  });
  it("recalls built-in selections through saved optional fields", async () => {
    const document = { tracks: [], metronomeClickPath: "builtin:woodblock", metronomeAccentPath: "builtin:cowbell" };
    const parsed = parseValidatedProject(JSON.stringify(document));
    expect(await restoreMetronomeProjectSounds(parsed)).toEqual({ metronomeClickPath: document.metronomeClickPath, metronomeAccentPath: document.metronomeAccentPath, warnings: [] });
  });
  it("keeps the native prepared-copy path instead of the original source", async () => {
    vi.mocked(nativeBridge.getMetronomeSoundInfo).mockResolvedValue({ selection: "C:/cache/prepared.wav", error: "" });
    expect((await restoreMetronomeProjectSounds({ metronomeClickPath: "C:/Downloads/click.wav" })).metronomeClickPath).toBe("C:/cache/prepared.wav");
  });
  it("reports a missing upload while retaining the independently restored accent", async () => {
    vi.mocked(nativeBridge.setMetronomeClickSound).mockResolvedValue(false);
    vi.mocked(nativeBridge.getMetronomeSoundInfo).mockResolvedValueOnce({ error: "Audio file is missing" }).mockResolvedValueOnce({ error: "" });
    const result = await restoreMetronomeProjectSounds({ metronomeClickPath: "missing.wav", metronomeAccentPath: "builtin:mechanical" });
    expect(result.metronomeClickPath).toBe("");
    expect(result.metronomeAccentPath).toBe("builtin:mechanical");
    expect(result.warnings[0]).toContain("missing");
  });
  it("reports bridge failures without claiming that a custom sound was loaded", async () => {
    vi.mocked(nativeBridge.setMetronomeAccentSound).mockRejectedValue(new Error("decode failed"));
    const result = await restoreMetronomeProjectSounds({ metronomeAccentPath: "broken.wav" });
    expect(result.metronomeAccentPath).toBe("");
    expect(result.warnings).toHaveLength(1);
  });
  it.each([{}, [], 32, "x".repeat(32769)])("rejects malformed persisted selections: %j", value => {
    expect(() => parseValidatedProject(JSON.stringify({ tracks: [], metronomeClickPath: value }))).toThrow();
  });
  it("offers four built-ins and distinguishes an uploaded sample", () => {
    expect(METRONOME_SOUND_OPTIONS).toHaveLength(4);
    expect(isCustomMetronomeSound("")).toBe(false);
    expect(metronomeSoundLabel("builtin:woodblock")).toBe("Woodblock");
    expect(isCustomMetronomeSound("C:/click.wav")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { displayedDrumNotes, drumPadFromSchema } from "../components/builtin/instrumentDrumPads";

const schema = (mapping: BuiltInPluginSchema["drumMapping"]): BuiltInPluginSchema => ({
  name: "OpenStudio Drums", pluginId: "drums", schemaVersion: 1, category: "Instrument", chain: "instrument", fxIndex: 0,
  parameters: [], drumMapping: mapping,
});
const row = { inputNote: 36, voiceNote: 38, piece: 1, articulation: "Snare", closesHat: false, aftertouchChoke: false };

describe("effective drum pad identity", () => {
  it("keeps incoming input36 distinct from the remapped Snare voice", () => {
    expect(drumPadFromSchema(schema([row]), 36)).toMatchObject({ inputNote: 36, voiceNote: 38, piece: 1, label: "Snare", ignored: false });
  });
  it("uses native articulation labels without inferring from the incoming note", () => {
    expect(drumPadFromSchema(schema([{ ...row, voiceNote: 53, piece: 7, articulation: "Ride bell" }]), 36)).toMatchObject({ label: "Ride bell", piece: 7, voiceNote: 53 });
  });
  it("names the native piece when the legacy articulation label contains no instrument identity", () => {
    expect(drumPadFromSchema(schema([{ ...row, articulation: "Legacy synthesized voice" }]), 36)).toMatchObject({ label: "Snare", piece: 1, voiceNote: 38 });
  });
  it("never assigns an ignored key to Kick", () => {
    expect(drumPadFromSchema(schema([{ ...row, voiceNote: -1, piece: -1, ignored: true }]), 36)).toMatchObject({ label: "Ignored", piece: null, voiceNote: null, ignored: true });
    expect(drumPadFromSchema(schema([{ ...row, ignored: true }]), 36).piece).toBeNull();
  });
  it("restores the native mapping after an ignored snapshot and distinguishes unavailable", () => {
    const ignored = schema([{ ...row, ignored: true }]);
    expect(drumPadFromSchema(ignored, 36).ignored).toBe(true);
    expect(drumPadFromSchema(schema([row]), 36).piece).toBe(1);
    expect(drumPadFromSchema(schema(undefined), 36)).toMatchObject({ available: false, ignored: false, piece: null });
    expect(new Set(displayedDrumNotes).size).toBe(16);
  });
});

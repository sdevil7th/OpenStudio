import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BuiltInParamDescriptor, BuiltInPluginSchema } from "../services/NativeBridge";
import type { ApprovedEffectEditorProps } from "../components/builtin/ApprovedEffectEditor";
import { SuiteEditor } from "../components/builtin/SuiteEditor";
import { CompressorEditor } from "../components/builtin/CompressorEditor";
import { PreampEditor } from "../components/builtin/PreampEditor";
import { GateEditor } from "../components/builtin/GateEditor";
import { changedEffectSettings } from "../components/builtin/EffectDetailIndicator";

function parameter(id: string, value = 0, role = "controls", type: BuiltInParamDescriptor["type"] = "continuous"): BuiltInParamDescriptor {
  return { id, label: id, type, value, defaultValue: 0, min: 0, max: 1, automatable: true, graphRole: role,
    ...(type === "enum" ? { enumOptions: [{ value: 0, label: "Legacy" }, { value: 1, label: "Original stages" }] } : {}) };
}
function props(pluginId: string, parameters: BuiltInParamDescriptor[]): ApprovedEffectEditorProps {
  const schema: BuiltInPluginSchema = { schemaVersion: 1, pluginId, name: "OpenStudio " + pluginId, category: "Effect", chain: "track", fxIndex: 0, parameters };
  return { schema, address: { chain: "track", trackId: "track", fxIndex: 0 }, canUndo: false, canRedo: false,
    onChange: () => {}, onGestureStart: () => {}, onGestureEnd: () => {}, onUndo: () => {}, onRedo: () => {},
    onApplyValues: async () => true, onApplyState: async () => true, onRecallPreset: async () => true, onFlush: async () => true };
}
describe("approved effect conditional controls", () => {
  it("does not mark nonzero defaults as changed or cancel opposite individual edits", () => {
    const schema = props("delay", [{ ...parameter("wowDepthMs", .4), defaultValue: .4 }, { ...parameter("crossFeed", .25), defaultValue: .25 }]).schema;
    expect(changedEffectSettings(schema, ["wowDepthMs", "crossFeed"])).toBe("");
    schema.parameters[0].value += .1; schema.parameters[1].value -= .1;
    const changed = changedEffectSettings(schema, ["wowDepthMs", "crossFeed"]);
    expect(changed).toContain("wowDepthMs"); expect(changed).toContain("crossFeed");
  });
  it("summarizes native appended choices once and omits unavailable fields", () => {
    const schema = props("limiter", [parameter("limitingStyle", 0, "style", "enum"), parameter("limitingStyleAll", 1, "style", "enum")]).schema;
    expect(changedEffectSettings(schema, ["limitingStyle", "limitingStyleAll", "missing"])).toBe("limitingStyleAll: Original stages");
  });
  it("keeps legacy Pitch parameters and new native modes without creating a graphical editor", () => {
    const parameters = [parameter("scale", 15, "scale", "enum"), parameter("humanizeMode", 1, "correction", "enum"),
      parameter("retuneSpeed", 50, "correction"), parameter("detectionSource", 0, "detection", "enum"),
      ...Array.from({ length: 12 }, (_, i) => parameter(`noteEnable_${i}`, 1, "notes", "toggle"))];
    const html = renderToStaticMarkup(<SuiteEditor {...props("pitch", parameters)} />);
    for (const p of parameters) expect(html).toContain(`data-param="${p.id}"`);
    expect(html).toContain("existing pitch editor");
    expect(html).not.toContain("<canvas"); expect(html).not.toContain("<svg class=\"suite-envelope");
    const automatic = renderToStaticMarkup(<SuiteEditor {...props("pitch", parameters.map(p => p.id === "scale" ? { ...p, value: 0 } : p))} />);
    expect(automatic).not.toContain('data-param="noteEnable_');
  });
  it("shows compressor headroom only for an active original colour model", () => {
    const parameters = [parameter("model", 1, "model", "enum"), { ...parameter("audioCharacter", 1, "character", "enum"), automatable: false }, parameter("headroom")];
    const clean = renderToStaticMarkup(<CompressorEditor {...props("compressor", parameters)} />);
    expect(clean).toContain('data-param="audioCharacter"'); expect(clean).not.toContain('data-param="headroom"');
    const coloured = renderToStaticMarkup(<CompressorEditor {...props("compressor", parameters.map(p => p.id === "model" ? { ...p, value: 2 } : p))} />);
    expect(coloured).toContain('data-param="headroom"');
  });
  it("keeps optional preamp stages out of old schemas and hides inactive legacy drive", () => {
    const parameters = [parameter("audioCharacter", 0, "character", "enum"), parameter("headroom"), parameter("outputDrive")];
    const legacy = renderToStaticMarkup(<PreampEditor {...props("preamp", parameters)} />);
    expect(legacy).not.toContain('data-param="headroom"'); expect(legacy).not.toContain('data-param="outputDrive"');
    const current = renderToStaticMarkup(<PreampEditor {...props("preamp", parameters.map(p => p.id === "audioCharacter" ? { ...p, value: 1 } : p))} />);
    expect(current).toContain('data-param="headroom"'); expect(current).toContain('data-param="outputDrive"');
    expect(renderToStaticMarkup(<PreampEditor {...props("preamp", [])} />)).not.toContain("Audio stages");
  });
  it("does not expose the gate-only onset response in downward expansion", () => {
    const parameters = [parameter("expansionMode", 1, "dynamics", "enum"), parameter("transientResponse", 1, "detection", "enum"), parameter("expansionRatio"), parameter("expansionKnee")];
    const html = renderToStaticMarkup(<GateEditor {...props("gate", parameters)} />);
    expect(html).not.toContain('data-param="transientResponse"'); expect(html).toContain('data-param="expansionRatio"'); expect(html).toContain('data-param="expansionKnee"');
  });
});

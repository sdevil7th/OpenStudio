import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInParamDescriptor, BuiltInPluginSchema } from "../services/NativeBridge";
import type { ApprovedEffectEditorProps } from "../components/builtin/ApprovedEffectEditor";
import type { PluginFeatureRevealRequest } from "../utils/pluginFeatureNavigation";
import { pluginSearchFeatures } from "../components/builtin/PluginFeatureFinder";
import { GateEditor } from "../components/builtin/GateEditor";
import { CompressorEditor } from "../components/builtin/CompressorEditor";
import { LimiterEditor } from "../components/builtin/LimiterEditor";

const navigation = vi.hoisted(() => ({ request: null as PluginFeatureRevealRequest | null }));
// SSR cannot dispatch browser events. Deliver one navigation request to the
// editor's real reveal callback so its normally collapsed detail page renders.
// Browser focus, scrolling and disclosure geometry remain browser-test duties.
vi.mock("../utils/pluginFeatureNavigation", async importOriginal => {
  const original = await importOriginal<typeof import("../utils/pluginFeatureNavigation")>();
  return {
    ...original,
    usePluginFeatureReveal: (...args: Parameters<typeof original.usePluginFeatureReveal>) => {
      original.usePluginFeatureReveal(...args);
      const [, pluginId, reveal] = args;
      if (navigation.request?.pluginId === pluginId) {
        const request = navigation.request;
        navigation.request = null;
        reveal(request);
      }
    },
  };
});

function parameter(id: string, value = 0, type: BuiltInParamDescriptor["type"] = "continuous",
  graphRole = "controls"): BuiltInParamDescriptor {
  return { id, label: id, value, defaultValue: 0, min: 0, max: 100, type, graphRole, automatable: true,
    ...(type === "enum" ? { enumOptions: [{ value: 0, label: "Classic" }, { value: 1, label: "Transparent" }, { value: 6, label: "Edge" }] } : {}) };
}

function editorProps(pluginId: string, parameters: BuiltInParamDescriptor[]): ApprovedEffectEditorProps {
  const schema: BuiltInPluginSchema = { schemaVersion: 1, pluginId, name: `OpenStudio ${pluginId}`,
    category: "Effect", chain: "track", fxIndex: 0, parameters };
  return { schema, address: { trackId: "track", chain: "track", fxIndex: 0 }, canUndo: false, canRedo: false,
    onChange: vi.fn(), onGestureStart: vi.fn(), onGestureEnd: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(),
    onApplyValues: vi.fn(async () => true), onApplyState: vi.fn(async () => true),
    onRecallPreset: vi.fn(async () => true), onFlush: vi.fn(async () => true) };
}

function tagWithLabel(html: string, tag: string, label: string): string {
  const element = html.match(new RegExp(`<${tag}\\b[^>]*>`, "g"))?.find(candidate => candidate.includes(`aria-label="${label}"`));
  expect(element, `${tag} named ${label}`).toBeDefined();
  return element ?? "";
}

function expectRetained(props: ApprovedEffectEditorProps, before: string) {
  expect(JSON.stringify(props.schema)).toBe(before);
  expect(props.onChange).not.toHaveBeenCalled();
  expect(props.onApplyValues).not.toHaveBeenCalled();
  expect(props.onApplyState).not.toHaveBeenCalled();
}

beforeEach(() => { navigation.request = null; });

describe("free-suite feature discovery", () => {
  it("excludes retained banks, bypass, signal compatibility and superseded controls", () => {
    const props = editorProps("limiter", [parameter("threshold"), parameter("limitingStyle", 0, "enum"),
      parameter("limitingStyleAll", 1, "enum"), parameter("savedStyle.threshold", 12, "continuous", "stateBank"),
      parameter("bypass", 0, "toggle"), parameter("signalPath", 1, "enum")]);
    const before = JSON.stringify(props.schema);
    const features = pluginSearchFeatures(props.schema);
    expect(features.map(feature => feature.parameterId)).toEqual(["threshold", "limitingStyleAll"]);
    expectRetained(props, before);
  });

  it("keeps enum choice names searchable and legacy-only schemas usable", () => {
    const schema = editorProps("limiter", [parameter("limitingStyle", 0, "enum")]).schema;
    const features = pluginSearchFeatures(schema);
    expect(features).toHaveLength(1);
    expect(features[0].parameterId).toBe("limitingStyle");
    for (const query of ["Classic", "Transparent", "Edge"])
      expect(`${features[0].label} ${features[0].detail}`.toLowerCase()).toContain(query.toLowerCase());
  });

  it("collapses every generation of expanded Reverb selectors", () => {
    const schema = editorProps("reverb", ["algorithm", "reverbType", "reverbTypeExpanded", "reverbTypeExtended", "reverbTypeAll"]
      .map(id => parameter(id, 0, "enum"))).schema;
    expect(pluginSearchFeatures(schema).filter(feature => feature.parameterId).map(feature => feature.parameterId)).toEqual(["reverbTypeAll"]);
  });

  it("collapses intermediate Synth destination aliases when the full range exists", () => {
    const schema = editorProps("synth", ["matrix1Target", "matrix1TargetExpanded", "matrix1TargetFull"]
      .map(id => parameter(id, 0, "enum"))).schema;
    expect(pluginSearchFeatures(schema).filter(feature => feature.parameterId).map(feature => feature.parameterId)).toEqual(["matrix1TargetFull"]);
  });

  it("exposes alignment workflows under the native utility plugin id", () => {
    const features = pluginSearchFeatures(editorProps("utility", []).schema);
    expect(features.map(feature => [feature.id, feature.workflowId])).toEqual([
      ["workflow:alignment", "alignment"], ["workflow:spectral", "spectral"],
    ]);
    expect(features.every(feature => feature.parameterId === undefined)).toBe(true);
  });
});

describe("inactive dynamics controls retain their settings", () => {
  it("disables Gate-only Hold and Hysteresis in Expander while retaining active timing", () => {
    const parameters = [parameter("expansionMode", 1, "enum"), parameter("hysteresis", 8), parameter("holdMs", 57),
      parameter("attackMs", 3), parameter("releaseMs", 119), parameter("transientResponse", 1, "enum")];
    const props = editorProps("gate", parameters), before = JSON.stringify(props.schema);
    const html = renderToStaticMarkup(<GateEditor {...props} />);
    expect(tagWithLabel(html, "input", "Hold value")).toContain('disabled=""');
    expect(tagWithLabel(html, "input", "Hold value")).toContain('value="57"');
    expect(tagWithLabel(html, "input", "Hysteresis value")).toContain('disabled=""');
    expect(tagWithLabel(html, "div", "Hysteresis")).toContain('aria-disabled="true"');
    expect(tagWithLabel(html, "input", "Attack value")).not.toContain("disabled");
    expect(tagWithLabel(html, "input", "Release value")).not.toContain("disabled");
    expect(html).not.toContain('data-param="transientResponse"');
    expect(html).toContain("retained for Gate mode");
    expectRetained(props, before);
    const gate = renderToStaticMarkup(<GateEditor {...editorProps("gate", parameters.map(p => p.id === "expansionMode" ? { ...p, value: 0 } : p))} />);
    expect(tagWithLabel(gate, "input", "Hold value")).not.toContain("disabled");
    expect(tagWithLabel(gate, "input", "Hold value")).toContain('value="57"');
  });

  it("keeps Clean automatic release and makeup values visible but inactive", () => {
    const props = editorProps("compressor", [parameter("model", 1, "enum"), parameter("autoRelease", 1, "toggle"),
      parameter("autoMakeup", 1, "toggle"), parameter("release", 78), parameter("makeupGain", 7), parameter("attack", 9)]);
    const before = JSON.stringify(props.schema), html = renderToStaticMarkup(<CompressorEditor {...props} />);
    expect(tagWithLabel(html, "input", "Release · auto value")).toContain('disabled=""');
    expect(tagWithLabel(html, "input", "Release · auto value")).toContain('value="78"');
    expect(tagWithLabel(html, "input", "Makeup · auto value")).toContain('disabled=""');
    expect(tagWithLabel(html, "input", "Attack value")).not.toContain("disabled");
    expectRetained(props, before);
  });

  it("keeps FET Input and Output active with Ratio Off while hiding compression-only timing", () => {
    const props = editorProps("compressor", [parameter("model", 2, "enum"), parameter("fetEngine", 1, "enum"),
      parameter("fetRatioExtended", 5, "enum"), parameter("fetInput", 27), parameter("fetOutput", 31),
      parameter("fetAttack", 3), parameter("fetRelease", 5), parameter("fetRecovery", .4), parameter("fetTilt", .7)]);
    const before = JSON.stringify(props.schema), html = renderToStaticMarkup(<CompressorEditor {...props} />);
    expect(tagWithLabel(html, "input", "Input value")).not.toContain("disabled");
    expect(tagWithLabel(html, "input", "Output value")).not.toContain("disabled");
    for (const id of ["fetAttack", "fetRelease", "fetRecovery", "fetTilt"]) expect(html).not.toContain(`data-param="${id}"`);
    expect(html).toContain("Compression timing is inactive");
    expectRetained(props, before);
  });

  it.each([0, 1, 6])("exposes only the applicable Limiter timing controls for style %i", style => {
    const props = editorProps("limiter", [parameter("limitingStyleAll", style, "enum"), parameter("lookaheadMs", 4),
      parameter("slowAttackMs", 17), parameter("releaseMs", 82), parameter("automaticRelease", 1, "toggle"),
      parameter("transientLink", 64), parameter("releaseLink", 39)]);
    const before = JSON.stringify(props.schema);
    navigation.request = { pluginId: "limiter", parameterId: "slowAttackMs" };
    const html = renderToStaticMarkup(<LimiterEditor {...props} />);
    expect(tagWithLabel(html, "input", "Lookahead value")).not.toContain("disabled");
    expect(tagWithLabel(html, "input", "Release value")).not.toContain("disabled");
    const transient = tagWithLabel(html, "input", "Transient link value");
    expect(transient.includes('disabled=""')).toBe(style === 0);
    if (style === 6) {
      for (const id of ["slowAttackMs", "automaticRelease", "releaseLink"]) expect(html).not.toContain(`data-param="${id}"`);
      expect(html).toContain("do not apply");
    } else {
      expect(tagWithLabel(html, "input", "Attack value").includes('disabled=""')).toBe(style === 0);
      expect(tagWithLabel(html, "input", "Attack value")).toContain('value="17"');
      expect(tagWithLabel(html, "button", "Auto release").includes('disabled=""')).toBe(style === 0);
      expect(tagWithLabel(html, "input", "Release link value").includes('disabled=""')).toBe(style === 0);
    }
    expectRetained(props, before);
  });
});

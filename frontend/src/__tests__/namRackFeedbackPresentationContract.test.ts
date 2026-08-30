// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("NAM Rack feedback presentation contract", () => {
  it("consumes native embedded identity fields without changing the approved faceplate assets", () => {
    const bridge = readSource("../services/NativeBridge.ts");
    const panel = readSource("../components/NAMRackPanel.tsx");

    for (const field of [
      "pedalMetadataName",
      "pedalMetadataGearMake",
      "pedalMetadataGearModel",
      "ampMetadataName",
      "ampMetadataGearMake",
      "ampMetadataGearModel",
    ]) {
      expect(bridge).toContain(`${field}?: string`);
      expect(panel).toContain(`modelState?.${field}`);
    }
    expect(panel).toContain("resolveNAMModelIdentityWarning");
    expect(panel).toContain("effectiveRackDiagnosticMessage");
  });

  it("removes the duplicate Tape Echo surface while preserving post-FX Delay", () => {
    const panel = readSource("../components/NAMRackPanel.tsx");
    const designPort = readSource("../components/NAMRackDesignPort.tsx");
    const bridge = readSource("../services/NativeBridge.ts");

    expect(panel).not.toContain("tapeEchoEnabled");
    expect(designPort).not.toContain('name="tape-echo"');
    expect(bridge).not.toContain('param("tapeEchoEnabled"');
    expect(bridge).toContain('param("delayMode", "Delay Mode"');
    expect(designPort).toContain('paramId="delayMode"');
  });

  it("uses the existing compact stage-status lane for gain and Economy guidance", () => {
    const panel = readSource("../components/NAMRackPanel.tsx");
    const designPort = readSource("../components/NAMRackDesignPort.tsx");
    const feedback = readSource("../utils/namRackPresentationFeedback.ts");

    expect(panel).toContain("resolveNAMGainStagingWarning");
    expect(panel).toContain("resolveNAMEconomyQualityWarning");
    expect(feedback).toContain("Set Amp Quality to Full");
    expect(designPort).toContain('className="premium-stage-status"');
  });

  it("labels a retained external IR as bypassed while the embedded cab is active", () => {
    const panel = readSource("../components/NAMRackPanel.tsx");
    const designPort = readSource("../components/NAMRackDesignPort.tsx");

    expect(panel).toContain("Cab in Capture / External IR bypassed");
    expect(panel).toContain('"Retained IR bypassed"');
    expect(designPort).toContain("CAB INCLUDED / IR BYPASSED");
  });
});

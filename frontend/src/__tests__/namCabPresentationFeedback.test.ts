import { describe, expect, it } from "vitest";

import { resolveNAMRackCabPresentation } from "../components/NAMCabPresentation";

describe("NAM Rack cabinet presentation feedback", () => {
  it("makes a retained external IR's bypass state explicit for an embedded cab", () => {
    const presentation = resolveNAMRackCabPresentation({
      hasAmpCapture: true,
      hasCabIR: true,
      embeddedCabCapture: true,
    });

    expect(presentation.mode).toBe("embedded");
    expect(presentation.hasRetainedExternalIR).toBe(true);
    expect(presentation.status).toContain("retained external IR is bypassed");
    expect(presentation.canBrowseExternalIR).toBe(true);
    expect(presentation.canLoadLocalIR).toBe(true);
    expect(presentation.canClearExternalIR).toBe(true);
  });

  it("explains that the external stage is bypassed even when no IR is retained", () => {
    const presentation = resolveNAMRackCabPresentation({
      hasAmpCapture: true,
      hasCabIR: false,
      embeddedCabCapture: true,
    });

    expect(presentation.status).toContain("prepare an external IR");
    expect(presentation.canBrowseExternalIR).toBe(true);
    expect(presentation.canLoadLocalIR).toBe(true);
    expect(presentation.canClearExternalIR).toBe(false);
  });
});

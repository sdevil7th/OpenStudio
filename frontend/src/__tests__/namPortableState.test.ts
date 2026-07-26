import { describe, expect, it } from "vitest";
import { omitNAMNonPortableState } from "../utils/namPortableState";

describe("portable NAM Rack state", () => {
  it("recursively omits interface and momentary runtime state", () => {
    const state = {
      calibrationReferenceDbu: -10,
      auditionSource: 1,
      laserTrigger: 1,
      inputTrimDb: 2,
      uiState: {
        compare: {
          calibrationReferenceDbu: 4,
          auditionSource: 1,
          laserTrigger: 1,
          ampMix: 0.75,
        },
      },
    };

    const json = JSON.stringify(state, omitNAMNonPortableState);
    expect(json).not.toContain("calibrationReferenceDbu");
    expect(json).not.toContain("auditionSource");
    expect(json).not.toContain("laserTrigger");
    expect(JSON.parse(json)).toEqual({ inputTrimDb: 2, uiState: { compare: { ampMix: 0.75 } } });
  });

  it("also strips those keys while importing a bundle", () => {
    const imported = JSON.parse(
      '{"state":{"auditionSource":1,"laserTrigger":1,"calibrationReferenceDbu":-18,"outputTrimDb":-1}}',
      omitNAMNonPortableState,
    );
    expect(imported).toEqual({ state: { outputTrimDb: -1 } });
  });
});

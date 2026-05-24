import { describe, expect, it } from "vitest";
import modalSource from "../components/AIClipGenerationModal.tsx?raw";

describe("AI clip generation modal", () => {
  it("requires direction prompts for Stable Audio source workflows", () => {
    expect(modalSource).toContain("stableSourcePromptMissing");
    expect(modalSource).toContain("Stable Audio source workflows need a direction prompt.");
    expect(modalSource).toContain("disabled={!sourceClip || (isModelReady && (inpaintSelectionMissing || stableSourcePromptMissing))}");
  });
});

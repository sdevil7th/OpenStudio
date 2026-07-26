// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const explorerSource = readFileSync(
  new URL("../components/NAMExplorer.tsx", import.meta.url),
  "utf8",
);
const useFlowStart = explorerSource.indexOf("const useSourceFlowSelection = async");
const useFlowEnd = explorerSource.indexOf("const applySourceFlowDesignTab", useFlowStart);
const useFlowSource = explorerSource.slice(useFlowStart, useFlowEnd);
const auditionPublishStart = explorerSource.indexOf("const loadRecordForAudition = async");
const auditionPublishEnd = explorerSource.indexOf("const loadRecordIntoCabIR = async", auditionPublishStart);
const auditionPublishSource = explorerSource.slice(auditionPublishStart, auditionPublishEnd);
const sourceFlowTargetsStart = explorerSource.indexOf("const sourceFlowTargetCards =");
const sourceFlowTargetsEnd = explorerSource.indexOf("const sourceCategoryLabel =", sourceFlowTargetsStart);
const sourceFlowTargetsSource = explorerSource.slice(sourceFlowTargetsStart, sourceFlowTargetsEnd);

describe("NAM remote capture Use flow", () => {
  it("has no demo-riff preview action or behavior", () => {
    expect(explorerSource).not.toContain("demo-audition");
    expect(explorerSource).not.toContain("Preview with Demo");
    expect(explorerSource).not.toContain("clean demo riff");
    expect(explorerSource).toContain('label: selectedSourceAuditionActive ? "Stop Audition" : "Audition"');
  });

  it("publishes the complete download, preparation, and activation lifecycle", () => {
    expect(useFlowSource).toContain('publishUseProgress("downloading"');
    expect(useFlowSource).toContain('publishUseProgress("preparing"');
    expect(useFlowSource).toContain('publishUseProgress("activating"');
    expect(useFlowSource).toContain('phase: "success"');
    expect(useFlowSource).toContain('phase: "error"');
  });

  it("does not leave the library until the exact committed capture is loaded and finalized", () => {
    expect(useFlowSource).toContain("applyDirectLoadPolicy: true");
    expect(useFlowSource).toContain("ampDeclaredCaptureType: declaredCaptureType");
    expect(useFlowSource).toContain("pedalDeclaredCaptureType: declaredCaptureType");
    expect(useFlowSource).toContain("cabRequestedEnabled: requestedCabEnabled");
    expect(useFlowSource).toContain("ampEnabled: 1, ampMix: activatedAmpMix");
    expect(useFlowSource).toContain("expectedCabRequestedEnabled: requestedCabEnabled");
    expect(useFlowSource).toContain("waitForNAMCaptureActivation");
    expect(useFlowSource).toContain("requirePreviewCleared: true");
    expect(useFlowSource).toContain("inspectNAMCaptureSchemaActivation");
    expect(useFlowSource).toContain("refreshedSchema = await Promise.resolve(onRefreshRack())");
    expect(useFlowSource).toContain("if (!refreshedSchemaInspection.verified)");
    expect(useFlowSource.indexOf("if (!finalReadback.verified)")).toBeGreaterThan(-1);
    expect(useFlowSource.lastIndexOf("onReturn?.()")).toBeGreaterThan(
      useFlowSource.indexOf("if (!refreshedSchemaInspection.verified)"),
    );
  });

  it("pins the destination slot before download so online and installed metadata cannot redirect Use", () => {
    expect(useFlowSource).toContain("const targetSlot: NAMTargetSlot = forcedTarget");
    expect(useFlowSource).not.toContain("targetSlot = forcedTarget ?? preferredTargetForInstalled");
  });

  it("keeps the selected catalog topology ahead of stale installed-manifest labels", () => {
    const selectedTypeStart = useFlowSource.indexOf(
      "const selectedDeclaredCaptureType = firstDeclaredCaptureType(",
    );
    const selectedTypeEnd = useFlowSource.indexOf(");", selectedTypeStart);
    const selectedTypeSource = useFlowSource.slice(selectedTypeStart, selectedTypeEnd);
    expect(selectedTypeSource.indexOf("selected.catalogRow")).toBeGreaterThan(-1);
    expect(selectedTypeSource.indexOf("selected.installedRecord")).toBeGreaterThan(
      selectedTypeSource.indexOf("selected.catalogRow"),
    );

    const finalTypeStart = useFlowSource.indexOf(
      "const declaredCaptureType = firstDeclaredCaptureType(",
    );
    const finalTypeEnd = useFlowSource.indexOf(");", finalTypeStart);
    const finalTypeSource = useFlowSource.slice(finalTypeStart, finalTypeEnd);
    expect(finalTypeSource.indexOf("selectedDeclaredCaptureType")).toBeGreaterThan(-1);
    expect(finalTypeSource.indexOf("captureTypeForInstalled(durableRecord)")).toBeGreaterThan(
      finalTypeSource.indexOf("selectedDeclaredCaptureType"),
    );

    expect(explorerSource).toContain(
      "const requestedCaptureType = firstDeclaredCaptureType(\n"
      + "      declaredCaptureType,\n"
      + "      captureTypeForInstalled(record),",
    );
    expect(explorerSource).toContain("catalogCaptureType,\n        );");
  });

  it("verifies preview Cab effectiveness from native topology rather than catalog labels", () => {
    expect(explorerSource).toContain("ampDeclaredCaptureType: requestedCaptureType");
    expect(explorerSource).toContain("pedalDeclaredCaptureType: requestedCaptureType");
    expect(explorerSource).toContain("authoritativeAmpIncludesCab");
    expect(explorerSource).toContain("expectedNAMEffectiveCabEnabled(");
    expect(explorerSource).toContain("effectiveCabMismatch");
    expect(explorerSource).toContain("verifiedModelState.ampIncludesCab === true");
  });

  it("keeps preview reconciliation locked until the parent accepts the new rack schema", () => {
    const updateIndex = auditionPublishSource.lastIndexOf("updateAudition(recoverableAudition)");
    const refreshIndex = auditionPublishSource.indexOf(
      "await Promise.resolve(onRefreshRack())",
      updateIndex,
    );
    const successIndex = auditionPublishSource.indexOf("return true;", refreshIndex);

    expect(updateIndex).toBeGreaterThan(-1);
    expect(refreshIndex).toBeGreaterThan(updateIndex);
    expect(successIndex).toBeGreaterThan(refreshIndex);
  });

  it("keeps the newly selected capture visible throughout Use activation", () => {
    expect(sourceFlowTargetsSource).toContain(
      "selectedRailTitle\n              || (captureUseInFlight ? captureUseProgress.message",
    );
    expect(sourceFlowTargetsSource).not.toContain("The current amp remains active until verification.");
    expect(explorerSource).toContain(
      'Keeping the selected ${sourceFlow === "ir" ? "IR" : "capture"} visible while native activation is verified.',
    );
    expect(explorerSource).not.toContain('activeSourceSlotTitle || "Current rack component"');
  });
});

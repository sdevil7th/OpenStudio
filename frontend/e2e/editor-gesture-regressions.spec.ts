import { expect, test } from "@playwright/test";
import { runNamOctaverFuzzChecks } from "./support/namOctaverFuzzChecks";
import { runRulerChecks } from "./support/rulerChecks";
import { runTimelineCopyChecks } from "./support/timelineCopyChecks";

test("the visible App ruler preserves zoom, selection, handle and cancellation contracts", async ({ page }) => {
  const result = await runRulerChecks(page);
  expect(result.surface).toBe("real App .workspace-sticky-ruler");
  expect(result.checks).toHaveLength(9);
});

test("selected audio and MIDI clips copy together with matching previews and atomic history", async ({ page }) => {
  test.setTimeout(90_000);
  const result = await runTimelineCopyChecks(page);
  expect(result.status).toBe("pass");
  expect(result.checks.length).toBeGreaterThan(0);
});

test("Octaver Fuzz fits four viewport widths and retains independent stage state", async ({ page }) => {
  test.setTimeout(90_000);
  const result = await runNamOctaverFuzzChecks(page);
  expect(result.checks).toHaveLength(7);
});

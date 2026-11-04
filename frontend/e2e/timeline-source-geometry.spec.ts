import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("long completed clips preserve source coordinates and trim freezes on release", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({ schemaVersion: 1,
      keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/?platform=windows&windowChrome=native");
  const source = readFileSync(resolve(testInfo.config.rootDir, "../../tools/timeline-source-geometry-browser-regression.js"), "utf8");
  const run = new Function(`return (${source}\n);`)() as (page: import("@playwright/test").Page) => Promise<{ status: string; checks: string[] }>;
  const result = await run(page);
  await testInfo.attach("source-geometry-report", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.status).toBe("pass");
  expect(result.checks).toHaveLength(5);
});

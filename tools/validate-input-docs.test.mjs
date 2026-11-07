import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateInputDocs } from "./validate-input-docs.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const websiteRoot = path.resolve(appRoot, "../openstudio-website");
const manual = path.join(appRoot, "docs/USER_MANUAL.md");
const source = fs.readFileSync(manual, "utf8");
const withManual = value => validateInputDocs({ overrides: new Map([[manual, value]]) });

test("current app-only contracts pass without assuming a sibling checkout", () => {
  const report = validateInputDocs();
  assert.equal(report.pass, true, report.errors.join("\n"));
  assert.equal(report.website, "not_requested");
  assert.equal(report.facts["clip.joinSelectedMidi"].scope, "timeline");
});
test("current explicitly selected six website guides pass", { skip: !fs.existsSync(websiteRoot) }, () => {
  const report = validateInputDocs({ websiteRoot });
  assert.equal(report.pass, true, report.errors.join("\n"));
  assert.equal(report.checked.length, 8);
});
test("a stale Ctrl+R-only Record row fails even when other Record prose is correct", () => {
  const report = withManual(`${source}\n| Record / Finish Recording | \`Ctrl+R\` |\n`);
  assert.equal(report.pass, false);
  assert.ok(report.errors.some(error => error.includes("transport.record") && error.includes("lacks source primary R")));
});
test("Join and Crossfade rows track catalog keys rather than a prose snapshot", () => {
  for (const row of ["| Join Selected MIDI Clips | `Ctrl+G` |", "| Crossfade Selected Audio Clips | `Shift+Y` |"])
    assert.equal(withManual(`${source}\n${row}\n`).pass, false);
});
test("dedicated tables reject an extra stale alias even when the correct key is also listed", () => {
  const report = withManual(`${source}\n| Record / Finish Recording | \`R\`, \`Ctrl+R\`, \`Ctrl+Alt+R\` |\n`);
  assert.ok(report.errors.some(error => error.includes("undocumented source alias ctrl+alt+r")));
});
test("F1 cannot advertise the separate shortcut/profile window", () => {
  const report = withManual(`${source}\n| Keyboard, Mouse & Trackpad | \`F1\` |\n`);
  assert.ok(report.errors.some(error => error.includes("F1 incorrectly advertised")));
});
test("a changed catalog shortcut requires matching docs", () => {
  const file = path.join(appRoot, "frontend/src/store/actionRegistry.ts");
  const changed = fs.readFileSync(file, "utf8").replace(/(id: "clip.joinSelectedMidi"[^\n]*shortcut: )"Ctrl\+J"/, '$1"Ctrl+K"');
  const report = validateInputDocs({ overrides: new Map([[file, changed]]) });
  assert.equal(report.facts["clip.joinSelectedMidi"].key, "Ctrl+K");
  assert.ok(report.errors.some(error => error.includes("clip.joinSelectedMidi") && error.includes("Ctrl+K")));
});
test("an OpenStudio profile override cannot silently replace its documented primary", () => {
  const file = path.join(appRoot, "frontend/src/utils/shortcutProfiles.ts");
  const changed = fs.readFileSync(file, "utf8").replace('"file.importAudio": keys("Ctrl+I"),', '"transport.record": keys("Ctrl+R"), "file.importAudio": keys("Ctrl+I"),');
  const report = validateInputDocs({ overrides: new Map([[file, changed]]) });
  assert.ok(report.errors.some(error => error.includes("OpenStudio profile no longer inherits")));
});
test("website development provenance and stale arm tooltips fail closed", { skip: !fs.existsSync(websiteRoot) }, () => {
  const file = path.join(websiteRoot, "src/features/docs/content/audio-setup.ts");
  const changed = fs.readFileSync(file, "utf8").replace('channel: "development"', 'channel: "release"');
  const header = path.join(websiteRoot, "src/features/daw-preview/TrackHeaderLite.tsx");
  const report = validateInputDocs({ websiteRoot, overrides: new Map([[file, changed], [header, 'export const Header = () => <button title="Record Arm (R)" />;']]) });
  assert.ok(report.errors.some(error => error.includes("development appReference")));
  assert.ok(report.errors.some(error => error.includes("stale Record Arm (R)")));
});

// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pickerSource = readFileSync(
  new URL("../components/NAMToneCapturePicker.tsx", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");
const pickerCSS = readFileSync(
  new URL("../components/NAMToneCapturePicker.css", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");

describe("NAM tone capture picker accessibility", () => {
  it("uses a labelled group of native buttons rather than composite listbox roles", () => {
    expect(pickerSource).toContain('role="group"');
    expect(pickerSource).toContain("aria-label={`Available NAM captures in ${title}`}");
    expect(pickerSource).toContain("aria-pressed={selected}");
    expect(pickerSource).not.toContain('role="listbox"');
    expect(pickerSource).not.toContain('role="option"');
    expect(pickerSource).not.toContain("aria-selected={selected}");
  });

  it("keeps picker copy legible and supplies practical keyboard/action targets", () => {
    expect(pickerCSS).toMatch(/\.nam-tone-capture-select\s*\{[^}]*min-height:\s*42px;/s);
    expect(pickerCSS).toMatch(/\.nam-tone-capture-name\s*\{[^}]*font-size:\s*12px;/s);
    expect(pickerCSS).toMatch(/\.nam-tone-capture-badges i\s*\{[^}]*font-size:\s*10px;/s);
    expect(pickerCSS).toMatch(/\.nam-tone-capture-actions button\s*\{[^}]*min-height:\s*36px;/s);
    expect(pickerCSS).toMatch(/\.nam-tone-capture-actions button\s*\{[^}]*font-size:\s*11px;/s);
    expect(pickerCSS).toContain(".nam-tone-capture-select:focus-visible");
    expect(pickerCSS).toContain("outline: 2px solid #f5ae27");
  });
});

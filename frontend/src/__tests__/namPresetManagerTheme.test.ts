// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../components/NAMPresetManagerModal.css", import.meta.url),
  "utf8",
);
const source = readFileSync(
  new URL("../components/NAMPresetManagerModal.tsx", import.meta.url),
  "utf8",
);

function relativeLuminance(hex: string): number {
  const channels = hex.replace("#", "").match(/.{2}/g)?.map((pair) => parseInt(pair, 16) / 255) ?? [];
  const linear = channels.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * (linear[0] ?? 0))
    + (0.7152 * (linear[1] ?? 0))
    + (0.0722 * (linear[2] ?? 0));
}

function contrastRatio(left: string, right: string): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (Math.max(leftLuminance, rightLuminance) + 0.05)
    / (Math.min(leftLuminance, rightLuminance) + 0.05);
}

describe("NAM preset manager theme", () => {
  it("uses the NAM Rack charcoal and warm amber palette without legacy blue accents", () => {
    expect(source).toContain('import "./NAMPresetManagerModal.css"');
    expect(css).toContain("--nam-preset-bg: #090a0c");
    expect(css).toContain("--nam-preset-accent: #e0a149");
    expect(css).toContain("--nam-preset-accent-hot: #ffc36c");
    expect(css).toContain("rgba(224, 161, 73, 0.14)");

    for (const legacyBlue of [
      "#55a8ed",
      "#6db8f5",
      "#56a9ee",
      "#91d1ff",
      "#348bd1",
      "#236ba6",
      "#4099df",
      "#2878b9",
      "rgba(62, 123, 178",
      "rgba(59, 137, 208",
      "rgba(53, 119, 178",
    ]) {
      expect(css.toLowerCase()).not.toContain(legacyBlue);
    }
  });

  it("applies the warm accent to selection, focus, status, tags, and primary actions", () => {
    expect(css).toContain('.nam-preset-library-row[data-selected="true"]');
    expect(css).toContain("box-shadow: inset 2px 0 0 var(--nam-preset-accent)");
    expect(css).toContain(".nam-preset-library-search:focus-within");
    expect(css).toContain("outline: 2px solid var(--nam-preset-accent-hot)");
    expect(css).toContain(".nam-preset-library-status");
    expect(css).toContain(".nam-preset-library-tags span");
    expect(css).toContain("background: linear-gradient(180deg, #efb45e, #c98231)");
    expect(source).toContain("data-selected={selected}");
    expect(source).toContain("data-active={entry.active}");
  });

  it("keeps representative normal text pairs above WCAG AA contrast", () => {
    expect(contrastRatio("#171006", "#c98231")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffc36c", "#18191b")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#928c83", "#171719")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#dec28f", "#111214")).toBeGreaterThanOrEqual(4.5);
  });
});

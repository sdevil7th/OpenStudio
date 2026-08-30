import { describe, expect, it } from "vitest";

const sourceFiles = import.meta.glob(
  ["../**/*.css", "../**/*.ts", "../**/*.tsx", "!../__tests__/**"],
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

describe("frontend style architecture", () => {
  it("does not use forced cascade declarations", () => {
    const forbiddenToken = "!" + "important";
    const offenders = Object.entries(sourceFiles)
      .filter(([, source]) => source.includes(forbiddenToken))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("keeps stylesheets out of TypeScript template strings and JSX style tags", () => {
    const stylesheetConstant = /const\s+[A-Z][A-Z0-9_]*(?:CSS|STYLES?)\s*=\s*`/;
    const offenders = Object.entries(sourceFiles).flatMap(([path, source]) => {
      if (!path.endsWith(".tsx") && !path.endsWith(".ts")) return [];
      return /<style(?:\s|>)/.test(source) || stylesheetConstant.test(source)
        ? [path]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});

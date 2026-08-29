import { describe, expect, it } from "vitest";

const componentTypeScriptSources = import.meta.glob("../components/*.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const componentSources = componentTypeScriptSources;

const entrySources = import.meta.glob("../PluginEditorWindowApp.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const componentStyles = import.meta.glob("../components/*.css", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const componentSource = (fileName: string) =>
  componentSources[`../components/${fileName}`] ?? "";

const componentStyle = (fileName: string) =>
  componentStyles[`../components/${fileName}`] ?? "";

const componentOwners = [
  "NAMRackChainModule",
  "NAMRackControlTooltip",
  "NAMRackDiagnostics",
  "NAMRackKnob",
  "NAMRackMixer",
] as const;

const featureStyles = [
  "NAMRackBrowser",
  "NAMRackPresets",
  "NAMRackPedalboard",
  "NAMRackSourceFlow",
  "NAMRackNeural",
  "NAMRackCalibration",
] as const;

describe("NAM Rack stylesheet ownership", () => {
  it("keeps the parent stylesheet owned by NAMRackPanel instead of global entry points", () => {
    expect(componentSource("NAMRackPanel.tsx")).toContain(
      'import "./NAMRackPanel.css";',
    );
    expect(entrySources["../PluginEditorWindowApp.tsx"] ?? "").not.toContain(
      "NAMRackPanel.css",
    );
    expect(componentSource("FXChainPanel.tsx")).not.toContain(
      "NAMRackPanel.css",
    );
  });

  it.each(componentOwners)("%s imports its own non-empty stylesheet", (owner) => {
    expect(componentSource(`${owner}.tsx`)).toContain(
      `import "./${owner}.css";`,
    );
  });

  it.each(featureStyles)(
    "%s remains an explicit parent-owned feature stylesheet",
    (feature) => {
      expect(componentSource("NAMRackPanel.tsx")).toContain(
        `import "./${feature}.css";`,
      );
    },
  );

  it("keeps Design Port style ownership explicit", () => {
    const source = componentSource("NAMRackDesignPort.tsx");
    for (const stylesheet of [
      "NAMRackDesignPort.css",
      "NAMRackStage.css",
      "NAMRackHardware.css",
      "NAMRackDesignPortSourceFlow.css",
      "NAMRackFooter.css",
      "NAMRackHeader.css",
    ]) {
      expect(source).toContain(`import "./${stylesheet}";`);
    }
  });

  it("does not reserve a scrollbar gutter around the detached NAM editor", () => {
    expect(componentStyle("FXChainPanel.css")).not.toMatch(
      /\.plugin-editor-window-app \.builtin-plugin-panel\[data-kind="nam"\]\s*\{[^}]*scrollbar-gutter:\s*stable/,
    );
    expect(componentStyle("NAMRackStage.css")).not.toMatch(
      /\.nam-rack-design-port\s*\{[^}]*scrollbar-gutter:\s*stable/,
    );
  });
});

import { describe, expect, it } from "vitest";
import renderModalSource from "../components/RenderModal.tsx?raw";
import mainComponentSource from "../../../Source/MainComponent.cpp?raw";

describe("render result reporting regression guards", () => {
  it("does not impose the generic 15-second bridge timeout on offline renders", () => {
    const declaration = mainComponentSource.match(/const NO_TIMEOUT_FUNCTIONS = \[([^\]]+)\]/)?.[1] ?? "";
    for (const name of ["scanForPlugins", "renderProject", "renderProjectWithDither"]) {
      expect(declaration).toContain(`'${name}'`);
    }
  });

  it("checks native boolean results and distinguishes later-stage failures", () => {
    expect(renderModalSource).toContain("if (!success)");
    expect(renderModalSource).toContain("Audio engine rejected the ${params.source} render");
    expect(renderModalSource).toContain(
      "Primary render completed, but the secondary ${secondaryOutputFormat.toUpperCase()} output failed",
    );
    expect(renderModalSource).toContain("output file${renderedFiles.length === 1 ? \" was\" : \"s were\"} rendered successfully");
  });
});

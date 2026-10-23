import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { BuiltInPluginSchema } from "../../src/services/NativeBridge";

export const nativeFreeSuiteSchemaPath = process.env.OPENSTUDIO_FREE_SUITE_SCHEMAS || fileURLToPath(new URL("../../../output/review/free-suite-ui/editor-schemas.json", import.meta.url));
// Ordinary frontend-only runs can omit native fixtures. An explicit path is a
// qualification request: a missing or invalid export must fail, never skip.
export const nativeFreeSuiteSchemasUnavailable = !process.env.OPENSTUDIO_FREE_SUITE_SCHEMAS && !existsSync(nativeFreeSuiteSchemaPath);

export function loadNativeFreeSuiteSchemas(path = nativeFreeSuiteSchemaPath): BuiltInPluginSchema[] {
  const result = JSON.parse(readFileSync(path, "utf8")) as { checks?: { schemas?: BuiltInPluginSchema[] }[] };
  const schemas = result.checks?.find(check => Array.isArray(check.schemas))?.schemas;
  if (!schemas?.length) throw new Error(`No native editor schemas in ${path}`);
  return schemas;
}

type HarnessState = {
  schemas: BuiltInPluginSchema[];
  schema: BuiltInPluginSchema;
  writes: { id: string; value: number }[];
  gestures: { id: string; begin: boolean }[];
  audition: { note: number; on: boolean }[];
  mount: (pluginId: string, values?: Record<string, number>) => void;
  update: (values: Record<string, number>) => void;
  dispose: () => void;
};
declare global { interface Window { freeSuiteQA: HarnessState } }

/** Real production editor + native-exported schema; the bridge records calls, not audio. */
export async function installFreeSuiteHarness(page: Page, schemas: BuiltInPluginSchema[]) {
  await page.goto("/");
  await page.getByRole("menubar", { name: "Main menu" }).waitFor();
  await page.locator("#openstudio-boot-overlay").waitFor({ state: "hidden" });
  await page.evaluate(async schemas => {
    const load = <T,>(path: string): Promise<T> => import(/* @vite-ignore */ path);
    const { default: React } = await load<{ default: typeof import("react") }>("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await load<{ default: typeof import("react-dom/client") }>("/node_modules/.vite/deps/react-dom_client.js");
    const { BuiltInPluginPanel } = await load<typeof import("../../src/components/BuiltInPluginPanel")>("/src/components/BuiltInPluginPanel.tsx");
    const { nativeBridge: bridge } = await load<typeof import("../../src/services/NativeBridge")>("/src/services/NativeBridge.ts");
    const { useDAWStore: store, createDefaultTrack } = await load<typeof import("../../src/store/useDAWStore")>("/src/store/useDAWStore.ts");
    store.getState().markInputProfileOnboardingSeen();
    store.setState({ tracks: [createDefaultTrack("suite-qa", "Suite QA", "#4488cc", "audio")], showGettingStarted: false });
    let root: ReturnType<typeof createRoot> | undefined;
    let host: HTMLDivElement | undefined;
    const render = () => root?.render(React.createElement(BuiltInPluginPanel, {
      address: { chain: "track", trackId: "suite-qa", fxIndex: 0 }, fallbackName: state.schema.name,
      initialSchema: state.schema, chrome: "detached", onClose: () => {},
    }));
    const state: HarnessState = window.freeSuiteQA = {
      schemas, schema: structuredClone(schemas[0]), writes: [], gestures: [], audition: [],
      dispose() { root?.unmount(); host?.remove(); root = undefined; host = undefined; },
      update(values) {
        // Deliver a new native snapshot without remounting the focused/captured controls.
        state.schema = structuredClone(state.schema);
        for (const parameter of state.schema.parameters) if (values[parameter.id] !== undefined) parameter.value = values[parameter.id];
        render();
      },
      mount(pluginId, values = {}) {
        state.dispose();
        const schema = schemas.find(item => item.pluginId === pluginId);
        if (!schema) throw new Error(`Missing native schema: ${pluginId}`);
        state.schema = structuredClone({ ...schema, chain: "track", fxIndex: 0 });
        for (const parameter of state.schema.parameters) if (values[parameter.id] !== undefined) parameter.value = values[parameter.id];
        state.writes = []; state.gestures = []; state.audition = [];
        host = document.createElement("div"); host.dataset.qaEditor = "true";
        host.className = "plugin-editor-window-app fixed inset-0 z-[9999] flex flex-col overflow-hidden bg-daw-dark";
        document.body.append(host); root = createRoot(host);
        render();
      },
    };
    bridge.getBuiltInPluginSchema = async () => structuredClone(state.schema);
    bridge.getBuiltInPluginMeters = async () => state.schema.visualization ?? null;
    bridge.getBuiltInPluginState = async () => ({ name: state.schema.name, values: Object.fromEntries(state.schema.parameters.map(p => [p.id, p.value])) });
    bridge.setBuiltInPluginState = async (_address, snapshot: unknown) => {
      const parsed = (typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot) as { values?: Record<string, number>; factoryDefault?: boolean; hostBypassed?: boolean };
      for (const parameter of state.schema.parameters) {
        if (parsed.factoryDefault) parameter.value = parameter.defaultValue;
        else if (typeof parsed.values?.[parameter.id] === "number") parameter.value = parsed.values[parameter.id];
      }
      if (typeof parsed.hostBypassed === "boolean") state.schema.hostBypassed = parsed.hostBypassed;
      return true;
    };
    bridge.setBuiltInPluginParam = async (_address, id, value) => {
      const parameter = state.schema.parameters.find(p => p.id === id);
      if (!parameter) return false;
      parameter.value = value; state.writes.push({ id, value }); return true;
    };
    bridge.builtInPluginGesture = async (_address, id, begin) => { state.gestures.push({ id, begin }); return true; };
    bridge.sendBuiltInPreview = async (_address, _session, note, on) => { state.audition.push({ note, on }); return true; };
  }, schemas);
}

export async function mountFreeSuiteEditor(page: Page, pluginId: string, values?: Record<string, number>) {
  await page.evaluate(({ pluginId, values }) => window.freeSuiteQA.mount(pluginId, values), { pluginId, values });
  const editor = page.locator("[data-qa-editor]");
  await editor.locator(".builtin-plugin-panel").waitFor();
  await page.waitForFunction(() => document.querySelector("[data-qa-editor] .builtin-plugin-panel")?.getAttribute("aria-busy") !== "true");
  // Include the initial ResizeObserver delivery and its React layout update.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return editor;
}

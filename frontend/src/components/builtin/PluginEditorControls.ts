// Shared Tailwind styles for native HTML controls. Keep the eq-* hooks for
// processor artwork; importing a control never loads another editor's scene.
const controlFocus = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#58b6ff]";
const buttonLayout = "inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border px-[9px] py-1 text-xs cursor-pointer disabled:cursor-default disabled:opacity-40";

export const editorButton = `eq-button ${buttonLayout} ${controlFocus} border-daw-border-light bg-daw-lighter text-daw-text aria-pressed:border-daw-accent aria-pressed:bg-[color-mix(in_srgb,var(--color-daw-accent)_20%,var(--color-daw-panel))] aria-pressed:text-[#b3dfff] enabled:hover:bg-daw-lighter`;
export const editorTab = `eq-tab ${buttonLayout} ${controlFocus} border-transparent bg-transparent text-daw-text aria-selected:border-daw-accent aria-selected:bg-[color-mix(in_srgb,var(--color-daw-accent)_20%,var(--color-daw-panel))] aria-selected:text-[#b3dfff]`;
export const editorSelect = `eq-select ${controlFocus} min-h-8 min-w-0 max-w-full rounded-md border border-daw-border-light bg-daw-lighter px-2 py-1 text-xs text-daw-text`;

import { nativeBridge } from "../services/NativeBridge";

// Paint feedback before sending work that may occupy the native message thread.
export const paintPluginActivity = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

export async function waitForPluginEditor(
  target: Parameters<typeof nativeBridge.getPluginEditorReadiness>[0],
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state = await Promise.race([
      nativeBridge.getPluginEditorReadiness(target),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
    if (state === "ready") return;
    if (state === "failed") throw new Error("The plugin editor failed to start.");
    if (state === "timeout") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The plugin editor has not appeared yet. It may still be starting; check its window before trying again.");
}

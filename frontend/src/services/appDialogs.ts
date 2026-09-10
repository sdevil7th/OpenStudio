import { getProjectEpoch } from "../utils/projectLifetime";

export interface AppDialogRequest {
  id: number;
  kind: "alert" | "confirm" | "prompt" | "about";
  message: string;
  initialValue: string;
  epoch: number;
  complete: (value: string | null) => void;
}
let nextId = 0;
let queue: AppDialogRequest[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export const subscribeAppDialogs = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getAppDialog = () => queue[0] ?? null;
export function finishAppDialog(id: number, value: string | null) {
  const current = queue[0];
  if (!current || current.id !== id) return;
  queue = queue.slice(1);
  current.complete(current.epoch === getProjectEpoch() ? value : null);
  notify();
}
function show(kind: AppDialogRequest["kind"], message: string, initialValue = ""): Promise<string | null> {
  return new Promise(resolve => {
    queue = [...queue, { id: ++nextId, kind, message, initialValue, epoch: getProjectEpoch(), complete: resolve }];
    notify();
  });
}
export const appDialogs = {
  prompt: (message: string, value = "") => show("prompt", message, value),
  confirm: async (message: string) => (await show("confirm", message)) !== null,
  alert: async (message: string) => { await show("alert", message); },
  about: async (version: string) => { await show("about", version); },
};

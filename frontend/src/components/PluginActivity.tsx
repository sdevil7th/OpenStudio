import { LoaderCircle } from "lucide-react";

export function PluginActivity({ message }: { message: string }) {
  return <div role="status" aria-live="polite" className="flex min-w-0 items-center gap-2 rounded border border-daw-accent/30 bg-daw-accent/10 px-3 py-2 text-xs text-daw-text">
    <LoaderCircle size={16} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
    <span className="min-w-0 break-words">{message}</span>
  </div>;
}

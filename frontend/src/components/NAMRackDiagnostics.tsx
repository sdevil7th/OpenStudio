import { Cable, Gauge, Library } from "lucide-react";

export type NAMRackDiagnosticTone = "error" | "warning" | "success" | "info" | "idle";

export type NAMRackDiagnosticsAction = {
  id: string;
  label: string;
  title: string;
  icon?: "routing" | "buffer" | "cab";
  onClick: () => void;
};

export type NAMRackDiagnosticsState = {
  tone: NAMRackDiagnosticTone;
  selectedInputLabel: string;
  levelLine: string;
  bufferLine?: string;
  message: string;
  authReady: boolean;
  authLabel: string;
  actions: NAMRackDiagnosticsAction[];
};

function DiagnosticActionIcon({ icon }: { icon?: NAMRackDiagnosticsAction["icon"] }) {
  if (icon === "routing") return <Cable size={12} />;
  if (icon === "buffer") return <Gauge size={12} />;
  if (icon === "cab") return <Library size={12} />;
  return null;
}

export function NAMRackDiagnostics({ state }: { state: NAMRackDiagnosticsState }) {
  return (
    <section className="nam-rack-input-diagnostics" data-tone={state.tone} aria-label="NAM Rack input diagnostics">
      <div className="nam-rack-input-summary">
        <span>Live Input</span>
        <strong>{state.selectedInputLabel}</strong>
        <small>{state.levelLine}</small>
        {state.bufferLine && <small>{state.bufferLine}</small>}
      </div>
      <div className="nam-rack-input-copy">
        <span>{state.message}</span>
      </div>
      <div className="nam-rack-input-actions">
        {state.actions.map((action) => (
          <button key={action.id} type="button" onClick={action.onClick} title={action.title}>
            <DiagnosticActionIcon icon={action.icon} />
            {action.label}
          </button>
        ))}
      </div>
      <span className="nam-rack-auth-pill" data-ready={state.authReady}>
        {state.authLabel}
      </span>
    </section>
  );
}

import "./NAMToneCapturePicker.css";
import { CheckCircle2, Download, Play, RefreshCw, RotateCcw } from "lucide-react";
import type { NAMCaptureType } from "../utils/namCaptureType";

export type NAMToneCapturePickerItem = {
  id: string;
  name: string;
  architecture: string;
  captureType: NAMCaptureType;
  includesCab: boolean;
  installed?: boolean;
  missing?: boolean;
  active?: boolean;
  auditioning?: boolean;
  busy?: boolean;
  disabled?: boolean;
};

export type NAMToneCapturePickerProps = {
  title: string;
  items: NAMToneCapturePickerItem[];
  selectedId?: string;
  busy?: boolean;
  error?: string;
  showUse?: boolean;
  compact?: boolean;
  onSelect: (id: string) => void;
  onAudition: (id: string) => void;
  onUse?: (id: string) => void;
};

function captureTopologyLabel(item: NAMToneCapturePickerItem): string {
  if (item.includesCab) return "CAB EMBEDDED";
  if (item.captureType === "pedal") return "PEDAL";
  if (item.captureType === "preamp") return "PREAMP";
  if (item.captureType === "studio") return "STUDIO";
  return "RAW / AMP ONLY";
}

export function NAMToneCapturePicker({
  title,
  items,
  selectedId = "",
  busy = false,
  error = "",
  showUse = false,
  compact = false,
  onSelect,
  onAudition,
  onUse,
}: NAMToneCapturePickerProps) {
  return (
    <section
      className="nam-tone-capture-picker"
      data-qa="nam-tone-capture-picker"
      data-compact={compact || undefined}
      aria-label={`Captures in ${title}`}
      aria-busy={busy || undefined}
    >
      <header>
        <div>
          <span>Captures in this pack</span>
          <strong title={title}>{title}</strong>
        </div>
        <em>{busy ? "Loading..." : `${items.length} capture${items.length === 1 ? "" : "s"}`}</em>
      </header>

      {error && <p className="nam-tone-capture-error" role="alert">{error}</p>}
      {!busy && items.length === 0 ? (
        <div className="nam-tone-capture-empty" role="status">
          Choose this pack to load its available captures.
        </div>
      ) : (
        <div
          className="nam-tone-capture-list"
          role="group"
          aria-label={`Available NAM captures in ${title}`}
        >
          {items.map((item) => {
            const selected = item.id === selectedId;
            const disabled = busy || item.busy || item.disabled;
            return (
              <article
                key={item.id}
                data-selected={selected || undefined}
                data-active={item.active || undefined}
                data-audition={item.auditioning || undefined}
                data-capture-id={item.id}
              >
                <button
                  type="button"
                  className="nam-tone-capture-select"
                  aria-pressed={selected}
                  onClick={() => onSelect(item.id)}
                  disabled={disabled}
                >
                  <span className="nam-tone-capture-name" title={item.name}>{item.name}</span>
                  <span className="nam-tone-capture-badges">
                    <i>{captureTopologyLabel(item)}</i>
                    <i>{item.architecture}</i>
                    {item.active ? <i data-state="active">ACTIVE</i>
                      : item.auditioning ? <i data-state="preview">AUDITIONING</i>
                        : item.missing ? <i data-state="missing">MISSING</i>
                          : item.installed ? <i data-state="installed">INSTALLED</i> : null}
                  </span>
                </button>
                <div className="nam-tone-capture-actions">
                  <button
                    type="button"
                    onClick={() => onAudition(item.id)}
                    disabled={disabled || item.missing}
                    aria-label={`${item.auditioning ? "Stop auditioning" : "Audition"} ${item.name}`}
                    title={item.auditioning ? "Stop audition" : "Audition with live input"}
                  >
                    {item.busy ? <RefreshCw size={14} /> : item.auditioning ? <RotateCcw size={14} /> : <Play size={14} />}
                    {item.auditioning ? "Stop" : "Audition"}
                  </button>
                  {showUse && onUse && (
                    <button
                      type="button"
                      data-primary="true"
                      onClick={() => onUse(item.id)}
                      disabled={disabled || item.missing || item.active}
                      aria-label={`${item.active ? "Using" : "Use"} ${item.name}`}
                    >
                      {item.installed ? <CheckCircle2 size={14} /> : <Download size={14} />}
                      {item.active ? "Using" : "Use"}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

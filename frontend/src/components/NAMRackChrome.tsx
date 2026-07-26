import { type CSSProperties, useState } from "react";
import { AlertTriangle, AudioLines, ChevronDown, Gauge, Lock, Maximize2, Package, SlidersHorizontal } from "lucide-react";

export type RackRightRailTab = "gear" | "tones" | "cab" | "saved" | "tuner";

export type NAMRackModeRailStatus = {
  cpu?: {
    label: string;
    alert: boolean;
    meterPct?: number;
  };
  dsp: {
    label: string;
    title: string;
    alert: boolean;
    meterPct?: number;
  };
  sampleRateLabel: string;
  bufferLabel: string;
  latencyLabel: string;
};

function statusMeterStyle(value: number | undefined): CSSProperties | undefined {
  return value === undefined ? undefined : ({ "--nam-status-pct": `${value}%` } as CSSProperties);
}

export function NAMRackStageFooter({
  diagnosticTone,
  tempo,
  timeSignature,
  stageLocked,
  stageZoomPercent,
  onToggleLock,
  onCycleZoom,
  onSetZoomPercent,
}: {
  diagnosticTone: "error" | "warning" | "success" | "info" | "idle";
  tempo: number;
  timeSignature?: {
    numerator: number;
    denominator: number;
  };
  stageLocked: boolean;
  stageZoomPercent: number;
  onToggleLock: () => void;
  onCycleZoom: () => void;
  onSetZoomPercent?: (zoomPercent: number) => void;
}) {
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const diagnosticTitle = diagnosticTone === "error"
    ? "Rack needs attention"
    : diagnosticTone === "warning"
      ? "Rack warning"
      : "Rack ready";
  const sizeOptions = [
    { label: "Compact", detail: "More room", value: 80 },
    { label: "Small", detail: "Reduced", value: 100 },
    { label: "Fit", detail: "Fit stage", value: 140 },
    { label: "Large", detail: "Closer", value: 180 },
    { label: "Maximum", detail: "Closest", value: 220 },
  ];
  const nearestSize = sizeOptions.reduce((nearest, option) => (
    Math.abs(option.value - stageZoomPercent) < Math.abs(nearest.value - stageZoomPercent) ? option : nearest
  ), sizeOptions[0]);

  return (
    <div className="nam-stage-footer" data-qa="nam-stage-footer" aria-label="NAM Rack stage utility controls">
      <div className="nam-stage-footer-left" data-qa="nam-stage-footer-left">
        <span className="nam-stage-footer-brand">NAM Rack</span>
        <span className="nam-stage-status-indicator" title={diagnosticTitle}>
          <AlertTriangle size={14} />
        </span>
        <span>Tuner</span>
        <span>MIDI</span>
        <span>Tap</span>
        <span>{Number.isFinite(tempo) ? tempo.toFixed(1) : "--"} BPM</span>
        <span>Metronome</span>
        <span>Settings</span>
        <span>{timeSignature ? `${timeSignature.numerator}/${timeSignature.denominator}` : "--"}</span>
      </div>
      <div className="nam-stage-footer-right" data-qa="nam-stage-footer-right">
        <button
          type="button"
          data-qa="nam-footer-lock"
          data-active={stageLocked}
          onClick={onToggleLock}
          title={stageLocked ? "Unlock rack module movement" : "Lock rack module movement"}
        >
          <Lock size={13} />
        </button>
        <button
          type="button"
          data-qa="nam-footer-zoom"
          className="nam-stage-zoom-button"
          onClick={onCycleZoom}
          title="Cycle rack stage size"
        >
          {nearestSize.label}
        </button>
        <div className="nam-stage-size-menu" data-open={sizeMenuOpen}>
          <span>Size</span>
          <button
            type="button"
            data-qa="nam-footer-size"
            aria-haspopup="listbox"
            aria-expanded={sizeMenuOpen}
            onClick={() => setSizeMenuOpen((open) => !open)}
            title="Select rack display size"
          >
            {nearestSize.label}
            <ChevronDown size={13} />
          </button>
          {sizeMenuOpen && (
            <div className="nam-stage-size-popover" role="listbox" aria-label="Rack display size">
              {sizeOptions.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="option"
                  aria-selected={option.label === nearestSize.label}
                  data-active={option.label === nearestSize.label}
                  onClick={() => {
                    onSetZoomPercent?.(option.value);
                    setSizeMenuOpen(false);
                  }}
                >
                  {option.label}
                  <span>{option.detail}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          data-qa="nam-footer-fullscreen"
          title="Maximum rack view"
          onClick={() => {
            onSetZoomPercent?.(220);
            setSizeMenuOpen(false);
          }}
        >
          <Maximize2 size={13} />
        </button>
      </div>
    </div>
  );
}

export function NAMRackModeRail({
  rackRailTab,
  slotBrowserOpen,
  status,
  onShowGear,
  onToggleChain,
  onOpenMixer,
  onOpenTuner,
}: {
  rackRailTab: RackRightRailTab;
  slotBrowserOpen: boolean;
  status: NAMRackModeRailStatus;
  onShowGear: () => void;
  onToggleChain: () => void;
  onOpenMixer: () => void;
  onOpenTuner: () => void;
}) {
  const gearActive = ["gear", "tones", "cab", "saved"].includes(rackRailTab);

  return (
    <aside className="nam-rack-mode-rail" aria-label="NAM Rack modes and system status">
      <div className="nam-mode-rail-nav" data-qa="nam-mode-rail-nav">
        <button
          type="button"
          data-qa="nam-mode-gear"
          data-active={gearActive}
          aria-pressed={gearActive}
          onClick={onShowGear}
          title="Gear explorer"
        >
          <Package size={18} />
          <span>Gear</span>
        </button>
        <button type="button" data-qa="nam-mode-chain" data-active={slotBrowserOpen} aria-pressed={slotBrowserOpen} onClick={onToggleChain} title="Chain editor">
          <AudioLines size={18} />
          <span>Chain</span>
        </button>
        <button type="button" data-qa="nam-mode-mixer" data-active={false} aria-pressed={false} onClick={onOpenMixer} title="Focused controls for the current device">
          <SlidersHorizontal size={18} />
          <span>Controls</span>
        </button>
        <button type="button" data-qa="nam-mode-tuner" data-active={rackRailTab === "tuner"} aria-pressed={rackRailTab === "tuner"} onClick={onOpenTuner} title="Tuner">
          <Gauge size={18} />
          <span>Tuner</span>
        </button>
      </div>
      <div className="nam-mode-rail-status" data-qa="nam-mode-rail-status">
        {status.cpu && (
          <article
            data-status="CPU"
            data-alert={status.cpu.alert}
            data-meter={status.cpu.meterPct !== undefined || undefined}
            style={statusMeterStyle(status.cpu.meterPct)}
          >
            <span>CPU</span>
            <strong>{status.cpu.label}</strong>
          </article>
        )}
        <article
          data-status="DSP"
          data-alert={status.dsp.alert}
          data-meter={status.dsp.meterPct !== undefined || undefined}
          style={statusMeterStyle(status.dsp.meterPct)}
          title={status.dsp.title}
        >
          <span>DSP</span>
          <strong>{status.dsp.label}</strong>
        </article>
        <article data-status="SR">
          <span>SR</span>
          <strong>{status.sampleRateLabel}</strong>
        </article>
        <article data-status="Buffer">
          <span>Buffer</span>
          <strong>{status.bufferLabel}</strong>
        </article>
        <article data-status="Latency">
          <span>Latency</span>
          <strong>{status.latencyLabel}</strong>
        </article>
      </div>
    </aside>
  );
}

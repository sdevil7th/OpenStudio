import { type CSSProperties } from "react";

export type NAMRailTunerState = {
  signalPresent: boolean;
  pitchLocked: boolean;
  noteLabel: string;
  statusLabel: string;
  centsPct: number;
  frequencyLabel: string;
  inputLevelLabel: string;
  confidenceLabel: string;
  routeLabel: string;
  meterPct: number;
};

export function NAMRackTuner({ tuner }: { tuner: NAMRailTunerState }) {
  return (
    <div
      className="nam-rail-section nam-rail-tuner"
      data-signal={tuner.signalPresent}
      data-lock={tuner.pitchLocked}
    >
      <span>Tuner</span>
      <div className="nam-tuner-display" aria-label="NAM Rack tuner">
        <strong>{tuner.noteLabel}</strong>
        <small>{tuner.statusLabel}</small>
      </div>
      <div
        className="nam-tuner-cents"
        style={{ "--nam-tuner-cents-pct": `${tuner.centsPct}%` } as CSSProperties}
        aria-hidden="true"
      >
        <i />
        <span>-50</span>
        <span>0</span>
        <span>+50</span>
      </div>
      <article>
        <span>Pitch</span>
        <strong>{tuner.frequencyLabel}</strong>
      </article>
      <article>
        <span>Input</span>
        <strong>{tuner.inputLevelLabel}</strong>
      </article>
      <article>
        <span>Lock</span>
        <strong>{tuner.confidenceLabel}</strong>
      </article>
      <article>
        <span>Route</span>
        <strong>{tuner.routeLabel}</strong>
      </article>
      <div className="nam-tuner-meter" style={{ "--nam-tuner-meter-pct": `${tuner.meterPct}%` } as CSSProperties} aria-hidden="true" />
    </div>
  );
}

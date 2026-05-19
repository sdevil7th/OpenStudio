type PianoRollInfoLineValue = string | number;

interface PianoRollInfoLineProps {
  readonly typeLabel: PianoRollInfoLineValue;
  readonly startLabel: PianoRollInfoLineValue;
  readonly lengthLabel: PianoRollInfoLineValue;
  readonly valueLabel: PianoRollInfoLineValue;
  readonly channelLabel: PianoRollInfoLineValue;
  readonly chanceLabel: PianoRollInfoLineValue;
  readonly laneLabel: PianoRollInfoLineValue;
  readonly curveLabel: PianoRollInfoLineValue;
}

export function PianoRollInfoLine({
  typeLabel,
  startLabel,
  lengthLabel,
  valueLabel,
  channelLabel,
  chanceLabel,
  laneLabel,
  curveLabel,
}: PianoRollInfoLineProps) {
  const fields = [
    ["Type", typeLabel],
    ["Start", startLabel],
    ["Length", lengthLabel],
    ["Value", valueLabel],
    ["Channel", channelLabel],
    ["Chance", chanceLabel],
    ["Lane", laneLabel],
    ["Curve", curveLabel],
  ] as const;

  return (
    <div className="piano-roll-info-line" aria-label="MIDI editor info line">
      {fields.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

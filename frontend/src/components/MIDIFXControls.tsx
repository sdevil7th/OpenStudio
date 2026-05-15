import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MIDITrackEffect, Track, useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";
import { guardModalContextMenu } from "../utils/modalEventGuards";

interface MIDIFXControlsProps {
  readonly track: Track;
}

type MIDIFXDialogState =
  | { type: "pitch"; semitones: string; error: string | null }
  | { type: "velocity"; percent: string; offset: string; error: string | null }
  | { type: "time"; swingPercent: string; offsetMs: string; error: string | null };

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function effectFor(effects: MIDITrackEffect[], type: MIDITrackEffect["type"]) {
  return effects.find((effect) => effect.type === type);
}

function replaceEffect(effects: MIDITrackEffect[], next: MIDITrackEffect) {
  const exists = effects.some((effect) => effect.type === next.type);
  return exists
    ? effects.map((effect) => (effect.type === next.type ? next : effect))
    : [...effects, next];
}

export function MIDIFXControls({ track }: MIDIFXControlsProps) {
  const [dialog, setDialog] = useState<MIDIFXDialogState | null>(null);
  const { setTrackMIDIEffects } = useDAWStore(
    useShallow((state) => ({
      setTrackMIDIEffects: state.setTrackMIDIEffects,
    })),
  );
  const effects = useMemo(() => track.midiEffects || [], [track.midiEffects]);
  const arp = effectFor(effects, "arpeggiator");
  const pitch = effectFor(effects, "pitch");
  const velocity = effectFor(effects, "velocity");
  const time = effectFor(effects, "time");

  const commitEffect = (effect: MIDITrackEffect) => {
    setTrackMIDIEffects(track.id, replaceEffect(effects, effect));
  };

  const toggleArp = () => {
    commitEffect({
      id: arp?.id || "midi-fx-arpeggiator",
      type: "arpeggiator",
      enabled: !(arp?.enabled ?? false),
      rateSeconds: arp?.rateSeconds ?? 0.125,
      gate: arp?.gate ?? 0.85,
      mode: arp?.mode ?? "up",
      octaves: arp?.octaves ?? 1,
    });
  };

  const editPitch = () => {
    setDialog({
      type: "pitch",
      semitones: String(pitch?.semitones ?? 0),
      error: null,
    });
  };

  const editVelocity = () => {
    setDialog({
      type: "velocity",
      percent: String(Math.round((velocity?.scale ?? 1) * 100)),
      offset: String(velocity?.offset ?? 0),
      error: null,
    });
  };

  const editTime = () => {
    setDialog({
      type: "time",
      swingPercent: String(Math.round((time?.swing ?? 0) * 100)),
      offsetMs: String(time?.offsetMs ?? 0),
      error: null,
    });
  };

  const updateDialog = (patch: Partial<MIDIFXDialogState>) => {
    setDialog((current) => current ? ({ ...current, ...patch, error: null } as MIDIFXDialogState) : current);
  };

  const submitDialog = () => {
    if (!dialog) return;
    if (dialog.type === "pitch") {
      const semitones = Number(dialog.semitones);
      if (!Number.isFinite(semitones)) {
        setDialog({ ...dialog, error: "Enter a valid semitone value." });
        return;
      }
      const clampedSemitones = clampNumber(semitones, -48, 48);
      commitEffect({
        id: pitch?.id || "midi-fx-pitch",
        type: "pitch",
        enabled: clampedSemitones !== 0,
        semitones: clampedSemitones,
      });
      setDialog(null);
      return;
    }

    if (dialog.type === "velocity") {
      const percent = Number(dialog.percent);
      const offset = Number(dialog.offset);
      if (!Number.isFinite(percent) || !Number.isFinite(offset)) {
        setDialog({ ...dialog, error: "Enter valid velocity values." });
        return;
      }
      const clampedPercent = clampNumber(percent, 1, 400);
      const clampedOffset = clampNumber(offset, -127, 127);
      commitEffect({
        id: velocity?.id || "midi-fx-velocity",
        type: "velocity",
        enabled: clampedPercent !== 100 || clampedOffset !== 0,
        scale: clampedPercent / 100,
        offset: clampedOffset,
      });
      setDialog(null);
      return;
    }

    const swingPercent = Number(dialog.swingPercent);
    const offsetMs = Number(dialog.offsetMs);
    if (!Number.isFinite(swingPercent) || !Number.isFinite(offsetMs)) {
      setDialog({ ...dialog, error: "Enter valid timing values." });
      return;
    }
    const clampedSwing = clampNumber(swingPercent, -100, 100);
    const clampedOffsetMs = clampNumber(offsetMs, -1000, 1000);
    commitEffect({
      id: time?.id || "midi-fx-time",
      type: "time",
      enabled: clampedSwing !== 0 || clampedOffsetMs !== 0,
      swing: clampedSwing / 100,
      offsetMs: clampedOffsetMs,
      gridSeconds: time?.gridSeconds ?? 0.25,
    });
    setDialog(null);
  };

  const clearEffects = () => {
    if (effects.length > 0) setTrackMIDIEffects(track.id, []);
  };

  return (
    <>
      <div className="flex items-center gap-0.5 shrink-0" data-no-drag="true" data-no-select="true">
        <Button variant={arp?.enabled ? "primary" : "default"} size="icon-sm" onClick={toggleArp} title="Toggle MIDI arpeggiator" className="text-[8px] px-1">
          Arp
        </Button>
        <Button variant={pitch?.enabled ? "primary" : "default"} size="icon-sm" onClick={editPitch} title={`MIDI pitch shift: ${pitch?.semitones ?? 0} st`} className="text-[8px] px-1">
          Pit
        </Button>
        <Button variant={velocity?.enabled ? "primary" : "default"} size="icon-sm" onClick={editVelocity} title="MIDI velocity processor" className="text-[8px] px-1">
          Vel
        </Button>
        <Button variant={time?.enabled ? "primary" : "default"} size="icon-sm" onClick={editTime} title="MIDI time/groove processor" className="text-[8px] px-1">
          Tim
        </Button>
        {effects.length > 0 && (
          <Button variant="ghost" size="icon-sm" onClick={clearEffects} title="Clear MIDI FX" className="text-[8px] px-1">
            Off
          </Button>
        )}
      </div>
      {dialog && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45"
          data-modal-root="true"
          role="dialog"
          aria-modal="true"
          aria-labelledby="midi-fx-dialog-title"
          onContextMenu={guardModalContextMenu}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDialog(null);
          }}
        >
          <form
            className="w-[310px] rounded-md border border-white/15 bg-[#191d25] p-4 shadow-2xl"
            onContextMenu={guardModalContextMenu}
            onSubmit={(event) => {
              event.preventDefault();
              submitDialog();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDialog(null);
              }
            }}
          >
            <div id="midi-fx-dialog-title" className="mb-3 text-sm font-semibold text-white">
              {dialog.type === "pitch" ? "MIDI Pitch" : dialog.type === "velocity" ? "MIDI Velocity" : "MIDI Time"}
            </div>

            {dialog.type === "pitch" && (
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-white/60">
                Semitones
                <input
                  id="midi-fx-pitch-semitones"
                  type="number"
                  min={-48}
                  max={48}
                  step={1}
                  autoFocus
                  className="mt-1 h-8 w-full rounded border border-white/15 bg-black/30 px-2 text-sm normal-case tracking-normal text-white outline-none focus:border-[#4cc9f0]"
                  value={dialog.semitones}
                  onChange={(event) => updateDialog({ semitones: event.target.value })}
                />
              </label>
            )}

            {dialog.type === "velocity" && (
              <>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-white/60">
                  Scale Percent
                  <input
                    id="midi-fx-velocity-percent"
                    type="number"
                    min={1}
                    max={400}
                    step={1}
                    autoFocus
                    className="mt-1 h-8 w-full rounded border border-white/15 bg-black/30 px-2 text-sm normal-case tracking-normal text-white outline-none focus:border-[#4cc9f0]"
                    value={dialog.percent}
                    onChange={(event) => updateDialog({ percent: event.target.value })}
                  />
                </label>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-white/60">
                  Offset
                  <input
                    id="midi-fx-velocity-offset"
                    type="number"
                    min={-127}
                    max={127}
                    step={1}
                    className="mt-1 h-8 w-full rounded border border-white/15 bg-black/30 px-2 text-sm normal-case tracking-normal text-white outline-none focus:border-[#4cc9f0]"
                    value={dialog.offset}
                    onChange={(event) => updateDialog({ offset: event.target.value })}
                  />
                </label>
              </>
            )}

            {dialog.type === "time" && (
              <>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-white/60">
                  Swing Percent
                  <input
                    id="midi-fx-time-swing"
                    type="number"
                    min={-100}
                    max={100}
                    step={1}
                    autoFocus
                    className="mt-1 h-8 w-full rounded border border-white/15 bg-black/30 px-2 text-sm normal-case tracking-normal text-white outline-none focus:border-[#4cc9f0]"
                    value={dialog.swingPercent}
                    onChange={(event) => updateDialog({ swingPercent: event.target.value })}
                  />
                </label>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-white/60">
                  Offset Ms
                  <input
                    id="midi-fx-time-offset"
                    type="number"
                    min={-1000}
                    max={1000}
                    step={1}
                    className="mt-1 h-8 w-full rounded border border-white/15 bg-black/30 px-2 text-sm normal-case tracking-normal text-white outline-none focus:border-[#4cc9f0]"
                    value={dialog.offsetMs}
                    onChange={(event) => updateDialog({ offsetMs: event.target.value })}
                  />
                </label>
              </>
            )}

            {dialog.error && (
              <div className="mt-2 text-xs text-red-300">{dialog.error}</div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="h-8 rounded border border-white/10 px-3 text-xs text-white/75 hover:bg-white/10"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-8 rounded bg-[#2677ff] px-3 text-xs font-semibold text-white hover:bg-[#3b86ff]"
              >
                Apply
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

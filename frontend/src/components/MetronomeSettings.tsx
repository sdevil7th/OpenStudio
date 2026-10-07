import { useEffect, useRef, useState } from "react";
import { ChevronDown, Music2, Volume2 } from "lucide-react";
import { nativeBridge, type MetronomeSoundInfo } from "../services/NativeBridge";
import { getProjectEpoch } from "../utils/projectLifetime";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { MetronomeControls } from "./MetronomeControls";
import { PracticeTimer } from "./PracticeTimer";
import { Button, Modal, NativeSelect, TimeSignatureInput, Slider } from "./ui";
import { METRONOME_SOUND_OPTIONS, isCustomMetronomeSound, metronomeSoundLabel } from "../utils/metronomeSounds";

interface MetronomeSettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MetronomeSettings({ isOpen, onClose }: MetronomeSettingsProps) {
  const {
    timeSignature,
    setTimeSignature,
    metronomeAccentBeats,
    setMetronomeAccentBeats,
    practiceEnabled,
    practiceError,
    isPlaying,
    isRecording,
    metronomeVolume,
    setMetronomeVolume,
    metronomeTrackId,
    generateMetronomeTrack,
    removeMetronomeTrack,
    metronomeClickPath,
    metronomeAccentPath,
  } = useDAWStore(useShallow((s) => ({
    timeSignature: s.timeSignature,
    setTimeSignature: s.setTimeSignature,
    metronomeAccentBeats: s.metronomeAccentBeats,
    setMetronomeAccentBeats: s.setMetronomeAccentBeats,
    practiceEnabled: s.metronomePracticeEnabled,
    practiceError: s.metronomePracticeError,
    isPlaying: s.transport.isPlaying,
    isRecording: s.transport.isRecording,
    metronomeVolume: s.metronomeVolume,
    setMetronomeVolume: s.setMetronomeVolume,
    metronomeTrackId: s.metronomeTrackId,
    generateMetronomeTrack: s.generateMetronomeTrack,
    removeMetronomeTrack: s.removeMetronomeTrack,
    metronomeClickPath: s.metronomeClickPath,
    metronomeAccentPath: s.metronomeAccentPath,
  })));

  const [soundPending, setSoundPending] = useState(false);
  const [soundError, setSoundError] = useState("");
  const soundBusy = useRef(false);
  const [soundInfo, setSoundInfo] = useState<MetronomeSoundInfo[]>([]);
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const epoch = getProjectEpoch();
    void Promise.all([nativeBridge.getMetronomeSoundInfo(false), nativeBridge.getMetronomeSoundInfo(true)])
      .then(info => { if (active && epoch === getProjectEpoch()) setSoundInfo(info); })
      .catch(() => {});
    return () => { active = false; };
  }, [isOpen]);
  const chooseSound = async (accent: boolean, selection = "custom") => {
    if (soundBusy.current) return;
    soundBusy.current = true;
    setSoundPending(true);
    setSoundError("");
    const epoch = getProjectEpoch();
    try {
      const custom = selection === "custom";
      const path = custom ? await nativeBridge.showOpenDialog(
        accent ? "Choose accent sound" : "Choose click sound", "*.wav;*.aif;*.aiff;*.flac;*.ogg")
        : selection;
      if ((custom && !path) || getProjectEpoch() !== epoch) return;
      const state = useDAWStore.getState();
      const accepted = await (accent ? state.setMetronomeAccentSound(path) : state.setMetronomeClickSound(path));
      const info = await nativeBridge.getMetronomeSoundInfo(accent);
      if (getProjectEpoch() !== epoch) return;
      if (!accepted) setSoundError(`${info.error || "Could not load this sound."} Your previous sound is kept.`);
      else setSoundInfo(current => {
        const next = [...current]; next[accent ? 1 : 0] = info; return next;
      });
    } catch { setSoundError("Could not load this sound. Please try another file."); }
    finally { soundBusy.current = false; setSoundPending(false); }
  };

  if (!isOpen) return null;

  const handleBeatClick = (index: number) => {
    const newAccents = [...metronomeAccentBeats];
    // Beat 1 (index 0) is always accented
    if (index === 0) return;
    newAccents[index] = !newAccents[index];
    setMetronomeAccentBeats(newAccents);
  };

  // Reset to default (only beat 1 accented)
  const handleReset = () => {
    const defaultAccents = Array(timeSignature.numerator).fill(false);
    defaultAccents[0] = true;
    setMetronomeAccentBeats(defaultAccents);
  };

  // Accent all beats
  const handleAccentAll = () => {
    setMetronomeAccentBeats(Array(timeSignature.numerator).fill(true));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Metronome Settings" size="md" className="max-w-full"
      footer={<Button size="sm" onClick={onClose}>Done</Button>}>
      <div className="space-y-4 text-sm text-daw-text">
        <section aria-label="Playback and volume" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <MetronomeControls />
            {practiceEnabled && <span role="status" className="text-xs text-daw-solo">
              {isRecording ? "Following recording" : isPlaying ? "Following playback" : "Click only playing"}
            </span>}
          </div>
          <p className="text-xs text-daw-text-muted">Enable with playback, or play the click on its own.</p>
          {practiceError && <p role="alert" className="text-xs text-daw-record">{practiceError}</p>}
          <div className="flex items-center gap-4">
            <span className="w-24 shrink-0 text-xs text-daw-text-muted">Click volume</span>
            <div className="min-w-0 flex-1"><Slider aria-label="Metronome volume" orientation="horizontal" min={0} max={100} step={1}
              value={Math.round(metronomeVolume * 100)} onChange={val => setMetronomeVolume(val / 100)} /></div>
            <span className="w-10 text-right text-xs tabular-nums">{Math.round(metronomeVolume * 100)}%</span>
          </div>
        </section>

        <section aria-labelledby="metronome-rhythm-heading" className="space-y-3 border-t border-daw-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="metronome-rhythm-heading" className="font-medium">Rhythm & accents</h3>
            <TimeSignatureInput numerator={timeSignature.numerator} denominator={timeSignature.denominator} onChange={setTimeSignature} size="md" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {Array.from({ length: timeSignature.numerator }).map((_, i) => (
              <Button key={i} variant={i === 0 || metronomeAccentBeats[i] ? "warning" : "default"} size="sm"
                aria-label={`Accent beat ${i + 1}`} aria-pressed={i === 0 || metronomeAccentBeats[i]}
                onClick={() => handleBeatClick(i)} disabled={i === 0} active={i === 0 || metronomeAccentBeats[i]} className="h-8 w-8">
                {i + 1}
              </Button>
            ))}
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="sm" onClick={handleReset}>Reset accents</Button>
              <Button variant="ghost" size="sm" onClick={handleAccentAll}>Accent all</Button>
            </div>
          </div>
          <p className="text-xs text-daw-text-muted">Highlighted beats use the accent sound. Beat 1 is always accented.</p>
        </section>

        <details className="group overflow-hidden rounded-lg border border-daw-border bg-daw-dark/40">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daw-accent [&::-webkit-details-marker]:hidden">
            <Volume2 size={16} className="shrink-0 text-daw-text-muted" />
            <span className="font-medium">Click sounds</span>
            <span className="ml-auto min-w-0 truncate text-xs text-daw-text-muted">
              {metronomeClickPath === metronomeAccentPath ? metronomeSoundLabel(metronomeClickPath)
                : `${metronomeSoundLabel(metronomeClickPath)} / ${metronomeSoundLabel(metronomeAccentPath)}`}
            </span>
            <ChevronDown size={14} className="shrink-0 text-daw-text-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t border-daw-border px-4 py-3">
          <p className="text-xs text-daw-text-muted">Choose a sound for each beat type. Use Play click only above to listen.</p>
          <div className="divide-y divide-daw-border">
            {[{ label: "Regular", path: metronomeClickPath, accent: false }, { label: "Accent", path: metronomeAccentPath, accent: true }].map(sound => (
              <div key={sound.label} className="flex flex-wrap items-end gap-3 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <NativeSelect label={`${sound.label} sound`} size="sm" fullWidth showPlaceholder={false}
                    options={[...METRONOME_SOUND_OPTIONS, { value: "custom", label: "Custom sample…" }]}
                    value={isCustomMetronomeSound(sound.path) ? "custom" : sound.path}
                    disabled={soundPending} onChange={value => void chooseSound(sound.accent, String(value))} />
                  {isCustomMetronomeSound(sound.path) && <p className="mt-1 truncate text-xs text-daw-text-muted" title={soundInfo[sound.accent ? 1 : 0]?.name || sound.path}>
                    {soundInfo[sound.accent ? 1 : 0]?.name || "Prepared custom click"}
                  </p>}
                </div>
                <Button size="sm" aria-label={`Choose ${sound.label.toLowerCase()} sound`} disabled={soundPending}
                  onClick={() => void chooseSound(sound.accent)}>{isCustomMetronomeSound(sound.path) ? "Replace file…" : "Choose file…"}</Button>
              </div>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-daw-text-muted">Custom WAV, AIFF, FLAC or Ogg: choose one clear, sharp hit. We inspect the first 2 seconds, align its attack, match its peak level, and fade it to at most 100 ms. A prepared copy is kept locally.</p>
          {soundPending && <p role="status" className="text-xs text-daw-text-muted">Preparing click sound…</p>}
          {soundError && <p role="alert" className="text-xs text-daw-record">{soundError}</p>}
          </div>
        </details>

        <PracticeTimer />

        <details className="group overflow-hidden rounded-lg border border-daw-border bg-daw-dark/40">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daw-accent [&::-webkit-details-marker]:hidden">
            <Music2 size={16} className="text-daw-text-muted" /><span className="flex-1 font-medium">Render click as a track</span>
            <ChevronDown size={14} className="text-daw-text-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t border-daw-border px-4 py-3">
            <p className="text-xs leading-relaxed text-daw-text-muted">Add an audio track to include the click in an export. Mute it when using the live metronome to avoid a double click.</p>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={() => generateMetronomeTrack()}>{metronomeTrackId ? "Regenerate track" : "Add as track"}</Button>
              {metronomeTrackId && <Button variant="danger" size="sm" onClick={() => removeMetronomeTrack()}>Remove track</Button>}
            </div>
          </div>
        </details>
      </div>
    </Modal>
  );
}

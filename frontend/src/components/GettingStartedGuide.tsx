import { useState, useCallback } from "react";
import { useShallow } from "zustand/shallow";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Music,
  Mic,
  FileAudio,
  MousePointer,
  Sliders,
  Keyboard,
  Download,
  Sparkles,
} from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";

/**
 * GettingStartedGuide — Interactive multi-step onboarding guide.
 *
 * Shows a modal with 8 steps covering the core DAW workflow.
 * "Don't show again" preference persisted in localStorage.
 */

interface GuideStep {
  icon: React.ReactNode;
  title: string;
  description: string;
  details: string[];
  tip?: string;
}

const STEPS: GuideStep[] = [
  {
    icon: <Sparkles size={32} className="text-daw-accent" />,
    title: "Welcome to Studio13",
    description:
      "Studio13 is a full-featured Digital Audio Workstation for recording, editing, mixing, and exporting music and audio. This guide will walk you through the essentials to get you started.",
    details: [
      "Hybrid architecture: C++ audio engine with a modern React UI",
      "VST3 plugin support for virtual instruments and effects",
      "Canvas-based timeline for precise audio and MIDI editing",
      "Keyboard-driven workflow with 100+ shortcuts",
    ],
    tip: "Press Ctrl+Shift+P anytime to open the Command Palette and search for any action.",
  },
  {
    icon: <Music size={32} className="text-daw-accent" />,
    title: "Creating Tracks",
    description:
      "Tracks are the foundation of your project. Studio13 supports audio tracks for recording and playback, MIDI tracks for virtual instruments, and instrument tracks that combine both.",
    details: [
      "Right-click in the track area or use Insert menu to add tracks",
      "Audio tracks: record from microphones, line inputs, or import audio files",
      "MIDI tracks: sequence notes that drive external MIDI devices",
      "Instrument tracks: built-in virtual instrument with MIDI input",
      "Folder tracks: organize related tracks into collapsible groups",
    ],
    tip: "Use Ctrl+T to quickly add a new audio track.",
  },
  {
    icon: <Mic size={32} className="text-daw-accent" />,
    title: "Recording Audio",
    description:
      "To record audio, arm a track for recording, select your input source, then hit the record button. Studio13 records to WAV files with zero-latency monitoring.",
    details: [
      "Click the record arm button (R) on the track header",
      "Select your audio input from the track's input dropdown",
      "Press Ctrl+R or click the record button in the transport bar",
      "Press Space or click Stop to finish recording",
      "A new audio clip will appear on the timeline",
    ],
    tip: "Open Audio Settings (Ctrl+Shift+S) to configure your audio device and buffer size for low-latency recording.",
  },
  {
    icon: <FileAudio size={32} className="text-daw-accent" />,
    title: "Importing Audio Files",
    description:
      "Bring existing audio into your project by dragging files directly from your file manager onto the timeline, or use the File menu to import.",
    details: [
      "Drag & drop WAV, AIFF, FLAC, or MP3 files onto the timeline",
      "Files are automatically placed at the drop position",
      "Sample rate conversion is handled automatically",
      "Use the Media Explorer (Ctrl+Shift+M) to browse audio files",
      "Multiple files can be imported at once",
    ],
    tip: "Hold Ctrl while dropping to place files on consecutive tracks instead of the same track.",
  },
  {
    icon: <MousePointer size={32} className="text-daw-accent" />,
    title: "Using the Timeline",
    description:
      "The timeline is your main workspace. Here you arrange, edit, trim, split, and move clips. Zoom and scroll to navigate your project.",
    details: [
      "Ctrl+Scroll to zoom in/out horizontally",
      "Shift+Scroll to scroll vertically through tracks",
      "Click on the ruler to set the playhead position",
      "Drag clip edges to trim, drag body to move",
      "Press S to split clips at the playhead",
      "Press B to toggle the split (blade) tool",
      "Press Delete to remove selected clips",
    ],
    tip: "Use Ctrl+= and Ctrl+- for precise zoom control. Double-click a clip to open its properties.",
  },
  {
    icon: <Sliders size={32} className="text-daw-accent" />,
    title: "Mixing Basics",
    description:
      "Use the mixer to balance levels, pan instruments in the stereo field, and add effects. Each track has a channel strip with volume fader, pan knob, and FX chain.",
    details: [
      "Press Ctrl+M to toggle the mixer panel",
      "Drag faders to adjust volume, double-click to reset to 0 dB",
      "Use pan knobs to position sounds left/right",
      "S button: solo a track (hear only that track)",
      "M button: mute a track (silence it)",
      "Click the FX button to open the effects chain",
    ],
    tip: "Automate any parameter over time by adding automation lanes to tracks.",
  },
  {
    icon: <Keyboard size={32} className="text-daw-accent" />,
    title: "Keyboard Shortcuts",
    description:
      "Studio13 is designed for fast keyboard-driven workflows. Learn the essential shortcuts to speed up your work dramatically.",
    details: [
      "Space: Play / Pause",
      "Ctrl+R: Start / Stop Recording",
      "Ctrl+Z / Ctrl+Y: Undo / Redo",
      "Ctrl+S: Save Project",
      "Ctrl+C / Ctrl+V: Copy / Paste clips",
      "S: Split at playhead",
      "L: Toggle loop mode",
      "F1: Open Help Reference",
    ],
    tip: "Press Shift+/ (?) to view the complete keyboard shortcuts reference.",
  },
  {
    icon: <Download size={32} className="text-daw-accent" />,
    title: "Export Your Project",
    description:
      "When your mix is ready, render it to an audio file. Studio13 supports multiple formats and bit depths for distribution or further mastering.",
    details: [
      "Go to File > Render / Export or press Ctrl+Shift+R",
      "Choose format: WAV, AIFF, or FLAC",
      "Select bit depth: 16-bit, 24-bit, or 32-bit float",
      "Mono or stereo output",
      "Optional normalize and render tail for reverb/delay tails",
      "Rendered file is saved to your project directory",
    ],
    tip: "For streaming platforms, export at 24-bit WAV and target -14 LUFS loudness.",
  },
];

const LS_KEY = "s13_gettingStartedDismissed";

export function GettingStartedGuide() {
  const { showGettingStarted, toggleGettingStarted } = useDAWStore(
    useShallow((s) => ({
      showGettingStarted: s.showGettingStarted,
      toggleGettingStarted: s.toggleGettingStarted,
    }))
  );

  const [currentStep, setCurrentStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(
    () => localStorage.getItem(LS_KEY) === "true"
  );

  const step = STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;

  const handleClose = useCallback(() => {
    if (dontShowAgain) {
      localStorage.setItem(LS_KEY, "true");
    }
    setCurrentStep(0);
    toggleGettingStarted();
  }, [dontShowAgain, toggleGettingStarted]);

  const handleNext = useCallback(() => {
    if (isLast) {
      handleClose();
    } else {
      setCurrentStep((s) => s + 1);
    }
  }, [isLast, handleClose]);

  const handlePrev = useCallback(() => {
    setCurrentStep((s) => Math.max(0, s - 1));
  }, []);

  if (!showGettingStarted) return null;

  return (
    <div className="fixed inset-0 z-2000 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative w-[640px] bg-daw-panel border border-daw-border rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-daw-border">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-daw-text">Getting Started</h2>
            <span className="text-xs text-neutral-500">
              Step {currentStep + 1} of {STEPS.length}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleClose}
            title="Close guide"
            aria-label="Close guide"
          >
            <X size={16} />
          </Button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-daw-dark">
          <div
            className="h-full bg-daw-accent transition-all duration-300 ease-out"
            style={{ width: `${((currentStep + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        {/* Step Content */}
        <div className="px-6 py-5 space-y-4 min-h-[380px]">
          {/* Icon + Title */}
          <div className="flex items-center gap-3">
            {step.icon}
            <h3 className="text-xl font-semibold text-daw-text">{step.title}</h3>
          </div>

          {/* Description */}
          <p className="text-sm text-neutral-300 leading-relaxed">
            {step.description}
          </p>

          {/* Details list */}
          <div className="bg-daw-dark/50 border border-daw-border/50 rounded-md p-4">
            <ul className="space-y-2">
              {step.details.map((detail, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-neutral-300">
                  <span className="text-daw-accent mt-0.5 shrink-0">&#8226;</span>
                  <span>{detail}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Tip */}
          {step.tip && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-daw-accent/10 border border-daw-accent/20 rounded-md">
              <Sparkles size={14} className="text-daw-accent mt-0.5 shrink-0" />
              <p className="text-xs text-daw-accent leading-relaxed">
                <span className="font-semibold">Tip: </span>
                {step.tip}
              </p>
            </div>
          )}
        </div>

        {/* Step indicators (dots) */}
        <div className="flex items-center justify-center gap-1.5 pb-3">
          {STEPS.map((_, i) => (
            <button
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${
                i === currentStep
                  ? "bg-daw-accent"
                  : i < currentStep
                    ? "bg-daw-accent/40"
                    : "bg-neutral-600"
              }`}
              onClick={() => setCurrentStep(i)}
              title={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-daw-border">
          {/* Don't show again */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-neutral-600 bg-daw-dark text-daw-accent focus:ring-daw-accent focus:ring-offset-0"
            />
            <span className="text-xs text-neutral-400">Don&apos;t show again</span>
          </label>

          {/* Navigation buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClose}
            >
              Skip
            </Button>

            {!isFirst && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePrev}
              >
                <ChevronLeft size={14} className="mr-1" />
                Previous
              </Button>
            )}

            <Button
              variant="primary"
              size="sm"
              onClick={handleNext}
            >
              {isLast ? "Finish" : "Next"}
              {!isLast && <ChevronRight size={14} className="ml-1" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

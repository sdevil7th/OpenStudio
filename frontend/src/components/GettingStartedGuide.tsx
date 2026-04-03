import { useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Navigation,
  Settings2,
  Music,
  Mic,
  Keyboard,
  Scissors,
  SlidersHorizontal,
  Download,
  Wand2,
  HelpCircle,
} from "lucide-react";
import { getEffectiveActionShortcut } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";

interface GuideStep {
  icon: React.ReactNode;
  title: string;
  description: string;
  details: string[];
  tip?: string;
}

function shortcut(actionId: string, fallback: string): string {
  return getEffectiveActionShortcut(actionId) ?? fallback;
}

function buildGuideSteps(): GuideStep[] {
  const commandPaletteShortcut = shortcut("view.commandPalette", "Ctrl+Shift+P");
  const audioTrackShortcut = shortcut("insert.audioTrack", "Ctrl+T");
  const midiTrackShortcut = shortcut("insert.midiTrack", "Ctrl+Shift+T");
  const instrumentTrackShortcut = shortcut("insert.quickAddInstrument", "Ctrl+Shift+I");
  const recordShortcut = shortcut("transport.record", "Ctrl+R");
  const preferencesShortcut = shortcut("options.preferences", "Ctrl+,");
  const importShortcut = shortcut("insert.mediaFile", "Insert");
  const saveShortcut = shortcut("file.save", "Ctrl+S");
  const renderShortcut = shortcut("file.render", "Ctrl+Alt+R");
  const helpShortcut = shortcut("help.contextualHelp", "F1");
  const splitToolShortcut = shortcut("tools.splitTool", "B");
  const splitShortcut = shortcut("edit.splitAtCursor", "S");
  const playShortcut = shortcut("transport.play", "Space");
  const mixerShortcut = shortcut("view.toggleMixer", "Ctrl+M");
  const virtualKeyboardShortcut = shortcut("view.toggleVirtualKeyboard", "Alt+B");

  return [
    {
      icon: <Sparkles size={32} className="text-daw-accent" />,
      title: "Welcome to OpenStudio",
      description:
        "OpenStudio is a modern desktop DAW for recording, editing, MIDI work, mixing, and advanced production tasks. This guide focuses on the first-session actions that matter most, then points you toward deeper features.",
      details: [
        "C++ audio engine with a modern React timeline and mixer UI",
        "Audio, MIDI, instrument, and bus tracks in one session",
        "Integrated plugin workflow, pitch tools, routing, and export",
        "Advanced tools like stem separation, scripting, and project utilities",
      ],
      tip: `Press ${commandPaletteShortcut} at any time to search for actions instead of hunting through menus.`,
    },
    {
      icon: <Navigation size={32} className="text-daw-accent" />,
      title: "Essential Navigation Gestures & Hotkeys",
      description:
        "Learn these controls first. They cover most of what a new user needs in the first two minutes and match the current app behavior exactly.",
      details: [
        "Scroll: native vertical scrolling through the workspace",
        "Ctrl+Scroll: zoom the timeline horizontally around the pointer",
        "Shift+Scroll: move horizontally through the timeline",
        "Alt+Scroll: resize track height",
        "Ctrl+Shift+Scroll: zoom track height more aggressively",
        `${playShortcut}: Play / Stop`,
        `${recordShortcut}: Start recording on armed tracks`,
        `${audioTrackShortcut}: New audio track`,
        `${mixerShortcut}: Toggle mixer`,
        `${splitShortcut}: Split at playhead | ${splitToolShortcut}: Split tool`,
      ],
      tip: `${helpShortcut} opens the Help Reference, and ${commandPaletteShortcut} is the fastest way to find any feature or command.`,
    },
    {
      icon: <Settings2 size={32} className="text-daw-accent" />,
      title: "Set Up Audio First",
      description:
        "Before recording, choose the right audio driver, hardware input/output, sample rate, and buffer size so monitoring and latency feel right.",
      details: [
        "Open Audio Settings from the toolbar or File menu audio/settings path",
        "Choose your driver and hardware devices",
        "Set sample rate and buffer size for a good latency/CPU balance",
        "Return to Preferences for editing, display, mouse, and backup options",
      ],
      tip: `Use ${preferencesShortcut} for Preferences. Shortcut rebinding is handled in Keyboard Shortcuts, not inside Preferences.`,
    },
    {
      icon: <Music size={32} className="text-daw-accent" />,
      title: "Create the Right Track Type",
      description:
        "OpenStudio supports different track types for different jobs, so the quickest path is to pick the right one at the start.",
      details: [
        `${audioTrackShortcut}: audio track for microphones, line inputs, and imported audio`,
        `${midiTrackShortcut}: MIDI track for note data and MIDI devices`,
        `${instrumentTrackShortcut}: instrument track for playing a plugin immediately`,
        "Bus/group tracks are used for routing and submixing later in the mix",
      ],
      tip: `If you are starting from a synth or sampler, use ${instrumentTrackShortcut} so the plugin browser opens in the right workflow.`,
    },
    {
      icon: <Mic size={32} className="text-daw-accent" />,
      title: "Record Audio",
      description:
        "Arm an audio track, choose the correct input, and record from the transport. Recorded takes appear directly on the timeline as audio clips.",
      details: [
        "Arm the track in the header or mixer",
        "Pick the hardware input and enable monitoring if needed",
        `Press ${recordShortcut} to record and ${playShortcut} to stop`,
        "Recorded clips appear in place and are ready to edit immediately",
      ],
      tip: "If monitoring feels late, lower the buffer size in Audio Settings until it feels comfortable without overloading the CPU.",
    },
    {
      icon: <Keyboard size={32} className="text-daw-accent" />,
      title: "Record MIDI & Instruments",
      description:
        "MIDI and instrument tracks record note performance instead of audio waveforms. Instrument tracks also let you hear the loaded plugin while you play.",
      details: [
        "Choose a MIDI input device on the track",
        "Load an instrument plugin for instrument tracks",
        `Use ${virtualKeyboardShortcut} for the on-screen keyboard if no controller is connected`,
        "Recorded MIDI clips open into the Piano Roll for note editing",
      ],
      tip: "Use an instrument track when you want the fastest \"play and hear\" workflow from a plugin.",
    },
    {
      icon: <Scissors size={32} className="text-daw-accent" />,
      title: "Edit on the Timeline",
      description:
        "The timeline is where you arrange, trim, split, mute, and move both audio and MIDI clips. Most day-to-day editing starts here.",
      details: [
        "Drag clip bodies to move them",
        "Drag clip edges to trim timing",
        `${splitShortcut}: split at the playhead`,
        `${splitToolShortcut}: switch into split-tool editing`,
        `${shortcut("edit.delete", "Delete")}: remove selected clips or tracks`,
        `${importShortcut}: import media at the current position`,
      ],
      tip: "Use the ruler to place the playhead before splitting, looping, or importing.",
    },
    {
      icon: <SlidersHorizontal size={32} className="text-daw-accent" />,
      title: "Mixing, FX & Snapshots",
      description:
        "Once material is on the timeline, move into the mixer for balancing, panning, mute/solo work, plugin access, and snapshot comparisons.",
      details: [
        `${mixerShortcut}: open the mixer`,
        "Use channel strips for volume, pan, mute, solo, arm, and FX access",
        "Open plugin editors from the FX chain workflow",
        "Use mixer snapshots to compare alternate balances quickly",
        "The mixer can also be detached into its own native window",
      ],
      tip: "Monitoring FX are for what you hear while working, not for what gets rendered into the final export.",
    },
    {
      icon: <Download size={32} className="text-daw-accent" />,
      title: "Render & Deliver",
      description:
        "Render creates the final output of your session. Use it for standard exports, delivery files, and broader session management tasks.",
      details: [
        `${renderShortcut}: open Render / Export`,
        "Choose file format, bit depth, and output settings",
        "Project tools also include MIDI export, session archive, and delivery helpers like DDP where available",
      ],
      tip: `Save first with ${saveShortcut}, then render once the mix and routing are where you want them.`,
    },
    {
      icon: <Wand2 size={32} className="text-daw-accent" />,
      title: "Advanced Capabilities Overview",
      description:
        "OpenStudio includes deeper tools that go beyond the basic record-edit-mix loop. You do not need them on day one, but they are worth knowing about early.",
      details: [
        "Pitch editing and pitch correction inside the session",
        "Stem separation for remixing, cleanup, practice, and creative extraction",
        "Routing matrix, buses, sends, and monitoring FX for larger mixes",
        "Theme editing, toolbar customization, scripting, templates, and project utilities",
      ],
      tip: `Use ${commandPaletteShortcut} to jump straight into advanced tools once you know what you want.`,
    },
    {
      icon: <HelpCircle size={32} className="text-daw-accent" />,
      title: "Where to Go Next",
      description:
        "Once you know the core gestures and shortcuts, the fastest next step is to use the built-in references instead of memorizing everything immediately.",
      details: [
        `${helpShortcut}: Help Reference for searchable feature guidance`,
        "Keyboard Shortcuts window for the full shortcut list and custom global rebinding",
        `Preferences (${preferencesShortcut}) for editing, display, mouse, and backup settings`,
        `Command Palette (${commandPaletteShortcut}) to find actions by name`,
      ],
      tip: "If a shortcut behaves differently than expected, check the Keyboard Shortcuts window first because global bindings may have been customized.",
    },
  ];
}

const LS_KEY = "openstudio_gettingStartedDismissed";

export function GettingStartedGuide() {
  const { showGettingStarted, toggleGettingStarted } = useDAWStore(
    useShallow((s) => ({
      showGettingStarted: s.showGettingStarted,
      toggleGettingStarted: s.toggleGettingStarted,
    })),
  );
  const customShortcuts = useDAWStore((s) => s.customShortcuts);

  const [currentStep, setCurrentStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(
    () => localStorage.getItem(LS_KEY) === "true",
  );

  const steps = useMemo(() => buildGuideSteps(), [customShortcuts]);
  const step = steps[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === steps.length - 1;

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
  }, [handleClose, isLast]);

  const handlePrev = useCallback(() => {
    setCurrentStep((s) => Math.max(0, s - 1));
  }, []);

  if (!showGettingStarted) return null;

  return (
    <div className="fixed inset-0 z-2000 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} />

      <div className="relative w-[680px] bg-daw-panel border border-daw-border rounded-lg shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-daw-border">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-daw-text">Getting Started</h2>
            <span className="text-xs text-neutral-500">
              Step {currentStep + 1} of {steps.length}
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

        <div className="h-1 bg-daw-dark">
          <div
            className="h-full bg-daw-accent transition-all duration-300 ease-out"
            style={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
          />
        </div>

        <div className="px-6 py-5 space-y-4 min-h-[420px]">
          <div className="flex items-center gap-3">
            {step.icon}
            <h3 className="text-xl font-semibold text-daw-text">{step.title}</h3>
          </div>

          <p className="text-sm text-neutral-300 leading-relaxed">{step.description}</p>

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

        <div className="flex items-center justify-center gap-1.5 pb-3">
          {steps.map((_, i) => (
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

        <div className="flex items-center justify-between px-5 py-3 border-t border-daw-border">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-neutral-600 bg-daw-dark text-daw-accent focus:ring-daw-accent focus:ring-offset-0"
            />
            <span className="text-xs text-neutral-400">Don&apos;t show again</span>
          </label>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePrev}
              disabled={isFirst}
              className="gap-1"
            >
              <ChevronLeft size={14} />
              Previous
            </Button>
            <Button variant="primary" size="sm" onClick={handleNext} className="gap-1">
              {isLast ? "Finish" : "Next"}
              {!isLast && <ChevronRight size={14} />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

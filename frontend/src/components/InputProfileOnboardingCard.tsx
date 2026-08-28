import { Keyboard, MousePointer2, X } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";
import { InputProfileSelectors } from "./InputProfileSelectors";

export function InputProfileOnboardingCard() {
  const {
    inputProfileOnboardingSeen,
    markInputProfileOnboardingSeen,
    toggleKeyboardShortcuts,
  } = useDAWStore(useShallow((state) => ({
    inputProfileOnboardingSeen: state.inputProfileOnboardingSeen,
    markInputProfileOnboardingSeen: state.markInputProfileOnboardingSeen,
    toggleKeyboardShortcuts: state.toggleKeyboardShortcuts,
  })));

  if (inputProfileOnboardingSeen) return null;

  const openFullEditor = () => {
    markInputProfileOnboardingSeen();
    toggleKeyboardShortcuts();
  };

  return (
    <section
      aria-label="Choose input profiles"
      aria-describedby="input-profile-onboarding-description"
      aria-live="polite"
      className="fixed bottom-3 right-3 z-[130] max-h-[calc(100vh-1.5rem)] w-[min(34rem,calc(100%-1.5rem))] overflow-y-auto rounded-xl border border-daw-accent/60 bg-daw-panel/98 shadow-2xl backdrop-blur sm:bottom-4 sm:right-4"
    >
      <div className="flex items-start justify-between gap-3 border-b border-daw-border px-4 py-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-daw-accent">First-run setup</p>
          <h2 id="input-profile-onboarding-title" className="mt-1 text-sm font-semibold text-daw-text">Make OpenStudio feel familiar</h2>
          <p id="input-profile-onboarding-description" className="mt-1 text-xs leading-relaxed text-neutral-400">
            Choose the DAW key map and mouse behavior you already know. You can change either one later.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={markInputProfileOnboardingSeen}
          title="Close profile setup"
          aria-label="Close profile setup and keep current selections"
        >
          <X size={14} />
        </Button>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="flex gap-2 text-[11px] text-neutral-500">
          <span className="inline-flex items-center gap-1"><Keyboard size={12} aria-hidden="true" /> Hotkeys</span>
          <span className="inline-flex items-center gap-1"><MousePointer2 size={12} aria-hidden="true" /> Scroll & pointer modifiers</span>
        </div>
        <InputProfileSelectors compact showDescriptions={false} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Custom bindings, including intentionally unassigned commands, override the selected profile. Most built-in profiles keep OpenStudio defaults for unmapped commands; strict profiles say so in their description and leave unsourced keys unassigned.
          </p>
          <div className="flex flex-wrap justify-end gap-2 sm:shrink-0">
            <Button variant="ghost" size="sm" onClick={openFullEditor}>Review shortcuts</Button>
            <Button variant="primary" size="sm" onClick={markInputProfileOnboardingSeen}>Use these profiles</Button>
          </div>
        </div>
      </div>
    </section>
  );
}

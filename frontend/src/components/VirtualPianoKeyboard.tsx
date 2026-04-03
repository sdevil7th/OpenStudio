import { useState, useCallback } from "react";
import { X, AlertTriangle } from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button } from "./ui";

interface PianoKey {
  note: number; // MIDI note number (0-127)
  name: string; // Note name (C4, D#4, etc.)
  isBlack: boolean;
  offset: number; // Horizontal offset for positioning
}

/**
 * Virtual Piano Keyboard Component
 * Provides an on-screen piano keyboard for MIDI input
 * Supports mouse/touch interaction to play notes
 */
export function VirtualPianoKeyboard() {
  const { tracks, selectedTrackIds } = useDAWStore(useShallow((s) => ({
    tracks: s.tracks,
    selectedTrackIds: s.selectedTrackIds,
  })));
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());

  // Generate piano keys (2 octaves: C3 to B4)
  const generateKeys = (): PianoKey[] => {
    const keys: PianoKey[] = [];
    const startNote = 48; // C3
    const octaves = 2;
    const notesPerOctave = 12;

    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const blackKeys = [1, 3, 6, 8, 10]; // Indices of black keys in an octave

    let whiteKeyIndex = 0;
    const whiteKeyWidth = 40;

    for (let i = 0; i < octaves * notesPerOctave; i++) {
      const noteInOctave = i % notesPerOctave;
      const octave = Math.floor(i / notesPerOctave) + 3;
      const isBlack = blackKeys.includes(noteInOctave);

      let offset: number;
      if (isBlack) {
        // Black keys are positioned between white keys
        offset = whiteKeyIndex * whiteKeyWidth - whiteKeyWidth / 4;
      } else {
        offset = whiteKeyIndex * whiteKeyWidth;
        whiteKeyIndex++;
      }

      keys.push({
        note: startNote + i,
        name: `${noteNames[noteInOctave]}${octave}`,
        isBlack,
        offset,
      });
    }

    return keys;
  };

  const keys = generateKeys();

  // Find the first selected MIDI track to route notes to
  const getMidiTrack = useCallback(() => {
    if (selectedTrackIds.length === 0) return null;
    const track = tracks.find(
      (t) =>
        selectedTrackIds.includes(t.id) &&
        (t.type === "midi" || t.type === "instrument")
    );
    return track || null;
  }, [tracks, selectedTrackIds]);

  const handleNoteOn = useCallback(
    async (note: number) => {
      const track = getMidiTrack();
      if (!track) {
        console.warn("No MIDI or instrument track selected for virtual keyboard");
        return;
      }

      setActiveNotes((prev) => new Set(prev).add(note));

      try {
        // Send MIDI note on with velocity 100 (0-127 range)
        await nativeBridge.sendMidiNote(track.id, note, 100, true);
      } catch (error) {
        console.error("Failed to send MIDI note on:", error);
      }
    },
    [getMidiTrack]
  );

  const handleNoteOff = useCallback(
    async (note: number) => {
      const track = getMidiTrack();
      if (!track) return;

      setActiveNotes((prev) => {
        const next = new Set(prev);
        next.delete(note);
        return next;
      });

      try {
        // Send MIDI note off (velocity 0)
        await nativeBridge.sendMidiNote(track.id, note, 0, false);
      } catch (error) {
        console.error("Failed to send MIDI note off:", error);
      }
    },
    [getMidiTrack]
  );

  const handleMouseDown = (note: number) => {
    handleNoteOn(note);
  };

  const handleMouseUp = (note: number) => {
    handleNoteOff(note);
  };

  const handleMouseLeave = (note: number) => {
    // Release note if mouse leaves while pressed
    if (activeNotes.has(note)) {
      handleNoteOff(note);
    }
  };

  const whiteKeys = keys.filter((k) => !k.isBlack);
  const blackKeys = keys.filter((k) => k.isBlack);
  const totalWidth = whiteKeys.length * 40;

  const midiTrack = getMidiTrack();

  return (
    <div className="h-48 bg-daw-panel border-t border-daw-border flex flex-col shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-daw-border">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-daw-text">
            Virtual MIDI Keyboard
          </span>
          {midiTrack ? (
            <span className="text-xs text-daw-text-muted">
              → {midiTrack.name}
            </span>
          ) : (
            <span className="text-xs text-yellow-500 flex items-center gap-1">
              <AlertTriangle size={12} /> No MIDI track selected
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => useDAWStore.getState().toggleVirtualKeyboard()}
          title="Close Virtual Keyboard"
        >
          <X size={14} />
        </Button>
      </div>

      {/* Piano Keyboard */}
      <div className="flex-1 flex items-end justify-center overflow-x-auto p-4">
        <div
          className="relative select-none"
          style={{ width: `${totalWidth}px`, height: "120px" }}
        >
          {/* White Keys */}
          {whiteKeys.map((key) => (
            <div
              key={key.note}
              className={`absolute bottom-0 border border-neutral-700 rounded-b cursor-pointer transition-colors ${
                activeNotes.has(key.note)
                  ? "bg-blue-500"
                  : "bg-white hover:bg-neutral-200"
              }`}
              style={{
                left: `${key.offset}px`,
                width: "38px",
                height: "120px",
              }}
              onMouseDown={() => handleMouseDown(key.note)}
              onMouseUp={() => handleMouseUp(key.note)}
              onMouseLeave={() => handleMouseLeave(key.note)}
            >
              <div className="absolute bottom-2 left-0 right-0 text-center text-xs text-neutral-600 font-medium select-none">
                {key.name}
              </div>
            </div>
          ))}

          {/* Black Keys */}
          {blackKeys.map((key) => (
            <div
              key={key.note}
              className={`absolute bottom-0 border border-neutral-900 rounded-b cursor-pointer transition-colors z-10 ${
                activeNotes.has(key.note)
                  ? "bg-blue-600"
                  : "bg-neutral-900 hover:bg-neutral-700"
              }`}
              style={{
                left: `${key.offset}px`,
                width: "28px",
                height: "80px",
              }}
              onMouseDown={() => handleMouseDown(key.note)}
              onMouseUp={() => handleMouseUp(key.note)}
              onMouseLeave={() => handleMouseLeave(key.note)}
            >
              <div className="absolute bottom-2 left-0 right-0 text-center text-[10px] text-neutral-400 font-medium select-none">
                {key.name}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

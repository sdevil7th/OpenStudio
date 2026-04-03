import { useEffect, useState } from "react";
import { Button, Input, Modal, Select } from "./ui";
import { type InsertableTrackType } from "../utils/trackCreation";

interface AddMultipleTracksModalProps {
  isOpen: boolean;
  initialType?: InsertableTrackType;
  onClose: () => void;
  onSubmit: (config: {
    count: number;
    trackType: InsertableTrackType;
    namingPrefix: string;
  }) => void | Promise<void>;
}

const TRACK_TYPE_OPTIONS = [
  { value: "audio", label: "Audio" },
  { value: "midi", label: "MIDI" },
  { value: "instrument", label: "Instrument" },
] as const;

const DEFAULT_PREFIX: Record<InsertableTrackType, string> = {
  audio: "Audio",
  midi: "MIDI",
  instrument: "Instrument",
};

export function AddMultipleTracksModal({
  isOpen,
  initialType = "audio",
  onClose,
  onSubmit,
}: AddMultipleTracksModalProps) {
  const [count, setCount] = useState("4");
  const [trackType, setTrackType] = useState<InsertableTrackType>(initialType);
  const [namingPrefix, setNamingPrefix] = useState(DEFAULT_PREFIX[initialType]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setCount("4");
    setTrackType(initialType);
    setNamingPrefix(DEFAULT_PREFIX[initialType]);
    setIsSubmitting(false);
  }, [initialType, isOpen]);

  const handleTypeChange = (value: string | number) => {
    const nextType = value as InsertableTrackType;
    setTrackType(nextType);
    setNamingPrefix((current) =>
      current.trim().length > 0 ? current : DEFAULT_PREFIX[nextType],
    );
  };

  const handleSubmit = async () => {
    const parsedCount = Math.max(1, Math.min(128, parseInt(count, 10) || 1));
    setIsSubmitting(true);
    try {
      await onSubmit({
        count: parsedCount,
        trackType,
        namingPrefix: namingPrefix.trim() || DEFAULT_PREFIX[trackType],
      });
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Multiple Tracks"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={isSubmitting}>
            Add Tracks
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs uppercase tracking-wide text-daw-text-muted mb-1">
            Number of Tracks
          </label>
          <Input
            type="number"
            min={1}
            max={128}
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wide text-daw-text-muted mb-1">
            Track Type
          </label>
          <Select
            value={trackType}
            onChange={handleTypeChange}
            options={TRACK_TYPE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            fullWidth
          />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wide text-daw-text-muted mb-1">
            Naming Prefix
          </label>
          <Input
            type="text"
            value={namingPrefix}
            onChange={(event) => setNamingPrefix(event.target.value)}
            placeholder={DEFAULT_PREFIX[trackType]}
          />
        </div>
      </div>
    </Modal>
  );
}

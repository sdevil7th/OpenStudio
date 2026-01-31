import { useState, useEffect } from "react";
import { useDAWStore } from "../store/useDAWStore";
import {
  Button,
  Input,
  Textarea,
  Select,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
} from "./ui";

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Project Settings Modal
 * Configure project metadata like name, notes, sample rate, and bit depth
 */
export function ProjectSettingsModal({
  isOpen,
  onClose,
}: ProjectSettingsModalProps) {
  const {
    projectName,
    projectNotes,
    projectSampleRate,
    projectBitDepth,
    transport,
    timeSignature,
    setProjectName,
    setProjectNotes,
    setProjectSampleRate,
    setProjectBitDepth,
    setTempo,
    setTimeSignature: setTimeSignatureAction,
  } = useDAWStore();

  // Local state for form
  const [localName, setLocalName] = useState(projectName);
  const [localNotes, setLocalNotes] = useState(projectNotes);
  const [localSampleRate, setLocalSampleRate] = useState(projectSampleRate);
  const [localBitDepth, setLocalBitDepth] = useState(projectBitDepth);
  const [localTempo, setLocalTempo] = useState(transport.tempo);
  const [localTimeSignatureNum, setLocalTimeSignatureNum] = useState(
    timeSignature.numerator
  );
  const [localTimeSignatureDenom, setLocalTimeSignatureDenom] = useState(
    timeSignature.denominator
  );

  // Sync local state when modal opens or store changes
  useEffect(() => {
    if (isOpen) {
      setLocalName(projectName);
      setLocalNotes(projectNotes);
      setLocalSampleRate(projectSampleRate);
      setLocalBitDepth(projectBitDepth);
      setLocalTempo(transport.tempo);
      setLocalTimeSignatureNum(timeSignature.numerator);
      setLocalTimeSignatureDenom(timeSignature.denominator);
    }
  }, [
    isOpen,
    projectName,
    projectNotes,
    projectSampleRate,
    projectBitDepth,
    transport.tempo,
    timeSignature,
  ]);

  const handleApply = () => {
    setProjectName(localName);
    setProjectNotes(localNotes);
    setProjectSampleRate(localSampleRate);
    setProjectBitDepth(localBitDepth);
    setTempo(localTempo);
    setTimeSignatureAction(localTimeSignatureNum, localTimeSignatureDenom);
    onClose();
  };

  const handleCancel = () => {
    // Reset to original values
    setLocalName(projectName);
    setLocalNotes(projectNotes);
    setLocalSampleRate(projectSampleRate);
    setLocalBitDepth(projectBitDepth);
    setLocalTempo(transport.tempo);
    setLocalTimeSignatureNum(timeSignature.numerator);
    setLocalTimeSignatureDenom(timeSignature.denominator);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleCancel} size="md">
      <ModalHeader title="Project Settings" onClose={handleCancel} />

      <ModalContent>
        <div className="space-y-6">
          {/* Project Name */}
          <Input
            type="text"
            variant="default"
            size="md"
            fullWidth
            label="Project Name"
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            placeholder="Untitled Project"
          />

          {/* Project Notes */}
          <Textarea
            variant="default"
            size="md"
            fullWidth
            label="Project Notes"
            value={localNotes}
            onChange={(e) => setLocalNotes(e.target.value)}
            rows={4}
            placeholder="Add notes about this project..."
          />

          {/* Audio Settings */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-daw-text border-b border-daw-border pb-2">
              Audio Settings
            </h3>

            <div className="grid grid-cols-2 gap-4">
              {/* Sample Rate */}
              <Select
                variant="default"
                size="md"
                fullWidth
                label="Sample Rate"
                options={[
                  { value: 44100, label: "44100 Hz" },
                  { value: 48000, label: "48000 Hz" },
                  { value: 88200, label: "88200 Hz" },
                  { value: 96000, label: "96000 Hz" },
                  { value: 192000, label: "192000 Hz" },
                ]}
                value={localSampleRate}
                onChange={(val) =>
                  setLocalSampleRate(
                    val as 44100 | 48000 | 88200 | 96000 | 192000
                  )
                }
              />

              {/* Bit Depth */}
              <Select
                variant="default"
                size="md"
                fullWidth
                label="Bit Depth"
                options={[
                  { value: 16, label: "16-bit" },
                  { value: 24, label: "24-bit" },
                  { value: 32, label: "32-bit float" },
                ]}
                value={localBitDepth}
                onChange={(val) => setLocalBitDepth(val as 16 | 24 | 32)}
              />
            </div>
          </div>

          {/* Project Defaults */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-daw-text border-b border-daw-border pb-2">
              Project Defaults
            </h3>

            <div className="grid grid-cols-2 gap-4">
              {/* Tempo */}
              <Input
                type="number"
                variant="default"
                size="md"
                fullWidth
                label="Tempo (BPM)"
                value={localTempo.toString()}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 20 && val <= 300) {
                    setLocalTempo(val);
                  }
                }}
                min="20"
                max="300"
                step="0.1"
              />

              {/* Time Signature */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-daw-text-muted">
                  Time Signature
                </label>
                <div className="flex items-center gap-2">
                  <Select
                    variant="default"
                    size="md"
                    fullWidth
                    options={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(
                      (n) => ({
                        value: n,
                        label: n.toString(),
                      })
                    )}
                    value={localTimeSignatureNum}
                    onChange={(val) =>
                      setLocalTimeSignatureNum(val as number)
                    }
                  />
                  <span className="text-daw-text-muted">/</span>
                  <Select
                    variant="default"
                    size="md"
                    fullWidth
                    options={[2, 4, 8, 16].map((d) => ({
                      value: d,
                      label: d.toString(),
                    }))}
                    value={localTimeSignatureDenom}
                    onChange={(val) =>
                      setLocalTimeSignatureDenom(val as number)
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </ModalContent>

      <ModalFooter>
        <Button variant="secondary" size="md" onClick={handleCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="md" onClick={handleApply}>
          Apply
        </Button>
      </ModalFooter>
    </Modal>
  );
}

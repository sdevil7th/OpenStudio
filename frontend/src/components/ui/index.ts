/**
 * UI Component Library
 *
 * Reusable, accessible, and type-safe components for the Studio13-v3 DAW.
 * Built with Tailwind CSS and Headless UI primitives.
 *
 * @example
 * ```tsx
 * import { Button, Input, Select, Modal } from '@/components/ui';
 *
 * // Or import individual components
 * import { Button } from '@/components/ui/Button';
 * ```
 */

// Button
export { Button } from './Button';
export type {
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  ButtonShape,
  ActiveStyle,
} from './Button';

// Input
export { Input } from './Input';
export type { InputProps, InputSize, InputVariant } from './Input';

// Select
export { Select } from './Select';
export type { SelectProps, SelectOption, SelectSize, SelectVariant } from './Select';

// Checkbox
export { Checkbox } from './Checkbox';
export type { CheckboxProps, CheckboxSize } from './Checkbox';

// Textarea
export { Textarea } from './Textarea';
export type { TextareaProps, TextareaSize } from './Textarea';

// Slider
export { Slider } from './Slider';
export type { SliderProps, SliderOrientation, SliderVariant } from './Slider';

// TimeSignatureInput
export { TimeSignatureInput } from './TimeSignatureInput';
export type { TimeSignatureInputProps, TimeSignatureInputSize } from './TimeSignatureInput';

// NativeSelect
export { NativeSelect } from './NativeSelect';
export type {
  NativeSelectProps,
  NativeSelectOption,
  NativeSelectSize,
  NativeSelectVariant,
} from './NativeSelect';

// Knob
export { Knob } from './Knob';
export type { KnobProps, KnobSize, KnobVariant } from './Knob';

// Modal
export { Modal, ModalHeader, ModalContent, ModalFooter } from './Modal';
export type {
  ModalProps,
  ModalHeaderProps,
  ModalContentProps,
  ModalFooterProps,
  ModalSize,
} from './Modal';

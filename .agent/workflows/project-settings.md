---
description: Project-specific settings and preferences for Studio13-v3
---

# Project Settings

## Build Verification

- **Do NOT auto-run build verification commands** after making code changes
- **Do NOT proactively check if builds work** - the user will inform you if something is broken
- Only run build commands when explicitly requested by the user

## Error Handling

- If you encounter an issue while making edits, **ask the user** what to do rather than terminating or assuming
- If an edit fails twice, stop and ask for guidance
- **If you face the same issue THREE times, STOP and ask the user for help**

## Coding Standards

- **Use Tailwind CSS** as much as possible instead of custom CSS files
- **Create and use reusable components** - avoid duplicating code
- **Do NOT use SVGs directly** unless absolutely necessary - use a free icon library (e.g., Phosphor Icons or similar)
- **Keep code modular** - don't keep increasing lines of code in one file; split into smaller components/utilities

## UI Component Library

All UI components are located in `frontend/src/components/ui/` and should be used instead of raw HTML elements:

### Available Components

- **Button**: For all buttons (transport, track controls, modal actions)
  - Variants: `default`, `primary`, `secondary`, `success`, `warning`, `danger`, `purple`, `orange`, `emerald`, `ghost`
  - Sizes: `xs`, `sm`, `md`, `lg`, `icon-sm`, `icon-md`, `icon-lg`
  - Special features: `active` state, `activeStyle` (solid/glow/subtle), `shape` (default/circle/square)
  - Example: `<Button variant="success" size="icon-lg" active={isPlaying}>▶</Button>`

- **Input**: For text, number, and other input fields
  - Variants: `default`, `inline`, `transparent`, `compact`
  - Sizes: `xs`, `sm`, `md`, `lg`
  - Features: label, helperText, error, unit suffix, centerText
  - Example: `<Input variant="default" size="md" fullWidth label="Project Name" />`

- **Textarea**: For multi-line text input
  - Variants: `default`
  - Sizes: `sm`, `md`, `lg`
  - Example: `<Textarea label="Notes" rows={4} placeholder="..." />`

- **Select**: For dropdown selections
  - Variants: `default`, `compact`, `accent`
  - Sizes: `xs`, `sm`, `md`, `lg`
  - Takes `options` prop: `[{ value: string | number, label: string }]`
  - Example: `<Select variant="default" size="md" options={[...]} value={...} onChange={...} />`

- **Checkbox**: For boolean options
  - Sizes: `sm`, `md`
  - Example: `<Checkbox label="Normalize" checked={...} onChange={...} />`

- **Slider**: For range inputs (horizontal and vertical faders)
  - Orientations: `horizontal`, `vertical`
  - Example: `<Slider orientation="vertical" value={...} onChange={...} />`

- **Modal**: For all modal dialogs
  - Built on @headlessui/react Dialog for accessibility
  - Sizes: `sm`, `md`, `lg`, `xl`
  - Subcomponents: `ModalHeader`, `ModalContent`, `ModalFooter`
  - Example:
    ```tsx
    <Modal isOpen={...} onClose={...} size="md">
      <ModalHeader title="Settings" onClose={...} />
      <ModalContent>
        {/* content */}
      </ModalContent>
      <ModalFooter>
        <Button variant="secondary">Cancel</Button>
        <Button variant="primary">Apply</Button>
      </ModalFooter>
    </Modal>
    ```

### Usage Guidelines

- **Always use component library components** instead of raw `<button>`, `<input>`, `<select>`, `<textarea>`, etc.
- **Use existing variants** before creating custom styles
- **Use className prop sparingly** - only for one-off custom styling that can't be achieved with variants
- **Maintain accessibility** - always provide `title` or `aria-label` for icon-only buttons
- **Import from barrel export**: `import { Button, Input, Select } from './ui'`

### Component Reference Files

- [Button.tsx](frontend/src/components/ui/Button/Button.tsx) - Full JSDoc with examples
- [Input.tsx](frontend/src/components/ui/Input/Input.tsx)
- [Select.tsx](frontend/src/components/ui/Select/Select.tsx)
- [Checkbox.tsx](frontend/src/components/ui/Checkbox/Checkbox.tsx)
- [Textarea.tsx](frontend/src/components/ui/Textarea/Textarea.tsx)
- [Slider.tsx](frontend/src/components/ui/Slider/Slider.tsx)
- [Modal.tsx](frontend/src/components/ui/Modal/Modal.tsx)

## General Workflow

- Make the requested changes directly
- Trust the user to test and report any issues
- Keep explanations concise unless the user asks for details

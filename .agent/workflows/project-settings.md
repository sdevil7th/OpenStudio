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

## General Workflow

- Make the requested changes directly
- Trust the user to test and report any issues
- Keep explanations concise unless the user asks for details

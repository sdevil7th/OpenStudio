"""Resolve the OpenStudio ACE split runtime payload."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable


REQUIRED_BACKEND_RELATIVE_PATHS: tuple[Path, ...] = (
    Path("nodes.py"),
    Path("folder_paths.py"),
    Path("comfy") / "sd.py",
    Path("comfy_extras") / "nodes_ace.py",
    Path("comfy_aimdo") / "__init__.py",
)


def missing_backend_paths(root: Path) -> list[str]:
    return [str(root / relative) for relative in REQUIRED_BACKEND_RELATIVE_PATHS if not (root / relative).exists()]


def is_complete_backend_root(root: Path) -> bool:
    return bool(root) and not missing_backend_paths(root)


def _candidate_variants(root: Path) -> Iterable[Path]:
    yield root
    yield root / "vendor_runtime"
    yield root / "openstudio_ace_backend" / "vendor_runtime"
    yield root / "scripts" / "openstudio_ace_backend" / "vendor_runtime"


def _known_comfy_roots() -> Iterable[Path]:
    home = Path.home()
    env_roots = (
        os.environ.get("COMFYUI_ROOT", ""),
        os.environ.get("COMFYUI_PATH", ""),
    )
    for value in env_roots:
        if value.strip():
            yield Path(value).expanduser()
    yield home / "Documents" / "ComfyUI"
    yield home / "Documents" / "Codes" / "ComfyUI"
    yield home / "ComfyUI"


def iter_backend_candidates(script_path: Path | None = None) -> list[Path]:
    if script_path is not None:
        script_dir = Path(script_path).resolve().parent
    else:
        script_dir = Path(__file__).resolve().parents[1]

    candidates: list[Path] = []
    env_backend = os.environ.get("OPENSTUDIO_ACE_BACKEND_ROOT", "").strip()
    if env_backend:
        candidates.extend(_candidate_variants(Path(env_backend).expanduser()))

    candidates.append(script_dir / "openstudio_ace_backend" / "vendor_runtime")

    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        local_root = Path(local_app_data).expanduser() / "OpenStudio"
        candidates.extend(
            [
                local_root / "ace-backend" / "vendor_runtime",
                local_root / "runtime" / "ace-split" / "vendor_runtime",
            ]
        )

    for ancestor in (script_dir, *script_dir.parents):
        candidates.extend(
            [
                ancestor / "tools" / "openstudio_ace_backend" / "vendor_runtime",
                ancestor
                / "build-check"
                / "OpenStudio_artefacts"
                / "Release"
                / "scripts"
                / "openstudio_ace_backend"
                / "vendor_runtime",
                ancestor
                / "build"
                / "OpenStudio_artefacts"
                / "Release"
                / "scripts"
                / "openstudio_ace_backend"
                / "vendor_runtime",
            ]
        )
    candidates.extend(_known_comfy_roots())

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        key = str(resolved).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(resolved)
    return unique


def resolve_backend_root(script_path: Path | None = None) -> Path | None:
    for candidate in iter_backend_candidates(script_path):
        if is_complete_backend_root(candidate):
            return candidate
    return None


def backend_status(script_path: Path | None = None) -> tuple[bool, str, list[str]]:
    candidates = iter_backend_candidates(script_path)
    resolved = resolve_backend_root(script_path)
    if resolved is not None:
        return True, str(resolved), []

    primary = candidates[0] if candidates else Path()
    return False, str(primary), missing_backend_paths(primary)

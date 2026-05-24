#!/usr/bin/env python3
"""Prepare the ignored OpenStudio ACE vendor runtime from a local ComfyUI checkout."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path


SCRIPT_ROOT = Path(__file__).resolve().parent
DEFAULT_DESTINATION = SCRIPT_ROOT / "openstudio_ace_backend" / "vendor_runtime"
PREFERRED_SOURCE = Path(r"C:\Users\srvds\Documents\Codes\ComfyUI")

REQUIRED_RELATIVE_PATHS = (
    "nodes.py",
    "folder_paths.py",
    "comfy/sd.py",
    "comfy_extras/nodes_ace.py",
)

ROOT_FILES = (
    "nodes.py",
    "folder_paths.py",
    "node_helpers.py",
    "latent_preview.py",
    "cuda_malloc.py",
    "comfyui_version.py",
    "LICENSE",
)

PACKAGE_DIRS = (
    "comfy",
    "comfy_extras",
    "comfy_execution",
    "comfy_api",
    "comfy_api_nodes",
    "utils",
)

IGNORED_NAMES = {
    ".git",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "tests",
    "tests-unit",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", default=[], help="ComfyUI source root candidate.")
    parser.add_argument("--destination", default=str(DEFAULT_DESTINATION), help="Vendor runtime destination.")
    parser.add_argument(
        "--required",
        action="store_true",
        help="Exit non-zero if no valid ComfyUI source can be found.",
    )
    return parser.parse_args()


def candidate_sources(extra_sources: list[str]) -> list[Path]:
    home = Path.home()
    raw_candidates = [
        *extra_sources,
        str(PREFERRED_SOURCE),
        os.environ.get("OPENSTUDIO_COMFYUI_ROOT", ""),
        os.environ.get("COMFYUI_ROOT", ""),
        str(home / "Documents" / "Codes" / "ComfyUI"),
        str(home / "Documents" / "ComfyUI"),
        str(home / "ComfyUI"),
    ]

    candidates: list[Path] = []
    seen: set[str] = set()
    for raw in raw_candidates:
        if not raw or not str(raw).strip():
            continue
        try:
            path = Path(raw).expanduser().resolve()
        except OSError:
            path = Path(raw).expanduser()
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        candidates.append(path)
    return candidates


def missing_required(root: Path) -> list[str]:
    return [relative for relative in REQUIRED_RELATIVE_PATHS if not (root / relative).is_file()]


def find_source(extra_sources: list[str]) -> tuple[Path | None, dict[str, list[str]]]:
    searched: dict[str, list[str]] = {}
    for candidate in candidate_sources(extra_sources):
        missing = missing_required(candidate)
        searched[str(candidate)] = missing
        if not missing:
            return candidate, searched
    return None, searched


def assert_safe_destination(destination: Path) -> None:
    resolved = destination.resolve()
    tail = [part.lower() for part in resolved.parts[-2:]]
    if tail != ["openstudio_ace_backend", "vendor_runtime"]:
        raise SystemExit(
            "Refusing to write ACE vendor runtime outside openstudio_ace_backend/vendor_runtime: "
            + str(resolved)
        )


def ignore_names(_directory: str, names: list[str]) -> set[str]:
    return {name for name in names if name in IGNORED_NAMES or name.endswith((".pyc", ".pyo"))}


def copy_runtime(source: Path, destination: Path) -> dict[str, list[str] | str]:
    assert_safe_destination(destination)
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)

    copied_files: list[str] = []
    copied_dirs: list[str] = []

    for file_name in ROOT_FILES:
        source_file = source / file_name
        if not source_file.is_file():
            continue
        shutil.copy2(source_file, destination / file_name)
        copied_files.append(file_name)

    for directory_name in PACKAGE_DIRS:
        source_dir = source / directory_name
        if not source_dir.is_dir():
            continue
        shutil.copytree(
            source_dir,
            destination / directory_name,
            ignore=ignore_names,
            dirs_exist_ok=True,
        )
        copied_dirs.append(directory_name)

    missing_after_copy = missing_required(destination)
    if missing_after_copy:
        raise SystemExit(
            "Prepared ACE vendor runtime is still missing: " + ", ".join(missing_after_copy)
        )

    manifest = {
        "source": str(source),
        "destination": str(destination),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "copiedFiles": copied_files,
        "copiedDirs": copied_dirs,
        "requiredRelativePaths": list(REQUIRED_RELATIVE_PATHS),
    }
    (destination / "openstudio-vendor-runtime.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    args = parse_args()
    destination = Path(args.destination).expanduser()
    source, searched = find_source(args.source)

    if source is None:
        message = (
            "OpenStudio ACE vendor runtime was not prepared because no valid ComfyUI source "
            "checkout was found. Searched: "
            + "; ".join(f"{path} missing [{', '.join(missing)}]" for path, missing in searched.items())
        )
        print("WARNING: " + message, file=sys.stderr)
        return 2 if args.required else 0

    manifest = copy_runtime(source, destination)
    print(
        "Prepared OpenStudio ACE vendor runtime from "
        + manifest["source"]
        + " -> "
        + manifest["destination"]
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

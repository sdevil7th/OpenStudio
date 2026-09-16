"""Stage an optional AI package beside a working runtime, never inside it.

The immutable environment stays at its creation path (venv launchers contain
absolute paths). A small manifest is published atomically after import checks.
Publication means an experiment is importable, not that audio is qualified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import uuid

RECIPES = {"int8": {"package": "bitsandbytes", "version": "0.50.2"}}


def run(command, timeout=300):
    result = subprocess.run(list(map(str, command)), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError(result.stdout[-4000:] + result.stderr[-4000:])
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-python", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--candidate", choices=RECIPES, required=True)
    args = parser.parse_args()
    recipe = RECIPES[args.candidate]
    root = args.output_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    if sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink()) > 2*1024**3:
        raise RuntimeError("Candidate cache exceeds its 2-GiB quota; review old experiments before staging more.")
    python = args.runtime_python.resolve(strict=True)
    # Query only interpreter/package provenance; no model or kernel execution.
    baseline = json.loads(run([python, "-c",
        "import sys,sysconfig,json,importlib.metadata as m; print(json.dumps({"
        "'python':sys.version,'site':sysconfig.get_path('purelib'),"
        "'packages':{p:m.version(p) for p in ('torch','diffusers','transformers','accelerate')}}))"]))
    environment = root / (args.candidate + "-" + uuid.uuid4().hex)
    environment.mkdir()
    record = {"candidate": args.candidate, "recipe": recipe, "baseRuntime": str(python),
              "baseline": baseline, "state": "staging", "audioQuality": "not_asserted"}
    manifest = environment / "candidate.json"
    try:
        manifest.write_text(json.dumps(record, indent=2), encoding="utf-8")
        run([python, "-m", "venv", environment])
        staged_python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        site = Path(run([staged_python, "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"]))
        # Read the base runtime's pinned packages. Candidate site-packages comes
        # first, and pip is always run with --no-deps so it cannot replace them.
        (site / "openstudio-base-runtime.pth").write_text(baseline["site"] + "\n", encoding="utf-8")
        wheels = environment / "wheels"
        wheels.mkdir()
        spec = recipe["package"] + "==" + recipe["version"]
        run([staged_python, "-m", "pip", "download", "--disable-pip-version-check",
             "--index-url", "https://pypi.org/simple", "--only-binary=:all:", "--no-deps",
             "--dest", wheels, spec])
        downloaded = list(wheels.glob("*.whl"))
        if len(downloaded) != 1:
            raise RuntimeError("Expected exactly one reviewed optional-package wheel.")
        wheel = downloaded[0]
        with urllib.request.urlopen(f"https://pypi.org/pypi/{recipe['package']}/{recipe['version']}/json", timeout=30) as response:
            release = json.load(response)
        expected = next((item["digests"]["sha256"] for item in release["urls"]
                         if item["filename"] == wheel.name), None)
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        if not expected or digest != expected:
            raise RuntimeError("Optional wheel failed the official PyPI release hash check.")
        run([staged_python, "-m", "pip", "install", "--disable-pip-version-check", "--no-index", "--no-deps", wheel])
        # Compare the inherited stack after installation, not just before it.
        observed = json.loads(run([staged_python, "-c",
            "import json,importlib.metadata as m,torch,bitsandbytes; print(json.dumps({"
            "p:m.version(p) for p in ('torch','diffusers','transformers','accelerate')}))"]))
        if observed != baseline["packages"]:
            raise RuntimeError("Candidate changed the pinned base stack.")
        record.update(state="import_only", python=str(staged_python), wheel=wheel.name, sha256=digest,
                      qualification="Operator and complete audio workflows still require qualification.")
        manifest.write_text(json.dumps(record, indent=2), encoding="utf-8")
        temporary = root / (args.candidate + "." + uuid.uuid4().hex + ".tmp")
        temporary.write_text(json.dumps(record, indent=2), encoding="utf-8")
        temporary.replace(root / (args.candidate + ".json"))
        print(json.dumps(record, indent=2))
        return 0
    except BaseException as exc:
        record.update(state="failed", error=f"{type(exc).__name__}: {exc}")
        manifest.write_text(json.dumps(record, indent=2), encoding="utf-8")
        raise


if __name__ == "__main__":
    raise SystemExit(main())

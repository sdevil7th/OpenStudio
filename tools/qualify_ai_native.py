#!/usr/bin/env python3
"""Drive the built app's real AI installer and separator without opening a window.

Creates a new, marked test directory. All runtime installation and activation
remain inside it. Cached archives/models can be reused without modifying them.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

from qualify_stem_installation import read_catalog


def qualification_environment(root: Path) -> dict[str, str]:
    """Keep a workstation's generation snapshots out of isolated stem tests."""
    cache = root.resolve() / "huggingface-cache"
    return dict(os.environ, HF_HOME=str(cache), HF_HUB_CACHE=str(cache / "hub"),
                HUGGINGFACE_HUB_CACHE=str(cache / "hub"))


def hide_owned_separator_metadata(root: Path, runtime: Path) -> tuple[Path, Path]:
    """A reversible, test-only incompatibility; never touch an external runtime."""
    root, runtime = root.resolve(), runtime.resolve()
    if (root / ".openstudio-ai-qualification").read_text().strip() != "owned-test-data-v1" or not runtime.is_relative_to(root):
        raise ValueError("Automatic repair fixtures require an owned runtime beneath the qualification root")
    candidates = list(runtime.rglob("audio_separator-*.dist-info"))
    if len(candidates) != 1:
        raise ValueError("Expected one audio-separator distribution in the owned runtime")
    original = candidates[0].resolve()
    hidden = original.with_name(".openstudio-qa-separator-" + uuid.uuid4().hex).resolve()
    if not original.is_relative_to(runtime) or not hidden.is_relative_to(runtime):
        raise ValueError("Metadata fixture escaped its owned runtime")
    original.rename(hidden)
    return original, hidden


def require_gpu_placement(report: dict, expected_backend: str) -> None:
    if expected_backend not in {"cuda", "rocm"} or report.get("status") != "pass":
        return
    receipt = report.get("diagnostics", {}).get("deviceReceipt", {})
    devices = receipt.get("parameterBytesByDevice", {})
    if not devices or not all(name.startswith("cuda:") for name in devices) or receipt.get("cudaPeakAllocatedBytes", 0) <= 0:
        raise RuntimeError("Native transport did not retain actual GPU placement/allocation evidence")


def qualify_automatic_repair(root: Path, app: Path, config: dict, report: dict, timeout: int) -> None:
    """Require exclusive maintenance and real separation of a deliberately incompatible owned runtime."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    original, hidden = hide_owned_separator_metadata(root, Path(report["activeRuntime"]))
    try:
        # This fixture represents Automatic setup. The separate native
        # policy tests verify preservation of an explicit CPU-only choice.
        (root / "user-data/ai-runtime-preference.json").write_text('{"cpuOnly":false}', encoding="utf-8")
        automatic = dict(config, install=False, automaticRuntimeMaintenance=True, testBusyDeferral=True,
                         expectAutomaticState="current", expectAutomaticInstall=True, accelerationMode="auto")
        automatic_file = root / "automatic-upgrade.json"
        automatic_file.write_text(json.dumps(automatic, indent=2), encoding="utf-8")
        with (root / "automatic-upgrade.log").open("wb") as log:
            completed = subprocess.run([str(Path(app).resolve()), "--ai-native-qualification", str(automatic_file)],
                stdout=log, stderr=subprocess.STDOUT, creationflags=flags, env=qualification_environment(root),
                timeout=timeout + 60, check=False)
        automatic_report = json.loads((root / "native-result-automatic-upgrade.json").read_text(encoding="utf-8"))
        if (completed.returncode or automatic_report.get("status") != "pass"
                or not automatic_report.get("observedAutomaticInstall")
                or automatic_report.get("busyDeferral") != "pass"
                or automatic_report.get("recordingExcludedThroughoutRepair") is not True):
            raise RuntimeError("Exclusive AI runtime repair did not activate and separate: " + str(automatic_report.get("error")))
        require_gpu_placement(automatic_report, config["expectedBackend"])
        print(json.dumps({"automaticRuntimeRepair":"pass","backend":automatic_report.get("backend")}),flush=True)
    finally:
        # Both resolved targets were checked above. Keep the previous slot
        # intact after the deliberate metadata fault, including on failure.
        if hidden.exists() and not original.exists():
            hidden.rename(original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--archive-cache")
    parser.add_argument("--models-cache")
    parser.add_argument("--input", required=True)
    parser.add_argument("--expected-backend", required=True)
    parser.add_argument("--acceleration-mode", choices=["auto", "cpu-only"], default="auto")
    parser.add_argument("--chunk-duration", type=int, choices=[0, 30], default=0)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--automatic-repair-regression", action="store_true",
                        help="After fresh setup, test exclusive maintenance on a reversible owned compatibility failure")
    args = parser.parse_args()
    root = Path(args.output_dir).resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / ".openstudio-ai-qualification").write_text("owned-test-data-v1\n")
    if shutil.disk_usage(root).free < 12 * 1024**3:
        raise SystemExit("Native qualification needs at least 12 GiB free for its isolated runtime")
    catalog = read_catalog(args.catalog)
    if args.archive_cache:
        def localize(node):
            if isinstance(node, dict):
                if node.get("fileName") and node.get("sha256") and node.get("url"):
                    cached = Path(args.archive_cache).resolve() / Path(node["fileName"]).name
                    if cached.is_file():
                        digest = hashlib.sha256()
                        with cached.open("rb") as source:
                            for block in iter(lambda: source.read(1024*1024), b""):
                                digest.update(block)
                        if digest.hexdigest().lower() != node["sha256"].lower():
                            raise ValueError("Cached archive hash mismatch")
                        node["url"] = cached.as_uri()
                for value in node.values():
                    localize(value)
            elif isinstance(node, list):
                for value in node:
                    localize(value)
        localize(catalog)
    manifest = root / "catalog.json"
    manifest.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    if args.models_cache:
        models = root / "user-data/models"
        models.mkdir(parents=True)
        for name in ["BS-Roformer-SW.ckpt", "BS-Roformer-SW.yaml", "download_checks.json"]:
            source = Path(args.models_cache) / name
            if source.is_file():
                shutil.copy2(source, models / name)
    config = {"input": str(Path(args.input).resolve()), "manifestUrl": manifest.as_uri(),
              "expectedBackend": args.expected_backend, "timeoutSeconds": args.timeout,
              "accelerationMode": args.acceleration_mode, "chunkDuration": args.chunk_duration,
              "install": True}
    config_file = root / "configuration.json"
    config_file.write_text(json.dumps(config, indent=2), encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    with (root / "native-host.log").open("wb") as log:
        process = subprocess.Popen([str(Path(args.app).resolve()), "--ai-native-qualification", str(config_file)],
                                   stdout=log, stderr=subprocess.STDOUT, creationflags=flags,
                                   env=qualification_environment(root))
        try:
            result = process.wait(timeout=args.timeout + 60)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=15)
            raise
    report = json.loads((root / "native-result.json").read_text(encoding="utf-8"))
    require_gpu_placement(report, args.expected_backend)
    print(json.dumps({"status": report.get("status"), "backend": report.get("backend"),
                      "error": report.get("error"), "exitCode": result}), flush=True)
    if result != 0 or report.get("status") != "pass":
        return 1
    if args.automatic_repair_regression:
        qualify_automatic_repair(root, Path(args.app), config, report, args.timeout)
    return 0


if __name__ == "__main__":
    sys.exit(main())

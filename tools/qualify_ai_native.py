#!/usr/bin/env python3
"""Drive the built app's real AI installer and separator without opening a window.

Creates a new, marked test directory. All runtime installation and activation
remain inside it. Cached archives/models can be reused without modifying them.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

from qualify_stem_installation import read_catalog


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
                                   stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            result = process.wait(timeout=args.timeout + 60)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=15)
            raise
    report = json.loads((root / "native-result.json").read_text(encoding="utf-8"))
    receipt = report.get("diagnostics", {}).get("deviceReceipt", {})
    if args.expected_backend in {"cuda", "rocm"} and report.get("status") == "pass":
        devices = receipt.get("parameterBytesByDevice", {})
        if not devices or not all(name.startswith("cuda:") for name in devices) or receipt.get("cudaPeakAllocatedBytes", 0) <= 0:
            raise RuntimeError("Native transport did not retain actual GPU placement/allocation evidence")
    print(json.dumps({"status": report.get("status"), "backend": report.get("backend"),
                      "error": report.get("error"), "exitCode": result}), flush=True)
    return 0 if result == 0 and report.get("status") == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())

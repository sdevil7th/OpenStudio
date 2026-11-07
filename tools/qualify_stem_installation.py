#!/usr/bin/env python3
"""Real installer -> probe -> six-stem inference qualification, on the host hardware.

Uses isolated runtime copies; never activates them in the app. Fresh Windows
cases can consume the public catalog/archive (including legacy plans). Existing
cases copy --base-runtime, so the user's runtime is never modified. Reports
cannot qualify hardware that did not execute this command.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen
import zipfile


def read_catalog(source):
    if source.startswith("https://"):
        with urlopen(source, timeout=60) as response:
            return json.load(response)
    return json.loads(Path(source).read_text(encoding="utf-8"))


def installer_terminal(path):
    terminal = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and value.get("state"):
                terminal = value
        except ValueError:
            pass
    return terminal


def expected_runtime_backend(requested_backend, model_backend):
    # A generic DirectML runtime is ready even though RoFormer must execute
    # on CPU. Likewise a valid CUDA runtime can select CPU for a tight budget.
    return requested_backend if requested_backend != "cpu" else model_backend


def fresh_catalog_runtime(catalog, cache, destination):
    platform = "windows" if sys.platform == "win32" else "linux"
    base = catalog["platforms"][platform]["base" if platform == "windows" else "x64"]
    archive = cache / Path(base["fileName"]).name
    cache.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        with urlopen(base["url"], timeout=120) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    digest = digest.hexdigest()
    if digest.lower() != base["sha256"].lower():
        raise ValueError("Runtime archive SHA-256 mismatch")
    unpack = destination.parent / (destination.name + "-unpack")
    unpack.mkdir()
    with zipfile.ZipFile(archive) as bundle:
        # No archive entry may escape this fresh extraction directory.
        for entry in bundle.infolist():
            if not (unpack / entry.filename).resolve().is_relative_to(unpack.resolve()):
                raise ValueError("Unsafe runtime archive path")
        bundle.extractall(unpack)
        if sys.platform != "win32":
            for entry in bundle.infolist():
                mode = entry.external_attr >> 16
                if mode & 0o111:
                    (unpack / entry.filename).chmod(mode & 0o777)
    candidates = list(unpack.rglob(".openstudio-ai-runtime.json"))
    if len(candidates) != 1:
        raise ValueError("Unexpected base runtime layout")
    shutil.copytree(candidates[0].parent, destination)
    return {"url": base["url"], "sha256": digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, help="New directory; existing paths are refused")
    parser.add_argument("--base-runtime", help="Prepared fresh base or existing runtime to copy, never modify")
    parser.add_argument("--catalog", help="Public catalog URL or saved JSON; required without --base-runtime")
    parser.add_argument("--archive-cache", default=".cache/stem-qualification")
    parser.add_argument("--install-plan", help="Saved downloaded plan; otherwise use catalog or repository plan")
    parser.add_argument("--tools-dir", default=str(Path(__file__).resolve().parent),
                        help="Installer and worker assets, optionally from the built app's scripts directory")
    parser.add_argument("--backend", required=True, choices=["cuda", "rocm", "directml", "cpu"])
    parser.add_argument("--expected-auto-backend", required=True, choices=["cuda", "rocm", "cpu", "mps", "coreml"])
    parser.add_argument("--features", default="stemSeparation", choices=["stemSeparation", "stemSeparation,audioGeneration"])
    parser.add_argument("--skip-generation-checkpoints", action="store_true",
                        help="Test both dependency paths without downloading unrelated generation checkpoints; reported as not_asserted")
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--input", help="Default: deterministic non-silent 31-second stereo fixture")
    parser.add_argument("--timeout", type=int, default=3600)
    args = parser.parse_args()
    root = Path(args.output_dir).resolve()
    root.mkdir(parents=True, exist_ok=False)
    runtime = root / "runtime"
    report = {"status": "fail", "backendRequested": args.backend, "features": args.features,
              "runtimeOrigin": str(Path(args.base_runtime).resolve()) if args.base_runtime else "catalog",
              "generationCheckpointDownload": "not_asserted" if args.skip_generation_checkpoints else "installer_default",
              "subjectiveAudioQuality": "not_asserted"}
    report["expectedRuntimeBackend"] = expected_runtime_backend(args.backend, args.expected_auto_backend)
    started = time.monotonic()
    tools = Path(args.tools_dir).resolve()
    report["toolsDirectory"] = str(tools)
    try:
        report["sourceSha256"] = {name: hashlib.sha256((tools / name).read_bytes()).hexdigest()
            for name in ("install_ai_tools.py", "stem_separator.py", "ai_memory_manager.py")}
        catalog = read_catalog(args.catalog) if args.catalog else None
        if args.base_runtime:
            shutil.copytree(Path(args.base_runtime).resolve(), runtime)
        else:
            if sys.platform not in {"win32", "linux"} or catalog is None:
                raise ValueError("Supply --base-runtime for this platform")
            report["archive"] = fresh_catalog_runtime(catalog, Path(args.archive_cache).resolve(), runtime)
        python = runtime / ("python/python.exe" if sys.platform == "win32" else "bin/python")
        if not python.exists():
            python = runtime / "python/bin/python3"
        if not python.exists():
            raise ValueError("No runtime interpreter found")
        # Refuse borrowed site-packages/.pth environments before pip could
        # uninstall a distribution outside this disposable runtime copy.
        subprocess.run([str(python), "-c",
            "import importlib.metadata as m,pathlib,sys; root=pathlib.Path(sys.argv[1]).resolve(); "
            "outside=[str(d.locate_file('').resolve()) for d in m.distributions() "
            "if not d.locate_file('').resolve().is_relative_to(root)]; "
            "assert not outside, 'Runtime borrows external packages: '+repr(outside)", str(runtime)],
            check=True, timeout=60)
        installer_args = ["--runtime-root", str(runtime), "--models-dir", str(Path(args.models_dir).resolve()),
                          "--verify-existing-runtime", "--backend-requested", args.backend,
                          "--features", args.features, "--log-path", str(root / "installer-detail.log")]
        if args.install_plan:
            plan = json.loads(Path(args.install_plan).read_text(encoding="utf-8"))
        elif catalog is not None and args.backend != "cpu":
            platform = "windows" if sys.platform == "win32" else "linux"
            plan = catalog["platforms"][platform]["backends"][args.backend]["installPlan"]
        elif args.backend != "cpu" or (args.features == "stemSeparation" and sys.platform in {"win32", "linux"}):
            platform = "windows" if sys.platform == "win32" else "linux"
            plan = json.loads((tools / f"ai-runtime-install-plan-{platform}-{args.backend}.json").read_text())
        else:
            # Explicit CPU qualification needs the same real dependency install
            # rather than silently borrowing the invoking Python's packages.
            both = ["stemSeparation", "audioGeneration"]
            plan = {"schemaVersion": 1, "id": "qualification-cpu", "backend": "cpu", "steps": [
                {"type": "pip_install", "features": both, "indexUrl": "https://download.pytorch.org/whl/cpu",
                 "packages": ["torch==2.11.0", "torchvision==0.26.0", "torchaudio==2.11.0"]},
                {"type": "pip_install", "features": both,
                 "packages": ["audio-separator[cpu]==0.41.1", "librosa==0.11.0", "audioread==3.1.0"]},
                {"type": "pip_install", "features": ["audioGeneration"],
                 "packages": ["diffusers==0.39.0", "transformers==4.57.6", "accelerate==1.12.0", "huggingface_hub>=0.34,<1.0"]},
            ]}
        if plan is not None:
            plan_path = root / "downloaded-plan.json"
            plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
            installer_args += ["--backend-install-plan", str(plan_path)]
        # The installer, feature filtering, pip commands, hardware probe, model
        # download/verification and terminal result all run normally. Only the
        # unrelated generation checkpoint download can be explicitly excluded.
        launcher = root / "installer-launcher.py"
        launcher.write_text(
            "import sys\nsys.path.insert(0, " + repr(str(tools)) + ")\nimport install_ai_tools as installer\n" +
            ("installer.download_music_gen_model = lambda *a, **k: None\n" if args.skip_generation_checkpoints else "") +
            "installer.main()\n", encoding="utf-8")
        with (root / "installer.log").open("wb") as log:
            installed = subprocess.run([str(python), "-u", str(launcher), *installer_args],
                                       stdout=log, stderr=subprocess.STDOUT, timeout=args.timeout)
        report["installerExitCode"] = installed.returncode
        # The app consumes this log. With --log-path the installer deliberately
        # avoids stdout so an undrained pipe cannot deadlock a long install.
        terminal = installer_terminal(root / "installer-detail.log")
        report["installerTerminal"] = terminal
        if installed.returncode or terminal.get("state") != "ready":
            raise RuntimeError("Installer did not reach ready; see installer.log")
        if terminal.get("selectedBackend") != report["expectedRuntimeBackend"]:
            raise RuntimeError("Installer selected the wrong backend (unexpected fallback)")
        with (root / "pip-check.log").open("wb") as log:
            checked = subprocess.run([str(python), "-m", "pip", "check"], stdout=log, stderr=subprocess.STDOUT, timeout=120)
        if checked.returncode:
            raise RuntimeError("Runtime dependency consistency failed; see pip-check.log")
        if args.input:
            fixture = Path(args.input).resolve()
        else:
            fixture = root / "fixture-31s.wav"
            subprocess.run([str(python), "-c",
                "import numpy as n,soundfile as s,sys; t=n.arange(31*44100)/44100; "
                "x=.15*n.sin(2*n.pi*220*t)+.08*n.sin(2*n.pi*493*t); s.write(sys.argv[1],n.stack([x,x*.9],axis=1),44100)",
                str(fixture)], check=True, timeout=120)
        command = [str(python), str(Path(__file__).with_name("qualify_stem_worker.py")),
                   "--worker-script", str(tools / "stem_separator.py"), "--input", str(fixture),
                   "--models-dir", str(Path(args.models_dir).resolve()), "--output-dir", str(root / "separation"),
                   "--expected-auto-backend", args.expected_auto_backend, "--timeout", str(args.timeout)]
        from qualify_stem_worker import worker_dependency_hashes
        report["separationSourceSha256"] = worker_dependency_hashes(tools/"stem_separator.py")
        with (root / "separation.log").open("wb") as log:
            separated = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=4 * args.timeout + 120)
        report["separation"] = json.loads((root / "separation/report.json").read_text())
        if separated.returncode:
            raise RuntimeError("Real-model separation matrix failed")
        # Continue through the same freshly installed/repaired interpreter.
        # A Python unit test or a globally installed Torch cannot substitute
        # for this installer-to-rolling-separation contract.
        streaming_command = [*command, "--memory-mode", "streaming-preview", "--sections", "0"]
        streaming_command[streaming_command.index("--output-dir")+1] = str(root/"streaming-separation")
        with (root/"streaming-separation.log").open("wb") as log:
            streaming = subprocess.run(streaming_command, stdout=log, stderr=subprocess.STDOUT,
                                       timeout=2*args.timeout+120)
        report["streamingSeparation"] = json.loads((root/"streaming-separation/report.json").read_text())
        if streaming.returncode:
            raise RuntimeError("Installed-runtime rolling separation matrix failed")
        report["status"] = "pass"
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        report["error"] = str(error)
    finally:
        report["elapsedSeconds"] = round(time.monotonic() - started, 3)
        (root / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("status", "elapsedSeconds", "error") if k in report}), flush=True)
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())

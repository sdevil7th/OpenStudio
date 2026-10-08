"""Check platform archive selection, published bytes and emitted release metadata."""

import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

import yaml

from tools.release_ai_runtime import ASSETS, MAX_RUNTIME_METADATA_BYTES, build_plan, validate_releases


ROOT = Path(__file__).resolve().parents[1]
SHELL = shutil.which("pwsh") or shutil.which("powershell")


def fixture_runtime_metadata(platform, version):
    architecture, family = {
        "windows": ("x64", "windows-base-x64"),
        "macos": ("arm64", "macos-arm64"),
        "linux": ("x64", "linux-cpu-x64"),
    }[platform]
    return {
        "schemaVersion": 3, "platform": platform, "architecture": architecture,
        "runtimeFamily": family, "runtimeVersion": version,
        "runtimeSource": {"pythonVersion": "3.11.15"},
    }


def write_fixture_archive(path, members):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("fixture-payload.txt", "Fixture only; no executable is run.")
        for name, content in members:
            archive.writestr(name, content)


def fixture_releases(plan, directory):
    releases = {}
    for platform, asset in plan["platforms"].items():
        path = directory / asset["fileName"]
        metadata = fixture_runtime_metadata(platform, asset["releaseTag"].rsplit("v", 1)[-1])
        write_fixture_archive(path, [(".openstudio-ai-runtime.json", json.dumps(metadata))])
        content = path.read_bytes()
        release = releases.setdefault(asset["releaseTag"], {
            "tag_name": asset["releaseTag"], "draft": False,
            "prerelease": False, "published_at": "2026-10-08T12:00:00Z", "assets": [],
        })
        release["assets"].append({
            "name": asset["fileName"], "browser_download_url": asset["url"],
            "size": len(content), "state": "uploaded",
            "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
        })
    return releases


class ReleaseAiRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.plan = build_plan("sdevil7th/OpenStudio", "0.0.14", "ai-runtime-v0.0.13", "ai-runtime-linux-v0.0.14")
        self.releases = fixture_releases(self.plan, self.directory)

    def replace_archive(self, platform, members=None, raw_content=None):
        selected = self.plan["platforms"][platform]
        path = self.directory / selected["fileName"]
        if raw_content is not None:
            path.write_bytes(raw_content)
        else:
            write_fixture_archive(path, members)
        content = path.read_bytes()
        published = next(asset for asset in self.releases[selected["releaseTag"]]["assets"]
                         if asset["name"] == selected["fileName"])
        # Reach metadata validation with bytes that match their published digest.
        published["size"] = len(content)
        published["digest"] = "sha256:" + hashlib.sha256(content).hexdigest()

    def test_nested_hidden_metadata_and_python_312_are_supported(self):
        metadata = fixture_runtime_metadata("macos", "0.0.13")
        metadata["runtimeSource"]["pythonVersion"] = "3.12.10"
        self.replace_archive("macos", [("runtime/.hidden/.openstudio-ai-runtime.json", json.dumps(metadata))])
        validate_releases(self.plan, self.releases, self.directory)

    def test_runtime_metadata_is_required_and_unique(self):
        metadata = json.dumps(fixture_runtime_metadata("windows", "0.0.13"))
        for members in ([], [("openstudio-ai-runtime.json", metadata)],
                        [(".openstudio-ai-runtime.json", metadata), ("prefix/.openstudio-ai-runtime.json", metadata)]):
            with self.subTest(members=[name for name, _ in members]):
                self.replace_archive("windows", members)
                with self.assertRaisesRegex(ValueError, "exactly one"):
                    validate_releases(self.plan, self.releases, self.directory)

    def test_invalid_zip_and_malformed_metadata_fail_closed(self):
        self.replace_archive("windows", raw_content=b"Not a ZIP archive")
        with self.assertRaisesRegex(ValueError, "invalid ZIP metadata"):
            validate_releases(self.plan, self.releases, self.directory)
        for content in (b"not json", b"\xff", b"[]", b"null"):
            with self.subTest(content=content):
                self.replace_archive("windows", [(".openstudio-ai-runtime.json", content)])
                with self.assertRaisesRegex(ValueError, "JSON"):
                    validate_releases(self.plan, self.releases, self.directory)

    def test_oversize_or_unsafe_runtime_metadata_is_rejected(self):
        metadata = json.dumps(fixture_runtime_metadata("windows", "0.0.13"))
        for name, content in ((".openstudio-ai-runtime.json", b" " * (MAX_RUNTIME_METADATA_BYTES + 1)),
                              ("../.openstudio-ai-runtime.json", metadata),
                              ("/.openstudio-ai-runtime.json", metadata)):
            with self.subTest(name=name, size=len(content)):
                self.replace_archive("windows", [(name, content)])
                with self.assertRaisesRegex(ValueError, "unsafe or exceeds"):
                    validate_releases(self.plan, self.releases, self.directory)

    def test_runtime_metadata_identity_and_schema_must_match(self):
        for platform in ASSETS:
            for field, value in (("platform", "other"), ("architecture", "other"),
                                 ("runtimeFamily", "other"), ("schemaVersion", 1), ("schemaVersion", True)):
                with self.subTest(platform=platform, field=field, value=value):
                    metadata = fixture_runtime_metadata(platform, "0.0.13")
                    metadata[field] = value
                    self.replace_archive(platform, [(".openstudio-ai-runtime.json", json.dumps(metadata))])
                    with self.assertRaisesRegex(ValueError, field):
                        validate_releases(self.plan, self.releases, self.directory)
            # Restore each platform so later assertions reach the intended archive.
            self.replace_archive(platform, [(".openstudio-ai-runtime.json", json.dumps(fixture_runtime_metadata(platform, "0.0.13")))])

    def test_published_python_310_metadata_is_rejected(self):
        for version in ("3.10.20", "3.9.9", "3.13.0", "3.11", "3.11.15-extra", None):
            with self.subTest(version=version):
                metadata = fixture_runtime_metadata("windows", "0.0.13")
                metadata["runtimeSource"]["pythonVersion"] = version
                self.replace_archive("windows", [(".openstudio-ai-runtime.json", json.dumps(metadata))])
                with self.assertRaisesRegex(ValueError, "Python 3.11 or 3.12"):
                    validate_releases(self.plan, self.releases, self.directory)

    def test_missing_runtime_source_and_unknown_archive_fail_closed(self):
        metadata = fixture_runtime_metadata("windows", "0.0.13")
        del metadata["runtimeSource"]
        self.replace_archive("windows", [(".openstudio-ai-runtime.json", json.dumps(metadata))])
        with self.assertRaisesRegex(ValueError, "Python 3.11 or 3.12"):
            validate_releases(self.plan, self.releases, self.directory)
        for change in ("unknown-platform", "unknown-filename"):
            with self.subTest(change=change):
                plan = copy.deepcopy(self.plan)
                if change == "unknown-platform":
                    plan["platforms"]["other"] = plan["platforms"].pop("windows")
                else:
                    plan["platforms"]["windows"]["fileName"] = "other.zip"
                with self.assertRaises(ValueError):
                    validate_releases(plan, self.releases, self.directory)

    def test_split_releases_keep_windows_and_macos_unchanged(self):
        self.assertEqual(self.plan["runtimeVersion"], "0.0.14")
        for platform, expected_tag in (
            ("windows", "ai-runtime-v0.0.13"), ("macos", "ai-runtime-v0.0.13"),
            ("linux", "ai-runtime-linux-v0.0.14"),
        ):
            asset = self.plan["platforms"][platform]
            self.assertEqual(asset["releaseTag"], expected_tag)
            self.assertEqual(asset["url"], f"https://github.com/sdevil7th/OpenStudio/releases/download/{expected_tag}/{ASSETS[platform]}")
        validate_releases(self.plan, self.releases, self.directory)

    def test_single_release_defaults_are_backward_compatible(self):
        for release_tag in ("", "ai-runtime-v0.0.13"):
            with self.subTest(release_tag=release_tag):
                plan = build_plan("sdevil7th/OpenStudio", "v0.0.13", release_tag)
                self.assertEqual(plan["runtimeVersion"], "0.0.13")
                self.assertEqual({node["releaseTag"] for node in plan["platforms"].values()}, {"ai-runtime-v0.0.13"})
                validate_releases(plan, fixture_releases(plan, self.directory), self.directory)

    def test_windows_upgrade_keeps_qualified_linux_archive(self):
        plan = build_plan("sdevil7th/OpenStudio", "0.0.15", "ai-runtime-v0.0.15", "ai-runtime-linux-v0.0.14")
        self.assertEqual(plan["runtimeVersion"], "0.0.15")
        self.assertEqual(plan["platforms"]["windows"]["releaseTag"], "ai-runtime-v0.0.15")
        self.assertEqual(plan["platforms"]["macos"]["releaseTag"], "ai-runtime-v0.0.15")
        self.assertEqual(plan["platforms"]["linux"]["releaseTag"], "ai-runtime-linux-v0.0.14")
        validate_releases(plan, fixture_releases(plan, self.directory), self.directory)

    def test_malformed_repository_version_or_release_tag_fails(self):
        for kwargs in (
            {"repository": "owner/repo/extra"}, {"runtime_version": "0.0.14-beta"},
            *({"release_tag": tag} for tag in ("../release", "tag/child", "-switch", "tag\nvalue", "$(command)", "tag..bad", "tag.")),
            {"linux_release_tag": "bad/tag"},
        ):
            with self.subTest(kwargs=kwargs):
                args = dict(repository="sdevil7th/OpenStudio", runtime_version="0.0.14")
                args.update(kwargs)
                with self.assertRaises(ValueError):
                    build_plan(**args)

    def test_only_exact_stable_published_releases_are_accepted(self):
        for property_name, value in (("tag_name", "other-tag"), ("draft", True), ("prerelease", True), ("published_at", None)):
            with self.subTest(property_name=property_name):
                releases = copy.deepcopy(self.releases)
                releases["ai-runtime-linux-v0.0.14"][property_name] = value
                with self.assertRaises(ValueError):
                    validate_releases(self.plan, releases)
        with self.assertRaises(ValueError):
            validate_releases(self.plan, {})

    def test_release_assets_require_unique_complete_expected_entries(self):
        tag = "ai-runtime-linux-v0.0.14"
        for changes in (
            {"name": "other.zip"}, {"browser_download_url": "https://github.com/other/repo/archive.zip"},
            {"state": "new"}, {"size": 0}, {"size": True}, {"digest": None},
            {"digest": "sha256:bad"},
        ):
            with self.subTest(changes=changes):
                releases = copy.deepcopy(self.releases)
                releases[tag]["assets"][0].update(changes)
                with self.assertRaises(ValueError):
                    validate_releases(self.plan, releases)
        releases = copy.deepcopy(self.releases)
        releases[tag]["assets"] *= 2
        with self.assertRaises(ValueError):
            validate_releases(self.plan, releases)

    def test_downloaded_bytes_must_match_published_size_and_digest(self):
        path = self.directory / ASSETS["linux"]
        original = path.read_bytes()
        for content in (b"", b"x" * len(original), original + b"tamper"):
            with self.subTest(content=content):
                path.write_bytes(content)
                with self.assertRaises(ValueError):
                    validate_releases(self.plan, self.releases, self.directory)
        path.unlink()
        with self.assertRaises(ValueError):
            validate_releases(self.plan, self.releases, self.directory)

    def test_command_line_round_trip_and_fail_closed(self):
        script = ROOT / "tools/release_ai_runtime.py"
        plan_path = self.directory / "selection.json"
        subprocess.run([
            sys.executable, str(script), "plan", "--repository", "sdevil7th/OpenStudio",
            "--runtime-version", "0.0.14", "--release-tag", "ai-runtime-v0.0.13",
            "--linux-release-tag", "ai-runtime-linux-v0.0.14", "--output", str(plan_path),
        ], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(plan_path.read_text()), self.plan)
        for tag, release in self.releases.items():
            (self.directory / f"{tag}.json").write_text(json.dumps(release), encoding="utf-8")
        command = [sys.executable, str(script), "verify", "--plan", str(plan_path),
                   "--releases-dir", str(self.directory), "--asset-dir", str(self.directory)]
        subprocess.run(command, check=True, capture_output=True, text=True)
        (self.directory / ASSETS["linux"]).write_bytes(b"corrupt")
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match", result.stderr)

    def test_command_line_rejects_published_python_310_without_traceback(self):
        metadata = fixture_runtime_metadata("windows", "0.0.13")
        metadata["runtimeSource"]["pythonVersion"] = "3.10.20"
        self.replace_archive("windows", [(".openstudio-ai-runtime.json", json.dumps(metadata))])
        plan_path = self.directory / "selection.json"
        plan_path.write_text(json.dumps(self.plan), encoding="utf-8")
        for tag, release in self.releases.items():
            (self.directory / f"{tag}.json").write_text(json.dumps(release), encoding="utf-8")
        result = subprocess.run([
            sys.executable, str(ROOT / "tools/release_ai_runtime.py"), "verify", "--plan", str(plan_path),
            "--releases-dir", str(self.directory), "--asset-dir", str(self.directory),
        ], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python 3.11 or 3.12", result.stderr)
        self.assertIn("3.10.20", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_workflow_uses_verified_selection_for_downloads_and_metadata(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
        job = workflow["jobs"]["publish"]
        self.assertEqual(job["env"]["AI_RUNTIME_LINUX_RELEASE_TAG"], "${{ vars.OPENSTUDIO_AI_RUNTIME_LINUX_RELEASE_TAG }}")
        steps = {step.get("name"): step.get("run", "") for step in job["steps"]}
        select = steps["Select and verify published AI runtime releases"]
        download = steps["Download AI runtime release assets"]
        metadata = steps["Generate checksums and updater metadata"]
        self.assertIn('releases/tags/$tag', select)
        self.assertIn('--linux-release-tag "$AI_RUNTIME_LINUX_RELEASE_TAG"', select)
        self.assertIn('--releases-dir dist/ai-runtime/releases', select)
        self.assertIn('--asset-dir dist/ai-runtime', download)
        self.assertIn('gh release download "$tag"', download)
        for platform in ASSETS:
            self.assertIn(f"$runtimeSelection.platforms.{platform}.url", metadata)
        self.assertNotIn("releases/download/$env:AI_RUNTIME_RELEASE_TAG", metadata)

    @unittest.skipUnless(SHELL, "PowerShell is required for release metadata integration")
    def test_generated_metadata_validates_split_and_single_release_assets(self):
        plans = (
            ("single", build_plan("sdevil7th/OpenStudio", "0.0.13")),
            ("split", self.plan),
            ("windows-upgrade", build_plan("sdevil7th/OpenStudio", "0.0.15", "ai-runtime-v0.0.15", "ai-runtime-linux-v0.0.14")),
        )
        for label, plan in plans:
            with self.subTest(plan=label):
                releases = fixture_releases(plan, self.directory)
                validate_releases(plan, releases, self.directory)
                output = self.directory / label
                app_paths = {}
                for platform, name in (("windows", "OpenStudio-Setup-x64.exe"), ("macos", "OpenStudio-macOS.dmg"), ("linux", "OpenStudio-0.1.04-linux-x86_64.AppImage")):
                    path = self.directory / name
                    path.write_bytes(f"{platform} application fixture".encode())
                    app_paths[platform] = path
                args = [
                    "-Version", "0.1.04", "-ReleasePageUrl", "https://github.com/sdevil7th/OpenStudio/releases/tag/v0.1.04",
                    "-OutputDir", str(output), "-NotesFile", str(ROOT / "docs/releases/0.1.04.md"),
                    "-AiRuntimeVersion", plan["runtimeVersion"],
                ]
                validate_args = ["-MetadataDir", str(output)]
                for platform, option in (("windows", "Windows"), ("macos", "Mac"), ("linux", "Linux")):
                    args += [f"-{option}AssetPath", str(app_paths[platform]), f"-{option}AssetUrl", f"https://github.com/sdevil7th/OpenStudio/releases/download/v0.1.04/{app_paths[platform].name}"]
                    validate_args += [f"-{option}AssetPath", str(app_paths[platform])]
                for platform, option in (("windows", "WindowsBase"), ("macos", "MacArm64"), ("linux", "LinuxX64")):
                    asset = plan["platforms"][platform]
                    args += [f"-{option}AiRuntimeAssetPath", str(self.directory / asset["fileName"]), f"-{option}AiRuntimeAssetUrl", asset["url"]]
                    validate_args += [f"-{option}AiRuntimeAssetPath", str(self.directory / asset["fileName"])]
                for option, filename in (
                    ("WindowsCuda", "windows-cuda"), ("WindowsDirectml", "windows-directml"),
                    ("LinuxCuda", "linux-cuda"), ("LinuxRocm", "linux-rocm"),
                ):
                    entry = [f"-{option}InstallPlanPath", str(ROOT / f"tools/ai-runtime-install-plan-{filename}.json")]
                    args += entry
                    validate_args += entry
                for script, script_args in (("generate-release-metadata.ps1", args), ("validate-release-metadata.ps1", validate_args)):
                    result = subprocess.run([SHELL, "-NoProfile", "-File", str(ROOT / "tools" / script), *script_args], cwd=ROOT, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                manifest = json.loads((output / "releases/ai-runtime/stable/latest.json").read_text(encoding="utf-8-sig"))
                self.assertEqual(manifest["schemaVersion"], 4)
                self.assertEqual(manifest["runtimeVersion"], plan["runtimeVersion"])
                for platform, node in (("windows", manifest["platforms"]["windows"]["base"]), ("macos", manifest["platforms"]["macos"]["arm64"]), ("linux", manifest["platforms"]["linux"]["x64"])):
                    selected = plan["platforms"][platform]
                    published = next(item for item in releases[selected["releaseTag"]]["assets"] if item["name"] == selected["fileName"])
                    self.assertEqual(node["url"], selected["url"])
                    self.assertEqual(node["sha256"], published["digest"].removeprefix("sha256:"))
                    self.assertEqual(node["size"], published["size"])


if __name__ == "__main__":
    unittest.main()

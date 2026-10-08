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

import yaml

from tools.release_ai_runtime import ASSETS, build_plan, validate_releases


ROOT = Path(__file__).resolve().parents[1]
SHELL = shutil.which("pwsh") or shutil.which("powershell")


def fixture_releases(plan, directory):
    releases = {}
    for platform, asset in plan["platforms"].items():
        content = f"{platform} archive from {asset['releaseTag']}\n".encode()
        (directory / asset["fileName"]).write_bytes(content)
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
        for split in (False, True):
            with self.subTest(split=split):
                plan = self.plan if split else build_plan("sdevil7th/OpenStudio", "0.0.13")
                releases = fixture_releases(plan, self.directory)
                validate_releases(plan, releases, self.directory)
                output = self.directory / ("split" if split else "single")
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

import json
import sys
import unittest
from unittest.mock import patch
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import install_ai_tools as installer  # noqa: E402


CORE_MUSIC_GENERATION_PACKAGES = {
    "diffusers": "diffusers==0.39.0",
    "transformers": "transformers==4.57.6",
    "accelerate": "accelerate==1.12.0",
    "huggingface_hub": "huggingface_hub>=0.34,<1.0",
}

RUNTIME_REQUIREMENT_FILES = (
    "ai-runtime-requirements-linux.txt",
    "ai-runtime-requirements-macos.txt",
    "ai-runtime-requirements-windows-cuda.txt",
    "ai-runtime-requirements-windows-directml.txt",
    "ai-runtime-requirements-linux-cuda.txt",
    "ai-runtime-requirements-linux-rocm.txt",
)

BACKEND_INSTALL_PLAN_FILES = (
    "ai-runtime-install-plan-windows-cuda.json",
    "ai-runtime-install-plan-windows-directml.json",
    "ai-runtime-install-plan-linux-cuda.json",
    "ai-runtime-install-plan-linux-rocm.json",
)


def package_name(requirement: str) -> str:
    return requirement.split("@", 1)[0].split("[", 1)[0].split("=", 1)[0].split("<", 1)[0].split(">", 1)[0]


class AiRuntimeDependencyPinTests(unittest.TestCase):
    def test_stem_only_cuda_install_applies_matching_torch_family(self):
        plan = json.loads((TOOLS_DIR / "ai-runtime-install-plan-windows-cuda.json").read_text(encoding="utf-8"))
        with patch.object(installer, "stream_step") as run, patch.object(installer, "emit"), \
             patch.object(installer.platform, "system", return_value="Windows"), \
             patch.object(installer.subprocess, "run", return_value=type("Result", (), {"stdout": "[]"})()), \
             patch.object(installer, "run_step"), patch.object(installer, "log_event"), patch.object(installer, "write_log"):
            installer.apply_backend_install_plan(Path("python"), Path("runtime"), plan,
                backend_requested="cuda", selected_features=["stemSeparation"], install_source="downloadedRuntime",
                requires_external_python=False, python_detected=False, build_runtime_mode="downloaded-runtime")
        commands = [call.args[0] for call in run.call_args_list]
        self.assertTrue(any("torch==2.11.0+cu128" in command and "torchvision==0.26.0+cu128" in command
                            and "torchaudio==2.11.0+cu128" in command for command in commands))
        self.assertFalse(any("diffusers==0.39.0" in command for command in commands))

    def test_legacy_catalog_and_existing_directml_runtime_are_repaired_before_install(self):
        legacy = {"id": "legacy", "backend": "cuda", "steps": [
            {"type": "pip_install", "features": ["audioGeneration"], "packages": ["torch", "torchaudio"]}]}
        for features in (["stemSeparation"], ["stemSeparation", "audioGeneration"]):
            with self.subTest(features=features), patch.object(installer.platform, "system", return_value="Windows"), \
                 patch.object(installer.subprocess, "run", return_value=type("Result", (), {"stdout": '["torch-directml", "onnxruntime-gpu", "onnxruntime-directml"]'})()), \
                 patch.object(installer, "stream_step") as install, patch.object(installer, "run_step") as uninstall, \
                 patch.object(installer, "emit"), patch.object(installer, "log_event"), patch.object(installer, "write_log"):
                installer.apply_backend_install_plan(Path("python"), Path("runtime"), legacy,
                    backend_requested="cuda", selected_features=features, install_source="downloadedRuntime",
                    requires_external_python=False, python_detected=False, build_runtime_mode="downloaded-runtime")
                self.assertIn("torch-directml", uninstall.call_args_list[0].args[0])
                self.assertIn("onnxruntime-gpu", uninstall.call_args_list[0].args[0])
                self.assertTrue(any("torchvision==0.26.0+cu128" in c.args[0] for c in install.call_args_list))
                self.assertEqual(any("diffusers==0.39.0" in c.args[0] for c in install.call_args_list), "audioGeneration" in features)
        self.assertEqual(legacy["id"], "legacy")

    def test_stem_dependencies_retain_the_separators_audio_api(self):
        for path in TOOLS_DIR.glob("ai-runtime-requirements*.txt"):
            content = path.read_text(encoding="utf-8")
            if "audio-separator" in content:
                self.assertIn("librosa==0.11.0", content, path.name)
                self.assertIn("audioread==3.1.0", content, path.name)
        for path in TOOLS_DIR.glob("ai-runtime-install-plan*.json"):
            for step in json.loads(path.read_text(encoding="utf-8"))["steps"]:
                packages = step.get("packages", [])
                if any(package.startswith("audio-separator") for package in packages):
                    self.assertIn("librosa==0.11.0", packages, path.name)
                    self.assertIn("audioread==3.1.0", packages, path.name)

    def test_legacy_linux_rocm_plan_cannot_skip_stem_torch_overlay(self):
        legacy = {"backend": "rocm", "steps": []}
        with patch.object(installer.platform, "system", return_value="Linux"), \
             patch.object(installer, "select_rocm_architecture_plan", side_effect=lambda plan, backend: plan), \
             patch.object(installer, "stream_step") as install, patch.object(installer, "run_step"), \
             patch.object(installer, "emit"), patch.object(installer, "log_event"), patch.object(installer, "write_log"):
            installer.apply_backend_install_plan(Path("python"), Path("runtime"), legacy,
                backend_requested="rocm", selected_features=["stemSeparation"], install_source="downloadedRuntime",
                requires_external_python=False, python_detected=False, build_runtime_mode="downloaded-runtime")
        self.assertTrue(any("torch==2.5.1" in call.args[0] and "torchaudio==2.5.1" in call.args[0]
                            for call in install.call_args_list))

    def assert_core_packages_are_pinned(self, packages: list[str], source: str) -> None:
        package_map = {package_name(package): package for package in packages}
        for name, expected_requirement in CORE_MUSIC_GENERATION_PACKAGES.items():
            self.assertEqual(
                package_map.get(name),
                expected_requirement,
                f"{source} must use the shared, tested {name} requirement",
            )

        self.assertFalse(
            any(package.startswith("git+") for package in packages),
            f"{source} must not depend on a moving Git branch",
        )

    def test_packaged_runtime_requirements_use_the_tested_dependency_set(self):
        for filename in RUNTIME_REQUIREMENT_FILES:
            path = TOOLS_DIR / filename
            packages = [
                line.strip()
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            ]
            with self.subTest(filename=filename):
                self.assert_core_packages_are_pinned(packages, filename)

    def test_backend_install_plans_use_the_tested_dependency_set(self):
        for filename in BACKEND_INSTALL_PLAN_FILES:
            path = TOOLS_DIR / filename
            plan = json.loads(path.read_text(encoding="utf-8"))
            packages = [
                package
                for step in plan["steps"]
                if "audioGeneration" in step.get("features", [])
                for package in step.get("packages", [])
            ]
            with self.subTest(filename=filename):
                self.assert_core_packages_are_pinned(packages, filename)

    def test_installer_fallback_uses_the_tested_dependency_set(self):
        packages = installer.get_music_generation_runtime_requirements(python_version=(3, 11, 9))
        self.assert_core_packages_are_pinned(packages, "install_ai_tools.py fallback")


if __name__ == "__main__":
    unittest.main()

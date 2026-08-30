import json
import sys
import unittest
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

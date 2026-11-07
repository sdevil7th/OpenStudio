"""Compiler setup transaction, recipe identity and platform boundaries."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import ai_compiler_profile as profile
import setup_ai_compiler as setup


class CompilerSetupTests(unittest.TestCase):
    def test_recipe_identity_survives_windows_text_transport(self):
        original=profile.requirements_path().read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            module=Path(directory)/"ai_compiler_profile.py"
            requirements=module.with_name(profile.REQUIREMENTS_NAME)
            with patch.object(profile,"__file__",str(module)):
                for data in (original,original.replace(b"\n",b"\r\n"),b"\xef\xbb\xbf"+original):
                    requirements.write_bytes(data)
                    self.assertEqual(profile.requirements_path(),requirements)
                requirements.write_bytes(original.replace(b"numpy==",b"numpy>=",1))
                with self.assertRaisesRegex(ValueError,"reviewed recipe"):profile.requirements_path()

    def test_unsupported_hardware_stops_before_package_or_model_loading(self):
        fake=NS(__version__="2.10.0+cu128",version=NS(hip=None),cuda=NS(
            get_device_name=lambda _:"NVIDIA GeForce RTX 3060",is_bf16_supported=lambda:True))
        with patch.object(profile.sys,"platform","win32"),patch.object(profile.sys,"version_info",(3,11,9)),patch.object(profile.metadata,"version") as version:
            with self.assertRaisesRegex(ValueError,"qualified Windows RTX 4080"):profile.validate_compiler_device(fake,"cuda:0")
            version.assert_not_called()

    def test_exact_packages_and_source_revision_are_required(self):
        versions=profile.pinned_packages()
        versions.update(torchaudio="2.10.0+cu128",torchvision="0.25.0+cu128")
        fake=NS(__version__="2.10.0+cu128",version=NS(hip=None),cuda=NS(
            get_device_name=lambda _:"NVIDIA GeForce RTX 4080",is_bf16_supported=lambda:True))
        origin=NS(read_text=lambda _:json.dumps({"url":"https://github.com/huggingface/diffusers/archive/7643c4826609c47755e3da0e5b768e8070468f49.zip"}))
        with patch.object(profile.sys,"platform","win32"),patch.object(profile.sys,"version_info",(3,11,9)),patch.object(
                profile.metadata,"version",side_effect=lambda name:versions[name]),patch.object(profile.metadata,"distribution",return_value=origin):
            self.assertFalse(profile.validate_compiler_device(fake,"cuda:0")["precisionChange"])
            versions["torchaudio"]="2.11.0+cu128"
            with self.assertRaisesRegex(ValueError,"must match PyTorch"):profile.validate_compiler_device(fake,"cuda:0")
            versions["torchaudio"]="2.10.0+cu128"
            versions["triton-windows"]="wrong"
            with self.assertRaisesRegex(ValueError,"triton-windows"):profile.validate_compiler_device(fake,"cuda:0")

    def test_published_previous_slot_is_retained_when_new_recipe_differs(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);slot=root/("compiler-runtime-"+"a"*32);slot.mkdir()
            (root/"active.json").write_text(json.dumps({"schemaVersion":1,"profile":"old-profile","slot":slot.name}))
            (slot/"ready.json").write_text(json.dumps({"profile":"old-profile","validation":"pass"}))
            self.assertEqual(setup.published_slot(root),slot)
            self.assertIsNone(setup.active_slot(root))
            (root/"active.json").write_text(json.dumps({"schemaVersion":1,"slot":"../"+slot.name}))
            self.assertIsNone(setup.published_slot(root))

    def test_integrity_failure_leaves_the_published_slot_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);root=base/"compiler";root.mkdir()
            slot=root/("compiler-runtime-"+"a"*32);slot.mkdir();(slot/"precious").write_text("old runtime")
            marker=root/"active.json";marker.write_text(json.dumps({"schemaVersion":1,"profile":profile.PROFILE,"slot":slot.name}))
            before=marker.read_bytes()
            model=base/"model";model.mkdir();(model/"model_index.json").write_text("{}")
            archive=base/"cache";archive.mkdir();(archive/setup.BOOTSTRAP["filename"]).write_bytes(b"corrupt")
            with patch.object(setup.sys,"platform","win32"),patch.object(setup.sys,"argv",["setup","--root",str(root),"--model-root",str(model),"--archive-cache",str(archive)]),patch.object(
                    setup.shutil,"disk_usage",return_value=NS(free=100*setup.GIB)):
                with self.assertRaisesRegex(ValueError,"integrity check failed"):setup.main()
            self.assertEqual(marker.read_bytes(),before)
            self.assertEqual((slot/"precious").read_text(),"old runtime")

    def test_archive_paths_cannot_escape_the_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);slot=root/"slot";slot.mkdir();archive=root/"archive.zip"
            with zipfile.ZipFile(archive,"w") as bundle:bundle.writestr("../outside","bad")
            with patch.dict(setup.BOOTSTRAP,{"sha256":hashlib.sha256(archive.read_bytes()).hexdigest(),"size":archive.stat().st_size}):
                with self.assertRaisesRegex(ValueError,"Unsafe compiler bootstrap"):setup.extract_bootstrap(archive,slot/"runtime")
            self.assertFalse((root/"outside").exists())

    def test_cleanup_cannot_delete_foreign_or_live_slot_data(self):
        import psutil
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);slot=root/("compiler-runtime-"+"a"*32);slot.mkdir()
            owner=slot/"owner.json";owner.write_text(json.dumps({"kind":"foreign"}))
            with self.assertRaisesRegex(ValueError,"Unknown compiler slot owner"):setup.remove_owned_slot(slot,root)
            owner.write_text(json.dumps({"kind":"openstudio-compiler-slot-v1","pid":os.getpid(),"birth":psutil.Process().create_time()}))
            with self.assertRaisesRegex(RuntimeError,"still owns"):setup.remove_owned_slot(slot,root)

    def test_windows_compiler_uses_supported_single_worker_path(self):
        from ai_compilation import prepare_worker_optimization
        fake=NS(cuda=NS(is_available=lambda:True),version=NS(hip=None))
        with patch.dict(os.environ,{}),patch.dict(sys.modules,{"torch":fake}),patch("ai_compilation.sys.platform","win32"),patch(
                "ai_execution_policy.optimization_candidates",return_value={"compile":{"state":"available"}}),patch("ai_compilation.CompilationWorkspace"):
            prepare_worker_optimization("compile")
            self.assertEqual(os.environ["TORCHINDUCTOR_COMPILE_THREADS"],"1")


if __name__=="__main__":unittest.main()

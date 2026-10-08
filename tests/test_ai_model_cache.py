import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ai_runtime_probe import resolve_music_gen_snapshot, get_music_generation_required_paths
from ai_generation_preflight import resolve_root


class ModelCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.hub = types.SimpleNamespace(try_to_load_from_cache=lambda *args, **kwargs: None)
        mock = patch.dict(sys.modules, huggingface_hub=self.hub)
        mock.start()
        self.addCleanup(mock.stop)

    def snapshot(self, name):
        root = self.root / name
        files = ["model_index.json", "scheduler/scheduler_config.json", "tokenizer/tokenizer.json"]
        for component, stem in (("vae", "diffusion_pytorch_model"), ("condition_encoder", "diffusion_pytorch_model"),
                                ("transformer", "diffusion_pytorch_model"), ("text_encoder", "model")):
            files += [f"{component}/config.json", f"{component}/{stem}.safetensors"]
        for filename in files:
            path = root / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}")
        return root

    def test_complete_direct_snapshot_shared_by_setup_and_preflight(self):
        root = self.snapshot("direct")
        self.assertEqual(resolve_music_gen_snapshot(root), root)
        self.assertEqual(resolve_root(root, "ace-step-v15-xl-turbo"), root)
        self.assertTrue(get_music_generation_required_paths(str(root))["layoutValid"])

    def test_missing_or_empty_weights_cannot_report_ready(self):
        root = self.snapshot("incomplete")
        (root / "vae/diffusion_pytorch_model.safetensors").write_bytes(b"")
        self.assertIsNone(resolve_music_gen_snapshot(root))
        self.assertFalse(get_music_generation_required_paths(str(root))["layoutValid"])
        with self.assertRaises(ValueError):
            resolve_root(root, "ace-step-v15-xl-turbo")

    def test_reuses_default_cache_when_configured_cache_is_empty(self):
        root = self.snapshot("default")
        self.hub.try_to_load_from_cache = lambda *args, cache_dir=None: str(root / "model_index.json") if cache_dir is None else None
        self.assertEqual(resolve_music_gen_snapshot(self.root / "empty"), root)

    def test_installer_reuses_complete_cache_without_downloading(self):
        import install_ai_tools as installer
        root = self.snapshot("installed")
        self.hub.try_to_load_from_cache = lambda *args, **kwargs: str(root / "model_index.json")
        with patch.object(installer, "stream_step") as download, patch.object(installer, "emit"), patch.object(installer, "log_event"):
            installer.download_music_gen_model(Path(sys.executable), "ace-step-v15-xl-turbo", self.root / "empty",
                install_source="downloadedRuntime", requires_external_python=False, python_detected=False,
                build_runtime_mode="downloaded-runtime")
        download.assert_not_called()

    def test_prefers_configured_cache_without_mixing_snapshots(self):
        configured, fallback = self.snapshot("configured"), self.snapshot("fallback")
        self.hub.try_to_load_from_cache = lambda *args, cache_dir=None: str((configured if cache_dir else fallback) / "model_index.json")
        self.assertEqual(resolve_music_gen_snapshot(self.root / "cache"), configured)
        (configured / "vae/config.json").unlink()
        (fallback / "transformer/config.json").unlink()
        self.assertIsNone(resolve_music_gen_snapshot(self.root / "cache"))

    def test_all_shards_required_and_unsafe_index_rejected(self):
        root = self.snapshot("sharded")
        component = root / "transformer"
        (component / "diffusion_pytorch_model.safetensors").unlink()
        index = component / "diffusion_pytorch_model.safetensors.index.json"
        index.write_text(json.dumps({"weight_map": {"a": "part1.safetensors", "b": "part2.safetensors"}}))
        (component / "part1.safetensors").write_bytes(b"data")
        self.assertIsNone(resolve_music_gen_snapshot(root))
        (component / "part2.safetensors").write_bytes(b"data")
        self.assertEqual(resolve_music_gen_snapshot(root), root)
        index.write_text(json.dumps({"weight_map": {"a": "../model_index.json"}}))
        self.assertIsNone(resolve_music_gen_snapshot(root))


if __name__ == "__main__":
    unittest.main()

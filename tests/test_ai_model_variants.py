import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ai_model_variants import COMPONENTS, MARKER, requested_variant, validate_variant, variant_root


class ModelVariantTests(unittest.TestCase):
    def test_unknown_selection_never_falls_back(self):
        self.assertEqual(requested_variant({}), "original")
        self.assertEqual(requested_variant({"modelVariant": "int8"}), "int8")
        with self.assertRaises(ValueError):
            requested_variant({"modelVariant": "nf4"})

    def test_variant_path_cannot_escape_managed_models(self):
        with self.assertRaises(ValueError):
            variant_root("../../foreign")

    def test_saved_quantization_contract_and_wrong_model(self):
        for model in ("ace-step-v15-xl-turbo", "stable-audio-3-medium", "minimax-music-3"):
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                with self.assertRaises(ValueError):
                    validate_variant(root, model)
                component = "language_model" if model == "minimax-music-3" else "transformer"
                (root / component).mkdir()
                record = {"schemaVersion": 1, "modelId": model, "variant": "int8", "component": component}
                (root / MARKER).write_text(json.dumps(record))
                config = root / component / "config.json"
                config.write_text(json.dumps({"quantization_config": {"quant_method": "bitsandbytes", "load_in_8bit": True}}))
                with self.assertRaises(ValueError):
                    validate_variant(root, model)
                (root / component / "model.safetensors").write_bytes(b"fixture")
                for name in COMPONENTS[model]:
                    (root / name).mkdir(exist_ok=True)
                    if name != component:
                        (root / name / "config.json").write_text("{}")
                        (root / name / "model.safetensors").write_bytes(b"fixture")
                for name in ("tokenizer/tokenizer_config.json", "scheduler/scheduler_config.json",
                             "modular_model_index.json" if model == "minimax-music-3" else "model_index.json"):
                    path = root / name
                    path.parent.mkdir(exist_ok=True)
                    path.write_text("{}")
                self.assertEqual(validate_variant(root, model), record)
                wrong = {**record, "modelId": "other-model"}
                (root / MARKER).write_text(json.dumps(wrong))
                with self.assertRaises(ValueError):
                    validate_variant(root, model)
                (root / MARKER).write_text(json.dumps(record))
                config.write_text("{}")
                with self.assertRaises(ValueError):
                    validate_variant(root, model)

    def test_installer_reuses_original_without_download(self):
        from prepare_diffusers_audio import prepare_variant
        with patch("ai_model_variants.prepare_int8") as convert, patch("prepare_diffusers_audio.download") as download:
            source, dest, cache = Path("source"), Path("dest"), Path("cache")
            prepare_variant("minimax-music-3", dest, cache, source=source)
            convert.assert_called_once_with(source, dest, "minimax-music-3")
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()

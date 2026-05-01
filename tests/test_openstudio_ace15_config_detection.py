import argparse
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import torch


VENDOR_RUNTIME_ROOT = Path(__file__).resolve().parents[1] / "tools" / "openstudio_ace_backend" / "vendor_runtime"
if str(VENDOR_RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_RUNTIME_ROOT))
TOOLS_ROOT = Path(__file__).resolve().parents[1] / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from comfy.model_detection import detect_unet_config
from comfy.ops import disable_weight_init
from comfy.ldm.ace.ace_step15 import AceStepConditionGenerationModel
from comfy_extras.nodes_audio import vae_decode_audio
from generate_music import (
    build_native_split_request,
    classify_generation_failure_kind,
    is_out_of_memory_error,
    normalize_generation_params,
    resolve_one_shot_params_json,
)
from install_ai_tools import normalize_installer_command
from comfy_extras.nodes_ace import EmptyAceStep15LatentAudio
from openstudio_ace_runner import build_openstudio_ace_prompt, choose_existing, run_ace_split_request


class DetectAceStep15ConfigTests(unittest.TestCase):
    def test_native_split_request_matches_expected_comfy_shape(self):
        raw_params = {
            "prompt": "prompt text",
            "lyrics": "lyrics text",
            "seed": 0,
            "bpm": 170,
            "duration": 191,
            "timesignature": "3/4",
            "language": "en",
            "keyscale": "C# minor",
            "generate_audio_codes": True,
            "cfg_scale": 2,
            "guidance_scale": 1,
            "inferenceSteps": 8,
            "shift": 3,
            "temperature": 0.85,
            "top_p": 0.9,
            "top_k": 0,
            "min_p": 0,
        }

        normalized = build_native_split_request(normalize_generation_params(raw_params))

        self.assertEqual(normalized["timesignature"], "3")
        self.assertEqual(normalized["sampler_name"], "euler")
        self.assertEqual(normalized["scheduler"], "simple")
        self.assertEqual(normalized["denoise"], 1.0)
        self.assertEqual(normalized["clip_type"], "ace")
        self.assertEqual(normalized["model_mode"], "default")
        self.assertEqual(normalized["decode_mode"], "full")

    def test_detects_split_encoder_and_decoder_dimensions(self):
        state_dict = {
            "encoder.lyric_encoder.layers.0.input_layernorm.weight": torch.empty(2048),
            "decoder.proj_in.1.weight": torch.empty(2560, 192, 2),
            "decoder.proj_out.1.weight": torch.empty(2560, 64, 2),
            "decoder.layers.0.self_attn.q_norm.weight": torch.empty(128),
            "decoder.layers.0.self_attn.q_proj.weight": torch.empty(4096, 2560),
            "decoder.layers.0.self_attn.k_proj.weight": torch.empty(1024, 2560),
            "decoder.layers.0.mlp.gate_proj.weight": torch.empty(9728, 2560),
            "decoder.layers.1.self_attn.q_proj.weight": torch.empty(4096, 2560),
            "encoder.text_projector.weight": torch.empty(2048, 1024),
            "encoder.timbre_encoder.embed_tokens.weight": torch.empty(2048, 64),
            "encoder.lyric_encoder.layers.0.self_attn.q_proj.weight": torch.empty(2048, 2048),
            "encoder.lyric_encoder.layers.0.self_attn.k_proj.weight": torch.empty(1024, 2048),
            "encoder.lyric_encoder.layers.0.mlp.gate_proj.weight": torch.empty(6144, 2048),
            "encoder.lyric_encoder.layers.1.self_attn.q_proj.weight": torch.empty(2048, 2048),
            "encoder.timbre_encoder.layers.0.self_attn.q_proj.weight": torch.empty(2048, 2048),
            "encoder.timbre_encoder.layers.1.self_attn.q_proj.weight": torch.empty(2048, 2048),
            "tokenizer.attention_pooler.layers.0.self_attn.q_proj.weight": torch.empty(2048, 2048),
            "tokenizer.attention_pooler.layers.1.self_attn.q_proj.weight": torch.empty(2048, 2048),
            "tokenizer.quantizer.project_in.weight": torch.empty(6, 2048),
            "detokenizer.special_tokens": torch.empty(1, 5, 2048),
        }

        config = detect_unet_config(state_dict, "")

        self.assertEqual(config["audio_model"], "ace1.5")
        self.assertEqual(config["encoder_hidden_size"], 2048)
        self.assertEqual(config["decoder_hidden_size"], 2560)
        self.assertEqual(config["encoder_intermediate_size"], 6144)
        self.assertEqual(config["decoder_intermediate_size"], 9728)

    def test_split_model_uses_2048_to_2560_condition_projection(self):
        model = AceStepConditionGenerationModel(
            encoder_hidden_size=2048,
            decoder_hidden_size=2560,
            encoder_num_heads=16,
            encoder_num_kv_heads=8,
            decoder_num_heads=32,
            decoder_num_kv_heads=8,
            encoder_intermediate_size=6144,
            decoder_intermediate_size=9728,
            operations=disable_weight_init,
        )

        self.assertEqual(tuple(model.decoder.condition_embedder.weight.shape), (2560, 2048))

    def test_out_of_memory_errors_classify_as_native_decode_failures(self):
        error_text = (
            "ACE-Step full audio decode ran out of GPU memory while decoding audio from the VAE."
        )

        self.assertTrue(is_out_of_memory_error(error_text))
        self.assertEqual(
            classify_generation_failure_kind(error_text, generation_mode="lm_first"),
            "native_decode_failure",
        )

    def test_audio_decode_normalization_avoids_inplace_updates(self):
        class DummyVae:
            audio_sample_rate = 44100

            def decode(self, samples):
                return torch.ones((1, 64, 32), dtype=torch.float32)

        decoded = vae_decode_audio(DummyVae(), {"samples": torch.zeros((1, 1, 1))})

        self.assertEqual(tuple(decoded["waveform"].shape), (1, 32, 64))
        self.assertEqual(decoded["sample_rate"], 44100)

    def test_tiled_audio_decode_uses_requested_tile_size_for_1d_audio(self):
        class DummyVae:
            audio_sample_rate = 44100

            def __init__(self):
                self.kwargs = None

            def decode_tiled(self, samples, **kwargs):
                self.kwargs = kwargs
                return torch.ones((1, 64, 32), dtype=torch.float32)

        vae = DummyVae()
        decoded = vae_decode_audio(
            vae,
            {"samples": torch.zeros((1, 1, 1))},
            tile=512,
            overlap=64,
        )

        self.assertEqual(decoded["sample_rate"], 44100)
        self.assertEqual(vae.kwargs, {"tile_x": 512, "tile_y": 512, "overlap": 64})

    def test_ace15_latent_uses_comfy_intermediate_dtype(self):
        with mock.patch("comfy.model_management.intermediate_device", return_value="cpu"):
            with mock.patch("comfy.model_management.intermediate_dtype", return_value=torch.float16):
                latent = EmptyAceStep15LatentAudio.execute(1.0, 1)[0]

        self.assertEqual(latent["samples"].dtype, torch.float16)
        self.assertEqual(tuple(latent["samples"].shape), (1, 64, 25))

    def test_installer_disables_pip_http_cache_for_installs(self):
        command = normalize_installer_command(
            ["python", "-m", "pip", "install", "--upgrade", "torch"]
        )

        self.assertEqual(
            command,
            ["python", "-m", "pip", "install", "--no-cache-dir", "--upgrade", "torch"],
        )

    def test_one_shot_params_loader_accepts_inline_file_stdin_and_bom_file(self):
        payload = json.dumps({"prompt": "hello"})
        bom_payload = "\ufeff" + payload
        with tempfile.TemporaryDirectory() as temp_dir:
            params_path = Path(temp_dir) / "params.json"
            bom_path = Path(temp_dir) / "params-bom.json"
            params_path.write_text(payload, encoding="utf-8")
            bom_path.write_text(bom_payload, encoding="utf-8")

            inline_args = argparse.Namespace(params=payload, params_file="", params_stdin=False)
            file_args = argparse.Namespace(params="", params_file=str(params_path), params_stdin=False)
            bom_args = argparse.Namespace(params="", params_file=str(bom_path), params_stdin=False)
            stdin_args = argparse.Namespace(params="", params_file="", params_stdin=True)

            self.assertEqual(resolve_one_shot_params_json(inline_args), payload)
            self.assertEqual(resolve_one_shot_params_json(file_args), payload)
            self.assertEqual(resolve_one_shot_params_json(bom_args), payload)
            with mock.patch("sys.stdin", io.StringIO(payload)):
                self.assertEqual(resolve_one_shot_params_json(stdin_args), payload)

    def test_one_shot_params_loader_rejects_ambiguous_sources(self):
        args = argparse.Namespace(params="{}", params_file="x.json", params_stdin=False)
        with self.assertRaises(SystemExit):
            resolve_one_shot_params_json(args)

    def test_openstudio_ace_prompt_maps_request_to_known_graph_values(self):
        request = {
            "prompt": "prompt",
            "lyrics": "lyrics",
            "seed": -1,
            "bpm": 170,
            "duration": 191.0,
            "timesignature": "3/4",
            "language": "en",
            "keyscale": "C# minor",
            "generate_audio_codes": True,
            "cfg_scale": 2.0,
            "guidance_scale": 1.0,
            "inferenceSteps": 8,
            "shift": 3.0,
            "temperature": 0.85,
            "top_p": 0.9,
            "top_k": 0,
            "min_p": 0.0,
            "sampler_name": "euler",
            "scheduler": "simple",
            "denoise": 1.0,
        }

        prompt = build_openstudio_ace_prompt(
            request=request,
            unet_name="acestep_v1.5_xl_turbo_bf16.safetensors",
            clip_name1="qwen_0.6b_ace15.safetensors",
            clip_name2="qwen_4b_ace15.safetensors",
            vae_name="ace_1.5_vae.safetensors",
        )

        self.assertEqual(prompt["104"]["class_type"], "UNETLoader")
        self.assertEqual(prompt["105"]["inputs"]["type"], "ace")
        self.assertEqual(prompt["94"]["class_type"], "TextEncodeAceStepAudio1.5")
        self.assertEqual(prompt["94"]["inputs"]["seed"], 0)
        self.assertEqual(prompt["94"]["inputs"]["duration"], 191.0)
        self.assertEqual(prompt["94"]["inputs"]["timesignature"], "3")
        self.assertEqual(prompt["47"]["class_type"], "ConditioningZeroOut")
        self.assertEqual(prompt["3"]["inputs"]["negative"], ["47", 0])
        self.assertEqual(prompt["3"]["inputs"]["sampler_name"], "euler")
        self.assertEqual(prompt["3"]["inputs"]["scheduler"], "simple")
        self.assertEqual(prompt["3"]["inputs"]["cfg"], 1.0)
        self.assertEqual(prompt["18"]["class_type"], "VAEDecodeAudio")

    def test_missing_ace_asset_error_points_to_ai_setup(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaises(FileNotFoundError) as exc_info:
                choose_existing(Path(temp_dir), ["vae/ace_1.5_vae.safetensors"])

        self.assertIn("Run OpenStudio AI setup", str(exc_info.exception))

    def test_runner_executes_openstudio_ace_graph_through_executor(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            backend_root = temp_root / "backend"
            backend_root.mkdir(parents=True, exist_ok=True)
            output_path = temp_root / "out.wav"
            for relative_path in (
                "diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors",
                "text_encoders/qwen_0.6b_ace15.safetensors",
                "text_encoders/qwen_4b_ace15.safetensors",
                "vae/ace_1.5_vae.safetensors",
            ):
                asset_path = temp_root / relative_path
                asset_path.parent.mkdir(parents=True, exist_ok=True)
                asset_path.write_bytes(b"stub")

            comfy_mod = types.ModuleType("comfy")
            comfy_utils_mod = types.ModuleType("comfy.utils")
            comfy_utils_mod.set_progress_bar_global_hook = lambda hook: None
            comfy_mod.utils = comfy_utils_mod

            nodes_mod = types.ModuleType("nodes")
            nodes_mod.NODE_CLASS_MAPPINGS = {}
            init_calls = []

            async def fake_init_extra_nodes(**kwargs):
                init_calls.append(kwargs)
                return []

            nodes_mod.init_extra_nodes = fake_init_extra_nodes

            class FakeCacheEntry:
                def __init__(self, outputs):
                    self.outputs = outputs

            class FakeOutputs:
                def __init__(self):
                    self.entries = {}

                async def get(self, node_id):
                    return self.entries.get(node_id)

            class FakeCaches:
                def __init__(self):
                    self.outputs = FakeOutputs()

            class FakePromptExecutor:
                captured_prompt = None

                def __init__(self, server, **kwargs):
                    self.server = server
                    self.cache_args = kwargs.get("cache_args")
                    self.success = True
                    self.caches = FakeCaches()

                def execute(self, prompt, prompt_id, extra_data=None, execute_outputs=None):
                    type(self).captured_prompt = prompt
                    self.caches.outputs.entries["18"] = FakeCacheEntry(
                        [[{"waveform": torch.full((1, 2, 32), 0.1, dtype=torch.float32), "sample_rate": 48000}]]
                    )
                    self.caches.outputs.entries["3"] = FakeCacheEntry(
                        [[{"samples": torch.full((1, 64, 8), 0.25, dtype=torch.float32)}]]
                    )

            execution_mod = types.ModuleType("execution")
            execution_mod.PromptExecutor = FakePromptExecutor
            nodes_model_adv_mod = types.ModuleType("comfy_extras.nodes_model_advanced")
            nodes_model_adv_mod.NODE_CLASS_MAPPINGS = {"ModelSamplingAuraFlow": object}

            fake_modules = {
                "comfy": comfy_mod,
                "comfy.utils": comfy_utils_mod,
                "nodes": nodes_mod,
                "execution": execution_mod,
                "comfy_extras.nodes_model_advanced": nodes_model_adv_mod,
            }

            request = {
                "requestId": "test-request",
                "prompt": "prompt",
                "lyrics": "lyrics",
                "seed": 0,
                "bpm": 120,
                "duration": 10.0,
                "timesignature": "4",
                "language": "en",
                "keyscale": "C major",
                "generate_audio_codes": True,
                "cfg_scale": 2.0,
                "guidance_scale": 1.0,
                "inferenceSteps": 1,
                "shift": 3.0,
                "temperature": 0.85,
                "top_p": 0.9,
                "top_k": 0,
                "min_p": 0.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
                "clip_type": "ace",
                "model_mode": "default",
            }

            with mock.patch.dict(sys.modules, fake_modules, clear=False):
                with mock.patch.dict(os.environ, {}, clear=True):
                    with mock.patch("openstudio_ace_runner.get_backend_root", return_value=backend_root):
                        with mock.patch("openstudio_ace_runner.get_runtime_workspace", return_value=temp_root / "workspace"):
                            with mock.patch("openstudio_ace_runner.configure_vendor_paths", return_value=None):
                                run_ace_split_request(
                                    checkpoint_root=temp_root,
                                    request=request,
                                    output_path=output_path,
                                )
                    self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                    self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
                    self.assertEqual(os.environ["HF_DATASETS_OFFLINE"], "1")

            self.assertTrue(output_path.exists())
            self.assertEqual(init_calls, [{"init_custom_nodes": False, "init_api_nodes": False}])
            self.assertIn("ModelSamplingAuraFlow", nodes_mod.NODE_CLASS_MAPPINGS)
            self.assertEqual(FakePromptExecutor.captured_prompt["18"]["class_type"], "VAEDecodeAudio")

    def test_runner_executor_failure_does_not_write_output(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            backend_root = temp_root / "backend"
            backend_root.mkdir(parents=True, exist_ok=True)
            output_path = temp_root / "out.wav"
            for relative_path in (
                "diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors",
                "text_encoders/qwen_0.6b_ace15.safetensors",
                "text_encoders/qwen_4b_ace15.safetensors",
                "vae/ace_1.5_vae.safetensors",
            ):
                asset_path = temp_root / relative_path
                asset_path.parent.mkdir(parents=True, exist_ok=True)
                asset_path.write_bytes(b"stub")

            comfy_mod = types.ModuleType("comfy")
            comfy_utils_mod = types.ModuleType("comfy.utils")
            comfy_utils_mod.set_progress_bar_global_hook = lambda hook: None
            comfy_mod.utils = comfy_utils_mod

            nodes_mod = types.ModuleType("nodes")
            nodes_mod.NODE_CLASS_MAPPINGS = {}

            async def fake_init_extra_nodes(**kwargs):
                return []

            nodes_mod.init_extra_nodes = fake_init_extra_nodes

            class FakePromptExecutor:
                def __init__(self, server, **kwargs):
                    self.server = server
                    self.cache_args = kwargs.get("cache_args")
                    self.success = False
                    self.caches = types.SimpleNamespace(outputs=None)

                def execute(self, prompt, prompt_id, extra_data=None, execute_outputs=None):
                    return None

            execution_mod = types.ModuleType("execution")
            execution_mod.PromptExecutor = FakePromptExecutor
            nodes_model_adv_mod = types.ModuleType("comfy_extras.nodes_model_advanced")
            nodes_model_adv_mod.NODE_CLASS_MAPPINGS = {"ModelSamplingAuraFlow": object}

            fake_modules = {
                "comfy": comfy_mod,
                "comfy.utils": comfy_utils_mod,
                "nodes": nodes_mod,
                "execution": execution_mod,
                "comfy_extras.nodes_model_advanced": nodes_model_adv_mod,
            }

            request = {
                "requestId": "test-request",
                "prompt": "prompt",
                "lyrics": "lyrics",
                "seed": 0,
                "bpm": 120,
                "duration": 10.0,
                "timesignature": "4",
                "language": "en",
                "keyscale": "C major",
                "generate_audio_codes": True,
                "cfg_scale": 2.0,
                "guidance_scale": 1.0,
                "inferenceSteps": 1,
                "shift": 3.0,
                "temperature": 0.85,
                "top_p": 0.9,
                "top_k": 0,
                "min_p": 0.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
                "clip_type": "ace",
                "model_mode": "default",
            }

            with mock.patch.dict(sys.modules, fake_modules, clear=False):
                with mock.patch("openstudio_ace_runner.get_backend_root", return_value=backend_root):
                    with mock.patch("openstudio_ace_runner.get_runtime_workspace", return_value=temp_root / "workspace"):
                        with mock.patch("openstudio_ace_runner.configure_vendor_paths", return_value=None):
                            with self.assertRaises(RuntimeError) as exc_info:
                                run_ace_split_request(
                                    checkpoint_root=temp_root,
                                    request=request,
                                    output_path=output_path,
                                )

            self.assertIn("graph execution failed", str(exc_info.exception))
            self.assertFalse(output_path.exists())


if __name__ == "__main__":
    unittest.main()

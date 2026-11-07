"""Request growth and header-only loading estimates for automatic generation."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
from ai_execution_policy import minimax_checkpoint_memory
from ai_memory_manager import GIB


class AutomaticGenerationMemoryTests(unittest.TestCase):
    def checkpoint(self, root):
        def write(component,tensors):
            folder=root/component;folder.mkdir()
            header={name:{"dtype":"F32","shape":[size//2],"data_offsets":[0,size*2]}
                    for name,size in tensors.items()}
            data=json.dumps(header).encode()
            (folder/'weights.safetensors').write_bytes(len(data).to_bytes(8,'little')+data)
        write('language_model',{'model.embed_tokens.weight':GIB,
            **{f'model.layers.{i}.weight':GIB//16 for i in range(36)}})
        for component,count in [('rvq_depth_decoder',16),('transformer',80),('condition_encoder',2),('vocoder',1)]:
            write(component,{f'weight{i}':GIB//16 for i in range(count)})
        (root/'language_model/config.json').write_text(json.dumps({
            'num_hidden_layers':36,'num_key_value_heads':8,'head_dim':128}))

    def test_large_shared_memory_avoids_disk_and_low_ram_includes_loading_reserve(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.checkpoint(root)
            values=dict(float_bytes=2,duration=30,prompt_tokens=100)
            large=minimax_checkpoint_memory(root,free_vram=90*GIB,available_ram=100*GIB,**values)
            self.assertEqual((large['placement'],large['loadingBacking']),('resident','host-memory'))
            self.assertIsInstance(large['minimumDeviceBytes'],int)
            small=minimax_checkpoint_memory(root,free_vram=9*GIB,available_ram=8*GIB,**values)
            self.assertEqual((small['placement'],small['loadingBacking']),('partial-resident-disk','disk'))
            self.assertEqual(small['requiredHostBytes'],5*GIB)
            self.assertGreater(large['requiredHostBytes'],large['weightsBytes'])

    def test_long_structured_input_changes_cache_and_minimum_device_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.checkpoint(root)
            values=dict(float_bytes=2,free_vram=9*GIB,available_ram=8*GIB)
            short=minimax_checkpoint_memory(root,duration=5,prompt_tokens=100,**values)
            long=minimax_checkpoint_memory(root,duration=300,prompt_tokens=5000,**values)
            self.assertGreater(long['requestKvBytes'],short['requestKvBytes'])
            self.assertGreater(long['minimumDeviceBytes'],short['minimumDeviceBytes'])
            self.assertLessEqual(long['requiredDeviceBytes'],9*GIB)

    def test_unknown_headers_do_not_claim_a_known_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(minimax_checkpoint_memory(Path(directory),float_bytes=2,duration=30,
                prompt_tokens=100,free_vram=12*GIB,available_ram=8*GIB))

    def test_progress_memory_reading_uses_the_selected_gpu_instead_of_thread_default(self):
        from diffusers_audio_pipeline import DiffusersAudioSession
        session=DiffusersAudioSession.__new__(DiffusersAudioSession)
        session.device='cuda';session.execution_device='cuda:1';session.model_id='stable-audio-3-medium'
        session.execution_details=dict(offload='resident',streaming=False,device='CUDA',precision='bfloat16')
        allocated=Mock(return_value=GIB)
        with patch.dict(sys.modules,{'torch':NS(cuda=NS(memory_allocated=allocated))}):
            self.assertIn('GPU 1.0 GiB',session.execution_summary())
        allocated.assert_called_once_with('cuda:1')

    def test_fp32_cuda_staging_checks_device_admission_before_full_cpu_loading(self):
        from diffusers_audio_pipeline import DiffusersAudioSession
        torch=NS(set_num_threads=Mock(),bfloat16='bf16',float32='fp32',version=NS(hip=None),
            cuda=NS(is_available=lambda:True,is_bf16_supported=lambda:False,get_device_name=lambda:'Test CUDA'))
        pipe=NS(load_components=Mock())
        diffusers=NS(ComponentsManager=Mock(),ModularPipeline=NS(from_pretrained=Mock(return_value=pipe)))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'modular_model_index.json').write_text('{}')
            with patch.dict(sys.modules,{'torch':torch,'diffusers':diffusers}),patch(
                    'ai_execution_policy.check_host_capacity') as full_load,patch(
                    'ai_execution_policy.device_budget',return_value=12*GIB),patch(
                    'ai_execution_policy.minimax_checkpoint_memory',return_value={
                        'loadingBacking':'disk','minimumDeviceBytes':100*GIB}):
                with self.assertRaisesRegex(ValueError,'available GPU memory'):
                    DiffusersAudioSession(root,'minimax-music-3',request_duration=300)
                full_load.assert_not_called();pipe.load_components.assert_not_called()

    def test_duration_ceiling_matches_recorded_upstream_30_and_60_second_wavs(self):
        from qualify_generation_worker import minimax_output_limit
        modules=NS(before_denoise=NS(_CHUNK_FRAMES=200,_CHUNK_HOP=100),
            decoders=NS(_CROP_LEFT_LATENT=86,_CROP_RIGHT_LATENT=258),encoders=NS(_MAX_AUDIO_FRAMES=9000))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'condition_encoder').mkdir()
            (root/'condition_encoder/config.json').write_text(json.dumps({'input_sampling_rate':24000,
                'input_hop_length':960,'output_sampling_rate':44100,'output_hop_length':512}))
            with patch.dict(sys.modules,{'diffusers.modular_pipelines.minimax_music3':modules}):
                for duration,observed_frames in ((30,1324032),(60,2649088)):
                    limit=minimax_output_limit(root,duration)
                    self.assertEqual(limit['maxSamples'],observed_frames)
                    self.assertEqual(limit['maxArFrames'],duration*25)
                self.assertGreater(minimax_output_limit(root,300)['maxSamples']/44100,300)

    def test_growth_rebuilds_every_minimax_placement_before_reusing_its_old_cache_budget(self):
        import stable_audio3_generate as worker_module
        for mode in ('resident','model-offload','group-offload','partial-resident'):
            for duration,tokens in ((300,100),(30,2000)):
                with self.subTest(mode=mode,duration=duration,tokens=tokens):
                    worker=worker_module.StableAudioWorker(Path('fixture'))
                    previous=NS(request_duration=30,request_prompt_tokens=100,needs_reload=Mock(return_value=False),
                        execution_details={'offload':mode},_partial=None,_int8_stage=None)
                    worker._model=previous;worker._request_duration=duration;worker._request_prompt_tokens=tokens
                    replacement=NS()
                    with patch.object(worker_module,'MODEL_ID','minimax-music-3'),patch.object(worker,'unload',
                            side_effect=lambda:setattr(worker,'_model',None)) as unload,patch.object(
                            worker,'_load_local_model',return_value=replacement) as load:
                        self.assertIs(worker._load_model('lyrics-style','fixture'),replacement)
                        unload.assert_called_once();load.assert_called_once()

    def test_smaller_request_reuses_an_admitted_session(self):
        import stable_audio3_generate as worker_module
        worker=worker_module.StableAudioWorker(Path('fixture'))
        worker._model=NS(request_duration=300,request_prompt_tokens=2000,needs_reload=lambda:False)
        worker._request_duration=30;worker._request_prompt_tokens=100
        with patch.object(worker_module,'MODEL_ID','minimax-music-3'),patch.object(worker,'_load_local_model') as load:
            self.assertIs(worker._load_model('lyrics-style','fixture'),worker._model)
            load.assert_not_called()


if __name__=='__main__':unittest.main()

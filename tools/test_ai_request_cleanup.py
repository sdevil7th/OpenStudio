"""Request-boundary reclamation preserves live CUDA tensors and other policies."""
import unittest
from unittest.mock import patch

import torch
from diffusers_audio_pipeline import DiffusersAudioSession


class RequestCleanupTests(unittest.TestCase):
    def test_other_placements_do_not_flush_allocator(self):
        session = DiffusersAudioSession.__new__(DiffusersAudioSession)
        with patch.object(torch.cuda, "empty_cache") as empty:
            session._prepare_int8_request()
        empty.assert_not_called()

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA forward qualification requires CUDA")
    def test_boundary_reclaims_unused_cache_and_preserves_live_tensor(self):
        session = DiffusersAudioSession.__new__(DiffusersAudioSession)
        session._int8_stage = object()
        session.execution_device = "cuda:0"
        session.execution_details = {}
        live = torch.ones(2 * 1024**2, device=session.execution_device)
        temporary = torch.empty(16 * 1024**2, device=session.execution_device)
        del temporary
        allocated = torch.cuda.memory_allocated(session.execution_device)
        reserved = torch.cuda.memory_reserved(session.execution_device)
        session._prepare_int8_request()
        self.assertEqual(torch.cuda.memory_allocated(session.execution_device), allocated)
        self.assertLess(torch.cuda.memory_reserved(session.execution_device), reserved)
        self.assertGreater(session.execution_details["requestCacheReleasedBytes"], 0)
        self.assertTrue(torch.equal(live, torch.ones_like(live)))
        session._prepare_int8_request()
        self.assertTrue(torch.equal(live, torch.ones_like(live)))


if __name__ == "__main__":
    unittest.main()

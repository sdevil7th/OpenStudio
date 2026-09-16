import copy
import unittest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from tools import updater_manifest as updater


class SignedUpdates(unittest.TestCase):
    def setUp(self):
        self.private = Ed25519PrivateKey.generate()
        self.public = self.private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.payload = {
            "schemaVersion": 1, "channel": "stable", "version": "0.1.01",
            "notes": (updater.ROOT / "docs/releases/0.1.01.md").read_text(encoding="utf-8"),
            "platforms": {"linux": {"architectures": ["x86_64"], "minimumGlibcVersion": "2.39",
                "url": "https://example.invalid/OpenStudio.AppImage", "size": 123, "sha256": "ab" * 32}},
        }

    def test_signed_round_trip_keeps_legacy_fields(self):
        result = updater.sign(self.payload, self.private, self.public)
        self.assertEqual(updater.verify(result, self.public), self.payload)
        self.assertEqual(result["platforms"], self.payload["platforms"])

    def test_wrong_key_is_rejected(self):
        other = Ed25519PrivateKey.generate()
        with self.assertRaises(ValueError):
            updater.sign(self.payload, other, self.public)
        result = updater.sign(self.payload, self.private, self.public)
        with self.assertRaises(InvalidSignature):
            updater.verify(result, other.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))

    def test_modified_payload_rejected(self):
        result = updater.sign(self.payload, self.private, self.public)
        changed = copy.deepcopy(self.payload)
        changed["platforms"]["linux"]["url"] = "https://attacker.invalid/bad.AppImage"
        result["signedPayload"] = updater.sign(changed, self.private, self.public)["signedPayload"]
        with self.assertRaises(InvalidSignature):
            updater.verify(result, self.public)

    def test_modified_legacy_fields_rejected_at_publish(self):
        result = updater.sign(self.payload, self.private, self.public)
        result["version"] = "99.0.0"
        with self.assertRaises(ValueError):
            updater.verify(result, self.public)

    def test_missing_architecture_rejected(self):
        del self.payload["platforms"]["linux"]["architectures"]
        with self.assertRaises(ValueError):
            updater.sign(self.payload, self.private, self.public)

    def test_template_notes_cannot_be_signed(self):
        self.payload["notes"] = "# OpenStudio {{version}}\nTODO"
        with self.assertRaises(ValueError):
            updater.sign(self.payload, self.private, self.public)

    def test_empty_notes_cannot_be_signed(self):
        self.payload["notes"] = ""
        with self.assertRaises(ValueError):
            updater.sign(self.payload, self.private, self.public)

    def test_bad_version_size_hash_and_scheme_rejected(self):
        for field, value in [("size", 0), ("size", True), ("sha256", ""), ("url", "http://example.invalid/a"),
                             ("minimumGlibcVersion", "latest")]:
            with self.subTest(field=field, value=value):
                payload = copy.deepcopy(self.payload)
                payload["platforms"]["linux"][field] = value
                with self.assertRaises(ValueError):
                    updater.sign(payload, self.private, self.public)

    def test_unsigned_feed_rejected(self):
        with self.assertRaises(KeyError):
            updater.verify(self.payload, self.public)


if __name__ == "__main__":
    unittest.main()

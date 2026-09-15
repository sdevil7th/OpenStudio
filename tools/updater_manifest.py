"""Sign exact update metadata bytes; never emit private key material to logs."""
import argparse
import base64
import ctypes
import json
import importlib.util
import os
from pathlib import Path
import re

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, PrivateFormat, NoEncryption

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_HEADER = ROOT / "Source/UpdatePublicKey.h"


def public_key(path=PUBLIC_HEADER):
    match = re.search(r'openStudioUpdatePublicKey\s*=\s*"([0-9a-f]{64})"', path.read_text())
    if not match:
        raise ValueError("Configure a dedicated updater public key before signing or publishing.")
    return bytes.fromhex(match[1])


def local_key_path():
    if os.name != "nt":
        raise ValueError("Set OPENSTUDIO_UPDATE_SIGNING_SEED for release signing on this platform.")
    return Path(os.environ["LOCALAPPDATA"]) / "OpenStudioReleaseKeys/updater-ed25519.dpapi"


def protect(data, decrypt=False):
    if os.name != "nt":
        raise ValueError("Local key storage requires Windows DPAPI.")
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, target = Blob(len(data), buf), Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ValueError("Windows could not protect/unprotect the signing key for this user.")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel = ctypes.WinDLL("kernel32")
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree(ctypes.cast(target.data, ctypes.c_void_p))


def load_private_key():
    encoded = os.environ.get("OPENSTUDIO_UPDATE_SIGNING_SEED")
    seed = base64.b64decode(encoded, validate=True) if encoded else protect(local_key_path().read_bytes(), True)
    if len(seed) != 32:
        raise ValueError("The updater signing seed must decode to 32 bytes.")
    return Ed25519PrivateKey.from_private_bytes(seed)


def validate_payload(payload):
    if payload.get("schemaVersion") != 1 or payload.get("channel") not in ("stable", "beta"):
        raise ValueError("Unsupported update manifest schema or channel.")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:\.\d+)?", payload.get("version", "")):
        raise ValueError("Invalid release version.")
    spec = importlib.util.spec_from_file_location("release_notes", ROOT / "tools/validate-release-notes.py")
    notes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notes)
    notes.validate_text(payload["version"], payload.get("notes", ""))
    for name, node in payload.get("platforms", {}).items():
        if name not in ("windows", "macos", "linux"):
            raise ValueError("Unknown application platform.")
        arches = node.get("architectures")
        if not isinstance(arches, list) or not arches or any(a not in ("x86_64", "arm64") for a in arches):
            raise ValueError("Every update must declare supported CPU architectures.")
        if not node.get("url", "").startswith("https://") or not re.fullmatch(r"[a-f0-9]{64}", node.get("sha256", "")):
            raise ValueError("Every update requires HTTPS and SHA-256.")
        if type(node.get("size")) is not int or not 0 < node["size"] <= 2 * 1024**3:
            raise ValueError("Invalid update package size.")
        for field in ("minimumSystemVersion", "minimumGlibcVersion"):
            if field in node and not re.fullmatch(r"\d+(?:\.\d+){0,3}", node[field]):
                raise ValueError("Invalid minimum platform version.")
    if not payload.get("platforms"):
        raise ValueError("No application packages in update manifest.")


def sign(payload, private, expected_public):
    payload = {k: v for k, v in payload.items() if k not in ("signedPayload", "signature")}
    validate_payload(payload)
    actual = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    if actual != expected_public:
        raise ValueError("Signing key does not match the public key embedded in this application.")
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return dict(payload, signedPayload=base64.b64encode(raw).decode(), signature=base64.b64encode(private.sign(raw)).decode())


def verify(envelope, expected_public):
    raw = base64.b64decode(envelope["signedPayload"], validate=True)
    signature = base64.b64decode(envelope["signature"], validate=True)
    Ed25519PublicKey.from_public_bytes(expected_public).verify(signature, raw)
    payload = json.loads(raw)
    validate_payload(payload)
    # Legacy clients must see exactly the same fields as authenticated clients.
    if payload != {k: v for k, v in envelope.items() if k not in ("signedPayload", "signature")}:
        raise ValueError("Unsigned legacy fields do not match the signed payload.")
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("keygen", "sign", "verify"))
    parser.add_argument("--metadata-dir", type=Path, default=ROOT / "dist/release-metadata")
    args = parser.parse_args()
    try:
        if args.command == "keygen":
            path = local_key_path()
            if path.exists() or re.search(r'"[0-9a-f]{64}"', PUBLIC_HEADER.read_text()):
                raise ValueError("An updater key already exists. Key rotation must be explicit.")
            private = Ed25519PrivateKey.generate()
            seed = private.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as output:
                output.write(protect(seed))
            public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
            PUBLIC_HEADER.write_text('#pragma once\n// Dedicated updater Ed25519 public key. Keep the private seed out of Git.\n'
                                     f'inline constexpr const char* openStudioUpdatePublicKey = "{public}";\n')
            print(f"Public key written to {PUBLIC_HEADER}; private key protected by Windows DPAPI at {path}.")
            return
        expected = public_key()
        private = load_private_key() if args.command == "sign" else None
        paths = [args.metadata_dir / "releases/latest.json"]
        paths.extend(sorted((args.metadata_dir / "releases").glob("*/latest.json")))
        paths = [p for p in paths if p.parent.name != "ai-runtime"]
        if not paths or any(not p.is_file() for p in paths):
            raise ValueError("Application release manifests are missing.")
        for path in paths:
            envelope = json.loads(path.read_text(encoding="utf-8-sig"))
            if private is not None:
                envelope = sign(envelope, private, expected)
                temporary = path.with_suffix(".json.tmp")
                temporary.write_text(json.dumps(envelope, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                temporary.replace(path)
            verify(envelope, expected)
        print(f"Verified publisher signatures for {len(paths)} application manifests.")
    except (ValueError, OSError, KeyError, InvalidSignature):
        parser.exit(2, "Updater signing/verification failed. Check the key, signed metadata, and required platform fields. No private key material was logged.\n")


if __name__ == "__main__":
    main()

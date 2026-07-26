#!/usr/bin/env python3
"""Refresh the local OpenStudio NAM catalog cache from TONE3000.

This script stores metadata and authenticated model download URLs only. It does
not bulk-download NAM files or redistribute TONE3000 content.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


API_BASE = "https://www.tone3000.com/api/v1"
DEFAULT_SORTS = ("newest", "trending", "downloads-all-time")
DEFAULT_ARCHITECTURES = ("1", "2")
TOKEN_REFRESH_SKEW_MS = 60_000
MAX_RATE_LIMIT_RETRIES = 3


def appdata_nam_root() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return base / "OpenStudio" / "NAM"

    if sys.platform == "darwin":
        canonical = Path.home() / "Library" / "Application Support" / "OpenStudio" / "NAM"
        legacy = Path.home() / "Library" / "OpenStudio" / "NAM"
    else:
        data_base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
        config_base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        canonical = data_base / "OpenStudio" / "NAM"
        legacy = config_base / "OpenStudio" / "NAM"

    # Match the native app's compatibility fallback for pre-release installs.
    # New installs always use the platform data directory.
    if not canonical.exists() and legacy.is_dir():
        return legacy
    return canonical


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def epoch_ms() -> int:
    return int(time.time() * 1000)


def dpapi_unprotect(data: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("DPAPI token loading is only available on Windows")

    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    buffer = ctypes.create_string_buffer(data)
    input_blob = DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    output_blob = DataBlob()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(input_blob),
        None,
        None,
        None,
        None,
        0x1,  # CRYPTPROTECT_UI_FORBIDDEN
        ctypes.byref(output_blob),
    ):
        raise OSError(ctypes.get_last_error(), "CryptUnprotectData failed")

    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(output_blob.pbData)


def dpapi_protect(data: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("DPAPI token saving is only available on Windows")

    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    buffer = ctypes.create_string_buffer(data)
    input_blob = DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    output_blob = DataBlob()
    if not crypt32.CryptProtectData(
        ctypes.byref(input_blob),
        "OpenStudio TONE3000",
        None,
        None,
        None,
        0x1,  # CRYPTPROTECT_UI_FORBIDDEN
        ctypes.byref(output_blob),
    ):
        raise OSError(ctypes.get_last_error(), "CryptProtectData failed")

    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(output_blob.pbData)


def stored_token_path(root: Path) -> Path:
    return root / ("tone3000_tokens.dpapi" if os.name == "nt" else "tone3000_tokens.json")


def write_private_file_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            os.chmod(path, 0o600)
    finally:
        temporary.unlink(missing_ok=True)


def load_stored_auth(root: Path) -> dict[str, Any]:
    path = stored_token_path(root)
    if not path.exists():
        return {}
    try:
        stored_bytes = path.read_bytes()
        if os.name == "nt":
            stored_bytes = dpapi_unprotect(stored_bytes)
        return json.loads(stored_bytes.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Could not read stored TONE3000 token: {exc}") from exc


def save_stored_auth(root: Path, payload: dict[str, Any]) -> None:
    path = stored_token_path(root)
    stored_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if os.name == "nt":
        stored_bytes = dpapi_protect(stored_bytes)
    write_private_file_atomic(path, stored_bytes)


def post_oauth_form(base_url: str, fields: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/oauth/token",
        data=urllib.parse.urlencode(fields).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "OpenStudio-NAM-Catalog/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"TONE3000 OAuth HTTP {exc.code}: {body[:500]}") from exc


def refresh_stored_auth(root: Path, stored: dict[str, Any], base_url: str) -> dict[str, Any]:
    refresh_token = str(stored.get("refreshToken") or "")
    client_id = str(stored.get("clientId") or "")
    if not refresh_token or not client_id:
        return stored

    token_payload = post_oauth_form(
        base_url,
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
        },
    )
    access_token = str(token_payload.get("access_token") or "")
    if not access_token:
        return stored

    next_refresh_token = str(token_payload.get("refresh_token") or refresh_token)
    expires_in = int(float(token_payload.get("expires_in") or 0))
    expires_at_ms = epoch_ms() + max(0, expires_in) * 1000
    refreshed = {
        "schemaVersion": 1,
        "provider": "tone3000",
        "clientId": client_id,
        "accessToken": access_token,
        "refreshToken": next_refresh_token,
        "tokenType": token_payload.get("token_type") or stored.get("tokenType") or "bearer",
        "scope": token_payload.get("scope", stored.get("scope")),
        "expiresAtMs": expires_at_ms,
        "storedAt": utc_now(),
    }
    save_stored_auth(root, refreshed)
    return refreshed


def resolve_access_token(args: argparse.Namespace) -> str:
    if args.access_token:
        if "\r" in args.access_token or "\n" in args.access_token:
            raise RuntimeError("The TONE3000 access token contains invalid header characters")
        return args.access_token
    if args.no_stored_token:
        return ""

    stored = load_stored_auth(args.nam_root)
    access_token = str(stored.get("accessToken") or "")
    expires_at_ms = int(float(stored.get("expiresAtMs") or 0))
    if access_token and (expires_at_ms <= 0 or epoch_ms() < expires_at_ms - TOKEN_REFRESH_SKEW_MS):
        if "\r" in access_token or "\n" in access_token:
            raise RuntimeError("The stored TONE3000 access token contains invalid header characters")
        return access_token

    refreshed = refresh_stored_auth(args.nam_root, stored, args.base_url)
    access_token = str(refreshed.get("accessToken") or "")
    if "\r" in access_token or "\n" in access_token:
        raise RuntimeError("The stored TONE3000 access token contains invalid header characters")
    return access_token


class Tone3000Client:
    def __init__(self, access_token: str, base_url: str, min_interval: float) -> None:
        self.access_token = access_token
        self.base_url = base_url.rstrip("/")
        self.min_interval = min_interval
        self._last_request = 0.0

    def get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}?{urllib.parse.urlencode(params)}"
        for attempt in range(MAX_RATE_LIMIT_RETRIES + 1):
            elapsed = time.monotonic() - self._last_request
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)

            request = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {self.access_token}",
                    "Content-Type": "application/json",
                    "User-Agent": "OpenStudio-NAM-Catalog/0.1",
                },
                method="GET",
            )
            self._last_request = time.monotonic()
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code == 429 and attempt < MAX_RATE_LIMIT_RETRIES:
                    retry_after = exc.headers.get("Retry-After")
                    try:
                        requested_delay = float(retry_after) if retry_after else 15.0
                    except (TypeError, ValueError):
                        requested_delay = 15.0
                    time.sleep(max(1.0, min(requested_delay, 60.0)))
                    continue
                body = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"TONE3000 API HTTP {exc.code}: {body[:500]}") from exc

        raise RuntimeError("TONE3000 API retry limit reached")


def connect_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS catalog_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generated_at TEXT NOT NULL,
            base_url TEXT NOT NULL,
            page_size INTEGER NOT NULL,
            pages INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tones (
            tone_id INTEGER PRIMARY KEY,
            title TEXT,
            creator TEXT,
            gear TEXT,
            platform TEXT,
            license TEXT,
            downloads_count INTEGER,
            favorites_count INTEGER,
            url TEXT,
            raw_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tone_buckets (
            tone_id INTEGER NOT NULL,
            sort_bucket TEXT NOT NULL,
            architecture TEXT NOT NULL,
            rank INTEGER NOT NULL,
            refreshed_at TEXT NOT NULL,
            PRIMARY KEY (tone_id, sort_bucket, architecture)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS models (
            model_id INTEGER PRIMARY KEY,
            tone_id INTEGER NOT NULL,
            name TEXT,
            architecture TEXT,
            model_url TEXT,
            size_json TEXT,
            raw_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    return conn


def text_from(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("name") or value.get("username") or "")
    return ""


def upsert_tone(conn: sqlite3.Connection, tone: dict[str, Any], refreshed_at: str) -> int:
    tone_id = int(tone.get("id") or tone.get("toneId") or 0)
    if tone_id <= 0:
        return 0
    user = tone.get("user") if isinstance(tone.get("user"), dict) else {}
    conn.execute(
        """
        INSERT INTO tones (
            tone_id, title, creator, gear, platform, license, downloads_count,
            favorites_count, url, raw_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tone_id) DO UPDATE SET
            title=excluded.title,
            creator=excluded.creator,
            gear=excluded.gear,
            platform=excluded.platform,
            license=excluded.license,
            downloads_count=excluded.downloads_count,
            favorites_count=excluded.favorites_count,
            url=excluded.url,
            raw_json=excluded.raw_json,
            updated_at=excluded.updated_at
        """,
        (
            tone_id,
            tone.get("title") or tone.get("name") or "",
            user.get("username") or tone.get("creator") or "",
            text_from(tone.get("gear")),
            text_from(tone.get("platform")),
            text_from(tone.get("license")),
            int(tone.get("downloads_count") or 0),
            int(tone.get("favorites_count") or 0),
            tone.get("url") or "",
            json.dumps(tone, ensure_ascii=False, sort_keys=True),
            refreshed_at,
        ),
    )
    return tone_id


def upsert_model(conn: sqlite3.Connection, model: dict[str, Any], refreshed_at: str) -> int:
    model_id = int(model.get("id") or model.get("model_id") or 0)
    tone_id = int(model.get("tone_id") or model.get("toneId") or 0)
    if model_id <= 0 or tone_id <= 0:
        return 0
    conn.execute(
        """
        INSERT INTO models (
            model_id, tone_id, name, architecture, model_url, size_json, raw_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET
            tone_id=excluded.tone_id,
            name=excluded.name,
            architecture=excluded.architecture,
            model_url=excluded.model_url,
            size_json=excluded.size_json,
            raw_json=excluded.raw_json,
            updated_at=excluded.updated_at
        """,
        (
            model_id,
            tone_id,
            model.get("name") or "",
            str(model.get("architecture_version") or model.get("architecture") or ""),
            model.get("model_url") or model.get("modelUrl") or "",
            json.dumps(model.get("size"), ensure_ascii=False, sort_keys=True),
            json.dumps(model, ensure_ascii=False, sort_keys=True),
            refreshed_at,
        ),
    )
    return model_id


def fetch_catalog(args: argparse.Namespace) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    client = Tone3000Client(args.access_token, args.base_url, args.min_interval)
    rows: list[dict[str, Any]] = []
    seen_model_fetches: set[tuple[int, str]] = set()
    model_fetch_count = 0

    with connect_db(args.db) as conn:
        generated_at = utc_now()
        conn.execute(
            "INSERT INTO catalog_runs (generated_at, base_url, page_size, pages) VALUES (?, ?, ?, ?)",
            (generated_at, args.base_url, args.page_size, args.pages),
        )

        rank = 0
        for architecture in args.architecture:
            for sort in args.sort:
                for page in range(1, args.pages + 1):
                    payload = client.get(
                        "/tones/search",
                        {
                            "query": args.query,
                            "page": page,
                            "page_size": args.page_size,
                            "sort": sort,
                            "gears": args.gears,
                            "platform": "nam",
                            "architecture": architecture,
                        },
                    )
                    tones = payload.get("data") or payload.get("tones") or []
                    for tone in tones:
                        if not isinstance(tone, dict):
                            continue
                        rank += 1
                        tone_id = upsert_tone(conn, tone, generated_at)
                        if tone_id <= 0:
                            continue
                        conn.execute(
                            """
                            INSERT INTO tone_buckets (tone_id, sort_bucket, architecture, rank, refreshed_at)
                            VALUES (?, ?, ?, ?, ?)
                            ON CONFLICT(tone_id, sort_bucket, architecture) DO UPDATE SET
                                rank=excluded.rank,
                                refreshed_at=excluded.refreshed_at
                            """,
                            (tone_id, sort, architecture, rank, generated_at),
                        )

                        model_key = (tone_id, architecture)
                        models: list[dict[str, Any]] = []
                        if model_key not in seen_model_fetches and model_fetch_count < args.max_model_fetches:
                            seen_model_fetches.add(model_key)
                            model_fetch_count += 1
                            models_payload = client.get(
                                "/models",
                                {
                                    "tone_id": tone_id,
                                    "page": 1,
                                    "page_size": 20,
                                    "architecture": architecture,
                                },
                            )
                            for model in models_payload.get("data") or []:
                                if isinstance(model, dict):
                                    upsert_model(conn, model, generated_at)
                                    models.append(model)

                        row = dict(tone)
                        row["sortBucket"] = sort
                        row["architecture"] = architecture
                        if models:
                            row["models"] = models
                        rows.append(row)

        conn.commit()

        if not args.skip_db_json_hydration:
            rows = build_json_rows_from_db(conn)

    root = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "source": "tone3000",
        "query": {
            "platform": "nam",
            "gears": args.gears,
            "architecture": list(args.architecture),
            "sort": list(args.sort),
            "pageSize": args.page_size,
            "pages": args.pages,
        },
        "tones": rows,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(root, ensure_ascii=False, indent=2), encoding="utf-8")
    return rows, root


def build_json_rows_from_db(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    query = """
        SELECT t.raw_json, b.sort_bucket, b.architecture
        FROM tone_buckets b
        JOIN tones t ON t.tone_id = b.tone_id
        ORDER BY b.sort_bucket, b.architecture, b.rank
    """
    for tone_raw, sort_bucket, architecture in conn.execute(query):
        tone = json.loads(tone_raw)
        tone_id = int(tone.get("id") or 0)
        tone["sortBucket"] = sort_bucket
        tone["architecture"] = architecture
        model_rows = conn.execute(
            "SELECT raw_json FROM models WHERE tone_id = ? AND (architecture = ? OR architecture = ?)",
            (tone_id, architecture, f"A{architecture}"),
        ).fetchall()
        tone["models"] = [json.loads(raw) for (raw,) in model_rows]
        rows.append(tone)
    return rows


def parse_args(argv: list[str]) -> argparse.Namespace:
    root = appdata_nam_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--access-token", default=os.environ.get("TONE3000_ACCESS_TOKEN", ""), help="TONE3000 OAuth access token. Defaults to TONE3000_ACCESS_TOKEN, then the per-user OpenStudio stored session.")
    parser.add_argument("--base-url", default=API_BASE)
    parser.add_argument("--nam-root", type=Path, default=root, help="OpenStudio NAM data root. Defaults to the per-user app data folder.")
    parser.add_argument("--no-stored-token", action="store_true", help="Do not read or refresh the per-user OpenStudio token store.")
    parser.add_argument("--db", type=Path, default=None)
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument("--query", default="")
    parser.add_argument("--gears", default="amp_amp-cab")
    parser.add_argument("--sort", action="append", choices=DEFAULT_SORTS, default=[])
    parser.add_argument("--architecture", action="append", choices=("1", "2", "custom"), default=[])
    parser.add_argument("--page-size", type=int, default=25)
    parser.add_argument("--pages", type=int, default=1)
    parser.add_argument("--max-model-fetches", type=int, default=60)
    parser.add_argument("--min-interval", type=float, default=0.75, help="Minimum seconds between API requests.")
    parser.add_argument("--skip-db-json-hydration", action="store_true")
    args = parser.parse_args(argv)
    if not args.sort:
        args.sort = list(DEFAULT_SORTS)
    if not args.architecture:
        args.architecture = list(DEFAULT_ARCHITECTURES)
    if args.db is None:
        args.db = args.nam_root / "catalog.sqlite"
    if args.json is None:
        args.json = args.nam_root / "catalog.json"
    args.page_size = max(1, min(args.page_size, 25))
    args.pages = max(1, min(args.pages, 3))
    args.max_model_fetches = max(0, min(args.max_model_fetches, 200))
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        args.access_token = resolve_access_token(args)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if not args.access_token:
        print("Missing TONE3000 access token. Authenticate in OpenStudio, set TONE3000_ACCESS_TOKEN, or pass --access-token.", file=sys.stderr)
        return 2

    rows, _ = fetch_catalog(args)
    print(f"Updated {args.db}")
    print(f"Wrote {args.json}")
    print(f"Cached {len(rows)} tone rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

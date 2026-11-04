from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid
import zipfile

from .common import Redactor, check, collection_environment, read_json, regular_file, report

LOG_NAMES = ("OpenStudio_Startup.log", "OpenStudio_Debug.log", "debug_log.txt",
             "crash_breadcrumbs.log", "crash_breadcrumbs.previous.log", "hang_breadcrumbs.log")
DUMP_NAMES = ("last_crash.dmp", "last_crash.previous.dmp", "last_hang.dmp", "last_hang.previous.dmp")
LOG_LIMIT = 512 * 1024
DUMP_LIMIT = 32 * 1024 * 1024
TOTAL_LIMIT = 128 * 1024 * 1024


def default_directories():
    home = Path.home()
    if os.name == "nt":
        documents = home / "Documents"
        # Documents may be relocated to OneDrive or another drive.
        guid = (ctypes.c_byte * 16).from_buffer_copy(uuid.UUID("FDD39AD0-238F-46AF-ADB4-6C85480369C7").bytes_le)
        value = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(value)) == 0:
            documents = Path(value.value)
            ctypes.windll.ole32.CoTaskMemFree(value)
        return [documents / "OpenStudio", Path(os.environ.get("APPDATA", home / "AppData/Roaming")) / "OpenStudio/logs"]
    if sys.platform == "darwin":
        return [home / "Library/Logs/OpenStudio", home / "Library/OpenStudio/logs"]
    return [home / "Documents/OpenStudio", Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "OpenStudio/logs"]


def collect(directories, route_reports=(), include_dumps=False, description=""):
    result = report("existing_evidence")
    result["environment"] = collection_environment()
    result["userDescription"] = description[:8000]
    result["artifacts"] = []
    result["limitations"].append("Logs can span multiple sessions/builds. No incident grouping or original build identity is inferred.")
    redactor = Redactor()
    artifacts = {}
    seen = set()
    total = 0
    candidates = [(directory / name, False) for directory in directories
                  for name in (*LOG_NAMES, *(DUMP_NAMES if include_dumps else ()))]
    candidates += [(path, True) for path in route_reports]
    for path, route in candidates:
        if path.absolute() in seen:
            continue
        seen.add(path.absolute())
        if not path.exists():
            if route:
                check(result, "route_report_missing", "fail", "The selected route report does not exist.")
            continue
        dump = path.suffix == ".dmp"
        name = f"evidence-{len(artifacts) + 1:02d}" + (".dmp" if dump else ".json" if route else ".txt")
        try:
            info = regular_file(path)
            truncated = False
            if dump:
                if info.st_size > DUMP_LIMIT:
                    raise ValueError("Dump exceeds 32 MiB; not copied. Share separately only after review.")
                data = path.read_bytes()
            elif route:
                value = read_json(path)
                if not isinstance(value, dict) or value.get("purpose") != "manual_render_route_report":
                    raise ValueError("Not an OpenStudio render route report")
                data = json.dumps(redactor.clean(value), indent=2, allow_nan=False).encode("utf-8")
            else:
                with path.open("rb") as stream:
                    if info.st_size > LOG_LIMIT:
                        stream.seek(info.st_size - LOG_LIMIT)
                        stream.readline()  # Do not present an incomplete first line as complete evidence.
                        truncated = True
                    data = redactor.text(stream.read(LOG_LIMIT).decode("utf-8", errors="replace")).encode("utf-8")
            if total + len(data) > TOTAL_LIMIT:
                raise ValueError("Support collection exceeds the 128 MiB total limit")
            artifacts[name] = data
            total += len(data)
            result["artifacts"].append({"file": name, "source": str(path.absolute()),
                                        "sourceBytes": info.st_size, "tailOnly": truncated,
                                        "unredactedDump": dump})
        except (OSError, ValueError) as exc:
            check(result, "evidence_not_collected", "not_asserted", str(exc), source=str(path))
    check(result, "existing_evidence", "pass" if artifacts else "not_asserted",
          f"Collected {len(artifacts)} existing evidence files; original files were not modified.")
    if include_dumps:
        result["limitations"].append("Included dumps are unredacted and can contain private memory, audio fragments, and credentials.")
    return result, artifacts, redactor


def bundle(directory: Path, destination: Path, reviewed: bool):
    if not reviewed:
        raise ValueError("Review all files first, then use --reviewed to create the ZIP. Nothing is uploaded.")
    manifest = read_json(directory / "manifest.json")
    if not isinstance(manifest, dict) or manifest.get("kind") != "openstudio_support_manifest":
        raise ValueError("Not a support report directory")
    entries = manifest.get("files", [])
    if not isinstance(entries, list) or not 2 <= len(entries) <= 100:
        raise ValueError("Invalid evidence list")
    files = {}
    total = 0
    for entry in entries:
        name = entry["file"]
        if (not isinstance(name, str) or not re.fullmatch(r"(?:report\.json|summary\.txt|evidence-\d{2,3}\.(?:txt|json|dmp))", name)
                or name in files):
            raise ValueError("Unsafe or duplicated evidence entry")
        path = directory / name
        info = regular_file(path)
        total += info.st_size
        if total > TOTAL_LIMIT or info.st_size != entry["bytes"]:
            raise ValueError("Evidence size changed or exceeds the bundle limit")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("Evidence changed after collection; regenerate and review the report")
        files[name] = data
    # Explicit entries only. Never recursively include neighbouring media/projects.
    files["manifest.json"] = json.dumps(manifest, indent=2).encode("utf-8")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as output:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)

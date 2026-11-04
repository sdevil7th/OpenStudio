from __future__ import annotations

import csv
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone

JSON_LIMIT = 32 * 1024 * 1024


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def require_closed():
    """One-shot prerequisite, not a resident monitor. Fail closed if enumeration fails.

    This cannot prevent a user launching the DAW later. Keep it closed until the
    tool exits; there is deliberately no new coordination hook in the application.
    """
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    if os.name == "nt":
        result = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True,
                                text=True, errors="replace", timeout=15, check=True, **flags)
        names = [row[0] for row in csv.reader(io.StringIO(result.stdout))
                 if row and (len(row) < 2 or row[1] != str(os.getpid()))]
    else:
        result = subprocess.run(["ps", "-A", "-o", "pid=,comm="], capture_output=True,
                                text=True, timeout=15, check=True)
        names = [Path(parts[1]).name for line in result.stdout.splitlines()
                 if len(parts := line.strip().split(None, 1)) == 2 and parts[0] != str(os.getpid())]
    if not names:
        raise ValueError("Could not check running applications; no diagnostic work was started.")
    if any(name.lower().removesuffix(".exe").startswith("openstudio") for name in names):
        raise ValueError("Close OpenStudio and its workers before running support tools. Keep it closed until finished.")


def regular_file(path: Path):
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise ValueError("Only regular files are accepted (no symbolic links or special files).")
    return info


def read_json(path: Path):
    if regular_file(path).st_size > JSON_LIMIT:
        raise ValueError("JSON input exceeds the 32 MiB inspection limit.")
    def invalid_constant(_value):
        raise ValueError("Non-finite JSON number")
    with path.open("r", encoding="utf-8-sig") as stream:
        return json.load(stream, parse_constant=invalid_constant)


def sha256(path: Path):
    regular_file(path)
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def report(kind: str):
    return {"schemaVersion": 1, "tool": "OpenStudio offline support", "kind": kind,
            "collectedAtUtc": utc_now(), "status": "diagnostic_only", "checks": [],
            "contentCompleteness": "not_asserted", "subjectiveAudioQuality": "not_asserted",
            "limitations": ["No new live-session telemetry was collected.",
                            "A later snapshot does not establish the state at the original incident."]}


def check(result: dict, name: str, status: str, detail: str, **evidence):
    result["checks"].append({"id": name, "status": status, "detail": detail, **evidence})
    if status == "fail":
        result["status"] = "fail"


class Redactor:
    """Best-effort privacy filter. Preview is mandatory; dumps are never redacted."""
    def __init__(self):
        self.aliases = {}

    def alias(self, value, kind="path"):
        key = (kind, str(value).replace("\\", "/").casefold())
        if key not in self.aliases:
            self.aliases[key] = f"<{kind}-{len(self.aliases) + 1}>"
        return self.aliases[key]

    def text(self, value):
        value = re.sub(r"(?i)\b(?:https?|file)://[^\s<>\"']+", "<url>", value)
        value = re.sub(r"(?i)\bBearer\s+[^\s,;\"']+", "Bearer <secret>", value)
        value = re.sub(r"(?im)([\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)[\"']?\s*[:=]\s*)([^\r\n]+)", r"\1<secret>", value)
        value = re.sub(r"\b[^\s@]+@[^\s@]+\.[^\s@]+", "<email>", value)
        value = re.sub(r"(?i)(?:[A-Z]:[\\/]|\\\\)[^\r\n\"'<>|]*", lambda m: self.alias(m[0].rstrip()), value)
        value = re.sub(r"(?<![\w<])/(?:Users|home|tmp|var|Volumes|mnt|media|opt|Applications|usr)/[^\r\n\"'<>|]*", lambda m: self.alias(m[0].rstrip()), value)
        value = re.sub(r"[A-Za-z0-9+/=_-]{128,}", "<long-data>", value)
        return value

    def clean(self, value, key=""):
        if re.search(r"(?i)(password|secret|token|api.?key|cookie|authorization|pluginState|fxState|projectNotes)", key):
            return "<redacted>"
        if isinstance(value, dict):
            return {str(k): self.clean(v, str(k)) for k, v in value.items()}
        if isinstance(value, list):
            return [self.clean(item, key) for item in value]
        if isinstance(value, str):
            if key.lower() in {"name", "trackname", "projectname", "clipname"}:
                return self.alias(value, "name")
            return self.text(value)
        return value


def summary(result):
    lines = ["OpenStudio offline support", f"Report: {result['kind']}",
             f"Result: {result['status']}", f"Collected: {result['collectedAtUtc']}",
             f"Original content completeness: {result['contentCompleteness']}",
             "Subjective audio quality: not_asserted", ""]
    for item in result["checks"]:
        lines.append(f"[{item['status']}] {item['id']}: {item['detail']}")
    lines += ["", "Limitations:", *["- " + item for item in result["limitations"]], "",
              "Review report.json and every evidence file before sharing.",
              "Redaction is best effort. Dumps contain unredacted process memory.",
              "Nothing is uploaded. Original media and projects are not copied."]
    return "\n".join(lines) + "\n"


def save_report(directory: Path, result: dict, artifacts=None, redactor=None):
    """Exclusive output directory: never overwrite a project, export, or old report."""
    directory.mkdir(parents=True, exist_ok=False)
    redactor = redactor or Redactor()
    cleaned = redactor.clean(result)
    files = {"report.json": json.dumps(cleaned, indent=2, allow_nan=False).encode("utf-8"),
             "summary.txt": summary(cleaned).encode("utf-8"), **(artifacts or {})}
    manifest = {"schemaVersion": 1, "kind": "openstudio_support_manifest", "files": []}
    for name, data in files.items():
        if Path(name).name != name or name in {".", "..", "manifest.json"}:
            raise ValueError("Invalid evidence filename")
        with (directory / name).open("xb") as stream:
            stream.write(data)
        manifest["files"].append({"file": name, "bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest(),
                                  "unredactedDump": name.endswith(".dmp")})
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return cleaned


def collection_environment():
    # Deliberately excludes host/user names, process lists, environment variables,
    # hardware serial numbers, and misleading historical CPU/RAM attribution.
    return {"when": "at_collection_time_only", "os": platform.system(),
            "osRelease": platform.release(), "architecture": platform.machine(),
            "logicalCPUs": os.cpu_count(), "python": sys.version.split()[0]}

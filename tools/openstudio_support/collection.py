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
from datetime import datetime, timezone

from .common import Redactor, check, collection_environment, read_json, regular_file, report
from .identity import dump_modules, match_ids, os_report_ids
from .snapshots import PLUGIN_FILES, installed_app, installed_snapshot, plugin_snapshot, symbol_archive_ids

LOG_NAMES = ("OpenStudio_Startup.log", "OpenStudio_Debug.log", "debug_log.txt",
             "crash_breadcrumbs.log", "crash_breadcrumbs.previous.log", "hang_breadcrumbs.log", "plugin_scan_debug.txt")
DUMP_NAMES = ("last_crash.dmp", "last_crash.previous.dmp", "last_hang.dmp", "last_hang.previous.dmp")
LOG_LIMIT = 512 * 1024
DUMP_LIMIT = 32 * 1024 * 1024
TOTAL_LIMIT = 128 * 1024 * 1024


def linux_xdg_directory(home, config, key, fallback):
    """Read only a literal XDG assignment; never source shell configuration.

    The pinned JUCE reads ~/.config/user-dirs.dirs even when XDG_CONFIG_HOME
    differs. Discovery includes that location as well as the XDG override.
    """
    path = config / 'user-dirs.dirs'
    try:
        if regular_file(path).st_size > 64 * 1024:
            return fallback
        for line in path.read_text(encoding='utf-8').splitlines():
            match = re.fullmatch(r'\s*' + re.escape(key) + r'\s*=\s*"([^"\r\n]*)"\s*', line)
            if match:
                value = match[1].replace('$HOME', str(home))
                candidate = Path(value)
                if '$' not in value and '`' not in value and candidate.is_absolute() and candidate.is_dir():
                    return candidate
    except (OSError, ValueError, UnicodeError):
        pass
    return fallback


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
        settings = Path(os.environ.get("APPDATA", home / "AppData/Roaming")) / "OpenStudio"
        return [documents / "OpenStudio", settings / "logs", settings]
    if sys.platform == "darwin":
        return [home / "Library/Logs/OpenStudio", home / "Library/OpenStudio/logs",
                home / "Library/Application Support/OpenStudio/Plugins", home / "Library/OpenStudio"]
    juce_config = home / '.config'
    configured = Path(os.environ.get('XDG_CONFIG_HOME', juce_config))
    if not configured.is_absolute():
        configured = juce_config
    documents = [linux_xdg_directory(home, config, 'XDG_DOCUMENTS_DIR', home / 'Documents')
                 for config in dict.fromkeys((juce_config, configured))]
    app_data = [linux_xdg_directory(home, juce_config, 'XDG_CONFIG_HOME', juce_config), configured]
    return list(dict.fromkeys([*(path / 'OpenStudio' for path in documents), home / 'Documents/OpenStudio',
                               *(path / 'OpenStudio/logs' for path in app_data),
                               *(path / 'OpenStudio' for path in app_data)]))


def collect(directories, route_reports=(), include_dumps=False, description="", *, app=None, symbols=None, crash_reports=()):
    result = report("existing_evidence")
    result["environment"] = collection_environment()
    result["userDescription"] = description[:8000]
    result["artifacts"] = []
    result["limitations"].append("Logs can span multiple sessions/builds. No incident grouping or original build identity is inferred.")
    redactor = Redactor()
    artifacts = {}
    seen = set()
    total = 0
    result['installedBuild'] = {'status': 'not_asserted', 'detail': 'Installed application not located; choose its executable if needed.'}
    app = app or installed_app()
    if app:
        try:
            result['installedBuild'] = installed_snapshot(app)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            check(result, 'installed_identity_unavailable', 'not_asserted', str(exc))
    symbol_ids = set()
    if symbols:
        try:
            symbol_ids = symbol_archive_ids(symbols)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            check(result, 'symbol_archive_invalid', 'fail', str(exc))
    result['incidentModules'] = []
    # Inspect only module metadata even when unredacted memory is not requested.
    for path in dict.fromkeys(directory / name for directory in directories for name in DUMP_NAMES):
        if path.exists():
            try:
                modules = dump_modules(path)
                result['incidentModules'].append({'source': str(path), 'modules': modules,
                    'symbolMatches': match_ids([identity for module in modules for identity in module['debugIds']], symbol_ids)})
            except (OSError, ValueError) as exc:
                check(result, 'dump_identity_unavailable', 'not_asserted', str(exc), source=str(path))
    candidates = [(directory / name, False) for directory in directories
                  for name in (*LOG_NAMES, *PLUGIN_FILES, *(DUMP_NAMES if include_dumps else ()))]
    candidates += [(path, True) for path in route_reports]
    for path in crash_reports:
        if path.suffix.lower() not in {'.txt', '.log', '.ips', '.crash', '.json'}:
            raise ValueError('Select an existing OS crash text report (.ips, .crash, .txt, .log or .json)')
        try:
            ids = os_report_ids(path)
            result.setdefault('osReportIdentities', []).append({'source': str(path), 'debugIds': ids,
                'symbolMatches': match_ids(ids, symbol_ids), 'recognizedIdentity': bool(ids)})
        except (OSError, ValueError, TypeError) as exc:
            check(result, 'os_report_identity_unavailable', 'not_asserted', str(exc), source=str(path))
    candidates += [(path, False) for path in crash_reports]
    for path, route in candidates:
        if path.absolute() in seen:
            continue
        seen.add(path.absolute())
        if not path.exists():
            if route:
                check(result, "route_report_missing", "fail", "The selected route report does not exist.")
            continue
        dump = path.suffix == ".dmp"
        settings = path.name in PLUGIN_FILES
        name = f"evidence-{len(artifacts) + 1:02d}" + (".dmp" if dump else ".json" if route or settings else ".txt")
        try:
            info = regular_file(path)
            truncated = False
            if len(artifacts) >= 90:
                raise ValueError('Evidence file count exceeds 90')
            if dump:
                if not include_dumps:
                    raise ValueError('Memory dumps require explicit inclusion')
                if info.st_size > DUMP_LIMIT:
                    raise ValueError("Dump exceeds 32 MiB; not copied. Share separately only after review.")
                data = path.read_bytes()
            elif settings:
                data = json.dumps(plugin_snapshot(path, redactor), indent=2).encode('utf-8')
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
                                        "sourceKind": path.name if path.name in (*LOG_NAMES, *DUMP_NAMES, *PLUGIN_FILES) else 'selected_report',
                                        "modifiedAtUtc": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(),
                                        "sourceBytes": info.st_size, "tailOnly": truncated,
                                        "unredactedDump": dump})
        except (OSError, ValueError, UnicodeError) as exc:
            check(result, "evidence_not_collected", "not_asserted", str(exc), source=str(path))
    from .recovery import recording_recovery
    recovery = recording_recovery(directories, redactor, result)
    if recovery['entries']:
        data = json.dumps(recovery, indent=2, allow_nan=False).encode('utf-8')
        if len(artifacts) >= 90 or total + len(data) > TOTAL_LIMIT:
            check(result, 'recording_recovery_not_collected', 'not_asserted', 'Evidence count/size limit reached')
        else:
            name = f'evidence-{len(artifacts) + 1:02d}.json'
            artifacts[name] = data
            result['artifacts'].append({'file': name, 'sourceKind': 'recording_recovery_snapshot',
                                        'unredactedDump': False})
    check(result, "existing_evidence", "pass" if artifacts else "not_asserted",
          f"Collected {len(artifacts)} existing evidence files; original files were not modified.")
    if include_dumps:
        result["limitations"].append("Included dumps are unredacted and can contain private memory, audio fragments, and credentials.")
    incident_ids = {identity for evidence in result['incidentModules'] for module in evidence['modules']
                    for identity in module['debugIds']}
    incident_ids.update(identity for evidence in result.get('osReportIdentities', []) for identity in evidence['debugIds'])
    check(result, 'incident_debug_identities', 'diagnostic_only' if incident_ids else 'not_asserted',
          f'{len(incident_ids)} native debug identities found in incident evidence; logs without IDs are not assigned to the installed build.')
    if symbols:
        matched = incident_ids & symbol_ids
        check(result, 'matching_native_symbols', 'diagnostic_only' if matched else 'not_asserted',
              f'{len(matched)} of {len(incident_ids)} incident identities match verified symbol files. Unmatched modules need their own symbols; cause and stack symbolication are not asserted.')
    result['limitations'].append('File modification times are not incident times. Plugin settings and installed build are later snapshots. Symbol identity matching does not determine the cause of a crash. OS report text is collected only when selected; no OS dump settings are changed.')
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
